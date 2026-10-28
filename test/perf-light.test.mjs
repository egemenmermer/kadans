// perf-1-light: the closed-popover brief skips its count (Orca, ps) while nothing event-driven changed, and the menu bar
// app's tick is one node start (`kadans live --json [--brief]`). Temp dirs and a fake orca only: no real ~/.claude or ~/.kadans.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIEF_REUSE_MS, PROC_RECHECK_MS, appendEvent, briefFor, briefInputs, realInspect } from '../lib/agents.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'kadans-perf-'));

function sandbox() {
  const root = tmp();
  const home = join(root, 'home');
  const claude = join(root, 'claude');
  mkdirSync(join(claude, 'sessions'), { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, home, claude };
}

test('briefFor: counts once, reuses while the inputs are unchanged and young, counts again on an event, a session file or age', async () => {
  const { home, claude } = sandbox();
  let T = Date.parse('2026-10-27T12:00:00Z');
  appendEvent(home, { t: T - 1000, ev: 'UserPromptSubmit', sid: 's1', cwd: '/p', prompt: 'go' }, T);
  let counts = 0;
  const list = [{ id: 's1', status: 'working' }, { id: 's2', status: 'needs-you' }];
  const ask = () => briefFor(home, { now: T, claudeDirs: [claude], freshMs: 0, count: async () => { counts++; return list; } });

  const a = await ask();
  assert.deepEqual([a.reused, a.brief, counts], [false, { working: 1, needsYou: 1, t: T }, 1]);
  assert.deepEqual(Object.keys(a.brief), ['working', 'needsYou', 't']); // the contract shape, never the fingerprint
  T += 20_000;
  const b = await ask();
  assert.deepEqual([b.reused, b.brief.t, counts], [true, T - 20_000, 1], 'nothing changed: no count');

  T += 1000;
  appendEvent(home, { t: T, ev: 'Stop', sid: 's1', cwd: '/p' }, T); // a hook event
  assert.equal((await ask()).reused, false);
  assert.equal(counts, 2);
  assert.equal((await ask()).reused, true);

  T += 1000;
  writeFileSync(join(claude, 'sessions', '4242.json'), '{}'); // a session started (registry file)
  assert.equal((await ask()).reused, false);
  assert.equal(counts, 3);

  T += BRIEF_REUSE_MS + 1; // the cap: the time rules (WORKING_MS) still show, at most this much later
  assert.equal((await ask()).reused, false);
  assert.equal(counts, 4);

  // the count gap (the app's CPU budget): no count within it, even after a hook event
  T += 1000;
  appendEvent(home, { t: T, ev: 'UserPromptSubmit', sid: 's1', cwd: '/p', prompt: 'again' }, T);
  const gap = (ms) => briefFor(home, { now: T, claudeDirs: [claude], freshMs: 0, minGapMs: ms, count: async () => { counts++; return list; } });
  assert.deepEqual([(await gap(30_000)).reused, counts], [true, 4]);
  T += 30_000;
  assert.deepEqual([(await gap(30_000)).reused, counts], [false, 5], 'past the gap: the changed inputs are counted');

  T -= 10 * 60_000; // a clock that went back never reuses a brief from the future
  assert.equal((await gap(10 * 60_000)).reused, false);
  assert.equal(counts, 6);
});

test('briefFor: a full list brief younger than freshMs is served first; a brief without a fingerprint is never reused past it', async () => {
  const { home, claude } = sandbox();
  const T = Date.parse('2026-10-27T12:00:00Z');
  writeFileSync(join(home, 'agents-brief.json'), JSON.stringify({ working: 3, needsYou: 0, t: T - 1000 }));
  let counts = 0;
  const count = async () => { counts++; return []; };
  assert.deepEqual(await briefFor(home, { now: T, claudeDirs: [claude], count }), { brief: { working: 3, needsYou: 0, t: T - 1000 }, reused: true });
  assert.deepEqual((await briefFor(home, { now: T + 5000, claudeDirs: [claude], count })).brief, { working: 0, needsYou: 0, t: T + 5000 });
  assert.equal(counts, 1);
  // the fingerprint names files only: sizes and times, never contents
  appendEvent(home, { t: T, ev: 'UserPromptSubmit', sid: 's1', cwd: '/p', prompt: 'a secret plan' }, T);
  assert.doesNotMatch(briefInputs(home, [claude]), /secret/);
  assert.doesNotMatch(readFileSync(join(home, 'agents-brief.json'), 'utf8'), /secret/);
});

function cliSandbox() {
  const { root, home, claude } = sandbox();
  const log = join(root, 'orca.log');
  writeFileSync(log, '');
  const ps = { ok: true, result: { worktrees: [{ path: root, repo: 'r', displayName: 'main', agents: [{ paneKey: 't1:l1', state: 'working', agentType: 'claude', updatedAt: Date.now() }] }] } };
  const fake = join(root, 'fake-orca.sh');
  writeFileSync(fake, `#!/bin/sh\necho "$*" >> "${log}"\ncase "$1 $2" in\n  "worktree ps") echo '${JSON.stringify(ps)}' ;;\n  "terminal list") echo '{"ok":true,"result":{"terminals":[]}}' ;;\n  *) exit 3 ;;\nesac\n`);
  chmodSync(fake, 0o755);
  const env = { PATH: process.env.PATH, HOME: root, KADANS_HOME: home, CLAUDE_CONFIG_DIR: claude, KADANS_ORCA_BIN: fake, KADANS_ORCA_TIMEOUT_MS: '30000', KADANS_BRIEF_FRESH_MS: '1' };
  const cli = (args, extra = {}) => spawnSync(process.execPath, [BIN, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000 });
  const orcaCalls = () => readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('worktree ps')).length;
  return { root, home, cli, orcaCalls };
}

test('cli: live --brief --json is {status, brief} in one run; a second tick with nothing new runs no orca; a hook event does', () => {
  const { home, root, cli, orcaCalls } = cliSandbox();
  const r = cli(['live', '--brief', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(j), ['status', 'brief', 'counted']);
  assert.equal(j.counted, true);
  assert.deepEqual(Object.keys(j.brief), ['working', 'needsYou', 't']);
  assert.equal(j.brief.working, 1); // the Orca-only agent
  const st = JSON.parse(cli(['status', '--json']).stdout);
  assert.deepEqual(Object.keys(j.status), Object.keys(st)); // the same status shape as `status --json`
  assert.equal(orcaCalls(), 1);

  const again = JSON.parse(cli(['live', '--brief', '--json']).stdout);
  assert.deepEqual([again.brief, again.counted], [j.brief, false]);
  assert.deepEqual(JSON.parse(cli(['agents', '--brief', '--json']).stdout), j.brief);
  assert.equal(orcaCalls(), 1, 'unchanged inputs: the brief is reused, no orca');

  appendEvent(home, { t: Date.now(), ev: 'UserPromptSubmit', sid: 's1', cwd: root, prompt: 'go' });
  assert.equal(cli(['live', '--brief', '--json']).status, 0);
  assert.equal(orcaCalls(), 2, 'a hook event: counted again');
  appendEvent(home, { t: Date.now(), ev: 'Stop', sid: 's1', cwd: root });
  const held = JSON.parse(cli(['live', '--brief', '--json', '--count-gap', '600']).stdout);
  assert.equal(held.counted, false, 'inside the count gap: the last counts, no orca');
  assert.equal(orcaCalls(), 2);
  assert.equal(cli(['live', '--brief', '--json'], { KADANS_BRIEF_REUSE_MS: '0' }).status, 0);
  assert.equal(orcaCalls(), 3, 'reuse off');
});

test('cli: live --json is {status, agents} with the agents --json rows; bad usage fails', () => {
  const { cli, orcaCalls } = cliSandbox();
  const r = cli(['live', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(j), ['status', 'agents']);
  assert.ok(Array.isArray(j.agents));
  const a = JSON.parse(cli(['agents', '--json']).stdout);
  assert.deepEqual(j.agents.map((x) => [x.id, x.status]), a.map((x) => [x.id, x.status]));
  assert.equal(orcaCalls(), 2, 'one orca call per full list, as before');
  assert.equal(typeof j.status.version, 'number');
  assert.notEqual(cli(['live']).status, 0);
});

test('realInspect: a claude process confirmed under a minute ago is answered from the pane map memory, no ps', () => {
  const now = Date.now();
  const start = now - 3_600_000;
  const procs = { [`${process.pid}:${start}`]: { paneKey: 't1:l1', handle: 'term_A', comm: '/opt/bin/claude', at: now - 10_000 } };
  // the test runner is really `node`: getting `claude` back proves the answer came from memory
  assert.deepEqual(realInspect(process.pid, procs, now), { start, comm: '/opt/bin/claude', paneKey: 't1:l1', handle: 'term_A' });
  // older than PROC_RECHECK_MS: ps again (the real answer: node, not claude, so nothing is stored for it)
  const old = { [`${process.pid}:${start}`]: { paneKey: 't1:l1', handle: 'term_A', comm: '/opt/bin/claude', at: now - PROC_RECHECK_MS } };
  const real = realInspect(process.pid, old, now);
  assert.notEqual(real.comm, '/opt/bin/claude');
  assert.match(real.comm, /node/);
  // a pid that no longer exists is never answered from memory
  const dead = 2 ** 22 + 12345;
  assert.equal(realInspect(dead, { [`${dead}:${start}`]: { comm: 'claude', at: now } }, now), null);
  // an entry without `at` (written before perf-1) is checked with ps
  assert.match(realInspect(process.pid, { [`${process.pid}:${start}`]: { paneKey: null, handle: null } }, now).comm, /node/);
});
