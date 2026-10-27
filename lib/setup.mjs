// `kadans setup`: one command for a new user (`npx kadans@latest setup`), and the same command updates.
// npx runs Kadans from npm's cache (~/.npm/_npx/<hash>/...), which npm cleans. So setup never points anything at the
// package it runs from: it copies the runtime to <KADANS_HOME>/app/<version>/, points <KADANS_HOME>/app/current at it
// (a symlink swapped atomically; a directory junction on Windows, see swapCurrent), and the hooks and the menu bar app
// use .../app/current. Later updates only move the link; the hooks stay as they are.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan } from './install.mjs';
import { isWin, renameRetry } from './platform.mjs';

// What a user runs: the CLI, its modules, the panel, the app sources and the script that builds the app.
export const RUNTIME = ['bin', 'lib', 'app/web', 'app/mac/Package.swift', 'app/mac/Sources', 'scripts/build-app.sh', 'package.json', 'LICENSE'];
// Never copied: build output, Finder litter, the panel's dev page and its invented fixtures.
const SKIP = new Set(['.build', 'build', '.DS_Store', 'node_modules', 'fixtures', 'dev.html']);
export const KEEP = 2;

export const WIN_APP_LINE = 'The menu bar app is macOS-only; the hooks and `npx kadans status` work.';
export const NO_TOOLCHAIN = "The menu bar app needs Apple's Command Line Tools: run xcode-select --install, then run setup again. The hooks and `npx kadans status` work now.";

// The package Kadans runs from (the folder holding bin/ and lib/).
export const SOURCE = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

const expandHome = (p) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
export const appRoot = (home) => join(resolve(expandHome(home)), 'app');
export const currentDir = (home) => join(appRoot(home), 'current');
export const currentBin = (home) => join(currentDir(home), 'bin', 'kadans.mjs');
export const appsDir = (env = process.env) => resolve(expandHome(env.KADANS_APPS_DIR || join(homedir(), 'Applications')));
export const isNpxCache = (p) => /[\\/]_npx[\\/]/.test(p);

function inside(dir, p) {
  const rel = relative(dir, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// The path hooks (and the kickoff schedule) should run. Node resolves the app/current symlink of the main module, so a
// copy started through it sees app/<version>/bin/kadans.mjs: that folder goes away two updates later, app/current stays.
export function stableBin(ownBin, home) {
  const root = appRoot(home);
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // no setup copy yet
  }
  return inside(root, ownBin) || inside(real, ownBin) ? currentBin(home) : ownBin;
}

export function packageVersion(src = SOURCE) {
  return JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version;
}

// 1.10.0 > 1.9.2; anything that is not a plain x.y.z sorts below the real versions.
export function versionCmp(a, b) {
  const parse = (v) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0) || a.localeCompare(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// The version app/current points at, or null.
export function installedVersion(home) {
  try {
    return basename(readlinkSync(currentDir(home)).replace(/[\\/]+$/, '')); // a junction's target is absolute
  } catch {
    return null;
  }
}

// The version folders in app/, newest first (hidden temp folders and the current link left out).
export function versions(home) {
  let names = [];
  try {
    names = readdirSync(appRoot(home), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
  } catch {
    // no app/ yet
  }
  return names.sort((a, b) => versionCmp(b, a));
}

export function copyRuntime(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const p of RUNTIME) {
    const from = join(src, p);
    if (!existsSync(from)) {
      if (p === 'LICENSE') continue;
      throw new Error(`setup: ${from} is missing; this copy of Kadans is incomplete`);
    }
    mkdirSync(dirname(join(dest, p)), { recursive: true });
    cpSync(from, join(dest, p), { recursive: true, filter: (f) => !SKIP.has(basename(f)) });
  }
}

// Points app/current at <name> (relative link, so a moved KADANS_HOME keeps working): a new link renamed over the old
// one, so a hook never finds app/current missing.
// win32 (fix-3): a symlink needs admin rights there, so app/current is a directory junction, which must have an
// absolute target. Windows will not rename over an existing junction: the old one is removed first, then the new one
// renamed into place. That is not atomic: a hook starting in that moment finds no app/current and fails once.
export function swapCurrent(home, name, { platform = process.platform, link = symlinkSync } = {}) {
  const root = appRoot(home);
  const win = isWin(platform);
  const cur = join(root, 'current');
  const tmp = join(root, `.current-${process.pid}`);
  rmSync(tmp, { force: true });
  if (win) link(join(root, name), tmp, 'junction');
  else link(name, tmp);
  try {
    const st = lstatSync(cur);
    if (st.isDirectory() && !st.isSymbolicLink()) throw new Error(`setup: ${cur} is a folder, not a link; move it away and run setup again`);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      rmSync(tmp, { force: true });
      throw e;
    }
  }
  if (win) {
    try {
      unlinkSync(cur); // the junction only (libuv removes a directory reparse point), never what it points at
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    renameRetry(tmp, cur, { platform });
  } else renameSync(tmp, cur);
}

// Keeps the newest `keep` version folders and the one app/current points at; returns the removed names.
export function prune(home, keep = KEEP) {
  const cur = installedVersion(home);
  const removed = [];
  // Leftovers of a setup that crashed mid-copy (.new-<version>-<pid>, .current-<pid>).
  try {
    for (const n of readdirSync(appRoot(home))) {
      if (/^\.(new-.+|current)-\d+$/.test(n) && !n.endsWith(`-${process.pid}`)) rmSync(join(appRoot(home), n), { recursive: true, force: true });
    }
  } catch {
    // no app/ yet
  }
  for (const name of versions(home).slice(keep)) {
    if (name === cur) continue;
    rmSync(join(appRoot(home), name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

// Copies src to app/<version>, points app/current at it, prunes old versions. Returns { dir, previous, removed, copied }.
export function installRuntime({ src = SOURCE, home, version = packageVersion(src), platform = process.platform, link = symlinkSync }) {
  const sw = (name) => swapCurrent(home, name, { platform, link });
  const root = appRoot(home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const previous = installedVersion(home);
  const dest = join(root, version);
  let same = false;
  try {
    same = realpathSync(src) === realpathSync(dest);
  } catch {
    // dest does not exist yet
  }
  if (!same) {
    const tmp = join(root, `.new-${version}-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    copyRuntime(src, tmp);
    if (!existsSync(dest)) renameSync(tmp, dest);
    else {
      // Same version again: app/current may point at dest. Point it at the fresh copy first, then replace dest.
      sw(basename(tmp));
      rmSync(dest, { recursive: true, force: true });
      cpSync(tmp, dest, { recursive: true });
      sw(version);
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  sw(version);
  return { dir: dest, previous, removed: prune(home), copied: !same };
}

// xcode-select from PATH (tests put a fake one first).
export function hasToolchain(env = process.env) {
  const r = spawnSync('xcode-select', ['-p'], { env, encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 && Boolean(r.stdout.trim());
}

// Builds the app from app/current (so Info.plist's KadansRepo is .../app/current) and installs it into appsDir.
// build-app.sh takes the heavy-job lock itself. Returns { ok, app }.
export function buildApp(home, env = process.env) {
  const apps = appsDir(env);
  const r = spawnSync('/bin/bash', [join(currentDir(home), 'scripts', 'build-app.sh')], {
    cwd: currentDir(home),
    env: { ...env, KADANS_APPS_DIR: apps },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  // Swift's build folder (~80 MB) is not needed once the app is copied out; every update builds from a fresh copy.
  if (r.status === 0) rmSync(join(currentDir(home), 'app', 'mac', '.build'), { recursive: true, force: true });
  return { ok: r.status === 0, app: join(apps, 'Kadans.app') };
}

const BUNDLE_ID = 'dev.kadans.app';

// Quits a running Kadans (a polite quit, never a kill) and opens the given app.
export function reopenApp(app) {
  const script = `if application id "${BUNDLE_ID}" is running then tell application id "${BUNDLE_ID}" to quit`;
  spawnSync('osascript', ['-e', script], { timeout: 15_000 });
  for (let i = 0; i < 20; i++) {
    if (spawnSync('pgrep', ['-x', 'Kadans']).status !== 0) break;
    spawnSync('sleep', ['0.25']);
  }
  return spawnSync('open', [app]).status === 0;
}

// The apply half of `kadans setup` (the preview and the question stay in bin/kadans.mjs): copy, app/current, hooks
// (always at app/current, in the platform's command form), then the app. win32: no app build and no open.
// deps (tests): link, build, reopen. Returns { rt, w, appLine }.
export function applySetup({ src = SOURCE, home, cfgDir, version, platform = process.platform, env = process.env, wantApp = true, toolchain = false, open = true, deps = {} }) {
  const { link = symlinkSync, build = buildApp, reopen = reopenApp } = deps;
  const rt = installRuntime({ src, home, version, platform, link });
  const w = plan({ kind: 'install', cfgDir, home, bin: currentBin(home), repoint: true, apply: true, platform });
  let appLine = 'skipped (--no-app)';
  if (isWin(platform)) appLine = WIN_APP_LINE;
  else if (wantApp && !toolchain) appLine = 'not built: Command Line Tools missing';
  else if (wantApp && toolchain) {
    process.stdout.write('Building the menu bar app (a minute or two the first time)...\n');
    const b = build(home, env);
    if (!b.ok) appLine = `build failed (see above); the hooks work without it. Try again: npx kadans@latest setup`;
    else {
      appLine = b.app;
      if (open) appLine += reopen(b.app) ? ' (restarted)' : ' (open it yourself: it did not start)';
    }
  }
  return { rt, w, appLine };
}
