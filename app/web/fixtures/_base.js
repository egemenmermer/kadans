// Invented fixture data for dev.html. No real paths, names or ids. Times are relative to a fixed "now" so shots are stable.
window.KADANS_FIXTURES = {};
window.KF = (function () {
  const N = 1792964040000;
  const M = 60000;
  const lim = (o) => Object.assign({ name: 'five_hour', state: 'cruise', pct: 58, rate: 0.27, needle: 0.27, projection: 94,
    resetsAt: N + 130 * M, timeLeft: 130 * M, brakeAt: null, target: 97, lastT: N - M, samples: 40, ended: false }, o);
  const acct = (o) => Object.assign({ key: 'aaaaaaaaaaaa', label: 'Your account', configDir: '~/.claude', own: true, gas: false,
    lastSample: N - M, state: 'cruise', limit: null, limits: [lim()] }, o);
  const queue = (o) => Object.assign({ ready: 1, next: [
    { id: 4, text: 'Write tests for the login screen', project: 'Tidepool', urgency: 'urgent', approved: true },
    { id: 7, text: 'Refresh README screenshots', project: 'Quarry', urgency: 'week', approved: false },
  ], startable: [
    { id: 4, text: 'Write tests for the login screen', project: 'Tidepool', urgency: 'urgent' },
    { id: 9, text: 'Tidy the changelog', project: 'Fernway', urgency: 'idle' },
  ] }, o);
  const status = (o) => Object.assign({ version: 1, now: N, error: null, accounts: [acct()], queue: queue() }, o);
  const agent = (id, o) => Object.assign({ id, source: 'claude', project: 'Tidepool', cwd: null, model: 'claude-opus-5-5',
    tokens: 182000, startedAt: N - 11 * M, lastSeen: N - 20000, status: 'working', firstPrompt: 'Write the brake hooks',
    subagents: [], pid: 50001, orca: null }, o);
  const base = () => [
    agent('fx-0001', { title: 'Brake hooks for the Stop event', titleSource: 'session', subagentTokens: 300000,
      subagents: [{ id: 'fx-sub-1', type: 'Explore', description: 'Reading the hooks docs', status: 'running', tokens: 120000, context: 45000 }] }),
    agent('fx-0002', { project: 'Quarry', model: 'claude-sonnet-4-6', tokens: 54000, startedAt: N - 6 * M, status: 'needs-you',
      firstPrompt: 'Pick a login provider' }),
    agent('fx-0003', { project: 'Fernway', model: 'claude-sonnet-4-6', tokens: 12000, startedAt: N - 3 * M,
      firstPrompt: 'Clean up unused CSS' }),
  ];
  // polish-2: a row action by its data-do, wherever it sits: More opens the row's menu first (a click on a button on the
  // row itself then closes that menu again and runs as before).
  const act = (doc, what, id) => {
    doc.querySelector(`[data-do="more"][data-id="${id}"]`)?.click();
    doc.querySelector(`[data-do="${what}"][data-id="${id}"]`)?.click();
  };
  return { N, M, lim, acct, queue, status, agent, base, act };
})();
