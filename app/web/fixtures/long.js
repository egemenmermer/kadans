// Long titles, markup-like text that must be escaped, big token counts, missing fields.
(function (K) {
  const N = KF.N, M = KF.M, A = KF.agent;
  K.KADANS_FIXTURES.long = {
    status: KF.status({ queue: KF.queue({ next: [
      { id: 12, text: 'Rewrite the <Onboarding> flow so "Continue" never skips the permissions step on first launch', project: 'A project with a rather long name', urgency: 'week', approved: false },
    ] }) }),
    agents: [
      A('fx-0101', { project: 'A project with a rather long name', tokens: 2350000, startedAt: N - 26 * 60 * M,
        firstPrompt: 'Please go through every <script> tag in the "legacy" folder and replace them with modules, then run the tests & report',
        subagents: [{ id: 'fx-sub-9', type: 'general-purpose', description: 'Checking each of the forty-two legacy script tags one by one', status: 'running' }] }),
      A('fx-0102', { status: 'needs-you', model: 'some-future-model', tokens: 999, firstPrompt: '   ' }),
      A('fx-0103', { project: null, model: null, tokens: null, startedAt: null, firstPrompt: null, title: 'A plain-language title from k5' }),
    ],
  };
})(window);
