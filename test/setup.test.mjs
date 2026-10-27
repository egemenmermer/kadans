// k39: `kadans setup` (npx install/update) and `uninstall --all`. Temp HOME, KADANS_HOME, CLAUDE_CONFIG_DIR and
// KADANS_APPS_DIR; a fake xcode-select that fails comes first on PATH, so no test ever builds the app or opens it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_TOOLCHAIN, SOURCE, copyRuntime, isNpxCache, packageVersion, stableBin, versionCmp } from '../lib/setup.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
const VERSION = packageVersion();

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'kadans-setup-'));
  const fake = join(root, 'fakebin');
  mkdirSync(fake);
  writeFileSync(join(fake, 'xcode-select'), '#!/bin/sh\necho "xcode-select: error: no developer tools" >&2\nexit 2\n');
  chmodSync(join(fake, 'xcode-select'), 0o755);
  const home = join(root, 'kadans');
  const claude = join(root, 'claude');
  const apps = join(root, 'Apps');
  const env = { PATH: `${fake}:${process.env.PATH}`, HOME: root, KADANS_HOME: home, CLAUDE_CONFIG_DIR: claude, KADANS_APPS_DIR: apps, KADANS_ORCA: '0' };
  return { root, home, claude, apps, env, settings: join(claude, 'settings.json') };
}

function run(sb, args, bin = BIN) {
  const r = spawnSync(process.execPath, [bin, ...args], { env: sb.env, encoding: 'utf8', timeout: 30000, input: '' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// Every command of ours (status line + hooks) in settings.json.
function ourCommands(file) {
  const s = JSON.parse(readFileSync(file, 'utf8'));
  const out = [];
  if (/kadans/.test(s.statusLine?.command ?? '')) out.push(s.statusLine.command);
  for (const groups of Object.values(s.hooks ?? {})) for (const g of groups) for (const h of g.hooks) if (/kadans/.test(h.command)) out.push(h.command);
  return out;
}

// A copy of this package with another version, as a newer npx download would be.
function release(sb, version) {
  const src = join(sb.root, `pkg-${version}`);
  copyRuntime(SOURCE, src);
  const pj = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
  writeFileSync(join(src, 'package.json'), JSON.stringify({ ...pj, version }));
  return join(src, 'bin', 'kadans.mjs');
}

test('help lists setup first', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.match(r.stdout, /^Usage:\n {2}kadans setup /m);
});

test('no TTY and no --yes: preview only, nothing created or written', () => {
  const sb = sandbox();
  mkdirSync(sb.claude);
  const before = '{\n  "theme": "dark"\n}\n';
  writeFileSync(sb.settings, before);
  const r = run(sb, ['setup']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Preview only: nothing changed\. To apply: npx kadans@latest setup --yes/);
  assert.match(r.out, /adds Stop hook stop/);
  assert.match(r.out, new RegExp(NO_TOOLCHAIN.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(readFileSync(sb.settings, 'utf8'), before);
  assert.equal(existsSync(sb.home), false, 'KADANS_HOME not created');
  assert.equal(existsSync(sb.apps), false);
});

test('--yes --no-app: copies the runtime, current link, hooks at app/current (never the source dir)', () => {
  const sb = sandbox();
  const r = run(sb, ['setup', '--yes', '--no-app']);
  assert.equal(r.code, 0, r.err);
  const dir = join(sb.home, 'app', VERSION);
  assert.equal(readlinkSync(join(sb.home, 'app', 'current')), VERSION);
  for (const p of ['bin/kadans.mjs', 'lib/setup.mjs', 'app/web/panel.html', 'app/mac/Package.swift', 'app/mac/Sources/Kadans/CLI.swift', 'scripts/build-app.sh', 'package.json', 'LICENSE']) {
    assert.ok(existsSync(join(dir, p)), p);
  }
  for (const p of ['app/web/dev.html', 'app/web/fixtures', 'test', 'docs', 'app/mac/.build']) assert.equal(existsSync(join(dir, p)), false, p);
  const cmds = ourCommands(sb.settings);
  assert.equal(cmds.length, 12);
  const want = `node '${join(sb.home, 'app', 'current', 'bin', 'kadans.mjs')}' `;
  for (const c of cmds) {
    assert.ok(c.startsWith(want), c);
    assert.ok(!c.includes(SOURCE), c);
  }
  assert.match(r.out, /Kadans [\d.]+ is set up\./);
  assert.match(r.out, /app: {4}skipped \(--no-app\)/);
  assert.match(r.out, /undo: {3}npx kadans@latest uninstall --apply --all/);
  assert.equal(existsSync(sb.apps), false);
  // The copy runs on its own, and reports app/current (not app/<version>) as its hook path.
  const help = spawnSync(process.execPath, [join(sb.home, 'app', 'current', 'bin', 'kadans.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  const j = JSON.parse(run(sb, ['install', '--json'], join(dir, 'bin', 'kadans.mjs')).out);
  assert.equal(j.changed, false);
  assert.equal(j.command, `node '${join(sb.home, 'app', 'current', 'bin', 'kadans.mjs')}'`);
});

test('missing Command Line Tools: one plain line, hooks still installed, no app dir', () => {
  const sb = sandbox();
  const r = run(sb, ['setup', '--no-open', '--yes']);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.trimEnd().endsWith(NO_TOOLCHAIN), r.out);
  assert.match(r.out, /app: {4}not built: Command Line Tools missing/);
  assert.equal(ourCommands(sb.settings).length, 12);
  assert.equal(existsSync(sb.apps), false);
});

test('re-run updates: same version refreshes, newer versions move the link, hooks stay, newest 2 kept', () => {
  const sb = sandbox();
  assert.equal(run(sb, ['setup', '--yes', '--no-app']).code, 0);
  const settings = readFileSync(sb.settings, 'utf8');
  const again = run(sb, ['setup', '--yes', '--no-app']);
  assert.match(again.out, new RegExp(`refreshes Kadans ${VERSION.replace(/\./g, '\\.')}`));
  assert.match(again.out, /already up to date/);
  assert.equal(readlinkSync(join(sb.home, 'app', 'current')), VERSION);

  const up = run(sb, ['setup', '--no-app', '--yes'], release(sb, '9.0.0'));
  assert.equal(up.code, 0, up.err);
  assert.match(up.out, new RegExp(`updates Kadans ${VERSION.replace(/\./g, '\\.')} -> 9\\.0\\.0`));
  assert.equal(readlinkSync(join(sb.home, 'app', 'current')), '9.0.0');
  assert.equal(readFileSync(sb.settings, 'utf8'), settings, 'hooks untouched by an update');
  assert.ok(existsSync(join(sb.home, 'app', VERSION)), 'previous version kept');

  mkdirSync(join(sb.home, 'app', '.new-9.0.0-1'));
  const up2 = run(sb, ['setup', '--yes', '--no-app'], release(sb, '10.0.0'));
  assert.equal(up2.code, 0, up2.err);
  assert.equal(readlinkSync(join(sb.home, 'app', 'current')), '10.0.0');
  assert.ok(existsSync(join(sb.home, 'app', '9.0.0')));
  assert.equal(existsSync(join(sb.home, 'app', VERSION)), false, 'oldest removed');
  assert.equal(existsSync(join(sb.home, 'app', '.new-9.0.0-1')), false, 'crash leftover removed');
  assert.match(up2.out, new RegExp(`removed old ${VERSION.replace(/\./g, '\\.')}`));
  assert.equal(readFileSync(sb.settings, 'utf8'), settings);
});

test('setup moves an older install (other path) to app/current; foreign hooks and the saved status line stay', () => {
  const sb = sandbox();
  mkdirSync(sb.claude);
  mkdirSync(sb.home);
  const old = "node '/opt/x/bin/kadans.mjs'";
  const foreign = { type: 'command', command: 'node /opt/other/stop.mjs' };
  writeFileSync(sb.settings, JSON.stringify({
    statusLine: { type: 'command', command: `${old} statusline` },
    hooks: {
      Stop: [{ hooks: [foreign] }, { hooks: [{ type: 'command', command: `${old} hook stop`, timeout: 30 }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${old} hook pace-pre`, timeout: 60 }] }],
    },
  }));
  const saved = JSON.stringify({ statusLine: { type: 'command', command: '~/old-line.sh' } });
  writeFileSync(join(sb.home, 'install.json'), saved);
  const r = run(sb, ['setup', '--yes', '--no-app']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /moves 3 existing Kadans hooks to the new path/);
  const s = JSON.parse(readFileSync(sb.settings, 'utf8'));
  assert.deepEqual(s.hooks.Stop[0].hooks[0], foreign);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].timeout, 60);
  assert.equal(s.hooks.PreToolUse[0].matcher, '*');
  const cmds = ourCommands(sb.settings);
  assert.equal(cmds.length, 12);
  for (const c of cmds) assert.ok(c.includes(join('app', 'current', 'bin', 'kadans.mjs')) && !c.includes('/opt/x'), c);
  assert.equal(readFileSync(join(sb.home, 'install.json'), 'utf8'), saved);
});

test('install --apply from an npx cache copy is refused; nothing written', () => {
  const sb = sandbox();
  const pkg = join(sb.root, '_npx', 'abc123', 'node_modules', 'kadans');
  copyRuntime(SOURCE, pkg);
  const r = run(sb, ['install', '--apply'], join(pkg, 'bin', 'kadans.mjs'));
  assert.equal(r.code, 2);
  assert.match(r.err, /npx kadans@latest setup/);
  assert.equal(existsSync(sb.settings), false);
});

test('uninstall leaves the store alone; --all removes app/ and Kadans.app but keeps the data without a yes', () => {
  const sb = sandbox();
  assert.equal(run(sb, ['setup', '--yes', '--no-app']).code, 0);
  mkdirSync(join(sb.apps, 'Kadans.app'), { recursive: true });
  writeFileSync(join(sb.home, 'config.json'), '{"notify":false}\n');
  const un = run(sb, ['uninstall', '--apply']);
  assert.equal(un.code, 0, un.err);
  assert.equal(ourCommands(sb.settings).length, 0);
  assert.match(un.out, /Remove with: kadans uninstall --apply --all/);
  assert.ok(existsSync(join(sb.home, 'app', 'current')));
  assert.ok(existsSync(join(sb.home, 'config.json')));

  const preview = run(sb, ['uninstall', '--all']);
  assert.match(preview.out, /--all would also remove/);
  assert.ok(existsSync(join(sb.home, 'app')));

  const all = run(sb, ['uninstall', '--apply', '--all']);
  assert.equal(all.code, 0, all.err);
  assert.equal(existsSync(join(sb.home, 'app')), false);
  assert.equal(existsSync(join(sb.apps, 'Kadans.app')), false);
  assert.ok(existsSync(join(sb.home, 'config.json')), 'store kept');
  assert.match(all.out, /kept your data in .*To delete it too: rm -rf/);
});

test('stableBin, isNpxCache, versionCmp', () => {
  assert.equal(stableBin('/h/k/app/1.1.0/bin/kadans.mjs', '/h/k'), '/h/k/app/current/bin/kadans.mjs');
  assert.equal(stableBin('/opt/src/bin/kadans.mjs', '/h/k'), '/opt/src/bin/kadans.mjs');
  assert.ok(isNpxCache('/Users/me/.npm/_npx/0a1b/node_modules/kadans/bin/kadans.mjs'));
  assert.ok(!isNpxCache('/opt/homebrew/lib/node_modules/kadans/bin/kadans.mjs'));
  assert.ok(versionCmp('1.10.0', '1.9.2') > 0);
  assert.equal(versionCmp('1.1.0', '1.1.0'), 0);
  assert.ok(versionCmp('x', '1.0.0') < 0);
});
