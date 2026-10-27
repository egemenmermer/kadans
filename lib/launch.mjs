// `kadans task start` and `kadans agent replace`: open a new Claude Code session for an approved task.
// Both ways run one one-shot script, $KADANS_HOME/run/task-<id>.command, that becomes `claude` on the owner's own account
// (CLAUDE_CONFIG_DIR unset, so never another account profile):
//   Orca worktree -> `orca terminal create --worktree path:<dir> --command "/bin/zsh '<file>'"` (argv to orca);
//   otherwise     -> Terminal.app (`open -a Terminal <file>`).
// Every check runs before anything changes; --dry-run only prints the plan.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readProjects, readTasks, updateTask } from './store.mjs';

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

// Throws a plain-language error unless the task can start now: queued, approved, project folder present.
export function checkStartable(home, ref) {
  const id = String(ref ?? '').trim();
  if (!/^\d+$/.test(id)) throw new Error(`not a task number: ${ref}`);
  const task = readTasks(home).find((t) => String(t.id) === id);
  if (!task) throw new Error(`unknown task: ${id}`);
  if (task.status !== 'queued') throw new Error(`task #${id} is not queued (${task.status})`);
  if (task.approved !== true) throw new Error(`task #${id} is not approved yet (kadans approve ${id})`);
  const project = readProjects(home).find((p) => String(p.id) === String(task.projectId));
  if (!project) throw new Error(`task #${id} has no project`);
  let dir = false;
  try {
    dir = statSync(project.path).isDirectory();
  } catch {
    // missing
  }
  if (!dir) throw new Error(`project folder not found: ${project.path}`);
  return { task, project };
}

// The Orca worktree whose folder is exactly dir, or null (no Orca, failure, or not an Orca worktree).
export function orcaWorktree(run, dir) {
  if (!run) return null;
  try {
    const list = JSON.parse(run(['worktree', 'list', '--json'])).result?.worktrees ?? [];
    const want = real(dir);
    const hit = list.find((w) => typeof w?.path === 'string' && !w.isArchived && real(w.path) === want);
    return hit ? hit.path : null;
  } catch {
    return null;
  }
}

export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The one-shot script. It deletes itself, then becomes `claude` in the project folder on the owner's own account.
export function commandScript({ dir, text, sessionId, taskId }) {
  const sep = String(text).startsWith('-') ? ' --' : '';
  return [
    '#!/bin/zsh -l',
    `# Kadans: task #${taskId}. One-shot: removes itself, then starts Claude Code in the project folder.`,
    'rm -f -- "$0"',
    'unset CLAUDE_CONFIG_DIR # the own account (~/.claude), never another account profile',
    `cd -- ${shq(dir)} || exit 1`,
    `exec claude --session-id ${sessionId}${sep} ${shq(text)}`,
    '',
  ].join('\n');
}

// What `task start` would do: { how: 'orca' | 'terminal', dir, file, script, sessionId, argv }. Writes nothing.
// argv: for 'orca' the orca CLI arguments, for 'terminal' the full command.
export function startPlan(home, { task, project }, { run = null, uuid = randomUUID } = {}) {
  const dir = project.path;
  const sessionId = uuid();
  const file = join(home, 'run', `task-${task.id}.command`);
  const script = commandScript({ dir, text: task.text, sessionId, taskId: task.id });
  const wt = orcaWorktree(run, dir);
  if (wt) {
    const argv = ['terminal', 'create', '--worktree', `path:${wt}`, '--title', `Kadans #${task.id}`, '--command', `/bin/zsh ${shq(file)}`, '--focus', '--json'];
    return { how: 'orca', dir, file, script, sessionId, argv };
  }
  return { how: 'terminal', dir, file, script, sessionId, argv: ['/usr/bin/open', '-a', 'Terminal', file] };
}

export function describePlan(plan, task) {
  const words = (argv) => argv.map((a) => (/^[\w:/.@-]+$/.test(a) ? a : shq(a))).join(' ');
  const lines = [`would start task #${task.id} in ${plan.dir}`];
  lines.push(`  write ${plan.file}:`, ...plan.script.trimEnd().split('\n').map((l) => `    ${l}`));
  lines.push(`  ${plan.how === 'orca' ? 'orca ' : ''}${words(plan.argv)}`);
  lines.push(`  then mark task #${task.id} running`);
  return `${lines.join('\n')}\n`;
}

function openTerminal(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) throw new Error(`open failed: ${(r.stderr || r.error?.message || '').trim().slice(0, 200)}`);
}

// Claims the task (re-checked under the store lock), then opens the session; puts the task back if opening fails.
// deps: { run (orca runner), exec (argv runner for Terminal.app), now }. Returns { task, how }.
// claimedBy = the new session's id (claude --session-id), both ways.
export function startTask(home, ref, plan, { run = null, exec = openTerminal, now = Date.now() } = {}) {
  const task = updateTask(home, ref, { status: 'running', claimedBy: plan.sessionId, startedAt: now }, (t) => {
    if (t.status !== 'queued') throw new Error(`task #${t.id} is not queued (${t.status})`);
    if (t.approved !== true) throw new Error(`task #${t.id} is not approved yet`);
  });
  try {
    if (plan.how === 'orca' && !run) throw new Error('the orca CLI is not available');
    mkdirSync(join(home, 'run'), { recursive: true, mode: 0o700 });
    writeFileSync(plan.file, plan.script, { mode: 0o700 });
    chmodSync(plan.file, 0o700);
    if (plan.how === 'orca') run(plan.argv);
    else exec(plan.argv);
    return { task, how: `opened in ${plan.how === 'orca' ? 'Orca' : 'Terminal'} (session ${plan.sessionId})` };
  } catch (e) {
    rmSync(plan.file, { force: true });
    updateTask(home, task.id, { status: 'queued', claimedBy: null, startedAt: null });
    throw new Error(`could not open a session for task #${task.id}: ${e.message}`);
  }
}

// Stop one agent, then start one task. Every check runs first, so a bad agent or task never stops anything.
// deps: { found: { agent } | { why }, check: () => ctx (throws), canStop(agent) -> { ok, why }, stop(agent), plan(ctx), start(ctx, plan) }.
export function replaceAgent({ found, check, canStop, stop, plan, start, dryRun = false }) {
  if (!found.agent) return { ok: false, why: found.why };
  let ctx;
  try {
    ctx = check();
  } catch (e) {
    return { ok: false, why: e.message };
  }
  const can = canStop(found.agent);
  if (!can.ok) return { ok: false, why: `cannot stop ${found.agent.id}: ${can.why}` };
  const p = plan(ctx);
  if (dryRun) return { ok: true, dryRun: true, stop: can.how, ctx, plan: p };
  const r = stop(found.agent);
  if (!r.ok) return { ok: false, why: `not stopped: ${r.why}` };
  const s = start(ctx, p);
  return { ok: true, stop: r.how, ...s };
}
