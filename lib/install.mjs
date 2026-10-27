// Merges Kadans into Claude Code's settings.json without removing anything that is not ours (Orca's hooks stay).
// Ours = a command matching OURS_RE. Preview (diff) by default; apply writes a timestamped backup first.
import { constants, existsSync, readFileSync, renameSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPAWN_MATCHER } from './hooks.mjs';
import { ensureHome, writeAtomic as writePrivate } from './store.mjs';

export const OURS_RE = /kadans(\.mjs)?["']?\s+(hook\s+(pace-pre|pace-post|stop|pretool|event)|statusline)(?![\w-])/;
// Session events for `kadans agents` (lib/agents.mjs). Notification only for prompts that wait on the owner.
export const EVENT_HOOKS = [
  ['SessionStart'],
  ['UserPromptSubmit'],
  ['Stop'],
  ['SubagentStart'],
  ['SubagentStop'],
  ['SessionEnd'],
  ['Notification', 'permission_prompt|elicitation_dialog'],
];
export const HOOK_TIMEOUT = 30; // seconds; a hook waits at most 2 s for the store lock
// pace-pre sleeps up to 40 s before a tool call of a slowed session (lib/pace-control.mjs SLOW_MAX_S).
export const PACE_TIMEOUT = 60;
export const PACE_MATCHER = '*';

// One line per hook kind for the install preview (and `install --json` changes).
const SUMMARY = {
  statusline: 'status line: records usage samples and shows the gauge (runs your old status line script too)',
  'hook stop': 'feeds one owner-approved task when quota would go to waste (off unless you opt in)',
  'hook pretool': 'holds new subagents and workflows (Agent|Workflow) while the brake is on',
  'hook event': 'logs session events for the agent list',
  'hook pace-pre': 'every tool call: waits 20 s if you slowed the session, halts it if you paused it; reads two small files otherwise',
  'hook pace-post': 'every tool call: with Auto-pace on, adds a short "usage is running hot" note at most every 10 min',
};

const isOurs = (h) => typeof h?.command === 'string' && OURS_RE.test(h.command);
// 'hook stop', 'hook event', 'statusline', ...: one entry of each kind per event, wherever the checkout lives.
const ourKind = (h) => (isOurs(h) ? h.command.match(OURS_RE)[2].replace(/\s+/g, ' ') : null);
const clone = (x) => JSON.parse(JSON.stringify(x ?? {}));

// Absolute invocation, single-quoted for /bin/sh (a ' inside becomes '\''), so a path with spaces, ", $, backticks or \
// stays one literal word. Installs made with the older "double-quoted" form are still recognised by OURS_RE.
export function kadansCommand(bin) {
  return `node '${String(bin).replace(/'/g, "'\\''")}'`;
}

function hasOurHook(groups, kind) {
  return Array.isArray(groups) && groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => ourKind(h) === kind));
}

// Returns { settings, savedStatusLine }: statusLine replaced (old one returned for saving), hook groups appended.
export function mergeSettings(input, cmd) {
  const s = clone(input);
  let savedStatusLine = null;
  if (!isOurs(s.statusLine)) {
    savedStatusLine = s.statusLine ?? null;
    s.statusLine = { type: 'command', command: `${cmd} statusline` };
  }
  s.hooks = s.hooks && typeof s.hooks === 'object' ? s.hooks : {};
  const add = (event, group) => {
    if (!Array.isArray(s.hooks[event])) s.hooks[event] = s.hooks[event] ? [s.hooks[event]] : [];
    if (!hasOurHook(s.hooks[event], ourKind(group.hooks[0]))) s.hooks[event].push(group);
  };
  add('Stop', { hooks: [{ type: 'command', command: `${cmd} hook stop`, timeout: HOOK_TIMEOUT }] });
  add('PreToolUse', {
    matcher: SPAWN_MATCHER,
    hooks: [{ type: 'command', command: `${cmd} hook pretool`, timeout: HOOK_TIMEOUT }],
  });
  add('PreToolUse', { matcher: PACE_MATCHER, hooks: [{ type: 'command', command: `${cmd} hook pace-pre`, timeout: PACE_TIMEOUT }] });
  add('PostToolUse', { matcher: PACE_MATCHER, hooks: [{ type: 'command', command: `${cmd} hook pace-post`, timeout: HOOK_TIMEOUT }] });
  for (const [event, matcher] of EVENT_HOOKS) {
    const hooks = [{ type: 'command', command: `${cmd} hook event`, timeout: HOOK_TIMEOUT }];
    add(event, matcher ? { matcher, hooks } : { hooks });
  }
  return { settings: s, savedStatusLine };
}

// Removes only our hook entries (and groups left empty by that); restores the saved statusLine.
export function unmergeSettings(input, savedStatusLine) {
  const s = clone(input);
  if (isOurs(s.statusLine)) {
    if (savedStatusLine) s.statusLine = savedStatusLine;
    else delete s.statusLine;
  }
  if (s.hooks && typeof s.hooks === 'object') {
    for (const event of Object.keys(s.hooks)) {
      if (!Array.isArray(s.hooks[event])) continue;
      s.hooks[event] = s.hooks[event]
        .map((g) => (Array.isArray(g?.hooks) && g.hooks.some(isOurs) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
        .filter((g) => !(Array.isArray(g?.hooks) && g.hooks.length === 0));
      if (s.hooks[event].length === 0 && (input.hooks[event] ?? []).length > 0) delete s.hooks[event]; // we emptied it
    }
  }
  return s;
}

// Our entries as "event|kind" (statusLine as "statusLine|statusline").
function ourEntries(s) {
  const out = new Set();
  if (isOurs(s?.statusLine)) out.add('statusLine|statusline');
  for (const [event, groups] of Object.entries(s?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) for (const h of Array.isArray(g?.hooks) ? g.hooks : []) if (isOurs(h)) out.add(`${event}|${ourKind(h)}`);
  }
  return out;
}

// What install adds or uninstall removes, one summary line each: [{ kind: 'add'|'remove', event, hook, summary }].
export function changeList(before, after) {
  const a = ourEntries(before);
  const b = ourEntries(after);
  const row = (kind) => (k) => {
    const [event, hook] = k.split('|');
    return { kind, event, hook, summary: SUMMARY[hook] ?? hook };
  };
  return [...[...b].filter((k) => !a.has(k)).map(row('add')), ...[...a].filter((k) => !b.has(k)).map(row('remove'))];
}

// Minimal line diff (LCS) of two texts: lines prefixed with "  ", "- " or "+ ".
export function lineDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) out.push(`  ${x[i++]}`), j++;
    else if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) out.push(`+ ${y[j++]}`);
    else out.push(`- ${x[i++]}`);
  }
  return out.join('\n');
}

const fmt = (o) => `${JSON.stringify(o, null, 2)}\n`;

export function settingsPath(cfgDir) {
  return join(cfgDir, 'settings.json');
}

// Reads settings; a missing file is {}; a broken file throws (nothing gets written).
export function readSettings(file) {
  if (!existsSync(file)) return { text: '', data: {} };
  const text = readFileSync(file, 'utf8');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`settings.json is not valid JSON, nothing was written: ${file}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`settings.json is not an object: ${file}`);
  return { text, data };
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// settings.json is not Kadans's file: it keeps the mode it has (a new one gets the usual 0644).
function writeAtomic(file, text) {
  let mode = 0o644;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    // new file
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, file);
}

// Never overwrites an older backup (two applies in the same second get -2, -3, ...).
function backupTo(file, base) {
  for (let n = 1; ; n++) {
    const dest = n === 1 ? base : `${base}-${n}`;
    try {
      copyFileSync(file, dest, constants.COPYFILE_EXCL);
      return dest;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

const installFile = (home) => join(home, 'install.json');

function readInstall(home) {
  try {
    return JSON.parse(readFileSync(installFile(home), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

// kind = 'install' | 'uninstall'. Returns { changed, diff, backup }. Writes only with apply = true.
export function plan({ kind, cfgDir, home, bin, apply = false, now = new Date() }) {
  const file = settingsPath(cfgDir);
  const { text, data } = readSettings(file);
  const saved = readInstall(home);
  let next;
  let savedStatusLine = null;
  if (kind === 'install') ({ settings: next, savedStatusLine } = mergeSettings(data, kadansCommand(bin)));
  else next = unmergeSettings(data, saved.statusLine ?? null);
  const before = text ? fmt(data) : '';
  const after = fmt(next);
  const changed = fmt(data) !== after;
  const diff = changed ? lineDiff(before, after) : '';
  let backup = null;
  if (apply && changed) {
    if (existsSync(file)) backup = backupTo(file, `${file}.kadans-backup-${stamp(now)}`);
    // Save the statusLine we replace (none = null) before touching settings, so uninstall never brings back an older
    // one; a second install (statusLine already ours) never overwrites it with ours.
    if (kind === 'install' && !isOurs(data.statusLine)) {
      ensureHome(home);
      writePrivate(installFile(home), fmt({ ...saved, statusLine: savedStatusLine }));
    }
    writeAtomic(file, after);
  }
  return { file, changed, changes: changeList(data, next), diff, backup, oldStatusLine: kind === 'install' ? savedStatusLine : null };
}
