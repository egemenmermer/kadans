// fix-3: the status line runs the user's previous statusLine (no default chain), and setup on win32 (junction, hooks
// only). Temp KADANS_HOME / CLAUDE_CONFIG_DIR / HOME only; the win32 paths run on a Mac through an injected platform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chainTarget, gitBash, joinLines, shellSpawn, userCommand } from '../lib/chain.mjs';
import { kadansCommand } from '../lib/install.mjs';
import { DEFAULTS, loadConfig } from '../lib/pace.mjs';
import { WIN_APP_LINE, applySetup, currentBin, currentDir, installedVersion, packageVersion } from '../lib/setup.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'kadans-chain-'));
  const home = join(root, 'kadans');
  const claude = join(root, 'claude');
  mkdirSync(home);
  mkdirSync(claude);
  return { root, home, claude, env: { PATH: process.env.PATH, HOME: root, KADANS_HOME: home, CLAUDE_CONFIG_DIR: claude, KADANS_ORCA: '0' } };
}

const saveStatusLine = (sb, statusLine) => writeFileSync(join(sb.home, 'install.json'), JSON.stringify({ statusLine }));
const setConfig = (sb, cfg) => writeFileSync(join(sb.home, 'config.json'), JSON.stringify(cfg));

function script(sb, name, body) {
  const file = join(sb.root, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function statusline(sb, input) {
  const r = spawnSync(process.execPath, [BIN, 'statusline'], { input, env: sb.env, encoding: 'utf8', timeout: 15000 });
  return { code: r.status, out: r.stdout };
}

const payload = (pct) =>
  JSON.stringify({ session_id: 's1', cwd: '/w', rate_limits: { five_hour: { used_percentage: pct, resets_at: Math.floor(Date.now() / 1000) + 3600 } } });

test('default config has no chain; an explicit "" is kept as "none"', () => {
  const sb = sandbox();
  assert.equal(DEFAULTS.chain, null);
  assert.equal(loadConfig(sb.home).chain, null);
  setConfig(sb, { chain: '' });
  assert.equal(loadConfig(sb.home).chain, '');
});

test('no chain configured + saved statusLine script: its output is shown inside Kadans\' line', () => {
  const sb = sandbox();
  const old = script(sb, 'old.sh', 'echo "main · ~/w"');
  saveStatusLine(sb, { type: 'command', command: old, padding: 0 });
  const r = statusline(sb, payload(42));
  assert.equal(r.code, 0);
  assert.match(r.out, /^5h 42% .* · main · ~\/w\n$/);
});

test('saved command string runs through the shell with the same stdin', () => {
  const sb = sandbox();
  const seen = join(sb.root, 'seen.json');
  // redirection and ; only work through /bin/sh -c
  saveStatusLine(sb, { type: 'command', command: `cat > '${seen}'; printf 'L1\\nL2\\n'; echo ERR 1>&2` });
  const input = payload(17);
  const r = statusline(sb, input);
  assert.equal(r.code, 0);
  assert.equal(readFileSync(seen, 'utf8'), input);
  assert.match(r.out, /^5h 17% .* · L1\nL2\n$/);
  assert.ok(!r.out.includes('ERR'));
});

test('saved line alone shows when there are no samples yet', () => {
  const sb = sandbox();
  saveStatusLine(sb, { type: 'command', command: 'echo HELLO' });
  assert.equal(statusline(sb, '{}').out, 'HELLO\n');
});

test('our own command is never chained (no loop)', () => {
  const sb = sandbox();
  const ours = { type: 'command', command: `${kadansCommand(BIN)} statusline` };
  assert.equal(userCommand(ours), null);
  assert.equal(userCommand({ type: 'command', command: `node '/x/app/current/bin/kadans.mjs' statusline` }), null);
  assert.equal(userCommand({ type: 'static', command: 'echo x' }), null);
  assert.equal(userCommand(null), null);
  saveStatusLine(sb, ours);
  assert.equal(chainTarget(loadConfig(sb.home), sb.home), null);
  const r = statusline(sb, payload(5));
  assert.equal(r.code, 0);
  assert.match(r.out, /^5h 5% [^\n]*\n$/);
});

test('a wrapper that runs kadans statusline again chains nothing more (no loop through a script)', () => {
  const sb = sandbox();
  const count = join(sb.root, 'count');
  // a wrapper script: OURS_RE cannot see that it runs Kadans
  const wrap = script(sb, 'wrap.sh', `echo x >> '${count}'\nexec '${process.execPath}' '${BIN}' "$(printf statusline)"`);
  saveStatusLine(sb, { type: 'command', command: wrap });
  const r = statusline(sb, payload(12));
  assert.equal(r.code, 0);
  assert.equal(readFileSync(count, 'utf8'), 'x\n'); // the inner kadans did not run the wrapper again
  assert.match(r.out, /^5h 12% .* · 5h 12% /);
});

test('an explicit chain wins over the saved statusLine (output dropped); an empty chain runs nothing', () => {
  const sb = sandbox();
  const mark = join(sb.root, 'chain-ran');
  const chain = script(sb, 'chain.sh', `touch '${mark}'\necho CHAIN_OUT`);
  const savedMark = join(sb.root, 'saved-ran');
  saveStatusLine(sb, { type: 'command', command: `touch '${savedMark}'; echo SAVED` });
  setConfig(sb, { chain });
  let r = statusline(sb, payload(30));
  assert.ok(existsSync(mark));
  assert.ok(!existsSync(savedMark));
  assert.doesNotMatch(r.out, /CHAIN_OUT|SAVED/);
  setConfig(sb, { chain: '' });
  r = statusline(sb, payload(31));
  assert.ok(!existsSync(savedMark));
  assert.match(r.out, /^5h 31% [^\n]*\n$/);
});

test('joinLines: ours first, their first line after it, the rest below', () => {
  assert.equal(joinLines('A', ''), 'A');
  assert.equal(joinLines('', 'B'), 'B');
  assert.equal(joinLines('A', 'B\nC'), 'A · B\nC');
});

test('win32 shell for a saved command: Git Bash (env, next to git.exe, default folder), else PowerShell -EncodedCommand', () => {
  const has = (set) => (f) => set.has(f);
  const viaEnv = 'D:\\Git\\bin\\bash.exe';
  assert.equal(gitBash({ CLAUDE_CODE_GIT_BASH_PATH: viaEnv }, { exists: has(new Set([viaEnv])) }), viaEnv);
  const git = 'C:\\Tools\\Git\\cmd\\git.exe';
  const bash = 'C:\\Tools\\Git\\bin\\bash.exe';
  assert.equal(gitBash({ PATH: 'C:\\Windows;C:\\Tools\\Git\\cmd' }, { exists: has(new Set([git, bash])) }), bash);
  const def = 'C:\\Program Files\\Git\\bin\\bash.exe';
  // a bash.exe on PATH (WSL's) is never taken
  assert.equal(gitBash({ PATH: 'C:\\Windows\\System32' }, { exists: has(new Set(['C:\\Windows\\System32\\bash.exe'])) }), null);
  const cmd = `echo "it's" | cat`;
  assert.deepEqual(shellSpawn(cmd, { platform: 'win32', env: { PATH: '' }, exists: has(new Set([def])) }), { file: def, args: ['-c', cmd] });
  const ps = shellSpawn(cmd, { platform: 'win32', env: { PATH: '', SystemRoot: 'C:\\WINDOWS' }, exists: () => false });
  assert.equal(ps.file, 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(ps.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(Buffer.from(ps.args[3], 'base64').toString('utf16le'), cmd);
  assert.deepEqual(shellSpawn(cmd, { platform: 'darwin' }), { file: '/bin/sh', args: ['-c', cmd] });
});

test('win32 setup: app/current is a junction with an absolute target, hooks in the k37 form, no build, no open', () => {
  const sb = sandbox();
  const links = [];
  const link = (target, p, type) => {
    links.push({ target, type });
    symlinkSync(target, p, type); // on macOS the type is ignored: an absolute symlink stands in for the junction
  };
  const never = (what) => () => assert.fail(`${what} must not run on win32`);
  const deps = { link, build: never('build'), reopen: never('open') };
  const version = packageVersion();
  const args = { home: sb.home, cfgDir: sb.claude, version, platform: 'win32', env: sb.env, wantApp: true, toolchain: true, deps };
  const first = applySetup(args);
  assert.equal(first.appLine, WIN_APP_LINE);
  assert.ok(links.length >= 1);
  for (const l of links) {
    assert.equal(l.type, 'junction');
    assert.ok(isAbsolute(l.target));
  }
  assert.ok(lstatSync(currentDir(sb.home)).isSymbolicLink());
  assert.equal(readlinkSync(currentDir(sb.home)), join(sb.home, 'app', version));
  assert.equal(installedVersion(sb.home), version);
  // again (an update): the old junction goes, the new one is renamed into place
  const second = applySetup(args);
  assert.equal(second.appLine, WIN_APP_LINE);
  assert.equal(installedVersion(sb.home), version);
  const s = JSON.parse(readFileSync(join(sb.claude, 'settings.json'), 'utf8'));
  const cmd = `node '${currentBin(sb.home).replace(/\\/g, '/')}'`;
  assert.equal(cmd, kadansCommand(currentBin(sb.home), { platform: 'win32' }));
  assert.equal(s.statusLine.command, `${cmd} statusline`);
  assert.equal(s.hooks.Stop[0].hooks[0].command, `${cmd} hook stop`);
  assert.equal(JSON.parse(readFileSync(resolve(dirname(BIN), '..', 'package.json'), 'utf8')).os.join(','), 'darwin,win32');
});
