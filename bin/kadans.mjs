#!/usr/bin/env node
// kadans: pace Claude Code usage limits and list running agents. Commands: see HELP.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountKey, appendSample, configDir, kadansHome, listAccounts, readSamples, sampleFromPayload } from '../lib/samples.mjs';
import { loadConfig, overall } from '../lib/pace.mjs';
import { renderAge, renderLine } from '../lib/render.mjs';
import { HOOK_LOCK_WAIT_MS, IMPORTANCE, addProject, addTask, readProjects, readTasks, setLockWait, updateTask } from '../lib/store.mjs';
import { rankTasks } from '../lib/pick.mjs';
import { notifyBrakeOnce, runPretool, runStop } from '../lib/hooks.mjs';
import { notify } from '../lib/notify.mjs';
import { kadansCommand, plan } from '../lib/install.mjs';
import { configView, setSetting } from '../lib/config.mjs';
import { ORCA_TIMEOUT_MS, briefOf, compactAgent, findAgent, listAgents, listAgentsAsync, orcaRunner, readBrief, renderAgents, runEvent, stopAgent } from '../lib/agents.mjs';
import { setTitle } from '../lib/titles.mjs';
import { MODE_OF, clearAutoPause, ownKey, parseUntil, runPacePost, runPacePre, setAutopace, setPace, windowOf } from '../lib/pace-control.mjs';
import { checkStartable, describePlan, replaceAgent, startPlan, startTask } from '../lib/launch.mjs';
import { fetchUsage, readUsageState, renderUsage, usageJson } from '../lib/usage-api.mjs';
import { renderTick, runTick, tickJson } from '../lib/autogas.mjs';
import { KICKOFF_ARGV, applySchedule, decide, describeSchedule, kickoffEnv, readKickoffState, runKickoff, schedulePlan } from '../lib/kickoff.mjs';

const HELP = `kadans: pace Claude Code usage limits

Usage:
  kadans statusline   read the status line payload on stdin, record a sample,
                      run the chained status line (output dropped), print one line
  kadans status [--json]   show every recorded account (--json: the panel's data)
  kadans project add <name> <path> [--importance high|normal|low]   (proje ekle, --onem)
  kadans project list                                               (proje liste)
  kadans task add <project> "<text>" [--urgent|--week|--idle] [--approved]
                                          (ekle, --acil|--hafta|--bos, --onayli)
  kadans task list [--all]                                          (liste, --hepsi)
  kadans task done|skip <id>                                        (bitti|atla)
  kadans task start <id> [--dry-run]   open a new Claude Code session for an approved task
                                       (Orca worktree: orca agent launch; else Terminal.app)  (basla)
  kadans task start <id> --session <id>   only mark it running, claimed by that session
  kadans task urgent <id>                                           (acil)
  kadans approve <id>     owner approves a task for the throttle    (onayla)
  kadans agents [--json] [--all]   running Claude Code agents (and Orca's); the text list leaves out agents
                      idle for 2+ hours (JSON marks them stale: true); --all lists them and ended ones
  kadans agents --brief --json     {"working","needsYou","t"} for the menu bar (no transcript reads)
  kadans agent stop <id>     stop one agent (Orca terminal close, else SIGTERM to its pid)
  kadans agent compact <id> [--dry-run]   type /compact into an idle chat's Orca terminal (orca terminal send);
                      refused for working, waiting or ended chats, a chat with unsent text in its input line, and
                      outside Orca (type /compact there yourself)
  kadans agent title <id> "<text>"   set the agent's title ("" clears it)
  kadans agent replace <agentId> <taskId> [--dry-run]   stop the agent, then task start
  kadans agent pace <id> slow|pause|none [--until reset|30m]   slow (wait before each tool call), pause
                      (halt before its next tool) or resume one of your own sessions; default --until reset
  kadans autopace on|off   auto-pace: nudge sessions when usage runs hot, slow them if the brake holds 10 min
  kadans usage fetch [--json]   read your own account's usage (~/.claude) from Claude's usage endpoint and record
                      it as a sample; Keychain item "Claude Code-credentials", never the refresh token; at most
                      once a minute, backs off after errors; off with config usageApi false
  kadans hook stop|pretool|event|pace-pre|pace-post   Claude Code hooks (hook JSON on stdin; never fail)
  kadans config get [--json]           show the settings the app can change
  kadans config set <key> <value>      limits auto|five_hour|five_hour,seven_day, targets.five_hour|targets.seven_day
                      50-100, slack 0-30, warmup.minutes 0-60, warmup.pct 0-50, notify|autopace|usageApi true|false,
                      lang en|tr, accounts.<own key>.gas true|false (your own account only),
                      kickoff.enabled true|false, kickoff.from|kickoff.to HH:MM,
                      compact.soonPct 10-95 (% of the context window) or 101 (Off), compact.nowPct 10-95,
                      compact.idleMin 1-120, autoGas true|false, autoGasMax 1-3, autoGasMinRamGB 0.5-16
  kadans kickoff [--dry-run]   start the next 5-hour window with one tiny Haiku message (claude -p, own account),
                      only if kickoff.enabled, inside kickoff.from-kickoff.to, and the window has ended
  kadans kickoff schedule|unschedule [--apply]   preview (or write and load) the launchd job that runs
                      \`kadans kickoff\` every 15 minutes (~/Library/LaunchAgents/dev.kadans.kickoff.plist)
  kadans gas tick [--dry-run] [--json]   use spare quota on its own: start the next approved task in a new session
                      (the task start path) when your own window would end with >= 15% unused and >= 45 min left,
                      or no window runs (then the start opens one); needs accounts.<own key>.gas and autoGas true;
                      caps: autoGasMax auto-started tasks running, 10 min apart, a failed task waits for the next window,
                      autoGasMinRamGB free; --json: {"started": <task id or null>, "why": "<code>"}
  kadans install [--apply] [--json]   preview (or write, with backup) settings.json changes
  kadans uninstall [--apply] preview (or write, with backup) removing them
  kadans --help       show this help

Environment:
  KADANS_HOME         data and config dir (default ~/.kadans); config in config.json
  CLAUDE_CONFIG_DIR   Claude config dir of the account to record (default ~/.claude)
  KADANS_THROTTLE=1   session opt-in for the Stop-hook throttle (also needs accounts.<key>.gas in config)
  KADANS_ALLOW=1      let spawning tools through while the brake is on
  KADANS_ORCA=0       do not ask the orca CLI for its agent terminals (KADANS_ORCA_BIN: path to the orca binary)
`;

function expandHome(p) {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

// Pipes the same stdin to the chained script and drops its stdout and stderr.
function runChain(cfg, raw) {
  const chain = expandHome(cfg.chain);
  try {
    accessSync(chain, constants.X_OK);
  } catch {
    return;
  }
  spawnSync(chain, [], { input: raw, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 });
}

function statusline(env) {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  const home = kadansHome(env);
  const key = accountKey(configDir(env));
  const now = Date.now();
  const cfg = loadConfig(home);
  setLockWait(HOOK_LOCK_WAIT_MS); // the status line runs on every refresh: never wait more than 2 s for the lock
  let lockBusy = false;
  try {
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
    const sample = sampleFromPayload(payload, now);
    if (sample) appendSample(home, key, sample, now);
  } catch (e) {
    // recording must never break the status line; on a lock timeout the gauge is shown from what is on disk
    lockBusy = e?.message === 'kadans: lock timeout';
  }
  try {
    runChain(cfg, raw);
  } catch {
    // the chained script must never break the status line
  }
  try {
    const samples = readSamples(home, key);
    if (samples.length === 0) return '';
    const res = overall(samples, now, cfg);
    try {
      if (!lockBusy) notifyBrakeOnce(home, cfg, key, res); // it needs the lock too: skip rather than wait again
    } catch {
      // notifications must never break the status line
    }
    return renderLine(res, now, cfg.lang);
  } catch {
    return '';
  }
}

// Finite numbers only (Infinity, NaN and missing become null), rounded for display; no new maths.
function num(v, digits = 1) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function limitJson(l) {
  return {
    name: l.name,
    state: l.state,
    pct: num(l.pct),
    rate: num(l.rate, 3),
    needle: num(l.needle, 3),
    projection: num(l.projection),
    resetsAt: num(l.resetsAt, 0),
    timeLeft: num(l.timeLeft, 0),
    brakeAt: num(l.brakeAt, 0),
    target: num(l.target),
    lastT: num(l.lastT, 0),
    samples: Number.isFinite(l.samples) ? l.samples : 0,
    ended: l.ended === true,
  };
}

function onPath(env, name) {
  for (const dir of String(env.PATH ?? '').split(':')) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // not here
    }
  }
  return false;
}

// Queued tasks, best first: ready = approved queued tasks; next = the top 3 for "Up next"; startable = top 5 approved.
function queueJson(home, now) {
  const projects = readProjects(home);
  const ranked = rankTasks(readTasks(home), projects, now);
  const name = (t) => projects.find((p) => String(p.id) === String(t.projectId))?.name ?? null;
  return {
    ready: ranked.filter(({ task }) => task.approved === true).length,
    next: ranked.slice(0, 3).map(({ task }) => ({
      id: task.id,
      text: task.text,
      project: name(task),
      urgency: task.urgency,
      approved: task.approved === true,
    })),
    // Approved queued tasks, best first: what Start and Replace can open now.
    startable: ranked.filter(({ task }) => task.approved === true).slice(0, 5).map(({ task }) => ({
      id: task.id,
      text: task.text,
      project: name(task),
      urgency: task.urgency,
    })),
  };
}

// `kadans status --json`: the panel's data (the JSON contract). Always prints JSON and exits 0;
// problems go into `error`.
// A reading older than this is not fresh: the menu bar dims it and the panel says how old it is.
const FRESH_MS = 10 * 60_000;

function statusJson(env, now = Date.now()) {
  const out = { version: 1, now, error: null, autopace: false, accounts: [], queue: { ready: 0, next: [] } };
  try {
    const home = kadansHome(env);
    const cfg = loadConfig(home);
    out.autopace = cfg.autopace === true;
    out.pace = { slowSeconds: cfg.pace.slowSeconds };
    // The usage endpoint reader (lib/usage-api.mjs): times and a short code only, no token.
    const ua = readUsageState(home);
    out.usageApi = {
      enabled: cfg.usageApi === true,
      lastOk: Number(ua.lastOk) || null,
      lastError: typeof ua.lastError === 'string' ? ua.lastError : null,
      nextAt: Number(ua.nextAt) > now ? Number(ua.nextAt) : null,
    };
    // The own account is always the main ~/.claude, even when CLAUDE_CONFIG_DIR points at another profile.
    const ownKey = accountKey(join(homedir(), '.claude'));
    for (const key of listAccounts(home)) {
      const samples = readSamples(home, key);
      if (samples.length === 0) continue;
      const res = overall(samples, now, cfg);
      const own = key === ownKey;
      out.accounts.push({
        key,
        label: own ? 'Your account' : 'Other account',
        configDir: own ? '~/.claude' : null,
        own,
        gas: own && cfg.accounts[key]?.gas === true, // other accounts never throttle
        lastSample: samples[samples.length - 1].t,
        fresh: now - samples[samples.length - 1].t <= FRESH_MS,
        lastSource: samples[samples.length - 1].source === 'api' ? 'api' : 'statusline',
        state: res.state,
        limit: res.limit,
        limits: res.limits.map(limitJson),
      });
    }
    out.accounts.sort((a, b) => Number(b.own) - Number(a.own) || b.lastSample - a.lastSample);
    out.queue = queueJson(home, now);
    if (out.accounts.length === 0) {
      const noClaude = !existsSync(join(homedir(), '.claude')) && !existsSync(configDir(env)) && !onPath(env, 'claude');
      out.error = noClaude
        ? { code: 'no_claude', message: 'no Claude Code config dir and no claude on PATH', at: now }
        : { code: 'no_data', message: 'no usage samples recorded yet', at: now };
    }
  } catch (e) {
    out.error = { code: 'read_failed', message: String(e?.message ?? e), at: now };
  }
  return out;
}

function status(args, env) {
  if (parseArgs(args).flags.json) {
    process.stdout.write(`${JSON.stringify(statusJson(env), null, 2)}\n`);
    return 0;
  }
  const home = kadansHome(env);
  const cfg = loadConfig(home);
  const now = Date.now();
  const accounts = listAccounts(home);
  if (accounts.length === 0) {
    process.stdout.write('no accounts recorded yet\n');
    return 0;
  }
  for (const key of accounts) {
    const samples = readSamples(home, key);
    if (samples.length === 0) continue;
    const res = overall(samples, now, cfg);
    const age = renderAge(now - samples[samples.length - 1].t, cfg.lang);
    process.stdout.write(`${key}  ${renderLine(res, now, cfg.lang)}  (${age})\n`);
  }
  return 0;
}

// Splits argv into positional words and --flags (--name value or --name=value; known switches take no value).
const SWITCHES = new Set(['urgent', 'week', 'idle', 'acil', 'hafta', 'bos', 'all', 'hepsi', 'approved', 'onayli', 'apply', 'uygula', 'json', 'dry-run']);
function parseArgs(args) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (eq !== -1) flags[name] = a.slice(eq + 1);
    else if (SWITCHES.has(name)) flags[name] = true;
    else flags[name] = args[++i] ?? '';
  }
  return { pos, flags };
}

const URGENCY_FLAGS = { urgent: 'urgent', acil: 'urgent', week: 'week', hafta: 'week', idle: 'idle', bos: 'idle' };
const STATUS_TEXT = { queued: 'queued', proposed: 'proposed', running: 'running', done: 'done', skipped: 'skipped' };

function fail(msg) {
  process.stderr.write(`kadans: ${msg}\n`);
  return 2;
}

function projectCmd(sub, args, env) {
  const home = kadansHome(env);
  const { pos, flags } = parseArgs(args);
  if (sub === 'add' || sub === 'ekle') {
    if (pos.length < 2) return fail('usage: kadans project add <name> <path> [--importance high|normal|low]');
    const importance = flags.importance ?? flags.onem ?? 'normal';
    if (!IMPORTANCE.includes(importance)) return fail(`importance must be high, normal or low: ${importance}`);
    const path = resolve(pos[1]);
    const p = addProject(home, { name: pos[0], path, importance });
    if (!existsSync(path) || !statSync(path).isDirectory()) process.stderr.write(`kadans: warning: folder not found: ${path}\n`);
    process.stdout.write(`project added: #${p.id} ${p.name} (importance: ${p.importance}) ${p.path}\n`);
    return 0;
  }
  if (sub === 'list' || sub === 'liste') {
    const projects = readProjects(home);
    if (projects.length === 0) process.stdout.write('no projects yet\n');
    for (const p of projects) process.stdout.write(`#${p.id}  ${p.name}  importance: ${p.importance}  ${p.path}\n`);
    return 0;
  }
  return fail('project commands: add (ekle), list (liste)');
}

function taskCmd(sub, args, env) {
  const home = kadansHome(env);
  const { pos, flags } = parseArgs(args);
  if (sub === 'add' || sub === 'ekle') {
    if (pos.length < 2) return fail('usage: kadans task add <project> "<text>" [--urgent|--week|--idle]');
    const picked = Object.keys(flags).filter((f) => URGENCY_FLAGS[f]);
    if (new Set(picked.map((f) => URGENCY_FLAGS[f])).size > 1) return fail('pick one urgency: --urgent, --week or --idle (--acil, --hafta, --bos)');
    const urgency = picked.length ? URGENCY_FLAGS[picked[0]] : 'week';
    const approved = Boolean(flags.approved || flags.onayli);
    const t = addTask(home, { project: pos[0], text: pos.slice(1).join(' '), urgency, approved });
    process.stdout.write(`task added: #${t.id} [${t.urgency}]${t.approved ? ' [approved]' : ''} ${t.text}\n`);
    return 0;
  }
  if (sub === 'list' || sub === 'liste') {
    const projects = readProjects(home);
    const tasks = readTasks(home);
    const name = (t) => projects.find((p) => String(p.id) === String(t.projectId))?.name ?? '?';
    const ranked = rankTasks(tasks, projects, Date.now());
    if (ranked.length === 0) process.stdout.write('no queued tasks\n');
    ranked.forEach(({ task, score }, i) => {
      process.stdout.write(`${i + 1}. #${task.id}  [${task.urgency}]  ${name(task)}  ${task.text}  (score ${score.toFixed(2)})\n`);
    });
    if (flags.all || flags.hepsi) {
      for (const t of tasks.filter((x) => x.status !== 'queued')) {
        process.stdout.write(`-  #${t.id}  [${t.urgency}]  ${name(t)}  ${t.text}  (${STATUS_TEXT[t.status] ?? t.status})\n`);
      }
    }
    return 0;
  }
  if (['done', 'bitti', 'skip', 'atla'].includes(sub)) {
    const done = sub === 'done' || sub === 'bitti';
    if (pos.length < 1) return fail(`usage: kadans task ${done ? 'done' : 'skip'} <id>`);
    const t = updateTask(
      home,
      pos[0],
      () => (done ? { status: 'done', doneAt: Date.now() } : { status: 'skipped' }),
      (x) => {
        if (x.status === 'done' || x.status === 'skipped') throw new Error(`task #${x.id} is already ${STATUS_TEXT[x.status]}`);
      },
    );
    process.stdout.write(`task #${t.id} ${done ? 'done' : 'skipped'}: ${t.text}\n`);
    if (done) notify(loadConfig(home), 'Kadans: task done', `#${t.id} ${t.text}`);
    return 0;
  }
  if (sub === 'approve' || sub === 'onayla') {
    if (pos.length < 1) return fail('usage: kadans approve <id>');
    const t = updateTask(home, pos[0], { approved: true });
    process.stdout.write(`task #${t.id} approved: ${t.text}\n`);
    return 0;
  }
  if (sub === 'urgent' || sub === 'acil') {
    if (pos.length < 1) return fail('usage: kadans task urgent <id>');
    const t = updateTask(home, pos[0], { urgency: 'urgent' });
    process.stdout.write(`task #${t.id} marked urgent: ${t.text}\n`);
    return 0;
  }
  if ((sub === 'start' || sub === 'basla' || sub === 'başla') && !flags.session) {
    if (pos.length < 1) return fail('usage: kadans task start <id> [--dry-run]');
    return startCmd(home, pos[0], Boolean(flags['dry-run']), env);
  }
  if (sub === 'start' || sub === 'basla' || sub === 'başla') {
    if (pos.length < 1) return fail('usage: kadans task start <id> --session <id>');
    const t = updateTask(
      home,
      pos[0],
      { status: 'running', claimedBy: flags.session || null, startedAt: Date.now() },
      (x) => {
        if (x.status !== 'queued') throw new Error(`task #${x.id} is not queued (${STATUS_TEXT[x.status] ?? x.status})`);
      },
    );
    process.stdout.write(`task #${t.id} started: ${t.text}\n`);
    return 0;
  }
  return fail('task commands: add (ekle), list (liste), done (bitti), skip (atla), start (basla), urgent (acil), approve (onayla)');
}

// A new session for an approved task. Orca calls get 30 s (launch waits for the terminal).
function startCmd(home, ref, dryRun, env) {
  const run = orcaRunner(env, 30_000);
  const ctx = checkStartable(home, ref);
  const plan = startPlan(home, ctx, { run });
  if (dryRun) {
    process.stdout.write(`dry run: nothing changed\n${describePlan(plan, ctx.task)}`);
    return 0;
  }
  const r = startTask(home, ctx.task.id, plan, { run });
  process.stdout.write(`task #${r.task.id} started: ${r.how}\n`);
  return 0;
}

// Hooks: any error means "no opinion" (allow), exit 0, nothing on stdout.
async function hookCmd(kind, env) {
  let out = '';
  setLockWait(HOOK_LOCK_WAIT_MS); // every lock in this hook process: give up after 2 s rather than 10 s
  try {
    const raw = readFileSync(0, 'utf8');
    if (kind === 'stop') out = runStop(raw, env);
    else if (kind === 'pretool') out = runPretool(raw, env);
    else if (kind === 'pace-pre') out = await runPacePre(raw, env);
    else if (kind === 'pace-post') out = await runPacePost(raw, env);
    else if (kind === 'event') {
      try {
        clearAutoPause(raw, env); // the owner typed: lift a pause set by auto-pace
      } catch {
        // never in the way of event logging
      }
      runEvent(raw, env, { home: kadansHome(env) }); // prints nothing, ever
    }
  } catch {
    out = '';
  }
  if (out) process.stdout.write(`${out}\n`);
  return 0;
}

// Owner: slow / pause / resume one own Claude session. Orca-only rows and other accounts are refused (no Kadans hooks).
function paceCmd(home, pos, flags, env) {
  if (pos.length < 2 || !MODE_OF[pos[1]] || pos[1] === 'paused') return fail('usage: kadans agent pace <id> slow|pause|none [--until reset|30m]');
  const { agent, why } = findAgent(listAgents(home, { run: orcaRunner(env), claudeDirs: [configDir(env)] }), pos[0]);
  if (!agent) return fail(why);
  if (agent.source !== 'claude') return fail(`not paced: ${agent.id} has no Claude session id here (Orca-only row, no Kadans hooks)`);
  const own = ownKey();
  if (agent.account && agent.account !== own) return fail(`not paced: ${agent.id} runs on another account; Kadans never paces it`);
  if (pos[1] === 'none') {
    setPace(home, agent.id, 'none');
    process.stdout.write(`${agent.id}: resumed\n`);
    return 0;
  }
  const now = Date.now();
  const ov = overall(readSamples(home, own), now, loadConfig(home));
  const until = parseUntil(flags.until, now, windowOf(ov));
  const e = setPace(home, agent.id, pos[1], { until, now });
  const till = e.until ? ` until ${new Date(e.until).toTimeString().slice(0, 5)}` : ' until resumed (no reset time known)';
  process.stdout.write(`${agent.id}: ${e.mode === 'slow' ? 'slowed' : 'paused'}${till}\n`);
  return 0;
}

function autopaceCmd(args, env) {
  const v = args[0];
  if (v !== 'on' && v !== 'off') return fail('usage: kadans autopace on|off');
  setAutopace(kadansHome(env), v === 'on');
  process.stdout.write(`auto-pace ${v}\n`);
  return 0;
}

// `kadans agents`: one `orca worktree ps` (1 s timeout) runs beside Kadans' own work. `--brief`: {"working","needsYou","t"} for
// the menu bar, from the latest full list when it is at most 2 s old, else counted now without reading any transcript.
async function agentsCmd(args, env) {
  const { flags } = parseArgs(args);
  const all = Boolean(flags.all || flags.hepsi);
  const home = kadansHome(env);
  const opts = { env, run: orcaRunner(env, ORCA_TIMEOUT_MS), all, claudeDirs: [configDir(env)] };
  if (flags.brief) {
    const now = Date.now();
    const brief = readBrief(home, now) ?? briefOf(await listAgentsAsync(home, { ...opts, now, all: false, scan: false }), now);
    process.stdout.write(`${JSON.stringify(brief)}\n`);
    return 0;
  }
  const agents = await listAgentsAsync(home, opts);
  process.stdout.write(flags.json ? `${JSON.stringify(agents, null, 2)}\n` : renderAgents(agents, Date.now(), { all }));
  return 0;
}

function agentCmd(sub, args, env) {
  const { pos, flags } = parseArgs(args);
  const home = kadansHome(env);
  if (sub === 'title') {
    if (pos.length < 1) return fail('usage: kadans agent title <id> "<text>"');
    const { agent, why } = findAgent(listAgents(home, { run: orcaRunner(env), all: true, claudeDirs: [configDir(env)] }), pos[0]);
    if (!agent) return fail(why);
    const t = setTitle(home, agent.id, pos.slice(1).join(' '));
    process.stdout.write(t ? `${agent.id}: title set: ${t}\n` : `${agent.id}: title cleared\n`);
    return 0;
  }
  if (sub === 'replace') {
    if (pos.length < 2) return fail('usage: kadans agent replace <agentId> <taskId> [--dry-run]');
    const run = orcaRunner(env);
    const launchRun = orcaRunner(env, 30_000);
    const r = replaceAgent({
      found: findAgent(listAgents(home, { run, claudeDirs: [configDir(env)] }), pos[0]),
      check: () => checkStartable(home, pos[1]),
      canStop: (a) => stopAgent(a, { run, dryRun: true }),
      stop: (a) => stopAgent(a, { run }),
      plan: (ctx) => startPlan(home, ctx, { run: launchRun }),
      start: (ctx, plan) => startTask(home, ctx.task.id, plan, { run: launchRun }),
      dryRun: Boolean(flags['dry-run']),
    });
    if (!r.ok) return fail(`not replaced: ${r.why}`);
    if (r.dryRun) process.stdout.write(`dry run: nothing changed\n${r.stop}\n${describePlan(r.plan, r.ctx.task)}`);
    else process.stdout.write(`${pos[0]}: ${r.stop}\ntask #${r.task.id} started: ${r.how}\n`);
    return 0;
  }
  if (sub === 'pace') return paceCmd(home, pos, flags, env);
  if (sub === 'compact') {
    if (pos.length < 1) return fail('usage: kadans agent compact <id> [--dry-run]');
    const run = orcaRunner(env);
    const { agent, why } = findAgent(listAgents(home, { run, all: true, claudeDirs: [configDir(env)] }), pos[0]);
    if (!agent) return fail(why);
    const dryRun = Boolean(flags['dry-run']);
    const r = compactAgent(agent, { run, dryRun });
    if (!r.ok) return fail(`not compacted: ${r.why}`);
    process.stdout.write(dryRun ? `dry run: nothing sent
${agent.id}: ${r.how}
` : `${agent.id}: ${r.how}
`);
    return 0;
  }
  if (sub !== 'stop' || pos.length < 1) return fail('usage: kadans agent stop|title|replace|pace|compact <id> ...');
  const run = orcaRunner(env);
  const { agent, why } = findAgent(listAgents(kadansHome(env), { run, claudeDirs: [configDir(env)] }), pos[0]);
  if (!agent) return fail(why);
  const r = stopAgent(agent, { run });
  if (!r.ok) return fail(`not stopped: ${r.why}`);
  process.stdout.write(`${agent.id}: ${r.how}\n`);
  return 0;
}

function installCmd(kind, args, env) {
  const { flags } = parseArgs(args);
  const apply = Boolean(flags.apply || flags.uygula);
  const bin = fileURLToPath(import.meta.url);
  const home = kadansHome(env);
  const r = plan({ kind, cfgDir: configDir(env), home, bin, apply });
  if (flags.json) {
    // The app shows the summaries only; the diff (with paths) stays in the plain preview.
    const { file, changed, changes, backup } = r;
    process.stdout.write(`${JSON.stringify({ file, changed, changes, backup, command: kadansCommand(bin) }, null, 2)}\n`);
    return 0;
  }
  if (kind === 'uninstall') {
    const sch = schedulePlan('unschedule', { bin });
    const there = existsSync(sch.file);
    process.stdout.write(`note: the kickoff schedule (launchd) is separate${there ? `; found ${sch.file}` : ' (not found)'}. Remove it with: kadans kickoff unschedule --apply\n`);
  }
  if (!r.changed) {
    process.stdout.write(`no changes: ${r.file}\n`);
    return 0;
  }
  process.stdout.write(`${r.file}\n${r.diff}\n`);
  for (const c of r.changes) process.stdout.write(`${c.kind === 'add' ? 'adds' : 'removes'} ${c.event} ${c.hook}: ${c.summary}\n`);
  if (kind === 'install') {
    const cfg = loadConfig(home);
    process.stdout.write(`note: kadans statusline chains the previous script: ${cfg.chain} (config.json "chain")\n`);
    const old = r.oldStatusLine?.command;
    if (old && expandHome(old.trim()) !== expandHome(cfg.chain)) {
      process.stdout.write(`WARNING: the old statusLine "${old}" differs from the chained script "${cfg.chain}"; point config.json "chain" at the old script, otherwise the old script (Orca forwarding) will not run.\n`);
    }
  }
  if (apply) process.stdout.write(`written${r.backup ? `; backup: ${r.backup}` : ''}\n`);
  else process.stdout.write(`preview: nothing written. To apply: kadans ${kind} --apply\n`);
  return 0;
}

function configCmd(sub, args, env) {
  const home = kadansHome(env);
  if (sub === 'get') {
    const v = configView(home);
    if (parseArgs(args).flags.json) process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
    else {
      for (const [k, x] of Object.entries(v)) if (k !== 'version') process.stdout.write(`${k}: ${JSON.stringify(x)}\n`);
    }
    return 0;
  }
  if (sub === 'set' && args.length === 2) {
    const value = setSetting(home, args[0], args[1]);
    process.stdout.write(`${args[0]} = ${JSON.stringify(value)}\n`);
    return 0;
  }
  return fail('usage: kadans config get [--json] | kadans config set <key> <value>');
}

// `kadans kickoff [--dry-run]` and `kadans kickoff schedule|unschedule [--apply]` (lib/kickoff.mjs).
function kickoffCmd(args, env) {
  const { pos, flags } = parseArgs(args);
  const home = kadansHome(env);
  const sub = pos[0];
  if (sub === 'schedule' || sub === 'unschedule') {
    const p = schedulePlan(sub, { env, bin: fileURLToPath(import.meta.url) });
    if (!flags.apply) {
      process.stdout.write(`${describeSchedule(p)}preview: nothing written. To apply: kadans kickoff ${sub} --apply\n`);
      return 0;
    }
    process.stdout.write(`${applySchedule(p)}\n`);
    return 0;
  }
  if (sub !== undefined) return fail('usage: kadans kickoff [--dry-run] | kadans kickoff schedule|unschedule [--apply]');
  const cfg = loadConfig(home);
  const samples = () => readSamples(home, ownKey());
  const now = Date.now();
  if (flags['dry-run']) {
    const d = decide({ cfg, samples: samples(), state: readKickoffState(home), now });
    const unset = Object.keys(env).filter((k) => !(k in kickoffEnv(env)));
    process.stdout.write(`${d.go ? 'would run' : `would not run: ${d.why}`}\n`);
    if (d.go) process.stdout.write(`  why: ${d.why}\n`);
    process.stdout.write(`  argv: ${JSON.stringify(KICKOFF_ARGV)}\n  in an empty temp folder, timeout 90 s, CLAUDE_CONFIG_DIR unset (own account)` +
      `${unset.length ? `; unsets ${unset.join(', ')}` : ''}\npreview: nothing run, nothing written\n`);
    return 0;
  }
  const r = runKickoff(home, cfg, { env, samples, now });
  if (r.code === 'off') return fail(`refused: ${r.why}`);
  process.stdout.write(`${r.why}\n`);
  return r.ran && !r.ok ? 1 : 0;
}

// `kadans gas tick [--dry-run] [--json]` (lib/autogas.mjs). Own account only (~/.claude), whatever CLAUDE_CONFIG_DIR says.
// The dry run stops after the gates: no orca call, no plan, nothing written. Every gate answer exits 0.
function gasCmd(args, env) {
  const { pos, flags } = parseArgs(args);
  if (pos[0] !== 'tick' || pos.length > 1) return fail('usage: kadans gas tick [--dry-run] [--json]');
  const home = kadansHome(env);
  const own = ownKey();
  const start = (id) => {
    const run = orcaRunner(env, 30_000);
    const ctx = checkStartable(home, id);
    const p = startPlan(home, ctx, { run });
    const r = startTask(home, ctx.task.id, p, { run });
    return { sessionId: p.sessionId, how: r.how };
  };
  const r = runTick(home, loadConfig(home), {
    own,
    samples: () => readSamples(home, own),
    dryRun: Boolean(flags['dry-run']),
    start,
  });
  process.stdout.write(flags.json ? `${JSON.stringify(tickJson(r))}\n` : `${renderTick(r)}\n`);
  return 0;
}

// `kadans usage fetch [--json]`: the own account only; prints percentages, never anything from the Keychain.
async function usageCmd(args, env) {
  const { pos, flags } = parseArgs(args);
  if (pos[0] !== 'fetch') return fail('usage: kadans usage fetch [--json]');
  const home = kadansHome(env);
  const r = await fetchUsage(home, { cfg: loadConfig(home) });
  process.stdout.write(flags.json ? `${JSON.stringify(usageJson(r))}\n` : `${renderUsage(r)}\n`);
  return r.ok || ['off', 'too_soon', 'backoff', 'no_token', 'busy'].includes(r.code) ? 0 : 1;
}

function main(argv, env = process.env) {
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === 'statusline') {
    const line = statusline(env);
    if (line) process.stdout.write(`${line}\n`);
    return 0;
  }
  if (cmd === 'status') return status(argv.slice(1), env);
  if (cmd === 'hook') return hookCmd(argv[1], env);
  if (cmd === 'usage') return usageCmd(argv.slice(1), env);
  try {
    if (cmd === 'project' || cmd === 'proje') return projectCmd(argv[1], argv.slice(2), env);
    if (cmd === 'task' || cmd === 'gorev' || cmd === 'görev') return taskCmd(argv[1], argv.slice(2), env);
    if (cmd === 'ekle') return taskCmd('add', argv.slice(1), env);
    if (cmd === 'liste') return taskCmd('list', argv.slice(1), env);
    if (cmd === 'approve' || cmd === 'onayla') return taskCmd('approve', argv.slice(1), env);
    if (cmd === 'agents') return agentsCmd(argv.slice(1), env).catch((e) => fail(e.message));
    if (cmd === 'agent') return agentCmd(argv[1], argv.slice(2), env);
    if (cmd === 'install' || cmd === 'uninstall') return installCmd(cmd, argv.slice(1), env);
    if (cmd === 'autopace') return autopaceCmd(argv.slice(1), env);
    if (cmd === 'config') return configCmd(argv[1], argv.slice(2), env);
    if (cmd === 'kickoff') return kickoffCmd(argv.slice(1), env);
    if (cmd === 'gas') return gasCmd(argv.slice(1), env);
  } catch (e) {
    return fail(e.message);
  }
  process.stderr.write(`kadans: unknown command "${cmd}"\n\n${HELP}`);
  return 2;
}

Promise.resolve(main(process.argv.slice(2))).then((code) => {
  process.exitCode = code;
});
