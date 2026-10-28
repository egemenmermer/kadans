// polish-2: agent rows with one primary action and a More menu. Four chats in Orca on this Mac (working, needs you,
// idle with a big context, slowed) and one paired computer (kasa), long titles. `row_actions` / `row_actions_wait` show the working /
// the needs-you row as the pointer's hover does (a snapshot has no pointer); `row_actions_menu` opens the idle row's More menu;
// `row_actions_phone` is the phone's sheet for the same row. Invented data only.
(function (K) {
  const N = KF.N, M = KF.M, A = KF.agent;
  const orca = (terminal, state) => ({ terminal, worktree: 'main', repo: 'Tidepool', state, title: null, ambiguous: false });
  const agents = () => [
    A('fx-0801', { title: 'Make the rain sound loop without a gap', titleSource: 'session', orca: orca('term_a', 'working') }),
    A('fx-0802', { project: 'Quarry', status: 'needs-you', title: 'Decide how the importer handles duplicate rows', titleSource: 'session',
      orca: orca('term_b', 'needs-you') }),
    A('fx-0803', { project: 'Fernway', status: 'idle', lastSeen: N - 12 * M, stateSince: N - 12 * M, title: 'Clean up the unused CSS in the site',
      titleSource: 'session', orca: orca('term_c', 'idle'),
      context: { tokens: 152000, window: 200000, pct: 76, advice: 'now', why: 'Idle 12 min: next turn re-reads all 152k' } }),
    A('fx-0804', { project: 'Tidepool', pace: { mode: 'slow', until: null }, title: 'Write the brake hooks for the Stop event',
      titleSource: 'session', orca: orca('term_d', 'working') }),
  ];
  const base = () => ({ status: KF.status(), agents: agents(),
    inbox: { ready: true, hub: 'on', machines: [{ id: 'local', name: 'This Mac' }, { id: 'env-0001', name: 'kasa' }], items: [] } });
  const host = (doc) => (doc && doc.defaultView) || window;
  // What the pointer's hover does to one row's actions (panel.css .row:hover .acts): a snapshot has no pointer and no
  // focus. (The row's own hover plate is drawn by panel.js from the pointer, so it is not lit here.)
  const lit = (doc, id) => {
    if (!doc.head || !doc.createElement) return;
    const st = doc.createElement('style');
    st.textContent = `.row[data-key="row:${id}"] .acts { opacity: 1; visibility: visible; transition: none; }`;
    doc.head.appendChild(st);
  };
  const phone = (doc) => { if (doc.documentElement) doc.documentElement.dataset.shell = 'phone'; host(doc).kadans.render({}); };
  const more = (doc, id) => doc.querySelector(`[data-do="more"][data-id="${id}"]`)?.click();

  K.KADANS_FIXTURES.row_actions = Object.assign(base(), { after(doc) { lit(doc, 'fx-0801'); } });
  K.KADANS_FIXTURES.row_actions_wait = Object.assign(base(), { after(doc) { lit(doc, 'fx-0802'); } });
  K.KADANS_FIXTURES.row_actions_menu = Object.assign(base(), { after(doc) { more(doc, 'fx-0803'); } });
  // Near the bottom of a full list (the popover at its cap): the menu of the lowest row must stay whole.
  const many = () => agents().concat([5, 6, 7, 8, 9].map((n) => A(`fx-081${n}`, { project: 'Quarry', status: 'idle', lastSeen: N - (20 + n) * M,
    stateSince: N - (20 + n) * M, title: `Sort the import batch ${n}`, titleSource: 'session', orca: orca(`term_${n}`, 'idle') })));
  K.KADANS_FIXTURES.row_actions_low = Object.assign(base(), { agents: many(), after(doc) { more(doc, 'fx-0819'); } });
  K.KADANS_FIXTURES.row_actions_phone = Object.assign(base(), { after(doc) { phone(doc); more(doc, 'fx-0803'); } });
})(window);
