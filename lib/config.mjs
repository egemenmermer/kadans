// `kadans config get|set`: a strict allow-list over ~/.kadans/config.json. Writes go under the store lock as a temp file
// plus rename, and keep every key Kadans does not know (chain, pace, other accounts, ...).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPACT_OFF } from './compact.mjs';
import { AUTO_COMPACT_RANGE, AUTO_GAS_RANGE, COMPACT_RANGE, HHMM_RE, loadConfig } from './pace.mjs';
import { withLock, writeAtomic } from './store.mjs';
import { ownKey as defaultOwnKey, setAutopace } from './pace-control.mjs';

const int = (lo, hi) => (v) => {
  if (!/^\d{1,3}$/.test(v)) return { error: `expected a whole number ${lo}-${hi}` };
  const n = Number(v);
  return n >= lo && n <= hi ? { value: n } : { error: `expected a whole number ${lo}-${hi}` };
};
const bool = (v) => (v === 'true' ? { value: true } : v === 'false' ? { value: false } : { error: 'expected true or false' });
const LIMITS = { auto: 'auto', five_hour: ['five_hour'], 'five_hour,seven_day': ['five_hour', 'seven_day'] };
const limits = (v) => (Object.hasOwn(LIMITS, v) ? { value: LIMITS[v] } : { error: 'expected auto, five_hour or five_hour,seven_day' });
const hhmm = (v) => (HHMM_RE.test(v) ? { value: v } : { error: 'expected a time HH:MM (00:00-23:59)' });
// A number lo-hi with at most one decimal (2.5).
const dec1 = (lo, hi) => (v) => {
  if (!/^\d{1,2}(\.\d)?$/.test(v)) return { error: `expected a number ${lo}-${hi} (one decimal at most)` };
  const n = Number(v);
  return n >= lo && n <= hi ? { value: n } : { error: `expected a number ${lo}-${hi} (one decimal at most)` };
};
// A whole number lo-hi of up to 6 digits (token counts).
const big = (lo, hi) => (v) => {
  if (!/^\d{1,6}$/.test(v)) return { error: `expected a whole number ${lo}-${hi}` };
  const n = Number(v);
  return n >= lo && n <= hi ? { value: n } : { error: `expected a whole number ${lo}-${hi}` };
};
const lang = (v) => (v === 'en' || v === 'tr' ? { value: v } : { error: 'expected en or tr' });

// 10-95 (% of the context window), or 101 for Off.
const soonRange = int(...COMPACT_RANGE.soonPct);
const soonPct = (v) => {
  if (v === String(COMPACT_OFF)) return { value: COMPACT_OFF };
  return soonRange(v).error ? { error: `expected a whole number ${COMPACT_RANGE.soonPct.join('-')}, or ${COMPACT_OFF} for Off` } : soonRange(v);
};

// key -> [path in config.json, parser]. Nothing outside this table can be written.
export const SETTABLE = {
  limits: [['limits'], limits],
  'targets.five_hour': [['targets', 'five_hour'], int(50, 100)],
  'targets.seven_day': [['targets', 'seven_day'], int(50, 100)],
  slack: [['slack'], int(0, 30)],
  'warmup.minutes': [['warmup', 'minutes'], int(0, 60)],
  'warmup.pct': [['warmup', 'pct'], int(0, 50)],
  notify: [['notify'], bool],
  autopace: [['autopace'], bool],
  usageApi: [['usageApi'], bool],
  smartTitles: [['smartTitles'], bool], // Haiku titles for the own account's chats (lib/smart-titles.mjs)
  codex: [['codex'], bool], // show Codex CLI limits (lib/codex.mjs)
  lang: [['lang'], lang],
  'kickoff.enabled': [['kickoff', 'enabled'], bool],
  'kickoff.from': [['kickoff', 'from'], hhmm],
  'kickoff.to': [['kickoff', 'to'], hhmm],
  'compact.soonPct': [['compact', 'soonPct'], soonPct],
  'compact.nowPct': [['compact', 'nowPct'], int(...COMPACT_RANGE.nowPct)],
  'compact.idleMin': [['compact', 'idleMin'], int(...COMPACT_RANGE.idleMin)],
  autoGas: [['autoGas'], bool],
  autoGasMax: [['autoGasMax'], int(...AUTO_GAS_RANGE.max)],
  autoGasMinRamGB: [['autoGasMinRamGB'], dec1(...AUTO_GAS_RANGE.ramGB)],
  autoCompact: [['autoCompact'], bool], // k55: /compact an idle, big Orca chat while its cache is warm (lib/autocompact.mjs)
  autoCompactIdleMin: [['autoCompactIdleMin'], int(...AUTO_COMPACT_RANGE.idleMin)],
  autoCompactMinTokens: [['autoCompactMinTokens'], big(...AUTO_COMPACT_RANGE.minTokens)],
  autoCompactPerHour: [['autoCompactPerHour'], int(...AUTO_COMPACT_RANGE.perHour)],
  lean: [['lean'], bool], // lean-mode nudges (lib/lean.mjs); false turns them all off
  phone: [['phone'], bool], // the Mac app keeps `kadans serve` running while true
  remoteAgents: [['remoteAgents'], bool], // k38: list agents on paired Orca environments (other computers)
};
const GAS_RE = /^accounts\.([0-9a-f]{12})\.gas$/;

// Returns { path, value } or { error }. ownKey: the key of the owner's own ~/.claude account.
export function parseSetting(key, raw, ownKey = defaultOwnKey()) {
  if (typeof key !== 'string' || typeof raw !== 'string') return { error: 'usage: kadans config set <key> <value>' };
  const gas = key.match(GAS_RE);
  if (gas) {
    if (gas[1] !== ownKey) return { error: `refused: ${gas[1]} is not your own account; Kadans never spends quota on another account` };
    const b = bool(raw);
    return b.error ? { error: `${key}: ${b.error}` } : { path: ['accounts', gas[1], 'gas'], value: b.value };
  }
  if (!Object.hasOwn(SETTABLE, key)) return { error: `unknown or read-only setting: ${key} (allowed: ${[...Object.keys(SETTABLE), 'accounts.<own key>.gas'].join(', ')})` };
  const [path, parse] = SETTABLE[key];
  const r = parse(raw);
  return r.error ? { error: `${key}: ${r.error}` } : { path, value: r.value };
}

function readRaw(file) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) ?? {};
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`config.json is not valid JSON, nothing was written: ${file}`);
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`config.json is not an object: ${file}`);
  return raw;
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Validates, then writes one setting. Throws with a readable message when refused (nothing is written then).
export function setSetting(home, key, raw, { ownKey = defaultOwnKey(), now = Date.now() } = {}) {
  const p = parseSetting(key, raw, ownKey);
  if (p.error) throw new Error(p.error);
  // autopace off also lifts the auto pace entries; same path as `kadans autopace on|off`.
  if (key === 'autopace') {
    setAutopace(home, p.value, { now });
    return p.value;
  }
  withLock(home, () => {
    const file = join(home, 'config.json');
    const cfg = readRaw(file);
    let o = cfg;
    for (const k of p.path.slice(0, -1)) {
      if (!isObj(o[k])) o[k] = {};
      o = o[k];
    }
    o[p.path[p.path.length - 1]] = p.value;
    writeAtomic(file, `${JSON.stringify(cfg, null, 2)}\n`);
  });
  return p.value;
}

// What the Settings view needs: the effective values plus the owner's own account key (for the gas switch).
export function configView(home, ownKey = defaultOwnKey()) {
  const c = loadConfig(home);
  return {
    version: 1,
    limits: c.limits,
    targets: c.targets,
    slack: c.slack,
    warmup: c.warmup,
    notify: c.notify,
    autopace: c.autopace,
    usageApi: c.usageApi,
    codex: c.codex,
    lang: c.lang,
    kickoff: c.kickoff,
    compact: c.compact,
    autoGas: c.autoGas,
    autoGasMax: c.autoGasMax,
    autoGasMinRamGB: c.autoGasMinRamGB,
    autoCompact: c.autoCompact,
    autoCompactIdleMin: c.autoCompactIdleMin,
    autoCompactMinTokens: c.autoCompactMinTokens,
    autoCompactPerHour: c.autoCompactPerHour,
    lean: c.lean,
    phone: c.phone,
    remoteAgents: c.remoteAgents,
    own: ownKey,
    accounts: Object.fromEntries(Object.entries(c.accounts).map(([k, v]) => [k, { gas: k === ownKey && v.gas === true }])),
  };
}
