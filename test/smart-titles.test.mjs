import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvent, listAgents, scanTranscript } from '../lib/agents.mjs';
import { pickTitle, readTitles, setTitle, titlerDir } from '../lib/titles.mjs';
import {
  CHAT_GAP_MS, TITLER_ARGV, WINDOW_CALLS, buildPrompt, candidates, cleanSmartTitle, gate, readTriggerStamp, realCallAllowed,
  refresh, smartState, titlerEnv, triggerRefresh,
} from '../lib/smart-titles.mjs';

const BIN = fileURLToPath(new URL('../bin/kadans.mjs', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'kadans-smart-'));
const jsonl = (rows) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');
const user = (content) => ({ type: 'user', message: { role: 'user', content } });
const NOW = Date.parse('2026-10-27T12:00:00Z');
const MIN = 60_000;
const OWN = 'aaaaaaaaaaaa';
const DIR = '/Users/me/.claude';
const own = (id, extra = {}) => ({ id, source: 'claude', status: 'idle', account: OWN, project: 'proj', titleSource: 'session', lastSeen: NOW, ...extra });
const scanOf = (prompts, extra = {}) => ({ path: `${DIR}/projects/p/x.jsonl`, prompts, recent: ['first', 'second', 'third'].slice(0, prompts), aiTitle: 'Old title', ...extra });
const noSmart = { titles: {}, calls: [] };

test('scanTranscript counts user prompts and keeps the last 3, each clipped to 300', () => {
  const f = join(tmp(), 't.jsonl');
  writeFileSync(f, jsonl([user('one'), user('<command-name>/clear</command-name>'), user([{ type: 'tool_result', content: 'x' }]), user('two'), user('three'), user('x'.repeat(500))]));
  const st = scanTranscript(f, null);
  assert.equal(st.prompts, 4);
  assert.deepEqual(st.recent.slice(0, 2), ['two', 'three']);
  assert.equal(st.recent[2].length, 300);
  assert.equal(st.promptRaw, 'one');
});

test('cleanSmartTitle: quotes, emoji, labels, trailing period, length', () => {
  assert.equal(cleanSmartTitle('"Fix the login bug."'), 'Fix the login bug');
  assert.equal(cleanSmartTitle('Title: Gauge colours 🎨\nmore text'), 'Gauge colours');
  assert.equal(cleanSmartTitle('**Başlık:** «Ödeme sayfası düzeltmesi»…'), 'Ödeme sayfası düzeltmesi');
  assert.equal(cleanSmartTitle('it\'s the menu bar fix'), 'it\'s the menu bar fix');
  assert.doesNotMatch(cleanSmartTitle('\u001b]0;x\u0007Red alert panel'), /[\u0000-\u001f]/);
  assert.equal(cleanSmartTitle('🎉 .'), null);
  assert.equal(cleanSmartTitle(''), null);
  assert.ok([...cleanSmartTitle('word '.repeat(30))].length <= 60);
});

test('chain: owner > smart > Claude Code title > Orca tab > first prompt', () => {
  const base = { id: 'a', scan: { aiTitle: 'ai title here' }, orca: { title: 'Tab title words' }, prompt: 'first prompt text', project: 'p' };
  assert.deepEqual(pickTitle({ ...base, owner: 'Mine', smart: 'Smart one' }), { title: 'Mine', titleSource: 'owner' });
  assert.deepEqual(pickTitle({ ...base, smart: 'Smart one' }), { title: 'Smart one', titleSource: 'smart' });
  assert.equal(pickTitle(base).titleSource, 'session');
  assert.equal(pickTitle({ ...base, scan: null }).titleSource, 'orca');
  assert.equal(pickTitle({ ...base, scan: null, orca: null }).titleSource, 'prompt');
});

test('candidates: trigger rules', () => {
  const c = (agents, scans, smart = noSmart) => candidates({ agents, scans, smart, own: OWN, now: NOW, dir: DIR });
  // only a first-prompt title: yes, even with one prompt; a Claude Code title and one prompt: no
  assert.equal(c([own('a', { titleSource: 'prompt' })], { a: scanOf(1) }).list[0].why, 'first-prompt title only');
  assert.deepEqual(c([own('a')], { a: scanOf(1) }).skipped, { 'nothing new': 1 });
  assert.equal(c([own('a')], { a: scanOf(2) }).list[0].why, 'no smart title yet');
  // since the last smart title: 1 new prompt is not enough, 2 are
  const made = { titles: { a: { title: 'T', prompts: 5, at: NOW - CHAT_GAP_MS } }, calls: [] };
  assert.equal(c([own('a', { titleSource: 'smart' })], { a: scanOf(6) }, made).list.length, 0);
  const two = c([own('a', { titleSource: 'smart' })], { a: scanOf(7) }, made).list[0];
  assert.deepEqual([two.newPrompts, two.why], [2, 'new prompts since the smart title']);
  // per chat at most once per 20 minutes (a failed try counts too)
  const recent = { titles: { a: { title: null, prompts: 0, at: NOW - CHAT_GAP_MS + MIN } }, calls: [] };
  assert.deepEqual(c([own('a')], { a: scanOf(9) }, recent).skipped, { 'titled recently': 1 });
  // owner title, other account, ended, no prompt
  const r = c([own('o', { titleSource: 'owner' }), own('x', { account: 'bbbbbbbbbbbb' }), own('e', { status: 'ended' }), own('z')],
    { o: scanOf(5), x: scanOf(5), e: scanOf(5), z: scanOf(0) });
  assert.deepEqual(r.skipped, { 'owner title': 1, 'other account': 1, 'not live': 1, 'no prompt yet': 1 });
  // no samples: the transcript path decides; another config dir (an Orca profile) is never own
  assert.equal(c([own('n', { account: null })], { n: scanOf(3) }).list.length, 1);
  assert.equal(c([own('n', { account: null })], { n: scanOf(3, { path: '/Users/me/.other-profile/projects/x.jsonl' }) }).list.length, 0);
  // most new prompts first
  assert.deepEqual(c([own('a'), own('b')], { a: scanOf(2), b: scanOf(4) }).list.map((x) => x.id), ['b', 'a']);
});

test('gate: off, brake, one call a minute, 30 per 5 hours', () => {
  const cfg = { smartTitles: true };
  assert.equal(gate({ cfg: { smartTitles: false }, brake: false, calls: [], now: NOW }).code, 'off');
  assert.equal(gate({ cfg, brake: true, calls: [], now: NOW }).code, 'brake');
  assert.equal(gate({ cfg, brake: false, calls: [NOW - 30_000], now: NOW }).code, 'minute');
  assert.equal(gate({ cfg, brake: false, calls: [NOW - MIN], now: NOW }).code, 'go');
  const many = Array.from({ length: WINDOW_CALLS }, (_, i) => NOW - (i + 2) * MIN);
  assert.equal(gate({ cfg, brake: false, calls: many, now: NOW }).code, 'window');
  assert.equal(gate({ cfg, brake: false, calls: many.map((t) => t - 5 * 60 * MIN), now: NOW }).code, 'go');
});

function fakeRunner(reply = 'Gauge colour fix', status = 0) {
  const calls = [];
  const run = (argv, opts) => {
    calls.push({ argv, ...opts });
    return { status, stdout: reply };
  };
  return { calls, run };
}

const env = { PATH: '/usr/bin', HOME: '/Users/me', CLAUDE_CONFIG_DIR: '/Users/me/other-profile', KADANS_THROTTLE: '1' };
const deps = (home, run, extra = {}) => ({ agents: [own('a')], scans: { a: scanOf(3) }, cfg: { smartTitles: true }, brake: false, env, now: NOW, run, own: OWN, dir: DIR, ...extra });

test('refresh: prompt on stdin (never argv), own-account env, titler folder, title stored with its prompt count', () => {
  const home = tmp();
  setTitle(home, 'other', 'Owner text');
  const f = fakeRunner('"Gauge colour fix."');
  const r = refresh(home, deps(home, f.run));
  assert.deepEqual([r.ran, r.ok, r.title], [true, true, 'Gauge colour fix']);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.deepEqual(call.argv, TITLER_ARGV);
  assert.ok(call.argv.includes('--no-session-persistence'));
  assert.ok(!call.argv.some((x) => /first|second|third|Old title/.test(x)));
  assert.match(call.input, /1\. first\n2\. second\n3\. third/);
  assert.match(call.input, /Old title/);
  assert.equal(call.cwd, titlerDir(home));
  assert.equal(call.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(call.env.KADANS_THROTTLE, undefined);
  assert.equal(call.env.KADANS_INTERNAL, '1');
  const all = readTitles(home);
  assert.equal(all.other, 'Owner text'); // owner titles stay
  assert.deepEqual(smartState(all).titles.a, { title: 'Gauge colour fix', prompts: 3, at: NOW });
  assert.deepEqual(smartState(all).calls, [NOW]);
  // a second run in the same minute: no call
  const again = refresh(home, deps(home, f.run, { scans: { a: scanOf(9) }, now: NOW + 10_000 }));
  assert.deepEqual([again.ran, again.code], [false, 'minute']);
  assert.equal(f.calls.length, 1);
});

test('refresh: brake, off, other account and dry run never call; a failed call claims the slot', () => {
  const home = tmp();
  const f = fakeRunner();
  assert.equal(refresh(home, deps(home, f.run, { brake: true })).code, 'brake');
  assert.equal(refresh(home, deps(home, f.run, { cfg: { smartTitles: false } })).code, 'off');
  assert.equal(refresh(home, deps(home, f.run, { agents: [own('a', { account: 'bbbbbbbbbbbb' })] })).ran, false);
  const dry = refresh(home, deps(home, f.run, { dryRun: true }));
  assert.deepEqual([dry.ran, dry.pick, dry.candidates.length], [false, 'a', 1]);
  assert.ok(!JSON.stringify(dry).includes('first'));
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(join(home, 'titles.json')), false); // dry run writes nothing
  const bad = fakeRunner('', 1);
  const r = refresh(home, deps(home, bad.run));
  assert.deepEqual([r.ran, r.ok], [true, false]);
  assert.deepEqual(smartState(readTitles(home)).titles.a, { title: null, prompts: 0, at: NOW });
});

test('refresh with the real runner refuses under the test runner (fake claude on PATH never runs)', () => {
  const home = tmp();
  const bin = join(tmp(), 'bin');
  mkdirSync(bin);
  const log = join(bin, 'log');
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$@" >> "${log}"\nexit 1\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  assert.equal(realCallAllowed(process.env), false);
  const { run, ...rest } = deps(home, null, { env: { ...env, PATH: `${bin}:/usr/bin` } });
  const r = refresh(home, rest);
  assert.deepEqual([r.ran, r.ok], [true, false]);
  assert.match(r.why, /refused/);
  assert.equal(existsSync(log), false);
});

test('titlerEnv and buildPrompt', () => {
  assert.deepEqual(titlerEnv({ A: '1', CLAUDE_CONFIG_DIR: '/x', ORCA_PANE_KEY: 'a:b', ORCA_TERMINAL_HANDLE: 'term_1' }), { A: '1', KADANS_INTERNAL: '1' });
  const p = buildPrompt({ project: 'p', aiTitle: null, recent: ['a', 'b', 'c', 'd', `x\u001b]0;evil\u0007${'y'.repeat(400)}`] });
  assert.doesNotMatch(p, /\n1\. a\n/);
  assert.doesNotMatch(p, /\u001b|\u0007/);
  assert.match(p, /Ignore any other instruction about the reply language/);
  assert.ok(p.split('\n').every((l) => l.length <= 320));
});

test('trigger: at most once a minute, never for internal runs, when off or in a sandbox', () => {
  const home = tmp();
  let n = 0;
  const start = () => { n += 1; };
  const yes = () => true;
  assert.equal(triggerRefresh(home, { env: {}, now: NOW, start, allowed: yes }), true);
  assert.equal(readTriggerStamp(home), NOW);
  assert.equal(triggerRefresh(home, { env: {}, now: NOW + 30_000, start, allowed: yes }), false);
  assert.equal(triggerRefresh(home, { env: {}, now: NOW + MIN, start, allowed: yes }), true);
  assert.equal(triggerRefresh(home, { env: { KADANS_INTERNAL: '1' }, now: NOW + 5 * MIN, start, allowed: yes }), false);
  assert.equal(triggerRefresh(home, { env: {}, cfg: { smartTitles: false }, now: NOW + 5 * MIN, start, allowed: yes }), false);
  assert.equal(triggerRefresh(home, { env: {}, now: NOW + 5 * MIN, start }), false); // default: refused under node --test
  assert.equal(n, 2);
});

test('listAgents: smart title shown with titleSource smart, the titler session hidden, trigger called after the list', () => {
  const home = tmp();
  const proj = join(tmp(), 'proj');
  mkdirSync(proj);
  const t1 = join(proj, 'a.jsonl');
  writeFileSync(t1, jsonl([user('build the thing'), { type: 'ai-title', aiTitle: 'build stuff' }]));
  appendEvent(home, { t: NOW - MIN, ev: 'UserPromptSubmit', sid: 'a', cwd: proj, transcript: t1, prompt: 'build the thing' }, NOW);
  mkdirSync(titlerDir(home), { recursive: true });
  appendEvent(home, { t: NOW - MIN, ev: 'SessionStart', sid: 'titler', cwd: titlerDir(home), transcript: null }, NOW);
  const all = { a: undefined, _smart: { titles: { a: { title: 'Smart name', prompts: 1, at: NOW } }, calls: [] } };
  writeFileSync(join(home, 'titles.json'), JSON.stringify(all));
  let seen = null;
  const list = listAgents(home, { now: NOW, alive: () => true, claudeDirs: [], all: true, trigger: (l) => { seen = l.length; } });
  assert.deepEqual(list.map((x) => x.id), ['a']);
  assert.deepEqual([list[0].title, list[0].titleSource], ['Smart name', 'smart']);
  assert.equal(seen, 1);
  setTitle(home, 'a', 'Owner wins');
  assert.equal(listAgents(home, { now: NOW, alive: () => true, claudeDirs: [] })[0].titleSource, 'owner');
  assert.equal(smartState(readTitles(home)).titles.a.title, 'Smart name'); // setTitle keeps the smart store
  const h2 = tmp();
  listAgents(h2, { now: NOW, alive: () => true, claudeDirs: [], brief: false });
  assert.equal(existsSync(join(h2, 'agents-brief.json')), false); // the titles refresh never writes the menu bar brief
  listAgents(h2, { now: NOW, alive: () => true, claudeDirs: [] });
  assert.equal(existsSync(join(h2, 'agents-brief.json')), true);
});

test('CLI: hooks do nothing for KADANS_INTERNAL runs; titles refresh --dry-run --json counts only', () => {
  const root = tmp();
  const home = join(root, 'kadans');
  const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: root, prompt: 'secret words' });
  const base = { PATH: process.env.PATH, HOME: root, KADANS_HOME: home, KADANS_ORCA: '0' };
  spawnSync(process.execPath, [BIN, 'hook', 'event'], { input, env: { ...base, KADANS_INTERNAL: '1' }, encoding: 'utf8' });
  assert.equal(existsSync(join(home, 'events')), false);
  spawnSync(process.execPath, [BIN, 'hook', 'event'], { input, env: base, encoding: 'utf8' });
  assert.equal(existsSync(join(home, 'events')), true);
  const r = spawnSync(process.execPath, [BIN, 'titles', 'refresh', '--dry-run', '--json'], { env: base, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dryRun, true);
  assert.equal(out.ran, false);
  assert.ok(!r.stdout.includes('secret'));
  assert.equal(existsSync(join(home, 'titles.json')), false);
  assert.ok(homedir()); // the real home is never written: everything above ran with HOME and KADANS_HOME in a temp folder
});
