// k37: `kadans connect [--name <name>]` makes this computer (Windows PC or any other) show up in the Mac's panel with one
// command: it finds the orca CLI (lib/platform.mjs), runs `orca serve` in the foreground (Ctrl+C stops it) and puts the
// pairing code on this terminal with one line on what to do with it. The code goes to this terminal only: it is never
// written to a file, a log, ~/.kadans or an error message. `orca serve` has no name flag: the name is only shown, for the
// Mac's Add dialog.
import { spawn as nodeSpawn } from 'node:child_process';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline';
import { findOrca, killChild, orcaSpawn } from './platform.mjs';

export const CONNECT_HINT = 'On your Mac: Kadans › Settings › Computers › Add, paste this code.';
export const ORCA_MISSING = 'Orca is not installed on this computer: get it from https://github.com/stablyai/orca/releases, open it once, then run kadans connect again.';
const PAIRING_PREFIX = 'Pairing URL: ';
const STOP_WAIT_MS = 5000;

// Letters, digits, space and dash, at most 32 (what the Mac's Add dialog takes); null when nothing is left.
export function cleanName(s) {
  const n = String(s ?? '').replace(/[^\p{L}\p{N} -]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 32).trim();
  return n || null;
}

// One line of `orca serve` output -> what this terminal shows (null: nothing). The pairing line becomes the code alone
// plus the hint; the web-client URL and mobile QR (other ways to pair, the same secret inside) are left out.
export function connectLines(line, name) {
  if (line.startsWith(PAIRING_PREFIX)) {
    const code = line.slice(PAIRING_PREFIX.length).trim();
    return ['', `Pairing code for "${name}":`, code, CONNECT_HINT, `Name it "${name}". Keep this window open; Ctrl+C stops it.`, ''];
  }
  if (line.startsWith('Web client URL: ') || line.startsWith('Mobile pairing QR:')) return null;
  return [line];
}

// deps: env, platform, find(env, { platform }) -> bin | null, spawn, out/err (writable), host(), signals (an emitter for
// SIGINT/SIGTERM, default process). Resolves the exit code; never rejects.
export function runConnect(args, deps = {}) {
  const { env = process.env, platform = process.platform, find = findOrca, spawn = nodeSpawn, out = process.stdout, err = process.stderr,
    host = hostname, signals = process, kill = killChild } = deps;
  let name = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--name' && i + 1 < args.length) name = args[++i];
    else if (a.startsWith('--name=')) name = a.slice(7);
    else {
      err.write('usage: kadans connect [--name <name>]\n');
      return Promise.resolve(2);
    }
  }
  const shown = cleanName(name ?? host()) ?? 'this computer';
  const bin = find(env, { platform });
  if (!bin) {
    err.write(`${ORCA_MISSING}\n`);
    return Promise.resolve(1);
  }
  let s;
  try {
    s = orcaSpawn(bin, ['serve'], { platform, env });
  } catch (e) {
    err.write(`${e.message}\n`);
    return Promise.resolve(1);
  }
  return new Promise((done) => {
    let child;
    try {
      // stdin and stderr stay this terminal's; stdout comes through here so the pairing line can be shown plainly.
      child = spawn(s.file, s.args, { ...s.opts, stdio: ['inherit', 'pipe', 'inherit'] });
    } catch {
      err.write('could not start orca serve\n');
      done(1);
      return;
    }
    out.write(`Starting Orca on this computer as "${shown}" (Ctrl+C stops it)...\n`);
    let stopping = false;
    let timer = null;
    // Ctrl+C reaches orca through the terminal too; wait for it to end, and stop it ourselves if it does not.
    const stop = () => {
      if (stopping) return;
      stopping = true;
      timer = setTimeout(() => kill(child, { platform }), STOP_WAIT_MS);
      timer.unref?.();
    };
    signals.on('SIGINT', stop);
    signals.on('SIGTERM', stop);
    const finish = (code) => {
      if (timer) clearTimeout(timer);
      signals.removeListener('SIGINT', stop);
      signals.removeListener('SIGTERM', stop);
      done(code);
    };
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => {
        const lines = connectLines(line, shown);
        if (lines) out.write(`${lines.join('\n')}\n`);
      });
    }
    child.on('error', () => {
      err.write('could not start orca serve\n');
      finish(1);
    });
    child.on('close', (code) => finish(stopping ? 0 : code === 0 ? 0 : 1));
  });
}
