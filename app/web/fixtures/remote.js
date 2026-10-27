// k38: agents on other computers (paired Orca environments), after the local rows; one machine offline. Invented data.
(function (K) {
  const N = KF.N, M = KF.M, A = KF.agent;
  const away = (id, machine, o) => A(id, Object.assign({ source: 'orca', machine, model: null, tokens: null, context: null, startedAt: null,
    pid: null, firstPrompt: null, subagents: [], canStop: false, canCompact: false, canPace: false, canReplace: false,
    machineStale: false, machineOffline: false, orca: { terminal: null, worktree: null, repo: null, state: 'working', title: null, ambiguous: false } }, o));
  K.KADANS_FIXTURES.remote = {
    status: KF.status(),
    agents: [
      A('fx-0301', { title: 'Brake hooks for the Stop event', titleSource: 'session' }),
      A('fx-0302', { project: 'Fernway', status: 'idle', lastSeen: N - M, stateSince: N - M, model: null, startedAt: null, firstPrompt: 'Clean up unused CSS' }),
      away('remote:other:tab-1:1', 'other', { project: 'Tidepool', status: 'working', lastSeen: N - 5000, title: null }),
      away('remote:other:tab-2:1', 'other', { project: 'Tidepool', status: 'needs-you', lastSeen: N - 2 * M, title: 'fix-sound' }),
      away('remote:spare', 'spare', { machineOffline: true, machineStale: true, status: 'idle', project: null, orca: null }),
    ],
  };
})(window);
