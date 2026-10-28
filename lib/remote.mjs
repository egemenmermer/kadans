// k38: agents on the owner's other computers (paired Orca environments): `orca environment list --json` (cached, at most
// every ENV_LIST_MS) and one `orca worktree ps --environment <id> --json` per machine, at most every REMOTE_GAP_MS, with
// one REMOTE_TIMEOUT_MS budget. State lives in $KADANS_HOME/orca-remote.json (0600), mapped fields only: no prompt,
// assistant message, preview, comment, tool input or sub-agent text is ever stored. Rows: id `remote:<machine>:<paneKey>`.
// k48: the fetch runs in a detached `kadans remote refresh` (triggerRemote), so a short `kadans agents` run never waits on
// another computer and a slow answer still lands: the listing shows the cached rows (the last good details) while a
// fetch is in flight. The cache keeps the prompt-derived title (first line, 80 characters, cleaned: promptTitle) and each
// agent's terminal handle on its machine (an id), never the prompt itself. Actions (stop, compact, send) resolve the id
// through a fresh lookup on that machine and always pass --environment: a remote id never reaches a local terminal.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orcaStatus } from './agents.mjs';
import { SEND_REFUSAL, draftGuard, sendGuard } from './compact.mjs';
import { findOrca, killChild, orcaSpawn } from './platform.mjs';
import { writeAtomic } from './store.mjs';
import { PROD_RE } from './text.mjs';
import { cleanTitle } from './titles.mjs';

export const REMOTE_TIMEOUT_MS = 5000; // one budget for a machine's refresh (env list + ps), and for each action call
export const REMOTE_GAP_MS = 10_000; // at most one `worktree ps` per machine this often; the cached result in between
export const REMOTE_STALE_MS = 90_000; // no fresh answer for this long: rows say machineStale
export const REMOTE_OFFLINE_MS = 5 * 60_000; // timeouts for this long (or an error at once): the machine is offline
export const ENV_LIST_MS = 5 * 60_000;
const NAME_RE = /[^\w .-]/g;
// Env ids and terminal handles come from another machine and go into orca's argv: a plain id that cannot be read as a flag.
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/;
const validId = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : null);

const cacheFile = (home) => join(home, 'orca-remote.json');
export function readRemoteCache(home) {
  try {
    const v = JSON.parse(readFileSync(cacheFile(home), 'utf8'));
    return { envs: v?.envs && Array.isArray(v.envs.list) ? v.envs : { t: 0, list: [] }, machines: v?.machines && typeof v.machines === 'object' ? v.machines : {} };
  } catch {
    return { envs: { t: 0, list: [] }, machines: {} };
  }
}
function writeRemoteCache(home, cache) {
  writeAtomic(cacheFile(home), JSON.stringify(cache)); // 0600: it holds prompt-derived titles
}

// k41: a fresh env list (after `kadans computers` add / remove / list) replaces the cached one at once, so a new
// machine shows and a removed one goes without waiting ENV_LIST_MS. Machines no longer listed are forgotten.
export function setEnvList(home, list, now = Date.now()) {
  const cache = readRemoteCache(home);
  const ids = new Set(list.map((e) => e.id));
  cache.envs = { t: now, list };
  cache.machines = Object.fromEntries(Object.entries(cache.machines).filter(([id]) => ids.has(id)));
  writeRemoteCache(home, cache);
}

const clean = (s, n = 80) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n) : '') || null;
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
const base = (p) => clean(String(p ?? '').split(/[\\/]+/).filter(Boolean).pop() ?? '');
export const PROMPT_TITLE_CHARS = 80;
// k42: the first non-blank line of the agent's prompt as a title, or null. k48: kept in the cache (promptTitle).
const promptTitle = (p) => (typeof p === 'string' ? cleanTitle(p.split(/\r\n?|\n/).find((l) => l.trim()) ?? '', PROMPT_TITLE_CHARS) : null);
const DONE_RE = /done|complete|finish|end|stop|exit/i;
// Running sub-agents as a count only (their text never leaves this function).
const subCount = (list) => (Array.isArray(list) ? list.filter((x) => x && !DONE_RE.test(String(x.status ?? x.state ?? ''))).length : 0);

// `orca environment list --json` -> [{ id, name }] (nothing else is kept: no endpoints, device or pairing ids).
export function parseEnvs(text) {
  const list = JSON.parse(text)?.result?.environments;
  if (!Array.isArray(list)) throw new Error('no environments');
  return list.map((e) => ({ id: clean(e?.id, 100), name: clean(String(e?.name ?? '').replace(NAME_RE, ''), 40) ?? clean(e?.id, 8) }))
    .filter((e) => validId(e.id) && e.name);
}

// One machine's `orca worktree ps --json` -> the agents, mapped fields only (the whitelist below).
export function mapRemote(text) {
  const ps = JSON.parse(text)?.result;
  if (!ps || !Array.isArray(ps.worktrees)) throw new Error('no worktrees');
  const out = [];
  for (const w of ps.worktrees) {
    for (const a of Array.isArray(w?.agents) ? w.agents : []) {
      if (!a?.paneKey) continue;
      const branch = clean(String(w.branch ?? '').replace(/^refs\/heads\//, ''));
      const onDefault = w.defaultBranch === true || w.isMainWorktree === true || /^(main|master)$/.test(branch ?? '');
      out.push({
        paneKey: clean(String(a.paneKey), 100),
        agentType: clean(a.agentType, 20),
        state: clean(a.state, 30),
        stateStartedAt: num(a.stateStartedAt),
        updatedAt: num(a.updatedAt),
        project: clean(w.repo, 60) ?? base(w.path),
        cwd: clean(w.path, 300),
        title: clean(a.taskTitle) ?? clean(a.displayName), // Orca's own title
        branch: onDefault ? null : branch ?? clean(w.displayName), // the last resort before "Session in <project>"
        toolName: clean(String(a.toolName ?? '').replace(/[^\w .:-]/g, ''), 40), // a tool's name only, never its input
        subagentCount: subCount(a.subagents),
        promptTitle: promptTitle(a.prompt), // the first line only, cleaned; the prompt itself is never kept
      });
    }
  }
  return out;
}

// Runs one orca call in the background: resolves { ok, text } / { ok: false, timeout }; never rejects.
function orcaCall(bin, args, timeout, env = process.env, childEnv = undefined) {
  timeout = Number(env.KADANS_ORCA_TIMEOUT_MS) || timeout; // tests on a loaded machine raise it (same override as lib/agents.mjs)
  return new Promise((done) => {
    let out = '';
    let child;
    try {
      const s = orcaSpawn(bin, args, { env });
      child = spawn(s.file, s.args, { ...s.opts, ...(childEnv ? { env: childEnv } : {}), stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      done({ ok: false, timeout: false });
      return;
    }
    const timer = setTimeout(() => {
      done({ ok: false, timeout: true });
      killChild(child);
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('error', () => {
      clearTimeout(timer);
      done({ ok: false, timeout: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 ? { ok: true, text: out } : { ok: false, timeout: false });
    });
  });
}

// Default caller: the real orca CLI (KADANS_ORCA=0 turns it off, KADANS_ORCA_BIN picks the binary). Tests inject one.
// childEnv (k51): the orca child's whole environment instead of this process's (the inbox drops Orca's session variables).
export function remoteCaller(env = process.env, { childEnv } = {}) {
  if (env.KADANS_ORCA === '0') return null;
  const bin = findOrca(env);
  return bin ? (args, timeout) => orcaCall(bin, args, timeout, env, childEnv) : null;
}

// `orca terminal list --json` of one machine -> Map(paneKey "<tabId>:<leafId>" -> { handle, writable }). Ids only.
export function remoteHandles(text) {
  const tl = JSON.parse(text)?.result;
  if (!tl || !Array.isArray(tl.terminals)) throw new Error('no terminals');
  const out = new Map();
  for (const t of tl.terminals) {
    const handle = validId(t?.handle);
    if (handle && typeof t.tabId === 'string' && typeof t.leafId === 'string') out.set(`${t.tabId}:${t.leafId}`, { handle, writable: t.writable !== false });
  }
  return out;
}

// What is due: the env list (every ENV_LIST_MS) and the machines past their gap.
function dueOf(cache, now) {
  const envs = now - (cache.envs.t ?? 0) >= ENV_LIST_MS || now < cache.envs.t;
  const machines = cache.envs.list.filter((e) => {
    const m = cache.machines[e.id];
    return !m || now - (m.tried ?? 0) >= REMOTE_GAP_MS || now < (m.tried ?? 0);
  });
  return { envs, machines, any: envs || machines.length > 0 };
}

// Refreshes what is due and writes the cache. call: (args, timeout) -> Promise<{ ok, text } | { ok: false, timeout }>.
// The env list and the machines' `worktree ps` share one `timeout` budget; a machine whose agents have a pane with no
// known handle also gets one `terminal list --environment` (its own timeout). A timeout keeps the last answer (stale after
// REMOTE_STALE_MS); an error, or timeouts for REMOTE_OFFLINE_MS, make the machine offline.
export async function refreshRemote(home, { call, now = Date.now(), timeout = REMOTE_TIMEOUT_MS, clock = Date.now } = {}) {
  if (!call) return;
  const t0 = clock();
  const left = () => Math.max(250, timeout - (clock() - t0));
  const cache = readRemoteCache(home);
  const due = dueOf(cache, now);
  if (!due.any) return;
  if (due.envs) {
    const r = await call(['environment', 'list', '--json'], left());
    try {
      if (r.ok) cache.envs = { t: now, list: parseEnvs(r.text) };
    } catch {
      // keep the old list
    }
    if (!r.ok) cache.envs = { ...cache.envs, t: now }; // tried; again after ENV_LIST_MS
  }
  const machines = dueOf(cache, now).machines;
  for (const e of machines) cache.machines[e.id] = { ...(cache.machines[e.id] ?? {}), tried: now };
  try {
    writeRemoteCache(home, cache); // other runs in the gap reuse the cache instead of calling again
  } catch {
    // best effort
  }
  const done = await Promise.all(machines.map(async (e) => {
    const r = await call(['worktree', 'ps', '--environment', e.id, '--json'], left());
    let agents = null;
    try {
      if (r.ok) agents = mapRemote(r.text);
    } catch {
      agents = null;
    }
    if (!agents) return [e.id, r.timeout ? { done: now } : { error: true, done: now }];
    const known = new Map((cache.machines[e.id]?.agents ?? []).map((a) => [a.paneKey, a.handle ?? null]));
    let handles = null;
    if (agents.some((a) => !known.get(a.paneKey)) && validId(e.id)) {
      const l = await call(['terminal', 'list', '--environment', e.id, '--json', '--limit', '1000'], timeout);
      try {
        if (l.ok) handles = remoteHandles(l.text);
      } catch {
        handles = null;
      }
    }
    for (const a of agents) a.handle = handles ? handles.get(a.paneKey)?.handle ?? null : known.get(a.paneKey) ?? null;
    return [e.id, { t: now, agents, error: false, done: now }];
  }));
  // Merge into the newest cache: another run may have written it while this one waited.
  const latest = readRemoteCache(home);
  if ((cache.envs.t ?? 0) >= (latest.envs.t ?? 0)) latest.envs = cache.envs; // else `kadans computers` listed them since
  const ids = new Set(latest.envs.list.map((e) => e.id));
  const next = {};
  for (const [id, m] of Object.entries({ ...cache.machines, ...latest.machines })) if (ids.has(id)) next[id] = { ...cache.machines[id], ...m };
  for (const [id, m] of done) if (m) next[id] = { ...next[id], ...m, tried: now };
  latest.machines = next; // forget removed environments
  try {
    writeRemoteCache(home, latest);
  } catch {
    // best effort
  }
}

// The rows of the cache (no orca call): the last good details, also while a refresh is in flight. A machine that never
// answered shows nothing while its first fetch is in flight (tried, not done, within REMOTE_GAP_MS), then offline.
export function remoteRows(home, now = Date.now()) {
  const cache = readRemoteCache(home);
  const rows = [];
  for (const e of cache.envs.list) {
    const m = cache.machines[e.id] ?? {};
    const age = Number.isFinite(m.t) ? now - m.t : Infinity;
    const inFlight = Number.isFinite(m.tried) && !((m.done ?? -Infinity) >= m.tried) && now - m.tried < REMOTE_GAP_MS && now >= m.tried;
    if (!Number.isFinite(m.t) && !m.error && inFlight) continue;
    if (m.error || age > REMOTE_OFFLINE_MS) {
      if (Number.isFinite(m.tried)) rows.push(offlineRow(e.name));
      continue;
    }
    for (const a of Array.isArray(m.agents) ? m.agents : []) rows.push(remoteRow(e.name, a, now, age > REMOTE_STALE_MS));
  }
  return rows;
}

// Refresh what is due, then the rows: for `kadans computers` and tests, which may wait for the answer.
export async function readRemote(home, { call, now = Date.now(), timeout = REMOTE_TIMEOUT_MS } = {}) {
  if (!call) return [];
  await refreshRemote(home, { call, now, timeout });
  return remoteRows(home, now);
}

// ---------- the detached refresher (k48) ----------

const BIN = fileURLToPath(new URL('../bin/kadans.mjs', import.meta.url));
const stampFile = (home) => join(home, 'orca-remote.stamp');
function spawnRefresh(home, env) {
  const child = spawn(process.execPath, [BIN, 'remote', 'refresh'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, KADANS_HOME: home } });
  child.unref();
}

// Starts a detached `kadans remote refresh` when something is due, at most once per REMOTE_GAP_MS (stamp file), so the
// listing never waits on another computer and the fetch finishes after the listing has printed. Never throws.
export function triggerRemote(home, { env = process.env, now = Date.now(), start = spawnRefresh } = {}) {
  try {
    if (!dueOf(readRemoteCache(home), now).any) return false;
    const last = Number(readFileSync(stampFile(home), 'utf8').trim()) || null;
    if (last !== null && now - last < REMOTE_GAP_MS && now >= last) return false;
  } catch {
    // no stamp yet
  }
  try {
    writeFileSync(stampFile(home), `${now}\n`, { mode: 0o600 });
    start(home, env);
    return true;
  } catch {
    return false;
  }
}

const NO_ACTIONS = { canStop: false, canCompact: false, canSend: false, canPace: false, canReplace: false };
const shared = (machine) => ({
  source: 'orca', machine, model: null, tokens: null, context: null, startedAt: null, account: null,
  pace: { mode: 'none', until: null }, firstPrompt: null, subagents: [], subagentTokens: null, pid: null, ...NO_ACTIONS,
});

// One remote agent -> a row with the same keys as an Orca-only row, plus machine / machineStale / machineOffline and
// (k42) agentType, toolName, subagentCount. Title: Orca's own, else the prompt's first line (k48: cached, so every run
// has it, stale rows too: the last good details), else the branch, else null (the panel says "Session in <project>").
// k48 flags: canStop when the agent's terminal handle on its machine is known; canCompact for an idle Claude chat with a
// handle, canSend (k49) for an idle one too; none on a stale machine. The handle itself stays out of the row (actions look it up again).
export function remoteRow(machine, a, now, stale = false) {
  const status = orcaStatus(a.state) ?? 'idle';
  const prompt = typeof a.promptTitle === 'string' && a.promptTitle ? a.promptTitle : null;
  const [title, titleSource] = a.title ? [a.title, 'orca'] : prompt ? [prompt, 'prompt'] : a.branch ? [a.branch, 'branch'] : [null, null];
  const handle = !stale && validId(a.handle);
  const typeable = Boolean(handle) && a.agentType === 'claude' && status === 'idle';
  // k49: on this Mac a message may reach a working chat (Claude Code queues it), but not here: between the screen read and
  // the keystrokes lies a network round trip, and a permission dialog opened in that gap would take the Enter (its
  // default is "Yes"). A remote chat gets messages only while it waits for its next prompt (owner decision 2026-10-27).
  const sendable = typeable;
  return {
    id: `remote:${machine}:${a.paneKey}`,
    ...shared(machine),
    project: a.project ?? null,
    cwd: a.cwd ?? null,
    lastSeen: a.updatedAt ?? null,
    status,
    stateSince: a.stateStartedAt ?? a.updatedAt ?? null,
    stateSource: 'orca',
    stale: false,
    title,
    titleSource,
    agentType: a.agentType ?? null,
    toolName: a.toolName ?? null,
    subagentCount: Number.isFinite(a.subagentCount) ? a.subagentCount : 0,
    // never a local handle: stopAgent / compactAgent would act on this computer's terminal otherwise
    orca: { terminal: null, worktree: null, repo: a.project ?? null, state: a.state ?? null, title: null, ambiguous: false },
    canStop: Boolean(handle),
    canCompact: typeable,
    canSend: sendable,
    machineStale: stale,
    machineOffline: false,
  };
}

// An offline machine: one marker row (the panel shows "<machine> · offline", the CLI skips it; never counted).
export function offlineRow(machine) {
  return {
    id: `remote:${machine}`,
    ...shared(machine),
    project: null, cwd: null, lastSeen: null, status: 'idle', stateSince: null, stateSource: 'orca', stale: false,
    title: null, titleSource: null, orca: null, machineStale: true, machineOffline: true,
  };
}

// ---------- actions on another computer (k48) ----------
// Every action takes the row id, never a row: the id is looked up again on its machine (fresh `worktree ps` and
// `terminal list`, both with --environment), and every orca call it makes carries `--environment <env id>`. Nothing here
// reads the local pane map or calls the local orca runner, so a remote id can never close or type into a terminal on
// this computer. Refusals and results are fixed sentences: no prompt, screen or message text.

const MACHINE_RE = /^[\w .-]{1,40}$/;
// remote:<machine>:<paneKey> -> { machine, paneKey } or null. Machine names never hold ':' (parseEnvs keeps [\w .-]).
export function parseRemoteId(id) {
  const m = /^remote:([^:]+):([^\s]{1,100})$/.exec(typeof id === 'string' ? id : '');
  return m && MACHINE_RE.test(m[1]) ? { machine: m[1], paneKey: m[2] } : null;
}
export const isRemoteId = (id) => typeof id === 'string' && id.startsWith('remote:');

// A fresh lookup: { ok, env, machine, agent, handle, writable } or { ok: false, why }.
export async function resolveRemote(home, id, { call, timeout = REMOTE_TIMEOUT_MS } = {}) {
  const ref = parseRemoteId(id);
  if (!ref) return { ok: false, why: 'not an agent on another computer' };
  if (!call) return { ok: false, why: 'the orca CLI is not available' };
  const envs = readRemoteCache(home).envs.list.filter((e) => e.name === ref.machine);
  if (envs.length !== 1) return { ok: false, why: envs.length ? `several computers are called ${ref.machine}` : `no computer called ${ref.machine}` };
  const envId = validId(envs[0].id);
  if (!envId) return { ok: false, why: `cannot address ${ref.machine}` };
  if (PROD_RE.test(ref.machine) || PROD_RE.test(envId)) return { ok: false, why: 'refused: Kadans never types into a production host' };
  const [p, l] = await Promise.all([
    call(['worktree', 'ps', '--environment', envId, '--json'], timeout),
    call(['terminal', 'list', '--environment', envId, '--json', '--limit', '1000'], timeout),
  ]);
  if (!p.ok || !l.ok) return { ok: false, why: `${ref.machine} did not answer; try again` };
  let agent;
  let term;
  try {
    agent = mapRemote(p.text).find((a) => a.paneKey === ref.paneKey) ?? null;
    term = remoteHandles(l.text).get(ref.paneKey) ?? null;
  } catch {
    return { ok: false, why: `${ref.machine} gave an answer Kadans cannot read` };
  }
  if (!agent) return { ok: false, why: `that agent is no longer running on ${ref.machine}` };
  if (!term) return { ok: false, why: `Orca on ${ref.machine} reports no terminal for that agent` };
  return { ok: true, env: envId, machine: ref.machine, agent, handle: term.handle, writable: term.writable };
}

// Closes the agent's terminal on its machine. -> { ok, how, argv } | { ok: false, why }.
export async function remoteStop(home, id, { call, timeout = REMOTE_TIMEOUT_MS, dryRun = false } = {}) {
  const r = await resolveRemote(home, id, { call, timeout });
  if (!r.ok) return r;
  const argv = ['terminal', 'close', '--environment', r.env, '--terminal', r.handle, '--json'];
  if (dryRun) return { ok: true, argv, how: `would close terminal ${r.handle} on ${r.machine}` };
  const c = await call(argv, timeout);
  return c.ok ? { ok: true, argv, how: `closed terminal ${r.handle} on ${r.machine}` } : { ok: false, why: `Orca on ${r.machine} did not close it` };
}

// Types `text` plus Enter into an idle Claude chat on its machine: compact after the draft guard, send (k49) after the send
// guard (the rendered screen must show an empty input line: never submits half-typed text). A working chat is refused
// for both: a dialog it opens between the read and the send, a network round trip later, would get the keystrokes.
// kind: 'compact' | 'send'.
async function typeRemote(home, id, text, kind, { call, timeout = REMOTE_TIMEOUT_MS, dryRun = false } = {}) {
  const r = await resolveRemote(home, id, { call, timeout });
  if (!r.ok) return r;
  if (r.agent.agentType !== 'claude') return { ok: false, why: 'Kadans types only into Claude Code chats' };
  const status = orcaStatus(r.agent.state) ?? 'idle';
  if (status === 'working') return { ok: false, why: 'it is working; try again when it waits for your next prompt' };
  if (status === 'needs-you') return { ok: false, why: 'it is waiting on a question or permission; answer it first' };
  if (!r.writable) return { ok: false, why: `Orca on ${r.machine} does not let Kadans type into that terminal` };
  const readArgv = ['terminal', 'read', '--environment', r.env, '--terminal', r.handle, '--screen', '--json'];
  const sendArgv = ['terminal', 'send', '--environment', r.env, '--terminal', r.handle, '--text', text, '--enter'];
  const what = kind === 'compact' ? '/compact' : 'the message';
  if (dryRun) return { ok: true, readArgv, how: `would read the screen of terminal ${r.handle} on ${r.machine}, and only if its input line is empty type ${what}` };
  const screen = await call(readArgv, timeout);
  if (!screen.ok) return { ok: false, why: kind === 'compact' ? `Could not read that chat's screen on ${r.machine}: type /compact there yourself` : SEND_REFUSAL.other };
  const guard = kind === 'compact' ? draftGuard(screen.text) : sendGuard(screen.text, { agentType: r.agent.agentType });
  if (!guard.ok) return guard;
  const s = await call(sendArgv, timeout);
  if (!s.ok) return { ok: false, why: `Orca on ${r.machine} did not take ${what}` };
  return { ok: true, how: `sent ${what} to terminal ${r.handle} on ${r.machine}` };
}

export const remoteCompact = (home, id, opts = {}) => typeRemote(home, id, '/compact', 'compact', opts);
// text: already checked by messageText (lib/text.mjs). It goes into orca's argv only: never logged, stored or returned.
export const remoteSend = (home, id, text, opts = {}) => typeRemote(home, id, text, 'send', opts);
