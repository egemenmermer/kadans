// The fake DOM and page loader shared by the panel tests (panel.test.mjs, inbox-ui.test.mjs). No tests here.
// Panel markup safety: every value that comes from JSON must reach the page as text. The panel is loaded in a vm with a
// minimal fake DOM, each fixture is rendered, and the resulting HTML is checked for injected tags and attributes.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'web');
export const read = (f) => readFileSync(join(WEB, f), 'utf8');

// Tags and attributes the panel's own markup uses; anything else in the output came from data.
export const TAGS = new Set(['div', 'span', 'button', 'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'i', 'pre', 'p', 'input', 'img', 'textarea']); // img: the pairing QR (k27); textarea: Tell (k49)
export const ATTRS = new Set(['id', 'class', 'role', 'tabindex', 'title', 'style', 'data-key', 'data-do', 'data-id', 'data-task', 'data-k', 'data-v',
  'data-mode', 'data-until', 'data-num', 'data-set', 'data-unit', 'data-fmt', 'aria-label', 'aria-pressed', 'aria-checked',
  'aria-disabled', 'aria-expanded', 'aria-haspopup', 'aria-hidden', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow',
  'aria-valuetext', 'width', 'height', 'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'd', 'x', 'y', 'rx', 'ry', 'cx', 'cy', 'r', 'transform', 'type', 'min', 'max', 'step', 'value', 'src', 'alt',
  'maxlength', 'placeholder', 'spellcheck', 'autocomplete', 'enterkeyhint', // k32: the rename field
  'rows', 'aria-keyshortcuts', 'aria-live']); // k49: the Tell composer

// A small DOM for the keyed patch (k14): elements made from markup keep their inner markup as a string; shells built
// by appending children serialise from their children. Every change is logged as [op, data-key or tag], so a test can
// tell which nodes a render touched. innerHTML reads back the whole tree, so the markup tests read what is on screen.
const UNESC = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const ESCA = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export class FNode {
  constructor(log, tag, attrs = [], inner = '', text = null) {
    Object.assign(this, { log, tag, inner, text, kids: [], parentNode: null, listeners: {}, style: {} });
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
  // k32: a stub layout for the drag tests: rows 44 px, sub-agent rows 32 px, stacked with no gaps; a list is 304 px wide.
  get offsetHeight() { return / child /.test(` ${this.attrs.get('class') ?? ''} `) ? 32 : 44; }
  get offsetTop() {
    const p = this.parentNode;
    if (!p) return 0;
    let y = 0;
    for (const k of p.kids) { if (k === this) break; if (k.tag !== '#text' && !(k.attrs.get('class') ?? '').includes('plate')) y += k.offsetHeight; }
    return y;
  }
  setPointerCapture() {}
  // simple selectors only: tag, .class, [attr] and [attr="v"], comma lists
  matches(sel) {
    return sel.split(',').some((one) => {
      const m = /^([a-z]*)((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/.exec(one.trim());
      if (!m || this.tag === '#text') return false;
      if (m[1] && m[1] !== this.tag) return false;
      const cls = (this.attrs.get('class') ?? '').split(' ');
      if (m[2] && !m[2].split('.').filter(Boolean).every((c) => cls.includes(c))) return false;
      return [...m[3].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(([, a, v]) => this.attrs.has(a) && (v === undefined || this.attrs.get(a) === v));
    });
  }
  closest(sel) { for (let x = this; x instanceof FNode; x = x.parentNode) if (x.matches(sel)) return x; return null; }
  animate() { return {}; }
}

// opts.clock: { now } read by Date.now() in the page; opts.timers: an array that collects setTimeout callbacks to run by hand
// (k18: each entry gets an id, and clearTimeout marks it `cleared`; nothing is deleted, so tests that fire by ms still work).
// opts.media: { reduce } read by matchMedia('(prefers-reduced-motion: reduce)'), changeable mid-test.
export function loadPanel(opts = {}) {
  const sent = [];
  const log = [];
  const docListeners = {};
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
    addEventListener: (t, fn) => { (docListeners[t] ??= []).push(fn); },
    visibilityState: 'visible',
    querySelectorAll: () => [],
    // fixtures' `after` hooks click buttons: find the data-do / data-id in the selector and run the panel's click handler
    querySelector(sel) {
      if (sel === 'link[rel="manifest"]') return manifestLink; // k29: the page points it at ?pair=<code> in iOS Safari
      const m = /data-do="([^"]+)"(?:\]\[data-id="([^"]+)")?/.exec(sel);
      if (!m) return null;
      const dataset = { do: m[1], ...(m[2] ? { id: m[2] } : {}) };
      return { click: () => click({ target: { closest: () => ({ dataset, getAttribute: () => null }) } }) };
    },
  };
  // k29: panel.html's manifest link (null when opts.http.noManifest)
  const manifestLink = opts.http?.noManifest ? null : { href: 'manifest.webmanifest', setAttribute(k, v) { if (k === 'href') this.href = v; } };
  document.manifestLink = manifestLink;
  const timers = opts.timers;
  let tid = 0;
  const g = { document, console, setTimeout: timers ? (fn, ms) => { timers.push({ id: ++tid, fn, ms }); return tid; } : () => 0,
    clearTimeout: timers ? (id) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true; } : noop,
    matchMedia: (q) => ({ matches: (/reduce/.test(q) && opts.media?.reduce === true) || q === `(display-mode: ${opts.http?.displayMode ?? 'browser'})` }), CSS: { escape: String },
    webkit: { messageHandlers: { kadans: { postMessage: (m) => sent.push(m) } } } };
  // k29 opts.http.standalone: navigator.standalone (iOS: false in Safari, true in a home-screen app; elsewhere unset);
  // opts.http.displayMode: what (display-mode: …) matches ('browser' by default).
  // k27 opts.http: { fetch, hash, store }: no bridge, a top-level http page (the phone), so panel.js starts its HTTP mode.
  if (opts.http) {
    delete g.webkit;
    const store = opts.http.store ?? new Map();
    Object.assign(g, { fetch: opts.http.fetch, navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      ...(Object.hasOwn(opts.http, 'standalone') ? { standalone: opts.http.standalone } : {}) },
      localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
      location: { protocol: 'http:', hash: opts.http.hash ?? '', pathname: '/', search: '' },
      history: { replaceState: (a, b, url) => { g.location.hash = ''; (opts.http.replaced ??= []).push(url); } } });
    g.top = g;
  }
  // k46 opts.native: { post, touched }: the iPhone app. The page sits on its own kadans-panel: scheme and has only
  // webkit.messageHandlers.kadansHttp (post answers {status, body}); fetch, localStorage and history record a touch.
  if (opts.native) {
    const touched = (opts.native.touched ??= []);
    const touch = (what) => () => { touched.push(what); return null; };
    Object.assign(g, { webkit: { messageHandlers: { kadansHttp: { postMessage: opts.native.post } } },
      fetch: () => { touched.push('fetch'); return Promise.reject(new Error('no fetch in the app')); },
      navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', standalone: false },
      localStorage: { getItem: touch('localStorage'), setItem: touch('localStorage'), removeItem: touch('localStorage') },
      location: { protocol: 'kadans-panel:', hash: '', pathname: '/panel.html', search: '' },
      history: { replaceState: touch('history') } });
    g.top = g;
  }
  if (opts.clock) g.Date = class extends Date { static now() { return opts.clock.now; } };
  g.window = g; // fixtures assign window.KF / window.KADANS_FIXTURES, which must be globals for the other scripts
  const ctx = vm.createContext(g);
  const window = g;
  vm.runInContext(read('panel.js'), ctx);
  vm.runInContext(['_base.js', ...readdirSync(join(WEB, 'fixtures')).filter((f) => f.endsWith('.js') && f !== '_base.js').sort()]
    .map((f) => read(join('fixtures', f))).join('\n;\n'), ctx);
  // a click on any element by its dataset (Settings segments carry data-k / data-v, which the fake querySelector does not parse)
  const tap = (dataset) => click({ target: { closest: () => ({ dataset, getAttribute: () => null }) } });
  return { window, document, html: () => el.innerHTML, sent, tap, el, log, docListeners };
}

// Fails on any tag or attribute the panel does not write itself (e.g. an injected <img onerror=...>).
export function assertNoInjection(html, label) {
  for (const t of html.matchAll(/<\/?([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>/g)) {
    assert.ok(TAGS.has(t[1]), `${label}: unexpected tag <${t[1]}>`);
    for (const a of t[2].matchAll(/([\w:-]+)(?:="[^"]*")?/g)) assert.ok(ATTRS.has(a[1]), `${label}: unexpected attribute ${a[1]} on <${t[1]}>`);
  }
  // every "<" left must belong to a tag matched above (stray "<" from data would be text only if escaped)
  const stripped = html.replace(/<\/?([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>/g, '');
  assert.ok(!stripped.includes('<') && !stripped.includes('>'), `${label}: raw angle bracket in text or attribute`);
}

export const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
// A fake server: records every call; `routes` answers by "METHOD path" with [status, body].
export function fakeServer(routes) {
  const calls = [];
  const fetch = (path, init = {}) => {
    calls.push({ path, method: init.method, auth: init.headers?.Authorization ?? null, body: init.body ? JSON.parse(init.body) : null });
    const r = routes[`${init.method} ${path}`];
    if (!r) return Promise.reject(new Error('offline'));
    const res = typeof r === 'function' ? r(init) : r;
    if (!res) return Promise.reject(new Error('offline'));
    const [status, body] = res;
    return Promise.resolve({ status, json: async () => body });
  };
  return { calls, fetch, routes };
}
export const fixture = (p, name) => { const f = { ...p.window.KADANS_FIXTURES[name] }; delete f.after; return JSON.parse(JSON.stringify(f)); };
