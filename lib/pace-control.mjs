// Pace control: slow, pause and nudge Claude Code sessions, by the owner or by auto-pace.
// State: $KADANS_HOME/pace.json = { "<session id>": { mode: "slow"|"paused", until: ms|null, by: "owner"|"auto", at: ms },
// "_auto": { state, windowId, brakeSince, lastStep }, "_nudged": { "<session id>": ms } }. Keys starting with "_" are ours.
// Hooks: `hook pace-pre` (PreToolUse, matcher "*") sleeps or halts; `hook pace-post` (PostToolUse) nudges.
// Fast path: with no entry for the session and autopace off, only pace.json and config.json are read.
// Any error in a runner is caught by bin/kadans.mjs: exit 0, no output (fail open).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withLock, writeAtomic as writeText } from './store.mjs';
import { accountKey, configDir, kadansHome } from './samples.mjs';

const MIN = 60_000;
export const SLOW_DEFAULT_S = 20;
export const SLOW_MAX_S = 40;
export const NUDGE_EVERY_MS = 10 * MIN; // at most one nudge per session per 10 minutes
export const AUTO_SLOW_AFTER_MS = 10 * MIN; // brake must hold this long before auto-pace slows sessions
export const AUTO_SLOW_TTL_MS = 15 * MIN; // auto entries expire unless a step renews them (never stuck slowed)
export const STEP_MS = 60_000; // the gauge is recomputed at most once a minute
export const WINDOW_TOLERANCE = 60_000; // resets_at within a minute = same window
const HOOK_LOCK = { waitMs: 2000 }; // hooks never wait long for the store lock
const LIMIT_NAME = { five_hour: '5-hour', seven_day: '7-day' };

// CLI word -> stored mode. The CLI says "pause", storage and the agents JSON say "paused".
export const MODE_OF = { slow: 'slow', pause: 'paused', paused: 'paused', none: 'none' };

export const paceFile = (home) => join(home, 'pace.json');

function readJson(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export const readPace = (home) => readJson(paceFile(home));
// Raw config (no normalising): the hot path only needs autopace and pace.slowSeconds.
export const readRawConfig = (home) => readJson(join(home, 'config.json'));

function writeAtomic(file, obj) {
  writeText(file, `${JSON.stringify(obj, null, 2)}\n`);
}

// Runs fn(pace) under the store lock and saves the (mutated) state; drops expired entries and old nudge stamps.
export function updatePace(home, fn, { now = Date.now(), lock = {} } = {}) {
  return withLock(
    home,
    () => {
      const pace = readPace(home);
      const out = fn(pace);
      for (const [k, v] of Object.entries(pace)) if (!k.startsWith('_') && !activeEntry(pace, k, now)) delete pace[k];
      if (pace._nudged) for (const [k, t] of Object.entries(pace._nudged)) if (!(now - t < 24 * 60 * MIN)) delete pace._nudged[k];
      writeAtomic(paceFile(home), pace);
      return out;
    },
    lock,
  );
}

// The session's entry if it is valid and not expired, else null (expired entries count as none).
export function activeEntry(pace, sid, now) {
  if (!sid || String(sid).startsWith('_')) return null;
  const e = pace?.[sid];
  if (!e || typeof e !== 'object') return null;
  if (e.mode !== 'slow' && e.mode !== 'paused') return null;
  if (e.until !== null && e.until !== undefined && !(Number(e.until) > now)) return null;
  return e;
}

// What the agents list shows: { mode: none|slow|paused, until, by }.
export function paceOf(pace, sid, now, autopace = true) {
  const e = activeEntry(pace, sid, now);
  if (!e || (e.by === 'auto' && !autopace)) return { mode: 'none', until: null, by: null };
  return { mode: e.mode, until: Number.isFinite(Number(e.until)) && e.until !== null ? Number(e.until) : null, by: e.by ?? 'owner' };
}

export function slowSeconds(cfg) {
  const s = Number(cfg?.pace?.slowSeconds);
  if (!Number.isFinite(s) || s <= 0) return SLOW_DEFAULT_S;
  return Math.min(SLOW_MAX_S, Math.max(1, s));
}

export const ownKey = () => accountKey(join(homedir(), '.claude'));
const sameWindow = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= WINDOW_TOLERANCE;

function hhmm(t) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------- pure decisions ----------

// Earliest reset among the applicable limits = the window id.
export function windowOf(ov) {
  const r = (ov?.limits ?? []).map((v) => v.resetsAt).filter(Number.isFinite);
  return r.length ? Math.min(...r) : null;
}

// One auto-pace step from the gauge: new auto state, and whether to lift or renew the auto entries.
export function autoStep(auto, ov, now) {
  const state = ov?.state ?? 'unknown';
  const windowId = windowOf(ov);
  const newWindow = Number.isFinite(auto?.windowId) && Number.isFinite(windowId) && !sameWindow(auto.windowId, windowId);
  const lift = newWindow || state === 'cruise' || state === 'gas';
  const brakeSince = state === 'brake' ? (!newWindow && Number.isFinite(auto?.brakeSince) ? auto.brakeSince : now) : null;
  return {
    auto: { state, limit: ov?.limit ?? null, windowId: windowId ?? auto?.windowId ?? null, brakeSince, lastStep: now },
    lift,
    renew: state === 'brake',
  };
}

// Applies a step to the pace state: lift drops every auto entry; renew pushes their `until` out again.
export function applyStep(pace, step, now) {
  pace._auto = step.auto;
  for (const [k, e] of Object.entries(pace)) {
    if (k.startsWith('_') || e?.by !== 'auto') continue;
    if (step.lift) delete pace[k];
    else if (step.renew && e.mode === 'slow') e.until = now + AUTO_SLOW_TTL_MS;
  }
}

// Auto-pace slows a session once brake held 10 minutes, unless it has an entry or works on an urgent task.
export function shouldAutoSlow({ auto, entry, urgent, now }) {
  return auto?.state === 'brake' && Number.isFinite(auto.brakeSince) && now - auto.brakeSince >= AUTO_SLOW_AFTER_MS && !entry && !urgent;
}

export function shouldNudge({ auto, nudgedAt, now }) {
  return (auto?.state === 'brake' || auto?.state === 'early') && !(Number.isFinite(nudgedAt) && now - nudgedAt < NUDGE_EVERY_MS);
}

export function nudgeText(auto) {
  const lim = LIMIT_NAME[auto?.limit] ?? 'usage';
  const reset = Number.isFinite(auto?.windowId) ? ` (resets ${hhmm(auto.windowId)})` : '';
  return (
    `Kadans: usage is running hot; at this pace the ${lim} limit runs out before the reset${reset}. ` +
    'Finish the current step, do not start subagents or workflows, and read less: grep before reading, read only the lines you need.'
  );
}

export function pauseReason(entry, sid) {
  const till = Number.isFinite(entry.until) ? ` until ${hhmm(entry.until)}` : '';
  if (entry.by === 'auto') return `Paused by Kadans${till}. Type to resume.`;
  return `Paused by Kadans${till}. Resume it in Kadans or run \`kadans agent pace ${String(sid).slice(0, 8)} none\`.`;
}

// PreToolUse output for a pause: halt the session; the deny is a backstop in case `continue` is ignored.
export function pauseOutput(entry, sid) {
  const reason = pauseReason(entry, sid);
  return {
    continue: false,
    stopReason: reason,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  };
}

// ---------- runners (IO) ----------

function isOwn(env, deps) {
  return accountKey(configDir(env)) === (deps.ownKey ?? ownKey());
}

// Recomputes the gauge at most once a minute (only when autopace is on) and saves the step.
async function ensureAuto(home, pace, env, now, deps) {
  const auto = pace._auto ?? {};
  if (Number.isFinite(auto.lastStep) && now - auto.lastStep < STEP_MS && now >= auto.lastStep) return auto;
  const { overall, loadConfig } = await import('./pace.mjs');
  const { actionable, readSamples } = await import('./samples.mjs');
  const ov = deps.ov ?? overall(actionable(readSamples(home, accountKey(configDir(env)))), now, loadConfig(home)); // never Codex readings
  const step = autoStep(auto, ov, now);
  try {
    updatePace(home, (p) => applyStep(p, step, now), { now, lock: HOOK_LOCK });
  } catch {
    // a lost write only delays the next step
  }
  applyStep(pace, step, now);
  return step.auto;
}

async function urgentClaim(home, sid) {
  const { readTasks } = await import('./store.mjs');
  const { allowedWhileBraking } = await import('./pick.mjs');
  return readTasks(home).some((t) => t.claimedBy === sid && t.status === 'running' && allowedWhileBraking(t));
}

const defaultSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// PreToolUse. Returns stdout text ('' = no opinion). deps: { now, sleep, ownKey, ov }.
export async function runPacePre(raw, env, deps = {}) {
  const now = deps.now ?? Date.now();
  const input = JSON.parse(raw);
  const sid = input?.session_id;
  if (typeof sid !== 'string' || !sid || sid.startsWith('_')) return '';
  const home = kadansHome(env);
  const pace = readPace(home);
  const cfg = readRawConfig(home);
  const autopace = cfg.autopace === true;
  let entry = activeEntry(pace, sid, now);
  if (entry?.by === 'auto' && !autopace) entry = null;
  if (!entry && !autopace) return ''; // fast path
  if (!isOwn(env, deps)) return ''; // never act on another account
  if (autopace) {
    const auto = await ensureAuto(home, pace, env, now, deps);
    entry = activeEntry(pace, sid, now);
    if (shouldAutoSlow({ auto, entry, urgent: false, now }) && !(await urgentClaim(home, sid))) {
      const e = { mode: 'slow', until: now + AUTO_SLOW_TTL_MS, by: 'auto', at: now };
      try {
        updatePace(home, (p) => { if (!activeEntry(p, sid, now)) p[sid] = e; }, { now, lock: HOOK_LOCK });
      } catch {
        // still slow this call
      }
      entry = e;
    }
  }
  if (!entry) return '';
  if (entry.mode === 'paused') return JSON.stringify(pauseOutput(entry, sid));
  (deps.sleep ?? defaultSleep)(slowSeconds(cfg) * 1000); // outside the lock: the status line needs it
  return '';
}

// PostToolUse: one short nudge per session per 10 minutes while the gauge says brake or early (autopace on only).
export async function runPacePost(raw, env, deps = {}) {
  const now = deps.now ?? Date.now();
  const input = JSON.parse(raw);
  const sid = input?.session_id;
  if (typeof sid !== 'string' || !sid || sid.startsWith('_')) return '';
  const home = kadansHome(env);
  const pace = readPace(home);
  if (readRawConfig(home).autopace !== true) return ''; // fast path
  if (!isOwn(env, deps)) return '';
  const auto = await ensureAuto(home, pace, env, now, deps);
  if (!shouldNudge({ auto, nudgedAt: Number(pace._nudged?.[sid]), now })) return '';
  const fresh = updatePace(
    home,
    (p) => {
      p._nudged ??= {};
      if (!shouldNudge({ auto, nudgedAt: Number(p._nudged[sid]), now })) return false;
      p._nudged[sid] = now;
      return true;
    },
    { now, lock: HOOK_LOCK },
  );
  if (!fresh) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudgeText(auto) } });
}

// UserPromptSubmit (called from `hook event`): the owner typed, so a pause set by auto is lifted. Owner pauses stay.
export function clearAutoPause(raw, env, { now = Date.now() } = {}) {
  const input = JSON.parse(raw);
  if (input?.hook_event_name !== 'UserPromptSubmit') return false;
  const sid = input.session_id;
  const home = kadansHome(env);
  const e = activeEntry(readPace(home), sid, now);
  if (!e || e.by !== 'auto' || e.mode !== 'paused') return false;
  return updatePace(
    home,
    (p) => {
      const x = activeEntry(p, sid, now);
      if (!x || x.by !== 'auto' || x.mode !== 'paused') return false;
      delete p[sid];
      return true;
    },
    { now, lock: HOOK_LOCK },
  );
}

// ---------- owner commands ----------

// "30m", "2h", "90" (minutes) -> ms from now; "reset" -> resetAt; else throws.
export function parseUntil(v, now, resetAt) {
  if (v === undefined || v === null || v === true || v === 'reset') return Number.isFinite(resetAt) ? resetAt : null;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|h)?$/);
  if (!m) throw new Error(`--until must be reset, <n>m or <n>h: ${v}`);
  const n = Number(m[1]) * (m[2] === 'h' ? 60 * MIN : MIN);
  if (!(n > 0) || n > 7 * 24 * 60 * MIN) throw new Error(`--until out of range: ${v}`);
  return now + n;
}

// Owner sets or clears the pace of one session. mode: slow | pause | none.
export function setPace(home, sid, mode, { until = null, now = Date.now() } = {}) {
  const m = MODE_OF[mode];
  if (!m || mode === 'paused') throw new Error(`mode must be slow, pause or none: ${mode}`);
  if (!sid || String(sid).startsWith('_')) throw new Error('bad session id');
  return updatePace(
    home,
    (p) => {
      if (m === 'none') {
        delete p[sid];
        return null;
      }
      p[sid] = { mode: m, until, by: 'owner', at: now };
      return p[sid];
    },
    { now },
  );
}

// `kadans autopace on|off`: config.json keeps every other key; off also lifts the auto entries.
export function setAutopace(home, on, { now = Date.now() } = {}) {
  withLock(home, () => {
    const file = join(home, 'config.json');
    let raw = {};
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) ?? {};
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`config.json is not valid JSON, nothing was written: ${file}`);
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`config.json is not an object: ${file}`);
    raw.autopace = on === true;
    writeAtomic(file, raw);
  });
  if (!on) updatePace(home, (p) => applyStep(p, { auto: { ...(p._auto ?? {}), lastStep: 0 }, lift: true, renew: false }, now), { now });
  return on === true;
}
