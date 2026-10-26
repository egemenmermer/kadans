// Project and task store under $KADANS_HOME, plus the one lock every writer uses (samples too).
// Writes: take the lock (mkdir-based, stale after 30 s), write a temp file, rename it over the real file.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute, resolve } from 'node:path';

export const LOCK_STALE_MS = 30_000;
export const LOCK_WAIT_MS = 10_000;
export const HOOK_LOCK_WAIT_MS = 2000; // a hook process never holds up the session long for the lock

let lockWaitMs = LOCK_WAIT_MS;
// Default wait for every withLock in this process. `kadans hook ...` lowers it to HOOK_LOCK_WAIT_MS.
export function setLockWait(ms) {
  lockWaitMs = ms;
}
export const IMPORTANCE = ['high', 'normal', 'low'];
export const URGENCY = ['urgent', 'week', 'idle'];
export const STATUS = ['queued', 'proposed', 'running', 'done', 'skipped'];

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Runs fn while holding $home/.lock. A lock older than LOCK_STALE_MS is taken over. Throws after waitMs.
export function withLock(home, fn, { waitMs = lockWaitMs, staleMs = LOCK_STALE_MS } = {}) {
  mkdirSync(home, { recursive: true });
  const lock = join(home, '.lock');
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > staleMs) {
        // Rename first: only one contender wins the rename, the others see ENOENT and retry mkdir.
        const aside = `${lock}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
        renameSync(lock, aside);
        rmSync(aside, { recursive: true, force: true });
        continue;
      }
    } catch {
      continue; // lock vanished or was taken over meanwhile
    }
    if (Date.now() >= deadline) throw new Error('kadans: lock timeout');
    sleep(5 + Math.floor(Math.random() * 15));
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function readList(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeList(file, list) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`);
  renameSync(tmp, file);
}

const projectsFile = (home) => join(home, 'projects.json');
const tasksFile = (home) => join(home, 'tasks.json');
const nextId = (list) => list.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1;

export function readProjects(home) {
  return readList(projectsFile(home));
}

export function readTasks(home) {
  return readList(tasksFile(home));
}

// Finds a project by numeric id or case-insensitive name.
export function findProject(projects, ref) {
  const s = String(ref).trim();
  return projects.find((p) => String(p.id) === s) ?? projects.find((p) => p.name.toLowerCase() === s.toLowerCase()) ?? null;
}

export function addProject(home, { name, path, importance = 'normal' }) {
  if (!name || !String(name).trim()) throw new Error('empty name');
  if (!IMPORTANCE.includes(importance)) throw new Error(`bad importance: ${importance}`);
  return withLock(home, () => {
    const list = readProjects(home);
    if (list.some((p) => p.name.toLowerCase() === String(name).trim().toLowerCase())) throw new Error(`duplicate project: ${name}`);
    const p = { id: nextId(list), name: String(name).trim(), path, importance };
    list.push(p);
    writeList(projectsFile(home), list);
    return p;
  });
}

export function addTask(home, { project, text, urgency = 'week', approved = false }, now = Date.now()) {
  if (!text || !String(text).trim()) throw new Error('empty text');
  if (!URGENCY.includes(urgency)) throw new Error(`bad urgency: ${urgency}`);
  return withLock(home, () => {
    const proj = findProject(readProjects(home), project);
    if (!proj) throw new Error(`unknown project: ${project}`);
    const list = readTasks(home);
    const t = {
      id: nextId(list),
      projectId: proj.id,
      text: String(text).trim(),
      urgency,
      status: 'queued',
      approved: approved === true,
      createdAt: now,
      claimedBy: null,
      startedAt: null,
      doneAt: null,
    };
    list.push(t);
    writeList(tasksFile(home), list);
    return t;
  });
}

// Applies a patch to one task under the lock; `check` may throw to refuse the change.
export function updateTask(home, id, patch, check) {
  return withLock(home, () => {
    const list = readTasks(home);
    const t = list.find((x) => String(x.id) === String(id));
    if (!t) throw new Error(`unknown task: ${id}`);
    if (check) check(t);
    Object.assign(t, typeof patch === 'function' ? patch(t) : patch);
    writeList(tasksFile(home), list);
    return t;
  });
}

// Hook bookkeeping ($KADANS_HOME/hooks.json): feeds per session and window, brake notifications per window.
const hooksFile = (home) => join(home, 'hooks.json');

export function readHookState(home) {
  try {
    const v = JSON.parse(readFileSync(hooksFile(home), 'utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return { feeds: {}, brakeNotified: {}, ...v };
  } catch {
    // missing or broken: start empty
  }
  return { feeds: {}, brakeNotified: {} };
}

function writeHookState(home, state) {
  const tmp = `${hooksFile(home)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, hooksFile(home));
}

export const feedKey = (sessionId, windowId) => `${sessionId}@${windowId}`;
// resets_at may drift by seconds between payloads (pace.mjs RESET_TOLERANCE): ids within a minute are the same window.
export const WINDOW_TOLERANCE = 60_000;
export const sameWindow = (a, b) => Number.isFinite(Number(a)) && Math.abs(Number(a) - Number(b)) <= WINDOW_TOLERANCE;

// The stored key of this session's window (an earlier, slightly different resets_at), or a new key.
function windowKey(state, sessionId, windowId) {
  const prefix = `${sessionId}@`;
  const hit = Object.keys(state.feeds ?? {}).find((k) => k.startsWith(prefix) && sameWindow(k.slice(prefix.length), windowId));
  return hit ?? feedKey(sessionId, windowId);
}

// Feeds already given to this session in this window.
export function feedCount(state, sessionId, windowId) {
  return Number(state.feeds?.[windowKey(state, sessionId, windowId)]) || 0;
}

// Runs fn(state) under the lock and saves what it returns (or the mutated state).
export function updateHookState(home, fn) {
  return withLock(home, () => {
    const state = readHookState(home);
    const out = fn(state);
    writeHookState(home, state);
    return out;
  });
}

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

// True when dir is the project folder or inside it (symlinks resolved; /x/proj does not match /x/proj2).
export function insideProject(projectPath, dir) {
  if (!projectPath || !dir) return false;
  const rel = relative(real(projectPath), real(dir));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// Picks with pickFn under the lock, re-checks the cap, claims the task for the session and counts the feed.
// Returns the claimed task or null. Two sessions stopping together cannot get the same task.
export function claimForFeed(home, { sessionId, windowId, cap, pickFn, now = Date.now() }) {
  return withLock(home, () => {
    const state = readHookState(home);
    for (const k of Object.keys(state.feeds)) if (Number(k.split('@').pop()) < now) delete state.feeds[k]; // old windows
    const key = windowKey(state, sessionId, windowId);
    if ((Number(state.feeds[key]) || 0) >= cap) return null;
    const list = readTasks(home);
    const picked = pickFn(list, readProjects(home));
    if (!picked) return null;
    const t = list.find((x) => String(x.id) === String(picked.id));
    if (!t || t.status !== 'queued' || t.approved !== true) return null;
    Object.assign(t, { status: 'running', claimedBy: sessionId, startedAt: now });
    state.feeds[key] = (Number(state.feeds[key]) || 0) + 1;
    writeList(tasksFile(home), list);
    writeHookState(home, state);
    return t;
  });
}
