// k41: the owner's other computers (paired Orca environments): list, add from a pairing code, remove.
// - list: `orca environment list --json` (fresh, written to the k38 cache) + the k38 per-machine state (lib/remote.mjs)
//   -> [{ id, name, status: online | stale | offline | unknown, agents }].
// - add: the pairing code comes on STDIN only (argv shows in `ps`). It is checked (orca://pair?... with URL-safe
//   characters, <= 2048), handed to `orca environment add --name <name> --pairing-code <code> --json` and forgotten. It
//   is never written to disk, logged, echoed or put in an error: every error here is a fixed string. orca itself takes
//   the code as an argument, so it is visible in `ps` for the moment orca runs (no stdin option in orca today).
// - remove: an id from the fresh env list -> `orca environment rm --environment <id> --json`.
// orca's stderr is never read (remoteCaller ignores it) and its stdout is only parsed for the env list.
import { readSync } from 'node:fs';
import { REMOTE_OFFLINE_MS, REMOTE_STALE_MS, parseEnvs, readRemote, readRemoteCache, setEnvList } from './remote.mjs';

export const CODE_MAX = 2048;
export const NAME_MAX = 32;
export const STDIN_MAX = 4096;
export const LIST_TIMEOUT_MS = 5000;
export const ADD_TIMEOUT_MS = 30_000; // pairing reaches the other computer
export const RM_TIMEOUT_MS = 10_000;

// Fixed errors (the CLI prints them after "kadans: "). Nothing from orca or from the code ever goes in.
export const ERR = {
  code: 'refused: that is not a pairing code (it starts with orca://pair?)',
  name: 'refused: the name takes 1 to 32 letters, digits, spaces or dashes, starting with a letter or digit',
  taken: 'refused: a computer with that name is already paired',
  id: 'refused: no paired computer with that id',
  tty: 'refused: pipe the pairing code on stdin, for example: pbpaste | kadans computers add --name PC',
  noOrca: 'orca not found (install Orca, or set KADANS_ORCA_BIN)',
  list: 'could not read the paired computers from orca',
  add: 'could not add the computer (check the code: each code works once, for a short time)',
  rm: 'could not remove the computer',
};

const CODE_RE = /^orca:\/\/pair\?[A-Za-z0-9_.~%=&+/:-]+$/;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} -]*$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

// The pasted code (outer spaces and the trailing newline dropped), or null. Never returns or throws the input.
export function validCode(raw) {
  if (typeof raw !== 'string' || raw.length > STDIN_MAX) return null;
  const s = raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  return s.length <= CODE_MAX && CODE_RE.test(s) ? s : null;
}
export function validName(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return [...s].length <= NAME_MAX && NAME_RE.test(s) ? s : null;
}
export const validId = (raw) => (typeof raw === 'string' && ID_RE.test(raw) ? raw : null);

// stdin, at most max + 1 bytes kept (more means too long). null when stdin is a terminal or unreadable.
export function readStdin(fd = 0, isTTY = process.stdin.isTTY, max = STDIN_MAX) {
  if (isTTY) return null;
  const chunks = [];
  let total = 0;
  const buf = Buffer.alloc(1024);
  for (;;) {
    let n;
    try {
      n = readSync(fd, buf);
    } catch (e) {
      if (e.code === 'EAGAIN') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); // a non-blocking pipe with nothing yet
        continue;
      }
      if (e.code === 'EOF') break;
      return null;
    }
    if (!n) break;
    if (total <= max) chunks.push(Buffer.from(buf.subarray(0, n)));
    total += n;
  }
  buf.fill(0);
  const out = Buffer.concat(chunks);
  const text = total > max ? 'x'.repeat(max + 1) : out.toString('utf8');
  out.fill(0);
  return text;
}

async function freshEnvs(home, call, now) {
  const r = await call(['environment', 'list', '--json'], LIST_TIMEOUT_MS);
  if (!r.ok) return null;
  let list;
  try {
    list = parseEnvs(r.text);
  } catch {
    return null;
  }
  try {
    setEnvList(home, list, now);
  } catch {
    // best effort: the list is still right for this run
  }
  return list;
}

// One machine's state from the k38 cache, as readRemote reads it.
export function machineStatus(m, now) {
  if (!m || !Number.isFinite(m.tried)) return { status: 'unknown', agents: null };
  const age = Number.isFinite(m.t) ? now - m.t : Infinity;
  if (m.error || age > REMOTE_OFFLINE_MS) return { status: 'offline', agents: 0 };
  const agents = Array.isArray(m.agents) ? m.agents.length : 0;
  return { status: age > REMOTE_STALE_MS ? 'stale' : 'online', agents };
}

// -> { ok: true, list: [{ id, name, status, agents }] } | { ok: false, why }. live false (config remoteAgents off):
// no `worktree ps`, so every status is unknown.
export async function listComputers(home, { call, now = Date.now(), live = true } = {}) {
  if (!call) return { ok: false, why: ERR.noOrca };
  const envs = await freshEnvs(home, call, now);
  if (!envs) return { ok: false, why: ERR.list };
  if (live) await readRemote(home, { call, now }).catch(() => []);
  const machines = live ? readRemoteCache(home).machines : {};
  return { ok: true, list: envs.map((e) => ({ id: e.id, name: e.name, ...machineStatus(machines[e.id], now) })) };
}

// -> { ok: true, computer: { id, name } } | { ok: false, why }. code: the raw stdin text.
export async function addComputer(home, { call, name, code, now = Date.now() } = {}) {
  const n = validName(name);
  if (!n) return { ok: false, why: ERR.name };
  let c = validCode(code);
  if (!c) return { ok: false, why: ERR.code };
  if (!call) return { ok: false, why: ERR.noOrca };
  const before = await freshEnvs(home, call, now);
  if (before?.some((e) => e.name.toLowerCase() === n.toLowerCase())) return { ok: false, why: ERR.taken };
  const r = await call(['environment', 'add', '--name', n, '--pairing-code', c, '--json'], ADD_TIMEOUT_MS);
  c = null; // done with it; orca's answer is not parsed (it may carry tokens)
  if (!r.ok) return { ok: false, why: ERR.add };
  const after = await freshEnvs(home, call, now);
  const found = after?.find((e) => e.name.toLowerCase() === n.toLowerCase() && !before?.some((b) => b.id === e.id))
    ?? after?.find((e) => e.name.toLowerCase() === n.toLowerCase());
  return { ok: true, computer: found ? { id: found.id, name: found.name } : { id: null, name: n } };
}

// -> { ok: true } | { ok: false, why }. Only an id from the fresh env list reaches orca.
export async function removeComputer(home, { call, id, now = Date.now() } = {}) {
  const want = validId(id);
  if (!want) return { ok: false, why: ERR.id };
  if (!call) return { ok: false, why: ERR.noOrca };
  const envs = await freshEnvs(home, call, now);
  if (!envs) return { ok: false, why: ERR.list };
  if (!envs.some((e) => e.id === want)) return { ok: false, why: ERR.id };
  const r = await call(['environment', 'rm', '--environment', want, '--json'], RM_TIMEOUT_MS);
  if (!r.ok) return { ok: false, why: ERR.rm };
  await freshEnvs(home, call, now);
  return { ok: true };
}
