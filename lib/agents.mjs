// Running Claude Code agents on this Mac: sessions from status-line samples and a small hook event log, tokens and model
// from each session's transcript, plus Orca's live agent terminals when the `orca` CLI is around.
// Event log: $KADANS_HOME/events/YYYY-MM-DD.jsonl (UTC day), append-only under the store lock; files older than 2 days
// are deleted. Transcript scan state: $KADANS_HOME/agents-cache.json (byte offset per session).
import { spawnSync } from 'node:child_process';
import { accessSync, appendFileSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { listAccounts, readSamples } from './samples.mjs';
import { withLock } from './store.mjs';
import { pickTitle, readTitles } from './titles.mjs';
import { paceOf, readPace, readRawConfig } from './pace-control.mjs';

export const EVENT_KEEP_MS = 2 * 24 * 3600 * 1000;
export const WORKING_MS = 2 * 60_000;
export const ENDED_MS = 30 * 60_000;
export const PROMPT_CHARS = 120;
export const PROMPT_RAW_CHARS = 2000;
export const STALE_MS = 2 * 3600_000; // idle this long: left out of the default list
export const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd', 'Notification'];
const NEEDS_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog']);
const STATUS_ORDER = { 'needs-you': 0, working: 1, idle: 2, ended: 3 };

const eventsDir = (home) => join(home, 'events');
const cacheFile = (home) => join(home, 'agents-cache.json');
const day = (t) => new Date(t).toISOString().slice(0, 10);
const clip = (s) => (typeof s === 'string' && s.trim() ? s.trim().replace(/\s+/g, ' ').slice(0, PROMPT_CHARS) : null);

// ---------- event log ----------

export function appendEvent(home, ev, now = Date.now()) {
  withLock(home, () => {
    const dir = eventsDir(home);
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (m && m[1] < day(now - EVENT_KEEP_MS)) rmSync(join(dir, f), { force: true }); // whole days past the 2-day window
    }
    appendFileSync(join(dir, `${day(now)}.jsonl`), `${JSON.stringify(ev)}\n`);
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

// The user's typed prompt (raw, up to PROMPT_RAW_CHARS), or null for commands, reminders and tool results.
function promptText(d) {
  if (d.type !== 'user' || d.isMeta || d.isSidechain || d.message?.role !== 'user') return null;
  const c = d.message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b?.type === 'text')?.text ?? null) : null;
  if (!text || !text.trim() || text.trimStart().startsWith('<')) return null;
  return text.slice(0, PROMPT_RAW_CHARS);
}

// Bump when the scan state gains fields: older cached states are rescanned from the start.
export const SCAN_VERSION = 2;
const freshScan = (path) => ({ v: SCAN_VERSION, path, offset: 0, done: 0, curId: null, cur: 0, model: null, firstPrompt: null, promptRaw: null, customTitle: null, aiTitle: null });

// Reads the transcript from the saved offset. One assistant message is written as several lines (one per content block)
// that repeat the same usage: they are counted once per message id, the last line of a message wins.
// Session titles: the last `custom-title` (/rename) and the last `ai-title` (Claude Code's own) entry.
// state: { v, path, offset, done, curId, cur, model, firstPrompt, promptRaw, customTitle, aiTitle } -> new state.
export function scanTranscript(path, prev, chunk = 4 * 1024 * 1024) {
  let st = prev && prev.path === path && prev.v === SCAN_VERSION ? { ...prev } : freshScan(path);
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return st;
  }
  if (size < st.offset) st = freshScan(path);
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
        if (!st.promptRaw) {
          st.promptRaw = promptText(d);
          st.firstPrompt = clip(st.promptRaw);
        }
        if (d.type === 'custom-title' && typeof d.customTitle === 'string') st.customTitle = d.customTitle.slice(0, 200);
        else if (d.type === 'ai-title' && typeof d.aiTitle === 'string') st.aiTitle = d.aiTitle.slice(0, 200);
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
      }
    }
    st.offset = pos - carry.length;
  } finally {
    closeSync(fd);
  }
  return st;
}

function readCache(home) {
  try {
    const v = JSON.parse(readFileSync(cacheFile(home), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeCache(home, cache) {
  withLock(home, () => {
    const tmp = `${cacheFile(home)}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(cache)}\n`);
    renameSync(tmp, cacheFile(home));
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
      map.set(sid, { id: sid, cwd: null, transcript: null, startedAt: null, lastSeen: null, lastEventAt: null, pid: null, pidAt: null, account: null, firstPrompt: null, lastPrompt: null, turn: null, stopAt: null, asked: false, needsAt: null, endedAt: null, subagents: new Map() });
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
      Object.assign(s, { turn: 'open', asked: false, needsAt: null });
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

// Status from what we know; `activity` = latest transcript write, `alive(pid)` = process exists.
export function sessionStatus(s, { now, activity = null, alive = () => true, orcaLive = false }) {
  if (s.endedAt !== null && (s.lastEventAt === null || s.endedAt >= s.lastEventAt)) return 'ended';
  if (s.pid && !alive(s.pid)) return 'ended';
  const sign = Math.max(s.lastSeen ?? 0, activity ?? 0, orcaLive ? now : 0);
  // A recorded claude pid that still runs keeps a quiet session listed (idle), however long it is quiet.
  if (now - sign > ENDED_MS && !s.pid) return 'ended';
  if (s.needsAt !== null && !(activity !== null && activity > s.needsAt + 1000)) return 'needs-you';
  if (s.turn === 'open') return 'working';
  if (s.turn === 'stopped') {
    if (activity !== null && activity > s.stopAt + 2000 && now - activity <= WORKING_MS) return 'working'; // woke up without a prompt
    return s.asked ? 'needs-you' : 'idle';
  }
  return now - sign <= WORKING_MS ? 'working' : 'idle';
}

function subagentDescription(transcript, sid, agentId) {
  if (!transcript) return null;
  try {
    const meta = JSON.parse(readFileSync(join(dirname(transcript), sid, 'subagents', `agent-${agentId}.meta.json`), 'utf8'));
    return clip(meta.description) ?? null;
  } catch {
    return null;
  }
}

// ---------- Orca ----------

// Absolute path of an executable on PATH, or null.
export function onPath(name, pathVar = process.env.PATH ?? '') {
  for (const d of pathVar.split(delimiter)) {
    if (!d) continue;
    const f = join(d, name);
    try {
      accessSync(f, constants.X_OK);
      return f;
    } catch {
      // next
    }
  }
  return null;
}

// Runner for the `orca` CLI: (args) -> stdout; throws on failure. Tests inject a fake one.
export function orcaRunner(env = process.env, timeout = 5000) {
  if (env.KADANS_ORCA === '0') return null;
  const bin = env.KADANS_ORCA_BIN || onPath('orca', env.PATH);
  if (!bin) return null;
  return (args) => {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`orca ${args.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim().slice(0, 200)}`);
    return r.stdout;
  };
}

const ORCA_STATUS = { working: 'working', done: 'idle', idle: 'idle' };
const orcaStatus = (state) => ORCA_STATUS[state] ?? (/block|wait|permission|input|question/i.test(String(state ?? '')) ? 'needs-you' : null);

// Live Claude agents in Orca: [{ paneKey, terminal, state, prompt, path, repo, worktree, title, updatedAt }]; null when Orca
// is absent or fails.
export function readOrca(run) {
  if (!run) return null;
  try {
    const ps = JSON.parse(run(['worktree', 'ps', '--json', '--limit', '1000'])).result;
    const tl = JSON.parse(run(['terminal', 'list', '--json', '--limit', '1000'])).result;
    const terms = new Map();
    for (const t of tl?.terminals ?? []) if (t?.tabId && t?.leafId) terms.set(`${t.tabId}:${t.leafId}`, t);
    const out = [];
    for (const w of ps?.worktrees ?? []) {
      for (const a of w?.agents ?? []) {
        if (a?.agentType && a.agentType !== 'claude') continue;
        const t = terms.get(a.paneKey) ?? null;
        out.push({
          paneKey: a.paneKey ?? null,
          terminal: t?.handle ?? null,
          state: a.state ?? null,
          prompt: clip(a.prompt),
          path: w.path ?? t?.worktreePath ?? null,
          repo: w.repo ?? null,
          worktree: w.displayName ?? null,
          title: t?.title ?? null,
          text: [t?.title, t?.preview, w.preview].filter((x) => typeof x === 'string').join('\n'), // for matching only
          updatedAt: Number(a.updatedAt) || null,
        });
      }
    }
    return { agents: out, truncated: Boolean(ps?.truncated || tl?.truncated) };
  } catch {
    return null;
  }
}

// ---------- process evidence ----------

// One live process, from `ps`: { start (epoch ms), comm, paneKey, handle } or null when the pid is gone. Orca puts
// ORCA_PANE_KEY and ORCA_TERMINAL_HANDLE into the environment of every shell it starts, and `claude` inherits them. Only those
// two values are read from the environment text; nothing else in it is kept or logged.
export function realInspect(pid) {
  const base = spawnSync('ps', ['-o', 'lstart=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
  const m = base.status === 0 ? base.stdout.trim().match(/^(\w{3} \w{3} +\d+ [\d:]{8} \d{4})\s+(.+)$/) : null;
  if (!m) return null;
  const env = spawnSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, maxBuffer: 8 * 1024 * 1024 });
  const text = env.status === 0 ? env.stdout : '';
  return {
    start: Date.parse(m[1]),
    comm: m[2].trim(),
    paneKey: text.match(/(?:^|\s)ORCA_PANE_KEY=([0-9A-Za-z-]+:[0-9A-Za-z-]+)/)?.[1] ?? null,
    handle: text.match(/(?:^|\s)ORCA_TERMINAL_HANDLE=(term_[0-9A-Za-z-]+)/)?.[1] ?? null,
  };
}

// Live interactive `claude` processes with their session id: [{ pid, sessionId, start, paneKey, handle }]. Claude Code writes
// <config dir>/sessions/<pid>.json (pid, sessionId, procStart in UTC, kind). A file counts only while that pid is still a
// `claude` process that started when the file says (a reused pid fails the start-time check, with 2 s of slack).
export function readHosted(claudeDirs, inspect = realInspect) {
  const out = [];
  for (const d of claudeDirs) {
    let names;
    try {
      names = readdirSync(join(d, 'sessions'));
    } catch {
      continue;
    }
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
      if (j.kind !== undefined && j.kind !== 'interactive') continue;
      const born = Date.parse(`${j.procStart} UTC`);
      const p = Number.isFinite(born) ? inspect(pid) : null;
      if (!p || basename(p.comm) !== 'claude' || !Number.isFinite(p.start) || Math.abs(p.start - born) > 2000) continue;
      if (p.paneKey || p.handle) out.push({ pid, sessionId: j.sessionId, start: p.start, paneKey: p.paneKey, handle: p.handle });
    }
  }
  return out;
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
    bySession.set(sid, list[0].agent);
    linked.add(list[0].agent);
    for (const c of list.slice(1)) {
      left.push({ ...c.agent, ambiguous: false, sameSessionAs: sid });
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

// Every session with its status, newest first. deps: { now, run (orca runner or null), alive, all, claudeDirs (to find
// transcripts of sessions that never reported one), hosted (readHosted result; default: read from claudeDirs) }.
export function listAgents(home, { now = Date.now(), run = null, alive = pidAlive, all = false, claudeDirs = [], hosted = null } = {}) {
  const samples = listAccounts(home).flatMap((k) => readSamples(home, k).map((x) => ({ ...x, account: k })));
  const sessions = collectSessions(readEvents(home, now), samples);
  const cache = readCache(home);
  const next = {};
  let dirty = false;
  const rows = [];
  for (const s of sessions.values()) {
    let activity = null;
    let scan = cache[s.id] ?? null;
    s.transcript ??= guessTranscript(claudeDirs, s.cwd, s.id);
    if (s.transcript) {
      try {
        activity = statSync(s.transcript).mtimeMs;
        const before = scan?.offset;
        scan = scanTranscript(s.transcript, scan);
        if (scan.offset !== before) dirty = true;
      } catch {
        // transcript gone
      }
    }
    if (scan) next[s.id] = scan;
    s.firstPrompt ??= scan?.firstPrompt ?? null;
    rows.push({ s, scan, activity });
  }
  if (dirty || Object.keys(next).length !== Object.keys(cache).length) {
    try {
      writeCache(home, next);
    } catch {
      // the cache is only a speed-up
    }
  }
  const orca = readOrca(run);
  const prelim = rows.map((r) => ({ ...r, status: sessionStatus(r.s, { now, activity: r.activity, alive }) }));
  const closed = (s) => s.endedAt !== null || Boolean(s.pid && !alive(s.pid));
  const { bySession, left } = orca
    ? matchOrca(
        prelim.filter((r) => r.status !== 'ended').map((r) => r.s),
        orca.agents,
        prelim.filter((r) => r.status === 'ended' && !closed(r.s)).map((r) => r.s),
        hosted ?? readHosted(claudeDirs),
      )
    : { bySession: new Map(), left: [] };
  const owned = readTitles(home);
  const pace = readPace(home);
  const autopace = readRawConfig(home).autopace === true;
  const stale = (status, lastSeen) => status === 'idle' && Number.isFinite(lastSeen) && now - lastSeen > STALE_MS;
  const out = [];
  for (const { s, scan, activity } of rows) {
    const o = bySession.get(s.id) ?? null;
    let status = sessionStatus(s, { now, activity, alive, orcaLive: Boolean(o) });
    if (o && status !== 'ended') {
      const os = orcaStatus(o.state);
      if (os === 'needs-you' || status === 'needs-you') status = 'needs-you';
      else if (os) status = os;
    }
    if (status === 'ended' && !all) continue;
    const project = o?.repo ?? projectName(s.cwd);
    const lastSeen = Math.max(s.lastSeen ?? 0, activity ?? 0) || null;
    out.push({
      id: s.id,
      source: 'claude',
      project,
      cwd: s.cwd,
      model: scan?.model ?? null,
      tokens: scan ? scan.done + scan.cur : null,
      startedAt: s.startedAt,
      lastSeen,
      status,
      stale: stale(status, lastSeen),
      account: s.account,
      pace: (({ mode, until }) => ({ mode, until }))(status === 'ended' ? paceOf({}, s.id, now) : paceOf(pace, s.id, now, autopace)),
      ...pickTitle({ id: s.id, owner: owned[s.id], scan, orca: o, prompt: scan?.promptRaw ?? s.firstPrompt, project }),
      firstPrompt: s.firstPrompt,
      subagents: [...s.subagents.values()].map((a) => ({
        ...a,
        description: subagentDescription(s.transcript, s.id, a.id),
        status: status === 'ended' && a.status === 'running' ? 'ended' : a.status,
      })),
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
      startedAt: null,
      lastSeen: a.updatedAt,
      status,
      stale: stale(status, a.updatedAt),
      account: null,
      pace: { mode: 'none', until: null }, // no Claude session id here, so no Kadans hook can pace it
      ...pickTitle({ id, owner: owned[id], scan: null, orca: a, prompt: a.prompt, project }),
      firstPrompt: a.prompt,
      subagents: [],
      pid: null,
      orca: { ...orcaField(a), ambiguous: a.ambiguous === true },
      ...(a.sameSessionAs ? { sameSessionAs: a.sameSessionAs } : {}),
    });
  }
  return out.sort((x, y) => STATUS_ORDER[x.status] - STATUS_ORDER[y.status] || (y.lastSeen ?? 0) - (x.lastSeen ?? 0));
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

// Orca terminal -> `orca terminal close`; else SIGTERM to the recorded claude pid. Returns { ok, how } or { ok: false, why }.
// The pid must still be a claude process that started before the event that recorded it (pidAt): a session that died
// without SessionEnd keeps its pid, and a later claude process (another session) may get the same pid.
// dryRun: the same checks, nothing closed or killed (`how` says what would happen).
export function stopAgent(agent, { run = null, ps = realPs, started = procStart, kill = (pid, sig) => process.kill(pid, sig), dryRun = false } = {}) {
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
  const p = ps(agent.pid);
  if (!p || basename(p.comm) !== 'claude') return { ok: false, why: `pid ${agent.pid} is no longer a claude process` };
  const born = Number.isFinite(agent.pidAt) ? started(agent.pid) : null;
  if (Number.isFinite(born) && born > agent.pidAt + START_SLACK_MS) {
    return { ok: false, why: `pid ${agent.pid} now belongs to a newer process (another session); this session has ended` };
  }
  if (dryRun) return { ok: true, how: `would send SIGTERM to pid ${agent.pid}` };
  try {
    kill(agent.pid, 'SIGTERM');
    return { ok: true, how: `sent SIGTERM to pid ${agent.pid}` };
  } catch (e) {
    return { ok: false, why: `kill ${agent.pid}: ${e.code ?? e.message}` };
  }
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

// Text table. Agents idle for 2+ hours (stale) are left out and counted in a footer unless `all`.
export function renderAgents(list, now = Date.now(), { all = false } = {}) {
  const dup = (a) => Boolean(a.sameSessionAs); // second Orca terminal on a session that is listed on its own row
  const agents = all ? list : list.filter((a) => !a.stale && !dup(a));
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
    a.source === 'orca' ? a.id.slice(0, 18) : a.id.slice(0, 8),
    a.title ?? (a.firstPrompt ?? a.orca?.title ?? '').slice(0, 60),
  ].map(String));
  const head = ['STATUS', 'PROJECT', 'MODEL', 'TOKENS', 'SEEN', 'SUB', 'ID', 'TITLE'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join('  ').trimEnd();
  return `${[head, ...rows].map(line).join('\n')}\n${foot}`;
}
