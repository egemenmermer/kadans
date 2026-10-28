// k55 `kadans compact tick`: opt-in auto-compact. Types /compact into ONE local Claude Code chat in Orca that has waited
// long enough with a big context while its prompt cache is still warm, so the next turn does not re-read the whole
// context at full price. Off by default (config autoCompact). At most one compact per tick and cfg.autoCompactPerHour per
// hour, own account only (never another account's profile), never a remote row. The live checks (pid,
// rendered screen, draft guard: an empty input line, no dialog) are compactAgent's (lib/agents.mjs), injected as
// `compact`; every refusal fails closed. Every try is recorded in $KADANS_HOME/autocompact.json (0600): agent id, time,
// tokens before, the chat's prompt count, ok, why code. Never a title, prompt or screen text.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { COMPACT_DEFAULTS, DIALOG_REFUSAL, DRAFT_REFUSAL, cacheWarm, compactPlan, kTok } from './compact.mjs';
import { withLock, writeAtomic } from './store.mjs';

const MIN = 60_000;
export const HOUR_MS = 60 * MIN;
export const OWNER_QUIET_MS = 2 * MIN; // the owner touched the chat less than this ago: leave it alone
export const GRACE_MS = 2 * MIN; // a pending try (being typed) counts toward the cap this long
export const SHOW_MS = 10 * MIN; // a row shows "Auto-compacted" this long
export const KEEP_MS = 24 * HOUR_MS;

// Every `why` code `compact tick` can return, in rule order (a per-chat refusal later in the list got further).
// 'compacted' and 'would-compact' (dry run) are the go answers.
export const WHY = ['compacted', 'would-compact', 'off', 'cap', 'no-chat',
  'remote', 'not-claude', 'ended', 'working', 'needs-you', 'not-idle', 'other-account', 'no-terminal', 'too-small', 'idle-short',
  'cache-cold', 'this-stretch', 'owner-active',
  'pid', 'unreadable', 'dialog', 'draft', 'refused'];
const RANK = new Map(WHY.map((w, i) => [w, i]));

const stateFile = (home) => join(home, 'autocompact.json');
const RECORD_KEYS = ['id', 't', 'tokens', 'prompts', 'ok', 'why'];
const clean = (r) => Object.fromEntries(RECORD_KEYS.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));

export function readAutoCompactState(home) {
  try {
    const v = JSON.parse(readFileSync(stateFile(home), 'utf8'));
    if (v && typeof v === 'object' && Array.isArray(v.runs)) return { runs: v.runs.filter((r) => r && typeof r === 'object' && typeof r.id === 'string') };
  } catch {
    // missing or broken: nothing on record
  }
  return { runs: [] };
}

function writeAutoCompactState(home, state, now) {
  const runs = state.runs.filter((r) => Number(r.t) > now - KEEP_MS).map(clean);
  writeAtomic(stateFile(home), `${JSON.stringify({ runs }, null, 2)}\n`); // writeAtomic: mode 0600
}

// id -> time of its newest auto compact in the last SHOW_MS (the row meta "Auto-compacted · 3m").
export function recentAutoCompacts(home, now = Date.now()) {
  const out = new Map();
  for (const r of readAutoCompactState(home).runs) {
    const t = Number(r.t);
    if (r.ok === true && now - t >= 0 && now - t < SHOW_MS && !(out.get(r.id) > t)) out.set(r.id, t);
  }
  return out;
}

// Own account: the row's samples account is the own key (or, with no samples, there is only the path to go by), and a
// transcript path must lie directly under the own config dir's projects folder, where this account's own chats live. A
// profile of another account keeps its own projects folder somewhere else (also when that lies inside the own config dir),
// so it never matches, whatever else says. An unknown path fails closed when there are no samples.
export function isOwnChat(agent, scan, { own, dir = join(homedir(), '.claude') }) {
  const path = typeof scan?.path === 'string' ? scan.path : '';
  if (path !== '' && !path.startsWith(join(dir, 'projects') + sep)) return false;
  if (agent.account) return agent.account === own;
  return path !== '';
}

// Auto compacts that count toward the hourly cap: done ones in the last hour, plus a try still being typed.
const spent = (state, now) => state.runs.filter((r) => (r.ok === true && now - Number(r.t) < HOUR_MS) || (r.ok === null && now - Number(r.t) < GRACE_MS)).length;

// One chat against every rule, cheap ones first: null (eligible) or a why code.
function refusal(a, scan, state, now, cfg, { own, dir }) {
  if (a.machine) return 'remote';
  if (a.source !== 'claude') return 'not-claude';
  if (a.status === 'ended') return 'ended';
  if (a.status === 'working') return 'working';
  if (a.status === 'needs-you' || a.asked === true) return 'needs-you'; // a question still open, even once it reads idle
  if (a.status !== 'idle') return 'not-idle';
  if (!isOwnChat(a, scan, { own, dir })) return 'other-account';
  if (!compactPlan(a).ok) return 'no-terminal';
  const tokens = a.context?.tokens;
  const advised = a.context?.advice === 'now' || a.context?.advice === 'soon';
  if (!Number.isFinite(tokens) || !(tokens >= cfg.autoCompactMinTokens || advised)) return 'too-small';
  // idle and cache age both count from the newest request (it refreshed the cache); unknown fails closed
  const at = Number(scan?.ctxAt);
  if (!Number.isFinite(at) || at <= 0) return 'cache-cold';
  const idleMs = now - at;
  if (idleMs < cfg.autoCompactIdleMin * MIN) return 'idle-short';
  if (!cacheWarm({ idleMs, cache1h: scan?.cache1h ?? null }, cfg.compact ?? COMPACT_DEFAULTS)) return 'cache-cold';
  // compacted already in this idle stretch: a record of this chat while its prompt count is unchanged (no new prompt since)
  const prompts = Number.isFinite(scan?.prompts) ? scan.prompts : null;
  if (state.runs.some((r) => r.id === a.id && (r.ok === true || r.ok === null) && (prompts === null || r.prompts === prompts))) return 'this-stretch';
  if (Number.isFinite(a.lastSeen) && now - a.lastSeen < OWNER_QUIET_MS) return 'owner-active';
  return null;
}

// agents: listAgents rows; state: readAutoCompactState; cfg: loadConfig. opts: scans (agents-cache.json, { [id]: scan }),
// own (own account key), dir (own config dir). -> { go: true, agent, tokens, prompts } or { go: false, why, skipped }.
// One chat at most: the eligible one with the biggest context. Nothing eligible: the why of the chat that got furthest.
export function pick(agents, state, now, cfg, { scans = {}, own = null, dir } = {}) {
  if (cfg?.autoCompact !== true) return { go: false, why: 'off', skipped: [] };
  if (spent(state, now) >= cfg.autoCompactPerHour) return { go: false, why: 'cap', skipped: [] };
  const skipped = [];
  let best = null;
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || typeof a.id !== 'string' || a.sameSessionAs) continue;
    const scan = scans[a.id] ?? null;
    const why = refusal(a, scan, state, now, cfg, { own, dir });
    const tokens = Number.isFinite(a.context?.tokens) ? a.context.tokens : 0;
    if (why) skipped.push({ id: a.id, why, tokens });
    else if (!best || tokens > best.tokens) best = { agent: a, tokens, prompts: Number.isFinite(scan?.prompts) ? scan.prompts : null };
  }
  if (best) return { go: true, ...best, skipped };
  if (!skipped.length) return { go: false, why: 'no-chat', skipped };
  const far = [...skipped].sort((x, y) => RANK.get(y.why) - RANK.get(x.why) || y.tokens - x.tokens)[0];
  return { go: false, why: far.why, skipped };
}

// compactAgent's refusal sentence -> a why code (anything unknown: 'refused').
export function whyOf(sentence) {
  const s = String(sentence ?? '');
  if (s === DRAFT_REFUSAL) return 'draft';
  if (s === DIALOG_REFUSAL) return 'dialog';
  if (s.startsWith("Could not read that chat's screen")) return 'unreadable';
  if (/\bpid\b/i.test(s)) return 'pid';
  return 'refused';
}

// One tick. deps: list() -> agents (listAgents rows, this computer), scans() -> agents-cache.json, own, dir, now, dryRun,
// compact(agent) -> compactAgent result ({ ok, why }), notify(title, body). The pick and a pending record are made under
// the store lock (two ticks never both type); the screen read and the send run outside it. A dry run reads no screen,
// sends nothing and writes nothing. Returns { compacted: <id> | null, why, tokens?, skipped }.
export function runTick(home, cfg, { list = () => [], scans = () => ({}), own = null, dir, now = Date.now(), dryRun = false, compact, notify = () => {} } = {}) {
  const agents = list();
  const sc = scans();
  const d = withLock(home, () => {
    const state = readAutoCompactState(home);
    const dec = pick(agents, state, now, cfg, { scans: sc, own, dir });
    if (dec.go && !dryRun) {
      state.runs.push({ id: dec.agent.id, t: now, tokens: dec.tokens, prompts: dec.prompts, ok: null });
      writeAutoCompactState(home, state, now);
    }
    return dec;
  });
  if (!d.go) return { compacted: null, why: d.why, skipped: d.skipped };
  const id = d.agent.id;
  if (dryRun) return { compacted: null, why: 'would-compact', id, tokens: d.tokens, skipped: d.skipped };
  let r;
  try {
    r = typeof compact === 'function' ? compact(d.agent) : { ok: false, why: 'no compact path' };
  } catch {
    r = { ok: false, why: 'refused' };
  }
  const ok = r?.ok === true;
  const why = ok ? 'compacted' : whyOf(r?.why);
  withLock(home, () => {
    const state = readAutoCompactState(home);
    const mine = state.runs.find((x) => x.ok === null && Number(x.t) === now && x.id === id);
    if (mine) Object.assign(mine, { ok, why });
    writeAutoCompactState(home, state, now);
  });
  if (ok) {
    try {
      notify('Kadans compacted an idle chat', `${kTok(d.tokens)} context, while its cache was still warm`); // no chat text
    } catch {
      // best effort
    }
  }
  return { compacted: ok ? id : null, why, tokens: d.tokens, skipped: d.skipped };
}

// The JSON contract with the app: exactly { compacted, why }.
export const tickJson = (r) => ({ compacted: r.compacted, why: r.why });

const TEXT = {
  off: 'off (config autoCompact)',
  cap: 'enough auto compacts this hour (autoCompactPerHour)',
  'no-chat': 'no chat on this computer',
  remote: 'runs on another computer',
  'not-claude': 'Kadans cannot see that chat’s session',
  ended: 'the session has ended',
  working: 'it is working',
  'needs-you': 'it waits on a question or permission',
  'not-idle': 'it is not idle',
  'other-account': 'not your own account',
  'no-terminal': 'it does not run in an Orca terminal Kadans knows',
  'too-small': 'the context is too small (autoCompactMinTokens)',
  'idle-short': 'not idle long enough (autoCompactIdleMin)',
  'cache-cold': 'the prompt cache has expired: a compact would re-read it all anyway',
  'this-stretch': 'already compacted since its last prompt',
  'owner-active': 'you touched it less than 2 min ago',
  pid: 'its process could not be confirmed',
  unreadable: 'its screen could not be read',
  dialog: 'a dialog or question is open',
  draft: 'it has unsent text',
  refused: 'compact refused',
};

const short = (id) => String(id).slice(0, 8);

export function renderTick(r) {
  if (r.why === 'compacted') return `sent /compact to ${short(r.compacted)} (${kTok(r.tokens)} context)`;
  if (r.why === 'would-compact') return `dry run: would compact ${short(r.id)} (${kTok(r.tokens)} context); nothing read, sent or written`;
  const lines = [`not compacted: ${TEXT[r.why] ?? r.why}`];
  if ((r.skipped ?? []).length > 1) for (const s of r.skipped) lines.push(`  ${short(s.id)}: ${s.why}`);
  return lines.join('\n');
}
