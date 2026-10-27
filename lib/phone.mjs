// Phone pairing store ($KADANS_HOME/phone.json): one-time pair codes and paired devices. Codes and tokens are kept only
// as sha256 hashes; the raw values exist in memory for one request and are never logged or written.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureHome, withLock, writeAtomic } from './store.mjs';
import { stripControl } from './text.mjs';

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_DEVICES = 10;
export const MAX_NAME = 40;
// The server holds the store lock only briefly; hooks wait 2 s for it, so never block the event loop longer.
const SERVE_LOCK_WAIT_MS = 2000;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// RFC 4648 base32, upper case, no padding: 16 bytes -> 26 characters.
export function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

// Constant-time match of a presented secret against stored sha256 hex hashes. Every stored hash is compared (no early
// exit), and the presented value is hashed first, so the time does not depend on where or whether it matches.
export function matchHash(secret, hashes) {
  const want = createHash('sha256').update(String(secret), 'utf8').digest();
  let found = -1;
  hashes.forEach((h, i) => {
    const have = /^[0-9a-f]{64}$/.test(h ?? '') ? Buffer.from(h, 'hex') : Buffer.alloc(32);
    if (timingSafeEqual(want, have) && found === -1) found = i;
  });
  return found;
}

// A pair code as typed or scanned: base32 letters only (spaces and dashes dropped), upper case.
export const normCode = (s) => String(s ?? '').replace(/[\s-]/g, '').toUpperCase();

// A device name for the list: control and invisible characters removed, at most MAX_NAME code points.
export function cleanName(v) {
  if (typeof v !== 'string') return null;
  const s = stripControl(v).replace(/[\n\t]/g, ' ').trim();
  if (!s || Array.from(s).length > MAX_NAME) return null;
  return s;
}

const file = (home) => join(home, 'phone.json');

export function readPhone(home) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file(home), 'utf8'));
  } catch {
    raw = {};
  }
  const ok = raw && typeof raw === 'object' && !Array.isArray(raw);
  const devices = ok && Array.isArray(raw.devices) ? raw.devices.filter((d) => d && typeof d.id === 'string' && typeof d.tokenHash === 'string') : [];
  const codes = ok && Array.isArray(raw.codes) ? raw.codes.filter((c) => c && typeof c.hash === 'string' && Number.isFinite(c.expiresAt)) : [];
  return { version: 1, devices, codes };
}

function writePhone(home, data) {
  writeAtomic(file(home), `${JSON.stringify(data, null, 2)}\n`);
}

function update(home, fn, waitMs) {
  ensureHome(home);
  return withLock(home, () => {
    const data = readPhone(home);
    const r = fn(data);
    writePhone(home, data);
    return r;
  }, waitMs ? { waitMs } : undefined);
}

// A new one-time code; it replaces any earlier unused code. Returns { code, expiresAt }; the caller shows the code once.
export function newPairCode(home, now = Date.now()) {
  const code = base32(randomBytes(16));
  const expiresAt = now + CODE_TTL_MS;
  update(home, (d) => {
    d.codes = [{ hash: sha256(code), expiresAt }];
  });
  return { code, expiresAt };
}

// Spends a pair code and adds a device. Returns { device, token } or { error: 'bad_code' | 'too_many' }.
// Wrong, expired and already used codes all read as bad_code. The code is spent only on success.
export function redeemCode(home, code, name, now = Date.now()) {
  return update(home, (d) => {
    d.codes = d.codes.filter((c) => c.expiresAt > now);
    const i = matchHash(normCode(code), d.codes.map((c) => c.hash));
    if (i === -1) return { error: 'bad_code' };
    if (d.devices.length >= MAX_DEVICES) return { error: 'too_many' };
    d.codes.splice(i, 1);
    const token = randomBytes(32).toString('base64url');
    const device = { id: randomBytes(6).toString('hex'), name, tokenHash: sha256(token), createdAt: now, lastSeenAt: now };
    d.devices.push(device);
    return { device: publicDevice(device), token };
  }, SERVE_LOCK_WAIT_MS);
}

export const publicDevice = (d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt });

// The device a bearer token belongs to, or null. Reads phone.json each time, so a revoke takes effect at once.
export function deviceForToken(home, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const { devices } = readPhone(home);
  const i = matchHash(token, devices.map((d) => d.tokenHash));
  return i === -1 ? null : devices[i];
}

export function listDevices(home) {
  return readPhone(home).devices.map(publicDevice);
}

// Removes a device; true when it existed. Its token stops working on the next request.
export function revokeDevice(home, id) {
  return update(home, (d) => {
    const n = d.devices.length;
    d.devices = d.devices.filter((x) => x.id !== id);
    return d.devices.length < n;
  });
}

// Records lastSeenAt for devices (id -> ms). Best effort: a busy lock skips this round.
export function touchDevices(home, seen) {
  try {
    update(home, (d) => {
      for (const x of d.devices) if (seen[x.id] > (x.lastSeenAt ?? 0)) x.lastSeenAt = seen[x.id];
    }, SERVE_LOCK_WAIT_MS);
  } catch {
    // lock busy: the next round writes it
  }
}
