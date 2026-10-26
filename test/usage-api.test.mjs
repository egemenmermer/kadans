import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountKey, readSamples } from '../lib/samples.mjs';
import { loadConfig, overall } from '../lib/pace.mjs';
import { setSetting } from '../lib/config.mjs';
import {
  BACKOFF_BASE_MS, KEYCHAIN_SERVICE, MIN_GAP_MS, NO_TOKEN_MESSAGE, USAGE_URL,
  fetchUsage, readUsageState, renderUsage, sampleFromUsage, usageJson,
} from '../lib/usage-api.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
const MIN = 60_000;
const NOW = Date.parse('2026-10-26T12:06:00Z');
const TOKEN = 'fake-tok-91Q'; // short on purpose: never looks like a real key
const OTHER_TOKEN = 'other-tok-55X';

// Never the real Keychain: a fake `security` that logs its argv and prints the given credentials file.
function sandbox({ creds, exit = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kadans-usage-'));
  const home = join(root, 'kadans');
  mkdirSync(home);
  const fake = join(root, 'fakebin');
  mkdirSync(fake);
  const credFile = join(fake, 'creds.txt');
  writeFileSync(credFile, creds ?? JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: 'fake-refresh-1', expiresAt: NOW + 3 * 3600_000 } }));
  const log = join(root, 'security-argv.log');
  const securityBin = join(fake, 'security');
  writeFileSync(securityBin, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\ncat '${credFile}'\nexit ${exit}\n`);
  chmodSync(securityBin, 0o755);
  const ownKey = accountKey(join(root, '.claude'));
  const calls = [];
  const okBody = {
    five_hour: { utilization: 27, resets_at: '2026-10-26T15:00:00.412345+00:00' },
    seven_day: { utilization: 41.5, resets_at: '2026-10-30T09:00:00.000000+00:00' },
    seven_day_opus: null,
    extra_usage: { is_enabled: false },
  };
  const fetchWith = (status, body = okBody, headers = {}) => async (url, init) => {
    calls.push({ url, init });
    return { status, body, headers };
  };
  return { root, home, ownKey, securityBin, log, calls, fetchWith, okBody };
}

// Every file under dir except the fake `security` folder (which holds the fake credentials on purpose).
function allText(dir) {
  let out = '';
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'fakebin') continue;
    if (statSync(p).isDirectory()) out += allText(p);
    else out += readFileSync(p, 'utf8');
  }
  return out;
}

const deps = (sb, extra = {}) => ({ securityBin: sb.securityBin, ownKey: sb.ownKey, account: 'me', ...extra });

test('good response: one GET to api.anthropic.com, a sample with source api under the own account', async () => {
  const sb = sandbox();
  const r = await fetchUsage(sb.home, deps(sb, { now: NOW, fetch: sb.fetchWith(200) }));
  assert.equal(r.ok, true);
  assert.equal(sb.calls.length, 1);
  assert.equal(sb.calls[0].url, USAGE_URL);
  assert.equal(new URL(sb.calls[0].url).hostname, 'api.anthropic.com');
  assert.equal(sb.calls[0].init.method, 'GET');
  assert.equal(sb.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(sb.calls[0].init.headers['anthropic-beta'], 'oauth-2025-04-20');
  const argv = readFileSync(sb.log, 'utf8').trim().split('\n');
  assert.deepEqual(argv, ['find-generic-password', '-a', 'me', '-s', KEYCHAIN_SERVICE, '-w']);
  const samples = readSamples(sb.home, sb.ownKey);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].source, 'api');
  assert.equal(samples[0].t, NOW);
  assert.equal(samples[0].session_id, null);
  assert.deepEqual(samples[0].limits.five_hour, { pct: 27, resetsAt: Date.parse('2026-10-26T15:00:00.412Z') });
  assert.equal(samples[0].limits.seven_day.pct, 41.5);
  assert.equal(renderUsage(r), 'usage: 5-hour 27 %, 7-day 42 %');
  assert.deepEqual(Object.keys(usageJson(r)).sort(), ['code', 'limits', 'ok', 'source', 't']);
  const st = readUsageState(sb.home);
  assert.equal(st.lastOk, NOW);
  assert.equal(st.failures, 0);
});

test('expired or missing token: no request, "login needs a Claude Code session", no sample', async () => {
  const expired = sandbox({ creds: JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: 'fake-refresh-1', expiresAt: NOW - MIN } }) });
  const r1 = await fetchUsage(expired.home, deps(expired, { now: NOW, fetch: expired.fetchWith(200) }));
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'no_token');
  assert.equal(r1.message, NO_TOKEN_MESSAGE);
  assert.equal(expired.calls.length, 0);
  assert.equal(readSamples(expired.home, expired.ownKey).length, 0);
  // expiring within the next minute counts as expired too
  const soon = sandbox({ creds: JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW + 20_000 } }) });
  assert.equal((await fetchUsage(soon.home, deps(soon, { now: NOW, fetch: soon.fetchWith(200) }))).code, 'no_token');
  assert.equal(soon.calls.length, 0);
  // no Keychain item: `security` exits 44 with nothing on stdout
  const missing = sandbox({ creds: '', exit: 44 });
  // denied or failed Keychain read (any other exit): its own code, exponential back-off, no request
  const denied = sandbox({ creds: '', exit: 51 });
  const d1 = await fetchUsage(denied.home, deps(denied, { now: NOW, fetch: denied.fetchWith(200) }));
  assert.equal(d1.code, 'keychain');
  assert.equal(readUsageState(denied.home).failures, 1);
  assert.equal((await fetchUsage(denied.home, deps(denied, { now: NOW + MIN_GAP_MS, fetch: denied.fetchWith(200) }))).code, 'backoff');
  await fetchUsage(denied.home, deps(denied, { now: NOW + BACKOFF_BASE_MS, fetch: denied.fetchWith(200) }));
  assert.equal(readUsageState(denied.home).nextAt, NOW + 3 * BACKOFF_BASE_MS);
  assert.equal(denied.calls.length, 0);
  const r2 = await fetchUsage(missing.home, deps(missing, { now: NOW, fetch: missing.fetchWith(200) }));
  assert.equal(r2.message, NO_TOKEN_MESSAGE);
  assert.equal(missing.calls.length, 0);
  // the next poll does not ask the Keychain again at once
  const r3 = await fetchUsage(missing.home, deps(missing, { now: NOW + 2 * MIN, fetch: missing.fetchWith(200) }));
  assert.equal(r3.code, 'backoff');
});

test('401 and 429: no sample, exponential back-off recorded, no request while backing off', async () => {
  const sb = sandbox();
  const r = await fetchUsage(sb.home, deps(sb, { now: NOW, fetch: sb.fetchWith(401, { error: 'x' }) }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'http_401');
  assert.match(r.message, /login needs a Claude Code session/);
  assert.equal(readSamples(sb.home, sb.ownKey).length, 0);
  let st = readUsageState(sb.home);
  assert.equal(st.failures, 1);
  assert.equal(st.nextAt, NOW + BACKOFF_BASE_MS);
  assert.equal(st.lastError, 'http_401');

  const r2 = await fetchUsage(sb.home, deps(sb, { now: NOW + 90_000, fetch: sb.fetchWith(200) }));
  assert.equal(r2.code, 'backoff');
  assert.equal(sb.calls.length, 1);

  const r3 = await fetchUsage(sb.home, deps(sb, { now: NOW + BACKOFF_BASE_MS, fetch: sb.fetchWith(429, null) }));
  assert.equal(r3.code, 'http_429');
  st = readUsageState(sb.home);
  assert.equal(st.failures, 2);
  assert.equal(st.nextAt, NOW + BACKOFF_BASE_MS + 2 * BACKOFF_BASE_MS); // doubled
  assert.equal(readSamples(sb.home, sb.ownKey).length, 0);

  // Retry-After longer than the back-off wins
  const t4 = st.nextAt;
  await fetchUsage(sb.home, deps(sb, { now: t4, fetch: sb.fetchWith(429, null, { 'retry-after': '1800' }) }));
  assert.equal(readUsageState(sb.home).nextAt, t4 + 1800_000);

  // 5xx and a timeout back off the same way; a success resets the count
  const sb2 = sandbox();
  await fetchUsage(sb2.home, deps(sb2, { now: NOW, fetch: sb2.fetchWith(503, null) }));
  assert.equal(readUsageState(sb2.home).lastError, 'http_503');
  const timeout = async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; };
  await fetchUsage(sb2.home, deps(sb2, { now: NOW + BACKOFF_BASE_MS, fetch: timeout }));
  assert.equal(readUsageState(sb2.home).lastError, 'timeout');
  assert.equal(readUsageState(sb2.home).failures, 2);
  const ok = await fetchUsage(sb2.home, deps(sb2, { now: NOW + 10 * MIN, fetch: sb2.fetchWith(200) }));
  assert.equal(ok.ok, true);
  assert.equal(readUsageState(sb2.home).failures, 0);
  assert.equal(readUsageState(sb2.home).nextAt, 0);
});

test('at most one request a minute, also across processes (the attempt is claimed first)', async () => {
  const sb = sandbox();
  await fetchUsage(sb.home, deps(sb, { now: NOW, fetch: sb.fetchWith(200) }));
  const r = await fetchUsage(sb.home, deps(sb, { now: NOW + 30_000, fetch: sb.fetchWith(200) }));
  assert.equal(r.code, 'too_soon');
  assert.equal(sb.calls.length, 1);
  const r2 = await fetchUsage(sb.home, deps(sb, { now: NOW + MIN_GAP_MS, fetch: sb.fetchWith(200) }));
  assert.equal(r2.ok, true);
  assert.equal(sb.calls.length, 2);
});

test('off switch: usageApi false means no Keychain read and no request', async () => {
  const sb = sandbox();
  setSetting(sb.home, 'usageApi', 'false', { ownKey: sb.ownKey });
  const cfg = loadConfig(sb.home);
  assert.equal(cfg.usageApi, false);
  const r = await fetchUsage(sb.home, deps(sb, { cfg, now: NOW, fetch: sb.fetchWith(200) }));
  assert.equal(r.code, 'off');
  assert.equal(sb.calls.length, 0);
  assert.equal(existsSync(sb.log), false);
  assert.equal(loadConfig(join(sb.root, 'nothing')).usageApi, true); // default on
  assert.throws(() => setSetting(sb.home, 'usageApi', 'maybe', { ownKey: sb.ownKey }), /true or false/);
});

test('the token never reaches stdout, stderr, messages or any file, even from broken Keychain JSON', async () => {
  const outputs = [];
  const runAll = async (sb, list) => {
    for (const [i, f] of list.entries()) {
      const r = await fetchUsage(sb.home, deps(sb, { now: NOW + i * 31 * MIN, fetch: f }));
      outputs.push(r.message, renderUsage(r), JSON.stringify(usageJson(r)));
    }
  };
  const sb = sandbox();
  const throwing = async () => { throw new Error(`socket hang up ${TOKEN}`); };
  await runAll(sb, [sb.fetchWith(200), sb.fetchWith(401, { error: { message: 'bad' } }), throwing, sb.fetchWith(200, { five_hour: 'x' })]);
  const broken = sandbox({ creds: `{"claudeAiOauth":{"accessToken":"${TOKEN}", oops` });
  await runAll(broken, [broken.fetchWith(200)]);
  assert.equal(broken.calls.length, 0);
  for (const s of [sb, broken]) assert.equal(allText(s.root).includes(TOKEN), false, 'token found in a file');
  assert.equal(outputs.join('\n').includes(TOKEN), false, 'token found in output');
  assert.equal(outputs.join('\n').includes('fake-refresh'), false);
});

test('own account only: CLAUDE_CONFIG_DIR pointing elsewhere is never read and gets no sample', async () => {
  const sb = sandbox();
  const other = join(sb.root, 'other');
  mkdirSync(other);
  writeFileSync(join(other, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: OTHER_TOKEN, expiresAt: NOW + 3600_000 } }));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = other;
  try {
    // no ownKey given: the default is always ~/.claude's key, never CLAUDE_CONFIG_DIR's
    const r = await fetchUsage(sb.home, { securityBin: sb.securityBin, account: 'me', now: NOW, fetch: sb.fetchWith(200) });
    assert.equal(r.ok, true);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
  assert.equal(sb.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(JSON.stringify(sb.calls).includes(OTHER_TOKEN), false);
  assert.equal(readFileSync(sb.log, 'utf8').includes(other), false);
  assert.ok(readFileSync(sb.log, 'utf8').split('\n').includes(KEYCHAIN_SERVICE)); // exact service, no per-dir suffix
  assert.equal(readSamples(sb.home, accountKey(other)).length, 0);
  assert.equal(readSamples(sb.home, accountKey(join(homedir(), '.claude'))).length, 1);
});

test('sampleFromUsage: only five_hour and seven_day, clamped, null resets skipped', () => {
  const s = sampleFromUsage({ five_hour: { utilization: 130, resets_at: 1790000000 }, seven_day: { utilization: 3, resets_at: null }, seven_day_opus: { utilization: 99, resets_at: 1790000000 } }, NOW);
  assert.deepEqual(Object.keys(s.limits), ['five_hour']);
  assert.equal(s.limits.five_hour.pct, 100);
  assert.equal(s.limits.five_hour.resetsAt, 1790000000_000);
  assert.equal(sampleFromUsage({ five_hour: { utilization: 'x', resets_at: 1 } }, NOW), null);
  assert.equal(sampleFromUsage(null, NOW), null);
});

// CLI: only paths that stop before the Keychain (off, back-off) run as a real process here.
test('cli: usage fetch with usageApi off or while backing off never reads the Keychain', () => {
  const root = mkdtempSync(join(tmpdir(), 'kadans-usage-cli-'));
  const home = join(root, 'kadans');
  mkdirSync(home);
  const env = { PATH: '', HOME: root, KADANS_HOME: home, KADANS_ORCA: '0' };
  writeFileSync(join(home, 'config.json'), JSON.stringify({ usageApi: false }));
  let r = spawnSync(process.execPath, [BIN, 'usage', 'fetch', '--json'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).code, 'off');
  writeFileSync(join(home, 'config.json'), '{}');
  writeFileSync(join(home, 'usage-api.json'), JSON.stringify({ lastAttempt: 0, nextAt: Date.now() + 3600_000, failures: 3, lastError: 'http_429' }));
  r = spawnSync(process.execPath, [BIN, 'usage', 'fetch'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^usage: backing off until \d\d:\d\d\n$/);
  const s = JSON.parse(spawnSync(process.execPath, [BIN, 'status', '--json'], { env, encoding: 'utf8' }).stdout);
  assert.equal(s.usageApi.enabled, true);
  assert.equal(s.usageApi.lastError, 'http_429');
  assert.ok(s.usageApi.nextAt > Date.now());
});

test('status --json: fresh and lastSource per account', () => {
  const root = mkdtempSync(join(tmpdir(), 'kadans-usage-fresh-'));
  const home = join(root, 'kadans');
  const now = Date.now();
  const write = (dir, samples) => {
    const d = join(home, 'accounts', accountKey(dir));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'samples.jsonl'), samples.map((x) => JSON.stringify(x)).join('\n') + '\n');
  };
  const lim = (pct) => ({ five_hour: { pct, resetsAt: now + 120 * MIN } });
  write(join(root, '.claude'), [{ t: now - 2 * MIN, session_id: null, limits: lim(27), source: 'api' }]);
  write(join(root, 'other'), [{ t: now - 11 * MIN, session_id: 's', limits: lim(12) }]);
  const env = { PATH: '', HOME: root, KADANS_HOME: home, KADANS_ORCA: '0' };
  const s = JSON.parse(spawnSync(process.execPath, [BIN, 'status', '--json'], { env, encoding: 'utf8' }).stdout);
  const own = s.accounts.find((a) => a.own);
  const oth = s.accounts.find((a) => !a.own);
  assert.equal(own.fresh, true);
  assert.equal(own.lastSource, 'api');
  assert.equal(oth.fresh, false);
  assert.equal(oth.lastSource, 'statusline');
});

// Pace with a jump: no status-line sample for 37 minutes, then the API says 27 %.
test('pace: 12 % then 27 % 37 min later, then steady: no false early or brake, needle settles to 0', () => {
  const cfg = loadConfig(join(tmpdir(), 'kadans-no-config'));
  const t0 = NOW - 37 * MIN; // 11:29
  const end = NOW + 150 * MIN; // window started 150 min before the jump
  const sl = (t, pct) => ({ t, session_id: 's1', limits: { five_hour: { pct, resetsAt: Math.floor(end / 1000) * 1000 } } });
  const api = (t, pct) => ({ t, session_id: null, source: 'api', limits: { five_hour: { pct, resetsAt: end + 412 } } });
  const samples = [sl(t0 - 10 * MIN, 10), sl(t0 - 5 * MIN, 11), sl(t0, 12)];
  const states = [];
  samples.push(api(NOW, 27));
  states.push(overall(samples, NOW, cfg));
  for (let m = 2; m <= 20; m += 2) {
    samples.push(api(NOW + m * MIN, 27));
    states.push(overall(samples, NOW + m * MIN, cfg));
  }
  for (const st of states) {
    assert.notEqual(st.state, 'brake');
    assert.notEqual(st.state, 'early');
    assert.equal(st.limits[0].pct, 27); // the jump is the current value, the window did not split
  }
  const last = states[states.length - 1].limits[0];
  assert.equal(last.samples, 14); // status-line and API points share one window
  assert.equal(last.needle, 0);
});

test('pace: same jump with the owner-like window (started 66 min before): any brake clears within 6 min of steady readings', () => {
  const cfg = loadConfig(join(tmpdir(), 'kadans-no-config'));
  const end = NOW + 234 * MIN; // 11:00 window start, 12:06 jump
  const pt = (t, pct, api) => ({ t, session_id: api ? null : 's1', ...(api ? { source: 'api' } : {}), limits: { five_hour: { pct, resetsAt: end } } });
  const samples = [pt(NOW - 47 * MIN, 10), pt(NOW - 42 * MIN, 11), pt(NOW - 37 * MIN, 12), pt(NOW, 27, true)];
  // 27 % in 66 min really is a pace that runs out: on the window average the jump may brake at first ...
  for (let m = 2; m <= 20; m += 2) {
    samples.push(pt(NOW + m * MIN, 27, true));
    const st = overall(samples, NOW + m * MIN, cfg);
    assert.notEqual(st.state, 'early');
    // ... but 4 steady API points over 6 min make the needle reliable (0), before auto-pace's 10-minute hold
    if (m >= 6) assert.notEqual(st.state, 'brake', `brake at +${m} min`);
  }
});

test('pace: status-line and API resets_at a few seconds apart stay one window, in either order', () => {
  const cfg = loadConfig(join(tmpdir(), 'kadans-no-config'));
  const end = NOW + 100 * MIN;
  const samples = [];
  for (let i = 0; i < 8; i++) {
    const t = NOW - (8 - i) * 2 * MIN;
    const drift = i % 2 ? 45_000 : -7_000;
    samples.push({ t, session_id: i % 2 ? null : 's1', ...(i % 2 ? { source: 'api' } : {}), limits: { five_hour: { pct: 20 + i, resetsAt: end + drift } } });
  }
  const res = overall(samples, NOW, cfg);
  assert.equal(res.limits[0].samples, 8);
  assert.equal(res.limits[0].pct, 27);
});
