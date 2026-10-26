// kickoff: decisions, the run with an injected fake runner, the CLI with a fake `claude` on PATH, and the launchd plan.
// Never a real claude, never the real ~/Library/LaunchAgents, never launchctl: temp HOME / KADANS_HOME and fakes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountKey } from '../lib/samples.mjs';
import { DEFAULTS, loadConfig } from '../lib/pace.mjs';
import { parseSetting, setSetting } from '../lib/config.mjs';
import {
  INTERVAL_S, KICKOFF_ARGV, LABEL, RETRY_MS, TIMEOUT_MS, applySchedule, decide, inHours, plistText, readKickoffState, runKickoff,
  schedulePlan,
} from '../lib/kickoff.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
const MIN = 60_000;
const H = 60 * MIN;
const at = (h, m = 0) => new Date(2026, 9, 26, h, m).getTime(); // local time, so the hours test does not depend on TZ
const cfgWith = (k) => ({ ...DEFAULTS, kickoff: { ...DEFAULTS.kickoff, ...k } });
const sample = (t, pct, resetsAt) => ({ t, limits: { five_hour: { pct, resetsAt } } });

function tmpHome() {
  return mkdtempSync(join(tmpdir(), 'kadans-kick-'));
}

// A runner that records its calls (and what the temp folder looked like) instead of running anything.
function fakeRunner(status = 0) {
  const calls = [];
  const run = (argv, opts) => {
    calls.push({ argv, ...opts, existed: existsSync(opts.cwd), files: readdirSync(opts.cwd) });
    return { status, error: null };
  };
  return { run, calls };
}

test('decide: refuses when kickoff is off, whatever the window', () => {
  const now = at(10);
  const d = decide({ cfg: cfgWith({ enabled: false }), samples: [], now });
  assert.equal(d.go, false);
  assert.equal(d.code, 'off');
  const home = tmpHome();
  const f = fakeRunner();
  const r = runKickoff(home, cfgWith({ enabled: false }), { run: f.run, now, samples: () => [] });
  assert.equal(r.ran, false);
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(join(home, 'kickoff.json')), false);
});

test('decide: does nothing in a live window', () => {
  const now = at(10);
  const samples = [sample(now - 30 * MIN, 12, now + 2 * H)];
  const f = fakeRunner();
  const r = runKickoff(tmpHome(), cfgWith({ enabled: true }), { run: f.run, now, samples: () => samples });
  assert.equal(r.ran, false);
  assert.equal(r.code, 'live');
  assert.match(r.why, /window already running.*nothing to do/);
  assert.equal(f.calls.length, 0);
});

test('runs once after the window ended, inside the hours: empty temp folder, 90 s, own account, one event line', () => {
  const home = tmpHome();
  const now = at(10);
  const samples = [sample(now - 6 * H, 80, now - H)]; // window ended an hour ago
  const env = { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: '/tmp/other', KADANS_THROTTLE: '1', KEEP: 'x' };
  const f = fakeRunner(0);
  const r = runKickoff(home, cfgWith({ enabled: true }), { env, run: f.run, now, samples: () => samples });
  assert.equal(r.ran, true);
  assert.equal(r.ok, true);
  assert.equal(f.calls.length, 1);
  const c = f.calls[0];
  assert.deepEqual(c.argv, ['claude', '-p', 'Reply with the single word OK.', '--model', 'haiku']);
  assert.deepEqual(c.argv, KICKOFF_ARGV);
  assert.equal(c.timeout, TIMEOUT_MS);
  assert.equal(TIMEOUT_MS, 90_000);
  assert.equal(c.existed, true);
  assert.deepEqual(c.files, []);
  assert.equal(existsSync(c.cwd), false); // removed afterwards
  assert.equal('CLAUDE_CONFIG_DIR' in c.env, false); // own account only
  assert.equal('KADANS_THROTTLE' in c.env, false); // never fed a task
  assert.equal(c.env.KEEP, 'x');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/other'); // caller's env untouched
  assert.deepEqual(readKickoffState(home), { lastAt: now, ok: true });
  const evDir = join(home, 'events');
  const lines = readdirSync(evDir).flatMap((x) => readFileSync(join(evDir, x), 'utf8').trim().split('\n'));
  assert.equal(lines.length, 1);
  const ev = JSON.parse(lines[0]);
  assert.equal(ev.ev, 'Kickoff');
  assert.equal(ev.ok, true);
  assert.equal(ev.sid, undefined); // never shows up as a session in the agent list

  // No sample follows a `claude -p`: the window Kadans started counts as live for 5 hours.
  const again = runKickoff(home, cfgWith({ enabled: true }), { env, run: f.run, now: now + 15 * MIN, samples: () => samples });
  assert.equal(again.ran, false);
  assert.equal(again.code, 'live');
  const later = runKickoff(home, cfgWith({ enabled: true }), { env, run: f.run, now: now + 4 * H + 59 * MIN, samples: () => samples });
  assert.equal(later.ran, false);
  const next = runKickoff(home, cfgWith({ enabled: true }), { env, run: f.run, now: now + 5 * H + MIN, samples: () => samples });
  assert.equal(next.ran, true);
  assert.equal(f.calls.length, 2);
});

test('a failed kickoff is retried after an hour at the earliest, not every 15 minutes', () => {
  const home = tmpHome();
  const now = at(9);
  const f = fakeRunner(1);
  const cfg = cfgWith({ enabled: true });
  const r = runKickoff(home, cfg, { run: f.run, now, samples: () => [] });
  assert.equal(r.ran, true);
  assert.equal(r.ok, false);
  assert.match(r.why, /exit 1/);
  assert.equal(runKickoff(home, cfg, { run: f.run, now: now + 15 * MIN, samples: () => [] }).ran, false);
  assert.equal(runKickoff(home, cfg, { run: f.run, now: now + RETRY_MS, samples: () => [] }).ran, true);
  assert.equal(f.calls.length, 2);
});

test('not outside the hours; from > to wraps past midnight; from == to is the whole day', () => {
  const samples = [];
  const f = fakeRunner();
  const cfg = cfgWith({ enabled: true, from: '07:00', to: '23:00' });
  for (const t of [at(6, 59), at(23), at(23, 30), at(3)]) {
    const r = runKickoff(tmpHome(), cfg, { run: f.run, now: t, samples: () => samples });
    assert.equal(r.code, 'hours', new Date(t).toString());
    assert.match(r.why, /outside the kickoff hours 07:00-23:00/);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(runKickoff(tmpHome(), cfg, { run: f.run, now: at(7), samples: () => samples }).ran, true);
  assert.equal(runKickoff(tmpHome(), cfg, { run: f.run, now: at(22, 59), samples: () => samples }).ran, true);
  assert.equal(inHours('22:00', '06:00', at(23)), true);
  assert.equal(inHours('22:00', '06:00', at(5, 59)), true);
  assert.equal(inHours('22:00', '06:00', at(6)), false);
  assert.equal(inHours('07:00', '00:00', at(23, 59)), true);
  assert.equal(inHours('00:00', '00:00', at(4)), true);
  assert.equal(inHours('7:00', '23:00', at(10)), false); // a malformed time never runs
});

// The CLI with a fake `claude` first on PATH that only writes down how it was called.
function cliSandbox(config) {
  const root = mkdtempSync(join(tmpdir(), 'kadans-kick-cli-'));
  const home = join(root, 'kadans');
  const claude = join(root, '.claude');
  const other = join(root, 'other');
  const fakeBin = join(root, 'fakebin');
  for (const d of [home, claude, other, fakeBin]) mkdirSync(d);
  if (config) writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  const mark = join(root, 'claude-calls.txt');
  writeFileSync(join(fakeBin, 'claude'), '#!/bin/sh\necho "cfg=${CLAUDE_CONFIG_DIR-unset} thr=${KADANS_THROTTLE-unset} pwd=$(pwd) args=$*" >> "$KICK_MARK"\n');
  chmodSync(join(fakeBin, 'claude'), 0o755);
  const env = { PATH: `${fakeBin}:/usr/bin:/bin`, HOME: root, KADANS_HOME: home, CLAUDE_CONFIG_DIR: other, KADANS_THROTTLE: '1', KICK_MARK: mark };
  const writeSamples = (dir, s) => {
    const d = join(home, 'accounts', accountKey(dir));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'samples.jsonl'), s.map((x) => `${JSON.stringify(x)}\n`).join(''));
  };
  const run = (args) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 20_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const calls = () => (existsSync(mark) ? readFileSync(mark, 'utf8').trim().split('\n') : []);
  return { root, home, claude, other, env, run, writeSamples, calls };
}

const ALL_DAY = { enabled: true, from: '00:00', to: '00:00' };

test('cli: refuses with exit 2 when kickoff.enabled is false; runs nothing', () => {
  const sb = cliSandbox();
  const r = sb.run(['kickoff']);
  assert.equal(r.code, 2);
  assert.match(r.err, /refused: kickoff is off/);
  assert.deepEqual(sb.calls(), []);
  assert.equal(existsSync(join(sb.home, 'kickoff.json')), false);
});

test('cli: own account only: decides on ~/.claude samples and runs claude without CLAUDE_CONFIG_DIR', () => {
  const sb = cliSandbox({ kickoff: ALL_DAY });
  const now = Date.now();
  sb.writeSamples(sb.claude, [sample(now - 6 * H, 90, now - 10 * MIN)]); // own window ended
  sb.writeSamples(sb.other, [sample(now - 10 * MIN, 5, now + 3 * H)]); // the other account is live: ignored
  const dry = sb.run(['kickoff', '--dry-run']);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /^would run/);
  assert.match(dry.out, /argv: \["claude","-p","Reply with the single word OK.","--model","haiku"\]/);
  assert.match(dry.out, /unsets CLAUDE_CONFIG_DIR, KADANS_THROTTLE/);
  assert.deepEqual(sb.calls(), []); // --dry-run changes nothing
  assert.equal(existsSync(join(sb.home, 'kickoff.json')), false);

  const r = sb.run(['kickoff']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /started the next window/);
  const calls = sb.calls();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^cfg=unset thr=unset pwd=.*kadans-kickoff-.* args=-p Reply with the single word OK\. --model haiku$/);
  const second = sb.run(['kickoff']);
  assert.equal(second.code, 0);
  assert.match(second.out, /window already running \(Kadans started it\), nothing to do/);
  assert.equal(sb.calls().length, 1);
});

test('cli: a live own window says so and exits 0', () => {
  const sb = cliSandbox({ kickoff: ALL_DAY });
  const now = Date.now();
  sb.writeSamples(sb.claude, [sample(now - 10 * MIN, 20, now + H)]);
  const r = sb.run(['kickoff']);
  assert.equal(r.code, 0);
  assert.match(r.out, /window already running .*nothing to do/);
  assert.deepEqual(sb.calls(), []);
});

test('schedule preview: plist and launchctl lines printed, nothing written; uninstall mentions it', () => {
  const sb = cliSandbox();
  const r = sb.run(['kickoff', 'schedule']);
  assert.equal(r.code, 0, r.err);
  const agents = join(sb.root, 'Library', 'LaunchAgents');
  assert.match(r.out, new RegExp(`would write ${agents}/dev\\.kadans\\.kickoff\\.plist`));
  assert.match(r.out, /<key>Label<\/key><string>dev\.kadans\.kickoff<\/string>/);
  assert.match(r.out, /<key>StartInterval<\/key><integer>900<\/integer>/);
  assert.ok(r.out.includes(`<string>${process.execPath}</string>`));
  assert.ok(r.out.includes(`<string>${BIN}</string>`));
  assert.match(r.out, /<string>kickoff<\/string>/);
  assert.match(r.out, /<key>KADANS_HOME<\/key>/);
  assert.match(r.out, /launchctl bootout gui\/\d+\/dev\.kadans\.kickoff/);
  assert.match(r.out, /launchctl bootstrap gui\/\d+ /);
  assert.match(r.out, /preview: nothing written\. To apply: kadans kickoff schedule --apply/);
  assert.doesNotMatch(r.out, /https?:\/\//);
  assert.equal(existsSync(agents), false);
  const u = sb.run(['kickoff', 'unschedule']);
  assert.match(u.out, /launchctl bootout gui\/\d+\/dev\.kadans\.kickoff/);
  assert.match(u.out, /preview: nothing written/);
  assert.match(sb.run(['uninstall']).out, /kickoff unschedule --apply/);
  assert.equal(sb.run(['kickoff', 'frob']).code, 2);
});

test('schedule plist is valid (plutil) and escapes paths', { skip: !existsSync('/usr/bin/plutil') }, () => {
  const dir = tmpHome();
  const text = plistText({ node: '/x/node', bin: '/opt/my apps/a&b/kadans.mjs', path: '/usr/bin:/bin' });
  assert.ok(text.includes('my apps/a&amp;b'));
  const f = join(dir, 'k.plist');
  writeFileSync(f, text);
  const r = spawnSync('/usr/bin/plutil', ['-lint', f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('schedule/unschedule --apply (fake launchctl, temp folder): write, bootout, bootstrap; then remove', () => {
  const dir = join(tmpHome(), 'LaunchAgents');
  const seen = [];
  const exec = (argv) => {
    seen.push(argv.join(' '));
    return { status: argv[1] === 'bootout' ? 3 : 0, err: '' }; // bootout fails when not loaded: ignored
  };
  const p = schedulePlan('schedule', { env: { PATH: '/usr/bin' }, node: '/n/node', bin: '/b/kadans.mjs', uid: 501, dir });
  assert.equal(p.file, join(dir, `${LABEL}.plist`));
  assert.match(applySchedule(p, { exec }), /loaded it \(every 15 minutes\)/);
  assert.equal(readFileSync(p.file, 'utf8'), p.plist);
  assert.ok(p.plist.includes(`<integer>${INTERVAL_S}</integer>`));
  assert.deepEqual(seen, [`launchctl bootout gui/501/${LABEL}`, `launchctl bootstrap gui/501 ${p.file}`]);
  const bad = (argv) => ({ status: argv[1] === 'bootstrap' ? 5 : 0, err: 'boom' });
  assert.throws(() => applySchedule(p, { exec: bad }), /launchctl bootstrap failed: boom/);
  const u = schedulePlan('unschedule', { bin: '/b/kadans.mjs', uid: 501, dir });
  seen.length = 0;
  applySchedule(u, { exec });
  assert.equal(existsSync(p.file), false);
  assert.deepEqual(seen, [`launchctl bootout gui/501/${LABEL}`]);
});

test('config: kickoff.enabled / kickoff.from / kickoff.to are allowed, defaults off 07:00-23:00, bad values refused', () => {
  const home = tmpHome();
  assert.deepEqual(loadConfig(home).kickoff, { enabled: false, from: '07:00', to: '23:00' });
  assert.deepEqual(parseSetting('kickoff.enabled', 'true', 'aaaaaaaaaaaa'), { path: ['kickoff', 'enabled'], value: true });
  assert.deepEqual(parseSetting('kickoff.from', '06:30', 'aaaaaaaaaaaa'), { path: ['kickoff', 'from'], value: '06:30' });
  assert.deepEqual(parseSetting('kickoff.to', '00:00', 'aaaaaaaaaaaa'), { path: ['kickoff', 'to'], value: '00:00' });
  for (const [k, v] of [['kickoff.enabled', 'yes'], ['kickoff.from', '7:00'], ['kickoff.from', '24:00'], ['kickoff.to', '23:60'],
    ['kickoff.to', '2300'], ['kickoff.to', ' 23:00'], ['kickoff', 'true'], ['kickoff.argv', 'x']]) {
    assert.ok(parseSetting(k, v, 'aaaaaaaaaaaa').error, `${k}=${v} should be refused`);
  }
  setSetting(home, 'kickoff.enabled', 'true', { ownKey: 'aaaaaaaaaaaa' });
  setSetting(home, 'kickoff.from', '08:00', { ownKey: 'aaaaaaaaaaaa' });
  assert.deepEqual(loadConfig(home).kickoff, { enabled: true, from: '08:00', to: '23:00' });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ kickoff: { enabled: 'true', from: 'x', to: 7 } }));
  assert.deepEqual(loadConfig(home).kickoff, { enabled: false, from: '07:00', to: '23:00' }); // only a real true turns it on
  const sb = cliSandbox();
  const g = JSON.parse(sb.run(['config', 'get', '--json']).out);
  assert.deepEqual(g.kickoff, { enabled: false, from: '07:00', to: '23:00' });
});
