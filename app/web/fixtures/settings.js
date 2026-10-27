// Settings view and hook setup (k4c). Invented data; the summaries match lib/install.mjs.
(function (K) {
  const SUM = {
    statusline: 'status line: records usage samples and shows the gauge (runs your old status line script too)',
    'hook stop': 'feeds one owner-approved task when quota would go to waste (off unless you opt in)',
    'hook pretool': 'holds new subagents and workflows (Agent|Workflow) while the brake is on',
    'hook event': 'logs session events for the agent list',
    'hook pace-pre': 'every tool call: waits 20 s if you slowed the session, halts it if you paused it; reads two small files otherwise',
    'hook pace-post': 'every tool call: with Auto-pace on, adds a short "usage is running hot" note at most every 10 min',
  };
  const ch = (event, hook) => ({ kind: 'add', event, hook, summary: SUM[hook] });
  const install = (changes) => ({ file: '/Users/me/.claude/settings.json', changed: changes.length > 0, changes, backup: null,
    command: "node '/Users/me/Projects/kadans/bin/kadans.mjs'" });
  const fresh = [ch('statusLine', 'statusline'), ch('Stop', 'hook stop'), ch('PreToolUse', 'hook pretool'),
    ch('PreToolUse', 'hook pace-pre'), ch('PostToolUse', 'hook pace-post'),
    ...['SessionStart', 'UserPromptSubmit', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd', 'Notification'].map((e) => ch(e, 'hook event'))];
  const config = {
    version: 1, limits: 'auto', targets: { five_hour: 97, seven_day: 98 }, slack: 10, warmup: { minutes: 10, pct: 10 },
    notify: false, autopace: true, usageApi: true, lang: 'en', kickoff: { enabled: false, from: '07:00', to: '23:00' },
    compact: { soonPct: 40, nowPct: 60, idleMin: 5 }, own: 'aaaaaaaaaaaa', accounts: { aaaaaaaaaaaa: { gas: false } },
    autoGas: false, autoGasMax: 1, autoGasMinRamGB: 2.5,
  };
  // k18: status --json usageApi (k13): read a minute ago.
  const usageApi = (o) => Object.assign({ enabled: true, lastOk: KF.N - KF.M, lastError: null, nextAt: null }, o);
  const twoAccounts = KF.status({ usageApi: usageApi(), accounts: [KF.acct(), KF.acct({ key: 'cccccccccccc', label: 'Other account', configDir: null, own: false })] });
  const openSettings = (doc) => doc.querySelector('[data-do="settings"]')?.click();
  K.KADANS_FIXTURES.settings = { status: twoAccounts, agents: KF.base(), config, install: install([]), after: openSettings };
  // k18: the usage row when Claude Code has no login, and after a failed read (backing off 8 min).
  K.KADANS_FIXTURES.settings_usage_login = { status: Object.assign({}, twoAccounts, { usageApi: usageApi({ lastOk: null, lastError: 'no_token' }) }),
    agents: KF.base(), config, install: install([]), after: openSettings };
  K.KADANS_FIXTURES.settings_usage_error = { status: Object.assign({}, twoAccounts, { usageApi: usageApi({ lastOk: KF.N - 30 * KF.M, lastError: 'http_503', nextAt: KF.N + 8 * KF.M }) }),
    agents: KF.base(), config, install: install([]), after: openSettings };
  // Settings scrolled to the end, with the Uninstall row open.
  K.KADANS_FIXTURES.settings_end = {
    status: twoAccounts, agents: KF.base(), config, install: install([]),
    after: (doc) => {
      openSettings(doc);
      doc.querySelector('[data-do="uninstall"]')?.click();
      const b = doc.getElementById('k-sbody');
      if (b) b.scrollTop = b.scrollHeight;
    },
  };
  // Settings scrolled to Auto-pace, Next window (off) and Accounts (own + other); Notifications is just below since k8.
  K.KADANS_FIXTURES.settings_mid = {
    status: twoAccounts, agents: KF.base(), config, install: install([]),
    after: (doc) => {
      openSettings(doc);
      const b = doc.getElementById('k-sbody');
      const g = doc.querySelectorAll('#k-sbody .gl')[1];
      if (b && g) b.scrollTop = g.offsetTop - b.offsetTop;
    },
  };
  // Kickoff on: the "Next window" group with its hours and the schedule command.
  K.KADANS_FIXTURES.settings_kickoff = {
    status: twoAccounts, agents: KF.base(), config: { ...config, kickoff: { enabled: true, from: '07:00', to: '23:00' } }, install: install([]),
    after: (doc) => {
      openSettings(doc);
      const b = doc.getElementById('k-sbody');
      const g = [...doc.querySelectorAll('#k-sbody .gl')].find((x) => x.textContent === 'Next window');
      if (b && g) b.scrollTop = g.offsetTop - b.offsetTop;
    },
  };
  // k25: spare quota on, "Use spare quota on its own" on with 2 at a time; scrolled to Accounts.
  const toAccounts = (doc) => {
    openSettings(doc);
    const b = doc.getElementById('k-sbody');
    const g = [...doc.querySelectorAll('#k-sbody .gl')].find((x) => x.textContent === 'Accounts');
    if (b && g) b.scrollTop = g.offsetTop - b.offsetTop;
  };
  K.KADANS_FIXTURES.settings_autogas = {
    status: twoAccounts, agents: KF.base(), install: install([]), after: toAccounts,
    config: { ...config, accounts: { aaaaaaaaaaaa: { gas: true } }, autoGas: true, autoGasMax: 2 },
  };
  // k25: the account's spare quota is off, so the row is off and says why.
  K.KADANS_FIXTURES.settings_autogas_off = { status: twoAccounts, agents: KF.base(), install: install([]), after: toAccounts, config };
  // An older install: the two pace hooks are missing.
  K.KADANS_FIXTURES.hooks = {
    status: KF.status(), agents: KF.base(), config,
    install: install([ch('PreToolUse', 'hook pace-pre'), ch('PostToolUse', 'hook pace-post')]),
  };
  // First run: nothing installed yet, the Review list open.
  K.KADANS_FIXTURES.hooks_review = {
    status: KF.status({ accounts: [], error: { code: 'no_data', message: 'no usage samples recorded yet', at: KF.N } }),
    agents: [], config, install: install(fresh),
    after: (doc) => doc.querySelector('[data-do="review"]')?.click(),
  };
  // Review with the inline confirm showing.
  K.KADANS_FIXTURES.hooks_confirm = {
    status: KF.status(), agents: KF.base(), config,
    install: install([ch('PreToolUse', 'hook pace-pre'), ch('PostToolUse', 'hook pace-post')]),
    after: (doc) => {
      doc.querySelector('[data-do="review"]')?.click();
      doc.querySelector('[data-do="apply"]')?.click();
    },
  };
})(window);
