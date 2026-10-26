// k11-live-list: Claude Code's session registry (<config dir>/sessions/<pid>.json) keeps the agent list current.
// Everything lives in temp dirs with fake process lookups: no real ~/.claude, ~/.kadans, ps or orca.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvent, listAgents, readHosted, readRegistry, registryCovers, sessionStatus, stopAgent, compactAgent } from '../lib/agents.mjs';

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'agents.mjs');
const NOW = Date.parse('2026-10-26T12:00:00Z');
const MIN = 60_000;
const START = Date.parse('2026-10-26T09:00:00Z');
const tmp = () => mkdtempSync(join(tmpdir(), 'kadans-live-'));
const procStartText = (ms) => new Date(ms).toUTCString().replace(/^(\w{3}), (\d+) (\w{3}) (\d{4}) ([\d:]{8}) GMT$/, (_, d, n, m, y, t) => `${d} ${m} ${String(Number(n))} ${t} ${y}`);

// A config dir with a registry: entries = [{ pid, sessionId, kind?, procStart? }]. Returns the dir.
function configDir(entries = []) {
  const dir = tmp();
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  for (const e of entries) {
    writeFileSync(join(dir, 'sessions', `${e.pid}.json`), JSON.stringify({ pid: e.pid, sessionId: e.sessionId, kind: e.kind ?? 'interactive', procStart: e.procStart ?? procStartText(START), cwd: '/Users/me/secret-project', peerToken: 'not-for-us' }));
  }
  return dir;
}

// Fake `ps`: pid -> process (start defaults to START).
const procs = (map) => (pid) => (map[pid] ? { start: START, comm: '/opt/bin/claude', paneKey: null, handle: null, ...map[pid] } : null);

test('readRegistry: live map takes any kind; usable only with a valid live entry; reused pid and bad files ignored', () => {
  const dir = configDir([
    { pid: 11, sessionId: 's11' },
    { pid: 12, sessionId: 's12', kind: 'sdk' },
    { pid: 13, sessionId: 's13' }, // pid reused later: started after the file says
    { pid: 14, sessionId: 's14' }, // no longer claude
    { pid: 15, sessionId: 's15' }, // process gone
    { pid: 16, sessionId: 's16', procStart: 'junk' },
  ]);
  writeFileSync(join(dir, 'sessions', '17.json'), '{broken');
  writeFileSync(join(dir, 'sessions', 'notes.txt'), 'x');
  const seen = [];
  const ps = procs({ 11: { paneKey: 'tA:lA', handle: 'term_x' }, 12: { paneKey: 'tB:lB' }, 13: { start: START + 60_000 }, 14: { comm: 'node' } });
  const reg = readRegistry([dir, join(dir, 'missing')], (pid) => (seen.push(pid), ps(pid)));
  assert.deepEqual([...reg.live], [['s11', { pid: 11, start: START }], ['s12', { pid: 12, start: START }]]);
  assert.deepEqual(reg.hosted, [{ pid: 11, sessionId: 's11', start: START, paneKey: 'tA:lA', handle: 'term_x' }]); // sdk kind: not pane-linked
  assert.deepEqual(reg.dirs, [{ dir, usable: true }, { dir: join(dir, 'missing'), usable: false }]);
  assert.equal(seen.includes(16), false);
  assert.deepEqual(readHosted([dir], ps), reg.hosted);
  // no valid entry for a live claude process: the registry proves nothing
  assert.equal(readRegistry([dir], () => null).dirs[0].usable, false);
  assert.equal(readRegistry([configDir()], ps).dirs[0].usable, false); // empty sessions/
});

test('readRegistry: a registry pid whose start time does not match is ignored; one ps per pid per call; newest process wins a session', () => {
  const dir = configDir([{ pid: 21, sessionId: 'a' }, { pid: 22, sessionId: 'b' }, { pid: 23, sessionId: 'a', procStart: procStartText(START + 5 * MIN) }]);
  const dir2 = configDir([{ pid: 21, sessionId: 'a' }]); // the same pid listed in a second config dir
  const calls = [];
  const ps = procs({ 21: { start: START }, 22: { start: START + 30 * MIN }, 23: { start: START + 5 * MIN } }); // 22 was reused by a newer process
  const reg = readRegistry([dir, dir2], (pid) => (calls.push(pid), ps(pid)));
  assert.equal(reg.live.has('b'), false);
  assert.deepEqual(reg.live.get('a'), { pid: 23, start: START + 5 * MIN });
  assert.deepEqual(calls.sort(), [21, 22, 23]); // 21 asked once although two files name it
  // slack: ps start times have 1 s resolution
  assert.equal(readRegistry([dir2], procs({ 21: { start: START + 1500 } })).live.size, 1);
  assert.equal(readRegistry([dir2], procs({ 21: { start: START + 2500 } })).live.size, 0);
});

test('readRegistry never opens the *.key files and keeps only pid, sessionId, start and kind', () => {
  const dir = configDir([{ pid: 31, sessionId: 'k1' }]);
  // A FIFO named like a key file blocks any reader forever: if the code opened it, this child would hit the timeout.
  const fifo = join(dir, 'sessions', '31.00000000-0000-4000-8000-000000000000.key');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const code = `import(${JSON.stringify(LIB)}).then(({ readRegistry }) => { const r = readRegistry([${JSON.stringify(dir)}], () => ({ start: ${START}, comm: 'claude', paneKey: null, handle: null })); console.log(JSON.stringify([[...r.live], r.hosted, r.dirs.map((d) => d.usable)])); });`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 8000 });
  assert.equal(r.error, undefined, 'timed out: a key file was opened');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [[['k1', { pid: 31, start: START }]], [], [true]]);
  assert.doesNotMatch(r.stdout, /secret|not-for-us/); // no other field of the .json leaks
});

test('registryCovers: only a transcript under a usable config dir gets a verdict', () => {
  const a = configDir([{ pid: 1, sessionId: 'x' }]);
  const b = configDir();
  const dirs = [{ dir: a, usable: true }, { dir: b, usable: false }];
  assert.equal(registryCovers(dirs, join(a, 'projects', '-p', 's.jsonl')), true);
  assert.equal(registryCovers(dirs, join(b, 'projects', '-p', 's.jsonl')), false); // unusable registry
  assert.equal(registryCovers(dirs, join(tmp(), 'projects', '-p', 's.jsonl')), false); // another account's dir
  assert.equal(registryCovers(dirs, null), false);
  assert.equal(registryCovers(dirs, `${a}-sibling/projects/-p/s.jsonl`), false); // prefix of the name only
});

test('sessionStatus: gone ends a session with no pid at once, but not one with a live pid or Orca terminal', () => {
  const s = { endedAt: null, lastEventAt: NOW - 5 * MIN, lastSeen: NOW - 5 * MIN, pid: null, needsAt: null, turn: 'stopped', stopAt: NOW - 5 * MIN, asked: false };
  assert.equal(sessionStatus(s, { now: NOW, gone: false }), 'idle');
  assert.equal(sessionStatus(s, { now: NOW, gone: true }), 'ended');
  assert.equal(sessionStatus(s, { now: NOW, gone: true, orcaLive: true }), 'idle');
  assert.equal(sessionStatus({ ...s, pid: 9 }, { now: NOW, gone: true, alive: () => true }), 'idle');
  assert.equal(sessionStatus({ ...s, pid: 9 }, { now: NOW, gone: true, alive: () => false }), 'ended');
});

// ---------- listAgents ----------

// A kadans home with sessions; each: { id, quietMin, pid?, dir (config dir for its transcript) }. Returns { home, proj }.
function world(sessions) {
  const home = tmp();
  const proj = join(tmp(), 'repo');
  mkdirSync(join(proj, '.git'), { recursive: true });
  for (const x of sessions) {
    const t = join(x.dir, 'projects', '-repo', `${x.id}.jsonl`);
    mkdirSync(dirname(t), { recursive: true });
    writeFileSync(t, `${JSON.stringify({ type: 'user', message: { role: 'user', content: `Task of ${x.id}` } })}\n`);
    const at = NOW - x.quietMin * MIN;
    utimesSync(t, new Date(at), new Date(at));
    appendEvent(home, { t: at - MIN, ev: 'UserPromptSubmit', sid: x.id, cwd: proj, transcript: t, prompt: `Task of ${x.id}`, ...(x.pid ? { pid: x.pid } : {}) }, NOW);
    appendEvent(home, { t: at, ev: 'Stop', sid: x.id, cwd: proj, transcript: t, asked: false }, NOW);
  }
  return { home, proj };
}

test('listAgents: a closed chat (not in the registry, no pid) leaves the list at once; a registry-live one stays and gets its pid', () => {
  const cfg = configDir([{ pid: 500, sessionId: 'live1' }, { pid: 501, sessionId: 'live2' }]);
  const { home } = world([
    { id: 'dead1', quietMin: 20, dir: cfg }, // closed 20 min ago: used to stay "idle" until 30 min of quiet
    { id: 'live1', quietMin: 45, dir: cfg }, // quiet 45 min, no Kadans pid, still open
    { id: 'live2', quietMin: 1, dir: cfg },
  ]);
  const ps = procs({ 500: {}, 501: {} });
  const list = listAgents(home, { now: NOW, claudeDirs: [cfg], inspect: ps, alive: (p) => p === 500 || p === 501 });
  assert.deepEqual(list.map((a) => [a.id, a.status]).sort(), [['live1', 'idle'], ['live2', 'idle']]);
  const live1 = list.find((a) => a.id === 'live1');
  assert.deepEqual([live1.pid, live1.pidAt], [500, START]);
  const all = listAgents(home, { now: NOW, claudeDirs: [cfg], inspect: ps, alive: (p) => p === 500 || p === 501, all: true });
  assert.equal(all.find((a) => a.id === 'dead1').status, 'ended');
  // without the registry (the old rule): dead1 is still idle at 20 min, and live1 is ended at 45 min
  const old = listAgents(home, { now: NOW, claudeDirs: [], alive: () => true });
  assert.deepEqual(old.map((a) => [a.id, a.status]).sort(), [['dead1', 'idle'], ['live2', 'idle']]);
});

test('listAgents: a recorded live pid is never replaced; a dead recorded pid yields to the registry; a reused registry pid is ignored', () => {
  const cfg = configDir([{ pid: 600, sessionId: 'keep' }, { pid: 601, sessionId: 'moved' }, { pid: 602, sessionId: 'reused' }, { pid: 603, sessionId: 'anchor' }]);
  const { home } = world([
    { id: 'keep', quietMin: 3, dir: cfg, pid: 900 }, // Kadans recorded 900 (alive); the registry says 600
    { id: 'moved', quietMin: 3, dir: cfg, pid: 901 }, // recorded 901 is dead; the chat was resumed as 601
    { id: 'reused', quietMin: 3, dir: cfg }, // pid 602 now belongs to a newer process
    { id: 'anchor', quietMin: 3, dir: cfg },
  ]);
  const ps = procs({ 600: {}, 601: {}, 602: { start: START + 90 * MIN }, 603: {} });
  const alive = (p) => [900, 600, 601, 602, 603].includes(p);
  const list = listAgents(home, { now: NOW, claudeDirs: [cfg], inspect: ps, alive, all: true });
  const by = Object.fromEntries(list.map((a) => [a.id, a]));
  assert.deepEqual([by.keep.status, by.keep.pid], ['idle', 900]);
  assert.deepEqual([by.moved.status, by.moved.pid, by.moved.pidAt], ['idle', 601, START]);
  assert.equal(by.reused.status, 'ended'); // no live process for it: the reused pid proves nothing
  assert.equal(by.reused.pid, null);
  // the adopted pid goes through the same reuse checks before stop or compact act on it
  const dead = () => null;
  assert.match(stopAgent(by.moved, { ps: dead, dryRun: true }).why, /no longer a claude process/);
  assert.match(stopAgent(by.moved, { ps: () => ({ ppid: 1, comm: '/opt/bin/claude' }), started: () => START + 60 * MIN, dryRun: true }).why, /newer process/);
  assert.deepEqual(stopAgent(by.moved, { ps: () => ({ ppid: 1, comm: '/opt/bin/claude' }), started: () => START, dryRun: true }), { ok: true, how: 'would send SIGTERM to pid 601' });
  assert.match(compactAgent({ ...by.moved, orca: { terminal: 'term_A' } }, { run: () => '', ps: dead }).why, /no longer a claude process/);
});

test('listAgents: no usable registry, or a transcript outside the registry dirs, keeps the 30-minute rule', () => {
  const emptyCfg = configDir(); // sessions/ exists but lists nothing
  const otherCfg = configDir([{ pid: 700, sessionId: 'someone-else' }]);
  const { home } = world([
    { id: 'a20', quietMin: 20, dir: emptyCfg },
    { id: 'a45', quietMin: 45, dir: emptyCfg },
    { id: 'b20', quietMin: 20, dir: tmp() }, // transcript in a dir we do not read the registry of
  ]);
  const ps = procs({ 700: {} });
  const list = listAgents(home, { now: NOW, claudeDirs: [emptyCfg, otherCfg], inspect: ps, alive: () => true, all: true });
  assert.deepEqual(list.map((a) => [a.id, a.status]).sort(), [['a20', 'idle'], ['a45', 'ended'], ['b20', 'idle']]);
  // registry dir that cannot be read at all
  const none = listAgents(home, { now: NOW, claudeDirs: [join(tmp(), 'nope')], inspect: ps, alive: () => true, all: true });
  assert.deepEqual(none.map((a) => [a.id, a.status]).sort(), [['a20', 'idle'], ['a45', 'ended'], ['b20', 'idle']]);
});

test('listAgents: one process lookup per pid per refresh; a closed chat is not paired with a live Orca agent in its folder', () => {
  const cfg = configDir([{ pid: 800, sessionId: 'elsewhere' }, { pid: 801, sessionId: 'elsewhere2' }]); // live chats Kadans has no events for
  const { home, proj } = world([{ id: 'closed', quietMin: 2, dir: cfg }]);
  const calls = [];
  const ps = procs({ 800: {}, 801: {} });
  const orca = (args) => {
    if (args[0] === 'worktree') return JSON.stringify({ result: { worktrees: [{ path: proj, repo: 'repo', displayName: 'main', agents: [{ paneKey: 't1:l1', state: 'done', agentType: 'claude', prompt: 'Task of closed' }] }] } });
    return JSON.stringify({ result: { terminals: [{ handle: 'term_A', tabId: 't1', leafId: 'l1', title: 'main' }] } });
  };
  const list = listAgents(home, { now: NOW, claudeDirs: [cfg], inspect: (p) => (calls.push(p), ps(p)), alive: () => true, run: orca, all: true });
  assert.deepEqual(calls.sort(), [800, 801]);
  const closed = list.find((a) => a.id === 'closed');
  assert.deepEqual([closed.status, closed.orca], ['ended', null]); // not paired by the one-agent-one-session guess
  assert.ok(list.some((a) => a.source === 'orca' && a.orca.terminal === 'term_A')); // the live Orca agent keeps its own row
  // the old rule (no registry) would have paired them: one idle session, one Orca agent, same folder
  const old = listAgents(home, { now: NOW, claudeDirs: [], alive: () => true, run: orca, all: true });
  assert.equal(old.find((a) => a.id === 'closed').orca?.terminal, 'term_A');
});
