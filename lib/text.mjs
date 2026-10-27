// Text safety for anything that may reach a terminal: titles, prompts, orca tab names.
// Strips control characters (ESC, BEL, NUL, C1) and invisible format characters (bidi overrides, zero-width, BOM)
// except newline and tab, so a hostile title cannot send escape sequences or reorder text in `kadans agents`.
export function stripControl(s) {
  return String(s ?? '').replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === '\n' || c === '\t' ? c : ''));
}

// k48: a message typed into an agent's terminal (`kadans agent send`, the bridge's `agent-send`). CRLF and CR become LF,
// blank lines and spaces at both ends go (stdin's last newline), then: at least one visible character, at most SEND_MAX
// characters (code points), printable characters and newlines only (no tab, other control, bidi, zero-width-no-break or
// line-separator characters), and no leading "-" (orca would read the value as a flag), "!" (Claude Code runs the rest
// as a shell command), "/" (a slash command such as /clear) or "#" (a memory note): a message is only ever words for the
// agent. Returns the text or null; it never says what was wrong, so a refusal can never echo the text.
export const SEND_MAX = 4000;
const SEND_BAD = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
export function messageText(v) {
  if (typeof v !== 'string' || v.length > 4 * SEND_MAX + 64) return null;
  const t = v.replace(/\r\n?/g, '\n').replace(/^\s+|\s+$/gu, '');
  if (!t || /^[-!/#]/.test(t) || SEND_BAD.test(t) || Array.from(t).length > SEND_MAX) return null;
  return t;
}
