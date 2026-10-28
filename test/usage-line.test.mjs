import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUsageLine, writeUsageLine } from '../lib/usage-line.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'kadans-uline-'));
const NOW = 1_800_000_000_000;
const lim = (o = {}) => ({ name: 'five_hour', state: 'cruise', pct: 40.4, rate: 0.5, projection: 60, resetsAt: NOW + 3_600_000, ...o });
const res = (o = {}, l = {}) => ({ state: 'cruise', limit: null, limits: [lim(l)], ...o });
const read = (home) => JSON.parse(readFileSync(join(home, 'usage-line.json'), 'utf8'));

test('usage-line: exact shape, nothing else in the file', () => {
  const home = tmp();
  assert.equal(writeUsageLine(home, res(), NOW), true);
  const o = read(home);
  assert.deepEqual(Object.keys(o), ['v', 'pct', 'limit', 'state', 'resetsAt', 'runsOutAt', 'at']);
  assert.deepEqual(o, { v: 1, pct: 40, limit: '5h', state: 'cruise', resetsAt: NOW + 3_600_000, runsOutAt: null, at: NOW });
});

test('usage-line: mode 0600, no temp file left behind, works in a fresh home', () => {
  const home = join(tmp(), 'fresh', 'home');
  assert.equal(existsSync(home), false);
  assert.equal(writeUsageLine(home, res(), NOW), true);
  if (process.platform !== 'win32') assert.equal(statSync(join(home, 'usage-line.json')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(home), ['usage-line.json']);
});

test('usage-line: atomic, written through a temp name in the same dir and renamed', async () => {
  const src = readFileSync(new URL('../lib/store.mjs', import.meta.url), 'utf8');
  assert.match(src, /\$\{file\}\.\$\{process\.pid\}\.tmp/);
  assert.match(src, /renameRetry\(tmp, file\)/);
  const home = tmp();
  writeUsageLine(home, res(), NOW);
  const before = statSync(join(home, 'usage-line.json')).ino;
  writeUsageLine(home, res({}, { pct: 70 }), NOW + 1);
  // a rename gives the path a new file, never an in-place rewrite; always complete JSON
  if (process.platform !== 'win32') assert.notEqual(statSync(join(home, 'usage-line.json')).ino, before);
  assert.equal(read(home).pct, 70);
});

test('usage-line: no write when only at would change', () => {
  const home = tmp();
  writeUsageLine(home, res(), NOW);
  const f = join(home, 'usage-line.json');
  const old = new Date(1_000_000);
  utimesSync(f, old, old);
  assert.equal(writeUsageLine(home, res(), NOW + 60_000), false);
  assert.equal(writeUsageLine(home, res({}, { pct: 40.2 }), NOW + 90_000), false); // same rounded integer
  assert.equal(statSync(f).mtimeMs, 1_000_000);
  assert.equal(read(home).at, NOW);
});

test('usage-line: a write when pct, state, limit, resetsAt or runsOutAt changes', () => {
  const home = tmp();
  writeUsageLine(home, res(), NOW);
  assert.equal(writeUsageLine(home, res({}, { pct: 41.6 }), NOW + 1), true);
  assert.equal(read(home).pct, 42);
  assert.equal(writeUsageLine(home, res({ state: 'brake', limit: 'five_hour' }, { pct: 41.6 }), NOW + 2), true);
  assert.equal(read(home).state, 'brake');
  assert.equal(writeUsageLine(home, res({ state: 'brake', limit: 'five_hour' }, { pct: 41.6, resetsAt: NOW + 5 }), NOW + 3), true);
  const run = { pct: 41.6, projection: 120, resetsAt: NOW + 5 };
  assert.equal(writeUsageLine(home, res({ state: 'brake', limit: 'five_hour' }, run), NOW + 4), true);
  assert.equal(read(home).runsOutAt % 60_000, 0);
  assert.ok(read(home).runsOutAt > NOW);
  const both = { state: 'cruise', limit: null, limits: [lim({ name: 'seven_day', pct: 10 })] };
  assert.equal(writeUsageLine(home, both, NOW + 5), true);
  assert.equal(read(home).limit, '7d');
});

test('usage-line: unknown state when data is missing, nothing written without a 5h/7d reading', () => {
  assert.equal(buildUsageLine(null, NOW), null);
  assert.equal(buildUsageLine({ state: 'unknown', limit: null, limits: [{ name: 'five_hour', state: 'nodata' }] }, NOW), null);
  assert.equal(buildUsageLine({ state: 'cruise', limit: null, limits: [lim({ name: 'codex_primary' })] }, NOW), null);
  const u = buildUsageLine({ state: 'unknown', limit: null, limits: [lim({ state: 'unknown' })] }, NOW);
  assert.equal(u.state, 'unknown');
  assert.equal(u.runsOutAt, null);
  const ended = buildUsageLine(res({ state: 'unknown' }, { ended: true, resetsAt: NOW - 1 }), NOW);
  assert.equal(ended.state, 'unknown');
  assert.equal(buildUsageLine(res({ state: 'early' }), NOW).state, 'cruise');
  const home = tmp();
  assert.equal(writeUsageLine(home, null, NOW), false);
  assert.equal(existsSync(join(home, 'usage-line.json')), false);
});

test('usage-line: a corrupt old file is replaced, pct is clamped', () => {
  const home = tmp();
  writeFileSync(join(home, 'usage-line.json'), '{"v":1,');
  assert.equal(writeUsageLine(home, res(), NOW), true);
  assert.equal(read(home).pct, 40);
  assert.equal(buildUsageLine(res({}, { pct: 140 }), NOW).pct, 100);
  assert.equal(buildUsageLine(res({}, { pct: -3 }), NOW).pct, 0);
});
