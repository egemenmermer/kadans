// k59: the usage line for other local apps, one tiny file: $KADANS_HOME/usage-line.json, mode 0600, written atomically
// (temp file + rename in the same dir) and only when pct (integer), limit, state, resetsAt or runsOutAt changed.
// `at` alone never triggers a write. Own account only; nothing about other accounts, titles, prompts or agents.
// It reuses the result the status line / status --json already computed: no extra sample reads, no timer, no spawn.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIN } from './pace.mjs';
import { ensureHome, writeAtomic } from './store.mjs';

export const USAGE_LINE_FILE = 'usage-line.json';
const KEYS = ['v', 'pct', 'limit', 'state', 'resetsAt', 'runsOutAt', 'at'];
const COMPARED = ['pct', 'limit', 'state', 'resetsAt', 'runsOutAt'];
const SHORT = { five_hour: '5h', seven_day: '7d' };
const STATES = new Set(['brake', 'cruise', 'gas']);
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// res = overall(...) of the own account's samples: { state, limit, limits: [limitState...] }, or null when there is no data.
// Returns the 7-key object, or null when no 5h / 7d limit is known at all (then nothing is published).
export function buildUsageLine(res, now) {
  const limits = Array.isArray(res?.limits) ? res.limits.filter((l) => SHORT[l?.name] && fin(l.pct) !== null) : [];
  const chosen = limits.find((l) => l.name === res?.limit) ?? limits.find((l) => l.name === 'five_hour') ?? limits[0];
  if (!chosen) return null;
  const pct = Math.min(100, Math.max(0, Math.round(chosen.pct)));
  // 'early' (on course to run out, brake not fired yet) and 'nodata' are not contract states: early reads as cruise.
  const state = chosen.ended ? 'unknown' : res.state === 'early' ? 'cruise' : STATES.has(res.state) ? res.state : 'unknown';
  // Run-out: when the pace reaches 100 %, to the whole minute so ordinary needle jitter does not rewrite the file.
  let runsOutAt = null;
  if (state !== 'unknown' && pct < 100 && fin(chosen.rate) > 0 && fin(chosen.projection) >= 100) {
    runsOutAt = Math.round((now + ((100 - chosen.pct) / chosen.rate) * MIN) / MIN) * MIN;
  }
  return { v: 1, pct, limit: SHORT[chosen.name], state, resetsAt: fin(chosen.resetsAt), runsOutAt, at: now };
}

function readLine(file) {
  try {
    const o = JSON.parse(readFileSync(file, 'utf8'));
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

// Writes the line when it differs from the file in a compared field. Never throws; returns true when it wrote.
export function writeUsageLine(home, res, now = Date.now()) {
  try {
    const line = buildUsageLine(res, now);
    if (!line) return false;
    const file = join(home, USAGE_LINE_FILE);
    const old = readLine(file);
    if (old && KEYS.every((k) => k in old) && COMPARED.every((k) => old[k] === line[k])) return false;
    ensureHome(home);
    writeAtomic(file, `${JSON.stringify(line)}\n`);
    return true;
  } catch {
    return false; // publishing must never break the status line or the tick
  }
}
