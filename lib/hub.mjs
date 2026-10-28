// k53: the inbox hub. Orca binds a Run to a live coordinator terminal PANE (k51 §0), so the inbox needs one Orca tab that
// stays open. `kadans inbox setup` (the Mac's and the phone's "Set up" tap) opens that tab itself: `orca terminal create
// --title "Kadans inbox" --command "exec /usr/bin/env KADANS_HOME='<home>' '<node>' '<kadans>' inbox hub"`. Inside it, `kadans inbox hub` binds the Kadans Run
// to its own pane (run-use the kept Run, or run-create once), prints one line, and answers a ping on a Unix socket at
// $KADANS_HOME/hub.sock until the tab closes. Mutations stay direct orca calls with --run/--from (k53 §0: Orca resolves
// the coordinator's pane from the handle); they only ask the hub first, so a closed tab gives one fixed line.
//
// Safety rules (tested in test/inbox-hub.test.mjs):
// - Owner only: the socket lives in the 0700 Kadans folder and is 0600 (umask while listening, chmod, stat check); Node
//   cannot read the peer's uid, so every request must also carry the key from hub.key (0600, random per start), which
//   only this user can read. A client talks only to a socket and key owned by its own uid with no group/other bits.
// - Requests are one small JSON line ({op: "ping", key}); anything else, larger than REQ_MAX, slow or concurrent is
//   refused. Nothing of a request is written anywhere, logged or echoed; the hub's only output is one fixed line.
// - The tab's command is built only from Kadans' own paths (single-quoted, refused with a quote or a control character),
//   never from request data. `exec` replaces the shell: when the hub ends, the tab ends, so nothing typed into the pane
//   (by Orca or anyone) can ever reach a shell there. The hub reads and drops its stdin for the same reason.
// - Setup creates a tab only when no hub answers, under an O_EXCL lock, and never retries a create.
import net from 'node:net';
import { chmodSync, closeSync, lstatSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { ensureHome, writeAtomic } from './store.mjs';
import { PROD_RE } from './text.mjs';

export const HUB_SOCK = 'hub.sock';
export const HUB_KEY = 'hub.key';
export const HUB_LOCK = 'hub.starting';
export const HUB_TITLE = 'Kadans inbox';
export const HUB_LINE = 'Kadans inbox: keep this tab open. Close it to turn the inbox off.';
export const REQ_MAX = 1024; // bytes of one request line; a ping is about 100
export const IDLE_MS = 3000; // a connection that sends no full line in this time is dropped
export const PROBE_MS = 1500; // a client waits this long for the hub's answer
export const SETUP_WAIT_MS = 10_000; // after the tab is created: how long setup waits for the hub to answer
export const POLL_MS = 250;
export const LOCK_STALE_MS = 60_000; // a setup lock older than this is a crash leftover
export const CREATE_TIMEOUT_MS = 15_000;
export const LIST_TIMEOUT_MS = 8000;
const SOCK_PATH_MAX = 103; // macOS sun_path is 104 bytes with the terminating NUL

// Fixed sentences (the CLI prints them after "kadans: "). Nothing from a request, from orca or from a path goes in.
export const HUB_ERR = {
  where: 'the inbox hub runs only inside its own Orca tab (tap Set up in Kadans, or run `kadans inbox setup`)',
  running: 'the inbox already runs in another Orca tab',
  path: 'the Kadans folder path is too long for the inbox socket (set KADANS_HOME to a shorter path)',
  sock: 'could not open the inbox socket in the Kadans folder',
  unbound: 'the "Kadans inbox" tab is open but Orca did not bind it: close that tab, then tap Set up again',
  noOrca: 'orca not found (install Orca, or set KADANS_ORCA_BIN)',
  worktree: 'Orca has no project folder on this Mac to open the inbox tab in: add one in Orca, then tap Set up',
  create: 'Orca did not open the "Kadans inbox" tab',
  slow: 'Orca opened the "Kadans inbox" tab, but the inbox did not answer within 10 seconds: look at that tab',
  busy: 'Set up is already running: wait a few seconds',
  quote: 'refused: the Kadans path has a quote or a control character; move Kadans to a folder without one',
};

const sockOf = (home) => join(home, HUB_SOCK);
const keyOf = (home) => join(home, HUB_KEY);
const KEY_RE = /^[0-9a-f]{64}$/;
const uid = () => (typeof process.getuid === 'function' ? process.getuid() : null);
// A file this user owns with no group or other bits (the socket, the key). Anything else is not ours: never trusted.
const ownerOnly = (st) => uid() !== null && st.uid === uid() && (st.mode & 0o077) === 0;

function readKey(home) {
  try {
    if (!ownerOnly(lstatSync(keyOf(home)))) return null;
    const k = readFileSync(keyOf(home), 'utf8').trim();
    return KEY_RE.test(k) ? k : null;
  } catch {
    return null;
  }
}

// ---------- client ----------

// Asks the hub whether it is there. -> { on, bound }. on false: no hub, a dead socket, a socket or key that is not this
// user's alone, a wrong answer or no answer in timeoutMs. Never throws.
export function hubStatus(home, { timeoutMs = Number(process.env.KADANS_HUB_PROBE_MS) || PROBE_MS } = {}) { // the env var: tests on a loaded machine raise it
  const off = { on: false, bound: false };
  const path = sockOf(home);
  try {
    const st = lstatSync(path);
    if (!st.isSocket() || !ownerOnly(st)) return Promise.resolve(off);
  } catch {
    return Promise.resolve(off);
  }
  const key = readKey(home);
  if (!key) return Promise.resolve(off);
  return new Promise((done) => {
    let buf = '';
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      done(v);
    };
    const sock = net.createConnection(path);
    const timer = setTimeout(() => finish(off), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify({ op: 'ping', key })}\n`));
    sock.on('data', (d) => {
      buf += d;
      if (buf.length > REQ_MAX) return finish(off);
      const nl = buf.indexOf('\n');
      if (nl < 0) return undefined;
      try {
        const j = JSON.parse(buf.slice(0, nl));
        return finish(j?.ok === true ? { on: true, bound: j.bound === true } : off);
      } catch {
        return finish(off);
      }
    });
    sock.on('error', () => finish(off));
    sock.on('close', () => finish(off));
  });
}

// ---------- the hub (runs inside its Orca tab) ----------

// True when something accepts a connection on the socket file (a live hub, whatever its key).
function socketAlive(path) {
  return new Promise((done) => {
    const sock = net.connect(path);
    const finish = (v) => {
      sock.destroy();
      done(v);
    };
    sock.setTimeout(1000, () => finish(true)); // slow, not dead: leave it alone
    sock.on('connect', () => finish(true));
    sock.on('error', () => finish(false));
  });
}

// Starts the hub: refuses when one already answers, listens, then binds (bind() -> { ok, why }; pings answer bound:false meanwhile). isBound() is asked on
// every ping (the Run in inbox.json still names this tab). -> { ok: true, bound, why, stop } | { ok: false, why }.
// stop() closes the socket and removes the socket and key files, only while they are still this hub's own.
export async function startHub(home, { bind, isBound }) {
  const path = sockOf(home);
  if (Buffer.byteLength(path) > SOCK_PATH_MAX) return { ok: false, why: HUB_ERR.path };
  ensureHome(home);
  if ((await hubStatus(home)).on) return { ok: false, why: HUB_ERR.running };
  try {
    if (!lstatSync(path).isSocket()) return { ok: false, why: HUB_ERR.sock };
  } catch {
    // no socket file: fine
  }
  const key = randomBytes(32).toString('hex');
  let busy = false;
  const open = new Set();
  const server = net.createServer((sock) => {
    open.add(sock);
    sock.on('close', () => open.delete(sock));
    if (busy) {
      sock.end('{"ok":false,"why":"busy"}\n');
      return;
    }
    busy = true;
    let answered = false;
    const release = () => {
      if (answered) return;
      answered = true;
      busy = false; // the next caller may come as soon as this one has its answer
    };
    let size = 0;
    const parts = [];
    sock.on('close', release);
    sock.on('error', () => {});
    sock.setTimeout(IDLE_MS, () => {
      release();
      sock.destroy();
    });
    sock.on('data', (chunk) => {
      if (answered) return;
      size += chunk.length;
      if (size > REQ_MAX) {
        parts.length = 0;
        sock.end('{"ok":false,"why":"too large"}\n');
        release();
        return;
      }
      parts.push(chunk);
      const all = Buffer.concat(parts);
      const nl = all.indexOf(10);
      if (nl < 0) return;
      parts.length = 0;
      sock.end(`${JSON.stringify(answer(all.subarray(0, nl).toString('utf8')))}\n`);
      release();
    });
  });
  // The request lives only in this function's memory: parsed, compared, dropped.
  const answer = (line) => {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      return { ok: false, why: 'refused' };
    }
    const fine = j && typeof j === 'object' && !Array.isArray(j) && Object.keys(j).length === 2 && j.op === 'ping'
      && typeof j.key === 'string' && KEY_RE.test(j.key) && timingSafeEqual(Buffer.from(j.key), Buffer.from(key));
    if (!fine) return { ok: false, why: 'refused' };
    let bound = false;
    try {
      bound = Boolean(isBound());
    } catch {
      bound = false;
    }
    return { ok: true, bound };
  };
  server.maxConnections = 4;
  // rev-2 L2: listen first (the key and the bind come after, so a second hub started at the same time loses here and
  // touches neither the key file nor the Run). A leftover socket is removed only when nothing answers on it.
  const listen = () => new Promise((ok, no) => {
    server.once('error', no);
    const old = process.umask(0o077); // bind() happens inside listen(): restore at once (other hubs may run in this process)
    try {
      server.listen(path, () => {
        server.removeListener('error', no);
        ok();
      });
    } finally {
      process.umask(old);
    }
  });
  try {
    try {
      await listen();
    } catch (e) {
      if (e?.code !== 'EADDRINUSE') throw e;
      if (await socketAlive(path)) return { ok: false, why: HUB_ERR.running };
      rmSync(path, { force: true }); // a dead hub's leftover (nothing answered it)
      await listen();
    }
  } catch {
    return { ok: false, why: HUB_ERR.sock };
  }
  const fail = (why) => {
    server.close();
    if (readKey(home) === key) rmSync(keyOf(home), { force: true }); // only while the key is still this hub's
    return { ok: false, why };
  };
  let ino = null;
  try {
    chmodSync(path, 0o600); // the umask made it owner-only already; 0600 exactly (no x bit) on top
    const st = statSync(path);
    ino = st.ino;
    if (!ownerOnly(st)) throw new Error('mode');
    writeAtomic(keyOf(home), key);
  } catch {
    return fail(HUB_ERR.sock);
  }
  const b = await bind();
  let stopped = false;
  const stop = () => new Promise((done) => {
    if (stopped) return done();
    stopped = true;
    try {
      if (lstatSync(path).ino === ino) rmSync(path, { force: true });
    } catch {
      // already gone
    }
    if (readKey(home) === key) rmSync(keyOf(home), { force: true });
    for (const s of open) s.destroy();
    server.close(() => done());
    setTimeout(done, 500);
  });
  return { ok: true, bound: Boolean(b?.ok) && Boolean(isBound()), why: b?.ok ? '' : b?.why ?? HUB_ERR.unbound, stop };
}

// ---------- setup: open the hub's tab (the "Set up" tap) ----------

const BAD_PATH_RE = /['‘-‛\u0000-\u001f\u007f]/;

// The tab's command: exec (the hub replaces the shell), the Kadans folder pinned (the tab's login shell may not have the
// app's KADANS_HOME: then setup would wait on one socket and the hub listen on another), node and the Kadans CLI by
// absolute path, single-quoted. Only Kadans' own paths go in; a quote or a control character (a newline would run half a
// command) is refused.
export function hubCommand(nodePath, bin, home) {
  for (const p of [nodePath, bin, home]) {
    if (typeof p !== 'string' || !p.startsWith('/') || BAD_PATH_RE.test(p)) throw new Error(HUB_ERR.quote);
  }
  return `exec /usr/bin/env KADANS_HOME='${home}' '${nodePath}' '${bin}' inbox hub`;
}

// Where the tab opens (pure; exported for tests). From `orca worktree list --json`: a local, not archived MAIN worktree
// (a project's own folder: it exists as long as the project is in Orca; linked worktrees come and go), absolute path,
// not production-looking. The project holding the Kadans checkout wins; else a pinned project; else the project the owner
// used last (lastActivityAt), so the tab shows up where the owner is looking; ties: lowest sortOrder, then id. -> path | null.
export function hubWorktree(worktrees, kadansRoot) {
  const list = (Array.isArray(worktrees) ? worktrees : []).filter((w) => w && w.isMainWorktree === true && w.isArchived !== true
    && (w.hostId == null || w.hostId === 'local') && typeof w.path === 'string' && w.path.startsWith('/') && w.path.length < 1024
    && !BAD_PATH_RE.test(w.path) && !PROD_RE.test(String(w.displayName ?? '')) && !PROD_RE.test(basename(w.path)));
  const root = typeof kadansRoot === 'string' ? kadansRoot : '';
  const holding = list.filter((w) => root === w.path || root.startsWith(`${w.path.replace(/\/+$/, '')}/`))
    .sort((a, b) => b.path.length - a.path.length);
  if (holding.length) return holding[0].path;
  const num = (v, none) => (Number.isFinite(v) ? v : none);
  list.sort((a, b) => Number(b.isPinned === true) - Number(a.isPinned === true)
    || num(b.lastActivityAt, -1) - num(a.lastActivityAt, -1)
    || num(a.sortOrder, Number.MAX_VALUE) - num(b.sortOrder, Number.MAX_VALUE)
    || String(a.id ?? a.path).localeCompare(String(b.id ?? b.path)));
  return list[0]?.path ?? null;
}

// The exact `orca terminal create` argv (pure; exported for tests).
export function hubCreateArgs(worktreePath, command) {
  return ['terminal', 'create', '--worktree', `path:${worktreePath}`, '--title', HUB_TITLE, '--command', command, '--json'];
}

const parseResult = (r) => {
  if (!r?.ok) return null;
  try {
    const j = JSON.parse(r.text);
    return j && j.ok !== false ? j.result ?? null : null;
  } catch {
    return null;
  }
};

function takeLock(home, now) {
  const p = join(home, HUB_LOCK);
  for (let i = 0; i < 2; i++) {
    try {
      closeSync(openSync(p, 'wx', 0o600));
      return () => rmSync(p, { force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      try {
        if (now() - statSync(p).mtimeMs < LOCK_STALE_MS) return null;
        rmSync(p, { force: true });
      } catch {
        // gone meanwhile: try again
      }
    }
  }
  return null;
}

// The "Set up" tap. A hub that answers: ready (or the unbound sentence), nothing created. Else, under the lock: one
// `orca terminal create` for the hub's tab, then wait up to wait ms for the hub to answer. Never creates twice and never
// retries a create. -> { ok: true, created } | { ok: false, why }.
export async function openHub(home, { call, nodePath = process.execPath, bin, probe = hubStatus, wait = SETUP_WAIT_MS,
  poll = POLL_MS, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (Buffer.byteLength(sockOf(home)) > SOCK_PATH_MAX) return { ok: false, why: HUB_ERR.path };
  const first = await probe(home);
  if (first.on) return first.bound ? { ok: true, created: false } : { ok: false, why: HUB_ERR.unbound };
  if (!call) return { ok: false, why: HUB_ERR.noOrca };
  let command;
  try {
    command = hubCommand(nodePath, bin, resolve(home));
  } catch {
    return { ok: false, why: HUB_ERR.quote };
  }
  ensureHome(home);
  const release = takeLock(home, now);
  if (!release) return { ok: false, why: HUB_ERR.busy };
  try {
    const again = await probe(home); // another tap may have finished while this one waited for the lock
    if (again.on) return again.bound ? { ok: true, created: false } : { ok: false, why: HUB_ERR.unbound };
    const wt = parseResult(await call(['worktree', 'list', '--json'], LIST_TIMEOUT_MS))?.worktrees;
    const where = hubWorktree(wt, resolve(dirname(bin), '..'));
    if (!where) return { ok: false, why: HUB_ERR.worktree };
    const made = parseResult(await call(hubCreateArgs(where, command), CREATE_TIMEOUT_MS));
    if (!made) return { ok: false, why: HUB_ERR.create };
    const end = now() + wait;
    for (;;) {
      const s = await probe(home);
      if (s.on) return s.bound ? { ok: true, created: true } : { ok: false, why: HUB_ERR.unbound };
      if (now() >= end) return { ok: false, why: HUB_ERR.slow };
      await sleep(poll);
    }
  } finally {
    release();
  }
}
