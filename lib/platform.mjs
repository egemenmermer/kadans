// k37: the few calls that differ on Windows. Finding executables (PATH + PATHEXT), finding the orca CLI (Windows keeps it
// at %LOCALAPPDATA%\Programs\orca\resources\bin\orca.cmd, often not on PATH) and running it. Since Node 20 a .cmd/.bat
// cannot be spawned without a shell, so it runs as `cmd.exe /d /v:off /s /c ""<bin>" <args>"` with every argument and the
// path itself checked against a strict allow-list first: no shell metacharacter ever reaches cmd.exe, and no `shell: true`.
// Everything takes an injected platform / env / access so the win32 paths are tested on a Mac.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, renameSync } from 'node:fs';
import path from 'node:path';

export const pathFor = (platform = process.platform) => (platform === 'win32' ? path.win32 : path.posix);
export const isWin = (platform = process.platform) => platform === 'win32';

function canRun(file) {
  try {
    accessSync(file, constants.X_OK); // on Windows X_OK is the same as F_OK
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

// Absolute path of an executable on PATH, or null. On win32 a bare name also tries the PATHEXT extensions (orca ->
// orca.cmd) and PATH entries may be quoted.
export function onPath(name, pathVar = process.env.PATH ?? '', { platform = process.platform, pathExt, access = canRun } = {}) {
  const p = pathFor(platform);
  const win = isWin(platform);
  const exts = win && !p.extname(name) ? String(pathExt || DEFAULT_PATHEXT).split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  for (let d of String(pathVar ?? '').split(p.delimiter)) {
    if (win) d = d.replace(/^"(.*)"$/, '$1');
    if (!d) continue;
    for (const e of exts) {
      const f = p.join(d, name + e);
      if (access(f)) return f;
    }
  }
  return null;
}

// Where the Windows installer puts the orca CLI (per-user install), or null without LOCALAPPDATA.
export function orcaWindowsDefault(env = process.env) {
  const base = env.LOCALAPPDATA;
  return typeof base === 'string' && base ? path.win32.join(base, 'Programs', 'orca', 'resources', 'bin', 'orca.cmd') : null;
}

// The orca CLI: KADANS_ORCA_BIN, then (Windows) the installer's default place, then PATH. Null when none is found.
export function findOrca(env = process.env, { platform = process.platform, access = canRun } = {}) {
  if (env.KADANS_ORCA_BIN) return env.KADANS_ORCA_BIN;
  if (isWin(platform)) {
    const d = orcaWindowsDefault(env);
    if (d && access(d)) return d;
    return onPath('orca', env.PATH ?? env.Path, { platform, pathExt: env.PATHEXT, access });
  }
  return onPath('orca', env.PATH, { platform, access });
}

// What may reach cmd.exe. Arguments: letters, digits, space and _ . , : / = @ + - (environment ids, flags, names).
// The .cmd path: also \ ( ) ~ ' (it sits inside double quotes). Never & | > < ^ " % ! ; or a line break.
export const CMD_ARG_RE = /^[\p{L}\p{N} _.,:/=@+-]*$/u;
export const CMD_BIN_RE = /^[\p{L}\p{N} _.,:/=@+\-\\()~']+$/u;
const needsCmd = (bin, platform) => isWin(platform) && /\.(cmd|bat)$/i.test(String(bin));

export function cmdExe(env = process.env) {
  return path.win32.join(env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows', 'System32', 'cmd.exe');
}

// (bin, args) -> { file, args, opts } for spawn / spawnSync. macOS and Linux: unchanged. Windows .cmd/.bat: through
// cmd.exe with verbatim arguments, after the allow-list (throws a fixed message that never quotes the argument).
export function orcaSpawn(bin, args, { platform = process.platform, env = process.env } = {}) {
  if (!needsCmd(bin, platform)) return { file: bin, args, opts: {} };
  if (!CMD_BIN_RE.test(String(bin))) throw new Error('refused: the orca path has characters cmd.exe would interpret');
  for (const a of args) {
    if (typeof a !== 'string' || !CMD_ARG_RE.test(a)) throw new Error('refused: an orca argument has characters cmd.exe would interpret');
  }
  const line = [`"${bin}"`, ...args.map((a) => (a === '' || / /.test(a) ? `"${a}"` : a))].join(' ');
  return { file: cmdExe(env), args: ['/d', '/v:off', '/s', '/c', `"${line}"`], opts: { windowsVerbatimArguments: true } };
}

// Stops a child we started. On Windows a .cmd child is cmd.exe: killing it would leave orca running, so the whole tree
// goes (taskkill /T /F with the numeric pid only).
export function killChild(child, { platform = process.platform, run = spawnSync } = {}) {
  if (!child) return;
  if (isWin(platform) && Number.isInteger(child.pid)) {
    try {
      const r = run('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
      if (!r?.error && r?.status === 0) return;
    } catch {
      // fall back to kill()
    }
  }
  try {
    child.kill();
  } catch {
    // already gone
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// renameSync over an existing file. Windows refuses it (EPERM / EACCES / EBUSY) while another process has the target
// open for a moment (a hook reading it): retry a few times there. Elsewhere one try, as before.
export function renameRetry(from, to, { platform = process.platform, rename = renameSync, tries = 8 } = {}) {
  for (let i = 1; ; i++) {
    try {
      rename(from, to);
      return;
    } catch (e) {
      if (!isWin(platform) || i >= tries || !['EPERM', 'EACCES', 'EBUSY'].includes(e?.code)) throw e;
      sleep(10 * i);
    }
  }
}
