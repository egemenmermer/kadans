// fix-3: what `kadans statusline` runs besides itself.
// - config.json "chain" set to a path: that script, as before (same stdin, output dropped). An empty string: nothing.
// - no "chain" key: the statusLine that `install` replaced (saved in <KADANS_HOME>/install.json), with the same stdin.
//   Its output is shown after Kadans' line, so a user's own status line keeps showing. A command string runs the way
//   Claude Code runs statusLine commands: `/bin/sh -c` on macOS and Linux; on Windows Git Bash, or PowerShell when Git
//   Bash is absent (k37 note). Only the user's own saved command ever runs; one of ours is never chained (no loop).
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OURS_RE } from './install.mjs';
import { isWin, onPath, pathFor } from './platform.mjs';

export const CHAIN_TIMEOUT_MS = 5000;
// Set on everything we chain: a wrapper script (or `npx kadans@latest statusline`, which OURS_RE does not match) that
// runs `kadans statusline` again then chains nothing, so the status line can never call itself in a loop.
export const CHAINED = 'KADANS_CHAINED';
const MAX_OUT = 64 * 1024;

const expandHome = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

// The statusLine install saved (the one it replaced), or null.
export function savedStatusLine(home) {
  try {
    const s = JSON.parse(readFileSync(join(home, 'install.json'), 'utf8'))?.statusLine;
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
}

// A saved statusLine we may run: a command string that is not one of ours.
export function userCommand(saved) {
  const c = saved?.command;
  if (typeof c !== 'string' || !c.trim()) return null;
  if (saved.type !== undefined && saved.type !== 'command') return null;
  return OURS_RE.test(c) ? null : c;
}

// What runs: { kind: 'chain', file } | { kind: 'saved', command } | null. An explicit chain (also '') wins.
export function chainTarget(cfg, home) {
  if (typeof cfg?.chain === 'string') return cfg.chain ? { kind: 'chain', file: cfg.chain } : null;
  const command = userCommand(savedStatusLine(home));
  return command ? { kind: 'saved', command } : null;
}

// Git Bash the way Claude Code finds it: CLAUDE_CODE_GIT_BASH_PATH, then next to git.exe on PATH, then the default
// install folder. Never a bare bash.exe from PATH (that may be WSL's).
export function gitBash(env = process.env, { exists = existsSync } = {}) {
  const w = pathFor('win32');
  const set = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (set && exists(set)) return set;
  const git = onPath('git', env.PATH ?? env.Path, { platform: 'win32', pathExt: env.PATHEXT, access: exists });
  const cands = [];
  if (git) cands.push(w.join(w.dirname(w.dirname(git)), 'bin', 'bash.exe'));
  for (const base of [env.ProgramFiles, env.ProgramW6432, 'C:\\Program Files']) if (base) cands.push(w.join(base, 'Git', 'bin', 'bash.exe'));
  return cands.find((f) => exists(f)) ?? null;
}

// (command) -> { file, args } for spawnSync, without `shell: true`.
export function shellSpawn(command, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (!isWin(platform)) return { file: '/bin/sh', args: ['-c', command] };
  const bash = gitBash(env, { exists });
  if (bash) return { file: bash, args: ['-c', command] };
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  const ps = pathFor('win32').join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // -EncodedCommand (UTF-16LE base64): no command-line quoting can change what PowerShell reads.
  return { file: ps, args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')] };
}

// Runs what chainTarget says with the status line's stdin. Returns the text to show after Kadans' line ('' for none).
export function runChained(target, raw, { platform = process.platform, env = process.env, spawn = spawnSync, exists = existsSync } = {}) {
  if (!target || env[CHAINED]) return '';
  if (target.kind === 'chain') {
    const file = expandHome(target.file);
    try {
      accessSync(file, constants.X_OK);
    } catch {
      return '';
    }
    spawn(file, [], { input: raw, env: { ...env, [CHAINED]: '1' }, stdio: ['pipe', 'ignore', 'ignore'], timeout: CHAIN_TIMEOUT_MS });
    return '';
  }
  const { file, args } = shellSpawn(target.command, { platform, env, exists });
  const r = spawn(file, args, { input: raw, env: { ...env, [CHAINED]: '1' }, stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf8', timeout: CHAIN_TIMEOUT_MS, maxBuffer: MAX_OUT, windowsHide: true });
  if (!r || r.error) return '';
  return String(r.stdout ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

// Kadans' line with the user's output inside it: its first line after ours, any further lines below.
export function joinLines(ours, theirs) {
  if (!theirs) return ours;
  if (!ours) return theirs;
  const [first, ...rest] = theirs.split('\n');
  return [`${ours} · ${first}`, ...rest].join('\n');
}

// One short form of a command for the setup preview.
export function shortCommand(c, max = 48) {
  const s = String(c).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
