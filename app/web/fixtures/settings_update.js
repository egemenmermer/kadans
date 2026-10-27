// k43: the Updates row on the first Settings screen (k44 pushes {update: {auto, available, checking}} from the Mac app).
// Also the fullest first screen: phone on with a device, two computers and an update waiting. Invented data.
(function (K) {
  const F = K.KADANS_FIXTURES;
  const S = F.settings;
  const base = { status: S.status, agents: S.agents, config: S.config, install: S.install, after: S.after };
  const phone = { on: true, url: 'http://192.0.2.10:7477/', pair: null, devices: [{ id: 'd1', name: 'iPhone', lastSeenAt: KF.N - 3 * KF.M }], error: null };
  const computers = { list: [{ id: 'env-0001', name: 'kasa', status: 'online', agents: 2 }, { id: 'env-0002', name: 'PC', status: 'offline', agents: 0 }], error: null };
  F.settings_update = Object.assign({}, base, { phone, computers, update: { auto: false, available: '1.2.0', checking: false } });
  F.settings_update_auto = Object.assign({}, base, { update: { auto: true, available: null, checking: false } });
  F.settings_update_checking = Object.assign({}, base, { update: { auto: true, available: null, checking: true } });
})(window);
