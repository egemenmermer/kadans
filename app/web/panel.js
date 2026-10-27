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
    tell: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 3h9.6c.7 0 1.2.5 1.2 1.2v5.6c0 .7-.5 1.2-1.2 1.2H8.4L5.2 13.6V11h-2c-.7 0-1.2-.5-1.2-1.2V4.2C2 3.5 2.5 3 3.2 3z"/></svg>',
    pace: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 11a5 5 0 1 1 10 0"/><path d="M8 11 5.8 8"/></svg>',
    play: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 4v8l6.5-4z"/></svg>',
    swap: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 5.5h9L10 3M12.5 10.5h-9L6 13"/></svg>',
    stop: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4.5" y="4.5" width="7" height="7" rx="1.8"/></svg>',
    open: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h6v6M12 4l-7.5 7.5"/></svg>',
    x: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
    compact: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.8v4.4M5.6 4 8 6.2 10.4 4M8 14.2V9.8M5.6 12 8 9.8l2.4 2.2M3.5 8h9"/></svg>',
    chev: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 4l4 4-4 4"/></svg>',
    theme: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/></svg>',
    pen: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.6 3.2l2.2 2.2-7.3 7.3-2.9.7.7-2.9z"/></svg>',
    gear: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/></svg>',
    // k52: the inbox tray
    inbox: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 9.2 4.1 3.9c.15-.5.6-.9 1.15-.9h5.5c.55 0 1 .4 1.15.9l1.6 5.3v2.6c0 .7-.5 1.2-1.2 1.2H3.7c-.7 0-1.2-.5-1.2-1.2z"/><path d="M2.6 9.2h2.9l.9 1.5h3.2l.9-1.5h2.9"/></svg>',
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
    compact: null, result: null,
    // k27: phoneWant = a flipped Phone switch waiting for the app; pairTimer = the code countdown; tapKey = the row whose
    // actions a tap opened (touch screens have no hover).
    phoneWant: null, pairTimer: null, tapKey: null,
    // k43: sub = the Settings second screen ('advanced' | 'phone' | 'computers' | null); updWant = a flipped updates switch.
    sub: null, updWant: null,
    // k41: Settings › Computers: { open (the add form), adding (sent, waiting), removing (id), confirm (id), err (code) }.
    comp: { open: false, adding: false, removing: null, confirm: null, err: null, at: 0 },
    // k32: rename = the chat whose title is being edited { id, start }; titles = renames sent, shown until the data
    // agrees { title, prev, at }; order = the owner's new order of the live rows { ids, at }, shown until the data
    // agrees; liveIds = the live rows in the order last drawn.
    rename: null, titles: new Map(), order: null, liveIds: [], awayTitles: new Map(),
    // k49: tell = the open composer { id, title, short, machine, n (characters), why (hint key) }: never the text, which
    // lives only in the textarea; telling = a message sent and not answered yet { id, at }.
    tell: null, telling: null,
    // k52: ibx = the inbox screen (see "inbox (k52)"); repos = the last repos answer { machine, list, err }.
    ibx: null, repos: null };

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
  const limitName = (n) => {
    const days = /^window_(\d+)$/.exec(String(n ?? ''));
    if (days && Number(days[1]) % 1440 === 0) return `${Number(days[1]) / 1440}-day limit`; // Codex windows in minutes
    return own(LIMIT_NAME, n, String(n ?? 'Limit').replace(/_/g, ' '));
  };

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
    if (a.kind === 'codex') return 'Codex';
    const others = accounts.filter((x) => !x.own && x.kind !== 'codex');
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
    let acct = accounts.find((a) => a.key === view.account) ?? accounts.find((a) => a.acts !== false) ?? accounts[0];
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
    const want = view.titles.get(String(a.id)); // k32: a rename sent, shown until the data has it
    if (want?.title) return want.title;
    if (a.machine) return remoteTitle(a);
    if (a.title && !want) return String(a.title);
    const p = String(a.firstPrompt ?? '').replace(/\s+/g, ' ').trim();
    if (p) return p.length > 60 ? `${p.slice(0, 59).trimEnd()}…` : p;
    if (a.orca?.title) return String(a.orca.title);
    return a.project ? `Session in ${a.project}` : 'Claude Code session';
  }

  // k42: another computer's row: Orca's own title, else the prompt's first line (sent only by the run that got a fresh
  // answer, then kept here in page memory until the machine goes stale or offline), else the branch, else
  // "Session in <project>". The prompt title is never written anywhere (no storage, no send).
  function remoteTitle(a) {
    if (a.title && a.titleSource === 'orca') return String(a.title);
    const p = a.titleSource === 'prompt' && a.title ? String(a.title) : view.awayTitles.get(String(a.id));
    if (p) return p;
    if (a.title) return String(a.title);
    return a.project ? `Session in ${a.project}` : 'Session on another computer';
  }
  function rememberAway(away) {
    const keep = new Set();
    for (const a of away) {
      const id = String(a.id);
      if (a.machineStale === true || a.machineOffline === true) continue;
      if (a.titleSource === 'prompt' && a.title) view.awayTitles.set(id, String(a.title));
      keep.add(id);
    }
    for (const id of [...view.awayTitles.keys()]) if (!keep.has(id)) view.awayTitles.delete(id);
  }
  const AGENT_TYPE = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode', cursor: 'Cursor' };
  // k42: a remote row's meta parts, in order of need (the line drops whole parts from the end; see .pv.meta):
  // "Working 1 hr 10 min" · Claude · PowerShell · 1 sub-agent · <project>.
  function remoteMeta(st, a, now) {
    const since = finite(a.stateSince) ? a.stateSince : finite(a.lastSeen) ? a.lastSeen : null;
    const d = since === null ? '' : ` ${dur(now - since)}`;
    const word = st === 'needs-you' ? 'Needs you' : st === 'idle' ? 'Idle' : st === 'ended' ? 'Ended' : 'Working';
    const pre = st === 'needs-you' ? `<span class="need">${word}</span>${esc(d)}` : esc(`${word}${d}`);
    const type = typeof a.agentType === 'string' && a.agentType.trim()
      ? own(AGENT_TYPE, a.agentType.trim().toLowerCase(), a.agentType.trim().slice(0, 20)) : null;
    const tool = st === 'working' && typeof a.toolName === 'string' && a.toolName.trim() ? a.toolName.trim().slice(0, 40) : null;
    const n = finite(a.subagentCount) && a.subagentCount > 0 ? plural(a.subagentCount, 'sub-agent', 'sub-agents') : null;
    const segs = [['at', type], ['tl', tool], ['sc', n], ['pj', a.project]].filter(([, t]) => t).map(([c, t]) => [c, String(t)]);
    return { pre, preText: `${word}${d}. `, segs };
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
  const canCompact = (a) => (a.machine ? remoteCan(a, 'canCompact') && rowState(a) === 'idle'
    : rowState(a) === 'idle' && a.source === 'claude' && !String(a.id).startsWith('orca:') && orcaOk(a) && adviceOf(a) !== 'none' && finite(a.context?.tokens));
  // k48: another computer's agent carries its own flags (lib/remote.mjs: a terminal handle on that machine is known); none
  // while its machine is stale or offline.
  const remoteCan = (a, flag) => a[flag] === true && a.machineStale !== true && a.machineOffline !== true;
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
    if (r && typeof r === 'object' && (r.action === 'computers-add' || r.action === 'computers-remove')) return compResult(r); // k41
    if (r && typeof r === 'object' && r.action === 'agent-send' && r.id != null) return tellResult(r); // k49: fixed lines only
    if (r && typeof r === 'object' && IBX_ACTIONS.has(r.action)) return inboxResult(r); // k52: by action (ids differ per bridge)
    // k32: a refused reorder drops the local order (the rows go back to the served order); a refused rename drops the
    // name shown early and says why on the row.
    if (r && typeof r === 'object' && r.ok !== true && r.action === 'reorder') {
      view.order = null;
      render({});
      return;
    }
    // k48: another computer's chat has no context size to watch: its compact is settled by the CLI's answer.
    if (r && typeof r === 'object' && r.ok === true && r.action === 'compact' && view.compact && String(view.compact.id) === String(r.id) &&
      findAgent(r.id)?.machine) {
      view.compact = null;
      setResult(r.id, true, 'Sent /compact');
      render({});
      return;
    }
    if (!r || typeof r !== 'object' || r.ok === true || !['stop', 'compact', 'replace', 'rename'].includes(r.action) || r.id == null) return;
    if (r.action === 'rename') view.titles.delete(String(r.id));
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
    // k48: a remote row has no context size; the compact settles when the CLI answers (a refusal) or after COMPACT_WAIT_MS.
    view.compact = { id: a.id, tokens: finite(a.context?.tokens) ? a.context.tokens : null, at: Date.now(), failedAt: null };
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
    if (a.machine) return remoteActs(a, st, id); // k48: another computer's agent: close/stop and compact where its flags allow
    let first;
    // Only Claude sessions on this Mac carry Kadans hooks; Orca-only rows have no session id to pace.
    const canPace = a.source !== 'orca' && !String(id).startsWith('orca:');
    const noPace = "Can't pace from here";
    if (st === 'needs-you') first = net.mode === 'bridge' ? btn('open', id, IC.open, 'Open in terminal') : ''; // no terminal on a phone
    else if (st === 'slowed' || st === 'paused') first = btn('resume', id, IC.play, 'Resume', { disabled: !canPace, why: noPace });
    else first = btn('pace', id, IC.pace, 'Slow or pause', { disabled: !canPace, why: noPace, menu: true });
    const canStop = canStopAgent(a);
    const why = !canStop ? "Can't stop from here" : !tasks.length ? 'No approved task to start' : '';
    // An idle chat closes (same `stop` bridge action, its own confirm copy); everything else stops.
    const last = st === 'idle'
      ? btn('close', id, IC.x, 'Close chat', { disabled: !canStop, why: "Can't close from here" })
      : btn('confirm', id, IC.stop, 'Stop', { disabled: !canStop, why: "Can't stop from here" });
    const comp = offerCompact(a) ? btn('compact', id, IC.compact, 'Compact chat') : '';
    // k32: on a phone (no double-click) the row's tap actions start with Rename.
    const ren = touchUi() ? btn('rename', id, IC.pen, 'Rename') : '';
    const tell = canTell(a) ? btn('tell', id, IC.tell, 'Tell') : ''; // k49
    return `<div class="acts${view.picker === id || view.pacer === id ? ' on' : ''}">${ren}${tell}${first}` +
      `${btn('replace', id, IC.swap, 'Replace', { disabled: Boolean(why), why, menu: true })}${comp}${last}</div>`;
  }

  // k48: the actions of another computer's agent. Close (idle) or Stop when its terminal there is known, Compact for an
  // idle Claude chat, Tell (k49) for an idle or working one; never pace, replace, rename or open (this computer only).
  function remoteActs(a, st, id) {
    const stop = remoteCan(a, 'canStop');
    const last = st === 'idle'
      ? btn('close', id, IC.x, 'Close chat', { disabled: !stop, why: "Can't close from here" })
      : btn('confirm', id, IC.stop, 'Stop', { disabled: !stop, why: "Can't stop from here" });
    const comp = offerCompact(a) ? btn('compact', id, IC.compact, 'Compact chat') : '';
    const tell = canTell(a) ? btn('tell', id, IC.tell, 'Tell') : ''; // k49: when its flags allow send
    if (!stop && !comp && !tell) return '<div class="acts"></div>'; // nothing it can do there: no disabled buttons either (k38)
    return `<div class="acts">${tell}${comp}${last}</div>`;
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

  // k32: what a sub-agent spends. `context` (newest input + cache) when known, else `tokens` (lifetime); both numbers or
  // null from `agents --json` (k31). An older CLI may send context as { tokens }. Null when neither is known.
  function subUse(s) {
    const ctx = finite(s.context) ? s.context : finite(s.context?.tokens) ? s.context.tokens : null;
    const tok = finite(s.tokens) ? s.tokens : null;
    const short = tokens(ctx ?? tok);
    if (!short) return null;
    const tip = [tokens(ctx) ? `${tokens(ctx)} context` : null, tokens(tok) ? `${tokens(tok)} tokens since start` : null].filter(Boolean).join(' · ');
    return { short, tip };
  }

  // k35: { done, total, step, text, aria, frac } of an agent or sub-agent that reported progress, else null.
  function progressOf(x) {
    const p = x?.progress;
    if (!p || !finite(p.done) || !finite(p.total) || p.total < 1) return null;
    const total = Math.floor(p.total);
    const done = Math.max(0, Math.min(total, Math.floor(p.done)));
    const step = typeof p.step === 'string' && p.step.trim() ? p.step.trim().slice(0, 60) : '';
    return { done, total, step, count: `${done}/${total}`, text: `${done}/${total}${step ? ` · ${step}` : ''}`, aria: `${done} of ${total} done${step ? `: ${step}` : ''}`,
      frac: Math.round((done / total) * 1000) / 1000 };
  }
  // The thin bar under a title. Always present on a main row (hidden without progress) so the text column keeps its
  // item count and a rename field is never rebuilt; a new value only patches the transform, which then glides.
  const barItem = (pg) => S('div', { class: pg ? 'pb' : 'pb off', 'aria-hidden': 'true' }, [S('i', { style: `transform:scaleX(${pg ? pg.frac : 0})` })]);

  // Agent rows as keyed items for the list: a row is a shell (blob, text, actions) so a changed meta line replaces only
  // its text and the row node itself (hover, focus) stays.
  function agentRows(list, now, tasks) {
    const items = [];
    for (const a of list) {
      const st = rowState(a);
      const title = titleOf(a);
      const pg = st === 'ended' ? null : progressOf(a);
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
      if (rs?.ok) [pre, preText] = [`${esc(rs.why || 'Compacted')} · `, `${rs.why || 'Compacted'}. `]; // k48: 'Sent /compact' on a remote row
      const tl = !askC && !ask && !swap && !rs && view.telling && String(view.telling.id) === String(a.id); // k49: a message on its way
      if (tl) [pre, preText] = ['Sending… · ', 'Sending. '];
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
      // k32: each part sits in its own span so a narrow row shortens the project first (then model, then age) and never
      // cuts the context number ("430k co…"); see .pv.meta in panel.css.
      // k42: parts in order of need; a line too narrow drops whole parts from the end (.pv.meta wraps them out of
      // sight), never squeezes one to "t…". The state words and a time always lead: the age right after the state
      // (and progress), except on an idle row, whose lead already says how long ("Idle 7 min").
      const age = st === 'ended' || !finite(a.startedAt) ? null : dur(now - a.startedAt);
      const rm = a.machine && !quiet ? remoteMeta(st, a, now) : null;
      if (rm && !ask && !askC && !swap && !cs && !rs && !tl) [pre, preText] = [rm.pre, rm.preText]; // k48: a confirm or result wins
      const segs = rm ? rm.segs : [['du', st === 'idle' ? null : age], ['cx', tagOn ? null : ctx], ['pj', a.project],
        ['fm', st === 'ended' ? null : family(a.model)], ['du', st === 'idle' ? age : null]].filter(([, t]) => t).map(([c, t]) => [c, String(t)]);
      let line = quiet ? '' : segs.map(([, t]) => t).join(' · ');
      // A refused action: its reason is the whole meta line (the full text in the title), reusing the .warn line.
      if (rs && !rs.ok) [pre, preText, line] = [`<span class="warn" title="${esc(rs.why)}" style="${REASON_STYLE}">${esc(rs.why)}</span>`, `${rs.why}. `, ''];
      const life = tokens(a.tokens);
      const subT = tokens(a.subagentTokens);
      const tip = [title, life ? `${life} tokens since start, cache reads not counted` : null, subT ? `sub-agents: ${subT}` : null].filter(Boolean).join('\n');
      const key = `row:${a.id}`;
      const cls = `row${st === 'ended' ? ' ended' : ''}${view.confirm === a.id || view.picker === a.id || view.pacer === a.id || view.tapKey === key ? ' hov' : ''}${view.rename && String(view.rename.id) === String(a.id) ? ' renaming' : ''}`;
      const meta = quiet || (rs && !rs.ok) ? `<div class="pv">${tag}${pre}${esc(line)}</div>`
        : `<div class="pv meta">${[['tg', tag], ['ld', pre], ['pn', pg ? pg.count : ''], ['ps', pg ? esc(pg.step) : ''], ...segs.map(([c, t]) => [c, esc(t)])].map(([c, h]) => [c, h.replace(/ · $/, '')])
          .filter(([, h]) => /[^\s·.…]/.test(h.replace(/<[^>]*>/g, ''))).map(([c, h], i) => `<span class="${c}">${i ? ' · ' : ''}${h}</span>`).join('')}</div>`;
      // The name and the meta line are separate items, so the minute tick replaces only the meta line (and a rename
      // input in the name slot keeps its node, its caret and what was typed).
      items.push(S('div', { class: cls, tabindex: 0, 'data-key': key, title: tip,
        'aria-label': `${title}. ${tagOn ? `Compact? ${tagTip}. ${ctx}. ` : ''}${preText}${pg && !quiet ? `${pg.aria}. ` : ''}${line}` }, [blob(shapeFor(a.id), FACE[st], 30, MOVE[st] ?? null, a.id),
        S('div', { class: 'tx' }, [nameItem(a, title), barItem(pg), meta]), actsHtml(a, st, tasks)], key));
      if (askC) {
        items.push({ key: `why:${a.id}`, html: `<div class="cwhy" data-key="why:${esc(a.id)}"><span class="ask">Compact this chat?</span>${why ? ` ${esc(why)}` : ''}</div>` });
      }
      if (view.picker === a.id) items.push({ key: `menu:pick:${a.id}`, html: pickerHtml(a, tasks) });
      if (view.tell && String(view.tell.id) === String(a.id) && !tellSheet()) items.push(tellItem(view.tell)); // k49: inline on the Mac
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
        const n = subUse(s);
        const sp = progressOf(s);
        items.push(S('div', { class: 'row child', tabindex: 0, 'data-key': key, title: [name, sp ? sp.text : null, n ? n.tip : null].filter(Boolean).join('\n'),
          'aria-label': `Subagent: ${name}${sp ? `. ${sp.aria}` : ''}${n ? `. ${n.tip}` : ''}` }, [blob(shapeFor(s.id), 'work', 22, 'work', s.id),
          `<div class="tx sub"><div class="nm">${esc(name)}</div>${sp ? `<span class="sq">· ${sp.count}</span>${sp.step ? `<span class="sp">· ${esc(sp.step)}</span>` : ''}` : ''}${n ? `<span class="sn">· ${esc(n.short)}</span>` : ''}` +
          `${sp ? `<div class="pb" aria-hidden="true"><i style="transform:scaleX(${sp.frac})"></i></div>` : ''}</div>`], key));
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
      '<div class="sp">' + inboxButton() +
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

  // k27: Settings › Phone (Mac only). The app pushes {phone: {on, url, pair: {url, qr, expiresAt} | null, devices: [{id,
  // name, lastSeenAt}], error}}; the page sends phone-on / phone-off / phone-pair / phone-revoke. Hidden when no phone
  // payload came (an older app, and on the phone itself). A flipped switch shows its new state until the app confirms it
  // (or 8 s pass). The error is a fixed string: the app's text is never shown. The QR is drawn only from a PNG data URL.
  const PHONE_NOTE = 'On your Wi-Fi the link is not encrypted; turn on Tailscale to use it away from home or on shared Wi-Fi';
  const QR_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;
  function phoneData() {
    const p = view.data?.phone;
    return p && typeof p === 'object' ? p : null;
  }
  function phoneOn(p) {
    const w = view.phoneWant;
    if (w && Date.now() - w.at < PENDING_MS) return w.on;
    return p.on === true;
  }
  const mmss = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${pad(s % 60)}`;
  };
  const ago = (t, now) => (!finite(t) ? 'Not used yet' : now - t < MIN ? 'Used just now' : `Used ${dur(now - t)} ago`);
  function phoneItems(p) {
    const now = Date.now();
    const on = phoneOn(p);
    const sw = S('button', { class: 'sw', role: 'switch', 'aria-checked': String(on), 'aria-label': 'Use Kadans on your phone',
      'data-do': on ? 'phone-off' : 'phone-on', 'data-key': 'set:phone' });
    const items = [sItem('phone', 'Use Kadans on your phone', esc(PHONE_NOTE), sw)];
    if (!on) return items;
    if (typeof p.error === 'string' && p.error) {
      items.push({ key: 'phone-err', html: '<div class="it col un"><div class="d warn">Couldn’t start the phone link. Turn it off and on to try again.</div></div>' });
      return items;
    }
    const pair = p.pair && typeof p.pair === 'object' ? p.pair : null;
    const qrOk = pair && typeof pair.qr === 'string' && QR_RE.test(pair.qr) && finite(pair.expiresAt);
    if (qrOk && pair.expiresAt > now) {
      items.push(S('div', { class: 'it col qrb' }, [
        { key: 'qr-img', html: `<div class="qrw"><img class="qr" src="${esc(pair.qr)}" alt="Pairing code for your phone" width="160" height="160"></div>` },
        { key: 'qr-say', html: '<div class="qrt">Scan with your phone’s camera, then Add to Home Screen</div>' },
        { key: 'qr-left', html: `<div class="d qrl" role="timer">Works once · ${mmss(pair.expiresAt - now)} left</div>` },
      ], 'pairing', true));
    } else if (qrOk) {
      items.push(sItem('pair', 'This code has expired', 'Each code works once, within 10 minutes.',
        '<button class="pill blue" data-do="phone-pair" data-key="phone-pair">New code</button>'));
    } else {
      items.push(sItem('pair', 'Pair a phone', 'Shows a code to scan. It works once, within 10 minutes.',
        '<button class="pill blue" data-do="phone-pair" data-key="phone-pair">Show code</button>'));
    }
    const devs = Array.isArray(p.devices) ? p.devices.filter((x) => x && typeof x.id === 'string' && x.id) : [];
    for (const dv of devs) {
      const name = typeof dv.name === 'string' && dv.name.trim() ? dv.name.trim().slice(0, 40) : 'Phone';
      items.push(sItem(`dev:${dv.id}`, esc(name), esc(ago(dv.lastSeenAt, now)),
        `<button class="pill quiet danger" data-do="phone-revoke" data-id="${esc(dv.id)}" data-key="revoke:${esc(dv.id)}" aria-label="Revoke ${esc(name)}">Revoke</button>`));
    }
    return items;
  }
  // One 1 s timer while Settings shows a live code: each tick patches the countdown text only.
  function pairTick() {
    clearTimeout(view.pairTimer);
    view.pairTimer = null;
    const p = phoneData();
    const exp = p?.pair?.expiresAt;
    if (view.screen !== 'settings' || view.sub !== 'phone' || !p || !phoneOn(p) || !finite(exp) || exp <= Date.now() - 1000) return; // k43: Settings › Phone only
    view.pairTimer = setTimeout(() => { view.pairTimer = null; if (view.screen === 'settings') renderScreen(); }, 1000 - (Date.now() % 1000) || 1000);
  }

  // k41: Settings › Computers (Mac only, under Phone). The app pushes {computers: {list: [{id, name, status, agents}] |
  // null, error: <code> | null}}; the page sends computers-add {name, code} / computers-remove {id} and hears how each
  // ended through kadans.result. Every line shown is the page's own text (error codes map to COMP_ERR). The pairing
  // code is read from the field at the click, sent once and the field is cleared at once; it is never put in markup,
  // view state or a log. The field has no value attribute, so a refresh never writes it back.
  const COMP_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} -]{0,31}$/u;
  const COMP_CODE_RE = /^orca:\/\/pair\?[A-Za-z0-9_.~%=&+/:-]+$/;
  const COMP_ERR = {
    name: 'Use letters, digits, spaces or dashes (up to 32).',
    code: 'That is not a pairing code. Copy the whole orca://pair?… line.',
    taken: 'A computer with that name is already here.',
    add: 'Couldn’t add it. Each code works once, for a short time: make a new one.',
    noorca: 'Orca is not installed on this Mac.',
    remove: 'Couldn’t remove that computer.',
    busy: 'Still working on the last request.',
  };
  const COMP_WAIT_MS = 60_000;
  function compData() {
    const c = view.data?.computers;
    return c && typeof c === 'object' ? c : null;
  }
  // The add form's fields, found in the last drawn tree (not by selector: the nodes may be inside the old screen).
  function compField(which, it = view.stree) {
    if (!it) return null;
    if (it.field === which) return it.node ?? null;
    for (const k of it.kids ?? []) {
      const n = compField(which, k);
      if (n) return n;
    }
    return null;
  }
  function compLine(c) {
    const st = c.status;
    const n = Number.isInteger(c.agents) && c.agents >= 0 ? plural(c.agents, 'agent', 'agents') : null;
    if (st === 'online') return n ? `online · ${n}` : 'online';
    if (st === 'stale') return n ? `not live · ${n}` : 'not live';
    if (st === 'offline') return 'offline';
    return 'not checked yet';
  }
  function compItems(p) {
    const c = view.comp;
    if (c.adding && Date.now() - c.at > COMP_WAIT_MS) c.adding = false; // no answer: let the owner try again
    const items = [];
    const list = Array.isArray(p.list) ? p.list.filter((x) => x && typeof x.id === 'string' && x.id && typeof x.name === 'string') : null;
    for (const m of list ?? []) {
      const name = m.name.trim().slice(0, 40) || 'Computer';
      const id = esc(m.id);
      let ctl;
      if (c.removing === m.id) ctl = '<span class="d">Removing…</span>';
      else if (c.confirm === m.id) {
        ctl = `<span class="cfm"><button class="pill quiet" data-do="comp-keep" data-key="comp-keep:${id}">Cancel</button>` +
          `<button class="pill danger" data-do="comp-remove-go" data-id="${id}" data-key="comp-go:${id}" aria-label="Remove ${esc(name)} now">Remove</button></span>`;
      } else ctl = `<button class="pill quiet danger" data-do="comp-remove" data-id="${id}" data-key="comp-rm:${id}" aria-label="Remove ${esc(name)}">Remove</button>`;
      items.push(sItem(`comp:${m.id}`, esc(name), esc(c.confirm === m.id ? 'Unpair it from this Mac? Its agents leave the list.' : compLine(m)), ctl, m.status === 'offline' ? ' off' : ''));
    }
    if (!list) items.push({ key: 'comp-list-err', html: '<div class="it col un"><div class="d warn">Couldn’t read your computers.</div></div>' });
    const err = c.err && Object.hasOwn(COMP_ERR, c.err) ? `<div class="d warn" role="status">${esc(COMP_ERR[c.err])}</div>` : '';
    if (!c.open) {
      items.push(sItem('comp-add', 'Add a computer', list?.length ? 'See agents on another computer here too.' : 'See the agents on your other computers here.',
        '<button class="pill blue" data-do="comp-open" data-key="comp-open">Add…</button>'));
      if (err) items.push({ key: 'comp-err', html: `<div class="it col un">${err}</div>` });
      return items;
    }
    const f = S('div', { class: 'it col cform' }, [
      { key: 'comp-hint', html: '<div class="d">On the other computer run: <span class="code">npx\u00a0kadans\u00a0connect</span></div>' },
      { key: 'comp-name', field: 'name', html: '<input class="fld" type="text" data-key="comp-name" placeholder="PC" maxlength="32" aria-label="Name for this computer" spellcheck="false" autocomplete="off">' },
      { key: 'comp-code', field: 'code', html: '<input class="fld" type="password" data-key="comp-code" placeholder="Paste the code (orca://pair?…)" aria-label="Pairing code" spellcheck="false" autocomplete="off" enterkeyhint="done">' },
      err ? { key: 'comp-ferr', html: err } : '',
      { key: `comp-foot:${c.adding}`, html: c.adding
        ? '<div class="cfoot"><span class="d">Adding…</span></div>'
        : '<div class="cfoot"><button class="pill quiet" data-do="comp-close" data-key="comp-close">Cancel</button><button class="pill blue" data-do="comp-add" data-key="comp-add">Add</button></div>' },
    ], 'comp-form', true);
    items.push(f);
    return items;
  }
  function compOpen(open) {
    const c = view.comp;
    Object.assign(c, { open, err: null, confirm: null });
    renderScreen();
    if (open) try { compField('name')?.focus?.(); } catch { /* no focus in this host */ }
  }
  // Add: reads both fields, clears the code field at once (also when the page refuses it), sends one computers-add.
  function compSubmit() {
    const c = view.comp;
    if (c.adding) return;
    const nameEl = compField('name');
    const codeEl = compField('code');
    const name = String(nameEl?.value ?? '').trim() || 'PC';
    let code = String(codeEl?.value ?? '').trim();
    if (codeEl) codeEl.value = '';
    if (!COMP_NAME_RE.test(name)) c.err = 'name';
    else if (code.length > 2048 || !COMP_CODE_RE.test(code)) c.err = 'code';
    else {
      Object.assign(c, { err: null, adding: true, at: Date.now() });
      send({ action: 'computers-add', name, code });
      setTimeout(() => { if (view.screen === 'settings') renderScreen(); }, COMP_WAIT_MS + 50);
    }
    code = '';
    renderScreen();
  }
  // kadans.result for computers-add / computers-remove: ok closes the form (add) or ends Removing…; a failure shows the
  // error code the app pushed with the list just before (never the result's own text).
  function compResult(r) {
    const c = view.comp;
    const e = compData()?.error;
    const code = typeof e === 'string' && Object.hasOwn(COMP_ERR, e) ? e : null;
    if (r.action === 'computers-add') {
      c.adding = false;
      if (r.ok === true) Object.assign(c, { open: false, err: null });
      else c.err = code ?? 'add';
    } else {
      c.removing = null;
      c.err = r.ok === true ? null : code ?? 'remove';
    }
    if (view.screen === 'settings') renderScreen();
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
  // A group: its label (none on the first Settings screen) and its card, both keyed; items that come and go (kickoff
  // hours, the uninstall command) rise in and fade out like rows.
  function sGroup(id, label, items) {
    const g = S('div', { class: 'sgrp' }, items, `g:${id}`, true);
    g.fade = true;
    return label ? [{ key: `gl:${id}`, html: `<div class="gl">${esc(label)}</div>` }, g] : [g];
  }
  const screenShell = (screen, cls, label, kids) =>
    S('div', { class: `panel screen${cls}`, role: 'dialog', 'aria-label': label }, kids, `screen:${screen}`, true);

  // k43: Settings is short. The first screen holds what people change (pace, phone and computers, updates) and one
  // Advanced row; the rare settings, Phone and Computers are second screens (view.sub) pushed from a one-line row. They
  // stay inside the 'settings' screen, so the app keeps polling devices until the page goes back to the main panel.
  const SUBS = { advanced: 'Advanced', phone: 'Phone', computers: 'Computers' };
  const IC_NEXT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';
  // A row that pushes a second screen: title, a short value and a chevron; the whole row is the button.
  const navItem = (id, title, value = '') =>
    S('button', { class: 'it nav', 'data-do': 'sub', 'data-id': id, 'data-key': `sub:${id}`, 'aria-label': value ? `${title}: ${value}` : title },
      [`<span class="tx">${esc(title)}</span>`, value ? `<span class="val">${esc(value)}</span>` : '', `<span class="chev" aria-hidden="true">${IC_NEXT}</span>`], `sub:${id}`);
  function phoneValue(p) {
    if (!phoneOn(p)) return 'Off';
    if (typeof p.error === 'string' && p.error) return 'Not working';
    const n = Array.isArray(p.devices) ? p.devices.filter((x) => x && typeof x.id === 'string' && x.id).length : 0;
    return n ? plural(n, 'phone', 'phones') : 'On';
  }
  function compValue(c) {
    if (!Array.isArray(c.list)) return '';
    const n = c.list.filter((x) => x && typeof x.id === 'string' && x.id && typeof x.name === 'string').length;
    return n ? String(n) : 'None';
  }

  // k43: Updates (k44 builds the Mac side). The app pushes {update: {auto, available: <version> | null, checking}}; the
  // page sends update-auto {on} and update-install. No payload, no row. A version is shown only when it looks like one.
  const VER_RE = /^v?\d{1,4}(?:\.\d{1,4}){0,3}(?:[-+][0-9A-Za-z.]{1,24})?$/;
  function updateData() {
    const u = view.data?.update;
    return u && typeof u === 'object' && !Array.isArray(u) ? u : null;
  }
  function updateItem(u) {
    const w = view.updWant;
    const auto = w && Date.now() - w.at < PENDING_MS ? w.on : u.auto === true;
    const ver = typeof u.available === 'string' && VER_RE.test(u.available.trim()) ? u.available.trim() : null;
    const sub = ver ? `<button class="pill blue inst" data-do="update-install" data-key="update-install">Install ${esc(ver)}</button>`
      : u.checking === true ? '<div class="d">Checking…</div>' : '';
    const sw = S('button', { class: 'sw', role: 'switch', 'aria-checked': String(auto), 'aria-label': 'Update automatically', 'data-do': 'update-auto',
      'data-v': String(!auto), 'data-key': 'set:update-auto' });
    return S('div', { class: 'it' }, [`<div class="tx"><div>Updates</div>${sub}</div>`, '<span class="cap" aria-hidden="true">Automatic</span>', sw], 'update');
  }

  function settingsTree() {
    const d = view.data ?? {};
    const cfg = d.config && typeof d.config === 'object' ? d.config : null;
    const sub = Object.hasOwn(SUBS, view.sub ?? '') ? view.sub : null;
    const shell = (body) => screenShell(sub ? `settings:${sub}` : 'settings', '', sub ? `Kadans settings: ${SUBS[sub]}` : 'Kadans settings',
      [topItem(sub ? SUBS[sub] : 'Settings'), S('div', { class: 'sbody', id: 'k-sbody' }, body, 'body', true)]);
    if (!cfg) {
      return shell([{ key: 'loading', html: '<div class="card"><div class="msg"><div><div class="t">Loading settings…</div>' +
        '<div class="s">If this stays, <span class="code">kadans config get</span> is failing.</div></div></div></div>' }]);
    }
    const ownKey = /^[0-9a-f]{12}$/.test(String(cfg.own ?? '')) ? cfg.own : null;
    if (sub === 'advanced') return shell(advancedBody(d, cfg, ownKey));
    if (sub === 'phone') {
      const ph = phoneData();
      return shell(ph && net.mode === 'bridge' ? sGroup('phone', '', phoneItems(ph)) : []);
    }
    if (sub === 'computers') {
      const cp = compData();
      return shell(cp && net.mode === 'bridge' ? sGroup('computers', '', compItems(cp)) : []); // k41: pairing stays on the Mac
    }
    const body = [];
    body.push(...sGroup('pace', '', [
      sSlider('targets.five_hour', '5-hour target', 'How full each 5-hour window should end.', 50, 100, '%'),
      ownKey
        ? sItem('gas', 'Use spare quota', 'Starts approved tasks before a window ends unused.', sSwitch(`accounts.${ownKey}.gas`, 'Use spare quota on your account'))
        : null,
      sItem('notify', 'Notifications', '', sSwitch('notify', 'Notifications')),
    ].filter(Boolean)));
    const ph = net.mode === 'bridge' ? phoneData() : null;
    const cp = net.mode === 'bridge' ? compData() : null;
    const dev = [ph ? navItem('phone', 'Phone', phoneValue(ph)) : null, cp ? navItem('computers', 'Computers', compValue(cp)) : null].filter(Boolean);
    if (dev.length) body.push(...sGroup('devices', '', dev));
    const up = net.mode === 'bridge' ? updateData() : null;
    const n = hooksNeeded(d.install && typeof d.install === 'object' ? d.install : null);
    body.push(...sGroup('more', '', [up ? updateItem(up) : null, navItem('advanced', 'Advanced', n ? 'Hooks to update' : '')].filter(Boolean)));
    return shell(body);
  }

  // Settings › Advanced: everything a person sets once, if ever.
  function advancedBody(d, cfg, ownKey) {
    const accounts = Array.isArray(d.status?.accounts) ? d.status.accounts : [];
    const own = accounts.find((a) => a?.own);
    const names = (own?.limits ?? []).map((l) => l?.name);
    const today = names.includes('five_hour') && names.includes('seven_day') ? ' Today: 5‑hour and 7‑day.'
      : names.includes('five_hour') ? ' Today: 5‑hour only.' : names.includes('seven_day') ? ' Today: 7‑day only.' : '';
    const m = cfgVal('warmup.minutes');
    const p = cfgVal('warmup.pct');
    const inst = d.install && typeof d.install === 'object' ? d.install : null;
    const n = hooksNeeded(inst);
    const cmd = typeof inst?.command === 'string' && inst.command ? inst.command : 'node bin/kadans.mjs';
    const has = (k) => cfgVal(k) !== undefined;
    const body = [];

    body.push(...sGroup('pace', 'Pace', [
      S('div', { class: 'it col' }, [S('div', { class: 'lr c' }, ['<span>Windows to watch</span>', sSeg('limits', 'Windows to watch', LIMIT_OPTS)], 'lr'),
        `<div class="d">Auto follows what Claude Code reports.${today}</div>`], 'windows'),
      sSlider('targets.seven_day', '7-day target', '', 50, 100, '%'),
      sSlider('slack', 'Spare margin', 'Spare quota counts only when the projection is this far below target.', 0, 30, ' pts'),
      sSlider('warmup.minutes', 'Warm-up time', '', 0, 60, ' min'),
      sSlider('warmup.pct', 'Warm-up usage', `No brake before ${esc(m ?? '?')} min into a window or ${esc(p ?? '?')}% used.`, 0, 50, '%'),
    ]));

    body.push(...sGroup('usage', 'Usage', [
      usageItem(d),
      has('codex') ? sItem('codex', 'Show Codex limits', '', sSwitch('codex', 'Show Codex limits')) : null,
    ].filter(Boolean)));

    const auto = ownKey ? autoGasItems(ownKey) : [];
    const ko = cfg.kickoff && typeof cfg.kickoff === 'object' ? cfg.kickoff : null;
    if (ko) {
      auto.push(sItem('kickoff', 'Start the next window for me', 'Sends Claude one tiny message when a 5-hour window ends, so the next one starts at once. ' +
        'Your account only; uses a little quota.', sSwitch('kickoff.enabled', 'Start the next window for me')));
      if (cfgVal('kickoff.enabled') === 'true') {
        auto.push(sHour('kickoff.from', 'Allowed from'), sHour('kickoff.to', 'Allowed until'), { key: 'kickoff-cmd',
          html: '<div class="it col un"><div class="d">Kadans does not set up background jobs itself. Run this once in a terminal; it adds a ' +
          'macOS job that checks every 15 minutes:</div>' +
          `<pre class="cmd" tabindex="0" aria-label="Command to run">${esc(cmd)} kickoff schedule --apply</pre>` +
          `<div class="d">Without <span class="code">--apply</span> it only shows the job. To remove it: <span class="code">kickoff unschedule --apply</span>.</div></div>` });
      }
    }
    if (auto.length) body.push(...sGroup('auto', 'On its own', auto));

    body.push(...sGroup('agents', 'Agents', [
      sItem('compact', 'Suggest compact', 'Marks idle chats that re-read a big context every turn.', compactSeg()),
      has('lean') ? sItem('lean', 'Lean mode', 'Short tips in your chats to use less quota.', sSwitch('lean', 'Lean mode')) : null,
      has('remoteAgents') && net.mode === 'bridge'
        ? sItem('remote', 'Agents on other computers', '', sSwitch('remoteAgents', 'Agents on other computers')) : null,
    ].filter(Boolean)));

    const cc = [sItem('lang', 'Status line language', '', sSeg('lang', 'Status line language', [['en', 'English'], ['tr', 'Türkçe']]))];
    if (net.mode === 'bridge') { // hooks are set up on the Mac, not from a phone
      cc.push(
        sItem('hooks', 'Hooks', inst ? (n ? `${plural(n, 'hook', 'hooks')} to add or update.` : '') : 'Not checked yet.',
          n ? '<button class="pill blue" data-do="review" data-key="review">Review</button>' : inst ? '<span class="chip ok">Installed</span>' : ''),
        sItem('uninstall', 'Remove from Claude Code', '',
          S('button', { class: 'pill danger', 'data-do': 'uninstall', 'data-key': 'uninstall', 'aria-expanded': String(view.uninstallOpen) }, ['Uninstall…'])));
      if (view.uninstallOpen) {
        cc.push({ key: 'uninstall-cmd', html: '<div class="it col un"><div class="d">Kadans does not remove itself from here. Run this in a terminal; it saves a backup of ' +
          'settings.json first, then takes out the status line and hooks and puts your old status line back:</div>' +
          `<pre class="cmd" tabindex="0" aria-label="Command to run">${esc(cmd)} uninstall --apply</pre>` +
          `<div class="d">Without <span class="code">--apply</span> it only shows the change.</div></div>` });
      }
    }
    body.push(...sGroup('cc', 'Claude Code', cc));
    return body;
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
    for (const k of ['status', 'agents', 'config', 'install', 'phone', 'computers', 'update', 'inbox']) if (k in d) next[k] = d[k];
    view.data = next;
    if ('inbox' in d) inboxArrived(); // k52
    if ('repos' in d) reposArrived(d.repos);
    if ('phone' in d && view.phoneWant && (d.phone?.on === view.phoneWant.on || d.phone?.error)) view.phoneWant = null;
    if ('update' in d && view.updWant && d.update?.auto === view.updWant.on) view.updWant = null;
    if ('config' in d) settlePending(d.config);
    if ('install' in d && view.applying) {
      view.applying = false;
      view.applyFailed = hooksNeeded(d.install) > 0;
      view.applied = !view.applyFailed;
    }
    if ('agents' in d && view.shown) inboxRead(); // k52: a host refresh; reads only when one is due (the badge)
    if (view.screen !== 'main') return renderScreen();
    // k32: a row held or settling is never yanked: the data is kept and drawn when it lands.
    if (drag.phase === 'on' || drag.phase === 'settle') {
      drag.deferred = true;
      return;
    }
    view.stree = null;
    const status = view.data.status ?? null;
    const now = finite(status?.now) ? status.now : Date.now();
    const g = gauge(status, now);
    const { all, old, live: served, away } = split(now);
    rememberAway(away);
    const live = applyOrder(served);
    view.liveIds = live.map((a) => a.id);
    settleTitles(all);
    if (view.rename && !live.some((a) => String(a.id) === String(view.rename.id) && rowState(a) !== 'ended') &&
      !(view.idleOpen && old.some((a) => String(a.id) === String(view.rename.id)))) view.rename = null;
    const tasks = startable(status?.queue);
    if (view.confirm && !all.some((a) => a.id === view.confirm)) view.confirm = null;
    if (view.confirm && view.kind === 'replace' && !tasks.some((t) => String(t.id) === String(view.task))) view.confirm = null;
    compactState();
    if (view.confirm && view.kind === 'compact' && !all.some((a) => a.id === view.confirm && offerCompact(a))) view.confirm = null;
    if (view.picker && (!all.some((a) => a.id === view.picker) || !tasks.length)) view.picker = null;
    if (view.pacer && !all.some((a) => a.id === view.pacer && ['working', 'idle'].includes(rowState(a)))) view.pacer = null;
    if (!old.length) view.closeAll = false;
    if (view.tapKey && !all.some((a) => `row:${a.id}` === view.tapKey)) view.tapKey = null;
    // k49: the chat left the list (or ended): its composer closes, and what was typed goes with it
    if (view.tell && !all.some((a) => String(a.id) === String(view.tell.id) && rowState(a) !== 'ended')) {
      const f = tellField();
      if (f) f.value = '';
      view.tell = null;
      tellViewport(false);
    }
    const subs = (a, rank) => (rowState(a) === 'ended' || !Array.isArray(a.subagents) ? []
      : a.subagents.filter((x) => x && x.status === 'running').map((x) => ({ id: x.id, startedAt: x.startedAt, rank })));
    shapeMap = assignShapes([...live.map((a) => ({ id: a.id, startedAt: a.startedAt, rank: 0 })), ...live.flatMap((a) => subs(a, 1)),
      ...old.map((a) => ({ id: a.id, startedAt: a.startedAt, rank: 2 })), ...old.flatMap((a) => subs(a, 3)),
      ...away.filter((a) => !a.machineOffline).map((a) => ({ id: a.id, startedAt: a.startedAt, rank: 4 }))]);

    const blocks = [];
    if (g.mode !== 'no_claude') {
      const hk = hookCard(view.data.install);
      if (hk) blocks.push({ key: 'hook', html: hk });
    }
    blocks.push(g.item);
    // k42: the gauge (above) and the bottom bar (below) never scroll; everything between them (Agents, sub-agents, other
    // computers, Up next) is one scroll area, which scrolls only when the panel cannot fit it (.panel max-height).
    const area = [];
    if (g.mode !== 'no_claude') {
      area.push({ key: 'sh', html: `<div class="sh"><span>Agents</span><span>${live.length || ''}</span></div>` });
      if (all.length) {
        area.push(...agentRows(live, now, tasks));
        if (old.length) area.push(groupHtml(old, now), ...(view.idleOpen ? agentRows(old, now, tasks) : []));
        area.push(...machineRows(away, now, tasks));
      } else {
        area.push(S('div', { class: 'empty' }, [blob('egg', 'idle', 30), '<div><div class="nm">No agents running</div>' +
          '<div class="s">They show up here when Claude Code starts one.</div></div>'], 'empty'));
      }
    }
    if (g.mode !== 'no_claude' && g.mode !== 'no_data' && g.mode !== 'error') {
      const up = upNext(status?.queue, g.gas);
      if (up) area.push({ key: 'upnext', html: up });
    }
    if (area.length) {
      const list = S('div', { class: 'list', id: 'k-list' }, area, 'list', true);
      list.fade = true;
      blocks.push(list);
    }
    blocks.push(bottom(status, g.mode));
    if (view.tell && tellSheet()) blocks.push(tellItem(view.tell)); // k49: the phone's bottom sheet
    // k27 phone: pairing / pair again replace the panel; "can't reach your Mac" sits above the last reading.
    const pc = phoneCard();
    if (pc && net.state !== 'offline' && net.state !== 'off') blocks.splice(0, blocks.length, pc);
    else if (pc) blocks.unshift(pc);
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

  // k38: one quiet header per other computer ("other · 2"; "other · offline" muted, its rows hidden), then its rows.
  function machineRows(away, now, tasks) {
    const out = [];
    for (const name of [...new Set(away.map((a) => a.machine))]) {
      const rows = away.filter((a) => a.machine === name);
      const off = rows.some((a) => a.machineOffline);
      const shown = off ? [] : rows.filter((a) => !a.machineOffline);
      const stale = shown.some((a) => a.machineStale === true);
      const note = off ? 'offline' : `${shown.length}${stale ? ' · not live' : ''}`;
      out.push({ key: `mh:${name}`, html: `<div class="mh${off ? ' off' : ''}" data-key="mh:${esc(name)}" title="${esc(off ? `${name} is offline` : `Agents on ${name}`)}">` +
        `<span class="mn">${esc(name)}</span> · <span class="mc">${note}</span></div>` });
      out.push(...agentRows(shown, now, tasks));
    }
    return out;
  }

  // all: rows the panel shows; old: idle chats quiet for 2+ hours, folded into the "N idle" group at the end; live: the rest.
  function split(now) {
    const all = agentList(view.data?.agents).filter((a) => a && a.id != null && !view.dismissed.has(a.id))
      .filter((a) => a.status !== 'ended' || !finite(a.lastSeen) || now - a.lastSeen < ENDED_KEEP_MS);
    // k38: agents on other computers (paired Orca environments) go in their own groups after everything local: never in
    // the Agents count, the idle group, Close all or the reorder.
    const away = all.filter((a) => typeof a.machine === 'string' && a.machine);
    const here = all.filter((a) => !away.includes(a));
    const old = here.filter((a) => rowState(a) === 'idle' &&
      (a.stale === true || (finite(a.lastSeen) && now - a.lastSeen > STALE_MS)));
    return { all, old, live: here.filter((a) => !old.includes(a)), away };
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
    if (view.screen === 'inbox') inboxRead(); // k52: every 15 s while the Inbox shows (the host's refresh draws it)
    const tree = view.screen === 'review' ? reviewTree() : view.screen === 'inbox' ? inboxTree() : settingsTree();
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
    pairTick();
    if (full || patchStats.made + patchStats.replaced + patchStats.removed + patchStats.attrs !== before) settle();
  }

  // dir: 'in' (Settings, Review) or 'back' (the screen you return to).
  function go(screen, dir = 'in') {
    if (view.screen === 'main' && view.tree) view.scroll = listNode()?.scrollTop ?? 0;
    // k27/k28: the app polls `devices --json` only while Settings is open; tell it when the page leaves for the main panel.
    if (screen === 'main' && settingsScreen() && net.mode === 'bridge') send({ action: 'settings-closed' });
    if (screen !== 'inbox' && view.screen === 'inbox') inboxLeave(); // k52: an open reply or new task goes, text and all
    view.slide = motionOk() ? { dir, at: Date.now() } : null;
    if (screen === 'main') view.sub = null; // Review keeps it: Back from Review lands on Advanced again
    view.screen = screen;
    view.sScroll = 0;
    view.applyConfirm = false;
    view.uninstallOpen = false;
    view.applyFailed = false;
    view.applied = false;
    if (net.mode === 'http') try { window.scrollTo?.(0, 0); } catch { /* the phone page scrolls, not the list */ }
    render({});
  }

  // k43: push (dir 'in') or leave (sub null, dir 'back') a Settings second screen; slides like a screen change.
  function goSub(sub, dir = 'in') {
    view.slide = motionOk() ? { dir, at: Date.now() } : null;
    view.sub = sub;
    view.sScroll = 0;
    view.uninstallOpen = false;
    if (sub !== 'computers') Object.assign(view.comp, { open: false, err: null, confirm: null });
    if (net.mode === 'http') try { window.scrollTo?.(0, 0); } catch { /* the phone page scrolls, not the list */ }
    renderScreen();
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
    // The height the panel wants (its scroll area fully open, up to the cap), not what fits the window now: the panel is
    // capped at the window's height in CSS, so a window that lags behind would otherwise never grow.
    const sc = p?.querySelector?.('#k-list, #k-sbody');
    const want = p ? p.getBoundingClientRect().height + (sc ? Math.max(0, sc.scrollHeight - sc.clientHeight) : 0) : 0;
    const h = Math.ceil(document.documentElement.dataset.shell === 'phone' ? want : Math.min(want, view.cap ?? 560));
    if (!h || h === view.height) return;
    const wait = view.animUntil - Date.now();
    if (h < view.height && wait > 0 && !now) {
      view.sizeTimer = setTimeout(reportSize, wait + 20);
      return;
    }
    view.height = h;
    send({ action: 'size', height: h });
  }

  // ---------- rename (k32) ----------
  // Double-click a chat's title (Mac) or Rename in its tap actions (phone): the title becomes an input with the current
  // title. Enter saves (rename), Escape or leaving the field cancels, empty clears to the automatic title. The input's
  // markup is built from the title at the start, so a refresh keeps its node (caret and typed text stay).
  const TITLE_MAX = 80;
  const TITLE_HOLD_MS = 10_000;
  const cleanTitle = (t) => String(t ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
  function nameItem(a, title) {
    const r = view.rename;
    if (!r || String(r.id) !== String(a.id)) return `<div class="nm">${esc(title)}</div>`;
    return { rename: true, html: `<input class="rn" type="text" data-key="rn:${esc(a.id)}" value="${esc(r.start)}" maxlength="${TITLE_MAX}" ` +
      `placeholder="Automatic title" aria-label="Chat name" spellcheck="false" autocomplete="off" enterkeyhint="done">` };
  }
  function renameInput(it = view.tree) {
    if (!it) return null;
    if (it.rename) return it.node ?? null;
    for (const k of it.kids ?? []) { const n = renameInput(k); if (n) return n; }
    return null;
  }
  function startRename(id) {
    const a = findAgent(id);
    if (!a || a.machine || rowState(a) === 'ended' || view.screen !== 'main') return; // k38: no rename for another computer's agent
    setConfirm(null);
    view.picker = null;
    view.pacer = null;
    view.tapKey = null;
    view.rename = { id: a.id, start: cleanTitle(titleOf(a)) };
    render({});
    const inp = renameInput();
    try { inp?.focus?.(); inp?.select?.(); } catch { /* no focus in this host */ }
  }
  function endRename(save) {
    const r = view.rename;
    if (!r) return;
    const typed = cleanTitle(renameInput()?.value ?? r.start);
    view.rename = null;
    const a = findAgent(r.id);
    if (save && a && typed !== r.start && (typed || a.title)) {
      view.titles.set(String(a.id), { title: typed, prev: a.title ?? null, at: Date.now() });
      clearResult(a.id);
      send({ action: 'rename', id: a.id, title: typed });
      setTimeout(() => render({}), TITLE_HOLD_MS + 50);
    }
    render({});
  }
  // A sent name is shown until the chat's title in the data changes, at most TITLE_HOLD_MS.
  function settleTitles(all) {
    const now = Date.now();
    for (const [id, w] of view.titles) {
      const a = all.find((x) => String(x.id) === id);
      if (!a || String(a.title ?? '') !== String(w.prev ?? '') || now - w.at > TITLE_HOLD_MS) view.titles.delete(id);
    }
  }
  function onDbl(e) {
    if (touchUi() || view.screen !== 'main' || drag.phase || !e.target?.closest?.('.nm')) return;
    const key = e.target.closest('.row[data-key]')?.getAttribute('data-key') ?? '';
    if (key.startsWith('row:')) startRename(key.slice(4));
  }

  // ---------- tell (k49) ----------
  // Tell on a row opens a composer: inline under the row on the Mac, a bottom sheet above the keyboard on the phone page
  // and in the iPhone app. Cmd-Enter or Send sends one `agent-send {id, text}`; Esc or Cancel closes it. The text lives
  // only in the textarea: never in `view`, never in localStorage, never logged. It is cleared on send and on cancel, and
  // no draft is kept when the panel closes (visible(false) and reset() drop it). The composer's markup is built from what
  // was known when it opened (title, machine), so a refresh never rebuilds the textarea (what was typed and the caret stay).
  // Results are fixed lines (TELL_LINES), never the CLI's text, so a refusal can never echo the message.
  const TELL_MAX = 4000; // lib/text.mjs SEND_MAX
  const TELL_NEAR = 3600; // the counter shows from here
  const TELL_WAIT_MS = 60_000; // no answer by then: the row stops saying "Sending…"
  const TELL_STATES = new Set(['idle', 'working', 'slowed', 'paused']);
  // As lib/text.mjs messageText checks it (tabs become two spaces first, so a pasted indent is not a refusal).
  const TELL_BAD = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
  const TELL_HINT = {
    lead: 'Messages can’t start with !, / or #',
    dash: 'Messages can’t start with -',
    bad: 'This has characters Kadans can’t type',
    long: `Too long: ${TELL_MAX} characters at most`,
  };
  // The answer's reason -> one fixed line. Order matters (the first match wins); anything else is "Not sent".
  const TELL_LINES = [
    [/unsent text/i, 'That chat has unsent text. Nothing was sent.'],
    [/question or permission/i, 'It’s waiting on a question. Answer it first.'],
    [/dialog|screen could not be read/i, 'That chat shows a dialog, or Kadans couldn’t read it. Nothing was sent.'],
    [/is working/i, 'It’s working. Try again when it waits.'],
    [/Too many messages/i, 'Too many messages; wait a minute'],
    [/Too many actions/i, 'Too many actions at once; try again'],
    [/took too long/i, 'No answer in time. Check that chat before sending again.'],
    [/reach your Mac/i, 'Couldn’t reach your Mac. Check that chat before sending again.'],
    [/did not answer|not live|offline/i, 'That computer didn’t answer. Nothing was sent.'],
    [/no longer running|has ended|not in the current|not an agent/i, 'That chat is gone. Nothing was sent.'],
    [/did not take/i, 'Orca didn’t take the message.'],
  ];
  const tellLine = (why) => (TELL_LINES.find(([re]) => re.test(String(why ?? ''))) ?? [null, 'Not sent.'])[1];
  function tellCheck(v) {
    const t = String(v ?? '').replace(/\t/g, '  ').replace(/\r\n?/g, '\n').replace(/^\s+|\s+$/gu, '');
    const n = Array.from(t).length;
    const why = !t ? 'empty' : /^[!/#]/.test(t) ? 'lead' : /^-/.test(t) ? 'dash' : n > TELL_MAX ? 'long' : TELL_BAD.test(t) ? 'bad' : null;
    return why ? { ok: false, n, why } : { ok: true, n, text: t };
  }
  // A local chat in a known Orca terminal that is idle or working (also slowed or paused), or another computer's chat
  // whose flags allow send. The CLI decides again on the chat's screen (lib/compact.mjs sendGuard).
  const canTell = (a) => (a.machine ? remoteCan(a, 'canSend') && (rowState(a) === 'idle' || rowState(a) === 'working')
    : TELL_STATES.has(rowState(a)) && orcaOk(a));
  const tellSheet = () => document.documentElement.dataset.shell === 'phone';
  // The field's node in the last drawn tree (k52: the Inbox's reply composer lives in the screen tree).
  function tellField(it = view.screen === 'main' ? view.tree : view.stree, flag = 'tellField') {
    if (!it) return null;
    if (it[flag]) return it.node ?? null;
    for (const k of it.kids ?? []) { const n = tellField(k, flag); if (n) return n; }
    return null;
  }
  function shortTitle(t) {
    if (t.length <= 24) return t;
    const cut = t.slice(0, 24);
    return (cut.lastIndexOf(' ') > 12 ? cut.slice(0, cut.lastIndexOf(' ')) : cut).trim();
  }
  function tellItem(t) {
    const id = esc(t.id);
    const sheet = tellSheet();
    const hint = t.why && t.why !== 'empty' ? TELL_HINT[t.why] : '';
    const count = t.n >= TELL_NEAR ? `${t.n} / ${TELL_MAX}` : '';
    const off = !t.n || Boolean(t.why);
    const reply = t.kind === 'reply'; // k52: the same composer answers an inbox question
    return S('div', { class: sheet ? 'tell sheet' : 'tell', role: 'group', 'aria-label': `${reply ? 'Reply to' : 'Tell'} ${t.title}`, 'data-key': `tell:${t.id}` }, [
      { key: 'tl', tellField: true, html: `<textarea class="tl" data-key="tl:${id}" rows="2" placeholder="${esc(reply ? 'Your answer…' : `Tell ${t.short}…`)}" ` +
        `aria-label="${esc(`${reply ? 'Answer to' : 'Message to'} ${t.title}`)}" spellcheck="true" autocomplete="off" enterkeyhint="enter"></textarea>` },
      // the title gives way (ellipsis), the machine always shows
      `<div class="tto"><span class="tn">To ${esc(t.title)}</span><span class="tm"> on ${esc(t.machine)}</span></div>`,
      `<div class="tbar"><span class="tmsg${hint ? ' warn' : ''}" aria-live="polite">${esc(hint)}</span>` +
        `<span class="tcount${t.n > TELL_MAX ? ' warn' : ''}">${count}</span>` +
        `<button class="pill quiet" data-do="tell-cancel" data-id="${id}">Cancel</button>` +
        `<button class="pill blue" data-do="tell-send" data-id="${id}" aria-keyshortcuts="Meta+Enter"${off ? ' aria-disabled="true"' : ''}>Send</button></div>`,
      sheet ? '<div class="thint">Tap the mic on the keyboard to speak</div>' : '',
    ], `tell:${t.id}`);
  }
  function startTell(id) {
    const a = findAgent(id);
    if (!a || !canTell(a) || view.screen !== 'main') return;
    if (view.rename) endRename(false);
    setConfirm(null);
    view.picker = null;
    view.pacer = null;
    view.tapKey = null;
    clearResult(a.id);
    const title = cleanTitle(titleOf(a)) || 'this chat';
    view.tell = { id: a.id, title, short: shortTitle(title), machine: a.machine ?? (net.mode === 'bridge' ? 'this Mac' : 'your Mac'), n: 0, why: 'empty' };
    tellViewport(true);
    render({});
    // The sheet slides up (the inline card rises in as a new list item does); never on a first paint or reduced motion.
    const sh = tellSheet() && motionOk() ? view.tree?.kids?.find((k) => k.key === `tell:${a.id}`)?.node : null;
    if (sh?.classList) {
      sh.classList.add('up');
      busy(320);
      setTimeout(() => sh.classList.remove('up'), 340);
    }
    try { tellField()?.focus?.(); } catch { /* no focus in this host */ }
  }
  // Closes the composer and empties the field (the node may stay a moment in a leave animation: never with the text).
  function endTell(focusRow = true) {
    const t = view.tell;
    if (!t) return;
    const f = tellField();
    if (f) f.value = '';
    view.tell = null;
    tellViewport(false);
    render({});
    const by = t.kind === 'reply' ? 'reply' : 'tell';
    if (focusRow) try { root().querySelector?.(`[data-do="${by}"][data-id="${CSS.escape(String(t.id))}"]`)?.focus?.(); } catch { /* fine */ }
  }
  function tellInput() {
    const t = view.tell;
    const f = tellField();
    if (!t || !f) return;
    // 2 to 6 lines, growing with the text (min and max height in panel.css); then the popover follows the new height.
    try {
      if (f.style) {
        f.style.height = 'auto';
        f.style.height = `${f.scrollHeight}px`;
        settle(); // render() reports the height only when it patched something; a keystroke usually patches nothing
      }
    } catch { /* no layout in this host */ }
    const c = tellCheck(f.value);
    const why = c.ok ? null : c.why;
    if (c.n === t.n && why === t.why) return;
    t.n = c.n;
    t.why = why;
    render({});
  }
  function sendTell() {
    const t = view.tell;
    const f = tellField();
    if (!t || !f) return;
    const c = tellCheck(f.value);
    if (!c.ok) {
      t.n = c.n;
      t.why = c.why;
      render({});
      return;
    }
    if (t.kind === 'reply') return replySend(t, f, c.text); // k52
    const a = findAgent(t.id);
    f.value = '';
    endTell(false);
    if (!a || !canTell(a)) {
      setResult(t.id, false, 'That chat can’t take a message now. Nothing was sent.');
      render({});
      return;
    }
    view.telling = { id: a.id, at: Date.now() };
    send({ action: 'agent-send', id: a.id, text: c.text });
    setTimeout(() => { if (view.telling && Date.now() - view.telling.at >= TELL_WAIT_MS) { view.telling = null; render({}); } }, TELL_WAIT_MS + 50);
    render({});
  }
  // The answer to an agent-send: "Sent" on the row, or one fixed line.
  function tellResult(r) {
    if (view.telling && String(view.telling.id) === String(r.id)) view.telling = null;
    if (r.ok === true) setResult(r.id, true, 'Sent');
    else setResult(r.id, false, tellLine(r.why));
    render({});
  }
  // The phone sheet stays above the keyboard: --kb is the part of the layout viewport the keyboard covers.
  let tellVV = null;
  function tellViewport(on) {
    const vv = window.visualViewport;
    const css = document.documentElement.style;
    if (on && tellSheet() && vv && !tellVV) {
      tellVV = () => css?.setProperty?.('--kb', `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
      vv.addEventListener('resize', tellVV);
      vv.addEventListener('scroll', tellVV);
      tellVV();
    } else if (!on && tellVV && vv) {
      vv.removeEventListener('resize', tellVV);
      vv.removeEventListener('scroll', tellVV);
      tellVV = null;
      css?.setProperty?.('--kb', '0px');
    }
  }

  // ---------- inbox (k52) ----------
  // One inbox for this Mac and the paired computers (k51: lib/inbox.mjs, the payload of `kadans inbox --json`). The
  // bottom bar's Inbox pushes a screen: what needs the owner (open questions and escalations), what runs, what
  // finished. A question opens the k49 composer (inline on the Mac, the bottom sheet on the phone) and sends one
  // inbox-reply {id, text}. New task (a second screen): computer, project, text, Options (model, effort), then a confirm
  // step that names everything; only its Start sends task-new, with confirmed: true. Agent text is the capped preview the
  // payload gives, always escaped, and nothing in it acts: the page only reads the inbox and sends what the owner taps.
  // Refusals show fixed lines (INBOX_LINES), never the CLI's text. The task text lives in its textarea; only its first
  // 60 characters sit in view.ibx.nt.head while the confirm step shows them (cleared with the confirm).
  // view.ibx: { sub ('new' | null), open (the expanded row), at / reading (the last read sent, the one in flight), err (the
  // last read failed), replying { id, at }, setup (sent at), line { where, ok, text, html, at }, nt (the new task) }.
  const IBX_ACTIONS = new Set(['inbox', 'repos', 'inbox-reply', 'task-new', 'inbox-setup']);
  const INBOX_OPEN_MS = 15_000; // the Inbox screen reads again this often
  const INBOX_MAIN_MS = 60_000; // elsewhere, while the panel shows: for the badge
  const INBOX_FIRST_MS = 8000; // the first background read, this long after the page loads
  const INBOX_REOPEN_MS = 20_000; // the popover opened: read at once unless the last read is this fresh
  const INBOX_WAIT_MS = 30_000; // a read with no answer by then may go again
  const REPLY_WAIT_MS = 60_000; // the bridges allow 45 s
  const START_WAIT_MS = 180_000; // the bridges allow 170 s
  const SETUP_WAIT_MS = 30_000;
  const IBX_LINE_MS = 8000;
  const DONE_MAX = 5;
  const NT_HEAD = 60;
  const REPO_SHOW = 6;
  const PREVIEW_MAX = 280; // lib/inbox.mjs caps it already; the page never shows more
  const IBX_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/; // as the bridges check ids
  const MODEL_OK = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/;
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  const MODELS = [['', 'Default'], ['opus', 'Opus'], ['sonnet', 'Sonnet']]; // Claude Code's model aliases
  const OPEN_KINDS = new Set(['question', 'escalation']);
  const KIND_LINE = { question: 'Question', escalation: 'Escalation', done: 'Done', message: 'Update', task: 'Task' };
  const TASK_LINE = { pending: 'Waiting', ready: 'Ready', blocked: 'Blocked', dispatched: 'Starting', running: 'Running',
    completed: 'Finished', failed: 'Failed', cancelled: 'Cancelled', canceled: 'Cancelled' };
  const TASK_END = new Set(['completed', 'failed', 'cancelled', 'canceled']);
  const DONE_LINE = { succeeded: 'Done', done: 'Done', failed: 'Failed' };
  // The answer's reason -> one fixed line (the first match wins); anything else is the caller's fallback.
  const INBOX_LINES = [
    [/not set up/i, 'The inbox isn’t set up yet.'],
    [/confirm step/i, 'Not started: it needs the confirm step.'],
    [/production/i, 'Kadans never starts work on a production computer.'],
    [/not this Mac or a paired|paired computers/i, 'That computer isn’t available now.'],
    [/repo/i, 'That project isn’t on that computer.'],
    [/did not confirm the start/i, 'Orca didn’t confirm the start. Check the inbox before starting it again.'],
    [/no open question/i, 'That question was answered or is gone.'],
    [/did not take/i, 'Orca didn’t take it. Nothing was sent.'],
    [/Too many messages/i, 'Too many messages; wait a minute'],
    [/Too many actions/i, 'Too many actions at once; try again'],
    [/took too long|timed out|in time/i, 'No answer in time. Check the inbox before trying again.'],
    [/reach your Mac/i, 'Couldn’t reach your Mac.'],
    [/orca not found/i, 'Orca isn’t installed on your Mac.'],
    [/text comes on stdin|printable/i, 'Kadans can’t send that text.'],
    [/model|effort/i, 'That model or effort isn’t accepted.'],
  ];
  const fixedLine = (why, fallback) => (INBOX_LINES.find(([re]) => re.test(String(why ?? ''))) ?? [null, fallback])[1];
  const SETUP_HTML = 'Couldn’t set it up from here. Run <span class="code">kadans inbox setup</span> once in an Orca terminal you keep open.';
  const IC_CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>';

  function ibxFresh() {
    return { sub: null, open: null, at: Date.now() - INBOX_MAIN_MS + INBOX_FIRST_MS, reading: 0, err: false, replying: null, setup: 0,
      line: null, nt: null };
  }
  view.ibx = ibxFresh();
  const settingsScreen = () => view.screen === 'settings' || view.screen === 'review';
  const str = (v) => (typeof v === 'string' ? v : '');
  function inboxData() {
    const b = view.data?.inbox;
    return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
  }
  // The payload's items with an id the bridges accept and a known kind. Every string is escaped where it is drawn.
  function inboxItems(b = inboxData()) {
    if (!Array.isArray(b?.items)) return [];
    return b.items.filter((i) => i && typeof i === 'object' && IBX_ID.test(str(i.id)) && Object.hasOwn(KIND_LINE, str(i.kind)));
  }
  const needsYou = (i) => OPEN_KINDS.has(i.kind) && i.status === 'open';
  const needCount = () => inboxItems().filter(needsYou).length;
  function inboxMachines(b = inboxData()) {
    const list = Array.isArray(b?.machines) ? b.machines.filter((m) => m && typeof m === 'object' && IBX_ID.test(str(m.id)) && str(m.name)) : [];
    if (!list.some((m) => m.id === 'local')) list.unshift({ id: 'local', name: 'This Mac' });
    return list;
  }
  // "this Mac" in the Mac panel, "your Mac" on the phone; another computer by its (cleaned) name.
  function machineText(id, name, cap = false) {
    if (id === 'local') return net.mode === 'bridge' ? (cap ? 'This Mac' : 'this Mac') : (cap ? 'Your Mac' : 'your Mac');
    return cleanTitle(name) || '';
  }
  // Offline: the contract's machines carry no status, so the page also reads the k38 offline marker rows (agents) and the
  // Settings › Computers list when they are there. An optional status / online on the machine wins.
  function machineOff(m) {
    if (!m || m.id === 'local') return false;
    if (m.online === false || m.status === 'offline') return true;
    const comps = view.data?.computers?.list;
    if (Array.isArray(comps) && comps.some((c) => c && c.id === m.id && c.status === 'offline')) return true;
    const ag = view.data?.agents;
    return Array.isArray(ag) && ag.some((a) => a && a.machineOffline === true && (a.machine === m.name || a.machine === m.id));
  }
  const clipText = (s, n) => {
    const cps = Array.from(String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim());
    return cps.length > n ? `${cps.slice(0, n - 1).join('')}…` : cps.join('');
  };
  function metaOf(i, now) {
    const st = OPEN_KINDS.has(i.kind) ? KIND_LINE[i.kind] : i.kind === 'task' ? own(TASK_LINE, i.status, '')
      : i.kind === 'done' ? own(DONE_LINE, i.status, 'Done') : KIND_LINE[i.kind];
    const t = Date.parse(str(i.at));
    const live = i.kind === 'task' && !TASK_END.has(i.status); // a running task: how long it has run
    const when = !Number.isFinite(t) ? '' : now - t < MIN ? (live ? '' : 'just now') : live ? dur(now - t) : `${dur(now - t)} ago`;
    return [machineText(i.machine, i.machineName, true), st, when].filter(Boolean).join(' · ');
  }

  // ---- reads ----
  // Reads only when one is due (or forced by the owner opening the Inbox); never two at once. The phone sends them as
  // actions too (one request at a time), so they stay rare off the Inbox screen.
  function inboxRead(force = false) {
    const now = Date.now();
    if (net.mode === 'http' && (!net.token || net.state !== 'live')) return;
    if (view.ibx.reading && now - view.ibx.reading < INBOX_WAIT_MS) return;
    if (!force && now - view.ibx.at < (view.screen === 'inbox' ? INBOX_OPEN_MS : INBOX_MAIN_MS)) return;
    view.ibx.at = now;
    view.ibx.reading = now;
    send({ action: 'inbox' });
  }
  // A new inbox payload (render() already keeps it): the read is over; a reply whose question is no longer open closes
  // (what was typed goes with it).
  function inboxArrived() {
    view.ibx.reading = 0;
    view.ibx.err = false;
    const t = view.tell;
    if (t?.kind === 'reply' && !inboxItems().some((i) => i.id === t.id && needsYou(i) && i.canReply === true)) {
      const f = tellField();
      if (f) f.value = '';
      view.tell = null;
      tellViewport(false);
    }
  }
  function reposArrived(p) {
    const nt = view.ibx.nt;
    if (!p || typeof p !== 'object' || !nt || p.machine !== nt.machine) return; // an answer for a computer no longer picked
    const list = Array.isArray(p.list)
      ? p.list.filter((r) => r && typeof r === 'object' && IBX_ID.test(str(r.id))).map((r) => ({ id: r.id, name: clipText(r.name, 60) || r.id }))
      : null;
    view.repos = { machine: p.machine, list, err: !list };
    nt.repoWait = false;
    if (nt.repo && !list?.some((r) => r.id === nt.repo)) nt.repo = null;
  }
  function ibxLine(where, ok, text, html = '') {
    const at = Date.now();
    view.ibx.line = { where, ok, text, html, at };
    if (ok) setTimeout(() => { if (view.ibx.line?.at === at) { view.ibx.line = null; paint(); } }, IBX_LINE_MS + 50);
  }
  const ibxLineFor = (where) => {
    const l = view.ibx.line;
    return l && l.where === where && (!l.ok || Date.now() - l.at < IBX_LINE_MS) ? l : null;
  };
  // The bridges' answers, matched by action (the Mac's refusals carry id ""; a started task's id is its machine).
  function inboxResult(r) {
    const ok = r.ok === true;
    switch (r.action) {
      case 'inbox':
        view.ibx.reading = 0;
        if (ok && r.inbox && typeof r.inbox === 'object') return render({ inbox: r.inbox }); // the phone: the answer carries it
        if (!ok) view.ibx.err = true;
        break;
      case 'repos':
        if (ok && r.repos && typeof r.repos === 'object') return render({ repos: r.repos });
        if (!ok && view.ibx.nt?.repoWait) {
          view.ibx.nt.repoWait = false;
          view.repos = { machine: view.ibx.nt.machine, list: null, err: true };
        }
        break;
      case 'inbox-reply': {
        const id = view.ibx.replying?.id ?? (IBX_ID.test(str(r.id)) ? r.id : 'top');
        view.ibx.replying = null;
        ibxLine(id, ok, ok ? 'Sent' : fixedLine(r.why, 'Not sent.'));
        if (ok && net.mode === 'http') { view.ibx.reading = 0; inboxRead(true); } // the Mac reads again by itself
        break;
      }
      case 'task-new': {
        const nt = view.ibx.nt;
        if (ok) {
          const on = nt?.startOn ? ` on ${nt.startOn}` : '';
          if (nt) {
            const f = ntField();
            if (f) f.value = '';
            view.ibx.nt = null;
            if (view.ibx.sub) {
              view.ibx.sub = null;
              view.slide = motionOk() ? { dir: 'back', at: Date.now() } : null;
            }
          }
          ibxLine('top', true, `Started${on}`);
          if (net.mode === 'http') { view.ibx.reading = 0; inboxRead(true); }
        } else if (nt?.starting) {
          Object.assign(nt, { starting: 0, step: 'edit', head: '', line: fixedLine(r.why, 'Not started.') });
        } else ibxLine('top', false, fixedLine(r.why, 'Not started.'));
        break;
      }
      case 'inbox-setup':
        view.ibx.setup = 0;
        if (ok) {
          ibxLine('setup', true, 'Set up');
          view.ibx.reading = 0; // a read sent before the setup may still be out: read the new state anyway
          inboxRead(true);
        } else ibxLine('setup', false, '', SETUP_HTML);
        break;
      default: return;
    }
    paint();
  }

  // ---- the Inbox screen ----
  function inboxButton() {
    const n = needCount();
    const label = n ? `Inbox, ${plural(n, 'item needs', 'items need')} you` : 'Inbox';
    return `<button class="ic ibx" title="Inbox" aria-label="${esc(label)}" data-do="inbox">${IC.inbox}` +
      (n ? `<span class="badge" aria-hidden="true">${n > 99 ? '99+' : n}</span>` : '') + '</button>';
  }
  function needRow(i, now) {
    const sending = view.ibx.replying?.id === i.id;
    const res = ibxLineFor(i.id);
    const meta = sending ? 'Sending…' : res ? res.text : metaOf(i, now);
    const composing = view.tell?.kind === 'reply' && view.tell.id === i.id;
    const reply = i.canReply === true && !sending && !composing && !view.ibx.replying;
    const pv = clipText(i.preview, PREVIEW_MAX);
    return S('div', { class: 'it ib', 'data-key': `ib:${i.id}` }, [
      avatar(shapeOf(str(i.dispatchId) || i.id), 'wait', 22),
      `<div class="tx"><div class="nm">${esc(clipText(i.title, TITLE_MAX) || KIND_LINE[i.kind])}</div>` +
        (pv ? `<div class="q">${esc(pv)}</div>` : '') + `<div class="d${res && !res.ok ? ' warn' : ''}">${esc(meta)}</div></div>`,
      reply ? `<button class="pill" data-do="reply" data-id="${esc(i.id)}">Reply</button>` : '', // quiet: the only blue is Send / Start
    ], `ib:${i.id}`);
  }
  // A running or finished row; with something to read it is a button that opens it in place (one click, details).
  function infoRow(i, face, now, more) {
    const pv = clipText(more, PREVIEW_MAX);
    const open = Boolean(pv) && view.ibx.open === i.id;
    const kids = [avatar(shapeOf(str(i.dispatchId) || i.id), face, 22),
      `<span class="tx"><span class="nm">${esc(clipText(i.title, TITLE_MAX) || KIND_LINE[i.kind])}</span>` +
        `<span class="d">${esc(metaOf(i, now))}</span>${open ? `<span class="q">${esc(pv)}</span>` : ''}</span>`,
      pv ? `<span class="chev${open ? ' on' : ''}" aria-hidden="true">${IC_NEXT}</span>` : ''];
    return pv
      ? S('button', { class: 'it ib', 'data-do': 'ib-open', 'data-id': i.id, 'data-key': `ib:${i.id}`, 'aria-expanded': String(open) }, kids, `ib:${i.id}`)
      : S('div', { class: 'it ib', 'data-key': `ib:${i.id}` }, kids, `ib:${i.id}`);
  }
  function setupCard() {
    const busy = view.ibx.setup > 0;
    const l = ibxLineFor('setup');
    const line = l ? `<div class="s${l.ok ? '' : ' warn'}">${l.html || esc(l.text)}</div>` : '';
    return { key: 'setup', html: '<div class="card ibs"><div class="msg"><div><div class="t">Not set up yet</div>' +
      '<div class="s">Set it up once to start tasks and answer agents here, on this Mac and your other computers.</div>' + line +
      `<div class="btns"><button class="pill blue" data-do="inbox-setup"${busy ? ' aria-disabled="true"' : ''}>${busy ? 'Setting up…' : 'Set up'}</button></div>` +
      '</div></div></div>' };
  }
  function inboxTree() {
    const b = inboxData();
    if (view.ibx.sub === 'new' && view.ibx.nt) return ntTree(b, view.ibx.nt);
    const now = finite(view.data?.status?.now) ? view.data.status.now : Date.now(); // as the main panel: the reading's time
    const newBtn = b?.ready === true ? '<button class="pill nt-go" data-do="nt-open" data-key="nt-open">New task</button>' : '';
    const top = { key: 'top', html: `<div class="top"><button class="ic" data-do="back" data-key="back" aria-label="Back" title="Back">${IC_BACK}</button>` +
      `<span class="ttl">Inbox</span>${newBtn}</div>` };
    const body = [];
    const l = ibxLineFor('top');
    if (l) body.push({ key: 'line', html: `<div class="ibl${l.ok ? '' : ' warn'}" role="status">${esc(l.text)}</div>` });
    if (!b) {
      body.push({ key: 'wait', html: view.ibx.err
        ? '<div class="card"><div class="msg"><div><div class="t">Couldn’t read the inbox</div><div class="btns">' +
          '<button class="pill" data-do="inbox-read">Try again</button></div></div></div></div>'
        : '<div class="ibl">Reading the inbox…</div>' });
    } else {
      if (b.ready !== true) body.push(setupCard());
      else if (view.ibx.err) body.push({ key: 'err', html: '<div class="ibl">Couldn’t read the inbox just now; this is the last reading.</div>' });
      const items = inboxItems(b);
      const need = items.filter(needsYou);
      const doneFor = new Set(items.filter((i) => i.kind === 'done' && i.dispatchId).map((i) => i.dispatchId));
      const running = items.filter((i) => i.kind === 'task' && !TASK_END.has(i.status) && !(i.dispatchId && doneFor.has(i.dispatchId)));
      const runIds = new Set(running.map((i) => i.dispatchId).filter(Boolean));
      const news = new Map(); // a running task's newest update (items are newest first)
      for (const i of items) if (i.kind === 'message' && i.dispatchId && runIds.has(i.dispatchId) && !news.has(i.dispatchId)) news.set(i.dispatchId, i.preview);
      const done = items.filter((i) => i.kind === 'done' || (i.kind === 'message' && !(i.dispatchId && runIds.has(i.dispatchId))) ||
        (i.kind === 'task' && TASK_END.has(i.status) && !(i.dispatchId && doneFor.has(i.dispatchId)))).slice(0, DONE_MAX);
      const sheet = tellSheet();
      if (need.length) {
        body.push(...sGroup('need', 'Needs you', need.flatMap((i) => [needRow(i, now),
          ...(view.tell?.kind === 'reply' && view.tell.id === i.id && !sheet ? [tellItem(view.tell)] : [])])));
      }
      if (running.length) body.push(...sGroup('run', 'Running', running.map((i) => infoRow(i, 'work', now, news.get(i.dispatchId) ?? ''))));
      if (done.length) {
        body.push(...sGroup('done', 'Done', done.map((i) => infoRow(i, i.status === 'failed' || i.status === 'cancelled' || i.status === 'canceled' ? 'slow'
          : i.kind === 'message' ? 'idle' : 'done', now, i.preview))));
      }
      if (b.ready === true && !need.length && !running.length && !done.length) {
        body.push(S('div', { class: 'empty' }, [avatar('egg', 'idle', 30), '<div><div class="nm">Nothing here yet</div>' +
          '<div class="s">Start a task; what the agents ask and report shows up here.</div></div>'], 'empty'));
      }
    }
    const kids = [top, S('div', { class: 'sbody', id: 'k-sbody' }, body, 'body', true)];
    if (view.tell?.kind === 'reply' && tellSheet()) kids.push(tellItem(view.tell)); // the phone's bottom sheet
    return screenShell('inbox', ' inbox', 'Kadans inbox', kids);
  }

  // ---- reply (the k49 composer) ----
  function startReply(id) {
    const it = inboxItems().find((i) => i.id === id);
    if (!it || !needsYou(it) || it.canReply !== true || view.ibx.sub || view.ibx.replying) return;
    if (view.tell) endTell(false);
    const title = clipText(it.title, TITLE_MAX) || KIND_LINE[it.kind];
    view.ibx.open = null;
    if (view.ibx.line?.where === it.id) view.ibx.line = null;
    view.tell = { kind: 'reply', id: it.id, title, short: shortTitle(title), machine: machineText(it.machine, it.machineName) || 'its computer', n: 0, why: 'empty' };
    tellViewport(true);
    renderScreen();
    const sh = tellSheet() && motionOk() ? view.stree?.kids?.find((k) => k.key === `tell:${it.id}`)?.node : null;
    if (sh?.classList) {
      sh.classList.add('up');
      busy(320);
      setTimeout(() => sh.classList.remove('up'), 340);
    }
    try { tellField()?.focus?.(); } catch { /* no focus in this host */ }
  }
  // From sendTell: the text passed the checks. The field is emptied before anything goes out.
  function replySend(t, f, text) {
    const it = inboxItems().find((i) => i.id === t.id);
    f.value = '';
    endTell(false);
    if (!it || !needsYou(it) || it.canReply !== true || view.ibx.replying) {
      ibxLine(t.id, false, 'That question was answered or is gone. Nothing was sent.');
      paint();
      return;
    }
    const at = Date.now();
    view.ibx.replying = { id: it.id, at };
    send({ action: 'inbox-reply', id: it.id, text });
    setTimeout(() => {
      if (view.ibx.replying?.at !== at) return;
      view.ibx.replying = null;
      ibxLine(it.id, false, 'No answer in time. Check the inbox before replying again.');
      paint();
    }, REPLY_WAIT_MS);
    paint();
  }
  function setupGo() {
    if (view.ibx.setup) return;
    const at = Date.now();
    view.ibx.setup = at;
    view.ibx.line = null;
    send({ action: 'inbox-setup' });
    // until the bridges answer inbox-setup (k53), nothing may come back: the button ends with the same fixed line
    setTimeout(() => {
      if (view.ibx.setup !== at) return;
      view.ibx.setup = 0;
      ibxLine('setup', false, '', SETUP_HTML);
      paint();
    }, SETUP_WAIT_MS);
    renderScreen();
  }
  // Leaving the Inbox (or closing the popover, or reset): an open reply and a new task go, and their text with them.
  function inboxDrop() {
    const f = view.ibx?.nt ? ntField() : null;
    if (f) f.value = '';
    if (view.ibx) {
      view.ibx.nt = null;
      view.ibx.sub = null;
      view.ibx.open = null;
    }
    if (view.tell?.kind === 'reply') {
      const g = tellField();
      if (g) g.value = '';
      view.tell = null;
      tellViewport(false);
    }
  }
  const inboxLeave = inboxDrop;

  // ---- new task ----
  const ntField = () => tellField(view.stree, 'ntField');
  function ntOpen() {
    const b = inboxData();
    if (!b || b.ready !== true || view.ibx.sub) return;
    if (view.tell) endTell(false);
    const d = b.defaults && typeof b.defaults === 'object' ? b.defaults : {}; // not in the k51 contract yet: used when present
    const model = MODEL_OK.test(str(d.model)) ? d.model : '';
    view.ibx.nt = { machine: null, repo: null, q: '', opts: false, model, effort: model && EFFORTS.includes(d.effort) ? d.effort : '',
      step: 'edit', head: '', starting: 0, startOn: '', line: null, n: 0, why: 'empty', repoWait: false };
    view.ibx.sub = 'new';
    view.ibx.line = null;
    view.slide = motionOk() ? { dir: 'in', at: Date.now() } : null;
    view.sScroll = 0;
    ntMachine('local', false);
    renderScreen();
    root().querySelector('[data-do="back"]')?.focus();
  }
  function ntClose() {
    const f = ntField();
    if (f) f.value = '';
    view.ibx.nt = null;
    view.ibx.sub = null;
    view.slide = motionOk() ? { dir: 'back', at: Date.now() } : null;
    renderScreen();
    root().querySelector('[data-do="nt-open"]')?.focus();
  }
  const ntMachineOk = (nt) => { const m = inboxMachines().find((x) => x.id === nt.machine); return m && !machineOff(m) ? m : null; };
  const ntRepoOk = (nt) => (view.repos?.machine === nt.machine ? view.repos.list?.find((r) => r.id === nt.repo) ?? null : null);
  function ntMachine(id, draw = true) {
    const nt = view.ibx.nt;
    if (!nt || nt.step !== 'edit' || nt.starting) return;
    const m = inboxMachines().find((x) => x.id === id);
    if (!m || machineOff(m)) return; // an offline computer is never picked (its button is disabled too)
    if (nt.machine !== m.id) {
      Object.assign(nt, { machine: m.id, repo: null, q: '', line: null });
      const q = tellField(view.stree, 'ntQ');
      if (q) q.value = '';
      ntRepos();
    }
    if (draw) renderScreen();
  }
  function ntRepos() {
    const nt = view.ibx.nt;
    if (!nt?.machine) return;
    nt.repoWait = true;
    if (view.repos?.machine !== nt.machine) view.repos = null;
    else view.repos.err = false;
    send({ action: 'repos', machine: nt.machine });
  }
  function ntSearch(input) {
    const nt = view.ibx.nt;
    if (!nt) return;
    const q = String(input.value ?? '').slice(0, 60);
    if (q === nt.q) return;
    nt.q = q;
    renderScreen();
  }
  function ntInput() {
    const nt = view.ibx.nt;
    const f = ntField();
    if (!nt || !f) return;
    try {
      if (f.style) {
        f.style.height = 'auto';
        f.style.height = `${f.scrollHeight}px`;
        settle();
      }
    } catch { /* no layout in this host */ }
    const c = tellCheck(f.value);
    const why = c.ok ? null : c.why;
    if (c.n === nt.n && why === nt.why) return;
    nt.n = c.n;
    nt.why = why;
    renderScreen();
  }
  const headOf = (t) => { const cps = Array.from(String(t).replace(/\s+/g, ' ').trim()); return cps.length > NT_HEAD ? `${cps.slice(0, NT_HEAD).join('')}…` : cps.join(''); };
  // Next: everything is checked again (computer online, project of that computer, text), then the confirm step names it.
  function ntNext() {
    const nt = view.ibx.nt;
    const f = ntField();
    if (!nt || nt.step !== 'edit' || nt.starting || !f) return;
    const c = tellCheck(f.value);
    nt.n = c.n;
    nt.why = c.ok ? null : c.why;
    const m = ntMachineOk(nt);
    const r = ntRepoOk(nt);
    nt.line = !m ? 'Pick a computer' : !r ? 'Pick a project' : null;
    if (c.ok && m && r) {
      nt.step = 'confirm';
      nt.head = headOf(c.text);
    }
    renderScreen();
    if (nt.step === 'confirm') root().querySelector('[data-do="nt-start"]')?.focus();
  }
  function ntEdit() {
    const nt = view.ibx.nt;
    if (!nt || nt.starting) return;
    nt.step = 'edit';
    nt.head = '';
    renderScreen();
    try { ntField()?.focus?.(); } catch { /* fine */ }
  }
  // Start, the only place that sends task-new: once, with confirmed: true, and only for what the confirm named.
  function ntStart() {
    const nt = view.ibx.nt;
    const f = ntField();
    if (!nt || nt.step !== 'confirm' || nt.starting || !f) return;
    const c = tellCheck(f.value);
    const m = ntMachineOk(nt);
    const r = ntRepoOk(nt);
    if (!c.ok || !m || !r || headOf(c.text) !== nt.head) return ntEdit(); // something changed: confirm again
    const at = Date.now();
    nt.starting = at;
    nt.startOn = machineText(m.id, m.name);
    nt.line = null;
    const msg = { action: 'task-new', machine: m.id, repo: `id:${r.id}`, text: c.text };
    if (nt.model) {
      msg.model = nt.model;
      if (nt.effort) msg.effort = nt.effort;
    }
    msg.confirmed = true;
    send(msg);
    setTimeout(() => {
      const n = view.ibx.nt;
      if (n?.starting !== at) return;
      Object.assign(n, { starting: 0, step: 'edit', head: '', line: 'No answer yet. Check the inbox before starting it again.' });
      paint();
    }, START_WAIT_MS);
    renderScreen();
  }
  function ntProjects(nt) {
    if (!nt.machine) return [];
    const rp = view.repos?.machine === nt.machine ? view.repos : null;
    if (!rp?.list) {
      return [rp?.err && !nt.repoWait
        ? { key: 'nt-rerr', html: '<div class="it"><div class="tx"><div class="d warn">Couldn’t read the projects there.</div></div>' +
          '<button class="pill quiet" data-do="nt-repos-again">Try again</button></div>' }
        : { key: 'nt-rwait', html: '<div class="it"><div class="tx"><div class="d">Loading projects…</div></div></div>' }];
    }
    if (!rp.list.length) return [{ key: 'nt-rnone', html: '<div class="it"><div class="tx"><div class="d">No git projects there.</div></div></div>' }];
    const q = nt.q.trim().toLowerCase();
    const hits = rp.list.filter((r) => !q || r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
    let shown = hits.slice(0, REPO_SHOW);
    const sel = rp.list.find((r) => r.id === nt.repo);
    if (sel && !shown.includes(sel)) shown = [sel, ...shown.slice(0, REPO_SHOW - 1)];
    const out = [];
    if (rp.list.length > REPO_SHOW) {
      out.push({ key: 'nt-q', ntQ: true, html: '<input class="fld ntq" type="text" data-key="nt-q" placeholder="Search projects" maxlength="60" ' +
        'aria-label="Search projects" spellcheck="false" autocomplete="off">' });
    }
    for (const r of shown) {
      const on = r.id === nt.repo;
      out.push(S('button', { class: 'it pk', 'aria-pressed': String(on), 'data-do': 'nt-repo', 'data-id': r.id, 'data-key': `ntr:${r.id}` },
        [`<span class="tx">${esc(r.name)}</span>`, `<span class="ck" aria-hidden="true">${IC_CHECK}</span>`], `ntr:${r.id}`));
    }
    if (!shown.length) out.push({ key: 'nt-rnone', html: '<div class="it"><div class="tx"><div class="d">No project matches.</div></div></div>' });
    else if (hits.length > shown.length) out.push({ key: 'nt-rmore', html: `<div class="d sub">${hits.length - shown.length} more; search to narrow</div>` });
    return out;
  }
  function ntTree(b, nt) {
    const confirm = nt.step === 'confirm';
    const busyNow = nt.starting > 0;
    const ms = inboxMachines(b);
    const machines = S('div', { class: 'seg mach', role: 'group', 'aria-label': 'Computer' }, ms.map((m) => {
      const off = machineOff(m);
      return S('button', { 'aria-pressed': String(nt.machine === m.id), 'data-do': 'nt-machine', 'data-id': m.id, 'data-key': `ntm:${m.id}`,
        'aria-disabled': off ? 'true' : null, title: off ? 'Offline' : null },
      [esc(m.id === 'local' ? 'This Mac' : clipText(m.name, 40)) + (off ? ' <span class="off">· offline</span>' : '')], `ntm:${m.id}`);
    }), 'mach', true);
    const where = [
      S('div', { class: 'it col' }, ['<div class="lr"><span>Computer</span></div>', machines], 'nt-where', true),
      ...(nt.machine ? [{ key: 'nt-pl', html: '<div class="it ntl"><div class="tx"><div>Project</div></div></div>' }, ...ntProjects(nt)] : []),
    ];
    const hint = nt.why && nt.why !== 'empty' ? TELL_HINT[nt.why] : '';
    const what = [
      { key: 'ntx', ntField: true, html: '<textarea class="tl ntx" data-key="ntx" rows="3" placeholder="What should it do?" aria-label="Task for the agent" ' +
        'spellcheck="true" autocomplete="off" enterkeyhint="enter"></textarea>' },
      { key: 'nt-hint', html: `<div class="d${hint ? ' warn' : ''}" aria-live="polite">${esc(hint || (tellSheet() ? 'Tap the mic on the keyboard to speak' : ''))}</div>` },
    ];
    const ml = own(Object.fromEntries(MODELS), nt.model, nt.model);
    const optVal = nt.model ? `${ml}${nt.effort ? ` · ${nt.effort}` : ''}` : 'Default model';
    const opts = [S('button', { class: 'it nav', 'data-do': 'nt-opts', 'data-key': 'nt-opts', 'aria-expanded': String(nt.opts), 'aria-label': `Options: ${optVal}` },
      ['<span class="tx">Options</span>', `<span class="val">${esc(optVal)}</span>`, `<span class="chev${nt.opts ? ' on' : ''}" aria-hidden="true">${IC_NEXT}</span>`], 'nt-opts')];
    if (nt.opts) {
      const seg = (key, label, list, cur, off) => S('div', { class: 'seg', role: 'group', 'aria-label': label }, list.map(([v, t]) =>
        S('button', { 'aria-pressed': String(cur === v), 'data-do': key, 'data-v': v, 'data-key': `${key}:${v}`, 'aria-disabled': off ? 'true' : null }, [esc(t)], `${key}:${v}`)), key, true);
      opts.push(S('div', { class: 'it' }, ['<div class="tx"><div>Model</div></div>', seg('nt-model', 'Model', MODELS, nt.model, false)], 'nt-om', true));
      opts.push(S('div', { class: 'it' }, [`<div class="tx"><div>Effort</div>${nt.model ? '' : '<div class="d">With a model</div>'}</div>`,
        seg('nt-effort', 'Effort', [['', 'Default'], ...EFFORTS.map((e) => [e, e])], nt.effort, !nt.model)], 'nt-oe', true));
    }
    const m = ntMachineOk(nt);
    const r = ntRepoOk(nt);
    const ready = Boolean(m && r && nt.n > 0 && !nt.why);
    let foot;
    if (confirm && m && r) {
      const line = `Start on ${machineText(m.id, m.name)} · ${r.name}: ${nt.head}`;
      foot = { key: 'nt-cf', html: '<div class="card ncf" role="group" aria-label="Confirm the new task">' +
        `<div class="t">${esc(line)}</div><div class="s">A new worktree and a Claude chat start there${nt.model ? ` (${esc(optVal)})` : ''}.</div>` +
        `<div class="btns"><button class="pill quiet" data-do="nt-edit"${busyNow ? ' aria-disabled="true"' : ''}>Edit</button>` +
        `<button class="pill blue" data-do="nt-start"${busyNow ? ' aria-disabled="true"' : ''}>${busyNow ? 'Starting…' : 'Start'}</button></div></div>` };
    } else {
      foot = { key: 'nt-foot', html: `<div class="tbar ntb"><span class="tmsg${nt.line ? ' warn' : ''}" aria-live="polite">${esc(nt.line ?? '')}</span>` +
        '<button class="pill quiet" data-do="nt-cancel">Cancel</button>' +
        `<button class="pill blue" data-do="nt-next" aria-keyshortcuts="Meta+Enter"${ready ? '' : ' aria-disabled="true"'}>Next</button></div>` };
    }
    const body = [...sGroup('nt-where', '', where), ...sGroup('nt-what', '', what), ...sGroup('nt-opts', '', opts), foot];
    return screenShell('inbox:new', ' inbox', 'Kadans inbox: New task',
      [topItem('New task'), S('div', { class: confirm ? 'sbody confirming' : 'sbody', id: 'k-sbody' }, body, 'body', true)]);
  }
  function inboxClick(b) {
    if (view.screen !== 'inbox') return false;
    const id = b.dataset.id;
    const nt = view.ibx.nt;
    switch (b.dataset.do) {
      case 'reply': startReply(id); return true;
      case 'ib-open': view.ibx.open = view.ibx.open === id ? null : id; renderScreen(); return true;
      case 'inbox-read': view.ibx.err = false; inboxRead(true); renderScreen(); return true;
      case 'inbox-setup': setupGo(); return true;
      case 'nt-open': ntOpen(); return true;
      case 'nt-cancel': ntClose(); return true;
      case 'nt-machine': ntMachine(id); return true;
      case 'nt-repos-again': if (nt && nt.step === 'edit') { ntRepos(); renderScreen(); } return true;
      case 'nt-repo':
        if (nt && nt.step === 'edit' && !nt.starting && view.repos?.machine === nt.machine && view.repos.list?.some((r) => r.id === id)) {
          nt.repo = id;
          nt.line = null;
          renderScreen();
        }
        return true;
      case 'nt-opts': if (nt) { nt.opts = !nt.opts; renderScreen(); } return true;
      case 'nt-model':
        if (nt && nt.step === 'edit' && MODELS.some(([v]) => v === b.dataset.v)) {
          nt.model = b.dataset.v;
          if (!nt.model) nt.effort = '';
          renderScreen();
        }
        return true;
      case 'nt-effort':
        if (nt && nt.step === 'edit' && nt.model && (b.dataset.v === '' || EFFORTS.includes(b.dataset.v))) {
          nt.effort = b.dataset.v;
          renderScreen();
        }
        return true;
      case 'nt-next': ntNext(); return true;
      case 'nt-edit': ntEdit(); return true;
      case 'nt-start': ntStart(); return true;
      default: return false;
    }
  }

  // ---------- arrange (k32) ----------
  // The owner's order of the live rows (not the idle group, not ended rows). It is drawn at once and held until the
  // served order agrees (the CLI stored it), at most ORDER_HOLD_MS; then the data decides again. Keyboard and drag both
  // end in commitOrder, which sends one reorder with the live ids in their new order.
  const ORDER_HOLD_MS = 10_000;
  function applyOrder(list) {
    const o = view.order;
    if (!o) return list;
    const pos = new Map(o.ids.map((id, i) => [String(id), i]));
    const known = list.filter((a) => pos.has(String(a.id)));
    const agrees = known.every((a, i) => i === 0 || pos.get(String(known[i - 1].id)) < pos.get(String(a.id)));
    if (agrees || Date.now() - o.at > ORDER_HOLD_MS) {
      view.order = null;
      return list;
    }
    return [...known.sort((x, y) => pos.get(String(x.id)) - pos.get(String(y.id))), ...list.filter((a) => !pos.has(String(a.id)))];
  }
  function commitOrder(ids) {
    view.order = { ids: ids.map(String), at: Date.now() };
    const byId = new Map(agentList(view.data?.agents).filter((a) => a && a.id != null).map((a) => [String(a.id), a]));
    const out = ids.map((id) => byId.get(String(id))).filter((a) => a && rowState(a) !== 'ended').map((a) => a.id).slice(0, 50);
    send({ action: 'reorder', ids: out });
    setTimeout(() => render({}), ORDER_HOLD_MS + 50);
  }
  // Alt+Up / Alt+Down on a focused row: one place, at once (keyboard moves never animate). False: not a live row.
  function keyMove(id, dir) {
    const ids = [...view.liveIds];
    const i = ids.findIndex((x) => String(x) === String(id));
    const a = i < 0 ? null : findAgent(ids[i]);
    if (!a || rowState(a) === 'ended') return false;
    const j = i + dir;
    if (j < 0 || j >= ids.length) return true;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setConfirm(null);
    view.picker = null;
    view.pacer = null;
    commitOrder(ids);
    render({});
    return true;
  }

  // Drag: press and hold a live row (250 ms with a mouse or pen, 450 ms with a finger; moving more than SLOP first is a
  // scroll or a click, not a hold). The row lifts (scale, a plate with a shadow under it and its sub-agents), its blob
  // widens its eyes and stretches with the drag speed (a soft spring, so it wobbles a little when the drag stops). The
  // other rows glide out of the way (translate only). Drop: the rows land in the new order (FLIP: drawn in the new
  // order, then each slides from where it was) with a short spring that takes over the release speed, then one reorder
  // goes out. Escape, a pointercancel or a drop well outside the list glides everything back. Reduced motion: no scale
  // or wobble, and every move is instant.
  const HOLD_MS = 250;
  const HOLD_TOUCH_MS = 450;
  const SLOP = 8;
  const drag = { phase: null, id: null, pid: null, x0: 0, y0: 0, timer: null, touch: false, list: null, rect: null, blocks: [],
    from: -1, to: -1, dy: 0, out: false, samples: [], plate: null, av: null, raf: 0, jelly: { s: 0, v: 0, t: 0 }, noClick: 0,
    deferred: false, settleTimer: null };
  const listKids = () => view.tree?.kids?.find((k) => k.key === 'list')?.kids ?? [];
  // The live rows as blocks: a row and what hangs under it (its sub-agents; menus are closed on lift).
  function blocksNow() {
    const live = new Set(view.liveIds.map(String));
    const out = [];
    for (const it of listKids()) {
      const k = String(it.key ?? '');
      if (k.startsWith('row:') && live.has(k.slice(4))) out.push({ id: k.slice(4), nodes: [it.node] });
      else if (!out.length) continue; // k42: the Agents heading sits in the scroll area above the rows
      else if (/^(sub|menu|why):/.test(k) && it.node) out[out.length - 1].nodes.push(it.node);
      else break; // the idle group, another computer's header, Up next: the end of the live rows
    }
    for (const b of out) {
      const last = b.nodes[b.nodes.length - 1];
      b.top = b.nodes[0].offsetTop || 0;
      b.h = Math.max(1, (last.offsetTop || 0) + (last.offsetHeight || 0) - b.top);
      b.shift = 0;
    }
    return out;
  }
  function onDown(e) {
    if (drag.phase || view.screen !== 'main' || view.rename) return;
    if ((e.button ?? 0) !== 0 || e.isPrimary === false) return;
    if (e.target?.closest?.('button, input, [data-do]')) return;
    const key = e.target?.closest?.('.row[data-key]')?.getAttribute('data-key') ?? '';
    const id = key.startsWith('row:') ? key.slice(4) : null;
    const a = id && view.liveIds.some((x) => String(x) === id) ? findAgent(id) : null;
    if (!a || rowState(a) === 'ended') return;
    Object.assign(drag, { phase: 'hold', id, pid: e.pointerId, x0: e.clientX ?? 0, y0: e.clientY ?? 0, touch: e.pointerType === 'touch' });
    drag.timer = setTimeout(lift, drag.touch ? HOLD_TOUCH_MS : HOLD_MS);
  }
  function cancelHold() {
    clearTimeout(drag.timer);
    drag.timer = null;
    if (drag.phase === 'hold') drag.phase = null;
  }
  function lift() {
    drag.timer = null;
    if (drag.phase !== 'hold') return;
    if (!view.shown || document.hidden) { drag.phase = null; return; }
    if (view.confirm || view.picker || view.pacer || view.tapKey) {
      setConfirm(null);
      view.picker = null;
      view.pacer = null;
      view.tapKey = null;
      render({});
    }
    const blocks = blocksNow();
    const from = blocks.findIndex((b) => b.id === drag.id);
    const list = listNode();
    if (from < 0 || !list || blocks.length < 2) { drag.phase = null; return; }
    const r = list.getBoundingClientRect?.() ?? {};
    Object.assign(drag, { phase: 'on', list, blocks, from, to: from, dy: 0, out: false, rect: r, samples: [{ t: Date.now(), y: drag.y0 }] });
    list.classList.add('arranging');
    const b = blocks[from];
    for (const n of b.nodes) n.classList.add('carried');
    b.nodes[0].classList.add('lift');
    try { b.nodes[0].setPointerCapture?.(drag.pid); } catch { /* the pointer is gone */ }
    const plate = make('<div class="plate" aria-hidden="true"></div>');
    if (plate?.style) {
      plate.style.top = `${b.top}px`;
      plate.style.height = `${b.h}px`;
      list.appendChild(plate);
      drag.plate = plate;
      // one frame later, so the plate fades and grows in instead of appearing
      if (typeof requestAnimationFrame === 'function' && motionOk()) requestAnimationFrame(() => plate.classList.add('on'));
      else plate.classList.add('on');
    }
    drag.av = b.nodes[0].querySelector?.('.av') ?? null;
    if (motionOk()) startJelly();
    if (drag.touch) try { window.navigator?.vibrate?.(8); } catch { /* no haptics */ }
  }
  // Past the first or last slot the row follows less and less (rubber band), instead of hitting a wall.
  const band = (over, dim) => (over * dim * 0.55) / (dim + 0.55 * Math.abs(over));
  function onMove(e) {
    if (!drag.phase || e.pointerId !== drag.pid) return;
    if (drag.phase === 'hold') {
      if (Math.hypot((e.clientX ?? 0) - drag.x0, (e.clientY ?? 0) - drag.y0) > SLOP) cancelHold();
      return;
    }
    if (drag.phase !== 'on') return;
    e.preventDefault?.();
    const y = e.clientY ?? drag.y0;
    const now = Date.now();
    drag.samples.push({ t: now, y });
    while (drag.samples.length > 2 && now - drag.samples[0].t > 100) drag.samples.shift();
    const { blocks, from } = drag;
    const b = blocks[from];
    const last = blocks[blocks.length - 1];
    const lo = blocks[0].top - b.top;
    const hi = last.top + last.h - b.h - b.top;
    const raw = y - drag.y0;
    drag.dy = raw < lo ? lo - band(lo - raw, b.h) : raw > hi ? hi + band(raw - hi, b.h) : raw;
    const r = drag.rect ?? {};
    const x = e.clientX ?? drag.x0;
    drag.out = [r.left, r.right, r.top, r.bottom].every(finite) && (x < r.left - 24 || x > r.right + 24 || y < r.top - 40 || y > r.bottom + 40);
    const mid = b.top + drag.dy + b.h / 2;
    let to = from;
    if (!drag.out) {
      to = 0;
      blocks.forEach((o, i) => { if (i !== from && o.top + o.h / 2 < mid) to += 1; });
    }
    drag.to = to;
    const t = `0 ${drag.dy.toFixed(1)}px`;
    for (const n of b.nodes) n.style.translate = t;
    if (drag.plate) {
      drag.plate.style.translate = t;
      drag.plate.classList.toggle('out', drag.out);
    }
    b.nodes[0].classList.toggle('out', drag.out);
    blocks.forEach((o, i) => {
      if (i === from) return;
      const shift = from < i && i <= to ? -b.h : to <= i && i < from ? b.h : 0;
      if (shift === o.shift) return;
      o.shift = shift;
      for (const n of o.nodes) n.style.translate = shift ? `0 ${shift}px` : '';
    });
  }
  function onUp(e) {
    if (!drag.phase || (e.pointerId !== undefined && e.pointerId !== drag.pid)) return;
    if (drag.phase === 'hold') return cancelHold();
    if (drag.phase === 'on') finishDrag(e.type !== 'pointercancel' && !drag.out);
  }
  // The release speed in px/s, from the last ~100 ms of moves (0 when the pointer rested).
  function speed() {
    const s = drag.samples;
    if (s.length < 2 || Date.now() - s[s.length - 1].t > 80) return 0;
    const dt = s[s.length - 1].t - s[0].t;
    return dt > 0 ? ((s[s.length - 1].y - s[0].y) / dt) * 1000 : 0;
  }
  // Keyframes of a damped spring from x0 (px) to 0, starting at v0 (px/s). zeta 1: no overshoot (a cancel); 0.8: a
  // little, because the drop carried momentum.
  function springFrames(x0, v0, zeta, response = 0.3) {
    const w = (2 * Math.PI) / response;
    const dt = 1 / 240;
    let x = x0;
    let v = clamp(v0, -2500, 2500);
    const xs = [x];
    for (let f = 0; f < 60; f++) {
      for (let k = 0; k < 4; k++) {
        v += (-w * w * x - 2 * zeta * w * v) * dt;
        x += v * dt;
      }
      xs.push(x);
      if (Math.abs(x) < 0.3 && Math.abs(v) < 10) break;
    }
    xs[xs.length - 1] = 0;
    return { frames: xs.map((n) => ({ translate: `0 ${n.toFixed(2)}px` })), ms: Math.round(((xs.length - 1) * 1000) / 60) };
  }
  function finishDrag(commit) {
    if (drag.phase !== 'on') return;
    const { blocks, from, list, plate } = drag;
    const to = commit ? drag.to : from;
    const b = blocks[from];
    const v = speed();
    drag.noClick = Date.now();
    stopJelly();
    // Where every node is on screen now: its slot plus its translate (offsetTop ignores the translate).
    const was = new Map();
    blocks.forEach((o, i) => { for (const n of o.nodes) was.set(n, (n.offsetTop || 0) + (i === from ? drag.dy : o.shift)); });
    const plateWas = b.top + drag.dy;
    list.classList.remove('arranging'); // no translate transition while the rows are put in their new places
    for (const n of was.keys()) n.style.translate = '';
    b.nodes[0].classList.remove('lift');
    b.nodes[0].classList.remove('out');
    plate?.classList.remove('out');
    drag.phase = null;
    if (to !== from) {
      const ids = blocks.map((o) => o.id);
      ids.splice(to, 0, ...ids.splice(from, 1));
      const rest = view.liveIds.map(String).filter((id) => !ids.includes(id)); // live rows that are not draggable (ended)
      commitOrder([...ids, ...rest]);
    }
    const deferred = drag.deferred;
    drag.deferred = false;
    if (to !== from || deferred) render({});
    // FLIP: each node slides from where it was to its new slot. The held block uses the spring, the others ease out.
    const anim = motionOk();
    let settleMs = 0;
    for (const [n, y] of was) {
      if (!n.parentNode) continue;
      const d = y - (n.offsetTop || 0);
      if (!anim || Math.abs(d) < 0.5) continue;
      if (b.nodes.includes(n)) {
        const sp = springFrames(d, v, commit ? 0.8 : 1);
        n.animate?.(sp.frames, { duration: sp.ms, easing: 'linear' });
        settleMs = Math.max(settleMs, sp.ms);
      } else n.animate?.([{ translate: `0 ${d}px` }, { translate: '0 0' }], { duration: SHIFT_MS, easing: EASE });
    }
    if (plate) {
      const top = b.nodes[0].parentNode ? b.nodes[0].offsetTop || 0 : b.top;
      plate.style.top = `${top}px`;
      plate.style.translate = '';
      const d = plateWas - top;
      if (anim && Math.abs(d) >= 0.5) {
        const sp = springFrames(d, v, commit ? 0.8 : 1);
        plate.animate?.(sp.frames, { duration: sp.ms, easing: 'linear' });
      }
      plate.classList.remove('on'); // fades and shrinks back with the row
    }
    drag.phase = 'settle';
    const done = () => {
      drag.settleTimer = null;
      for (const n of b.nodes) n.classList.remove('carried');
      plate?.remove();
      drag.plate = null;
      drag.av = null;
      drag.phase = null;
      if (drag.deferred) {
        drag.deferred = false;
        render({});
      }
    };
    if (anim) {
      busy(Math.max(settleMs, 220));
      drag.settleTimer = setTimeout(done, Math.max(settleMs, 220) + 20);
    } else done();
  }
  // The held blob: stretches with the drag speed through a soft spring (it lags, then wobbles a little when the drag
  // stops). Individual transform properties, so the breathe loop and the arrival squish (transform) still compose.
  function startJelly() {
    const j = drag.jelly;
    const av = drag.av;
    Object.assign(j, { s: 0, v: 0, t: 0 });
    if (typeof requestAnimationFrame !== 'function' || !av?.style) return;
    if (drag.raf) cancelAnimationFrame(drag.raf); // the last drop's blob is still settling
    const step = (ts) => {
      const dt = j.t ? Math.min(0.032, (ts - j.t) / 1000) : 1 / 60;
      j.t = ts;
      const target = drag.phase === 'on' ? Math.min(0.09, Math.abs(speed()) * 0.00006) : 0;
      j.v += (260 * (target - j.s) - 16 * j.v) * dt;
      j.s += j.v * dt;
      if (drag.phase !== 'on' && Math.abs(j.s) < 0.002 && Math.abs(j.v) < 0.02) {
        av.style.scale = '';
        drag.raf = 0;
        return;
      }
      av.style.scale = `${(1 - j.s * 0.5).toFixed(4)} ${(1 + j.s).toFixed(4)}`;
      drag.raf = requestAnimationFrame(step);
    };
    drag.raf = requestAnimationFrame(step);
  }
  // On drop the loop keeps running until the blob is at rest (startJelly's step clears the style itself).
  function stopJelly() {
    if (!drag.raf && drag.av?.style) drag.av.style.scale = '';
  }

  // ---------- actions ----------
  function send(msg) {
    if (net.mode === 'http') return httpSend(msg);
    try {
      const h = window.webkit?.messageHandlers?.kadans;
      if (h) h.postMessage(msg);
      else console.log('kadans.send', JSON.stringify(msg));
    } catch (e) {
      console.log('kadans.send failed', e);
    }
  }

  // ---------- phone transport (k27) ----------
  // In the Mac app the page talks to WKWebView's bridge (window.webkit.messageHandlers.kadans). Served by `kadans serve`
  // to a phone there is no bridge: the page pairs once (#pair=<code> -> POST /api/pair -> a token kept in localStorage,
  // the hash cleared), reads GET /api/state every 2 s while it is visible and hands it to render(), and sends the
  // allow-listed actions to POST /api/action, whose answer goes to kadans.result(). A 401 anywhere drops the token and
  // shows "Pair again". Nothing touches the network until a token or a pair code exists. One request at a time: polls
  // never overlap, and actions go out in order.
  const POLL_MS = 2000;
  const TOKEN_KEY = 'kadans.token';
  const HTTP_ACTIONS = new Set(['config-set', 'stop', 'compact', 'approve', 'start', 'replace', 'pace', 'rename', 'reorder', 'agent-send',
    'inbox', 'inbox-reply', 'task-new', 'repos', 'inbox-setup']); // k52: the inbox (k51 allows the first four on the server; k53 adds setup)
  // net.state: 'idle' (bridge) | 'pairing' | 'live' | 'unpaired' (no token, or a 401) | 'offline' (the Mac did not answer)
  // | 'off' (503: phone access is turned off on the Mac) | 'install' (k29: iOS Safari with a code, "Add to Home Screen")
  // net.code: the pair code held back on the 'install' screen until "Use it in Safari instead" (never in the DOM).
  const net = { mode: 'bridge', state: 'idle', token: null, timer: null, inflight: false, chain: null, failures: 0, why: null, code: null };
  // k46: the iPhone app (ios/) hosts this page from its bundle and carries its requests natively (URLSession, the token
  // in the iOS Keychain), so the page never holds the token and needs no CORS. window.webkit.messageHandlers.kadansHttp
  // takes {method, path, body?} (body as JSON text) and answers {status, body}, or rejects when the Mac did not answer.
  // A placeholder stands in for the token, so the HTTP-mode logic here (poll, 401, 503, offline, actions) is unchanged.
  // The app pairs and unpairs natively; it never opens the page with #pair=.
  const nativeHttp = () => { try { return window.webkit?.messageHandlers?.kadansHttp ?? null; } catch { return null; } };
  const store = {
    get() {
      if (nativeHttp()) return 'native';
      try { return window.localStorage?.getItem(TOKEN_KEY) || null; } catch { return null; }
    },
    set(v) {
      if (nativeHttp()) return;
      try { if (v) window.localStorage?.setItem(TOKEN_KEY, v); else window.localStorage?.removeItem(TOKEN_KEY); } catch { /* private mode */ }
    },
  };
  const pageVisible = () => document.visibilityState !== 'hidden' && !document.hidden;
  function deviceName() {
    const ua = String(window.navigator?.userAgent ?? '');
    const n = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : 'Phone';
    return n.slice(0, 40);
  }
  async function call(method, path, body) {
    const nh = nativeHttp();
    if (nh) {
      const r = await nh.postMessage(body !== undefined ? { method, path, body: JSON.stringify(body) } : { method, path });
      let json = null;
      try { json = JSON.parse(r?.body ?? ''); } catch { json = null; }
      return { status: Number(r?.status) || 0, json };
    }
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (net.token) headers.Authorization = `Bearer ${net.token}`;
    const r = await window.fetch(path, { method, headers, cache: 'no-store', credentials: 'omit',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    let json = null;
    try { json = await r.json(); } catch { json = null; }
    return { status: r.status, json };
  }
  function unpaired(why) {
    net.token = null;
    store.set(null);
    net.state = 'unpaired';
    net.why = why;
    view.screen = 'main'; // "Pair again" lives on the main screen, also when the 401 came while Settings was open
    view.stree = null;
    clearTimeout(net.timer);
    net.timer = null;
    paint();
  }
  // Re-render whatever screen is showing (the phone's status card lives on the main screen).
  function paint() {
    if (view.screen === 'main') render({});
    else renderScreen();
  }
  async function pair(code) {
    net.state = 'pairing';
    paint();
    try {
      const r = await call('POST', 'api/pair', { code, name: deviceName() });
      if (r.status === 200 && typeof r.json?.token === 'string' && r.json.token) {
        net.token = r.json.token;
        store.set(net.token);
        net.state = 'live';
        net.why = null;
        return poll();
      }
      return unpaired(r.status === 429 ? 'busy' : 'code');
    } catch {
      return unpaired('offline');
    }
  }
  async function poll() {
    clearTimeout(net.timer);
    net.timer = null;
    if (net.mode !== 'http' || !net.token || net.inflight) return;
    if (net.state === 'install') return; // k29: the Add to Home Screen card waits for the owner, even with a Safari token
    if (!pageVisible()) return; // visibilitychange polls again when the page comes back
    net.inflight = true;
    let next = POLL_MS;
    try {
      const r = await call('GET', 'api/state');
      if (r.status === 401) return unpaired('revoked');
      if (r.status === 503 || r.status === 429) {
        // 503: phone access is off on the Mac; 429: too many requests. Keep the token, read again more slowly.
        net.failures += 1;
        next = Math.min(10_000, POLL_MS * (net.failures + 1));
        const st = r.status === 503 ? 'off' : net.state === 'off' ? 'off' : 'live';
        if (st !== net.state) {
          net.state = st;
          paint();
        }
      } else if (r.status === 200 && r.json && typeof r.json === 'object') {
        const was = net.state;
        net.state = 'live';
        net.failures = 0;
        render(r.json);
        if (was !== 'live' && view.screen !== 'main') renderScreen();
      } else throw new Error(`http ${r.status}`);
    } catch {
      net.failures += 1;
      if (net.state !== 'offline') {
        net.state = 'offline';
        paint();
      }
      next = Math.min(10_000, POLL_MS * net.failures); // 2, 4, 6 … up to 10 s while the Mac is away
    } finally {
      net.inflight = false;
    }
    if (net.token && pageVisible()) net.timer = setTimeout(poll, next);
  }
  // Only the actions the server allows go out; the app-only ones are handled here or dropped.
  function httpSend(msg) {
    if (!msg || typeof msg !== 'object') return;
    let m = msg;
    if (m.action === 'autopace') m = { action: 'config-set', key: 'autopace', value: String(m.on === true) };
    if (m.action === 'retry' || m.action === 'check-again') { poll(); return; }
    if (!HTTP_ACTIONS.has(m.action) || !net.token) return;
    const go = async () => {
      try {
        const r = await call('POST', 'api/action', m);
        if (r.status === 401) return unpaired('revoked');
        if (r.json && typeof r.json === 'object') actionResult(r.json);
        else actionResult({ action: m.action, id: m.id, ok: false, why: 'Kadans on your Mac did not accept this' });
      } catch {
        actionResult({ action: m.action, id: m.id, ok: false, why: 'Couldn’t reach your Mac' });
      }
      poll();
    };
    net.chain = (net.chain ?? Promise.resolve()).then(go, go);
    return net.chain;
  }
  function onVisibility() {
    if (document.hidden) {
      cancelHold(); // a hold must not lift while the page is away
      if (drag.phase === 'on') finishDrag(false);
    }
    scheduleBlinks();
    if (net.mode !== 'http') return;
    if (pageVisible()) poll();
    else {
      clearTimeout(net.timer);
      net.timer = null;
    }
  }
  // k29: iOS keeps a home-screen web app's storage apart from Safari's, so a token saved in Safari (where the camera opens
  // the pair link) is not seen by the app added afterwards. Only iOS Safari sets navigator.standalone to false; Android
  // and desktop browsers leave it undefined and share storage with an installed app, so they pair at once as before.
  const displayMode = (m) => { try { return window.matchMedia?.(`(display-mode: ${m})`)?.matches === true; } catch { return false; } };
  const standaloneApp = () => window.navigator?.standalone === true || displayMode('standalone') || displayMode('fullscreen');
  const iosSafari = () => window.navigator?.standalone === false && !standaloneApp();
  // The manifest link: manifest.webmanifest?pair=<code> makes the app added to the Home Screen start at /#pair=<code>.
  function manifestCode(code) {
    try {
      const l = document.querySelector('link[rel="manifest"]');
      l?.setAttribute?.('href', code ? `manifest.webmanifest?pair=${encodeURIComponent(code)}` : 'manifest.webmanifest');
    } catch { /* no manifest link */ }
  }
  function clearHash() {
    try {
      if (/[#&]pair=/.test(window.location.hash ?? '')) window.history?.replaceState?.(null, '', window.location.pathname + window.location.search);
    } catch { /* no history API */ }
  }
  // "Use it in Safari instead": pair here with the held code, as before k29; the plain manifest comes back, so an app
  // added later does not start on a spent code.
  function pairHere() {
    const code = net.code;
    if (net.state !== 'install' || !code) return;
    net.code = null;
    manifestCode(null);
    clearHash();
    pair(code);
  }
  // HTTP mode only: top-level page, http(s), no bridge. Starts pairing or polling; with neither a code nor a token it
  // shows "Pair again" and makes no request. In iOS Safari a code is held back for the home-screen app (the hash stays,
  // in case an iOS version adds the page URL instead of the manifest's start_url) and nothing is sent.
  function startHttp() {
    let code = null;
    try {
      const m = /[#&]pair=([A-Za-z2-7]{8,64})\b/.exec(window.location.hash ?? '');
      if (m) code = m[1].toUpperCase();
    } catch { /* no location */ }
    net.mode = 'http';
    document.documentElement.dataset.shell = 'phone';
    net.token = store.get();
    if (code && iosSafari()) {
      net.code = code;
      manifestCode(code);
      net.state = 'install';
      net.why = null;
      return paint();
    }
    clearHash();
    // The home-screen app opens its start_url (/#pair=<code>) on every cold launch; once it holds a token that code is
    // spent, so it is ignored rather than sent again (a 401 would drop the good token).
    if (code && net.token && standaloneApp()) code = null;
    if (code) return pair(code);
    if (net.token) {
      net.state = 'live';
      return poll();
    }
    return unpaired('new');
  }
  function wantsHttp() {
    try {
      if (window.webkit?.messageHandlers?.kadans) return false;
      if (window.top !== window) return false; // dev.html's frame (its bridge stand-in comes after load)
      if (nativeHttp()) return true; // k46: the iPhone app (its own kadans-panel: scheme)
      if (!/^https?:$/.test(window.location.protocol)) return false;
      return !/[?&](debugFrames|dev)\b/.test(window.location.search);
    } catch { return false; }
  }
  // The phone's own status card: pairing, pair again, or the Mac not answering. Null when live.
  // The iOS Share glyph (a box with an arrow up), so "Tap Share" points at the button people know.
  const SHARE_ICON = '<svg class="share" width="13" height="16" viewBox="0 0 13 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 1.5v8.5M3.8 4.2 6.5 1.5l2.7 2.7"/>' +
    '<path d="M4.3 6.5H2.8a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h7.4a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H8.7"/></svg>';
  function phoneCard() {
    if (net.mode !== 'http') return null;
    if (net.state === 'pairing') return { key: 'net', html: msgCard('wait', 'Pairing…', 'Connecting to Kadans on your Mac.', '') };
    if (net.state === 'install') {
      return { key: 'net', html: msgCard('idle', 'Add Kadans to your Home Screen',
        `Tap Share ${SHARE_ICON}, then Add to Home Screen. Open it from there.`,
        '<button class="pill quiet" data-do="pair-here" data-key="pair-here">Use it in Safari instead</button>') };
    }
    if (net.state === 'unpaired') {
      const why = { code: 'That code didn’t work: each code works once, within 10 minutes. ', busy: 'Too many tries: wait a minute. ',
        offline: 'Couldn’t reach your Mac. ' }[net.why] ?? '';
      const title = net.why === 'new' ? 'Pair this phone' : 'Pair again';
      return { key: 'net', html: msgCard('idle', title, `${esc(why)}Scan the code in Kadans on your Mac (Settings\u00a0›\u00a0Phone).`, '') };
    }
    if (net.state === 'off') {
      return { key: 'net', html: '<div class="note net-off" role="status"><i class="dot-gray"></i><span>Phone access is off on your Mac</span></div>' };
    }
    if (net.state === 'offline') {
      return { key: 'net', html: '<div class="note net-off" role="status"><i class="dot-orange"></i><span>Can’t reach your Mac · trying again</span></div>' };
    }
    return null;
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

  // k27: touch screens have no hover. A tap on a row (not on one of its buttons) shows its actions, a tap on the same
  // row or anywhere else hides them again. A button inside the open row keeps it open.
  const touchUi = () => {
    if (net.mode === 'http') return true;
    try { return matchMedia('(hover: none)').matches; } catch { return false; }
  };
  function onTap(e, b) {
    if (!touchUi() || view.screen !== 'main') return false;
    const row = e.target?.closest?.('.row[data-key]') ?? null;
    const key = row && !row.classList?.contains('grp') ? row.getAttribute('data-key') : null;
    if (b && key && key === view.tapKey) return false; // a button in the open row
    const next = !b && key && key !== view.tapKey ? key : null;
    if (next === view.tapKey) return false;
    view.tapKey = next;
    if (!b) {
      view.picker = null; // a tap elsewhere also closes an open menu
      view.pacer = null;
      render({});
      return true;
    }
    return false; // the button's own handler renders
  }
  function onClick(e) {
    if (drag.noClick && Date.now() - drag.noClick < 500) { drag.noClick = 0; return; } // the release of a drag
    if (e.target?.classList?.contains?.('rn')) return; // typing a name
    if (e.target?.classList?.contains?.('tl')) return; // k49: typing a message
    const b = e.target.closest('[data-do]');
    if (onTap(e, b)) return;
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
      case 'rename': startRename(id); return;
      case 'tell': startTell(id); return;
      case 'tell-send': sendTell(); return;
      case 'tell-cancel': endTell(); return;
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
    const back = (screen, sub) => {
      const land = () => {
        if (sub) { // k43: a second screen goes back to the first Settings screen, focus on the row that opened it
          goSub(null, 'back');
          root().querySelector(`[data-do="sub"][data-id="${sub}"]`)?.focus();
          return;
        }
        const from = view.screen;
        go(screen, 'back');
        root().querySelector(screen !== 'main' ? '[data-do="review"]' : from === 'inbox' ? '[data-do="inbox"]' : '[data-do="settings"]')?.focus();
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
      case 'settings': view.sub = null; go('settings'); send({ action: 'settings' }); root().querySelector('[data-do="back"]')?.focus(); return true;
      case 'sub':
        if (view.screen === 'settings' && Object.hasOwn(SUBS, b.dataset.id ?? '')) {
          goSub(b.dataset.id);
          root().querySelector('[data-do="back"]')?.focus();
        }
        return true;
      case 'update-auto':
        view.updWant = { on: b.dataset.v === 'true', at: Date.now() };
        send({ action: 'update-auto', on: view.updWant.on });
        renderScreen();
        return true;
      case 'update-install': send({ action: 'update-install' }); return true;
      case 'review':
        view.from = view.screen;
        go('review');
        send({ action: 'install-preview' });
        root().querySelector('[data-do="apply"], [data-do="back"]')?.focus();
        return true;
      case 'back':
        if (view.screen === 'inbox' && view.ibx.sub) ntClose(); // k52: New task goes back to the Inbox
        else if (view.screen === 'settings' && view.sub) back('settings', view.sub);
        else back(view.screen === 'review' ? view.from : 'main');
        return true;
      case 'set': {
        const k = b.dataset.k;
        if (!k || b.dataset.v == null) return true;
        setValue(k, b.dataset.v);
        renderScreen();
        return true;
      }
      case 'uninstall': view.uninstallOpen = !view.uninstallOpen; renderScreen(); return true;
      case 'phone-on': case 'phone-off':
        view.phoneWant = { on: b.dataset.do === 'phone-on', at: Date.now() };
        send({ action: b.dataset.do });
        renderScreen();
        return true;
      case 'phone-pair': send({ action: 'phone-pair' }); return true;
      case 'pair-here': pairHere(); return true;
      case 'phone-revoke': if (b.dataset.id) send({ action: 'phone-revoke', id: b.dataset.id }); return true;
      case 'comp-open': compOpen(true); return true;
      case 'comp-close': compOpen(false); return true;
      case 'comp-add': compSubmit(); return true;
      case 'comp-remove': if (b.dataset.id) { Object.assign(view.comp, { confirm: b.dataset.id, err: null }); renderScreen(); } return true;
      case 'comp-keep': view.comp.confirm = null; renderScreen(); return true;
      case 'comp-remove-go':
        if (b.dataset.id && !view.comp.removing) {
          Object.assign(view.comp, { confirm: null, removing: b.dataset.id, err: null });
          send({ action: 'computers-remove', id: b.dataset.id });
          renderScreen();
        }
        return true;
      case 'inbox': // k52: the bottom bar's Inbox pushes the Inbox screen and reads it at once
        if (view.screen !== 'main') return true;
        if (view.tell) endTell(false);
        go('inbox');
        inboxRead(true);
        root().querySelector('[data-do="back"]')?.focus();
        return true;
      case 'apply': view.applyConfirm = true; renderScreen(); root().querySelector('[data-do="apply-go"]')?.focus(); return true;
      case 'apply-cancel': view.applyConfirm = false; renderScreen(); root().querySelector('[data-do="apply"]')?.focus(); return true;
      case 'apply-go':
        view.applyConfirm = false;
        view.applying = true;
        view.applyFailed = false;
        renderScreen();
        send({ action: 'install-apply' });
        return true;
      default: return inboxClick(b); // k52
    }
  }

  // Sliders: the number follows while dragging; one config-set when released (not one per step).
  function onInput(e) {
    const r = e.target;
    if (r?.classList?.contains?.('ntx')) { ntInput(); return; } // k52: the new task's text
    if (r?.getAttribute?.('data-key') === 'nt-q') { ntSearch(r); return; } // k52: the project search
    if (r?.classList?.contains?.('tl')) { tellInput(); return; } // k49
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
    // k52: the new task's text owns its keys too: Cmd-Enter goes on to the confirm step (never straight to a start),
    // Escape goes back to the Inbox (the text goes with it).
    if (view.screen === 'inbox' && view.ibx.nt && e.target?.classList?.contains?.('ntx')) {
      if (e.isComposing) return;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault?.(); ntNext(); } else if (e.key === 'Escape') { e.preventDefault?.(); ntClose(); }
      return;
    }
    // k49: the message field owns every key: Cmd-Enter (Ctrl-Enter) sends, Escape cancels, Enter is a new line, and no
    // key reaches the row shortcuts or closes the popover. Dictation and input methods compose first (isComposing).
    if (view.tell && e.target?.classList?.contains?.('tl')) {
      if (e.isComposing) return;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault?.(); sendTell(); } else if (e.key === 'Escape') { e.preventDefault?.(); endTell(); }
      return;
    }
    // k32: the rename input owns Enter and Escape; a held row owns Escape; Alt+Up/Down moves the focused row.
    if (view.rename && e.target?.classList?.contains?.('rn')) {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault?.(); endRename(true); } else if (e.key === 'Escape') { e.preventDefault?.(); endRename(false); }
      return;
    }
    // k41: the add form: Enter adds, Escape closes it.
    const fk = e.target?.getAttribute?.('data-key');
    if (view.comp.open && (fk === 'comp-name' || fk === 'comp-code') && !e.isComposing) {
      if (e.key === 'Enter') { e.preventDefault?.(); compSubmit(); } else if (e.key === 'Escape') { e.preventDefault?.(); compOpen(false); }
      return;
    }
    if (drag.phase && e.key === 'Escape') {
      if (drag.phase === 'on') { e.preventDefault?.(); finishDrag(false); return; }
      cancelHold();
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && view.screen === 'main' && !drag.phase) {
      const key = document.activeElement?.getAttribute?.('data-key') ?? '';
      if (key.startsWith('row:') && keyMove(key.slice(4), e.key === 'ArrowUp' ? -1 : 1)) e.preventDefault?.();
      return;
    }
    if (e.key !== 'Escape') return;
    if (view.screen !== 'main') {
      if (view.screen === 'inbox' && view.tell) endTell(); // k52: an open reply closes before the screen goes back
      else if (view.screen === 'inbox' && view.ibx.nt?.step === 'confirm' && !view.ibx.nt.starting) ntEdit();
      else if (view.applyConfirm) {
        view.applyConfirm = false;
        renderScreen();
      } else if (view.uninstallOpen) {
        view.uninstallOpen = false;
        renderScreen();
      } else onScreenClick({ dataset: { do: 'back' } });
      return;
    }
    if (view.tell) {
      endTell(); // k49: Escape on the composer's buttons cancels it too, before anything else
    } else if (view.closeAll) {
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
    el.addEventListener('pointerdown', onDown);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    // once a row is lifted on a touch screen the page must not scroll under the finger (touch-action cannot change
    // mid-gesture; a non-passive touchmove can still stop it)
    document.addEventListener('touchmove', (e) => { if (drag.phase === 'on') e.preventDefault(); }, { passive: false });
    el.addEventListener('contextmenu', (e) => { if (drag.phase) e.preventDefault(); });
    el.addEventListener('dblclick', onDbl);
    // the system took the pointer (a gesture, a window change): put the row back
    el.addEventListener('lostpointercapture', (e) => { if (drag.phase === 'on' && e.pointerId === drag.pid) finishDrag(false); });
    el.addEventListener('focusout', (e) => { if (view.rename && e.target?.classList?.contains?.('rn')) endRename(false); });
    document.addEventListener('pointerup', onPointer);
    document.addEventListener('pointercancel', onPointer);
    el.addEventListener('scroll', (e) => { if (e.target.id === 'k-list') fade(e.target); }, true);
    document.addEventListener('keydown', onKey);
    el.addEventListener('mouseover', onArrive);
    el.addEventListener('focusin', onArrive);
    el.addEventListener('mouseleave', () => { view.hoverKey = null; });
    document.addEventListener('visibilitychange', onVisibility);
    // Taps outside the panel (the phone's page margin) close an open row too.
    document.addEventListener('click', (e) => { if (view.tapKey && !el.contains(e.target)) { view.tapKey = null; render({}); } });
    if (wantsHttp()) startHttp();
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
    inboxDrop(); // k52: first, while the screen tree still holds the fields (the new task's text goes too)
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
    view.phoneWant = null;
    view.comp = { open: false, adding: false, removing: null, confirm: null, err: null, at: 0 };
    view.tapKey = null;
    view.rename = null;
    if (view.tell) { const f = tellField(); if (f) f.value = ''; }
    view.tell = null;
    view.telling = null;
    tellViewport(false);
    view.ibx = ibxFresh();
    view.repos = null;
    view.titles.clear();
    view.awayTitles.clear();
    view.order = null;
    setConfirm(null);
  }
  // The host says when the popover opens and closes (WKWebView does not reliably report document.hidden for a closed
  // NSPopover): closed, the blink timer stops and nothing animates.
  function visible(on) {
    // k27/k28: closing the popover on Settings ends the app's device polling; reopening on Settings starts it again.
    if (net.mode === 'bridge' && settingsScreen() && (on !== false) !== view.shown) send({ action: on !== false ? 'settings' : 'settings-closed' });
    // k52: closing the popover drops an open reply or new task (no draft kept); opening it reads the inbox (the badge)
    if (on === false && view.screen === 'inbox') inboxDrop();
    if (on !== false && !view.shown && Date.now() - view.ibx.at >= INBOX_REOPEN_MS) inboxRead(true);
    view.shown = on !== false;
    if (!view.shown) {
      cancelHold();
      if (drag.phase === 'on') finishDrag(false);
    }
    if (!view.shown && view.rename) endRename(false); // closing the popover never saves a half-typed name
    if (!view.shown && view.tell) endTell(false); // k49: closing the panel drops the message; no draft is kept anywhere
    // Opening or closing the popover drops focus: a row focused earlier (a click, or a restore after a refresh) would
    // otherwise come back highlighted, ring and actions showing, the next time the popover opens.
    const a = document.activeElement;
    if (a && a !== document.body && typeof a.blur === 'function') a.blur();
    view.focusKey = null;
    scheduleBlinks();
  }
  // k42: the host's room for the popover on this screen (px): the panel's max height. Only the scroll area gives way.
  function cap(px) {
    const n = Number(px);
    if (!Number.isFinite(n) || n < 120) return;
    view.cap = Math.round(n);
    document.documentElement.style?.setProperty?.('--cap', `${view.cap}px`);
    if (view.tree) settle();
  }
  // net: read-only view of the phone transport for tests ({ mode, state, token }).
  const netState = () => ({ mode: net.mode, state: net.state, token: net.token, why: net.why, polling: net.timer !== null, tapKey: view.tapKey });
  window.kadans = { version: 1, render, send, result: actionResult, reset, assignShapes, frames, visible, cap, patchStats, blinkState, staleReading, netState, startHttp,
    arrangeState: () => ({ phase: drag.phase, from: drag.from, to: drag.to, out: drag.out, order: view.order?.ids ?? null, rename: view.rename?.id ?? null }) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
