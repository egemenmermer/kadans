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
  // a click on any element by its dataset (Settings segments carry data-k / data-v, which the fake querySelector does not parse)
  const tap = (dataset) => click({ target: { closest: () => ({ dataset, getAttribute: () => null }) } });
  return { window, document, html: () => html, sent, tap };
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
  assert.match(none, /Quarry · Opus · 148k ctx · 40 min/);
  assert.doesNotMatch(none, /class="tag"/);
  assert.doesNotMatch(none, /class="pv">[^<]*2\.1M/);
  assert.match(none, /title="Port the CSV importer\n2\.1M tokens since start, cache reads not counted"/);
  // null: no number in that slot
  const nul = rowHtml(html, 'fx-0025');
  assert.doesNotMatch(nul, /ctx/);
  assert.match(nul, /Fernway · Sonnet · 2 min/);
  // soon: the number is enough
  const soon = rowHtml(html, 'fx-0022');
  assert.match(soon, /92k ctx/);
  assert.doesNotMatch(soon, /class="tag"/);
  // now: a quiet tag right after the number, the why as its title and in the row's aria text
  const now = rowHtml(html, 'fx-0021');
  assert.match(now, /class="pv"><span class="tag" title="Idle 12 min: next turn re-reads all 152k">Compact\?<\/span> 152k ctx · Idle 12 min · Tidepool · Opus · 1 hr 35 min</);
  assert.match(now, /aria-label="Refactor the sync worker\. Compact\? Idle 12 min: next turn re-reads all 152k\. 152k ctx\. Idle/);
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
  assert.match(row, /<div class="cwhy"><span class="ask">Compact this chat\?<\/span> Idle 12 min: next turn re-reads all 152k<\/div>/);
  assert.match(row, /class="pv">Idle 12 min · Tidepool · Opus · 152k ctx · 1 hr 35 min</);
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
  assert.match(rowHtml(html, 'fx-0021'), /21k ctx/);
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
  assert.match(html, /152k ctx/); // the number stays
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
  assert.match(rowHtml(p.html(), 'fx-0022'), /92k ctx/);
  clock.now += 8_100;
  p.window.kadans.render({});
  row = rowHtml(p.html(), 'fx-0021');
  assert.doesNotMatch(row, /unsent text/);
  assert.match(row, /Compact\?<\/span> 152k ctx/);
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
  assert.match(row, /class="pv">Compacted · Tidepool · Opus · 21k ctx/);
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
