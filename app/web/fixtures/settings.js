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
    notify: false, autopace: true, lang: 'en', kickoff: { enabled: false, from: '07:00', to: '23:00' }, own: 'aaaaaaaaaaaa', accounts: { aaaaaaaaaaaa: { gas: false } },
  };
  const twoAccounts = KF.status({ accounts: [KF.acct(), KF.acct({ key: 'cccccccccccc', label: 'Other account', configDir: null, own: false })] });
  const openSettings = (doc) => doc.querySelector('[data-do="settings"]')?.click();
  K.KADANS_FIXTURES.settings = { status: twoAccounts, agents: KF.base(), config, install: install([]), after: openSettings };
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
