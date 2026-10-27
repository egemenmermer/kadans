// k23-hardening: private file modes, lock ownership, control characters in titles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addProject, addTask, ensureHome, updateHookState, withLock, writeAtomic } from '../lib/store.mjs';
import { appendEvent, renderAgents } from '../lib/agents.mjs';
import { appendSample } from '../lib/samples.mjs';
import { setSetting } from '../lib/config.mjs';
import { setAutopace } from '../lib/pace-control.mjs';
import { cleanTitle, cut, pickTitle, readTitles, setTitle } from '../lib/titles.mjs';
import { stripControl } from '../lib/text.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'kadans-hard-'));
const mode = (p) => statSync(p).mode & 0o777;
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [join(dir, e.name), ...walk(join(dir, e.name))] : [join(dir, e.name)]));

test('private files: a wide existing home is tightened, every file is 0600 and every dir 0700', () => {
  const home = tmp();
  chmodSync(home, 0o755);
  const old = process.umask(0o022);
  try {
    addProject(home, { name: 'Alpha', path: '/x/a' });
    addTask(home, { project: 'alpha', text: 'a task' });
    updateHookState(home, (s) => { s.feeds.x = 1; });
    appendEvent(home, { ev: 'UserPromptSubmit', session: 's1', prompt: 'secret prompt', t: Date.now() });
    appendSample(home, 'acct', { t: Date.now(), five_hour: { pct: 10, resetsAt: 1 } });
    appendSample(home, 'acct', { t: Date.now() + 1, five_hour: { pct: 11, resetsAt: 1 } }, Date.now() + 9 * 24 * 3600 * 1000); // forces the rewrite path
    setTitle(home, 'abc', 'my title');
    setSetting(home, 'usageApi', 'false');
    setAutopace(home, true);
  } finally {
    process.umask(old);
  }
  assert.equal(mode(home), 0o700);
  const all = walk(home);
  assert.ok(all.length >= 8, `expected several files, got ${all.length}`);
  for (const p of all) {
    const want = statSync(p).isDirectory() ? 0o700 : 0o600;
    assert.equal(mode(p), want, `${p} is ${mode(p).toString(8)}`);
  }
  assert.ok(!all.some((p) => p.endsWith('.tmp')), 'no temp files left');
});

test('private files: a new home is created 0700 even under umask 022; writeAtomic replaces a wide leftover temp file', () => {
  const root = tmp();
  const home = join(root, 'deep', 'home');
  const old = process.umask(0o022);
  try {
    ensureHome(home);
    assert.equal(mode(home), 0o700);
    const f = join(home, 'x.json');
    writeFileSync(`${f}.${process.pid}.tmp`, 'old', { mode: 0o666 });
    writeAtomic(f, 'new\n');
    assert.equal(readFileSync(f, 'utf8'), 'new\n');
    assert.equal(mode(f), 0o600);
  } finally {
    process.umask(old);
  }
});

// A child that holds the lock for holdMs after waiting startMs; logs enter/exit times to a file.
function holder({ home, name, startMs, holdMs, staleMs, epoch }) {
  const code = `
    import { appendFileSync } from 'node:fs';
    import { withLock } from ${JSON.stringify(new URL('../lib/store.mjs', import.meta.url).href)};
    const [home, name, startMs, holdMs, staleMs, epoch] = process.argv.slice(1);
    const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    nap(Math.max(0, Number(epoch) + Number(startMs) - Date.now())); // start relative to a shared epoch, so a slow process start does not skew the schedule
    let enter = 0;
    try {
      withLock(home, () => {
        enter = Date.now();
        nap(Number(holdMs));
        appendFileSync(home + '/' + name + '.log', enter + ' ' + Date.now() + '\\n');
      }, { staleMs: Number(staleMs), waitMs: 5000 });
    } catch (e) {
      appendFileSync(home + '/' + name + '.err', e.message + '\\n');
      process.exit(3);
    }
  `;
  return new Promise((res) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code, home, name, startMs, holdMs, staleMs, epoch], { stdio: 'ignore' });
    p.on('close', (c) => res(c));
  });
}

test('lock: a slow holder that was taken over does not delete the new holder lock (three-writer race)', async () => {
  const home = tmp();
  const staleMs = 500;
  const epoch = Date.now() + 3000; // children are up and waiting by then, even on a loaded machine
  // A holds 800 ms (stale after 500): B takes over at ~500 and holds 350 ms; A releases at ~800 while B is inside;
  // C starts at 820 and must wait for B. Before the fix A's release removed B's lock and C got in at once.
  const [a, b, c] = await Promise.all([
    holder({ home, name: 'A', startMs: 0, holdMs: 800, staleMs, epoch }),
    holder({ home, name: 'B', startMs: 50, holdMs: 350, staleMs, epoch }),
    holder({ home, name: 'C', startMs: 820, holdMs: 100, staleMs, epoch }),
  ]);
  assert.equal(b, 0);
  assert.equal(c, 0);
  assert.equal(a, 3, 'A lost its lock and says so');
  assert.match(readFileSync(join(home, 'A.err'), 'utf8'), /taken over/);
  const span = (n) => readFileSync(join(home, `${n}.log`), 'utf8').trim().split(' ').map(Number);
  const [bIn, bOut] = span('B');
  const [cIn, cOut] = span('C');
  assert.ok(bOut - bIn >= 300, 'B held the lock for its full time');
  assert.ok(cIn >= bOut, `C entered at ${cIn - bIn} ms after B started, B left at ${bOut - bIn}: no overlap`);
  assert.ok(cOut > cIn);
  assert.ok(!existsSync(join(home, '.lock')), 'the lock is gone at the end');
});

test('lock: release removes only our own lock; a plain nested use still works', () => {
  const home = tmp();
  assert.equal(withLock(home, () => 7), 7);
  assert.ok(!existsSync(join(home, '.lock')));
  assert.throws(() => withLock(home, () => { throw new Error('boom'); }), /boom/);
  assert.ok(!existsSync(join(home, '.lock')));
  // someone else takes the lock while we are inside: we leave it alone and throw
  assert.throws(
    () => withLock(home, () => { writeFileSync(join(home, '.lock', 'owner'), 'other.token'); }),
    /taken over/,
  );
  assert.equal(readFileSync(join(home, '.lock', 'owner'), 'utf8'), 'other.token');
});

const ESC_TITLE = '\x1b]0;pwned\x07\x1b[31mFix the login bug';
const BIDI = '\u202eFix the \u2066login\u2069 bug\u200b';

test('control characters: cleanTitle, cut and stripControl drop ESC, BEL, bidi and zero-width, keep \\n and \\t', () => {
  const t = cleanTitle(ESC_TITLE);
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(t), JSON.stringify(t));
  assert.ok(!t.includes('\x1b') && !t.includes('\x07'));
  assert.equal(cleanTitle(BIDI), 'Fix the login bug');
  assert.equal(cut(BIDI), 'Fix the login bug');
  assert.equal(stripControl('a\tb\nc\x1b[0md\u202ee\x00f\x9b'), 'a\tb\nc[0mdef');
  assert.equal(cleanTitle('fix it\rsecond thing here to read'), 'Fix it second thing here to read');
});

test('control characters: setTitle and pickTitle store and return clean text', () => {
  const home = tmp();
  const v = setTitle(home, 'abc', ESC_TITLE);
  assert.ok(!/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(v), JSON.stringify(v));
  assert.equal(setTitle(home, 'def', BIDI), 'Fix the login bug');
  assert.ok(!readFileSync(join(home, 'titles.json'), 'utf8').includes('\\u001b'));
  assert.equal(pickTitle({ id: 'x', owner: BIDI }).title, 'Fix the login bug');
  assert.ok(!/[\x00-\x1f]/.test(pickTitle({ id: 'x', scan: { aiTitle: ESC_TITLE } }).title));
  assert.equal(Object.keys(readTitles(home)).length, 2);
});

test('control characters: renderAgents prints no escape sequences from any field', () => {
  const row = {
    id: 'abcdef123456', source: 'orca', status: 'working', project: 'p\x1b]0;x\x07', model: 'm', tokens: 1, lastSeen: 0,
    subagents: [], title: null, firstPrompt: ESC_TITLE, orca: { title: ESC_TITLE }, pace: { mode: 'none' },
  };
  const out = renderAgents([row], 1000, { all: true });
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e]/.test(out), JSON.stringify(out));
  const out2 = renderAgents([{ ...row, title: ESC_TITLE, firstPrompt: null }], 1000, { all: true });
  assert.ok(!out2.includes('\x1b'));
});

