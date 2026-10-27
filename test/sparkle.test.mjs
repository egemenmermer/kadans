// k44: Sparkle self-update exists only in the signed premium build. Static checks on the gating (the free build that
// `npx kadans setup` compiles never fetches, links or starts Sparkle) and a run of scripts/sparkle-appcast.sh with a fake
// sign_update and a fake app (no Swift build, no keys, nothing uploaded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('Package.swift adds Sparkle (exact pin) only when KADANS_SPARKLE=1', () => {
  const s = read('app/mac/Package.swift');
  assert.match(s, /environment\["KADANS_SPARKLE"\] == "1"/);
  assert.match(s, /sparkle-project\/Sparkle", exact: "\d+\.\d+\.\d+"/);
  assert.match(s, /dependencies: sparkle\s*\?/);
  assert.match(s, /swiftSettings: sparkle \? \[\.define\("KADANS_SPARKLE"\)\] : \[\]/);
});

test('build-app.sh: SU* keys, the framework and KADANS_SPARKLE only with both feed and public key', () => {
  const s = read('scripts/build-app.sh');
  assert.match(s, /if \[ -n "\$\{KADANS_SPARKLE_FEED:-\}" \] && \[ -n "\$\{KADANS_SPARKLE_PUBKEY:-\}" \]; then SPARKLE=1; fi/);
  assert.match(s, /env -u KADANS_SPARKLE swift build/);
  // every SU key and the framework copy sit inside an `if [ "$SPARKLE" = 1 ]` block
  const blocks = s.split(/if \[ "\$SPARKLE" = 1 \]; then/).slice(1).map((b) => b.split(/\nfi\n/)[0]).join('\n');
  for (const k of ['SUFeedURL', 'SUPublicEDKey', 'SUEnableAutomaticChecks', 'SUAutomaticallyUpdate', 'Sparkle.framework']) {
    assert.ok(blocks.includes(k), `${k} inside the Sparkle branch`);
  }
  assert.doesNotMatch(s.replace(/SPARKLE_KEYS="[\s\S]*?"\nfi/, ''), /<key>SU/);
  assert.match(s, /rm -rf "\$APP\/Contents\/Frameworks\/Sparkle\.framework\/Versions\/B\/XPCServices"/);
  // inside-out signing: Autoupdate, Updater.app and the framework before the app
  const order = ['Versions/B/Autoupdate"', 'Versions/B/Updater.app"', '"${SIGN[@]}" "$SFW"', '"${SIGN[@]}" "$APP"'].map((x) => s.indexOf(x));
  assert.ok(order.every((i) => i > 0), 'all signing steps present');
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('the updater is compiled in only under KADANS_SPARKLE and starts only with both plist keys', () => {
  const s = read('app/mac/Sources/Kadans/Updater.swift');
  assert.match(s, /#if KADANS_SPARKLE\nimport Sparkle\n#endif/);
  assert.match(s, /guard UpdateInfo\.configured\(Bundle\.main\.infoDictionary\)/);
  assert.match(s, /#else\n\/\/\/ Free build: no Sparkle, never an updater\.\nfinal class AppUpdater \{[\s\S]*static func make\(\) -> AppUpdater\? \{ nil \}/);
  const p = read('app/mac/Sources/Kadans/PanelController.swift');
  assert.match(p, /case "update-auto":[\s\S]*CFBooleanGetTypeID\(\)[\s\S]*case "update-install":/);
});

// The signed-release scripts stay out of the public copy (scripts/export-public.sh exports build-app.sh only).
const noRelease = !existsSync(join(ROOT, 'scripts', 'release-app.sh')) && 'release scripts are not in this copy';

test('release-app.sh needs an https base and a public key, then writes dist/appcast.xml', { skip: noRelease }, () => {
  const s = read('scripts/release-app.sh');
  assert.match(s, /case "\$BASE" in https:\/\/\*\) ;;/);
  assert.match(s, /KADANS_SPARKLE_PUBKEY:\?/);
  assert.ok(s.indexOf('stapler staple') < s.indexOf('sparkle-appcast.sh'), 'appcast after staple');
  assert.doesNotMatch(s, /generate_keys/);
});

test('sparkle-appcast.sh writes one signed item for the zip', { skip: noRelease }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kadans-appcast-'));
  const app = join(dir, 'Kadans.app');
  mkdirSync(join(app, 'Contents'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>1.2.3</string>
<key>CFBundleVersion</key><string>10203</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>SUPublicEDKey</key><string>cHVibGlj</string>
</dict></plist>`);
  const zip = join(dir, 'Kadans-1.2.3.zip');
  writeFileSync(zip, 'zip');
  const fake = join(dir, 'sign_update');
  writeFileSync(fake, '#!/bin/sh\necho "args:$*" > "$(dirname "$0")/args"\necho \'sparkle:edSignature="c2ln" length="3"\'\n');
  chmodSync(fake, 0o755);
  const out = join(dir, 'appcast.xml');
  const r = spawnSync('/bin/bash', [join(ROOT, 'scripts', 'sparkle-appcast.sh'), app, zip, out], {
    env: { ...process.env, KADANS_DOWNLOAD_BASE: 'https://example.test/kadans/', KADANS_SIGN_UPDATE: fake, KADANS_SPARKLE_KEY_FILE: join(dir, 'k') },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const xml = readFileSync(out, 'utf8');
  assert.equal(xml.match(/<item>/g).length, 1);
  assert.match(xml, /<sparkle:version>10203<\/sparkle:version>/);
  assert.match(xml, /<sparkle:shortVersionString>1\.2\.3<\/sparkle:shortVersionString>/);
  assert.match(xml, /<sparkle:minimumSystemVersion>13\.0<\/sparkle:minimumSystemVersion>/);
  assert.match(xml, /<sparkle:releaseNotesLink>https:\/\/example\.test\/kadans\/notes\/1\.2\.3\.html<\/sparkle:releaseNotesLink>/);
  assert.match(xml, /<enclosure url="https:\/\/example\.test\/kadans\/Kadans-1\.2\.3\.zip" type="application\/octet-stream" sparkle:edSignature="c2ln" length="3" \/>/);
  assert.match(readFileSync(join(dir, 'args'), 'utf8'), /^args:-f .*\/k .*Kadans-1\.2\.3\.zip/);

  const bad = spawnSync('/bin/bash', [join(ROOT, 'scripts', 'sparkle-appcast.sh'), app, zip, out], {
    env: { ...process.env, KADANS_DOWNLOAD_BASE: '', KADANS_SIGN_UPDATE: fake }, encoding: 'utf8',
  });
  assert.notEqual(bad.status, 0, 'no base, no appcast');
});
