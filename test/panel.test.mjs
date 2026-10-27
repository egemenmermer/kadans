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

// A small DOM for the keyed patch (k14): elements made from markup keep their inner markup as a string; shells built
// by appending children serialise from their children. Every change is logged as [op, data-key or tag], so a test can
// tell which nodes a render touched. innerHTML reads back the whole tree, so the markup tests read what is on screen.
const UNESC = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const ESCA = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
class FNode {
  constructor(log, tag, attrs = [], inner = '', text = null) {
    Object.assign(this, { log, tag, inner, text, kids: [], parentNode: null, listeners: {} });
    this.attrs = new Map(attrs);
  }
  static parse(log, html) {
    const m = /^<([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*>/.exec(html);
    if (!m) return new FNode(log, '#text', [], '', html);
    const attrs = [...m[2].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map((a) => [a[1], (a[2] ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (e) => UNESC[e])]);
    const close = `</${m[1]}>`;
    return new FNode(log, m[1], attrs, html.endsWith(close) ? html.slice(m[0].length, -close.length) : html.slice(m[0].length));
  }
  key() { return this.attrs.get('data-key') ?? this.tag; }
  get outerHTML() {
    if (this.tag === '#text') return this.text;
    return `<${this.tag}${[...this.attrs].map(([k, v]) => ` ${k}="${v.replace(/[&<>"']/g, (c) => ESCA[c])}"`).join('')}>${this.innerHTML}</${this.tag}>`;
  }
  get innerHTML() { return this.kids.length ? this.kids.map((k) => k.outerHTML).join('') : this.inner; }
  set innerHTML(v) {
    for (const k of this.kids) k.parentNode = null;
    this.kids = [];
    this.inner = '';
    if (v) this.appendChild(FNode.parse(this.log, v));
  }
  get dataset() {
    const d = {};
    for (const [k, v] of this.attrs) if (k.startsWith('data-')) d[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    return d;
  }
  get classList() {
    const get = () => (this.attrs.get('class') ?? '').split(' ').filter(Boolean);
    const set = (a) => { this.attrs.set('class', a.join(' ')); this.log.push(['class', this.key()]); };
    return {
      add: (c) => { const a = get(); if (!a.includes(c)) set([...a, c]); },
      remove: (c) => { const a = get(); if (a.includes(c)) set(a.filter((x) => x !== c)); },
      contains: (c) => get().includes(c),
      toggle: (c, on) => { const a = get(); if (on && !a.includes(c)) set([...a, c]); else if (!on && a.includes(c)) set(a.filter((x) => x !== c)); },
    };
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); this.log.push(['attr', this.key(), k]); }
  removeAttribute(k) { this.log.push(['attr', this.key(), k]); this.attrs.delete(k); }
  getAttribute(k) { return this.attrs.get(k) ?? null; }
  appendChild(n) { return this.insertBefore(n, null); }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.kids.splice(n.parentNode.kids.indexOf(n), 1);
    const i = ref ? this.kids.indexOf(ref) : -1;
    if (i < 0) this.kids.push(n); else this.kids.splice(i, 0, n);
    n.parentNode = this;
    this.log.push(['insert', n.key()]);
    return n;
  }
  remove() {
    if (!this.parentNode) return;
    this.log.push(['remove', this.key()]);
    this.parentNode.kids.splice(this.parentNode.kids.indexOf(this), 1);
    this.parentNode = null;
  }
  replaceWith(n) {
    const p = this.parentNode;
    if (!p) return;
    this.log.push(['replace', this.key()]);
    p.kids[p.kids.indexOf(this)] = n;
    n.parentNode = p;
    this.parentNode = null;
  }
  get firstChild() { return this.kids[0] ?? null; }
  get firstElementChild() { return this.kids[0] ?? null; }
  get nextSibling() { const p = this.parentNode; return p ? p.kids[p.kids.indexOf(this) + 1] ?? null : null; }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  find(key) {
    if (this.attrs.get('data-key') === key) return this;
    for (const k of this.kids) { const f = k.find(key); if (f) return f; }
    return null;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { height: 0 }; }
  closest() { return null; }
  animate() { return {}; }
}

// opts.clock: { now } read by Date.now() in the page; opts.timers: an array that collects setTimeout callbacks to run by hand
// (k18: each entry gets an id, and clearTimeout marks it `cleared`; nothing is deleted, so tests that fire by ms still work).
// opts.media: { reduce } read by matchMedia('(prefers-reduced-motion: reduce)'), changeable mid-test.
function loadPanel(opts = {}) {
  const sent = [];
  const log = [];
  const el = new FNode(log, 'div', [['id', 'kadans']]);
  const click = (e) => el.listeners.click[0](e);
  const noop = () => {};
  const document = {
    readyState: 'complete',
    body: { appendChild: noop },
    documentElement: { dataset: {} },
    activeElement: null,
    getElementById: (id) => (id === 'kadans' ? el : null),
    createElement: (tag) => (tag === 'template'
      ? { content: null, set innerHTML(h) { this.content = { firstChild: FNode.parse(log, h) }; } } : el),
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
  let tid = 0;
  const g = { document, console, setTimeout: timers ? (fn, ms) => { timers.push({ id: ++tid, fn, ms }); return tid; } : () => 0,
    clearTimeout: timers ? (id) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true; } : noop,
    matchMedia: (q) => ({ matches: /reduce/.test(q) && opts.media?.reduce === true }), CSS: { escape: String },
    webkit: { messageHandlers: { kadans: { postMessage: (m) => sent.push(m) } } } };
  if (opts.clock) g.Date = class extends Date { static now() { return opts.clock.now; } };
  g.window = g; // fixtures assign window.KF / window.KADANS_FIXTURES, which must be globals for the other scripts
  const ctx = vm.createContext(g);
  const window = g;
  vm.runInContext(read('panel.js'), ctx);
  vm.runInContext(['_base.js', ...readdirSync(join(WEB, 'fixtures')).filter((f) => f.endsWith('.js') && f !== '_base.js').sort()]
    .map((f) => read(join('fixtures', f))).join('\n;\n'), ctx);
  // a click on any element by its dataset (Settings segments carry data-k / data-v, which the fake querySelector does not parse)
  const tap = (dataset) => click({ target: { closest: () => ({ dataset, getAttribute: () => null }) } });
  return { window, document, html: () => el.innerHTML, sent, tap, el, log };
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

// ---------- k10b: compact hint and action ----------
// One agent row's markup, from its opening tag up to the next row (or the end).
function rowHtml(html, id) {
  const start = html.indexOf(`data-key="row:${id}"`);
  assert.ok(start >= 0, `row ${id} is on screen`);
  const open = html.lastIndexOf('<div class="row', start);
  const next = html.indexOf('<div class="row', start);
  return html.slice(open, next < 0 ? undefined : next);
}
const compacts = (p) => p.sent.filter((m) => m.action === 'compact');

test('panel: context number and compact hint for none / soon / now / null', () => {
  const p = loadPanel();
  p.window.kadans.reset();
  p.window.kadans.render(p.window.KADANS_FIXTURES.compact);
  const html = p.html();
  // none (working): the number, no tag; the lifetime sum only in the tooltip
  const none = rowHtml(html, 'fx-0024');
  assert.match(none, /Quarry · Opus · 148k context · 40 min/);
  assert.doesNotMatch(none, /class="tag"/);
  assert.doesNotMatch(none, /class="pv">[^<]*2\.1M/);
  assert.match(none, /title="Port the CSV importer\n2\.1M tokens since start, cache reads not counted"/);
  // null: no number in that slot
  const nul = rowHtml(html, 'fx-0025');
  assert.doesNotMatch(nul, /\d+k context/);
  assert.match(nul, /Fernway · Sonnet · 2 min/);
  // soon: the number is enough
  const soon = rowHtml(html, 'fx-0022');
  assert.match(soon, /92k context/);
  assert.doesNotMatch(soon, /class="tag"/);
  // now: a quiet tag right after the number, the why as its title and in the row's aria text
  const now = rowHtml(html, 'fx-0021');
  assert.match(now, /class="pv"><span class="tag" title="Idle 12 min: next turn re-reads all 152k">Compact\?<\/span> 152k context · Idle 12 min · Tidepool · Opus · 1 hr 35 min</);
  assert.match(now, /aria-label="Refactor the sync worker\. Compact\? Idle 12 min: next turn re-reads all 152k\. 152k context\. Idle/);
  // now, but no Orca terminal: the tag tells the owner to type it
  assert.match(rowHtml(html, 'fx-0023'), /class="tag" title="Re-reads 128k tokens every turn\. Type \/compact in that chat">Compact\?/);
});

test('panel: Compact only on idle chats with advice in a usable Orca terminal', () => {
  const p = loadPanel();
  const F = p.window.KADANS_FIXTURES;
  const btnOn = (html, id) => new RegExp(`data-do="compact" data-id="${id}"`).test(html);
  p.window.kadans.reset();
  p.window.kadans.render(F.compact);
  let html = p.html();
  assert.ok(btnOn(html, 'fx-0021'), 'now + Orca');
  assert.ok(btnOn(html, 'fx-0022'), 'soon + Orca');
  assert.ok(!btnOn(html, 'fx-0023'), 'now without Orca');
  assert.ok(!btnOn(html, 'fx-0024') && !btnOn(html, 'fx-0025'), 'working / needs-you');
  // The same big context on rows that must never be compacted (k10a gives them 'none', the panel does not rely on it)
  const N = p.window.KF.N;
  const M = p.window.KF.M;
  const big = { tokens: 150000, window: 200000, pct: 75, advice: 'now', why: 'Re-reads 150k tokens every turn' };
  const orca = (t) => ({ terminal: t, worktree: 'x', repo: 'x', state: 'idle', title: null, ambiguous: false });
  const A = p.window.KF.agent;
  const rows = [
    A('fx-0031', { status: 'working', context: big, orca: orca('term_a') }),
    A('fx-0032', { status: 'needs-you', context: big, orca: orca('term_b') }),
    A('fx-0033', { status: 'idle', lastSeen: N - 9 * M, pace: { mode: 'slow', until: null }, context: big, orca: orca('term_c') }),
    A('fx-0034', { status: 'idle', lastSeen: N - 9 * M, pace: { mode: 'paused', until: null }, context: big, orca: orca('term_d') }),
    A('fx-0035', { status: 'ended', lastSeen: N - M, context: big, orca: orca('term_e') }),
    A('fx-0036', { status: 'idle', lastSeen: N - 9 * M, context: big, orca: { ...orca('term_f'), ambiguous: true } }),
    A('orca:term_g', { source: 'orca', status: 'idle', lastSeen: N - 9 * M, pid: null, context: big, orca: orca('term_g') }),
    A('fx-0037', { status: 'idle', lastSeen: N - 9 * M, context: { ...big, advice: 'none' }, orca: orca('term_h') }),
  ];
  p.window.kadans.render({ agents: rows });
  html = p.html();
  assert.doesNotMatch(html, /data-do="compact"/);
  // a fake click on one of them opens no confirm and sends nothing
  p.tap({ do: 'compact', id: 'fx-0031' });
  assert.doesNotMatch(p.html(), /Compact this chat\?/);
  assert.equal(compacts(p).length, 0);
});

test('panel: Compact confirms first, then sends exactly one compact with the id (never stop)', () => {
  const p = loadPanel();
  p.window.kadans.reset();
  p.window.kadans.render(p.window.KADANS_FIXTURES.compact);
  p.document.querySelector('[data-do="compact"][data-id="fx-0021"]').click();
  const row = rowHtml(p.html(), 'fx-0021');
  // the question and its reason on the line under the row; the row keeps its meta line, without the tag
  assert.match(row, /<div class="cwhy" data-key="why:fx-0021"><span class="ask">Compact this chat\?<\/span> Idle 12 min: next turn re-reads all 152k<\/div>/);
  assert.match(row, /class="pv">Idle 12 min · Tidepool · Opus · 152k context · 1 hr 35 min</);
  assert.match(row, /data-do="compact-go" data-id="fx-0021">Compact<\/button>/);
  assert.match(row, /data-do="cancel" data-id="fx-0021">Cancel/);
  assert.equal(compacts(p).length, 0);
  // Cancel sends nothing
  p.document.querySelector('[data-do="cancel"][data-id="fx-0021"]').click();
  assert.doesNotMatch(p.html(), /Compact this chat\?/);
  assert.equal(compacts(p).length, 0);
  p.document.querySelector('[data-do="compact"][data-id="fx-0021"]').click();
  p.document.querySelector('[data-do="compact-go"][data-id="fx-0021"]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(compacts(p))), [{ action: 'compact', id: 'fx-0021' }]);
  assert.equal(p.sent.filter((m) => m.action === 'stop').length, 0);
  // a second click on the same confirm (double click) sends nothing more
  p.document.querySelector('[data-do="compact-go"][data-id="fx-0021"]').click();
  assert.equal(compacts(p).length, 1);
});

test('panel: a confirm left open closes when the chat starts working, and its Compact then sends nothing', () => {
  const p = loadPanel();
  const F = p.window.KADANS_FIXTURES;
  p.window.kadans.reset();
  p.window.kadans.render(F.compact);
  p.document.querySelector('[data-do="compact"][data-id="fx-0021"]').click();
  const working = F.compact.agents.map((a) => (a.id === 'fx-0021' ? { ...a, status: 'working', context: { ...a.context, advice: 'none', why: null } } : a));
  p.window.kadans.render({ agents: working });
  assert.doesNotMatch(p.html(), /Compact this chat\?/);
  p.tap({ do: 'compact-go', id: 'fx-0021' });
  assert.equal(compacts(p).length, 0);
});

test('panel: one compact in flight at a time; Compacting… until the context shrinks or 90 s pass', () => {
  const clock = { now: 5_000_000 };
  const timers = [];
  const p = loadPanel({ clock, timers });
  const F = p.window.KADANS_FIXTURES;
  p.window.kadans.reset();
  p.window.kadans.render(F.compact);
  p.document.querySelector('[data-do="compact"][data-id="fx-0021"]').click();
  p.document.querySelector('[data-do="compact-go"][data-id="fx-0021"]').click();
  let html = p.html();
  assert.match(rowHtml(html, 'fx-0021'), /class="pv">Compacting… · Tidepool/);
  assert.doesNotMatch(rowHtml(html, 'fx-0021'), /class="tag"/);
  // no Compact anywhere while one is in flight, and a forged click is ignored
  assert.doesNotMatch(html, /data-do="compact"/);
  p.tap({ do: 'compact', id: 'fx-0022' });
  p.tap({ do: 'compact-go', id: 'fx-0022' });
  assert.equal(compacts(p).length, 1);
  // a refresh with the same context keeps it running
  clock.now += 30_000;
  p.window.kadans.render({ agents: F.compact.agents });
  assert.match(p.html(), /Compacting…/);
  // the context got smaller: done, Compact is back on the other row
  const smaller = F.compact.agents.map((a) => (a.id === 'fx-0021' ? { ...a, context: { tokens: 21000, window: 200000, pct: 10.5, advice: 'none', why: null } } : a));
  p.window.kadans.render({ agents: smaller });
  html = p.html();
  assert.doesNotMatch(html, /Compacting…/);
  assert.match(rowHtml(html, 'fx-0021'), /21k context/);
  assert.match(html, /data-do="compact" data-id="fx-0022"/);

  // the other way: nothing changes for 90 s -> a quiet note, then Compact may be offered again
  p.document.querySelector('[data-do="compact"][data-id="fx-0022"]').click();
  p.document.querySelector('[data-do="compact-go"][data-id="fx-0022"]').click();
  assert.deepEqual(compacts(p).map((m) => m.id), ['fx-0021', 'fx-0022']);
  assert.ok(timers.some((t) => t.ms >= 90_000), 'a re-render is scheduled at the deadline');
  clock.now += 91_000;
  p.window.kadans.render({ agents: smaller });
  html = p.html();
  assert.match(rowHtml(html, 'fx-0022'), /<span class="warn" title="[^"]*">Compact not confirmed<\/span>/);
  assert.match(html, /data-do="compact" data-id="fx-0022"/);
  clock.now += 9000;
  p.window.kadans.render({ agents: smaller });
  assert.doesNotMatch(p.html(), /Compact not confirmed/);
  assert.equal(compacts(p).length, 2);
});

test('panel: Suggest compact Off hides every hint and button; the segment sets compact.soonPct', () => {
  const p = loadPanel();
  const F = p.window.KADANS_FIXTURES;
  p.window.kadans.reset();
  p.window.kadans.render(F.compact_off);
  let html = p.html();
  assert.doesNotMatch(html, /class="tag"/);
  assert.doesNotMatch(html, /data-do="compact"/);
  assert.match(html, /152k context/); // the number stays
  p.tap({ do: 'compact', id: 'fx-0021' });
  assert.doesNotMatch(p.html(), /Compact this chat\?/);
  // Settings: Off is pressed and can be picked (the CLI stores 101 since k12)
  p.tap({ do: 'settings' });
  html = p.html();
  assert.match(html, /aria-label="Suggest compact"/);
  assert.match(html, /<button aria-pressed="true" data-do="set" data-k="compact.soonPct" data-v="101" [^>]*>Off<\/button>/);
  assert.doesNotMatch(html, /not available yet/);
  // with 40 % stored: 40 % pressed; picking 60 % sends one config-set through the existing path
  p.window.kadans.reset();
  p.window.kadans.render(F.compact);
  p.tap({ do: 'settings' });
  html = p.html();
  assert.match(html, /aria-pressed="true" data-do="set" data-k="compact.soonPct" data-v="40"/);
  p.tap({ do: 'set', k: 'compact.soonPct', v: '60' });
  assert.deepEqual(JSON.parse(JSON.stringify(p.sent.filter((m) => m.action === 'config-set'))), [{ action: 'config-set', key: 'compact.soonPct', value: '60' }]);
  assert.match(p.html(), /aria-pressed="true" data-do="set" data-k="compact.soonPct" data-v="60"/);
});

// ---------- k12: Off, action results, Compacted ----------

test('panel: picking Off sends config-set compact.soonPct 101, and the hints go away', () => {
  const p = loadPanel();
  const F = p.window.KADANS_FIXTURES;
  p.window.kadans.reset();
  p.window.kadans.render(F.compact);
  p.tap({ do: 'settings' });
  assert.match(p.html(), /aria-pressed="true" data-do="set" data-k="compact.soonPct" data-v="40"/);
  p.tap({ do: 'set', k: 'compact.soonPct', v: '101' });
  assert.deepEqual(JSON.parse(JSON.stringify(p.sent.filter((m) => m.action === 'config-set'))), [{ action: 'config-set', key: 'compact.soonPct', value: '101' }]);
  assert.match(p.html(), /aria-pressed="true" data-do="set" data-k="compact.soonPct" data-v="101"[^>]*>Off</);
  p.window.kadans.render({ config: { ...F.compact.config, compact: { ...F.compact.config.compact, soonPct: 101 } } });
  p.tap({ do: 'back' });
  assert.doesNotMatch(p.html(), /class="tag"|data-do="compact"/);
});

test('panel: a refused compact shows the CLI reason on its row for 8 s, clears the in-flight state and offers Compact again', () => {
  const clock = { now: 7_000_000 };
  const timers = [];
  const p = loadPanel({ clock, timers });
  const F = p.window.KADANS_FIXTURES;
  p.window.kadans.reset();
  p.window.kadans.render(F.compact);
  p.document.querySelector('[data-do="compact"][data-id="fx-0021"]').click();
  p.document.querySelector('[data-do="compact-go"][data-id="fx-0021"]').click();
  assert.match(rowHtml(p.html(), 'fx-0021'), /Compacting…/);
  const why = 'not compacted: That chat has unsent text: type /compact there yourself';
  p.window.kadans.result({ action: 'compact', id: 'fx-0021', ok: false, why });
  let row = rowHtml(p.html(), 'fx-0021');
  assert.match(row, new RegExp(`class="pv"><span class="warn" title="${why}" style="[^"]*">${why}</span></div>`));
  assert.doesNotMatch(row, /Compacting…|class="tag"/);
  assert.match(row, /aria-label="Refactor the sync worker\. not compacted: That chat/);
  assert.match(p.html(), /data-do="compact" data-id="fx-0022"/); // not in flight any more
  assert.ok(timers.some((t) => t.ms <= 8100 && t.ms >= 8000), 'a re-render is scheduled when the reason expires');
  // other rows are untouched
  assert.match(rowHtml(p.html(), 'fx-0022'), /92k context/);
  clock.now += 8_100;
  p.window.kadans.render({});
  row = rowHtml(p.html(), 'fx-0021');
  assert.doesNotMatch(row, /unsent text/);
  assert.match(row, /Compact\?<\/span> 152k context/);
});

test('panel: a refused stop shows its reason on the row; a successful result, an unknown action and a junk payload change nothing', () => {
  const p = loadPanel();
  const F = p.window.KADANS_FIXTURES;
  p.window.kadans.reset();
  p.window.kadans.render(F.compact);
  const before = p.html();
  for (const r of [{ action: 'stop', id: 'fx-0021', ok: true, why: '' }, { action: 'config-set', id: 'compact.soonPct', ok: false, why: 'x' },
    { action: 'stop', id: 'nope', ok: false, why: 'x' }, null, 'x', 5, {}, { action: 'stop', ok: false }]) p.window.kadans.result(r);
  assert.equal(p.html(), before);
  p.tap({ do: 'close', id: 'fx-0021' });
  p.tap({ do: 'stop', id: 'fx-0021' });
  assert.deepEqual(p.sent.filter((m) => m.action === 'stop').map((m) => m.id), ['fx-0021']);
  p.window.kadans.result({ action: 'stop', id: 'fx-0021', ok: false, why: '   ' });
  assert.match(rowHtml(p.html(), 'fx-0021'), /<span class="warn" title="It did not work" style="[^"]*">It did not work<\/span>/);
  p.window.kadans.result({ action: 'stop', id: 'fx-0021', ok: false, why: 'a'.repeat(500) });
  assert.match(rowHtml(p.html(), 'fx-0021'), new RegExp(`title="${'a'.repeat(200)}" style="[^"]*">${'a'.repeat(200)}</span>`));
  // a new click clears the old reason
  p.tap({ do: 'stop', id: 'fx-0021' });
  assert.doesNotMatch(rowHtml(p.html(), 'fx-0021'), /class="warn"/);
});

test('panel: the result callback shows a hostile reason as text only, also when it arrives as a JSON literal in script source', () => {
  const p = loadPanel();
  const H = p.window.HOSTILE;
  const nasty = `${H.QUOTE} \\ ${H.SCRIPT}\n"${H.IMG}\u2028end`;
  p.window.kadans.reset();
  p.window.kadans.render(p.window.KADANS_FIXTURES.hostile);
  // what PanelController does: the payload as JSON (U+2028/9 escaped), inside the call's argument list, never as raw text
  const literal = JSON.stringify({ action: 'compact', id: 'fx-0204', ok: false, why: nasty }).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  assert.ok(!literal.includes('\n') && !literal.includes('\u2028'));
  vm.runInContext(`window.kadans && window.kadans.result && window.kadans.result(${literal}); true;`, p.window);
  const html = p.html();
  assertNoInjection(html, 'result');
  const row = rowHtml(html, 'fx-0204');
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const shown = nasty.replace(/\s+/g, ' ').trim();
  assert.ok(row.includes(`<span class="warn" title="${esc(shown)}" style=`) && row.includes(`">${esc(shown)}</span>`), 'the reason, one line, escaped');
  // the fixture does the same through its own hook
  p.window.kadans.reset();
  const f = p.window.KADANS_FIXTURES.hostile_result;
  p.window.kadans.render(f);
  f.after(p.document);
  assertNoInjection(p.html(), 'hostile_result');
  assert.match(rowHtml(p.html(), 'fx-0204'), /class="warn" title="&lt;img src=x onerror=alert\(1\)&gt; &#39; onmouseover/);
});

test('panel: Compacted shows on the row once the context dropped after an accepted compact; a successful result alone shows nothing', () => {
  const clock = { now: 9_000_000 };
  const timers = [];
  const p = loadPanel({ clock, timers });
  const F = p.window.KADANS_FIXTURES;
  p.window.kadans.reset();
  p.window.kadans.render(F.compact);
  p.document.querySelector('[data-do="compact"][data-id="fx-0021"]').click();
  p.document.querySelector('[data-do="compact-go"][data-id="fx-0021"]').click();
  p.window.kadans.result({ action: 'compact', id: 'fx-0021', ok: true, why: '' }); // the CLI typed it
  assert.match(rowHtml(p.html(), 'fx-0021'), /Compacting… · Tidepool/);
  assert.doesNotMatch(p.html(), /Compacted/);
  clock.now += 20_000;
  const smaller = F.compact.agents.map((a) => (a.id === 'fx-0021' ? { ...a, context: { tokens: 21000, window: 200000, pct: 10.5, advice: 'none', why: null } } : a));
  p.window.kadans.render({ agents: smaller });
  let row = rowHtml(p.html(), 'fx-0021');
  assert.match(row, /class="pv">Compacted · Tidepool · Opus · 21k context/);
  assert.doesNotMatch(row, /Compacting…|class="warn"/);
  clock.now += 8_100;
  p.window.kadans.render({});
  assert.doesNotMatch(p.html(), /Compacted/);
  // the chat ended or vanished instead: nothing to celebrate
  p.window.kadans.reset();
  p.window.kadans.render(F.compact);
  p.document.querySelector('[data-do="compact"][data-id="fx-0022"]').click();
  p.document.querySelector('[data-do="compact-go"][data-id="fx-0022"]').click();
  p.window.kadans.render({ agents: F.compact.agents.filter((a) => a.id !== 'fx-0022') });
  assert.doesNotMatch(p.html(), /Compacted/);
});

// ---------- k14: keyed patch, leave fade, stale reading ----------
// A panel on the blobs fixture with motion allowed (the first 300 ms after the first paint never animate).
function livePanel() {
  const clock = { now: 1_000_000 };
  const timers = [];
  const p = loadPanel({ clock, timers });
  const F = p.window.KADANS_FIXTURES;
  p.window.kadans.reset();
  p.window.kadans.render(F.blobs);
  clock.now += 1000;
  timers.length = 0;
  p.log.length = 0;
  const data = () => JSON.parse(JSON.stringify({ status: F.blobs.status, agents: F.blobs.agents }));
  return { p, clock, timers, data };
}

test('panel: a refresh with unchanged data touches no node at all', () => {
  const { p, data } = livePanel();
  const before = p.html();
  const row = p.el.find('row:fx-0001');
  p.window.kadans.render(data());
  p.window.kadans.render(data());
  assert.deepEqual(p.log, []);
  assert.equal(p.el.find('row:fx-0001'), row);
  assert.equal(p.html(), before);
});

test('panel: a changed row is patched alone; every other row node is left as it was', () => {
  const { p, data } = livePanel();
  const nodes = Object.fromEntries(['row:fx-0004', 'row:fx-0001', 'row:fx-0002', 'row:fx-0006', 'grp'].map((k) => [k, p.el.find(k)]));
  const d = data();
  d.agents.find((a) => a.id === 'fx-0002').status = 'working'; // needs-you -> working: new face, meta line and actions
  p.window.kadans.render(d);
  const touched = new Set(p.log.map(([, k]) => k));
  // the row element itself stays (hover and focus with it); its blob, text and actions were replaced inside it
  assert.equal(p.el.find('row:fx-0002'), nodes['row:fx-0002']);
  assert.ok(p.log.some(([op]) => op === 'replace'));
  for (const k of ['row:fx-0004', 'row:fx-0001', 'row:fx-0006', 'grp']) {
    assert.equal(p.el.find(k), nodes[k], `${k} kept`);
    assert.ok(!touched.has(k), `${k} untouched`);
  }
  assert.doesNotMatch(p.html(), /Needs you/);
  // a new agent row is inserted (and rises in); the others stay
  const d2 = data();
  d2.agents.splice(1, 0, p.window.KF.agent('fx-0030', { title: 'A new one', startedAt: p.window.KF.N - 60000 }));
  p.log.length = 0;
  p.window.kadans.render(d2);
  assert.match(p.el.find('row:fx-0030').getAttribute('class'), /\benter\b/);
  assert.equal(p.el.find('row:fx-0004'), nodes['row:fx-0004']);
});

test('panel: an open confirm, the hover mark and runtime classes survive a refresh that changes the row', () => {
  const { p, clock, data } = livePanel();
  p.document.querySelector('[data-do="confirm"][data-id="fx-0001"]').click();
  const row = p.el.find('row:fx-0001');
  assert.match(row.getAttribute('class'), /\bhov\b/);
  row.classList.add('poke'); // a squish in progress
  clock.now += 2000;
  const d = data();
  d.status.now += 60_000; // a minute later: durations and the gauge move
  d.status.accounts[0].limits[0].pct += 3;
  p.window.kadans.render(d);
  assert.equal(p.el.find('row:fx-0001'), row);
  assert.match(row.getAttribute('class'), /\bhov\b/);
  assert.match(row.getAttribute('class'), /\bpoke\b/);
  assert.match(p.html(), /data-do="stop" data-id="fx-0001">Stop<\/button>/);
  // the gauge fill keeps its node and only its transform changes, so the CSS transition carries it
  assert.ok(p.log.some(([op, k, a]) => op === 'attr' && k === 'div' && a === 'style'));
  assert.match(p.html(), /class="fill" style="transform:translateX\(-39%\)"/);
});

test('panel: a row a refresh removes fades out, then goes; with the popover closed it goes at once', () => {
  const { p, timers, data } = livePanel();
  const d = data();
  d.agents = d.agents.filter((a) => a.id !== 'fx-0002');
  p.window.kadans.render(d);
  const ghost = p.el.kids[0].kids.find((k) => k.attrs.get('id') === 'k-list').kids.find((k) => /\bleave\b/.test(k.attrs.get('class') ?? ''));
  assert.ok(ghost, 'the removed row is still there, fading');
  assert.equal(ghost.attrs.get('data-key'), undefined, 'out of focus restore and blinks');
  assert.equal(p.el.find('row:fx-0002'), null);
  timers.filter((t) => t.ms === 150).forEach((t) => t.fn());
  assert.equal(ghost.parentNode, null);
  // closed popover: no motion, the row is removed right away
  p.window.kadans.visible(false);
  const d2 = data();
  d2.agents = d2.agents.filter((a) => a.id !== 'fx-0002' && a.id !== 'fx-0006');
  p.window.kadans.render(d2);
  assert.ok(!/\bleave\b/.test(p.html()));
  assert.doesNotMatch(p.html(), /Draft release notes/);
});

test('panel: a reading older than 10 min shows its age in the muted note instead of pace advice', () => {
  const p = loadPanel();
  const F = p.window.KADANS_FIXTURES;
  const { N, M } = p.window.KF;
  p.window.kadans.reset();
  p.window.kadans.render(F.stale);
  let html = p.html();
  assert.match(html, /<div class="note stale"><i class="dot-gray"><\/i><span>Last reading 37 min ago<\/span><\/div>/);
  assert.doesNotMatch(html, /On pace/);
  assert.doesNotMatch(html, /title="Pace /);
  // 9 min old: still fresh, the advice is back
  p.window.kadans.render({ status: p.window.KF.status({ accounts: [p.window.KF.acct({ lastSample: N - 9 * M })] }) });
  html = p.html();
  assert.match(html, /On pace/);
  assert.doesNotMatch(html, /Last reading/);
  // a stale brake is not advice either
  p.window.kadans.render({ status: p.window.KF.status({ accounts: [p.window.KF.acct({ lastSample: N - 90 * M, state: 'brake' })] }) });
  assert.match(p.html(), /Last reading 1 hr 30 min ago/);
  assert.doesNotMatch(p.html(), /run out/);
  // k13's per-account flag wins when it is there
  p.window.kadans.render({ status: p.window.KF.status({ accounts: [p.window.KF.acct({ lastSample: N - 40 * M, fresh: true })] }) });
  assert.doesNotMatch(p.html(), /Last reading/);
  p.window.kadans.render({ status: p.window.KF.status({ accounts: [p.window.KF.acct({ lastSample: N - 2 * M, fresh: false })] }) });
  assert.match(p.html(), /Last reading 2 min ago/);
});

// ---------- k18: alive panel ----------
// The blob wrapper of a keyed row (its first kid), and its class list.
const blobOf = (p, key) => p.el.find(key)?.kids[0] ?? null;
const cls = (n) => n?.attrs.get('class') ?? '';
const pending = (timers) => timers.filter((t) => !t.cleared && !t.ran);
const fire = (t) => { t.ran = true; t.fn(); };

test('panel: working and needs-you blobs carry their motion class, on the right rows only', () => {
  const p = loadPanel();
  const { KF } = p.window;
  const A = KF.agent;
  p.window.kadans.reset();
  p.window.kadans.render({ status: KF.status(), agents: [
    A('fx-0101', { title: 'Working', subagents: [{ id: 'fx-sub-9', type: 'Explore', status: 'running' }] }),
    A('fx-0102', { title: 'Waiting', status: 'needs-you' }),
    A('fx-0103', { title: 'Idle', status: 'idle', lastSeen: KF.N - 5 * KF.M }),
    A('fx-0104', { title: 'Slowed', pace: { mode: 'slow' } }),
    A('fx-0105', { title: 'Paused', pace: { mode: 'paused', until: KF.N + 9 * KF.M } }),
    A('fx-0106', { title: 'Ended', status: 'ended', lastSeen: KF.N - KF.M }),
  ] });
  const move = (key) => (/\bbw-(work|need)\b/.exec(cls(blobOf(p, key))) ?? [])[1] ?? null;
  assert.equal(move('row:fx-0101'), 'work');
  assert.equal(move('sub:fx-sub-9'), 'work');
  assert.equal(move('row:fx-0102'), 'need');
  for (const id of ['fx-0103', 'fx-0104', 'fx-0105', 'fx-0106']) {
    assert.match(cls(blobOf(p, `row:${id}`)), /^bw$/, `${id} has a still blob`);
  }
  // the stagger comes from the id, so the same data gives the same markup (no churn on a refresh)
  const ph = blobOf(p, 'row:fx-0101').attrs.get('style');
  assert.match(ph, /^--ph:0(\.\d+)?$/);
  assert.notEqual(ph, blobOf(p, 'row:fx-0102').attrs.get('style'));
  // working -> needs you: the blob is swapped for one with the other motion; the row node stays
  const row = p.el.find('row:fx-0101');
  p.window.kadans.render({ agents: [A('fx-0101', { title: 'Working', status: 'needs-you' })] });
  assert.equal(p.el.find('row:fx-0101'), row);
  assert.equal(move('row:fx-0101'), 'need');
});

test('panel: one blink timer; each blob on its own 3-9 s, never two at once; off when hidden or with reduced motion', () => {
  const clock = { now: 1_000_000 };
  const timers = [];
  const media = { reduce: false };
  const p = loadPanel({ clock, timers, media });
  const F = p.window.KADANS_FIXTURES;
  p.window.kadans.reset();
  p.window.kadans.render(F.blobs);
  // every visible blob with open eyes: working, needs you, idle, and the idle group's egg
  let st = p.window.kadans.blinkState();
  assert.deepEqual(Object.keys(st.due).sort(), ['grp', 'row:fx-0001', 'row:fx-0002', 'row:fx-0004', 'row:fx-0006']);
  const check = (due, now) => {
    const ts = Object.values(due).sort((a, b) => a - b);
    for (const t of ts) assert.ok(t - now >= 3000 && t - now <= 9000, `due in 3-9 s, got ${t - now}`);
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= 300, 'two blinks never land together');
  };
  check(st.due, clock.now);
  assert.equal(st.armed, true);
  assert.equal(pending(timers).length, 1, 'one shared timer');
  assert.match(cls(p.el), /\balive\b/);
  // a refresh re-arms the same timer (still one) and keeps every due time
  p.window.kadans.render({ agents: F.blobs.agents });
  assert.equal(pending(timers).length, 1);
  assert.deepEqual(p.window.kadans.blinkState().due, st.due);
  // the first one due blinks alone, and the same timer ends the blink 200 ms later
  const [firstKey, firstAt] = Object.entries(st.due).sort((a, b) => a[1] - b[1])[0];
  clock.now = firstAt;
  fire(pending(timers)[0]);
  const blinking = ['grp', 'row:fx-0001', 'row:fx-0002', 'row:fx-0004', 'row:fx-0006'].filter((k) => /\bblink\b/.test(cls(blobOf(p, k)) + cls(p.el.find(k)?.kids[0]?.kids?.[0])));
  assert.equal(blinking.length, 1);
  assert.equal(blinking[0], firstKey);
  st = p.window.kadans.blinkState();
  assert.equal(st.blinking, 1);
  assert.ok(st.due[firstKey] - clock.now >= 3000, 'its next blink is 3-9 s away again');
  assert.equal(pending(timers).length, 1);
  clock.now += 200;
  fire(pending(timers)[0]);
  assert.equal(p.window.kadans.blinkState().blinking, 0);
  assert.doesNotMatch(p.html(), /\bblink\b/);
  // popover closed: no timer, no loops (alive off); open again: armed
  p.window.kadans.visible(false);
  assert.equal(p.window.kadans.blinkState().armed, false);
  assert.equal(pending(timers).length, 0);
  assert.doesNotMatch(cls(p.el), /\balive\b/);
  p.window.kadans.visible(true);
  assert.equal(p.window.kadans.blinkState().armed, true);
  assert.match(cls(p.el), /\balive\b/);
  // reduced motion: nothing is scheduled and nothing loops
  media.reduce = true;
  p.window.kadans.render({ agents: F.blobs.agents });
  assert.equal(p.window.kadans.blinkState().armed, false);
  assert.equal(pending(timers).length, 0);
  assert.doesNotMatch(cls(p.el), /\balive\b/);
});

test('panel: a Settings switch patches only itself (the knob node stays, so it slides); nothing else is rebuilt', () => {
  const p = loadPanel();
  const F = p.window.KADANS_FIXTURES;
  p.window.kadans.reset();
  p.window.kadans.render(F.settings);
  F.settings.after(p.document);
  const sw = p.el.find('set:notify');
  const usage = p.el.find('set:usageApi');
  const seg = p.el.find('set:lang:en');
  assert.equal(sw.getAttribute('aria-checked'), 'false');
  p.log.length = 0;
  p.tap({ do: 'set', k: 'notify', v: 'true' });
  assert.ok(p.log.length > 0);
  for (const [op, key] of p.log) assert.deepEqual([op, key], ['attr', 'set:notify']);
  assert.equal(p.el.find('set:notify'), sw);
  assert.equal(sw.getAttribute('aria-checked'), 'true');
  assert.equal(sw.getAttribute('data-v'), 'false');
  assert.deepEqual({ ...p.sent.at(-1) }, { action: 'config-set', key: 'notify', value: 'true' });
  // the config that confirms it changes nothing more
  p.log.length = 0;
  p.window.kadans.render({ config: { ...F.settings.config, notify: true } });
  assert.deepEqual(p.log, []);
  // a segment: only its two buttons change
  p.tap({ do: 'set', k: 'lang', v: 'tr' });
  assert.ok(p.log.every(([op, key]) => op === 'attr' && /^set:lang:(en|tr)$/.test(key)));
  assert.equal(p.el.find('set:lang:en'), seg);
  assert.equal(seg.getAttribute('aria-pressed'), 'false');
  // a minute later only the usage line's text is replaced; its switch and every other control stay
  p.log.length = 0;
  p.window.kadans.render({ status: { ...F.settings.status, now: F.settings.status.now + 4 * 60_000 } });
  assert.equal(p.el.find('set:usageApi'), usage);
  assert.equal(p.el.find('set:notify'), sw);
  assert.ok(p.log.length > 0 && p.log.every(([op]) => op === 'replace' || op === 'insert'));
  assert.match(p.html(), /Every 2 min · last read 5 min ago/);
});

test('panel: switching accounts keeps the gauge card, its account control and the shared limit; the pressed button moves', () => {
  const p = loadPanel();
  const F = p.window.KADANS_FIXTURES;
  p.window.kadans.reset();
  p.window.kadans.render(F.many);
  const card = () => p.el.kids[0].kids.find((k) => cls(k) === 'card');
  const c0 = card();
  const acct = c0.kids[0];
  const lim = c0.kids[1];
  const fill = lim.kids[1].kids[1];
  assert.equal(cls(fill), 'fill');
  assert.equal(cls(acct), 'acct');
  assert.equal(c0.kids.filter((k) => cls(k) === 'lim').length, 2);
  p.log.length = 0;
  p.tap({ do: 'account', id: 'bbbbbbbbbbbb' });
  assert.equal(card(), c0);
  assert.equal(c0.kids[0], acct);
  assert.equal(c0.kids[1], lim, 'the 5-hour limit both accounts have keeps its node');
  assert.equal(lim.kids[1].kids[1], fill, 'and its fill (it glides to the other account\'s value)');
  assert.equal(c0.kids.filter((k) => cls(k) === 'lim').length, 1);
  assert.deepEqual(acct.kids.map((b) => b.getAttribute('aria-pressed')), ['false', 'true']);
  assert.ok(!p.log.some(([op, key]) => op === 'replace' && key === 'button'), 'no account button replaced');
  assert.deepEqual({ ...p.sent.at(-1) }, { action: 'account', id: 'bbbbbbbbbbbb' });
});

test('panel: Settings "Read usage from Claude" shows fixed strings only (ok, login, error, off) and sets usageApi', () => {
  const p = loadPanel();
  const F = p.window.KADANS_FIXTURES;
  const { N, M } = p.window.KF;
  const open = (name, patch) => {
    p.window.kadans.reset();
    const f = F[name];
    p.window.kadans.render(patch ? { ...f, ...patch(f) } : f);
    f.after(p.document);
    const m = /Read usage from Claude<\/div><div class="d">([^<]*)<\/div>/.exec(p.html());
    assert.ok(m, `${name}: the usage row is there`);
    return m[1].replace(/&#39;/g, "'");
  };
  const ua = (f, o) => ({ status: { ...f.status, usageApi: { ...f.status.usageApi, ...o } } });
  assert.equal(open('settings'), 'Every 2 min · last read 1 min ago');
  assert.equal(open('settings', (f) => ua(f, { lastOk: N - 20_000 })), 'Every 2 min · last read just now');
  assert.equal(open('settings', (f) => ua(f, { lastOk: null })), 'Every 2 min · not read yet');
  assert.equal(open('settings_usage_login'), 'Needs a Claude Code login');
  const at = new Date(N + 8 * M);
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  assert.equal(open('settings_usage_error'), `Couldn't read · trying again at ${hhmm}`);
  assert.equal(open('settings_usage_error', (f) => ua(f, { nextAt: null })), "Couldn't read · trying again soon");
  // an error string from the CLI is never shown, whatever it holds
  const evil = '<img src=x onerror=alert(1)> /Users/me token';
  const html = (() => { open('settings', (f) => ua(f, { lastError: evil })); return p.html(); })();
  assert.ok(!html.includes('onerror') && !html.includes('token') && !html.includes('/Users/me'));
  assert.match(html, /Couldn&#39;t read · trying again soon/);
  // off: no error line, whatever the last error was
  assert.equal(open('settings_usage_error', (f) => ({ config: { ...f.config, usageApi: false } })), 'Off · updates only when Claude replies');
  // the switch sends the existing config-set
  p.tap({ do: 'set', k: 'usageApi', v: 'true' });
  assert.deepEqual({ ...p.sent.at(-1) }, { action: 'config-set', key: 'usageApi', value: 'true' });
  assert.equal(p.el.find('set:usageApi').getAttribute('aria-checked'), 'true');
});

test('panel: staleReading prefers the account\'s fresh flag; lastSample only gives the age (and is the fallback)', () => {
  const p = loadPanel();
  const { staleReading } = p.window.kadans;
  const now = 10_000_000;
  assert.equal(staleReading({ fresh: true, lastSample: now - 60 * 60_000 }, now), null);
  assert.equal(staleReading({ fresh: false, lastSample: now - 2 * 60_000 }, now), 'Last reading 2 min ago');
  assert.equal(staleReading({ fresh: false }, now), 'No recent reading');
  assert.equal(staleReading({ lastSample: now - 37 * 60_000 }, now), 'Last reading 37 min ago');
  assert.equal(staleReading({ lastSample: now - 9 * 60_000 }, now), null);
});

test('panel: reopening the popover (or coming back from Settings) a minute later does not blink every blob at once', () => {
  const clock = { now: 1_000_000 };
  const timers = [];
  const p = loadPanel({ clock, timers });
  const F = p.window.KADANS_FIXTURES;
  p.window.kadans.reset();
  p.window.kadans.render(F.blobs);
  const spread = () => {
    const ts = Object.values(p.window.kadans.blinkState().due).sort((a, b) => a - b);
    for (const t of ts) assert.ok(t - clock.now >= 3000 && t - clock.now <= 9000, `due in 3-9 s, got ${t - clock.now}`);
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= 300);
    const live = pending(timers).filter((t) => t.fn.name === 'blinkTick'); // (the slide's own class timer may be pending too)
    assert.equal(live.length, 1);
    assert.ok(live[0].ms >= 3000, `the next wake is a normal blink away, got ${live[0].ms} ms`);
  };
  p.window.kadans.visible(false);
  clock.now += 60_000;
  p.window.kadans.visible(true);
  spread();
  // Settings and back, 20 s later
  p.tap({ do: 'settings' });
  assert.equal(p.window.kadans.blinkState().armed, false);
  clock.now += 20_000;
  p.tap({ do: 'back' }); // motion is on, so Back waits for the slide-out
  timers.filter((t) => t.ms === 130 && !t.ran && !t.cleared).forEach(fire);
  spread();
});

// k25: "Use spare quota on its own" under the own account's gas switch.
test('panel: Settings "Use spare quota on its own": on / off / disabled strings, patched in place, sets autoGas and autoGasMax', () => {
  const p = loadPanel();
  const F = p.window.KADANS_FIXTURES;
  const line = () => {
    const m = /Use spare quota on its own<\/div><div class="d">([^<]*)<\/div>/.exec(p.html());
    return m ? m[1] : null;
  };
  const open = (f, config) => {
    p.window.kadans.reset();
    p.window.kadans.render(config ? { ...f, config } : f);
    f.after(p.document);
  };
  // the account's spare quota is off: the row is off, says why, and does nothing when tapped
  open(F.settings_autogas_off);
  assert.equal(line(), 'Off while “Use spare quota” is off');
  const sw = p.el.find('set:autoGas');
  assert.equal(sw.getAttribute('aria-disabled'), 'true');
  assert.equal(sw.getAttribute('aria-checked'), 'false');
  assert.equal(sw.getAttribute('data-do'), null);
  assert.equal(p.el.find('set:autoGasMax:1'), null);
  // autoGas true in the config still shows off (and disabled) while gas is off
  open(F.settings_autogas_off, { ...F.settings_autogas.config, accounts: { aaaaaaaaaaaa: { gas: false } } });
  assert.equal(line(), 'Off while “Use spare quota” is off');
  assert.equal(p.el.find('set:autoGas').getAttribute('aria-checked'), 'false');
  // on, 2 at a time
  open(F.settings_autogas);
  assert.equal(line(), 'Starts your next approved task when a window would end unused · max\u00a02\u00a0at\u00a0a\u00a0time');
  const on = p.el.find('set:autoGas');
  assert.equal(on.getAttribute('aria-checked'), 'true');
  assert.equal(on.getAttribute('aria-disabled'), null);
  assert.equal(p.el.find('set:autoGasMax:2').getAttribute('aria-pressed'), 'true');
  // autoGasMax 3: one config-set, the segment keeps its nodes and the line follows at once
  const b1 = p.el.find('set:autoGasMax:1');
  p.tap({ do: 'set', k: 'autoGasMax', v: '3' });
  assert.deepEqual({ ...p.sent.at(-1) }, { action: 'config-set', key: 'autoGasMax', value: '3' });
  assert.equal(p.el.find('set:autoGasMax:1'), b1);
  assert.equal(p.el.find('set:autoGasMax:3').getAttribute('aria-pressed'), 'true');
  assert.equal(line(), 'Starts your next approved task when a window would end unused · max\u00a03\u00a0at\u00a0a\u00a0time');
  // off: config-set autoGas false, the switch node is kept and the line says it is off
  p.tap({ do: 'set', k: 'autoGas', v: 'false' });
  assert.deepEqual({ ...p.sent.at(-1) }, { action: 'config-set', key: 'autoGas', value: 'false' });
  assert.equal(p.el.find('set:autoGas'), on);
  assert.equal(on.getAttribute('aria-checked'), 'false');
  assert.equal(line(), 'Starts your next approved task when a window would end unused · off until you turn it on');
  // the account's gas switched off from elsewhere: the same switch node turns disabled
  p.window.kadans.render({ config: { ...F.settings_autogas.config, autoGas: false, accounts: { aaaaaaaaaaaa: { gas: false } } } });
  assert.equal(p.el.find('set:autoGas'), on);
  assert.equal(on.getAttribute('aria-disabled'), 'true');
  assert.equal(on.getAttribute('data-do'), null);
  // a junk autoGasMax shows 1
  open(F.settings_autogas, { ...F.settings_autogas.config, autoGasMax: 9 });
  assert.equal(line(), 'Starts your next approved task when a window would end unused · max\u00a01\u00a0at\u00a0a\u00a0time');
  // an older CLI (no autoGas in config get): no row at all
  const { autoGas, autoGasMax, autoGasMinRamGB, ...old } = F.settings_autogas.config;
  open(F.settings_autogas, old);
  assert.equal(line(), null);
  assert.equal(p.el.find('set:autoGas'), null);
});

test('panel: Settings Back reports the main screen\'s height as its slide-in starts, not after it', () => {
  const clock = { now: 5_000_000 };
  const timers = [];
  const rect = FNode.prototype.getBoundingClientRect;
  // the Settings screen is tall (560), the main panel 400
  FNode.prototype.getBoundingClientRect = function () { return { height: / tall/.test(this.attrs.get('class') ?? '') ? 560 : 400 }; };
  try {
    const p = loadPanel({ clock, timers });
    const F = p.window.KADANS_FIXTURES;
    p.window.kadans.reset();
    p.window.kadans.render({ ...F.settings, after: undefined });
    const sizes = () => p.sent.filter((m) => m.action === 'size').map((m) => m.height);
    assert.deepEqual(sizes(), [400]);
    p.tap({ do: 'settings' });
    assert.deepEqual(sizes(), [400, 560]); // push: taller at once, the popover grows with the slide
    clock.now += 2000;
    timers.forEach((t) => { t.ran = true; }); // the push slide is over
    p.tap({ do: 'back' }); // the Settings screen slides out (130 ms), then the main panel slides in
    assert.deepEqual(sizes(), [400, 560]);
    const out = pending(timers).find((t) => t.ms === 130);
    assert.ok(out, 'Back waits for the slide-out');
    clock.now += 130;
    fire(out);
    // the shorter height goes out as the slide-in starts, with no size timer left waiting for the slide's end
    assert.deepEqual(sizes(), [400, 560, 400]);
    assert.ok(!pending(timers).some((t) => t.fn.name === 'reportSize'), 'no deferred size report');
    clock.now += 400;
    pending(timers).forEach(fire);
    assert.deepEqual(sizes(), [400, 560, 400]);
  } finally {
    FNode.prototype.getBoundingClientRect = rect;
  }
});

test('opening or closing the popover drops focus, so no row comes back highlighted', () => {
  const p = loadPanel();
  let blurred = 0;
  p.window.document.activeElement = { blur: () => { blurred += 1; } };
  p.window.kadans.visible(false);
  assert.equal(blurred, 1);
  p.window.kadans.visible(true);
  assert.equal(blurred, 2);
  p.window.document.activeElement = p.window.document.body;
  p.window.kadans.visible(true); // nothing focused: nothing to drop
  assert.equal(blurred, 2);
});
