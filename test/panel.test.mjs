// Panel markup safety: every value that comes from JSON must reach the page as text. The panel is loaded in a vm with a
// minimal fake DOM, each fixture is rendered, and the resulting HTML is checked for injected tags and attributes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { read, FNode, loadPanel, assertNoInjection, flush, fakeServer, fixture, rowActs, allActs } from './panel-dom.mjs';

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

// k32: a row's meta line as text (it is split into spans so a narrow row never cuts the context number).
function pvText(row) {
  const m = /<div class="pv[^"]*">(.*?)<\/div>/.exec(row);
  assert.ok(m, 'the row has a meta line');
  return m[1].replace(/<[^>]+>/g, '');
}

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
  assert.equal(pvText(none), '40 min · 148k context · Quarry · Opus');
  assert.match(none, /<span class="cx"> · 148k context<\/span>/); // its own span: never cut by the ellipsis
  assert.doesNotMatch(none, /class="tag"/);
  assert.doesNotMatch(pvText(none), /2\.1M/);
  assert.match(none, /title="Port the CSV importer\n2\.1M tokens since start, cache reads not counted"/);
  // null: no number in that slot
  const nul = rowHtml(html, 'fx-0025');
  assert.doesNotMatch(nul, /\d+k context/);
  assert.match(nul, /2 min · Fernway · Sonnet/);
  // soon: the number is enough
  const soon = rowHtml(html, 'fx-0022');
  assert.match(soon, /92k context/);
  assert.doesNotMatch(soon, /class="tag"/);
  // now: a quiet tag right after the number, the why as its title and in the row's aria text
  const now = rowHtml(html, 'fx-0021');
  assert.match(now, /class="pv meta"><span class="tg"><span class="tag" title="Idle 12 min: next turn re-reads all 152k">Compact\?<\/span> 152k context<\/span><span class="ld"> · Idle 12 min<\/span><span class="pj"> · Tidepool<\/span>/);
  assert.equal(pvText(now), 'Compact? 152k context · Idle 12 min · Tidepool · Opus · 1 hr 35 min');
  assert.match(now, /aria-label="Refactor the sync worker\. Compact\? Idle 12 min: next turn re-reads all 152k\. 152k context\. Idle/);
  // now, but no Orca terminal: the tag tells the owner to type it
  assert.match(rowHtml(html, 'fx-0023'), /class="tag" title="Re-reads 128k tokens every turn\. Type \/compact in that chat">Compact\?/);
});

test('panel: Compact only on idle chats with advice in a usable Orca terminal', () => {
  const p = loadPanel();
  const F = p.window.KADANS_FIXTURES;
  const btnOn = (html, id) => new RegExp(`data-do="compact" data-id="${id}"`).test(rowActs(p, id)); // polish-2: the row and its More menu
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
  assert.doesNotMatch(allActs(p), /data-do="compact"/);
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
  assert.equal(pvText(row), 'Idle 12 min · 152k context · Tidepool · Opus · 1 hr 35 min');
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
  assert.match(pvText(rowHtml(html, 'fx-0021')), /^Compacting… · (\d+k context · )?Tidepool/);
  assert.doesNotMatch(rowHtml(html, 'fx-0021'), /class="tag"/);
  // no Compact anywhere while one is in flight, and a forged click is ignored
  assert.doesNotMatch(allActs(p), /data-do="compact"/);
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
  assert.match(rowActs(p, 'fx-0022'), /data-do="compact" data-id="fx-0022"/);

  // the other way: nothing changes for 90 s -> a quiet note, then Compact may be offered again
  p.document.querySelector('[data-do="compact"][data-id="fx-0022"]').click();
  p.document.querySelector('[data-do="compact-go"][data-id="fx-0022"]').click();
  assert.deepEqual(compacts(p).map((m) => m.id), ['fx-0021', 'fx-0022']);
  assert.ok(timers.some((t) => t.ms >= 90_000), 'a re-render is scheduled at the deadline');
  clock.now += 91_000;
  p.window.kadans.render({ agents: smaller });
  html = p.html();
  assert.match(rowHtml(html, 'fx-0022'), /<span class="warn" title="[^"]*">Compact not confirmed<\/span>/);
  assert.match(rowActs(p, 'fx-0022'), /data-do="compact" data-id="fx-0022"/);
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
  assert.doesNotMatch(allActs(p), /data-do="compact"/);
  assert.match(html, /152k context/); // the number stays
  p.tap({ do: 'compact', id: 'fx-0021' });
  assert.doesNotMatch(p.html(), /Compact this chat\?/);
  // Settings: Off is pressed and can be picked (the CLI stores 101 since k12)
  p.tap({ do: 'settings' });
  p.tap({ do: 'sub', id: 'advanced' }); // k43: Suggest compact is on Settings › Advanced
  html = p.html();
  assert.match(html, /aria-label="Suggest compact"/);
  assert.match(html, /<button aria-pressed="true" data-do="set" data-k="compact.soonPct" data-v="101" [^>]*>Off<\/button>/);
  assert.doesNotMatch(html, /not available yet/);
  // with 40 % stored: 40 % pressed; picking 60 % sends one config-set through the existing path
  p.window.kadans.reset();
  p.window.kadans.render(F.compact);
  p.tap({ do: 'settings' });
  p.tap({ do: 'sub', id: 'advanced' }); // k43: Suggest compact is on Settings › Advanced
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
  p.tap({ do: 'sub', id: 'advanced' }); // k43: Suggest compact is on Settings › Advanced
  assert.match(p.html(), /aria-pressed="true" data-do="set" data-k="compact.soonPct" data-v="40"/);
  p.tap({ do: 'set', k: 'compact.soonPct', v: '101' });
  assert.deepEqual(JSON.parse(JSON.stringify(p.sent.filter((m) => m.action === 'config-set'))), [{ action: 'config-set', key: 'compact.soonPct', value: '101' }]);
  assert.match(p.html(), /aria-pressed="true" data-do="set" data-k="compact.soonPct" data-v="101"[^>]*>Off</);
  p.window.kadans.render({ config: { ...F.compact.config, compact: { ...F.compact.config.compact, soonPct: 101 } } });
  p.tap({ do: 'back' });
  p.tap({ do: 'back' });
  assert.doesNotMatch(p.html(), /class="tag"/);
  assert.doesNotMatch(allActs(p), /data-do="compact"/);
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
  assert.match(rowActs(p, 'fx-0022'), /data-do="compact" data-id="fx-0022"/); // not in flight any more
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
  assert.match(pvText(rowHtml(p.html(), 'fx-0021')), /Compacting… · (\d+k context · )?Tidepool/);
  assert.doesNotMatch(p.html(), /Compacted/);
  clock.now += 20_000;
  const smaller = F.compact.agents.map((a) => (a.id === 'fx-0021' ? { ...a, context: { tokens: 21000, window: 200000, pct: 10.5, advice: 'none', why: null } } : a));
  p.window.kadans.render({ agents: smaller });
  let row = rowHtml(p.html(), 'fx-0021');
  assert.match(pvText(row), /^Compacted · 21k context · Tidepool · Opus/);
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
  p.window.kadans.render(F.settings_advanced); // k43: a switch, a segment and the usage line on Settings › Advanced
  F.settings_advanced.after(p.document);
  const sw = p.el.find('set:lean');
  const usage = p.el.find('set:usageApi');
  const seg = p.el.find('set:lang:en');
  assert.equal(sw.getAttribute('aria-checked'), 'true');
  p.log.length = 0;
  p.tap({ do: 'set', k: 'lean', v: 'false' });
  assert.ok(p.log.length > 0);
  for (const [op, key] of p.log) assert.deepEqual([op, key], ['attr', 'set:lean']);
  assert.equal(p.el.find('set:lean'), sw);
  assert.equal(sw.getAttribute('aria-checked'), 'false');
  assert.equal(sw.getAttribute('data-v'), 'true');
  assert.deepEqual({ ...p.sent.at(-1) }, { action: 'config-set', key: 'lean', value: 'false' });
  // the config that confirms it changes nothing more
  p.log.length = 0;
  p.window.kadans.render({ config: { ...F.settings.config, lean: false } });
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
  assert.equal(p.el.find('set:lean'), sw);
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
  assert.equal(open('settings_advanced'), 'Every 2 min · last read 1 min ago');
  assert.equal(open('settings_advanced', (f) => ua(f, { lastOk: N - 20_000 })), 'Every 2 min · last read just now');
  assert.equal(open('settings_advanced', (f) => ua(f, { lastOk: null })), 'Every 2 min · not read yet');
  assert.equal(open('settings_usage_login'), 'Needs a Claude Code login');
  const at = new Date(N + 8 * M);
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  assert.equal(open('settings_usage_error'), `Couldn't read · trying again at ${hhmm}`);
  assert.equal(open('settings_usage_error', (f) => ua(f, { nextAt: null })), "Couldn't read · trying again soon");
  // an error string from the CLI is never shown, whatever it holds
  const evil = '<img src=x onerror=alert(1)> /Users/me token';
  const html = (() => { open('settings_advanced', (f) => ua(f, { lastError: evil })); return p.html(); })();
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
  // the Settings screen is taller (560 here; since k43 it is as tall as its rows), the main panel 400
  FNode.prototype.getBoundingClientRect = function () { return { height: / screen/.test(this.attrs.get('class') ?? '') ? 560 : 400 }; };
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

// ---------- k27: phone (HTTP transport, tap-to-show actions) and Settings › Phone ----------
test('phone: pairs from #pair=, keeps the token, clears the hash, polls every 2 s while visible, sends actions over HTTP', async () => {
  const timers = [];
  const store = new Map();
  let state = null;
  const srv = fakeServer({
    'POST api/pair': [200, { token: 'tok-1' }],
    'GET api/state': () => [200, state],
    'POST api/action': (init) => { const b = JSON.parse(init.body); return [200, { action: b.action, id: b.id ?? null, ok: false, why: 'Refused on the Mac' }]; },
  });
  const http = { fetch: srv.fetch, hash: '#pair=abcdefghijklmnop234567', store };
  const p = loadPanel({ timers, http });
  state = fixture(p, 'cruise');
  await flush();
  assert.equal(p.document.documentElement.dataset.shell, 'phone');
  assert.deepEqual(srv.calls[0], { path: 'api/pair', method: 'POST', auth: null, body: { code: 'ABCDEFGHIJKLMNOP234567', name: 'iPhone' } });
  assert.equal(p.window.location.hash, '', 'the one-time code leaves the address bar');
  assert.equal(store.get('kadans.token'), 'tok-1');
  assert.deepEqual({ path: srv.calls[1].path, method: srv.calls[1].method, auth: srv.calls[1].auth }, { path: 'api/state', method: 'GET', auth: 'Bearer tok-1' });
  assert.equal(p.window.kadans.netState().state, 'live');
  assert.ok(p.html().includes('Brake hooks for the Stop event'), 'the state renders');
  const polls = () => timers.filter((t) => !t.cleared && t.ms >= 2000 && t.fn.name === 'poll');
  assert.equal(polls().length, 1, 'one poll pending');
  assert.equal(polls()[0].ms, 2000);
  // the poll runs: one more GET, one more timer
  const t = polls()[0];
  t.cleared = true;
  await t.fn();
  await flush();
  assert.equal(srv.calls.filter((c) => c.path === 'api/state').length, 2);
  assert.equal(polls().length, 1);
  // hidden: the poll stops; visible again: polls at once
  p.document.visibilityState = 'hidden';
  p.docListeners.visibilitychange.forEach((fn) => fn());
  assert.equal(polls().length, 0);
  p.document.visibilityState = 'visible';
  p.docListeners.visibilitychange.forEach((fn) => fn());
  await flush();
  assert.equal(srv.calls.filter((c) => c.path === 'api/state').length, 3);
  // actions: only the allow-listed ones go out (app-only ones are dropped), autopace becomes config-set, results show
  const before = srv.calls.length;
  for (const m of [{ action: 'size', height: 300 }, { action: 'open', id: 'fx-0002' }, { action: 'theme', theme: 'dark' }, { action: 'settings' }]) p.window.kadans.send(m);
  await flush();
  assert.equal(srv.calls.length, before, 'size / open / theme / settings never reach the server');
  p.window.kadans.send({ action: 'autopace', on: false });
  await flush();
  assert.deepEqual(srv.calls.find((c) => c.path === 'api/action').body, { action: 'config-set', key: 'autopace', value: 'false' });
  p.window.kadans.send({ action: 'stop', id: 'fx-0001' });
  await flush();
  const acts = srv.calls.filter((c) => c.path === 'api/action');
  assert.deepEqual(acts.at(-1), { path: 'api/action', method: 'POST', auth: 'Bearer tok-1', body: { action: 'stop', id: 'fx-0001' } });
  assert.ok(p.html().includes('Refused on the Mac'), 'the result reaches the row');
  assert.equal(srv.calls.at(-1).path, 'api/state', 'an action is followed by a fresh read');
});

test('phone (k29): iOS Safari with #pair= holds the code for the home-screen app; no POST until "Use it in Safari instead"', async () => {
  const CODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const timers = [];
  const store = new Map();
  const srv = fakeServer({ 'POST api/pair': [200, { token: 'tok-s' }], 'GET api/state': () => [200, state] });
  const http = { fetch: srv.fetch, hash: `#pair=${CODE.toLowerCase()}`, store, standalone: false, displayMode: 'browser' };
  const p = loadPanel({ timers, http });
  const state = fixture(p, 'cruise');
  await flush();
  assert.equal(srv.calls.length, 0, 'nothing sent: the code is for the home-screen app');
  assert.equal(p.window.kadans.netState().state, 'install');
  assert.equal(p.document.manifestLink.href, `manifest.webmanifest?pair=${CODE}`, 'the manifest starts the app at /#pair=<code>');
  assert.equal(p.window.location.hash, `#pair=${CODE.toLowerCase()}`, 'the hash stays, in case iOS adds the page URL');
  assert.equal(http.replaced, undefined);
  const h = p.html();
  assert.match(h, /Add Kadans to your Home Screen/);
  assert.match(h, /Tap Share <svg class="share"[^]*<\/svg>, then Add to Home Screen\. Open it from there\./);
  assert.match(h, /<button class="pill quiet" data-do="pair-here"[^>]*>Use it in Safari instead<\/button>/);
  assert.ok(!h.includes(CODE) && !h.includes(CODE.toLowerCase()), 'the code is not in the page');
  assert.ok(!h.includes('data-do="settings"'), 'the card replaces the panel');
  assertNoInjection(h, 'install');
  assert.equal(timers.filter((t) => !t.cleared && t.fn.name === 'poll').length, 0, 'no polling');
  // a stored Safari token does not change that: a new code still goes to the home-screen app
  const store2 = new Map([['kadans.token', 'old']]);
  const srv2 = fakeServer({});
  const p2 = loadPanel({ http: { fetch: srv2.fetch, hash: `#pair=${CODE}`, store: store2, standalone: false } });
  await flush();
  assert.equal(srv2.calls.length, 0);
  assert.equal(p2.window.kadans.netState().state, 'install');
  // coming back to the tab (or retry) does not poll with that token and does not replace the card
  p2.docListeners.visibilitychange.forEach((f) => f());
  p2.window.kadans.send({ action: 'retry' });
  await flush();
  assert.equal(srv2.calls.length, 0);
  assert.equal(p2.window.kadans.netState().state, 'install');
  srv2.routes['POST api/pair'] = [200, { token: 'new' }];
  srv2.routes['GET api/state'] = [200, fixture(p2, 'cruise')];
  p2.tap({ do: 'pair-here' });
  await flush();
  assert.equal(srv2.calls[0].path, 'api/pair');
  assert.equal(srv2.calls[1].auth, 'Bearer new');
  assert.equal(store2.get('kadans.token'), 'new');
  // "Use it in Safari instead": pairs here as before, plain manifest back, hash cleared
  p.tap({ do: 'pair-here' });
  await flush();
  assert.deepEqual(srv.calls[0], { path: 'api/pair', method: 'POST', auth: null, body: { code: CODE, name: 'iPhone' } });
  assert.equal(store.get('kadans.token'), 'tok-s');
  assert.equal(p.window.location.hash, '');
  assert.equal(p.document.manifestLink.href, 'manifest.webmanifest');
  assert.equal(p.window.kadans.netState().state, 'live');
  assert.equal(srv.calls[1].auth, 'Bearer tok-s');
  p.tap({ do: 'pair-here' });
  await flush();
  assert.equal(srv.calls.filter((c) => c.path === 'api/pair').length, 1, 'the button pairs once');
  // no manifest link: still the screen, nothing thrown
  const p3 = loadPanel({ http: { fetch: fakeServer({}).fetch, hash: `#pair=${CODE}`, standalone: false, noManifest: true } });
  await flush();
  assert.equal(p3.window.kadans.netState().state, 'install');
});

test('phone (k29): the home-screen app pairs from its start_url, clears the hash, and ignores the spent code on later launches', async () => {
  const CODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const mode of [{ standalone: true, displayMode: 'standalone' }, { standalone: true, displayMode: 'browser' }, { displayMode: 'standalone' }]) {
    const store = new Map();
    let state = null;
    const srv = fakeServer({ 'POST api/pair': [200, { token: 'tok-h' }], 'GET api/state': () => [200, state] });
    const http = { fetch: srv.fetch, hash: `#pair=${CODE}`, store, ...mode };
    const p = loadPanel({ http });
    state = fixture(p, 'cruise');
    await flush();
    assert.deepEqual(srv.calls[0], { path: 'api/pair', method: 'POST', auth: null, body: { code: CODE, name: 'iPhone' } }, JSON.stringify(mode));
    assert.equal(store.get('kadans.token'), 'tok-h');
    assert.equal(p.window.location.hash, '');
    assert.equal(p.document.manifestLink.href, 'manifest.webmanifest', 'the app leaves the manifest alone');
    assert.equal(p.window.kadans.netState().state, 'live');
    // a cold launch later: the same start_url, a token stored -> no pair call, a Bearer poll, the token kept
    const srv2 = fakeServer({ 'POST api/pair': [401, { error: 'bad_code' }], 'GET api/state': () => [200, state] });
    const p2 = loadPanel({ http: { ...http, fetch: srv2.fetch, hash: `#pair=${CODE}`, replaced: [] } });
    await flush();
    assert.equal(srv2.calls.filter((c) => c.path === 'api/pair').length, 0);
    assert.equal(srv2.calls[0].auth, 'Bearer tok-h');
    assert.equal(store.get('kadans.token'), 'tok-h');
    assert.equal(p2.window.location.hash, '');
    assert.equal(p2.window.kadans.netState().state, 'live');
  }
  // not iOS (navigator.standalone unset, e.g. Android): pairs at once in the browser, as before k29
  const srv3 = fakeServer({ 'POST api/pair': [200, { token: 't3' }] });
  loadPanel({ http: { fetch: srv3.fetch, hash: `#pair=${CODE}` } });
  await flush();
  assert.equal(srv3.calls[0].path, 'api/pair');
});

test('phone: a 401 drops the token and shows "Pair again"; no token and no code makes no request at all', async () => {
  const timers = [];
  const store = new Map([['kadans.token', 'old']]);
  const srv = fakeServer({ 'GET api/state': [401, { error: 'unauthorized' }] });
  const p = loadPanel({ timers, http: { fetch: srv.fetch, store } });
  await flush();
  assert.equal(srv.calls[0].auth, 'Bearer old');
  assert.equal(store.has('kadans.token'), false);
  assert.equal(p.window.kadans.netState().state, 'unpaired');
  assert.match(p.html(), /Pair again/);
  assert.match(p.html(), /Scan the code in Kadans on your Mac/);
  assert.ok(!p.html().includes('data-do="settings"'), 'nothing else on the page while unpaired');
  assert.equal(timers.filter((t) => !t.cleared && t.fn.name === 'poll').length, 0, 'no polling without a token');
  // an action with no token goes nowhere
  p.window.kadans.send({ action: 'stop', id: 'x' });
  await flush();
  assert.equal(srv.calls.length, 1);

  const srv2 = fakeServer({});
  const p2 = loadPanel({ http: { fetch: srv2.fetch } });
  await flush();
  assert.equal(srv2.calls.length, 0);
  assert.match(p2.html(), /Pair this phone/);

  // a used or expired code: 401 from /api/pair
  const srv3 = fakeServer({ 'POST api/pair': [401, { error: 'bad code' }] });
  const p3 = loadPanel({ http: { fetch: srv3.fetch, hash: '#pair=ABCDEFGHJKLMNPQR' } });
  await flush();
  assert.equal(srv3.calls.length, 1);
  assert.match(p3.html(), /That code didn’t work/);
  assert.match(p3.html(), /Pair again/);
  // the Mac not answering: the last reading stays, with a quiet note
  let up = true;
  const srv4 = fakeServer({ 'POST api/pair': [200, { token: 't' }], 'GET api/state': () => (up ? [200, state4] : null) });
  const t4 = [];
  const p4 = loadPanel({ timers: t4, http: { fetch: srv4.fetch, hash: '#pair=ABCDEFGHJKLMNPQR' } });
  const state4 = fixture(p4, 'cruise');
  await flush();
  up = false;
  const t = t4.find((x) => !x.cleared && x.fn.name === 'poll');
  t.cleared = true;
  await t.fn();
  await flush();
  assert.match(p4.html(), /Can’t reach your Mac · trying again/);
  assert.ok(p4.html().includes('Brake hooks for the Stop event'), 'the last reading stays');
  assert.equal(t4.filter((x) => !x.cleared && x.fn.name === 'poll').at(-1).ms, 2000);
  // 503: phone access was turned off on the Mac; the token stays, polling goes on more slowly
  const off = fakeServer({ 'GET api/state': [503, { error: 'off' }] });
  const t5 = [];
  const store5 = new Map([['kadans.token', 'keep']]);
  const p5 = loadPanel({ timers: t5, http: { fetch: off.fetch, store: store5 } });
  await flush();
  assert.match(p5.html(), /Phone access is off on your Mac/);
  assert.equal(store5.get('kadans.token'), 'keep');
  assert.equal(t5.filter((x) => !x.cleared && x.fn.name === 'poll').at(-1).ms, 4000);
});

test('phone: a tap on a row shows its actions, a second tap or a tap elsewhere hides them; no hover needed', async () => {
  let state = null;
  const srv = fakeServer({ 'POST api/pair': [200, { token: 't' }], 'GET api/state': () => [200, state] });
  const p = loadPanel({ http: { fetch: srv.fetch, hash: '#pair=ABCDEFGHJKLMNPQR' } });
  state = fixture(p, 'cruise');
  await flush();
  const click = p.el.listeners.click[0];
  const rowTarget = (key) => ({ closest: (sel) => (sel.includes('.row') ? { getAttribute: () => key, classList: { contains: () => false } } : null) });
  const btnIn = (key, dataset) => ({ closest: (sel) => (sel.includes('data-do') ? { dataset, getAttribute: () => null }
    : sel.includes('.row') ? { getAttribute: () => key, classList: { contains: () => false } } : null) });
  const hov = (key) => / hov\b/.test(p.el.find(key).getAttribute('class'));
  assert.equal(hov('row:fx-0001'), false);
  click({ target: rowTarget('row:fx-0001') });
  assert.equal(hov('row:fx-0001'), true, 'tap shows the actions');
  assert.equal(p.window.kadans.netState().tapKey, 'row:fx-0001');
  click({ target: btnIn('row:fx-0001', { do: 'pace', id: 'fx-0001' }) });
  assert.equal(hov('row:fx-0001'), true, 'a button inside the open row keeps it open');
  click({ target: rowTarget('row:fx-0002') });
  assert.equal(hov('row:fx-0001') || p.window.kadans.netState().tapKey !== 'row:fx-0002', false, 'one open row at a time');
  click({ target: rowTarget('row:fx-0002') });
  assert.equal(p.window.kadans.netState().tapKey, null, 'a second tap hides them');
  click({ target: rowTarget('row:fx-0001') });
  click({ target: { closest: () => null } });
  assert.equal(p.window.kadans.netState().tapKey, null, 'a tap on empty space hides them');
  assert.equal(hov('row:fx-0001'), false);
  // the open row survives a refresh, and goes when its agent does
  click({ target: rowTarget('row:fx-0001') });
  p.window.kadans.render(fixture(p, 'cruise'));
  assert.equal(hov('row:fx-0001'), true);
  p.window.kadans.render({ agents: [] });
  assert.equal(p.window.kadans.netState().tapKey, null);
  // the Mac (pointer with hover) is unchanged: a click on a row opens nothing
  const m = loadPanel();
  m.window.kadans.render(m.window.KADANS_FIXTURES.cruise);
  m.el.listeners.click[0]({ target: rowTarget('row:fx-0001') });
  assert.equal(/ hov\b/.test(m.el.find('row:fx-0001').getAttribute('class')), false);
});

test('Settings › Phone: off, on with devices, pairing with QR and countdown, expired, error; sends phone-* actions', () => {
  const clock = { now: 1792964040000 };
  const timers = [];
  const p = loadPanel({ clock, timers });
  const F = p.window.KADANS_FIXTURES;
  const open = (name) => {
    p.window.kadans.reset();
    const f = F[name];
    p.window.kadans.render(f);
    f.after(p.document);
    return p.html();
  };
  // no phone payload (older app): no section
  assert.ok(!open('settings').includes('Use Kadans on your phone'));
  // off
  let h = open('settings_phone_off');
  assert.match(h, /<span class="ttl">Phone<\/span>/); // k43: its own screen, pushed from the Phone row
  assert.match(h, /Use Kadans on your phone/);
  assert.match(h, /On your Wi-Fi the link is not encrypted; turn on Tailscale to use it away from home or on shared Wi-Fi/);
  assert.equal(p.el.find('set:phone').getAttribute('aria-checked'), 'false');
  assert.ok(!h.includes('Pair a phone') && !h.includes('Revoke'));
  p.tap({ do: 'phone-on' });
  assert.deepEqual({ ...p.sent.at(-1) }, { action: 'phone-on' });
  assert.equal(p.el.find('set:phone').getAttribute('aria-checked'), 'true', 'the switch flips at once');
  // on, with devices
  h = open('settings_phone_on');
  assert.equal(p.el.find('set:phone').getAttribute('aria-checked'), 'true');
  assert.match(h, /data-do="phone-pair"[^>]*>Show code</);
  assert.match(h, /<div>iPhone<\/div><div class="d">Used 3 min ago<\/div>/);
  assert.match(h, /<div>iPad<\/div><div class="d">Not used yet<\/div>/);
  p.tap({ do: 'phone-pair' });
  assert.deepEqual({ ...p.sent.at(-1) }, { action: 'phone-pair' });
  p.tap({ do: 'phone-revoke', id: 'd1' });
  assert.deepEqual({ ...p.sent.at(-1) }, { action: 'phone-revoke', id: 'd1' });
  p.tap({ do: 'phone-off' });
  assert.deepEqual({ ...p.sent.at(-1) }, { action: 'phone-off' });
  // pairing: the QR, the line, the countdown; one 1 s timer patches the countdown alone
  h = open('settings_phone_pairing');
  assert.match(h, /<img class="qr" src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="Pairing code for your phone"/);
  assert.match(h, /Scan with your phone’s camera, then Add to Home Screen/);
  assert.match(h, /Works once · 9:41 left/);
  assert.ok(!h.includes('Pair a phone'));
  const tick = timers.filter((t) => !t.cleared && t.ms <= 1000).at(-1);
  assert.ok(tick, 'a countdown timer runs');
  clock.now += 1000;
  p.log.length = 0;
  tick.fn();
  assert.match(p.html(), /9:40 left/);
  assert.deepEqual(p.log, [['replace', 'div']], 'one node changes: the countdown line (the QR image stays)');
  // expired
  h = open('settings_phone_expired');
  assert.match(h, /This code has expired/);
  assert.match(h, /data-do="phone-pair"[^>]*>New code</);
  assert.ok(!h.includes('<img'));
  // error: a fixed line, never the app's text
  h = open('settings_phone_error');
  assert.match(h, /Couldn’t start the phone link\. Turn it off and on to try again\./);
  assert.ok(!h.includes('EADDRINUSE') && !h.includes('192.0.2.10'));
  // a QR that is not a PNG data URL is never drawn; a hostile device name is text
  p.window.kadans.render({ phone: { on: true, pair: { qr: 'javascript:alert(1)" onerror="x', expiresAt: clock.now + 60000 }, devices: [{ id: 'z"><b>', name: '<img src=x onerror=alert(1)>' }] } });
  h = p.html();
  assert.ok(!h.includes('<img'));
  assertNoInjection(h.replace(/<img class="qr"[^>]*>/g, ''), 'phone');
  assert.ok(h.includes('&lt;img src=x onerror=alert(1)&gt;'));
  // leaving Settings tells the app (it stops polling devices); Back from Phone lands on Settings first, which does not
  p.tap({ do: 'back' });
  assert.notEqual(p.sent.at(-1)?.action, 'settings-closed');
  assert.match(p.html(), /<span class="ttl">Settings<\/span>/);
  p.tap({ do: 'back' });
  assert.deepEqual({ ...p.sent.at(-1) }, { action: 'settings-closed' });
});

test('phone: Settings on the phone has no Phone or Claude Code group (Mac-only), and leaving it sends nothing to the app', async () => {
  let state = null;
  const srv = fakeServer({ 'POST api/pair': [200, { token: 't' }], 'GET api/state': () => [200, state] });
  const p = loadPanel({ http: { fetch: srv.fetch, hash: '#pair=ABCDEFGHJKLMNPQR' } });
  state = { ...fixture(p, 'settings'), phone: { on: true, devices: [] } };
  await flush();
  p.tap({ do: 'settings' });
  const h = p.html();
  assert.match(h, /5-hour target/);
  assert.ok(!h.includes('data-id="phone"') && !h.includes('data-id="computers"'));
  p.tap({ do: 'sub', id: 'advanced' });
  assert.match(p.html(), /Status line language/);
  assert.ok(!p.html().includes('Remove from Claude Code'));
  const n = srv.calls.length;
  p.tap({ do: 'back' });
  p.tap({ do: 'back' });
  await flush();
  assert.ok(srv.calls.slice(n).every((c) => c.path === 'api/state'));
  // revoked while Settings is open: back to the main screen with "Pair again"
  p.tap({ do: 'settings' });
  state = null;
  srv.routes['GET api/state'] = [401, { error: 'unauthorized' }];
  p.docListeners.visibilitychange.forEach((fn) => fn());
  await flush();
  assert.match(p.html(), /Pair again/);
  assert.ok(!p.html().includes('Kadans settings'));
});

// ---------- k32: sub-agent numbers, rename, arrange ----------
function arrangePanel(opts = {}) {
  const clock = { now: 1_000_000 };
  const timers = [];
  const p = loadPanel({ clock, timers, ...opts });
  const KF = p.window.KF;
  const data = () => JSON.parse(JSON.stringify({ status: KF.status(), agents: KF.base() }));
  p.window.kadans.reset();
  p.window.kadans.render(data());
  clock.now += 1000; // past the first-paint quiet time, so motion is on
  timers.length = 0;
  p.log.length = 0;
  const list = p.el.find('row:fx-0001').parentNode;
  list.getBoundingClientRect = () => ({ left: 0, right: 304, top: 0, bottom: 164, height: 164 });
  const down = (id, y, more = {}) => p.el.listeners.pointerdown.forEach((fn) => fn({ target: p.el.find(`row:${id}`), pointerId: 1, pointerType: 'mouse',
    button: 0, clientX: 100, clientY: y, ...more }));
  const doc = (type, e) => p.docListeners[type].forEach((fn) => fn({ pointerId: 1, clientX: 100, preventDefault() {}, type, ...e }));
  const hold = () => { const t = timers.find((x) => x.ms === 250 && !x.cleared && !x.ran); t.ran = true; t.fn(); };
  const order = () => list.kids.map((k) => k.attrs.get('data-key')).filter((k) => k !== undefined); // k42: not the Agents heading or Up next
  const reorders = () => JSON.parse(JSON.stringify(p.sent.filter((m) => m.action === 'reorder'))); // out of the vm's realm
  const key = (e) => p.docListeners.keydown.forEach((fn) => fn({ preventDefault() {}, ...e }));
  // the drop's settle (spring) timer
  const settle = () => timers.filter((x) => !x.cleared && !x.ran && x.ms >= 200 && x.ms < 1000).forEach((x) => { x.ran = true; x.fn(); });
  return { p, clock, timers, data, list, down, doc, hold, order, reorders, key, settle };
}

test('k32: a sub-agent row shows what it spends (context, else tokens) with both in its tooltip; the parent adds the sum', () => {
  const { p, data } = arrangePanel();
  let html = p.html();
  assert.match(html, /<span class="sn">· 45k<\/span>/);
  assert.match(html, /data-key="sub:fx-sub-1" title="Reading the hooks docs\n45k context · 120k tokens since start" aria-label="Subagent: Reading the hooks docs\. 45k context · 120k tokens since start"/);
  assert.match(html, /title="Brake hooks for the Stop event\n182k tokens since start, cache reads not counted\nsub-agents: 300k"/);
  const d = data();
  Object.assign(d.agents[0].subagents[0], { context: null, tokens: 120000 });
  delete d.agents[0].subagentTokens;
  p.window.kadans.render(d);
  html = p.html();
  assert.match(html, /<span class="sn">· 120k<\/span>/);
  assert.match(html, /title="Reading the hooks docs\n120k tokens since start"/);
  assert.doesNotMatch(html, /sub-agents:/);
  Object.assign(d.agents[0].subagents[0], { context: null, tokens: null });
  p.window.kadans.render(d);
  assert.doesNotMatch(p.html(), /class="sn"/);
  assert.match(p.html(), /data-key="sub:fx-sub-1" title="Reading the hooks docs" aria-label="Subagent: Reading the hooks docs"/);
});

test('k32: drag reorder: hold, move up past two rows, drop; the block lands first and one reorder carries the new ids', () => {
  const { p, timers, down, doc, hold, order, reorders, list } = arrangePanel();
  assert.deepEqual(order(), ['row:fx-0001', 'sub:fx-sub-1', 'row:fx-0002', 'row:fx-0003']);
  down('fx-0003', 140);
  assert.equal(p.window.kadans.arrangeState().phase, 'hold');
  hold();
  assert.equal(p.window.kadans.arrangeState().phase, 'on');
  const row = p.el.find('row:fx-0003');
  assert.match(row.getAttribute('class'), /\bcarried\b.*\blift\b|\blift\b.*\bcarried\b/);
  assert.match(list.getAttribute('class'), /\barranging\b/);
  doc('pointermove', { clientY: 90 }); // 50 px up: past fx-0002's middle
  assert.equal(p.window.kadans.arrangeState().to, 1);
  assert.equal(p.el.find('row:fx-0002').style.translate, '0 44px'); // fx-0002 glides down by the held row's height
  doc('pointermove', { clientY: 10 }); // further up, past fx-0001 and its sub-agent
  assert.equal(p.window.kadans.arrangeState().to, 0);
  assert.equal(p.el.find('row:fx-0001').style.translate, '0 44px');
  assert.equal(p.el.find('sub:fx-sub-1').style.translate, '0 44px'); // the sub-agent row moves with its parent
  assert.ok(Number.parseFloat(row.style.translate.split(' ')[1]) < -120, 'the held row follows the pointer (rubber band past the top)');
  assert.equal(reorders().length, 0, 'nothing is sent while the row is held');
  doc('pointerup', {});
  assert.deepEqual(reorders(), [{ action: 'reorder', ids: ['fx-0003', 'fx-0001', 'fx-0002'] }]);
  assert.deepEqual(order().filter(Boolean), ['row:fx-0003', 'row:fx-0001', 'sub:fx-sub-1', 'row:fx-0002']);
  assert.equal(p.el.find('row:fx-0003'), row, 'the same node, moved');
  for (const k of ['row:fx-0001', 'sub:fx-sub-1', 'row:fx-0002', 'row:fx-0003']) assert.equal(p.el.find(k).style.translate, '');
  assert.equal(p.window.kadans.arrangeState().phase, 'settle');
  timers.filter((t) => !t.cleared && t.ms < 1000 && t.ms >= 200).forEach((t) => t.fn());
  assert.equal(p.window.kadans.arrangeState().phase, null);
  assert.doesNotMatch(row.getAttribute('class'), /carried|lift/);
  assert.ok(!list.kids.some((k) => /plate/.test(k.attrs.get('class') ?? '')), 'the plate is gone');
  // the click that ends a drag does nothing
  p.el.listeners.click[0]({ target: row });
  assert.equal(p.sent.filter((m) => m.action !== 'reorder' && m.action !== 'size').length, 0);
});

test('k32: the order holds until the served order agrees (or 10 s pass), then the data decides', () => {
  const { p, clock, data, down, doc, hold, order, settle } = arrangePanel();
  down('fx-0001', 20);
  hold();
  doc('pointermove', { clientY: 170 }); // down past both others (rubber band past the end)
  doc('pointerup', {});
  const want = ['row:fx-0002', 'row:fx-0003', 'row:fx-0001', 'sub:fx-sub-1'];
  assert.deepEqual(order().filter(Boolean).slice(0, 4), want);
  p.window.kadans.render(data()); // still the old served order, while the drop settles: kept for later
  settle();
  clock.now += 1000;
  p.window.kadans.render(data());
  assert.deepEqual(order().slice(0, 4), want, 'a refresh before the CLI stored it does not snap the row back');
  const d = data();
  d.agents = [d.agents[1], d.agents[2], d.agents[0]];
  p.window.kadans.render(d);
  assert.equal(p.window.kadans.arrangeState().order, null, 'served order agrees: local order dropped');
  assert.deepEqual(order().slice(0, 4), want);
  // a refused reorder puts the served order back at once
  down('fx-0003', 76 + 22);
  hold();
  doc('pointermove', { clientY: 10 });
  doc('pointerup', {});
  settle();
  assert.equal(order()[0], 'row:fx-0003');
  p.window.kadans.result({ action: 'reorder', ok: false, why: 'Unknown command' });
  assert.equal(p.window.kadans.arrangeState().order, null);
  assert.equal(order()[0], 'row:fx-0002');
  // no answer and no new order from the CLI (an older one): after 10 s the served order is back
  down('fx-0003', 76 + 22);
  hold();
  doc('pointermove', { clientY: 10 });
  doc('pointerup', {});
  settle();
  p.window.kadans.render(d);
  assert.equal(order()[0], 'row:fx-0003');
  clock.now += 10_500;
  p.window.kadans.render(d);
  assert.equal(order()[0], 'row:fx-0002');
});

test('k32: Escape or a drop outside the list cancels: no reorder, the order and the inline moves are undone', () => {
  const { p, down, doc, hold, order, reorders, key } = arrangePanel();
  const before = order();
  down('fx-0002', 98);
  hold();
  doc('pointermove', { clientY: 10 });
  assert.equal(p.window.kadans.arrangeState().to, 0);
  key({ key: 'Escape' });
  assert.equal(reorders().length, 0);
  assert.ok(!p.sent.some((m) => m.action === 'close'), 'Escape cancels the drag, it does not close the popover');
  assert.deepEqual(order().filter(Boolean), before);
  for (const k of before) assert.equal(p.el.find(k).style.translate, '');
  // a press while the last drop settles is ignored
  down('fx-0003', 142);
  const t = p.window.kadans.arrangeState();
  assert.equal(t.phase, 'settle', 'a new press waits for the last drop to settle');
});

test('k32: a drop well outside the list glides back and sends nothing; a press that moves first is not a hold', () => {
  const { p, down, doc, hold, order, reorders, timers } = arrangePanel();
  const before = order();
  down('fx-0002', 98);
  hold();
  doc('pointermove', { clientY: 10 });
  doc('pointermove', { clientY: 10, clientX: 420 }); // off the panel to the right
  assert.equal(p.window.kadans.arrangeState().out, true);
  assert.equal(p.window.kadans.arrangeState().to, 1, 'outside: the target is the row\'s own place');
  assert.equal(p.el.find('row:fx-0001').style.translate, '');
  doc('pointerup', { clientX: 420 });
  assert.equal(reorders().length, 0);
  assert.deepEqual(order().filter(Boolean), before);
  timers.filter((x) => !x.cleared && x.ms >= 200 && x.ms < 1000).forEach((x) => x.fn());
  // a press that wanders more than a few px before the hold is a scroll or a click: no drag
  down('fx-0002', 98);
  doc('pointermove', { clientY: 110 });
  assert.equal(p.window.kadans.arrangeState().phase, null);
  // buttons, ended rows, sub-agent rows and the idle group never start a hold
  p.el.listeners.pointerdown.forEach((fn) => fn({ target: p.el.find('sub:fx-sub-1'), pointerId: 1, button: 0, clientX: 0, clientY: 50 }));
  assert.equal(p.window.kadans.arrangeState().phase, null);
});

test('k32: a hold pending when the popover closes never lifts, so later refreshes are still drawn', () => {
  const { p, data, down, timers } = arrangePanel();
  down('fx-0003', 140);
  p.window.kadans.visible(false);
  const t = timers.find((x) => x.ms === 250);
  assert.equal(t.cleared, true);
  t.fn(); // even if the timer still ran
  assert.equal(p.window.kadans.arrangeState().phase, null);
  p.window.kadans.visible(true);
  const d = data();
  d.agents.unshift(p.window.KF.agent('fx-0031', { title: 'Another one', startedAt: p.window.KF.N - 60000 }));
  p.window.kadans.render(d);
  assert.ok(p.el.find('row:fx-0031'));
});

test('k32: a refresh during a drag never yanks the held row; it is drawn on drop', () => {
  const { p, data, down, doc, hold, list, reorders } = arrangePanel();
  down('fx-0003', 140);
  hold();
  doc('pointermove', { clientY: 100 });
  const row = p.el.find('row:fx-0003');
  const t = row.style.translate;
  p.log.length = 0;
  const d = data();
  d.agents.unshift(p.window.KF.agent('fx-0030', { title: 'A new one', startedAt: p.window.KF.N - 60000 }));
  d.agents[3].project = 'Moved on';
  p.window.kadans.render(d);
  assert.deepEqual(p.log, [], 'nothing on screen changed');
  assert.equal(p.el.find('row:fx-0030'), null);
  assert.equal(row.style.translate, t);
  doc('pointermove', { clientY: 96 });
  doc('pointerup', {});
  assert.deepEqual(reorders()[0].ids, ['fx-0001', 'fx-0003', 'fx-0002']); // the rows as they were when lifted
  assert.ok(p.el.find('row:fx-0030'), 'the kept data is drawn after the drop');
  assert.ok(list.kids.indexOf(p.el.find('row:fx-0003')) < list.kids.indexOf(p.el.find('row:fx-0002')));
});

test('k32: Alt+Down / Alt+Up on a focused row moves it one place at once and sends the new order', () => {
  const { p, key, order, reorders } = arrangePanel();
  p.document.activeElement = p.el.find('row:fx-0001');
  let prevented = 0;
  key({ key: 'ArrowDown', altKey: true, preventDefault() { prevented += 1; } });
  assert.equal(prevented, 1);
  assert.deepEqual(reorders(), [{ action: 'reorder', ids: ['fx-0002', 'fx-0001', 'fx-0003'] }]);
  assert.deepEqual(order(), ['row:fx-0002', 'row:fx-0001', 'sub:fx-sub-1', 'row:fx-0003']);
  assert.ok(!p.log.some(([op, k]) => op === 'class' && /row/.test(k) && false));
  p.document.activeElement = p.el.find('row:fx-0002');
  key({ key: 'ArrowUp', altKey: true }); // already first: nothing to send
  assert.equal(reorders().length, 1);
  p.document.activeElement = p.el.find('row:fx-0003');
  key({ key: 'ArrowUp', altKey: true });
  assert.deepEqual(reorders()[1].ids, ['fx-0002', 'fx-0003', 'fx-0001']);
  // a sub-agent row is not moved, and plain arrows do nothing
  p.document.activeElement = p.el.find('sub:fx-sub-1');
  key({ key: 'ArrowDown', altKey: true });
  p.document.activeElement = p.el.find('row:fx-0002');
  key({ key: 'ArrowDown' });
  assert.equal(reorders().length, 2);
});

test('k32: rename: double-click the title, Enter saves (trimmed, 80 max), Escape cancels, empty clears; a refresh keeps the field', () => {
  const { p, clock, data, key } = arrangePanel();
  const dbl = (id) => p.el.listeners.dblclick.forEach((fn) => fn({ target: p.el.find(`row:${id}`).kids[1].kids[0] }));
  const renames = () => JSON.parse(JSON.stringify(p.sent.filter((m) => m.action === 'rename')));
  dbl('fx-0001');
  assert.match(p.html(), /<input class="rn" type="text" data-key="rn:fx-0001" value="Brake hooks for the Stop event" maxlength="80" placeholder="Automatic title"/);
  assert.match(p.el.find('row:fx-0001').getAttribute('class'), /\brenaming\b/);
  const inp = p.el.find('rn:fx-0001');
  inp.value = '  Ship the brake  ';
  clock.now += 60_000;
  const d = data();
  d.status.now += 60_000; // the minute tick changes the meta line
  p.window.kadans.render(d);
  assert.equal(p.el.find('rn:fx-0001'), inp, 'the field keeps its node (and what was typed)');
  key({ key: 'Enter', target: inp });
  assert.deepEqual(renames(), [{ action: 'rename', id: 'fx-0001', title: 'Ship the brake' }]);
  assert.match(p.html(), /<div class="nm">Ship the brake<\/div>/, 'the new name shows at once');
  p.window.kadans.render(data()); // served title not updated yet: the new name stays
  assert.match(p.html(), /<div class="nm">Ship the brake<\/div>/);
  // Escape cancels and never closes the popover
  dbl('fx-0002');
  p.el.find('rn:fx-0002').value = 'Something else';
  key({ key: 'Escape', target: p.el.find('rn:fx-0002') });
  assert.equal(renames().length, 1);
  assert.ok(!p.sent.some((m) => m.action === 'close'));
  assert.doesNotMatch(p.html(), /class="rn"/);
  // empty clears to the automatic title; long names are cut at 80, control characters dropped
  dbl('fx-0003');
  p.el.find('rn:fx-0003').value = `${'x'.repeat(100)}`;
  key({ key: 'Enter', target: p.el.find('rn:fx-0003') });
  assert.equal(renames()[1].title.length, 80);
  const d2 = data();
  d2.agents[0].title = 'Ship the brake';
  p.window.kadans.render(d2);
  dbl('fx-0001');
  assert.match(p.html(), /value="Ship the brake"/);
  p.el.find('rn:fx-0001').value = '   ';
  key({ key: 'Enter', target: p.el.find('rn:fx-0001') });
  assert.deepEqual(renames()[2], { action: 'rename', id: 'fx-0001', title: '' });
  assert.match(p.html(), /<div class="nm">Write the brake hooks<\/div>/, 'cleared: the automatic title');
  // leaving the field (or closing the popover) cancels
  dbl('fx-0002');
  p.el.find('rn:fx-0002').value = 'Half typed';
  p.window.kadans.visible(false);
  assert.equal(renames().length, 3);
  assert.doesNotMatch(p.html(), /class="rn"/);
});

test('k32: on a phone, Rename is in the row\'s tap actions; rename and reorder go out over HTTP', async () => {
  const { p } = arrangePanel();
  p.window.matchMedia = (q) => ({ matches: q === '(hover: none)' });
  p.window.kadans.render({});
  assert.match(rowActs(p, 'fx-0001'), /data-do="rename" data-id="fx-0001"/);
  p.tap({ do: 'rename', id: 'fx-0001' });
  assert.match(p.html(), /data-key="rn:fx-0001"/);
  // the phone transport allows both new actions
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    return { status: 200, json: async () => (url.includes('state') ? { status: null, agents: [] } : { ok: true }) };
  };
  const ph = loadPanel({ http: { fetch, store: new Map([['kadans.token', 'tok']]) } });
  await new Promise((r) => setImmediate(r));
  ph.window.kadans.send({ action: 'rename', id: 'a1', title: 'New' });
  ph.window.kadans.send({ action: 'reorder', ids: ['a2', 'a1'] });
  const posted = (act) => calls.some((c) => c.url === 'api/action' && c.body?.action === act);
  for (let i = 0; i < 600 && !(posted('rename') && posted('reorder')); i++) await new Promise((r) => setTimeout(r, 50)); // poll up to 30 s, not a fixed 20 ms
  assert.ok(calls.some((c) => c.url === 'api/action' && c.body?.action === 'rename' && c.body.title === 'New'));
  assert.ok(calls.some((c) => c.url === 'api/action' && c.body?.action === 'reorder' && c.body.ids.length === 2));
});

test('Codex account: labelled "Codex", its 30-day window named, never the default pick', () => {
  const p = loadPanel();
  const d = { status: { accounts: [
    { key: 'cx', kind: 'codex', name: 'Codex', own: false, acts: false, state: 'gas', limits: [{ name: 'window_43200', pct: 1, resetsAt: Date.now() + 86400000 }] },
    { key: 'me', own: true, state: 'cruise', limits: [{ name: 'five_hour', pct: 20, resetsAt: Date.now() + 3600000 }] },
  ] }, agents: [] };
  p.window.kadans.render(d);
  const html = p.html();
  assert.match(html, />Codex</);
  assert.match(html, /5-hour limit/); // the own account is shown first, not Codex
});

// k35: progress on agent rows and sub-agent rows.
test('k35: progress leads the meta line ("3/5 · Writing tests") with a bar under the title; none without progress', () => {
  const p = loadPanel();
  p.window.kadans.render(fixture(p, 'progress'));
  const html = p.html();
  assert.match(html, /<span class="pn">3\/5<\/span><span class="ps"> · Writing tests<\/span><span class="du"> · 11 min<\/span><span class="pj"> · Tidepool<\/span>/);
  assert.match(html, /<div class="pb" aria-hidden="true"><i style="transform:scaleX\(0\.6\)"><\/i><\/div>/);
  assert.match(html, /aria-label="Brake hooks for the Stop event\. 3 of 5 done: Writing tests\. 11 min · Tidepool/);
  // needs-you keeps its words first; a step-less count; 0/6 still draws the (empty) bar on its track
  assert.match(html, /<span class="ld"><span class="need">Needs you<\/span><\/span><span class="pn"> · 1\/3<\/span><span class="ps"> · Comparing/);
  assert.match(html, /<span class="pn">0\/6<\/span><span class="du"> · 40 min<\/span><span class="pj"> · Marlin<\/span>/);
  assert.match(html, /<i style="transform:scaleX\(0\)"><\/i>/);
  // a row without progress: a hidden bar slot, no count
  const fern = html.slice(html.indexOf('data-key="row:fx-0003"'), html.indexOf('data-key="row:fx-0004"'));
  assert.match(fern, /<div class="pb off" aria-hidden="true">/);
  assert.doesNotMatch(fern, /class="pn"/);
  // the sub-agent row: count and step in small, the bar, all in its tooltip
  assert.match(html, /<span class="sq">· 1\/4<\/span><span class="sp">· Hook input formats<\/span><span class="sn">· 45k<\/span><div class="pb" aria-hidden="true"><i style="transform:scaleX\(0\.25\)"><\/i><\/div>/);
  assert.match(html, /title="Reading the hooks docs\n1\/4 · Hook input formats\n45k context · 120k tokens since start" aria-label="Subagent: Reading the hooks docs\. 1 of 4 done: Hook input formats\. 45k context/);
});

test('k35: a new value patches the bar in place (it glides); ended rows, bad values and hostile steps', () => {
  const p = loadPanel();
  const d = fixture(p, 'progress');
  p.window.kadans.render(d);
  const bar = p.el.find('row:fx-0001').kids[1].kids[1];
  assert.equal(bar.getAttribute('class'), 'pb');
  d.agents[0].progress = { done: 4, total: 5, step: 'Writing tests' };
  p.window.kadans.render(d);
  assert.equal(p.el.find('row:fx-0001').kids[1].kids[1], bar, 'same node');
  assert.equal(bar.kids[0].getAttribute('style'), 'transform:scaleX(0.8)');
  for (const bad of [{ done: 1, total: 0 }, { done: 'x', total: 3 }, null, { done: 2 }]) {
    d.agents[0].progress = bad;
    p.window.kadans.render(d);
    assert.doesNotMatch(p.html().slice(0, p.html().indexOf('data-key="row:fx-0002"')), /class="pn"/, JSON.stringify(bad));
  }
  d.agents[0].progress = { done: 9, total: 3, step: '<img src=x onerror=alert(1)>' };
  p.window.kadans.render(d);
  assert.match(p.html(), /<span class="pn">3\/3<\/span><span class="ps"> · &lt;img src=x onerror=alert\(1\)&gt;<\/span>/);
  assertNoInjection(p.html(), 'hostile step');
  Object.assign(d.agents[0], { status: 'ended', progress: { done: 2, total: 5, step: 'Old' } });
  p.window.kadans.render(d);
  assert.doesNotMatch(p.html(), /Old/);
});

test('k35: the phone page shows the same progress', async () => {
  let state = null;
  const srv = fakeServer({ 'POST api/pair': [200, { token: 't' }], 'GET api/state': () => [200, state] });
  const p = loadPanel({ http: { fetch: srv.fetch, hash: '#pair=ABCDEFGHJKLMNPQR' } });
  state = fixture(p, 'progress');
  await flush();
  assert.equal(p.document.documentElement.dataset.shell, 'phone');
  assert.match(p.html(), /<span class="pn">3\/5<\/span><span class="ps"> · Writing tests<\/span>/);
  assert.match(p.html(), /<span class="sq">· 1\/4<\/span>/);
});

test('k38: other computers: a quiet header per machine after the local rows, no actions on their rows, offline hides rows', () => {
  const p = loadPanel();
  p.window.kadans.render(fixture(p, 'remote'));
  const html = p.html();
  const at = (s) => html.indexOf(s);
  assert.ok(at('data-key="row:fx-0302"') < at('data-key="mh:other"'), 'local rows first');
  assert.match(html, /<div class="mh" data-key="mh:other" title="Agents on other"><span class="mn">other<\/span> · <span class="mc">2<\/span><\/div>/);
  assert.ok(at('data-key="mh:other"') < at('data-key="row:remote:other:tab-1:1"'));
  assert.match(html, /<div class="mh off" data-key="mh:spare" title="spare is offline"><span class="mn">spare<\/span> · <span class="mc">offline<\/span><\/div>/);
  assert.ok(!html.includes('data-key="row:remote:spare"'), 'an offline machine shows no rows');
  // no stop, close, pace, replace, compact, open or rename on a remote row whose flags allow none (k48: flags below)
  const row = html.slice(at('data-key="row:remote:other:tab-2:1"'));
  assert.match(row, /<div class="acts"><\/div>/);
  assert.ok(!/data-id="remote:/.test(html), 'no action button carries a remote id');
  // the Agents count and the reorder only know this computer's rows
  assert.match(html, /<div class="sh"><span>Agents<\/span><span>2<\/span><\/div>/);
  // a stale machine says so in its header
  const d = fixture(p, 'remote');
  for (const a of d.agents) if (a.machine === 'other') a.machineStale = true;
  p.window.kadans.render(d);
  assert.match(p.html(), /<span class="mc">2 · not live<\/span>/);
});

test('k38: no empty meta part: a blank or separator-only part is dropped, so "Idle 1 min" never ends in a stray dot', () => {
  const p = loadPanel();
  const d = fixture(p, 'remote');
  d.agents = d.agents.filter((a) => a.id === 'fx-0302');
  for (const project of ['   ', '·', ' . ', '…']) {
    d.agents[0].project = project;
    p.window.kadans.reset();
    p.window.kadans.render(d);
    const row = p.html().slice(p.html().indexOf('data-key="row:fx-0302"'));
    const meta = /<div class="pv meta">(.*?)<\/div>/.exec(row)[1];
    assert.equal(meta, '<span class="ld">Idle 1 min</span>', `project ${JSON.stringify(project)}`);
  }
  // k42: parts are never squeezed (whole parts drop instead), so none can show only its separator (CSS)
  assert.match(read('panel.css'), /\.pv\.meta > span \{ flex: none; white-space: pre; \}/);
});

test('k38: the phone page shows the other computers too, without actions', async () => {
  let state = null;
  const srv = fakeServer({ 'POST api/pair': [200, { token: 't' }], 'GET api/state': () => [200, state] });
  const p = loadPanel({ http: { fetch: srv.fetch, hash: '#pair=ABCDEFGHJKLMNPQR' } });
  state = fixture(p, 'remote');
  await flush();
  assert.match(p.html(), /data-key="mh:other"/);
  assert.ok(!/data-id="remote:/.test(p.html()));
});

// ---------- k41: Settings › Computers ----------
test('Settings › Computers: rows with status and agents, offline muted, remove with a confirm; hidden without a payload', () => {
  const p = loadPanel();
  const F = p.window.KADANS_FIXTURES;
  const open = (name) => {
    p.window.kadans.reset();
    p.window.kadans.render(F[name]);
    F[name].after(p.document);
    return p.html();
  };
  assert.ok(!open('settings').includes('Add a computer'), 'an older app sends no computers: no section');
  let h = open('settings_computers');
  assert.match(h, /<span class="ttl">Computers<\/span>/); // k43: its own screen, pushed from the Computers row
  assert.match(h, /<div>kasa<\/div><div class="d">online · 2 agents<\/div>/);
  assert.match(h, /<div>studio<\/div><div class="d">not live · 1 agent<\/div>/);
  assert.match(h, /<div class="it off"><div class="tx"><div>PC<\/div><div class="d">offline<\/div>/);
  assert.match(h, /Add a computer/);
  assert.ok(open('settings_update').indexOf('>Computers<') > p.html().indexOf('>Phone<'), 'its row sits under the Phone row');
  h = open('settings_computers');
  p.tap({ do: 'comp-remove', id: 'env-0003' });
  h = p.html();
  assert.match(h, /Unpair it from this Mac\?/);
  assert.equal(p.sent.filter((m) => m.action === 'computers-remove').length, 0, 'nothing sent before the confirm');
  p.tap({ do: 'comp-keep' });
  assert.ok(!p.html().includes('Unpair it'));
  p.tap({ do: 'comp-remove', id: 'env-0003' });
  p.tap({ do: 'comp-remove-go', id: 'env-0003' });
  assert.deepEqual({ ...p.sent.at(-1) }, { action: 'computers-remove', id: 'env-0003' });
  assert.match(p.html(), /Removing…/);
  p.window.kadans.render({ computers: { list: F.settings_computers.computers.list.slice(0, 2), error: null } });
  p.window.kadans.result({ action: 'computers-remove', id: 'env-0003', ok: true, why: '' });
  h = p.html();
  assert.ok(!h.includes('>PC<') && !h.includes('Removing'));
  // a failed remove: the page's own line, never the result's text
  p.tap({ do: 'comp-remove', id: 'env-0002' });
  p.tap({ do: 'comp-remove-go', id: 'env-0002' });
  p.window.kadans.render({ computers: { list: F.settings_computers.computers.list.slice(0, 2), error: 'remove' } });
  p.window.kadans.result({ action: 'computers-remove', id: 'env-0002', ok: false, why: 'kadans: orca says <b>secret</b>' });
  h = p.html();
  assert.match(h, /Couldn’t remove that computer\./);
  assert.ok(!h.includes('secret'));
  // list unreadable, and none yet
  assert.match(open('settings_computers_error'), /Couldn’t read your computers\./);
  assert.match(open('settings_computers_none'), /See the agents on your other computers here\./);
});

test('Settings › Computers: the add form sends the code once, clears the field at once, never draws it', () => {
  const timers = [];
  const p = loadPanel({ timers });
  const F = p.window.KADANS_FIXTURES;
  p.window.kadans.reset();
  p.window.kadans.render(F.settings_computers_add);
  F.settings_computers_add.after(p.document); // clicks "Add…"
  let h = p.html();
  assert.match(h, /On the other computer run: <span class="code">npx\u00a0kadans\u00a0connect<\/span>/);
  assert.match(h, /<input class="fld" type="text" data-key="comp-name" placeholder="PC" maxlength="32"/);
  assert.match(h, /<input class="fld" type="password" data-key="comp-code" placeholder="[^"]*" aria-label="Pairing code" spellcheck="false" autocomplete="off"/);
  assert.ok(!/data-key="comp-code"[^>]*value=/.test(h), 'the code field has no value attribute');
  const CODE = 'orca://pair?code=FAKE_k41_panel_code';
  const code = () => p.el.find('comp-code');
  // a bad code: refused on the page, field cleared, nothing sent
  code().value = 'orca://pair?code=a b"c';
  p.tap({ do: 'comp-add' });
  assert.equal(code().value, '');
  assert.equal(p.sent.filter((m) => m.action === 'computers-add').length, 0);
  assert.match(p.html(), /That is not a pairing code\./);
  // a refresh while typing keeps the field node
  const nameNode = p.el.find('comp-name');
  code().value = `  ${CODE}\n`;
  p.window.kadans.render({ computers: F.settings_computers_add.computers });
  assert.equal(p.el.find('comp-name'), nameNode);
  p.tap({ do: 'comp-add' });
  assert.deepEqual({ ...p.sent.at(-1) }, { action: 'computers-add', name: 'PC', code: CODE }, 'empty name: the placeholder PC');
  assert.equal(code().value, '', 'cleared after submit');
  h = p.html();
  assert.match(h, /Adding…/);
  assert.ok(!h.includes('FAKE_k41'), 'the code is never in the markup');
  assert.ok(!JSON.stringify(p.window.kadans).includes('FAKE_k41'));
  // a failed add: the app's error code -> the page's line; the form stays, the field stays empty
  p.window.kadans.render({ computers: { list: F.settings_computers_add.computers.list, error: 'add' } });
  p.window.kadans.result({ action: 'computers-add', id: '', ok: false, why: CODE });
  h = p.html();
  assert.match(h, /Couldn’t add it\. Each code works once/);
  assert.ok(!h.includes('FAKE_k41'));
  assert.equal(code().value, '');
  // try again with a name: ok closes the form, the new row comes with the list
  p.el.find('comp-name').value = 'Work PC';
  code().value = CODE;
  p.tap({ do: 'comp-add' });
  assert.deepEqual({ ...p.sent.at(-1) }, { action: 'computers-add', name: 'Work PC', code: CODE });
  p.window.kadans.render({ computers: { list: [...F.settings_computers_add.computers.list, { id: 'env-9', name: 'Work PC', status: 'unknown', agents: null }], error: null } });
  p.window.kadans.result({ action: 'computers-add', id: '', ok: true, why: '' });
  h = p.html();
  assert.ok(!h.includes('comp-code'), 'the form closed');
  assert.match(h, /<div>Work PC<\/div><div class="d">not checked yet<\/div>/);
  // a bad name
  p.tap({ do: 'comp-open' });
  p.el.find('comp-name').value = '--json';
  code().value = CODE;
  p.tap({ do: 'comp-add' });
  assert.equal(code().value, '');
  assert.match(p.html(), /Use letters, digits, spaces or dashes/);
  assert.equal(p.sent.filter((m) => m.action === 'computers-add').length, 2);
});

test('Settings › Computers: hostile names and error codes stay text; the phone page never shows the section', async () => {
  const p = loadPanel();
  const F = p.window.KADANS_FIXTURES;
  p.window.kadans.reset();
  const evil = { list: [{ id: 'e"><img src=x onerror=alert(1)>', name: '<img src=x onerror=alert(1)>', status: '<b>', agents: '2' },
    { id: 'ok', name: 'a&b', status: 'online', agents: -1 }, null, { id: 7, name: 'x' }], error: 'constructor' };
  p.window.kadans.render(Object.assign({}, F.settings_computers, { computers: evil }));
  F.settings_computers.after(p.document);
  const h = p.html();
  assertNoInjection(h, 'computers hostile');
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(h, /<div>a&amp;b<\/div><div class="d">online<\/div>/);
  p.window.kadans.result({ action: 'computers-add', id: '', ok: false, why: 'x' });
  assert.ok(!p.html().includes('[object') && !p.html().includes('native code'));
  // the phone (http) page: no Computers section even with a payload
  const store = new Map([['kadans.token', 't']]);
  const q = loadPanel({ http: { fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }), store } });
  q.window.kadans.render(Object.assign({}, F.settings_computers, { computers: { list: [{ id: 'a', name: 'kasa', status: 'online', agents: 1 }], error: null } }));
  q.tap({ do: 'settings' });
  assert.ok(!q.html().includes('Add a computer'));
});

// ---------- k42: fit on one screen, whole meta parts, useful remote rows ----------
test('k42: the gauge and the bottom bar sit outside the scroll area; Agents, other computers and Up next inside it', () => {
  const p = loadPanel();
  p.window.kadans.render(fixture(p, 'fit'));
  const panel = p.el.kids[0];
  const kids = panel.kids.map((k) => k.attrs.get('class'));
  assert.deepEqual(kids, ['card', 'list', 'bottom'], 'the panel is gauge, one scroll area, bottom bar');
  const list = panel.kids[1];
  assert.equal(list.attrs.get('id'), 'k-list');
  const inner = list.innerHTML;
  for (const part of ['<div class="sh"><span>Agents</span>', 'data-key="row:fx-0401"', 'data-key="sub:fx-sub-42"', 'data-key="mh:other"',
    'data-key="row:remote:other:tab-1:1"', '<div class="upnext">']) assert.ok(inner.includes(part), part);
  assert.ok(!inner.includes('class="bottom"') && !inner.includes('class="card"'));
  // CSS: only the list gives way; the panel's height is the host's cap
  const css = read('panel.css');
  assert.match(css, /\.panel \{[^}]*max-height: var\(--cap, 560px\)/);
  assert.match(css, /\.panel > \* \{ flex: none; \}/);
  assert.match(css, /\.list \{ position: relative; flex: 0 1 auto; min-height: 0; overflow-y: auto;/);
  // no agents: the heading and the empty note are still in the scroll area, the bar outside
  const d = fixture(p, 'fit');
  d.agents = [];
  p.window.kadans.reset();
  p.window.kadans.render(d);
  assert.deepEqual(p.el.kids[0].kids.map((k) => k.attrs.get('class')), ['card', 'list', 'bottom']);
});

test('k42: the host sets the cap (--cap) and the page reports its size again; nonsense is ignored', () => {
  const p = loadPanel();
  const set = [];
  p.document.documentElement.style = { setProperty: (k, v) => set.push([k, v]) };
  p.window.kadans.render(fixture(p, 'fit'));
  p.window.kadans.cap(431.6);
  p.window.kadans.cap('x');
  p.window.kadans.cap(-5);
  assert.deepEqual(set, [['--cap', '432px']]);
});

test('k42: the meta line holds whole parts in order of need: state and time lead, model and project go first', () => {
  const p = loadPanel();
  p.window.kadans.render(fixture(p, 'fit'));
  const html = p.html();
  const parts = (id) => [.../<div class="pv meta">(.*?)<\/div>/.exec(rowHtml(html, id))[1].matchAll(/<span class="(\w+)">/g)].map((m) => m[1]);
  assert.deepEqual(parts('fx-0401'), ['du', 'cx', 'pj', 'fm']); // working: its age first
  assert.deepEqual(parts('fx-0402'), ['ld', 'cx', 'pj', 'fm', 'du']); // idle: "Idle 7 min" carries the time; the age last
  assert.equal(pvText(rowHtml(html, 'fx-0402')), 'Idle 7 min · 106k context · Tidepool-website-redesign · Sonnet · 4 hr');
  // CSS: one line, parts never squeezed: what does not fit wraps out of sight with everything after it
  const css = read('panel.css');
  assert.match(css, /\.pv\.meta \{ display: flex; flex-wrap: wrap; height: 1\.35em; line-height: 1\.35em; overflow: hidden; \}/);
  assert.match(css, /\.pv\.meta > span \{ flex: none; white-space: pre; \}/);
  assert.doesNotMatch(css, /\.pv\.meta[^{]*\{[^}]*flex-grow/, 'no squeeze ladder left');
  assert.doesNotMatch(css, /\.pv\.meta[^{]*\{[^}]*min-width: 2\.6em/);
});

test('k42: a remote row says what it does: "Working 1 hr 10 min · Claude · PowerShell · 1 sub-agent · project", blob moving', () => {
  const p = loadPanel();
  const d = fixture(p, 'fit');
  p.window.kadans.render(d);
  const row = rowHtml(p.html(), 'remote:other:tab-1:1');
  assert.equal(pvText(row), 'Working 1 hr 10 min · Claude · PowerShell · 1 sub-agent · Fernway');
  assert.match(row, /<div class="nm">Make the rain sound loop without a gap<\/div>/);
  assert.match(row, /class="bw bw-work"/, 'the blob moves like a local working row');
  // needs you: no tool; a Codex agent; no sub-agents
  Object.assign(d.agents[2], { status: 'needs-you', stateSince: d.status.now - 5 * 60000, agentType: 'codex', subagentCount: 0 });
  p.window.kadans.render(d);
  assert.equal(pvText(rowHtml(p.html(), 'remote:other:tab-1:1')), 'Needs you 5 min · Codex · Fernway');
});

test('k42: the prompt title is kept in page memory only: cached runs keep it, a stale or offline machine falls back', () => {
  const p = loadPanel();
  const d = fixture(p, 'fit');
  const id = 'remote:other:tab-1:1';
  const name = () => /<div class="nm">(.*?)<\/div>/.exec(rowHtml(p.html(), id))[1];
  p.window.kadans.render(d);
  assert.equal(name(), 'Make the rain sound loop without a gap');
  Object.assign(d.agents[2], { title: null, titleSource: null }); // a run inside the 10 s gap: no prompt title
  p.window.kadans.render(d);
  assert.equal(name(), 'Make the rain sound loop without a gap');
  Object.assign(d.agents[2], { title: 'fix-sound', titleSource: 'branch' });
  p.window.kadans.render(d);
  assert.equal(name(), 'Make the rain sound loop without a gap', 'the prompt beats the branch');
  d.agents[2].machineStale = true;
  p.window.kadans.render(d);
  assert.equal(name(), 'fix-sound', 'stale: the memory is dropped');
  d.agents[2].machineStale = false;
  Object.assign(d.agents[2], { title: null, titleSource: null });
  p.window.kadans.render(d);
  assert.equal(name(), 'Session in Fernway');
  assert.ok(!JSON.stringify(p.sent).includes('rain sound'), 'never sent to the host');
});

// ---------- k43: calm Settings (first screen, Advanced, Phone / Computers screens, Updates) ----------
const ttl = (html) => /<span class="ttl">([^<]*)<\/span>/.exec(html)?.[1] ?? null;
const groups = (html) => (html.match(/class="sgrp"/g) ?? []).length;

test('k43: the first Settings screen has at most 3 groups and none of the rare settings', () => {
  const p = loadPanel();
  const F = p.window.KADANS_FIXTURES;
  for (const name of ['settings', 'settings_update', 'settings_update_auto', 'settings_update_checking']) {
    p.window.kadans.reset();
    p.window.kadans.render(F[name]);
    F[name].after(p.document);
    const h = p.html();
    assert.equal(ttl(h), 'Settings', name);
    assert.ok(groups(h) >= 2 && groups(h) <= 3, `${name}: ${groups(h)} groups`);
    for (const rare of ['Status line language', 'Read usage from Claude', 'Suggest compact', 'Start the next window', 'Warm-up', '7-day target',
      'Windows to watch', 'Spare margin', 'Remove from Claude Code', 'Hooks', 'on its own', 'Lean mode', 'Use Kadans on your phone', 'Add a computer']) {
      assert.ok(!h.includes(rare), `${name}: "${rare}" is not on the first screen`);
    }
    assert.ok(!/data-k="autopace"/.test(h), 'Auto-pace is the bottom bar switch only (no duplicate)');
    assert.match(h, /data-do="sub" data-id="advanced"/);
  }
  // the fullest first screen: pace, then Phone and Computers as one line each, then Updates and Advanced
  p.window.kadans.reset();
  p.window.kadans.render(F.settings_update);
  F.settings_update.after(p.document);
  const h = p.html();
  assert.equal(groups(h), 3);
  assert.match(h, /aria-label="Phone: 1 phone"/);
  assert.match(h, /aria-label="Computers: 2"/);
  assert.ok(h.indexOf('>5-hour target<') < h.indexOf('>Phone<') && h.indexOf('>Phone<') < h.indexOf('>Computers<') &&
    h.indexOf('>Computers<') < h.indexOf('>Updates<') && h.indexOf('>Updates<') < h.indexOf('>Advanced<'));
});

test('k43: Advanced, Phone and Computers push a second screen and Back returns to Settings, then to the panel', () => {
  const p = loadPanel();
  const F = p.window.KADANS_FIXTURES;
  p.window.kadans.reset();
  p.window.kadans.render({ ...F.settings_update, install: F.hooks.install });
  p.tap({ do: 'sub', id: 'advanced' }); // not on Settings: nothing happens, nothing is sent
  assert.equal(ttl(p.html()), null);
  p.tap({ do: 'settings' });
  assert.match(p.html(), /aria-label="Advanced: Hooks to update"/);
  const sent = p.sent.length;
  for (const [id, title] of [['advanced', 'Advanced'], ['phone', 'Phone'], ['computers', 'Computers']]) {
    p.tap({ do: 'sub', id });
    assert.equal(ttl(p.html()), title);
    assert.match(p.html(), new RegExp(`aria-label="Kadans settings: ${title}"`));
    p.tap({ do: 'back' });
    assert.equal(ttl(p.html()), 'Settings', `Back from ${title}`);
  }
  p.tap({ do: 'sub', id: 'nope' });
  p.tap({ do: 'sub', id: '__proto__' });
  assert.equal(ttl(p.html()), 'Settings');
  assert.equal(p.sent.length, sent, 'moving between Settings screens sends nothing to the app');
  // Review opened from Advanced comes back to Advanced; the gear always opens the first screen
  p.tap({ do: 'sub', id: 'advanced' });
  p.tap({ do: 'review' });
  assert.equal(ttl(p.html()), 'Update hooks');
  p.tap({ do: 'back' });
  assert.equal(ttl(p.html()), 'Advanced');
  p.tap({ do: 'back' });
  p.tap({ do: 'back' });
  assert.deepEqual({ ...p.sent.at(-1) }, { action: 'settings-closed' });
  assert.equal(ttl(p.html()), null, 'the main panel');
  p.tap({ do: 'settings' });
  p.tap({ do: 'sub', id: 'phone' });
  p.tap({ do: 'back' });
  p.tap({ do: 'back' });
  p.tap({ do: 'settings' });
  assert.equal(ttl(p.html()), 'Settings');
});

test('k43: Back from a second screen slides out, then Settings slides back in and reports its height at once', () => {
  const clock = { now: 5_000_000 };
  const timers = [];
  const rect = FNode.prototype.getBoundingClientRect;
  FNode.prototype.getBoundingClientRect = function () { return { height: /settings: Advanced/.test(this.attrs.get('aria-label') ?? '') ? 560 : 420 }; };
  try {
    const p = loadPanel({ clock, timers });
    const F = p.window.KADANS_FIXTURES;
    p.window.kadans.reset();
    p.window.kadans.render({ ...F.settings, after: undefined });
    p.tap({ do: 'settings' });
    const sizes = () => p.sent.filter((m) => m.action === 'size').map((m) => m.height);
    const at = sizes().length;
    clock.now += 2000;
    timers.forEach((t) => { t.ran = true; });
    p.tap({ do: 'sub', id: 'advanced' });
    assert.equal(ttl(p.html()), 'Advanced');
    assert.deepEqual(sizes().slice(at), [560], 'taller at once, with the push');
    clock.now += 2000;
    timers.forEach((t) => { t.ran = true; });
    p.tap({ do: 'back' });
    assert.equal(ttl(p.html()), 'Advanced', 'still sliding out');
    const out = pending(timers).find((t) => t.ms === 130);
    assert.ok(out, 'Back waits for the slide-out');
    clock.now += 130;
    fire(out);
    assert.equal(ttl(p.html()), 'Settings');
    assert.deepEqual(sizes().slice(at), [560, 420], 'the shorter height goes out as the slide-in starts');
  } finally {
    FNode.prototype.getBoundingClientRect = rect;
  }
});

test('k43: every control the old Settings had is still reachable (Settings, its second screens, or the bottom bar)', () => {
  // Listed from the Settings screen before k43 (one long page): data-do, with data-k / data-set for config keys.
  const OLD = ['back', 'review', 'uninstall', 'phone-on', 'phone-off', 'phone-pair', 'phone-revoke', 'comp-open', 'comp-close', 'comp-add',
    'comp-remove', 'comp-keep', 'comp-remove-go', 'set:limits', 'set:usageApi', 'set:autopace', 'set:compact.soonPct', 'set:kickoff.enabled',
    'set:accounts.aaaaaaaaaaaa.gas', 'set:autoGas', 'set:autoGasMax', 'set:notify', 'set:lang', 'range:targets.five_hour',
    'range:targets.seven_day', 'range:slack', 'range:warmup.minutes', 'range:warmup.pct', 'range:kickoff.from', 'range:kickoff.to'];
  const p = loadPanel();
  const F = p.window.KADANS_FIXTURES;
  const seen = new Set();
  const collect = () => {
    const h = p.html();
    for (const m of h.matchAll(/data-do="([^"]+)"(?: data-k="([^"]+)")?/g)) seen.add(m[1] === 'set' ? `set:${m[2]}` : m[1]);
    for (const m of h.matchAll(/data-set="([^"]+)"/g)) seen.add(`range:${m[1]}`);
  };
  const open = (name, ...taps) => {
    p.window.kadans.reset();
    p.window.kadans.render(F[name]);
    F[name].after?.(p.document);
    collect();
    for (const t of taps) { p.tap(t); collect(); }
  };
  open('settings_update'); // the first screen
  p.window.kadans.reset();
  p.window.kadans.render({ ...F.settings, status: { ...F.settings.status, autopace: true } });
  collect();
  assert.ok(seen.has('autopace'), 'the bottom bar Auto-pace switch');
  seen.add('set:autopace'); // the same setting: the bottom bar sends autopace, the bridge maps it to config-set autopace
  open('settings_kickoff');
  open('settings_autogas');
  open('settings_end');
  open('hooks', { do: 'settings' }, { do: 'sub', id: 'advanced' });
  open('settings_phone_off');
  open('settings_phone_on');
  open('settings_computers', { do: 'comp-remove', id: 'env-0001' });
  open('settings_computers_add');
  const missing = OLD.filter((k) => !seen.has(k));
  assert.deepEqual(missing, []);
});

test('k43: the Updates row shows only with an update payload; Automatic and Install send their actions', () => {
  const p = loadPanel();
  const F = p.window.KADANS_FIXTURES;
  const open = (f) => {
    p.window.kadans.reset();
    p.window.kadans.render(f);
    F.settings.after(p.document);
    return p.html();
  };
  let h = open(F.settings);
  assert.ok(!h.includes('>Updates<') && !h.includes('update-auto') && !h.includes('update-install'), 'no payload, no row');
  h = open(F.settings_update);
  assert.match(h, /<div>Updates<\/div><button class="pill blue inst" data-do="update-install" data-key="update-install">Install 1\.2\.0<\/button>/);
  assert.match(h, /<span class="cap" aria-hidden="true">Automatic<\/span>/);
  const sw = p.el.find('set:update-auto');
  assert.equal(sw.getAttribute('aria-checked'), 'false');
  p.tap({ do: 'update-auto', v: sw.getAttribute('data-v') });
  assert.deepEqual({ ...p.sent.at(-1) }, { action: 'update-auto', on: true });
  assert.equal(p.el.find('set:update-auto'), sw, 'the switch keeps its node');
  assert.equal(sw.getAttribute('aria-checked'), 'true', 'and flips at once');
  p.window.kadans.render({ update: { auto: true, available: '1.2.0', checking: false } });
  assert.equal(sw.getAttribute('aria-checked'), 'true');
  p.tap({ do: 'update-install' });
  assert.deepEqual({ ...p.sent.at(-1) }, { action: 'update-install' });
  // nothing waiting: no button; checking: one quiet line
  h = open(F.settings_update_auto);
  assert.ok(h.includes('>Updates<') && !h.includes('update-install') && !h.includes('Checking'));
  assert.equal(p.el.find('set:update-auto').getAttribute('aria-checked'), 'true');
  assert.match(open(F.settings_update_checking), /<div>Updates<\/div><div class="d">Checking…<\/div>/);
  // a version that does not look like one is never drawn
  for (const bad of ['<img src=x onerror=alert(1)>', '1.2.0 now', 'x'.repeat(80), 7]) {
    h = open({ ...F.settings_update, update: { auto: false, available: bad, checking: false } });
    assertNoInjection(h, 'update');
    assert.ok(!h.includes('update-install') && !h.includes('onerror'), String(bad));
  }
  assert.match(open({ ...F.settings_update, update: { auto: false, available: 'v1.10.2-beta.1', checking: false } }), />Install v1\.10\.2-beta\.1</);
  // the payload going away removes the row
  p.window.kadans.render({ update: null });
  assert.ok(!p.html().includes('>Updates<'));
});

// ---------- k46: the iPhone app's native transport ----------
test('phone (k46): in the iPhone app every request goes through kadansHttp; no fetch, no localStorage, no token in the page', async () => {
  const timers = [];
  const msgs = [];
  let state = null;
  const answers = {
    'GET api/state': () => [200, state],
    'POST api/action': (b) => [200, { action: b.action, id: b.id ?? null, ok: false, why: 'Refused on the Mac' }],
  };
  const post = (m) => {
    msgs.push(JSON.parse(JSON.stringify(m))); // out of the vm realm, for deepEqual
    const a = answers[`${m.method} ${m.path}`];
    const r = a?.(m.body === undefined ? undefined : JSON.parse(m.body));
    return r ? Promise.resolve({ status: r[0], body: JSON.stringify(r[1]) }) : Promise.reject(new Error('offline'));
  };
  const native = { post };
  state = fixture(loadPanel(), 'cruise'); // ready before the page loads: the app's page reads at once
  const p = loadPanel({ timers, native });
  await flush();
  assert.equal(p.document.documentElement.dataset.shell, 'phone', 'phone layout');
  assert.deepEqual(msgs[0], { method: 'GET', path: 'api/state' }, 'reads at once, no pairing, no body key, no token');
  assert.equal(p.window.kadans.netState().state, 'live');
  assert.ok(p.html().includes('Brake hooks for the Stop event'), 'the state renders');
  const polls = () => timers.filter((t) => !t.cleared && t.ms >= 2000 && t.fn.name === 'poll');
  assert.equal(polls().length, 1, 'polls every 2 s as in the browser');
  // an action: the body goes as JSON text; the answer reaches the row; a fresh read follows
  p.window.kadans.send({ action: 'stop', id: 'fx-0001' });
  await flush();
  const act = msgs.find((m) => m.path === 'api/action');
  assert.deepEqual(act, { method: 'POST', path: 'api/action', body: JSON.stringify({ action: 'stop', id: 'fx-0001' }) });
  assert.ok(p.html().includes('Refused on the Mac'));
  assert.equal(msgs.at(-1).path, 'api/state');
  // pull to refresh in the app sends retry: one more read
  const n = msgs.length;
  p.window.kadans.send({ action: 'retry' });
  await flush();
  assert.equal(msgs.length, n + 1);
  assert.equal(msgs.at(-1).path, 'api/state');
  // no answer: offline card, the last reading stays
  answers['GET api/state'] = () => null;
  p.window.kadans.send({ action: 'retry' });
  await flush();
  assert.equal(p.window.kadans.netState().state, 'offline');
  assert.ok(p.html().includes('Brake hooks for the Stop event'), 'the last reading stays');
  // a 401 (the Mac revoked the phone): unpaired, polling stops; the app shows its own pair screen
  answers['GET api/state'] = () => [401, { error: 'unauthorized' }];
  p.window.kadans.send({ action: 'retry' });
  await flush();
  assert.equal(p.window.kadans.netState().state, 'unpaired');
  assert.equal(polls().length, 0);
  assert.deepEqual(native.touched, [], 'never fetch, localStorage or history');
  assert.ok(!JSON.stringify(msgs).includes('Bearer'), 'the page sends no token');
});

// ---------- k48: remote rows get the actions their flags allow ----------
test('k48: a remote row gets Close/Stop and Compact where its flags allow; the clicks send its remote id; stale or flagless rows none', () => {
  const p = loadPanel();
  const d = fixture(p, 'remote');
  const set = (id, o) => Object.assign(d.agents.find((a) => a.id === id), o);
  set('remote:other:tab-1:1', { status: 'idle', canStop: true, canCompact: true, canSend: true }); // an idle Claude chat there
  set('remote:other:tab-2:1', { status: 'working', canStop: true, canCompact: false, canSend: false });
  p.window.kadans.render(d);
  let idle = rowActs(p, 'remote:other:tab-1:1');
  assert.match(idle, /data-do="compact" data-id="remote:other:tab-1:1"/);
  assert.match(idle, /data-do="close" data-id="remote:other:tab-1:1"/);
  const busy = rowActs(p, 'remote:other:tab-2:1');
  assert.match(busy, /data-do="confirm" data-id="remote:other:tab-2:1"/);
  assert.doesNotMatch(busy, /data-do="compact"/);
  for (const row of [idle, busy]) assert.doesNotMatch(row, /data-do="(pace|resume|replace|rename|open)"/); // this computer only
  // close: confirm first, then one stop with the remote id
  p.document.querySelector('[data-do="close"][data-id="remote:other:tab-1:1"]').click();
  assert.match(rowHtml(p.html(), 'remote:other:tab-1:1'), /Close this chat\?/);
  assert.equal(p.sent.filter((m) => m.action === 'stop').length, 0);
  p.document.querySelector('[data-do="stop"][data-id="remote:other:tab-1:1"]').click();
  assert.deepEqual(p.sent.filter((m) => m.action === 'stop').map((m) => m.id), ['remote:other:tab-1:1']);
  // compact: confirm, send, and the CLI's answer settles it (no context size to watch on another computer)
  p.document.querySelector('[data-do="compact"][data-id="remote:other:tab-1:1"]').click();
  p.document.querySelector('[data-do="compact-go"][data-id="remote:other:tab-1:1"]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(compacts(p))), [{ action: 'compact', id: 'remote:other:tab-1:1' }]);
  p.window.kadans.result({ action: 'compact', id: 'remote:other:tab-1:1', ok: true, why: '' });
  assert.match(rowHtml(p.html(), 'remote:other:tab-1:1'), /Sent \/compact/);
  // a stale machine, or a row without flags: no buttons at all
  for (const a of d.agents) if (a.machine === 'other') a.machineStale = true;
  p.window.kadans.render(d);
  assert.match(rowHtml(p.html(), 'remote:other:tab-1:1'), /<div class="acts"><\/div>/);
  assert.match(rowHtml(p.html(), 'remote:other:tab-2:1'), /<div class="acts"><\/div>/);
});

// ---------- k49: Tell an agent (the guard's tests are in test/tell.test.mjs; these need this file's fake DOM) ----------
const TELL_MSG = 'SECRET-MESSAGE run the tests, careful with the migrations';
function tellPanel(opts = {}) {
  const clock = { now: 1_000_000 };
  const timers = [];
  const p = loadPanel({ clock, timers, ...opts });
  const data = () => fixture(p, 'tell');
  p.window.kadans.reset();
  p.window.kadans.render(data());
  const key = (e) => p.docListeners.keydown.forEach((fn) => fn({ preventDefault() {}, ...e }));
  const field = (id) => p.el.find(`tl:${id}`);
  const type = (id, v) => { const f = field(id); f.value = v; p.el.listeners.input.forEach((fn) => fn({ target: f })); return f; };
  const sends = () => JSON.parse(JSON.stringify(p.sent.filter((m) => m.action === 'agent-send')));
  return { p, clock, timers, data, key, field, type, sends };
}

test('k49: Tell on rows that can take a message (Orca chats here, idle or working; remote rows whose flags allow send)', () => {
  const { p, data } = tellPanel();
  const html = p.html();
  assert.match(rowActs(p, 'fx-0501'), /data-do="tell" data-id="fx-0501"/); // working, in Orca
  assert.match(rowActs(p, 'fx-0502'), /data-do="tell" data-id="fx-0502"/); // idle, in Orca
  assert.doesNotMatch(rowActs(p, 'fx-0503'), /data-do="tell"/); // waits on a question
  assert.match(rowActs(p, 'remote:other:tab-1:1'), /data-do="tell" data-id="remote:other:tab-1:1"/);
  const d = data();
  d.agents[0].orca = null; // not in an Orca terminal Kadans knows
  d.agents[3].canSend = false;
  p.window.kadans.render(d);
  assert.doesNotMatch(rowActs(p, 'fx-0501'), /data-do="tell"/);
  assert.doesNotMatch(rowActs(p, 'remote:other:tab-1:1'), /data-do="tell"/);
});

test('k49: Cmd-Enter sends agent-send {id, text}; the field is empty after; the row says Sending…, then Sent', () => {
  const { p, data, key, field, type, sends } = tellPanel();
  p.tap({ do: 'tell', id: 'fx-0501' });
  const html = p.html();
  assert.match(html, /<textarea class="tl" data-key="tl:fx-0501" rows="2" placeholder="Tell Brake hooks for the…"/);
  assert.match(html, /To Brake hooks for the Stop event<\/span><span class="tm"> on this Mac/);
  assert.match(html, /data-do="tell-send" data-id="fx-0501" aria-keyshortcuts="Meta\+Enter" aria-disabled="true">Send/); // empty: off
  const f = type('fx-0501', `  ${TELL_MSG}\n`);
  p.window.kadans.render(data()); // a refresh keeps the field's node (what was typed stays)
  assert.equal(field('fx-0501'), f);
  key({ key: 'Enter', target: f }); // a plain Enter is a new line, not a send
  assert.equal(sends().length, 0);
  key({ key: 'Enter', metaKey: true, target: f });
  assert.deepEqual(sends(), [{ action: 'agent-send', id: 'fx-0501', text: TELL_MSG }]);
  assert.equal(f.value, '');
  assert.doesNotMatch(p.html(), /class="tl"/);
  assert.match(rowHtml(p.html(), 'fx-0501'), /Sending…/);
  p.window.kadans.result({ action: 'agent-send', id: 'fx-0501', ok: true, why: '' });
  assert.match(rowHtml(p.html(), 'fx-0501'), /<span class="ld">Sent<\/span>/);
  assert.ok(!p.html().includes('SECRET-MESSAGE'));
  // remote: the machine is named
  p.tap({ do: 'tell', id: 'remote:other:tab-1:1' });
  assert.match(p.html(), /To Make the rain sound loop without a gap<\/span><span class="tm"> on other/);
});

test('k49: Esc and Cancel close the composer and empty the field; nothing is sent and the popover stays open', () => {
  const { p, key, type, sends } = tellPanel();
  p.tap({ do: 'tell', id: 'fx-0502' });
  const f = type('fx-0502', TELL_MSG);
  key({ key: 'Escape', target: f });
  assert.equal(f.value, '');
  assert.doesNotMatch(p.html(), /class="tl"/);
  p.tap({ do: 'tell', id: 'fx-0502' });
  const g = type('fx-0502', TELL_MSG);
  p.tap({ do: 'tell-cancel', id: 'fx-0502' });
  assert.equal(g.value, '');
  p.tap({ do: 'tell', id: 'fx-0502' });
  const h = type('fx-0502', TELL_MSG);
  key({ key: 'ArrowUp', altKey: true, target: h }); // row shortcuts do not fire from the field
  p.window.kadans.visible(false); // closing the panel keeps no draft
  assert.equal(h.value, '');
  assert.doesNotMatch(p.html(), /class="tl"/);
  assert.deepEqual(sends(), []);
  assert.ok(!p.sent.some((m) => m.action === 'close' || m.action === 'reorder'));
});

test('k49: a refusal shows one fixed line, never the text; a leading !, / or # is caught before sending', () => {
  const { p, key, type, sends } = tellPanel();
  for (const why of [`not sent: ${TELL_MSG}`, 'not sent: That chat has unsent text: nothing was sent', 'Too many messages; wait a minute', 'weird']) {
    p.window.kadans.result({ action: 'agent-send', id: 'fx-0502', ok: false, why });
    const row = rowHtml(p.html(), 'fx-0502');
    assert.ok(!row.includes('SECRET-MESSAGE'), why);
    assert.match(row, /class="warn"/);
  }
  assert.match(rowHtml(p.html(), 'fx-0502'), />Not sent\.</);
  p.window.kadans.result({ action: 'agent-send', id: 'fx-0502', ok: false, why: 'Too many messages; wait a minute' });
  assert.match(rowHtml(p.html(), 'fx-0502'), />Too many messages; wait a minute</);
  for (const lead of ['!rm -rf build', '/clear', '# remember this', '  /compact']) {
    p.tap({ do: 'tell', id: 'fx-0502' });
    const f = type('fx-0502', lead);
    assert.match(p.html(), /Messages can’t start with !, \/ or #/, lead);
    assert.match(p.html(), /data-do="tell-send" data-id="fx-0502" aria-keyshortcuts="Meta\+Enter" aria-disabled="true"/);
    key({ key: 'Enter', metaKey: true, target: f });
    assert.match(p.html(), /class="tl"/, 'the composer stays open with the hint');
    key({ key: 'Escape', target: f });
  }
  assert.deepEqual(sends(), []);
});

test('k49: the phone page and the iPhone app send the same action from a bottom sheet; nothing in localStorage', async () => {
  const calls = [];
  let answer = { action: 'agent-send', id: 'fx-0501', ok: true, why: '' };
  const fetch = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url.includes('state')) return { status: 200, json: async () => ({ status: null, agents: [] }) };
    return { status: answer.ok ? 200 : 429, json: async () => answer };
  };
  const store = new Map([['kadans.token', 'tok']]);
  const ph = loadPanel({ http: { fetch, store } });
  await flush();
  ph.window.kadans.render(fixture(ph, 'tell'));
  ph.tap({ do: 'tell', id: 'fx-0501' });
  const html = ph.html();
  assert.match(html, /class="tell sheet"/);
  assert.match(html, /Tap the mic on the keyboard to speak/);
  assert.match(html, /on your Mac/);
  const f = ph.el.find('tl:fx-0501');
  f.value = TELL_MSG;
  ph.el.listeners.input.forEach((fn) => fn({ target: f }));
  ph.tap({ do: 'tell-send', id: 'fx-0501' });
  await flush();
  assert.ok(calls.some((c) => c.url === 'api/action' && c.body?.action === 'agent-send' && c.body.id === 'fx-0501' && c.body.text === TELL_MSG));
  assert.equal(f.value, '');
  // the k48 rate limit: its plain line
  answer = { action: 'agent-send', id: 'fx-0501', ok: false, why: 'Too many messages; wait a minute' };
  ph.window.kadans.render(fixture(ph, 'tell')); // the fake Mac's poll answered with no agents
  ph.tap({ do: 'tell', id: 'fx-0501' });
  const g = ph.el.find('tl:fx-0501');
  g.value = 'and one more thing';
  ph.el.listeners.input.forEach((fn) => fn({ target: g }));
  ph.tap({ do: 'tell-send', id: 'fx-0501' });
  await flush();
  ph.window.kadans.render(fixture(ph, 'tell'));
  assert.match(rowHtml(ph.html(), 'fx-0501'), /Too many messages; wait a minute/);
  assert.deepEqual([...store.keys()], ['kadans.token']);
  assert.ok(![...store.values()].some((v) => String(v).includes('SECRET') || String(v).includes('one more')));
});

test('k49: the iPhone app gets the bottom sheet too and sends agent-send through kadansHttp; nothing in localStorage', async () => {
  const msgs = [];
  let state = null;
  const post = (m) => {
    msgs.push(JSON.parse(JSON.stringify(m)));
    if (m.path === 'api/state') return Promise.resolve({ status: 200, body: JSON.stringify(state) });
    const b = JSON.parse(m.body);
    return Promise.resolve({ status: 200, body: JSON.stringify({ action: b.action, id: b.id, ok: true, why: '' }) });
  };
  const native = { post };
  state = fixture(loadPanel(), 'tell');
  const p = loadPanel({ native });
  await flush();
  assert.equal(p.document.documentElement.dataset.shell, 'phone');
  p.tap({ do: 'tell', id: 'fx-0501' });
  assert.match(p.html(), /class="tell sheet"/);
  assert.match(p.html(), /Tap the mic on the keyboard to speak/);
  const f = p.el.find('tl:fx-0501');
  f.value = TELL_MSG;
  p.el.listeners.input.forEach((fn) => fn({ target: f }));
  p.tap({ do: 'tell-send', id: 'fx-0501' });
  await flush();
  const act = msgs.find((m) => m.path === 'api/action');
  assert.deepEqual(JSON.parse(act.body), { action: 'agent-send', id: 'fx-0501', text: TELL_MSG });
  assert.equal(f.value, '');
  assert.match(rowHtml(p.html(), 'fx-0501'), /<span class="ld">Sent<\/span>/);
  assert.deepEqual(native.touched, [], 'never fetch, localStorage or history');
});
