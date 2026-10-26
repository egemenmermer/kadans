// `kadans config get|set`: a strict allow-list over ~/.kadans/config.json. Writes go under the store lock as a temp file
// plus rename, and keep every key Kadans does not know (chain, pace, other accounts, ...).
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HHMM_RE, loadConfig } from './pace.mjs';
import { withLock } from './store.mjs';
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
const lang = (v) => (v === 'en' || v === 'tr' ? { value: v } : { error: 'expected en or tr' });

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
  lang: [['lang'], lang],
  'kickoff.enabled': [['kickoff', 'enabled'], bool],
  'kickoff.from': [['kickoff', 'from'], hhmm],
  'kickoff.to': [['kickoff', 'to'], hhmm],
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
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
    renameSync(tmp, file);
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
    lang: c.lang,
    kickoff: c.kickoff,
    own: ownKey,
    accounts: Object.fromEntries(Object.entries(c.accounts).map(([k, v]) => [k, { gas: k === ownKey && v.gas === true }])),
  };
}
