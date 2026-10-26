// k14: the newest usage sample is 37 min old (no Claude reply since): the gauge says so instead of giving pace advice.
(function (K) {
  const N = KF.N, M = KF.M;
  K.KADANS_FIXTURES.stale = { status: KF.status({ accounts: [KF.acct({ lastSample: N - 37 * M })] }), agents: KF.base() };
})(window);
