// k54: Continue on kasa. Two chats in Orca on this Mac and the inbox on with one paired computer (kasa), or two (the
// computer menu). The `after` hooks tap the action and play the bridges' answers: step 1, Writing handoff…, the late line,
// step 2 (a matched project, or a choice), and the phone's bottom sheet. Invented data only.
(function (K) {
  const N = KF.N, M = KF.M, A = KF.agent;
  const orca = (terminal) => ({ terminal, worktree: 'main', repo: 'Tidepool', state: 'working', title: null, ambiguous: false });
  const agents = () => [
    A('fx-0601', { title: 'Make the rain sound loop without a gap', titleSource: 'session', orca: orca('term_a') }),
    A('fx-0602', { project: 'Fernway', status: 'idle', lastSeen: N - 4 * M, stateSince: N - 4 * M, title: 'Clean up unused CSS',
      titleSource: 'session', orca: orca('term_b') }),
  ];
  const machines = (two) => [{ id: 'local', name: 'This Mac' }, { id: 'env-0001', name: 'kasa' }].concat(two ? [{ id: 'env-0003', name: 'PC' }] : []);
  const base = (two) => ({ status: KF.status(), agents: agents(), inbox: { ready: true, hub: 'on', machines: machines(two), items: [] } });
  const host = (doc) => (doc && doc.defaultView) || window;
  const tap = (doc, sel) => doc.querySelector(sel)?.click();
  const phone = (doc) => { if (doc.documentElement) doc.documentElement.dataset.shell = 'phone'; host(doc).kadans.render({}); };
  const ID = 'fx-0601';
  const ask = (doc) => KF.act(doc, 'handoff', ID); // polish-2: in the row's More menu
  const asked = (doc) => {
    ask(doc);
    tap(doc, `[data-do="ho-ask"][data-id="${ID}"]`);
    host(doc).kadans.result({ action: 'handoff-ask', id: ID, ok: true, why: '' });
  };
  const ready = (doc, repo) => {
    asked(doc);
    host(doc).kadans.result({ action: 'handoff-status', id: ID, ok: true, why: '', handoff: { ok: true, state: 'ready', askedAt: N - 4 * M,
      branch: 'feat/rain-loop', path: 'docs/handoff/2026-10-27-rain-loop.md', machines: [{ id: 'env-0001', name: 'kasa' }],
      machine: { id: 'env-0001', name: 'kasa' }, repo,
      repos: [{ id: 'repo-0001', name: 'rain-sounds' }, { id: 'repo-0002', name: 'rain-sounds-web' }, { id: 'repo-0003', name: 'tools' }] } });
  };

  K.KADANS_FIXTURES.handoff = Object.assign(base(), { after(doc) { ask(doc); } });
  K.KADANS_FIXTURES.handoff_pick = Object.assign(base(true), { after(doc) { ask(doc); } });
  K.KADANS_FIXTURES.handoff_writing = Object.assign(base(), { after(doc) { asked(doc); } });
  K.KADANS_FIXTURES.handoff_late = Object.assign(base(), {
    after(doc) {
      asked(doc);
      host(doc).kadans.result({ action: 'handoff-status', id: ID, ok: true, why: '', handoff: { ok: true, state: 'late', askedAt: N - 16 * M } });
    },
  });
  K.KADANS_FIXTURES.handoff_ready = Object.assign(base(), { after(doc) { ready(doc, 'repo-0001'); } });
  K.KADANS_FIXTURES.handoff_choose = Object.assign(base(), { after(doc) { ready(doc, null); } });
  K.KADANS_FIXTURES.handoff_phone = Object.assign(base(), { after(doc) { phone(doc); ask(doc); } });
  K.KADANS_FIXTURES.handoff_phone_ready = Object.assign(base(), { after(doc) { phone(doc); ready(doc, 'repo-0001'); } });
})(window);
