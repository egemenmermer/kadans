import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEP_CHARS, progressHint, progressOfCommand, progressProgram } from '../lib/progress.mjs';
import { BRIEF } from '../lib/lean.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
const P = (done, total, step = null) => ({ done, total, step });

test('progressOfCommand: the command forms agents use', () => {
  assert.deepEqual(progressOfCommand('kadans progress 3/5 "Writing tests"'), P(3, 5, 'Writing tests'));
  assert.deepEqual(progressOfCommand("kadans progress 3/5 'Writing tests'"), P(3, 5, 'Writing tests'));
  assert.deepEqual(progressOfCommand('kadans progress 3/5 Writing tests'), P(3, 5, 'Writing tests'));
  assert.deepEqual(progressOfCommand('kadans progress 0/4'), P(0, 4));
  assert.deepEqual(progressOfCommand('cd /opt/app && kadans progress 2/4 "Build"; echo ok'), P(2, 4, 'Build'));
  assert.deepEqual(progressOfCommand("node '/opt/my apps/kadans/bin/kadans.mjs' progress 1/2 \"Say \\\"hi\\\"\""), P(1, 2, 'Say "hi"'));
  assert.deepEqual(progressOfCommand('./bin/kadans.mjs progress 1/3 "a" && kadans progress 2/3 "b"'), P(2, 3, 'b'), 'the last one wins');
  for (const tail of [' 2>&1', ' >/dev/null', ' | tail -1', '>/dev/null 2>&1', ' &']) {
    assert.deepEqual(progressOfCommand(`kadans progress 3/5 "Writing tests"${tail}`), P(3, 5, 'Writing tests'), tail);
    assert.deepEqual(progressOfCommand(`kadans progress 3/5 Writing tests${tail}`), P(3, 5, 'Writing tests'), `unquoted${tail}`);
  }
  assert.deepEqual(progressOfCommand('kadans progress 1/2 Step 2 of the plan'), P(1, 2, 'Step 2 of the plan'));
});

test('progressOfCommand: mentions, bad numbers, clipping and control characters', () => {
  for (const c of ['grep -rn "kadans progress 1/2" lib', 'echo kadans progress 1/2', 'notkadans progress 1/2', 'kadans progress 0/0',
    'kadans progress 3', 'kadans progress a/b', 'kadans progresses 1/2', 'ls', 42, null]) assert.equal(progressOfCommand(c), undefined, String(c));
  assert.deepEqual(progressOfCommand('kadans progress 7/5 "Over"'), P(5, 5, 'Over'), 'done is clamped to total');
  const long = progressOfCommand(`kadans progress 1/2 "${'x'.repeat(200)}"`);
  assert.equal(long.step.length, STEP_CHARS);
  assert.deepEqual(progressOfCommand('kadans progress 1/2 "a\u001b[31mb‮c"'), P(1, 2, 'a[31mbc'));
  assert.deepEqual(progressOfCommand('kadans progress 1/2 ""'), P(1, 2, null));
});

test('the brief line, both ways of running Kadans, parses back', () => {
  assert.ok(BRIEF.endsWith(progressHint('kadans')));
  assert.ok(BRIEF.split(/\s+/).length <= 60);
  const prog = progressProgram('');
  assert.match(prog, /^node '.*\/bin\/kadans\.mjs'$/);
  for (const p of [prog, 'kadans']) {
    const cmd = /`(.*)`/.exec(progressHint(p))[1].replace('<done>/<total>', '2/7').replace('<step>', 'Wiring it');
    assert.deepEqual(progressOfCommand(cmd), P(2, 7, 'Wiring it'), cmd);
  }
});

test('kadans progress: a no-op for any arguments (exit 0, no output, no files)', () => {
  const home = mkdtempSync(join(tmpdir(), 'kadans-progress-'));
  const env = { ...process.env, KADANS_HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude') };
  for (const args of [['3/5', 'Writing tests'], [], ['nonsense', '--json']]) {
    const r = spawnSync(process.execPath, [BIN, 'progress', ...args], { env, encoding: 'utf8' });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], args.join(' '));
  }
  assert.deepEqual(readdirSync(home), []);
});
