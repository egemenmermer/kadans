// One short plain-text status line. No emoji, no colour codes. English is the default; the Turkish table is
// selected with config lang "tr".
import { MIN } from './pace.mjs';

const TEXT = {
  tr: {
    cruise: 'SEYİR',
    early: 'ERKEN UYARI: bu hızla biter',
    unknown: 'VERİ AZ',
    noData: 'veri yok',
    ended: 'sıfırlandı',
    left: 'sonra sıfırlanır',
    atReset: (p, u) => `sıfırlanmada ${p}, ${u} boşa`,
    runsOut: (at, before) => `${at}'te biter, sıfırlanmadan ${before} önce`,
    perMin: '%/dk',
    lastSample: 'son örnek',
    ago: 'önce',
    short: { five_hour: '5s', seven_day: '7g' },
    gas: (w) => `GAZ: ~%${w} boşa gidecek`,
    brake: (at, reset) => `FREN: ~${at}'te biter (sıfırlanma ${reset})`,
    pct: (n) => `%${n}`,
    approx: (n) => `~%${n}`,
    rate: (n) => `${n.toFixed(1).replace('.', ',')}%/dk`,
    dur: (d, h, m) => (d > 0 ? `${d}g${h}s` : h > 0 ? `${h}s${m}dk` : `${m}dk`),
  },
  en: {
    cruise: 'CRUISE',
    early: 'EARLY WARNING: on course to run out',
    unknown: 'LOW DATA',
    noData: 'no data',
    ended: 'window ended',
    left: 'to reset',
    atReset: (p, u) => `${p} at reset, ${u} unused`,
    runsOut: (at, before) => `runs out ~${at}, ${before} before reset`,
    perMin: '%/min',
    lastSample: 'last sample',
    ago: 'ago',
    short: { five_hour: '5h', seven_day: '7d' },
    gas: (w) => `GAS: ~${w}% will go unused`,
    brake: (at, reset) => `BRAKE: runs out ~${at} (reset ${reset})`,
    pct: (n) => `${n}%`,
    approx: (n) => `~${n}%`,
    rate: (n) => `${n.toFixed(1)}%/min`,
    dur: (d, h, m) => (d > 0 ? `${d}d${h}h` : h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`),
  },
};

export function fmtDuration(ms, lang = 'en') {
  const total = Math.max(0, Math.round(ms / MIN));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  return (TEXT[lang] ?? TEXT.en).dur(d, h, m);
}

export function hhmm(t) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// window_<minutes> (Codex plans): whole days as "30d" ("30g" in Turkish), else hours ("12h"/"12s").
function windowShort(name, t) {
  const m = typeof name === 'string' ? name.match(/^window_(\d+)$/) : null;
  if (!m) return name;
  const min = Number(m[1]);
  const [h, d] = t === TEXT.tr ? ['s', 'g'] : ['h', 'd'];
  return min % 1440 === 0 ? `${min / 1440}${d}` : `${Math.round(min / 60)}${h}`;
}

function segment(v, t) {
  const short = t.short[v.name] ?? windowShort(v.name, t);
  if (v.state === 'nodata') return `${short} ${t.noData}`;
  if (v.ended) return `${short} ${t.pct(Math.round(v.pct))} · ${t.ended}`;
  const lang = t === TEXT.tr ? 'tr' : 'en';
  // A projection of 100 or more is not shown as a percentage: say when it runs out instead.
  let proj;
  if (v.projection >= 100 && Number.isFinite(v.brakeAt)) {
    proj = t.runsOut(hhmm(v.brakeAt), fmtDuration(Math.max(0, v.resetsAt - v.brakeAt), lang));
  } else {
    const p = Math.round(v.projection);
    proj = t.atReset(t.approx(p), t.approx(Math.max(0, 100 - p)));
  }
  return [
    `${short} ${t.pct(Math.round(v.pct))}`,
    t.rate(v.needle),
    proj,
    `${fmtDuration(v.timeLeft, lang)} ${t.left}`,
  ].join(' · ');
}

function stateText(res, t) {
  if (res.state === 'cruise') return t.cruise;
  if (res.state === 'early') return t.early;
  if (res.state === 'gas') {
    const v = res.limits.find((x) => x.name === res.limit);
    return t.gas(Math.round(100 - v.projection));
  }
  if (res.state === 'brake') {
    const v = res.limits.find((x) => x.name === res.limit);
    const at = v.brakeAt === Infinity ? '-' : hhmm(v.brakeAt);
    return t.brake(at, hhmm(v.resetsAt));
  }
  return t.unknown;
}

// res is the result of pace.overall(). lang is "en" (default) or "tr".
export function renderLine(res, now, lang = 'en') {
  const t = TEXT[lang] ?? TEXT.en;
  const segs = res.limits.map((v) => segment(v, t));
  const state = stateText(res, t);
  return segs.length ? `${segs.join(' | ')} · ${state}` : state;
}

// Age of the last sample, e.g. "last sample 2m ago".
export function renderAge(ageMs, lang = 'en') {
  const t = TEXT[lang] ?? TEXT.en;
  return `${t.lastSample} ${fmtDuration(ageMs, lang)} ${t.ago}`;
}
