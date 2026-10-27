import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountKey } from '../lib/samples.mjs';
import { FEED_CAP, decidePretool, decideStop, runPretool, runStop } from '../lib/hooks.mjs';
import { notify, notifyArgs } from '../lib/notify.mjs';
import { insideProject } from '../lib/store.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 25, 12, 0);

// ---- pure stop gates ----
function base(over = {}) {
  const proj = mkdtempSync(join(tmpdir(), 'kadans-proj-'));
  const args = {
    input: { session_id: 's1', cwd: join(proj, 'sub'), stop_hook_active: false },
    env: { KADANS_THROTTLE: '1' },
    cfg: { accounts: { K: { gas: true } } },
    key: 'K',
    ov: { state: 'gas', limit: 'five_hour', limits: [{ name: 'five_hour', state: 'gas', projection: 60, resetsAt: NOW + 120 * MIN }] },
    tasks: [{ id: 1, projectId: 1, text: 'x', urgency: 'week', status: 'queued', approved: true, createdAt: NOW, claimedBy: null }],
    projects: [{ id: 1, name: 'P', path: proj, importance: 'normal' }],
    state: { feeds: {} },
    now: NOW,
  };
  mkdirSync(join(proj, 'sub'));
  return { ...args, ...over(args) };
}
const o = (f) => base(typeof f === 'function' ? f : () => f);

test('stop: all gates open feeds, with the waste estimate', () => {
  const d = decideStop(o({}));
  assert.equal(d.feed, true);
  assert.equal(d.waste, 40);
  assert.equal(d.windowId, NOW + 120 * MIN);
});

test('stop: each false gate blocks the feed', () => {
  const cases = {
    'no-session': (a) => ({ input: { ...a.input, session_id: undefined } }),
    'account-off': () => ({ cfg: { accounts: {} } }),
    'account-off ': () => ({ cfg: { accounts: { K: { gas: 'true' } } } }),
    'account-off  ': () => ({ cfg: { accounts: { OTHER: { gas: true } } } }),
    'session-off': () => ({ env: {} }),
    'session-off ': () => ({ env: { KADANS_THROTTLE: 'yes' } }),
    'not-gas': (a) => ({ ov: { ...a.ov, state: 'cruise' } }),
    'not-gas ': (a) => ({ ov: { ...a.ov, state: 'brake' } }),
    'near-reset': (a) => ({ ov: { ...a.ov, limits: [{ ...a.ov.limits[0], resetsAt: NOW + 14 * MIN }] } }),
    cap: () => ({ state: { feeds: { [`s1@${NOW + 120 * MIN}`]: FEED_CAP } } }),
    unfinished: (a) => ({ tasks: [...a.tasks, { id: 2, projectId: 1, status: 'running', claimedBy: 's1', approved: true }] }),
    'no-task': (a) => ({ tasks: [{ ...a.tasks[0], approved: false }] }),
    'no-task ': (a) => ({ tasks: [{ ...a.tasks[0], approved: undefined }] }),
    'no-task  ': (a) => ({ tasks: [{ ...a.tasks[0], status: 'done' }] }),
    'no-task   ': (a) => ({ input: { ...a.input, cwd: `${a.projects[0].path}2` } }),
    'no-task    ': (a) => ({ input: { ...a.input, cwd: tmpdir() } }),
  };
  for (const [why, f] of Object.entries(cases)) {
    const d = decideStop(o(f));
    assert.equal(d.feed, false, why);
    assert.equal(d.why, why.trim(), why);
  }
  // resets_at drifting by seconds is still the same window for the cap
  assert.equal(decideStop(o(() => ({ state: { feeds: { [`s1@${NOW + 120 * MIN - 30_000}`]: FEED_CAP } } }))).why, 'cap');
  assert.equal(decideStop(o(() => ({ state: { feeds: { [`s1@${NOW + 120 * MIN - 120_000}`]: FEED_CAP } } }))).feed, true);
  // 2 feeds so far is still under the cap; another session's running task does not count.
  assert.equal(decideStop(o(() => ({ state: { feeds: { [`s1@${NOW + 120 * MIN}`]: FEED_CAP - 1 } } }))).feed, true);
  assert.equal(decideStop(o((a) => ({ tasks: [...a.tasks, { id: 2, status: 'running', claimedBy: 's2' }] }))).feed, true);
});

test('insideProject: folder or below, not a sibling with the same prefix', () => {
  const p = mkdtempSync(join(tmpdir(), 'kadans-in-'));
  mkdirSync(join(p, 'a'));
  assert.equal(insideProject(p, p), true);
  assert.equal(insideProject(p, join(p, 'a')), true);
  assert.equal(insideProject(join(p, 'a'), p), false);
  assert.equal(insideProject(p, `${p}x`), false);
  assert.equal(insideProject(null, p), false);
});

// ---- pure brake ----
const brakeOv = { state: 'brake', limit: 'five_hour', limits: [{ name: 'five_hour', state: 'brake', brakeAt: NOW + 30 * MIN, resetsAt: NOW + 120 * MIN }] };

test('pretool: brake denies spawning tools, allows the rest', () => {
  const t = [{ id: 1, urgency: 'week', status: 'running', claimedBy: 's1' }];
  const d = decidePretool({ input: { tool_name: 'Agent', session_id: 's1' }, env: {}, ov: brakeOv, tasks: t });
  assert.equal(d.deny, true);
  assert.match(d.reason, /brake/);
  assert.match(d.reason, /resets \d\d:\d\d/);
  assert.equal(decidePretool({ input: { tool_name: 'Workflow' }, env: {}, ov: brakeOv, tasks: [] }).deny, true);
  assert.equal(decidePretool({ input: { tool_name: 'Bash' }, env: {}, ov: brakeOv, tasks: [] }).deny, false);
  assert.equal(decidePretool({ input: { tool_name: 'Agent' }, env: {}, ov: { ...brakeOv, state: 'cruise' }, tasks: [] }).deny, false);
  assert.equal(decidePretool({ input: { tool_name: 'Agent' }, env: { KADANS_ALLOW: '1' }, ov: brakeOv, tasks: [] }).deny, false);
  const urgent = [{ id: 1, urgency: 'urgent', status: 'running', claimedBy: 's1' }];
  assert.equal(decidePretool({ input: { tool_name: 'Agent', session_id: 's1' }, env: {}, ov: brakeOv, tasks: urgent }).deny, false);
  assert.equal(decidePretool({ input: { tool_name: 'Agent', session_id: 's2' }, env: {}, ov: brakeOv, tasks: urgent }).deny, true);
});

// ---- end to end through the CLI, in a sandbox ----
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'kadans-hook-'));
  const home = join(root, 'kadans');
  const claude = join(root, 'claude');
  const proj = join(root, 'proj');
  for (const d of [home, claude, proj]) mkdirSync(d);
  const env = { PATH: process.env.PATH, HOME: root, KADANS_HOME: home, CLAUDE_CONFIG_DIR: claude };
  return { root, home, claude, proj, env, key: accountKey(claude) };
}

function run(sb, args, input = '', extra = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { input, env: { ...sb.env, ...extra }, encoding: 'utf8', timeout: 15000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// pct rises `slope` per minute over the last hour; the window resets in 2 h.
function seed(sb, start, slope) {
  const now = Date.now();
  const resetsAt = now + 120 * MIN;
  const lines = [];
  for (let m = 60; m >= 0; m -= 5) lines.push(JSON.stringify({ t: now - m * MIN, limits: { five_hour: { pct: start + slope * (60 - m), resetsAt } } }));
  mkdirSync(join(sb.home, 'accounts', sb.key), { recursive: true });
  writeFileSync(join(sb.home, 'accounts', sb.key, 'samples.jsonl'), `${lines.join('\n')}\n`);
}

const tasks = (sb) => JSON.parse(readFileSync(join(sb.home, 'tasks.json'), 'utf8'));
const stopIn = (sb, sid = 's1', active = false) => JSON.stringify({ session_id: sid, cwd: sb.proj, hook_event_name: 'Stop', stop_hook_active: active });

test('cli: approve, task add --approved, start, urgent', () => {
  const sb = sandbox();
  run(sb, ['project', 'add', 'P', sb.proj]);
  assert.match(run(sb, ['task', 'add', 'P', 'one', '--approved']).out, /approved/);
  run(sb, ['ekle', 'P', 'two']);
  assert.deepEqual(tasks(sb).map((t) => t.approved), [true, false]);
  assert.equal(run(sb, ['onayla', '2']).code, 0);
  assert.equal(tasks(sb)[1].approved, true);
  assert.equal(run(sb, ['task', 'urgent', '2']).code, 0);
  assert.equal(run(sb, ['task', 'start', '2', '--session', 'abc']).code, 0);
  const t = tasks(sb)[1];
  assert.equal(t.urgency, 'urgent');
  assert.equal(t.status, 'running');
  assert.equal(t.claimedBy, 'abc');
  assert.ok(t.startedAt > 0);
  assert.equal(run(sb, ['task', 'start', '2', '--dry-run']).code, 2); // not queued any more
});

test('hook stop: feeds approved tasks in order, claims them, caps at 3 per session and window', () => {
  const sb = sandbox();
  writeFileSync(join(sb.home, 'config.json'), JSON.stringify({ accounts: { [sb.key]: { gas: true } } }));
  seed(sb, 20, 0.1); // 26 % now, projection ~38 %: gas
  run(sb, ['project', 'add', 'P', sb.proj]);
  run(sb, ['task', 'add', 'P', 'not approved']);
  for (const n of ['a', 'b', 'c', 'd']) run(sb, ['task', 'add', 'P', n, '--approved']);
  const on = { KADANS_THROTTLE: '1' };
  assert.equal(run(sb, ['hook', 'stop'], stopIn(sb)).out, ''); // session not opted in
  for (let i = 0; i < 3; i++) {
    const r = run(sb, ['hook', 'stop'], stopIn(sb, 's1', i > 0), on);
    assert.equal(r.code, 0);
    const j = JSON.parse(r.out);
    assert.equal(j.decision, 'block');
    const id = i + 2;
    assert.ok(j.reason.includes(`run \`kadans task done ${id}\`, then stop`), j.reason);
    assert.match(j.reason, /~\d+% of this window's quota would go to waste/);
    const t = tasks(sb).find((x) => x.id === id);
    assert.equal(t.status, 'running');
    assert.equal(t.claimedBy, 's1');
    // unfinished claimed task: the next stop is allowed (no pile-up, no loop on stop_hook_active)
    assert.equal(run(sb, ['hook', 'stop'], stopIn(sb, 's1', true), on).out, '');
    run(sb, ['task', 'done', String(id)]);
  }
  assert.equal(run(sb, ['hook', 'stop'], stopIn(sb, 's1', true), on).out, ''); // cap reached
  assert.equal(tasks(sb).find((x) => x.id === 5).status, 'queued');
  assert.equal(JSON.parse(run(sb, ['hook', 'stop'], stopIn(sb, 's2'), on).out).decision, 'block'); // other session
  assert.equal(tasks(sb).find((x) => x.id === 1).status, 'queued'); // the unapproved one is never fed
});

test('hook stop: gates off by default and never fails', () => {
  const sb = sandbox();
  seed(sb, 20, 0.1);
  run(sb, ['project', 'add', 'P', sb.proj]);
  run(sb, ['task', 'add', 'P', 'a', '--approved']);
  assert.equal(run(sb, ['hook', 'stop'], stopIn(sb), { KADANS_THROTTLE: '1' }).out, ''); // account not opted in
  for (const bad of ['', 'not json', '{"session_id": 5}', '[]']) {
    const r = run(sb, ['hook', 'stop'], bad, { KADANS_THROTTLE: '1' });
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
  }
  assert.equal(run(sb, ['hook', 'pretool'], 'garbage').code, 0);
});

test('hook pretool: denies Agent while braking, allows with KADANS_ALLOW or an urgent claimed task', () => {
  const sb = sandbox();
  seed(sb, 60, 0.5); // 90 % now, rising: brake
  const input = (tool, sid = 's1') => JSON.stringify({ session_id: sid, cwd: sb.proj, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {} });
  const r = run(sb, ['hook', 'pretool'], input('Agent'));
  const j = JSON.parse(r.out).hookSpecificOutput;
  assert.equal(j.hookEventName, 'PreToolUse');
  assert.equal(j.permissionDecision, 'deny');
  assert.match(j.permissionDecisionReason, /runs out ~\d\d:\d\d \(resets \d\d:\d\d\)/);
  assert.equal(run(sb, ['hook', 'pretool'], input('Bash')).out, '');
  assert.equal(run(sb, ['hook', 'pretool'], input('Agent'), { KADANS_ALLOW: '1' }).out, '');
  run(sb, ['project', 'add', 'P', sb.proj]);
  run(sb, ['task', 'add', 'P', 'u', '--acil']);
  run(sb, ['task', 'start', '1', '--session', 's1']);
  assert.equal(run(sb, ['hook', 'pretool'], input('Workflow')).out, '');
  assert.equal(JSON.parse(run(sb, ['hook', 'pretool'], input('Workflow', 's2')).out).hookSpecificOutput.permissionDecision, 'deny');
  seed(sb, 20, 0.1); // gas: nothing to deny
  assert.equal(run(sb, ['hook', 'pretool'], input('Agent', 's2')).out, '');
});

// ---- notifications ----
test('notify: task text goes as argv, never into the AppleScript source', () => {
  const evil = `a "quoted" \\ back $(rm -rf ~) \`x\` ' end tell`;
  const args = notifyArgs('Kadans', evil);
  const scripts = args.filter((_, i) => args[i - 1] === '-e');
  assert.ok(scripts.every((s) => !s.includes('rm -rf')));
  assert.deepEqual(args.slice(-3), ['--', 'Kadans', evil]);
  const calls = [];
  const runFn = (cmd, a) => calls.push([cmd, a]);
  assert.equal(notify({ notify: false }, 't', evil, { run: runFn, platform: 'darwin' }), false);
  assert.equal(notify({ notify: true }, 't', evil, { run: runFn, platform: 'linux' }), false);
  assert.equal(notify({ notify: true }, 't', evil, { run: runFn, platform: 'darwin' }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'osascript');
});

test('notify: one on feed, one on the first brake per window (in-process, fake runner)', () => {
  const sb = sandbox();
  writeFileSync(join(sb.home, 'config.json'), JSON.stringify({ notify: true, accounts: { [sb.key]: { gas: true } } }));
  run(sb, ['project', 'add', 'P', sb.proj]);
  run(sb, ['task', 'add', 'P', 'feed "me"', '--approved']);
  const calls = [];
  const notifyDeps = { run: (cmd, a) => calls.push(a.at(-1)), platform: 'darwin' };
  const env = { ...sb.env, KADANS_THROTTLE: '1' };
  seed(sb, 20, 0.1);
  assert.equal(JSON.parse(runStop(stopIn(sb), env, { notifyDeps })).decision, 'block');
  assert.deepEqual(calls, ['#1 feed "me"']);
  seed(sb, 60, 0.5);
  const pre = JSON.stringify({ session_id: 's9', tool_name: 'Agent' });
  runPretool(pre, env, { notifyDeps });
  runPretool(pre, env, { notifyDeps });
  assert.equal(calls.length, 2); // brake notified once for this window
  assert.match(calls[1], /resets/);
});

test('hooks give up quickly on a held store lock: exit 0, nothing extra on stdout', () => {
  const sb = sandbox();
  seed(sb, 60, 0.5); // brake, so pretool reaches the brake notification (which takes the lock)
  writeFileSync(join(sb.home, 'config.json'), JSON.stringify({ notify: true }));
  mkdirSync(join(sb.home, '.lock')); // a fresh lock held by someone else (not stale)
  const timed = (args, input) => {
    const t0 = Date.now();
    const r = run(sb, args, input);
    return { ...r, ms: Date.now() - t0 };
  };
  const ev = timed(['hook', 'event'], JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: sb.proj, prompt: 'hi' }));
  assert.equal(ev.code, 0);
  assert.equal(ev.out, '');
  assert.ok(ev.ms < 12_000, `hook event waited ${ev.ms} ms on the lock`);
  const pre = timed(['hook', 'pretool'], JSON.stringify({ session_id: 's1', cwd: sb.proj, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: {} }));
  assert.equal(pre.code, 0);
  assert.equal(JSON.parse(pre.out).hookSpecificOutput.permissionDecision, 'deny'); // the decision does not need the lock
  assert.ok(pre.ms < 12_000, `hook pretool waited ${pre.ms} ms on the lock`);
});
