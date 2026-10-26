import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addProject, addTask, readTasks } from '../lib/store.mjs';
import { appendEvent } from '../lib/agents.mjs';
import { checkStartable, commandScript, replaceAgent, shq, startPlan, startTask } from '../lib/launch.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');

// A temp KADANS_HOME with one project folder and three tasks: #1 approved, #2 not approved, #3 approved but done.
// Nothing here opens Terminal.app or Orca: the CLI runs only with --dry-run and KADANS_ORCA=0, the lib with fakes.
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'kadans-launch-'));
  const home = join(root, 'kadans');
  const proj = join(root, "it's a proj");
  mkdirSync(proj, { recursive: true });
  addProject(home, { name: 'P', path: proj });
  addTask(home, { project: 'P', text: "fix the 'quote' $HOME `x`\nand a second line", approved: true });
  addTask(home, { project: 'P', text: 'needs an OK' });
  addTask(home, { project: 'P', text: 'already done', approved: true });
  const list = JSON.parse(readFileSync(join(home, 'tasks.json'), 'utf8'));
  list[2].status = 'done';
  writeFileSync(join(home, 'tasks.json'), JSON.stringify(list));
  const env = { PATH: process.env.PATH, HOME: root, KADANS_HOME: home, CLAUDE_CONFIG_DIR: join(root, 'claude'), KADANS_ORCA: '0' };
  return { root, home, proj, env };
}

const cli = (sb, args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { env: sb.env, encoding: 'utf8', timeout: 15000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('checkStartable: only approved, queued tasks with a project folder', () => {
  const sb = sandbox();
  assert.equal(checkStartable(sb.home, '1').task.id, 1);
  assert.throws(() => checkStartable(sb.home, '2'), /not approved/);
  assert.throws(() => checkStartable(sb.home, '3'), /not queued \(done\)/);
  assert.throws(() => checkStartable(sb.home, '9'), /unknown task: 9/);
  assert.throws(() => checkStartable(sb.home, '-1'), /not a task number/);
  rmSync(sb.proj, { recursive: true });
  assert.throws(() => checkStartable(sb.home, '1'), /project folder not found/);
});

test('shq / commandScript: task text reaches claude unchanged (quotes, $, backticks, newlines)', () => {
  const text = "it's $HOME and `whoami`\nline two \\ end";
  const r = spawnSync('/bin/sh', ['-c', `printf %s ${shq(text)}`], { encoding: 'utf8' });
  assert.equal(r.stdout, text);
  const s = commandScript({ dir: "/tmp/it's here", text: '-dash first', sessionId: 'abc', taskId: 4 });
  assert.match(s, /^#!\/bin\/zsh -l\n/);
  assert.match(s, /\nunset CLAUDE_CONFIG_DIR .*\ncd -- /); // never another account profile
  assert.match(s, /cd -- '\/tmp\/it'\\''s here' \|\| exit 1/);
  assert.match(s, /exec claude --session-id abc -- '-dash first'\n$/);
});

test('task start --dry-run: prints the Terminal plan, changes nothing', () => {
  const sb = sandbox();
  const before = readFileSync(join(sb.home, 'tasks.json'), 'utf8');
  const r = cli(sb, ['task', 'start', '1', '--dry-run']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^dry run: nothing changed\nwould start task #1 in /);
  assert.match(r.out, /write .*\/run\/task-1\.command:/);
  assert.match(r.out, /exec claude --session-id [0-9a-f-]{36} 'fix the '\\''quote'\\'' \$HOME `x`/);
  assert.match(r.out, /\/usr\/bin\/open -a Terminal .*task-1\.command/);
  assert.equal(readFileSync(join(sb.home, 'tasks.json'), 'utf8'), before);
  assert.equal(existsSync(join(sb.home, 'run')), false);
  // refusals, also in a dry run
  assert.match(cli(sb, ['task', 'start', '2', '--dry-run']).err, /not approved yet/);
  assert.equal(cli(sb, ['task', 'start', '3', '--dry-run']).code, 2);
});

test('startPlan: an Orca worktree gets an Orca terminal running the same one-shot script', () => {
  const sb = sandbox();
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return JSON.stringify({ ok: true, result: { worktrees: [{ path: '/elsewhere' }, { path: sb.proj, isArchived: false }] } });
  };
  const ctx = checkStartable(sb.home, '1');
  const plan = startPlan(sb.home, ctx, { run, uuid: () => 'u-1' });
  assert.equal(plan.how, 'orca');
  const file = join(sb.home, 'run', 'task-1.command');
  assert.deepEqual(plan.argv, ['terminal', 'create', '--worktree', `path:${sb.proj}`, '--title', 'Kadans #1', '--command', `/bin/zsh ${shq(file)}`, '--focus', '--json']);
  assert.equal(plan.file, file);
  assert.match(plan.script, /unset CLAUDE_CONFIG_DIR/);
  assert.match(plan.script, /exec claude --session-id u-1 /);
  assert.deepEqual(calls, [['worktree', 'list', '--json']]);
  assert.equal(startPlan(sb.home, ctx, { run: () => 'not json' }).how, 'terminal'); // a broken Orca: Terminal.app
});

test('startTask: marks running, writes the one-shot script, opens it; a failed open puts the task back', () => {
  const sb = sandbox();
  const ctx = checkStartable(sb.home, '1');
  const plan = startPlan(sb.home, ctx, { uuid: () => '11111111-2222-3333-4444-555555555555' });
  const opened = [];
  const r = startTask(sb.home, 1, plan, { exec: (argv) => opened.push(argv), now: 1000 });
  assert.match(r.how, /Terminal/);
  const t = readTasks(sb.home)[0];
  assert.deepEqual([t.status, t.claimedBy, t.startedAt], ['running', '11111111-2222-3333-4444-555555555555', 1000]);
  assert.deepEqual(opened, [['/usr/bin/open', '-a', 'Terminal', plan.file]]);
  assert.equal(statSync(plan.file).mode & 0o777, 0o700);
  assert.match(readFileSync(plan.file, 'utf8'), /rm -f -- "\$0"/);
  assert.throws(() => startTask(sb.home, 1, plan, { exec: () => {} }), /not queued/); // no double start
  // failure path
  const sb2 = sandbox();
  const plan2 = startPlan(sb2.home, checkStartable(sb2.home, '1'));
  assert.throws(() => startTask(sb2.home, 1, plan2, { exec: () => { throw new Error('boom'); } }), /could not open a session for task #1: boom/);
  const back = readTasks(sb2.home)[0];
  assert.deepEqual([back.status, back.claimedBy, back.startedAt], ['queued', null, null]);
  assert.equal(existsSync(plan2.file), false); // the script is removed again
  // Orca: script written, then the orca CLI asked for a terminal; the claim is the session id
  const sb3 = sandbox();
  const calls = [];
  const orcaPlan = { ...startPlan(sb3.home, checkStartable(sb3.home, '1'), { uuid: () => 'u-3' }), how: 'orca', argv: ['terminal', 'create'] };
  const r3 = startTask(sb3.home, 1, orcaPlan, { run: (args) => { calls.push([args, existsSync(orcaPlan.file)]); return '{}'; } });
  assert.deepEqual(calls, [[['terminal', 'create'], true]]);
  assert.match(r3.how, /Orca/);
  assert.equal(readTasks(sb3.home)[0].claimedBy, 'u-3');
});

test('replaceAgent: every check before the stop; stop, then start', () => {
  const log = [];
  const deps = (over = {}) => ({
    found: { agent: { id: 'A' } },
    check: () => ({ task: { id: 1 } }),
    canStop: () => ({ ok: true, how: 'would stop A' }),
    stop: () => { log.push('stop'); return { ok: true, how: 'stopped A' }; },
    plan: () => { log.push('plan'); return { how: 'terminal' }; },
    start: () => { log.push('start'); return { task: { id: 1 }, how: 'opened' }; },
    ...over,
  });
  assert.deepEqual(replaceAgent(deps({ check: () => { throw new Error('unknown task: 99'); } })), { ok: false, why: 'unknown task: 99' });
  assert.deepEqual(replaceAgent(deps({ found: { why: 'no agent with id x' } })), { ok: false, why: 'no agent with id x' });
  assert.equal(replaceAgent(deps({ canStop: () => ({ ok: false, why: 'no pid' }) })).why, 'cannot stop A: no pid');
  assert.deepEqual(log, []); // nothing stopped, nothing planned
  assert.equal(replaceAgent(deps({ dryRun: true })).dryRun, true);
  assert.deepEqual(log, ['plan']);
  log.length = 0;
  const r = replaceAgent(deps());
  assert.deepEqual([r.ok, r.stop, r.how], [true, 'stopped A', 'opened']);
  assert.deepEqual(log, ['plan', 'stop', 'start']);
});

test('cli agent replace: a bad task id is refused before anything is stopped', () => {
  const sb = sandbox();
  const now = Date.now();
  // A live agent with a pid that is not a claude process: even a real stop could not kill anything.
  appendEvent(sb.home, { t: now - 1000, ev: 'UserPromptSubmit', sid: 'sess-aaaa-1', cwd: sb.proj, transcript: null, prompt: 'p' }, now);
  const before = readFileSync(join(sb.home, 'tasks.json'), 'utf8');
  const bad = cli(sb, ['agent', 'replace', 'sess-aaaa-1', '99']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /not replaced: unknown task: 99/);
  assert.match(cli(sb, ['agent', 'replace', 'sess-aaaa-1', '2', '--dry-run']).err, /not replaced: task #2 is not approved/);
  assert.match(cli(sb, ['agent', 'replace', 'nobody-here', '1', '--dry-run']).err, /not replaced: no running agent/);
  // a valid task, but this agent has no pid or Orca terminal: refused before stopping or starting
  assert.match(cli(sb, ['agent', 'replace', 'sess-aaaa-1', '1', '--dry-run']).err, /not replaced: cannot stop sess-aaaa-1: no pid recorded/);
  assert.equal(readFileSync(join(sb.home, 'tasks.json'), 'utf8'), before);
  assert.match(cli(sb, ['agents']).out, /sess-aaa/); // still listed
});

test('cli agent title: set and clear by id prefix', () => {
  const sb = sandbox();
  const now = Date.now();
  appendEvent(sb.home, { t: now - 1000, ev: 'UserPromptSubmit', sid: 'sess-bbbb-2', cwd: sb.proj, transcript: null, prompt: 'p' }, now);
  assert.match(cli(sb, ['agent', 'title', 'sess-bbbb', 'My', 'build']).out, /sess-bbbb-2: title set: My build/);
  assert.match(cli(sb, ['agents']).out, /My build/);
  assert.match(cli(sb, ['agent', 'title', 'sess-bbbb', '']).out, /title cleared/);
});
