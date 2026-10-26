(function (K) {
  K.KADANS_FIXTURES.gas = {
    status: KF.status({
      accounts: [KF.acct({ state: 'gas', gas: true, limit: 'five_hour', limits: [KF.lim({ state: 'gas', pct: 41, rate: 0.13,
        needle: 0.13, projection: 76, resetsAt: KF.N + 160 * KF.M, timeLeft: 160 * KF.M })] })],
      queue: KF.queue({ ready: 2, next: [
        { id: 4, text: 'Write tests for the login screen', project: 'Tidepool', urgency: 'urgent', approved: true },
        { id: 9, text: 'Tidy the changelog', project: 'Fernway', urgency: 'idle', approved: true },
        { id: 7, text: 'Refresh README screenshots', project: 'Quarry', urgency: 'week', approved: false },
      ] }),
    }),
    agents: [KF.base()[0]],
  };
})(window);
