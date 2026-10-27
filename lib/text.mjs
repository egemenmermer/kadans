// Text safety for anything that may reach a terminal: titles, prompts, orca tab names.
// Strips control characters (ESC, BEL, NUL, C1) and invisible format characters (bidi overrides, zero-width, BOM)
// except newline and tab, so a hostile title cannot send escape sequences or reorder text in `kadans agents`.
export function stripControl(s) {
  return String(s ?? '').replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === '\n' || c === '\t' ? c : ''));
}
