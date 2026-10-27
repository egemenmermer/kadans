// k27: Settings › Phone (what the Mac app pushes as {phone}) and the phone page's own states. Invented data: the QR is a
// made-up pattern (not a working code), the address is from the documentation range.
(function (K) {
  const F = K.KADANS_FIXTURES;
  const S = F.settings;
  const QR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIQAAACECAAAAAB0L9x7AAABTUlEQVR42u3ayw7DIAxE0fz/T6erbhD2DCgNmN5smkYRnEoIP+h1b3BdIECAAAECBIijEFdyte+073+/u+OAqIPoLp7meTR4++mMD6IGQi243qC9+2gcEOcgRu9B/A8iCmpZIANRG5E9V4nLK1EUxKsIN0HtvT8zDoi9EbJ4TQaMoI9X5SC2QbhFL4izENkECucEvunMCsQWiF6TbDSIZZODqIGIml9uMzVqsqU/AkQJRG8i9U6EkhsaiFKI0SJILUS7+AGxDSJakCrJzRopKoiBqIGIgpTTQFWFM4haCGezUsEsOrCbTmpALEc4jbMsEc6Kn0ebqSBeQajFqILUT3ZMEMsRbpGcJUHqsBdEPcRMwauSnvvpfxeB2ArhNFczDIhzEG6DdKTJDqIGwjmMGZl46uQHxDaI0UR3ZqMDUQex4gIBAgQIECBAlEZ8AEFmEpEsXbBSAAAAAElFTkSuQmCC';
  const URL = 'http://192.0.2.10:7477/';
  const phone = (o) => Object.assign({ on: true, url: URL, pair: null, devices: [], error: null }, o);
  // Settings is opened at the real clock, so the pair expiry is read at render time (Date.now()).
  const pairNow = () => ({ url: `${URL}#pair=ABCDEFGHIJKLMNOPQRSTUVWXYZ`, qr: QR, expiresAt: Date.now() + (9 * 60 + 41) * 1000 });
  const toPhone = (doc) => {
    S.after(doc);
    const b = doc.getElementById?.('k-sbody');
    const g = [...(doc.querySelectorAll?.('.gl') ?? [])].find((x) => x.textContent === 'Phone');
    if (b && g) b.scrollTop += g.getBoundingClientRect().top - b.getBoundingClientRect().top - 4;
  };
  const base = { status: S.status, agents: S.agents, config: S.config, install: S.install, after: toPhone };
  const devices = [{ id: 'd1', name: 'iPhone', lastSeenAt: Date.now() - 3 * KF.M }, { id: 'd2', name: 'iPad', lastSeenAt: null }];
  F.settings_phone_off = Object.assign({}, base, { phone: phone({ on: false, url: null }) });
  F.settings_phone_on = Object.assign({}, base, { phone: phone({ devices }) });
  Object.defineProperty(F, 'settings_phone_pairing', { enumerable: true, get: () => Object.assign({}, base, { phone: phone({ pair: pairNow(), devices: devices.slice(0, 1) }) }) });
  F.settings_phone_expired = Object.assign({}, base, { phone: phone({ pair: { url: `${URL}#pair=X`, qr: QR, expiresAt: 1000 } }) });
  F.settings_phone_error = Object.assign({}, base, { phone: phone({ error: 'listen EADDRINUSE 192.0.2.10:7477' }) });
})(window);
