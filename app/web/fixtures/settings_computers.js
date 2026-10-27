// k41: Settings › Computers (what the Mac app pushes as {computers}): paired computers, the add form, an error, none
// yet. Invented data: names and ids are made up.
(function (K) {
  const F = K.KADANS_FIXTURES;
  const S = F.settings;
  const toComputers = (open) => (doc) => {
    S.after(doc);
    if (open) doc.querySelector?.('[data-do="comp-open"]')?.click?.();
    const b = doc.getElementById?.('k-sbody');
    const g = [...(doc.querySelectorAll?.('.gl') ?? [])].find((x) => x.textContent === 'Computers');
    if (b && g) b.scrollTop += g.getBoundingClientRect().top - b.getBoundingClientRect().top - 4;
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
