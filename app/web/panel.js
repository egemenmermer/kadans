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
    applyFailed: false, dragging: false, deferred: false, lastHtml: '', sScroll: 0,
    // k9a motion: seen = row key -> time it first showed (enter animation); gauge = last fill / tail per limit;
    // firstAt = first paint (never animated); slide = settings push {dir, at}; once = one-shot classes for the next render;
    // leaving = an exit animation is running. Close idle: closeAll = "Close N idle chats?" open; bulk = the run in progress.
    seen: new Map(), gauge: new Map(), firstAt: 0, slide: null, once: new Set(), leaving: false, hoverKey: null, focusKey: null,
    closeAll: false, closeTimer: null, bulk: null };

  // ---------- motion (k9a) ----------
  // Calm and short: 120-260 ms, transform and opacity only (the gauge fill may sweep its width). Nothing moves on the first
  // paint, in the 300 ms after it (fixture `after` clicks, snapshots), with reduced motion, or while the page is hidden.
  const ENTER_MS = 260;
  const LEAVE_MS = 150;
  const OUT_MS = 130;
  const reduced = () => {
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  };
  const motionOk = () => !reduced() && !document.hidden && view.firstAt > 0 && Date.now() - view.firstAt > 300;
  // Enter animation for a keyed element: only for a key not on screen in the last render. A re-render while it is still
  // running keeps it going (negative delay) instead of jumping to the end; existing rows never re-animate.
  let seenNext = null;
  function enter(key) {
    const now = Date.now();
    let t = view.seen.get(key);
    if (t === undefined) t = motionOk() ? now : -Infinity;
    seenNext?.set(key, t);
    const age = now - t;
    if (!(age < ENTER_MS)) return ['', ''];
    return [' enter', age > 0 ? ` style="--d:-${Math.round(age)}ms"` : ''];
  }

  // ---------- gauge card ----------
  const LIMIT_NAME = { five_hour: '5-hour limit', seven_day: '7-day limit' };
  const limitName = (n) => own(LIMIT_NAME, n, String(n ?? 'Limit').replace(/_/g, ' '));

  function resetText(l, now) {
    if (l.ended || !finite(l.resetsAt) || l.resetsAt <= now) return 'Resetting';
    const left = l.resetsAt - now;
    return left < DAY ? `Resets in ${dur(left)}` : `Resets ${dayTime(l.resetsAt)}`;
  }

  let limTargets = [];
  function limitHtml(l, now, showTarget) {
    const pct = clamp(Math.round(finite(l.pct) ? l.pct : 0), 0, 100);
    const brakeLike = l.state === 'brake' || l.state === 'early';
    const hasTail = !l.ended && l.state !== 'unknown' && finite(l.projection) && (brakeLike || !thin(l));
    const end = brakeLike ? 100 : hasTail ? clamp(Math.round(l.projection), pct, 100) : pct;
    const tail = hasTail && end > pct
      ? `<div class="ahead ${brakeLike ? 'orange' : 'blue'}" style="left:${pct}%;right:${100 - end}%"></div>` : '';
    const mark = showTarget && finite(l.target)
      ? `<div class="mark" style="left:${clamp(l.target, 0, 100)}%" title="Target ${Math.round(l.target)}%"></div>` : '';
    const name = limitName(l.name);
    limTargets.push({ key: `${view.account}|${limTargets.length}|${l.name}`, w: pct, tl: tail ? pct : null, tr: tail ? 100 - end : null });
    const pace = finite(l.needle) && finite(l.projection) && !l.ended
      ? `Pace ${l.needle.toFixed(2)} pts/min · about ${Math.round(l.projection)}% at the reset` : '';
    return `<div class="lim"><div class="lrow"><span class="k">${esc(name)}</span><span class="r">${esc(resetText(l, now))}</span>` +
      `<span class="p">${pct}%</span></div>` +
      `<div class="track" role="meter" aria-label="${esc(name)} used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"` +
      `${pace ? ` title="${esc(pace)}"` : ''}><div class="fill" style="width:${pct}%"></div>${tail}${mark}</div></div>`;
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

  function accountLabel(a, i, accounts) {
    if (a.own) return 'Mine';
    const others = accounts.filter((x) => !x.own);
    return others.length > 1 ? `Other ${others.indexOf(a) + 1}` : 'Other';
  }

  // Returns { html, mode } where mode drives what else the panel shows.
  function gauge(status, now) {
    const err = status ? status.error : { code: 'read_failed', at: now };
    const accounts = Array.isArray(status?.accounts) ? status.accounts : [];
    if (err && err.code === 'no_claude') {
      return { mode: 'no_claude', html: msgCard('wait', 'Claude Code not found',
        'Kadans works with the Claude Code CLI. Install it, sign in, then open this panel again.',
        '<button class="pill blue" data-do="install-help">How to install</button><button class="pill" data-do="check-again">Check again</button>') };
    }
    if (err && err.code !== 'no_data') {
      const ago = finite(err.at) ? Math.round((now - err.at) / MIN) : null;
      const when = ago === null ? '' : ago < 1 ? ' just now' : ` ${ago} min ago`;
      return { mode: 'error', html: msgCard('slow', "Can't read usage data",
        `kadans status failed${esc(when)}. Agents keep running; pacing is off until this works.`,
        '<button class="pill blue" data-do="retry">Try again</button><button class="pill" data-do="copy">Copy details</button>') };
    }
    if (!accounts.length) {
      return { mode: 'no_data', html: msgCard('idle', 'No data yet',
        "Kadans reads your limit after Claude's next reply. Send any message in Claude Code.") };
    }
    let acct = accounts.find((a) => a.key === view.account) ?? accounts[0];
    view.account = acct.key;
    const seg = accounts.length > 1
      ? `<div class="acct" role="group" aria-label="Account">${accounts.map((a, i) =>
        `<button aria-pressed="${a === acct}" data-do="account" data-id="${esc(a.key)}" title="${esc(a.label ?? '')}">${esc(accountLabel(a, i, accounts))}</button>`).join('')}</div>`
      : '';
    const limits = (Array.isArray(acct.limits) ? acct.limits : []).filter((l) => l && l.state !== 'nodata');
    const [dot, note] = noteFor(acct, limits, status.queue, now);
    const body = limits.length ? limits.map((l) => limitHtml(l, now, limits.length > 1)).join('') : '';
    return { mode: acct.state, gas: acct.state === 'gas' && acct.own === true,
      html: `<div class="card">${seg}${body}<div class="note"${body ? '' : ' style="margin-top:0"'}><i class="dot-${dot}"></i><span>${esc(note)}</span></div></div>` };
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

  const canStopAgent = (a) => finite(a.pid) || (Boolean(a.orca?.terminal) && !a.orca?.ambiguous);

  function actsHtml(a, st, tasks) {
    const id = a.id;
    if (view.confirm === id) {
      const replace = view.kind === 'replace';
      const word = replace ? 'Replace' : view.kind === 'close' ? 'Close' : 'Stop';
      return `<div class="acts on"><button class="sure${replace ? ' go' : ''}" data-do="${replace ? 'replace-go' : 'stop'}" ` +
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
    return `<div class="acts${view.picker === id || view.pacer === id ? ' on' : ''}">${first}` +
      `${btn('replace', id, IC.swap, 'Replace', { disabled: Boolean(why), why, menu: true })}${last}</div>`;
  }

  function pickerHtml(a, tasks) {
    const [ec, es] = enter(`pick:${a.id}`);
    return `<div class="pick${ec}"${es} role="menu" aria-label="Replace with">` +
      `<div class="pick-h">Stop this agent and start</div>${tasks.map((t) =>
        `<button role="menuitem" data-do="pick" data-id="${esc(a.id)}" data-task="${esc(t.id)}" data-key="pick:${esc(a.id)}:${esc(t.id)}" title="${esc(t.text)}">` +
        `<span class="nm">${esc(t.text)}</span><span class="pv">${esc(t.project ?? '')}</span></button>`).join('')}</div>`;
  }

  // "Pace this agent" menu. resetAt: the own account's next reset, for "Pause until reset".
  function pacerHtml(a, resetAt, slowS) {
    const item = (mode, until, name, hint) =>
      `<button role="menuitem" data-do="pace-set" data-id="${esc(a.id)}" data-mode="${mode}"${until ? ` data-until="${until}"` : ''} ` +
      `data-key="pace:${esc(a.id)}:${mode}:${until ?? ''}"><span class="nm">${esc(name)}</span><span class="pv">${esc(hint)}</span></button>`;
    const [ec, es] = enter(`pace:${a.id}`);
    return `<div class="pick${ec}"${es} role="menu" aria-label="Pace this agent"><div class="pick-h">Pace this agent</div>` +
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

  function agentRows(list, now, tasks) {
    let html = '';
    for (const a of list) {
      const st = rowState(a);
      const title = titleOf(a);
      let [pre, preText] = prefixOf(st, a, now);
      const swap = view.confirm === a.id && view.kind === 'replace' ? tasks.find((t) => String(t.id) === String(view.task)) : null;
      if (swap) [pre, preText] = [`Replace with: ${esc(swap.text)}`, `Replace with: ${swap.text}. `];
      const ask = view.confirm === a.id && view.kind === 'close';
      if (ask) [pre, preText] = ['<span class="ask">Close this chat?</span>', 'Close this chat? '];
      const parts = [a.project, st === 'ended' ? null : family(a.model), tokens(a.tokens),
        st === 'ended' || !finite(a.startedAt) ? null : dur(now - a.startedAt)].filter(Boolean).map(String);
      const line = swap || ask ? '' : parts.join(' · ');
      const [ec, es] = enter(`row:${a.id}`);
      const cls = `row${st === 'ended' ? ' ended' : ''}${view.confirm === a.id || view.picker === a.id || view.pacer === a.id ? ' hov' : ''}${ec}`;
      html += `<div class="${cls}"${es} tabindex="0" data-key="row:${esc(a.id)}" title="${esc(title)}" aria-label="${esc(`${title}. ${preText}${line}`)}">` +
        `${avatar(shapeFor(a.id), FACE[st])}<div class="tx"><div class="nm">${esc(title)}</div><div class="pv">${pre}${esc(line)}</div></div>` +
        `${actsHtml(a, st, tasks)}</div>`;
      if (view.picker === a.id) html += pickerHtml(a, tasks);
      if (view.pacer === a.id) {
        const st0 = view.data?.status;
        const slowS = finite(st0?.pace?.slowSeconds) ? st0.pace.slowSeconds : 20;
        html += pacerHtml(a, ownReset(st0), slowS);
      }
      if (st === 'ended') continue;
      for (const s of Array.isArray(a.subagents) ? a.subagents : []) {
        if (s.status !== 'running') continue;
        const name = s.description || s.type || 'Subagent';
        const [sc, ss] = enter(`sub:${s.id}`);
        html += `<div class="row child${sc}"${ss} tabindex="0" data-key="sub:${esc(s.id)}" title="${esc(name)}" aria-label="${esc(`Subagent: ${name}`)}">` +
          `${avatar(shapeFor(s.id), 'work', 22)}<div class="tx"><div class="nm">${esc(name)}</div></div></div>`;
      }
    }
    return html;
  }

  // ---------- up next and bottom bar ----------
  const URGENCY = { urgent: 'Urgent', week: 'This week', idle: 'When idle' };
  function upNext(queue, gas) {
    const next = Array.isArray(queue?.next) ? queue.next : [];
    if (!next.length) return '';
    return '<div class="sh"><span>Up next</span></div>' + next.map((t) => {
      const u = own(URGENCY, t.urgency, URGENCY.week);
      const line = [t.project ? esc(t.project) : null, t.urgency === 'urgent' ? `<span class="urgent">${u}</span>` : u].filter(Boolean).join(' · ');
      const ok = t.approved ? '' : ' · needs your OK';
      const b = t.approved
        ? `<button class="pill${gas ? ' blue' : ''}" data-do="start" data-id="${esc(t.id)}">Start</button>`
        : `<button class="pill${gas ? '' : ' blue'}" data-do="approve" data-id="${esc(t.id)}">Approve</button>`;
      return `<div class="row" title="${esc(t.text)}"><div class="tx"><div class="nm">${esc(t.text)}</div><div class="pv">${line}${ok}</div></div>${b}</div>`;
    }).join('');
  }

  function bottom(status, mode) {
    const live = typeof status?.autopace === 'boolean';
    const on = live && status.autopace && mode !== 'no_claude';
    const sw = live
      ? `<button class="sw" role="switch" aria-checked="${on}" aria-label="Auto-pace" data-do="autopace"></button>`
      : `<button class="sw" role="switch" aria-checked="false" aria-disabled="true" aria-label="Auto-pace (${SOON})" title="${SOON}"></button>`;
    return `<div class="bottom"><div class="toggle">${sw}<span aria-hidden="true">Auto-pace</span></div><div class="sp">` +
      `<button class="ic" title="Theme" aria-label="Theme" data-do="theme">${IC.theme}</button>` +
      `<button class="ic" title="Settings" aria-label="Settings" data-do="settings">${IC.gear}</button></div></div>`;
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

  const sItem = (title, desc, ctl, cls = '') =>
    `<div class="it${cls}"><div class="tx"><div>${title}</div>${desc ? `<div class="d">${desc}</div>` : ''}</div>${ctl ?? ''}</div>`;
  function sSwitch(key, label, disabled) {
    const on = cfgVal(key) === 'true';
    return disabled
      ? `<button class="sw" role="switch" aria-checked="false" aria-disabled="true" aria-label="${esc(label)} (not available)"></button>`
      : `<button class="sw" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-do="set" data-k="${esc(key)}" ` +
        `data-v="${!on}" data-key="set:${esc(key)}"></button>`;
  }
  function sSeg(key, label, opts) {
    const cur = cfgVal(key);
    return `<div class="seg" role="group" aria-label="${esc(label)}">${opts.map(([v, t]) =>
      `<button aria-pressed="${cur === v}" data-do="set" data-k="${esc(key)}" data-v="${esc(v)}" data-key="set:${esc(key)}:${esc(v)}">${esc(t)}</button>`).join('')}</div>`;
  }
  function sSlider(key, title, desc, min, max, unit) {
    const raw = Number(cfgVal(key));
    const v = Number.isFinite(raw) ? clamp(raw, min, max) : min;
    const fill = Math.round(((v - min) / (max - min)) * 1000) / 10;
    return `<div class="it col"><div class="lr"><span>${esc(title)}</span><span class="num" data-num="${esc(key)}">${v}${unit}</span></div>` +
      `<input type="range" min="${min}" max="${max}" step="1" value="${v}" aria-label="${esc(title)}" data-set="${esc(key)}" style="--p:${fill}%" ` +
      `data-unit="${esc(unit)}" data-key="rng:${esc(key)}">${desc ? `<div class="d">${desc}</div>` : ''}</div>`;
  }

  // Whole-hour slider for an "HH:MM" setting (kickoff.from / kickoff.to); sends "HH:00".
  const hh = (n) => `${String(n).padStart(2, '0')}:00`;
  function sHour(key, title) {
    const cur = String(cfgVal(key) ?? '');
    const m = cur.match(/^([01]\d|2[0-3]):[0-5]\d$/);
    const v = m ? Number(m[1]) : 0;
    const fill = Math.round((v / 23) * 1000) / 10;
    return `<div class="it col"><div class="lr"><span>${esc(title)}</span><span class="num" data-num="${esc(key)}">${esc(m ? cur : '–')}</span></div>` +
      `<input type="range" min="0" max="23" step="1" value="${v}" aria-label="${esc(title)}" aria-valuetext="${esc(m ? cur : hh(v))}" ` +
      `data-set="${esc(key)}" data-fmt="hour" style="--p:${fill}%" data-key="rng:${esc(key)}"></div>`;
  }
  const sliderText = (r) => (r.dataset.fmt === 'hour' ? hh(r.value) : `${r.value}${r.dataset.unit ?? ''}`);
  const sliderValue = (r) => (r.dataset.fmt === 'hour' ? hh(r.value) : String(r.value));

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

  function settingsHtml() {
    const d = view.data ?? {};
    const cfg = d.config && typeof d.config === 'object' ? d.config : null;
    if (!cfg) {
      return topBar('Settings') + '<div class="sbody"><div class="card"><div class="msg"><div><div class="t">Loading settings…</div>' +
        '<div class="s">If this stays, <span class="code">kadans config get</span> is failing.</div></div></div></div></div>';
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
    let h = topBar('Settings') + '<div class="sbody" id="k-sbody">';

    h += '<div class="gl">Limits</div><div class="sgrp">' +
      sItem('Windows to watch', '', sSeg('limits', 'Windows to watch', LIMIT_OPTS)) +
      `<div class="d sub">Auto uses what Claude Code reports.${today}</div>` +
      sSlider('targets.five_hour', '5-hour target', 'Aim to end the window this full.', 50, 100, '%') +
      sSlider('targets.seven_day', '7-day target', '', 50, 100, '%') +
      sSlider('slack', 'Spare margin', 'Spare quota counts only when the projection is this far below target.', 0, 30, ' pts') +
      sSlider('warmup.minutes', 'Warm-up time', '', 0, 60, ' min') +
      sSlider('warmup.pct', 'Warm-up usage', `No brake before ${esc(m ?? '?')} min into a window or ${esc(p ?? '?')}% used.`, 0, 50, '%') +
      '</div>';

    h += '<div class="gl">Auto-pace</div><div class="sgrp">' +
      sItem('Auto-pace', 'Nudges agents when usage runs hot and slows them if the brake holds 10 min. Same as the switch in the panel.',
        sSwitch('autopace', 'Auto-pace')) + '</div>';

    const ko = cfg.kickoff && typeof cfg.kickoff === 'object' ? cfg.kickoff : null;
    if (ko) {
      const koOn = cfgVal('kickoff.enabled') === 'true';
      h += '<div class="gl">Next window</div><div class="sgrp">' +
        sItem('Start the next window for me', 'When your 5-hour window has ended, Kadans sends Claude one tiny Haiku message, so the next ' +
          'window starts right away. Your own account only; uses a little quota. Off until you turn it on.',
        sSwitch('kickoff.enabled', 'Start the next window for me'));
      if (koOn) {
        h += sHour('kickoff.from', 'Allowed from') + sHour('kickoff.to', 'Allowed until') +
          '<div class="it col un"><div class="d">Kadans does not set up background jobs itself. Run this once in a terminal; it adds a ' +
          'macOS job that checks every 15 minutes:</div>' +
          `<pre class="cmd" tabindex="0" aria-label="Command to run">${esc(cmd)} kickoff schedule --apply</pre>` +
          `<div class="d">Without <span class="code">--apply</span> it only shows the job. To remove it: <span class="code">kickoff unschedule --apply</span>.</div></div>`;
      }
      h += '</div>';
    }

    h += '<div class="gl">Accounts</div><div class="sgrp">' +
      (ownKey
        ? sItem('Use spare quota', 'Your account (<span class="code">~/.claude</span>). Starts approved tasks when quota would go unused. Off until you turn it on.',
          sSwitch(`accounts.${ownKey}.gas`, 'Use spare quota on your account'))
        : '') +
      others.map((a, i) => sItem(`Use spare quota · ${others.length > 1 ? `Other ${i + 1}` : 'Other account'}`,
        '<span class="warn">Not available: Kadans never spends quota on an account that is not yours. Brake and pacing still work.</span>',
        sSwitch('', 'Use spare quota on another account', true))).join('') + '</div>';

    h += '<div class="gl">Notifications</div><div class="sgrp">' +
      sItem('Allow notifications', "When you'd run out early, and when Kadans starts or finishes a task. Off by default.",
        sSwitch('notify', 'Allow notifications')) + '</div>';

    h += '<div class="gl">General</div><div class="sgrp">' +
      sItem('Status line language', 'The line under Claude Code’s prompt.', sSeg('lang', 'Status line language', [['en', 'English'], ['tr', 'Türkçe']])) +
      '</div>';

    h += '<div class="gl">Claude Code</div><div class="sgrp">' +
      sItem('Hooks in Claude Code', inst ? (n ? `${plural(n, 'hook', 'hooks')} to add or update.` : 'Status line and hooks are installed.') : 'Not checked yet.',
        n ? '<button class="pill blue" data-do="review" data-key="review">Review</button>' : inst ? '<span class="chip ok">Installed</span>' : '') +
      sItem('Remove from Claude Code', 'Takes out only Kadans hooks and restores your old status line.',
        `<button class="pill danger" data-do="uninstall" data-key="uninstall" aria-expanded="${view.uninstallOpen}">Uninstall…</button>`);
    if (view.uninstallOpen) {
      h += '<div class="it col un"><div class="d">Kadans does not remove itself from here. Run this in a terminal; it saves a backup of ' +
        'settings.json first, then takes out the status line and hooks and puts your old status line back:</div>' +
        `<pre class="cmd" tabindex="0" aria-label="Command to run">${esc(cmd)} uninstall --apply</pre>` +
        `<div class="d">Without <span class="code">--apply</span> it only shows the change.</div></div>`;
    }
    h += '</div></div>';
    return h;
  }

  function reviewHtml() {
    const inst = view.data?.install && typeof view.data.install === 'object' ? view.data.install : null;
    const groups = inst?.changed ? hookGroups(inst) : [];
    const fresh = groups.some((g) => g.hook === 'statusline' && g.kind === 'add');
    let h = topBar(fresh ? 'Connect to Claude Code' : 'Update hooks') + '<div class="sbody" id="k-sbody">';
    if (!inst) {
      h += '<div class="card"><div class="msg"><div><div class="t">Checking Claude Code settings…</div>' +
        '<div class="s">If this stays, <span class="code">kadans install</span> is failing (for example a broken settings.json).</div></div></div></div></div>';
      return h;
    }
    if (!groups.length) {
      const msg = view.applied ? 'Applied; a backup of settings.json was saved first.' : 'Nothing to change.';
      return h + `<div class="card"><div class="msg">${avatar('square', 'done', 26)}<div><div class="t">Hooks are up to date</div>` +
        `<div class="s">${msg} Claude Code picks the hooks up in new sessions.</div></div></div></div></div>` +
        '<div class="foot"><button class="pill blue" data-do="back" data-key="done">Done</button></div>';
    }
    h += `<p class="lead">Kadans adds ${groups.length === 1 ? 'this' : 'these'} to <span class="code">${esc(tildeFile(inst.file))}</span>. Here is everything that changes.</p>` +
      '<div class="chg">' + groups.map((g) => {
        const ev = g.events.length > 1 ? `<div class="ev">${esc(g.events.join(', '))}</div>` : '';
        return `<div class="r"><span class="k ${g.kind === 'add' ? 'add' : 'del'}" aria-hidden="true">${g.kind === 'add' ? '+' : '−'}</span>` +
          `<div class="tx"><div>${esc(own(HOOK_TITLE, g.hook, g.hook ?? g.events[0]))}</div><div class="d">${esc(own(HOOK_DESC, g.hook, g.summary ?? ''))}</div>${ev}</div></div>`;
      }).join('') +
      '<div class="r"><span class="k keep" aria-hidden="true">=</span><div class="tx"><div>Everything else stays</div>' +
      '<div class="d">Orca’s hooks and your other settings are untouched. A backup is saved first.</div></div></div></div></div>';
    if (view.applying) h += '<div class="foot"><span class="l">Applying…</span></div>';
    else if (view.applyConfirm) {
      h += '<div class="foot"><span class="l">Write settings.json now?</span>' +
        '<button class="pill" data-do="apply-cancel" data-key="apply-cancel">Cancel</button>' +
        '<button class="pill blue" data-do="apply-go" data-key="apply-go">Apply</button></div>';
    } else {
      h += `<div class="foot"><span class="l">${view.applyFailed ? '<span class="warn">Not applied. Run kadans install in a terminal to see why.</span>' : 'Undo any time in Settings'}</span>` +
        '<button class="pill blue" data-do="apply" data-key="apply">Apply</button></div>';
    }
    return h;
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
    view.lastHtml = '';
    const status = view.data.status ?? null;
    const now = finite(status?.now) ? status.now : Date.now();
    limTargets = [];
    const g = gauge(status, now);
    const { all, old, live } = split(now);
    const tasks = startable(status?.queue);
    if (view.confirm && !all.some((a) => a.id === view.confirm)) view.confirm = null;
    if (view.confirm && view.kind === 'replace' && !tasks.some((t) => String(t.id) === String(view.task))) view.confirm = null;
    if (view.picker && (!all.some((a) => a.id === view.picker) || !tasks.length)) view.picker = null;
    if (view.pacer && !all.some((a) => a.id === view.pacer && ['working', 'idle'].includes(rowState(a)))) view.pacer = null;
    if (!old.length) view.closeAll = false;
    const subs = (a, rank) => (rowState(a) === 'ended' || !Array.isArray(a.subagents) ? []
      : a.subagents.filter((x) => x && x.status === 'running').map((x) => ({ id: x.id, startedAt: x.startedAt, rank })));
    shapeMap = assignShapes([...live.map((a) => ({ id: a.id, startedAt: a.startedAt, rank: 0 })), ...live.flatMap((a) => subs(a, 1)),
      ...old.map((a) => ({ id: a.id, startedAt: a.startedAt, rank: 2 })), ...old.flatMap((a) => subs(a, 3))]);

    seenNext = new Map();
    let html = g.html;
    if (g.mode !== 'no_claude') {
      html += `<div class="sh"><span>Agents</span><span>${live.length || ''}</span></div>`;
      const group = old.length ? groupHtml(old, now) + (view.idleOpen ? agentRows(old, now, tasks) : '') : '';
      html += all.length
        ? `<div class="list" id="k-list">${agentRows(live, now, tasks)}${group}</div>`
        : `<div class="empty">${avatar('egg', 'idle')}<div><div class="nm">No agents running</div>` +
          '<div class="s">They show up here when Claude Code starts one.</div></div></div>';
    }
    if (g.mode !== 'no_claude' && g.mode !== 'no_data' && g.mode !== 'error') html += upNext(status?.queue, g.gas);
    html += bottom(status, g.mode);
    if (g.mode !== 'no_claude') html = hookCard(view.data.install) + html;

    const el = root();
    const focusKey = keyOf(document.activeElement);
    const oldList = document.getElementById('k-list');
    if (oldList) view.scroll = oldList.scrollTop;
    const [pc, ps] = slideIn('back');
    el.innerHTML = `<div class="panel${pc}"${ps} role="dialog" aria-label="Kadans">${html}</div>`;
    view.seen = seenNext;
    seenNext = null;
    view.once.clear();
    const list = document.getElementById('k-list');
    if (list) {
      list.scrollTop = view.scroll;
      fade(list);
    }
    sweepGauge(el);
    if (view.focusPick) {
      view.focusPick = false;
      el.querySelector('.pick [data-do="pick"], .pick [data-do="pace-set"]')?.focus();
    } else if (focusKey) restoreFocus(el, focusKey);
    if (!view.firstAt) view.firstAt = Date.now();
    reportSize();
    scheduleBlinks();
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
    const [ec, es] = enter('grp');
    return `<div class="row grp${ec}"${es} data-key="grp"><button class="grp-t" data-do="idle" data-key="idle-group" aria-expanded="${view.idleOpen}">` +
      `${avatar('egg', 'idle', 22)}<span class="tx"><span class="nm">${n} idle</span><span class="pv">${line}</span></span>` +
      `${view.closeAll && closable ? '' : `<span class="chev${view.once.has('chev') ? ' turn' : ''}" aria-hidden="true">${IC.chev}</span>`}</button>${right}</div>`;
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
  // Panel-level push: 'in' for Settings / Review, 'back' for the screen you return to. Survives a rebuild mid-way.
  function slideIn(dir) {
    const sl = view.slide;
    if (!sl || sl.dir !== dir) return ['', ''];
    const age = Date.now() - sl.at;
    if (age >= ENTER_MS) {
      view.slide = null;
      return ['', ''];
    }
    return [` ${dir}`, age > 0 ? ` style="--d:-${Math.round(age)}ms"` : ''];
  }

  // Gauge: the new markup carries the new width; put the old one back, flush styles, then set the new one so the CSS
  // transition runs. A forced reflow, not requestAnimationFrame (that never fires in the offscreen snapshot window).
  function sweepGauge(el) {
    const prev = view.gauge;
    const nodes = el.querySelectorAll('.lim');
    const moves = [];
    view.gauge = new Map(limTargets.map((t) => [t.key, t]));
    if (!motionOk()) return;
    limTargets.forEach((t, i) => {
      const p = prev.get(t.key);
      const node = nodes[i];
      if (!p || !node) return;
      const fill = node.querySelector('.fill');
      const tail = node.querySelector('.ahead');
      if (fill && p.w !== t.w) {
        fill.style.width = `${p.w}%`;
        moves.push(() => { fill.style.width = `${t.w}%`; });
      }
      if (tail && p.tl !== null && (p.tl !== t.tl || p.tr !== t.tr)) {
        tail.style.left = `${p.tl}%`;
        tail.style.right = `${p.tr}%`;
        moves.push(() => { tail.style.left = `${t.tl}%`; tail.style.right = `${t.tr}%`; });
      }
    });
    if (!moves.length) return;
    void el.offsetWidth;
    moves.forEach((f) => f());
  }

  // Blobs: a small squish and blink when the pointer or focus reaches a row (once per arrival, not per re-render).
  function poke(av) {
    if (!av || !motionOk() || av.closest?.('.ended')) return;
    av.classList.remove('poke');
    void av.getBoundingClientRect();
    av.classList.add('poke');
    setTimeout(() => av.classList.remove('poke'), 420);
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

  // Working agents blink now and then: each row gets its own random 4-9 s, all driven by one shared timer that is off
  // when nothing works, with reduced motion, on the settings screens and while the page is hidden.
  const blinks = { due: new Map(), timer: null };
  const nextBlink = (now) => now + 4000 + Math.random() * 5000;
  function workingBlobs() {
    return [...root().querySelectorAll('.row[data-key] > .av.f-work')].map((av) => [av.parentElement.dataset.key, av]);
  }
  function scheduleBlinks() {
    clearTimeout(blinks.timer);
    blinks.timer = null;
    if (view.screen !== 'main' || reduced() || document.hidden) return;
    const now = Date.now();
    const due = new Map();
    for (const [key] of workingBlobs()) due.set(key, blinks.due.get(key) ?? nextBlink(now));
    blinks.due = due;
    if (!due.size) return;
    blinks.timer = setTimeout(blinkDue, Math.max(50, Math.min(...due.values()) - now));
  }
  function blinkDue() {
    blinks.timer = null;
    const now = Date.now();
    for (const [key, av] of workingBlobs()) {
      if ((blinks.due.get(key) ?? Infinity) > now + 30) continue;
      blinks.due.set(key, nextBlink(now));
      if (av.classList.contains('poke')) continue;
      av.classList.add('blink');
      setTimeout(() => av.classList.remove('blink'), 220);
    }
    scheduleBlinks();
  }

  // Settings and Review: rebuilt only when their markup changes, and never while a slider is held (the 5 s
  // refresh would drop the drag).
  function renderScreen() {
    if (view.dragging) {
      view.deferred = true;
      return;
    }
    const inner = view.screen === 'review' ? reviewHtml() : settingsHtml();
    if (inner === view.lastHtml) return;
    const el = root();
    const focusKey = keyOf(document.activeElement);
    const old = document.getElementById('k-sbody');
    if (old && view.lastHtml) view.sScroll = old.scrollTop;
    view.lastHtml = inner;
    const label = view.screen === 'review' ? 'Hooks in Claude Code' : 'Kadans settings';
    const [pc, ps] = view.slide?.dir === 'in' ? slideIn('in') : slideIn('back');
    el.innerHTML = `<div class="panel screen${view.screen === 'settings' ? ' tall' : ''}${pc}"${ps} role="dialog" aria-label="${label}">${inner}</div>`;
    scheduleBlinks();
    const body = document.getElementById('k-sbody');
    if (body) body.scrollTop = view.sScroll;
    if (focusKey) restoreFocus(el, focusKey);
    reportSize();
  }

  // dir: 'in' (Settings, Review) or 'back' (the screen you return to).
  function go(screen, dir = 'in') {
    view.slide = motionOk() ? { dir, at: Date.now() } : null;
    view.screen = screen;
    view.lastHtml = '';
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
    if (!target && action === 'pick') target = find(`replace-go:${id.slice(0, id.lastIndexOf(':'))}`);
    if (!target && (action === 'stop' || action === 'cancel' || action === 'replace-go')) {
      target = find(`confirm:${id}`) ?? find(`close:${id}`) ?? find(`replace:${id}`) ?? find(`row:${id}`);
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

  function reportSize() {
    const p = root().firstElementChild;
    const h = p ? Math.ceil(p.getBoundingClientRect().height) : 0;
    if (h && h !== view.height) {
      view.height = h;
      send({ action: 'size', height: h });
    }
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
      case 'close-all': setConfirm(null); setCloseAll(true); break;
      case 'close-all-cancel': setCloseAll(false); break;
      case 'close-all-go': closeAllGo(); return;
      case 'cancel': setConfirm(null); break;
      case 'stop': setConfirm(null); send({ action: 'stop', id }); break;
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
        if (view.leaving) return;
        if (view.idleOpen && motionOk() && b.closest) {
          // Collapse: the group's rows fade out and the chevron turns back, then the list closes.
          b.setAttribute('aria-expanded', 'false');
          for (let n = b.closest('.row.grp')?.nextElementSibling; n; n = n.nextElementSibling) n.classList.add('leave');
          view.leaving = true;
          setTimeout(() => { view.leaving = false; view.idleOpen = false; render({}); }, LEAVE_MS);
          return;
        }
        view.idleOpen = !view.idleOpen;
        if (view.idleOpen && motionOk()) view.once.add('chev');
        break;
      }
      case 'open': send({ action: 'open', id }); return;
      case 'dismiss': {
        view.dismissed.add(id);
        send({ action: 'dismiss', id });
        const row = b.closest?.('.row');
        if (row && motionOk()) {
          row.classList.add('leave');
          setTimeout(() => render({}), LEAVE_MS);
          return;
        }
        break;
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
        view.lastHtml = '';
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

  // dev.html only: start a fixture from a clean slate (render keeps keys a payload leaves out).
  function reset() {
    view.data = {};
    view.pending = {};
    view.screen = 'main';
    view.lastHtml = '';
    view.seen = new Map();
    view.gauge = new Map();
    view.firstAt = 0;
    view.slide = null;
    view.closeAll = false;
    view.bulk = null;
    view.idleOpen = false;
  }
  window.kadans = { version: 1, render, send, reset, assignShapes };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
