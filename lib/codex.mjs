// Codex CLI limits, read-only from Codex's own session logs ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl).
// Codex writes a `token_count` event after each model turn whose payload carries `rate_limits`
// ({ limit_id, primary: { used_percent, window_minutes, resets_at }, secondary, plan_type, ... }).
//
// PRIVACY RULES (also in SECURITY.md):
// - Only regular files named rollout-*.jsonl under $CODEX_HOME/sessions are opened (symlinks are skipped). Nothing else
//   in $CODEX_HOME is read (never auth.json), and nothing is ever written there.
// - A line is parsed only if it contains "rate_limits"; every other line (prompts, replies, tool output) is skipped
//   unparsed. From a parsed line only the timestamp and the numbers of rate_limits (plus a short plan word) are kept.
// - Samples get no session id, folder or transcript path, so nothing else in Kadans opens a rollout.
// - The cache ($KADANS_HOME/codex-cache.json) holds file paths, sizes, times and byte offsets only.
// - Kadans shows the Codex account but never acts on it (no brake, feed, slow, gas or kickoff): see actionable().
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KEEP_MS, accountKey, appendSamplesLocked, readSamples } from './samples.mjs';
import { withLock, writeAtomic } from './store.mjs';

export const SOURCE = 'codex';
export const NAME = 'Codex';
export const NEEDLE = '"rate_limits"';
export const MAX_READ = 4 * 1024 * 1024; // per file and sync: only the last 4 MB of new bytes are read
export const MAX_FILES = 40; // newest rollout files looked at per sync
export const LOCK_WAIT_MS = 1500; // a busy store skips the sync, it never holds up `status`
const DEDUPE_MS = 5 * 60_000; // an unchanged reading is kept at most every 5 minutes
const DAY = 24 * 3600 * 1000;
const ROLLOUT_RE = /^rollout-[\w.:-]+\.jsonl$/;

export function codexHome(env = process.env) {
  return env.CODEX_HOME || join(env.HOME || homedir(), '.codex');
}

// A key of its own: never the same as a Claude config dir's key.
export function codexKey(env = process.env) {
  return accountKey(`codex:${codexHome(env)}`);
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Config `codex` (default true), and only when Codex's sessions folder exists.
export function codexEnabled(cfg, env = process.env) {
  return cfg?.codex !== false && isDir(join(codexHome(env), 'sessions'));
}

export function isCodexSamples(samples) {
  return samples.length > 0 && samples[samples.length - 1].source === SOURCE;
}

// 300 -> five_hour, 10080 -> seven_day, any other window -> window_<minutes>.
export function limitName(minutes) {
  if (minutes === 300) return 'five_hour';
  if (minutes === 10080) return 'seven_day';
  return `window_${minutes}`;
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// One rollout line -> a sample, or null. Lines without "rate_limits" are never parsed.
export function sampleFromLine(line) {
  if (typeof line !== 'string' || !line.includes(NEEDLE)) return null;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null; // never rethrown: a SyntaxError message quotes the input
  }
  if (!o || typeof o !== 'object' || o.type !== 'event_msg' || o.payload?.type !== 'token_count') return null;
  const rl = o.payload.rate_limits;
  if (!rl || typeof rl !== 'object' || Array.isArray(rl)) return null;
  if (rl.limit_id != null && rl.limit_id !== 'codex') return null; // another limit family: not mixed into this account
  const t = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  if (!Number.isFinite(t)) return null;
  const limits = {};
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || typeof w !== 'object') continue;
    const { used_percent: pct, window_minutes: min, resets_at: r } = w;
    if (!finite(pct) || !Number.isInteger(min) || min <= 0 || min > 1_000_000 || !finite(r) || r <= 0) continue;
    limits[limitName(min)] = { pct: Math.max(0, Math.min(100, pct)), resetsAt: r < 1e11 ? r * 1000 : r };
  }
  if (Object.keys(limits).length === 0) return null;
  const plan = typeof rl.plan_type === 'string' && /^[a-z_]{1,20}$/.test(rl.plan_type) ? rl.plan_type : null;
  return { t, session_id: null, cwd: null, transcript: null, source: SOURCE, ...(plan ? { plan } : {}), limits };
}

function subdirs(dir, re) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && re.test(d.name)) // a symlink is not a directory here: skipped
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

// Rollout files of the newest day folders (back to KEEP_MS, always at least the newest day), newest change first.
export function listRollouts(sessions, now = Date.now()) {
  const days = [];
  outer: for (const y of subdirs(sessions, /^\d{4}$/)) {
    for (const m of subdirs(join(sessions, y), /^\d{2}$/)) {
      for (const d of subdirs(join(sessions, y, m), /^\d{2}$/)) {
        if (days.length && Date.UTC(Number(y), Number(m) - 1, Number(d)) < now - KEEP_MS - DAY) break outer;
        days.push(join(sessions, y, m, d));
      }
    }
  }
  const files = [];
  for (const day of days) {
    let ents = [];
    try {
      ents = readdirSync(day, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (!e.isFile() || !ROLLOUT_RE.test(e.name)) continue; // symlinks and other files are never opened
      const path = join(day, e.name);
      try {
        const st = statSync(path);
        files.push({ path, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // gone meanwhile
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES);
}

const cacheFile = (home) => join(home, 'codex-cache.json');

// { key, lastT, files: { path: { size, mtimeMs, off } } }: numbers and paths only.
export function readCache(home) {
  try {
    const v = JSON.parse(readFileSync(cacheFile(home), 'utf8'));
    if (v && typeof v === 'object' && v.files && typeof v.files === 'object') return v;
  } catch {
    // missing or broken: start over
  }
  return { key: null, lastT: 0, files: {} };
}

function writeCache(home, c) {
  const files = {};
  for (const [p, f] of Object.entries(c.files)) files[p] = { size: Number(f.size) || 0, mtimeMs: Number(f.mtimeMs) || 0, off: Number(f.off) || 0 };
  writeAtomic(cacheFile(home), `${JSON.stringify({ key: c.key, lastT: Number(c.lastT) || 0, files })}\n`);
}

const unchanged = (f, c) => c && c.size === f.size && c.mtimeMs === f.mtimeMs;

// Reads the new complete lines of one file: [start, size), at most the last MAX_READ bytes. Returns { lines, off }.
function readNew(path, start, size) {
  const from = Math.max(start, size - MAX_READ);
  const len = size - from;
  if (len <= 0) return { lines: [], off: size };
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  let got = 0;
  try {
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, from + got);
      if (n <= 0) break;
      got += n;
    }
  } finally {
    closeSync(fd);
  }
  const end = buf.lastIndexOf(0x0a, got - 1); // a line still being written waits for the next sync
  if (end < 0) return { lines: [], off: from };
  let text = buf.toString('utf8', 0, end);
  if (from > start) text = text.slice(text.indexOf('\n') + 1); // started mid-line: drop the partial first line
  return { lines: text.split('\n'), off: from + end + 1 };
}

const sameLimits = (a, b) => JSON.stringify(a.limits) === JSON.stringify(b.limits);

// One sync. Returns { ok, code, key, added, changed, sample? } and never throws.
// deps: { cfg, now, lockWaitMs }.
export function syncCodex(home, env = process.env, deps = {}) {
  const now = deps.now ?? Date.now();
  const key = codexKey(env);
  try {
    if (!codexEnabled(deps.cfg ?? {}, env)) return { ok: false, code: deps.cfg?.codex === false ? 'off' : 'no_codex', key, added: 0 };
    const sessions = join(codexHome(env), 'sessions');
    const files = listRollouts(sessions, now);
    const peek = readCache(home);
    const sameKey = peek.key === key;
    const todo = files.filter((f) => !sameKey || !unchanged(f, peek.files[f.path]));
    if (todo.length === 0) return { ok: true, code: 'unchanged', key, added: 0, sample: last(home, key) };
    return withLock(home, () => {
      let cache = readCache(home);
      if (cache.key !== key) cache = { key, lastT: 0, files: {} }; // another CODEX_HOME: start over
      if (!cache.lastT) cache.lastT = readSamples(home, key).reduce((m, s) => Math.max(m, s.t), 0);
      const fresh = [];
      const seen = {};
      for (const f of files) {
        const c = cache.files[f.path];
        if (unchanged(f, c)) {
          seen[f.path] = c;
          continue;
        }
        const known = c && f.size >= c.off; // grown (or touched); a shrunk file is read again
        const { lines, off } = readNew(f.path, known ? c.off : 0, f.size);
        for (const line of lines) {
          const s = sampleFromLine(line);
          // A file read for the first time may repeat readings already stored: only newer ones count.
          if (s && s.t >= now - KEEP_MS && s.t <= now + 60_000 && (known || s.t > cache.lastT)) fresh.push(s);
        }
        seen[f.path] = { size: f.size, mtimeMs: f.mtimeMs, off };
      }
      fresh.sort((a, b) => a.t - b.t);
      const keep = [];
      for (const s of fresh) {
        const prev = keep[keep.length - 1];
        if (prev && sameLimits(prev, s) && s.t - prev.t < DEDUPE_MS) continue;
        keep.push(s);
      }
      appendSamplesLocked(home, key, keep, now);
      cache.files = seen;
      if (keep.length) cache.lastT = Math.max(cache.lastT, keep[keep.length - 1].t);
      writeCache(home, cache);
      return { ok: true, code: keep.length ? 'updated' : 'unchanged', key, added: keep.length, sample: last(home, key) };
    }, { waitMs: deps.lockWaitMs ?? LOCK_WAIT_MS });
  } catch (e) {
    return { ok: false, code: e?.message === 'kadans: lock timeout' ? 'busy' : 'read_failed', key, added: 0 };
  }
}

function last(home, key) {
  const s = readSamples(home, key);
  return s.length ? s[s.length - 1] : null;
}

const LABEL = { five_hour: '5-hour', seven_day: '7-day' };
function label(n) {
  if (LABEL[n]) return LABEL[n];
  const m = n.match(/^window_(\d+)$/);
  if (!m) return n;
  const min = Number(m[1]);
  return min % 1440 === 0 ? `${min / 1440}-day` : `${Math.round(min / 60)}-hour`;
}

// Percentages only.
export function renderSync(r) {
  if (!r.ok) return `codex: ${r.code === 'off' ? 'off (kadans config set codex true)' : r.code === 'no_codex' ? 'no Codex sessions folder' : r.code}`;
  if (!r.sample) return 'codex: no readings yet';
  const parts = Object.entries(r.sample.limits).map(([n, l]) => `${label(n)} ${Math.round(l.pct)} %`);
  return `codex: ${parts.join(', ')}${r.added ? ` (${r.added} new)` : ''}`;
}

export function syncJson(r) {
  const out = { ok: r.ok, code: r.code, key: r.key, added: r.added };
  if (r.sample) {
    out.t = r.sample.t;
    if (r.sample.plan) out.plan = r.sample.plan;
    out.limits = {};
    for (const [n, l] of Object.entries(r.sample.limits)) out.limits[n] = { pct: l.pct, resetsAt: l.resetsAt };
  }
  return out;
}
