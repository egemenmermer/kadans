// k37: the win32 code paths, run on any OS through an injected platform / env / access (path.win32 inside).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { CMD_ARG_RE, findOrca, onPath, orcaSpawn, orcaWindowsDefault, renameRetry } from '../lib/platform.mjs';
import { OURS_RE, kadansCommand, mergeSettings, unmergeSettings } from '../lib/install.mjs';
import { MAC_ONLY_NOTE, fetchUsage, usageApiSupported } from '../lib/usage-api.mjs';
import { CONNECT_HINT, ORCA_MISSING, cleanName, connectLines, runConnect } from '../lib/connect.mjs';
import { ensureHome } from '../lib/store.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
const LOCAL = 'C:\\Users\\me x\\AppData\\Local';
const WIN_ORCA = 'C:\\Users\\me x\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.cmd';
const has = (set) => (f) => set.has(f);

test('win32 paths: onPath splits on ; tries PATHEXT, strips quotes; posix unchanged', () => {
  const files = new Set(['C:\\Tools\\orca.cmd', 'C:\\Program Files\\nodejs\\node.exe', '/opt/bin/orca']);
  const pathVar = 'C:\\Windows;"C:\\Program Files\\nodejs";C:\\Tools';
  assert.equal(onPath('orca', pathVar, { platform: 'win32', access: has(files) }), 'C:\\Tools\\orca.cmd');
  assert.equal(onPath('node', pathVar, { platform: 'win32', access: has(files) }), 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(onPath('node', pathVar, { platform: 'win32', pathExt: '.CMD', access: has(files) }), null);
  assert.equal(onPath('orca', '/usr/bin:/opt/bin', { platform: 'darwin', access: has(files) }), '/opt/bin/orca');
  // a Windows PATH split on ':' would have broken C:\... apart: the posix reader never sees the win32 file
  assert.equal(onPath('orca', pathVar, { platform: 'darwin', access: has(files) }), null);
  assert.equal(orcaWindowsDefault({ LOCALAPPDATA: LOCAL }), WIN_ORCA);
  assert.equal(orcaWindowsDefault({}), null);
});

test('orca discovery order: KADANS_ORCA_BIN, then %LOCALAPPDATA% orca.cmd, then PATH', () => {
  const both = has(new Set([WIN_ORCA, 'D:\\bin\\orca.exe']));
  const env = { LOCALAPPDATA: LOCAL, PATH: 'D:\\bin', PATHEXT: '.EXE;.CMD' };
  assert.equal(findOrca({ ...env, KADANS_ORCA_BIN: 'E:\\x\\orca.cmd' }, { platform: 'win32', access: both }), 'E:\\x\\orca.cmd');
  assert.equal(findOrca(env, { platform: 'win32', access: both }), WIN_ORCA);
  assert.equal(findOrca(env, { platform: 'win32', access: has(new Set(['D:\\bin\\orca.exe'])) }), 'D:\\bin\\orca.exe');
  assert.equal(findOrca({ LOCALAPPDATA: LOCAL, Path: 'D:\\bin' }, { platform: 'win32', access: has(new Set(['D:\\bin\\orca.cmd'])) }), 'D:\\bin\\orca.cmd');
  assert.equal(findOrca(env, { platform: 'win32', access: () => false }), null);
  // macOS never looks at LOCALAPPDATA
  assert.equal(findOrca({ LOCALAPPDATA: LOCAL, PATH: '/opt/bin' }, { platform: 'darwin', access: has(new Set([WIN_ORCA, '/opt/bin/orca'])) }), '/opt/bin/orca');
});

test('orcaSpawn: a .cmd runs as cmd.exe /d /s /c with verbatim, allow-listed arguments; elsewhere unchanged', () => {
  const env = { SystemRoot: 'C:\\Windows' };
  const s = orcaSpawn(WIN_ORCA, ['worktree', 'ps', '--environment', 'env-1a2b', '--json'], { platform: 'win32', env });
  assert.equal(s.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(s.args, ['/d', '/v:off', '/s', '/c', `""${WIN_ORCA}" worktree ps --environment env-1a2b --json"`]);
  assert.deepEqual(s.opts, { windowsVerbatimArguments: true });
  assert.deepEqual(orcaSpawn('/opt/bin/orca', ['serve'], { platform: 'darwin' }), { file: '/opt/bin/orca', args: ['serve'], opts: {} });
  assert.deepEqual(orcaSpawn('D:\\bin\\orca.exe', ['serve'], { platform: 'win32' }), { file: 'D:\\bin\\orca.exe', args: ['serve'], opts: {} });
  assert.equal(orcaSpawn('D:\\BIN\\ORCA.BAT', ['serve'], { platform: 'win32', env }).file, 'C:\\Windows\\System32\\cmd.exe');
  // a spaced argument is quoted; nothing else is
  assert.match(orcaSpawn(WIN_ORCA, ['x', 'two words'], { platform: 'win32', env }).args[4], / x "two words""$/);
  for (const bad of ['a&b', 'a|b', 'a>b', 'a<b', 'a^b', 'a"b', '%PATH%', 'a!b', 'a\nb', 'a\rb', 'a;b', 'a(b)']) {
    assert.equal(CMD_ARG_RE.test(bad), false, JSON.stringify(bad));
    assert.throws(() => orcaSpawn(WIN_ORCA, ['serve', bad], { platform: 'win32', env }), (e) => !e.message.includes(bad) && /refused/.test(e.message));
  }
  for (const badBin of ['C:\\A&B\\orca.cmd', 'C:\\100%\\orca.cmd', 'C:\\x"y\\orca.cmd', 'C:\\x^y\\orca.cmd', 'C:\\x!y\\orca.cmd', 'C:\\x\ny\\orca.cmd']) {
    assert.throws(() => orcaSpawn(badBin, ['serve'], { platform: 'win32', env }), /refused/);
  }
  assert.doesNotThrow(() => orcaSpawn('C:\\Users\\Zoë (x)\\orca.cmd', ['serve'], { platform: 'win32', env }));
});

test('hook command on win32: bare node, forward slashes, single quotes; Git Bash reads one literal word', () => {
  const win = 'C:\\Users\\me x\\.kadans\\app\\current\\bin\\kadans.mjs';
  const cmd = kadansCommand(win, { platform: 'win32' });
  assert.equal(cmd, "node 'C:/Users/me x/.kadans/app/current/bin/kadans.mjs'");
  for (const p of ['C:\\Users\\$HOME `x`\\kadans.mjs', 'C:\\A&B (1) 100%\\kadans.mjs', 'C:\\Users\\me x\\kadans.mjs']) {
    const c = kadansCommand(p, { platform: 'win32' });
    assert.ok(!c.includes('\\'), c);
    const words = spawnSync('/bin/sh', ['-c', `printf '%s\\0' ${c.slice(5)} hook stop`], { encoding: 'utf8' });
    assert.deepEqual(words.stdout.split('\0').slice(0, -1), [p.replace(/\\/g, '/'), 'hook', 'stop'], p);
    const merged = mergeSettings({}, c).settings;
    assert.match(merged.statusLine.command, OURS_RE);
    assert.deepEqual(mergeSettings(merged, c).settings, merged);
    assert.deepEqual(unmergeSettings(merged, null), { hooks: {} });
  }
  for (const bad of ["C:\\Users\\O'Brien\\kadans.mjs", 'C:\\Users\\O\u2019Brien\\kadans.mjs', 'C:\\x\ny\\kadans.mjs']) {
    assert.throws(() => kadansCommand(bad, { platform: 'win32' }), /refused/);
  }
  // macOS output stays byte-identical
  assert.equal(kadansCommand('/Users/me/kadans/bin/kadans.mjs', { platform: 'darwin' }), "node '/Users/me/kadans/bin/kadans.mjs'");
  assert.equal(kadansCommand("/opt/it's/kadans.mjs", { platform: 'darwin' }), "node '/opt/it'\\''s/kadans.mjs'");
  assert.equal(kadansCommand('/Users/me/kadans/bin/kadans.mjs'), "node '/Users/me/kadans/bin/kadans.mjs'");
});

test('usage API reader is skipped on win32: no Keychain call, no request, nothing written', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kadans-win-ua-'));
  let calls = 0;
  const r = await fetchUsage(home, { platform: 'win32', run: () => { calls++; return { status: 0, stdout: '' }; }, fetch: async () => { calls++; return { status: 200 }; } });
  assert.deepEqual(r, { ok: false, code: 'mac_only', message: MAC_ONLY_NOTE });
  assert.equal(MAC_ONLY_NOTE, 'usage reading from Anthropic is Mac-only for now');
  assert.equal(calls, 0);
  assert.deepEqual(readdirSync(home), []);
  assert.equal(usageApiSupported('win32'), false);
  assert.equal(usageApiSupported('darwin'), true);
});

test('win32 store: no chmod on the home; renames retry while Windows holds the target open', () => {
  const root = mkdtempSync(join(tmpdir(), 'kadans-win-store-'));
  const home = join(root, 'h');
  mkdirSync(home, { mode: 0o755 });
  chmodSync(home, 0o755);
  ensureHome(home, { platform: 'win32' });
  assert.equal(statSync(home).mode & 0o777, 0o755);
  ensureHome(home, { platform: 'darwin' });
  assert.equal(statSync(home).mode & 0o777, 0o700);
  const busy = (n) => {
    let left = n;
    return () => {
      if (left-- > 0) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    };
  };
  assert.doesNotThrow(() => renameRetry('a', 'b', { platform: 'win32', rename: busy(2) }));
  assert.throws(() => renameRetry('a', 'b', { platform: 'darwin', rename: busy(1) }), /busy/);
  assert.throws(() => renameRetry('a', 'b', { platform: 'win32', rename: busy(99), tries: 3 }), /busy/);
});

const sink = () => {
  let text = '';
  return { stream: new Writable({ write(c, _e, cb) { text += c; cb(); } }), get text() { return text; } };
};

test('connect lines: the code alone plus the hint; web URL and QR left out; names cleaned', () => {
  const l = connectLines('Pairing URL: orca://pair?x=FAKE', 'other');
  assert.ok(l.includes('orca://pair?x=FAKE'));
  assert.ok(l.includes(CONNECT_HINT));
  assert.equal(CONNECT_HINT, 'On your Mac: Kadans › Settings › Computers › Add, paste this code.');
  assert.equal(connectLines('Web client URL: http://x/#FAKE', 'k'), null);
  assert.deepEqual(connectLines('Orca server ready', 'k'), ['Orca server ready']);
  assert.equal(cleanName('DESKTOP-AB12 "x"; rm'), 'DESKTOP-AB12 x rm');
  assert.equal(cleanName('&&&'), null);
  assert.equal(cleanName('a'.repeat(40)).length, 32);
});

test('connect on win32: orca.cmd through cmd.exe, Ctrl+C ends with 0, missing orca is one line', async () => {
  const out = sink();
  const err = sink();
  const signals = new EventEmitter();
  let spawned = null;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  const fakeSpawn = (file, args, opts) => {
    spawned = { file, args, opts };
    return child;
  };
  const p = runConnect([], { env: { LOCALAPPDATA: LOCAL, SystemRoot: 'C:\\Windows' }, platform: 'win32', find: () => WIN_ORCA, spawn: fakeSpawn,
    out: out.stream, err: err.stream, host: () => 'OTHER-PC', signals, kill: () => {} });
  assert.equal(spawned.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(spawned.args, ['/d', '/v:off', '/s', '/c', `""${WIN_ORCA}" serve"`]);
  assert.equal(spawned.opts.windowsVerbatimArguments, true);
  assert.deepEqual(spawned.opts.stdio, ['inherit', 'pipe', 'inherit']);
  child.stdout.end('Pairing URL: orca://pair?offer=WINFAKE\n');
  await new Promise((r) => setImmediate(r));
  signals.emit('SIGINT');
  child.emit('close', null);
  assert.equal(await p, 0);
  assert.match(out.text, /Pairing code for "OTHER-PC":\norca:\/\/pair\?offer=WINFAKE\nOn your Mac: Kadans › Settings › Computers › Add, paste this code\./);
  assert.equal(signals.listenerCount('SIGINT'), 0);

  const e2 = sink();
  assert.equal(await runConnect([], { env: {}, platform: 'win32', find: () => null, out: sink().stream, err: e2.stream }), 1);
  assert.equal(e2.text, `${ORCA_MISSING}\n`);
  assert.equal(await runConnect(['--bogus'], { find: () => WIN_ORCA, out: sink().stream, err: sink().stream }), 2);
});

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) walk(f, out);
    else out.push(f);
  }
  return out;
}

test('kadans connect (real CLI, fake orca): prints the code once with the hint and never writes it anywhere', () => {
  const root = mkdtempSync(join(tmpdir(), 'kadans-connect-'));
  const home = join(root, 'kadans');
  const tmp = join(root, 'tmp');
  mkdirSync(home);
  mkdirSync(tmp);
  const CODE = 'orca://pair?offer=K37FAKECODE9z';
  const fake = join(root, 'fake-orca');
  writeFileSync(fake, `#!/usr/bin/env node\nconsole.log('argv ' + process.argv.slice(2).join(' '));\nconsole.log('Orca server ready');\nconsole.log('Web client URL: http://127.0.0.1:1/#${CODE}');\nconsole.log('Pairing URL: ${CODE}');\n`);
  chmodSync(fake, 0o755);
  const env = { PATH: process.env.PATH, HOME: root, KADANS_HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp, CLAUDE_CONFIG_DIR: join(root, 'claude'), KADANS_ORCA_BIN: fake, KADANS_ORCA_TIMEOUT_MS: '30000' };
  const r = spawnSync(process.execPath, [BIN, 'connect', '--name', 'other'], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /argv serve\n/); // the name is never passed to orca
  assert.equal(r.stdout.split(CODE).length - 1, 1, r.stdout);
  assert.match(r.stdout, new RegExp(`Pairing code for "other":\\n${CODE.replace(/[?.]/g, '\\$&')}\\n${CONNECT_HINT.replace(/[.]/g, '\\.')}`));
  assert.ok(!r.stderr.includes('K37FAKECODE9z'));
  const files = walk(root).filter((f) => f !== fake);
  for (const f of files) assert.ok(!readFileSync(f, 'utf8').includes('K37FAKECODE9z'), f);
  assert.deepEqual(readdirSync(home), []);

  const miss = spawnSync(process.execPath, [BIN, 'connect'], { env: { ...env, KADANS_ORCA_BIN: '', PATH: '' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(miss.status, 1);
  assert.equal(miss.stderr, `${ORCA_MISSING}\n`);
});
