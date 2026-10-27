// k35: rows that report progress ("3/5 · Writing tests" and the bar), next to rows that do not. Invented data.
(function (K) {
  const N = KF.N, M = KF.M, A = KF.agent;
  K.KADANS_FIXTURES.progress = {
    status: KF.status(),
    agents: [
      A('fx-0001', { title: 'Brake hooks for the Stop event', titleSource: 'session', subagentTokens: 300000,
        progress: { done: 3, total: 5, step: 'Writing tests' },
        subagents: [{ id: 'fx-sub-1', type: 'Explore', description: 'Reading the hooks docs', status: 'running', tokens: 120000, context: 45000,
          progress: { done: 1, total: 4, step: 'Hook input formats' } }] }),
      A('fx-0002', { project: 'Quarry', model: 'claude-sonnet-4-6', tokens: 54000, startedAt: N - 6 * M, status: 'needs-you',
        firstPrompt: 'Pick a login provider', progress: { done: 1, total: 3, step: 'Comparing the providers on price and setup time' } }),
      A('fx-0003', { project: 'Fernway', model: 'claude-sonnet-4-6', tokens: 12000, startedAt: N - 3 * M, firstPrompt: 'Clean up unused CSS' }),
      A('fx-0004', { project: 'Marlin', model: 'claude-sonnet-4-6', tokens: 96000, startedAt: N - 40 * M, firstPrompt: 'Bump the UI framework',
        progress: { done: 0, total: 6, step: null } }),
    ],
  };
})(window);
// The same rows in the phone layout, for snapshots (the Mac snapshot has no phone shell of its own). Null-safe in the test DOM.
window.KADANS_FIXTURES.progress_phone = Object.assign({}, window.KADANS_FIXTURES.progress, {
  after: (doc) => { if (doc.documentElement?.dataset) doc.documentElement.dataset.shell = 'phone'; },
});
