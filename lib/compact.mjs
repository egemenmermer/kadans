// Compact advice: which idle chats are worth a /compact. Every turn re-reads the whole context, so a big context spends
// the usage window faster; once the prompt cache has expired (idle 5+ min) the next turn pays for all of it again.
// Pure functions only; lib/agents.mjs feeds them, `kadans agent compact` acts on the owner's click.

export const COMPACT_DEFAULTS = { soonPct: 40, nowPct: 60, idleMin: 5 };
// compact.soonPct = 101 means Off: no chat is ever advised (the Settings "Suggest compact" Off segment).
export const COMPACT_OFF = 101;
export const MIN_TOKENS = 60_000; // below this, never advise
export const IDLE_TOKENS = 100_000; // from this size, an expired cache alone is reason enough
export const WINDOW_1M = 1_000_000;
export const WINDOW_DEFAULT = 200_000;

// Context window of a model id: 1M for "[1m]" / "1m" context ids, else 200k. A context larger than 200k can only fit a
// 1M window, whatever the id says (transcripts record the API model id, which has no "[1m]").
export function contextWindow(model, tokens = 0) {
  if (typeof model === 'string' && /\[1m\]|(^|[^0-9a-z])1m([^0-9a-z]|$)/i.test(model)) return WINDOW_1M;
  return tokens > WINDOW_DEFAULT ? WINDOW_1M : WINDOW_DEFAULT;
}

export function kTok(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`;
}

export const CACHE_1H_MIN = 60;

// { tokens, window, status, idleMs, cache1h } -> { advice: 'none'|'soon'|'now', why: string|null }.
// Only an idle session (waiting for a new prompt) is advised: never a working one, nor one waiting on a question or a
// permission dialog (typing /compact there would answer it), nor an ended one.
// cache1h: the chat's prompt cache lives an hour (the transcript shows 1-hour cache writes only), so idle time only
// counts from 60 minutes; otherwise from cfg.idleMin (the 5-minute cache).
export function compactAdvice({ tokens, window, status, idleMs = null, cache1h = null }, cfg = COMPACT_DEFAULTS) {
  const c = { ...COMPACT_DEFAULTS, ...(cfg ?? {}) };
  const none = { advice: 'none', why: null };
  if (c.soonPct >= COMPACT_OFF) return none;
  if (status !== 'idle' || !Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0) return none;
  if (tokens < MIN_TOKENS) return none;
  const pct = (tokens / window) * 100;
  const idleMin = Number.isFinite(idleMs) && idleMs > 0 ? Math.floor(idleMs / 60_000) : 0;
  const cacheGone = idleMin >= (cache1h === true ? Math.max(c.idleMin, CACHE_1H_MIN) : c.idleMin);
  if (tokens >= IDLE_TOKENS && cacheGone) return { advice: 'now', why: `Idle ${idleMin} min: next turn re-reads all ${kTok(tokens)}` };
  if (pct >= c.nowPct) return { advice: 'now', why: `Re-reads ${kTok(tokens)} tokens every turn` };
  if (pct >= c.soonPct) return { advice: 'soon', why: `Re-reads ${kTok(tokens)} tokens every turn` };
  return none;
}

// The `context` field of one agent row, or null when the context size is unknown.
export function contextOf({ tokens, model, status, idleMs, cache1h = null }, cfg) {
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  const window = contextWindow(model, tokens);
  const pct = Math.round((tokens / window) * 1000) / 10;
  return { tokens, window, pct, ...compactAdvice({ tokens, window, status, idleMs, cache1h }, cfg) };
}

// What `kadans agent compact` would run: the orca argv, or a reason. Checks only what the row says; the caller adds the
// live process check (pid reuse). agent: a row of listAgents.
export function compactPlan(agent) {
  const typeIt = 'Type /compact in that chat';
  if (agent.source !== 'claude') return { ok: false, why: `Kadans cannot see this chat's session; ${typeIt}` };
  if (agent.status === 'working') return { ok: false, why: 'it is working; compact it when it waits for your next prompt' };
  if (agent.status === 'needs-you') return { ok: false, why: 'it is waiting on a question or permission; answer it first' };
  if (agent.status === 'ended') return { ok: false, why: 'the session has ended' };
  if (agent.status !== 'idle') return { ok: false, why: `status is ${agent.status}` };
  if (agent.orca?.ambiguous) return { ok: false, why: `several Claude sessions share this Orca worktree; ${typeIt}` };
  if (!agent.orca?.terminal) return { ok: false, why: `it does not run in an Orca terminal Kadans knows; ${typeIt}` };
  return { ok: true, terminal: agent.orca.terminal, argv: ['terminal', 'send', '--terminal', agent.orca.terminal, '--text', '/compact', '--enter'] };
}

// ---------- draft guard ----------
// `orca terminal send --text /compact --enter` types into whatever input line the chat has: a half-typed message there
// would be submitted together with /compact. So before sending, the terminal's RENDERED screen (read-only: `orca terminal
// read --screen --json`, not the raw stream, which comes back as repaint fragments) must show Claude Code's input line
// clearly empty. Anything else, or a screen that cannot be read or parsed, refuses (fail closed). Pure functions.

export const DRAFT_REFUSAL = 'That chat has unsent text: type /compact there yourself';
const DIALOG_REFUSAL = 'That chat is waiting on a dialog or question: answer it there, then type /compact yourself';
const unreadable = (why) => ({ ok: false, why: `Could not read that chat's screen (${why}): type /compact there yourself` });

// The read-only call: the rendered screen of one terminal as JSON.
export const screenReadArgv = (terminal) => ['terminal', 'read', '--terminal', terminal, '--screen', '--json'];

// A horizontal rule of the input box: "────", a labelled "──── name ──", or the corners of the older boxed layout.
const RULE = /^\s*[╭╰]?[─━]{3,}(?:.*[─━]{2,})?[╮╯]?\s*$/u;
// k49: "esc to interrupt" is the working line (the spinner above the input box), not a dialog. Compact still reads it as one
// (never /compact a working chat); the send guard alone lets a working Claude Code chat through when its box is empty.
const WORKING = /esc to interrupt/i;
const DIALOG = [/esc to cancel/i, WORKING, /do you want to/i, /enter to confirm/i, /\(y\/n\)/i, /^\s*│?\s*[❯>›]\s*\d+[.)]\s+\S/u];
const NOT_WORKING = DIALOG.filter((re) => re !== WORKING);
const BOTTOM_ROWS = 14; // only the bottom of the screen can hold the live input box or a dialog
const FOOTER_ROWS = 6;

// Rendered screen lines (top to bottom) -> 'empty' | 'text' | 'dialog' | 'unknown'. 'empty' only when the last input box
// (between two rules) starts with the prompt marker followed by nothing, with no further text inside the box.
// allowWorking (k49, the send guard for Claude Code only): the working line is not a dialog, every other dialog still is.
export function inputBoxState(lines, { allowWorking = false } = {}) {
  if (!Array.isArray(lines)) return 'unknown';
  const rows = lines.map((l) => (typeof l === 'string' ? l.replace(/\s+$/u, '') : ''));
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  if (rows.length === 0) return 'unknown';
  const dialogs = allowWorking ? NOT_WORKING : DIALOG;
  if (rows.slice(-BOTTOM_ROWS).some((l) => dialogs.some((re) => re.test(l)))) return 'dialog';
  let b = -1;
  for (let i = rows.length - 1; i >= 0; i--) if (RULE.test(rows[i])) { b = i; break; }
  if (b < 0 || rows.length - 1 - b > FOOTER_ROWS) return 'unknown';
  let t = -1;
  for (let i = b - 1; i >= 0; i--) if (RULE.test(rows[i])) { t = i; break; }
  if (t < 0 || b - t < 2) return 'unknown';
  const inner = rows.slice(t + 1, b).map((l) => l.replace(/^\s*│?\s*/u, '').replace(/\s*│\s*$/u, '').trim());
  const m = inner[0].match(/^[❯>›]\s?(.*)$/u);
  if (!m) return 'unknown';
  return m[1] === '' && inner.slice(1).every((l) => l === '') ? 'empty' : 'text';
}

// The rendered lines of `orca terminal read --screen --json`, or { why } when the answer is not a rendered screen.
function screenOf(raw) {
  let term;
  try {
    term = JSON.parse(raw)?.result?.terminal;
  } catch {
    return { why: 'not JSON' };
  }
  if (!term || typeof term !== 'object') return { why: 'no terminal in the answer' };
  if (term.source !== 'screen') return { why: `Orca gave ${term.source ?? 'no'} output, not the rendered screen` };
  const lines = Array.isArray(term.tail) ? term.tail : typeof term.tail === 'string' ? term.tail.split('\n') : null;
  return { lines };
}

// Output of `orca terminal read --screen --json` -> { ok: true } (input line empty) or { ok: false, why }.
export function draftGuard(raw) {
  const sc = screenOf(raw);
  if (sc.why) return unreadable(sc.why);
  const state = inputBoxState(sc.lines);
  if (state === 'empty') return { ok: true };
  if (state === 'text') return { ok: false, why: DRAFT_REFUSAL };
  if (state === 'dialog') return { ok: false, why: DIALOG_REFUSAL };
  return unreadable('no input line found');
}

// ---------- send guard (k49) ----------
// A message (`kadans agent send`) may reach a WORKING Claude Code chat: Claude Code queues what is typed while it works
// and takes it up when the turn allows, so the working screen ("esc to interrupt" above an empty input box) is accepted
// like the idle one. Still refused: a permission or question dialog, a non-empty input line (a draft would be sent with
// it), and any screen Kadans cannot read. A dialog that opens after the read is not seen (see sendAgent). Codex (or any other agent): idle only (its composer shows a placeholder that a
// text-only screen cannot tell from typed text, and its queueing is not documented here), so a working Codex screen is
// refused. Refusals are fixed sentences: never the screen or the message.
export const SEND_REFUSAL = {
  draft: 'That chat has unsent text: nothing was sent',
  other: 'That chat is waiting on a dialog, or its screen could not be read: nothing was sent',
  working: 'it is working; try again when it waits for your next prompt',
};
// -> { ok: true, working } or { ok: false, why } (why: one of SEND_REFUSAL).
export function sendGuard(raw, { agentType = 'claude' } = {}) {
  const sc = screenOf(raw);
  if (sc.why || !Array.isArray(sc.lines)) return { ok: false, why: SEND_REFUSAL.other };
  const claude = agentType === 'claude';
  const state = inputBoxState(sc.lines, { allowWorking: claude });
  const working = sc.lines.slice(-BOTTOM_ROWS - 4).some((l) => typeof l === 'string' && WORKING.test(l));
  if (state === 'empty') return { ok: true, working };
  if (state === 'text') return { ok: false, why: SEND_REFUSAL.draft };
  if (!claude && working && inputBoxState(sc.lines, { allowWorking: true }) !== 'dialog') return { ok: false, why: SEND_REFUSAL.working };
  return { ok: false, why: SEND_REFUSAL.other };
}
