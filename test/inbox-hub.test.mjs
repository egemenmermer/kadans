// k53: the inbox hub (lib/hub.mjs), `kadans inbox hub` / `inbox setup`, the hub gate on mutations and the inbox-setup
// bridge action. Fake orca only (an in-process caller, or a fake orca script) and temp KADANS_HOME folders; the hub
// runs in this process or as a child of it, never inside a real Orca.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUB_ERR, HUB_KEY, HUB_LINE, HUB_LOCK, HUB_SOCK, REQ_MAX, hubCommand, hubCreateArgs, hubStatus, hubWorktree, openHub, startHub } from '../lib/hub.mjs';
import { ERR, INBOX_FILE, readInbox, replyTo, sendFollowUp, startTask } from '../lib/inbox.mjs';
import { ALLOWED_ACTIONS, SENDS, planAction } from '../lib/serve.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
const RUN = 'run_k53';
const COORD = 'term_hub';
const SECRET = 'SECRET-K53-owner-text';
const ok = (result) => ({ ok: true, text: JSON.stringify({ ok: true, result }) });

// Short temp roots: a Unix socket path must stay under 104 bytes on macOS.
function withRoot(fn) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'kh-'));
    try {
      await fn(join(root, 'k'), root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}
function allText(dir) {
  let out = '';
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out += allText(p);
    else if (e.isFile()) out += `${readFileSync(p, 'latin1')}\n`;
  }
  return out;
}
// One raw request on the socket -> the answer text ('' when the hub closed without one).
function raw(path, data, { end = false } = {}) {
  return new Promise((done) => {
    let buf = '';
    const s = net.createConnection(path);
    s.setEncoding('utf8');
    s.on('connect', () => (end ? s.end(data) : s.write(data)));
    s.on('data', (d) => { buf += d; });
    s.on('error', () => {});
    s.on('close', () => done(buf));
  });
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('k53 hub: socket and key 0600, owner only; a ping answers; bad, oversized, extra or concurrent requests are refused; request text never on disk', withRoot(async (home, root) => {
  let bound = true;
  const binds = [];
  const hub = await startHub(home, { bind: async () => { binds.push(1); return { ok: true }; }, isBound: () => bound });
  assert.equal(hub.ok, true);
  assert.equal(hub.bound, true);
  const sock = join(home, HUB_SOCK);
  try {
    const st = lstatSync(sock);
    assert.ok(st.isSocket());
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(st.uid, process.getuid());
    assert.equal(statSync(join(home, HUB_KEY)).mode & 0o777, 0o600);
    assert.equal(statSync(home).mode & 0o077, 0);
    assert.deepEqual(await hubStatus(home), { on: true, bound: true });
    bound = false;
    assert.deepEqual(await hubStatus(home), { on: true, bound: false }, 'bound is asked on every ping');
    bound = true;
    const key = readFileSync(join(home, HUB_KEY), 'utf8');
    const refused = '{"ok":false,"why":"refused"}\n';
    // no key, a wrong key, not JSON, an array, another op, an extra field carrying text: refused
    assert.equal(await raw(sock, '{"op":"ping"}\n'), refused);
    assert.equal(await raw(sock, `${JSON.stringify({ op: 'ping', key: 'f'.repeat(64) })}\n`), refused);
    assert.equal(await raw(sock, `not json ${SECRET}\n`), refused);
    assert.equal(await raw(sock, `[${JSON.stringify(SECRET)}]\n`), refused);
    assert.equal(await raw(sock, `${JSON.stringify({ op: 'reply', key, text: SECRET })}\n`), refused);
    assert.equal(await raw(sock, `${JSON.stringify({ op: 'ping', key, text: SECRET })}\n`), refused);
    // larger than REQ_MAX without a newline: refused and closed
    assert.equal(await raw(sock, `${SECRET}${'x'.repeat(REQ_MAX + 10)}`), '{"ok":false,"why":"too large"}\n');
    assert.equal(await raw(sock, `${JSON.stringify({ op: 'ping', key })}\n`), '{"ok":true,"bound":true}\n');
    // one request at a time: while a connection is open, another one is told "busy" (the probe reads that as off)
    const held = net.createConnection(sock);
    held.on('error', () => {});
    await new Promise((r) => held.on('connect', r));
    await tick(50);
    assert.equal(await raw(sock, `${JSON.stringify({ op: 'ping', key })}\n`), '{"ok":false,"why":"busy"}\n');
    assert.deepEqual(await hubStatus(home), { on: false, bound: false });
    held.destroy();
    await tick(50);
    assert.deepEqual(await hubStatus(home), { on: true, bound: true });
    // a client trusts only a socket and key that are this user's alone
    chmodSync(sock, 0o660);
    assert.deepEqual(await hubStatus(home), { on: false, bound: false });
    chmodSync(sock, 0o600);
    chmodSync(join(home, HUB_KEY), 0o644);
    assert.deepEqual(await hubStatus(home), { on: false, bound: false });
    chmodSync(join(home, HUB_KEY), 0o600);
    // a second hub while this one answers: refused before it binds anything
    const second = await startHub(home, { bind: async () => { binds.push(2); return { ok: true }; }, isBound: () => true });
    assert.deepEqual(second, { ok: false, why: HUB_ERR.running });
    assert.deepEqual(binds, [1]);
    // the text of every request above: in no file
    assert.ok(!allText(root).includes(SECRET));
  } finally {
    await hub.stop();
  }
  assert.ok(!existsSync(sock) && !existsSync(join(home, HUB_KEY)), 'stop removes the socket and the key');
  assert.deepEqual(await hubStatus(home), { on: false, bound: false });
}));

// A fake orca script: answers run-list / run-create / run-use, logs argv (no text ever reaches it here).
const FAKE_ORCA = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
const a = process.argv.slice(2);
appendFileSync(join(__dirname, 'calls.log'), JSON.stringify(a) + '\\n');
const k = a.slice(0, 2).join(' ');
const out = (result) => process.stdout.write(JSON.stringify({ ok: true, result }));
if (k === 'orchestration run-list') out({ runs: [{ id: '${RUN}', legacy: 0 }] });
else if (k === 'orchestration run-create' || k === 'orchestration run-use') out({ run: { id: '${RUN}' } });
else { process.stdout.write('{"ok":false}'); process.exitCode = 1; }
`;

function hubSandbox(root) {
  const fakeDir = join(root, 'f');
  mkdirSync(fakeDir);
  writeFileSync(join(fakeDir, 'orca'), FAKE_ORCA, { mode: 0o755 });
  const home = join(root, 'k');
  const env = { PATH: process.env.PATH, HOME: join(root, 'h'), KADANS_HOME: home, CLAUDE_CONFIG_DIR: join(root, 'h', 'c'), KADANS_ORCA_BIN: join(fakeDir, 'orca') };
  const calls = () => (existsSync(join(fakeDir, 'calls.log')) ? readFileSync(join(fakeDir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const start = async () => {
    const p = spawn(process.execPath, [BIN, 'inbox', 'hub'], { env: { ...env, ORCA_TERMINAL_HANDLE: COORD, ORCA_PANE_KEY: 'pane-1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    for (let i = 0; i < 100 && !out.includes('\n') && p.exitCode === null; i++) await tick(100);
    return { p, out: () => out, err: () => err, exit: new Promise((r) => p.once('exit', (code, sig) => r({ code, sig }))) };
  };
  return { home, env, calls, start };
}

test('k53 hub process: binds from its own tab, prints one line, ends cleanly on SIGINT / SIGHUP and removes its socket; refused outside Orca or in a chat', withRoot(async (home, root) => {
  const sb = hubSandbox(root);
  // refused outside an Orca terminal and inside an agent chat: no orca call, no socket
  for (const extra of [{}, { ORCA_TERMINAL_HANDLE: COORD, CLAUDECODE: '1' }, { ORCA_TERMINAL_HANDLE: COORD, ORCA_AGENT_SESSION_ID: 's' }, { ORCA_TERMINAL_HANDLE: '--from' }]) {
    const r = spawnSync(process.execPath, [BIN, 'inbox', 'hub'], { env: { ...sb.env, ...extra }, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 2);
    assert.equal(r.stderr, `kadans: ${HUB_ERR.where}\n`);
  }
  assert.deepEqual(sb.calls(), []);
  for (const sig of ['SIGINT', 'SIGHUP']) {
    const h = await sb.start();
    assert.equal(h.out(), `${HUB_LINE}\n`);
    assert.equal(h.err(), '');
    assert.deepEqual(await hubStatus(sb.home), { on: true, bound: true });
    // typed into the tab (Orca or anyone): read and dropped, never echoed, written or acted on
    h.p.stdin.write(`${SECRET}\norca orchestration check\n`);
    await tick(100);
    assert.deepEqual(await hubStatus(sb.home), { on: true, bound: true });
    h.p.kill(sig);
    const end = await h.exit;
    assert.equal(end.code, 0, `${sig}: exit code`);
    assert.ok(!existsSync(join(sb.home, HUB_SOCK)) && !existsSync(join(sb.home, HUB_KEY)), `${sig}: socket and key removed`);
    assert.ok(!h.out().includes(SECRET) && !h.err().includes(SECRET));
  }
  // first start created the Run from this tab; the second reused it (same handle: no call)
  const verbs = sb.calls().map((c) => c.slice(0, 2).join(' '));
  assert.deepEqual(verbs, ['orchestration run-create', 'orchestration run-list']);
  assert.deepEqual(sb.calls()[0].slice(-3), ['--from', COORD, '--json']);
  const state = JSON.parse(readFileSync(join(sb.home, INBOX_FILE), 'utf8'));
  assert.deepEqual([state.runId, state.coordinator], [RUN, COORD]);
  assert.ok(!allText(root).includes(SECRET));
}));

const WORKTREES = [
  { id: 'r1::/Users/me/old', path: '/Users/me/old', isMainWorktree: true, isArchived: true, hostId: 'local', sortOrder: 1 },
  { id: 'r2::/Users/me/web-prod', path: '/Users/me/web-prod', isMainWorktree: true, hostId: 'local', sortOrder: 2, displayName: 'main' },
  { id: 'r3::/Users/me/shop', path: '/Users/me/shop', isMainWorktree: true, hostId: 'local', sortOrder: 3, displayName: 'production' },
  { id: 'r4::/Users/me/remote', path: '/Users/me/remote', isMainWorktree: true, hostId: 'ssh-box', sortOrder: 4 },
  { id: 'r5::/Users/me/app-feature', path: '/Users/me/app-feature', isMainWorktree: false, hostId: 'local', sortOrder: 5 },
  { id: 'r7::/Users/me/code/app', path: '/Users/me/code/app', isMainWorktree: true, hostId: 'local', sortOrder: 7, displayName: 'main', lastActivityAt: 300 },
  { id: 'r6::/Users/me/notes', path: '/Users/me/notes', isMainWorktree: true, sortOrder: 9, displayName: 'notes', lastActivityAt: 200 },
  { id: 'r8::/Users/me/zz', path: '/Users/me/zz', isMainWorktree: true, sortOrder: 0, displayName: 'zz' },
];

test('k53 setup: picks the tab\'s project, builds the exact terminal create args, never creates when a hub answers, waits for it', withRoot(async (home, root) => {
  // where: the project holding Kadans, else a pinned one, else the one used last (local main projects only: not
  // archived, linked, remote or prod-looking even when they are newer), then the oldest
  assert.equal(hubWorktree(WORKTREES, '/opt/kadans'), '/Users/me/code/app');
  assert.equal(hubWorktree(WORKTREES, '/Users/me/notes/tools/kadans'), '/Users/me/notes');
  assert.equal(hubWorktree(WORKTREES.map((w) => (w.id.startsWith('r6') ? { ...w, isPinned: true } : w)), '/opt/kadans'), '/Users/me/notes');
  assert.equal(hubWorktree(WORKTREES.map((w) => ({ ...w, lastActivityAt: w.id.startsWith('r2') || w.id.startsWith('r5') ? 999 : undefined })), '/opt/kadans'), '/Users/me/zz');
  assert.equal(hubWorktree([{ path: '/x\ny', isMainWorktree: true }, { path: 'rel', isMainWorktree: true }], '/opt/kadans'), null);
  assert.equal(hubWorktree(null, '/opt/kadans'), null);
  // the command: Kadans' own paths only, single-quoted, exec; a quote or a control character is refused
  const NODE = '/opt/node/bin/node';
  const KBIN = '/opt/kadans/bin/kadans.mjs';
  assert.equal(hubCommand(NODE, KBIN, '/Users/me/.kadans'), "exec /usr/bin/env KADANS_HOME='/Users/me/.kadans' '/opt/node/bin/node' '/opt/kadans/bin/kadans.mjs' inbox hub");
  assert.equal(hubCommand('/opt/my node/node', KBIN, '/Users/me/k $x'), "exec /usr/bin/env KADANS_HOME='/Users/me/k $x' '/opt/my node/node' '/opt/kadans/bin/kadans.mjs' inbox hub");
  for (const bad of ["/opt/it's/kadans.mjs", '/opt/a\nrm -rf ~/kadans.mjs', 'kadans.mjs', '/opt/’/k.mjs']) {
    assert.throws(() => hubCommand(NODE, bad, '/Users/me/.kadans'));
    assert.throws(() => hubCommand(NODE, KBIN, bad));
  }

  const calls = [];
  const call = async (args) => {
    calls.push(args);
    if (args[0] === 'worktree') return ok({ worktrees: WORKTREES });
    if (args[0] === 'terminal') return ok({ terminal: { handle: 'term_new' } });
    return { ok: false };
  };
  // no hub: one create with the exact args, then it waits until the hub answers
  let probes = 0;
  const probe = async () => (++probes >= 4 ? { on: true, bound: true } : { on: false, bound: false });
  const r = await openHub(home, { call, nodePath: NODE, bin: KBIN, probe, sleep: async () => {}, wait: 10_000 });
  assert.deepEqual(r, { ok: true, created: true });
  assert.deepEqual(calls, [['worktree', 'list', '--json'],
    ['terminal', 'create', '--worktree', 'path:/Users/me/code/app', '--title', 'Kadans inbox', '--command', `exec /usr/bin/env KADANS_HOME='${home}' '/opt/node/bin/node' '/opt/kadans/bin/kadans.mjs' inbox hub`, '--json']]);
  assert.deepEqual(calls[1], hubCreateArgs('/Users/me/code/app', hubCommand(NODE, KBIN, home)));
  assert.ok(!existsSync(join(home, HUB_LOCK)), 'the lock is released');
  // a hub answers: nothing is created (ready), or the unbound sentence
  calls.length = 0;
  assert.deepEqual(await openHub(home, { call, nodePath: NODE, bin: KBIN, probe: async () => ({ on: true, bound: true }) }), { ok: true, created: false });
  assert.deepEqual(await openHub(home, { call, nodePath: NODE, bin: KBIN, probe: async () => ({ on: true, bound: false }) }), { ok: false, why: HUB_ERR.unbound });
  // with a real hub on the socket and the default probe: no call either
  const hub = await startHub(home, { bind: async () => ({ ok: true }), isBound: () => true });
  try {
    assert.deepEqual(await openHub(home, { call, nodePath: NODE, bin: KBIN }), { ok: true, created: false });
  } finally {
    await hub.stop();
  }
  assert.deepEqual(calls, []);
  // a second tap while one is under way (the lock): refused, nothing created
  writeFileSync(join(home, HUB_LOCK), '');
  assert.deepEqual(await openHub(home, { call, nodePath: NODE, bin: KBIN, probe: async () => ({ on: false }) }), { ok: false, why: HUB_ERR.busy });
  rmSync(join(home, HUB_LOCK));
  // a quoted path, no project, a failed create, a hub that never answers: fixed sentences, never a second create
  assert.deepEqual(await openHub(home, { call, nodePath: NODE, bin: "/opt/it's/k.mjs", probe: async () => ({ on: false }) }), { ok: false, why: HUB_ERR.quote });
  assert.deepEqual(calls, []);
  const noProject = async (args) => (calls.push(args), ok({ worktrees: [] }));
  assert.deepEqual(await openHub(home, { call: noProject, nodePath: NODE, bin: KBIN, probe: async () => ({ on: false }) }), { ok: false, why: HUB_ERR.worktree });
  const failing = async (args) => (calls.push(args), args[0] === 'worktree' ? ok({ worktrees: WORKTREES }) : { ok: false });
  assert.deepEqual(await openHub(home, { call: failing, nodePath: NODE, bin: KBIN, probe: async () => ({ on: false }) }), { ok: false, why: HUB_ERR.create });
  calls.length = 0;
  let t = 0;
  const slow = await openHub(home, { call, nodePath: NODE, bin: KBIN, probe: async () => ({ on: false }), now: () => t, sleep: async (ms) => { t += ms; }, wait: 1000 });
  assert.deepEqual(slow, { ok: false, why: HUB_ERR.slow });
  assert.equal(calls.filter((c) => c[0] === 'terminal').length, 1, 'never a second create');
  assert.ok(!existsSync(join(root, 'k', HUB_SOCK)));
}));

test('k53 gate: with no hub every mutation refuses with the fixed line and calls nothing; the inbox says hub on/off and ready', withRoot(async (home) => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, INBOX_FILE), JSON.stringify({ runId: RUN, coordinator: COORD, tasks: { disp_1: { taskId: 't1', machine: 'local', at: 1 } } }));
  const calls = [];
  const call = async (args) => {
    calls.push(args);
    const k = args.slice(0, 2).join(' ');
    if (k === 'environment list') return ok({ environments: [] });
    if (k === 'repo list') return ok({ repos: [{ id: 'repo-mac', kind: 'git' }] });
    if (k === 'orchestration inbox') return ok({ messages: [{ id: 'msg_q', run_id: RUN, to_handle: `run:${RUN}`, type: 'question', subject: 'Q', body: 'b', created_at: '2026-10-27T10:00:00Z' }] });
    if (k === 'orchestration task-list') return ok({ tasks: [] });
    return ok({ dispatchId: 'disp_x', state: 'ready', message: { id: 'm' } });
  };
  // no hub (no socket): the one fixed line, no orca call
  assert.equal(ERR.off, 'The inbox is off. Tap Set up.');
  assert.deepEqual(await startTask(home, { machine: 'local', repo: 'repo-mac', text: SECRET, confirmed: true }, { call }), { ok: false, why: ERR.off });
  assert.deepEqual(await replyTo(home, 'msg_q', SECRET, { call }), { ok: false, why: ERR.off });
  assert.deepEqual(await sendFollowUp(home, 'disp_1', SECRET, { call }), { ok: false, why: ERR.off });
  assert.deepEqual(calls, []);
  let box = await readInbox(home, { call });
  assert.deepEqual([box.ready, box.hub, box.items.find((i) => i.id === 'msg_q').canReply], [false, 'off', false]);
  // a hub that is on but bound to another tab: still off for mutations, not ready
  let bound = false;
  const hub = await startHub(home, { bind: async () => ({ ok: true }), isBound: () => bound });
  try {
    calls.length = 0;
    assert.equal((await replyTo(home, 'msg_q', 'yes', { call })).why, ERR.off);
    assert.deepEqual(calls, []);
    box = await readInbox(home, { call });
    assert.deepEqual([box.ready, box.hub], [false, 'on']);
    // on and bound: ready, the question can be answered, and the reply goes out with --run / --from
    bound = true;
    box = await readInbox(home, { call });
    assert.deepEqual([box.ready, box.hub, box.items.find((i) => i.id === 'msg_q').canReply], [true, 'on', true]);
    assert.deepEqual(await replyTo(home, 'msg_q', 'yes', { call }), { ok: true, id: 'msg_q' });
    assert.deepEqual(calls.at(-1), ['orchestration', 'reply', '--id', 'msg_q', '--body', 'yes', '--run', RUN, '--from', COORD, '--json']);
  } finally {
    await hub.stop();
  }
  // no Run kept yet: ready false, nothing called for it, hub reported
  rmSync(join(home, INBOX_FILE));
  calls.length = 0;
  assert.deepEqual(await readInbox(home, { call }), { ok: true, ready: false, hub: 'off', machines: [{ id: 'local', name: 'This Mac' }], items: [] });
  assert.deepEqual(calls, []);
  assert.ok(!allText(home).includes(SECRET));
}));

test('k53 phone: inbox-setup is on the allow-list with fixed arguments (nothing from the request) and shares the send limit', () => {
  assert.ok(ALLOWED_ACTIONS.includes('inbox-setup'));
  assert.ok(SENDS.has('inbox-setup'));
  const plan = planAction({ action: 'inbox-setup', id: '--worktree', text: SECRET, command: 'rm -rf ~', machine: 'env-kasa' }, new Set());
  assert.deepEqual(plan, { action: 'inbox-setup', id: '', args: ['inbox', 'setup'], timeout: 45_000 });
});
