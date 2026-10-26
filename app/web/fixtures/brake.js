(function (K) {
  K.KADANS_FIXTURES.brake = {
    status: KF.status({ accounts: [KF.acct({ state: 'brake', limit: 'five_hour', limits: [KF.lim({ state: 'brake', pct: 73,
      rate: 0.41, needle: 0.41, projection: 108, resetsAt: KF.N + 86 * KF.M, timeLeft: 86 * KF.M, brakeAt: KF.N + 61 * KF.M })] })] }),
    agents: KF.base(),
  };
})(window);
