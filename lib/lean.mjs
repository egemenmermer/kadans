// Lean mode (config `lean`, default true): nudges that make Claude Code agents do the most work for the fewest tokens.
// Nudges only: these hooks never deny or block a tool. One `kadans hook lean` handles three events:
//   SessionStart        -> a short lean brief as additionalContext (not on resume: the transcript already has it)
//   PreToolUse Read     -> "already read, unchanged" when the same full file is read again unchanged
//   PostToolUse Bash|Read|Grep -> records Reads (path, size, mtime, full/range, time; never contents) and flags big output
// State: ~/.kadans/lean.json, bounded (sessions, files per session, age). `config set lean false` makes every call return
// '' without reading or writing lean.json.
import { readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { kadansHome } from './samples.mjs';
import { progressHint, progressProgram } from './progress.mjs';
import { withLock, writeAtomic } from './store.mjs';

export const BIG_CHARS = 15_000;
export const MAX_SESSIONS = 20;
export const MAX_FILES = 100; // per session (with 20 sessions lean.json stays ~200 KB: a few ms per hook call)
export const KEEP_MS = 24 * 3600_000; // a session untouched this long is dropped
export const BIG_TOOLS = ['Bash', 'Read', 'Grep'];
export const LEAN_PRE_MATCHER = 'Read';
export const LEAN_POST_MATCHER = BIG_TOOLS.join('|');

// k35: the last sentence asks for `kadans progress` (lib/progress.mjs), written the way this agent can run it.
export const briefText = (prog = 'kadans') =>
  'Kadans lean mode: most work, fewest tokens. Read only what you need (grep, line ranges); ' +
  'never re-read an unchanged file. Iterate on the touched test; full suite once. ' +
  `Pipe long output through tail or grep. Brief sub-agents with exact files. Keep replies short. ${progressHint(prog)}`;
export const BRIEF = briefText();

export const leanFile = (home) => join(home, 'lean.json');

// Lean is on unless config.json says "lean": false (missing or broken config = on).
export function leanOn(home) {
  try {
    return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))?.lean !== false;
  } catch {
    return true;
  }
}

export function readLean(home) {
  try {
    const v = JSON.parse(readFileSync(leanFile(home), 'utf8'));
    if (v && typeof v === 'object' && v.sessions && typeof v.sessions === 'object' && !Array.isArray(v.sessions)) return v;
  } catch {
    // missing or broken: start empty
  }
  return { sessions: {} };
}

// Counters of one session for `kadans agents --json`.
export function leanOf(state, sid) {
  const s = state?.sessions && Object.hasOwn(state.sessions, sid) ? state.sessions[sid] : null;
  return { rereads: Number(s?.rereads) || 0, bigOutputs: Number(s?.bigOutputs) || 0 };
}

// Drops old sessions, keeps the newest MAX_SESSIONS, and the newest MAX_FILES reads per session.
export function prune(state, now) {
  const all = Object.entries(state.sessions ?? {}).filter(([, s]) => s && typeof s === 'object' && now - (Number(s.at) || 0) <= KEEP_MS);
  all.sort((a, b) => b[1].at - a[1].at);
  const sessions = {};
  for (const [sid, s] of all.slice(0, MAX_SESSIONS)) {
    const reads = Object.entries(s.reads ?? {});
    if (reads.length > MAX_FILES) s.reads = Object.fromEntries(reads.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_FILES));
    sessions[sid] = s;
  }
  state.sessions = sessions;
  return state;
}

function update(home, now, fn) {
  return withLock(home, () => {
    const state = readLean(home);
    const out = fn(state);
    writeAtomic(leanFile(home), JSON.stringify(prune(state, now)));
    return out;
  });
}

function session(state, sid, now) {
  if (!Object.hasOwn(state.sessions, sid)) state.sessions[sid] = { at: now, rereads: 0, bigOutputs: 0, reads: {} };
  const s = state.sessions[sid];
  if (!s.reads || typeof s.reads !== 'object') s.reads = {};
  s.at = now;
  return s;
}

// A subagent has its own context: its reads are kept apart from the main agent's (counters stay per session).
const readKey = (input, path) => (input.agent_id ? `${input.agent_id}:${path}` : path);
const isRange = (ti) => ti?.offset != null || ti?.limit != null || ti?.pages != null;

function statOf(path) {
  try {
    const st = statSync(path);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

// Total characters of the strings in a tool result (bounded walk).
export function outputChars(v, depth = 0) {
  if (typeof v === 'string') return v.length;
  if (!v || typeof v !== 'object' || depth > 4) return 0;
  let n = 0;
  for (const x of Array.isArray(v) ? v : Object.values(v)) n += outputChars(x, depth + 1);
  return n;
}

// Pure: the re-read nudge text, or null. rec = what was recorded for this path, cur = its stat now.
export function rereadNudge(input, rec, cur, now) {
  if (isRange(input?.tool_input) || !rec?.full || !cur) return null;
  if (cur.size !== rec.size || cur.mtimeMs !== rec.mtimeMs) return null;
  const min = Math.max(0, Math.round((now - rec.at) / 60_000));
  return `Already read ${basename(input.tool_input.file_path)} ${min} min ago, unchanged: use it or read a range.`;
}

export function bigNudge(chars) {
  if (chars <= BIG_CHARS) return null;
  return `That output was large (~${Math.round(chars / 1000)}k chars): next time pipe through tail/grep or read a range.`;
}

const SID_RE = /^[A-Za-z0-9][\w-]{0,127}$/; // Claude session ids are UUIDs; anything else (__proto__ too) is ignored
const own = (o, k) => (o && Object.hasOwn(o, k) ? o[k] : undefined);
const out = (event, text) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

function onSessionStart(home, input, now, env) {
  const sid = input.session_id;
  // After a compact or clear the earlier reads are gone from the context: re-reading is right again.
  if ((input.source === 'compact' || input.source === 'clear') && own(readLean(home).sessions, sid)) {
    update(home, now, (st) => {
      session(st, sid, now).reads = {};
    });
  }
  return input.source === 'resume' ? '' : out('SessionStart', briefText(progressProgram(env?.PATH ?? '')));
}

function onPreRead(home, input, now) {
  const path = input.tool_input?.file_path;
  if (typeof path !== 'string' || !isAbsolute(path) || isRange(input.tool_input)) return '';
  const rec = own(own(readLean(home).sessions, input.session_id)?.reads, readKey(input, path));
  if (!rec?.full) return '';
  const text = rereadNudge(input, rec, statOf(path), now);
  if (!text) return '';
  update(home, now, (st) => {
    session(st, input.session_id, now).rereads += 1;
  });
  return out('PreToolUse', text);
}

function onPost(home, input, now) {
  const tool = input.tool_name;
  if (!BIG_TOOLS.includes(tool)) return '';
  const res = input.tool_response;
  // An image or PDF Read carries base64 that costs far fewer tokens than its length: only text output is measured.
  const measured = tool !== 'Read' || res?.type == null || res.type === 'text' || res.type === 'notebook';
  const text = measured ? bigNudge(outputChars(res)) : null;
  let rec = null;
  const path = input.tool_input?.file_path;
  // Claude Code answers an unchanged re-read with a short stub (type file_unchanged): keep the earlier record then.
  if (tool === 'Read' && typeof path === 'string' && isAbsolute(path) && res?.type !== 'file_unchanged') {
    const cur = statOf(path);
    const f = res?.file;
    const cut = Number.isFinite(f?.numLines) && Number.isFinite(f?.totalLines) && f.numLines < f.totalLines;
    if (cur) rec = { ...cur, full: !isRange(input.tool_input) && !cut, at: now };
  }
  if (!rec && !text) return '';
  update(home, now, (st) => {
    const s = session(st, input.session_id, now);
    if (rec) s.reads[readKey(input, path)] = rec;
    if (text) s.bigOutputs += 1;
  });
  return text ? out('PostToolUse', text) : '';
}

// Returns the stdout text for `kadans hook lean` ('' = nothing to say).
export function runLean(raw, env, { now = Date.now() } = {}) {
  const input = JSON.parse(raw);
  const sid = input?.session_id;
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return '';
  const home = kadansHome(env);
  if (!leanOn(home)) return '';
  const ev = input.hook_event_name;
  if (ev === 'SessionStart') return onSessionStart(home, input, now, env);
  if (ev === 'PreToolUse' && input.tool_name === 'Read') return onPreRead(home, input, now);
  if (ev === 'PostToolUse') return onPost(home, input, now);
  return '';
}
