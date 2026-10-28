// k38: agents on paired Orca environments (other computers): mapping, gap and timeout (stale), offline, no prompt text
// stored, no actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { briefOf, compactAgent, listAgentsAsync, renderAgents, stopAgent } from '../lib/agents.mjs';
import { REMOTE_GAP_MS, REMOTE_OFFLINE_MS, REMOTE_STALE_MS, mapRemote, readRemote, refreshRemote } from '../lib/remote.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
const NOW = 1_800_000_000_000;
const SECRET = 'SECRET-PROMPT-TEXT';
const FIRST = 'Make the rain sound loop without a gap'; // k42: the prompt's first line becomes the title (memory only)
const ENVS = JSON.stringify({ ok: true, result: { environments: [{ id: 'env-1', name: 'other', endpoints: [{ endpoint: 'ws://10.0.0.2' }], pairedDeviceId: 'dev' }] } });
const ps = (state = 'working', extra = {}) => JSON.stringify({ ok: true, result: { worktrees: [
  { repo: 'proj', path: 'C:\\Users\\me\\proj', branch: 'refs/heads/main', isMainWorktree: true, displayName: 'main', preview: SECRET, comment: SECRET,
    agents: [{ paneKey: 'tab-1:1', state, agentType: 'claude', prompt: `\n${FIRST}\n${SECRET}`, lastAssistantMessage: SECRET, toolInput: { command: SECRET }, toolName: 'PowerShell',
      stateStartedAt: NOW - 60_000, updatedAt: NOW - 5000, subagents: [{ id: 's', description: SECRET }], ...extra }] },
  { repo: 'proj', path: '/opt/proj-fix', branch: 'refs/heads/fix-sound', displayName: 'quiet-fox', agents: [] },
] } });

// A fake caller: answers from `answers` by command, counts the calls.
function caller(answers) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args.join(' '));
    const a = args[0] === 'environment' ? answers.env : args[0] === 'terminal' ? answers[args[1]] ?? { ok: false, timeout: false } : answers.ps;
    return typeof a === 'function' ? a() : a;
  };
  fn.calls = calls;
  return fn;
}
const okText = (text) => ({ ok: true, text });

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'kadans-remote-'));
  return Promise.resolve(fn(home)).finally(() => rmSync(home, { recursive: true, force: true }));
}

test('remote: maps each agent to a row under its machine; status via orcaStatus; no actions, tokens or context', () => withHome(async (home) => {
  const call = caller({ env: okText(ENVS), ps: okText(ps('waiting')) });
  const rows = await readRemote(home, { call, now: NOW });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.id, 'remote:other:tab-1:1');
  assert.equal(r.machine, 'other');
  assert.equal(r.source, 'orca');
  assert.equal(r.status, 'needs-you');
  assert.equal(r.stateSince, NOW - 60_000);
  assert.equal(r.project, 'proj');
  assert.equal(r.title, FIRST); // k42: no Orca title and the default branch: the prompt's first line
  assert.equal(r.titleSource, 'prompt');
  assert.equal(r.agentType, 'claude');
  assert.equal(r.toolName, 'PowerShell');
  assert.equal(r.subagentCount, 1);
  assert.equal(r.model, null);
  assert.equal(r.tokens, null);
  assert.equal(r.context, null);
  assert.deepEqual(r.subagents, []);
  assert.equal(r.firstPrompt, null);
  assert.equal(r.orca.terminal, null);
  for (const k of ['canStop', 'canCompact', 'canSend', 'canPace', 'canReplace']) assert.equal(r[k], false); // no handle known
  assert.equal(r.machineStale, false);
  assert.equal(r.machineOffline, false);
  assert.deepEqual(call.calls, ['environment list --json', 'worktree ps --environment env-1 --json', 'terminal list --environment env-1 --json --limit 1000']);
}));

test('remote: title from Orca taskTitle/displayName, else the prompt, else the branch; Windows paths give the folder', async () => {
  const { remoteRow } = await import('../lib/remote.mjs');
  const [a] = mapRemote(ps('working', { taskTitle: 'Fix the rain sound' }));
  assert.equal(a.title, 'Fix the rain sound');
  assert.equal(remoteRow('other', a, NOW, false).title, 'Fix the rain sound'); // Orca's own title wins
  const text = JSON.stringify({ result: { worktrees: [{ path: 'C:\\code\\game', branch: 'refs/heads/fix-sound', agents: [{ paneKey: 'p', state: 'done' }] }] } });
  const [b] = mapRemote(text);
  assert.equal(b.title, null);
  assert.equal(b.branch, 'fix-sound');
  assert.equal(b.project, 'game');
  assert.deepEqual([remoteRow('other', b, NOW).title, remoteRow('other', b, NOW).titleSource], ['fix-sound', 'branch']);
  const long = mapRemote(ps('working', { prompt: 'Please make the rain sound loop smoothly '.repeat(8) }))[0];
  assert.ok(long.promptTitle.length > 60 && [...long.promptTitle].length <= 80, long.promptTitle);
});

test('remote: no prompt, message, preview, comment, tool input or sub-agent text reaches the rows or the cache', () => withHome(async (home) => {
  const rows = await readRemote(home, { call: caller({ env: okText(ENVS), ps: okText(ps()) }), now: NOW });
  assert.ok(!JSON.stringify(rows).includes(SECRET));
  const cache = readFileSync(join(home, 'orca-remote.json'), 'utf8');
  assert.ok(!cache.includes(SECRET), 'only the first line of the prompt, as a title; never the prompt');
  assert.ok(cache.includes(FIRST) && !cache.includes('"prompt"'), 'k48: the derived title is cached, the prompt is not');
  assert.ok(!cache.includes('10.0.0.2') && !cache.includes('dev')); // endpoints and device ids are not kept either
}));

test('remote: one call per machine per 10 s; env list cached; a timeout reuses the last answer, stale after 90 s', () => withHome(async (home) => {
  let answer = okText(ps('working'));
  const call = caller({ env: okText(ENVS), ps: () => answer });
  await readRemote(home, { call, now: NOW });
  await readRemote(home, { call, now: NOW + REMOTE_GAP_MS - 1 });
  assert.equal(call.calls.length, 3); // env list, ps, terminal list; then cached: no second ps, no second env list
  answer = { ok: false, timeout: true };
  let rows = await readRemote(home, { call, now: NOW + REMOTE_GAP_MS });
  assert.equal(call.calls.length, 4);
  assert.equal(rows[0].status, 'working');
  assert.equal(rows[0].machineStale, false);
  rows = await readRemote(home, { call, now: NOW + REMOTE_STALE_MS + 1 });
  assert.equal(rows[0].machineStale, true);
  assert.equal(rows[0].machineOffline, false);
  rows = await readRemote(home, { call, now: NOW + REMOTE_OFFLINE_MS + 1 });
  assert.deepEqual(rows.map((r) => [r.id, r.machineOffline]), [['remote:other', true]]);
}));

test('remote: an error marks the machine offline at once (one marker row); a later answer brings the rows back', () => withHome(async (home) => {
  let answer = { ok: false, timeout: false };
  const call = caller({ env: okText(ENVS), ps: () => answer });
  let rows = await readRemote(home, { call, now: NOW });
  assert.deepEqual(rows.map((r) => [r.id, r.machine, r.machineOffline]), [['remote:other', 'other', true]]);
  answer = okText(ps('done'));
  rows = await readRemote(home, { call, now: NOW + REMOTE_GAP_MS });
  assert.deepEqual(rows.map((r) => [r.id, r.status]), [['remote:other:tab-1:1', 'idle']]);
}));

test('remote: a slow orca is cut at the timeout (real spawn), counted as a timeout', () => withHome(async (home) => {
  const slow = join(home, 'orca');
  writeFileSync(slow, `#!/bin/sh\ncase "$1" in environment) echo '${ENVS}';; *) exec sleep 60;; esac\n`, { mode: 0o755 });
  const { remoteCaller, setEnvList } = await import('../lib/remote.mjs');
  setEnvList(home, [{ id: 'env-1', name: 'other' }], NOW); // only the ps is timed (a loaded machine could slow the env list too)
  const call = remoteCaller({ PATH: process.env.PATH, KADANS_ORCA_BIN: slow });
  const t0 = Date.now();
  const rows = await readRemote(home, { call, now: NOW, timeout: 200 });
  assert.ok(Date.now() - t0 < 45_000); // cut at the timeout (200 ms), not after the 60 s sleep
  assert.deepEqual(rows.map((r) => [r.id, r.machineOffline]), [['remote:other', true]]); // never answered: offline
  assert.equal(remoteCaller({ KADANS_ORCA: '0' }), null);
}));

test('remote: listAgentsAsync appends remote rows after the local ones; remoteAgents false turns it off; brief and text skip them', () => withHome(async (home) => {
  const env = { PATH: '', KADANS_ORCA: '0' };
  const call = caller({ env: okText(ENVS), ps: okText(ps()) });
  await refreshRemote(home, { call, now: NOW });
  let started = 0;
  const list = await listAgentsAsync(home, { env, now: NOW, alive: () => true, claudeDirs: [], remote: () => started++ });
  assert.equal(started, 1); // the listing asks for a refresh (triggerRemote decides whether one is due)
  assert.deepEqual(list.map((a) => a.id), ['remote:other:tab-1:1']);
  assert.equal(briefOf(list, NOW).working, 0);
  assert.match(renderAgents(list, NOW), /remote:other:tab-1/);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ remoteAgents: false }));
  const off = await listAgentsAsync(home, { env, now: NOW + REMOTE_GAP_MS, alive: () => true, claudeDirs: [], remote: () => started++ });
  assert.deepEqual(off, []);
  assert.equal(started, 1); // off: no refresh either
  const marker = [{ id: 'remote:other', machine: 'other', machineOffline: true, status: 'idle', subagents: [], lastSeen: null }];
  assert.match(renderAgents(marker, NOW), /no running agents/);
}));

test('remote: stop and compact refuse a remote row (dry run too), and never touch a terminal', () => {
  const row = { id: 'remote:other:tab-1:1', source: 'orca', machine: 'other', orca: { terminal: null }, pid: null, status: 'idle' };
  let ran = false;
  const run = () => {
    ran = true;
  };
  for (const r of [stopAgent(row, { run, dryRun: true }), stopAgent(row, { run }), compactAgent(row, { run, dryRun: true })]) {
    assert.equal(r.ok, false);
    assert.match(r.why, /runs on other/);
  }
  assert.equal(ran, false);
});

// ---------- k42 ----------
test('k42/k48: the cache keeps the whitelist only: tool name, sub-agent count, the derived title and the handle; never the prompt', () => withHome(async (home) => {
  await readRemote(home, { call: caller({ env: okText(ENVS), ps: okText(ps()) }), now: NOW });
  const cache = JSON.parse(readFileSync(join(home, 'orca-remote.json'), 'utf8'));
  const [a] = cache.machines['env-1'].agents;
  assert.deepEqual(Object.keys(a).sort(), ['agentType', 'branch', 'cwd', 'handle', 'paneKey', 'project', 'promptTitle', 'state', 'stateStartedAt',
    'subagentCount', 'title', 'toolName', 'updatedAt']);
  assert.equal(a.promptTitle, FIRST);
  assert.equal(a.toolName, 'PowerShell');
  assert.equal(a.subagentCount, 1);
  assert.equal(a.title, null);
}));

test('k48: the prompt title is cached (0600): every run has it, a stale machine keeps it; the prompt never is', () => withHome(async (home) => {
  let answer = okText(ps('working'));
  const call = caller({ env: okText(ENVS), ps: () => answer });
  let [r] = await readRemote(home, { call, now: NOW });
  assert.equal(r.title, FIRST);
  [r] = await readRemote(home, { call, now: NOW + 1000 }); // inside the gap: from the cache file
  assert.deepEqual([r.title, r.titleSource], [FIRST, 'prompt']);
  answer = { ok: false, timeout: true };
  [r] = await readRemote(home, { call, now: NOW + REMOTE_STALE_MS + 1 }); // a timeout: the last good details, stale
  assert.equal(r.machineStale, true);
  assert.equal(r.title, FIRST);
  const file = join(home, 'orca-remote.json');
  assert.ok(!readFileSync(file, 'utf8').includes(SECRET));
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
}));

test('k42: a sub-agent count counts running ones only; a tool name keeps a name, never its input', () => {
  const [a] = mapRemote(ps('working', { toolName: 'Bash <rm -rf />; echo', subagents: [{ id: 'a', status: 'running', description: SECRET }, { id: 'b', status: 'done' }] }));
  assert.equal(a.subagentCount, 1);
  assert.ok(!/[<>;/]/.test(a.toolName));
  assert.ok(!JSON.stringify({ ...a, promptTitle: null }).includes(SECRET)); // no sub-agent text
});

// ---------- k48: the fetch outlives the listing; title and handle cached; actions on the other computer ----------
const TL = JSON.stringify({ ok: true, result: { terminals: [{ tabId: 'tab-1', leafId: '1', handle: 'term_r1', writable: true, title: SECRET, preview: SECRET }] } });
const RULE = '─'.repeat(40);
const screenOf = (tail) => JSON.stringify({ ok: true, result: { terminal: { source: 'screen', tail } } });
const EMPTY_SCREEN = screenOf(['  done', RULE, '❯ ', RULE, '  ? for shortcuts']);
const DRAFT_SCREEN = screenOf(['  done', RULE, '❯ half a thought', RULE]);
const MSG = 'SECRET-MESSAGE carry on with the next step';
const ID = 'remote:other:tab-1:1';
const actionCaller = ({ state = 'done', screen = EMPTY_SCREEN, tl = TL, psText = null } = {}) =>
  caller({ env: okText(ENVS), ps: okText(psText ?? ps(state)), list: okText(tl), read: okText(screen), send: okText('{"ok":true}'), close: okText('{"ok":true}') });

test('k48: the listing never waits on another computer; a slow fetch lands after it; the last good details show while one is in flight', () => withHome(async (home) => {
  const env = { PATH: '', KADANS_ORCA: '0' };
  const opts = { env, alive: () => true, claudeDirs: [] };
  let release;
  let gate = new Promise((r) => { release = r; });
  const call = caller({ env: okText(ENVS), ps: () => gate.then(() => okText(ps('done'))), list: okText(TL) });
  let fetch = null;
  const first = await listAgentsAsync(home, { ...opts, now: NOW, remote: (now) => { fetch = refreshRemote(home, { call, now }); } });
  assert.deepEqual(first, []); // returned while the other computer had not answered
  assert.ok(fetch);
  release();
  await fetch; // the fetch finishes after the listing
  let [r] = await listAgentsAsync(home, { ...opts, now: NOW + 1000, remote: () => {} });
  assert.deepEqual([r.id, r.title, r.titleSource, r.canStop, r.machineStale], [ID, FIRST, 'prompt', true, false]);
  gate = new Promise((res) => { release = res; }); // the next fetch hangs: the cached details still show meanwhile
  [r] = await listAgentsAsync(home, { ...opts, now: NOW + REMOTE_GAP_MS, remote: (now) => { fetch = refreshRemote(home, { call, now }); } });
  assert.deepEqual([r.id, r.title, r.status], [ID, FIRST, 'idle']);
  release();
  await fetch;
}));

test('k48: triggerRemote starts one detached refresh when something is due, at most once per gap', () => withHome(async (home) => {
  const { triggerRemote } = await import('../lib/remote.mjs');
  const starts = [];
  const start = (h) => starts.push(h);
  assert.equal(triggerRemote(home, { now: NOW, start }), true); // never fetched: due
  assert.equal(triggerRemote(home, { now: NOW + 1000, start }), false); // one in flight (stamp)
  await refreshRemote(home, { call: actionCaller(), now: NOW });
  assert.equal(triggerRemote(home, { now: NOW + REMOTE_GAP_MS - 1, start }), false); // fresh: nothing due
  assert.equal(triggerRemote(home, { now: NOW + REMOTE_GAP_MS, start }), true);
  assert.deepEqual(starts, [home, home]);
}));

test('k48: a refresh maps each agent to its terminal handle on that machine; rows get stop/compact/send flags, stale rows none', () => withHome(async (home) => {
  let state = 'done';
  const call = caller({ env: okText(ENVS), ps: () => okText(ps(state)), list: okText(TL) });
  let [r] = await readRemote(home, { call, now: NOW });
  assert.deepEqual([r.canStop, r.canCompact, r.canSend, r.canPace, r.canReplace, r.orca.terminal], [true, true, true, false, false, null]);
  assert.ok(!JSON.stringify(r).includes('term_r1'), 'the handle stays out of the row');
  const cache = readFileSync(join(home, 'orca-remote.json'), 'utf8');
  assert.ok(cache.includes('term_r1') && !cache.includes(SECRET)); // ids only: no tab title or preview
  state = 'working';
  [r] = await readRemote(home, { call, now: NOW + REMOTE_GAP_MS });
  assert.deepEqual([r.canStop, r.canCompact, r.canSend], [true, false, false]); // k49: a remote working chat takes no message
  assert.equal(call.calls.filter((c) => c.startsWith('terminal list')).length, 1, 'a known handle needs no second terminal list');
  state = { ok: false, timeout: true };
  const stale = caller({ env: okText(ENVS), ps: { ok: false, timeout: true } });
  [r] = await readRemote(home, { call: stale, now: NOW + REMOTE_GAP_MS + REMOTE_STALE_MS + 1 });
  assert.deepEqual([r.machineStale, r.canStop, r.canCompact, r.canSend], [true, false, false, false]);
}));

test('k48: stop, compact and send on a remote id look it up again on that machine and use its handle, always with --environment', () => withHome(async (home) => {
  const { remoteCompact, remoteSend, remoteStop } = await import('../lib/remote.mjs');
  // an older answer cached another handle: the action must use the fresh one
  await readRemote(home, { call: actionCaller({ tl: TL.replace('term_r1', 'term_old') }), now: NOW });
  const LOOKUP = ['worktree ps --environment env-1 --json', 'terminal list --environment env-1 --json --limit 1000'];
  let call = actionCaller();
  let r = await remoteStop(home, ID, { call });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(call.calls, [...LOOKUP, 'terminal close --environment env-1 --terminal term_r1 --json']);
  call = actionCaller();
  r = await remoteCompact(home, ID, { call });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(call.calls, [...LOOKUP, 'terminal read --environment env-1 --terminal term_r1 --screen --json',
    'terminal send --environment env-1 --terminal term_r1 --text /compact --enter']);
  call = actionCaller();
  r = await remoteSend(home, ID, MSG, { call });
  assert.equal(r.ok, true, r.why);
  assert.equal(call.calls.at(-1), `terminal send --environment env-1 --terminal term_r1 --text ${MSG} --enter`);
  assert.ok(!JSON.stringify(r).includes(MSG), 'the result never repeats the message');
  call = actionCaller();
  r = await remoteStop(home, ID, { call, dryRun: true });
  assert.deepEqual([r.ok, call.calls], [true, LOOKUP]); // dry run: the lookup only
}));

test('k48: a remote id never reaches a local terminal; refusals act on nothing and never repeat the message', () => withHome(async (home) => {
  const { remoteCompact, remoteSend, remoteStop, parseRemoteId } = await import('../lib/remote.mjs');
  const { sendAgent } = await import('../lib/agents.mjs');
  await readRemote(home, { call: actionCaller(), now: NOW });
  // the local actions refuse a remote row (k38), send too; the local runner is never called
  const row = { id: ID, source: 'orca', machine: 'other', orca: { terminal: null }, pid: null, status: 'idle' };
  let ran = false;
  const run = () => { ran = true; };
  assert.equal(sendAgent(row, MSG, { run }).ok, false);
  assert.equal(stopAgent(row, { run }).ok, false);
  assert.equal(ran, false);
  // ids that name no single agent: no orca call at all
  for (const id of ['remote:nope:tab-1:1', 'remote:other', 'remote:oth', 'other:tab-1:1', 'remote:-x:tab-1:1', 'remote:other:a b', '']) {
    const call = actionCaller();
    assert.equal((await remoteStop(home, id, { call })).ok, false, id);
    assert.deepEqual(call.calls, [], id);
  }
  assert.deepEqual(parseRemoteId(ID), { machine: 'other', paneKey: 'tab-1:1' });
  const acts = (calls) => calls.filter((c) => /^terminal (close|send)/.test(c));
  const cases = [
    [() => remoteStop(home, ID, { call: c }), { psText: ps('done', { paneKey: 'tab-9:9' }) }, /no longer running/], // gone
    [() => remoteStop(home, ID, { call: c }), { tl: JSON.stringify({ ok: true, result: { terminals: [] } }) }, /no terminal/],
    [() => remoteStop(home, ID, { call: c }), { tl: TL.replace('term_r1', '--all') }, /no terminal/], // a handle that reads as a flag
    [() => remoteCompact(home, ID, { call: c }), { state: 'working' }, /working/], // k49: send may reach a working chat (tell.test.mjs)
    [() => remoteSend(home, ID, MSG, { call: c }), { state: 'waiting' }, /question or permission/],
    [() => remoteSend(home, ID, MSG, { call: c }), { screen: DRAFT_SCREEN }, /unsent text/],
    [() => remoteSend(home, ID, MSG, { call: c }), { screen: 'not json' }, /screen could not be read/],
    [() => remoteCompact(home, ID, { call: c }), { screen: DRAFT_SCREEN }, /unsent text/],
    [() => remoteSend(home, ID, MSG, { call: c }), { psText: ps('done', { agentType: 'codex' }) }, /only into Claude Code/],
  ];
  let c;
  for (const [act, opts, why] of cases) {
    c = actionCaller(opts);
    const r = await act();
    assert.equal(r.ok, false, String(why));
    assert.match(r.why, why);
    assert.ok(!r.why.includes(MSG));
    assert.deepEqual(acts(c.calls), [], String(why));
    assert.ok(c.calls.every((x) => x.includes('--environment env-1')));
  }
  // two computers with one name: refused before any call
  const { setEnvList } = await import('../lib/remote.mjs');
  setEnvList(home, [{ id: 'env-1', name: 'other' }, { id: 'env-2', name: 'other' }], NOW);
  c = actionCaller();
  assert.match((await remoteStop(home, ID, { call: c })).why, /several computers/);
  assert.deepEqual(c.calls, []);
}));

test('k48 cli: agents --json returns at once and a detached refresh fills the cache; stop and send on a remote id act on that machine only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kadans-remote-cli-'));
  try {
    const home = join(root, 'kadans');
    mkdirSync(home);
    const log = join(root, 'orca.log');
    const f = (name, text) => {
      const p = join(root, name);
      writeFileSync(p, text);
      return p;
    };
    const envs = f('envs.json', ENVS);
    const rps = f('rps.json', ps('done'));
    const tl = f('tl.json', TL);
    const scr = f('screen.json', EMPTY_SCREEN);
    // this computer's Orca knows the same pane key under another handle: it must never be used
    const ltl = f('ltl.json', JSON.stringify({ ok: true, result: { terminals: [{ tabId: 'tab-1', leafId: '1', handle: 'term_local' }] } }));
    writeFileSync(join(home, 'orca-panes.json'), JSON.stringify({ t: Date.now(), panes: { 'tab-1:1': { handle: 'term_local', path: null } }, procs: {} }));
    const fake = join(root, 'orca');
    writeFileSync(fake, `#!/bin/sh\necho "$*" >> "${log}"\ncase "$1 $2 $3" in\n  "environment list --json") cat "${envs}" ;;\n` +
      `  "worktree ps --environment") cat "${rps}" ;;\n  "worktree ps --json") echo '{"ok":true,"result":{"worktrees":[]}}' ;;\n` +
      `  "terminal list --environment") cat "${tl}" ;;\n  "terminal list --json") cat "${ltl}" ;;\n  "terminal read --environment") cat "${scr}" ;;\n` +
      `  "terminal send --environment"|"terminal close --environment") echo '{"ok":true}' ;;\n  *) echo '{"ok":true}' ;;\nesac\n`, { mode: 0o755 });
    const env = { PATH: process.env.PATH, HOME: root, KADANS_HOME: home, CLAUDE_CONFIG_DIR: join(root, 'claude'), KADANS_ORCA_BIN: fake, KADANS_ORCA_TIMEOUT_MS: '30000' };
    const cli = (args, input) => {
      const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', input, timeout: 60_000 });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    const first = cli(['agents', '--json']);
    assert.equal(first.code, 0, first.err);
    assert.deepEqual(JSON.parse(first.out), []); // nothing cached yet, and no wait for the other computer
    const cacheFile = join(home, 'orca-remote.json');
    // up to 30 s: the detached refresher is a fresh node process, slow on a loaded machine
    for (let i = 0; i < 300 && !(existsSync(cacheFile) && readFileSync(cacheFile, 'utf8').includes('term_r1')); i++) await new Promise((r) => setTimeout(r, 100));
    const [row] = JSON.parse(cli(['agents', '--json']).out);
    assert.deepEqual([row.id, row.title, row.canStop, row.canSend], [ID, FIRST, true, true]);
    assert.ok(!readFileSync(cacheFile, 'utf8').includes(SECRET));
    const stop = cli(['agent', 'stop', ID]);
    assert.equal(stop.code, 0, stop.err);
    assert.match(stop.out, /closed terminal term_r1 on other/);
    const sent = cli(['agent', 'send', ID], `${MSG}\n`);
    assert.equal(sent.code, 0, sent.err);
    assert.ok(!(sent.out + sent.err).includes('SECRET-MESSAGE'));
    for (const id of ['remote:oth', 'remote:other:tab-1', 'remote:nope:tab-1:1']) assert.notEqual(cli(['agent', 'stop', id]).code, 0, id);
    const acts = readFileSync(log, 'utf8').split('\n').filter((l) => /^terminal (close|send)/.test(l));
    assert.deepEqual(acts, ['terminal close --environment env-1 --terminal term_r1 --json', `terminal send --environment env-1 --terminal term_r1 --text ${MSG} --enter`]);
    assert.ok(!readFileSync(log, 'utf8').includes('term_local'), 'the local handle never reaches an action');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fix-7 L1: a flag-shaped env id from the environment list never reaches worktree ps', () => withHome(async (home) => {
  const envs = JSON.stringify({ ok: true, result: { environments: [{ id: '--help', name: 'kasa' }, { id: 'env-1', name: 'other' }] } });
  const call = caller({ env: okText(envs), ps: okText(ps('waiting')) });
  await refreshRemote(home, { call, now: NOW });
  const psCalls = call.calls.filter((c) => c.startsWith('worktree ps'));
  assert.deepEqual(psCalls, ['worktree ps --environment env-1 --json']);
  assert.ok(!call.calls.some((c) => c.includes('--help')));
}));

test('fix-7 L6: stop, compact and send refuse a production-looking computer before any call', () => withHome(async (home) => {
  const { remoteCompact, remoteSend, remoteStop } = await import('../lib/remote.mjs');
  const prodEnvs = JSON.stringify({ ok: true, result: { environments: [{ id: 'env-1', name: 'web-prod' }, { id: 'env-prod', name: 'ok-box' }] } });
  const seed = caller({ env: okText(prodEnvs), ps: okText(ps('done')), list: okText(TL) });
  await refreshRemote(home, { call: seed, now: NOW });
  for (const id of ['remote:web-prod:tab-1:1', 'remote:ok-box:tab-1:1']) {
    const call = actionCaller();
    for (const r of [await remoteStop(home, id, { call }), await remoteCompact(home, id, { call }), await remoteSend(home, id, MSG, { call })]) {
      assert.deepEqual([r.ok, r.why], [false, 'refused: Kadans never types into a production host'], id);
    }
    assert.deepEqual(call.calls, [], `${id}: nothing reached orca`);
  }
}));
