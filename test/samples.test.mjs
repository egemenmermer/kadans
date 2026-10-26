import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountKey, appendSample, KEEP_MS, listAccounts, readSamples, sampleFromPayload } from '../lib/samples.mjs';

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

test('accountKey is the first 12 hex of sha1 of the config dir string', () => {
  const dir = '/some/where/.claude';
  const key = accountKey(dir);
  assert.match(key, /^[0-9a-f]{12}$/);
  assert.equal(key, createHash('sha1').update(dir).digest('hex').slice(0, 12));
  assert.notEqual(accountKey('/other'), key);
});

test('sampleFromPayload: no rate_limits gives null', () => {
  assert.equal(sampleFromPayload({ session_id: 'x' }, NOW), null);
  assert.equal(sampleFromPayload(null, NOW), null);
  assert.equal(sampleFromPayload({ rate_limits: {} }, NOW), null);
});

test('sampleFromPayload: seconds, ms and ISO resets_at; only the present limits kept', () => {
  const sec = Math.floor(NOW / 1000) + 3600;
  const s = sampleFromPayload(
    { session_id: 's1', cwd: '/w', rate_limits: { five_hour: { used_percentage: 59, resets_at: sec }, seven_day: { used_percentage: '5', resets_at: sec } } },
    NOW,
  );
  assert.deepEqual(s.limits, { five_hour: { pct: 59, resetsAt: sec * 1000 } });
  assert.equal(s.t, NOW);
  assert.equal(s.session_id, 's1');
  const iso = sampleFromPayload({ rate_limits: { five_hour: { used_percentage: 1, resets_at: '2026-10-25T13:00:00Z' } } }, NOW);
  assert.equal(iso.limits.five_hour.resetsAt, Date.parse('2026-10-25T13:00:00Z'));
  const ms = sampleFromPayload({ rate_limits: { five_hour: { used_percentage: 1, resets_at: NOW + 5000 } } }, NOW);
  assert.equal(ms.limits.five_hour.resetsAt, NOW + 5000);
});

test('append writes one JSON line per sample and reads back in time order', () => {
  const home = mkdtempSync(join(tmpdir(), 'kadans-s-'));
  const key = 'abcdef012345';
  const mk = (t, pct) => ({ t, session_id: null, cwd: null, limits: { five_hour: { pct, resetsAt: NOW + 3600e3 } } });
  appendSample(home, key, mk(NOW, 2), NOW);
  appendSample(home, key, mk(NOW - 60e3, 1), NOW);
  const file = join(home, 'accounts', key, 'samples.jsonl');
  const lines = readFileSync(file, 'utf8').split('\n');
  assert.equal(lines.length, 3); // two lines plus trailing newline
  assert.equal(lines[2], '');
  const back = readSamples(home, key);
  assert.deepEqual(back.map((s) => s.limits.five_hour.pct), [1, 2]);
  assert.deepEqual(listAccounts(home), [key]);
});

test('samples older than 8 days are trimmed on append; malformed lines are skipped', () => {
  const home = mkdtempSync(join(tmpdir(), 'kadans-t-'));
  const key = 'k1';
  appendSample(home, key, { t: NOW - KEEP_MS - 1000, limits: { five_hour: { pct: 9, resetsAt: NOW } } }, NOW - KEEP_MS - 1000);
  appendFileSync(join(home, 'accounts', key, 'samples.jsonl'), 'garbage{\n');
  appendSample(home, key, { t: NOW, limits: { five_hour: { pct: 3, resetsAt: NOW + 1000 } } }, NOW);
  const back = readSamples(home, key);
  assert.equal(back.length, 1);
  assert.equal(back[0].limits.five_hour.pct, 3);
  assert.equal(readFileSync(join(home, 'accounts', key, 'samples.jsonl'), 'utf8').split('\n').length, 2);
});
