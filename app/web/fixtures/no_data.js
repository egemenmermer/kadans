(function (K) {
  K.KADANS_FIXTURES.no_data = {
    status: KF.status({ accounts: [], error: { code: 'no_data', message: 'no usage samples recorded yet', at: KF.N } }),
    agents: [],
  };
  K.KADANS_FIXTURES.no_claude = {
    status: KF.status({ accounts: [], queue: { ready: 0, next: [] },
      error: { code: 'no_claude', message: 'no Claude Code config dir and no claude on PATH', at: KF.N } }),
    agents: [],
  };
  K.KADANS_FIXTURES.read_failed = {
    status: KF.status({ accounts: [], error: { code: 'read_failed', message: 'unexpected end of JSON input', at: KF.N - 2 * KF.M } }),
    agents: KF.base(),
  };
})(window);
