// polish-2: agent rows stay minimal. One primary action per row state, the rest in one "More" menu in a fixed order
// (greyed items keep their reason), keyboard and Escape, one menu at a time, the phone's sheet, and the bridge messages
// unchanged. Runs the panel in the fake DOM of panel-dom.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPanel, assertNoInjection, flush, fixture, rowActs } from './panel-dom.mjs';

const PN = 1792964040000; // fixtures/_base.js KF.N
const M = 60_000;
const orca = (terminal, state = 'working') => ({ terminal, worktree: 'main', repo: 'Tidepool', state, title: null, ambiguous: false });
const big = { tokens: 150000, window: 200000, pct: 75, advice: 'now', why: 'Re-reads 150k tokens every turn' };

function page(opts = {}) {
  const p = loadPanel({ clock: { now: PN }, timers: [], ...opts });
  if (!opts.http) p.window.kadans.reset();
  const A = p.window.KF.agent;
  // Every state, in Orca on this Mac, with one paired computer (kasa) so Continue on applies.
  const agents = [
    A('fx-0701', { title: 'Make the rain sound loop without a gap', titleSource: 'session', orca: orca('term_a') }), // working, Tell
    A('fx-0702', { status: 'idle', lastSeen: PN - 9 * M, stateSince: PN - 9 * M, context: big, orca: orca('term_b', 'idle') }), // idle, Tell + Compact
    A('fx-0703', { status: 'needs-you', orca: orca('term_c') }),
    A('fx-0704', { pace: { mode: 'slow', until: null }, orca: orca('term_d') }), // slowed
    A('fx-0705', { pace: { mode: 'paused', until: null }, orca: orca('term_e') }), // paused
    A('fx-0706', { orca: null }), // working, no Orca terminal: no Tell
    A('fx-0707', { status: 'idle', lastSeen: PN - 9 * M, orca: null }), // idle, no Tell
    A('fx-0708', { status: 'ended', lastSeen: PN - M }),
  ];
  const inbox = { ready: true, hub: 'on', machines: [{ id: 'local', name: 'This Mac' }, { id: 'env-0001', name: 'kasa' }], items: [] };
  const data = { status: p.window.KF.status({ queue: { next: [] } }), agents, inbox }; // no approved task: Replace greyed
  const sent = () => JSON.parse(JSON.stringify(p.sent.filter((m) => !['size', 'inbox'].includes(m.action))));
  const key = (e) => p.docListeners.keydown.forEach((fn) => fn({ preventDefault() {}, ...e }));
  return { p, data, sent, key };
}
// The row's own buttons (aria-label, data-do) and the open menu's items, in order.
const rowButtons = (html, id) => {
  const i = html.indexOf(`data-key="row:${id}"`);
  const a = html.indexOf('<div class="acts', i);
  const acts = html.slice(a, html.indexOf('</div>', a));
  return [...acts.matchAll(/<button[^>]*?aria-label="([^"]*)"(?: data-do="([^"]*)")?/g)].map((m) => [m[1], m[2] ?? null]);
};
const menuItems = (html, id) => {
  const m = html.indexOf(`data-key="menu:more:${id}"`);
  if (m < 0) return null;
  const rest = html.slice(m + 1);
  const end = rest.search(/data-key="(?!more:)/);
  const seg = html.slice(m, end < 0 ? undefined : m + 1 + end);
  return [...seg.matchAll(/<button role="menuitem"[^>]*?aria-label="([^"]*)"/g)].map((x) => x[1]);
};

test('polish-2: one primary action per row state, then More; ended rows keep Dismiss only', () => {
  const { p, data } = page();
  p.window.kadans.render(data);
  const html = p.html();
  const primary = (id) => rowButtons(html, id).map(([, d]) => d);
  assert.deepEqual(primary('fx-0701'), ['tell', 'more'], 'working: Tell');
  assert.deepEqual(primary('fx-0702'), ['tell', 'more'], 'idle: Tell');
  assert.deepEqual(primary('fx-0703'), ['open', 'more'], 'needs you, on the Mac: Open in terminal');
  assert.deepEqual(primary('fx-0704'), ['resume', 'more'], 'slowed: Resume');
  assert.deepEqual(primary('fx-0705'), ['resume', 'more'], 'paused: Resume');
  assert.deepEqual(primary('fx-0706'), ['confirm', 'more'], 'working, Tell not allowed: Stop');
  assert.deepEqual(primary('fx-0707'), ['close', 'more'], 'idle, Tell not allowed: Close');
  assert.deepEqual(rowButtons(html, 'fx-0708'), [['Dismiss', 'dismiss']], 'ended: Dismiss, no menu');
  // never more than two buttons on a row; More says it opens a menu and is closed
  for (const id of ['fx-0701', 'fx-0702', 'fx-0703', 'fx-0704', 'fx-0705', 'fx-0706', 'fx-0707']) {
    assert.ok(rowButtons(html, id).length <= 2, id);
    assert.match(html, new RegExp(`aria-label="More actions" data-do="more" data-id="${id}" aria-haspopup="menu" aria-expanded="false"`));
  }
  assert.doesNotMatch(html, /data-key="menu:more:/, 'no menu until More is pressed');
  assertNoInjection(html, 'rows');
});

test('polish-2: the More menu lists every other action in one fixed order; greyed ones say why on a second line', () => {
  const { p, data, sent } = page();
  p.window.kadans.render(data);
  p.tap({ do: 'more', id: 'fx-0702' });
  let html = p.html();
  assert.deepEqual(sent(), [], 'More sends nothing to the host');
  assert.match(html, /data-do="more" data-id="fx-0702" aria-haspopup="menu" aria-expanded="true"/);
  assert.deepEqual(menuItems(html, 'fx-0702'), ['Continue on kasa', 'Compact chat', 'Slow or pause', 'Replace (No approved task to start)', 'Rename', 'Close chat']);
  // the greyed Replace: aria-disabled, no data-do (a click does nothing), its reason as the second line
  assert.match(html, /aria-label="Replace \(No approved task to start\)" aria-disabled="true" aria-haspopup="menu" data-key="more:fx-0702:replace">.*?<span class="nm">Replace<\/span><span class="pv">No approved task to start<\/span><\/button>/);
  // Close sits last, under a hairline; the menu is inline under its row on the Mac
  assert.match(html, /<div class="sep" role="separator"><\/div><button role="menuitem"[^>]*data-do="close" data-id="fx-0702"/);
  assert.ok(html.indexOf('data-key="row:fx-0702"') < html.indexOf('data-key="menu:more:fx-0702"'));
  assert.ok(html.indexOf('data-key="menu:more:fx-0702"') < html.indexOf('data-key="row:fx-0703"'));
  assert.match(html, /class="row hov" tabindex="0" data-key="row:fx-0702"/, 'its row stays lit while the menu is open');
  assert.match(html, /data-key="row:fx-0702"[^]*?<div class="acts on">/, 'and its buttons stay shown');
  assertNoInjection(html, 'menu');
  // the other states: same order, without the row's primary
  const items = (id) => { p.tap({ do: 'more', id }); const m = menuItems(p.html(), id); p.tap({ do: 'more', id }); return m; };
  assert.deepEqual(items('fx-0701'), ['Continue on kasa', 'Slow or pause', 'Replace (No approved task to start)', 'Rename', 'Stop']);
  assert.deepEqual(items('fx-0703'), ['Replace (No approved task to start)', 'Rename', 'Stop']);
  assert.deepEqual(items('fx-0704'), ['Tell', 'Continue on kasa', 'Replace (No approved task to start)', 'Rename', 'Stop']);
  assert.deepEqual(items('fx-0706'), ['Slow or pause', 'Replace (No approved task to start)', 'Rename']);
  html = p.html();
  assert.doesNotMatch(html, /data-key="menu:more:/);
});

test('polish-2: keyboard: focus starts on the first action; Up/Down wrap, Home/End jump; Escape closes and sends nothing', () => {
  const { p, data, sent, key } = page();
  p.window.kadans.render(data);
  p.tap({ do: 'more', id: 'fx-0702' });
  const active = () => /<button role="menuitem" tabindex="0"[^>]*aria-label="([^"]*)"/.exec(p.html())?.[1];
  assert.equal(active(), 'Continue on kasa');
  assert.equal((p.html().match(/role="menuitem" tabindex="0"/g) ?? []).length, 1, 'one item in the tab order (roving)');
  key({ key: 'ArrowDown' });
  assert.equal(active(), 'Compact chat');
  key({ key: 'ArrowDown' });
  key({ key: 'ArrowDown' });
  assert.equal(active(), 'Replace (No approved task to start)', 'a greyed action is reachable (it is read out with its reason)');
  key({ key: 'End' });
  assert.equal(active(), 'Close chat');
  key({ key: 'ArrowDown' });
  assert.equal(active(), 'Continue on kasa', 'wraps to the top');
  key({ key: 'ArrowUp' });
  assert.equal(active(), 'Close chat', 'wraps to the bottom');
  key({ key: 'Home' });
  assert.equal(active(), 'Continue on kasa');
  key({ key: 'ArrowDown', altKey: true }); // Alt+Down moves rows, never the menu
  assert.equal(active(), 'Continue on kasa');
  key({ key: 'Escape' });
  assert.doesNotMatch(p.html(), /data-key="menu:more:/);
  assert.match(p.html(), /data-do="more" data-id="fx-0702" aria-haspopup="menu" aria-expanded="false"/);
  assert.deepEqual(sent(), [], 'Escape on an open menu does not close the popover');
  key({ key: 'Escape' });
  assert.deepEqual(sent(), [{ action: 'close' }], 'the next Escape does, as before');
  // opened again: focus starts at the top again
  p.tap({ do: 'more', id: 'fx-0702' });
  assert.equal(active(), 'Continue on kasa');
});

test('polish-2: one menu at a time; a click outside closes it; a greyed item keeps it open; sub-menus open from it', () => {
  const { p, data, sent } = page();
  p.window.kadans.render(data);
  p.tap({ do: 'more', id: 'fx-0701' });
  p.tap({ do: 'more', id: 'fx-0707' });
  assert.equal((p.html().match(/data-key="menu:more:/g) ?? []).length, 1);
  assert.match(p.html(), /data-key="menu:more:fx-0707"/);
  // More again closes it
  p.tap({ do: 'more', id: 'fx-0707' });
  assert.doesNotMatch(p.html(), /data-key="menu:more:/);
  // a click on nothing closes it; a click inside the menu off any action (a greyed one) keeps it
  const click = (inMenu) => p.el.listeners.click[0]({ target: { closest: (sel) => (inMenu && sel === '.pick.more' ? {} : null) } });
  p.tap({ do: 'more', id: 'fx-0701' });
  click(true);
  assert.match(p.html(), /data-key="menu:more:fx-0701"/);
  click(false);
  assert.doesNotMatch(p.html(), /data-key="menu:more:/);
  // Slow or pause: the menu gives way to the pace menu in the same place (and Escape there closes it)
  p.tap({ do: 'more', id: 'fx-0701' });
  p.tap({ do: 'pace', id: 'fx-0701' });
  assert.doesNotMatch(p.html(), /data-key="menu:more:/);
  assert.match(p.html(), /data-key="menu:pace:fx-0701" role="menu" aria-label="Pace this agent"/);
  p.tap({ do: 'pace-set', id: 'fx-0701', mode: 'slow' });
  // Replace from the menu opens the task picker (with an approved task to start)
  const withTask = { ...data, status: { ...data.status, queue: { next: [{ id: 7, text: 'Ship the loop fix', project: 'Tidepool', approved: true, urgency: 'week' }] } } };
  p.window.kadans.render(withTask);
  p.tap({ do: 'more', id: 'fx-0701' });
  assert.deepEqual(menuItems(p.html(), 'fx-0701'), ['Continue on kasa', 'Slow or pause', 'Replace', 'Rename', 'Stop']);
  p.tap({ do: 'replace', id: 'fx-0701' });
  assert.doesNotMatch(p.html(), /data-key="menu:more:/);
  assert.match(p.html(), /data-key="menu:pick:fx-0701" role="menu" aria-label="Replace with"/);
  assert.deepEqual(sent(), [{ action: 'pace', id: 'fx-0701', mode: 'slow' }]);
  // k54's computer menu (two paired computers) gives way to More as well
  p.window.kadans.render(fixture(p, 'handoff_pick'));
  p.tap({ do: 'more', id: 'fx-0601' });
  p.tap({ do: 'handoff', id: 'fx-0601' });
  assert.match(p.html(), /role="menu" aria-label="Continue on"/);
  assert.doesNotMatch(p.html(), /data-key="menu:more:/);
  p.tap({ do: 'more', id: 'fx-0602' });
  assert.match(p.html(), /data-key="menu:more:fx-0602"/);
  assert.doesNotMatch(p.html(), /role="menu" aria-label="Continue on"/);
  assert.equal((p.html().match(/role="menu"/g) ?? []).length, 1);
});

test('polish-2: every action keeps its exact bridge message when it runs from the menu', () => {
  const { p, data, sent } = page();
  p.window.kadans.render(data);
  const fromMenu = (id, act, extra = {}) => { p.tap({ do: 'more', id }); p.tap({ do: act, id, ...extra }); };
  fromMenu('fx-0701', 'confirm'); // Stop: confirm first
  assert.match(p.html(), /data-do="stop" data-id="fx-0701">Stop</);
  p.tap({ do: 'stop', id: 'fx-0701' });
  fromMenu('fx-0702', 'compact');
  p.tap({ do: 'compact-go', id: 'fx-0702' });
  fromMenu('fx-0704', 'tell');
  assert.match(p.html(), /data-key="tell:fx-0704"/, 'Tell opens its composer');
  p.tap({ do: 'tell-cancel', id: 'fx-0704' });
  fromMenu('fx-0707', 'rename');
  assert.match(p.html(), /data-key="rn:fx-0707"/, 'Rename opens the name field');
  p.tap({ do: 'resume', id: 'fx-0705' }); // primary on the row
  p.tap({ do: 'open', id: 'fx-0703' });
  p.tap({ do: 'dismiss', id: 'fx-0708' });
  fromMenu('fx-0701', 'handoff');
  assert.match(p.html(), /class="tell ho" role="group" aria-label="Continue on kasa"/);
  assert.deepEqual(sent(), [
    { action: 'stop', id: 'fx-0701' },
    { action: 'compact', id: 'fx-0702' },
    { action: 'pace', id: 'fx-0705', mode: 'none' },
    { action: 'open', id: 'fx-0703' },
    { action: 'dismiss', id: 'fx-0708' },
  ]);
});

test('polish-2: no action lost: the row plus its menu hold what the row held before, plus Rename', () => {
  const { p, data } = page();
  p.window.kadans.render(data);
  const has = (id) => [...rowActs(p, id).matchAll(/data-do="([^"]+)"|aria-label="([^"(]+) \(/g)].map((m) => m[1] ?? m[2]).filter((d) => d !== 'more');
  // (a greyed action has no data-do: its label counts)
  assert.deepEqual(has('fx-0701'), ['tell', 'handoff', 'pace', 'Replace', 'rename', 'confirm']);
  assert.deepEqual(has('fx-0702'), ['tell', 'handoff', 'compact', 'pace', 'Replace', 'rename', 'close']);
  assert.deepEqual(has('fx-0703'), ['open', 'Replace', 'rename', 'confirm']);
  assert.deepEqual(has('fx-0704'), ['resume', 'tell', 'handoff', 'Replace', 'rename', 'confirm']);
  assert.deepEqual(has('fx-0708'), ['dismiss']);
  // another computer's chat: a menu of one is no menu (Tell and Close sit on the row)
  const d = fixture(p, 'remote');
  Object.assign(d.agents.find((a) => a.id === 'remote:other:tab-1:1'), { status: 'idle', canStop: true, canCompact: true, canSend: true });
  p.window.kadans.render(d);
  assert.deepEqual(rowButtons(p.html(), 'remote:other:tab-1:1').map(([, x]) => x), ['tell', 'more']);
  p.tap({ do: 'more', id: 'remote:other:tab-1:1' });
  assert.deepEqual(menuItems(p.html(), 'remote:other:tab-1:1'), ['Compact chat', 'Close chat']);
  p.tap({ do: 'more', id: 'remote:other:tab-1:1' });
  Object.assign(d.agents.find((a) => a.id === 'remote:other:tab-1:1'), { canCompact: false });
  p.window.kadans.render(d);
  assert.deepEqual(rowButtons(p.html(), 'remote:other:tab-1:1').map(([, x]) => x), ['tell', 'close']);
});

test('polish-2: the menu closes when its row ends, leaves, or the popover closes', () => {
  const { p, data } = page();
  p.window.kadans.render(data);
  p.tap({ do: 'more', id: 'fx-0701' });
  p.window.kadans.render({ ...data, agents: data.agents.map((a) => (a.id === 'fx-0701' ? { ...a, status: 'ended', lastSeen: PN } : a)) });
  assert.doesNotMatch(p.html(), /data-key="menu:more:/);
  p.window.kadans.render(data);
  p.tap({ do: 'more', id: 'fx-0702' });
  p.window.kadans.visible(false);
  p.window.kadans.visible(true);
  p.window.kadans.render({});
  assert.doesNotMatch(p.html(), /data-key="menu:more:/);
});

test('polish-2 phone: More opens the same actions, same order, as a bottom sheet with Cancel; needs-you has no primary', async () => {
  const fetch = async (url) => (url.includes('state') ? { status: 200, json: async () => ({ status: null, agents: [] }) }
    : { status: 200, json: async () => ({ ok: true }) });
  const { p, data, sent } = page({ http: { fetch, store: new Map([['kadans.token', 'tok']]) } });
  await flush();
  p.window.kadans.render(data);
  const html = p.html();
  assert.deepEqual(rowButtons(html, 'fx-0703').map(([, x]) => x), ['more'], 'no terminal on a phone, and no Tell for a chat that waits');
  assert.deepEqual(rowButtons(html, 'fx-0702').map(([, x]) => x), ['tell', 'more']);
  p.tap({ do: 'more', id: 'fx-0702' });
  const h = p.html();
  assert.match(h, /class="pick more sheet" data-key="menu:more:fx-0702" role="menu" aria-label="Actions for [^"]+"><div class="pick-h">/);
  assert.deepEqual(menuItems(h, 'fx-0702'), ['Continue on kasa', 'Compact chat', 'Slow or pause', 'Replace (No approved task to start)', 'Rename', 'Close chat']);
  assert.ok(h.indexOf('data-key="menu:more:fx-0702"') > h.lastIndexOf('data-key="row:'), 'drawn with the panel, over the list');
  assert.match(h, /data-do="more-cancel" data-id="fx-0702"[^>]*>Cancel<\/button>/);
  p.tap({ do: 'more-cancel', id: 'fx-0702' });
  assert.doesNotMatch(p.html(), /data-key="menu:more:/);
  p.tap({ do: 'more', id: 'fx-0703' });
  assert.deepEqual(menuItems(p.html(), 'fx-0703'), ['Replace (No approved task to start)', 'Rename', 'Stop']);
  assertNoInjection(p.html(), 'phone sheet');
  assert.ok(!sent().some((m) => m.action === 'more' || m.action === 'more-cancel'));
});
