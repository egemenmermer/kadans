// Panel markup safety: every value that comes from JSON must reach the page as text. The panel is loaded in a vm with a
// minimal fake DOM, each fixture is rendered, and the resulting HTML is checked for injected tags and attributes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'web');
const read = (f) => readFileSync(join(WEB, f), 'utf8');

// Tags and attributes the panel's own markup uses; anything else in the output came from data.
const TAGS = new Set(['div', 'span', 'button', 'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'i', 'pre', 'p', 'input']);
const ATTRS = new Set(['id', 'class', 'role', 'tabindex', 'title', 'style', 'data-key', 'data-do', 'data-id', 'data-task', 'data-k', 'data-v',
  'data-mode', 'data-until', 'data-num', 'data-set', 'data-unit', 'data-fmt', 'aria-label', 'aria-pressed', 'aria-checked',
  'aria-disabled', 'aria-expanded', 'aria-haspopup', 'aria-hidden', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow',
  'aria-valuetext', 'width', 'height', 'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'd', 'x', 'y', 'rx', 'ry', 'cx', 'cy', 'r', 'transform', 'type', 'min', 'max', 'step', 'value']);

// opts.clock: { now } read by Date.now() in the page; opts.timers: an array that collects setTimeout callbacks to run by hand.
function loadPanel(opts = {}) {
  const sent = [];
  let html = '';
  let click = null;
  const el = {
    id: 'kadans',
    set innerHTML(v) { html = v; },
    get innerHTML() { return html; },
    contains: () => false,
    addEventListener(type, fn) { if (type === 'click') click = fn; },
    querySelector: () => null,
    querySelectorAll: () => [],
    firstElementChild: null,
  };
  const noop = () => {};
  const document = {
    readyState: 'complete',
    body: { appendChild: noop },
    documentElement: { dataset: {} },
    activeElement: null,
    getElementById: (id) => (id === 'kadans' ? el : null),
    createElement: () => el,
    addEventListener: noop,
    querySelectorAll: () => [],
    // fixtures' `after` hooks click buttons: find the data-do / data-id in the selector and run the panel's click handler
    querySelector(sel) {
      const m = /data-do="([^"]+)"(?:\]\[data-id="([^"]+)")?/.exec(sel);
      if (!m) return null;
      const dataset = { do: m[1], ...(m[2] ? { id: m[2] } : {}) };
      return { click: () => click({ target: { closest: () => ({ dataset, getAttribute: () => null }) } }) };
    },
  };
  const timers = opts.timers;
  const g = { document, console, setTimeout: timers ? (fn, ms) => timers.push({ fn, ms }) : () => 0, clearTimeout: noop, matchMedia: () => ({ matches: false }), CSS: { escape: String },
    webkit: { messageHandlers: { kadans: { postMessage: (m) => sent.push(m) } } } };
  if (opts.clock) g.Date = class extends Date { static now() { return opts.clock.now; } };
  g.window = g; // fixtures assign window.KF / window.KADANS_FIXTURES, which must be globals for the other scripts
  const ctx = vm.createContext(g);
  const window = g;
  vm.runInContext(read('panel.js'), ctx);
  vm.runInContext(['_base.js', ...readdirSync(join(WEB, 'fixtures')).filter((f) => f.endsWith('.js') && f !== '_base.js').sort()]
    .map((f) => read(join('fixtures', f))).join('\n;\n'), ctx);
  return { window, document, html: () => html, sent };
}

// Fails on any tag or attribute the panel does not write itself (e.g. an injected <img onerror=...>).
function assertNoInjection(html, label) {
  for (const t of html.matchAll(/<\/?([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>/g)) {
    assert.ok(TAGS.has(t[1]), `${label}: unexpected tag <${t[1]}>`);
    for (const a of t[2].matchAll(/([\w:-]+)(?:="[^"]*")?/g)) assert.ok(ATTRS.has(a[1]), `${label}: unexpected attribute ${a[1]} on <${t[1]}>`);
  }
  // every "<" left must belong to a tag matched above (stray "<" from data would be text only if escaped)
  const stripped = html.replace(/<\/?([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>/g, '');
  assert.ok(!stripped.includes('<') && !stripped.includes('>'), `${label}: raw angle bracket in text or attribute`);
}

test('panel: every fixture renders without injected tags or attributes', () => {
  const p = loadPanel();
  const names = Object.keys(p.window.KADANS_FIXTURES);
  assert.ok(names.includes('hostile') && names.includes('hostile_review') && names.includes('hostile_settings'));
  for (const name of names) {
    p.window.kadans.reset();
    const f = p.window.KADANS_FIXTURES[name];
    p.window.kadans.render(f);
    if (typeof f.after === 'function') f.after(p.document);
    assertNoInjection(p.html(), name);
  }
});

test('panel: hostile strings from JSON show up as escaped text, on the main, review and settings screens', () => {
  const p = loadPanel();
  const H = p.window.HOSTILE;
  const seen = (name, needles) => {
    p.window.kadans.reset();
    const f = p.window.KADANS_FIXTURES[name];
    p.window.kadans.render(f);
    f.after?.(p.document);
    const html = p.html();
    assertNoInjection(html, name);
    assert.ok(!html.includes('[object Object]') && !html.includes('native code'), `${name}: a prototype key leaked into the text`);
    for (const n of needles) assert.ok(html.includes(n), `${name}: expected escaped text ${n}`);
    return html;
  };
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  // main: agent titles, projects, subagent, task text in "Up next" and in the open Replace picker, account label
  seen('hostile', [esc(H.IMG), esc(H.AMP), esc(H.SCRIPT), esc(H.QUOTE), esc(`Run ${H.IMG} now`)]);
  seen('hostile_review', [esc(H.IMG), esc(H.AMP)]);
  seen('hostile_settings', [esc(`node '/Users/me/${H.BREAK}/bin/kadans.mjs'`)]);
});

// Blob shape per agent row, read from the markup: data-key="row:<id>" ... var(--blob-<shape>).
function rowShapes(html) {
  const out = {};
  for (const m of html.matchAll(/data-key="(?:row|sub):([^"]+)"[^>]*>.*?var\(--blob-(\w+)\)/g)) out[m[1]] = m[2];
  return out;
}

test('panel: distinct blobs, stable and oldest first', () => {
  const p = loadPanel();
  const assign = (items) => Object.fromEntries(p.window.kadans.assignShapes(items));
  // fx-0001 and fx-0004 both hash to star: the older one keeps it, the other takes the next free shape in list order
  const two = assign([{ id: 'fx-0001', startedAt: 200 }, { id: 'fx-0004', startedAt: 100 }]);
  assert.equal(two['fx-0004'], 'star');
  assert.equal(two['fx-0001'], 'flower');
  // same input (in any order) -> same output
  assert.deepEqual(assign([{ id: 'fx-0004', startedAt: 100 }, { id: 'fx-0001', startedAt: 200 }]), two);
  // a newer agent never takes an older one's blob
  const three = assign([{ id: 'fx-0001', startedAt: 200 }, { id: 'fx-0004', startedAt: 100 }, { id: 'fx-0009', startedAt: 300 }]);
  assert.equal(three['fx-0004'], 'star');
  assert.equal(three['fx-0001'], 'flower');
  // five rows: five shapes; a sixth falls back to its own hash shape
  const ids = ['fx-0001', 'fx-0004', 'fx-0002', 'fx-0003', 'fx-0006', 'fx-0010'];
  const six = assign(ids.map((id, i) => ({ id, startedAt: i })));
  assert.equal(new Set(ids.slice(0, 5).map((id) => six[id])).size, 5);
  // live rows (rank 0) win over the idle group (rank 2), so opening the group never changes a live blob
  const ranked = assign([{ id: 'fx-0010', startedAt: 1, rank: 2 }, { id: 'fx-0006', startedAt: 9, rank: 0 }]);
  assert.equal(ranked['fx-0006'], 'egg');
  assert.notEqual(ranked['fx-0010'], 'egg');
});

test('panel: the blobs fixture shows no two rows with the same shape', () => {
  const p = loadPanel();
  p.window.kadans.reset();
  p.window.kadans.render(p.window.KADANS_FIXTURES.blobs);
  const shapes = rowShapes(p.html());
  assert.deepEqual(Object.keys(shapes).sort(), ['fx-0001', 'fx-0002', 'fx-0004', 'fx-0006']);
  assert.equal(shapes['fx-0004'], 'star');
  assert.notEqual(shapes['fx-0001'], 'star');
  assert.equal(new Set(Object.values(shapes)).size, 4);
  // a refresh with the same data keeps every blob
  p.window.kadans.render({ agents: p.window.KADANS_FIXTURES.blobs.agents });
  assert.deepEqual(rowShapes(p.html()), shapes);
  // no row carries an enter animation on the first paint
  assert.ok(!/class="row[^"]*\benter\b/.test(p.html()));
});

test('panel: idle chats close through the confirm; Close all only for the 2+ hour group', () => {
  const p = loadPanel();
  const F = p.window.KADANS_FIXTURES;
  p.window.kadans.reset();
  p.window.kadans.render(F.blobs);
  let html = p.html();
  // the idle row under 2 h has Close, not Stop; working rows keep Stop
  assert.match(html, /data-do="close" data-id="fx-0006"/);
  assert.doesNotMatch(html, /data-do="confirm" data-id="fx-0006"/);
  assert.match(html, /data-do="confirm" data-id="fx-0001"/);
  assert.match(html, />3 idle</);
  assert.match(html, /data-do="close-all"/);
  // single close: confirm first, nothing sent until the owner says Close
  p.document.querySelector('[data-do="close"][data-id="fx-0006"]').click();
  html = p.html();
  assert.match(html, /Close this chat\?/);
  assert.equal(p.sent.filter((m) => m.action === 'stop').length, 0);
  p.document.querySelector('[data-do="stop"][data-id="fx-0006"]').click();
  assert.deepEqual(p.sent.filter((m) => m.action === 'stop').map((m) => m.id), ['fx-0006']);
});

test('panel: Close all confirms once, sends one stop per closable 2+ hour idle chat in order, then reports failures', () => {
  const clock = { now: 1_000_000 };
  const timers = [];
  const p = loadPanel({ clock, timers });
  const F = p.window.KADANS_FIXTURES;
  const stops = () => p.sent.filter((m) => m.action === 'stop').map((m) => m.id);
  const run = () => { while (timers.length) { const t = timers.shift(); if (t.ms < 2000) t.fn(); } }; // the sends, not the deadlines
  p.window.kadans.reset();
  p.window.kadans.render(F.blobs);
  p.document.querySelector('[data-do="close-all"]').click();
  assert.match(p.html(), /Close 2 idle chats\?/); // the third one has no pid or terminal
  assert.equal(stops().length, 0);
  // cancel closes the confirm without sending
  p.document.querySelector('[data-do="close-all-cancel"]').click();
  assert.doesNotMatch(p.html(), /idle chats\?/);
  assert.equal(stops().length, 0);
  // confirm: the first stop goes now, the next after a short gap
  p.document.querySelector('[data-do="close-all"]').click();
  timers.length = 0; // the 4 s auto-revert of the confirm
  p.document.querySelector('[data-do="close-all-go"]').click();
  assert.deepEqual(stops(), ['fx-0010']);
  assert.match(p.html(), /Closing 1 of 2…/);
  run();
  assert.deepEqual(stops(), ['fx-0010', 'orca:term_fx11']); // never fx-0006 (idle under 2 h) or fx-0012 (can't stop)
  assert.match(p.html(), /Closed 0 of 2…/);
  // one ends, one stays: after the wait it says so
  const agents = F.blobs.agents.map((a) => (a.id === 'fx-0010' ? { ...a, status: 'ended', stale: false, lastSeen: a.lastSeen } : a));
  p.window.kadans.render({ agents });
  assert.match(p.html(), /Closed 1 of 2…/);
  clock.now += 16_000;
  p.window.kadans.render({ agents });
  assert.match(p.html(), /Closed 1 of 2 · <span class="warn">1 didn't close<\/span>/);
  assert.deepEqual(stops(), ['fx-0010', 'orca:term_fx11']);
});
