// k38: agents on the owner's other computers (paired Orca environments). Read-only: `orca environment list --json`
// (cached, at most every ENV_LIST_MS) and one `orca worktree ps --environment <id> --json` per machine, at most every
// REMOTE_GAP_MS, with a REMOTE_TIMEOUT_MS timeout. State between short-lived `kadans agents` runs lives in
// $KADANS_HOME/orca-remote.json, mapped fields only: no prompt, assistant message, preview, comment, tool input or
// sub-agent text is ever stored. Rows: id `remote:<machine>:<paneKey>`; no actions (Kadans only acts on this computer).
// k42: a title from the first line of the agent's prompt rides only on the rows of the run that got the answer (memory,
// stdout); it is split off before the cache is written and never logged. The panel keeps it in page memory in between.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { orcaStatus } from './agents.mjs';
import { findOrca, killChild, orcaSpawn, renameRetry } from './platform.mjs';
import { cleanTitle } from './titles.mjs';

export const REMOTE_TIMEOUT_MS = 2000;
export const REMOTE_GAP_MS = 10_000; // at most one `worktree ps` per machine this often; the cached result in between
export const REMOTE_STALE_MS = 60_000; // no fresh answer for this long: rows say machineStale
export const REMOTE_OFFLINE_MS = 5 * 60_000; // timeouts for this long (or an error at once): the machine is offline
export const ENV_LIST_MS = 5 * 60_000;
const NAME_RE = /[^\w .-]/g;

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
  const f = cacheFile(home);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache));
  renameRetry(tmp, f);
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
// k42: the first non-blank line of the agent's prompt as a title (memory only, see readRemote), or null.
const promptTitle = (p) => (typeof p === 'string' ? cleanTitle(p.split(/\r\n?|\n/).find((l) => l.trim()) ?? '', PROMPT_TITLE_CHARS) : null);
const DONE_RE = /done|complete|finish|end|stop|exit/i;
// Running sub-agents as a count only (their text never leaves this function).
const subCount = (list) => (Array.isArray(list) ? list.filter((x) => x && !DONE_RE.test(String(x.status ?? x.state ?? ''))).length : 0);

// `orca environment list --json` -> [{ id, name }] (nothing else is kept: no endpoints, device or pairing ids).
export function parseEnvs(text) {
  const list = JSON.parse(text)?.result?.environments;
  if (!Array.isArray(list)) throw new Error('no environments');
  return list.map((e) => ({ id: clean(e?.id, 100), name: clean(String(e?.name ?? '').replace(NAME_RE, ''), 40) ?? clean(e?.id, 8) }))
    .filter((e) => e.id && e.name);
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
        promptTitle: promptTitle(a.prompt), // split off before the cache is written (readRemote)
      });
    }
  }
  return out;
}

// Runs one orca call in the background: resolves { ok, text } / { ok: false, timeout }; never rejects.
function orcaCall(bin, args, timeout, env = process.env) {
  return new Promise((done) => {
    let out = '';
    let child;
    try {
      const s = orcaSpawn(bin, args, { env });
      child = spawn(s.file, s.args, { ...s.opts, stdio: ['ignore', 'pipe', 'ignore'] });
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
export function remoteCaller(env = process.env) {
  if (env.KADANS_ORCA === '0') return null;
  const bin = findOrca(env);
  return bin ? (args, timeout) => orcaCall(bin, args, timeout, env) : null;
}

// Refreshes what is due (env list, machines past their gap) and returns the remote rows. call: (args, timeout) ->
// Promise<{ ok, text } | { ok: false, timeout }>. A timeout keeps the last answer (stale after REMOTE_STALE_MS);
// an error, or timeouts for REMOTE_OFFLINE_MS, make the machine offline: one marker row, no agent rows.
export async function readRemote(home, { call, now = Date.now(), timeout = REMOTE_TIMEOUT_MS } = {}) {
  if (!call) return [];
  const cache = readRemoteCache(home);
  let dirty = false;
  if (now - (cache.envs.t ?? 0) >= ENV_LIST_MS || now < cache.envs.t) {
    const r = await call(['environment', 'list', '--json'], timeout);
    try {
      if (r.ok) cache.envs = { t: now, list: parseEnvs(r.text) };
    } catch {
      // keep the old list
    }
    if (!r.ok) cache.envs = { ...cache.envs, t: now }; // tried; again after ENV_LIST_MS
    dirty = true;
  }
  const envs = cache.envs.list;
  const machines = {};
  const fresh = new Map(); // env id -> Map(paneKey -> prompt title), this run's answers only
  const due = envs.filter((e) => {
    const m = cache.machines[e.id];
    return !m || now - (m.tried ?? 0) >= REMOTE_GAP_MS || now < (m.tried ?? 0);
  });
  if (due.length) {
    for (const e of due) cache.machines[e.id] = { ...(cache.machines[e.id] ?? {}), tried: now };
    try {
      writeRemoteCache(home, cache); // other runs in the gap reuse the cache instead of calling again
    } catch {
      // best effort
    }
    const answers = await Promise.all(due.map((e) => call(['worktree', 'ps', '--environment', e.id, '--json'], timeout)));
    due.forEach((e, i) => {
      const r = answers[i];
      const m = cache.machines[e.id];
      let agents = null;
      try {
        if (r.ok) agents = mapRemote(r.text);
      } catch {
        agents = null;
      }
      if (agents) {
        // k42: prompt titles stay in this run's memory; the cache gets the agents without them.
        fresh.set(e.id, new Map(agents.map((a) => [a.paneKey, a.promptTitle])));
        Object.assign(m, { t: now, agents: agents.map(({ promptTitle: _, ...rest }) => rest), error: false });
      }
      else if (!r.timeout) Object.assign(m, { error: true });
    });
    dirty = true;
  }
  for (const e of envs) machines[e.id] = cache.machines[e.id];
  cache.machines = machines; // forget removed environments
  if (dirty) {
    try {
      writeRemoteCache(home, cache);
    } catch {
      // best effort
    }
  }
  const rows = [];
  for (const e of envs) {
    const m = machines[e.id] ?? {};
    const age = Number.isFinite(m.t) ? now - m.t : Infinity;
    if (m.error || age > REMOTE_OFFLINE_MS) {
      if (Number.isFinite(m.tried)) rows.push(offlineRow(e.name));
      continue;
    }
    for (const a of m.agents ?? []) rows.push(remoteRow(e.name, a, now, age > REMOTE_STALE_MS, fresh.get(e.id)?.get(a.paneKey) ?? null));
  }
  return rows;
}

const NO_ACTIONS = { canStop: false, canCompact: false, canPace: false, canReplace: false };
const shared = (machine) => ({
  source: 'orca', machine, model: null, tokens: null, context: null, startedAt: null, account: null,
  pace: { mode: 'none', until: null }, firstPrompt: null, subagents: [], subagentTokens: null, pid: null, ...NO_ACTIONS,
});

// One remote agent -> a row with the same keys as an Orca-only row, plus machine / machineStale / machineOffline and
// (k42) agentType, toolName, subagentCount. Title: Orca's own, else the prompt's first line (only from a fresh answer:
// promptTitle), else the branch, else null (the panel says "Session in <project>").
export function remoteRow(machine, a, now, stale = false, promptTitle = null) {
  const status = orcaStatus(a.state) ?? 'idle';
  const prompt = stale ? null : promptTitle;
  const [title, titleSource] = a.title ? [a.title, 'orca'] : prompt ? [prompt, 'prompt'] : a.branch ? [a.branch, 'branch'] : [null, null];
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
    orca: { terminal: null, worktree: null, repo: a.project ?? null, state: a.state ?? null, title: null, ambiguous: false }, // never a handle: stop would close a local terminal
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
