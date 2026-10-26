// k10b: context size per row and the compact hint / action. Invented data. `context` as `agents --json` gives it (k10a):
// a 'now' idle chat in an Orca terminal (tag + Compact), a 'soon' one (number only, Compact on hover), a 'now' chat outside
// Orca (tag only, "Type /compact in that chat"), a working chat (number, nothing else) and one with no context yet.
(function (K) {
  const N = KF.N, M = KF.M, A = KF.agent;
  const ctx = (tokens, advice, why) => ({ tokens, window: 200000, pct: Math.round(tokens / 2000) / 10, advice, why });
  const term = (t, repo) => ({ terminal: t, worktree: `${repo.toLowerCase()}-main`, repo, state: 'idle', title: null, ambiguous: false });
  const agents = [
    A('fx-0024', { project: 'Quarry', tokens: 2100000, startedAt: N - 40 * M, title: 'Port the CSV importer',
      context: ctx(148000, 'none', null) }),
    A('fx-0025', { project: 'Fernway', model: 'claude-sonnet-4-6', tokens: 6000, startedAt: N - 2 * M, status: 'needs-you',
      title: 'Pick a date library', context: null }),
    A('fx-0021', { project: 'Tidepool', tokens: 4300000, startedAt: N - 95 * M, lastSeen: N - 12 * M, status: 'idle',
      title: 'Refactor the sync worker', orca: term('term_fx21', 'Tidepool'),
      context: ctx(152000, 'now', 'Idle 12 min: next turn re-reads all 152k') }),
    A('fx-0022', { project: 'Orchard', model: 'claude-sonnet-4-6', tokens: 1200000, startedAt: N - 50 * M, lastSeen: N - 3 * M,
      status: 'idle', title: 'Draft the release notes', orca: term('term_fx22', 'Orchard'),
      context: ctx(92000, 'soon', 'Re-reads 92k tokens every turn') }),
    A('fx-0023', { project: 'Pebble', tokens: 3600000, startedAt: N - 70 * M, lastSeen: N - 4 * M, status: 'idle',
      title: 'Tune the search ranking', orca: null, context: ctx(128000, 'now', 'Re-reads 128k tokens every turn') }),
  ];
  const status = KF.status({ queue: KF.queue({ ready: 0, next: [] }) });
  const config = {
    version: 1, limits: 'auto', targets: { five_hour: 97, seven_day: 98 }, slack: 10, warmup: { minutes: 10, pct: 10 },
    notify: false, autopace: true, lang: 'en', kickoff: { enabled: false, from: '07:00', to: '23:00' },
    compact: { soonPct: 40, nowPct: 60, idleMin: 5 }, own: 'aaaaaaaaaaaa', accounts: { aaaaaaaaaaaa: { gas: false } },
  };
  K.KADANS_FIXTURES.compact = { status, agents, config };
  // "Compact this chat?" + the why sentence, Compact / Cancel.
  K.KADANS_FIXTURES.compact_confirm = { status, agents, config,
    after: (doc) => doc.querySelector('[data-do="compact"][data-id="fx-0021"]')?.click() };
  // Confirmed: "Compacting…" on the row, no Compact anywhere else until it settles.
  K.KADANS_FIXTURES.compact_sent = { status, agents, config,
    after: (doc) => {
      doc.querySelector('[data-do="compact"][data-id="fx-0021"]')?.click();
      doc.querySelector('[data-do="compact-go"][data-id="fx-0021"]')?.click();
    } };
  // k12: the CLI refused the click: its reason replaces the row's meta line for 8 s. A stop refused the same way looks alike.
  K.KADANS_FIXTURES.compact_refused = { status, agents, config,
    after: (doc) => {
      doc.querySelector('[data-do="compact"][data-id="fx-0021"]')?.click();
      doc.querySelector('[data-do="compact-go"][data-id="fx-0021"]')?.click();
      K.kadans.result({ action: 'compact', id: 'fx-0021', ok: false, why: 'not compacted: That chat has unsent text: type /compact there yourself' });
    } };
  // Hints Off (compact.soonPct 101): numbers stay, no tag, no Compact.
  K.KADANS_FIXTURES.compact_off = { status, agents, config: { ...config, compact: { ...config.compact, soonPct: 101 } } };
  // Settings scrolled to the Auto-pace group with the "Suggest compact" row.
  K.KADANS_FIXTURES.settings_compact = { status, agents, config, install: { file: '/Users/me/.claude/settings.json', changed: false, changes: [] },
    after: (doc) => {
      doc.querySelector('[data-do="settings"]')?.click();
      const b = doc.getElementById('k-sbody');
      const g = doc.querySelectorAll('#k-sbody .gl')[1];
      if (b && g) b.scrollTop = g.offsetTop - b.offsetTop;
    } };
})(window);
