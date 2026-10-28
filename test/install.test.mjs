import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changeList, kadansCommand, lineDiff, mergeSettings, plan, unmergeSettings } from '../lib/install.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');

// Orca-like settings: a foreign status line, Stop and PreToolUse hooks, plus unrelated keys.
const FIXTURE = {
  permissions: { allow: ['Bash(git status)'] },
  statusLine: { type: 'command', command: '~/.claude/usage-guard/statusline.sh', padding: 0 },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'node ~/orca/hooks/stop.mjs' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node ~/orca/hooks/pretool.mjs', timeout: 5 }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'node ~/orca/hooks/start.mjs' }] }],
  },
};
const CMD = kadansCommand('/opt/Disk X/x/bin/kadans.mjs');

test('merge appends ours to the existing arrays and keeps every foreign entry', () => {
  const { settings: s, savedStatusLine } = mergeSettings(FIXTURE, CMD);
  assert.deepEqual(savedStatusLine, FIXTURE.statusLine);
  assert.equal(s.statusLine.command, `node '/opt/Disk X/x/bin/kadans.mjs' statusline`);
  assert.deepEqual(s.hooks.Stop[0], FIXTURE.hooks.Stop[0]);
  assert.deepEqual(s.hooks.PreToolUse[0], FIXTURE.hooks.PreToolUse[0]);
  assert.deepEqual(s.hooks.SessionStart[0], FIXTURE.hooks.SessionStart[0]);
  assert.equal(s.hooks.SessionStart.length, 2);
  assert.match(s.hooks.SessionStart[1].hooks[0].command, /kadans\.mjs' hook event$/);
  assert.deepEqual(s.permissions, FIXTURE.permissions);
  assert.equal(s.hooks.Stop.length, 3);
  assert.match(s.hooks.Stop[1].hooks[0].command, /kadans\.mjs' hook stop$/);
  assert.match(s.hooks.Stop[2].hooks[0].command, /kadans\.mjs' hook event$/);
  for (const ev of ['UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'SessionEnd']) {
    assert.equal(s.hooks[ev].length, 1, ev);
    assert.match(s.hooks[ev][0].hooks[0].command, /hook event$/);
  }
  assert.equal(s.hooks.Notification[0].matcher, 'permission_prompt|elicitation_dialog');
  assert.equal(s.hooks.PreToolUse[1].matcher, 'Agent|Workflow');
  assert.match(s.hooks.PreToolUse[1].hooks[0].command, /hook pretool$/);
  assert.equal(s.hooks.PreToolUse[1].hooks[0].timeout, 30);
  // idempotent, and a second merge does not report our own status line as the one to save
  const again = mergeSettings(s, CMD);
  assert.deepEqual(again.settings, s);
  assert.equal(again.savedStatusLine, null);
  // input not mutated
  assert.equal(FIXTURE.hooks.Stop.length, 1);
});

test('merge works on empty settings; unmerge restores the original exactly', () => {
  const { settings: s } = mergeSettings({}, CMD);
  assert.equal(s.hooks.Stop.length, 2);
  assert.deepEqual(unmergeSettings(s, null), { hooks: {} });
  const merged = mergeSettings(FIXTURE, CMD).settings;
  assert.deepEqual(unmergeSettings(merged, FIXTURE.statusLine), FIXTURE);
  assert.deepEqual(unmergeSettings(FIXTURE, null), FIXTURE); // nothing of ours: untouched
});

test('an older install (stop + pretool only) gains the event hooks once; the path of the checkout does not matter', () => {
  const old = mergeSettings(FIXTURE, CMD).settings;
  for (const ev of Object.keys(old.hooks)) {
    old.hooks[ev] = old.hooks[ev].filter((g) => !g.hooks.some((h) => / hook event$/.test(h.command)));
  }
  const moved = kadansCommand('/elsewhere/kadans/bin/kadans.mjs');
  const up = mergeSettings(old, moved).settings;
  assert.equal(up.hooks.Stop.length, 3); // stop kept (old path), event added
  assert.match(up.hooks.Stop[1].hooks[0].command, /x\/bin\/kadans\.mjs' hook stop$/);
  assert.equal(up.hooks.PreToolUse.length, 3); // + pace-pre
  assert.deepEqual(mergeSettings(up, moved).settings, up);
  assert.deepEqual(unmergeSettings(up, FIXTURE.statusLine), FIXTURE);
});

test('lineDiff marks added and removed lines', () => {
  assert.equal(lineDiff('a\nb\nc', 'a\nc\nd'), '  a\n- b\n  c\n+ d');
});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'kadans-inst-'));
  const home = join(root, 'kadans');
  const claude = join(root, 'claude');
  mkdirSync(home);
  mkdirSync(claude);
  const file = join(claude, 'settings.json');
  writeFileSync(file, JSON.stringify(FIXTURE, null, 2));
  const env = { PATH: process.env.PATH, HOME: root, KADANS_HOME: home, CLAUDE_CONFIG_DIR: claude };
  return { root, home, claude, file, env };
}

function run(sb, args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { env: sb.env, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const backups = (sb) => readdirSync(sb.claude).filter((f) => f.startsWith('settings.json.kadans-backup-'));

test('cli install previews by default, --apply backs up, uninstall restores', () => {
  const sb = sandbox();
  const original = readFileSync(sb.file, 'utf8');
  const p = run(sb, ['install']);
  assert.equal(p.code, 0);
  assert.match(p.out, /^\+ .*hook stop/m);
  assert.match(p.out, /preview/);
  assert.equal(readFileSync(sb.file, 'utf8'), original);
  assert.equal(backups(sb).length, 0);

  const a = run(sb, ['install', '--apply']);
  assert.equal(a.code, 0);
  assert.equal(backups(sb).length, 1);
  assert.equal(readFileSync(join(sb.claude, backups(sb)[0]), 'utf8'), original);
  const s = JSON.parse(readFileSync(sb.file, 'utf8'));
  assert.equal(s.hooks.Stop.length, 3);
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'node ~/orca/hooks/stop.mjs');
  assert.deepEqual(JSON.parse(readFileSync(join(sb.home, 'install.json'), 'utf8')).statusLine, FIXTURE.statusLine);

  assert.match(run(sb, ['install', '--apply']).out, /no changes/); // idempotent
  assert.deepEqual(JSON.parse(readFileSync(join(sb.home, 'install.json'), 'utf8')).statusLine, FIXTURE.statusLine);

  assert.match(run(sb, ['uninstall']).out, /^- .*hook pretool/m);
  assert.equal(JSON.parse(readFileSync(sb.file, 'utf8')).hooks.Stop.length, 3); // preview wrote nothing
  assert.equal(run(sb, ['uninstall', '--apply']).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(sb.file, 'utf8')), FIXTURE);
});

test('cli install: the old status line keeps running (no WARNING); an explicit other chain warns', () => {
  const sb = sandbox();
  const out = run(sb, ['install']).out;
  assert.match(out, /^Your status line '~\/\.claude\/usage-guard\/statusline\.sh' keeps running inside Kadans' line\.$/m);
  assert.doesNotMatch(out, /WARNING/);
  writeFileSync(join(sb.home, 'config.json'), JSON.stringify({ chain: '~/.claude/usage-guard/statusline.sh' }));
  assert.doesNotMatch(run(sb, ['install']).out, /WARNING/); // chain = the old script: same thing
  writeFileSync(join(sb.home, 'config.json'), JSON.stringify({ chain: '/elsewhere/other.sh' }));
  assert.match(run(sb, ['install']).out, /WARNING: your status line '~\/\.claude\/usage-guard\/statusline\.sh' does not run/);
});

test('cli install refuses a broken settings.json and writes nothing', () => {
  const sb = sandbox();
  writeFileSync(sb.file, '{ broken');
  const r = run(sb, ['install', '--apply']);
  assert.equal(r.code, 2);
  assert.equal(readFileSync(sb.file, 'utf8'), '{ broken');
  assert.equal(backups(sb).length, 0);
  assert.equal(existsSync(join(sb.home, 'install.json')), false);
});

test('install adds the pace hooks (every tool, 60 s pre timeout) next to Orca hooks, with a summary line each; uninstall removes them', () => {
  const { settings: s } = mergeSettings(FIXTURE, CMD);
  const pre = s.hooks.PreToolUse.find((g) => g.hooks.some((h) => / hook pace-pre$/.test(h.command)));
  const post = s.hooks.PostToolUse.find((g) => g.hooks.some((h) => / hook pace-post$/.test(h.command)));
  assert.equal(pre.matcher, '*');
  assert.equal(pre.hooks[0].timeout, 60);
  assert.equal(post.matcher, '*');
  assert.deepEqual(s.hooks.PreToolUse[0], FIXTURE.hooks.PreToolUse[0]); // Orca's stays first
  assert.equal(s.hooks.PreToolUse.length, 3); // Orca, pretool, pace-pre
  // an install that predates k6 gains exactly the two pace groups
  const old = JSON.parse(JSON.stringify(s));
  old.hooks.PreToolUse = old.hooks.PreToolUse.filter((g) => g !== pre && !g.hooks.some((h) => /pace-pre/.test(h.command)));
  delete old.hooks.PostToolUse;
  const ch = changeList(old, mergeSettings(old, CMD).settings);
  assert.deepEqual(ch.map((c) => `${c.kind} ${c.event} ${c.hook}`).sort(), ['add PostToolUse hook pace-post', 'add PreToolUse hook pace-pre']);
  assert.ok(ch.every((c) => c.summary.length > 10));
  assert.deepEqual(unmergeSettings(s, FIXTURE.statusLine), FIXTURE);
});

test('cli install preview lists the pace hooks with summaries; --json has changes', () => {
  const sb = sandbox();
  const p = run(sb, ['install']);
  assert.match(p.out, /^\+ .*hook pace-pre/m);
  assert.match(p.out, /^\+ .*hook pace-post/m);
  assert.match(p.out, /^adds PreToolUse hook pace-pre: .*20 s/m);
  assert.match(p.out, /^adds PostToolUse hook pace-post: .*Auto-pace/m);
  const j = JSON.parse(run(sb, ['install', '--json']).out);
  assert.ok(j.changes.some((c) => c.event === 'PostToolUse' && c.hook === 'hook pace-post'));
  assert.equal(backups(sb).length, 0);
});

test('plan: uninstall never restores a status line the owner removed after an earlier install', () => {
  const sb = sandbox();
  const bin = '/opt/kadans/bin/kadans.mjs';
  const go = (kind) => plan({ kind, cfgDir: sb.claude, home: sb.home, bin, apply: true });
  go('install');
  go('uninstall');
  assert.deepEqual(JSON.parse(readFileSync(sb.file, 'utf8')).statusLine, FIXTURE.statusLine);
  // The owner drops the old status line, then installs and uninstalls again: no status line comes back.
  const { statusLine, ...rest } = JSON.parse(readFileSync(sb.file, 'utf8'));
  writeFileSync(sb.file, JSON.stringify(rest, null, 2));
  go('install');
  go('uninstall');
  assert.equal(JSON.parse(readFileSync(sb.file, 'utf8')).statusLine, undefined);
});

test('plan: two applies in the same second keep both backups', () => {
  const sb = sandbox();
  const original = readFileSync(sb.file, 'utf8');
  const now = new Date(2026, 9, 26, 12, 0, 0);
  const go = (kind) => plan({ kind, cfgDir: sb.claude, home: sb.home, bin: '/opt/kadans/bin/kadans.mjs', apply: true, now });
  const a = go('install');
  const b = go('uninstall');
  assert.notEqual(a.backup, b.backup);
  assert.equal(backups(sb).length, 2);
  assert.equal(readFileSync(a.backup, 'utf8'), original); // the pre-install settings survive
});

// ---- fix-2: quoting of odd checkout paths ----
const ODD_PATHS = [
  '/opt/My "Quoted" dir/bin/kadans.mjs',
  '/opt/$HOME and $(echo x)/bin/kadans.mjs',
  '/opt/back`tick`/bin/kadans.mjs',
  '/opt/back\\slash/bin/kadans.mjs',
  "/opt/it's here/bin/kadans.mjs",
  '/opt/all "of" $them `at` \\ once \'x\'/bin/kadans.mjs',
];

test('kadansCommand gives a working /bin/sh command for paths with quotes, $, backticks, backslashes and spaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'kadans-q-'));
  for (const [i, p] of ODD_PATHS.entries()) {
    const dir = join(root, String(i));
    const bin = join(dir, p.replace(/^\/opt\//, ''));
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    const cmd = kadansCommand(bin);
    assert.ok(cmd.startsWith('node '), cmd);
    // the shell must hand the path over as one literal word (printf shows exactly what argv would be)
    const words = spawnSync('/bin/sh', ['-c', `printf '%s\\0' ${cmd.slice(5)} hook stop`], { encoding: 'utf8' });
    assert.deepEqual(words.stdout.split('\0').slice(0, -1), [bin, 'hook', 'stop'], p);
    if (!p.includes('\\')) {
      // real node run (node itself cannot start an .mjs entry whose path has a backslash)
      const r = spawnSync('/bin/sh', ['-c', `${cmd} hook stop`], { encoding: 'utf8', env: { PATH: process.env.PATH } });
      assert.equal(r.status, 0, `${p}: ${r.stderr}`);
      assert.deepEqual(JSON.parse(r.stdout), ['hook', 'stop'], p);
    }
    // and the merged hook commands are still recognised as ours: a second merge adds nothing, uninstall removes everything
    const merged = mergeSettings({}, cmd).settings;
    assert.deepEqual(mergeSettings(merged, cmd).settings, merged, p);
    assert.deepEqual(unmergeSettings(merged, null), { hooks: {} }, p);
  }
});

test('the old double-quoted install form still counts as ours (no duplicates on update, removed on uninstall)', () => {
  const oldCmd = 'node "/Users/me/Projects/kadans/bin/kadans.mjs"';
  const old = mergeSettings(FIXTURE, oldCmd).settings;
  const up = mergeSettings(old, kadansCommand('/Users/me/Projects/kadans/bin/kadans.mjs')).settings;
  assert.deepEqual(up, old);
  assert.deepEqual(unmergeSettings(old, FIXTURE.statusLine), FIXTURE);
});

test('install adds no separate lean hooks: lean runs inside hook event / pace-pre / pace-post', () => {
  const { settings: s } = mergeSettings(FIXTURE, CMD);
  const leanGroups = Object.values(s.hooks).flat().filter((g) => g.hooks.some((h) => / hook lean$/.test(h.command)));
  assert.equal(leanGroups.length, 0);
  assert.deepEqual(unmergeSettings(s, FIXTURE.statusLine), FIXTURE);
});
