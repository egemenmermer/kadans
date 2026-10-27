// Claude Code hooks: Stop = throttle (feeds one owner-approved task when quota would go to waste),
// PreToolUse = brake (denies spawning tools while the brake is on). Decisions are pure; runners do the IO.
// Runners never throw to the caller's benefit: bin/kadans.mjs wraps them and exits 0 with no output on any error.
import { allowedWhileBraking, rankTasks } from './pick.mjs';
import { overall, loadConfig } from './pace.mjs';
import { hhmm } from './render.mjs';
import { accountKey, actionable, configDir, kadansHome, readSamples } from './samples.mjs';
import { claimForFeed, feedCount, insideProject, readHookState, readProjects, readTasks, sameWindow, updateHookState } from './store.mjs';
import { notify } from './notify.mjs';

// Tools that start more work (hooks docs: PreToolUse matches `Agent`, `Workflow`; tools-reference: Agent spawns a
// subagent, Workflow orchestrates many subagents). The install matcher is built from this list.
export const SPAWN_TOOLS = ['Agent', 'Workflow'];
export const SPAWN_MATCHER = SPAWN_TOOLS.join('|');
export const FEED_CAP = 3; // feeds per session per window
export const MIN_LEFT_MS = 15 * 60_000; // no feed in the last 15 minutes before a reset
const LIMIT_NAME = { five_hour: '5-hour', seven_day: '7-day' };

// Window id = the earliest reset among the applicable limits.
function nextReset(ov) {
  const r = ov.limits.map((v) => v.resetsAt).filter(Number.isFinite);
  return r.length ? Math.min(...r) : null;
}

// Approved, queued tasks of a project that contains cwd, best first.
export function feedable(tasks, projects, cwd, now) {
  const ok = new Set(projects.filter((p) => insideProject(p.path, cwd)).map((p) => String(p.id)));
  return rankTasks(
    tasks.filter((t) => t.approved === true && t.status === 'queued' && ok.has(String(t.projectId))),
    projects,
    now,
  );
}

// Gates of the throttle, in order. Returns { feed: false, why } or { feed: true, windowId, waste }.
export function decideStop({ input, env, cfg, key, ov, tasks, projects, state, now }) {
  const sid = input?.session_id;
  if (!sid) return { feed: false, why: 'no-session' };
  if (cfg.accounts?.[key]?.gas !== true) return { feed: false, why: 'account-off' };
  if (env.KADANS_THROTTLE !== '1') return { feed: false, why: 'session-off' };
  if (ov.state !== 'gas') return { feed: false, why: 'not-gas' };
  const windowId = nextReset(ov);
  if (windowId === null || windowId - now < MIN_LEFT_MS) return { feed: false, why: 'near-reset' };
  if (feedCount(state, sid, windowId) >= FEED_CAP) return { feed: false, why: 'cap' };
  // A task this session claimed and did not finish: do not pile on (also stops loops when stop_hook_active is true).
  if (tasks.some((t) => t.status === 'running' && t.claimedBy === sid)) return { feed: false, why: 'unfinished' };
  if (feedable(tasks, projects, input.cwd, now).length === 0) return { feed: false, why: 'no-task' };
  const worst = ov.limits.find((v) => v.name === ov.limit) ?? ov.limits[0];
  return { feed: true, windowId, waste: Math.max(0, Math.round(100 - worst.projection)) };
}

export function feedReason(task, project, waste, windowId) {
  return (
    `Kadans gas: ~${waste}% of this window's quota would go to waste (resets ${hhmm(windowId)}). ` +
    `Next task approved by the owner: #${task.id} (${project?.name ?? '?'}): ${task.text} ` +
    `When it is done, run \`kadans task done ${task.id}\`, then stop.`
  );
}

// Brake: deny spawning tools unless the session's claimed task is urgent or KADANS_ALLOW=1.
export function decidePretool({ input, env, ov, tasks }) {
  if (!SPAWN_TOOLS.includes(input?.tool_name)) return { deny: false, why: 'other-tool' };
  if (ov.state !== 'brake') return { deny: false, why: 'no-brake' };
  if (env.KADANS_ALLOW === '1') return { deny: false, why: 'env-allow' };
  const sid = input.session_id;
  const mine = sid ? tasks.filter((t) => t.claimedBy === sid && t.status === 'running') : [];
  if (mine.some(allowedWhileBraking)) return { deny: false, why: 'urgent' };
  const v = ov.limits.find((x) => x.name === ov.limit) ?? ov.limits[0];
  const ends = Number.isFinite(v.brakeAt) ? hhmm(v.brakeAt) : '-';
  const reason =
    `Kadans brake: the ${LIMIT_NAME[v.name] ?? v.name} limit runs out ~${ends} (resets ${hhmm(v.resetsAt)}). ` +
    `Do not start new agents or workflows: start the work after the reset, or mark the task urgent ` +
    `(\`kadans task urgent <id>\`).`;
  return { deny: true, why: 'brake', reason };
}

function context(env, now) {
  const home = kadansHome(env);
  const cfg = loadConfig(home);
  const key = accountKey(configDir(env));
  const ov = overall(actionable(readSamples(home, key)), now, cfg); // Codex readings never brake or feed
  return { home, cfg, key, ov };
}

// First brake of a window: one notification (needs cfg.notify). Safe to call often.
export function notifyBrakeOnce(home, cfg, key, ov, deps = {}) {
  if (ov.state !== 'brake' || cfg.notify !== true) return false;
  const v = ov.limits.find((x) => x.name === ov.limit) ?? ov.limits[0];
  const fresh = updateHookState(home, (s) => {
    s.brakeNotified ??= {};
    if (sameWindow(s.brakeNotified[key], v.resetsAt)) return false;
    s.brakeNotified[key] = v.resetsAt;
    return true;
  });
  if (fresh) notify(cfg, 'Kadans: brake', `${LIMIT_NAME[v.name] ?? v.name} limit will run out early, resets ${hhmm(v.resetsAt)}`, deps);
  return fresh;
}

// Returns the stdout text for the Stop hook ('' = allow the stop).
export function runStop(raw, env, { now = Date.now(), notifyDeps } = {}) {
  const input = JSON.parse(raw);
  const { home, cfg, key, ov } = context(env, now);
  const tasks = readTasks(home);
  const projects = readProjects(home);
  const d = decideStop({ input, env, cfg, key, ov, tasks, projects, state: readHookState(home), now });
  if (!d.feed) return '';
  const task = claimForFeed(home, {
    sessionId: input.session_id,
    windowId: d.windowId,
    cap: FEED_CAP,
    now,
    pickFn: (ts, ps) => feedable(ts, ps, input.cwd, now)[0]?.task ?? null,
  });
  if (!task) return '';
  const project = projects.find((p) => String(p.id) === String(task.projectId));
  const reason = feedReason(task, project, d.waste, d.windowId);
  notify(cfg, 'Kadans: task started', `#${task.id} ${task.text}`, notifyDeps);
  return JSON.stringify({ decision: 'block', reason });
}

// Returns the stdout text for the PreToolUse hook ('' = no opinion, normal permission flow).
export function runPretool(raw, env, { now = Date.now(), notifyDeps } = {}) {
  const input = JSON.parse(raw);
  if (!SPAWN_TOOLS.includes(input?.tool_name)) return '';
  const { home, cfg, key, ov } = context(env, now);
  try {
    notifyBrakeOnce(home, cfg, key, ov, notifyDeps);
  } catch {
    // a notification must never change the decision
  }
  const d = decidePretool({ input, env, ov, tasks: readTasks(home) });
  if (!d.deny) return '';
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason },
  });
}
