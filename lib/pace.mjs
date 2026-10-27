// Pure pace maths for the usage windows. All times are epoch milliseconds; rates are percentage points per minute.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPACT_OFF } from './compact.mjs';

export const MIN = 60_000;
export const WINDOW_MS = { five_hour: 5 * 60 * MIN, seven_day: 7 * 24 * 60 * MIN };
const WINDOW_RE = /^window_([1-9]\d{0,6})$/; // other window lengths (Codex plans), in minutes: window_43200 = 30 days

// Window length of a limit name in ms, or null for an unknown name.
export function windowMs(name) {
  if (Object.hasOwn(WINDOW_MS, name)) return WINDOW_MS[name];
  const m = typeof name === 'string' ? name.match(WINDOW_RE) : null;
  return m ? Number(m[1]) * MIN : null;
}

// Target for a limit: the configured one, or for a window_<minutes> limit the larger of the two configured targets.
function targetOf(cfg, name) {
  const t = cfg.targets ?? DEFAULTS.targets;
  return Number.isFinite(t[name]) ? t[name] : Math.max(t.five_hour ?? 0, t.seven_day ?? 0) || DEFAULTS.targets.seven_day;
}
export const DEFAULTS = {
  limits: 'auto',
  targets: { five_hour: 97, seven_day: 98 },
  slack: 10,
  warmup: { minutes: 10, pct: 10 }, // a limit can only brake after this much window time passed or this much was used
  lang: 'en', // status line language: 'en' or 'tr'
  chain: '~/.claude/usage-guard/statusline.sh',
  notify: false, // macOS notifications on feed, done and first brake per window
  autopace: false, // nudge sessions when usage runs hot, slow them if the brake holds (lib/pace-control.mjs)
  pace: { slowSeconds: 20 }, // wait before each tool call of a slowed session (max 40)
  accounts: {}, // per account key: { gas: true } opts that account into the throttle (default off)
  kickoff: { enabled: false, from: '07:00', to: '23:00' }, // lib/kickoff.mjs: start the next window with one tiny message
  compact: { soonPct: 40, nowPct: 60, idleMin: 5 }, // lib/compact.mjs: when an idle chat is worth a /compact
  codex: true, // lib/codex.mjs: read Codex CLI limits from its session logs, show only (Kadans never acts on Codex)
  smartTitles: true, // lib/smart-titles.mjs: Haiku names the own account's chats from their latest prompts (few calls)
  usageApi: true, // lib/usage-api.mjs: the app reads the own account's usage from Claude's usage endpoint every 2 min
  autoGas: false, // lib/autogas.mjs: `gas tick` may start the next approved task on spare quota (also needs accounts.<own>.gas)
  autoGasMax: 1, // at most this many auto-started sessions running at once (1-3)
  autoGasMinRamGB: 2.5, // no auto start with less free memory than this (vm_stat, macOS)
};
export const AUTO_GAS_RANGE = { max: [1, 3], ramGB: [0.5, 16] };
export const COMPACT_RANGE = { soonPct: [10, 95], nowPct: [10, 95], idleMin: [1, 120] };

export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const BRAKE_LEVEL = 98; // 100 % minus a 2-point margin
const GAS_MIN_LEFT = 15 * MIN; // no gas in the last 15 minutes of a window
const NEEDLE_SPAN = 15 * MIN; // needle = slope over the last 15 minutes
const MIN_SPAN = 5 * MIN; // data must span at least 5 minutes
const MIN_NEEDLE_POINTS = 3;
const RESET_TOLERANCE = 60_000; // resets_at values within a minute belong to the same window

// Missing or broken config falls back to defaults; never throws.
export function loadConfig(home) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) ?? {};
  } catch {
    raw = {};
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const cfg = { ...DEFAULTS, targets: { ...DEFAULTS.targets }, warmup: { ...DEFAULTS.warmup } };
  const names = Object.keys(WINDOW_MS);
  if (raw.limits === 'auto') cfg.limits = 'auto';
  else if (Array.isArray(raw.limits) && raw.limits.length && raw.limits.every((n) => names.includes(n))) cfg.limits = raw.limits;
  if (raw.targets && typeof raw.targets === 'object') {
    for (const n of names) if (Number.isFinite(raw.targets[n])) cfg.targets[n] = raw.targets[n];
  }
  if (Number.isFinite(raw.slack)) cfg.slack = raw.slack;
  if (raw.warmup && typeof raw.warmup === 'object') {
    for (const k of ['minutes', 'pct']) if (Number.isFinite(raw.warmup[k]) && raw.warmup[k] >= 0) cfg.warmup[k] = raw.warmup[k];
  }
  if (raw.lang === 'tr' || raw.lang === 'en') cfg.lang = raw.lang;
  if (typeof raw.chain === 'string' && raw.chain) cfg.chain = raw.chain;
  cfg.notify = raw.notify === true;
  cfg.autopace = raw.autopace === true;
  cfg.usageApi = raw.usageApi !== false;
  cfg.smartTitles = raw.smartTitles !== false;
  cfg.codex = raw.codex !== false; // lib/codex.mjs: show Codex CLI limits (only when its sessions folder exists)
  cfg.autoGas = raw.autoGas === true;
  cfg.lean = raw.lean !== false; // lib/lean.mjs: token-saving nudges, on by default
  cfg.phone = raw.phone === true; // phone control (`kadans serve`), off by default
  cfg.remoteAgents = raw.remoteAgents !== false; // k38: agents of paired Orca environments (other computers), on by default
  const [mlo, mhi] = AUTO_GAS_RANGE.max;
  cfg.autoGasMax = Number.isInteger(raw.autoGasMax) && raw.autoGasMax >= mlo && raw.autoGasMax <= mhi ? raw.autoGasMax : DEFAULTS.autoGasMax;
  const [rlo, rhi] = AUTO_GAS_RANGE.ramGB;
  cfg.autoGasMinRamGB = Number.isFinite(raw.autoGasMinRamGB) && raw.autoGasMinRamGB >= rlo && raw.autoGasMinRamGB <= rhi ? raw.autoGasMinRamGB : DEFAULTS.autoGasMinRamGB;
  cfg.pace = { slowSeconds: Number.isFinite(raw.pace?.slowSeconds) && raw.pace.slowSeconds > 0 ? Math.min(40, raw.pace.slowSeconds) : 20 };
  const ko = raw.kickoff && typeof raw.kickoff === 'object' ? raw.kickoff : {};
  cfg.kickoff = {
    enabled: ko.enabled === true,
    from: typeof ko.from === 'string' && HHMM_RE.test(ko.from) ? ko.from : DEFAULTS.kickoff.from,
    to: typeof ko.to === 'string' && HHMM_RE.test(ko.to) ? ko.to : DEFAULTS.kickoff.to,
  };
  const cp = raw.compact && typeof raw.compact === 'object' && !Array.isArray(raw.compact) ? raw.compact : {};
  cfg.compact = { ...DEFAULTS.compact };
  for (const [k, [lo, hi]] of Object.entries(COMPACT_RANGE)) if (Number.isInteger(cp[k]) && cp[k] >= lo && cp[k] <= hi) cfg.compact[k] = cp[k];
  // 101 = Off (kept as it is, outside the 10-95 range and the cap below)
  if (cp.soonPct === COMPACT_OFF) cfg.compact.soonPct = COMPACT_OFF;
  else if (cfg.compact.soonPct > cfg.compact.nowPct) cfg.compact.soonPct = cfg.compact.nowPct; // "soon" never after "now"
  cfg.accounts = {};
  if (raw.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts)) {
    for (const [k, v] of Object.entries(raw.accounts)) if (v && typeof v === 'object') cfg.accounts[k] = { gas: v.gas === true };
  }
  return cfg;
}

// Limits to show: the configured list, or with "auto" the ones present in the latest sample that has any
// (5-hour and 7-day first, then other window lengths, shortest first).
export function applicableLimits(samples, cfg) {
  if (Array.isArray(cfg.limits)) return cfg.limits;
  const last = [...samples].reverse().find((s) => s.limits && Object.keys(s.limits).length);
  if (!last) return [];
  const fixed = Object.keys(WINDOW_MS).filter((n) => n in last.limits);
  const other = Object.keys(last.limits).filter((n) => !fixed.includes(n) && windowMs(n) !== null).sort((a, b) => windowMs(a) - windowMs(b));
  return [...fixed, ...other];
}

// Points for one limit, and the samples of the current window (the latest resets_at group).
// Usage only grows inside a window, so a lower value than one already seen is a stale payload from
// an idle session and is dropped; only a new resets_at starts a new window.
export function currentWindow(samples, name) {
  const pts = samples
    .filter((s) => s.limits && s.limits[name])
    .map((s) => ({ t: s.t, pct: s.limits[name].pct, resetsAt: s.limits[name].resetsAt }))
    .sort((a, b) => a.t - b.t);
  if (pts.length === 0) return null;
  const end = pts[pts.length - 1].resetsAt;
  const cur = [];
  let max = -Infinity;
  for (const p of pts) {
    if (Math.abs(p.resetsAt - end) > RESET_TOLERANCE) continue;
    if (p.pct < max) continue;
    max = p.pct;
    cur.push(p);
  }
  return { end, start: end - windowMs(name), last: cur[cur.length - 1], pts: cur };
}

// Least-squares slope of pct against time, in percentage points per minute.
function slopePerMin(pts) {
  const n = pts.length;
  const tbar = pts.reduce((a, p) => a + p.t, 0) / n;
  const pbar = pts.reduce((a, p) => a + p.pct, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.t - tbar) * (p.pct - pbar);
    den += (p.t - tbar) ** 2;
  }
  return den === 0 ? null : (num / den) * MIN;
}

export function limitState(samples, name, now, cfg) {
  const w = currentWindow(samples, name);
  if (!w) return { name, state: 'nodata' };
  const used = w.last.pct;
  const target = targetOf(cfg, name);
  const timeLeft = w.end - now;
  if (timeLeft <= 0) return { name, state: 'unknown', ended: true, pct: used, resetsAt: w.end };

  const elapsedMin = Math.max((now - w.start) / MIN, 0);
  const baseRate = elapsedMin > 0 ? used / elapsedMin : 0;
  const recent = w.pts.filter((p) => p.t >= now - NEEDLE_SPAN && p.t <= now);
  let needle = baseRate;
  if (recent.length >= 2) {
    const s = slopePerMin(recent);
    if (s !== null) needle = Math.max(s, 0);
  }
  const span = recent.length ? recent[recent.length - 1].t - recent[0].t : 0;
  const reliable = recent.length >= MIN_NEEDLE_POINTS && span >= MIN_SPAN;
  const rate = reliable ? needle : baseRate;
  const projection = used + rate * (timeLeft / MIN);

  // Warm-up: right after a window starts the rate is meaningless, so brake is held back until enough
  // of the window has passed or enough was used.
  const wu = cfg.warmup ?? DEFAULTS.warmup;
  const warm = elapsedMin >= wu.minutes || used >= wu.pct;

  // Past warm-up, brake fires whenever the projection reaches the brake level, even on thin data (conservative).
  let brakeAt = Infinity;
  if (used >= BRAKE_LEVEL) brakeAt = now;
  else if (rate > 0) brakeAt = now + ((BRAKE_LEVEL - used) / rate) * MIN;
  const brake = warm && projection >= BRAKE_LEVEL;

  const wspan = w.pts.length ? w.pts[w.pts.length - 1].t - w.pts[0].t : 0;
  const enough = w.pts.length >= 2 && wspan >= MIN_SPAN;
  let state;
  if (brake) state = 'brake';
  // Still warming up but already on course to run out: say so, without braking yet.
  else if (!warm && projection >= BRAKE_LEVEL) state = 'early';
  else if (!enough) state = 'unknown';
  else if (timeLeft >= GAS_MIN_LEFT && projection < target - cfg.slack) state = 'gas';
  else state = 'cruise';

  return {
    name,
    state,
    pct: used,
    rate,
    // The needle shown to the owner is the rate actually used, so a burst of samples seconds apart
    // never shows a wild value.
    needle: rate,
    projection,
    resetsAt: w.end,
    timeLeft,
    brakeAt,
    target,
    lastT: w.last.t,
    samples: w.pts.length,
  };
}

// Overall: brake if any limit brakes; gas only if every applicable limit says gas; unknown if none has data.
export function overall(samples, now, cfg) {
  const names = applicableLimits(samples, cfg);
  const limits = names.map((n) => limitState(samples, n, now, cfg));
  if (limits.length === 0) return { state: 'unknown', limit: null, limits };
  const brakes = limits.filter((v) => v.state === 'brake').sort((a, b) => a.brakeAt - b.brakeAt);
  if (brakes.length) return { state: 'brake', limit: brakes[0].name, limits };
  const early = limits.find((v) => v.state === 'early');
  if (early) return { state: 'early', limit: early.name, limits };
  if (limits.every((v) => v.state === 'gas')) {
    const worst = limits.reduce((a, b) => (b.projection < a.projection ? b : a));
    return { state: 'gas', limit: worst.name, limits };
  }
  if (limits.every((v) => v.state === 'unknown' || v.state === 'nodata')) return { state: 'unknown', limit: null, limits };
  return { state: 'cruise', limit: null, limits };
}
