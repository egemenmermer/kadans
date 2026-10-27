// k41: Settings › Computers (what the Mac app pushes as {computers}): paired computers, the add form, an error, none
// yet. Invented data: names and ids are made up.
(function (K) {
  const F = K.KADANS_FIXTURES;
  const S = F.settings;
  // k43: Settings › Computers is its own screen, pushed from the one-line Computers row.
  const toComputers = (open) => (doc) => {
    S.after(doc);
    doc.querySelector('[data-do="sub"][data-id="computers"]')?.click();
    if (open) doc.querySelector?.('[data-do="comp-open"]')?.click?.();
  };
  const list = [
    { id: 'env-0001', name: 'kasa', status: 'online', agents: 2 },
    { id: 'env-0002', name: 'studio', status: 'stale', agents: 1 },
    { id: 'env-0003', name: 'PC', status: 'offline', agents: 0 },
  ];
  const base = { status: S.status, agents: S.agents, config: S.config, install: S.install };
  F.settings_computers = Object.assign({}, base, { computers: { list, error: null }, after: toComputers(false) });
  F.settings_computers_add = Object.assign({}, base, { computers: { list: list.slice(0, 1), error: null }, after: toComputers(true) });
  F.settings_computers_none = Object.assign({}, base, { computers: { list: [], error: null }, after: toComputers(false) });
  F.settings_computers_error = Object.assign({}, base, { computers: { list: null, error: 'list' }, after: toComputers(false) });
})(window);
