import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountKey } from '../lib/samples.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
const MIN = 60_000;

// Temp HOME, KADANS_HOME and CLAUDE_CONFIG_DIR: the real ~/.kadans and ~/.claude are never touched.
// The own account is HOME/.claude; `other` stands for any other config dir.
function sandbox({ ownDir = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kadans-status-'));
  const home = join(root, 'kadans');
  mkdirSync(home);
  const own = join(root, '.claude');
  if (ownDir) mkdirSync(own);
  const env = { PATH: '', HOME: root, KADANS_HOME: home, CLAUDE_CONFIG_DIR: ownDir ? own : join(root, 'missing'), KADANS_ORCA: '0' };
  return { root, home, own, other: join(root, 'other'), env };
}

function writeSamples(sb, dir, samples) {
  const d = join(sb.home, 'accounts', accountKey(dir));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'samples.jsonl'), samples.map((s) => JSON.stringify(s)).join('\n') + '\n');
}

// A steady climb in the 5-hour window: `n` samples one minute apart ending now, `perMin` points a minute.
function climb(now, { start, perMin, n = 12, resetIn = 120 * MIN, seven = null }) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = now - i * MIN;
    const limits = { five_hour: { pct: start + (n - 1 - i) * perMin, resetsAt: now + resetIn } };
    if (seven) limits.seven_day = { pct: seven, resetsAt: now + 3 * 24 * 60 * MIN };
    out.push({ t, session_id: 's1', cwd: '/x', limits });
  }
  return out;
}

function statusJson(sb) {
  const r = spawnSync(process.execPath, [BIN, 'status', '--json'], { env: sb.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('status --json: no samples gives error no_data, empty accounts', () => {
  const sb = sandbox();
  const s = statusJson(sb);
  assert.equal(s.version, 1);
  assert.equal(typeof s.now, 'number');
  assert.equal(s.error.code, 'no_data');
  assert.equal(typeof s.error.at, 'number');
  assert.deepEqual(s.accounts, []);
  assert.deepEqual(s.queue, { ready: 0, next: [], startable: [] });
});

test('status --json: no config dir and no claude on PATH gives no_claude', () => {
  const sb = sandbox({ ownDir: false });
  assert.equal(statusJson(sb).error.code, 'no_claude');
});

test('status --json: an empty samples file still counts as no data', () => {
  const sb = sandbox();
  mkdirSync(join(sb.home, 'accounts', accountKey(sb.own)), { recursive: true });
  writeFileSync(join(sb.home, 'accounts', accountKey(sb.own), 'samples.jsonl'), '');
  const s = statusJson(sb);
  assert.equal(s.error.code, 'no_data');
  assert.equal(s.accounts.length, 0);
});

test('status --json: brake account carries the overall state and a finite brakeAt', () => {
  const sb = sandbox();
  const now = Date.now();
  writeSamples(sb, sb.own, climb(now, { start: 60, perMin: 1 }));
  const s = statusJson(sb);
  assert.equal(s.error, null);
  assert.equal(s.accounts.length, 1);
  const a = s.accounts[0];
  assert.equal(a.key, accountKey(sb.own));
  assert.equal(a.own, true);
  assert.equal(a.label, 'Your account');
  assert.equal(a.configDir, '~/.claude');
  assert.equal(a.state, 'brake');
  assert.equal(a.limit, 'five_hour');
  const l = a.limits[0];
  assert.equal(l.name, 'five_hour');
  assert.equal(l.state, 'brake');
  assert.equal(l.pct, 71);
  assert.ok(l.projection > 98);
  assert.equal(typeof l.brakeAt, 'number');
  assert.ok(l.brakeAt > s.now && l.brakeAt < l.resetsAt);
  assert.equal(l.target, 97);
  assert.equal(l.samples, 12);
  assert.equal(l.ended, false);
  for (const k of ['rate', 'needle', 'timeLeft', 'lastT']) assert.equal(typeof l[k], 'number', k);
});

test('status --json: flat usage has brakeAt null (never Infinity) and gas only when opted in', () => {
  const sb = sandbox();
  const now = Date.now();
  writeSamples(sb, sb.own, climb(now, { start: 0, perMin: 0, resetIn: 290 * MIN }));
  let a = statusJson(sb).accounts[0];
  assert.equal(a.limits[0].brakeAt, null);
  assert.equal(a.state, 'gas');
  assert.equal(a.gas, false);
  writeFileSync(join(sb.home, 'config.json'), JSON.stringify({ accounts: { [accountKey(sb.own)]: { gas: true } } }));
  a = statusJson(sb).accounts[0];
  assert.equal(a.gas, true);
});

test('status --json: other accounts are own:false and gas:false even when the config opts them in', () => {
  const sb = sandbox();
  const now = Date.now();
  writeSamples(sb, sb.other, climb(now, { start: 10, perMin: 0.05 }));
  writeSamples(sb, sb.own, climb(now, { start: 20, perMin: 0.05 }));
  writeFileSync(join(sb.home, 'config.json'), JSON.stringify({ accounts: { [accountKey(sb.other)]: { gas: true } } }));
  const s = statusJson(sb);
  assert.equal(s.accounts.length, 2);
  assert.equal(s.accounts[0].own, true, 'own account first');
  const other = s.accounts.find((a) => a.key === accountKey(sb.other));
  assert.equal(other.own, false);
  assert.equal(other.gas, false);
  assert.equal(other.configDir, null);
  assert.equal(other.label, 'Other account');
});

test('status --json: two limits are both listed', () => {
  const sb = sandbox();
  const now = Date.now();
  writeSamples(sb, sb.own, climb(now, { start: 30, perMin: 0.1, seven: 52 }));
  const a = statusJson(sb).accounts[0];
  assert.deepEqual(a.limits.map((l) => l.name), ['five_hour', 'seven_day']);
  assert.equal(a.limits[1].pct, 52);
  assert.equal(a.limits[1].target, 98);
});

test('status --json: queue lists the top 3 queued tasks with project names and counts approved ones as ready', () => {
  const sb = sandbox();
  const run = (args) => spawnSync(process.execPath, [BIN, ...args], { env: sb.env, encoding: 'utf8' });
  run(['project', 'add', 'Alpha', sb.root]);
  run(['task', 'add', 'Alpha', 'first', '--urgent', '--approved']);
  run(['task', 'add', 'Alpha', 'second', '--week']);
  run(['task', 'add', 'Alpha', 'third', '--idle', '--approved']);
  run(['task', 'add', 'Alpha', 'fourth', '--idle']);
  run(['task', 'done', '3']);
  run(['task', 'add', 'Alpha', 'fifth', '--idle']);
  const s = statusJson(sb);
  assert.equal(s.error.code, 'no_data', 'queue is filled even without samples');
  assert.equal(s.queue.ready, 1);
  assert.equal(s.queue.next.length, 3);
  assert.deepEqual(s.queue.next[0], { id: 1, text: 'first', project: 'Alpha', urgency: 'urgent', approved: true });
  assert.equal(s.queue.next[1].text, 'second');
  assert.equal(s.queue.next[1].approved, false);
  assert.deepEqual(s.queue.startable, [{ id: 1, text: 'first', project: 'Alpha', urgency: 'urgent' }]);
});

test('status without --json keeps the plain text output', () => {
  const sb = sandbox();
  const r = spawnSync(process.execPath, [BIN, 'status'], { env: sb.env, encoding: 'utf8' });
  assert.equal(r.stdout, 'no accounts recorded yet\n');
});
