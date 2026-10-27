// gas tick: every reason code, the caps across calls (fake clock, temp KADANS_HOME), the dry run, the start through an
// injected starter, config keys and the CLI. Never a real session: starters are fakes, the CLI only runs off or --dry-run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, loadConfig } from '../lib/pace.mjs';
import { accountKey, appendSample } from '../lib/samples.mjs';
import { addProject, addTask, readTasks, updateTask } from '../lib/store.mjs';
import { parseSetting, setSetting } from '../lib/config.mjs';
import { startPlan, startTask } from '../lib/launch.mjs';
import { GAP_MS, WHY, freeGBFromVmStat, readAutoGasState, renderTick, runTick, tickJson } from '../lib/autogas.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
const MIN = 60_000;
const H = 60 * MIN;
const NOW = Date.UTC(2026, 9, 27, 2, 0);
const OWN = 'aaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbb';

const tmp = () => mkdtempSync(join(tmpdir(), 'kadans-autogas-'));
// Five-hour window ending `left` from now, used share rising to `pct` (three samples over 19 minutes).
const window5 = (pct, left = 3 * H, now = NOW) => [
  { t: now - 20 * MIN, limits: { five_hour: { pct: pct - 2, resetsAt: now + left } } },
  { t: now - 10 * MIN, limits: { five_hour: { pct: pct - 1, resetsAt: now + left } } },
  { t: now - MIN, limits: { five_hour: { pct, resetsAt: now + left } } },
];
const cfgOn = (over = {}) => ({ ...DEFAULTS, autoGas: true, accounts: { [OWN]: { gas: true } }, ...over });

// A temp home with one project folder and the given tasks ([text, { urgency, approved }]).
function world(tasks = [['Write the docs', { approved: true }]]) {
  const home = tmp();
  const dir = join(tmp(), 'proj');
  mkdirSync(dir);
  addProject(home, { name: 'proj', path: dir });
  for (const [text, o] of tasks) addTask(home, { project: 'proj', text, urgency: o.urgency ?? 'week', approved: o.approved === true }, NOW - H);
  return { home, dir };
}

// A starter that only marks the task running (as startTask would) and records the call. No session, no orca, no terminal.
function fakeStarter(home, { fail = false } = {}) {
  const calls = [];
  const start = (id) => {
    calls.push(id);
    if (fail) throw new Error('orca said no');
    const sessionId = `sess-${calls.length}`;
    updateTask(home, id, { status: 'running', claimedBy: sessionId, startedAt: NOW });
    return { sessionId, how: 'opened (fake)' };
  };
  return { start, calls };
}

const deps = (home, samples, extra = {}) => ({ own: OWN, samples: () => samples, now: NOW, platform: 'darwin', ram: () => 6, ...extra });

test('gas tick: starts the next approved task when the window would end with spare quota, and records it', () => {
  const { home } = world([['Low one', { approved: true, urgency: 'idle' }], ['Urgent one', { approved: true, urgency: 'urgent' }], ['Not approved', { urgency: 'urgent' }]]);
  const f = fakeStarter(home);
  const r = runTick(home, cfgOn(), { ...deps(home, window5(12)), start: f.start });
  assert.deepEqual(tickJson(r), { started: 2, why: 'started' }); // the id as stored: a number, as in status --json // the picker's best approved task (urgent), not the unapproved one
  assert.deepEqual(Object.keys(tickJson(r)), ['started', 'why']);
  assert.deepEqual(f.calls, ['2']);
  const st = readAutoGasState(home);
  assert.equal(st.starts.length, 1);
  assert.deepEqual(st.starts[0], { t: NOW, windowId: NOW + 3 * H, taskId: '2', sessionId: 'sess-1', ok: true });
  assert.equal(readFileSync(join(home, 'autogas.json'), 'utf8').includes('Urgent'), false); // ids only, no task text
  assert.match(renderTick(r), /started task #2 on spare quota/);
});

test('gas tick: off unless both the own account gas switch and autoGas are on; never another account', () => {
  const { home } = world();
  const f = fakeStarter(home);
  const s = window5(12);
  const cases = [
    { ...DEFAULTS, accounts: { [OWN]: { gas: true } } }, // autoGas default false
    { ...DEFAULTS, autoGas: true }, // no gas switch
    { ...DEFAULTS, autoGas: true, accounts: { [OWN]: { gas: false } } },
    { ...DEFAULTS, autoGas: true, accounts: { [OTHER]: { gas: true } } }, // another account's switch does not count
  ];
  for (const cfg of cases) assert.deepEqual(tickJson(runTick(home, cfg, { ...deps(home, s), start: f.start })), { started: null, why: 'off' });
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(join(home, 'autogas.json')), false);
});

test('gas tick: not-gas, near-reset, too-little-spare (the tightest limit counts), no-task', () => {
  const { home } = world();
  const f = fakeStarter(home);
  const why = (cfg, samples, h = home) => runTick(h, cfg, { ...deps(h, samples), start: f.start }).why;
  assert.equal(why(cfgOn(), window5(36)), 'not-gas'); // projects ~90 %: cruise
  assert.equal(why(cfgOn(), [{ t: NOW - MIN, limits: { five_hour: { pct: 30, resetsAt: NOW + 3 * H } } }]), 'not-gas'); // LOW DATA, 30 % used
  assert.equal(why(cfgOn(), window5(10, 30 * MIN)), 'near-reset'); // gas, but 30 min left
  const loose = cfgOn({ targets: { five_hour: 100, seven_day: 100 }, slack: 0 });
  assert.equal(why(loose, window5(36)), 'too-little-spare'); // gas under a 100 % target, but only ~10 % unused
  // five-hour has lots of room (~30 %), the seven-day limit projects ~90 %: the tight one decides
  const seven = (pct) => window5(12).map((x, i) => ({ t: x.t, limits: { ...x.limits, seven_day: { pct: pct - 0.02 + i * 0.01, resetsAt: NOW + 6 * 24 * H } } }));
  assert.equal(why(loose, seven(12.9)), 'too-little-spare');
  assert.equal(runTick(home, loose, { ...deps(home, seven(5)), dryRun: true, start: f.start }).why, 'would-start');
  const empty = world([['Not approved yet', {}]]);
  assert.equal(why(cfgOn(), window5(12), empty.home), 'no-task');
  assert.equal(f.calls.length, 0);
});

test('gas tick: not-macos, low-ram (also when vm_stat cannot be read); RAM is read only after the cheaper gates', () => {
  const { home } = world();
  const f = fakeStarter(home);
  let reads = 0;
  const ram = (v) => () => {
    reads++;
    return v;
  };
  assert.equal(runTick(home, cfgOn(), { ...deps(home, window5(12)), platform: 'linux', ram: ram(8), start: f.start }).why, 'not-macos');
  assert.equal(reads, 0);
  const low = runTick(home, cfgOn(), { ...deps(home, window5(12)), ram: ram(1.6), start: f.start });
  assert.equal(low.why, 'low-ram');
  assert.match(renderTick(low), /1\.6 GB free/);
  assert.equal(runTick(home, cfgOn(), { ...deps(home, window5(12)), ram: ram(null), start: f.start }).why, 'low-ram');
  assert.equal(runTick(home, cfgOn({ autoGasMinRamGB: 1.5 }), { ...deps(home, window5(12)), ram: ram(1.6), start: f.start }).why, 'started');
  assert.equal(runTick(home, cfgOn(), { ...deps(home, window5(36)), ram: ram(8), start: f.start }).why, 'not-gas');
  assert.equal(reads, 3); // not for linux, not after not-gas
  assert.deepEqual(f.calls, ['1']);
});

test('gas tick: caps hold across calls (fake clock): autoGasMax running TASKS, 10 min apart; a done task frees its place', () => {
  const { home } = world([['One', { approved: true }], ['Two', { approved: true }], ['Three', { approved: true }], ['Four', { approved: true }]]);
  const f = fakeStarter(home);
  const at = (now, cfg = cfgOn()) => runTick(home, cfg, { ...deps(home, window5(12, 4 * H, now)), now, start: f.start }).why;
  assert.equal(at(NOW), 'started');
  assert.equal(at(NOW + 5 * MIN), 'cap'); // max 1: task 1 runs
  assert.equal(at(NOW + 5 * MIN, cfgOn({ autoGasMax: 2 })), 'too-soon'); // room for two, but not 10 min apart
  assert.equal(at(NOW + 30 * MIN), 'cap'); // task 1 still running (its session may be open or not: the task counts)
  updateTask(home, 1, { status: 'done' }); // done; its session may still sit idle: it no longer blocks
  assert.equal(at(NOW + 30 * MIN), 'started');
  assert.equal(at(NOW + 45 * MIN), 'cap'); // task 2 runs
  assert.equal(at(NOW + 45 * MIN, cfgOn({ autoGasMax: 2 })), 'started');
  assert.equal(at(NOW + 60 * MIN, cfgOn({ autoGasMax: 2 })), 'cap'); // tasks 2 and 3 run
  updateTask(home, 2, { status: 'skipped' });
  assert.equal(at(NOW + 60 * MIN, cfgOn({ autoGasMax: 2 })), 'started');
  assert.equal(at(NOW + 75 * MIN, cfgOn({ autoGasMax: 3 })), 'no-task');
  assert.deepEqual(f.calls, ['1', '2', '3', '4']);
  assert.deepEqual(readAutoGasState(home).starts.map((s) => [s.taskId, s.sessionId, s.ok]), [['1', 'sess-1', true], ['2', 'sess-2', true], ['3', 'sess-3', true], ['4', 'sess-4', true]]);
});

test('gas tick: a task that fails to start says start-failed once, then is skipped for the rest of that window', () => {
  const { home } = world([['Broken one', { approved: true, urgency: 'urgent' }], ['Fine one', { approved: true }]]);
  const calls = [];
  const start = (id) => {
    calls.push(id);
    if (id === '1') throw new Error('project folder not found');
    updateTask(home, id, { status: 'running', claimedBy: 'sess-ok' });
    return { sessionId: 'sess-ok' };
  };
  const at = (dt, samples = window5(12, 2 * H - dt, NOW + dt)) => runTick(home, cfgOn(), { ...deps(home, samples, { now: NOW + dt }), start });
  const r = at(0);
  assert.deepEqual(tickJson(r), { started: null, why: 'start-failed' });
  assert.match(renderTick(r), /could not start: project folder not found \(skipped until the window resets\)/);
  assert.equal(readTasks(home)[0].status, 'queued'); // put back by the start path, but skipped by the picker
  assert.equal(at(5 * MIN).why, 'too-soon');
  assert.deepEqual(tickJson(at(11 * MIN)), { started: 2, why: 'started' }); // the next task, never task 1 again
  updateTask(home, 2, { status: 'done' });
  assert.equal(at(30 * MIN).why, 'no-task'); // only the failed one is left: no retry every 10 min
  assert.deepEqual(calls, ['1', '2']);
  // after the reset (a new window) it may be tried again
  assert.equal(runTick(home, cfgOn(), { ...deps(home, window5(12, 4 * H, NOW + 3 * H), { now: NOW + 3 * H }), dryRun: true, start }).why, 'would-start');
  assert.deepEqual(readAutoGasState(home).starts.map((s) => [s.taskId, s.ok, s.windowId]), [['1', false, NOW + 2 * H], ['2', true, NOW + 2 * H]]);
});

test('gas tick at night: no live 5-hour window counts as spare (100 %); the start opens the window', () => {
  const { home } = world();
  const f = fakeStarter(home);
  // the last window ended an hour ago at 80 %: spare, window id = now + 5 h
  const ended = [{ t: NOW - 3 * H, limits: { five_hour: { pct: 70, resetsAt: NOW - H } } }, { t: NOW - 2 * H, limits: { five_hour: { pct: 80, resetsAt: NOW - H } } }];
  const r = runTick(home, cfgOn(), { ...deps(home, ended), start: f.start });
  assert.deepEqual(tickJson(r), { started: 1, why: 'started' });
  assert.equal(readAutoGasState(home).starts[0].windowId, NOW + 5 * H);
  // no five-hour sample at all: the same
  const w2 = world();
  assert.equal(runTick(w2.home, cfgOn(), { ...deps(w2.home, []), dryRun: true }).why, 'would-start');
  // the other caps still hold: off, low RAM, a seven-day limit that brakes
  assert.equal(runTick(w2.home, { ...cfgOn(), autoGas: false }, { ...deps(w2.home, ended), dryRun: true }).why, 'off');
  assert.equal(runTick(w2.home, cfgOn(), { ...deps(w2.home, ended), ram: () => 1, dryRun: true }).why, 'low-ram');
  const hot = [...ended, { t: NOW - 20 * MIN, limits: { seven_day: { pct: 97, resetsAt: NOW + 24 * H } } }, { t: NOW - MIN, limits: { seven_day: { pct: 97.5, resetsAt: NOW + 24 * H } } }];
  assert.equal(runTick(w2.home, cfgOn(), { ...deps(w2.home, hot), dryRun: true }).why, 'not-gas');
});

test('gas tick: LOW DATA with <= 10 % used and >= 45 min left counts as spare (100 - used)', () => {
  const { home } = world();
  const one = (pct, left) => [{ t: NOW - MIN, limits: { five_hour: { pct, resetsAt: NOW + left } } }];
  const why = (samples) => runTick(home, cfgOn(), { ...deps(home, samples), dryRun: true }).why;
  const r = runTick(home, cfgOn(), { ...deps(home, one(5, 4 * H)), dryRun: true });
  assert.deepEqual([r.why, r.spare], ['would-start', 95]);
  assert.equal(why(one(10, 4 * H)), 'would-start');
  assert.equal(why(one(11, 4 * H)), 'not-gas');
  assert.equal(why(one(5, 30 * MIN)), 'near-reset');
  assert.equal(existsSync(join(home, 'autogas.json')), false);
});

test('gas tick --dry-run: the gates only; no starter call, no record, tasks unchanged', () => {
  const { home } = world();
  const f = fakeStarter(home);
  const before = JSON.stringify(readTasks(home));
  const r = runTick(home, cfgOn(), { ...deps(home, window5(12)), dryRun: true, start: f.start });
  assert.deepEqual(tickJson(r), { started: null, why: 'would-start' });
  assert.match(renderTick(r), /dry run: would start task #1 .*nothing started/);
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(join(home, 'autogas.json')), false);
  assert.equal(JSON.stringify(readTasks(home)), before);
  assert.equal(runTick(home, cfgOn(), { ...deps(home, window5(36)), dryRun: true, start: f.start }).why, 'not-gas');
});

test('gas tick: the start goes through the task start path (startPlan + startTask), here with a fake Terminal opener', () => {
  const { home, dir } = world();
  const opened = [];
  const start = (id) => {
    const ctx = { task: readTasks(home).find((t) => t.id === Number(id) || String(t.id) === id), project: { path: dir } };
    const plan = startPlan(home, ctx, { run: null, uuid: () => 'fixed-session' });
    const r = startTask(home, ctx.task.id, plan, { run: null, exec: (argv) => opened.push(argv), now: NOW });
    return { sessionId: plan.sessionId, how: r.how };
  };
  const r = runTick(home, cfgOn(), { ...deps(home, window5(12)), start });
  assert.equal(r.why, 'started');
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0], '/usr/bin/open');
  const script = readFileSync(join(home, 'run', 'task-1.command'), 'utf8');
  assert.match(script, /unset CLAUDE_CONFIG_DIR/); // the own account, never another profile
  assert.match(script, /exec claude --session-id fixed-session 'Write the docs'/);
  assert.deepEqual([readTasks(home)[0].status, readTasks(home)[0].claimedBy], ['running', 'fixed-session']);
  assert.equal(readAutoGasState(home).starts[0].sessionId, 'fixed-session');
});

test('vm_stat parser: free + inactive + speculative + purgeable pages times the page size', () => {
  const text = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:    65536.\nPages active:  99449.\nPages inactive:   65536.\nPages speculative:  0.\nPages purgeable:  0.\n';
  assert.equal(freeGBFromVmStat(text), 2);
  assert.equal(freeGBFromVmStat('nonsense'), null);
  assert.equal(freeGBFromVmStat('(page size of 4096 bytes)\nPages active: 5.\n'), null);
});

test('config: autoGas, autoGasMax 1-3, autoGasMinRamGB 0.5-16 (one decimal); defaults off, 1, 2.5', () => {
  assert.deepEqual(parseSetting('autoGas', 'true', OWN), { path: ['autoGas'], value: true });
  assert.deepEqual(parseSetting('autoGasMax', '3', OWN), { path: ['autoGasMax'], value: 3 });
  assert.deepEqual(parseSetting('autoGasMinRamGB', '2.5', OWN), { path: ['autoGasMinRamGB'], value: 2.5 });
  assert.deepEqual(parseSetting('autoGasMinRamGB', '16', OWN), { path: ['autoGasMinRamGB'], value: 16 });
  for (const [k, v] of [['autoGas', 'yes'], ['autoGasMax', '0'], ['autoGasMax', '4'], ['autoGasMax', '1.5'], ['autoGasMinRamGB', '0.2'], ['autoGasMinRamGB', '17'], ['autoGasMinRamGB', '2.55'], ['autoGasMinRamGB', '-1'], ['autoGasMinRamGB', 'NaN']]) {
    assert.ok(parseSetting(k, v, OWN).error, `${k}=${v} must be refused`);
  }
  const home = tmp();
  const c0 = loadConfig(home);
  assert.deepEqual([c0.autoGas, c0.autoGasMax, c0.autoGasMinRamGB], [false, 1, 2.5]);
  setSetting(home, 'autoGas', 'true', { ownKey: OWN });
  setSetting(home, 'autoGasMax', '2', { ownKey: OWN });
  setSetting(home, 'autoGasMinRamGB', '3.5', { ownKey: OWN });
  const c = loadConfig(home);
  assert.deepEqual([c.autoGas, c.autoGasMax, c.autoGasMinRamGB], [true, 2, 3.5]);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ autoGas: 'true', autoGasMax: 9, autoGasMinRamGB: 0 }));
  const bad = loadConfig(home);
  assert.deepEqual([bad.autoGas, bad.autoGasMax, bad.autoGasMinRamGB], [false, 1, 2.5]); // hand-edited junk falls back
});

// CLI: temp HOME (own key = temp ~/.claude), temp KADANS_HOME, a fake orca that logs every call. Only `off` and --dry-run.
function cliWorld() {
  const root = tmp();
  const home = join(root, 'kadans');
  const claude = join(root, '.claude');
  mkdirSync(home);
  mkdirSync(claude);
  const log = join(root, 'orca.log');
  const fake = join(root, 'fake-orca.sh');
  writeFileSync(fake, `#!/bin/sh\necho "$*" >> "${log}"\nexit 3\n`);
  chmodSync(fake, 0o755);
  // CLAUDE_CONFIG_DIR points at another profile: gas tick must ignore it and use the own ~/.claude
  const env = { PATH: process.env.PATH, HOME: root, KADANS_HOME: home, CLAUDE_CONFIG_DIR: join(root, 'other-profile'), KADANS_ORCA_BIN: fake, KADANS_ORCA_TIMEOUT_MS: '30000' };
  const cli = (args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 15000 });
  return { root, home, own: accountKey(claude), log, cli };
}

test('cli: gas tick --json prints exactly {started, why}; off by default; --dry-run calls no orca and writes nothing', () => {
  const w = cliWorld();
  const r = w.cli(['gas', 'tick', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { started: null, why: 'off' });
  assert.equal(w.cli(['gas', 'tick']).stdout.trim(), 'not started: off (needs accounts.<own key>.gas and autoGas true)');
  assert.notEqual(w.cli(['gas', 'frob']).status, 0);

  // own account on, gas state, an approved task: the dry run runs every gate and stops before any plan
  const now = Date.now();
  for (const s of window5(12, 3 * H, now)) appendSample(w.home, w.own, s, now);
  const proj = join(w.root, 'proj');
  mkdirSync(proj);
  addProject(w.home, { name: 'proj', path: proj });
  addTask(w.home, { project: 'proj', text: 'Write the docs', approved: true }, now);
  assert.equal(w.cli(['config', 'set', `accounts.${w.own}.gas`, 'true']).status, 0);
  assert.equal(w.cli(['config', 'set', 'autoGas', 'true']).status, 0);
  assert.equal(w.cli(['config', 'set', 'autoGasMinRamGB', '0.5']).status, 0);
  const d = w.cli(['gas', 'tick', '--dry-run', '--json']);
  assert.equal(d.status, 0, d.stderr);
  const j = JSON.parse(d.stdout);
  assert.deepEqual(Object.keys(j), ['started', 'why']);
  assert.equal(j.started, null);
  assert.ok(WHY.includes(j.why));
  if (process.platform === 'darwin') assert.ok(['would-start', 'low-ram'].includes(j.why), j.why);
  else assert.equal(j.why, 'not-macos');
  assert.equal(existsSync(w.log), false); // no orca call at all
  assert.equal(existsSync(join(w.home, 'autogas.json')), false);
  assert.equal(existsSync(join(w.home, 'run')), false);
  const g = JSON.parse(w.cli(['config', 'get', '--json']).stdout);
  assert.deepEqual([g.autoGas, g.autoGasMax, g.autoGasMinRamGB], [true, 1, 0.5]);
});
