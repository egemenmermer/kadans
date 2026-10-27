// `kadans serve`: the panel (app/web) and a small JSON API for a paired phone, over node:http only.
// Safe by default: binds one address (Tailscale, else the LAN address, never 0.0.0.0), every /api route but /api/pair
// needs a device token, actions are the Mac bridge's allow-list with the same validation, and run `kadans` with an
// argument array (no shell). Tokens and pair codes are never logged; phone-log.jsonl holds time, device, route, status.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIPv4 } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deviceForToken, redeemCode, cleanName, touchDevices } from './phone.mjs';
import { loadConfig } from './pace.mjs';
import { ensureHome, writeAtomic } from './store.mjs';
import { messageText, SEND_MAX, stripControl } from './text.mjs';

export const DEFAULT_PORT = 7477;
export const WEB_ROOT = fileURLToPath(new URL('../app/web/', import.meta.url));
export const BIN = fileURLToPath(new URL('../bin/kadans.mjs', import.meta.url));
export const PAIR_LIMIT = [5, 60_000]; // attempts per minute per IP
export const TOKEN_LIMIT = [10, 1000]; // requests per second per device
const STATE_CACHE_MS = 1500;
const IDS_MAX_AGE_MS = 15_000;
const MAX_BODY = 4096;
const ACTION_BODY_MAX = 24_576; // k48: room for agent-send's text (4000 characters, up to 4 bytes each, JSON-escaped)
export const SEND_LIMIT = [6, 60_000]; // agent-send messages per device per minute
const MAX_ACTIONS = 3; // actions in flight at once
const SEEN_FLUSH_MS = 60_000;
const LOG_MAX_BYTES = 1_000_000;
const MAX_WHY = 200;

// ---------- host ----------

export const isTailscale = (ip) => {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127; // 100.64.0.0/10
};
const isPrivateLan = (ip) => {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};

// The default address from os.networkInterfaces(): the Tailscale IPv4 if there is one, else the primary LAN IPv4
// (en0 first). null when neither exists. Never 0.0.0.0.
export function pickHost(ifaces) {
  const v4 = [];
  for (const [name, list] of Object.entries(ifaces ?? {})) {
    for (const a of list ?? []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal && isIPv4(a.address)) v4.push({ name, address: a.address });
  }
  const ts = v4.find((a) => isTailscale(a.address));
  if (ts) return { host: ts.address, via: 'tailscale' };
  const lan = v4.filter((a) => isPrivateLan(a.address));
  const pick = lan.find((a) => a.name === 'en0') ?? lan[0];
  return pick ? { host: pick.address, via: 'lan' } : null;
}

// ---------- the Mac bridge, ported from PanelController.swift ----------

// BridgeResult.why: empty on success; else the first non-empty line of stderr (then stdout) without "kadans: ".
export function why(code, out, err, timedOut) {
  if (code === 0 && !timedOut) return '';
  if (timedOut) return 'It took too long and was given up';
  for (const text of [err, out]) {
    for (const line of String(text ?? '').split(/[\n\r\v\f\u0085\u2028\u2029]/)) {
      let l = line.replace(/^[ \t]+|[ \t]+$/g, '');
      if (l.startsWith('kadans: ')) l = l.slice(8);
      if (l) return Array.from(l).slice(0, MAX_WHY).join('');
    }
  }
  return `It failed (code ${code})`;
}

export const bridgeResult = (action, id, r) => ({ action, id, ok: r.code === 0 && !r.timedOut, why: why(r.code, r.out, r.err, r.timedOut) });

// Agent ids in `agents --json` output (a list, or { agents: [...] }).
export function agentIds(agents) {
  const list = Array.isArray(agents) ? agents : Array.isArray(agents?.agents) ? agents.agents : [];
  return new Set(list.map((a) => a?.id).filter((id) => typeof id === 'string'));
}

// A positive integer task id; booleans, strings and fractions are refused.
export function taskId(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 1_000_000_000 || Math.round(v) !== v) return null;
  return v;
}

// A config-set argument: a short plain string that cannot be read as a flag. `kadans config set` does the real check.
export function configArg(v, re) {
  if (typeof v !== 'string' || !v || Array.from(v).length > 64 || v.startsWith('-') || !re.test(v)) return null;
  return v;
}

const agentId = (v, ids) => (typeof v === 'string' && v && !v.startsWith('-') && ids.has(v) ? v : null);

export const ALLOWED_ACTIONS = ['config-set', 'stop', 'compact', 'approve', 'start', 'replace', 'pace', 'rename', 'reorder', 'agent-send'];
export const NEEDS_AGENT = new Set(['stop', 'compact', 'replace', 'pace', 'rename', 'reorder', 'agent-send']);
// k48: an action on another computer's agent looks it up there first (two orca calls), then acts: a longer timeout.
const actTimeout = (id) => (id.startsWith('remote:') ? 25_000 : 10_000);
export const TITLE_MAX = 80;
export const REORDER_MAX = 50;

// A rename title: a string, control and invisible characters stripped (lib/text.mjs), at most TITLE_MAX characters
// (code points) after that; "" clears the title. A title starting with "--" would be read as a flag: refused.
export function titleArg(v) {
  if (typeof v !== 'string' || v.length > 4 * TITLE_MAX) return null;
  const t = stripControl(v).trim();
  if (Array.from(t).length > TITLE_MAX || t.startsWith('--')) return null;
  return t;
}

// body -> { action, id, args, timeout } or { action, id, why } (refused, nothing runs). ids: the current agent ids.
export function planAction(body, ids) {
  const action = body?.action;
  if (typeof action !== 'string' || !ALLOWED_ACTIONS.includes(action)) return { action: '', id: '', why: 'refused: not an allowed action' };
  const rawId = typeof body.id === 'string' ? body.id.slice(0, 100) : typeof body.id === 'number' && Number.isFinite(body.id) ? String(body.id) : '';
  const refuse = (w) => ({ action, id: action === 'config-set' ? (typeof body.key === 'string' ? body.key.slice(0, 64) : '') : rawId, why: `refused: ${w}` });
  switch (action) {
    case 'config-set': {
      const key = configArg(body.key, /^[A-Za-z0-9_.]+$/);
      const value = configArg(body.value, /^[a-z0-9_,:]+$/);
      if (!key || !value) return refuse('key or value is not a short plain string');
      return { action, id: key, args: ['config', 'set', key, value], timeout: 10_000 };
    }
    case 'stop':
    case 'compact': {
      const id = agentId(body.id, ids);
      if (!id) return refuse('id is not in the current agents list');
      return { action, id, args: ['agent', action, id], timeout: actTimeout(id) };
    }
    case 'agent-send': {
      // k48: the text goes to `kadans agent send <id>` on stdin (input), never in args; checked like the CLI checks it.
      const id = agentId(body.id, ids);
      const text = messageText(body.text);
      if (!id || text === null) return refuse(`agent id not in the current list or text is not 1 to ${SEND_MAX} printable characters`);
      return { action, id, args: ['agent', 'send', id], input: text, timeout: actTimeout(id) + 15_000 };
    }
    case 'approve': {
      const t = taskId(body.id);
      if (!t) return refuse('id is not a task number');
      return { action, id: String(t), args: ['approve', String(t)], timeout: 10_000 };
    }
    case 'start': {
      const t = taskId(body.id);
      if (!t) return refuse('id is not a task number');
      return { action, id: String(t), args: ['task', 'start', String(t)], timeout: 45_000 };
    }
    case 'replace': {
      const id = agentId(body.id, ids);
      const t = taskId(body.task);
      if (!id || !t) return refuse('agent id not in the current list or task is not a number');
      return { action, id, args: ['agent', 'replace', id, String(t)], timeout: 45_000 };
    }
    case 'pace': {
      const id = agentId(body.id, ids);
      const mode = body.mode;
      if (!id || !['slow', 'pause', 'none'].includes(mode)) return refuse('agent id not in the current list or mode is not slow, pause or none');
      const args = ['agent', 'pace', id, mode];
      if (Object.hasOwn(body, 'until')) {
        if (mode !== 'pause' || !['reset', '30m'].includes(body.until)) return refuse('until must be reset or 30m, with pause only');
        args.push('--until', body.until);
      }
      return { action, id, args, timeout: 10_000 };
    }
    case 'rename': {
      const id = agentId(body.id, ids);
      const title = titleArg(body.title);
      if (!id || title === null) return refuse(`agent id not in the current list or title is not text of at most ${TITLE_MAX} characters`);
      return { action, id, args: ['agent', 'title', id, title], timeout: 10_000 };
    }
    case 'reorder': {
      // The page's new row order: every id in the current list, no repeats, 1 to REORDER_MAX of them. id in the result: "".
      const list = body.ids;
      const fine = Array.isArray(list) && list.length >= 1 && list.length <= REORDER_MAX && new Set(list).size === list.length && list.every((x) => agentId(x, ids));
      if (!fine) return { action, id: '', why: `refused: ids must be 1 to ${REORDER_MAX} different agent ids from the current list` };
      return { action, id: '', args: ['agent', 'order', ...list], timeout: 10_000 };
    }
    default:
      return { action: '', id: '', why: 'refused: not an allowed action' };
  }
}

// Runs `kadans <args>` as a child process (argument array, no shell). Resolves { code, out, err, timedOut }.
// input: text for the child's stdin (agent-send), else stdin is closed.
export function cliRunner({ bin = BIN, env = process.env, maxBytes = 4_000_000 } = {}) {
  return (args, { timeout = 10_000, input = null } = {}) => new Promise((done) => {
    let out = '';
    let err = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(process.execPath, [bin, ...args], { env, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], shell: false });
      if (input !== null) {
        child.stdin.on('error', () => {}); // a child that exits early closes the pipe: its exit code tells the rest
        child.stdin.end(input);
      }
    } catch (e) {
      done({ code: -1, out: '', err: e.message, timedOut: false });
      return;
    }
    const take = (cur, chunk) => (cur.length < maxBytes ? cur + chunk.toString('utf8').slice(0, maxBytes - cur.length) : cur);
    child.stdout.on('data', (c) => { out = take(out, c); });
    child.stderr.on('data', (c) => { err = take(err, c); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeout);
    child.on('error', (e) => { err = take(err, Buffer.from(e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code: code ?? -1, out, err, timedOut });
    });
  });
}

const parseJson = (r) => {
  if (r.code !== 0 || r.timedOut) return undefined;
  try {
    return JSON.parse(r.out);
  } catch {
    return undefined;
  }
};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------- static files ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
// k31 (review k30): an explicit allow-list of the panel's files, matched with exact case. APFS ignores case, so a
// deny-list (dev.html, fixtures/) let /DEV.HTML through; now the fixture viewer, fixtures and anything new are 404.
// A new file under app/web must be added here to reach the phone.
export const STATIC_FILES = new Set(['panel.html', 'panel.js', 'panel.css', 'manifest.webmanifest', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']);

// A file under webRoot for a request path, or null (traversal, hidden, unknown type, directory, outside the root).
// k29: the manifest for a home-screen app added from the pairing page. iOS keeps a home-screen app's storage apart from
// Safari's, so the page links manifest.webmanifest?pair=<code> and the app starts at /#pair=<code> and pairs itself.
// Only the exact pair-code shape is copied (no lookup: serving it never spends, checks or reveals a code); anything
// else gets the plain manifest. The query never reaches the request log (the route is the path alone).
export const PAIR_CODE_RE = /^[A-Z2-7]{26}$/;
export function manifestFor(text, query) {
  let code = null;
  try {
    const c = new URLSearchParams(query ?? '').get('pair');
    if (c && PAIR_CODE_RE.test(c)) code = c;
  } catch {
    code = null;
  }
  if (!code) return text;
  try {
    const m = JSON.parse(text);
    if (!m || typeof m !== 'object' || Array.isArray(m)) return text;
    return `${JSON.stringify({ ...m, start_url: `/#pair=${code}` }, null, 2)}\n`;
  } catch {
    return text;
  }
}

export function staticFile(webRoot, rawPath) {
  let p;
  try {
    p = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (p === '/') p = '/panel.html';
  if (!p.startsWith('/') || p.includes('\0') || p.includes('\\')) return null;
  const segs = p.slice(1).split('/');
  if (segs.length !== 1 || !STATIC_FILES.has(segs[0])) return null;
  const type = TYPES[extname(p).toLowerCase()];
  if (!type) return null;
  try {
    const root = realpathSync(webRoot);
    const real = realpathSync(resolve(root, ...segs));
    if (!real.startsWith(root + sep)) return null;
    const st = statSync(real);
    if (!st.isFile() || st.size > 5_000_000) return null;
    return { file: real, type };
  } catch {
    return null;
  }
}

// ---------- server ----------

function limiter(max, windowMs) {
  const hits = new Map();
  return (key, t) => {
    const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    const ok = list.length < max;
    if (ok) list.push(t);
    hits.set(key, list);
    if (hits.size > 1000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
    return ok;
  };
}

const HEADERS = {
  // Scripts, images, fetches: this server only. Inline style attributes stay allowed because the panel builds its
  // gauges and blobs with style="..." markup; styles cannot run code, and the panel escapes every text it inserts.
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

// Appends one line to phone-log.jsonl (0600); past LOG_MAX_BYTES it moves to phone-log.1.jsonl first.
export function logRequest(home, entry) {
  const file = join(home, 'phone-log.jsonl');
  try {
    if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, join(home, 'phone-log.1.jsonl'));
  } catch {
    // no log yet
  }
  try {
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // logging never breaks a request
  }
}

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

function readBody(req, max = MAX_BODY) {
  return new Promise((done, fail) => {
    if (!/^application\/json(;|$)/i.test(req.headers['content-type'] ?? '')) {
      fail(new HttpError(415, 'json_only'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        req.removeAllListeners('data');
        req.resume(); // drain the rest unread, then answer
        fail(new HttpError(413, 'too_large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!isObj(v)) throw new Error('not an object');
        done(v);
      } catch {
        fail(new HttpError(400, 'bad_json'));
      }
    });
    req.on('error', () => fail(new HttpError(400, 'bad_request')));
  });
}

// The phone server. run(args, {timeout}) -> Promise<{code,out,err,timedOut}> runs `kadans`; tests pass a fake.
// now() is injectable for the rate limits and code expiry. Listen with server.listen(port, host).
// requirePhone: every /api route answers 503 once config phone is false, even if nobody stopped the server.
export function createPhoneServer({ home, run = cliRunner(), webRoot = WEB_ROOT, now = Date.now, requirePhone = false } = {}) {
  ensureHome(home);
  const pairLimit = limiter(...PAIR_LIMIT);
  const tokenLimit = limiter(...TOKEN_LIMIT);
  const sendLimit = limiter(...SEND_LIMIT);
  let stateCache = null;
  let stateFlight = null;
  let ids = { at: -Infinity, set: new Set() };
  let actions = 0;
  const seen = {};
  const flushed = {};

  const flushSeen = (force) => {
    const due = Object.fromEntries(Object.entries(seen).filter(([id, t]) => force || t - (flushed[id] ?? 0) >= SEEN_FLUSH_MS));
    if (!Object.keys(due).length) return;
    touchDevices(home, due);
    for (const [id, t] of Object.entries(due)) {
      flushed[id] = t;
      delete seen[id];
    }
  };

  // status, agents, config: the same three reads PanelController.refresh(full: true) makes, one after the other.
  // Shared by every device and kept STATE_CACHE_MS, so polling phones never stack up `kadans` processes.
  const readState = () => {
    if (stateCache && now() - stateCache.at < STATE_CACHE_MS) return Promise.resolve(stateCache.value);
    stateFlight ??= (async () => {
      const s = await run(['status', '--json'], { timeout: 10_000 });
      const a = await run(['agents', '--json'], { timeout: 10_000 });
      const c = await run(['config', 'get', '--json'], { timeout: 10_000 });
      const status = parseJson(s);
      const agents = parseJson(a) ?? [];
      const config = parseJson(c);
      const value = { status: isObj(status) ? status : null, agents };
      if (isObj(config)) value.config = config;
      ids = { at: now(), set: agentIds(agents) };
      stateCache = { at: now(), value };
      return value;
    })().finally(() => {
      stateFlight = null;
    });
    return stateFlight;
  };

  const currentIds = async () => {
    if (now() - ids.at < IDS_MAX_AGE_MS) return ids.set;
    const a = await run(['agents', '--json'], { timeout: 10_000 });
    ids = { at: now(), set: agentIds(parseJson(a) ?? []) };
    return ids.set;
  };

  const auth = (req) => {
    const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization ?? '');
    return m ? deviceForToken(home, m[1]) : null;
  };

  // k31 (review k30): slow or idle clients cannot hold sockets open. The header and request timeouts are checked every
  // connectionsCheckingInterval, which only createServer's options can set.
  const server = createServer({ headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 5_000, connectionsCheckingInterval: 2_000 }, (req, res) => {
    const ctx = { device: null, route: '' };
    const raw = String(req.url ?? '').split('?')[0];
    ctx.route = `${req.method} ${stripControl(raw).slice(0, 100)}`;
    res.on('finish', () => logRequest(home, { t: now(), device: ctx.device, route: ctx.route, status: res.statusCode }));
    const api = raw === '/api' || raw.startsWith('/api/');
    const send = (status, body, extra = {}) => {
      const text = body === undefined ? '' : JSON.stringify(body);
      res.writeHead(status, {
        ...HEADERS,
        ...(api ? { 'Cache-Control': 'no-store' } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
        ...extra,
      });
      res.end(text);
    };
    handle(req, res, ctx, raw, api, send).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) send(e.status, { error: e.message });
      else send(500, { error: 'server_error' });
    });
  });

  // Requests must name this server (Host = the bound address), which also stops DNS-rebinding pages.
  const hostOk = (req) => {
    const a = server.address();
    if (!a || typeof a !== 'object') return false;
    const h = String(req.headers.host ?? '').toLowerCase();
    const ok = [`${a.address}:${a.port}`];
    if (a.address === '127.0.0.1') ok.push(`localhost:${a.port}`);
    return ok.includes(h);
  };

  async function handle(req, res, ctx, raw, api, send) {
    if (!hostOk(req)) return send(421, { error: 'wrong_host' });
    if (req.method === 'OPTIONS') return send(405, { error: 'method' });
    if (!api) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'method' });
      const f = staticFile(webRoot, raw);
      if (!f) return send(404, { error: 'not_found' });
      let data = readFileSync(f.file);
      const manifest = raw === '/manifest.webmanifest';
      if (manifest) {
        const q = String(req.url ?? '').split('?').slice(1).join('?');
        data = Buffer.from(manifestFor(data.toString('utf8'), q), 'utf8');
      }
      res.writeHead(200, { ...HEADERS, 'Content-Type': f.type, 'Content-Length': data.length, 'Cache-Control': manifest ? 'no-store' : 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : data);
    }
    if (requirePhone && !loadConfig(home).phone) return send(503, { error: 'phone_off' });
    if (raw === '/api/pair') {
      if (req.method !== 'POST') return send(405, { error: 'method' });
      if (!pairLimit(req.socket.remoteAddress ?? '?', now())) return send(429, { error: 'too_many_attempts' });
      const body = await readBody(req);
      const name = Object.hasOwn(body, 'name') ? cleanName(body.name) : 'Phone';
      if (!name) return send(400, { error: 'bad_name' });
      if (typeof body.code !== 'string' || body.code.length > 64) return send(401, { error: 'bad_code' });
      let r;
      try {
        r = redeemCode(home, body.code, name, now());
      } catch {
        return send(503, { error: 'busy' });
      }
      if (r.error === 'too_many') return send(403, { error: 'too_many_devices' });
      if (r.error) return send(401, { error: 'bad_code' });
      ctx.device = r.device.id;
      return send(200, { token: r.token });
    }
    if (raw !== '/api/state' && raw !== '/api/action') return send(404, { error: 'not_found' });
    const device = auth(req);
    if (!device) return send(401, { error: 'unauthorized' });
    ctx.device = device.id;
    if (!tokenLimit(device.id, now())) return send(429, { error: 'too_many_requests' });
    seen[device.id] = now();
    flushSeen(false);
    if (raw === '/api/state') {
      if (req.method !== 'GET') return send(405, { error: 'method' });
      return send(200, await readState());
    }
    if (req.method !== 'POST') return send(405, { error: 'method' });
    const body = await readBody(req, ACTION_BODY_MAX); // after auth: only a paired device may send the larger body
    const plan = planAction(body, NEEDS_AGENT.has(body.action) ? await currentIds() : new Set());
    if (!plan.args) return send(400, { action: plan.action, id: plan.id, ok: false, why: plan.why });
    if (plan.action === 'agent-send' && !sendLimit(device.id, now())) return send(429, { action: plan.action, id: plan.id, ok: false, why: 'Too many messages; wait a minute' });
    if (actions >= MAX_ACTIONS) return send(429, { action: plan.action, id: plan.id, ok: false, why: 'Too many actions at once; try again' });
    actions++;
    try {
      const r = await run(plan.args, { timeout: plan.timeout, input: plan.input ?? null }); // the text: stdin only, never logged
      stateCache = null; // the next poll shows the result, as the Mac refreshes after an action
      ids.at = -Infinity;
      return send(200, bridgeResult(plan.action, plan.id, r));
    } finally {
      actions--;
    }
  }

  server.maxConnections = 64; // at most 64 connections at once
  server.setTimeout(30_000); // a socket idle this long is closed
  server.flushSeen = () => flushSeen(true);
  return server;
}

// ---------- serve.json ----------

export const serveFile = (home) => join(home, 'serve.json');

export function writeServeInfo(home, info) {
  ensureHome(home);
  writeAtomic(serveFile(home), `${JSON.stringify(info)}\n`);
}

// serve.json of a running serve (its pid is alive), else null.
export function readServeInfo(home) {
  let info;
  try {
    info = JSON.parse(readFileSync(serveFile(home), 'utf8'));
  } catch {
    return null;
  }
  if (!isObj(info) || !Number.isInteger(info.pid) || typeof info.host !== 'string' || !Number.isInteger(info.port)) return null;
  try {
    process.kill(info.pid, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return null;
  }
  return info;
}

// Removes serve.json if it still names this process.
export function clearServeInfo(home, pid = process.pid) {
  try {
    if (JSON.parse(readFileSync(serveFile(home), 'utf8')).pid === pid) rmSync(serveFile(home), { force: true });
  } catch {
    // already gone
  }
}
