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
  // k42: the owner's crowded case: two limits, two local agents with two sub-agents, one agent on another computer
  // (working 70 min, Claude, a tool running, one sub-agent, its title from the prompt), one Up next task. Fits, footer shown.
  const remoteFit = away('remote:other:tab-1:1', 'other', { project: 'Fernway', status: 'working', stateSince: N - 70 * M, lastSeen: N - 5000,
    agentType: 'claude', toolName: 'PowerShell', subagentCount: 1, title: 'Make the rain sound loop without a gap', titleSource: 'prompt' });
  K.KADANS_FIXTURES.fit = {
    status: KF.status({ accounts: [KF.acct({ limits: [
      KF.lim({ pct: 41, projection: 78, resetsAt: N + 150 * M, timeLeft: 150 * M }),
      KF.lim({ name: 'seven_day', pct: 52, rate: 0.006, needle: 0.006, projection: 88, target: 98, resetsAt: N + 2.5 * 24 * 60 * M, timeLeft: 2.5 * 24 * 60 * M }),
    ] })], queue: KF.queue({ ready: 1, next: [{ id: 4, text: 'Write tests for the login screen', project: 'Tidepool', urgency: 'urgent', approved: true }] }) }),
    agents: [
      A('fx-0401', { title: 'Brake hooks for the Stop event', titleSource: 'session', subagentTokens: 300000,
        context: { tokens: 88000, window: 200000, pct: 44, advice: 'none' },
        subagents: [
          { id: 'fx-sub-41', type: 'Explore', description: 'Reading the hooks docs', status: 'running', tokens: 120000, context: 45000 },
          { id: 'fx-sub-42', type: 'general-purpose', description: 'Checking the Stop event payload', status: 'running', tokens: 60000, context: 31000 },
        ] }),
      A('fx-0402', { project: 'Tidepool-website-redesign', model: 'claude-sonnet-4-6', tokens: 410000, startedAt: N - 4 * 60 * M, lastSeen: N - 7 * M,
        status: 'idle', title: 'Move the pricing table to the new grid', titleSource: 'session', context: { tokens: 106000, window: 200000, pct: 53, advice: 'none' } }),
      remoteFit,
    ],
  };
  // k42: a long list on the same gauge: the agents area scrolls, the gauge and the bottom bar stay.
  K.KADANS_FIXTURES.fit_long = Object.assign({}, K.KADANS_FIXTURES.fit, {
    agents: [...K.KADANS_FIXTURES.fit.agents.slice(0, 2), ...K.KADANS_FIXTURES.many.agents.filter((a) => !a.stale), remoteFit,
      away('remote:other:tab-2:1', 'other', { project: 'Fernway', status: 'needs-you', stateSince: N - 2 * M, agentType: 'codex', title: 'fix-sound', titleSource: 'branch' })],
    status: Object.assign({}, K.KADANS_FIXTURES.fit.status, { queue: KF.queue() }),
  });
})(window);
