// Readable agent titles, with no model calls and no network. First match wins:
// 1. a title the owner set (`kadans agent title <id> "<text>"`, $KADANS_HOME/titles.json, keyed by agent id);
// 2. the session title Claude Code stored in the transcript (`custom-title` from /rename, else the latest `ai-title`);
// 3. a meaningful Orca terminal tab title;
// 4. the cleaned first prompt.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock } from './store.mjs';

export const TITLE_CHARS = 60;
const titlesFile = (home) => join(home, 'titles.json');

// Owner titles: { [agentId]: text }.
export function readTitles(home) {
  try {
    const v = JSON.parse(readFileSync(titlesFile(home), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// Sets (or, with empty text, clears) the owner's title for one agent. Returns the stored text or null.
export function setTitle(home, id, text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  const value = clean ? cut(clean, TITLE_CHARS) : null;
  return withLock(home, () => {
    const all = readTitles(home);
    if (value) all[id] = value;
    else delete all[id];
    const tmp = `${titlesFile(home)}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(tmp, titlesFile(home));
    return value;
  });
}

const TURKISH = /[çğıöşüÇĞİÖŞÜ]/;

// Upper-cases the first letter; Turkish text gets the Turkish rules (i -> İ).
function capitalise(s) {
  const chars = [...s];
  const i = chars.findIndex((c) => /\p{L}/u.test(c));
  if (i === -1) return s;
  chars[i] = TURKISH.test(s) ? chars[i].toLocaleUpperCase('tr') : chars[i].toUpperCase();
  return chars.join('');
}

// Cuts at a word boundary to at most max characters (code points), with an ellipsis when cut.
export function cut(s, max = TITLE_CHARS) {
  const chars = [...s];
  if (chars.length <= max) return s;
  const head = chars.slice(0, max - 1).join('');
  const sp = head.search(/\s\S*$/u);
  const base = sp > max / 3 ? head.slice(0, sp) : head; // one very long word: hard cut
  return `${base.replace(/[\s.,;:!?…\-–—(]+$/u, '')}…`;
}

// Cleans a prompt (or any free text) into a short title, or null when nothing readable is left.
export function cleanTitle(text, max = TITLE_CHARS) {
  if (typeof text !== 'string') return null;
  let s = text.replace(/\r\n?/g, '\n');
  s = s.replace(/```[\s\S]*?(```|$)/g, '\n'); // fenced (pasted) code blocks, closed or not
  s = s.replace(/\[(Pasted text|Image|File)[^\]\n]*\]/gi, ' '); // Claude Code paste placeholders
  s = s.replace(/<([A-Za-z][\w:-]*)(\s[^<>]*)?>[\s\S]*?<\/\1\s*>/g, ' '); // <tag>…</tag> blocks
  s = s.replace(/<\/?[A-Za-z][^<>\n]*>/g, ' '); // lone tags
  s = s.replace(/\b(?:https?|ftp|file):\/\/\S+|\bwww\.\S+/gi, ' '); // URLs
  // Pasted logs and dumps: lines that are mostly not words.
  s = s.split('\n').filter((line) => {
    const t = line.trim();
    if (!t) return true;
    const letters = (t.match(/\p{L}/gu) ?? []).length;
    return letters >= 3 && letters / t.length >= 0.4;
  }).join('\n');
  s = s.replace(/^\s*\/[\w:-]+(?=\s|$).*$/gm, ''); // a /slash-command line
  s = s.replace(/^\s*[!$>#]\s*(?=\S)/gim, ''); // shell, quote and memory prefixes at a line start
  s = s.replace(/(^|[\s"'`(])(?:~|\.{1,2})?\/[^\s"'`)]*/g, '$1'); // absolute and ./ paths, /slash-commands
  s = s.replace(/(^|[\s"'`(])[\w.-]+(?:\/[\w.-]+)+/g, (m, pre) => (/\/.*\/|\.\w{1,6}$/.test(m) ? pre : m)); // a/b/c, a/b.ext
  s = s.replace(/(^|\s)@\S+/g, '$1'); // @file mentions
  s = s.replace(/(["'`])\s*\1/g, ' ').replace(/\(\s*\)/g, ' '); // quotes and brackets left empty
  // First sentence; a line ends a sentence too. Very short leads ("Here:") take the next sentence along.
  const lines = s.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => /\p{L}{2}/u.test(l));
  const parts = lines.flatMap((l) => l.split(/(?<=[.!?…])\s+/u));
  let sentence = parts.shift() ?? '';
  while (parts.length && (sentence.match(/\p{L}/gu) ?? []).length < 8) sentence += ` ${parts.shift()}`;
  sentence = sentence.replace(/^[\s\-–—:;,.*•>|]+/u, '').replace(/[\s,;:.]+$/u, '').trim();
  if (!/\p{L}{2}/u.test(sentence)) return null;
  return cut(capitalise(sentence), max);
}

const GENERIC = /^(claude( code)?|codex|zsh|bash|sh|fish|node|terminal|shell|login|new tab|untitled|tab \d+)$/i;

// The Orca tab title when it says something: Claude Code writes "✳ <title>" there; shells write their name or a path.
export function orcaTitle(title, { id = null, names = [] } = {}) {
  if (typeof title !== 'string' || /^\s*[~/.]/.test(title)) return null; // a path
  const t = title.replace(/^[^\p{L}\p{N}]+/u, '').trim(); // ✳, spinner glyphs
  if (!t || GENERIC.test(t)) return null;
  if (id && String(id).length >= 8 && t.includes(id)) return null; // `claude --resume <id>`
  if (names.some((n) => n && t.toLowerCase() === String(n).toLowerCase())) return null;
  if (/^(~|\/)/.test(t) || /^[\w.-]+@[\w.-]+/.test(t)) return null; // a path or user@host
  return cleanTitle(t);
}

// { title, titleSource } for one agent row. scan: transcript scan state ({ customTitle, aiTitle }).
export function pickTitle({ id, owner, scan, orca, prompt, project }) {
  const own = typeof owner === 'string' && owner.trim() ? cut(owner.trim()) : null;
  if (own) return { title: own, titleSource: 'owner' };
  const session = cleanTitle(scan?.customTitle ?? '') ?? cleanTitle(scan?.aiTitle ?? '');
  if (session) return { title: session, titleSource: 'session' };
  const fromOrca = orcaTitle(orca?.title, { id, names: [project, orca?.worktree, orca?.repo] });
  if (fromOrca) return { title: fromOrca, titleSource: 'orca' };
  const fromPrompt = cleanTitle(prompt ?? '');
  if (fromPrompt) return { title: fromPrompt, titleSource: 'prompt' };
  return { title: null, titleSource: null };
}
