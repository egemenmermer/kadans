import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addProject, addTask, findProject, readProjects, readTasks, updateTask, withLock } from '../lib/store.mjs';
import { readSamples } from '../lib/samples.mjs';

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const tmp = () => mkdtempSync(join(tmpdir(), 'kadans-store-'));

// Runs a module script in a child process; resolves with its exit code.
function child(code, args) {
  return new Promise((res) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { stdio: 'ignore' });
    p.on('close', res);
  });
}

test('store: projects and tasks round trip, ids, lookup by name or id', () => {
  const home = tmp();
  const a = addProject(home, { name: 'Alpha', path: '/x/a', importance: 'high' });
  const b = addProject(home, { name: 'Beta', path: '/x/b' });
  assert.deepEqual([a.id, b.id, b.importance], [1, 2, 'normal']);
  assert.throws(() => addProject(home, { name: 'alpha', path: '/y' }), /duplicate/);
  assert.throws(() => addProject(home, { name: 'C', path: '/y', importance: 'huge' }), /importance/);
  const t = addTask(home, { project: 'alpha', text: 'do it', urgency: 'urgent' }, 1000);
  assert.deepEqual(t, { id: 1, projectId: 1, text: 'do it', urgency: 'urgent', status: 'queued', approved: false, createdAt: 1000, claimedBy: null, startedAt: null, doneAt: null });
  assert.throws(() => addTask(home, { project: 'nope', text: 'x' }), /unknown project/);
  assert.equal(findProject(readProjects(home), '2').name, 'Beta');
  updateTask(home, 1, { status: 'done', doneAt: 5 });
  assert.equal(readTasks(home)[0].status, 'done');
  assert.throws(() => updateTask(home, 9, {}), /unknown task/);
});

test('store: missing or broken files read as empty', () => {
  const home = tmp();
  assert.deepEqual(readTasks(home), []);
  addProject(home, { name: 'A', path: '/a' });
  assert.equal(readProjects(home).length, 1);
});

test('lock: two concurrent writer processes lose no write', async () => {
  const home = tmp();
  addProject(home, { name: 'P', path: '/p' });
  const code = `import { addTask } from ${JSON.stringify(`${LIB}/store.mjs`)};
    const [home, who] = process.argv.slice(1);
    for (let i = 0; i < 40; i++) addTask(home, { project: 'P', text: who + i });`;
  const codes = await Promise.all([child(code, [home, 'a']), child(code, [home, 'b'])]);
  assert.deepEqual(codes, [0, 0]);
  const tasks = readTasks(home);
  assert.equal(tasks.length, 80);
  assert.equal(new Set(tasks.map((t) => t.id)).size, 80);
  assert.equal(existsSync(join(home, '.lock')), false);
});

test('lock: concurrent sample appends (with trim) share the same lock and lose nothing', async () => {
  const home = tmp();
  const code = `import { appendSample } from ${JSON.stringify(`${LIB}/samples.mjs`)};
    const [home, who] = process.argv.slice(1);
    const now = Date.now();
    // one old sample first so the first append trims (rewrites) the file
    appendSample(home, 'k', { t: now - 9 * 24 * 3600 * 1000, limits: {} }, now - 9 * 24 * 3600 * 1000);
    for (let i = 0; i < 40; i++) appendSample(home, 'k', { t: now + (who === 'a' ? 0 : 100000) + i, limits: { five_hour: { pct: i, resetsAt: now } } }, now);`;
  const codes = await Promise.all([child(code, [home, 'a']), child(code, [home, 'b'])]);
  assert.deepEqual(codes, [0, 0]);
  assert.equal(readSamples(home, 'k').length, 80);
});

test('lock: a stale lock (older than 30 s) is taken over, a fresh one times out', () => {
  const home = tmp();
  const lock = join(home, '.lock');
  mkdirSync(lock);
  assert.throws(() => withLock(home, () => 1, { waitMs: 150 }), /lock timeout/);
  const old = new Date(Date.now() - 31_000);
  utimesSync(lock, old, old);
  assert.equal(withLock(home, () => 'ok', { waitMs: 150 }), 'ok');
  assert.equal(existsSync(lock), false);
});

test('lock: released when the callback throws', () => {
  const home = tmp();
  assert.throws(() => withLock(home, () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(join(home, '.lock')), false);
});
