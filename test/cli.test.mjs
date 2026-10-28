import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountKey } from '../lib/samples.mjs';
import { appendEvent } from '../lib/agents.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');

// Every run gets temp KADANS_HOME, HOME and CLAUDE_CONFIG_DIR: the real ~/.kadans and ~/.claude are never touched.
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'kadans-cli-'));
  const home = join(root, 'kadans');
  const claude = join(root, 'claude');
  mkdirSync(home);
  mkdirSync(claude);
  return { root, home, claude, env: { PATH: process.env.PATH, HOME: root, KADANS_HOME: home, CLAUDE_CONFIG_DIR: claude, KADANS_ORCA: '0' } };
}

function run(sb, args, input = '') {
  const r = spawnSync(process.execPath, [BIN, ...args], { input, env: sb.env, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function setConfig(sb, cfg) {
  writeFileSync(join(sb.home, 'config.json'), JSON.stringify(cfg));
}

function fakeChain(sb, body) {
  const file = join(sb.root, 'fake-chain.sh');
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

const payload = (pct = 59) =>
  JSON.stringify({
    session_id: 's1',
    cwd: '/work',
    rate_limits: { five_hour: { used_percentage: pct, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
  });

test('statusline prints one line and records a sample', () => {
  const sb = sandbox();
  const r = run(sb, ['statusline'], payload(59));
  assert.equal(r.code, 0);
  assert.match(r.out, /^5h 59% · .* · LOW DATA\n$/);
  const file = join(sb.home, 'accounts', accountKey(sb.claude), 'samples.jsonl');
  assert.ok(existsSync(file));
  assert.equal(JSON.parse(readFileSync(file, 'utf8').trim()).session_id, 's1');
});

test('chain gets the same stdin and its stdout is dropped', () => {
  const sb = sandbox();
  const seen = join(sb.root, 'chain-stdin.json');
  const chain = fakeChain(sb, `cat > "${seen}"\necho CHAIN_OUT\necho CHAIN_ERR 1>&2\nexit 1`);
  setConfig(sb, { chain });
  const input = payload(33);
  const r = run(sb, ['statusline'], input);
  assert.equal(r.code, 0);
  assert.equal(readFileSync(seen, 'utf8'), input);
  assert.ok(!r.out.includes('CHAIN_OUT'));
  assert.match(r.out, /^5h 33% /);
});

test('missing chain is skipped', () => {
  const sb = sandbox();
  setConfig(sb, { chain: join(sb.root, 'nope.sh') });
  const r = run(sb, ['statusline'], payload(10));
  assert.equal(r.code, 0);
  assert.match(r.out, /^5h 10% /);
});

test('bad stdin never fails the status line', () => {
  const sb = sandbox();
  const r = run(sb, ['statusline'], '{not json');
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
});

test('payload without rate_limits and no stored samples prints nothing', () => {
  const sb = sandbox();
  const r = run(sb, ['statusline'], JSON.stringify({ session_id: 'x' }));
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
});

test('status lists recorded accounts', () => {
  const sb = sandbox();
  assert.match(run(sb, ['status']).out, /no accounts recorded yet/);
  run(sb, ['statusline'], payload(41));
  const r = run(sb, ['status']);
  assert.equal(r.code, 0);
  assert.ok(r.out.startsWith(accountKey(sb.claude)), r.out);
  assert.match(r.out, /5h 41% .*\(last sample 0m ago\)/);
});

test('help and unknown command', () => {
  const sb = sandbox();
  const h = run(sb, ['--help']);
  assert.equal(h.code, 0);
  assert.match(h.out, /statusline/);
  assert.match(h.out, /status/);
  assert.equal(run(sb, ['nope']).code, 2);
});

test('queue CLI round trip (English commands, Turkish aliases, English output)', () => {
  const sb = sandbox();
  const proj = join(sb.root, 'proj');
  mkdirSync(proj);
  let r = run(sb, ['project', 'add', 'Alpha', proj, '--importance', 'high']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /project added: #1 Alpha \(importance: high\)/);
  r = run(sb, ['proje', 'ekle', 'Beta', proj]);
  assert.match(r.out, /#2 Beta \(importance: normal\)/);
  assert.equal(run(sb, ['project', 'add', 'Alpha', proj]).code, 2); // duplicate
  r = run(sb, ['proje', 'liste']);
  assert.match(r.out, /#1  Alpha  importance: high/);
  assert.match(r.out, /#2  Beta  importance: normal/);

  assert.match(run(sb, ['task', 'add', 'Beta', 'idle job', '--idle']).out, /task added: #1 \[idle\] idle job/);
  assert.match(run(sb, ['ekle', 'Beta', 'weekly job', '--hafta']).out, /#2 \[week\]/);
  assert.match(run(sb, ['ekle', 'alpha', 'fire', '--acil']).out, /#3 \[urgent\]/);
  assert.match(run(sb, ['task', 'add', '1', 'default urgency']).out, /#4 \[week\]/);
  assert.equal(run(sb, ['task', 'add', 'Nope', 'x']).code, 2);
  assert.equal(run(sb, ['task', 'add', 'Beta', 'x', '--urgent', '--idle']).code, 2);

  r = run(sb, ['task', 'list']);
  const ids = r.out.trim().split('\n').map((l) => l.match(/^\d+\. #(\d+)/)[1]);
  assert.deepEqual(ids, ['3', '4', '2', '1']); // urgent/high, week/high, week/normal, idle/normal
  assert.match(r.out.split('\n')[0], /1\. #3  \[urgent\]  Alpha  fire  \(score 4.00\)/);
  assert.equal(run(sb, ['liste']).out, r.out);

  assert.match(run(sb, ['task', 'done', '3']).out, /task #3 done: fire/);
  assert.match(run(sb, ['task', 'skip', '1']).out, /task #1 skipped/);
  assert.equal(run(sb, ['task', 'done', '3']).code, 2); // already done
  assert.equal(run(sb, ['task', 'done', '99']).code, 2);
  r = run(sb, ['liste']);
  assert.deepEqual(r.out.trim().split('\n').map((l) => l.match(/^\d+\. #(\d+)/)[1]), ['4', '2']);
  r = run(sb, ['task', 'list', '--all']);
  assert.match(r.out, /-  #3 .*\(done\)/);
  assert.match(r.out, /-  #1 .*\(skipped\)/);
  const tasks = JSON.parse(readFileSync(join(sb.home, 'tasks.json'), 'utf8'));
  assert.equal(tasks.find((t) => t.id === 3).status, 'done');
  assert.equal(typeof tasks.find((t) => t.id === 3).doneAt, 'number');
});

test('statusline gives up on a held store lock (bounded wait): still prints the gauge, skips the sample', () => {
  const sb = sandbox();
  const dir = join(sb.home, 'accounts', accountKey(sb.claude));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'samples.jsonl');
  const old = JSON.stringify({ t: Date.now() - 60_000, limits: { five_hour: { pct: 40, resetsAt: Date.now() + 3_600_000 } } });
  writeFileSync(file, `${old}\n`);
  mkdirSync(join(sb.home, '.lock')); // a fresh lock held by someone else (not stale)
  const t0 = Date.now();
  const r = run(sb, ['statusline'], payload(59));
  const ms = Date.now() - t0;
  assert.equal(r.code, 0);
  assert.ok(ms < 40_000, `statusline waited ${ms} ms on the lock`); // gave up (2 s lock wait), did not hang; generous for a loaded machine (spawn timeout is 60 s)
  assert.match(r.out, /^5h 40% /); // gauge from the samples already on disk
  assert.equal(readFileSync(file, 'utf8'), `${old}\n`); // the new sample was not written
});

test('agent order: stores listed ids (prefixes resolved), refuses unknown ids and empty calls', () => {
  const sb = sandbox();
  const now = Date.now();
  for (const sid of ['sess-one', 'sess-two']) appendEvent(sb.home, { t: now - 1000, ev: 'UserPromptSubmit', sid, cwd: '/opt/p', transcript: null, prompt: 'go' }, now);
  const file = join(sb.home, 'order.json');
  assert.match(run(sb, ['agent', 'order']).err, /usage: kadans agent order/);
  const bad = run(sb, ['agent', 'order', 'sess-two', 'nope-nope']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /order not saved: no running agent with id nope-nope/);
  assert.equal(existsSync(file), false);
  const ok = run(sb, ['agent', 'order', 'sess-t', 'sess-one']);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /order saved: 2 agents first/);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ids: ['sess-two', 'sess-one'] });
  const list = JSON.parse(run(sb, ['agents', '--json']).out);
  assert.deepEqual(list.map((a) => [a.id, a.ordered]), [['sess-two', true], ['sess-one', true]]);
});
