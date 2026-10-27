// `kadans kickoff`: start the owner's next 5-hour window with one tiny Haiku message, so the clock starts when he wants it
// to. Opt-in (config kickoff.enabled, default off), only inside the kickoff hours, only on the own account (~/.claude,
// CLAUDE_CONFIG_DIR unset), only when that account's window has ended or no sample shows a live one.
// `claude -p` never runs the status line, so a kickoff records no sample: $KADANS_HOME/kickoff.json remembers the last
// run, and a window started by Kadans counts as live for 5 hours (a failed run is retried after RETRY_MS at the earliest).
// `kadans kickoff schedule|unschedule` print (or with --apply write) a launchd user agent that runs it every 15 minutes.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HHMM_RE, MIN, WINDOW_MS, currentWindow } from './pace.mjs';
import { withLock, writeAtomic } from './store.mjs';
import { appendEvent } from './agents.mjs';

export const PROMPT = 'Reply with the single word OK.';
export const KICKOFF_ARGV = ['claude', '-p', PROMPT, '--model', 'haiku'];
export const TIMEOUT_MS = 90_000;
export const RETRY_MS = 60 * MIN; // after a failed kickoff, at most one try an hour
export const LABEL = 'dev.kadans.kickoff';
export const INTERVAL_S = 900;
// Removed from the kickoff's environment: the account switch (own account only) and the throttle opt-in (the kickoff
// session runs the owner's Stop hook and must never be fed a task).
export const DROP_ENV = ['CLAUDE_CONFIG_DIR', 'KADANS_THROTTLE'];

const stateFile = (home) => join(home, 'kickoff.json');

export function readKickoffState(home) {
  try {
    const v = JSON.parse(readFileSync(stateFile(home), 'utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {
    // missing or broken: never run
  }
  return {};
}

function writeKickoffState(home, state) {
  writeAtomic(stateFile(home), `${JSON.stringify(state, null, 2)}\n`);
}

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// Local time of day inside [from, to). from > to wraps past midnight (22:00-06:00); from == to means the whole day.
export function inHours(from, to, now) {
  if (!HHMM_RE.test(from) || !HHMM_RE.test(to)) return false;
  const d = new Date(now);
  const m = d.getHours() * 60 + d.getMinutes();
  const a = minutes(from);
  const b = minutes(to);
  if (a === b) return true;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

// Is the own account's 5-hour window running? From the samples, or from Kadans's own last kickoff (which leaves none).
export function windowLive(samples, state, now) {
  const w = currentWindow(samples, 'five_hour');
  if (w && w.end > now) return { live: true, why: `window already running (resets ${new Date(w.end).toTimeString().slice(0, 5)})` };
  const last = Number(state.lastAt);
  if (Number.isFinite(last) && last <= now) {
    if (state.ok === true && now - last < WINDOW_MS.five_hour) return { live: true, why: 'window already running (Kadans started it)' };
    if (state.ok !== true && now - last < RETRY_MS) return { live: true, why: 'last kickoff did not finish; next try later' };
  }
  return { live: false, why: w ? 'window ended' : 'no sample in a live window' };
}

// { go, code, why }. code: 'off' (refused, kickoff.enabled false) | 'live' | 'hours' | 'go'.
export function decide({ cfg, samples, state = {}, now }) {
  const k = cfg.kickoff;
  if (!k?.enabled) return { go: false, code: 'off', why: 'kickoff is off (kadans config set kickoff.enabled true)' };
  const w = windowLive(samples, state, now);
  if (w.live) return { go: false, code: 'live', why: `${w.why}, nothing to do` };
  if (!inHours(k.from, k.to, now)) return { go: false, code: 'hours', why: `outside the kickoff hours ${k.from}-${k.to}, nothing to do` };
  return { go: true, code: 'go', why: `${w.why}; inside ${k.from}-${k.to}` };
}

// The kickoff's environment: the caller's, minus DROP_ENV.
export function kickoffEnv(env) {
  const out = { ...env };
  for (const k of DROP_ENV) delete out[k];
  return out;
}

function spawnRun(argv, { cwd, env, timeout }) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, env, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, error: r.error ? r.error.message : null, signal: r.signal ?? null };
}

// Decides under the store lock and claims the run in kickoff.json before spawning, so launchd and a manual run never
// both go. deps: { run(argv, {cwd, env, timeout}) -> {status, error}, now, readSamples() }.
// Returns { ran, code, why, ok?, ms? }.
export function runKickoff(home, cfg, { env = process.env, run = spawnRun, now = Date.now(), samples = () => [] } = {}) {
  const d = withLock(home, () => {
    const dec = decide({ cfg, samples: samples(), state: readKickoffState(home), now });
    if (dec.go) writeKickoffState(home, { lastAt: now, ok: null });
    return dec;
  });
  if (!d.go) return { ran: false, ...d };
  const dir = mkdtempSync(join(tmpdir(), 'kadans-kickoff-'));
  const t0 = Date.now();
  let r;
  try {
    r = run(KICKOFF_ARGV, { cwd: dir, env: kickoffEnv(env), timeout: TIMEOUT_MS });
  } catch (e) {
    r = { status: null, error: e.message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const ok = r?.status === 0;
  const ms = Date.now() - t0;
  const why = ok ? 'started the next window' : `claude did not finish (${r?.error || (r?.signal ? `signal ${r.signal}` : `exit ${r?.status}`)})`;
  withLock(home, () => writeKickoffState(home, { lastAt: now, ok }));
  // No sid: readEvents skips it, so the agent list never shows a phantom session.
  try {
    appendEvent(home, { t: now, ev: 'Kickoff', ok, ms, why: why.slice(0, 200) }, now);
  } catch {
    // the log is best effort
  }
  return { ran: true, code: 'go', ok, ms, why };
}

// ---------- launchd schedule ----------

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const shq = (s) => (/^[\w:/.@=-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

function findOnPath(env, name) {
  for (const dir of String(env.PATH ?? '').split(':')) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return dir;
    } catch {
      // not here
    }
  }
  return null;
}

export const agentsDir = () => join(homedir(), 'Library', 'LaunchAgents');

// launchd starts jobs with a bare PATH: bake in node's folder and claude's (as found now), then the usual ones.
export function schedulePath(env, node = process.execPath) {
  const dirs = [dirname(node), findOnPath(env, 'claude'), join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  return [...new Set(dirs.filter(Boolean))].join(':');
}

// The plist text. No DOCTYPE line: launchd does not need it, and Kadans keeps no URLs in its code.
export function plistText({ node, bin, path, kadansHome = null }) {
  const env = [['PATH', path], ...(kadansHome ? [['KADANS_HOME', kadansHome]] : [])];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xml(node)}</string>`,
    `    <string>${xml(bin)}</string>`,
    '    <string>kickoff</string>',
    '  </array>',
    `  <key>StartInterval</key><integer>${INTERVAL_S}</integer>`,
    '  <key>RunAtLoad</key><false/>',
    '  <key>ProcessType</key><string>Background</string>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...env.map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`),
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// kind 'schedule' | 'unschedule'. Returns { file, plist (schedule only), steps: [argv...] } and writes nothing.
export function schedulePlan(kind, { env = process.env, node = process.execPath, bin, uid = process.getuid(), dir = agentsDir() } = {}) {
  const file = join(dir, `${LABEL}.plist`);
  const out = ['launchctl', 'bootout', `gui/${uid}/${LABEL}`];
  if (kind === 'unschedule') return { kind, file, steps: [out, ['rm', '-f', file]] };
  const plist = plistText({ node, bin, path: schedulePath(env, node), kadansHome: env.KADANS_HOME || null });
  return { kind, file, plist, steps: [out, ['launchctl', 'bootstrap', `gui/${uid}`, file]] };
}

export function describeSchedule(p) {
  const words = (argv) => argv.map(shq).join(' ');
  const lines = [];
  if (p.kind === 'schedule') {
    lines.push(`would write ${p.file}:`, ...p.plist.trimEnd().split('\n').map((l) => `  ${l}`), 'then run:');
    lines.push(`  ${words(p.steps[0])}   (only if it is loaded already)`, `  ${words(p.steps[1])}`);
    lines.push(`It runs \`kadans kickoff\` every ${INTERVAL_S / 60} minutes; that does nothing unless kickoff.enabled is true.`);
  } else {
    lines.push('would run:', `  ${words(p.steps[0])}`, `  ${words(p.steps[1])}`);
  }
  return `${lines.join('\n')}\n`;
}

function launchctl(argv) {
  const r = spawnSync('/bin/launchctl', argv.slice(1), { encoding: 'utf8', timeout: 15_000 });
  return { status: r.status, err: (r.stderr || r.error?.message || '').trim() };
}

// Applies a plan. deps: { exec(argv) -> {status, err} } (launchctl). The bootout before bootstrap may fail (not loaded).
export function applySchedule(p, { exec = launchctl } = {}) {
  if (p.kind === 'unschedule') {
    exec(p.steps[0]);
    rmSync(p.file, { force: true });
    return `removed ${p.file}`;
  }
  mkdirSync(dirname(p.file), { recursive: true });
  const tmp = `${p.file}.${process.pid}.tmp`;
  writeFileSync(tmp, p.plist);
  renameSync(tmp, p.file);
  exec(p.steps[0]);
  const r = exec(p.steps[1]);
  if (r.status !== 0) throw new Error(`wrote ${p.file}, but launchctl bootstrap failed: ${String(r.err ?? '').slice(0, 200)}`);
  return `wrote ${p.file} and loaded it (every ${INTERVAL_S / 60} minutes)`;
}
