import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN, DEFAULTS, currentWindow, limitState, loadConfig, overall } from '../lib/pace.mjs';

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const CFG = { ...DEFAULTS, targets: { ...DEFAULTS.targets } };
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// specs: { limitName: { used, slope (pct per min), resetsAt } }; values at minute m before now are used - slope * m.
function build(specs, { spanMin = 60, stepMin = 5, now = NOW } = {}) {
  const out = [];
  for (let m = spanMin; m >= 0; m -= stepMin) {
    const limits = {};
    for (const [name, s] of Object.entries(specs)) limits[name] = { pct: s.used - s.slope * m, resetsAt: s.resetsAt };
    out.push({ t: now - m * MIN, limits });
  }
  return out;
}

const FIVE_IN_2H = NOW + 2 * 60 * MIN;

test('steady linear use projects gas', () => {
  const s = build({ five_hour: { used: 60, slope: 0.2, resetsAt: FIVE_IN_2H } });
  const v = limitState(s, 'five_hour', NOW, CFG);
  close(v.pct, 60);
  close(v.rate, 0.2);
  close(v.needle, 0.2);
  close(v.projection, 84); // 60 + 0.2 * 120 min left
  assert.equal(v.state, 'gas');
});

test('burst in the last minutes raises the needle above the base rate', () => {
  const s = [];
  for (const [m, pct] of [[60, 40], [45, 40], [30, 40], [15, 40], [10, 40], [5, 45], [0, 50]]) {
    s.push({ t: NOW - m * MIN, limits: { five_hour: { pct, resetsAt: FIVE_IN_2H } } });
  }
  const v = limitState(s, 'five_hour', NOW, CFG);
  close(v.needle, 0.7);
  close(v.rate, 0.7); // 4 recent points spanning 15 min: needle is used
  assert.equal(v.state, 'brake');
});

test('integer-quantised percentages still give a sensible rate', () => {
  const s = [];
  for (let m = 180; m >= 0; m--) {
    s.push({ t: NOW - (180 - m) * MIN, limits: { five_hour: { pct: Math.floor(0.1 * m), resetsAt: NOW + 2 * 60 * MIN } } });
  }
  // time since window start: m runs from 0 (start) to 180 (now); pct = floor(0.1 * elapsed minutes)
  const v = limitState(s, 'five_hour', NOW, CFG);
  close(v.pct, 18);
  assert.ok(Math.abs(v.rate - 0.1) < 0.02, `rate ${v.rate}`);
  assert.equal(v.state, 'gas');
});

test('new resets_at starts a new window; a lower pct in the same window is a stale sample', () => {
  const oldEnd = NOW - 60 * MIN;
  const old = [];
  for (let m = 180; m >= 60; m -= 20) old.push({ t: NOW - m * MIN, limits: { five_hour: { pct: 90, resetsAt: oldEnd } } });
  const newEnd = NOW + 4 * 60 * MIN;
  const fresh = [];
  for (let m = 50; m >= 0; m -= 10) fresh.push({ t: NOW - m * MIN, limits: { five_hour: { pct: 5 - m / 10, resetsAt: newEnd } } });
  const w = currentWindow([...old, ...fresh], 'five_hour');
  assert.equal(w.end, newEnd);
  assert.equal(w.pts.length, fresh.length);
  assert.equal(limitState([...old, ...fresh], 'five_hour', NOW, CFG).pct, 5);

  // same resets_at, an idle session reports an old lower value (seen live: 68 then 59 in the same second)
  const same = [
    { t: NOW - 30 * MIN, limits: { five_hour: { pct: 60, resetsAt: newEnd } } },
    { t: NOW - 20 * MIN, limits: { five_hour: { pct: 68, resetsAt: newEnd } } },
    { t: NOW - 20 * MIN, limits: { five_hour: { pct: 59, resetsAt: newEnd } } },
    { t: NOW, limits: { five_hour: { pct: 70, resetsAt: newEnd } } },
  ];
  const w2 = currentWindow(same, 'five_hour');
  assert.deepEqual(w2.pts.map((p) => p.pct), [60, 68, 70]);
  assert.equal(w2.last.pct, 70);
});

test('no seven_day in the data: auto uses only five_hour', () => {
  const s = build({ five_hour: { used: 20, slope: 0.01, resetsAt: FIVE_IN_2H } });
  const res = overall(s, NOW, CFG);
  assert.deepEqual(res.limits.map((v) => v.name), ['five_hour']);
  assert.equal(res.state, 'gas'); // 20 + 0.01 * 120 = 21.2, below 87
});

test('both limits: gas only if every limit says gas, brake if any does', () => {
  const sevenEnd = NOW + 3 * 24 * 60 * MIN;
  const gasFive = { used: 60, slope: 0.2, resetsAt: FIVE_IN_2H };
  const gasSeven = { used: 20, slope: 0.01, resetsAt: sevenEnd };
  const cruiseSeven = { used: 50, slope: 0.01, resetsAt: sevenEnd };
  const brakeSeven = { used: 80, slope: 0.05, resetsAt: sevenEnd };

  const both = overall(build({ five_hour: gasFive, seven_day: gasSeven }), NOW, CFG);
  assert.equal(both.state, 'gas');
  assert.equal(both.limit, 'seven_day'); // worst projection: 20 + 0.01 * 4320 = 63.2

  assert.equal(overall(build({ five_hour: gasFive, seven_day: cruiseSeven }), NOW, CFG).state, 'cruise');

  const brake = overall(build({ five_hour: gasFive, seven_day: brakeSeven }), NOW, CFG);
  assert.equal(brake.state, 'brake');
  assert.equal(brake.limit, 'seven_day');
});

test('explicit limits list ignores the other limit and marks missing data as nodata', () => {
  const s = build({ five_hour: { used: 20, slope: 0.01, resetsAt: FIVE_IN_2H } });
  const cfg = { ...CFG, limits: ['five_hour', 'seven_day'] };
  const res = overall(s, NOW, cfg);
  assert.equal(res.limits[1].state, 'nodata');
  assert.equal(res.state, 'cruise');
});

test('too little data is unknown', () => {
  const one = build({ five_hour: { used: 20, slope: 0.01, resetsAt: FIVE_IN_2H } }, { spanMin: 0 });
  assert.equal(limitState(one, 'five_hour', NOW, CFG).state, 'unknown');
  assert.equal(overall(one, NOW, CFG).state, 'unknown');
  assert.equal(overall([], NOW, CFG).state, 'unknown');
});

test('a window that has already reset is unknown until a new sample arrives', () => {
  const s = build({ five_hour: { used: 60, slope: 0.2, resetsAt: NOW - MIN } });
  const v = limitState(s, 'five_hour', NOW, CFG);
  assert.equal(v.state, 'unknown');
  assert.equal(v.ended, true);
});

test('brake takes precedence even on a thin sample', () => {
  const s = build({ five_hour: { used: 99, slope: 0, resetsAt: FIVE_IN_2H } }, { spanMin: 0 });
  const v = limitState(s, 'five_hour', NOW, CFG);
  assert.equal(v.state, 'brake');
  assert.equal(v.brakeAt, NOW);
});

test('loadConfig: defaults, partial overrides, broken file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kadans-cfg-'));
  let cfg = loadConfig(dir);
  assert.equal(cfg.lang, 'en');
  assert.equal(cfg.limits, 'auto');
  assert.deepEqual(cfg.targets, { five_hour: 97, seven_day: 98 });

  writeFileSync(join(dir, 'config.json'), JSON.stringify({ lang: 'tr', limits: ['five_hour'], slack: 5, targets: { seven_day: 95 }, lang2: 1 }));
  cfg = loadConfig(dir);
  assert.equal(cfg.lang, 'tr');
  assert.deepEqual(cfg.limits, ['five_hour']);
  assert.equal(cfg.slack, 5);
  assert.deepEqual(cfg.targets, { five_hour: 97, seven_day: 95 });

  writeFileSync(join(dir, 'config.json'), '{not json');
  assert.equal(loadConfig(dir).lang, 'en');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ lang: 'de', limits: ['month'] }));
  cfg = loadConfig(dir);
  assert.equal(cfg.lang, 'en');
  assert.equal(cfg.limits, 'auto');
});

// Warm-up: a window that is brand new (< 20 min and < 20 % used) cannot brake yet.
test('warm-up: early warning before 10 min or 10 % used; brake right after', () => {
  const young = (elapsedMin, used) => {
    const resetsAt = NOW + (300 - elapsedMin) * MIN;
    return build({ five_hour: { used, slope: 1, resetsAt } }, { spanMin: 6, stepMin: 2 }); // 1 %/min: projection far above 98
  };
  let v = limitState(young(8, 8), 'five_hour', NOW, CFG);
  assert.equal(v.state, 'early'); // on course to run out, but held back from braking
  assert.ok(v.projection >= 98);
  assert.equal(overall(young(8, 8), NOW, CFG).state, 'early');
  v = limitState(young(12, 8), 'five_hour', NOW, CFG); // 10 min passed
  assert.equal(v.state, 'brake');
  v = limitState(young(6, 10), 'five_hour', NOW, CFG); // 10 % used
  assert.equal(v.state, 'brake');
  v = limitState(young(6, 9.9), 'five_hour', NOW, CFG);
  assert.notEqual(v.state, 'brake');
});

test('warm-up: too little data stays unknown, never brake', () => {
  const one = build({ five_hour: { used: 1, slope: 0, resetsAt: NOW + 295 * MIN } }, { spanMin: 0 });
  assert.equal(limitState(one, 'five_hour', NOW, CFG).state, 'unknown');
  assert.equal(overall(one, NOW, CFG).state, 'unknown');
});

test('warm-up: config defaults and overrides', () => {
  assert.deepEqual(DEFAULTS.warmup, { minutes: 10, pct: 10 });
  const dir = mkdtempSync(join(tmpdir(), 'kadans-cfg-'));
  assert.deepEqual(loadConfig(dir).warmup, { minutes: 10, pct: 10 });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ warmup: { minutes: 5, pct: 'x' } }));
  assert.deepEqual(loadConfig(dir).warmup, { minutes: 5, pct: 10 });
  // with warmup 0/0 the same young window brakes at once
  const s = build({ five_hour: { used: 15, slope: 1, resetsAt: NOW + 285 * MIN } }, { spanMin: 10, stepMin: 2 });
  assert.equal(limitState(s, 'five_hour', NOW, { ...CFG, warmup: { minutes: 0, pct: 0 } }).state, 'brake');
});
