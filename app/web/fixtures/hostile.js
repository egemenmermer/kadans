// Hostile strings in every field that comes from JSON: titles, project names, task text, cwd, account labels, limit names,
// subagent names, hook names, paths and commands. All of it must render as plain text. Invented data only.
(function (K) {
  const N = KF.N, M = KF.M, A = KF.agent;
  const IMG = '<img src=x onerror=alert(1)>';
  const BREAK = '"><svg onload=alert(2)>';
  const QUOTE = "' onmouseover='alert(3)' x='";
  const SCRIPT = '</div></div><script>alert(4)</script>';
  const AMP = 'Fish &amp; Chips &lt;b&gt;bold&lt;/b&gt; & more';
  K.HOSTILE = { IMG, BREAK, QUOTE, SCRIPT, AMP };
  const hostileStatus = KF.status({
    queue: KF.queue({
      ready: 1,
      next: [
        { id: 4, text: `Run ${IMG} now`, project: BREAK, urgency: 'week', approved: true },
        { id: 7, text: QUOTE, project: AMP, urgency: '__proto__', approved: false },
      ],
      startable: [{ id: 4, text: `Run ${IMG} now`, project: BREAK, urgency: 'week' }],
    }),
    accounts: [
      KF.acct({ limits: [KF.lim({ name: `five_hour${IMG}` }), KF.lim({ name: 'seven_day', pct: 20, projection: 60 })] }),
      KF.acct({ key: `bbbb${BREAK}`, label: `Other ${IMG}`, configDir: null, own: false }),
    ],
  });
  K.KADANS_FIXTURES.hostile = {
    status: hostileStatus,
    agents: [
      A('fx-0201', { title: `${IMG} ${AMP}`, project: BREAK, cwd: SCRIPT, firstPrompt: SCRIPT,
        subagents: [{ id: `sub${QUOTE}`, type: 'Explore', description: `${IMG}${SCRIPT}`, status: 'running' }] }),
      A(`fx-0202${BREAK}`, { project: QUOTE, status: 'needs-you', firstPrompt: IMG }),
      A('orca:term_fx203', { source: 'orca', project: AMP, model: null, tokens: null, pid: null, firstPrompt: null,
        orca: { terminal: null, worktree: SCRIPT, repo: IMG, state: 'working', title: `${IMG} ${QUOTE}`, ambiguous: true } }),
      A('fx-0204', { project: IMG, status: 'idle', lastSeen: N - 12 * M, firstPrompt: AMP }),
    ],
    // the Replace picker open on the first row: task text and project names go through the menu markup too
    after: (doc) => doc.querySelector('[data-do="replace"][data-id="fx-0201"]')?.click(),
  };
  // Review screen: hook names, summaries, settings path and command from `kadans install --json` are text as well.
  const hostileInstall = {
    file: `/Users/me/${IMG}/settings.json`, changed: true, backup: null, command: `node '/Users/me/${BREAK}/bin/kadans.mjs'`,
    changes: [
      { kind: 'add', event: `Stop${IMG}`, hook: `hook ${IMG}`, summary: `${SCRIPT} ${AMP}` },
      { kind: 'add', event: BREAK, hook: `hook ${IMG}`, summary: QUOTE },
      { kind: 'remove', event: QUOTE, hook: 'statusline', summary: AMP },
    ],
  };
  K.KADANS_FIXTURES.hostile_review = {
    status: hostileStatus, agents: [], install: hostileInstall,
    after: (doc) => doc.querySelector('[data-do="review"]')?.click(),
  };
  // Settings with the kickoff command row and the Uninstall row open: both print the install command.
  K.KADANS_FIXTURES.hostile_settings = {
    status: hostileStatus, agents: [], install: hostileInstall,
    config: { version: 1, limits: 'auto', targets: { five_hour: 97, seven_day: 98 }, slack: 10, warmup: { minutes: 20, pct: 20 },
      notify: false, autopace: true, lang: 'en', kickoff: { enabled: true, from: '07:00', to: '23:00' }, own: 'aaaaaaaaaaaa',
      accounts: { aaaaaaaaaaaa: { gas: false } } },
    after: (doc) => {
      doc.querySelector('[data-do="settings"]')?.click();
      doc.querySelector('[data-do="uninstall"]')?.click();
    },
  };
})(window);
