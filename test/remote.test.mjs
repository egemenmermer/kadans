// k38: agents on paired Orca environments (other computers): mapping, gap and timeout (stale), offline, no prompt text
// stored, no actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { briefOf, compactAgent, listAgentsAsync, renderAgents, stopAgent } from '../lib/agents.mjs';
import { REMOTE_GAP_MS, REMOTE_OFFLINE_MS, REMOTE_STALE_MS, mapRemote, readRemote } from '../lib/remote.mjs';

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
    const a = args[0] === 'environment' ? answers.env : answers.ps;
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
  assert.equal(r.title, FIRST); // k42: no Orca title and the default branch: the prompt's first line (fresh answer only)
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
  for (const k of ['canStop', 'canCompact', 'canPace', 'canReplace']) assert.equal(r[k], false);
  assert.equal(r.machineStale, false);
  assert.equal(r.machineOffline, false);
  assert.deepEqual(call.calls, ['environment list --json', 'worktree ps --environment env-1 --json']);
}));

test('remote: title from Orca taskTitle/displayName, else the prompt, else the branch; Windows paths give the folder', async () => {
  const { remoteRow } = await import('../lib/remote.mjs');
  const [a] = mapRemote(ps('working', { taskTitle: 'Fix the rain sound' }));
  assert.equal(a.title, 'Fix the rain sound');
  assert.equal(remoteRow('other', a, NOW, false, a.promptTitle).title, 'Fix the rain sound'); // Orca's own title wins
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
  assert.ok(!cache.includes(SECRET));
  assert.ok(!cache.includes(FIRST) && !cache.includes('promptTitle'), 'the prompt-derived title never reaches the cache file');
  assert.ok(!cache.includes('10.0.0.2') && !cache.includes('dev')); // endpoints and device ids are not kept either
}));

test('remote: one call per machine per 10 s; env list cached; a timeout reuses the last answer, stale after 60 s', () => withHome(async (home) => {
  let answer = okText(ps('working'));
  const call = caller({ env: okText(ENVS), ps: () => answer });
  await readRemote(home, { call, now: NOW });
  await readRemote(home, { call, now: NOW + REMOTE_GAP_MS - 1 });
  assert.equal(call.calls.length, 2); // cached: no second ps, no second env list
  answer = { ok: false, timeout: true };
  let rows = await readRemote(home, { call, now: NOW + REMOTE_GAP_MS });
  assert.equal(call.calls.length, 3);
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
  writeFileSync(slow, `#!/bin/sh\ncase "$1" in environment) echo '${ENVS}';; *) sleep 5;; esac\n`, { mode: 0o755 });
  const { remoteCaller } = await import('../lib/remote.mjs');
  const call = remoteCaller({ PATH: process.env.PATH, KADANS_ORCA_BIN: slow });
  const t0 = Date.now();
  const rows = await readRemote(home, { call, now: NOW, timeout: 200 });
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(rows.map((r) => [r.id, r.machineOffline]), [['remote:other', true]]); // never answered: offline
  assert.equal(remoteCaller({ KADANS_ORCA: '0' }), null);
}));

test('remote: listAgentsAsync appends remote rows after the local ones; remoteAgents false turns it off; brief and text skip them', () => withHome(async (home) => {
  const env = { PATH: '', KADANS_ORCA: '0' };
  const call = caller({ env: okText(ENVS), ps: okText(ps()) });
  const list = await listAgentsAsync(home, { env, now: NOW, alive: () => true, claudeDirs: [], remote: call });
  assert.deepEqual(list.map((a) => a.id), ['remote:other:tab-1:1']);
  assert.equal(briefOf(list, NOW).working, 0);
  assert.match(renderAgents(list, NOW), /remote:other:tab-1/);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ remoteAgents: false }));
  const off = await listAgentsAsync(home, { env, now: NOW + REMOTE_GAP_MS, alive: () => true, claudeDirs: [], remote: call });
  assert.deepEqual(off, []);
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
test('k42: the cache keeps the whitelist only: tool name and sub-agent count, never the prompt or its title', () => withHome(async (home) => {
  await readRemote(home, { call: caller({ env: okText(ENVS), ps: okText(ps()) }), now: NOW });
  const cache = JSON.parse(readFileSync(join(home, 'orca-remote.json'), 'utf8'));
  const [a] = cache.machines['env-1'].agents;
  assert.deepEqual(Object.keys(a).sort(), ['agentType', 'branch', 'cwd', 'paneKey', 'project', 'state', 'stateStartedAt', 'subagentCount',
    'title', 'toolName', 'updatedAt']);
  assert.equal(a.toolName, 'PowerShell');
  assert.equal(a.subagentCount, 1);
  assert.equal(a.title, null);
}));

test('k42: the prompt title rides only on the run that got the answer; a cached or stale answer falls back', () => withHome(async (home) => {
  let answer = okText(ps('working'));
  const call = caller({ env: okText(ENVS), ps: () => answer });
  let [r] = await readRemote(home, { call, now: NOW });
  assert.equal(r.title, FIRST);
  [r] = await readRemote(home, { call, now: NOW + 1000 }); // inside the gap: from the cache file, no prompt there
  assert.deepEqual([r.title, r.titleSource], [null, null]);
  answer = { ok: false, timeout: true };
  [r] = await readRemote(home, { call, now: NOW + REMOTE_STALE_MS + 1 }); // a timeout: the last answer, stale
  assert.equal(r.machineStale, true);
  assert.equal(r.title, null);
  assert.ok(!readFileSync(join(home, 'orca-remote.json'), 'utf8').includes(FIRST));
}));

test('k42: a sub-agent count counts running ones only; a tool name keeps a name, never its input', () => {
  const [a] = mapRemote(ps('working', { toolName: 'Bash <rm -rf />; echo', subagents: [{ id: 'a', status: 'running', description: SECRET }, { id: 'b', status: 'done' }] }));
  assert.equal(a.subagentCount, 1);
  assert.ok(!/[<>;/]/.test(a.toolName));
  assert.ok(!JSON.stringify({ ...a, promptTitle: null }).includes(SECRET)); // no sub-agent text
});
