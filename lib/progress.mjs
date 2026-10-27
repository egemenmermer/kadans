// Work progress of an agent ("3/5 · Writing tests") read from its transcript (k35).
// Agents report it with a no-op Bash command, `kadans progress <done>/<total> ["<step>"]`; the transcript scan keeps the
// newest one per chain (lib/agents.mjs). Setups whose agents use TodoWrite or TaskCreate / TaskUpdate get it from those
// tool inputs too. progress = { done, total, step } (step: control characters stripped, at most STEP_CHARS) or null.
import { accessSync, constants } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripControl } from './text.mjs';

export const STEP_CHARS = 60;
export const MAX_TOTAL = 1000;
export const MAX_TASKS = 100;

// The program: `kadans`, a path ending in /kadans or /kadans.mjs, bare or quoted, optionally run with `node`.
const PROG = String.raw`(?:node\s+)?(?:'(?:[^'\n]*/)?kadans(?:\.mjs)?'|"(?:[^"\n]*/)?kadans(?:\.mjs)?"|(?:[^\s;&|'"]*/)?kadans(?:\.mjs)?)`;
// Only at the start of the command or of a chained one (after &&, ||, ; or a newline): `grep "kadans progress"` never counts.
// It may end in a redirection or a pipe (`2>&1`, `>/dev/null`, `| tail -1`).
const CMD = new RegExp(
  String.raw`(?:^|&&|\|\||;|\n)[ \t]*${PROG}[ \t]+progress[ \t]+(\d{1,6})[ \t]*/[ \t]*(\d{1,6})` +
    String.raw`(?:[ \t]+(?:"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'|([^\s;&|'"<>][^;&|\n<>]*?)))?[ \t]*(?=$|[;&|\n<>]|\d+[<>])`,
  'g',
);

export function cleanStep(s) {
  const t = stripControl(s).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, STEP_CHARS).trim() : null;
}

export function makeProgress(done, total, step) {
  const d = Number(done);
  const t = Number(total);
  if (!Number.isInteger(d) || !Number.isInteger(t) || t < 1 || t > MAX_TOTAL || d < 0) return null;
  return { done: Math.min(d, t), total: t, step: cleanStep(step) };
}

// The newest `kadans progress` in one Bash command string, or undefined when it has none.
export function progressOfCommand(command) {
  if (typeof command !== 'string' || !command.includes('progress')) return undefined;
  let last;
  for (const m of command.matchAll(CMD)) last = m;
  if (!last) return undefined;
  const step = last[3] !== undefined ? last[3].replace(/\\(.)/g, '$1') : (last[4] ?? last[5] ?? null);
  return makeProgress(last[1], last[2], step) ?? undefined;
}

function fromTodos(todos) {
  if (!Array.isArray(todos)) return undefined;
  const items = todos.filter((t) => t && typeof t === 'object');
  if (!items.length) return null; // an emptied list: no progress
  const now = items.find((t) => t.status === 'in_progress');
  return makeProgress(items.filter((t) => t.status === 'completed').length, items.length, now ? (now.activeForm || now.content) : null);
}

// Task tools (assumed shape, from tool inputs only): TaskCreate { subject, activeForm? } gets the next id "1", "2", ...;
// TaskUpdate { taskId, status?, subject?, activeForm? }, status "deleted" drops it. tasks: [{ id, s, a, st }] (st: status).
function applyTask(tasks, name, input) {
  if (name === 'TaskCreate') {
    if (tasks.length >= MAX_TASKS) return tasks;
    const next = tasks.reduce((n, t) => Math.max(n, Number(t.id) || 0), 0) + 1;
    return [...tasks, { id: String(next), s: cleanStep(input.subject), a: cleanStep(input.activeForm), st: 'pending' }];
  }
  const id = String(input.taskId ?? input.id ?? '');
  const i = tasks.findIndex((t) => t.id === id);
  if (i === -1) return tasks;
  if (input.status === 'deleted') return tasks.filter((_, j) => j !== i);
  const t = { ...tasks[i] };
  if (typeof input.status === 'string') t.st = input.status;
  if (typeof input.subject === 'string') t.s = cleanStep(input.subject);
  if (typeof input.activeForm === 'string') t.a = cleanStep(input.activeForm);
  return tasks.map((x, j) => (j === i ? t : x));
}

function fromTasks(tasks) {
  if (!tasks.length) return null;
  const now = tasks.find((t) => t.st === 'in_progress');
  return makeProgress(tasks.filter((t) => t.st === 'completed').length, tasks.length, now ? (now.a || now.s) : null);
}

// One transcript line: updates st.progress (and st.tasks for the task tools) in place. Sidechain lines are the caller's call.
export function progressFromLine(d, st) {
  if (d?.type !== 'assistant' || !Array.isArray(d.message?.content)) return;
  for (const b of d.message.content) {
    if (b?.type !== 'tool_use' || !b.input || typeof b.input !== 'object') continue;
    if (b.name === 'Bash') {
      const p = progressOfCommand(b.input.command);
      if (p !== undefined) st.progress = p;
    } else if (b.name === 'TodoWrite') {
      const p = fromTodos(b.input.todos);
      if (p !== undefined) st.progress = p;
    } else if (b.name === 'TaskCreate' || b.name === 'TaskUpdate') {
      st.tasks = applyTask(Array.isArray(st.tasks) ? st.tasks : [], b.name, b.input);
      st.progress = fromTasks(st.tasks);
    }
  }
}

// How an agent runs Kadans: `kadans` when it is on PATH, else this checkout's bin the way `kadans install` writes hooks.
export function progressProgram(pathVar = process.env.PATH ?? '') {
  for (const d of pathVar.split(delimiter)) {
    if (!d) continue;
    try {
      accessSync(join(d, 'kadans'), constants.X_OK);
      return 'kadans';
    } catch {
      // next
    }
  }
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
  return `node '${bin.replace(/'/g, "'\\''")}'`;
}

// The line the lean brief (SessionStart) adds.
// Chained onto a command the agent runs anyway, it costs no extra model request.
export const progressHint = (prog = 'kadans') => `With 3+ steps, end a command you run anyway with \`; ${prog} progress <done>/<total> "<step>"\`.`;
