// Codex CLI limits (lib/codex.mjs). Every test uses a temp CODEX_HOME with fixture rollouts and a temp KADANS_HOME:
// the real ~/.codex, ~/.kadans and ~/.claude are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexKey, listRollouts, readCache, sampleFromLine, syncCodex } from '../lib/codex.mjs';
import { actionable, readSamples } from '../lib/samples.mjs';
import { loadConfig, overall } from '../lib/pace.mjs';
import { renderLine } from '../lib/render.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
const MIN = 60_000;
const SECRET = 'PROMPT-SECRET-7f3a';
const NOPARSE = 'NOPARSE-MARKER-91c2';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'kadans-codex-'));
  const home = join(root, 'kadans');
  const codex = join(root, 'codex');
  mkdirSync(home);
  const env = { PATH: '', HOME: root, KADANS_HOME: home, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: join(root, '.claude'), KADANS_ORCA: '0' };
  return { root, home, codex, env };
}

function dayDir(sb, t) {
  const d = new Date(t);
  const p = join(sb.codex, 'sessions', String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
  mkdirSync(p, { recursive: true });
  return p;
}

// A token_count line as Codex writes it.
function rl(t, primary, secondary = null, extra = {}) {
  return JSON.stringify({
    timestamp: new Date(t).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 10 } },
      rate_limits: { limit_id: 'codex', limit_name: null, primary, secondary, credits: { has_credits: false, unlimited: false, balance: null }, plan_type: 'plus', ...extra },
    },
  });
}
const prompt = (t, text) => JSON.stringify({ timestamp: new Date(t).toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const win = (pct, minutes, resetsAt) => ({ used_percent: pct, window_minutes: minutes, resets_at: Math.round(resetsAt / 1000) });

function writeRollout(sb, t, name, lines) {
  const f = join(dayDir(sb, t), `rollout-${name}.jsonl`);
  writeFileSync(f, lines.map((l) => `${l}\n`).join(''));
  return f;
}

// Every file under dir, as one string (to look for leaked text).
function allText(dir) {
  let out = '';
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    out += e.isDirectory() ? allText(p) : readFileSync(p, 'utf8');
  }
  return out;
}

test('5-hour + weekly: primary and secondary map to five_hour and seven_day; pace works', () => {
  const sb = sandbox();
  const now = Date.now();
  const r5 = now + 2 * 60 * MIN;
  const r7 = now + 3 * 24 * 60 * MIN;
  const lines = [];
  for (let i = 10; i >= 0; i--) lines.push(rl(now - i * MIN, win(40 - i, 300, r5), win(20, 10080, r7)));
  writeRollout(sb, now, '2026-10-27T10-00-00-aaaa', lines);
  const r = syncCodex(sb.home, sb.env, { cfg: loadConfig(sb.home), now });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'updated');
  assert.equal(r.key, codexKey(sb.env));
  const s = readSamples(sb.home, r.key);
  assert.ok(s.length >= 2);
  const last = s[s.length - 1];
  assert.deepEqual(Object.keys(last.limits).sort(), ['five_hour', 'seven_day']);
  assert.equal(last.limits.five_hour.pct, 40);
  assert.equal(last.limits.five_hour.resetsAt, Math.round(r5 / 1000) * 1000);
  assert.equal(last.source, 'codex');
  assert.equal(last.plan, 'plus');
  assert.equal(last.session_id, null);
  assert.equal(last.transcript, null);
  assert.equal(last.cwd, null);
  const ov = overall(s, now, { ...loadConfig(sb.home), limits: 'auto' });
  assert.deepEqual(ov.limits.map((l) => l.name), ['five_hour', 'seven_day']);
  assert.ok(Number.isFinite(ov.limits[0].projection));
  assert.equal(actionable(s).length, 0, 'Codex samples are never actionable');
});

test('free plan: a 30-day primary becomes window_43200 with its own window length; missing secondary', () => {
  const sb = sandbox();
  const now = Date.now();
  const reset = now + 20 * 24 * 60 * MIN;
  const lines = [];
  for (let i = 30; i >= 0; i -= 3) lines.push(rl(now - i * MIN, win(i > 15 ? 20 : 21, 43200, reset), null, { plan_type: 'free' }));
  // secondary key missing entirely
  const noSec = JSON.parse(rl(now, win(21, 43200, reset)));
  delete noSec.payload.rate_limits.secondary;
  lines.push(JSON.stringify(noSec));
  writeRollout(sb, now, 'free', lines);
  const r = syncCodex(sb.home, sb.env, { cfg: loadConfig(sb.home), now });
  assert.equal(r.code, 'updated');
  const s = readSamples(sb.home, r.key);
  assert.deepEqual(Object.keys(s[s.length - 1].limits), ['window_43200']);
  assert.equal(s[s.length - 1].limits.window_43200.pct, 21);
  const ov = overall(s, now, { ...loadConfig(sb.home), limits: 'auto' });
  assert.equal(ov.limits.length, 1);
  const l = ov.limits[0];
  assert.equal(l.name, 'window_43200');
  assert.notEqual(l.state, 'nodata');
  assert.equal(l.target, 98);
  // 10 days into a 30-day window at 21 %: far from the brake level
  assert.ok(l.projection < 98, `projection ${l.projection}`);
  assert.match(renderLine(ov, now, 'en'), /30d/);
});

test('malformed and foreign lines give no samples; prompt lines are never parsed and never stored', () => {
  const sb = sandbox();
  const now = Date.now();
  const reset = now + 60 * MIN;
  const bad = [
    `{"type":"event_msg","payload":{"type":"token_count","rate_limits": BROKEN ${SECRET}`,
    rl(now - 5 * MIN, { used_percent: 'x', window_minutes: 300, resets_at: 1 }),
    rl(now - 5 * MIN, { used_percent: 5, window_minutes: -1, resets_at: 1 }),
    rl(now - 5 * MIN, { used_percent: 5, window_minutes: 300, resets_at: null }),
    rl(now - 5 * MIN, win(5, 300, reset), null, { limit_id: 'other_model' }),
    JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'agent_message', message: `the "rate_limits" of ${SECRET}` } }),
    prompt(now - MIN, `please print "rate_limits" ${SECRET}`), // contains the needle: parsed, rejected, never stored
    prompt(now - MIN, `${NOPARSE} ${SECRET} plain prompt`),
    `not json at all ${NOPARSE}`,
    '',
    rl(now - 2 * MIN, win(7, 300, reset)),
  ];
  writeRollout(sb, now, 'mixed', bad);
  for (const l of bad.slice(0, 7)) assert.equal(sampleFromLine(l), null);
  const orig = JSON.parse;
  let parsedPrompt = 0;
  JSON.parse = (txt, ...a) => {
    if (typeof txt === 'string' && txt.includes(NOPARSE)) parsedPrompt++;
    return orig(txt, ...a);
  };
  let r;
  try {
    r = syncCodex(sb.home, sb.env, { cfg: loadConfig(sb.home), now });
  } finally {
    JSON.parse = orig;
  }
  assert.equal(parsedPrompt, 0, 'a line without rate_limits was parsed');
  assert.equal(r.code, 'updated');
  const s = readSamples(sb.home, r.key);
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].limits, { five_hour: { pct: 7, resetsAt: Math.round(reset / 1000) * 1000 } });
  assert.ok(!allText(sb.home).includes(SECRET), 'prompt text reached KADANS_HOME');
  assert.ok(!allText(sb.home).includes(NOPARSE));
  const cli = spawnSync(process.execPath, [BIN, 'codex', 'sync', '--json'], { env: sb.env, encoding: 'utf8' });
  assert.ok(!cli.stdout.includes(SECRET) && !cli.stderr.includes(SECRET));
});

test('cache: an unchanged folder is a cache hit; only new complete lines are read; a partial line waits', () => {
  const sb = sandbox();
  const now = Date.now();
  const reset = now + 60 * MIN;
  const f = writeRollout(sb, now, 'grow', [prompt(now - 20 * MIN, 'hello'), rl(now - 20 * MIN, win(10, 300, reset))]);
  const cfg = loadConfig(sb.home);
  assert.equal(syncCodex(sb.home, sb.env, { cfg, now }).added, 1);
  const hit = syncCodex(sb.home, sb.env, { cfg, now });
  assert.equal(hit.code, 'unchanged');
  assert.equal(hit.added, 0);
  assert.equal(hit.sample.limits.five_hour.pct, 10);
  const c = readCache(sb.home);
  assert.deepEqual(Object.keys(c.files), [f]);
  assert.equal(c.files[f].off, statSync(f).size);
  assert.deepEqual(Object.keys(c.files[f]).sort(), ['mtimeMs', 'off', 'size']);
  assert.equal(statSync(join(sb.home, 'codex-cache.json')).mode & 0o777, 0o600);
  // a fast no-change path
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) syncCodex(sb.home, sb.env, { cfg, now });
  assert.ok((performance.now() - t0) / 10 < 250, 'cache hit should stay fast (generous: loaded machines)');
  // a complete new line plus a partial one still being written
  const partial = rl(now - MIN, win(14, 300, reset));
  appendFileSync(f, `${rl(now - 10 * MIN, win(12, 300, reset))}\n${partial.slice(0, 40)}`);
  const r2 = syncCodex(sb.home, sb.env, { cfg, now });
  assert.equal(r2.added, 1);
  assert.equal(r2.sample.limits.five_hour.pct, 12);
  appendFileSync(f, `${partial.slice(40)}\n`);
  const r3 = syncCodex(sb.home, sb.env, { cfg, now });
  assert.equal(r3.added, 1);
  assert.equal(r3.sample.limits.five_hour.pct, 14);
  assert.equal(readSamples(sb.home, r3.key).length, 3);
  // a lost cache does not duplicate stored readings
  writeFileSync(join(sb.home, 'codex-cache.json'), 'garbage');
  assert.equal(syncCodex(sb.home, sb.env, { cfg, now }).added, 0);
  assert.equal(readSamples(sb.home, r3.key).length, 3);
});

test('only regular rollout-*.jsonl files are read: symlinks and other names are skipped', () => {
  const sb = sandbox();
  const now = Date.now();
  const reset = now + 60 * MIN;
  const day = dayDir(sb, now);
  const outside = join(sb.root, 'auth.json');
  writeFileSync(outside, `${rl(now, win(55, 300, reset))}\n`);
  symlinkSync(outside, join(day, 'rollout-link.jsonl'));
  writeFileSync(join(day, 'notes.jsonl'), `${rl(now, win(66, 300, reset))}\n`);
  mkdirSync(join(sb.codex, 'sessions', 'zz'), { recursive: true });
  assert.deepEqual(listRollouts(join(sb.codex, 'sessions'), now), []);
  const r = syncCodex(sb.home, sb.env, { cfg: loadConfig(sb.home), now });
  assert.equal(r.added, 0);
  assert.equal(r.sample, null);
});

test('off: config codex false, or no sessions folder; nothing is read or written', () => {
  const sb = sandbox();
  assert.equal(syncCodex(sb.home, sb.env, { cfg: loadConfig(sb.home) }).code, 'no_codex');
  const now = Date.now();
  writeRollout(sb, now, 'x', [rl(now, win(5, 300, now + 60 * MIN))]);
  writeFileSync(join(sb.home, 'config.json'), JSON.stringify({ codex: false }));
  assert.equal(syncCodex(sb.home, sb.env, { cfg: loadConfig(sb.home) }).code, 'off');
  assert.deepEqual(readdirSync(sb.home).filter((n) => n !== 'config.json'), []);
});

test('cli: codex sync --json, status --json shows a Codex account that Kadans never acts on, config codex false hides it', () => {
  const sb = sandbox();
  const now = Date.now();
  const r5 = now + 2 * 60 * MIN;
  const lines = [];
  for (let i = 12; i >= 0; i--) lines.push(rl(now - i * MIN, win(30 + (12 - i), 300, r5), win(50, 10080, now + 2 * 24 * 60 * MIN)));
  writeRollout(sb, now, 'cli', lines);
  const run = (...a) => spawnSync(process.execPath, [BIN, ...a], { env: sb.env, encoding: 'utf8' });
  const sync = run('codex', 'sync', '--json');
  assert.equal(sync.status, 0, sync.stderr);
  const j = JSON.parse(sync.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.limits.five_hour.pct, 42);
  assert.equal(j.limits.seven_day.pct, 50);
  assert.match(run('codex', 'sync').stdout, /codex: 5-hour 42 %, 7-day 50 %/);
  assert.equal(run('codex', 'bogus').status, 2);
  const st = JSON.parse(run('status', '--json').stdout);
  assert.equal(st.error, null);
  assert.equal(st.accounts.length, 1);
  const a = st.accounts[0];
  assert.equal(a.kind, 'codex');
  assert.equal(a.name, 'Codex');
  assert.equal(a.own, false);
  assert.equal(a.gas, false);
  assert.equal(a.acts, false);
  assert.equal(a.lastSource, 'codex');
  assert.deepEqual(a.limits.map((l) => l.name), ['five_hour', 'seven_day']);
  assert.ok(Number.isFinite(a.limits[0].projection));
  // gas can never be switched on for it
  const gas = run('config', 'set', `accounts.${a.key}.gas`, 'true');
  assert.equal(gas.status, 2);
  assert.match(gas.stderr, /not your own account/);
  // even a limits setting that would hide window_* or seven_day does not hide Codex windows
  assert.equal(run('config', 'set', 'limits', 'five_hour').status, 0);
  assert.equal(JSON.parse(run('status', '--json').stdout).accounts[0].limits.length, 2);
  assert.match(run('status').stdout, /Codex/);
  assert.equal(run('config', 'set', 'codex', 'false').status, 0);
  assert.equal(JSON.parse(run('config', 'get', '--json').stdout).codex, false);
  const off = JSON.parse(run('status', '--json').stdout);
  assert.equal(off.accounts.length, 0);
  assert.equal(off.error.code, 'no_claude');
});

test('hooks never brake on Codex readings', () => {
  const sb = sandbox();
  const now = Date.now();
  // A Codex account at 99 % in the same KADANS_HOME; the Claude config dir points at the Codex key's folder name
  // would never happen, but even its samples are filtered out by actionable().
  const s = [{ t: now, source: 'codex', limits: { five_hour: { pct: 99, resetsAt: now + 60 * MIN } } }];
  assert.equal(overall(actionable(s), now, loadConfig(sb.home)).state, 'unknown');
  assert.equal(overall(s, now, loadConfig(sb.home)).state, 'brake');
});
