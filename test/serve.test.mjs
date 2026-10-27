// Phone control: `kadans serve` / pair / devices. Every server binds 127.0.0.1 on an ephemeral port in a temp
// KADANS_HOME, and actions go to an injected runner, so nothing real is stopped, started or paced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODE_TTL_MS, base32, listDevices, newPairCode, revokeDevice, sha256 } from '../lib/phone.mjs';
import { ALLOWED_ACTIONS, STATIC_FILES, agentIds, cliRunner, createPhoneServer, manifestFor, pickHost, planAction, titleArg, why } from '../lib/serve.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');

const AGENTS = [{ id: 'a1', title: 'one' }, { id: 'b2', title: 'two' }];
const STATUS = { version: 1, accounts: [{ key: 'abc', limits: [] }] };
const CONFIG = { version: 1, phone: true, autopace: false };
const ok = (v) => ({ code: 0, out: `${JSON.stringify(v)}\n`, err: '', timedOut: false });

async function boot({ outputs = {}, webRoot, t = 1_000_000 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'kadans-serve-'));
  const clock = { t };
  const calls = [];
  const run = async (args, o = {}) => {
    calls.push({ args, timeout: o.timeout });
    const key = args.join(' ');
    if (Object.hasOwn(outputs, key)) return outputs[key];
    if (key === 'status --json') return ok(STATUS);
    if (key === 'agents --json') return ok(AGENTS);
    if (key === 'config get --json') return ok(CONFIG);
    return { code: 0, out: 'done\n', err: '', timedOut: false };
  };
  const server = createPhoneServer({ home, run, now: () => clock.t, ...(webRoot ? { webRoot } : {}) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const req = (method, path, { body, token, headers = {}, raw } = {}) => new Promise((done, fail) => {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    let data;
    if (raw !== undefined) data = raw;
    else if (body !== undefined) {
      data = JSON.stringify(body);
      h['content-type'] ??= 'application/json';
    }
    const r = request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        done({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', fail);
    if (data !== undefined) r.write(data);
    r.end();
  });
  const pair = async (name = 'My phone') => {
    const { code } = newPairCode(home, clock.t);
    const r = await req('POST', '/api/pair', { body: { code, name } });
    assert.equal(r.status, 200, r.text);
    return { code, token: r.json.token };
  };
  const close = () => new Promise((r) => {
    server.closeAllConnections();
    server.close(r);
  });
  return { home, clock, calls, req, pair, close, server, port };
}

const actionCalls = (calls) => calls.filter((c) => !['status --json', 'agents --json', 'config get --json'].includes(c.args.join(' ')));

test('pair: a good code gives a 256-bit token once; reused, wrong and expired codes get 401', async () => {
  const s = await boot();
  try {
    const { code, token } = await s.pair();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.equal((await s.req('POST', '/api/pair', { body: { code, name: 'again' } })).status, 401, 'single use');
    assert.equal((await s.req('POST', '/api/pair', { body: { code: base32(Buffer.alloc(16, 7)), name: 'x' } })).status, 401, 'wrong');
    const d = listDevices(s.home);
    assert.equal(d.length, 1);
    assert.deepEqual(Object.keys(d[0]).sort(), ['createdAt', 'id', 'lastSeenAt', 'name']);
    assert.equal(d[0].name, 'My phone');
    const { code: late } = newPairCode(s.home, s.clock.t);
    s.clock.t += CODE_TTL_MS + 1;
    assert.equal((await s.req('POST', '/api/pair', { body: { code: late, name: 'late' } })).status, 401, 'expired');
    assert.equal(listDevices(s.home).length, 1);
  } finally {
    await s.close();
  }
});

test('pair: codes are 26 base32 characters; a new code replaces the old one; bad names do not spend a code', async () => {
  const s = await boot();
  try {
    const a = newPairCode(s.home, s.clock.t);
    assert.match(a.code, /^[A-Z2-7]{26}$/);
    assert.equal(a.expiresAt, s.clock.t + CODE_TTL_MS);
    const b = newPairCode(s.home, s.clock.t);
    assert.equal((await s.req('POST', '/api/pair', { body: { code: a.code, name: 'x' } })).status, 401, 'replaced');
    assert.equal((await s.req('POST', '/api/pair', { body: { code: b.code, name: 'x'.repeat(41) } })).status, 400);
    assert.equal((await s.req('POST', '/api/pair', { body: { code: b.code, name: '\u0007\u202e' } })).status, 400);
    const r = await s.req('POST', '/api/pair', { body: { code: b.code.toLowerCase(), name: 'Pixel' } });
    assert.equal(r.status, 200, 'case-insensitive, still unspent');
  } finally {
    await s.close();
  }
});

test('pair: at most 5 attempts per minute per IP, then 429 even for a good code', async () => {
  const s = await boot();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await s.req('POST', '/api/pair', { body: { code: 'WRONG', name: 'x' } })).status, 401);
    const { code } = newPairCode(s.home, s.clock.t);
    assert.equal((await s.req('POST', '/api/pair', { body: { code, name: 'x' } })).status, 429);
    s.clock.t += 60_000;
    assert.equal((await s.req('POST', '/api/pair', { body: { code, name: 'x' } })).status, 200);
  } finally {
    await s.close();
  }
});

test('auth: missing, malformed, unknown and revoked tokens get 401 and run nothing', async () => {
  const s = await boot();
  try {
    const { token } = await s.pair();
    for (const headers of [{}, { authorization: token }, { authorization: `Basic ${token}` }, { authorization: 'Bearer short' }]) {
      assert.equal((await s.req('GET', '/api/state', { headers })).status, 401);
    }
    assert.equal((await s.req('GET', '/api/state', { token: 'A'.repeat(43) })).status, 401);
    assert.equal((await s.req('POST', '/api/action', { body: { action: 'stop', id: 'a1' } })).status, 401);
    assert.equal(s.calls.length, 0, 'nothing ran before auth');
    assert.equal((await s.req('GET', '/api/state', { token })).status, 200);
    const [d] = listDevices(s.home);
    assert.equal(revokeDevice(s.home, d.id), true);
    assert.equal((await s.req('GET', '/api/state', { token })).status, 401, 'revoked at once');
    assert.equal(revokeDevice(s.home, d.id), false);
  } finally {
    await s.close();
  }
});

test('auth: 10 requests per second per token, then 429', async () => {
  const s = await boot();
  try {
    const { token } = await s.pair();
    for (let i = 0; i < 10; i++) assert.equal((await s.req('GET', '/api/state', { token })).status, 200);
    assert.equal((await s.req('GET', '/api/state', { token })).status, 429);
    s.clock.t += 1000;
    assert.equal((await s.req('GET', '/api/state', { token })).status, 200);
    assert.equal(s.calls.length, 3, 'state is cached: one status/agents/config round');
  } finally {
    await s.close();
  }
});

test('state: exactly the panel render payload (status, agents, config) from the same three CLI reads', async () => {
  const s = await boot();
  try {
    const { token } = await s.pair();
    const r = await s.req('GET', '/api/state', { token });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json), ['status', 'agents', 'config']);
    assert.deepEqual(r.json, { status: STATUS, agents: AGENTS, config: CONFIG });
    assert.deepEqual(s.calls.map((c) => c.args), [['status', '--json'], ['agents', '--json'], ['config', 'get', '--json']]);
  } finally {
    await s.close();
  }
  const bad = await boot({
    outputs: {
      'status --json': { code: 1, out: '', err: 'kadans: broken', timedOut: false },
      'agents --json': { code: 0, out: 'not json', err: '', timedOut: false },
      'config get --json': { code: 2, out: '', err: 'x', timedOut: false },
    },
  });
  try {
    const { token } = await bad.pair();
    const r = await bad.req('GET', '/api/state', { token });
    assert.deepEqual(r.json, { status: null, agents: [] }, 'as the Mac: null status, [] agents, no config key');
  } finally {
    await bad.close();
  }
});

test('actions: every allowed action runs the same argv as the Mac bridge and answers like BridgeResult', async () => {
  const s = await boot({ outputs: { 'agent stop b2': { code: 1, out: '', err: 'kadans: refused: that agent is not running\nmore', timedOut: false } } });
  try {
    const { token } = await s.pair();
    const cases = [
      [{ action: 'config-set', key: 'compact.soonPct', value: '80' }, ['config', 'set', 'compact.soonPct', '80'], 10_000, 'compact.soonPct'],
      [{ action: 'config-set', key: 'limits', value: 'five_hour,seven_day' }, ['config', 'set', 'limits', 'five_hour,seven_day'], 10_000, 'limits'],
      [{ action: 'stop', id: 'a1' }, ['agent', 'stop', 'a1'], 10_000, 'a1'],
      [{ action: 'compact', id: 'a1' }, ['agent', 'compact', 'a1'], 10_000, 'a1'],
      [{ action: 'approve', id: 7 }, ['approve', '7'], 10_000, '7'],
      [{ action: 'start', id: 12 }, ['task', 'start', '12'], 45_000, '12'],
      [{ action: 'replace', id: 'b2', task: 3 }, ['agent', 'replace', 'b2', '3'], 45_000, 'b2'],
      [{ action: 'pace', id: 'a1', mode: 'slow' }, ['agent', 'pace', 'a1', 'slow'], 10_000, 'a1'],
      [{ action: 'pace', id: 'a1', mode: 'none' }, ['agent', 'pace', 'a1', 'none'], 10_000, 'a1'],
      [{ action: 'pace', id: 'a1', mode: 'pause', until: '30m' }, ['agent', 'pace', 'a1', 'pause', '--until', '30m'], 10_000, 'a1'],
      [{ action: 'pace', id: 'a1', mode: 'pause', until: 'reset' }, ['agent', 'pace', 'a1', 'pause', '--until', 'reset'], 10_000, 'a1'],
    ];
    for (const [body, args, timeout, id] of cases) {
      s.clock.t += 1000; // stay under the per-second limit
      const before = s.calls.length;
      const r = await s.req('POST', '/api/action', { body, token });
      assert.equal(r.status, 200, JSON.stringify(body));
      assert.deepEqual(r.json, { action: body.action, id, ok: true, why: '' });
      assert.deepEqual(actionCalls(s.calls.slice(before)), [{ args, timeout }], JSON.stringify(body));
    }
    s.clock.t += 1000;
    const r = await s.req('POST', '/api/action', { body: { action: 'stop', id: 'b2' }, token });
    assert.deepEqual(r.json, { action: 'stop', id: 'b2', ok: false, why: 'refused: that agent is not running' });
  } finally {
    await s.close();
  }
});

test('actions: everything else is refused with 400 and runs nothing', async () => {
  const s = await boot();
  try {
    const { token } = await s.pair();
    const refused = [
      { action: 'autopace', on: true }, { action: 'install-apply' }, { action: 'install-preview' }, { action: 'size', height: 100 },
      { action: 'close' }, { action: 'settings' }, { action: 'retry' }, { action: 'phone-pair' }, { action: 'phone-off' },
      { action: 'shell', cmd: 'ls' }, { action: '' }, {}, { action: ['stop'] }, { action: 'constructor' }, { action: 'toString' },
      { action: 'stop', id: 'zz' }, { action: 'stop', id: '-a1' }, { action: 'stop' }, { action: 'compact', id: 1 },
      { action: 'approve', id: true }, { action: 'approve', id: '5' }, { action: 'approve', id: 1.5 }, { action: 'approve', id: 0 },
      { action: 'start', id: 1e10 }, { action: 'start', id: -3 }, { action: 'replace', id: 'a1' }, { action: 'replace', id: 'zz', task: 2 },
      { action: 'pace', id: 'a1', mode: 'fast' }, { action: 'pace', id: 'a1', mode: 'pause', until: null },
      { action: 'pace', id: 'a1', mode: 'slow', until: '30m' }, { action: 'pace', id: 'a1', mode: 'pause', until: '1h' },
      { action: 'config-set', key: 'limits', value: 'AUTO' }, { action: 'config-set', key: '--help', value: 'x' },
      { action: 'config-set', key: 'a b', value: 'x' }, { action: 'config-set', key: 'notify', value: 'true; rm -rf x' },
      { action: 'config-set', key: 'notify', value: 'x'.repeat(65) }, { action: 'config-set', key: 'notify', value: true },
    ];
    for (const body of refused) {
      s.clock.t += 1000;
      const r = await s.req('POST', '/api/action', { body, token });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.ok, false);
      assert.match(r.json.why, /^refused: /);
      assert.deepEqual(Object.keys(r.json), ['action', 'id', 'ok', 'why']);
    }
    assert.deepEqual(actionCalls(s.calls), [], 'only agents --json ran');
    for (const [method, path, status] of [
      ['GET', '/api/action', 405], ['POST', '/api/state', 405], ['GET', '/api/pair', 405], ['GET', '/api/devices', 404],
      ['GET', '/api', 404], ['GET', '/api/state/../action', 404], ['OPTIONS', '/api/action', 405], ['PUT', '/', 405], ['DELETE', '/panel.html', 405],
    ]) {
      s.clock.t += 1000;
      assert.equal((await s.req(method, path, { token })).status, status, `${method} ${path}`);
    }
    s.clock.t += 1000;
    assert.equal((await s.req('POST', '/api/action', { raw: '{"action":"stop","id":"a1"}', token, headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await s.req('POST', '/api/action', { raw: '[1]', token, headers: { 'content-type': 'application/json' } })).status, 400);
    assert.equal((await s.req('POST', '/api/action', { body: { action: 'stop', id: 'a1', pad: 'x'.repeat(5000) }, token })).status, 413);
    assert.equal((await s.req('GET', '/', { headers: { host: 'evil.example:7477' } })).status, 421, 'Host must be this server');
    assert.deepEqual(actionCalls(s.calls), []);
  } finally {
    await s.close();
  }
});

test('static: app/web files only; traversal, hidden, fixtures, dev page, unknown types and symlinks out are 404', async () => {
  const s = await boot();
  try {
    const home = await s.req('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.headers['content-type'], /^text\/html/);
    assert.match(home.text, /panel\.js/);
    assert.match((await s.req('GET', '/panel.css')).headers['content-type'], /^text\/css/);
    assert.match((await s.req('GET', '/panel.js')).headers['content-type'], /^text\/javascript/);
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/%2e%2e%2fbin%2fkadans.mjs', '/..%5cpackage.json',
      '/fixtures/_base.js', '/dev.html', '/DEV.HTML', '/Dev.html', '/Fixtures/blobs.js', '/FIXTURES/_base.js', '/Panel.js', '/PANEL.HTML', '/.git', '/fixtures/', '/fixtures', '/panel.html%00.css', '/nope.js', '/README.md', '/%ff', '//etc/hosts']) {
      assert.equal((await s.req('GET', p)).status, 404, p);
    }
  } finally {
    await s.close();
  }
  const root = mkdtempSync(join(tmpdir(), 'kadans-web-'));
  const outside = mkdtempSync(join(tmpdir(), 'kadans-out-'));
  writeFileSync(join(root, 'panel.html'), '<p>ok</p>');
  writeFileSync(join(root, 'icon-192.png'), 'png');
  writeFileSync(join(outside, 'secret.js'), 'secret');
  symlinkSync(join(outside, 'secret.js'), join(root, 'panel.js'));
  mkdirSync(join(root, 'icons'));
  writeFileSync(join(root, 'icons', 'a.svg'), '<svg/>');
  writeFileSync(join(root, 'extra.js'), 'x');
  const t = await boot({ webRoot: root });
  try {
    assert.equal((await t.req('GET', '/')).text, '<p>ok</p>');
    assert.equal((await t.req('GET', '/icon-192.png')).status, 200);
    assert.equal((await t.req('GET', '/icons/a.svg')).status, 404, 'not on the allow-list');
    assert.equal((await t.req('GET', '/extra.js')).status, 404, 'not on the allow-list');
    assert.equal((await t.req('GET', '/panel.js')).status, 404, 'symlink out of the root');
    assert.equal((await t.req('GET', '/icons')).status, 404, 'no directory listing');
  } finally {
    await t.close();
  }
});

test('manifest: ?pair=<code> sets start_url /#pair=<code> only for the exact code shape, no-store, and never spends the code', async () => {
  const s = await boot();
  try {
    const plain = await s.req('GET', '/manifest.webmanifest');
    assert.equal(plain.status, 200);
    assert.match(plain.headers['content-type'], /^application\/manifest\+json/);
    assert.equal(plain.headers['cache-control'], 'no-store');
    assert.equal(plain.json.start_url, './');
    assert.equal(plain.json.display, 'standalone');
    const { code, expiresAt } = newPairCode(s.home, s.clock.t);
    assert.ok(expiresAt - s.clock.t === CODE_TTL_MS && CODE_TTL_MS === 10 * 60_000, 'valid 10 minutes');
    const withCode = await s.req('GET', `/manifest.webmanifest?pair=${code}`);
    assert.equal(withCode.status, 200);
    assert.equal(withCode.headers['cache-control'], 'no-store');
    assert.equal(withCode.json.start_url, `/#pair=${code}`);
    assert.deepEqual({ ...withCode.json, start_url: './' }, plain.json, 'otherwise the same manifest');
    assert.equal(Number(withCode.headers['content-length']), Buffer.byteLength(withCode.text));
    assert.equal((await s.req('HEAD', `/manifest.webmanifest?pair=${code}`)).status, 200);
    // not the exact shape: the plain manifest
    for (const q of [`pair=${code.toLowerCase()}`, `pair=${code.slice(1)}`, `pair=${code}A`, `pair=${code.slice(0, 25)}1`, 'pair=', 'x=1',
      `pair=${code}%22,%22scope%22:%22https://evil`, `pair=${code}%23x`, `pair=${encodeURIComponent(`${code}"}`)}`, `pair=${code}&pair=${code}`.replace(/^pair=[A-Z2-7]+/, 'pair=bad')]) {
      const r = await s.req('GET', `/manifest.webmanifest?${q}`);
      assert.equal(r.status, 200, q);
      assert.equal(r.text, plain.text, q);
    }
    // serving it never used the code up: it still pairs once, then not again
    assert.equal((await s.req('POST', '/api/pair', { body: { code, name: 'iPhone' } })).status, 200);
    assert.equal((await s.req('POST', '/api/pair', { body: { code, name: 'iPhone' } })).status, 401, 'single use');
    // the query (the code) never reaches the log
    const log = readFileSync(join(s.home, 'phone-log.jsonl'), 'utf8');
    assert.ok(!log.includes(code) && log.includes('"GET /manifest.webmanifest"'));
  } finally {
    await s.close();
  }
  assert.equal(manifestFor('not json', 'pair=ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'not json');
  assert.equal(manifestFor('[1]', 'pair=ABCDEFGHIJKLMNOPQRSTUVWXYZ'), '[1]');
  assert.equal(JSON.parse(manifestFor('{"a":1}', 'pair=ABCDEFGHIJKLMNOPQRSTUVWXYZ')).start_url, '/#pair=ABCDEFGHIJKLMNOPQRSTUVWXYZ');
});

test('home page: manifest, apple-touch-icon and the home-screen app meta tags are there', async () => {
  const s = await boot();
  try {
    const h = (await s.req('GET', '/')).text;
    for (const re of [/<link rel="manifest" href="manifest\.webmanifest">/, /<link rel="apple-touch-icon" href="apple-touch-icon\.png">/,
      /<meta name="apple-mobile-web-app-capable" content="yes">/, /<meta name="apple-mobile-web-app-status-bar-style" content="default">/]) assert.match(h, re);
    assert.equal((await s.req('GET', '/apple-touch-icon.png')).status, 200);
  } finally {
    await s.close();
  }
});

test('headers: CSP, frame and sniff guards everywhere, no-store on /api, never CORS', async () => {
  const s = await boot();
  try {
    const { token } = await s.pair();
    const rs = [await s.req('GET', '/'), await s.req('GET', '/api/state', { token }), await s.req('GET', '/api/state'), await s.req('GET', '/nope.js')];
    for (const r of rs) {
      const csp = r.headers['content-security-policy'];
      assert.match(csp, /^default-src 'self';/);
      assert.doesNotMatch(csp, /script-src|unsafe-eval|\*/, 'scripts only from this server');
      assert.equal(csp.split(';').filter((d) => d.includes('unsafe-inline')).map((d) => d.trim().split(' ')[0]).join(), 'style-src');
      assert.equal(r.headers['x-frame-options'], 'DENY');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
      assert.ok(!Object.keys(r.headers).some((h) => h.startsWith('access-control-')));
    }
    assert.equal(rs[1].headers['cache-control'], 'no-store');
    assert.equal(rs[2].headers['cache-control'], 'no-store');
  } finally {
    await s.close();
  }
});

test('secrets: token and code never reach a file; phone.json keeps the sha256; the log has time, device, route, status', async () => {
  const s = await boot();
  try {
    const { code, token } = await s.pair();
    s.clock.t += 1000;
    await s.req('GET', '/api/state', { token });
    await s.req('POST', '/api/action', { body: { action: 'stop', id: 'a1' }, token });
    await s.req('GET', `/?pair=${code}`);
    s.clock.t += 61_000;
    await s.req('GET', '/api/state', { token });
    s.server.flushSeen();
    for (const f of readdirSync(s.home)) {
      const p = join(s.home, f);
      if (!statSync(p).isFile()) continue;
      const text = readFileSync(p, 'utf8');
      assert.ok(!text.includes(token), `token in ${f}`);
      assert.ok(!text.includes(code), `code in ${f}`);
      assert.equal(statSync(p).mode & 0o077, 0, `${f} is private`);
    }
    assert.ok(readFileSync(join(s.home, 'phone.json'), 'utf8').includes(sha256(token)));
    const lines = readFileSync(join(s.home, 'phone-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.length >= 5);
    for (const l of lines) assert.deepEqual(Object.keys(l), ['t', 'device', 'route', 'status']);
    const [d] = listDevices(s.home);
    assert.ok(lines.some((l) => l.route === 'POST /api/action' && l.device === d.id && l.status === 200));
    assert.equal(d.lastSeenAt, s.clock.t, 'lastSeenAt written (at most once a minute)');
  } finally {
    await s.close();
  }
});

test('helpers: host choice, why(), agent ids, planAction ids', () => {
  const lo = { family: 'IPv4', address: '127.0.0.1', internal: true };
  assert.deepEqual(pickHost({ lo0: [lo], en0: [{ family: 'IPv4', address: '192.168.1.20', internal: false }], utun3: [{ family: 'IPv4', address: '100.88.1.2', internal: false }] }), { host: '100.88.1.2', via: 'tailscale' });
  assert.deepEqual(pickHost({ lo0: [lo], en1: [{ family: 'IPv4', address: '10.0.0.9', internal: false }], en0: [{ family: 'IPv4', address: '192.168.1.20', internal: false }] }), { host: '192.168.1.20', via: 'lan' });
  assert.equal(pickHost({ lo0: [lo], x: [{ family: 'IPv4', address: '100.200.1.1', internal: false }] }), null, 'not 100.64/10, not private');
  assert.equal(pickHost({}), null);
  assert.equal(why(0, 'x', 'y', false), '');
  assert.equal(why(0, '', '', true), 'It took too long and was given up');
  assert.equal(why(3, 'out line', '\n  \n  kadans: nope  \nmore', false), 'nope');
  assert.equal(why(3, '\nfrom out\n', '', false), 'from out');
  assert.equal(why(3, '', '', false), 'It failed (code 3)');
  assert.equal(why(1, '', 'x'.repeat(300), false).length, 200);
  assert.deepEqual([...agentIds({ agents: [{ id: 'q' }, { id: 4 }] })], ['q']);
  assert.deepEqual([...agentIds('nope')], []);
  assert.equal(planAction({ action: 'stop', id: 'a1' }, new Set()).args, undefined, 'not in the list');
});

test('cliRunner: argument array, no shell, timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kadans-runner-'));
  const script = join(dir, 'echo.mjs');
  writeFileSync(script, "if (process.argv[2] === 'hang') setTimeout(() => {}, 60000); else process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const run = cliRunner({ bin: script });
  const r = await run(['config', 'set', 'notify', '$(touch x); `id` | true']);
  assert.deepEqual(JSON.parse(r.out), ['config', 'set', 'notify', '$(touch x); `id` | true']);
  assert.equal(r.code, 0);
  assert.ok(!existsSync(join(dir, 'x')));
  const h = await run(['hang'], { timeout: 200 });
  assert.equal(h.timedOut, true);
});

// One child process: the real CLI on 127.0.0.1, port 0, temp home. Only pairing routes are hit (no real status/agents).
test('cli: serve refuses while phone is off; serve, pair --json, devices, revoke, SIGTERM', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kadans-cli-serve-'));
  const env = { ...process.env, KADANS_HOME: home, KADANS_ORCA: '0', CLAUDE_CONFIG_DIR: join(home, 'claude') };
  const off = spawnSync(process.execPath, [BIN, 'serve', '--host', '127.0.0.1', '--port', '0'], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(off.status, 2);
  assert.match(off.stderr, /phone control is off/);
  assert.equal(spawnSync(process.execPath, [BIN, 'pair'], { env, encoding: 'utf8' }).status, 2, 'pair needs a running serve');
  assert.equal(spawnSync(process.execPath, [BIN, 'config', 'set', 'phone', 'true'], { env, encoding: 'utf8' }).status, 0);
  const child = spawn(process.execPath, [BIN, 'serve', '--host', '127.0.0.1', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const line = await new Promise((done, fail) => {
      let buf = '';
      child.stdout.on('data', (c) => {
        buf += c;
        if (buf.includes('\n')) done(buf.split('\n')[0]);
      });
      child.on('exit', (c) => fail(new Error(`serve exited ${c}`)));
    });
    const info = JSON.parse(line);
    assert.deepEqual(Object.keys(info), ['url', 'host', 'port', 'pid']);
    assert.equal(info.host, '127.0.0.1');
    assert.equal(info.url, `http://127.0.0.1:${info.port}`);
    assert.equal(info.pid, child.pid);
    assert.equal(statSync(join(home, 'serve.json')).mode & 0o777, 0o600);
    const p = spawnSync(process.execPath, [BIN, 'pair', '--json'], { env, encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
    const pr = JSON.parse(p.stdout);
    assert.match(pr.url, new RegExp(`^http://127\\.0\\.0\\.1:${info.port}/#pair=[A-Z2-7]{26}$`));
    const code = pr.url.split('#pair=')[1];
    const post = (path, body, token) => fetch(`${info.url}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const r = await post('/api/pair', { code, name: 'Test phone' });
    assert.equal(r.status, 200);
    const { token } = await r.json();
    const list = JSON.parse(spawnSync(process.execPath, [BIN, 'devices', '--json'], { env, encoding: 'utf8' }).stdout);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Test phone');
    const rv = spawnSync(process.execPath, [BIN, 'devices', 'revoke', list[0].id], { env, encoding: 'utf8' });
    assert.equal(rv.status, 0);
    assert.equal((await post('/api/state', null, token)).status, 401, 'revoked: refused before anything runs');
    assert.equal(spawnSync(process.execPath, [BIN, 'config', 'set', 'phone', 'false'], { env, encoding: 'utf8' }).status, 0);
    assert.equal((await post('/api/pair', { code, name: 'x' })).status, 503, 'phone off: the API closes even if serve still runs');
    assert.equal(spawnSync(process.execPath, [BIN, 'devices', 'revoke', list[0].id], { env, encoding: 'utf8' }).status, 2);
    const exited = new Promise((done) => child.on('exit', (c, sig) => done({ c, sig })));
    child.kill('SIGTERM');
    assert.deepEqual(await exited, { c: 0, sig: null });
    assert.equal(existsSync(join(home, 'serve.json')), false);
    for (const f of readdirSync(home)) {
      if (statSync(join(home, f)).isFile()) assert.ok(!readFileSync(join(home, f), 'utf8').includes(token), f);
    }
  } finally {
    child.kill('SIGKILL');
  }
});

// k31: rename and reorder on the phone allow-list, with the Mac bridge's validation.
test('planAction: rename and reorder', () => {
  const ids = new Set(['a1', 'a2', 'orca:t3']);
  assert.ok(ALLOWED_ACTIONS.includes('rename') && ALLOWED_ACTIONS.includes('reorder'));
  assert.deepEqual(planAction({ action: 'rename', id: 'a1', title: '  Fix the \u001b[31mlogin\u202e bug ' }, ids), { action: 'rename', id: 'a1', args: ['agent', 'title', 'a1', 'Fix the [31mlogin bug'], timeout: 10_000 });
  assert.deepEqual(planAction({ action: 'rename', id: 'a1', title: '' }, ids).args, ['agent', 'title', 'a1', ''], 'empty clears');
  assert.deepEqual(planAction({ action: 'rename', id: 'a1', title: 'é'.repeat(80) }, ids).args?.[3], 'é'.repeat(80));
  for (const body of [
    { action: 'rename', id: 'a1', title: 'x'.repeat(81) },
    { action: 'rename', id: 'a1', title: '--all' },
    { action: 'rename', id: 'a1', title: 5 },
    { action: 'rename', id: 'a1' },
    { action: 'rename', id: 'zz', title: 'ok' },
    { action: 'rename', id: '-a1', title: 'ok' },
  ]) assert.equal(planAction(body, ids).args, undefined, JSON.stringify(body).slice(0, 60));
  assert.equal(titleArg('\u0007'.repeat(400)), null, 'raw length capped too');
  assert.deepEqual(planAction({ action: 'reorder', ids: ['orca:t3', 'a1'] }, ids), { action: 'reorder', id: '', args: ['agent', 'order', 'orca:t3', 'a1'], timeout: 10_000 });
  for (const list of [[], ['a1', 'a1'], ['a1', 'nope'], ['a1', 7], 'a1', Array.from({ length: 51 }, (_, i) => `x${i}`), undefined]) {
    const p = planAction({ action: 'reorder', ids: list }, ids);
    assert.equal(p.args, undefined, JSON.stringify(list));
    assert.equal(p.id, '');
  }
  const many = new Set(Array.from({ length: 50 }, (_, i) => `x${i}`));
  assert.equal(planAction({ action: 'reorder', ids: [...many] }, many).args.length, 52);
});

test('phone: rename and reorder over HTTP check ids against the current list', async () => {
  const s = await boot();
  try {
    const { token } = await s.pair();
    const ids = [...agentIds(AGENTS)];
    s.clock.t += 1000;
    const r = await s.req('POST', '/api/action', { body: { action: 'rename', id: ids[0], title: 'New name' }, token });
    assert.deepEqual([r.status, r.json.ok], [200, true]);
    s.clock.t += 1000;
    const o = await s.req('POST', '/api/action', { body: { action: 'reorder', ids: [...ids].reverse() }, token });
    assert.deepEqual([o.status, o.json.action, o.json.id, o.json.ok], [200, 'reorder', '', true]);
    s.clock.t += 1000;
    assert.equal((await s.req('POST', '/api/action', { body: { action: 'reorder', ids: ['not-listed'] }, token })).status, 400);
    const acts = s.calls.map((c) => c.args).filter((a) => a[0] === 'agent');
    assert.deepEqual(acts, [['agent', 'title', ids[0], 'New name'], ['agent', 'order', ...[...ids].reverse()]]);
  } finally {
    await s.close();
  }
});

test('server limits and the static allow-list (review k30)', () => {
  const server = createPhoneServer({ home: mkdtempSync(join(tmpdir(), 'kadans-serve-')), run: async () => ({ code: 0, out: '', err: '', timedOut: false }) });
  assert.deepEqual([server.headersTimeout, server.requestTimeout, server.timeout, server.keepAliveTimeout, server.maxConnections], [10_000, 30_000, 30_000, 5_000, 64]);
  assert.deepEqual([...STATIC_FILES].sort(), ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'manifest.webmanifest', 'panel.css', 'panel.html', 'panel.js']);
});
