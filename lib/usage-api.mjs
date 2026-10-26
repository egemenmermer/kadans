// `kadans usage fetch`: one fresh usage reading for the owner's OWN account (~/.claude), from the same endpoint
// Claude Code's /usage screen reads. The reading is stored as a normal sample (source: "api").
//
// TOKEN RULES (also in SECURITY.md):
// - The access token is read from the macOS Keychain item "Claude Code-credentials" (the ~/.claude account; other
//   config dirs use other items and are never read), through /usr/bin/security with an argument list, no shell.
// - It lives in memory for one request. It is never written to disk, logged, printed, put in an error message, passed
//   on a command line or in an environment variable, or sent anywhere but https://api.anthropic.com.
// - The refresh token is never used: refreshing rotates it and could log Claude Code out. An expired or missing access
//   token means: no request, and "login needs a Claude Code session".
// - Failures (401/403/429/5xx/timeouts) store no sample and back off exponentially; the back-off file
//   ($KADANS_HOME/usage-api.json) holds times and status codes only. At most one request per 60 s, across processes.
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { LIMIT_NAMES, accountKey, appendSample, sampleFromPayload } from './samples.mjs';
import { withLock } from './store.mjs';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const USAGE_HOST = 'api.anthropic.com';
export const KEYCHAIN_SERVICE = 'Claude Code-credentials';
export const SECURITY_BIN = '/usr/bin/security';
export const OAUTH_BETA = 'oauth-2025-04-20';
export const MIN_GAP_MS = 60_000; // never more than one request a minute
export const BACKOFF_BASE_MS = 2 * 60_000; // 2, 4, 8, 16, 30 min after consecutive failures
export const BACKOFF_MAX_MS = 30 * 60_000;
export const NO_TOKEN_WAIT_MS = 5 * 60_000; // no usable token: look again in 5 min, not every poll
export const EXPIRY_MARGIN_MS = 60_000; // a token expiring within a minute counts as expired
export const KEYCHAIN_TIMEOUT_MS = 60_000; // macOS may show an "allow" dialog the owner has to click
export const REQUEST_TIMEOUT_MS = 10_000;
export const NO_TOKEN_MESSAGE = 'login needs a Claude Code session';

const stateFile = (home) => join(home, 'usage-api.json');

export function readUsageState(home) {
  try {
    const v = JSON.parse(readFileSync(stateFile(home), 'utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {
    // missing or broken: start empty
  }
  return {};
}

// Only these fields are ever written: times, a failure count and a short code. Never anything from the Keychain.
function writeUsageState(home, s) {
  const clean = {
    lastAttempt: Number(s.lastAttempt) || 0,
    lastOk: Number(s.lastOk) || 0,
    failures: Number(s.failures) || 0,
    nextAt: Number(s.nextAt) || 0,
    lastError: typeof s.lastError === 'string' ? s.lastError.slice(0, 40) : null,
  };
  const tmp = `${stateFile(home)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`);
  renameSync(tmp, stateFile(home));
}

function updateUsageState(home, fn) {
  return withLock(home, () => {
    const s = readUsageState(home);
    const out = fn(s);
    writeUsageState(home, s);
    return out;
  });
}

// Reads the access token and its expiry. Returns { token, expiresAt } or { code } (never the raw Keychain text).
// deps.run(file, args, opts) defaults to spawnSync; deps.securityBin to /usr/bin/security (tests pass a fake).
export function readAccessToken({ run = spawnSync, securityBin = SECURITY_BIN, account } = {}) {
  let user = account;
  if (!user) {
    try {
      user = userInfo().username;
    } catch {
      user = undefined;
    }
  }
  const args = ['find-generic-password', ...(user ? ['-a', user] : []), '-s', KEYCHAIN_SERVICE, '-w'];
  let r;
  try {
    r = run(securityBin, args, { encoding: 'utf8', timeout: KEYCHAIN_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return { code: 'keychain' };
  }
  // 44 = no such item (not logged in). A timeout, a denied dialog or any other failure is a Keychain problem.
  if (!r || r.error) return { code: 'keychain' };
  if (r.status === 44) return { code: 'no_token' };
  if (r.status !== 0) return { code: 'keychain' };
  if (typeof r.stdout !== 'string' || !r.stdout.trim()) return { code: 'no_token' };
  let creds;
  try {
    creds = JSON.parse(r.stdout);
  } catch {
    // SyntaxError messages quote part of the input: drop the error, keep only a fixed code.
    return { code: 'no_token' };
  }
  const o = creds && typeof creds === 'object' ? creds.claudeAiOauth : null;
  const token = o && typeof o.accessToken === 'string' && o.accessToken ? o.accessToken : null;
  const expiresAt = o && Number.isFinite(o.expiresAt) ? o.expiresAt : null;
  if (!token) return { code: 'no_token' };
  return { token, expiresAt };
}

// Default request: Node's fetch, fixed URL, no redirects (the bearer never follows a 3xx), with a timeout.
async function defaultFetch(url, init) {
  const res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, headers: { 'retry-after': res.headers.get('retry-after') }, body };
}

// Maps the usage response ({ five_hour: { utilization, resets_at }, seven_day: {...}, ... }) to a sample.
export function sampleFromUsage(body, now = Date.now()) {
  if (!body || typeof body !== 'object') return null;
  const rate_limits = {};
  for (const name of LIMIT_NAMES) {
    const l = body[name];
    if (!l || typeof l !== 'object' || typeof l.utilization !== 'number' || !Number.isFinite(l.utilization)) continue;
    if (l.resets_at === null || l.resets_at === undefined) continue; // no live window for this limit
    rate_limits[name] = { used_percentage: Math.max(0, Math.min(100, l.utilization)), resets_at: l.resets_at };
  }
  const s = sampleFromPayload({ rate_limits }, now);
  return s ? { ...s, source: 'api' } : null;
}

function backoffMs(failures, retryAfter) {
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(failures - 1, 0), BACKOFF_MAX_MS);
  const ra = Number(retryAfter);
  return Number.isFinite(ra) && ra > 0 ? Math.max(exp, Math.min(ra * 1000, 60 * 60_000)) : exp;
}

// One fetch for the own account. Returns { ok, code, message, sample? } with no token in it. Never throws.
// deps: { cfg, ownKey, now, run, securityBin, fetch, account }.
export async function fetchUsage(home, deps = {}) {
  const now = deps.now ?? Date.now();
  if (deps.cfg && deps.cfg.usageApi === false) return { ok: false, code: 'off', message: 'usage API reading is off (config usageApi false)' };
  // Claim the attempt under the lock first: two processes can never both call.
  let gate;
  try {
    gate = updateUsageState(home, (s) => {
      if (now - (Number(s.lastAttempt) || 0) < MIN_GAP_MS) return { code: 'too_soon' };
      if (now < (Number(s.nextAt) || 0)) return { code: 'backoff', until: s.nextAt };
      s.lastAttempt = now;
      return null;
    });
  } catch {
    return { ok: false, code: 'busy', message: 'store is busy; try again' };
  }
  if (gate?.code === 'too_soon') return { ok: false, code: 'too_soon', message: 'read less than a minute ago' };
  if (gate?.code === 'backoff') return { ok: false, code: 'backoff', message: `backing off until ${new Date(gate.until).toTimeString().slice(0, 5)}` };

  const cred = readAccessToken(deps);
  if (!cred.token || !Number.isFinite(cred.expiresAt) || cred.expiresAt - EXPIRY_MARGIN_MS <= now) {
    if (cred.code === 'keychain') {
      // Denied, timed out or failed: back off like a failed request, so a dialog is not shown every poll.
      const wait = updateUsageState(home, (s) => {
        s.failures = (Number(s.failures) || 0) + 1;
        s.lastError = 'keychain';
        s.nextAt = now + backoffMs(s.failures);
        return s.nextAt;
      });
      return { ok: false, code: 'keychain', message: `could not read the Keychain item (denied or timed out); next try after ${new Date(wait).toTimeString().slice(0, 5)}` };
    }
    updateUsageState(home, (s) => {
      s.lastError = 'no_token';
      s.nextAt = now + NO_TOKEN_WAIT_MS;
    });
    return { ok: false, code: 'no_token', message: NO_TOKEN_MESSAGE };
  }

  let res;
  try {
    const url = new URL(USAGE_URL);
    if (url.protocol !== 'https:' || url.hostname !== USAGE_HOST) throw new Error('refused');
    res = await (deps.fetch ?? defaultFetch)(url.href, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cred.token}`,
        'anthropic-beta': OAUTH_BETA,
        'Content-Type': 'application/json',
        'User-Agent': 'kadans',
      },
    });
  } catch (e) {
    res = { status: 0, timeout: e?.name === 'TimeoutError' || e?.name === 'AbortError' };
  }
  cred.token = null; // done with it

  const status = Number(res?.status) || 0;
  const sample = status >= 200 && status < 300 ? sampleFromUsage(res.body, now) : null;
  if (!sample) {
    const code = status === 0 ? (res?.timeout ? 'timeout' : 'network') : status >= 200 && status < 300 ? 'bad_response' : `http_${status}`;
    const wait = updateUsageState(home, (s) => {
      s.failures = (Number(s.failures) || 0) + 1;
      s.lastError = code;
      s.nextAt = now + backoffMs(s.failures, res?.headers?.['retry-after']);
      return s.nextAt;
    });
    const why = status === 401 || status === 403 ? `${NO_TOKEN_MESSAGE} (HTTP ${status})` : code === 'bad_response' ? 'no usage numbers in the response' : status ? `HTTP ${status}` : code;
    return { ok: false, code, message: `${why}; next try after ${new Date(wait).toTimeString().slice(0, 5)}` };
  }
  // Always the own account's key (~/.claude), whatever CLAUDE_CONFIG_DIR says: the Keychain item is that account's.
  appendSample(home, deps.ownKey ?? accountKey(join(homedir(), '.claude')), sample, now);
  updateUsageState(home, (s) => {
    s.failures = 0;
    s.nextAt = 0;
    s.lastOk = now;
    s.lastError = null;
  });
  return { ok: true, code: 'ok', message: 'ok', sample };
}

const LABEL = { five_hour: '5-hour', seven_day: '7-day' };

// Percentages only: never anything else from the response.
export function renderUsage(r) {
  if (!r.ok) return `usage: ${r.message}`;
  const parts = Object.entries(r.sample.limits).map(([n, l]) => `${LABEL[n] ?? n} ${Math.round(l.pct)} %`);
  return `usage: ${parts.join(', ')}`;
}

export function usageJson(r) {
  if (!r.ok) return { ok: false, code: r.code, message: r.message };
  const limits = {};
  for (const [n, l] of Object.entries(r.sample.limits)) limits[n] = { pct: l.pct, resetsAt: l.resetsAt };
  return { ok: true, code: 'ok', source: 'api', t: r.sample.t, limits };
}
