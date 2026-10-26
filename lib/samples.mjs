// Sample store: one JSONL file per account under $KADANS_HOME/accounts/<key>/samples.jsonl.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withLock } from './store.mjs';

export const KEEP_MS = 8 * 24 * 3600 * 1000;
export const LIMIT_NAMES = ['five_hour', 'seven_day'];

export function kadansHome(env = process.env) {
  return env.KADANS_HOME || join(homedir(), '.kadans');
}

// Same directory string and hash as ~/.claude/usage-guard/statusline.sh (printf '%s' "$dir" | shasum | cut -c1-12).
export function configDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function accountKey(dir) {
  return createHash('sha1').update(dir).digest('hex').slice(0, 12);
}

// resets_at may be unix seconds, unix milliseconds or an ISO string; stored as epoch milliseconds.
function toMs(v) {
  if (typeof v === 'string') {
    const d = Date.parse(v);
    return Number.isNaN(d) ? null : d;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  return null;
}

// Returns null when the payload carries no usable rate_limits (e.g. before the first response).
export function sampleFromPayload(payload, now = Date.now()) {
  const rl = payload && typeof payload === 'object' ? payload.rate_limits : null;
  if (!rl || typeof rl !== 'object') return null;
  const limits = {};
  for (const name of LIMIT_NAMES) {
    const l = rl[name];
    if (!l || typeof l.used_percentage !== 'number' || !Number.isFinite(l.used_percentage)) continue;
    const resetsAt = toMs(l.resets_at);
    if (resetsAt === null) continue;
    limits[name] = { pct: l.used_percentage, resetsAt };
  }
  if (Object.keys(limits).length === 0) return null;
  return {
    t: now,
    session_id: payload.session_id ?? null,
    cwd: payload.cwd ?? payload.workspace?.current_dir ?? null,
    transcript: payload.transcript_path ?? null, // lib/agents.mjs reads tokens and model from it
    limits,
  };
}

function accountDir(home, key) {
  return join(home, 'accounts', key);
}

function parseLine(line) {
  if (!line.trim()) return null;
  try {
    const s = JSON.parse(line);
    return s && typeof s.t === 'number' && s.limits && typeof s.limits === 'object' ? s : null;
  } catch {
    return null;
  }
}

// Appends one sample as a single write, under the shared store lock. Drops lines older than KEEP_MS
// (rewritten via temp file + rename).
export function appendSample(home, key, sample, now = Date.now()) {
  withLock(home, () => appendLocked(home, key, sample, now));
}

function appendLocked(home, key, sample, now) {
  const dir = accountDir(home, key);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'samples.jsonl');
  if (existsSync(file)) {
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    const cutoff = now - KEEP_MS;
    const kept = lines.filter((l) => {
      const s = parseLine(l);
      return s !== null && s.t >= cutoff;
    });
    if (kept.length !== lines.length) {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, kept.map((l) => `${l}\n`).join(''));
      renameSync(tmp, file);
    }
  }
  appendFileSync(file, `${JSON.stringify(sample)}\n`);
}

export function readSamples(home, key) {
  const file = join(accountDir(home, key), 'samples.jsonl');
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const s = parseLine(line);
    if (s) out.push(s);
  }
  return out.sort((a, b) => a.t - b.t);
}

export function listAccounts(home) {
  const root = join(home, 'accounts');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => {
    try {
      return statSync(join(root, name)).isDirectory();
    } catch {
      return false;
    }
  }).sort();
}
