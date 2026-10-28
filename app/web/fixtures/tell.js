// k49: Tell an agent. A working and an idle chat in Orca on this Mac, one chat on another computer whose flags allow
// send, and one that waits on a question (no Tell). The `after` hooks open the composer (inline on the Mac, the bottom
// sheet in the phone shell), type an invented message, or show a refusal. Invented data only.
(function (K) {
  const N = KF.N, M = KF.M, A = KF.agent;
  const orca = (terminal) => ({ terminal, worktree: 'main', repo: 'Tidepool', state: 'working', title: null, ambiguous: false });
  const agents = () => [
    A('fx-0501', { title: 'Brake hooks for the Stop event', titleSource: 'session', orca: orca('term_a') }),
    A('fx-0502', { project: 'Fernway', status: 'idle', lastSeen: N - 4 * M, stateSince: N - 4 * M, title: 'Clean up unused CSS',
      titleSource: 'session', orca: orca('term_b') }),
    A('fx-0503', { project: 'Quarry', status: 'needs-you', title: 'Pick a login provider', titleSource: 'session', orca: orca('term_c') }),
    A('remote:other:tab-1:1', { source: 'orca', machine: 'other', project: 'Fernway', status: 'working', stateSince: N - 9 * M,
      lastSeen: N - 5000, model: null, tokens: null, startedAt: null, pid: null, agentType: 'claude', title: 'Make the rain sound loop without a gap',
      titleSource: 'prompt', canStop: true, canCompact: false, canSend: true, canPace: false, canReplace: false, machineStale: false, machineOffline: false,
      orca: { terminal: null, worktree: null, repo: null, state: 'working', title: null, ambiguous: false } }),
  ];
  const base = () => ({ status: KF.status(), agents: agents() });
  const host = (doc) => (doc && doc.defaultView) || window;
  const open = (doc, id) => KF.act(doc, 'tell', id);
  // Types into the open field and lets the panel see it (the counter, the hint, the height).
  const type = (doc, text) => {
    const f = doc.querySelector('textarea.tl');
    if (!f) return;
    f.value = text;
    if (typeof Event === 'function' && f.dispatchEvent) f.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const phone = (doc) => { if (doc.documentElement) doc.documentElement.dataset.shell = 'phone'; };
  const MSG = 'Run the tests again before the commit,\nand be careful with the migrations.';

  K.KADANS_FIXTURES.tell = Object.assign(base(), { after(doc) { open(doc, 'fx-0501'); type(doc, MSG); } });
  K.KADANS_FIXTURES.tell_remote = Object.assign(base(), { after(doc) { open(doc, 'remote:other:tab-1:1'); } });
  K.KADANS_FIXTURES.tell_hint = Object.assign(base(), { after(doc) { open(doc, 'fx-0502'); type(doc, '/clear the context first'); } });
  K.KADANS_FIXTURES.tell_refused = Object.assign(base(), {
    after(doc) {
      host(doc).kadans.result({ action: 'agent-send', id: 'fx-0502', ok: false, why: 'not sent: That chat has unsent text: nothing was sent' });
    },
  });
  K.KADANS_FIXTURES.tell_phone = Object.assign(base(), { after(doc) { phone(doc); host(doc).kadans.render({}); open(doc, 'fx-0501'); type(doc, MSG); } });
  K.KADANS_FIXTURES.tell_phone_remote = Object.assign(base(), { after(doc) { phone(doc); host(doc).kadans.render({}); open(doc, 'remote:other:tab-1:1'); } });
})(window);
