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

function loadPanel() {
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
  const g = { document, console, setTimeout: () => 0, clearTimeout: noop, matchMedia: () => ({ matches: false }), CSS: { escape: String },
    webkit: { messageHandlers: { kadans: { postMessage: (m) => sent.push(m) } } } };
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
