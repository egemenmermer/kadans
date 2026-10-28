// Two accounts, two limits, every row state, more rows than fit (the list scrolls).
(function (K) {
  const N = KF.N, M = KF.M, A = KF.agent;
  K.KADANS_FIXTURES.many = {
    status: KF.status({ accounts: [
      KF.acct({ limits: [
        KF.lim({ pct: 34, projection: 70, resetsAt: N + 185 * M, timeLeft: 185 * M }),
        KF.lim({ name: 'seven_day', pct: 52, rate: 0.006, needle: 0.006, projection: 88, target: 98,
          resetsAt: N + 2.5 * 24 * 60 * M, timeLeft: 2.5 * 24 * 60 * M }),
      ] }),
      KF.acct({ key: 'bbbbbbbbbbbb', label: 'Other account', configDir: null, own: false, state: 'gas', limits: [KF.lim({ state: 'gas', pct: 12, projection: 30 })] }),
    ] }),
    agents: [
      ...KF.base(),
      A('fx-0004', { project: 'Pebble', model: 'claude-haiku-4-5', tokens: 8000, startedAt: N - 21 * M, firstPrompt: 'Translate onboarding copy',
        pace: { mode: 'slow', until: null } }),
      A('fx-0005', { project: 'Marlin', model: 'claude-sonnet-4-6', tokens: 96000, startedAt: N - 40 * M, firstPrompt: 'Bump the UI framework',
        pace: { mode: 'paused', until: N + 50 * M } }),
      A('fx-0006', { project: 'Orchard', model: 'claude-sonnet-4-6', tokens: 22000, startedAt: N - 65 * M, lastSeen: N - 12 * M,
        status: 'idle', firstPrompt: 'Draft release notes' }),
      A('orca:term_fx7', { source: 'orca', project: 'Orchard', model: null, tokens: null, startedAt: N - 30 * M, pid: null,
        firstPrompt: null, orca: { terminal: null, worktree: 'orchard-main', repo: 'Orchard', state: 'working', title: 'Fix the date picker', ambiguous: true } }),
      A('fx-0008', { project: 'Tidepool', tokens: 1240000, startedAt: N - 3 * 60 * M, firstPrompt: 'Port the settings screen' }),
      A('fx-0009', { tokens: 64000, startedAt: N - 50 * M, lastSeen: N - 3 * M, status: 'ended', firstPrompt: 'Fix flaky date test' }),
      // quiet for 2+ hours: folded into the "2 idle" row
      A('fx-0010', { project: 'Quarry', tokens: 31000, startedAt: N - 9 * 60 * M, lastSeen: N - 5 * 60 * M, status: 'idle', stale: true,
        title: 'Sketch the pricing page', titleSource: 'prompt' }),
      A('orca:term_fx11', { source: 'orca', project: 'Orchard', model: null, tokens: null, startedAt: null, lastSeen: N - 26 * 60 * M,
        status: 'idle', stale: true, pid: null, title: 'Batch run for the newsletter', titleSource: 'orca',
        orca: { terminal: 'term_fx11', worktree: 'orchard-main', repo: 'Orchard', state: 'done', title: '✳ Batch run for the newsletter', ambiguous: false } }),
    ],
  };
  // The Replace picker open on the first row (snapshot only: `after` runs once the fixture is rendered).
  K.KADANS_FIXTURES.replace = Object.assign({}, K.KADANS_FIXTURES.many, {
    after: (doc) => KF.act(doc, 'replace', 'fx-0001'),
  });
  // k6: the pace menu open on a working row, with a slowed and a paused agent above it, Auto-pace on.
  K.KADANS_FIXTURES.pace = Object.assign({}, K.KADANS_FIXTURES.many, {
    status: KF.status({ autopace: true, pace: { slowSeconds: 20 }, queue: KF.queue({ ready: 0, next: [] }) }),
    agents: [
      A('fx-0004', { project: 'Pebble', model: 'claude-haiku-4-5', tokens: 8000, startedAt: N - 21 * M, title: 'Translate onboarding copy',
        pace: { mode: 'slow', until: N + 185 * M } }),
      A('fx-0005', { project: 'Marlin', model: 'claude-sonnet-4-6', tokens: 96000, startedAt: N - 40 * M, title: 'Bump the UI framework',
        pace: { mode: 'paused', until: N + 50 * M } }),
      ...KF.base().filter((a) => a.id === 'fx-0003'),
    ],
    after: (doc) => KF.act(doc, 'pace', 'fx-0003'),
  });
  // An open "2 idle" group.
  K.KADANS_FIXTURES.idle_open = Object.assign({}, K.KADANS_FIXTURES.many, {
    agents: K.KADANS_FIXTURES.many.agents.filter((a) => a.stale || a.id === 'fx-0001'),
    after: (doc) => doc.querySelector('[data-do="idle"]')?.click(),
  });
})(window);
