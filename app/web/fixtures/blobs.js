// k9a: distinct blobs and closing idle chats. fx-0001 and fx-0004 hash to the same shape (star); the older one keeps it.
// One idle chat under 2 h (its own Close), and an "N idle" group of three, two of which Kadans can close.
(function (K) {
  const N = KF.N, M = KF.M, A = KF.agent;
  const agents = [
    A('fx-0004', { project: 'Pebble', model: 'claude-haiku-4-5', tokens: 8000, startedAt: N - 21 * M, title: 'Translate onboarding copy' }),
    A('fx-0001', { title: 'Brake hooks for the Stop event', startedAt: N - 11 * M }),
    A('fx-0002', { project: 'Quarry', model: 'claude-sonnet-4-6', tokens: 54000, startedAt: N - 6 * M, status: 'needs-you',
      title: 'Pick a login provider' }),
    A('fx-0006', { project: 'Orchard', model: 'claude-sonnet-4-6', tokens: 22000, startedAt: N - 65 * M, lastSeen: N - 12 * M,
      status: 'idle', title: 'Draft release notes' }),
    // quiet for 2+ hours: the "3 idle" group; the last one has no pid and no terminal, so Close all leaves it out
    A('fx-0010', { project: 'Quarry', tokens: 31000, startedAt: N - 9 * 60 * M, lastSeen: N - 5 * 60 * M, status: 'idle', stale: true,
      title: 'Sketch the pricing page' }),
    A('orca:term_fx11', { source: 'orca', project: 'Orchard', model: null, tokens: null, startedAt: null, lastSeen: N - 26 * 60 * M,
      status: 'idle', stale: true, pid: null, title: 'Batch run for the newsletter',
      orca: { terminal: 'term_fx11', worktree: 'orchard-main', repo: 'Orchard', state: 'done', title: 'Batch run for the newsletter', ambiguous: false } }),
    A('fx-0012', { project: 'Fernway', tokens: 9000, startedAt: N - 8 * 60 * M, lastSeen: N - 3 * 60 * M, status: 'idle', stale: true,
      pid: null, title: 'Check the font licences' }),
  ];
  const status = KF.status({ queue: KF.queue({ ready: 0, next: [] }) });
  K.KADANS_FIXTURES.blobs = { status, agents };
  // "Close 2 idle chats?" open on the group.
  K.KADANS_FIXTURES.blobs_closeall = { status, agents, after: (doc) => doc.querySelector('[data-do="close-all"]')?.click() };
  // "Close this chat?" open on the idle row (under 2 h).
  K.KADANS_FIXTURES.blobs_close = { status, agents, after: (doc) => KF.act(doc, 'close', 'fx-0006') };
})(window);
