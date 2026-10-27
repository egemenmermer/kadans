// Running Claude Code agents on this Mac: sessions from status-line samples and a small hook event log, tokens and model
// from each session's transcript, plus Orca's live agent states when the `orca` CLI is around.
// Event log: $KADANS_HOME/events/YYYY-MM-DD.jsonl (UTC day), append-only under the store lock; files older than 2 days
// are deleted. Transcript scan state: $KADANS_HOME/agents-cache.json (byte offset, size and mtime per session).
// Orca pane map: $KADANS_HOME/orca-panes.json (pane key -> terminal handle, ids only). Brief counts for the menu bar:
// $KADANS_HOME/agents-brief.json ({ working, needsYou, t }), written by every full list.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { listAccounts, readSamples } from './samples.mjs';
import { PRIVATE_DIR, PRIVATE_FILE, withLock, writeAtomic } from './store.mjs';
import { stripControl } from './text.mjs';
import { findOrca, killChild, onPath as platformOnPath, orcaSpawn } from './platform.mjs';
import { cleanTitle, pickTitle, readTitles, smartTitleOf, titlerDir } from './titles.mjs';
import { paceOf, readPace, readRawConfig } from './pace-control.mjs';
import { loadConfig } from './pace.mjs';
import { leanOf, readLean } from './lean.mjs';
import { SEND_REFUSAL, compactPlan, contextOf, draftGuard, screenReadArgv, sendGuard } from './compact.mjs';
import { applyOrder, dropFromOrder, readOrder } from './order.mjs';
import { progressFromLine } from './progress.mjs';
import { remoteRows } from './remote.mjs';

export const EVENT_KEEP_MS = 2 * 24 * 3600 * 1000;
export const WORKING_MS = 2 * 60_000;
export const ENDED_MS = 30 * 60_000;
export const PROMPT_CHARS = 120;
export const PROMPT_RAW_CHARS = 2000;
export const STALE_MS = 2 * 3600_000; // idle this long: left out of the default list
export const ASKED_MS = 30 * 60_000; // a reply that ended in a question keeps a non-Orca chat on needs-you this long
export const ORCA_TIMEOUT_MS = 1000; // a slower orca CLI counts as absent for that refresh (hook rules apply)
export const PANES_REFRESH_MS = 60_000; // `orca terminal list` at most this often, and only for a pane with no known handle
export const BRIEF_FRESH_MS = 2000; // `agents --brief` reuses the counts of a full list this recent
export const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd', 'Notification'];
const NEEDS_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog']);
const STATUS_ORDER = { 'needs-you': 0, working: 1, idle: 2, ended: 3 };

const eventsDir = (home) => join(home, 'events');
const cacheFile = (home) => join(home, 'agents-cache.json');
const panesFile = (home) => join(home, 'orca-panes.json');
const briefFile = (home) => join(home, 'agents-brief.json');
const day = (t) => new Date(t).toISOString().slice(0, 10);
const clip = (s) => {
  const t = typeof s === 'string' ? stripControl(s).trim() : '';
  return t ? t.replace(/\s+/g, ' ').slice(0, PROMPT_CHARS) : null;
};

// ---------- event log ----------

export function appendEvent(home, ev, now = Date.now()) {
  withLock(home, () => {
    const dir = eventsDir(home);
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
    for (const f of readdirSync(dir)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (m && m[1] < day(now - EVENT_KEEP_MS)) rmSync(join(dir, f), { force: true }); // whole days past the 2-day window
    }
    appendFileSync(join(dir, `${day(now)}.jsonl`), `${JSON.stringify(ev)}\n`, { mode: PRIVATE_FILE });
  });
}

export function readEvents(home, now = Date.now()) {
  const dir = eventsDir(home);
  if (!existsSync(dir)) return [];
  const cutoff = now - EVENT_KEEP_MS;
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && typeof e.t === 'number' && e.t >= cutoff && typeof e.sid === 'string') out.push(e);
      } catch {
        // a torn line: skip
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---------- hook side ----------

// Last assistant text of a transcript (reads only the tail).
export function lastAssistantText(path, tailBytes = 256 * 1024) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      if (!line.includes('"assistant"')) continue;
      try {
        const d = JSON.parse(line);
        if (d.type !== 'assistant') continue;
        const c = d.message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
        if (text.trim()) return text;
      } catch {
        // partial first line of the tail
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}

export function endsWithQuestion(text) {
  if (typeof text !== 'string') return false;
  return /[?？]$/.test(text.trim().replace(/[\s*_`)"'»]+$/u, ''));
}

// ps(pid) -> { ppid, comm } | null. Walks up from the hook's parent to the `claude` process (hooks run under a shell).
export function findClaudePid(start, ps, depth = 6) {
  let pid = start;
  for (let i = 0; i < depth && pid > 1; i++) {
    const p = ps(pid);
    if (!p) return null;
    if (basename(p.comm) === 'claude') return pid;
    pid = p.ppid;
  }
  return null;
}

export function realPs(pid) {
  const r = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
  const m = r.status === 0 ? r.stdout.trim().match(/^(\d+)\s+(.+)$/) : null;
  return m ? { ppid: Number(m[1]), comm: m[2].trim() } : null;
}

// Hook input -> one event line (null = not ours to record).
export function eventFromInput(input, now, { pid = null, asked = null } = {}) {
  const ev = input?.hook_event_name;
  const sid = input?.session_id;
  if (!EVENTS.includes(ev) || typeof sid !== 'string' || !sid) return null;
  if (ev === 'Notification' && !NEEDS_NOTIFICATIONS.has(input.notification_type)) return null;
  const e = { t: now, ev, sid, cwd: input.cwd ?? null, transcript: input.transcript_path ?? null };
  if (pid) e.pid = pid;
  if (ev === 'UserPromptSubmit') e.prompt = clip(input.prompt);
  if (ev === 'Stop') e.asked = asked === true;
  if (ev === 'SubagentStart' || ev === 'SubagentStop') Object.assign(e, { agentId: input.agent_id ?? null, agentType: input.agent_type ?? null });
  if (ev === 'SessionStart') e.source = input.source ?? null;
  if (ev === 'SessionEnd') e.reason = input.reason ?? null;
  if (ev === 'Notification') e.kind = input.notification_type;
  return e;
}

// `kadans hook event`: records the event, prints nothing (SessionStart / UserPromptSubmit stdout would reach Claude).
export function runEvent(raw, env, { home, now = Date.now(), ps = realPs, ppid = process.ppid } = {}) {
  const input = JSON.parse(raw);
  const ev = input?.hook_event_name;
  const pid = ev === 'SessionStart' || ev === 'UserPromptSubmit' ? findClaudePid(ppid, ps) : null;
  let asked = null;
  if (ev === 'Stop') {
    const text = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : lastAssistantText(input.transcript_path);
    asked = endsWithQuestion(text);
  }
  const e = eventFromInput(input, now, { pid, asked });
  if (e) appendEvent(home, e, now);
  return '';
}

// ---------- transcripts ----------

const usageTokens = (u) => (Number(u?.input_tokens) || 0) + (Number(u?.output_tokens) || 0) + (Number(u?.cache_creation_input_tokens) || 0);
// Context size of one request: everything the model read (new input, cache writes and cache reads).
const contextTokens = (u) => (Number(u?.input_tokens) || 0) + (Number(u?.cache_creation_input_tokens) || 0) + (Number(u?.cache_read_input_tokens) || 0);

// Context of one assistant line: { ctx, ctxAt, cache1h } or null (sidechain, synthetic or empty usage). cache1h: the
// request wrote the prompt cache with the 1-hour lifetime only (true), the 5-minute one (false), or wrote none (null).
function contextOfLine(d) {
  if (d?.type !== 'assistant' || !d.message?.usage || d.isSidechain || d.message.model === '<synthetic>') return null;
  const u = d.message.usage;
  const ctx = contextTokens(u);
  if (ctx <= 0) return null;
  const h1 = Number(u.cache_creation?.ephemeral_1h_input_tokens) || 0;
  const m5 = Number(u.cache_creation?.ephemeral_5m_input_tokens) || 0;
  const t = Date.parse(d.timestamp);
  return { ctx, ctxAt: Number.isFinite(t) ? t : null, cache1h: h1 > 0 && m5 === 0 ? true : m5 > 0 ? false : null };
}

// Context after a finished compact: Claude Code writes a main-chain {"type":"system","subtype":"compact_boundary",
// "compactMetadata":{"preTokens","postTokens"},"timestamp"} line. Only compactMetadata.postTokens and the timestamp are read.
// The context is postTokens until the next assistant message reports its own. { ctx, ctxAt, cache1h: null } or null.
function contextOfBoundary(d) {
  if (d?.type !== 'system' || d.subtype !== 'compact_boundary' || d.isSidechain) return null;
  const post = Number(d.compactMetadata?.postTokens);
  if (!Number.isFinite(post) || post <= 0) return null;
  const t = Date.parse(d.timestamp);
  return { ctx: Math.round(post), ctxAt: Number.isFinite(t) ? t : null, cache1h: null };
}

// The newest assistant context (or compact boundary) in the last tailBytes of a transcript: { ctx, ctxAt, cache1h } with
// nulls when none.
export function lastContext(path, tailBytes = 1024 * 1024) {
  const none = { ctx: null, ctxAt: null, cache1h: null };
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"') && !lines[i].includes('"compact_boundary"')) continue;
      try {
        const d = JSON.parse(lines[i]);
        const c = contextOfLine(d) ?? contextOfBoundary(d);
        if (c) return c;
      } catch {
        // partial first line of the tail
      }
    }
  } catch {
    return none;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return none;
}

// The user's typed prompt (raw, up to PROMPT_RAW_CHARS), or null for commands, reminders and tool results.
function promptText(d) {
  if (d.type !== 'user' || d.isMeta || d.isSidechain || d.message?.role !== 'user') return null;
  const c = d.message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b?.type === 'text')?.text ?? null) : null;
  if (!text || !text.trim() || text.trimStart().startsWith('<')) return null;
  return text.slice(0, PROMPT_RAW_CHARS);
}

// Bump when the scan state gains fields: older cached states are rescanned from the start.
export const SCAN_VERSION = 3;
export const RECENT_PROMPTS = 3; // the last user prompts kept for smart titles (lib/smart-titles.mjs)
export const RECENT_CHARS = 300;
const freshScan = (path) => ({ v: SCAN_VERSION, path, offset: 0, done: 0, curId: null, cur: 0, model: null, firstPrompt: null, promptRaw: null, prompts: 0, recent: [], customTitle: null, aiTitle: null, ctx: null, ctxAt: null, cache1h: null, progress: null, tasks: [], size: 0, mtime: 0 });

// Reads the transcript from the saved offset. One assistant message is written as several lines (one per content block)
// that repeat the same usage: they are counted once per message id, the last line of a message wins.
// Session titles: the last `custom-title` (/rename) and the last `ai-title` (Claude Code's own) entry.
// Context size: the newest main-chain assistant message (ctx = input + cache writes + cache reads, ctxAt = its time), or
// a newer compact_boundary's postTokens (k12).
// User prompts: `prompts` counts them, `recent` keeps the last RECENT_PROMPTS (each at most RECENT_CHARS) for smart titles.
// Progress (k35, lib/progress.mjs): the newest `kadans progress` / TodoWrite / task-tool call of the main chain; a new user
// prompt clears it (new work). States cached before k35 have no `progress` and pick it up from the next new lines.
// state: { v, path, offset, done, curId, cur, model, firstPrompt, promptRaw, prompts, recent, customTitle, aiTitle, ctx, ctxAt, cache1h, progress, tasks, size, mtime }.
// A cached state from before the context fields gets them from the transcript tail once (no full rescan).
// Cache key: (path, size, mtime). A file that matches its cached size and mtime is not opened at all and `prev` itself is
// returned (same object); otherwise only the bytes after the cached offset are read.
export function scanTranscript(path, prev, chunk = 4 * 1024 * 1024) {
  const reuse = prev && prev.path === path && prev.v === SCAN_VERSION;
  let st = reuse ? { ...prev } : freshScan(path);
  let size;
  let mtime;
  try {
    const info = statSync(path);
    size = info.size;
    mtime = info.mtimeMs;
  } catch {
    return st;
  }
  if (reuse && prev.size === size && prev.mtime === mtime && 'ctx' in prev && size >= prev.offset) return prev; // cache hit: no read
  if (size < st.offset) st = freshScan(path);
  if (!('ctx' in st)) Object.assign(st, lastContext(path));
  Object.assign(st, { size, mtime });
  const fd = openSync(path, 'r');
  try {
    let pos = st.offset;
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(chunk, size - pos));
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const nl = data.lastIndexOf(0x0a);
      if (nl === -1) {
        carry = data;
        continue;
      }
      carry = data.subarray(nl + 1);
      for (const line of data.subarray(0, nl).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let d;
        try {
          d = JSON.parse(line);
        } catch {
          continue;
        }
        const p = promptText(d);
        if (p) {
          if (!st.promptRaw) {
            st.promptRaw = p;
            st.firstPrompt = clip(p);
          }
          st.prompts += 1;
          st.recent = [...st.recent, p.slice(0, RECENT_CHARS)].slice(-RECENT_PROMPTS);
          st.progress = null;
        }
        if (d.type === 'custom-title' && typeof d.customTitle === 'string') st.customTitle = d.customTitle.slice(0, 200);
        else if (d.type === 'ai-title' && typeof d.aiTitle === 'string') st.aiTitle = d.aiTitle.slice(0, 200);
        const b = contextOfBoundary(d);
        // a compact that finished after the newest assistant message: the context is what the compact left
        if (b && (st.ctxAt === null || b.ctxAt === null || b.ctxAt >= st.ctxAt)) Object.assign(st, { ctx: b.ctx, ctxAt: b.ctxAt });
        if (!d.isSidechain) progressFromLine(d, st);
        if (d.type !== 'assistant' || !d.message?.usage || d.isSidechain) continue;
        const id = d.message.id ?? d.requestId ?? d.uuid ?? null;
        const tok = usageTokens(d.message.usage);
        if (id !== null && id === st.curId) st.cur = tok;
        else {
          st.done += st.cur;
          st.curId = id;
          st.cur = tok;
        }
        if (d.message.model && d.message.model !== '<synthetic>') st.model = d.message.model;
        const c = contextOfLine(d);
        if (c) Object.assign(st, { ctx: c.ctx, ctxAt: c.ctxAt, cache1h: c.cache1h ?? st.cache1h ?? null });
      }
    }
    st.offset = pos - carry.length;
  } finally {
    closeSync(fd);
  }
  return st;
}

// Sub-agent transcripts (<transcript dir>/<sid>/subagents/agent-<id>.jsonl) are sidechain lines throughout. Their scan
// state keeps numbers and progress only (no prompt, no title): { v, path, offset, done, curId, cur, ctx, progress, tasks, size, mtime }. tokens =
// done + cur (input + output + cache writes, once per message id), ctx = the newest request's input + cache. Same cache
// key and incremental read as scanTranscript: a hit returns `prev` itself without opening the file.
export const SUB_SCAN_VERSION = 1;
const freshSubScan = (path) => ({ v: SUB_SCAN_VERSION, path, offset: 0, done: 0, curId: null, cur: 0, ctx: null, progress: null, tasks: [], size: 0, mtime: 0 });
export const SUBAGENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
export const subagentFile = (transcript, sid, agentId) =>
  transcript && SUBAGENT_ID.test(String(agentId ?? '')) && SUBAGENT_ID.test(String(sid ?? '')) ? join(dirname(transcript), sid, 'subagents', `agent-${agentId}.jsonl`) : null;

export function scanSubagent(path, prev, chunk = 4 * 1024 * 1024) {
  const reuse = prev && prev.path === path && prev.v === SUB_SCAN_VERSION;
  let st = reuse ? { ...prev } : freshSubScan(path);
  let size;
  let mtime;
  try {
    const info = statSync(path);
    size = info.size;
    mtime = info.mtimeMs;
  } catch {
    return reuse ? prev : null;
  }
  if (reuse && prev.size === size && prev.mtime === mtime && size >= prev.offset) return prev; // cache hit: no read
  if (size < st.offset) st = freshSubScan(path);
  Object.assign(st, { size, mtime });
  const fd = openSync(path, 'r');
  try {
    let pos = st.offset;
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(chunk, size - pos));
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const nl = data.lastIndexOf(0x0a);
      if (nl === -1) {
        carry = data;
        continue;
      }
      carry = data.subarray(nl + 1);
      for (const line of data.subarray(0, nl).toString('utf8').split('\n')) {
        if (!line.includes('"assistant"')) continue;
        let d;
        try {
          d = JSON.parse(line);
        } catch {
          continue;
        }
        progressFromLine(d, st);
        if (d?.type !== 'assistant' || !d.message?.usage || d.message.model === '<synthetic>') continue;
        const id = d.message.id ?? d.requestId ?? d.uuid ?? null;
        const tok = usageTokens(d.message.usage);
        if (id !== null && id === st.curId) st.cur = tok;
        else {
          st.done += st.cur;
          st.curId = id;
          st.cur = tok;
        }
        const ctx = contextTokens(d.message.usage);
        if (ctx > 0) st.ctx = ctx;
      }
    }
    st.offset = pos - carry.length;
  } finally {
    closeSync(fd);
  }
  return st;
}

export function readCache(home) {
  try {
    const v = JSON.parse(readFileSync(cacheFile(home), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeCache(home, cache) {
  withLock(home, () => {
    writeAtomic(cacheFile(home), `${JSON.stringify(cache)}\n`);
  });
}

// ---------- sessions ----------

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

// Name of the git root of cwd; a linked worktree reports its main repository's name.
export function projectName(cwd) {
  if (!cwd) return null;
  let dir = resolve(cwd);
  for (;;) {
    const g = join(dir, '.git');
    if (existsSync(g)) {
      try {
        if (statSync(g).isFile()) {
          const m = readFileSync(g, 'utf8').match(/gitdir:\s*(.+)/);
          const wt = m && m[1].trim().match(/^(.*)[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/);
          if (wt) return basename(wt[1]);
        }
      } catch {
        // fall through to the folder name
      }
      return basename(dir);
    }
    const up = dirname(dir);
    if (up === dir) return basename(resolve(cwd));
    dir = up;
  }
}

// Folds events and samples into one record per session id.
export function collectSessions(events, samples) {
  const map = new Map();
  const get = (sid) => {
    if (!map.has(sid)) {
      map.set(sid, { id: sid, cwd: null, transcript: null, startedAt: null, lastSeen: null, lastEventAt: null, pid: null, pidAt: null, account: null, modelId: null, firstPrompt: null, lastPrompt: null, turn: null, turnAt: null, stopAt: null, asked: false, needsAt: null, endedAt: null, subagents: new Map() });
    }
    return map.get(sid);
  };
  const touch = (s, t, cwd, transcript) => {
    s.startedAt = s.startedAt === null ? t : Math.min(s.startedAt, t);
    s.lastSeen = s.lastSeen === null ? t : Math.max(s.lastSeen, t);
    if (cwd) s.cwd = cwd;
    if (transcript) s.transcript = transcript;
  };
  for (const x of samples) {
    if (typeof x.session_id !== 'string' || !x.session_id) continue;
    const s = get(x.session_id);
    touch(s, x.t, x.cwd, x.transcript);
    if (x.account) s.account = x.account; // the account whose samples.jsonl recorded it
    if (typeof x.model === 'string' && x.model) s.modelId = x.model; // status line model id (may say "[1m]")
  }
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    const s = get(e.sid);
    touch(s, e.t, e.cwd, e.transcript);
    if (e.pid) Object.assign(s, { pid: e.pid, pidAt: e.t }); // pidAt: the pid was running this session then
    if (e.ev !== 'SessionEnd') {
      s.lastEventAt = e.t;
      if (s.endedAt !== null && e.ev === 'SessionStart') s.endedAt = null; // resumed
    }
    if (e.ev === 'UserPromptSubmit') {
      Object.assign(s, { turn: 'open', turnAt: e.t, asked: false, needsAt: null });
      if (e.prompt) {
        s.firstPrompt ??= e.prompt;
        s.lastPrompt = e.prompt;
      }
    } else if (e.ev === 'Stop') Object.assign(s, { turn: 'stopped', stopAt: e.t, asked: e.asked === true, needsAt: null });
    else if (e.ev === 'Notification') s.needsAt = e.t;
    else if (e.ev === 'SessionEnd') s.endedAt = e.t;
    else if (e.ev === 'SubagentStart' && e.agentId) s.subagents.set(e.agentId, { id: e.agentId, type: e.agentType ?? null, description: null, status: 'running' });
    else if (e.ev === 'SubagentStop' && e.agentId) {
      const a = s.subagents.get(e.agentId) ?? { id: e.agentId, type: e.agentType ?? null, description: null };
      s.subagents.set(e.agentId, { ...a, status: 'done' });
    }
  }
  return map;
}

// Status from hook events and samples; `activity` = latest transcript write, `alive(pid)` = process exists. `gone`: Claude
// Code's registry (usable) no longer lists the session: it is closed, unless a live pid or Orca terminal says otherwise.
// A reply that ended in a question (asked) means needs-you for ASKED_MS after the Stop, then idle.
export function sessionStatus(s, { now, activity = null, alive = () => true, orcaLive = false, gone = false }) {
  if (s.endedAt !== null && (s.lastEventAt === null || s.endedAt >= s.lastEventAt)) return 'ended';
  if (s.pid && !alive(s.pid)) return 'ended';
  if (gone && !orcaLive && !s.pid) return 'ended';
  const sign = Math.max(s.lastSeen ?? 0, activity ?? 0, orcaLive ? now : 0);
  // A recorded claude pid that still runs keeps a quiet session listed (idle), however long it is quiet.
  if (now - sign > ENDED_MS && !s.pid) return 'ended';
  if (s.needsAt !== null && !(activity !== null && activity > s.needsAt + 1000)) return 'needs-you';
  if (s.turn === 'open') return 'working';
  if (s.turn === 'stopped') {
    if (activity !== null && activity > s.stopAt + 2000 && now - activity <= WORKING_MS) return 'working'; // woke up without a prompt
    return s.asked && now - (s.stopAt ?? now) <= ASKED_MS ? 'needs-you' : 'idle';
  }
  return now - sign <= WORKING_MS ? 'working' : 'idle';
}

// When the hook-side status began (epoch ms), or null when unknown.
function hookSince(s, status, activity) {
  if (status === 'ended') return s.endedAt ?? null;
  if (status === 'needs-you') return s.needsAt ?? s.stopAt ?? null;
  if (status === 'working') return s.turn === 'open' ? s.turnAt ?? s.lastEventAt : activity ?? s.lastSeen;
  return s.stopAt ?? s.lastSeen ?? null;
}

// Status of a session with its Orca agent `o` (null when not hosted in Orca). For an Orca-hosted chat Orca's state is the
// source of truth, mapped by orcaStatus; the hook side only wins while its newest event is younger than Orca's last word
// on the agent (updatedAt: Orca sees the same hooks, so a state confirmed after the event already counts it; its
// stateStartedAt is the start of the state, which for a lead agent with sub-agents can be hours old), and even then
// without the asked-question rule: Orca decides when a chat needs you. A dead process or a SessionEnd still ends the row,
// and an Orca state Kadans cannot map leaves the hook rules in charge.
// Returns { status, stateSince (Orca's stateStartedAt when Orca decides), stateSource: 'orca' | 'hooks' }.
export function resolveStatus(s, o, { now, activity = null, alive = () => true, gone = false }) {
  const deps = { now, activity, alive, gone, orcaLive: Boolean(o) };
  const base = sessionStatus(s, deps);
  const hooks = (status) => ({ status, stateSince: hookSince(s, status, activity), stateSource: 'hooks' });
  if (!o || base === 'ended') return hooks(base);
  const os = orcaStatus(o.state);
  if (os === null) return hooks(base);
  const seen = o.updatedAt ?? o.stateStartedAt ?? null;
  if (seen !== null && (s.lastEventAt ?? 0) > seen) return hooks(sessionStatus({ ...s, asked: false }, deps));
  return { status: os, stateSince: o.stateStartedAt ?? o.updatedAt ?? null, stateSource: 'orca' };
}

// { subagents, subagentTokens }: each sub-agent with its lifetime tokens and newest context (numbers or null), and the
// sum of the known token counts (null when none is known).
function subagentRows(s, subScans, status) {
  let sum = null;
  const subagents = [...s.subagents.values()].map((a) => {
    const sc = subScans?.get(a.id) ?? null;
    const tokens = sc ? sc.done + sc.cur : null;
    if (tokens !== null) sum = (sum ?? 0) + tokens;
    return {
      ...a,
      description: subagentDescription(s.transcript, s.id, a.id),
      status: status === 'ended' && a.status === 'running' ? 'ended' : a.status,
      tokens,
      context: sc?.ctx ?? null,
      progress: sc?.progress ?? null,
    };
  });
  return { subagents, subagentTokens: sum };
}

function subagentDescription(transcript, sid, agentId) {
  if (!transcript || !SUBAGENT_ID.test(String(agentId ?? ''))) return null;
  try {
    const meta = JSON.parse(readFileSync(join(dirname(transcript), sid, 'subagents', `agent-${agentId}.meta.json`), 'utf8'));
    return clip(meta.description) ?? null;
  } catch {
    return null;
  }
}

// ---------- Orca ----------

// Absolute path of an executable on PATH, or null (lib/platform.mjs: PATHEXT and `;` on Windows).
export function onPath(name, pathVar = process.env.PATH ?? '') {
  return platformOnPath(name, pathVar);
}

// Runner for the `orca` CLI: (args) -> stdout; throws on failure. Tests inject a fake one.
export function orcaRunner(env = process.env, timeout = 5000) {
  if (env.KADANS_ORCA === '0') return null;
  timeout = Number(env.KADANS_ORCA_TIMEOUT_MS) || timeout; // tests on a loaded machine raise it
  const bin = findOrca(env);
  if (!bin) return null;
  return (args) => {
    const s = orcaSpawn(bin, args, { env }); // throws on an argument cmd.exe could misread (Windows .cmd only)
    const r = spawnSync(s.file, s.args, { ...s.opts, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`orca ${args.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim().slice(0, 200)}`);
    return r.stdout;
  };
}

// Orca's agent states (its sidebar) -> Kadans statuses. Orca: working | waiting (permission request or a question asked
// through the AskUserQuestion tool) | blocked | done | idle; `attention` is its sidebar group for the waiting ones. Anything
// else that reads like waiting for input is needs-you too; an unknown state gives no verdict (null: hook rules apply).
export const ORCA_STATUS = { working: 'working', waiting: 'needs-you', blocked: 'needs-you', attention: 'needs-you', done: 'idle', idle: 'idle' };
export const orcaStatus = (state) => ORCA_STATUS[state] ?? (/block|wait|permission|input|question|attention/i.test(String(state ?? '')) ? 'needs-you' : null);

const PS_ARGS = ['worktree', 'ps', '--json', '--limit', '1000'];
const TL_ARGS = ['terminal', 'list', '--json', '--limit', '1000'];

// Pane map: { t, panes: { "<tabId:leafId>": { handle, path } }, procs: { "<pid>:<start>": { paneKey, handle } } }. Ids and the
// worktree path only: no titles, no previews.
export function readPanes(home) {
  const empty = { t: 0, panes: {}, procs: {} };
  if (!home) return empty;
  try {
    const v = JSON.parse(readFileSync(panesFile(home), 'utf8'));
    const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
    return v && typeof v === 'object' ? { t: Number(v.t) || 0, panes: obj(v.panes), procs: obj(v.procs) } : empty;
  } catch {
    return empty;
  }
}

function writePanes(home, map) {
  if (!home) return;
  try {
    writeJsonAtomic(panesFile(home), map);
  } catch {
    // the map is only a speed-up
  }
}

function writeJsonAtomic(file, value) {
  writeAtomic(file, `${JSON.stringify(value)}\n`);
}

// Tab titles of one `orca terminal list` output, in memory only: Map of pane key and handle -> title (control characters
// stripped, at most 200 characters). Never written to the pane map or anywhere else; pickTitle cleans it further.
export function tabTitles(tl) {
  const out = new Map();
  for (const t of tl?.terminals ?? []) {
    if (typeof t?.title !== 'string') continue;
    const title = stripControl(t.title).slice(0, 200);
    if (t.tabId && t.leafId) out.set(`${t.tabId}:${t.leafId}`, title);
    if (typeof t.handle === 'string') out.set(t.handle, title);
  }
  return out;
}

// One `orca terminal list` -> the pane map's panes (handles only), written to $KADANS_HOME when a home is given; the tab
// titles of the same call come back in memory (`titles`), so a refresh never needs a second call for them.
function listPanes(run, home, now, map) {
  const tl = JSON.parse(run(TL_ARGS)).result;
  const panes = {};
  for (const t of tl?.terminals ?? []) {
    if (t?.tabId && t?.leafId && typeof t.handle === 'string') panes[`${t.tabId}:${t.leafId}`] = { handle: t.handle, path: typeof t.worktreePath === 'string' ? t.worktreePath : null };
  }
  const next = { ...map, t: now, panes };
  writePanes(home, next);
  return { map: next, titles: tabTitles(tl) };
}

// Live Claude agents in Orca: [{ paneKey, terminal, state, stateStartedAt, updatedAt, prompt, path, repo, worktree,
// title: null }]; null when Orca is absent, slow or fails. One `orca worktree ps` per refresh (or `psText`, its output
// fetched earlier by orcaFetch). Terminal handles come from the hosted claude processes (their environment names the
// pane and the terminal) and from the pane map; a pane with no handle from either triggers one `orca terminal list`, at
// most every PANES_REFRESH_MS. Only state fields, ids and the worktree path are kept: no prompt, preview, message, tool
// input or title text is stored.
export function readOrca(run, { home = null, hosted = [], now = Date.now(), psText = null } = {}) {
  if (!run && psText === null) return null;
  try {
    const ps = JSON.parse(psText ?? run(PS_ARGS)).result;
    const byPane = new Map();
    for (const h of hosted) if (h.paneKey && h.handle) byPane.set(h.paneKey, h.handle);
    let map = readPanes(home);
    let titles = null;
    const handleOf = (key) => byPane.get(key) ?? map.panes[key]?.handle ?? null;
    const out = [];
    for (const w of ps?.worktrees ?? []) {
      for (const a of w?.agents ?? []) {
        if (a?.agentType && a.agentType !== 'claude') continue;
        out.push({
          paneKey: a.paneKey ?? null,
          terminal: null,
          state: a.state ?? null,
          stateStartedAt: Number(a.stateStartedAt) || null,
          updatedAt: Number(a.updatedAt) || null,
          prompt: clip(a.prompt), // for pairing by prompt only; never stored
          path: w.path ?? null,
          repo: w.repo ?? null,
          worktree: w.displayName ?? null,
          title: null,
        });
      }
    }
    if (run && out.some((a) => a.paneKey && !handleOf(a.paneKey)) && now - map.t >= PANES_REFRESH_MS) {
      try {
        ({ map, titles } = listPanes(run, home, now, map));
      } catch {
        // no handles this refresh; the next one may try again after PANES_REFRESH_MS
      }
    }
    for (const a of out) {
      a.terminal = a.paneKey ? handleOf(a.paneKey) : null;
      a.path ??= map.panes[a.paneKey]?.path ?? null;
    }
    return { agents: out, truncated: Boolean(ps?.truncated), titles };
  } catch {
    return null;
  }
}

// Starts `orca worktree ps --json` in the background: returns a promise of its stdout, or null (absent, failed, or slower
// than ORCA_TIMEOUT_MS); never rejects. Lets the list do its own work while Orca answers.
export function orcaFetch(env = process.env, timeout = ORCA_TIMEOUT_MS) {
  if (env.KADANS_ORCA === '0') return Promise.resolve(null);
  timeout = Number(env.KADANS_ORCA_TIMEOUT_MS) || timeout;
  const bin = findOrca(env);
  if (!bin) return Promise.resolve(null);
  return new Promise((done) => {
    let out = '';
    let child;
    try {
      const s = orcaSpawn(bin, PS_ARGS, { env });
      child = spawn(s.file, s.args, { ...s.opts, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      done(null);
      return;
    }
    const timer = setTimeout(() => {
      done(null);
      killChild(child);
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('error', () => {
      clearTimeout(timer);
      done(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 ? out : null);
    });
  });
}

// ---------- process evidence ----------

// One live process, from `ps`: { start (epoch ms), comm, paneKey, handle } or null when the pid is gone. Orca puts
// ORCA_PANE_KEY and ORCA_TERMINAL_HANDLE into the environment of every shell it starts, and `claude` inherits them. Only those
// two values are read from the environment text; nothing else in it is kept or logged.
// `procs` (optional): { "<pid>:<start>": { paneKey, handle } }, the pane map's memory of claude processes already looked up;
// a process's environment never changes, so a known (pid, start) skips the second `ps` and a new one is added to `procs`.
// One pid per `ps` call on purpose: `ps -p a,b,c` walks the whole process table and costs ten times more.
export function realInspect(pid, procs = null) {
  const base = spawnSync('ps', ['-o', 'lstart=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
  const m = base.status === 0 ? base.stdout.trim().match(/^(\w{3} \w{3} +\d+ [\d:]{8} \d{4})\s+(.+)$/) : null;
  if (!m) return null;
  const start = Date.parse(m[1]);
  const comm = m[2].trim();
  if (basename(comm) !== 'claude') return { start, comm, paneKey: null, handle: null }; // not ours: no environment lookup
  const known = procs?.[`${pid}:${start}`];
  if (known) return { start, comm, paneKey: known.paneKey ?? null, handle: known.handle ?? null };
  const env = spawnSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, maxBuffer: 8 * 1024 * 1024 });
  const o = orcaEnv(env.status === 0 ? env.stdout : '');
  if (procs) procs[`${pid}:${start}`] = o;
  return { start, comm, ...o };
}

const orcaEnv = (text) => ({
  paneKey: text.match(/(?:^|\s)ORCA_PANE_KEY=([0-9A-Za-z-]+:[0-9A-Za-z-]+)/)?.[1] ?? null,
  handle: text.match(/(?:^|\s)ORCA_TERMINAL_HANDLE=(term_[0-9A-Za-z-]+)/)?.[1] ?? null,
});

// Claude Code's own registry of running sessions: <config dir>/sessions/<pid>.json. Only four fields are read from it: pid,
// sessionId, procStart (UTC) and kind. The sibling `<pid>.<id>.key` files hold peer tokens and are never opened (only
// names that are exactly <digits>.json are read), and no other field of the .json is used or kept.
// A file counts only while that pid is still a `claude` process that started when the file says (a reused pid fails the
// start-time check, with 2 s of slack). Returns
//   live:   Map(sessionId -> { pid, start }), any `kind`; the newest process wins when two claim one session
//   hosted: [{ pid, sessionId, start, paneKey, handle }], interactive ones that run inside an Orca pane / terminal
//   dirs:   [{ dir, usable }]; usable = the sessions/ folder holds at least one valid entry for a live claude process.
//           Only then does a session missing from `live` mean "closed" (an empty or absent registry proves nothing).
// `inspect(pid, procs)` is asked once per pid per call; `procs` is the pane map's process memory (see realInspect).
export function readRegistry(claudeDirs, inspect = realInspect, procs = null) {
  const memo = new Map();
  const look = (pid) => {
    if (!memo.has(pid)) memo.set(pid, inspect(pid, procs));
    return memo.get(pid);
  };
  const live = new Map();
  const hosted = [];
  const dirs = [];
  for (const d of claudeDirs) {
    let names;
    try {
      names = readdirSync(join(d, 'sessions'));
    } catch {
      dirs.push({ dir: d, usable: false });
      continue;
    }
    let valid = 0;
    for (const n of names) {
      if (!/^\d+\.json$/.test(n)) continue;
      let j;
      try {
        j = JSON.parse(readFileSync(join(d, 'sessions', n), 'utf8'));
      } catch {
        continue;
      }
      const pid = Number(n.slice(0, -5));
      if (j?.pid !== pid || typeof j.sessionId !== 'string' || !j.sessionId) continue;
      const born = Date.parse(`${j.procStart} UTC`);
      const p = Number.isFinite(born) ? look(pid) : null;
      if (!p || basename(p.comm) !== 'claude' || !Number.isFinite(p.start) || Math.abs(p.start - born) > 2000) continue;
      valid++;
      const had = live.get(j.sessionId);
      if (!had || p.start > had.start) live.set(j.sessionId, { pid, start: p.start });
      if ((j.kind === undefined || j.kind === 'interactive') && (p.paneKey || p.handle)) hosted.push({ pid, sessionId: j.sessionId, start: p.start, paneKey: p.paneKey, handle: p.handle });
    }
    dirs.push({ dir: d, usable: valid > 0 });
  }
  return { live, hosted, dirs };
}

// Live interactive `claude` processes inside Orca: [{ pid, sessionId, start, paneKey, handle }] (see readRegistry).
export function readHosted(claudeDirs, inspect = realInspect) {
  return readRegistry(claudeDirs, inspect).hosted;
}

// Whether the registry of the config dir that owns this transcript is usable (see readRegistry). A session without a
// transcript, or whose transcript is outside every config dir we read, gets no verdict: the old time rule applies.
export function registryCovers(dirs, transcript) {
  if (!transcript) return false;
  const t = [resolve(transcript), real(transcript)];
  const owner = dirs.find((x) => [resolve(x.dir), real(x.dir)].some((d) => t.some((p) => p.startsWith(join(d, 'projects') + sep))));
  return Boolean(owner?.usable);
}

// Pairs Orca agents with sessions. Hard evidence first (`hosted`, see readHosted): the claude process of a session lives in
// that Orca pane / terminal (its environment names it), whatever its folder. A pane with processes of two different sessions
// is not linked this way. A session claimed by two panes goes to the pane with the newest process; the other pane's row is
// kept, tagged sameSessionAs (a second process on the same session, not another agent). Then, in the same (real) folder:
// the session id in the terminal title or preview (`claude --resume <id>`), then the prompt. Without evidence a pair is made only when the folder has exactly one
// Orca Claude agent and one candidate session (active ones first; else the latest quiet one, i.e. no sign for 30 min but
// not closed). Everything else stays unpaired: a wrong pair would make `agent stop` close another agent's terminal.
// Returns Map(sessionId -> orca agent) and the unpaired agents (ambiguous = some session could have been it).
export function matchOrca(sessions, orcaAgents, quiet = [], hosted = []) {
  const bySession = new Map();
  const left = [];
  const known = new Set([...sessions, ...quiet].map((s) => s.id));
  const claims = new Map(); // session id -> [{ agent, start }]
  const linked = new Set();
  for (const a of orcaAgents) {
    const mine = hosted.filter((h) => (h.paneKey && a.paneKey ? h.paneKey === a.paneKey : Boolean(h.handle && a.terminal && h.handle === a.terminal)));
    const ids = new Set(mine.map((h) => h.sessionId));
    if (ids.size !== 1 || !known.has([...ids][0])) continue;
    const sid = [...ids][0];
    if (!claims.has(sid)) claims.set(sid, []);
    claims.get(sid).push({ agent: a, start: Math.max(...mine.map((h) => h.start)) });
  }
  for (const [sid, list] of claims) {
    list.sort((x, y) => y.start - x.start);
    if (list.length > 1 && list[0].start === list[1].start) continue; // cannot tell which one is the live process
    const handle = (a) => a.terminal ?? hosted.find((h) => h.sessionId === sid && h.paneKey && h.paneKey === a.paneKey && h.handle)?.handle ?? null;
    bySession.set(sid, { ...list[0].agent, terminal: handle(list[0].agent) }); // the process environment names the terminal too
    linked.add(list[0].agent);
    for (const c of list.slice(1)) {
      left.push({ ...c.agent, terminal: handle(c.agent), ambiguous: false, sameSessionAs: sid });
      linked.add(c.agent);
    }
  }
  const groups = new Map();
  for (const a of orcaAgents) {
    const root = a.path ? real(a.path) : null;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(a);
  }
  const free = (root, list) => list.filter((s) => !bySession.has(s.id) && s.cwd && root && real(s.cwd) === root);
  for (const [root, agents] of groups) {
    const rest = [];
    for (const a of agents) {
      if (linked.has(a)) continue;
      const pool = [...free(root, sessions), ...free(root, quiet)];
      let hit = a.text ? pool.filter((s) => a.text.includes(s.id)) : [];
      if (hit.length !== 1 && a.prompt) hit = pool.filter((s) => s.lastPrompt === a.prompt || s.firstPrompt === a.prompt);
      if (hit.length === 1) bySession.set(hit[0].id, a);
      else rest.push(a);
    }
    const active = free(root, sessions);
    const latestQuiet = free(root, quiet).sort((x, y) => (y.lastSeen ?? 0) - (x.lastSeen ?? 0)).slice(0, 1);
    const cands = active.length ? active : latestQuiet;
    // `agents` counts the pane-linked ones too: a leftover pair is a guess, and a linked neighbour in the folder voids it
    if (agents.length === 1 && rest.length === 1 && cands.length === 1) bySession.set(cands[0].id, rest[0]);
    else for (const a of rest) left.push({ ...a, ambiguous: active.length + latestQuiet.length > 0 });
  }
  return { bySession, left };
}

// ---------- the list ----------

function orcaField(a) {
  return a ? { terminal: a.terminal, worktree: a.worktree, repo: a.repo, state: a.state, title: a.title } : null;
}

// Claude Code keeps a session's transcript at <config dir>/projects/<cwd, every non-alphanumeric char as '-'>/<id>.jsonl.
export function guessTranscript(claudeDirs, cwd, sid) {
  if (!cwd) return null;
  for (const d of claudeDirs) {
    const f = join(d, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sid}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

// Phase one of the list, Kadans' own work (no Orca): registry, samples, events and the transcript scans. `scan: false`
// leaves the transcripts alone (cached scans only, activity from stat): what `agents --brief` needs.
export function prepareAgents(home, { now = Date.now(), alive = pidAlive, claudeDirs = [], inspect = realInspect, scan: doScan = true } = {}) {
  // The pane map remembers each claude process's pane and terminal (ids), so `ps eww` runs once per process, not per refresh.
  const map = inspect === realInspect ? readPanes(home) : null;
  const procs = map ? { ...map.procs } : null;
  const reg = readRegistry(claudeDirs, inspect, procs);
  if (procs) {
    const livePids = new Set([...reg.live.values()].map((x) => `${x.pid}:${x.start}`));
    const kept = Object.fromEntries(Object.entries(procs).filter(([k]) => livePids.has(k)));
    if (JSON.stringify(kept) !== JSON.stringify(map.procs)) writePanes(home, { ...map, procs: kept });
  }
  const samples = listAccounts(home).flatMap((k) => readSamples(home, k).map((x) => ({ ...x, account: k })));
  const sessions = collectSessions(readEvents(home, now), samples);
  const cache = readCache(home);
  const next = {};
  let dirty = false;
  const rows = [];
  const titler = titlerDir(home);
  for (const s of sessions.values()) {
    if (s.cwd && (resolve(s.cwd) === titler || resolve(s.cwd).startsWith(titler + sep))) continue; // Kadans' own titler run
    let activity = null;
    let scan = cache[s.id] ?? null;
    s.transcript ??= guessTranscript(claudeDirs, s.cwd, s.id);
    if (s.transcript) {
      try {
        activity = statSync(s.transcript).mtimeMs;
        if (doScan) {
          const before = scan;
          scan = scanTranscript(s.transcript, scan);
          if (scan !== before) dirty = true; // a cache hit returns the cached object itself
        }
      } catch {
        // transcript gone
      }
    }
    if (scan) next[s.id] = scan;
    // Sub-agent numbers: one stat per known sub-agent file, a read only when it grew (cache key `<sid>/<agentId>`).
    const subScans = new Map();
    for (const agentId of s.subagents.keys()) {
      const key = `${s.id}/${agentId}`;
      let sub = cache[key] ?? null;
      const file = subagentFile(s.transcript, s.id, agentId);
      if (doScan && file) {
        const before = sub;
        sub = scanSubagent(file, sub);
        if (sub !== before) dirty = true;
      }
      if (sub) {
        next[key] = sub;
        subScans.set(agentId, sub);
      }
    }
    s.firstPrompt ??= scan?.firstPrompt ?? null;
    // Registry: a listed session is alive and gets its pid when Kadans has none (or only a dead one); a live recorded pid is
    // never replaced. A session not listed, while the owning config dir's registry is usable, is closed (unless a live pid
    // or Orca terminal says otherwise, see sessionStatus). pidAt = the process start, so the reuse checks of stop/compact apply.
    const listed = reg.live.get(s.id) ?? null;
    if (listed && !(s.pid && alive(s.pid))) Object.assign(s, { pid: listed.pid, pidAt: listed.start });
    rows.push({ s, scan, subScans, activity, gone: !listed && registryCovers(reg.dirs, s.transcript) });
  }
  if (doScan && (dirty || Object.keys(next).length !== Object.keys(cache).length)) {
    try {
      writeCache(home, next);
    } catch {
      // the cache is only a speed-up
    }
  }
  return { home, now, alive, reg, rows, scanned: doScan };
}

// Orca tab titles for the rows that have no title from their owner or from Claude Code: the titles of this refresh's
// `orca terminal list` when it already ran, else one call now, only if such a row exists (never for `--brief`). In memory
// only. Returns a lookup (agent -> title or null).
function tabTitleLookup({ orca, run, need }) {
  if (!orca || !need) return () => null;
  let titles = orca.titles ?? null;
  if (!titles && run) {
    try {
      titles = tabTitles(JSON.parse(run(TL_ARGS)).result);
    } catch {
      titles = null;
    }
  }
  if (!titles) return () => null;
  return (a) => (a ? (a.paneKey && titles.get(a.paneKey)) || (a.terminal && titles.get(a.terminal)) || null : null);
}

// Phase two: pairs the rows with Orca's agents (`orca`: readOrca result or null), settles every status and builds the
// list. Writes the brief counts to $KADANS_HOME/agents-brief.json.
export function finishAgents({ home, now, alive, reg, rows, scanned = true }, { orca = null, all = false, hosted = null, run = null, brief = true } = {}) {
  const prelim = rows.map((r) => ({ ...r, status: sessionStatus(r.s, { now, activity: r.activity, alive, gone: r.gone }) }));
  const closed = (r) => r.s.endedAt !== null || r.gone || Boolean(r.s.pid && !alive(r.s.pid));
  const { bySession, left } = orca
    ? matchOrca(
        prelim.filter((r) => r.status !== 'ended').map((r) => r.s),
        orca.agents,
        prelim.filter((r) => r.status === 'ended' && !closed(r)).map((r) => r.s),
        hosted ?? reg.hosted,
      )
    : { bySession: new Map(), left: [] };
  const owned = readTitles(home);
  const hasOwnTitle = (id, scan) => Boolean((typeof owned[id] === 'string' && owned[id].trim()) || smartTitleOf(owned, id) || cleanTitle(scan?.customTitle ?? '') || cleanTitle(scan?.aiTitle ?? ''));
  const need = scanned && (left.length > 0 || rows.some(({ s, scan }) => bySession.has(s.id) && !hasOwnTitle(s.id, scan)));
  const tabOf = tabTitleLookup({ orca, run, need });
  const pace = readPace(home);
  const autopace = readRawConfig(home).autopace === true;
  const compactCfg = loadConfig(home).compact;
  const leanState = readLean(home);
  const stale = (status, lastSeen) => status === 'idle' && Number.isFinite(lastSeen) && now - lastSeen > STALE_MS;
  const out = [];
  const endedIds = new Set();
  for (const { s, scan, subScans, activity, gone } of rows) {
    const o = bySession.get(s.id) ?? null;
    const { status, stateSince, stateSource } = resolveStatus(s, o, { now, activity, alive, gone });
    if (status === 'ended') endedIds.add(s.id);
    if (status === 'ended' && !all) continue;
    const project = o?.repo ?? projectName(s.cwd);
    const lastSeen = Math.max(s.lastSeen ?? 0, activity ?? 0, o?.updatedAt ?? 0) || null;
    const idleMs = stateSource === 'orca' && stateSince ? Math.max(0, now - stateSince) : idleSince(s, scan, activity, now);
    out.push({
      id: s.id,
      source: 'claude',
      project,
      cwd: s.cwd,
      model: scan?.model ?? null,
      tokens: scan ? scan.done + scan.cur : null,
      context: contextOf({ tokens: scan?.ctx ?? null, model: s.modelId ?? scan?.model ?? null, status, idleMs, cache1h: scan?.cache1h }, compactCfg),
      startedAt: s.startedAt,
      lastSeen,
      status,
      stateSince,
      stateSource,
      stale: stale(status, lastSeen),
      account: s.account,
      pace: (({ mode, until }) => ({ mode, until }))(status === 'ended' ? paceOf({}, s.id, now) : paceOf(pace, s.id, now, autopace)),
      lean: leanOf(leanState, s.id), // lean-mode counters (lib/lean.mjs): { rereads, bigOutputs }
      progress: scan?.progress ?? null, // k35: { done, total, step } or null
      ...pickTitle({ id: s.id, owner: owned[s.id], smart: smartTitleOf(owned, s.id), scan, orca: o && !hasOwnTitle(s.id, scan) ? { ...o, title: tabOf(o) } : o, prompt: scan?.promptRaw ?? s.firstPrompt, project }),
      firstPrompt: s.firstPrompt,
      ...subagentRows(s, subScans, status),
      pid: s.pid,
      pidAt: s.pidAt,
      orca: orcaField(o),
    });
  }
  for (const a of left) {
    const id = `orca:${a.terminal ?? a.paneKey}`;
    const project = a.repo ?? projectName(a.path);
    const status = orcaStatus(a.state) ?? 'idle';
    out.push({
      id,
      source: 'orca',
      project,
      cwd: a.path,
      model: null,
      tokens: null,
      context: null,
      startedAt: null,
      lastSeen: a.updatedAt,
      status,
      stateSince: a.stateStartedAt ?? a.updatedAt ?? null,
      stateSource: 'orca',
      stale: stale(status, a.updatedAt),
      account: null,
      pace: { mode: 'none', until: null }, // no Claude session id here, so no Kadans hook can pace it
      ...pickTitle({ id, owner: owned[id], scan: null, orca: { ...a, title: scanned ? tabOf(a) : null }, prompt: a.prompt, project }),
      firstPrompt: a.prompt,
      subagents: [],
      subagentTokens: null,
      pid: null,
      orca: { ...orcaField(a), ambiguous: a.ambiguous === true },
      ...(a.sameSessionAs ? { sameSessionAs: a.sameSessionAs } : {}),
    });
  }
  out.sort((x, y) => STATUS_ORDER[x.status] - STATUS_ORDER[y.status] || (y.lastSeen ?? 0) - (x.lastSeen ?? 0));
  // The owner's order (k31): ordered rows first, the rest as sorted above; ended or vanished ids leave the stored order.
  const { list: ordered, gone: dropIds } = applyOrder(out, readOrder(home), { ended: endedIds, present: new Set(out.map((a) => a.id)), orcaRead: orca !== null });
  if (dropIds.length) {
    try {
      dropFromOrder(home, dropIds);
    } catch {
      // tried again on the next refresh
    }
  }
  out.splice(0, out.length, ...ordered);
  try {
    if (brief) writeJsonAtomic(briefFile(home), briefOf(out, now)); // brief false: a list without Orca (smart titles)
  } catch {
    // the brief file is only a speed-up
  }
  return out;
}

// Every session with its status, newest first. deps: { now, run (orca runner or null), alive, all, claudeDirs (to find
// transcripts of sessions that never reported one), hosted (readHosted result; default: read from claudeDirs), inspect
// (process lookup for the registry; asked once per pid), scan (false: no transcript reads) }. One registry read per call
// serves pane linking, pids and closed-session detection; one `orca worktree ps` per call (see readOrca).
export function listAgents(home, { run = null, all = false, hosted = null, trigger = null, brief = true, ...rest } = {}) {
  const ctx = prepareAgents(home, rest);
  const orca = readOrca(run, { home, hosted: hosted ?? ctx.reg.hosted, now: ctx.now });
  return afterList(finishAgents(ctx, { orca, all, hosted, run, brief }), trigger);
}

// trigger: optional fire-and-forget hook run after a full list (the CLI passes the smart-title trigger,
// lib/smart-titles.mjs). It never blocks or fails the list.
function afterList(list, trigger) {
  if (typeof trigger === 'function') {
    try {
      trigger(list);
    } catch {
      // best effort
    }
  }
  return list;
}

// The same list for the CLI: `orca worktree ps` runs in the background while Kadans does its own work, so a refresh costs
// about one orca call. A slow or missing orca (ORCA_TIMEOUT_MS) means the hook rules alone, as without Orca.
// k38 `remote`: agents of the paired Orca environments (other computers) after the local rows; off with config
// remoteAgents false. k48: `remote` is a refresh starter, (now) -> void (the CLI passes lib/remote.mjs triggerRemote, a
// detached `kadans remote refresh`); the rows come from its cache, so the listing never waits on another computer and
// shows the last good details while a fetch is in flight. Remote rows are never in the sync listAgents: stop / compact /
// send on a remote id go through lib/remote.mjs (a fresh lookup on that machine), never through a local row.
export async function listAgentsAsync(home, { env = process.env, timeout = ORCA_TIMEOUT_MS, run = null, all = false, hosted = null, trigger = null, remote = null, ...rest } = {}) {
  const pending = orcaFetch(env, timeout);
  const away = typeof remote === 'function' && loadConfig(home).remoteAgents !== false;
  if (away) {
    try {
      remote(rest.now ?? Date.now());
    } catch {
      // best effort: the cached rows still show
    }
  }
  const ctx = prepareAgents(home, rest);
  const psText = await pending;
  const orca = psText === null ? null : readOrca(run, { home, hosted: hosted ?? ctx.reg.hosted, now: ctx.now, psText });
  const list = finishAgents(ctx, { orca, all, hosted, run });
  if (away) list.push(...remoteRows(home, ctx.now));
  return afterList(list, trigger);
}

// Time since the session's last turn ended: the newest assistant message or Stop hook; the transcript write as a fallback.
// Status-line samples are not used: they keep coming while a chat sits idle.
function idleSince(s, scan, activity, now) {
  const end = Math.max(scan?.ctxAt ?? 0, s.stopAt ?? 0) || activity;
  return Number.isFinite(end) && end > 0 ? Math.max(0, now - end) : null;
}

// ---------- brief ----------

// Menu bar counts of a list: { working, needsYou, t }. Fixed shape (contract with the menu bar app). A second Orca terminal
// on a listed session (sameSessionAs) is the same agent and is not counted twice.
export function briefOf(list, now = Date.now()) {
  const rows = list.filter((a) => !a.sameSessionAs && !a.machine); // this computer's agents only
  return { working: rows.filter((a) => a.status === 'working').length, needsYou: rows.filter((a) => a.status === 'needs-you').length, t: now };
}

// The counts written by the latest full list, when at most BRIEF_FRESH_MS old; else null.
export function readBrief(home, now = Date.now(), freshMs = BRIEF_FRESH_MS) {
  try {
    const v = JSON.parse(readFileSync(briefFile(home), 'utf8'));
    if (!v || !Number.isInteger(v.working) || !Number.isInteger(v.needsYou) || typeof v.t !== 'number') return null;
    return now - v.t >= 0 && now - v.t <= freshMs ? { working: v.working, needsYou: v.needsYou, t: v.t } : null;
  } catch {
    return null;
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// ---------- stop ----------

// Exact id, or a unique prefix of at least 4 characters.
export function findAgent(agents, ref) {
  const r = String(ref ?? '').trim();
  const exact = agents.find((a) => a.id === r);
  if (exact) return { agent: exact };
  if (r.length < 4) return { why: `no agent with id ${r}` };
  const hits = agents.filter((a) => a.id.startsWith(r) || a.id.startsWith(`orca:${r}`));
  if (hits.length === 1) return { agent: hits[0] };
  return { why: hits.length ? `${hits.length} agents start with ${r}; give more of the id` : `no running agent with id ${r}` };
}

// Start time (epoch ms) of a live process, or null.
export function procStart(pid) {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
  const t = r.status === 0 ? Date.parse(r.stdout.trim()) : NaN;
  return Number.isFinite(t) ? t : null;
}
const START_SLACK_MS = 2000; // ps start times have 1 s resolution

// The recorded pid must still be a claude process that started before the event that recorded it (pidAt): a session
// that died without SessionEnd keeps its pid, and a later claude process (another session) may get the same pid.
// Returns null when fine, else the reason.
export function pidProblem(agent, ps = realPs, started = procStart) {
  const p = ps(agent.pid);
  if (!p || basename(p.comm) !== 'claude') return `pid ${agent.pid} is no longer a claude process`;
  const born = Number.isFinite(agent.pidAt) ? started(agent.pid) : null;
  if (Number.isFinite(born) && born > agent.pidAt + START_SLACK_MS) return `pid ${agent.pid} now belongs to a newer process (another session); this session has ended`;
  return null;
}

// Orca terminal -> `orca terminal close`; else SIGTERM to the recorded claude pid. Returns { ok, how } or { ok: false, why }.
// The pid must still be a claude process that started before the event that recorded it (pidAt): a session that died
// without SessionEnd keeps its pid, and a later claude process (another session) may get the same pid.
// dryRun: the same checks, nothing closed or killed (`how` says what would happen).
export function stopAgent(agent, { run = null, ps = realPs, started = procStart, kill = (pid, sig) => process.kill(pid, sig), dryRun = false } = {}) {
  if (agent.machine) return { ok: false, why: `runs on ${agent.machine}; Kadans acts only on this computer` };
  if (agent.orca?.terminal && !agent.orca.ambiguous) {
    if (!run) return { ok: false, why: 'agent runs in Orca but the orca CLI is not available' };
    if (dryRun) return { ok: true, how: `would close Orca terminal ${agent.orca.terminal}` };
    try {
      run(['terminal', 'close', '--terminal', agent.orca.terminal, '--json']);
      return { ok: true, how: `closed Orca terminal ${agent.orca.terminal}` };
    } catch (e) {
      return { ok: false, why: e.message };
    }
  }
  if (agent.orca?.ambiguous) return { ok: false, why: 'several Claude sessions share this Orca worktree; cannot tell which terminal is which' };
  if (agent.source === 'orca') return { ok: false, why: 'Orca reports no terminal handle for this agent' };
  if (!agent.pid) {
    return { ok: false, why: 'no pid recorded for this session (it started before `kadans install` added the session hooks) and no Orca terminal matched' };
  }
  const bad = pidProblem(agent, ps, started);
  if (bad) return { ok: false, why: bad };
  if (dryRun) return { ok: true, how: `would send SIGTERM to pid ${agent.pid}` };
  try {
    kill(agent.pid, 'SIGTERM');
    return { ok: true, how: `sent SIGTERM to pid ${agent.pid}` };
  } catch (e) {
    return { ok: false, why: `kill ${agent.pid}: ${e.code ?? e.message}` };
  }
}

// ---------- compact ----------

// Types /compact (plus Enter) into the session's Orca terminal: only for an idle Claude session with a known, unambiguous
// Orca terminal, and, when a pid is recorded, only while that pid is still this session's claude process. Never types
// into any other app. Draft guard: first reads that terminal's rendered screen (read-only) and refuses unless Claude Code's
// input line is clearly empty, so a half-typed message is never submitted with /compact; an unreadable screen refuses too.
// Returns { ok, how, argv } or { ok: false, why }. dryRun: the same checks, nothing read or sent (`how` names both calls).
export function compactAgent(agent, { run = null, ps = realPs, started = procStart, dryRun = false } = {}) {
  if (agent.machine) return { ok: false, why: `runs on ${agent.machine}; Kadans acts only on this computer` };
  const plan = compactPlan(agent);
  if (!plan.ok) return plan;
  if (!run) return { ok: false, why: 'agent runs in Orca but the orca CLI is not available; Type /compact in that chat' };
  if (agent.pid) {
    const bad = pidProblem(agent, ps, started);
    if (bad) return { ok: false, why: bad };
  }
  const argv = ['orca', ...plan.argv];
  const readArgv = ['orca', ...screenReadArgv(plan.terminal)];
  if (dryRun) return { ok: true, argv, readArgv, how: `would read the screen: ${JSON.stringify(readArgv)}, and only if the input line is empty run: ${JSON.stringify(argv)}` };
  let screen;
  try {
    screen = run(screenReadArgv(plan.terminal));
  } catch (e) {
    return { ok: false, why: `Could not read that chat's screen (${String(e.message).slice(0, 120)}): type /compact there yourself` };
  }
  const guard = draftGuard(screen);
  if (!guard.ok) return guard;
  try {
    run(plan.argv);
    return { ok: true, argv, how: `sent /compact to Orca terminal ${plan.terminal}` };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

// ---------- send (k48) ----------

// Types a message (already checked by lib/text.mjs messageText) plus Enter into this computer's Orca terminal of a Claude
// chat that is idle or working (k49: Claude Code queues what is typed while it works), after the send guard (the rendered
// screen must show an empty input line, so half-typed text is never submitted and a dialog on screen at the read is
// refused). Limit: the read and the send are two calls; a permission or question dialog that a WORKING chat opens between
// them gets the keystrokes (Enter picks its highlighted option). The text goes into orca's argv only: never logged, stored
// or returned; every refusal is a fixed sentence. Returns { ok, how } or { ok: false, why }.
export function sendAgent(agent, text, { run = null, ps = realPs, started = procStart, dryRun = false } = {}) {
  if (agent.machine) return { ok: false, why: `runs on ${agent.machine}; Kadans types there only through its remote id` };
  if (agent.status === 'needs-you') return { ok: false, why: 'it is waiting on a question or permission; answer it first' };
  if (agent.status === 'ended') return { ok: false, why: 'the session has ended' };
  if (agent.status !== 'idle' && agent.status !== 'working') return { ok: false, why: `status is ${agent.status}` };
  if (agent.orca?.ambiguous) return { ok: false, why: 'several Claude sessions share this Orca worktree; type it in that chat' };
  const terminal = agent.orca?.terminal;
  if (!terminal) return { ok: false, why: 'it does not run in an Orca terminal Kadans knows; type it in that chat' };
  if (!run) return { ok: false, why: 'the orca CLI is not available' };
  if (agent.pid) {
    const bad = pidProblem(agent, ps, started);
    if (bad) return { ok: false, why: bad };
  }
  if (dryRun) return { ok: true, how: `would read the screen of Orca terminal ${terminal}, and only if its input line is empty type the message` };
  let screen;
  try {
    screen = run(screenReadArgv(terminal));
  } catch {
    return { ok: false, why: SEND_REFUSAL.other };
  }
  const guard = sendGuard(screen); // local Orca rows are Claude Code only (non-Claude agents are never listed)
  if (!guard.ok) return guard;
  try {
    run(['terminal', 'send', '--terminal', terminal, '--text', text, '--enter']);
  } catch {
    return { ok: false, why: 'Orca did not take the message' }; // never e.message: orcaRunner's error repeats the argv
  }
  return { ok: true, how: `sent the message to Orca terminal ${terminal}` };
}

// ---------- text ----------

function age(ms) {
  if (ms === null || !Number.isFinite(ms)) return '-';
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${Math.floor(m / 1440)}d`;
}

function kTokens(n) {
  if (n === null || n === undefined) return '-';
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

const PACE_WORD = { slow: 'slowed', paused: 'paused' };
const ctxNote = (c) => (c && (c.advice === 'now' || c.advice === 'soon') ? `  (ctx ${kTokens(c.tokens)} · compact${c.advice === 'soon' ? ' soon' : ''})` : '');

// Text table. Agents idle for 2+ hours (stale) are left out and counted in a footer unless `all`.
export function renderAgents(list, now = Date.now(), { all = false } = {}) {
  const dup = (a) => Boolean(a.sameSessionAs); // second Orca terminal on a session that is listed on its own row
  const agents = (all ? list : list.filter((a) => !a.stale && !dup(a))).filter((a) => !a.machineOffline);
  const folded = all ? 0 : list.filter(dup).length;
  const hidden = all ? 0 : list.filter((a) => a.stale && !dup(a)).length;
  const foot = (hidden ? `${hidden} idle for 2+ hours not shown (--all lists them)\n` : '')
    + (folded ? `${folded} more Orca terminal${folded === 1 ? '' : 's'} on a session listed above not shown (--all lists them)\n` : '');
  if (agents.length === 0) return `no running agents\n${foot}`;
  const rows = agents.map((a) => [
    a.status === 'ended' ? 'ended' : PACE_WORD[a.pace?.mode] ?? a.status,
    a.project ?? '?',
    (a.model ?? '-').replace(/^claude-/, ''),
    kTokens(a.tokens),
    age(a.lastSeen ? now - a.lastSeen : null),
    a.subagents.filter((x) => x.status === 'running').length || '',
    a.machine ? a.id.slice(0, 7 + a.machine.length + 9) : a.source === 'orca' ? a.id.slice(0, 18) : a.id.slice(0, 8),
    (a.title ?? (a.firstPrompt ?? a.orca?.title ?? '').slice(0, 60)) + ctxNote(a.context),
  ].map((c) => stripControl(String(c))));
  const head = ['STATUS', 'PROJECT', 'MODEL', 'TOKENS', 'SEEN', 'SUB', 'ID', 'TITLE'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join('  ').trimEnd();
  return `${[head, ...rows].map(line).join('\n')}\n${foot}`;
}
