import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN } from '../lib/pace.mjs';
import { fmtDuration, renderAge, renderLine } from '../lib/render.mjs';

const at = (h, m) => new Date(2026, 9, 25, h, m).getTime();

const cruise = {
  state: 'cruise',
  limit: null,
  limits: [{ name: 'five_hour', state: 'cruise', pct: 59.2, needle: 0.3, projection: 91.6, timeLeft: 216 * MIN }],
};
const gas = {
  state: 'gas',
  limit: 'five_hour',
  limits: [{ name: 'five_hour', state: 'gas', pct: 40, needle: 0.1, projection: 70.4, timeLeft: 120 * MIN }],
};
const brake = {
  state: 'brake',
  limit: 'five_hour',
  limits: [{ name: 'five_hour', state: 'brake', pct: 68, needle: 0.6, projection: 186, timeLeft: 189 * MIN, brakeAt: at(22, 39), resetsAt: new Date(2026, 9, 26, 1, 0).getTime() }],
};

test('default line is English (no lang argument)', () => {
  assert.equal(renderLine(cruise, 0), '5h 59% · 0.3%/min · ~92% at reset, ~8% unused · 3h36m to reset · CRUISE');
  assert.equal(renderLine(gas, 0), '5h 40% · 0.1%/min · ~70% at reset, ~30% unused · 2h00m to reset · GAS: ~30% will go unused');
  assert.equal(
    renderLine(brake, 0),
    '5h 68% · 0.6%/min · runs out ~22:39, 2h21m before reset · 3h09m to reset · BRAKE: runs out ~22:39 (reset 01:00)',
  );
  assert.doesNotMatch(renderLine(brake, 0), /186/);
});

test('config lang "tr" selects the Turkish line', () => {
  assert.equal(renderLine(cruise, 0, 'tr'), '5s %59 · 0,3%/dk · sıfırlanmada ~%92, ~%8 boşa · 3s36dk sonra sıfırlanır · SEYİR');
  assert.equal(renderLine(gas, 0, 'tr'), '5s %40 · 0,1%/dk · sıfırlanmada ~%70, ~%30 boşa · 2s0dk sonra sıfırlanır · GAZ: ~%30 boşa gidecek');
  const b = {
    state: 'brake',
    limit: 'five_hour',
    limits: [{ name: 'five_hour', state: 'brake', pct: 50, needle: 0.7, projection: 134, timeLeft: 120 * MIN, brakeAt: at(17, 40), resetsAt: at(18, 20) }],
  };
  assert.equal(renderLine(b, 0, 'tr'), "5s %50 · 0,7%/dk · 17:40'te biter, sıfırlanmadan 40dk önce · 2s0dk sonra sıfırlanır · FREN: ~17:40'te biter (sıfırlanma 18:20)");
});

test('projection below 100 shows percent and unused, 100 or more shows when it runs out', () => {
  const mk = (projection) => ({
    state: 'cruise',
    limit: null,
    limits: [{ name: 'five_hour', state: 'cruise', pct: 50, needle: 1, projection, timeLeft: 60 * MIN, brakeAt: at(23, 17), resetsAt: new Date(2026, 9, 26, 1, 0).getTime() }],
  });
  assert.match(renderLine(mk(92), 0), /~92% at reset, ~8% unused/);
  assert.match(renderLine(mk(100), 0), /runs out ~23:17, 1h43m before reset/);
  assert.doesNotMatch(renderLine(mk(184), 0), /184/);
  assert.match(renderLine(mk(184), 0, 'tr'), /23:17'te biter, sıfırlanmadan 1s43dk önce/);
  assert.match(renderLine(mk(92), 0, 'tr'), /sıfırlanmada ~%92, ~%8 boşa/);
});

test('two limits, no data and unknown', () => {
  const two = {
    state: 'gas',
    limit: 'seven_day',
    limits: [
      { name: 'five_hour', state: 'gas', pct: 40, needle: 0.1, projection: 80, timeLeft: 60 * MIN },
      { name: 'seven_day', state: 'gas', pct: 20, needle: 0.01, projection: 70, timeLeft: 3 * 24 * 60 * MIN },
    ],
  };
  assert.equal(
    renderLine(two, 0, 'en'),
    '5h 40% · 0.1%/min · ~80% at reset, ~20% unused · 1h00m to reset | 7d 20% · 0.0%/min · ~70% at reset, ~30% unused · 3d0h to reset · GAS: ~30% will go unused',
  );
  assert.equal(renderLine({ state: 'unknown', limit: null, limits: [{ name: 'five_hour', state: 'nodata' }] }, 0), '5h no data · LOW DATA');
  assert.equal(renderLine({ state: 'unknown', limit: null, limits: [{ name: 'five_hour', state: 'nodata' }] }, 0, 'tr'), '5s veri yok · VERİ AZ');
  assert.equal(renderLine({ state: 'unknown', limit: null, limits: [] }, 0, 'tr'), 'VERİ AZ');
});

test('decimal comma only in Turkish', () => {
  const res = { state: 'cruise', limit: null, limits: [{ name: 'five_hour', state: 'cruise', pct: 1, needle: 0.25, projection: 5, timeLeft: 0 }] };
  assert.match(renderLine(res, 0, 'tr'), /0,3%\/dk/);
  assert.match(renderLine(res, 0, 'en'), /0\.3%\/min/);
});

test('durations and age', () => {
  assert.equal(fmtDuration(0), '0m');
  assert.equal(fmtDuration(90 * MIN), '1h30m');
  assert.equal(fmtDuration(189 * MIN), '3h09m');
  assert.equal(fmtDuration((3 * 1440 + 120) * MIN), '3d2h');
  assert.equal(fmtDuration(90 * MIN, 'tr'), '1s30dk');
  assert.equal(fmtDuration((3 * 1440 + 120) * MIN, 'tr'), '3g2s');
  assert.equal(renderAge(2 * MIN, 'tr'), 'son örnek 2dk önce');
  assert.equal(renderAge(2 * MIN), 'last sample 2m ago');
});
