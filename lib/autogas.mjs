// `kadans gas tick`: use spare quota on its own. When the owner's own 5-hour window would end with quota unused, start the
// next approved task in a new Claude Code session, through the same path as `kadans task start <id>` (lib/launch.mjs).
// Also when no 5-hour window is running (the night case): the start then opens the window. Off by default: needs
// accounts.<own key>.gas AND autoGas. Own account only: the samples and the gas switch come from ~/.claude (ownKey),
// whatever CLAUDE_CONFIG_DIR says, and the session script unsets CLAUDE_CONFIG_DIR. At most one start per call; every start is recorded in $KADANS_HOME/autogas.json (window id, task id,
// session id, time) so the caps hold across calls. Decisions are pure; runTick does the IO with injected parts.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIN, WINDOW_MS, limitState, overall } from './pace.mjs';
import { rankTasks } from './pick.mjs';
import { readProjects, readTasks, withLock, writeAtomic } from './store.mjs';
import { appendEvent } from './agents.mjs';

export const MIN_SPARE_PCT = 15; // projected unused share of the tightest limit
export const MIN_LEFT_MS = 45 * MIN; // time left in the window
export const GAP_MS = 10 * MIN; // no two starts (or tries) closer than this
export const GRACE_MS = 10 * MIN; // a start still being opened (pending record) counts as running this long
export const KEEP_MS = 2 * 24 * 60 * MIN;
// Every `why` code `gas tick` can return. 'started' and 'would-start' (dry run) are the go answers.
export const WHY = ['started', 'would-start', 'off', 'not-gas', 'near-reset', 'too-little-spare', 'no-task', 'cap', 'too-soon', 'not-macos', 'low-ram', 'start-failed'];

const stateFile = (home) => join(home, 'autogas.json');

export function readAutoGasState(home) {
  try {
    const v = JSON.parse(readFileSync(stateFile(home), 'utf8'));
    if (v && typeof v === 'object' && Array.isArray(v.starts)) return { starts: v.starts.filter((s) => s && typeof s === 'object') };
  } catch {
    // missing or broken: no starts on record
  }
  return { starts: [] };
}

function writeAutoGasState(home, state, now) {
  const starts = state.starts.filter((s) => Number(s.t) > now - KEEP_MS);
  writeAtomic(stateFile(home), `${JSON.stringify({ starts }, null, 2)}\n`);
}

// Free memory in GB from `vm_stat` output: (free + inactive + speculative + purgeable pages) x page size. null if unreadable.
export function freeGBFromVmStat(text) {
  const page = Number(String(text).match(/page size of (\d+) bytes/)?.[1]);
  if (!page) return null;
  let pages = 0;
  let seen = 0;
  for (const name of ['free', 'inactive', 'speculative', 'purgeable']) {
    const m = String(text).match(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.?$`, 'm'));
    if (m) {
      pages += Number(m[1]);
      seen++;
    }
  }
  return seen ? (pages * page) / 1024 ** 3 : null;
}

export function readFreeGB() {
  const r = spawnSync('/usr/bin/vm_stat', [], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? freeGBFromVmStat(r.stdout) : null;
}

export const IDLE_MAX_USED = 10; // LOW DATA counts as spare only while this little (%) is used

// Spare quota of the own account: { why } when there is none to use, else { spare, windowId }. Three cases:
// - gas: the tightest applicable limit's projected unused share (100 - projection), window id = the earliest reset;
// - no live 5-hour window (no sample in one, or its reset has passed, e.g. at night): spare = 100; a start opens the window,
//   whose id is taken as now + 5 h;
// - LOW DATA (too few samples to project) with at most IDLE_MAX_USED % used: spare = 100 - used.
// A seven-day limit with a projection still caps the spare, and one that brakes (or will) blocks it.
export function spareOf(samples, now, cfg) {
  const ov = overall(samples, now, cfg);
  const five = limitState(samples, 'five_hour', now, cfg);
  const others = ov.limits.filter((v) => v.name !== 'five_hour');
  if (others.some((v) => v.state === 'brake' || v.state === 'early')) return { why: 'not-gas' };
  const capOthers = (spare) => Math.min(spare, ...others.filter((v) => Number.isFinite(v.projection)).map((v) => 100 - v.projection));
  let spare;
  let windowId;
  if (five.state === 'nodata' || five.ended) {
    if (others.some((v) => v.state === 'cruise')) return { why: 'not-gas' };
    spare = 100;
    windowId = now + WINDOW_MS.five_hour;
  } else if (ov.state === 'gas') {
    spare = Math.min(...ov.limits.filter((v) => Number.isFinite(v.projection)).map((v) => 100 - v.projection));
    windowId = Math.min(...ov.limits.map((v) => v.resetsAt).filter(Number.isFinite));
  } else if (five.state === 'unknown' && five.pct <= IDLE_MAX_USED && !others.some((v) => v.state === 'cruise')) {
    spare = 100 - five.pct;
    windowId = five.resetsAt;
  } else return { why: 'not-gas' };
  if (!Number.isFinite(windowId) || windowId - now < MIN_LEFT_MS) return { why: 'near-reset' };
  return { spare: capOthers(spare), windowId };
}

// Auto-started tasks still running (task status running), plus a start still being opened (pending, under GRACE_MS).
// An idle session whose task is done no longer counts; a failed try never does.
export function runningStarts(state, tasks, now) {
  const status = new Map(tasks.map((t) => [String(t.id), t.status]));
  return state.starts.filter((s) => (s.ok === null && now - Number(s.t) < GRACE_MS) || (s.ok === true && status.get(String(s.taskId)) === 'running')).length;
}

// Task ids whose start failed in a window that has not reset yet: the picker skips them for the rest of that window.
export function failedIds(state, now) {
  return new Set(state.starts.filter((s) => s.ok === false && Number(s.windowId) > now).map((s) => String(s.taskId)));
}

// Gates, cheap ones first. deps (lazy, so a gate that fails early costs nothing): platform, ram() -> free GB or null.
// Returns { go: false, why } or { go: true, task, windowId, spare }.
export function decideTick({ cfg, own, samples, tasks, projects, state, now, platform = process.platform, ram = readFreeGB }) {
  if (cfg.autoGas !== true || cfg.accounts?.[own]?.gas !== true) return { go: false, why: 'off' };
  const sp = spareOf(samples, now, cfg);
  if (sp.why) return { go: false, why: sp.why };
  const { spare, windowId } = sp;
  if (!(spare >= MIN_SPARE_PCT)) return { go: false, why: 'too-little-spare' };
  const skip = failedIds(state, now);
  const task = rankTasks(tasks.filter((t) => t.approved === true && t.status === 'queued' && !skip.has(String(t.id))), projects, now)[0]?.task ?? null;
  if (!task) return { go: false, why: 'no-task' };
  if (runningStarts(state, tasks, now) >= cfg.autoGasMax) return { go: false, why: 'cap' };
  if (state.starts.some((s) => now - Number(s.t) < GAP_MS)) return { go: false, why: 'too-soon' };
  if (platform !== 'darwin') return { go: false, why: 'not-macos' };
  const gb = ram();
  if (!(Number.isFinite(gb) && gb >= cfg.autoGasMinRamGB)) return { go: false, why: 'low-ram', freeGB: gb };
  return { go: true, task, windowId, spare };
}

// One tick. deps: samples() (own account), now, dryRun, platform, ram, start(taskId) -> { sessionId, how } (throws when
// the session could not open; the default in bin/kadans.mjs is the `task start <id>` path). The decision and a pending
// record are made under the store lock, so two ticks never both start; the start itself runs outside it (startTask takes
// the lock). Returns { started: <task id as stored, a number> | null, why, task?, error?, how? }; only started and why are the JSON contract.
export function runTick(home, cfg, { own, samples = () => [], now = Date.now(), dryRun = false, platform, ram, start } = {}) {
  const d = withLock(home, () => {
    const state = readAutoGasState(home);
    const dec = decideTick({ cfg, own, samples: samples(), tasks: readTasks(home), projects: readProjects(home), state, now, platform, ram });
    if (dec.go && !dryRun) {
      state.starts.push({ t: now, windowId: dec.windowId, taskId: String(dec.task.id), sessionId: null, ok: null });
      writeAutoGasState(home, state, now);
    }
    return dec;
  });
  if (!d.go) return { started: null, why: d.why, ...(d.freeGB !== undefined ? { freeGB: d.freeGB } : {}) };
  if (dryRun) return { started: null, why: 'would-start', task: d.task, spare: d.spare };
  const id = String(d.task.id);
  let r = null;
  let error = null;
  try {
    if (typeof start !== 'function') throw new Error('no starter');
    r = start(id);
  } catch (e) {
    error = String(e?.message ?? e).slice(0, 200);
  }
  const ok = error === null;
  withLock(home, () => {
    const state = readAutoGasState(home);
    const mine = state.starts.find((s) => s.ok === null && Number(s.t) === now && s.taskId === id);
    if (mine) Object.assign(mine, { ok, sessionId: ok ? r?.sessionId ?? null : null });
    writeAutoGasState(home, state, now);
  });
  try {
    appendEvent(home, { t: now, ev: 'AutoGas', task: id, ok }, now); // no sid: never a row in the agent list
  } catch {
    // the log is best effort
  }
  return ok ? { started: d.task.id, why: 'started', task: d.task, how: r?.how ?? null } : { started: null, why: 'start-failed', task: d.task, error };
}

// The JSON contract with the app: exactly { started, why }.
export const tickJson = (r) => ({ started: r.started, why: r.why });

const TEXT = {
  off: 'off (needs accounts.<own key>.gas and autoGas true)',
  'not-gas': 'the gauge is not on gas, and no idle window with room',
  'near-reset': 'less than 45 min left in the window',
  'too-little-spare': `less than ${MIN_SPARE_PCT}% would go unused`,
  'no-task': 'no approved task in the queue (a task that failed to start waits for the next window)',
  cap: 'enough auto-started tasks are running (autoGasMax)',
  'too-soon': 'the last auto start was less than 10 min ago',
  'not-macos': 'free memory is only read on macOS',
  'low-ram': 'not enough free memory (autoGasMinRamGB)',
};

export function renderTick(r) {
  if (r.why === 'started') return `started task #${r.started} on spare quota: ${r.how ?? ''}`.trim();
  if (r.why === 'would-start') return `dry run: would start task #${r.task.id} (~${Math.round(r.spare)}% would go unused); nothing started, nothing written`;
  if (r.why === 'start-failed') return `not started: task #${r.task.id} could not start: ${r.error} (skipped until the window resets)`;
  const gb = Number.isFinite(r.freeGB) ? ` (${r.freeGB.toFixed(1)} GB free)` : '';
  return `not started: ${TEXT[r.why] ?? r.why}${gb}`;
}
