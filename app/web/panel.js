// Kadans menu bar panel. No network: the host calls window.kadans.render({ status, agents }) with the output of
// `kadans status --json` and `kadans agents --json`; buttons call window.kadans.send({ action, ... }).
(function () {
  'use strict';

  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const CONFIRM_MS = 4000;
  const ENDED_KEEP_MS = 10 * MIN;
  const STALE_MS = 2 * HOUR; // idle this long: folded into the "N idle" row (the CLI marks these stale: true)
  const SOON = 'Coming soon';

  // ---------- helpers ----------
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const own = (map, k, fallback) => (typeof k === 'string' && Object.hasOwn(map, k) ? map[k] : fallback); // not map['__proto__']
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const thin = (l) => finite(l.samples) && l.samples < 3; // under 3 samples shows the "too little data" copy

  function dur(ms) {
    const total = Math.max(1, Math.round(Math.max(0, ms) / MIN));
    const d = Math.floor(total / 1440);
    const h = Math.floor((total % 1440) / 60);
    const m = total % 60;
    if (d) return h ? `${d} d ${h} hr` : `${d} d`;
    if (h) return m ? `${h} hr ${m} min` : `${h} hr`;
    return `${m} min`;
  }
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (t) => {
    const d = new Date(t);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayTime = (t) => `${DAYS[new Date(t).getDay()]} ${hhmm(t)}`;
  function tokens(n) {
    if (!finite(n) || n <= 0) return null;
    if (n < 1000) return String(Math.round(n));
    if (n < 999_500) return `${Math.round(n / 1000)}k`;
    return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  }
  function family(model) {
    const m = String(model ?? '').toLowerCase();
    if (m.includes('opus')) return 'Opus';
    if (m.includes('sonnet')) return 'Sonnet';
    if (m.includes('haiku')) return 'Haiku';
    return null;
  }
  // FNV-1a, so an agent keeps its blob across refreshes.
  function hash(s) {
    let h = 0x811c9dc5;
    for (const ch of String(s ?? '')) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  }

  // ---------- blob avatars: the face shows the state ----------
  const SHAPES = {
    shield: '<path d="M16 3.5 26.5 7.5V15c0 6.5-4.6 11.2-10.5 13.5C10.1 26.2 5.5 21.5 5.5 15V7.5Z"/>',
    square: '<rect x="4.5" y="5" width="23" height="22" rx="7.5"/>',
    star: '<path d="M16 4.5l3.1 6.6 7.2.9-5.3 5 1.4 7.1L16 20.6l-6.4 3.5L11 17l-5.3-5 7.2-.9Z" stroke-linejoin="round" stroke-width="3.2"/>',
    flower: '<circle cx="16" cy="9.5" r="5.5"/><circle cx="22.3" cy="14" r="5.5"/><circle cx="20" cy="21.5" r="5.5"/><circle cx="12" cy="21.5" r="5.5"/><circle cx="9.7" cy="14" r="5.5"/><circle cx="16" cy="16" r="6"/>',
    egg: '<ellipse cx="16" cy="17" rx="10.5" ry="11.5"/>',
  };
  const SHAPE_NAMES = Object.keys(SHAPES);
  const LINE = 'style="stroke:var(--ink)" stroke-linecap="round" fill="none"';
  const FACES = {
    work: '<rect x="12.6" y="12.5" width="2.6" height="6" rx="1.3"/><rect x="18" y="12.5" width="2.6" height="6" rx="1.3"/>',
    wait: `<rect x="11.8" y="13.5" width="2.6" height="5.4" rx="1.3"/><rect x="17.6" y="13.5" width="2.6" height="5.4" rx="1.3"/><path d="M11 11.2l3.6-1M21 11.2l-3.6-1" stroke-width="1.4" ${LINE}/>`,
    slow: `<path d="M11.5 16h3.6M17.4 16H21" stroke-width="1.8" ${LINE}/>`,
    pause: `<path d="M11.3 15.2q1.8 1.8 3.6 0M17.3 15.2q1.8 1.8 3.6 0" stroke-width="1.6" ${LINE}/>`,
    idle: '<circle cx="13.9" cy="15.6" r="1.4"/><circle cx="19.3" cy="15.6" r="1.4"/>',
    done: `<path d="M11.4 16.4q1.8-1.8 3.6 0M17.2 16.4q1.8-1.8 3.6 0" stroke-width="1.6" ${LINE}/>`,
  };
  // The face sits in its own group (class fc) so it can blink; the svg carries the face name (f-work…) for CSS.
  function avatar(shape, face, size = 30) {
    const s = SHAPES[shape];
    const body = `var(--blob-${shape})`;
    const edge = `var(--blob-${shape}-edge)`;
    const star = shape === 'star';
    return `<svg class="av f-${face}" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">` +
      `<g style="fill:${edge}${star ? `;stroke:${edge}` : ''}" transform="translate(1.2 1.6)">${s}</g>` +
      `<g style="fill:${body}${star ? `;stroke:${body}` : ''}">${s}</g><g class="fc" style="fill:var(--ink)">${FACES[face]}</g></svg>`;
  }
  const shapeOf = (id) => SHAPE_NAMES[hash(id) % SHAPE_NAMES.length];
  // k18: a list blob sits in a wrapper span (bw) that carries the slow motion (working: a calm breathe; needs you: a small
  // hop every few seconds), so the arrival squish on the svg inside composes with it. move: 'work' | 'need' | null. --ph
  // (0-1, from the id) staggers the loops so rows never move in step; it is part of the markup, so it never changes on a
  // refresh. The blink class goes on the wrapper too (.bw.blink .fc). Returned as an item flagged with its face, so the
  // blink timer finds the blobs in the render tree, not by querying the DOM.
  const BLINKABLE = new Set(['work', 'wait', 'idle']);
  function blob(shape, face, size, move = null, id = '') {
    const ph = move ? ` style="--ph:${(hash(`ph:${id}`) % 1000) / 1000}"` : '';
    return { html: `<span class="bw${move ? ` bw-${move}` : ''}"${ph}>${avatar(shape, face, size)}</span>`, blob: face };
  }
  const MOVE = { working: 'work', 'needs-you': 'need' };

  // Distinct blobs: no two visible rows share a shape while a free one is left. Rows are ranked oldest first (startedAt,
  // then id), so a newcomer never takes an older agent's blob; each row starts at its hash shape and, on a collision,
  // takes the next free shape in SHAPE_NAMES order. Once all five are used, rows fall back to their hash shape.
  // items: [{ id, startedAt?, rank? }]; lower rank first (the panel: 0 live rows, 1 their subagents, 2 the idle group's
  // rows, 3 their subagents), so live rows never change blob when the idle group opens. Same input, same output.
  function assignShapes(items) {
    const t = (x) => (finite(x.startedAt) ? x.startedAt : Infinity);
    const ranked = [...items].filter((x) => x && x.id != null)
      .sort((a, b) => (a.rank || 0) - (b.rank || 0) || t(a) - t(b) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    const used = new Set();
    const out = new Map();
    for (const x of ranked) {
      if (out.has(String(x.id))) continue;
      const pref = hash(x.id) % SHAPE_NAMES.length;
      let pick = SHAPE_NAMES[pref];
      if (used.size < SHAPE_NAMES.length) {
        for (let i = 0; i < SHAPE_NAMES.length; i++) {
          const name = SHAPE_NAMES[(pref + i) % SHAPE_NAMES.length];
          if (!used.has(name)) { pick = name; break; }
        }
      }
      used.add(pick);
      out.set(String(x.id), pick);
    }
    return out;
  }
  let shapeMap = new Map();
  const shapeFor = (id) => shapeMap.get(String(id)) ?? shapeOf(id);

  const IC = {
    pace: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 11a5 5 0 1 1 10 0"/><path d="M8 11 5.8 8"/></svg>',
    play: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 4v8l6.5-4z"/></svg>',
    swap: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 5.5h9L10 3M12.5 10.5h-9L6 13"/></svg>',
    stop: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4.5" y="4.5" width="7" height="7" rx="1.8"/></svg>',
    open: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h6v6M12 4l-7.5 7.5"/></svg>',
    x: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
    compact: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.8v4.4M5.6 4 8 6.2 10.4 4M8 14.2V9.8M5.6 12 8 9.8l2.4 2.2M3.5 8h9"/></svg>',
    chev: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 4l4 4-4 4"/></svg>',
    theme: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/></svg>',
    gear: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/></svg>',
  };

  // ---------- view state that survives re-renders (render runs every 5 s) ----------
  // confirm: agent id with an inline confirm open; kind 'stop' | 'replace' (task = the picked task id).
  // picker: agent id whose "Replace with" menu is open. pacer: agent id whose "Pace this agent" menu is open.
  // idleOpen: the "N idle" group is expanded.
  const view = { confirm: null, kind: 'stop', task: null, picker: null, pacer: null, idleOpen: false, focusPick: false, timer: null, account: null,
    dismissed: new Set(), scroll: 0, height: 0, data: null,
    // k4c: screen 'main' | 'settings' | 'review'; from: where Review was opened; pending config picks; apply flow flags.
    screen: 'main', from: 'main', pending: {}, uninstallOpen: false, applyConfirm: false, applying: false, applied: false,
    applyFailed: false, dragging: false, deferred: false, sScroll: 0, stree: null,
    // k9a motion: firstAt = first paint (never animated); slide = settings push {dir, at};
    // leaving = an exit animation is running. Close idle: closeAll = "Close N idle chats?" open; bulk = the run in progress.
    // k14: tree = the last main-panel item tree (null after a Settings / Review screen: the next main render builds anew);
    // shown = the popover is open (host: kadans.visible); animUntil = when the running enter / leave / slide ends.
    firstAt: 0, slide: null, leaving: false, hoverKey: null, focusKey: null, tree: null, shown: true, animUntil: 0, sizeTimer: null, sizeNow: false,
    closeAll: false, closeTimer: null, bulk: null,
    // k10b: the one compact in flight, { id, tokens (context at the click), at, failedAt }.
    // k12: the latest action result for one row, { id, ok, why, at }, shown for RESULT_KEEP_MS.
    compact: null, result: null };

  // ---------- motion (k9a, k14) ----------
  // Calm and short: 120-260 ms, transform and opacity only. Nothing moves on the first paint, in the 300 ms after it
  // (fixture `after` clicks, snapshots), with reduced motion, or while the popover is closed (document.hidden, or the
  // host's kadans.visible(false)).
  const ENTER_MS = 260;
  const LEAVE_MS = 150;
  const SHIFT_MS = 200;
  const OUT_MS = 130;
  const EASE = 'cubic-bezier(.2,.9,.25,1)';
  const reduced = () => {
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  };
  const motionOk = () => !reduced() && !document.hidden && view.shown && view.firstAt > 0 && Date.now() - view.firstAt > 300;
  const busy = (ms) => { view.animUntil = Math.max(view.animUntil, Date.now() + ms); };

  // ---------- keyed patch (k14) ----------
  // The panel is a tree of items: { key?, html } (markup) or a shell { tag, attrs, kids, keyed } built by S(). render()
  // builds the whole tree every time (the single source of truth); patch() compares it with the last tree, by markup
  // strings and attribute values, never by reading the DOM. Same markup: the node is kept. A shell whose attributes
  // changed is updated in place (class by token, so runtime classes such as enter / leave stay). Keyed kids (the
  // panel's blocks, the agent list) are matched by key, the others by position. So hover, focus, scroll, open menus and
  // running transitions survive the 5 s refresh, and a refresh with the same data touches no node at all.
  const ATTR_SKIP = (v) => v === null || v === undefined || v === false;
  const attrStr = (a) => Object.entries(a).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  function S(tag, attrs, kids = [], key, keyed = false) {
    const a = {};
    for (const [k, v] of Object.entries(attrs)) if (!ATTR_SKIP(v)) a[k] = String(v);
    const ks = kids.filter((k) => k !== '' && k !== null && k !== undefined).map((k) => (typeof k === 'string' ? { html: k } : k));
    return { key, tag, attrs: a, kids: ks, keyed };
  }
  const isShell = (it) => it.tag !== undefined;
  function markup(it) {
    if (!isShell(it)) return it.html;
    if (it.m === undefined) it.m = `<${it.tag}${attrStr(it.attrs)}>${it.kids.map(markup).join('')}</${it.tag}>`;
    return it.m;
  }
  const patchStats = { made: 0, replaced: 0, removed: 0, attrs: 0 };
  function make(html) {
    const t = document.createElement('template');
    t.innerHTML = html;
    patchStats.made += 1;
    return t.content.firstChild;
  }
  // k18: a new shell is parsed once from its whole markup and its items are bound to the nodes the parser made (one
  // parse for a whole screen, not one per shell). If the node count does not line up (an item that parses to more than
  // one node, or the test DOM), each item is built on its own as before.
  function build(it) {
    if (!isShell(it)) return (it.node = make(it.html));
    const whole = make(markup(it));
    if (whole && bind(it, whole)) return whole;
    const n = make(`<${it.tag}${attrStr(it.attrs)}></${it.tag}>`);
    for (const k of it.kids) n.appendChild(build(k));
    return (it.node = n);
  }
  function bind(it, node) {
    it.node = node;
    if (!isShell(it)) return true;
    const c = node.childNodes;
    if (!c || c.length !== it.kids.length) return false;
    for (let i = 0; i < c.length; i++) if (!bind(it.kids[i], c[i])) return false;
    return true;
  }
  function swapClasses(node, from, to) {
    const a = new Set(String(from ?? '').split(' ').filter(Boolean));
    const b = new Set(String(to ?? '').split(' ').filter(Boolean));
    for (const c of a) if (!b.has(c)) node.classList.remove(c);
    for (const c of b) if (!a.has(c)) node.classList.add(c);
  }
  function patchShell(o, n, ctx) {
    const node = (n.node = o.node);
    for (const k of Object.keys(o.attrs)) {
      if (k in n.attrs) continue;
      if (k === 'class') swapClasses(node, o.attrs.class, '');
      else node.removeAttribute(k);
      patchStats.attrs += 1;
    }
    for (const [k, v] of Object.entries(n.attrs)) {
      if (o.attrs[k] === v) continue;
      if (k === 'class') swapClasses(node, o.attrs.class, v);
      else node.setAttribute(k, v);
      if (k === 'value' && node.tagName === 'INPUT') node.value = v; // a moved range no longer follows its attribute
      patchStats.attrs += 1;
    }
    if (n.keyed) patchKeyed(node, o.kids, n.kids, ctx, n.fade === true);
    else patchKids(node, o.kids, n.kids, ctx);
  }
  // One item against its old self: kept, patched in place or replaced. Returns the node now on screen.
  function patchOne(o, n, ctx) {
    if (isShell(o) && isShell(n) && o.tag === n.tag) {
      patchShell(o, n, ctx);
      return n.node;
    }
    if (markup(o) === markup(n)) return (n.node = o.node);
    const node = build(n);
    o.node.replaceWith(node);
    patchStats.replaced += 1;
    return node;
  }
  function patchKids(parent, ok, nk, ctx) {
    if (ok.length !== nk.length) {
      for (const o of ok) o.node.remove();
      for (const n of nk) parent.appendChild(build(n));
      patchStats.replaced += nk.length;
      return;
    }
    nk.forEach((n, i) => patchOne(ok[i], n, ctx));
  }
  // Keyed kids: matched by key, put in order with as few moves as possible. ctx.list: rows that go away fade out and
  // the rows under them glide up; new rows rise in.
  function patchKeyed(parent, ok, nk, ctx, list = false) {
    const old = new Map(ok.map((o) => [o.key, o]));
    const born = [];
    let prev = null;
    for (const n of nk) {
      const o = old.get(n.key);
      let node;
      if (o) {
        old.delete(n.key);
        node = patchOne(o, n, ctx);
      } else {
        node = build(n);
        born.push(node);
      }
      let at = prev ? prev.nextSibling : parent.firstChild;
      while (at && at.classList?.contains('leave')) at = at.nextSibling;
      if (at !== node) parent.insertBefore(node, at);
      prev = node;
    }
    for (const o of old.values()) {
      if (list) leave(o.node);
      else o.node.remove();
      patchStats.removed += 1;
    }
    if (list && ctx.animate) {
      for (const node of born) enterNode(node);
      // One new row in the middle: the rows under it glide down instead of jumping (one height read, after all writes).
      if (born.length === 1 && born[0].nextSibling) {
        const node = born[0];
        const h = node.offsetHeight || 0;
        for (let n = node.nextSibling; h && n; n = n.nextSibling) {
          if (!n.classList?.contains('leave')) n.animate?.([{ transform: `translateY(${-h}px)` }, { transform: 'none' }], { duration: SHIFT_MS, easing: EASE });
        }
      }
    }
    if (born.length || old.size) ctx.moved = true;
  }

  // A new row rises in (220 ms); will-change only while the class is on.
  function enterNode(node) {
    node.classList.add('enter');
    busy(ENTER_MS);
    setTimeout(() => node.classList.remove('enter'), ENTER_MS + 40);
  }
  // A row that went away fades out where it was, then the rows under it glide up into its place (one height read).
  function leave(node) {
    node.removeAttribute('data-key'); // out of focus restore, blinks and the next patch
    if (!motionOk()) { node.remove(); return; }
    node.inert = true;
    node.classList.add('leave');
    busy(LEAVE_MS + SHIFT_MS);
    setTimeout(() => {
      const h = node.offsetHeight || 0;
      const after = [];
      for (let n = node.nextSibling; n; n = n.nextSibling) if (!n.classList?.contains('leave')) after.push(n);
      node.remove();
      if (h && motionOk()) {
        for (const n of after) n.animate?.([{ transform: `translateY(${h}px)` }, { transform: 'none' }], { duration: SHIFT_MS, easing: EASE });
      }
      settle();
    }, LEAVE_MS);
  }

  // ---------- gauge card ----------
  const LIMIT_NAME = { five_hour: '5-hour limit', seven_day: '7-day limit' };
  const limitName = (n) => own(LIMIT_NAME, n, String(n ?? 'Limit').replace(/_/g, ' '));

  function resetText(l, now) {
    if (l.ended || !finite(l.resetsAt) || l.resetsAt <= now) return 'Resetting';
    const left = l.resetsAt - now;
    return left < DAY ? `Resets in ${dur(left)}` : `Resets ${dayTime(l.resetsAt)}`;
  }

  // The fill and the projection tail are full-width layers slid into place with translateX (the track clips them), so a
  // new value glides there by a CSS transition on transform alone: the nodes stay across refreshes (keyed patch), no
  // reflow, no width animation. The tail sits under the fill and is always there (hidden under the fill when no tail).
  function limitItem(l, now, showTarget, stale, key) {
    const pct = clamp(Math.round(finite(l.pct) ? l.pct : 0), 0, 100);
    const brakeLike = l.state === 'brake' || l.state === 'early';
    const hasTail = !l.ended && l.state !== 'unknown' && finite(l.projection) && (brakeLike || !thin(l));
    const end = brakeLike ? 100 : hasTail ? clamp(Math.round(l.projection), pct, 100) : pct;
    const tail = S('div', { class: `ahead ${brakeLike ? 'orange' : 'blue'}`, style: `transform:translateX(${end - 100}%)` }, [], 'tail');
    const fill = S('div', { class: 'fill', style: `transform:translateX(${pct - 100}%)` }, [], 'fill');
    // keyed (k18): the target mark comes and goes with the number of limits (account switch) without rebuilding the fill
    const mark = showTarget && finite(l.target)
      ? { key: 'mark', html: `<div class="mark" style="left:${clamp(l.target, 0, 100)}%" title="Target ${Math.round(l.target)}%"></div>` } : '';
    const name = limitName(l.name);
    const pace = !stale && finite(l.needle) && finite(l.projection) && !l.ended
      ? `Pace ${l.needle.toFixed(2)} pts/min · about ${Math.round(l.projection)}% at the reset` : null;
    const track = S('div', { class: 'track', role: 'meter', 'aria-label': `${name} used`, 'aria-valuemin': 0, 'aria-valuemax': 100,
      'aria-valuenow': pct, title: pace }, [tail, fill, mark], undefined, true);
    return S('div', { class: 'lim' }, [`<div class="lrow"><span class="k">${esc(name)}</span><span class="r">${esc(resetText(l, now))}</span>` +
      `<span class="p">${pct}%</span></div>`, track], key);
  }

  // Stale reading: the newest usage sample is older than STALE_READING_MS. k13 may add a per-account `fresh` flag;
  // when it is there it decides, and `lastSample` (status --json, per account) still gives the age for the text.
  const STALE_READING_MS = 10 * MIN;
  function staleReading(acct, now) {
    const at = finite(acct?.lastSample) ? acct.lastSample : null;
    const stale = typeof acct?.fresh === 'boolean' ? !acct.fresh : at !== null && now - at > STALE_READING_MS;
    if (!stale) return null;
    return at !== null && now > at ? `Last reading ${dur(now - at)} ago` : 'No recent reading';
  }

  function noteFor(acct, limits, queue, now) {
    const main = limits.find((l) => l.name === acct.limit) ?? limits[0];
    // Tasks only ever start on the owner's own account, so only that one mentions them.
    const ready = acct.own && finite(queue?.ready) ? queue.ready : 0;
    const state = (acct.state === 'cruise' || acct.state === 'gas') && limits.some(thin) ? 'unknown' : acct.state;
    switch (state) {
      case 'brake': {
        if (main && finite(main.brakeAt) && main.brakeAt > now) return ['orange', `At this pace you'll run out at ${hhmm(main.brakeAt)}`];
        return ['orange', main && finite(main.resetsAt) ? `At the limit · resets at ${hhmm(main.resetsAt)}` : 'At the limit'];
      }
      case 'early':
        return ['orange', main && finite(main.brakeAt)
          ? `Early in the window · at this pace you'd run out at ${hhmm(main.brakeAt)}` : 'Early in the window · pace is high'];
      case 'gas': {
        // Same figure as the CLI status line: 100 minus the projection at the reset.
        const left = main && finite(main.projection) ? Math.max(0, Math.round(100 - main.projection)) : null;
        const head = left === null ? 'Quota would go unused' : `About ${left}% would go unused`;
        return ['green', ready > 0 ? `${head} · ${ready} ${ready === 1 ? 'task' : 'tasks'} ready` : head];
      }
      case 'cruise': {
        const live = limits.filter((l) => finite(l.projection) && !l.ended && l.state !== 'unknown');
        if (live.length > 1) {
          const tight = live.reduce((a, b) => (b.projection / (b.target || 100) > a.projection / (a.target || 100) ? b : a));
          return ['blue', `On pace · the ${limitName(tight.name)} sets the speed`];
        }
        const l = live[0] ?? main;
        return ['blue', l && finite(l.projection) ? `On pace · about ${Math.round(l.projection)}% at the reset` : 'On pace'];
      }
      default: {
        const n = limits.reduce((m, l) => Math.max(m, finite(l.samples) ? l.samples : 0), 0);
        return ['gray', `Too little data yet · ${n} ${n === 1 ? 'sample' : 'samples'}`];
      }
    }
  }

  function msgCard(face, title, text, buttons) {
    return `<div class="card"><div class="msg">${avatar('egg', face)}<div><div class="t">${esc(title)}</div>` +
      `<div class="s">${text}</div>${buttons ? `<div class="btns">${buttons}</div>` : ''}</div></div></div>`;
  }

  const msg = (mode, ...a) => ({ key: `msg:${mode}`, html: msgCard(...a) });

  function accountLabel(a, i, accounts) {
    if (a.own) return 'Mine';
    const others = accounts.filter((x) => !x.own);
    return others.length > 1 ? `Other ${others.indexOf(a) + 1}` : 'Other';
  }

  // Returns { item, mode } where mode drives what else the panel shows.
  function gauge(status, now) {
    const err = status ? status.error : { code: 'read_failed', at: now };
    const accounts = Array.isArray(status?.accounts) ? status.accounts : [];
    if (err && err.code === 'no_claude') {
      return { mode: 'no_claude', item: msg('no_claude', 'wait', 'Claude Code not found',
        'Kadans works with the Claude Code CLI. Install it, sign in, then open this panel again.',
        '<button class="pill blue" data-do="install-help">How to install</button><button class="pill" data-do="check-again">Check again</button>') };
    }
    if (err && err.code !== 'no_data') {
      const ago = finite(err.at) ? Math.round((now - err.at) / MIN) : null;
      const when = ago === null ? '' : ago < 1 ? ' just now' : ` ${ago} min ago`;
      return { mode: 'error', item: msg('error', 'slow', "Can't read usage data",
        `kadans status failed${esc(when)}. Agents keep running; pacing is off until this works.`,
        '<button class="pill blue" data-do="retry">Try again</button><button class="pill" data-do="copy">Copy details</button>') };
    }
    if (!accounts.length) {
      return { mode: 'no_data', item: msg('no_data', 'idle', 'No data yet',
        "Kadans reads your limit after Claude's next reply. Send any message in Claude Code.") };
    }
    let acct = accounts.find((a) => a.key === view.account) ?? accounts[0];
    view.account = acct.key;
    // k18: the account control and each limit are keyed shells, so switching accounts patches the pressed button and
    // glides the fills that both accounts have, instead of replacing the card's insides.
    const seg = accounts.length > 1
      ? S('div', { class: 'acct', role: 'group', 'aria-label': 'Account' }, accounts.map((a, i) =>
        S('button', { 'aria-pressed': String(a === acct), 'data-do': 'account', 'data-id': a.key, title: a.label ?? '' },
          [esc(accountLabel(a, i, accounts))])), 'acct')
      : '';
    const limits = (Array.isArray(acct.limits) ? acct.limits : []).filter((l) => l && l.state !== 'nodata');
    const stale = staleReading(acct, now);
    // A stale reading is not advice: the note says how old it is, in the muted colour, whatever the state was.
    const [dot, note] = stale ? ['gray', stale] : noteFor(acct, limits, status.queue, now);
    const body = limits.map((l, i) => limitItem(l, now, limits.length > 1, Boolean(stale), `lim:${i}:${l.name}`));
    const noteHtml = `<div class="note${stale ? ' stale' : ''}"${body.length ? '' : ' style="margin-top:0"'}><i class="dot-${dot}"></i><span>${esc(note)}</span></div>`;
    return { mode: acct.state, gas: acct.state === 'gas' && acct.own === true, stale: Boolean(stale),
      item: S('div', { class: 'card' }, [seg, ...body, { key: 'note', html: noteHtml }], 'gauge', true) };
  }

  // ---------- agents ----------
  function agentList(agents) {
    if (Array.isArray(agents)) return agents;
    if (agents && Array.isArray(agents.agents)) return agents.agents;
    return [];
  }

  function rowState(a) {
    const mode = a.pace?.mode;
    if (a.status === 'ended') return 'ended';
    if (mode === 'paused' || mode === 'pause') return 'paused';
    if (mode === 'slow' || mode === 'slowed') return 'slowed';
    if (a.status === 'needs-you') return 'needs-you';
    if (a.status === 'idle') return 'idle';
    return 'working';
  }
  const FACE = { working: 'work', 'needs-you': 'wait', idle: 'idle', slowed: 'slow', paused: 'pause', ended: 'done' };

  function titleOf(a) {
    if (a.title) return String(a.title);
    const p = String(a.firstPrompt ?? '').replace(/\s+/g, ' ').trim();
    if (p) return p.length > 60 ? `${p.slice(0, 59).trimEnd()}…` : p;
    if (a.orca?.title) return String(a.orca.title);
    return a.project ? `Session in ${a.project}` : 'Claude Code session';
  }

  function prefixOf(st, a, now) {
    const seen = finite(a.lastSeen) ? a.lastSeen : now;
    switch (st) {
      case 'needs-you': return ['<span class="need">Needs you</span> · ', 'Needs you. '];
      case 'idle': return [`Idle ${esc(dur(now - seen))} · `, `Idle ${dur(now - seen)}. `];
      case 'slowed': return ['Slowed · ', 'Slowed. '];
      case 'paused': {
        const t = finite(a.pace?.until) ? `Paused till ${hhmm(a.pace.until)}` : 'Paused';
        return [`${t} · `, `${t}. `];
      }
      case 'ended': return [`Ended ${esc(dur(now - seen))} ago · `, `Ended ${dur(now - seen)} ago. `];
      default: return ['', ''];
    }
  }

  function btn(action, id, icon, label, { disabled = false, why = '', menu = false } = {}) {
    const tip = disabled ? why || SOON : label;
    return `<button class="rb" title="${esc(tip)}" aria-label="${esc(disabled ? `${label} (${tip})` : label)}"` +
      `${disabled ? ' aria-disabled="true"' : ` data-do="${action}" data-id="${esc(id)}"`}${menu ? ' aria-haspopup="menu"' : ''}>${icon}</button>`;
  }

  // Approved queued tasks that Start / Replace can open now (status --json `queue.startable`, else the approved part of `next`).
  function startable(queue) {
    if (Array.isArray(queue?.startable)) return queue.startable;
    return (Array.isArray(queue?.next) ? queue.next : []).filter((t) => t && t.approved === true);
  }

  const orcaOk = (a) => Boolean(a.orca?.terminal) && !a.orca?.ambiguous;
  const canStopAgent = (a) => finite(a.pid) || orcaOk(a);

  // ---------- compact (k10b) ----------
  // `context` per row comes from `agents --json` (k10a): { tokens, window, pct, advice: none|soon|now, why } or null.
  // Compact is offered only where `kadans agent compact` would act: an idle Claude session (not working, needs-you,
  // slowed, paused or ended) in a known, unambiguous Orca terminal, with advice soon or now, hints not Off, and no other
  // compact in flight. The CLI's /compact returns as soon as the text is typed, so a finished compact is read from the
  // data: the context gets smaller on a later refresh ("Compacted"). After COMPACT_WAIT_MS without that the row says so
  // for COMPACT_KEEP_MS. A refusal (the CLI exited with an error) arrives through window.kadans.result and shows its
  // reason on the row for RESULT_KEEP_MS (k12).
  const COMPACT_WAIT_MS = 90_000;
  const COMPACT_KEEP_MS = 8000;
  const RESULT_KEEP_MS = 8000;
  // A reason may be a whole sentence: up to two lines, then an ellipsis (the full text is in the title). Inline because
  // panel.css is not part of this change.
  const REASON_STYLE = 'display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;white-space:normal;overflow:hidden';
  // Off: compact.soonPct = COMPACT_OFF; `config set` stores it and compactAdvice then says none for every chat (k12).
  const COMPACT_OFF = 101;
  const TYPE_IT = 'Type /compact in that chat';
  const hintsOff = () => Number(cfgVal('compact.soonPct')) >= COMPACT_OFF;
  const adviceOf = (a) => (hintsOff() ? 'none' : a.context?.advice === 'now' || a.context?.advice === 'soon' ? a.context.advice : 'none');
  const compactInFlight = () => Boolean(view.compact && !view.compact.failedAt);
  const canCompact = (a) => rowState(a) === 'idle' && a.source === 'claude' && !String(a.id).startsWith('orca:') && orcaOk(a) &&
    adviceOf(a) !== 'none' && finite(a.context?.tokens);
  const offerCompact = (a) => canCompact(a) && !compactInFlight();
  const findAgent = (id) => agentList(view.data?.agents).find((a) => a && String(a.id) === String(id)) ?? null;

  // The compact in flight, settled against the latest data: done (context smaller, row ended or gone) clears it;
  // no change after COMPACT_WAIT_MS marks it failed, shown for COMPACT_KEEP_MS.
  function compactState() {
    const c = view.compact;
    if (!c) return null;
    const now = Date.now();
    if (!c.failedAt) {
      const a = findAgent(c.id);
      if (!a || rowState(a) === 'ended' || (finite(a.context?.tokens) && a.context.tokens < c.tokens)) {
        view.compact = null;
        if (a && rowState(a) !== 'ended') setResult(a.id, true, 'Compacted');
        return null;
      }
      if (now - c.at >= COMPACT_WAIT_MS) {
        c.failedAt = now;
        setTimeout(() => render({}), COMPACT_KEEP_MS + 50);
      }
    } else if (now - c.failedAt >= COMPACT_KEEP_MS) {
      view.compact = null;
      return null;
    }
    return c;
  }

  // The result line of one row: { ok, why } for RESULT_KEEP_MS, then gone.
  function setResult(id, ok, why) {
    view.result = { id: String(id), ok, why, at: Date.now() };
    setTimeout(() => render({}), RESULT_KEEP_MS + 50);
  }
  function resultFor(id) {
    const r = view.result;
    if (!r) return null;
    if (Date.now() - r.at >= RESULT_KEEP_MS) { view.result = null; return null; }
    return String(r.id) === String(id) ? r : null;
  }
  const clearResult = (id) => { if (view.result && String(view.result.id) === String(id)) view.result = null; };

  // The host's answer to a bridge action: { action, id, ok, why }. Only a failed stop, compact or replace shows (why: the
  // first line of the CLI's message, text only); the rest is read from the next refresh, as before.
  function actionResult(r) {
    if (!r || typeof r !== 'object' || r.ok === true || !['stop', 'compact', 'replace'].includes(r.action) || r.id == null) return;
    const why = typeof r.why === 'string' ? r.why.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    if (r.action === 'compact' && view.compact && String(view.compact.id) === String(r.id)) view.compact = null;
    setResult(r.id, false, why || 'It did not work');
    render({});
  }

  function compactGo(id) {
    setConfirm(null);
    clearResult(id);
    const a = findAgent(id);
    // Checked again at the click: the chat may have started working since the confirm opened.
    if (!a || !offerCompact(a)) return;
    view.compact = { id: a.id, tokens: a.context.tokens, at: Date.now(), failedAt: null };
    send({ action: 'compact', id: a.id });
    setTimeout(() => render({}), COMPACT_WAIT_MS + 50);
  }

  function actsHtml(a, st, tasks) {
    const id = a.id;
    if (view.confirm === id) {
      const replace = view.kind === 'replace';
      const compact = view.kind === 'compact';
      const word = replace ? 'Replace' : compact ? 'Compact' : view.kind === 'close' ? 'Close' : 'Stop';
      return `<div class="acts on"><button class="sure${replace || compact ? ' go' : ''}" data-do="${replace ? 'replace-go' : compact ? 'compact-go' : 'stop'}" ` +
        `data-id="${esc(id)}">${word}</button>` +
        `<button class="pill" data-do="cancel" data-id="${esc(id)}">Cancel</button></div>`;
    }
    if (st === 'ended') return `<div class="acts">${btn('dismiss', id, IC.x, 'Dismiss')}</div>`;
    let first;
    // Only Claude sessions on this Mac carry Kadans hooks; Orca-only rows have no session id to pace.
    const canPace = a.source !== 'orca' && !String(id).startsWith('orca:');
    const noPace = "Can't pace from here";
    if (st === 'needs-you') first = btn('open', id, IC.open, 'Open in terminal');
    else if (st === 'slowed' || st === 'paused') first = btn('resume', id, IC.play, 'Resume', { disabled: !canPace, why: noPace });
    else first = btn('pace', id, IC.pace, 'Slow or pause', { disabled: !canPace, why: noPace, menu: true });
    const canStop = canStopAgent(a);
    const why = !canStop ? "Can't stop from here" : !tasks.length ? 'No approved task to start' : '';
    // An idle chat closes (same `stop` bridge action, its own confirm copy); everything else stops.
    const last = st === 'idle'
      ? btn('close', id, IC.x, 'Close chat', { disabled: !canStop, why: "Can't close from here" })
      : btn('confirm', id, IC.stop, 'Stop', { disabled: !canStop, why: "Can't stop from here" });
    const comp = offerCompact(a) ? btn('compact', id, IC.compact, 'Compact chat') : '';
    return `<div class="acts${view.picker === id || view.pacer === id ? ' on' : ''}">${first}` +
      `${btn('replace', id, IC.swap, 'Replace', { disabled: Boolean(why), why, menu: true })}${comp}${last}</div>`;
  }

  function pickerHtml(a, tasks) {
    return `<div class="pick" data-key="menu:pick:${esc(a.id)}" role="menu" aria-label="Replace with">` +
      `<div class="pick-h">Stop this agent and start</div>${tasks.map((t) =>
        `<button role="menuitem" data-do="pick" data-id="${esc(a.id)}" data-task="${esc(t.id)}" data-key="pick:${esc(a.id)}:${esc(t.id)}" title="${esc(t.text)}">` +
        `<span class="nm">${esc(t.text)}</span><span class="pv">${esc(t.project ?? '')}</span></button>`).join('')}</div>`;
  }

  // "Pace this agent" menu. resetAt: the own account's next reset, for "Pause until reset".
  function pacerHtml(a, resetAt, slowS) {
    const item = (mode, until, name, hint) =>
      `<button role="menuitem" data-do="pace-set" data-id="${esc(a.id)}" data-mode="${mode}"${until ? ` data-until="${until}"` : ''} ` +
      `data-key="pace:${esc(a.id)}:${mode}:${until ?? ''}"><span class="nm">${esc(name)}</span><span class="pv">${esc(hint)}</span></button>`;
    return `<div class="pick" data-key="menu:pace:${esc(a.id)}" role="menu" aria-label="Pace this agent"><div class="pick-h">Pace this agent</div>` +
      item('slow', null, 'Slow down', `Waits ${slowS} s before each tool call`) +
      item('pause', 'reset', 'Pause until reset', finite(resetAt) ? `Holds before its next tool · ${hhmm(resetAt)}` : 'Holds before its next tool') +
      item('pause', '30m', 'Pause for 30 min', 'Then it carries on') + '</div>';
  }

  function ownReset(status) {
    const accts = Array.isArray(status?.accounts) ? status.accounts : [];
    const own = accts.find((x) => x && x.own) ?? null;
    const r = (own?.limits ?? []).map((l) => l?.resetsAt).filter(finite);
    return r.length ? Math.min(...r) : null;
  }

  // Agent rows as keyed items for the list: a row is a shell (blob, text, actions) so a changed meta line replaces only
  // its text and the row node itself (hover, focus) stays.
  function agentRows(list, now, tasks) {
    const items = [];
    for (const a of list) {
      const st = rowState(a);
      const title = titleOf(a);
      let [pre, preText] = prefixOf(st, a, now);
      const swap = view.confirm === a.id && view.kind === 'replace' ? tasks.find((t) => String(t.id) === String(view.task)) : null;
      if (swap) [pre, preText] = [`Replace with: ${esc(swap.text)}`, `Replace with: ${swap.text}. `];
      const ask = view.confirm === a.id && view.kind === 'close';
      if (ask) [pre, preText] = ['<span class="ask">Close this chat?</span>', 'Close this chat? '];
      const why = String(a.context?.why ?? '');
      const askC = view.confirm === a.id && view.kind === 'compact';
      // Compact / Cancel leave too little room on the row for the question and its reason: both go on a line under
      // the row (see .cwhy); the row keeps its meta line, without the tag.
      if (askC) preText = `Compact this chat? ${why}. ${preText}`;
      const cs = !askC && view.compact && String(view.compact.id) === String(a.id) ? view.compact : null;
      if (cs && !cs.failedAt) [pre, preText] = ['Compacting… · ', 'Compacting. '];
      const rs = !askC && !ask && !swap ? resultFor(a.id) : null;
      if (rs?.ok) [pre, preText] = ['Compacted · ', 'Compacted. '];
      if (cs?.failedAt) {
        const note = 'Kadans saw no smaller context within 90 s. If it did not compact, type /compact in that chat.';
        [pre, preText] = [`<span class="warn" title="${esc(note)}">Compact not confirmed</span> · `, `Compact not confirmed: ${note} `];
      }
      // The number is the current context ("124k context"); the lifetime sum moves to the tooltip. 'now' adds a quiet tag.
      const ctx = finite(a.context?.tokens) ? `${tokens(a.context.tokens)} context` : null;
      const quiet = swap || ask || (rs && !rs.ok);
      const tagOn = ctx && !cs && !quiet && !askC && adviceOf(a) === 'now';
      const tagTip = tagOn ? `${why || 'Big context'}${canCompact(a) ? '' : `. ${TYPE_IT}`}` : '';
      // The tag and its number lead the meta line (like "Needs you"), so a long line never cuts them off.
      const tag = tagOn ? `<span class="tag" title="${esc(tagTip)}">Compact?</span> ${esc(ctx)} · ` : '';
      const parts = [a.project, st === 'ended' ? null : family(a.model), tagOn ? null : ctx,
        st === 'ended' || !finite(a.startedAt) ? null : dur(now - a.startedAt)].filter(Boolean).map(String);
      let line = quiet ? '' : parts.join(' · ');
      // A refused action: its reason is the whole meta line (the full text in the title), reusing the .warn line.
      if (rs && !rs.ok) [pre, preText, line] = [`<span class="warn" title="${esc(rs.why)}" style="${REASON_STYLE}">${esc(rs.why)}</span>`, `${rs.why}. `, ''];
      const life = tokens(a.tokens);
      const tip = life ? `${title}\n${life} tokens since start, cache reads not counted` : title;
      const cls = `row${st === 'ended' ? ' ended' : ''}${view.confirm === a.id || view.picker === a.id || view.pacer === a.id ? ' hov' : ''}`;
      const key = `row:${a.id}`;
      items.push(S('div', { class: cls, tabindex: 0, 'data-key': key, title: tip,
        'aria-label': `${title}. ${tagOn ? `Compact? ${tagTip}. ${ctx}. ` : ''}${preText}${line}` }, [blob(shapeFor(a.id), FACE[st], 30, MOVE[st] ?? null, a.id),
        `<div class="tx"><div class="nm">${esc(title)}</div><div class="pv">${tag}${pre}${esc(line)}</div></div>`, actsHtml(a, st, tasks)], key));
      if (askC) {
        items.push({ key: `why:${a.id}`, html: `<div class="cwhy" data-key="why:${esc(a.id)}"><span class="ask">Compact this chat?</span>${why ? ` ${esc(why)}` : ''}</div>` });
      }
      if (view.picker === a.id) items.push({ key: `menu:pick:${a.id}`, html: pickerHtml(a, tasks) });
      if (view.pacer === a.id) {
        const st0 = view.data?.status;
        const slowS = finite(st0?.pace?.slowSeconds) ? st0.pace.slowSeconds : 20;
        items.push({ key: `menu:pace:${a.id}`, html: pacerHtml(a, ownReset(st0), slowS) });
      }
      if (st === 'ended') continue;
      for (const s of Array.isArray(a.subagents) ? a.subagents : []) {
        if (s.status !== 'running') continue;
        const name = s.description || s.type || 'Subagent';
        const key = `sub:${s.id}`;
        items.push(S('div', { class: 'row child', tabindex: 0, 'data-key': key, title: name, 'aria-label': `Subagent: ${name}` },
          [blob(shapeFor(s.id), 'work', 22, 'work', s.id), `<div class="tx"><div class="nm">${esc(name)}</div></div>`], key));
      }
    }
    return items;
  }

  // ---------- up next and bottom bar ----------
  const URGENCY = { urgent: 'Urgent', week: 'This week', idle: 'When idle' };
  function upNext(queue, gas) {
    const next = Array.isArray(queue?.next) ? queue.next : [];
    if (!next.length) return '';
    return '<div class="upnext"><div class="sh"><span>Up next</span></div>' + next.map((t) => {
      const u = own(URGENCY, t.urgency, URGENCY.week);
      const line = [t.project ? esc(t.project) : null, t.urgency === 'urgent' ? `<span class="urgent">${u}</span>` : u].filter(Boolean).join(' · ');
      const ok = t.approved ? '' : ' · needs your OK';
      const b = t.approved
        ? `<button class="pill${gas ? ' blue' : ''}" data-do="start" data-id="${esc(t.id)}">Start</button>`
        : `<button class="pill${gas ? '' : ' blue'}" data-do="approve" data-id="${esc(t.id)}">Approve</button>`;
      return `<div class="row" title="${esc(t.text)}"><div class="tx"><div class="nm">${esc(t.text)}</div><div class="pv">${line}${ok}</div></div>${b}</div>`;
    }).join('') + '</div>';
  }

  function bottom(status, mode) {
    const live = typeof status?.autopace === 'boolean';
    const on = live && status.autopace && mode !== 'no_claude';
    // Shells down to the switch, so a flip keeps its node and the knob slides.
    const sw = live
      ? S('button', { class: 'sw', role: 'switch', 'aria-checked': on, 'aria-label': 'Auto-pace', 'data-do': 'autopace' })
      : S('button', { class: 'sw', role: 'switch', 'aria-checked': false, 'aria-disabled': true, 'aria-label': `Auto-pace (${SOON})`, title: SOON });
    return S('div', { class: 'bottom' }, [S('div', { class: 'toggle' }, [sw, '<span aria-hidden="true">Auto-pace</span>']),
      '<div class="sp">' +
      `<button class="ic" title="Theme" aria-label="Theme" data-do="theme">${IC.theme}</button>` +
      `<button class="ic" title="Settings" aria-label="Settings" data-do="settings">${IC.gear}</button></div>`], 'bottom');
  }

  // ---------- settings and hook setup (k4c) ----------
  // view.screen: 'main' | 'settings' | 'review'. Config comes from `kadans config get --json` (data.config), hooks from
  // `kadans install --json` (data.install). Controls send {action: 'config-set', key, value} with value as a string;
  // the CLI validates. Until the next config arrives (or 8 s pass) the control shows what was picked (view.pending).
  const PENDING_MS = 8000;
  const LIMIT_OPTS = [['auto', 'Auto'], ['five_hour', '5 h'], ['five_hour,seven_day', '5 h + 7 d']];
  const HOOK_TITLE = {
    statusline: 'Status line',
    'hook pretool': 'Check before new subagents',
    'hook stop': 'Check when a reply ends',
    'hook event': 'Session events',
    'hook pace-pre': 'Before each tool call',
    'hook pace-post': 'After each tool call',
  };
  // Plain copy per hook kind (onboarding.html); the CLI summary is the fallback for a kind the page does not know.
  const HOOK_DESC = {
    statusline: 'Reads your usage, then runs your current status line, so anything that relies on it still gets it.',
    'hook pretool': 'Holds Agent and Workflow calls only while braking.',
    'hook stop': 'Can start an approved task. Does nothing until you turn on “Use spare quota”.',
    'hook event': 'Notes when sessions start, wait and end, for the agent list.',
    'hook pace-pre': 'Waits or holds only an agent you slowed or paused.',
    'hook pace-post': 'With Auto-pace on, adds a short “usage is running hot” note at most every 10 min.',
  };
  const IC_BACK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>';

  function cfgRaw(cfg, key) {
    if (!cfg || typeof cfg !== 'object') return undefined;
    if (key === 'limits') return Array.isArray(cfg.limits) ? cfg.limits.join(',') : cfg.limits;
    const gas = key.match(/^accounts\.([0-9a-f]{12})\.gas$/);
    if (gas) return cfg.accounts?.[gas[1]]?.gas === true;
    return key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), cfg);
  }
  // The value a control shows: a pending pick first, then the config.
  function cfgVal(key) {
    const p = view.pending[key];
    if (p && Date.now() - p.at < PENDING_MS) return p.value;
    const v = cfgRaw(view.data?.config, key);
    return v === undefined ? undefined : String(v);
  }
  // delay > 0 (sliders): arrow keys fire change on every step; only the last value within the delay is sent, so the
  // separate CLI runs cannot land out of order.
  const timers = {};
  function setValue(key, value, delay = 0) {
    view.pending[key] = { value: String(value), at: Date.now() + delay };
    clearTimeout(timers[key]);
    const go = () => send({ action: 'config-set', key, value: String(value) });
    if (delay > 0) timers[key] = setTimeout(go, delay);
    else go();
  }
  // A config payload settles every pending pick it confirms; refused picks fall back after PENDING_MS.
  function settlePending(cfg) {
    for (const [k, p] of Object.entries(view.pending)) {
      if (String(cfgRaw(cfg, k)) === p.value || Date.now() - p.at >= PENDING_MS) delete view.pending[k];
    }
  }

  // k18: Settings and Review are item trees patched in place like the main panel (k14): a switch, a segment or a slider
  // keeps its node, so a flipped switch's knob slides and nothing else on the screen is rebuilt. Every kid of a keyed
  // shell needs its own key.
  const sItem = (key, title, desc, ctl, cls = '') =>
    S('div', { class: `it${cls}` }, [`<div class="tx"><div>${title}</div>${desc ? `<div class="d">${desc}</div>` : ''}</div>`, ctl ?? ''], key);
  // disabled: shown off, with no action. With a key it keeps its data-key (k25), so an enable / disable flip patches the
  // same node instead of replacing it.
  function sSwitch(key, label, disabled) {
    const on = cfgVal(key) === 'true';
    return disabled
      ? S('button', { class: 'sw', role: 'switch', 'aria-checked': 'false', 'aria-disabled': 'true', 'aria-label': `${label} (not available)`,
        ...(key ? { 'data-key': `set:${key}` } : {}) })
      : S('button', { class: 'sw', role: 'switch', 'aria-checked': String(on), 'aria-label': label, 'data-do': 'set', 'data-k': key,
        'data-v': String(!on), 'data-key': `set:${key}` });
  }
  const segBtn = (key, v, t, on) =>
    S('button', { 'aria-pressed': String(on), 'data-do': 'set', 'data-k': key, 'data-v': v, 'data-key': `set:${key}:${v}` }, [esc(t)]);
  function sSeg(key, label, opts) {
    const cur = cfgVal(key);
    return S('div', { class: 'seg', role: 'group', 'aria-label': label }, opts.map(([v, t]) => segBtn(key, v, t, cur === v)));
  }
  // A slider row: the input is a shell, so a confirmed value is patched onto the node the owner just moved (patchShell
  // also sets its .value); the number and the description are markup next to it.
  function sSlider(key, title, desc, min, max, unit) {
    const raw = Number(cfgVal(key));
    const v = Number.isFinite(raw) ? clamp(raw, min, max) : min;
    const fill = Math.round(((v - min) / (max - min)) * 1000) / 10;
    return S('div', { class: 'it col' }, [`<div class="lr"><span>${esc(title)}</span><span class="num" data-num="${esc(key)}">${v}${unit}</span></div>`,
      S('input', { type: 'range', min, max, step: 1, value: v, 'aria-label': title, 'data-set': key, style: `--p:${fill}%`, 'data-unit': unit,
        'data-key': `rng:${key}` }), desc ? `<div class="d">${desc}</div>` : ''], `rng:${key}`);
  }

  // "Suggest compact": Off / 40 % / 60 % for compact.soonPct (nowPct and idleMin stay as they are). Off is COMPACT_OFF
  // (101) and hides every hint and button.
  function compactSeg() {
    const key = 'compact.soonPct';
    const cur = Number(cfgVal(key));
    return S('div', { class: 'seg', role: 'group', 'aria-label': 'Suggest compact' }, [segBtn(key, String(COMPACT_OFF), 'Off', cur >= COMPACT_OFF),
      segBtn(key, '40', '40 %', cur === 40), segBtn(key, '60', '60 %', cur === 60)]);
  }

  // Whole-hour slider for an "HH:MM" setting (kickoff.from / kickoff.to); sends "HH:00".
  const hh = (n) => `${String(n).padStart(2, '0')}:00`;
  function sHour(key, title) {
    const cur = String(cfgVal(key) ?? '');
    const m = cur.match(/^([01]\d|2[0-3]):[0-5]\d$/);
    const v = m ? Number(m[1]) : 0;
    const fill = Math.round((v / 23) * 1000) / 10;
    return S('div', { class: 'it col' }, [`<div class="lr"><span>${esc(title)}</span><span class="num" data-num="${esc(key)}">${esc(m ? cur : '–')}</span></div>`,
      S('input', { type: 'range', min: 0, max: 23, step: 1, value: v, 'aria-label': title, 'aria-valuetext': m ? cur : hh(v), 'data-set': key,
        'data-fmt': 'hour', style: `--p:${fill}%`, 'data-key': `rng:${key}` })], `rng:${key}`);
  }
  const sliderText = (r) => (r.dataset.fmt === 'hour' ? hh(r.value) : `${r.value}${r.dataset.unit ?? ''}`);
  const sliderValue = (r) => (r.dataset.fmt === 'hour' ? hh(r.value) : String(r.value));

  // k18: "Read usage from Claude" (config usageApi, k13). The muted line is one of a few fixed strings built from times
  // and the error code in status --json usageApi; no error text from the CLI ever reaches the page.
  const USAGE_EVERY = 'Every 2 min';
  function usageLine(on, ua, now) {
    if (!on) return 'Off · updates only when Claude replies';
    const err = typeof ua?.lastError === 'string' && ua.lastError ? ua.lastError : null;
    if (err === 'no_token') return 'Needs a Claude Code login';
    if (err) return finite(ua.nextAt) && ua.nextAt > now ? `Couldn't read · trying again at ${hhmm(ua.nextAt)}` : "Couldn't read · trying again soon";
    if (!finite(ua?.lastOk)) return `${USAGE_EVERY} · not read yet`;
    const age = now - ua.lastOk;
    return age < MIN ? `${USAGE_EVERY} · last read just now` : `${USAGE_EVERY} · last read ${dur(age)} ago`;
  }
  function usageItem(d) {
    const ua = d.status?.usageApi && typeof d.status.usageApi === 'object' ? d.status.usageApi : null;
    if (cfgVal('usageApi') === undefined && !ua) return null; // an older CLI: no such setting
    const now = finite(d.status?.now) ? d.status.now : Date.now();
    const on = cfgVal('usageApi') !== undefined ? cfgVal('usageApi') === 'true' : ua?.enabled === true;
    const sw = sSwitch('usageApi', 'Read usage from Claude');
    if (cfgVal('usageApi') === undefined) Object.assign(sw.attrs, { 'aria-checked': String(on), 'data-v': String(!on) });
    return sItem('usage', 'Read usage from Claude', esc(usageLine(on, ua, now)), sw);
  }

  // k25: "Use spare quota on its own" (config autoGas, autoGasMax; the app runs `gas tick` every 5 min while it is on).
  // Only under the own account's gas switch, and off (with the reason) while that switch is off. The 1 / 2 / 3 segment
  // shows only while it is on. Hidden for an older CLI whose config has no autoGas.
  const AUTOGAS_WHAT = 'Starts your next approved task when a window would end unused';
  function autoGasLine(gasOn, on, max) {
    if (!gasOn) return 'Off while “Use spare quota” is off';
    // no-break spaces keep the tail on one line (no lone "time" on the last line)
    return on ? `${AUTOGAS_WHAT} · max\u00a0${max}\u00a0at\u00a0a\u00a0time` : `${AUTOGAS_WHAT} · off until you turn it on`;
  }
  function autoGasItems(ownKey) {
    if (cfgVal('autoGas') === undefined) return [];
    const gasOn = cfgVal(`accounts.${ownKey}.gas`) === 'true';
    const on = gasOn && cfgVal('autoGas') === 'true';
    const raw = Number(cfgVal('autoGasMax'));
    const max = Number.isInteger(raw) && raw >= 1 && raw <= 3 ? raw : 1;
    const items = [sItem('autogas', 'Use spare quota on its own', esc(autoGasLine(gasOn, on, max)),
      sSwitch('autoGas', 'Use spare quota on its own', !gasOn))];
    if (on) {
      items.push(sItem('autogas-max', 'Tasks at a time', '',
        S('div', { class: 'seg', role: 'group', 'aria-label': 'Tasks at a time' }, ['1', '2', '3'].map((v) => segBtn('autoGasMax', v, v, String(max) === v)))));
    }
    return items;
  }

  // Hook changes grouped by hook kind (the event hook alone covers seven events).
  function hookGroups(install) {
    const groups = new Map();
    for (const c of Array.isArray(install?.changes) ? install.changes : []) {
      if (!c || typeof c !== 'object') continue;
      const k = `${c.kind}|${c.hook ?? c.event}`;
      if (!groups.has(k)) groups.set(k, { kind: c.kind, hook: c.hook, summary: c.summary, events: [] });
      groups.get(k).events.push(c.event);
    }
    return [...groups.values()];
  }
  const hooksNeeded = (install) => (install && install.changed === true ? hookGroups(install).length : 0);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function hookCard(install) {
    const n = hooksNeeded(install);
    if (!n) return '';
    return `<div class="card hk"><div class="msg">${avatar('flower', 'wait', 26)}<div><div class="t">${plural(n, 'hook', 'hooks')} to add or update</div>` +
      '<div class="s">Nothing changes in Claude Code until you apply.</div></div>' +
      '<button class="pill blue" data-do="review" data-key="review">Review</button></div></div>';
  }

  function topBar(title) {
    return `<div class="top"><button class="ic" data-do="back" data-key="back" aria-label="Back" title="Back">${IC_BACK}</button>` +
      `<span class="ttl">${esc(title)}</span></div>`;
  }

  const topItem = (title) => ({ key: 'top', html: topBar(title) });
  // A group: its label and its card, both keyed; items that come and go (kickoff hours, the uninstall command) rise in
  // and fade out like rows.
  function sGroup(id, label, items) {
    const g = S('div', { class: 'sgrp' }, items, `g:${id}`, true);
    g.fade = true;
    return [{ key: `gl:${id}`, html: `<div class="gl">${esc(label)}</div>` }, g];
  }
  const screenShell = (screen, cls, label, kids) =>
    S('div', { class: `panel screen${cls}`, role: 'dialog', 'aria-label': label }, kids, `screen:${screen}`, true);

  function settingsTree() {
    const d = view.data ?? {};
    const cfg = d.config && typeof d.config === 'object' ? d.config : null;
    if (!cfg) {
      return screenShell('settings', ' tall', 'Kadans settings', [topItem('Settings'), { key: 'loading', html: '<div class="sbody"><div class="card"><div class="msg"><div><div class="t">Loading settings…</div>' +
        '<div class="s">If this stays, <span class="code">kadans config get</span> is failing.</div></div></div></div></div>' }]);
    }
    const accounts = Array.isArray(d.status?.accounts) ? d.status.accounts : [];
    const own = accounts.find((a) => a?.own);
    const names = (own?.limits ?? []).map((l) => l?.name);
    const today = names.includes('five_hour') && names.includes('seven_day') ? ' Today: 5‑hour and 7‑day.'
      : names.includes('five_hour') ? ' Today: 5‑hour only.' : names.includes('seven_day') ? ' Today: 7‑day only.' : '';
    const m = cfgVal('warmup.minutes');
    const p = cfgVal('warmup.pct');
    const ownKey = /^[0-9a-f]{12}$/.test(String(cfg.own ?? '')) ? cfg.own : null;
    const others = accounts.filter((a) => a && !a.own);
    const inst = d.install && typeof d.install === 'object' ? d.install : null;
    const n = hooksNeeded(inst);
    const cmd = typeof inst?.command === 'string' && inst.command ? inst.command : 'node bin/kadans.mjs';
    const body = [];

    body.push(...sGroup('limits', 'Limits', [
      usageItem(d),
      sItem('windows', 'Windows to watch', '', sSeg('limits', 'Windows to watch', LIMIT_OPTS)),
      { key: 'windows-sub', html: `<div class="d sub">Auto uses what Claude Code reports.${today}</div>` },
      sSlider('targets.five_hour', '5-hour target', 'Aim to end the window this full.', 50, 100, '%'),
      sSlider('targets.seven_day', '7-day target', '', 50, 100, '%'),
      sSlider('slack', 'Spare margin', 'Spare quota counts only when the projection is this far below target.', 0, 30, ' pts'),
      sSlider('warmup.minutes', 'Warm-up time', '', 0, 60, ' min'),
      sSlider('warmup.pct', 'Warm-up usage', `No brake before ${esc(m ?? '?')} min into a window or ${esc(p ?? '?')}% used.`, 0, 50, '%'),
    ].filter(Boolean)));

    body.push(...sGroup('autopace', 'Auto-pace', [
      sItem('autopace', 'Auto-pace', 'Nudges agents when usage runs hot and slows them if the brake holds 10 min. Same as the switch in the panel.',
        sSwitch('autopace', 'Auto-pace')),
      sItem('compact', 'Suggest compact', 'Marks idle chats that re-read a big context every turn.', compactSeg()),
    ]));

    const ko = cfg.kickoff && typeof cfg.kickoff === 'object' ? cfg.kickoff : null;
    if (ko) {
      const koOn = cfgVal('kickoff.enabled') === 'true';
      const items = [sItem('kickoff', 'Start the next window for me', 'When your 5-hour window has ended, Kadans sends Claude one tiny Haiku message, so the next ' +
        'window starts right away. Your own account only; uses a little quota. Off until you turn it on.',
      sSwitch('kickoff.enabled', 'Start the next window for me'))];
      if (koOn) {
        items.push(sHour('kickoff.from', 'Allowed from'), sHour('kickoff.to', 'Allowed until'), { key: 'kickoff-cmd',
          html: '<div class="it col un"><div class="d">Kadans does not set up background jobs itself. Run this once in a terminal; it adds a ' +
          'macOS job that checks every 15 minutes:</div>' +
          `<pre class="cmd" tabindex="0" aria-label="Command to run">${esc(cmd)} kickoff schedule --apply</pre>` +
          `<div class="d">Without <span class="code">--apply</span> it only shows the job. To remove it: <span class="code">kickoff unschedule --apply</span>.</div></div>` });
      }
      body.push(...sGroup('kickoff', 'Next window', items));
    }

    body.push(...sGroup('accounts', 'Accounts', [
      ownKey
        ? sItem('gas', 'Use spare quota', 'Your account (<span class="code">~/.claude</span>). Starts approved tasks when quota would go unused. Off until you turn it on.',
          sSwitch(`accounts.${ownKey}.gas`, 'Use spare quota on your account'))
        : null,
      ...(ownKey ? autoGasItems(ownKey) : []),
      ...others.map((a, i) => sItem(`gas-other:${i}`, `Use spare quota · ${others.length > 1 ? `Other ${i + 1}` : 'Other account'}`,
        '<span class="warn">Not available: Kadans never spends quota on an account that is not yours. Brake and pacing still work.</span>',
        sSwitch('', 'Use spare quota on another account', true))),
    ].filter(Boolean)));

    body.push(...sGroup('notify', 'Notifications', [
      sItem('notify', 'Allow notifications', "When you'd run out early, and when Kadans starts or finishes a task. Off by default.",
        sSwitch('notify', 'Allow notifications')),
    ]));

    body.push(...sGroup('general', 'General', [
      sItem('lang', 'Status line language', 'The line under Claude Code’s prompt.', sSeg('lang', 'Status line language', [['en', 'English'], ['tr', 'Türkçe']])),
    ]));

    const cc = [
      sItem('hooks', 'Hooks in Claude Code', inst ? (n ? `${plural(n, 'hook', 'hooks')} to add or update.` : 'Status line and hooks are installed.') : 'Not checked yet.',
        n ? '<button class="pill blue" data-do="review" data-key="review">Review</button>' : inst ? '<span class="chip ok">Installed</span>' : ''),
      sItem('uninstall', 'Remove from Claude Code', 'Takes out only Kadans hooks and restores your old status line.',
        S('button', { class: 'pill danger', 'data-do': 'uninstall', 'data-key': 'uninstall', 'aria-expanded': String(view.uninstallOpen) }, ['Uninstall…'])),
    ];
    if (view.uninstallOpen) {
      cc.push({ key: 'uninstall-cmd', html: '<div class="it col un"><div class="d">Kadans does not remove itself from here. Run this in a terminal; it saves a backup of ' +
        'settings.json first, then takes out the status line and hooks and puts your old status line back:</div>' +
        `<pre class="cmd" tabindex="0" aria-label="Command to run">${esc(cmd)} uninstall --apply</pre>` +
        `<div class="d">Without <span class="code">--apply</span> it only shows the change.</div></div>` });
    }
    body.push(...sGroup('cc', 'Claude Code', cc));
    return screenShell('settings', ' tall', 'Kadans settings', [topItem('Settings'), S('div', { class: 'sbody', id: 'k-sbody' }, body, 'body', true)]);
  }

  // Review: patched at block level (title bar, body, foot), so the confirm in the foot never rebuilds the list above it.
  function reviewTree() {
    const inst = view.data?.install && typeof view.data.install === 'object' ? view.data.install : null;
    const groups = inst?.changed ? hookGroups(inst) : [];
    const fresh = groups.some((g) => g.hook === 'statusline' && g.kind === 'add');
    const kids = [topItem(fresh ? 'Connect to Claude Code' : 'Update hooks')];
    const done = (b, f) => screenShell('review', '', 'Hooks in Claude Code', [...kids, { key: 'body', html: `<div class="sbody" id="k-sbody">${b}</div>` },
      f ? { key: 'foot', html: f } : '']);
    if (!inst) {
      return done('<div class="card"><div class="msg"><div><div class="t">Checking Claude Code settings…</div>' +
        '<div class="s">If this stays, <span class="code">kadans install</span> is failing (for example a broken settings.json).</div></div></div></div>');
    }
    if (!groups.length) {
      const msg = view.applied ? 'Applied; a backup of settings.json was saved first.' : 'Nothing to change.';
      return done(`<div class="card"><div class="msg">${avatar('square', 'done', 26)}<div><div class="t">Hooks are up to date</div>` +
        `<div class="s">${msg} Claude Code picks the hooks up in new sessions.</div></div></div></div>`,
      '<div class="foot"><button class="pill blue" data-do="back" data-key="done">Done</button></div>');
    }
    const b = `<p class="lead">Kadans adds ${groups.length === 1 ? 'this' : 'these'} to <span class="code">${esc(tildeFile(inst.file))}</span>. Here is everything that changes.</p>` +
      '<div class="chg">' + groups.map((g) => {
        const ev = g.events.length > 1 ? `<div class="ev">${esc(g.events.join(', '))}</div>` : '';
        return `<div class="r"><span class="k ${g.kind === 'add' ? 'add' : 'del'}" aria-hidden="true">${g.kind === 'add' ? '+' : '−'}</span>` +
          `<div class="tx"><div>${esc(own(HOOK_TITLE, g.hook, g.hook ?? g.events[0]))}</div><div class="d">${esc(own(HOOK_DESC, g.hook, g.summary ?? ''))}</div>${ev}</div></div>`;
      }).join('') +
      '<div class="r"><span class="k keep" aria-hidden="true">=</span><div class="tx"><div>Everything else stays</div>' +
      '<div class="d">Orca’s hooks and your other settings are untouched. A backup is saved first.</div></div></div></div>';
    let f;
    if (view.applying) f = '<div class="foot"><span class="l">Applying…</span></div>';
    else if (view.applyConfirm) {
      f = '<div class="foot"><span class="l">Write settings.json now?</span>' +
        '<button class="pill" data-do="apply-cancel" data-key="apply-cancel">Cancel</button>' +
        '<button class="pill blue" data-do="apply-go" data-key="apply-go">Apply</button></div>';
    } else {
      f = `<div class="foot"><span class="l">${view.applyFailed ? '<span class="warn">Not applied. Run kadans install in a terminal to see why.</span>' : 'Undo any time in Settings'}</span>` +
        '<button class="pill blue" data-do="apply" data-key="apply">Apply</button></div>';
    }
    return done(b, f);
  }

  // Shows ~/… instead of the home folder (the page only knows the path from install --json).
  function tildeFile(f) {
    const s = String(f ?? 'settings.json');
    const mm = s.match(/^\/Users\/[^/]+\/(.*)$/);
    return mm ? `~/${mm[1]}` : s;
  }

  // ---------- render ----------
  function root() {
    let el = document.getElementById('kadans');
    if (!el) {
      el = document.createElement('div');
      el.id = 'kadans';
      document.body.appendChild(el);
    }
    return el;
  }

  // A payload may carry only some of status, agents, config, install (Settings and Review get config / install
  // alone); the keys it leaves out keep their last value. `status: null` still means "can't read usage data".
  function render(data) {
    const d = data && typeof data === 'object' ? data : {};
    const next = { ...(view.data ?? {}) };
    for (const k of ['status', 'agents', 'config', 'install']) if (k in d) next[k] = d[k];
    view.data = next;
    if ('config' in d) settlePending(d.config);
    if ('install' in d && view.applying) {
      view.applying = false;
      view.applyFailed = hooksNeeded(d.install) > 0;
      view.applied = !view.applyFailed;
    }
    if (view.screen !== 'main') return renderScreen();
    view.stree = null;
    const status = view.data.status ?? null;
    const now = finite(status?.now) ? status.now : Date.now();
    const g = gauge(status, now);
    const { all, old, live } = split(now);
    const tasks = startable(status?.queue);
    if (view.confirm && !all.some((a) => a.id === view.confirm)) view.confirm = null;
    if (view.confirm && view.kind === 'replace' && !tasks.some((t) => String(t.id) === String(view.task))) view.confirm = null;
    compactState();
    if (view.confirm && view.kind === 'compact' && !all.some((a) => a.id === view.confirm && offerCompact(a))) view.confirm = null;
    if (view.picker && (!all.some((a) => a.id === view.picker) || !tasks.length)) view.picker = null;
    if (view.pacer && !all.some((a) => a.id === view.pacer && ['working', 'idle'].includes(rowState(a)))) view.pacer = null;
    if (!old.length) view.closeAll = false;
    const subs = (a, rank) => (rowState(a) === 'ended' || !Array.isArray(a.subagents) ? []
      : a.subagents.filter((x) => x && x.status === 'running').map((x) => ({ id: x.id, startedAt: x.startedAt, rank })));
    shapeMap = assignShapes([...live.map((a) => ({ id: a.id, startedAt: a.startedAt, rank: 0 })), ...live.flatMap((a) => subs(a, 1)),
      ...old.map((a) => ({ id: a.id, startedAt: a.startedAt, rank: 2 })), ...old.flatMap((a) => subs(a, 3))]);

    const blocks = [];
    if (g.mode !== 'no_claude') {
      const hk = hookCard(view.data.install);
      if (hk) blocks.push({ key: 'hook', html: hk });
    }
    blocks.push(g.item);
    if (g.mode !== 'no_claude') {
      blocks.push({ key: 'sh', html: `<div class="sh"><span>Agents</span><span>${live.length || ''}</span></div>` });
      const rows = agentRows(live, now, tasks);
      if (old.length) rows.push(groupHtml(old, now), ...(view.idleOpen ? agentRows(old, now, tasks) : []));
      if (all.length) {
        const list = S('div', { class: 'list', id: 'k-list' }, rows, 'list', true);
        list.fade = true;
        blocks.push(list);
      } else {
        blocks.push(S('div', { class: 'empty' }, [blob('egg', 'idle', 30), '<div><div class="nm">No agents running</div>' +
          '<div class="s">They show up here when Claude Code starts one.</div></div>'], 'empty'));
      }
    }
    if (g.mode !== 'no_claude' && g.mode !== 'no_data' && g.mode !== 'error') {
      const up = upNext(status?.queue, g.gas);
      if (up) blocks.push({ key: 'upnext', html: up });
    }
    blocks.push(bottom(status, g.mode));
    const tree = S('div', { class: 'panel', role: 'dialog', 'aria-label': 'Kadans' }, blocks, 'panel', true);

    const el = root();
    const focusKey = keyOf(document.activeElement);
    const before = patchStats.made + patchStats.replaced + patchStats.removed + patchStats.attrs;
    const prev = view.tree;
    const ctx = { animate: motionOk(), moved: false };
    let full = false;
    if (prev?.node && prev.node.parentNode === el) patchShell(prev, tree, ctx);
    else {
      full = true;
      el.innerHTML = '';
      el.appendChild(build(tree));
      const sl = view.slide;
      if (sl?.dir === 'back' && Date.now() - sl.at < ENTER_MS) {
        tree.node.classList.add('back');
        busy(ENTER_MS);
        view.sizeNow = true; // k25: the popover shrinks with the slide-in, not after it
        setTimeout(() => tree.node.classList.remove('back'), ENTER_MS + 40);
      }
      view.slide = null;
      const list = listNode(tree);
      if (list && view.scroll) list.scrollTop = view.scroll;
    }
    view.tree = tree;
    if (view.focusPick) {
      view.focusPick = false;
      el.querySelector('.pick [data-do="pick"], .pick [data-do="pace-set"]')?.focus();
    } else if (focusKey && !el.contains(document.activeElement)) restoreFocus(el, focusKey);
    if (!view.firstAt) view.firstAt = Date.now();
    // Layout is read only when something changed: an unchanged refresh costs no style or layout work at all.
    if (full || patchStats.made + patchStats.replaced + patchStats.removed + patchStats.attrs !== before) settle();
    scheduleBlinks();
  }

  const listNode = (tree = view.tree) => tree?.kids?.find((k) => k.key === 'list')?.node ?? null;
  // After the DOM changed: the list's scroll fade and the popover height (both read layout once, together).
  function settle() {
    const list = view.screen === 'main' ? listNode() : null;
    if (list) fade(list);
    reportSize();
  }

  // all: rows the panel shows; old: idle chats quiet for 2+ hours, folded into the "N idle" group at the end; live: the rest.
  function split(now) {
    const all = agentList(view.data?.agents).filter((a) => a && a.id != null && !view.dismissed.has(a.id))
      .filter((a) => a.status !== 'ended' || !finite(a.lastSeen) || now - a.lastSeen < ENDED_KEEP_MS);
    const old = all.filter((a) => rowState(a) === 'idle' &&
      (a.stale === true || (finite(a.lastSeen) && now - a.lastSeen > STALE_MS)));
    return { all, old, live: all.filter((a) => !old.includes(a)) };
  }

  // ---------- close idle chats (k9a) ----------
  // "Close all" exists only on the 2+ hour idle group, and only for chats Kadans can stop. One confirm, then one `stop`
  // per id in list order (BULK_GAP_MS apart, so the progress shows and the CLI runs one at a time). A chat counts as
  // closed once its row is ended or gone; whatever is still there BULK_WAIT_MS after the last send "didn't close".
  const BULK_GAP_MS = 400;
  const BULK_WAIT_MS = 15_000;
  const BULK_KEEP_MS = 8000;

  function bulkState() {
    const b = view.bulk;
    if (!b) return null;
    const byId = new Map(agentList(view.data?.agents).filter((a) => a && a.id != null).map((a) => [a.id, a]));
    const closed = b.ids.filter((id) => !byId.has(id) || rowState(byId.get(id)) === 'ended').length;
    const n = b.ids.length;
    const now = Date.now();
    const done = b.sent >= n && (closed === n || now >= b.deadline);
    if (done && !b.doneAt) {
      b.doneAt = now;
      setTimeout(() => render({}), BULK_KEEP_MS + 50);
    }
    if (done && now - b.doneAt >= BULK_KEEP_MS) {
      view.bulk = null;
      return null;
    }
    return { n, closed, sent: b.sent, done };
  }

  function groupHtml(old, now) {
    const n = old.length;
    const closable = old.filter(canStopAgent).length;
    const bs = bulkState();
    let line = 'Quiet for 2+ hours';
    let right = '';
    if (view.closeAll && closable) {
      line = `<span class="ask">Close ${plural(closable, 'idle chat', 'idle chats')}?</span>`;
      right = '<div class="acts on"><button class="sure" data-do="close-all-go">Close</button>' +
        '<button class="pill" data-do="close-all-cancel">Cancel</button></div>';
    } else if (bs) {
      if (bs.sent < bs.n) line = `Closing ${bs.sent} of ${bs.n}…`;
      else if (!bs.done) line = `Closed ${bs.closed} of ${bs.n}…`;
      else if (bs.closed === bs.n) line = `Closed ${plural(bs.n, 'chat', 'chats')}`;
      else line = `Closed ${bs.closed} of ${bs.n} · <span class="warn">${bs.n - bs.closed} didn't close</span>`;
    } else if (closable) {
      right = `<button class="pill quiet" data-do="close-all" title="Close the ${plural(closable, 'chat', 'chats')} quiet for 2+ hours">Close all</button>`;
    }
    const toggle = S('button', { class: 'grp-t', 'data-do': 'idle', 'data-key': 'idle-group', 'aria-expanded': view.idleOpen }, [
      blob('egg', 'idle', 22), `<span class="tx"><span class="nm">${n} idle</span><span class="pv">${line}</span></span>`,
      view.closeAll && closable ? '' : `<span class="chev" aria-hidden="true">${IC.chev}</span>`]);
    return S('div', { class: 'row grp', 'data-key': 'grp' }, [toggle, right], 'grp');
  }

  // The chats Close all would close right now (worked out again when the owner confirms, not when the confirm opened).
  function closableIdle() {
    const status = view.data?.status ?? null;
    const now = finite(status?.now) ? status.now : Date.now();
    return split(now).old.filter(canStopAgent).map((a) => a.id);
  }

  function setCloseAll(on) {
    clearTimeout(view.closeTimer);
    view.closeAll = on;
    if (on) view.closeTimer = setTimeout(() => { view.closeAll = false; render({}); }, CONFIRM_MS);
  }

  function closeAllGo() {
    setCloseAll(false);
    const ids = closableIdle();
    if (!ids.length) return;
    const b = { ids, sent: 0, deadline: Infinity, doneAt: null };
    view.bulk = b;
    const step = () => {
      if (view.bulk !== b) return;
      send({ action: 'stop', id: ids[b.sent] });
      b.sent += 1;
      if (b.sent < ids.length) setTimeout(step, BULK_GAP_MS);
      else {
        b.deadline = Date.now() + BULK_WAIT_MS;
        setTimeout(() => render({}), BULK_WAIT_MS + 50);
      }
      render({});
    };
    step();
  }

  // ---------- motion helpers that touch the DOM ----------
  // Blobs: a small squish and blink when the pointer or focus reaches a row (once per arrival, not per re-render).
  // Web Animations, so a replay needs no forced reflow; the same keyframes as before (k-squish, k-blink).
  const SQUISH = [{ transform: 'none' }, { transform: 'scale(1.06, .92)', offset: 0.35 }, { transform: 'scale(.98, 1.02)', offset: 0.7 }, { transform: 'none' }];
  const BLINK = [{ transform: 'none' }, { transform: 'scaleY(.1)', offset: 0.3 }, { transform: 'scaleY(.1)', offset: 0.65 }, { transform: 'none' }];
  function poke(av) {
    if (!av || !motionOk() || av.closest?.('.ended') || typeof av.animate !== 'function') return;
    av.animate(SQUISH, { duration: 320, easing: EASE });
    if (/\bf-(work|wait|idle)\b/.test(av.getAttribute('class') ?? '')) av.querySelector('.fc')?.animate(BLINK, { duration: 180, easing: 'ease-in-out' });
    av.classList.add('poke'); // marker only: the timer blink skips a blob that is being poked
    setTimeout(() => av.classList.remove('poke'), 340);
  }
  let restoring = false;
  function onArrive(e) {
    if (restoring) return;
    const row = e.target?.closest?.('.row[data-key]') ?? null;
    const key = row ? row.dataset.key : null;
    const which = e.type === 'focusin' ? 'focusKey' : 'hoverKey';
    if (key === view[which]) return;
    view[which] = key;
    if (row) poke(row.querySelector('.av'));
  }

  // k18: every visible blob with open eyes blinks now and then (working, needs you, idle; subagents and the idle group's
  // egg too): each on its own random 3-9 s, never two at once (due times stay BLINK_GAP_MS apart), all from ONE timer
  // that also ends the blinks (no timer per row or per blink). Off on Settings / Review, with reduced motion and while the
  // popover is closed (kadans.visible(false) or document.hidden). The blobs come from the render tree, not the DOM.
  // The same gate sets `alive` on #kadans (outside the patched tree): the CSS loops of working / needs-you blobs run only
  // under it, so they stop with the popover closed.
  const BLINK_MS = 200;
  const BLINK_GAP_MS = 300;
  const blinks = { due: new Map(), on: new Map(), timer: null };
  function nextBlink(now, key) {
    let t = 0;
    for (let i = 0; i < 16; i++) {
      t = now + 3000 + Math.random() * 6000;
      let clash = false;
      for (const [k, d] of blinks.due) if (k !== key && Math.abs(d - t) < BLINK_GAP_MS) { clash = true; break; }
      if (!clash) break;
    }
    return t;
  }
  // [key, wrapper node] for every blinkable blob on screen: key = the nearest keyed item (row:…, sub:…, grp, empty).
  function blobNodes(it = view.tree, key = null, out = []) {
    if (!it) return out;
    const k = it.key ?? key;
    if (it.blob && BLINKABLE.has(it.blob) && it.node && k) out.push([k, it.node]);
    for (const kid of it.kids ?? []) blobNodes(kid, k, out);
    return out;
  }
  const blinkOk = () => view.screen === 'main' && !reduced() && !document.hidden && view.shown;
  function scheduleBlinks() {
    clearTimeout(blinks.timer);
    blinks.timer = null;
    const ok = blinkOk();
    root().classList.toggle('alive', ok && view.screen === 'main');
    const now = Date.now();
    if (!ok) {
      for (const node of blinks.on.keys()) node.classList.remove('blink');
      blinks.on.clear();
      return;
    }
    const nodes = blobNodes();
    const keys = new Set(nodes.map(([k]) => k));
    for (const k of [...blinks.due.keys()]) if (!keys.has(k)) blinks.due.delete(k);
    // new blobs get a time; so do times that passed while blinks were off (popover closed, Settings), one by one so the
    // spread holds: otherwise every overdue blob would blink together on the first tick after reopening
    for (const k of keys) if (!(blinks.due.get(k) > now)) blinks.due.set(k, nextBlink(now, k));
    const wake = Math.min(...blinks.due.values(), ...blinks.on.values());
    if (Number.isFinite(wake)) blinks.timer = setTimeout(blinkTick, Math.max(16, wake - now));
  }
  function blinkTick() {
    blinks.timer = null;
    const now = Date.now();
    for (const [node, end] of blinks.on) {
      if (end > now + 10) continue;
      node.classList.remove('blink');
      blinks.on.delete(node);
    }
    for (const [key, node] of blobNodes()) {
      if ((blinks.due.get(key) ?? Infinity) > now + 10) continue;
      blinks.due.set(key, nextBlink(now, key));
      if (blinks.on.has(node) || node.firstElementChild?.classList?.contains('poke')) continue; // mid-squish: skip this one
      node.classList.add('blink');
      blinks.on.set(node, now + BLINK_MS);
    }
    scheduleBlinks();
  }
  // Read-only view for tests and the dev page: is the timer armed, and each blob's next blink.
  const blinkState = () => ({ armed: blinks.timer !== null, due: Object.fromEntries(blinks.due), blinking: blinks.on.size });

  // Settings and Review (k18): built as item trees and patched like the main panel, so a flipped switch keeps its node
  // (the knob slides) and scroll, focus and running transitions stay. Built anew only when the screen changes, with the
  // push class added on that build and removed by timer (never an attribute, so a patch mid-slide cannot re-time it).
  // Never patched while a slider is held (the 5 s refresh would drop the drag).
  function renderScreen() {
    if (view.dragging) {
      view.deferred = true;
      return;
    }
    const tree = view.screen === 'review' ? reviewTree() : settingsTree();
    const el = root();
    const focusKey = keyOf(document.activeElement);
    const before = patchStats.made + patchStats.replaced + patchStats.removed + patchStats.attrs;
    const prev = view.stree;
    let full = false;
    if (prev?.node && prev.node.parentNode === el && prev.key === tree.key) patchShell(prev, tree, { animate: motionOk(), moved: false });
    else {
      full = true;
      el.innerHTML = '';
      el.appendChild(build(tree));
      view.tree = null; // the main panel is built anew when it comes back
      const sl = view.slide;
      if (sl && Date.now() - sl.at < ENTER_MS) {
        tree.node.classList.add(sl.dir);
        busy(ENTER_MS);
        if (sl.dir === 'back') view.sizeNow = true;
        setTimeout(() => tree.node.classList.remove(sl.dir), ENTER_MS + 40);
      }
      view.slide = null;
      const body = document.getElementById('k-sbody');
      if (body) body.scrollTop = view.sScroll;
    }
    view.stree = tree;
    if (focusKey && !el.contains(document.activeElement)) restoreFocus(el, focusKey);
    scheduleBlinks();
    if (full || patchStats.made + patchStats.replaced + patchStats.removed + patchStats.attrs !== before) settle();
  }

  // dir: 'in' (Settings, Review) or 'back' (the screen you return to).
  function go(screen, dir = 'in') {
    if (view.screen === 'main' && view.tree) view.scroll = listNode()?.scrollTop ?? 0;
    view.slide = motionOk() ? { dir, at: Date.now() } : null;
    view.screen = screen;
    view.sScroll = 0;
    view.applyConfirm = false;
    view.uninstallOpen = false;
    view.applyFailed = false;
    view.applied = false;
    render({});
  }

  // Focus survives the 5 s re-render: rows carry data-key, buttons are keyed by action and id.
  function keyOf(node) {
    if (!node || node === document.body || !root().contains(node)) return null;
    if (node.dataset.key) return node.dataset.key;
    if (node.dataset.do) return `${node.dataset.do}:${node.dataset.id ?? ''}`;
    return null;
  }
  function restoreFocus(el, key) {
    const [action, ...rest] = key.split(':');
    const id = rest.join(':');
    const find = (k) => [...el.querySelectorAll('[data-key],[data-do]')].find((n) => keyOf(n) === k);
    let target = find(key);
    if (!target && (action === 'confirm' || action === 'close')) target = find(`stop:${id}`); // confirm swapped in Stop + Cancel
    if (!target && action === 'compact') target = find(`compact-go:${id}`);
    if (!target && action === 'pick') target = find(`replace-go:${id.slice(0, id.lastIndexOf(':'))}`);
    if (!target && (action === 'stop' || action === 'cancel' || action === 'replace-go' || action === 'compact-go')) {
      target = find(`confirm:${id}`) ?? find(`close:${id}`) ?? find(`compact:${id}`) ?? find(`replace:${id}`) ?? find(`row:${id}`);
    }
    if (!target && action.startsWith('close-all')) target = find('close-all-go:') ?? find('close-all:') ?? find('idle-group');
    if (!target && action !== 'row') target = find(`row:${id}`);
    restoring = true;
    try { target?.focus(); } finally { restoring = false; }
  }

  function fade(list) {
    const over = list.scrollHeight > list.clientHeight + 1;
    list.classList.toggle('scroll', over);
    list.classList.toggle('end', over && list.scrollTop + list.clientHeight >= list.scrollHeight - 1);
  }

  // The popover follows the page height: it grows at once (nothing gets cut off), and shrinks only after the running
  // enter / leave / slide is over, so it never resizes under a moving row. The host coalesces what is left.
  // k25: a Back slide is the exception (view.sizeNow): the screen you return to is reported as its slide-in starts, so
  // the host's resize runs with the slide (as the Settings push already does) instead of after it.
  function reportSize() {
    clearTimeout(view.sizeTimer);
    view.sizeTimer = null;
    const now = view.sizeNow === true;
    view.sizeNow = false;
    const p = root().firstElementChild;
    const h = p ? Math.ceil(p.getBoundingClientRect().height) : 0;
    if (!h || h === view.height) return;
    const wait = view.animUntil - Date.now();
    if (h < view.height && wait > 0 && !now) {
      view.sizeTimer = setTimeout(reportSize, wait + 20);
      return;
    }
    view.height = h;
    send({ action: 'size', height: h });
  }

  // ---------- actions ----------
  function send(msg) {
    try {
      const h = window.webkit?.messageHandlers?.kadans;
      if (h) h.postMessage(msg);
      else console.log('kadans.send', JSON.stringify(msg));
    } catch (e) {
      console.log('kadans.send failed', e);
    }
  }

  function setConfirm(id, kind = 'stop', task = null) {
    clearTimeout(view.timer);
    view.confirm = id;
    view.kind = kind;
    view.task = task;
    if (id) view.timer = setTimeout(() => { view.confirm = null; render(view.data); }, CONFIRM_MS);
  }

  function toggleTheme() {
    const r = document.documentElement;
    const dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    r.dataset.theme = dark ? 'light' : 'dark';
    return r.dataset.theme;
  }

  function onClick(e) {
    const b = e.target.closest('[data-do]');
    if (!b || b.getAttribute('aria-disabled') === 'true') return;
    if (onScreenClick(b)) return;
    const id = b.dataset.id;
    const numId = id != null && /^\d+$/.test(id) ? Number(id) : id;
    switch (b.dataset.do) {
      case 'confirm': view.picker = null; view.pacer = null; setConfirm(id); break;
      case 'close': view.picker = null; view.pacer = null; setConfirm(id, 'close'); break;
      case 'compact': {
        view.picker = null;
        view.pacer = null;
        const a = findAgent(id);
        if (a && offerCompact(a)) setConfirm(a.id, 'compact');
        break;
      }
      case 'compact-go': compactGo(id); break;
      case 'close-all': setConfirm(null); setCloseAll(true); break;
      case 'close-all-cancel': setCloseAll(false); break;
      case 'close-all-go': closeAllGo(); return;
      case 'cancel': setConfirm(null); break;
      case 'stop': setConfirm(null); clearResult(id); send({ action: 'stop', id }); break;
      case 'replace':
        setConfirm(null);
        view.pacer = null;
        view.picker = view.picker === id ? null : id;
        view.focusPick = view.picker !== null;
        break;
      case 'pace':
        setConfirm(null);
        view.picker = null;
        view.pacer = view.pacer === id ? null : id;
        view.focusPick = view.pacer !== null;
        break;
      case 'pace-set': {
        view.pacer = null;
        const msg = { action: 'pace', id, mode: b.dataset.mode };
        if (b.dataset.until) msg.until = b.dataset.until;
        send(msg);
        break;
      }
      case 'resume': send({ action: 'pace', id, mode: 'none' }); return;
      case 'pick': view.picker = null; setConfirm(id, 'replace', Number(b.dataset.task)); break;
      case 'replace-go': {
        const task = view.task;
        setConfirm(null);
        if (Number.isInteger(task)) send({ action: 'replace', id, task });
        break;
      }
      case 'idle': {
        // Open: the rows rise in; collapse: they fade out (keyed patch). The chevron turns by its transition.
        view.idleOpen = !view.idleOpen;
        break;
      }
      case 'open': send({ action: 'open', id }); return;
      case 'dismiss': {
        view.dismissed.add(id);
        send({ action: 'dismiss', id });
        break; // the row fades out (keyed patch)
      }
      case 'start': case 'approve': send({ action: b.dataset.do, id: numId }); return;
      case 'account': view.account = id; send({ action: 'account', id }); break;
      case 'autopace': send({ action: 'autopace', on: b.getAttribute('aria-checked') !== 'true' }); return;
      case 'theme': send({ action: 'theme', theme: toggleTheme() }); return;
      case 'copy': {
        const err = view.data?.status?.error;
        send({ action: 'copy', text: err ? `${err.code}: ${err.message ?? ''}` : 'kadans status: no data' });
        return;
      }
      default: send({ action: b.dataset.do }); return; // settings, retry, install-help, check-again
    }
    render(view.data);
  }

  // Settings / Review buttons. Returns true when handled.
  function onScreenClick(b) {
    const back = (screen) => {
      const land = () => {
        go(screen, 'back');
        root().querySelector(screen === 'main' ? '[data-do="settings"]' : '[data-do="review"]')?.focus();
      };
      const panel = root().firstElementChild;
      if (view.leaving) return;
      if (!panel || !motionOk()) return land();
      // The screen slides back out to the right, then the one underneath comes back in.
      panel.classList.add('out');
      view.leaving = true;
      setTimeout(() => { view.leaving = false; land(); }, OUT_MS);
    };
    switch (b.dataset.do) {
      case 'settings': go('settings'); send({ action: 'settings' }); root().querySelector('[data-do="back"]')?.focus(); return true;
      case 'review':
        view.from = view.screen;
        go('review');
        send({ action: 'install-preview' });
        root().querySelector('[data-do="apply"], [data-do="back"]')?.focus();
        return true;
      case 'back': back(view.screen === 'review' ? view.from : 'main'); return true;
      case 'set': {
        const k = b.dataset.k;
        if (!k || b.dataset.v == null) return true;
        setValue(k, b.dataset.v);
        renderScreen();
        return true;
      }
      case 'uninstall': view.uninstallOpen = !view.uninstallOpen; renderScreen(); return true;
      case 'apply': view.applyConfirm = true; renderScreen(); root().querySelector('[data-do="apply-go"]')?.focus(); return true;
      case 'apply-cancel': view.applyConfirm = false; renderScreen(); root().querySelector('[data-do="apply"]')?.focus(); return true;
      case 'apply-go':
        view.applyConfirm = false;
        view.applying = true;
        view.applyFailed = false;
        renderScreen();
        send({ action: 'install-apply' });
        return true;
      default: return false;
    }
  }

  // Sliders: the number follows while dragging; one config-set when released (not one per step).
  function onInput(e) {
    const r = e.target;
    if (!r.dataset?.set) return;
    const n = root().querySelector(`[data-num="${CSS.escape(r.dataset.set)}"]`);
    if (n) n.textContent = sliderText(r);
    if (r.dataset.fmt === 'hour') r.setAttribute('aria-valuetext', sliderText(r));
    const lo = Number(r.min);
    const hi = Number(r.max);
    r.style.setProperty('--p', `${((Number(r.value) - lo) / (hi - lo)) * 100}%`);
  }
  function onChange(e) {
    const r = e.target;
    if (!r.dataset?.set) return;
    view.dragging = false;
    if (cfgVal(r.dataset.set) !== sliderValue(r)) setValue(r.dataset.set, sliderValue(r), 300);
    view.deferred = false;
    renderScreen();
  }
  function onPointer(e) {
    if (e.type === 'pointerdown') {
      if (e.target.dataset?.set) view.dragging = true;
      return;
    }
    if (!view.dragging) return;
    view.dragging = false;
    if (view.deferred) {
      view.deferred = false;
      renderScreen();
    }
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (view.screen !== 'main') {
      if (view.applyConfirm) {
        view.applyConfirm = false;
        renderScreen();
      } else if (view.uninstallOpen) {
        view.uninstallOpen = false;
        renderScreen();
      } else onScreenClick({ dataset: { do: 'back' } });
      return;
    }
    if (view.closeAll) {
      setCloseAll(false);
      render({});
      root().querySelector('[data-do="close-all"]')?.focus();
    } else if (view.pacer) {
      const id = view.pacer;
      view.pacer = null;
      render(view.data);
      root().querySelector(`[data-do="pace"][data-id="${CSS.escape(id)}"]`)?.focus();
    } else if (view.picker) {
      const id = view.picker;
      view.picker = null;
      render(view.data);
      root().querySelector(`[data-do="replace"][data-id="${CSS.escape(id)}"]`)?.focus();
    } else if (view.confirm) {
      setConfirm(null);
      render(view.data);
    } else {
      send({ action: 'close' });
    }
  }

  function init() {
    const el = root();
    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    el.addEventListener('pointerdown', onPointer);
    document.addEventListener('pointerup', onPointer);
    document.addEventListener('pointercancel', onPointer);
    el.addEventListener('scroll', (e) => { if (e.target.id === 'k-list') fade(e.target); }, true);
    document.addEventListener('keydown', onKey);
    el.addEventListener('mouseover', onArrive);
    el.addEventListener('focusin', onArrive);
    el.addEventListener('mouseleave', () => { view.hoverKey = null; });
    document.addEventListener('visibilitychange', scheduleBlinks);
  }

  // ---------- dev-only frame probe (k14) ----------
  // Off in the shipped panel: it records only when the page URL has ?debugFrames or window.kadans.debugFrames is true.
  // frames.start() begins recording requestAnimationFrame gaps; frames.stop() returns { n, p50, p95, max, long } in ms
  // (long: frames over 25 ms), or null when off.
  const probe = { t: [], last: 0, raf: 0, on: false };
  const probeOn = () => {
    try { return /[?&]debugFrames\b/.test(location.search) || window.kadans?.debugFrames === true; } catch { return false; }
  };
  const frames = {
    start() {
      if (!probeOn() || typeof requestAnimationFrame !== 'function') return false;
      cancelAnimationFrame(probe.raf);
      Object.assign(probe, { t: [], last: 0, on: true });
      const tick = (ts) => {
        if (!probe.on) return;
        if (probe.last) probe.t.push(ts - probe.last);
        probe.last = ts;
        probe.raf = requestAnimationFrame(tick);
      };
      probe.raf = requestAnimationFrame(tick);
      return true;
    },
    stop() {
      if (!probe.on) return null;
      probe.on = false;
      cancelAnimationFrame(probe.raf);
      const d = [...probe.t].sort((a, b) => a - b);
      if (!d.length) return null;
      const q = (p) => Math.round(d[Math.min(d.length - 1, Math.floor(p * d.length))] * 10) / 10;
      return { n: d.length, p50: q(0.5), p95: q(0.95), max: q(1), long: d.filter((x) => x > 25).length };
    },
  };

  // dev.html only: start a fixture from a clean slate (render keeps keys a payload leaves out).
  function reset() {
    view.data = {};
    view.pending = {};
    view.screen = 'main';
    view.stree = null;
    view.tree = null;
    view.firstAt = 0;
    view.animUntil = 0;
    view.sizeNow = false;
    view.slide = null;
    view.closeAll = false;
    view.bulk = null;
    view.idleOpen = false;
    view.compact = null;
    view.result = null;
    setConfirm(null);
  }
  // The host says when the popover opens and closes (WKWebView does not reliably report document.hidden for a closed
  // NSPopover): closed, the blink timer stops and nothing animates.
  function visible(on) {
    view.shown = on !== false;
    // Opening or closing the popover drops focus: a row focused earlier (a click, or a restore after a refresh) would
    // otherwise come back highlighted, ring and actions showing, the next time the popover opens.
    const a = document.activeElement;
    if (a && a !== document.body && typeof a.blur === 'function') a.blur();
    view.focusKey = null;
    scheduleBlinks();
  }
  window.kadans = { version: 1, render, send, result: actionResult, reset, assignShapes, frames, visible, patchStats, blinkState, staleReading };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
