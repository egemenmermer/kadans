// k41: Settings › Computers: `kadans computers` list / add (pairing code on stdin only) / remove, through a fake orca.
// The fake code must never show up in stdout, stderr or any file under the test's temp root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODE_MAX, ERR, addComputer, listComputers, machineStatus, removeComputer, validCode, validName } from '../lib/computers.mjs';
import { REMOTE_OFFLINE_MS, REMOTE_STALE_MS } from '../lib/remote.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
const SECRET = `FAKEPAIR${randomBytes(12).toString('hex')}`;
const CODE = `orca://pair?code=${SECRET}`;
const TOKEN = 'FAKE-DEVICE-TOKEN-k41';

// A stateful fake orca (node script): environments live in envs.json; `environment add` compares the code's hash and
// logs only "ok" / "bad" in its place; the add answer carries a token that must never reach Kadans' output.
function sandbox({ envs = [{ id: 'env-1', name: 'kasa' }, { id: 'env-2', name: 'spare' }] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kadans-k41-'));
  const home = join(root, 'kadans');
  mkdirSync(home);
  const state = join(root, 'envs.json');
  const log = join(root, 'orca.log');
  writeFileSync(state, JSON.stringify(envs));
  const hash = createHash('sha256').update(CODE).digest('hex');
  const fake = join(root, 'fake-orca.mjs');
  writeFileSync(fake, `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const a = process.argv.slice(2);
const envs = JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8'));
const save = () => writeFileSync(${JSON.stringify(state)}, JSON.stringify(envs));
const val = (f) => a[a.indexOf(f) + 1];
const shown = a.map((x, i) => (a[i - 1] === '--pairing-code' ? (createHash('sha256').update(x).digest('hex') === '${hash}' ? 'ok' : 'bad') : x));
appendFileSync(${JSON.stringify(log)}, shown.join(' ') + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o));
const cmd = a[0] + ' ' + a[1];
if (cmd === 'environment list') out({ ok: true, result: { environments: envs.map((e) => ({ ...e, endpoints: [{ endpoint: 'ws://10.0.0.9' }], pairedDeviceId: 'dev' })) } });
else if (cmd === 'environment add') {
  if (shown[a.indexOf('--pairing-code') + 1] !== 'ok') { process.stderr.write('bad code ' + val('--pairing-code')); process.exit(1); }
  envs.push({ id: 'env-new', name: val('--name') }); save();
  out({ ok: true, result: { environment: { id: 'env-new', name: val('--name'), deviceToken: '${TOKEN}' } } });
} else if (cmd === 'environment rm') {
  const i = envs.findIndex((e) => e.id === val('--environment'));
  if (i < 0) process.exit(1);
  envs.splice(i, 1); save(); out({ ok: true });
} else if (cmd === 'worktree ps') {
  if (val('--environment') === 'env-2') process.exit(1);
  out({ ok: true, result: { worktrees: [{ repo: 'p', path: '/p', agents: [{ paneKey: 'a', state: 'working' }, { paneKey: 'b', state: 'idle' }] }] } });
} else process.exit(3);
`);
  const wrap = join(root, 'fake-orca.sh'); // node's path may hold spaces, which a #! line cannot
  writeFileSync(wrap, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(wrap, 0o755);
  const env = { PATH: process.env.PATH, HOME: root, KADANS_HOME: home, CLAUDE_CONFIG_DIR: join(root, 'claude'), KADANS_ORCA_BIN: wrap };
  const cli = (args, input = '') => {
    const r = spawnSync(process.execPath, [BIN, ...args], { input, env, encoding: 'utf8', timeout: 20000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const orcaLog = () => { try { return readFileSync(log, 'utf8'); } catch { return ''; } };
  return { root, home, cli, orcaLog, envs: () => JSON.parse(readFileSync(state, 'utf8')), done: () => rmSync(root, { recursive: true, force: true }) };
}

// Every file under dir, read as text: none may hold the secret.
function assertNotOnDisk(dir, needle) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) assertNotOnDisk(p, needle);
    else assert.ok(!readFileSync(p, 'latin1').includes(needle), `the pairing code is in ${p}`);
  }
}

test('computers: validation of the code and the name', () => {
  assert.equal(validCode(CODE), CODE);
  assert.equal(validCode(`  ${CODE}\n`), CODE, 'outer spaces and the trailing newline are dropped');
  assert.equal(validCode(`${CODE}\r\n`), CODE);
  for (const bad of [
    `orca://pair?code=ab cd`, `orca://pair?code="abc"`, `orca://pair?code='abc'`, `orca://pair?code=abc;rm -rf x`, `orca://pair?code=ab\ncd`,
    `orca://pair?code=ab\tcd`, `orca://pair?code=a\u0000b`, `orca://pair?code=a\`b\``, `orca://pair?code=$(id)`.replace('(', '<'),
    `https://pair?code=abc`, `orca://evil?code=abc`, `ORCA://pair?code=abc`, `orca://pair?`, '', 'abc', `--pairing-code`,
    `orca://pair?code=${'a'.repeat(CODE_MAX)}`, `orca://pair?code=é`, null, 42,
  ]) assert.equal(validCode(bad), null, JSON.stringify(bad));
  assert.equal(validCode(`orca://pair?code=${'a'.repeat(CODE_MAX - 17)}`)?.length, CODE_MAX, 'exactly 2048 is fine');
  for (const ok of ['PC', 'kasa', 'Work laptop', 'pc-2', 'Çalışma', '  PC  ']) assert.ok(validName(ok), ok);
  for (const bad of ['', ' ', '-x', '--json', 'a;b', 'a"b', "a'b", 'a\nb', 'a_b', 'a.b', 'x'.repeat(33), null]) assert.equal(validName(bad), null, JSON.stringify(bad));
  assert.equal(validName('x'.repeat(32)), 'x'.repeat(32));
});

test('computers: machine status from the k38 cache (online, stale, offline, unknown)', () => {
  const now = 10_000_000;
  assert.deepEqual(machineStatus(undefined, now), { status: 'unknown', agents: null });
  assert.deepEqual(machineStatus({ tried: now, t: now - 1000, agents: [1, 2] }, now), { status: 'online', agents: 2 });
  assert.deepEqual(machineStatus({ tried: now, t: now - REMOTE_STALE_MS - 1, agents: [1] }, now), { status: 'stale', agents: 1 });
  assert.deepEqual(machineStatus({ tried: now, t: now - REMOTE_OFFLINE_MS - 1, agents: [1] }, now), { status: 'offline', agents: 0 });
  assert.deepEqual(machineStatus({ tried: now, error: true }, now), { status: 'offline', agents: 0 });
  assert.deepEqual(machineStatus({ tried: now }, now), { status: 'offline', agents: 0 }, 'tried, never answered');
});

test('cli: computers --json lists name, id, status and agent count from the fake orca; text form too', () => {
  const sb = sandbox();
  try {
    const r = sb.cli(['computers', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), [
      { id: 'env-1', name: 'kasa', status: 'online', agents: 2 },
      { id: 'env-2', name: 'spare', status: 'offline', agents: 0 },
    ]);
    assert.ok(!r.out.includes('10.0.0.9') && !r.out.includes('dev"'), 'no endpoints or device ids');
    const t = sb.cli(['computers']);
    assert.match(t.out, /^env-1 {2}kasa · online · 2 agents$/m);
    assert.match(t.out, /^env-2 {2}spare · offline · 0 agents$/m);
    assert.match(sb.orcaLog(), /^environment list --json$/m);
    // remoteAgents off: the list, no worktree ps
    writeFileSync(join(sb.home, 'config.json'), JSON.stringify({ remoteAgents: false }));
    const before = sb.orcaLog().length;
    const off = sb.cli(['computers', '--json']);
    assert.deepEqual(JSON.parse(off.out).map((c) => c.status), ['unknown', 'unknown']);
    assert.ok(!sb.orcaLog().slice(before).includes('worktree ps'));
  } finally {
    sb.done();
  }
});

test('cli: computers add reads the code from stdin only, runs orca environment add, and never shows or stores it', () => {
  const sb = sandbox();
  try {
    const r = sb.cli(['computers', 'add', '--name', 'PC', '--json'], `${CODE}\n`);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), { id: 'env-new', name: 'PC' });
    assert.match(sb.orcaLog(), /^environment add --name PC --pairing-code ok --json$/m, 'orca got the exact code');
    assert.ok(sb.envs().some((e) => e.name === 'PC'));
    // the new machine is in the k38 cache at once (no 5 min wait)
    assert.ok(JSON.parse(readFileSync(join(sb.home, 'orca-remote.json'), 'utf8')).envs.list.some((e) => e.id === 'env-new'));
    const t = sb.cli(['computers', 'add', '--name', 'Work laptop'], CODE);
    assert.equal(t.code, 0, t.err);
    assert.equal(t.out, 'added Work laptop\n');
    for (const x of [r, t]) {
      assert.ok(!x.out.includes(SECRET) && !x.err.includes(SECRET));
      assert.ok(!x.out.includes(TOKEN), "orca's answer is not echoed");
    }
    // orca fails (a spent code): a fixed error, no code
    const bad = `orca://pair?code=${SECRET}x`;
    const f = sb.cli(['computers', 'add', '--name', 'Other'], bad);
    assert.equal(f.code, 2);
    assert.equal(f.err, `kadans: ${ERR.add}\n`);
    assert.ok(!f.out.includes(SECRET) && !f.err.includes(SECRET));
    // a name already paired is refused before orca sees the code
    const n = sb.orcaLog().length;
    const dup = sb.cli(['computers', 'add', '--name', 'KASA'], CODE);
    assert.equal(dup.err, `kadans: ${ERR.taken}\n`);
    assert.ok(!sb.orcaLog().slice(n).includes('environment add'));
    assertNotOnDisk(sb.root, SECRET);
  } finally {
    sb.done();
  }
});

test('cli: computers add refuses a code on argv, bad codes and bad names with fixed errors; orca never runs add', () => {
  const sb = sandbox();
  try {
    const refused = [
      [['computers', 'add', '--name', 'PC', '--pairing-code', CODE], CODE, /^kadans: usage: /],
      [['computers', 'add', '--name', 'PC', '--code', CODE], CODE, /^kadans: usage: /],
      [['computers', 'add', '--name', 'PC', CODE], CODE, /^kadans: usage: /],
      [['computers', 'add', CODE], '', /^kadans: usage: /],
      [['computers', 'add', '--name', 'PC'], '', ERR.code],
      [['computers', 'add', '--name', 'PC'], 'orca://pair?code=ab cd', ERR.code],
      [['computers', 'add', '--name', 'PC'], 'orca://pair?code="ab"', ERR.code],
      [['computers', 'add', '--name', 'PC'], 'orca://pair?code=ab;id', ERR.code],
      [['computers', 'add', '--name', 'PC'], `orca://pair?code=${SECRET}\norca://pair?code=x`, ERR.code],
      [['computers', 'add', '--name', 'PC'], `orca://pair?code=${'a'.repeat(5000)}`, ERR.code],
      [['computers', 'add', '--name', 'PC'], `https://pair?code=${SECRET}`, ERR.code],
      [['computers', 'add', '--name', 'a;b'], CODE, ERR.name],
      [['computers', 'add', '--name', '--json'], CODE, ERR.name],
      [['computers', 'add', '--name', 'x'.repeat(33)], CODE, ERR.name],
    ];
    for (const [args, input, want] of refused) {
      const r = sb.cli(args, input);
      assert.equal(r.code, 2, args.join(' '));
      if (want instanceof RegExp) assert.match(r.err, want);
      else assert.equal(r.err, `kadans: ${want}\n`);
      assert.equal(r.out, '');
      assert.ok(!r.err.includes(SECRET), 'no code in the error');
    }
    assert.ok(!sb.orcaLog().includes('environment add'), 'orca never saw an add');
    assertNotOnDisk(sb.root, SECRET);
  } finally {
    sb.done();
  }
});

test('cli: computers remove takes only an id from the list; the row is gone at once', () => {
  const sb = sandbox();
  try {
    sb.cli(['computers', '--json']); // fills the k38 cache
    const r = sb.cli(['computers', 'remove', 'env-2']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'removed env-2\n');
    assert.match(sb.orcaLog(), /^environment rm --environment env-2 --json$/m);
    assert.deepEqual(sb.envs().map((e) => e.id), ['env-1']);
    const cache = JSON.parse(readFileSync(join(sb.home, 'orca-remote.json'), 'utf8'));
    assert.deepEqual(cache.envs.list.map((e) => e.id), ['env-1']);
    assert.ok(!('env-2' in cache.machines));
    for (const id of ['env-9', '--all', '-x', 'a b', 'kasa']) {
      const n = sb.orcaLog().length;
      const x = sb.cli(['computers', 'remove', id]);
      assert.equal(x.code, 2, id);
      assert.ok(x.err === `kadans: ${ERR.id}\n` || x.err.startsWith('kadans: usage: '), x.err); // --all reads as a flag
      assert.ok(!sb.orcaLog().slice(n).includes('environment rm'), id);
    }
    assert.equal(sb.cli(['computers', 'remove']).code, 2);
  } finally {
    sb.done();
  }
});

test('computers (lib): no orca, orca list failing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kadans-k41-lib-'));
  try {
    assert.deepEqual(await listComputers(home, { call: null }), { ok: false, why: ERR.noOrca });
    assert.deepEqual(await addComputer(home, { call: null, name: 'PC', code: CODE }), { ok: false, why: ERR.noOrca });
    const failing = async () => ({ ok: false, timeout: false });
    assert.deepEqual(await listComputers(home, { call: failing }), { ok: false, why: ERR.list });
    assert.deepEqual(await removeComputer(home, { call: failing, id: 'env-1' }), { ok: false, why: ERR.list });
    // add with the env list down still tries (no duplicate check possible), and a failed add says ERR.add
    const seen = [];
    const call = async (args) => { seen.push(args[1]); return { ok: false, timeout: false }; };
    assert.deepEqual(await addComputer(home, { call, name: 'PC', code: CODE }), { ok: false, why: ERR.add });
    assert.deepEqual(seen, ['list', 'add']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('serve: the phone server has no computers-* action (pairing stays on the Mac)', async () => {
  const { ALLOWED_ACTIONS, planAction } = await import('../lib/serve.mjs');
  assert.ok(!ALLOWED_ACTIONS.some((a) => a.startsWith('computers')));
  for (const body of [{ action: 'computers-list' }, { action: 'computers-add', name: 'PC', code: CODE }, { action: 'computers-remove', id: 'env-1' }]) {
    const p = planAction(body, new Set());
    assert.equal(p.args, undefined);
    assert.match(p.why, /^refused: /);
    assert.ok(!JSON.stringify(p).includes(SECRET));
  }
});
