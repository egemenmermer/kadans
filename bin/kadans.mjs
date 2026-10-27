#!/usr/bin/env node
// kadans: pace Claude Code usage limits and list running agents. Commands: see HELP.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountKey, actionable, appendSample, configDir, kadansHome, listAccounts, readSamples, sampleFromPayload } from '../lib/samples.mjs';
import { NAME as CODEX_NAME, codexEnabled, isCodexSamples, renderSync, syncCodex, syncJson } from '../lib/codex.mjs';
import { loadConfig, overall } from '../lib/pace.mjs';
import { renderAge, renderLine } from '../lib/render.mjs';
import { HOOK_LOCK_WAIT_MS, IMPORTANCE, addProject, addTask, readProjects, readTasks, setLockWait, updateTask } from '../lib/store.mjs';
import { rankTasks } from '../lib/pick.mjs';
import { notifyBrakeOnce, runPretool, runStop } from '../lib/hooks.mjs';
import { runLean } from '../lib/lean.mjs';
import { notify } from '../lib/notify.mjs';
import { kadansCommand, plan } from '../lib/install.mjs';
import { chainTarget, joinLines, runChained, savedStatusLine, shortCommand, userCommand } from '../lib/chain.mjs';
import { NO_TOOLCHAIN, WIN_APP_LINE, appRoot, applySetup, appsDir, currentBin, hasToolchain, installedVersion, isNpxCache, packageVersion, stableBin, versionCmp } from '../lib/setup.mjs';
import { configView, setSetting } from '../lib/config.mjs';
import { isRemoteId, refreshRemote, remoteCaller, remoteCompact, remoteSend, remoteStop, triggerRemote } from '../lib/remote.mjs';
import { SEND_MAX, messageText } from '../lib/text.mjs';
import { ERR as COMPUTER_ERR, addComputer, listComputers, readStdin, removeComputer } from '../lib/computers.mjs';
import { ORCA_TIMEOUT_MS, briefOf, compactAgent, findAgent, listAgents, listAgentsAsync, orcaRunner, readBrief, readCache, renderAgents, runEvent, sendAgent, stopAgent } from '../lib/agents.mjs';
import { refresh as refreshTitles, triggerRefresh } from '../lib/smart-titles.mjs';
import { setTitle } from '../lib/titles.mjs';
import { ORDER_MAX, setOrder } from '../lib/order.mjs';
import { MODE_OF, clearAutoPause, ownKey, parseUntil, runPacePost, runPacePre, setAutopace, setPace, windowOf } from '../lib/pace-control.mjs';
import { checkStartable, describePlan, replaceAgent, startPlan, startTask } from '../lib/launch.mjs';
import { MAC_ONLY_NOTE, fetchUsage, readUsageState, renderUsage, usageApiSupported, usageJson } from '../lib/usage-api.mjs';
import { renderTick, runTick, tickJson } from '../lib/autogas.mjs';
import { listDevices, newPairCode, revokeDevice } from '../lib/phone.mjs';
import { DEFAULT_PORT, clearServeInfo, cliRunner, createPhoneServer, pickHost, readServeInfo, writeServeInfo } from '../lib/serve.mjs';
import { stripControl } from '../lib/text.mjs';
import { onPath as findOnPath, isWin as isWinPlatform } from '../lib/platform.mjs';
import { runConnect } from '../lib/connect.mjs';
import { KICKOFF_ARGV, applySchedule, decide, describeSchedule, kickoffEnv, readKickoffState, runKickoff, schedulePlan } from '../lib/kickoff.mjs';

const HELP = `kadans: pace Claude Code usage limits

Usage:
  kadans setup [--yes] [--no-app] [--no-open]   install or update Kadans: copies it to ~/.kadans/app, adds the
                      Claude Code hooks (preview first, asks before writing; --yes: no question) and builds the menu
                      bar app into ~/Applications (--no-app: skip it; --no-open: do not restart it). Run it again to update:
                      npx kadans@latest setup
  kadans statusline   read the status line payload on stdin, record a sample,
                      run your previous status line (its output follows Kadans' line; config.json
                      "chain": a script to run instead, output dropped; "" = none), print the line
  kadans status [--json]   show every recorded account (--json: the panel's data)
  kadans codex sync [--json]   read Codex CLI limits from ~/.codex/sessions (read-only; shown, never acted on)
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
  kadans progress <done>/<total> ["<step>"]   for agents: report progress (does nothing; the agent list reads it
                             from the transcript)
  kadans agent stop <id>     stop one agent (Orca terminal close, else SIGTERM to its pid)
  kadans agent compact <id> [--dry-run]   type /compact into an idle chat's Orca terminal (orca terminal send);
                      refused for working, waiting or ended chats, a chat with unsent text in its input line, and
                      outside Orca (type /compact there yourself)
  kadans agent send <id> [--dry-run] < message   type the message (stdin only, up to 4000 characters) plus Enter
                      into an idle chat's Orca terminal; the same refusals as compact. Never logged or stored
                      Stop, compact and send also take another computer's id (remote:<computer>:...): Kadans looks the
                      agent up on that computer again and acts there through Orca (--environment)
  kadans agent title <id> "<text>"   set the agent's title ("" clears it)
  kadans agent order <id> [<id> ...]   show these agents first, in this order (ended ones drop out)
  kadans agent replace <agentId> <taskId> [--dry-run]   stop the agent, then task start
  kadans agent pace <id> slow|pause|none [--until reset|30m]   slow (wait before each tool call), pause
                      (halt before its next tool) or resume one of your own sessions; default --until reset
  kadans autopace on|off   auto-pace: nudge sessions when usage runs hot, slow them if the brake holds 10 min
  kadans usage fetch [--json]   read your own account's usage (~/.claude) from Claude's usage endpoint and record
                      it as a sample; Keychain item "Claude Code-credentials", never the refresh token; at most
                      once a minute, backs off after errors; off with config usageApi false
  kadans hook stop|pretool|event|pace-pre|pace-post|lean   Claude Code hooks (hook JSON on stdin; never fail)
  kadans config get [--json]           show the settings the app can change
  kadans config set <key> <value>      limits auto|five_hour|five_hour,seven_day, targets.five_hour|targets.seven_day
                      50-100, slack 0-30, warmup.minutes 0-60, warmup.pct 0-50, notify|autopace|usageApi|codex true|false,
                      lang en|tr, accounts.<own key>.gas true|false (your own account only),
                      kickoff.enabled true|false, kickoff.from|kickoff.to HH:MM,
                      compact.soonPct 10-95 (% of the context window) or 101 (Off), compact.nowPct 10-95,
                      compact.idleMin 1-120, autoGas true|false, autoGasMax 1-3, autoGasMinRamGB 0.5-16,
                      phone true|false (the app keeps kadans serve running while true)
  kadans titles refresh [--dry-run] [--json]   name the own account's live chats from their latest prompts
                      (one Haiku call at most; \`kadans agents\` starts it once a minute; config smartTitles)
  kadans kickoff [--dry-run]   start the next 5-hour window with one tiny Haiku message (claude -p, own account),
                      only if kickoff.enabled, inside kickoff.from-kickoff.to, and the window has ended
  kadans kickoff schedule|unschedule [--apply]   preview (or write and load) the launchd job that runs
                      \`kadans kickoff\` every 15 minutes (~/Library/LaunchAgents/dev.kadans.kickoff.plist)
  kadans gas tick [--dry-run] [--json]   use spare quota on its own: start the next approved task in a new session
                      (the task start path) when your own window would end with >= 15% unused and >= 45 min left,
                      or no window runs (then the start opens one); needs accounts.<own key>.gas and autoGas true;
                      caps: autoGasMax auto-started tasks running, 10 min apart, a failed task waits for the next window,
                      autoGasMinRamGB free; --json: {"started": <task id or null>, "why": "<code>"}
  kadans serve [--host <ip>] [--port <n>]   phone control: serve the panel and its API to paired phones
                      (default: this Mac's Tailscale address, else its LAN address, port 7477; never 0.0.0.0);
                      needs config phone true; prints {"url","host","port","pid"}, runs until SIGTERM
  kadans pair [--json]   a one-time pair link for a phone (needs a running serve; valid 10 min, one use)
  kadans devices [--json]   paired phones; kadans devices revoke <id> unpairs one at once
  kadans connect [--name <name>]   on another computer (Windows too): runs \`orca serve\` here and shows the code
                      to paste on your Mac (Kadans › Settings › Computers › Add); Ctrl+C stops it
  kadans computers [--json]   paired computers (Orca environments): name, id, online/stale/offline, agents
  kadans computers add --name <name>   pair one: the code that \`kadans connect\` printed on the other computer
                      comes on stdin only (pbpaste | kadans computers add --name PC); never echoed or stored
  kadans computers remove <id>   unpair one
  kadans install [--apply] [--json]   preview (or write, with backup) settings.json changes
  kadans uninstall [--apply] [--all]   preview (or write, with backup) removing them; --all also removes setup's
                      copy (~/.kadans/app) and ~/Applications/Kadans.app, and asks before deleting your data
  kadans --help       show this help

Environment:
  KADANS_HOME         data and config dir (default ~/.kadans); config in config.json
  CLAUDE_CONFIG_DIR   Claude config dir of the account to record (default ~/.claude)
  KADANS_APPS_DIR     where setup installs Kadans.app (default ~/Applications)
  KADANS_THROTTLE=1   session opt-in for the Stop-hook throttle (also needs accounts.<key>.gas in config)
  KADANS_ALLOW=1      let spawning tools through while the brake is on
  KADANS_ORCA=0       do not ask the orca CLI for its agent terminals (KADANS_ORCA_BIN: path to the orca binary)
`;

function expandHome(p) {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
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
  let theirs = '';
  try {
    theirs = runChained(chainTarget(cfg, home), raw, { env });
  } catch {
    // the chained script must never break the status line
  }
  try {
    const samples = readSamples(home, key);
    if (samples.length === 0) return theirs;
    const res = overall(samples, now, cfg);
    try {
      if (!lockBusy) notifyBrakeOnce(home, cfg, key, res); // it needs the lock too: skip rather than wait again
    } catch {
      // notifications must never break the status line
    }
    return joinLines(renderLine(res, now, cfg.lang), theirs);
  } catch {
    return theirs;
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
  return findOnPath(name, env.PATH ?? env.Path, { pathExt: env.PATHEXT }) !== null;
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
      enabled: cfg.usageApi === true && usageApiSupported(),
      lastOk: Number(ua.lastOk) || null,
      lastError: typeof ua.lastError === 'string' ? ua.lastError : null,
      nextAt: Number(ua.nextAt) > now ? Number(ua.nextAt) : null,
    };
    // The own account is always the main ~/.claude, even when CLAUDE_CONFIG_DIR points at another profile.
    const ownKey = accountKey(join(homedir(), '.claude'));
    if (codexEnabled(cfg, env)) syncCodex(home, env, { cfg, now }); // bounded; never throws
    for (const key of listAccounts(home)) {
      const samples = readSamples(home, key);
      if (samples.length === 0) continue;
      // Codex (lib/codex.mjs): shown with its own windows, never acted on (no gas, brake, feed or pace).
      const codex = isCodexSamples(samples);
      if (codex && cfg.codex === false) continue;
      const res = overall(samples, now, codex ? { ...cfg, limits: 'auto' } : cfg);
      const own = !codex && key === ownKey;
      const label = codex ? CODEX_NAME : own ? 'Your account' : 'Other account';
      const lastSrc = samples[samples.length - 1].source;
      out.accounts.push({
        key,
        kind: codex ? 'codex' : 'claude',
        name: label,
        label,
        configDir: own ? '~/.claude' : null,
        own,
        acts: !codex, // false: Kadans shows this account's states but never acts on them
        ...(codex && samples[samples.length - 1].plan ? { plan: samples[samples.length - 1].plan } : {}),
        gas: own && cfg.accounts[key]?.gas === true, // other accounts never throttle
        lastSample: samples[samples.length - 1].t,
        fresh: now - samples[samples.length - 1].t <= FRESH_MS,
        lastSource: lastSrc === 'api' || lastSrc === 'codex' ? lastSrc : 'statusline',
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
  if (codexEnabled(cfg, env)) syncCodex(home, env, { cfg, now });
  if (process.platform === 'win32') process.stdout.write(`${MAC_ONLY_NOTE}; the status line still records usage\n`);
  const accounts = listAccounts(home);
  if (accounts.length === 0) {
    process.stdout.write('no accounts recorded yet\n');
    return 0;
  }
  for (const key of accounts) {
    const samples = readSamples(home, key);
    if (samples.length === 0) continue;
    const codex = isCodexSamples(samples);
    if (codex && cfg.codex === false) continue;
    const res = overall(samples, now, codex ? { ...cfg, limits: 'auto' } : cfg);
    const age = renderAge(now - samples[samples.length - 1].t, cfg.lang);
    process.stdout.write(`${codex ? `${key} ${CODEX_NAME}` : key}  ${renderLine(res, now, cfg.lang)}  (${age})\n`);
  }
  return 0;
}

// Splits argv into positional words and --flags (--name value or --name=value; known switches take no value).
const SWITCHES = new Set(['urgent', 'week', 'idle', 'acil', 'hafta', 'bos', 'all', 'hepsi', 'approved', 'onayli', 'apply', 'uygula', 'json', 'dry-run', 'force-dev', 'yes', 'no-app', 'no-open']);
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
// Lean mode rides on the hooks that already run (one node process per event): its additionalContext is appended to
// whatever the pace hook said, and a pace decision (permissionDecision etc.) is kept as it is.
function withLean(out, raw, env) {
  let lean = '';
  try {
    lean = runLean(raw, env);
  } catch {
    return out;
  }
  if (!lean) return out;
  if (!out) return lean;
  try {
    const a = JSON.parse(out);
    const b = JSON.parse(lean);
    const ha = a.hookSpecificOutput ?? (a.hookSpecificOutput = { hookEventName: b.hookSpecificOutput?.hookEventName });
    const extra = b.hookSpecificOutput?.additionalContext;
    if (extra) ha.additionalContext = ha.additionalContext ? `${ha.additionalContext}\n${extra}` : extra;
    return JSON.stringify(a);
  } catch {
    return out;
  }
}

async function hookCmd(kind, env) {
  let out = '';
  setLockWait(HOOK_LOCK_WAIT_MS); // every lock in this hook process: give up after 2 s rather than 10 s
  try {
    const raw = readFileSync(0, 'utf8');
    // Kadans' own Haiku runs (smart titles) set KADANS_INTERNAL=1: no hook of ours acts on them or records them.
    if (env.KADANS_INTERNAL === '1') return 0;
    if (kind === 'stop') out = runStop(raw, env);
    else if (kind === 'pretool') out = runPretool(raw, env);
    else if (kind === 'lean') out = runLean(raw, env);
    else if (kind === 'pace-pre') out = withLean(await runPacePre(raw, env), raw, env);
    else if (kind === 'pace-post') out = withLean(await runPacePost(raw, env), raw, env);
    else if (kind === 'event') {
      try {
        clearAutoPause(raw, env); // the owner typed: lift a pause set by auto-pace
      } catch {
        // never in the way of event logging
      }
      runEvent(raw, env, { home: kadansHome(env) }); // logs only
      out = withLean('', raw, env); // SessionStart: the lean brief (nothing for other events)
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
  const ov = overall(actionable(readSamples(home, own)), now, loadConfig(home));
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
  // Smart titles (lib/smart-titles.mjs): a detached `kadans titles refresh`, at most once a minute, never waited for.
  const trigger = () => triggerRefresh(home, { env, cfg: loadConfig(home) });
  // k48: other computers' agents come from the cache; a detached `kadans remote refresh` updates it when due.
  const remote = remoteCaller(env) ? (now) => triggerRemote(home, { env, now }) : null;
  const agents = await listAgentsAsync(home, { ...opts, trigger, remote }); // --brief stays local
  process.stdout.write(flags.json ? `${JSON.stringify(agents, null, 2)}\n` : renderAgents(agents, Date.now(), { all }));
  return 0;
}

// k48: stop / compact / send on another computer's agent (`remote:<machine>:<paneKey>`, exact ids only): a fresh lookup on
// that machine through lib/remote.mjs, never the local list or pane map.
async function remoteAgentCmd(sub, id, home, env, { dryRun = false, text = null } = {}) {
  const call = remoteCaller(env);
  const r = sub === 'stop' ? await remoteStop(home, id, { call, dryRun })
    : sub === 'compact' ? await remoteCompact(home, id, { call, dryRun })
      : await remoteSend(home, id, text, { call, dryRun });
  const verb = { stop: 'stopped', compact: 'compacted', send: 'sent' }[sub];
  if (!r.ok) return fail(`not ${verb}: ${r.why}`);
  process.stdout.write(`${dryRun ? 'dry run: nothing changed\n' : ''}${id}: ${r.how}\n`);
  return 0;
}

const SEND_USAGE = 'usage: kadans agent send <id> [--dry-run] (the message comes on stdin)';
const SEND_BAD_TEXT = `not sent: the message must be 1 to ${SEND_MAX} printable characters (newlines allowed), not starting with "-"`;

// `kadans agent send <id>`: the message on stdin only (never an argument: argv shows in `ps` and shell history), typed into
// the agent's terminal followed by Enter. Never logged or stored; errors are fixed sentences that never repeat the text.
async function agentSendCmd(pos, flags, env) {
  if (pos.length !== 1) return fail(SEND_USAGE);
  const text = messageText(readStdin(0, process.stdin.isTTY, 4 * SEND_MAX + 64));
  if (text === null) return fail(SEND_BAD_TEXT);
  const home = kadansHome(env);
  const dryRun = Boolean(flags['dry-run']);
  if (isRemoteId(pos[0])) return remoteAgentCmd('send', pos[0], home, env, { dryRun, text });
  const run = orcaRunner(env);
  const { agent, why } = findAgent(listAgents(home, { run, all: true, claudeDirs: [configDir(env)] }), pos[0]);
  if (!agent) return fail(`not sent: ${why}`);
  const r = sendAgent(agent, text, { run, dryRun });
  if (!r.ok) return fail(`not sent: ${r.why}`);
  process.stdout.write(`${dryRun ? 'dry run: nothing sent\n' : ''}${agent.id}: ${r.how}\n`);
  return 0;
}

function agentCmd(sub, args, env) {
  const { pos, flags } = parseArgs(args);
  const home = kadansHome(env);
  if (sub === 'send') return agentSendCmd(pos, flags, env).catch(() => fail('not sent: something went wrong; nothing was logged'));
  if ((sub === 'stop' || sub === 'compact') && isRemoteId(pos[0])) {
    return remoteAgentCmd(sub, pos[0], home, env, { dryRun: Boolean(flags['dry-run']) }).catch(() => fail(`not done: ${sub} on another computer failed`));
  }
  if (sub === 'title') {
    if (pos.length < 1) return fail('usage: kadans agent title <id> "<text>"');
    const { agent, why } = findAgent(listAgents(home, { run: orcaRunner(env), all: true, claudeDirs: [configDir(env)] }), pos[0]);
    if (!agent) return fail(why);
    const t = setTitle(home, agent.id, pos.slice(1).join(' '));
    process.stdout.write(t ? `${agent.id}: title set: ${t}\n` : `${agent.id}: title cleared\n`);
    return 0;
  }
  if (sub === 'order') {
    // The owner's row order (drag to reorder in the panel): these ids first, in this order; every id must be listed now.
    if (pos.length < 1 || pos.length > ORDER_MAX) return fail(`usage: kadans agent order <id> [<id> ...] (1 to ${ORDER_MAX} ids)`);
    const list = listAgents(home, { run: orcaRunner(env), claudeDirs: [configDir(env)] });
    const ids = [];
    for (const ref of pos) {
      const { agent, why } = findAgent(list, ref);
      if (!agent) return fail(`order not saved: ${why}`);
      ids.push(agent.id);
    }
    const stored = setOrder(home, ids);
    process.stdout.write(`order saved: ${stored.length} agent${stored.length === 1 ? '' : 's'} first\n`);
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
  if (sub !== 'stop' || pos.length < 1) return fail('usage: kadans agent stop|title|order|replace|pace|compact|send <id> ...');
  const run = orcaRunner(env);
  const { agent, why } = findAgent(listAgents(kadansHome(env), { run, claudeDirs: [configDir(env)] }), pos[0]);
  if (!agent) return fail(why);
  const r = stopAgent(agent, { run });
  if (!r.ok) return fail(`not stopped: ${r.why}`);
  process.stdout.write(`${agent.id}: ${r.how}\n`);
  return 0;
}

// The preview lines shared by install and setup.
function printPlan(r, kind, home) {
  if (!r.changed) {
    process.stdout.write(`no changes: ${r.file}\n`);
    return;
  }
  process.stdout.write(`${r.file}\n${r.diff}\n`);
  for (const c of r.changes) process.stdout.write(`${c.kind === 'add' ? 'adds' : 'removes'} ${c.event} ${c.hook}: ${c.summary}\n`);
  if (r.repointed) process.stdout.write(`moves ${r.repointed} existing Kadans hook${r.repointed === 1 ? '' : 's'} to the new path\n`);
  if (kind === 'install') {
    const cfg = loadConfig(home);
    const old = userCommand(r.oldStatusLine) ?? userCommand(savedStatusLine(home));
    if (typeof cfg.chain === 'string' && cfg.chain) {
      process.stdout.write(`note: kadans statusline also runs config.json "chain": ${cfg.chain} (its output is not shown)\n`);
      if (old && expandHome(old.trim()) !== expandHome(cfg.chain)) {
        process.stdout.write(`WARNING: your status line '${shortCommand(old)}' does not run: config.json "chain" runs "${cfg.chain}" instead. Remove "chain" from config.json to keep your own line.\n`);
      }
    } else if (cfg.chain === null && old) {
      process.stdout.write(`Your status line '${shortCommand(old)}' keeps running inside Kadans' line.\n`);
    }
  }
}

const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

// "<question> [y/N]" on a terminal; anything but y/yes is no.
async function ask(question) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

async function installCmd(kind, args, env) {
  const { flags } = parseArgs(args);
  const apply = Boolean(flags.apply || flags.uygula);
  const home = kadansHome(env);
  const bin = stableBin(fileURLToPath(import.meta.url), home);
  if (kind === 'install' && apply && isNpxCache(bin)) {
    return fail("this copy runs from npx's cache, which npm cleans; hooks pointing here would break. Run instead: npx kadans@latest setup");
  }
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
  printPlan(r, kind, home);
  if (r.changed) {
    if (apply) process.stdout.write(`written${r.backup ? `; backup: ${r.backup}` : ''}\n`);
    else process.stdout.write(`preview: nothing written. To apply: kadans ${kind} --apply${flags.all ? ' --all' : ''}\n`);
  }
  if (kind === 'uninstall') return removeFiles(home, env, apply, Boolean(flags.all));
  return 0;
}

// uninstall: setup's copy (<home>/app) and Kadans.app go only with --all --apply; the data store only after a yes on
// a terminal. Without --all: say how.
async function removeFiles(home, env, apply, all) {
  const runtime = appRoot(home);
  const app = join(appsDir(env), 'Kadans.app');
  const found = [runtime, app].filter((p) => existsSync(p));
  if (!all) {
    if (found.length) process.stdout.write(`note: also installed by setup: ${found.join(', ')}. Remove with: kadans uninstall --apply --all (asks before deleting your data in ${home})\n`);
    return 0;
  }
  if (!apply) {
    process.stdout.write(`--all would also remove: ${found.length ? found.join(', ') : '(nothing found)'}; it asks before deleting your data in ${home}\n`);
    return 0;
  }
  for (const p of found) {
    rmSync(p, { recursive: true, force: true });
    process.stdout.write(`removed ${p}\n`);
  }
  if (found.includes(app)) process.stdout.write('If Kadans is still in the menu bar, quit it there: its files are gone.\n');
  if (!existsSync(home)) return 0;
  if (interactive() && (await ask(`Also delete your Kadans data (usage samples, tasks, settings) in ${home}?`))) {
    rmSync(home, { recursive: true, force: true });
    process.stdout.write(`removed ${home}\n`);
  } else {
    process.stdout.write(`kept your data in ${home}. To delete it too: rm -rf '${home.replace(/'/g, "'\\''")}'\n`);
  }
  return 0;
}

// `kadans setup`: see lib/setup.mjs. Preview, ask (or --yes), then copy, hooks, app, restart, summary.
async function setupCmd(args, env, platform = process.platform) {
  const { flags } = parseArgs(args);
  const home = kadansHome(env);
  const version = packageVersion();
  const had = installedVersion(home);
  const bin = currentBin(home);
  const cfgDir = configDir(env);
  const r = plan({ kind: 'install', cfgDir, home, bin, repoint: true, platform });
  const win = isWinPlatform(platform);
  const wantApp = !flags['no-app'];
  const toolchain = wantApp && !win && hasToolchain(env);
  const apps = appsDir(env);

  const step = !had ? `copies Kadans ${version} to ${appRoot(home)}/${version}`
    : had === version ? `refreshes Kadans ${version} in ${appRoot(home)}/${version}`
      : `updates Kadans ${had} -> ${version}${versionCmp(version, had) < 0 ? ' (older than the installed one)' : ''} in ${appRoot(home)}/${version}`;
  process.stdout.write(`Kadans setup\n\n1. ${step}; ${appRoot(home)}/current points at it\n\n2. Claude Code hooks, run from ${bin}:\n`);
  printPlan(r, 'install', home);
  process.stdout.write(`\n3. menu bar app: ${win ? WIN_APP_LINE : !wantApp ? 'skipped (--no-app)' : toolchain ? `builds and installs ${join(apps, 'Kadans.app')}` : NO_TOOLCHAIN}\n\n`);

  if (!flags.yes) {
    if (!interactive()) {
      process.stdout.write('Preview only: nothing changed. To apply: npx kadans@latest setup --yes\n');
      return 0;
    }
    if (!(await ask('Apply?'))) {
      process.stdout.write('Nothing changed.\n');
      return 0;
    }
  }

  const { rt, w, appLine } = applySetup({ home, cfgDir, version, platform, env, wantApp, toolchain, open: !flags['no-open'] });
  const undo = 'npx kadans@latest uninstall --apply --all';
  process.stdout.write(`\nKadans ${version} is set up.\n`
    + `  files:  ${rt.dir}${rt.previous && rt.previous !== version ? ` (was ${rt.previous})` : ''}${rt.removed.length ? `; removed old ${rt.removed.join(', ')}` : ''}\n`
    + `  hooks:  ${w.changed ? `${w.file} updated${w.backup ? `; backup ${w.backup}` : ''}` : `${w.file} already up to date`}\n`
    + `  app:    ${appLine}\n`
    + `  update: npx kadans@latest setup\n`
    + `  undo:   ${undo} (asks before deleting your data)\n`);
  if (win) process.stdout.write('Next: npx kadans connect (pairs this computer with Kadans on your Mac)\n');
  else if (wantApp && !toolchain) process.stdout.write(`${NO_TOOLCHAIN}\n`);
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

// `kadans titles refresh [--dry-run] [--json]` (lib/smart-titles.mjs). Own account only (~/.claude), whatever
// CLAUDE_CONFIG_DIR says. At most one Haiku call per run; the dry run lists the chats it would title (counts only).
function titlesCmd(args, env) {
  const { pos, flags } = parseArgs(args);
  if (pos[0] !== 'refresh' || pos.length > 1) return fail('usage: kadans titles refresh [--dry-run] [--json]');
  const home = kadansHome(env);
  const cfg = loadConfig(home);
  const own = ownKey();
  const dir = join(homedir(), '.claude');
  const now = Date.now();
  const agents = listAgents(home, { claudeDirs: [dir], now, brief: false }); // no Orca here: leave the menu bar brief alone
  const r = refreshTitles(home, { agents, scans: readCache(home), cfg, samples: actionable(readSamples(home, own)), env, now, own, dir, dryRun: Boolean(flags['dry-run']) });
  const short = (id) => (id ? String(id).slice(0, 8) : null);
  const out = { dryRun: Boolean(flags['dry-run']), gate: r.code, why: r.why, pick: short(r.pick), ran: r.ran, ok: r.ok ?? null,
    candidates: r.candidates.map((c) => ({ ...c, id: short(c.id) })), skipped: r.skipped };
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }
  const lines = [`${out.dryRun ? 'dry run: ' : ''}${r.why}`];
  for (const c of out.candidates) lines.push(`  ${c.id}  ${c.project ?? '-'}  prompts ${c.prompts} (+${c.newPrompts})  ${c.why}${c.id === out.pick ? '  <- next' : ''}`);
  const sk = Object.entries(out.skipped).map(([k, n]) => `${k} ${n}`).join(', ');
  if (sk) lines.push(`  skipped: ${sk}`);
  if (out.dryRun) lines.push('preview: nothing run, no titles written');
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

// `kadans kickoff [--dry-run]` and `kadans kickoff schedule|unschedule [--apply]` (lib/kickoff.mjs).
function kickoffCmd(args, env) {
  const { pos, flags } = parseArgs(args);
  const home = kadansHome(env);
  const sub = pos[0];
  if (sub === 'schedule' || sub === 'unschedule') {
    if (process.platform !== 'darwin') return fail('kickoff schedule uses launchd: macOS only for now');
    const p = schedulePlan(sub, { env, bin: stableBin(fileURLToPath(import.meta.url), home) });
    if (!flags.apply) {
      process.stdout.write(`${describeSchedule(p)}preview: nothing written. To apply: kadans kickoff ${sub} --apply\n`);
      return 0;
    }
    process.stdout.write(`${applySchedule(p)}\n`);
    return 0;
  }
  if (sub !== undefined) return fail('usage: kadans kickoff [--dry-run] | kadans kickoff schedule|unschedule [--apply]');
  const cfg = loadConfig(home);
  const samples = () => actionable(readSamples(home, ownKey()));
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
    samples: () => actionable(readSamples(home, own)),
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
  return r.ok || ['off', 'too_soon', 'backoff', 'no_token', 'busy', 'mac_only'].includes(r.code) ? 0 : 1;
}

// `kadans codex sync [--json]`: Codex CLI limits from its session logs, read-only. Percentages only.
function codexCmd(args, env) {
  const { pos, flags } = parseArgs(args);
  if (pos[0] !== 'sync' || pos.length !== 1) return fail('usage: kadans codex sync [--json]');
  const home = kadansHome(env);
  const r = syncCodex(home, env, { cfg: loadConfig(home) });
  process.stdout.write(flags.json ? `${JSON.stringify(syncJson(r))}\n` : `${renderSync(r)}\n`);
  return r.ok || ['off', 'no_codex', 'busy'].includes(r.code) ? 0 : 1;
}

// `kadans serve [--host <ip>] [--port <n>] [--force-dev]` (lib/serve.mjs). --force-dev skips the phone setting (tests).
function serveCmd(args, env) {
  const { pos, flags } = parseArgs(args);
  if (pos.length) return fail('usage: kadans serve [--host <ip>] [--port <n>]');
  const home = kadansHome(env);
  if (!loadConfig(home).phone && !flags['force-dev']) return fail('refused: phone control is off (kadans config set phone true)');
  let host = flags.host;
  if (host === undefined) {
    const p = pickHost(networkInterfaces());
    if (!p) return fail('no Tailscale or LAN address found; pass --host <ip>');
    host = p.host;
  }
  if (typeof host !== 'string' || !isIPv4(host) || host === '0.0.0.0') return fail('--host must be one IPv4 address of this Mac (never 0.0.0.0)');
  const rawPort = flags.port === undefined ? String(DEFAULT_PORT) : String(flags.port);
  const port = Number(rawPort);
  if (!/^\d{1,5}$/.test(rawPort) || port > 65535 || (port !== 0 && port < 1024)) return fail('--port must be 1024-65535');
  if (readServeInfo(home)) return fail(`kadans serve is already running (see ${join(home, 'serve.json')})`);
  const server = createPhoneServer({ home, run: cliRunner({ env }), requirePhone: !flags['force-dev'] });
  return new Promise((done) => {
    server.once('error', (e) => done(fail(`cannot listen on ${host}:${port}: ${e.code ?? e.message}`)));
    server.listen(port, host, () => {
      const a = server.address();
      const info = { url: `http://${host}:${a.port}`, host, port: a.port, pid: process.pid };
      writeServeInfo(home, info);
      process.stdout.write(`${JSON.stringify(info)}\n`);
      const stop = () => {
        server.flushSeen();
        clearServeInfo(home);
        server.close(() => done(0));
        server.closeAllConnections();
      };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
    });
  });
}

// `kadans pair [--json]`: a new one-time code (replaces an unused one). The code appears only inside the URL.
function pairCmd(args, env) {
  const { pos, flags } = parseArgs(args);
  if (pos.length) return fail('usage: kadans pair [--json]');
  const home = kadansHome(env);
  const info = readServeInfo(home);
  if (!info) return fail('kadans serve is not running (turn phone control on in the app, or run kadans serve)');
  const { code, expiresAt } = newPairCode(home);
  const url = `http://${info.host}:${info.port}/#pair=${code}`;
  if (flags.json) process.stdout.write(`${JSON.stringify({ url, expiresAt })}\n`);
  else process.stdout.write(`${url}\nOpen it on your phone within 10 minutes; it works once.\n`);
  return 0;
}

// `kadans devices [--json]` and `kadans devices revoke <id>`.
function devicesCmd(args, env) {
  const { pos, flags } = parseArgs(args);
  const home = kadansHome(env);
  if (pos[0] === 'revoke') {
    if (pos.length !== 2) return fail('usage: kadans devices revoke <id>');
    if (!revokeDevice(home, pos[1])) return fail(`no paired device ${stripControl(pos[1]).slice(0, 40)}`);
    process.stdout.write(`revoked ${pos[1]}\n`);
    return 0;
  }
  if (pos.length) return fail('usage: kadans devices [--json] | kadans devices revoke <id>');
  const list = listDevices(home);
  if (flags.json) process.stdout.write(`${JSON.stringify(list)}\n`);
  else if (!list.length) process.stdout.write('no paired devices\n');
  else for (const d of list) process.stdout.write(`${d.id}  ${d.name}  last seen ${new Date(d.lastSeenAt).toISOString()}\n`);
  return 0;
}

// `kadans computers [--json]`, `kadans computers add --name <name>` (code on stdin), `kadans computers remove <id>` (k41).
// Errors are the fixed strings in lib/computers.mjs; the pairing code never reaches stdout, stderr or a file.
async function computersCmd(args, env) {
  const { pos, flags } = parseArgs(args);
  const home = kadansHome(env);
  const call = remoteCaller(env);
  if (pos[0] === 'add') {
    // the code never comes as an argument (argv shows in `ps`): any extra word or code flag is refused unread
    if (pos.length !== 1 || typeof flags.name !== 'string' || Object.keys(flags).some((f) => f !== 'name' && f !== 'json')) return fail('usage: pbpaste | kadans computers add --name <name> [--json]');
    const code = readStdin();
    if (code === null) return fail(COMPUTER_ERR.tty);
    const r = await addComputer(home, { call, name: flags.name, code });
    if (!r.ok) return fail(r.why);
    process.stdout.write(flags.json ? `${JSON.stringify(r.computer)}\n` : `added ${r.computer.name}\n`);
    return 0;
  }
  if (pos[0] === 'remove' || pos[0] === 'rm') {
    if (pos.length !== 2) return fail('usage: kadans computers remove <id>');
    const r = await removeComputer(home, { call, id: pos[1] });
    if (!r.ok) return fail(r.why);
    process.stdout.write(flags.json ? `${JSON.stringify({ removed: pos[1] })}\n` : `removed ${pos[1]}\n`);
    return 0;
  }
  if (pos.length) return fail('usage: kadans computers [--json] | computers add --name <name> | computers remove <id>');
  const r = await listComputers(home, { call, live: loadConfig(home).remoteAgents !== false });
  if (!r.ok) return fail(r.why);
  if (flags.json) process.stdout.write(`${JSON.stringify(r.list)}\n`);
  else if (!r.list.length) process.stdout.write('no paired computers (on the other computer run: npx kadans connect)\n');
  else {
    for (const c of r.list) {
      const n = c.agents === null ? '' : ` · ${c.agents} ${c.agents === 1 ? 'agent' : 'agents'}`;
      process.stdout.write(`${c.id}  ${c.name} · ${c.status}${n}\n`);
    }
  }
  return 0;
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
  if (cmd === 'progress') return 0; // k35: a no-op on purpose, any arguments; the transcript scan reads the command
  if (cmd === 'status') return status(argv.slice(1), env);
  if (cmd === 'hook') return hookCmd(argv[1], env);
  if (cmd === 'usage') return usageCmd(argv.slice(1), env);
  if (cmd === 'codex') return codexCmd(argv.slice(1), env);
  try {
    if (cmd === 'project' || cmd === 'proje') return projectCmd(argv[1], argv.slice(2), env);
    if (cmd === 'task' || cmd === 'gorev' || cmd === 'görev') return taskCmd(argv[1], argv.slice(2), env);
    if (cmd === 'ekle') return taskCmd('add', argv.slice(1), env);
    if (cmd === 'liste') return taskCmd('list', argv.slice(1), env);
    if (cmd === 'approve' || cmd === 'onayla') return taskCmd('approve', argv.slice(1), env);
    if (cmd === 'agents') return agentsCmd(argv.slice(1), env).catch((e) => fail(e.message));
    if (cmd === 'agent') return agentCmd(argv[1], argv.slice(2), env);
    if (cmd === 'setup') return setupCmd(argv.slice(1), env).catch((e) => fail(e.message));
    if (cmd === 'install' || cmd === 'uninstall') return installCmd(cmd, argv.slice(1), env).catch((e) => fail(e.message));
    if (cmd === 'autopace') return autopaceCmd(argv.slice(1), env);
    if (cmd === 'config') return configCmd(argv[1], argv.slice(2), env);
    if (cmd === 'kickoff') return kickoffCmd(argv.slice(1), env);
    if (cmd === 'titles') return titlesCmd(argv.slice(1), env);
    if (cmd === 'gas') return gasCmd(argv.slice(1), env);
    if (cmd === 'serve') return serveCmd(argv.slice(1), env);
    if (cmd === 'pair') return pairCmd(argv.slice(1), env);
    if (cmd === 'devices') return devicesCmd(argv.slice(1), env);
    if (cmd === 'connect') return runConnect(argv.slice(1), { env });
    if (cmd === 'computers') return computersCmd(argv.slice(1), env).catch(() => fail(COMPUTER_ERR.list));
    // k48, internal: the detached refresher lib/remote.mjs triggerRemote starts. Prints nothing.
    if (cmd === 'remote' && argv[1] === 'refresh' && argv.length === 2) return refreshRemote(kadansHome(env), { call: remoteCaller(env) }).then(() => 0, () => 1);
  } catch (e) {
    return fail(e.message);
  }
  process.stderr.write(`kadans: unknown command "${cmd}"\n\n${HELP}`);
  return 2;
}

// A reader that stops early (`kadans status | head -1`) closes the pipe: end quietly instead of crashing on EPIPE.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });

Promise.resolve(main(process.argv.slice(2))).then((code) => {
  process.exitCode = code;
});
