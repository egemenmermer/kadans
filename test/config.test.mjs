import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountKey } from '../lib/samples.mjs';
import { parseSetting, setSetting } from '../lib/config.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
const OTHER = 'bbbbbbbbbbbb';

// Temp HOME (so the own key is the temp ~/.claude), KADANS_HOME and CLAUDE_CONFIG_DIR; never the real ones.
function sandbox(config) {
  const root = mkdtempSync(join(tmpdir(), 'kadans-cfg-'));
  const home = join(root, 'kadans');
  const claude = join(root, '.claude');
  mkdirSync(home);
  mkdirSync(claude);
  if (config !== undefined) writeFileSync(join(home, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config, null, 2));
  const env = { PATH: process.env.PATH, HOME: root, KADANS_HOME: home, CLAUDE_CONFIG_DIR: claude };
  return { root, home, claude, env, own: accountKey(claude) };
}

function run(sb, args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { env: sb.env, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const cfgOf = (sb) => JSON.parse(readFileSync(join(sb.home, 'config.json'), 'utf8'));

test('config set: every allowed key and value is stored with the right type and path', () => {
  const sb = sandbox();
  const cases = [
    [['limits', 'auto'], (c) => c.limits, 'auto'],
    [['limits', 'five_hour'], (c) => c.limits, ['five_hour']],
    [['limits', 'five_hour,seven_day'], (c) => c.limits, ['five_hour', 'seven_day']],
    [['targets.five_hour', '50'], (c) => c.targets.five_hour, 50],
    [['targets.five_hour', '100'], (c) => c.targets.five_hour, 100],
    [['targets.seven_day', '98'], (c) => c.targets.seven_day, 98],
    [['slack', '0'], (c) => c.slack, 0],
    [['slack', '30'], (c) => c.slack, 30],
    [['warmup.minutes', '60'], (c) => c.warmup.minutes, 60],
    [['warmup.pct', '50'], (c) => c.warmup.pct, 50],
    [['notify', 'true'], (c) => c.notify, true],
    [['notify', 'false'], (c) => c.notify, false],
    [['autopace', 'true'], (c) => c.autopace, true],
    [['autopace', 'false'], (c) => c.autopace, false],
    [['lang', 'tr'], (c) => c.lang, 'tr'],
    [['lang', 'en'], (c) => c.lang, 'en'],
    [[`accounts.${sb.own}.gas`, 'true'], (c) => c.accounts[sb.own].gas, true],
    [[`accounts.${sb.own}.gas`, 'false'], (c) => c.accounts[sb.own].gas, false],
  ];
  for (const [args, get, want] of cases) {
    const r = run(sb, ['config', 'set', ...args]);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`);
    assert.deepEqual(get(cfgOf(sb)), want, args.join(' '));
  }
  // get --json reflects the file
  const g = JSON.parse(run(sb, ['config', 'get', '--json']).out);
  assert.equal(g.own, sb.own);
  assert.deepEqual(g.limits, ['five_hour', 'seven_day']);
  assert.deepEqual(g.targets, { five_hour: 100, seven_day: 98 });
  assert.deepEqual(g.warmup, { minutes: 60, pct: 50 });
  assert.equal(g.slack, 30);
  assert.equal(g.lang, 'en');
  assert.deepEqual(g.accounts, { [sb.own]: { gas: false } });
});

test('config set refuses unknown keys and out-of-range or malformed values, and writes nothing', () => {
  const seed = { chain: '~/x.sh', slack: 12 };
  const sb = sandbox(seed);
  const before = readFileSync(join(sb.home, 'config.json'), 'utf8');
  const bad = [
    ['chain', '/tmp/evil.sh'], ['pace.slowSeconds', '5'], ['__proto__', 'x'], ['constructor.prototype', 'x'], ['targets', '97'],
    ['targets.foo', '97'], ['warmup', '10'], ['accounts', 'x'], [`accounts.${sb.own}.foo`, 'true'], [`accounts.${sb.own}`, 'true'],
    ['--json', 'true'], ['', 'true'],
    ['limits', 'seven_day'], ['limits', 'seven_day,five_hour'], ['limits', 'AUTO'], ['limits', ''],
    ['targets.five_hour', '49'], ['targets.five_hour', '101'], ['targets.five_hour', '97.5'], ['targets.five_hour', '1e2'],
    ['targets.five_hour', ' 97'], ['targets.five_hour', '0x60'], ['targets.five_hour', ''], ['targets.seven_day', '-90'],
    ['slack', '31'], ['slack', '-1'], ['warmup.minutes', '61'], ['warmup.pct', '51'],
    ['notify', 'yes'], ['notify', '1'], ['notify', 'TRUE'], ['autopace', 'on'], ['lang', 'de'], ['lang', 'TR'],
    [`accounts.${sb.own}.gas`, 'on'],
  ];
  for (const args of bad) {
    const r = run(sb, ['config', 'set', ...args]);
    assert.equal(r.code, 2, `should refuse: ${args.join(' ')}`);
    assert.match(r.err, /kadans: /);
  }
  assert.equal(run(sb, ['config', 'set', 'slack']).code, 2); // missing value
  assert.equal(run(sb, ['config', 'set', 'slack', '5', 'extra']).code, 2);
  assert.equal(readFileSync(join(sb.home, 'config.json'), 'utf8'), before);
});

test('gas is refused for any account that is not the owner\'s own, both on and off', () => {
  const sb = sandbox({ accounts: { [OTHER]: { gas: false } } });
  const before = readFileSync(join(sb.home, 'config.json'), 'utf8');
  for (const v of ['true', 'false']) {
    const r = run(sb, ['config', 'set', `accounts.${OTHER}.gas`, v]);
    assert.equal(r.code, 2);
    assert.match(r.err, /not your own account/);
  }
  // CLAUDE_CONFIG_DIR pointing at another profile does not make that profile "own"
  const other = join(sb.root, 'orca-profile');
  mkdirSync(other);
  const r = run({ env: { ...sb.env, CLAUDE_CONFIG_DIR: other } }, ['config', 'set', `accounts.${accountKey(other)}.gas`, 'true']);
  assert.equal(r.code, 2);
  assert.equal(readFileSync(join(sb.home, 'config.json'), 'utf8'), before);
  // and the library check agrees
  assert.match(parseSetting(`accounts.${OTHER}.gas`, 'true', sb.own).error, /refused/);
  assert.deepEqual(parseSetting(`accounts.${sb.own}.gas`, 'true', sb.own).value, true);
});

test('config set writes atomically under the lock and keeps unknown keys and other accounts', () => {
  const seed = {
    chain: '~/my/statusline.sh', pace: { slowSeconds: 30 }, foo: { bar: [1, 2] }, targets: { five_hour: 90, extra: 1 },
    warmup: 'broken', accounts: { [OTHER]: { gas: false, note: 'other' } },
  };
  const sb = sandbox(seed);
  assert.equal(run(sb, ['config', 'set', 'targets.seven_day', '95']).code, 0);
  assert.equal(run(sb, ['config', 'set', 'warmup.pct', '15']).code, 0);
  assert.equal(run(sb, ['config', 'set', `accounts.${sb.own}.gas`, 'true']).code, 0);
  assert.equal(run(sb, ['config', 'set', 'autopace', 'true']).code, 0);
  const c = cfgOf(sb);
  assert.equal(c.chain, seed.chain);
  assert.deepEqual(c.pace, seed.pace);
  assert.deepEqual(c.foo, seed.foo);
  assert.deepEqual(c.targets, { five_hour: 90, extra: 1, seven_day: 95 });
  assert.deepEqual(c.warmup, { pct: 15 }); // a non-object is replaced by an object
  assert.deepEqual(c.accounts[OTHER], seed.accounts[OTHER]);
  assert.deepEqual(c.accounts[sb.own], { gas: true });
  assert.equal(c.autopace, true);
  // no temp files or lock left behind
  assert.deepEqual(readdirSync(sb.home).filter((f) => f.includes('.tmp') || f === '.lock'), []);
});

test('config set refuses a broken config.json and writes nothing; a missing one is created', () => {
  const sb = sandbox('{ not json');
  const r = run(sb, ['config', 'set', 'slack', '5']);
  assert.equal(r.code, 2);
  assert.match(r.err, /not valid JSON/);
  assert.equal(readFileSync(join(sb.home, 'config.json'), 'utf8'), '{ not json');
  const arr = sandbox('[1,2]');
  assert.equal(run(arr, ['config', 'set', 'slack', '5']).code, 2);
  const fresh = sandbox();
  assert.equal(existsSync(join(fresh.home, 'config.json')), false);
  assert.equal(run(fresh, ['config', 'set', 'lang', 'tr']).code, 0);
  assert.deepEqual(cfgOf(fresh), { lang: 'tr' });
});

test('config set autopace false lifts auto pace entries like `kadans autopace off`; owner entries stay', () => {
  const sb = sandbox({ autopace: true });
  const now = Date.now();
  const pace = {
    s1: { mode: 'slow', until: now + 3_600_000, by: 'auto', at: now },
    s2: { mode: 'paused', until: now + 3_600_000, by: 'owner', at: now },
  };
  writeFileSync(join(sb.home, 'pace.json'), JSON.stringify(pace));
  setSetting(sb.home, 'autopace', 'false', { ownKey: sb.own, now });
  const p = JSON.parse(readFileSync(join(sb.home, 'pace.json'), 'utf8'));
  assert.equal(p.s1, undefined);
  assert.equal(p.s2.by, 'owner');
  assert.equal(cfgOf(sb).autopace, false);
});

test('config get --json gives defaults without a config file and never reports gas for another account', () => {
  const sb = sandbox({ accounts: { [OTHER]: { gas: true } }, lang: 'xx', slack: 7 });
  const g = JSON.parse(run(sb, ['config', 'get', '--json']).out);
  assert.equal(g.version, 1);
  assert.equal(g.limits, 'auto');
  assert.equal(g.lang, 'en');
  assert.equal(g.slack, 7);
  assert.equal(g.notify, false);
  assert.equal(g.autopace, false);
  assert.deepEqual(g.accounts[OTHER], { gas: false });
  assert.equal(g.chain, undefined); // only what the app may change
  assert.match(run(sb, ['config', 'get']).out, /^limits: "auto"$/m);
  assert.equal(run(sb, ['config', 'frob']).code, 2);
});

// install --json on temp settings files only.
const ORCA = {
  statusLine: { type: 'command', command: '~/.claude/usage-guard/statusline.sh' },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node ~/orca/hooks/stop.mjs' }] }] },
};

test('install --json: {file, changed, changes, backup, command}, no diff, nothing written; up to date after apply', () => {
  const sb = sandbox();
  const file = join(sb.claude, 'settings.json');
  writeFileSync(file, JSON.stringify(ORCA, null, 2));
  const original = readFileSync(file, 'utf8');
  const j = JSON.parse(run(sb, ['install', '--json']).out);
  assert.deepEqual(Object.keys(j).sort(), ['backup', 'changed', 'changes', 'command', 'file']);
  assert.equal(j.file, file);
  assert.equal(j.changed, true);
  assert.equal(j.backup, null);
  assert.match(j.command, /^node '.*bin\/kadans\.mjs'$/);
  const hooks = new Set(j.changes.map((c) => c.hook));
  assert.deepEqual([...hooks].sort(), ['hook event', 'hook pace-post', 'hook pace-pre', 'hook pretool', 'hook stop', 'statusline']);
  for (const c of j.changes) {
    assert.equal(c.kind, 'add');
    assert.equal(typeof c.event, 'string');
    assert.ok(c.summary.length > 10);
  }
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.deepEqual(readdirSync(sb.claude).filter((f) => f.includes('backup')), []);

  assert.equal(run(sb, ['install', '--apply']).code, 0);
  const after = JSON.parse(run(sb, ['install', '--json']).out);
  assert.equal(after.changed, false);
  assert.deepEqual(after.changes, []);

  // an older install (no pace hooks): only those two show up
  const s = JSON.parse(readFileSync(file, 'utf8'));
  s.hooks.PreToolUse = s.hooks.PreToolUse.filter((g) => !g.hooks.some((h) => /pace-pre/.test(h.command)));
  delete s.hooks.PostToolUse;
  writeFileSync(file, JSON.stringify(s, null, 2));
  const old = JSON.parse(run(sb, ['install', '--json']).out);
  assert.equal(old.changed, true);
  assert.deepEqual(old.changes.map((c) => c.hook).sort(), ['hook pace-post', 'hook pace-pre']);
});

test('install --json without a settings file previews a fresh install; a broken file fails without writing', () => {
  const sb = sandbox();
  const j = JSON.parse(run(sb, ['install', '--json']).out);
  assert.equal(j.changed, true);
  assert.equal(existsSync(join(sb.claude, 'settings.json')), false);
  writeFileSync(join(sb.claude, 'settings.json'), '{ nope');
  const r = run(sb, ['install', '--json']);
  assert.equal(r.code, 2);
  assert.equal(readFileSync(join(sb.claude, 'settings.json'), 'utf8'), '{ nope');
});
