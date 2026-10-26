import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountKey } from '../lib/samples.mjs';
import {
  AUTO_SLOW_TTL_MS,
  activeEntry,
  autoStep,
  paceOf,
  parseUntil,
  readPace,
  runPacePost,
  runPacePre,
  setAutopace,
  setPace,
  slowSeconds,
} from '../lib/pace-control.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 26, 12, 0);
const RESET = NOW + 120 * MIN;
const OWN = '/x/own/.claude';

function sb({ autopace = false, cfg = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'kadans-pace-'));
  if (autopace || Object.keys(cfg).length) writeFileSync(join(home, 'config.json'), JSON.stringify({ autopace, ...cfg }));
  return { home, env: { KADANS_HOME: home, CLAUDE_CONFIG_DIR: OWN } };
}
const deps = (over = {}) => {
  const slept = [];
  return { slept, now: NOW, ownKey: accountKey(OWN), sleep: (ms) => slept.push(ms), ...over };
};
const input = (sid = 's1', extra = {}) => JSON.stringify({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read', ...extra });
const ov = (state) => ({ state, limit: 'five_hour', limits: [{ name: 'five_hour', state, resetsAt: RESET }] });
const putPace = (home, obj) => writeFileSync(join(home, 'pace.json'), JSON.stringify(obj));

test('fast path: nothing set, autopace off -> no output, no sleep, no file written', async () => {
  const s = sb();
  const d = deps();
  assert.equal(await runPacePre(input(), s.env, d), '');
  assert.equal(await runPacePost(input(), s.env, d), '');
  assert.deepEqual(d.slept, []);
  assert.deepEqual(readdirSync(s.home), []);
  // an entry for another session does not slow this one
  putPace(s.home, { other: { mode: 'slow', until: null, by: 'owner', at: NOW } });
  assert.equal(await runPacePre(input(), s.env, d), '');
  assert.deepEqual(d.slept, []);
});

test('slow: sleeps slowSeconds (default 20, capped at 40) before the tool call, then allows it', async () => {
  const s = sb();
  putPace(s.home, { s1: { mode: 'slow', until: NOW + 30 * MIN, by: 'owner', at: NOW } });
  const d = deps();
  assert.equal(await runPacePre(input(), s.env, d), '');
  assert.deepEqual(d.slept, [20_000]);
  assert.equal(slowSeconds({ pace: { slowSeconds: 90 } }), 40);
  assert.equal(slowSeconds({ pace: { slowSeconds: 'x' } }), 20);
  writeFileSync(join(s.home, 'config.json'), JSON.stringify({ pace: { slowSeconds: 5 } }));
  await runPacePre(input(), s.env, d);
  assert.deepEqual(d.slept, [20_000, 5_000]);
  // expired entries count as none
  const late = deps({ now: NOW + 31 * MIN });
  assert.equal(await runPacePre(input(), s.env, late), '');
  assert.deepEqual(late.slept, []);
});

test('pause: continue false with a stop reason (owner vs auto wording), plus a deny backstop', async () => {
  const s = sb({ autopace: true });
  putPace(s.home, {
    s1: { mode: 'paused', until: RESET, by: 'owner', at: NOW },
    s2: { mode: 'paused', until: null, by: 'auto', at: NOW },
    _auto: { state: 'cruise', windowId: RESET, brakeSince: null, lastStep: NOW },
  });
  const o = JSON.parse(await runPacePre(input('s1'), s.env, deps()));
  assert.equal(o.continue, false);
  assert.match(o.stopReason, /^Paused by Kadans until \d\d:\d\d\. Resume it in Kadans or run `kadans agent pace s1 none`\.$/);
  assert.equal(o.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(o.hookSpecificOutput.hookEventName, 'PreToolUse');
  const a = JSON.parse(await runPacePre(input('s2'), s.env, deps({ ov: ov('early') })));
  assert.equal(a.stopReason, 'Paused by Kadans. Type to resume.');
});

test('UserPromptSubmit through `hook event` lifts an auto pause, never an owner pause', () => {
  const s = sb();
  const root = mkdtempSync(join(tmpdir(), 'kadans-pace-home-'));
  const now = Date.now();
  putPace(s.home, {
    a1: { mode: 'paused', until: now + 60 * MIN, by: 'auto', at: now },
    o1: { mode: 'paused', until: now + 60 * MIN, by: 'owner', at: now },
  });
  const env = { PATH: process.env.PATH, HOME: root, KADANS_HOME: s.home, KADANS_ORCA: '0' };
  for (const sid of ['a1', 'o1']) {
    const r = spawnSync(process.execPath, [BIN, 'hook', 'event'], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: root, prompt: 'go on' }), env, encoding: 'utf8' });
    assert.deepEqual([r.status, r.stdout], [0, '']);
  }
  const p = readPace(s.home);
  assert.equal(p.a1, undefined);
  assert.equal(p.o1.mode, 'paused');
});

test('nudge: only with autopace on and brake/early, at most once per 10 minutes per session', async () => {
  const off = sb();
  assert.equal(await runPacePost(input(), off.env, deps({ ov: ov('brake') })), '');
  const s = sb({ autopace: true });
  const first = JSON.parse(await runPacePost(input(), s.env, deps({ ov: ov('brake') })));
  assert.equal(first.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(first.hookSpecificOutput.additionalContext, /running hot.*Finish the current step, do not start subagents or workflows, and read less/);
  assert.equal(await runPacePost(input(), s.env, deps({ now: NOW + 5 * MIN, ov: ov('brake') })), '');
  assert.notEqual(await runPacePost(input('s2'), s.env, deps({ now: NOW + 5 * MIN, ov: ov('brake') })), ''); // own throttle per session
  assert.notEqual(await runPacePost(input(), s.env, deps({ now: NOW + 10 * MIN, ov: ov('early') })), '');
  // cruise: no nudge
  const c = sb({ autopace: true });
  assert.equal(await runPacePost(input(), c.env, deps({ ov: ov('cruise') })), '');
});

test('auto-pace: brake slows after 10 minutes (not urgent work), lifts on cruise and on a new window, owner entries stay', async () => {
  const s = sb({ autopace: true });
  const at = (m, state, extra = {}) => deps({ now: NOW + m * MIN, ov: { ...ov(state), ...extra } });
  let d = at(0, 'brake');
  assert.equal(await runPacePre(input('s1'), s.env, d), '');
  assert.deepEqual(d.slept, []); // brake just started
  assert.equal(readPace(s.home)._auto.brakeSince, NOW);
  d = at(11, 'brake');
  await runPacePre(input('s1'), s.env, d);
  assert.deepEqual(d.slept, [20_000]);
  const e = readPace(s.home).s1;
  assert.deepEqual([e.mode, e.by, e.until], ['slow', 'auto', NOW + 11 * MIN + AUTO_SLOW_TTL_MS]);
  // urgent claimed task: never auto-slowed
  writeFileSync(join(s.home, 'tasks.json'), JSON.stringify([{ id: 1, projectId: 1, text: 'x', urgency: 'urgent', status: 'running', claimedBy: 's2', approved: true }]));
  d = at(12, 'brake');
  await runPacePre(input('s2'), s.env, d);
  assert.deepEqual(d.slept, []);
  // owner entry for s3 stays through a lift
  setPace(s.home, 's3', 'slow', { until: null, now: NOW + 12 * MIN });
  d = at(14, 'cruise');
  await runPacePre(input('s1'), s.env, d);
  assert.deepEqual(d.slept, []);
  const p = readPace(s.home);
  assert.equal(p.s1, undefined);
  assert.equal(p.s3.by, 'owner');
  // new window lifts too
  const w = sb({ autopace: true });
  await runPacePre(input('s1'), w.env, at(0, 'brake'));
  await runPacePre(input('s1'), w.env, at(11, 'brake'));
  assert.equal(readPace(w.home).s1.by, 'auto');
  const nd = deps({ now: NOW + 13 * MIN, ov: { ...ov('brake'), limits: [{ name: 'five_hour', state: 'brake', resetsAt: RESET + 300 * MIN }] } });
  await runPacePre(input('s1'), w.env, nd);
  assert.deepEqual(nd.slept, []); // lifted; brake timer restarts
  assert.equal(readPace(w.home).s1, undefined);
  // turning autopace off lifts the rest and ignores auto entries at once
  await runPacePre(input('s1'), w.env, at(30, 'brake', { limits: [{ name: 'five_hour', state: 'brake', resetsAt: RESET + 300 * MIN }] }));
  assert.equal(readPace(w.home).s1?.by, 'auto');
  setAutopace(w.home, false, { now: NOW + 31 * MIN });
  assert.equal(readPace(w.home).s1, undefined);
  assert.equal(JSON.parse(readFileSync(join(w.home, 'config.json'), 'utf8')).autopace, false);
});

test('autoStep is pure: brake timer, lift and renew', () => {
  const a = autoStep({}, ov('brake'), NOW);
  assert.deepEqual([a.auto.brakeSince, a.lift, a.renew], [NOW, false, true]);
  const b = autoStep(a.auto, ov('brake'), NOW + 5 * MIN);
  assert.equal(b.auto.brakeSince, NOW);
  assert.equal(autoStep(b.auto, ov('early'), NOW).auto.brakeSince, null);
  assert.equal(autoStep(b.auto, ov('gas'), NOW).lift, true);
  assert.equal(autoStep(b.auto, ov('unknown'), NOW).lift, false);
  const drift = { ...ov('brake'), limits: [{ name: 'five_hour', state: 'brake', resetsAt: RESET + 30_000 }] };
  assert.equal(autoStep(b.auto, drift, NOW).lift, false); // resets_at drift within a minute is the same window
});

test('another account is never paced, even with an entry and autopace on', async () => {
  const s = sb({ autopace: true });
  putPace(s.home, { s1: { mode: 'paused', until: null, by: 'owner', at: NOW } });
  const other = { ...s.env, CLAUDE_CONFIG_DIR: '/x/other/profile' };
  const d = deps({ ov: ov('brake') });
  assert.equal(await runPacePre(input('s1'), other, d), '');
  assert.equal(await runPacePost(input('s1'), other, d), '');
  assert.deepEqual(d.slept, []);
  assert.equal(readPace(s.home)._auto, undefined); // not even a gauge step
});

test('garbage stdin and odd entries: no output, never throws past the CLI', async () => {
  const s = sb();
  putPace(s.home, { s1: { mode: 'zoom', until: null }, _auto: 'x' });
  assert.equal(activeEntry(readPace(s.home), 's1', NOW), null);
  assert.equal(await runPacePre(input('_auto'), s.env, deps()), '');
  for (const kind of ['pace-pre', 'pace-post']) {
    const r = spawnSync(process.execPath, [BIN, 'hook', kind], { input: 'garbage', env: { PATH: process.env.PATH, KADANS_HOME: s.home }, encoding: 'utf8' });
    assert.deepEqual([r.status, r.stdout], [0, '']);
  }
});

test('parseUntil and paceOf', () => {
  assert.equal(parseUntil(undefined, NOW, RESET), RESET);
  assert.equal(parseUntil('reset', NOW, null), null);
  assert.equal(parseUntil('30m', NOW, RESET), NOW + 30 * MIN);
  assert.equal(parseUntil('2h', NOW, RESET), NOW + 120 * MIN);
  assert.throws(() => parseUntil('soon', NOW, RESET));
  const p = { a: { mode: 'paused', until: RESET, by: 'owner' }, b: { mode: 'slow', until: null, by: 'auto' } };
  assert.deepEqual(paceOf(p, 'a', NOW), { mode: 'paused', until: RESET, by: 'owner' });
  assert.deepEqual(paceOf(p, 'b', NOW, false), { mode: 'none', until: null, by: null }); // auto entries hidden when autopace is off
  assert.equal(paceOf(p, 'a', RESET + 1).mode, 'none');
});

test('cli: agent pace sets and clears an own session; agents --json shows pace; Orca-only rows refused; status has autopace', () => {
  const root = mkdtempSync(join(tmpdir(), 'kadans-pace-cli-'));
  const home = join(root, 'kadans');
  mkdirSync(home);
  const env = { PATH: process.env.PATH, HOME: root, KADANS_HOME: home, KADANS_ORCA: '0' };
  const cli = (args, inp = '') => spawnSync(process.execPath, [BIN, ...args], { input: inp, env, encoding: 'utf8' });
  cli(['hook', 'event'], JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'abcd1234-own', cwd: root, prompt: 'hello' }));
  let r = cli(['agent', 'pace', 'abcd1234', 'pause', '--until', '30m']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /paused until \d\d:\d\d/);
  let a = JSON.parse(cli(['agents', '--json']).stdout).find((x) => x.id === 'abcd1234-own');
  assert.equal(a.pace.mode, 'paused');
  assert.ok(a.pace.until > Date.now() + 25 * MIN);
  assert.match(cli(['agents']).stdout, /^paused/m);
  r = cli(['agent', 'pace', 'abcd1234', 'slow']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /slowed until resumed/); // no samples, so no reset time
  assert.equal(cli(['agent', 'pace', 'abcd1234', 'none']).status, 0);
  a = JSON.parse(cli(['agents', '--json']).stdout).find((x) => x.id === 'abcd1234-own');
  assert.deepEqual(a.pace, { mode: 'none', until: null });
  assert.equal(cli(['agent', 'pace', 'abcd1234', 'fast']).status, 2);
  assert.equal(cli(['agent', 'pace', 'nope-nope', 'slow']).status, 2);
  assert.equal(JSON.parse(cli(['status', '--json']).stdout).autopace, false);
  assert.equal(cli(['autopace', 'on']).status, 0);
  assert.equal(JSON.parse(cli(['status', '--json']).stdout).autopace, true);
  assert.equal(existsSync(join(root, '.kadans')), false); // only the temp KADANS_HOME was used
});

test('cli: a session recorded under another account is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'kadans-pace-acct-'));
  const home = join(root, 'kadans');
  const other = accountKey('/x/other');
  mkdirSync(join(home, 'accounts', other), { recursive: true });
  const now = Date.now();
  writeFileSync(join(home, 'accounts', other, 'samples.jsonl'), `${JSON.stringify({ t: now, session_id: 'bbbb2222-x', cwd: root, limits: { five_hour: { pct: 10, resetsAt: now + 100 * MIN } } })}\n`);
  const env = { PATH: process.env.PATH, HOME: root, KADANS_HOME: home, KADANS_ORCA: '0' };
  const r = spawnSync(process.execPath, [BIN, 'agent', 'pace', 'bbbb2222', 'slow'], { env, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /another account/);
  assert.equal(existsSync(join(home, 'pace.json')), false);
});
