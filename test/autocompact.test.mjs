import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOUR_MS, WHY, isOwnChat, pick, readAutoCompactState, recentAutoCompacts, renderTick, runTick, tickJson, whyOf } from '../lib/autocompact.mjs';
import { DIALOG_REFUSAL, DRAFT_REFUSAL, cacheWarm } from '../lib/compact.mjs';
import { appendEvent, compactAgent } from '../lib/agents.mjs';
import { accountKey, appendSample } from '../lib/samples.mjs';
import { loadConfig } from '../lib/pace.mjs';
import { parseSetting } from '../lib/config.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
const MIN = 60_000;
const NOW = Date.parse('2026-10-27T12:00:00Z');
const OWN = 'aaaaaaaaaaaa';
const DIR = '/u/.claude';
const tmp = () => mkdtempSync(join(tmpdir(), 'kadans-autocompact-'));
const ON = () => ({ ...loadConfig(tmp()), autoCompact: true });

// An idle own chat in Orca, 150k context, last request 15 min ago with a 1-hour cache: eligible as it is.
const row = (over = {}) => ({ id: 's1', source: 'claude', status: 'idle', account: OWN, lastSeen: NOW - 15 * MIN, pid: null,
  context: { tokens: 150_000, window: 200_000, pct: 75, advice: 'none', why: null },
  orca: { terminal: 'term_A', worktree: 'w', repo: 'r', state: 'done', title: 'SECRET-TITLE' }, title: 'SECRET-TITLE', firstPrompt: 'SECRET-PROMPT', ...over });
const scan = (over = {}) => ({ path: `${DIR}/projects/-r/s1.jsonl`, ctxAt: NOW - 15 * MIN, cache1h: true, prompts: 3, ...over });
const opts = (scans = { s1: scan() }) => ({ scans, own: OWN, dir: DIR });
const none = { runs: [] };

// screens for the live check (the same shapes compact.test.mjs uses)
const RULE = '─'.repeat(60);
const EMPTY = ['  ⏺ Done.', '', RULE, '❯ ', RULE, '  ? for shortcuts'];
const TYPED = ['  ⏺ Done.', '', RULE, '❯ please also rename the helper', RULE, '  ? for shortcuts'];
const DIALOG = [' Bash command', '   rm -rf build', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'];
const screen = (tail) => JSON.stringify({ ok: true, result: { terminal: { handle: 'term_A', status: 'running', source: 'screen', tail, nextCursor: null } } });
const runner = (tail, calls) => (args) => {
  calls.push(args);
  return args[1] === 'read' ? screen(tail) : '{"ok":true}';
};

test('config: auto-compact is off by default with its three numbers; off does nothing at all', () => {
  const c = loadConfig(tmp());
  assert.equal(c.autoCompact, false);
  assert.equal(c.autoCompactIdleMin, 10);
  assert.equal(c.autoCompactMinTokens, 120_000);
  assert.equal(c.autoCompactPerHour, 4);
  assert.equal(pick([row()], none, NOW, c, opts()).why, 'off');
  const home = tmp();
  let listed = 0;
  let typed = 0;
  const r = runTick(home, c, { list: () => { listed++; return [row()]; }, scans: () => ({ s1: scan() }), own: OWN, dir: DIR, now: NOW, compact: () => { typed++; return { ok: true }; } });
  assert.deepEqual(tickJson(r), { compacted: null, why: 'off' });
  assert.equal(typed, 0);
  assert.equal(existsSync(join(home, 'autocompact.json')), false);
  assert.ok(listed <= 1);
});

test('pick: an eligible chat goes; each rule refuses with its own reason', () => {
  const cfg = ON();
  assert.equal(pick([row()], none, NOW, cfg, opts()).agent.id, 's1');
  const why = (r, s = scan(), state = none, c = cfg) => pick([r], state, NOW, c, opts({ s1: s })).why;
  assert.equal(why(row({ status: 'working' })), 'working');
  assert.equal(why(row({ status: 'needs-you' })), 'needs-you');
  assert.equal(why(row({ asked: true })), 'needs-you'); // its last reply asked a question, now past the needs-you time
  assert.equal(why(row({ status: 'ended' })), 'ended');
  assert.equal(why(row({ machine: 'mini', id: 's1' })), 'remote');
  assert.equal(why(row({ source: 'orca' })), 'not-claude');
  assert.equal(why(row({ account: 'bbbbbbbbbbbb' })), 'other-account'); // another account's samples
  // another account's profile: its own projects folder, outside the own one (here a temp layout built at runtime)
  const other = join(tmp(), 'profiles', 'p1', 'projects', '-r', 's1.jsonl');
  assert.equal(why(row({ account: null }), scan({ path: other })), 'other-account');
  assert.equal(why(row(), scan({ path: other })), 'other-account'); // own samples key, but the file is not in the own projects folder
  assert.equal(why(row(), scan({ path: `${DIR}/profiles/p1/projects/-r/s1.jsonl` })), 'other-account'); // even inside the own config dir
  assert.equal(why(row({ account: null }), scan({ path: '/elsewhere/s1.jsonl' })), 'other-account');
  assert.equal(why(row({ orca: null })), 'no-terminal');
  assert.equal(why(row({ orca: { terminal: 'term_A', ambiguous: true } })), 'no-terminal');
  assert.equal(why(row({ context: { tokens: 90_000, window: 200_000, advice: 'none' } })), 'too-small');
  assert.equal(why(row({ context: null })), 'too-small');
  assert.notEqual(why(row({ context: { tokens: 90_000, window: 200_000, advice: 'soon' } })), 'too-small'); // advised counts
  assert.equal(why(row(), scan({ ctxAt: NOW - 4 * MIN })), 'idle-short');
  assert.equal(why(row(), scan({ ctxAt: NOW - 61 * MIN })), 'cache-cold'); // 1-hour cache gone
  assert.equal(why(row(), scan({ cache1h: false })), 'cache-cold'); // 5-minute cache, idle 15 min
  assert.equal(why(row(), scan({ cache1h: null })), 'cache-cold');
  assert.equal(why(row(), scan({ ctxAt: null })), 'cache-cold'); // unknown: fail closed
  assert.equal(why(row(), scan(), { runs: [{ id: 's1', t: NOW - 3 * HOUR_MS, tokens: 1, prompts: 3, ok: true }] }), 'this-stretch');
  assert.equal(why(row(), scan({ prompts: 4 }), { runs: [{ id: 's1', t: NOW - 3 * HOUR_MS, tokens: 1, prompts: 3, ok: true }] }), undefined); // a new prompt since: a new stretch
  assert.equal(why(row({ lastSeen: NOW - MIN })), 'owner-active');
  const four = { runs: [1, 2, 3, 4].map((i) => ({ id: `x${i}`, t: NOW - i * 10 * MIN, tokens: 1, prompts: 1, ok: true })) };
  assert.equal(why(row(), scan(), four), 'cap');
  assert.equal(why(row(), scan(), { runs: four.runs.map((r, i) => (i === 3 ? { ...r, t: NOW - HOUR_MS - MIN } : r)) }), undefined); // an older one no longer counts
  assert.equal(why(row(), scan(), { runs: four.runs.map((r, i) => (i === 3 ? { ...r, ok: false } : r)) }), undefined); // failed tries do not count
  assert.equal(pick([], none, NOW, cfg, opts()).why, 'no-chat');
  // a 5-minute-cache chat qualifies only when the owner lowers the idle time below its window
  assert.equal(why(row(), scan({ cache1h: false, ctxAt: NOW - 3 * MIN }), none, { ...cfg, autoCompactIdleMin: 2 }), undefined);
  for (const w of ['working', 'needs-you', 'remote', 'other-account', 'cache-cold', 'too-small', 'this-stretch', 'owner-active', 'cap', 'draft', 'dialog']) assert.ok(WHY.includes(w), w);
});

test('pick: several chats -> one, the biggest; none eligible -> the reason of the one that got furthest', () => {
  const cfg = ON();
  const a = row({ id: 'a', context: { tokens: 130_000, window: 200_000, advice: 'none' } });
  const b = row({ id: 'b', context: { tokens: 400_000, window: 1_000_000, advice: 'none' } });
  const d = pick([a, b], none, NOW, cfg, opts({ a: scan(), b: scan() }));
  assert.equal(d.agent.id, 'b');
  const w = row({ id: 'w', status: 'working', context: { tokens: 500_000, window: 1_000_000 } });
  const c = row({ id: 'c' });
  assert.equal(pick([w, c], none, NOW, cfg, opts({ w: scan(), c: scan({ cache1h: false }) })).why, 'cache-cold');
});

test('cacheWarm: the same windows compactAdvice uses', () => {
  assert.equal(cacheWarm({ idleMs: 4 * MIN, cache1h: false }), true);
  assert.equal(cacheWarm({ idleMs: 5 * MIN, cache1h: false }), false);
  assert.equal(cacheWarm({ idleMs: 59 * MIN, cache1h: true }), true);
  assert.equal(cacheWarm({ idleMs: 60 * MIN, cache1h: true }), false);
  assert.equal(cacheWarm({ idleMs: null, cache1h: true }), false);
  assert.equal(isOwnChat({ account: null }, { path: `${DIR}/projects/x.jsonl` }, { own: OWN, dir: DIR }), true);
});

test('runTick: one compact per tick through the live check; draft, dialog and an unreadable screen refuse and send nothing', () => {
  const cfg = ON();
  const deps = (home, rows, tail, calls) => ({ list: () => rows, scans: () => Object.fromEntries(rows.map((r) => [r.id, scan()])), own: OWN, dir: DIR, now: NOW,
    compact: (agent) => compactAgent(agent, { run: runner(tail, calls) }) });
  // two eligible chats: one read, one send, the bigger chat
  let calls = [];
  const home = tmp();
  const notes = [];
  const two = [row({ id: 'a' }), row({ id: 'b', context: { tokens: 180_000, window: 200_000, advice: 'none' } })];
  const r = runTick(home, cfg, { ...deps(home, two, EMPTY, calls), notify: (t, b) => notes.push([t, b]) });
  assert.deepEqual(tickJson(r), { compacted: 'b', why: 'compacted' });
  assert.deepEqual(calls.map((c) => c[1]), ['read', 'send']);
  assert.deepEqual(calls[1], ['terminal', 'send', '--terminal', 'term_A', '--text', '/compact', '--enter']);
  assert.equal(notes.length, 1); // one notify line per compact, no chat text
  assert.doesNotMatch(JSON.stringify(notes), /SECRET/);
  // the same tick again: b is done for this stretch, a goes next
  calls = [];
  assert.equal(runTick(home, cfg, deps(home, two, EMPTY, calls)).compacted, 'a');
  for (const [tail, code] of [[TYPED, 'draft'], [DIALOG, 'dialog'], [null, 'unreadable']]) {
    const c = [];
    const h = tmp();
    const t = runTick(h, cfg, deps(h, [row()], tail, c));
    assert.deepEqual(tickJson(t), { compacted: null, why: code });
    assert.deepEqual(c.map((x) => x[1]), ['read']); // read only, never sent
    const st = readAutoCompactState(h);
    assert.equal(st.runs.length, 1);
    assert.equal(st.runs[0].ok, false);
    // a refused try neither counts toward the cap nor blocks the next tick
    assert.equal(pick([row()], st, NOW + MIN, cfg, opts()).go, true);
  }
});

test('runTick: the record file is 0600 and holds no text; --dry-run reads, sends and writes nothing', () => {
  const cfg = ON();
  const home = tmp();
  const calls = [];
  const deps = { list: () => [row()], scans: () => ({ s1: scan() }), own: OWN, dir: DIR, now: NOW, compact: (a) => compactAgent(a, { run: runner(EMPTY, calls) }) };
  const dry = runTick(home, cfg, { ...deps, dryRun: true });
  assert.deepEqual(tickJson(dry), { compacted: null, why: 'would-compact' });
  assert.match(renderTick(dry), /^dry run: would compact s1 \(150k context\)/);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(join(home, 'autocompact.json')), false);
  runTick(home, cfg, deps);
  const file = join(home, 'autocompact.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const text = readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /SECRET|term_A|compact |❯/);
  const { runs } = JSON.parse(text);
  assert.equal(runs.length, 1);
  assert.deepEqual(Object.keys(runs[0]).sort(), ['id', 'ok', 'prompts', 't', 'tokens', 'why']);
  assert.deepEqual(runs[0], { id: 's1', t: NOW, tokens: 150_000, prompts: 3, ok: true, why: 'compacted' });
  assert.deepEqual([...recentAutoCompacts(home, NOW + 3 * MIN)], [['s1', NOW]]);
  assert.equal(recentAutoCompacts(home, NOW + 11 * MIN).size, 0);
});

test('whyOf maps compactAgent refusals; anything unknown is a refusal', () => {
  assert.equal(whyOf(DRAFT_REFUSAL), 'draft');
  assert.equal(whyOf(DIALOG_REFUSAL), 'dialog');
  assert.equal(whyOf("Could not read that chat's screen (not JSON): type /compact there yourself"), 'unreadable');
  assert.equal(whyOf('pid 42 is no longer a claude process'), 'pid');
  assert.equal(whyOf('something new'), 'refused');
});

test('config keys round-trip through parseSetting; out of range refused', () => {
  assert.deepEqual(parseSetting('autoCompact', 'true', OWN), { path: ['autoCompact'], value: true });
  assert.deepEqual(parseSetting('autoCompactMinTokens', '150000', OWN), { path: ['autoCompactMinTokens'], value: 150_000 });
  assert.match(parseSetting('autoCompactMinTokens', '1000000', OWN).error, /20000-900000/);
  assert.match(parseSetting('autoCompactIdleMin', '1', OWN).error, /2-120/);
  assert.match(parseSetting('autoCompactPerHour', '13', OWN).error, /1-12/);
});

// ---------- CLI (fake orca only; a temp HOME, so ~/.claude is the sandbox's) ----------

function sandbox({ tail = EMPTY } = {}) {
  const root = tmp();
  const home = join(root, 'kadans');
  const proj = join(root, 'repo');
  mkdirSync(join(proj, '.git'), { recursive: true });
  mkdirSync(home);
  const now = Date.now();
  const at = now - 15 * MIN;
  const own = join(root, '.claude');
  const t = join(own, 'projects', '-repo', 's1.jsonl');
  mkdirSync(dirname(t), { recursive: true });
  const asst = { type: 'assistant', timestamp: new Date(at).toISOString(), message: { id: 'm1', model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 2, output_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 149_000, cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 } } } };
  writeFileSync(t, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'SECRET-PROMPT plan the release' } })}\n${JSON.stringify(asst)}\n`);
  utimesSync(t, new Date(at), new Date(at));
  appendSample(home, accountKey(own), { t: at, session_id: 's1', cwd: proj, transcript: t, model: 'claude-opus-5', limits: { five_hour: { pct: 1, resetsAt: now + 3600e3 } } }, now);
  appendEvent(home, { t: at - MIN, ev: 'UserPromptSubmit', sid: 's1', cwd: proj, transcript: t, prompt: 'SECRET-PROMPT plan the release' }, now);
  appendEvent(home, { t: at, ev: 'Stop', sid: 's1', cwd: proj, transcript: t, asked: false }, now);
  const log = join(root, 'orca.log');
  writeFileSync(join(root, 'screen.json'), screen(tail));
  writeFileSync(join(root, 'ps.json'), JSON.stringify({ ok: true, result: { worktrees: [{ path: proj, repo: 'repo', displayName: 'main', agents: [{ paneKey: 't1:l1', state: 'done', agentType: 'claude', prompt: 'SECRET-PROMPT plan the release', updatedAt: at, stateStartedAt: at }] }] } }));
  writeFileSync(join(root, 'tl.json'), JSON.stringify({ ok: true, result: { terminals: [{ handle: 'term_A', tabId: 't1', leafId: 'l1', title: 'main' }] } }));
  const fake = join(root, 'fake-orca.sh');
  writeFileSync(fake, `#!/bin/sh\necho "$*" >> "${log}"\ncase "$1 $2" in\n  "worktree ps") cat "${join(root, 'ps.json')}" ;;\n  "terminal list") cat "${join(root, 'tl.json')}" ;;\n  "terminal read") cat "${join(root, 'screen.json')}" ;;\n  "terminal send") echo '{"ok":true}' ;;\n  *) exit 3 ;;\nesac\n`);
  chmodSync(fake, 0o755);
  const env = { PATH: process.env.PATH, HOME: root, KADANS_HOME: home, CLAUDE_CONFIG_DIR: own, KADANS_ORCA_BIN: fake, KADANS_ORCA_TIMEOUT_MS: '30000' };
  return { root, home, log, env };
}
const cli = (env, args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 20000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const lines = (log, what) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith(`terminal ${what}`)) : []);

test('cli: config keys round-trip through kadans config', () => {
  const sb = sandbox();
  for (const [k, v] of [['autoCompact', 'true'], ['autoCompactIdleMin', '15'], ['autoCompactMinTokens', '150000'], ['autoCompactPerHour', '2']]) {
    const r = cli(sb.env, ['config', 'set', k, v]);
    assert.equal(r.code, 0, r.err);
  }
  const j = JSON.parse(cli(sb.env, ['config', 'get', '--json']).out);
  assert.deepEqual([j.autoCompact, j.autoCompactIdleMin, j.autoCompactMinTokens, j.autoCompactPerHour], [true, 15, 150_000, 2]);
  assert.notEqual(cli(sb.env, ['config', 'set', 'autoCompactMinTokens', '5']).code, 0);
  assert.equal(JSON.parse(cli(sb.env, ['config', 'get', '--json']).out).autoCompactMinTokens, 150_000);
});

test('cli: compact tick off -> nothing; dry run sends nothing; on -> one /compact, recorded; again -> this-stretch; the row says so', () => {
  const sb = sandbox();
  const off = cli(sb.env, ['compact', 'tick', '--json']);
  assert.equal(off.code, 0, off.err);
  assert.deepEqual(JSON.parse(off.out), { compacted: null, why: 'off' });
  assert.equal(existsSync(sb.log), false); // off: not even a worktree list
  cli(sb.env, ['config', 'set', 'autoCompact', 'true']);
  const dry = cli(sb.env, ['compact', 'tick', '--dry-run', '--json']);
  assert.deepEqual(JSON.parse(dry.out), { compacted: null, why: 'would-compact' }, dry.err);
  assert.deepEqual(lines(sb.log, 'read'), []);
  assert.deepEqual(lines(sb.log, 'send'), []);
  assert.equal(existsSync(join(sb.home, 'autocompact.json')), false);
  const go = cli(sb.env, ['compact', 'tick', '--json']);
  assert.deepEqual(JSON.parse(go.out), { compacted: 's1', why: 'compacted' }, go.err);
  assert.deepEqual(lines(sb.log, 'send'), ['terminal send --terminal term_A --text /compact --enter']);
  assert.doesNotMatch(readFileSync(join(sb.home, 'autocompact.json'), 'utf8'), /SECRET/);
  assert.deepEqual(JSON.parse(cli(sb.env, ['compact', 'tick', '--json']).out), { compacted: null, why: 'this-stretch' });
  assert.equal(lines(sb.log, 'send').length, 1);
  const [a] = JSON.parse(cli(sb.env, ['agents', '--json']).out);
  assert.ok(Number.isFinite(a.autoCompactedAt));
  assert.equal(cli(sb.env, ['compact', 'nope']).code, 2);
});

test('cli: compact tick skips a chat with a draft and sends nothing', () => {
  const sb = sandbox({ tail: TYPED });
  cli(sb.env, ['config', 'set', 'autoCompact', 'true']);
  const r = cli(sb.env, ['compact', 'tick']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^not compacted: it has unsent text/);
  assert.equal(lines(sb.log, 'read').length, 1);
  assert.deepEqual(lines(sb.log, 'send'), []);
});

// ---------- panel (Settings › Advanced and the row meta; fake DOM) ----------

test('panel: Settings "Compact idle chats automatically": hidden for an older CLI, off by default, one config-set when tapped', async () => {
  const { loadPanel } = await import('./panel-dom.mjs');
  const p = loadPanel();
  const F = p.window.KADANS_FIXTURES;
  const open = (f) => {
    p.window.kadans.reset();
    p.window.kadans.render(f);
    f.after(p.document);
  };
  open(F.settings_advanced); // config without autoCompact: no row
  assert.equal(p.el.find('set:autoCompact'), null);
  open(F.settings_autocompact_off);
  const sw = p.el.find('set:autoCompact');
  assert.equal(sw.getAttribute('aria-checked'), 'false');
  assert.match(p.html(), /Compact idle chats automatically<\/div><div class="d">Types \/compact into a chat that has waited 10 min with a big context, while it is still cheap\. Never while you type or a question is open\.<\/div>/);
  p.tap({ do: 'set', k: 'autoCompact', v: 'true' });
  assert.deepEqual({ ...p.sent.at(-1) }, { action: 'config-set', key: 'autoCompact', value: 'true' });
  open(F.settings_autocompact_on);
  assert.equal(p.el.find('set:autoCompact').getAttribute('aria-checked'), 'true');
  assert.doesNotMatch(p.html(), /autoCompactIdleMin|autoCompactMinTokens|autoCompactPerHour/); // the numbers stay config-only
});

test('panel: a row compacted by Kadans says "Auto-compacted · 3m" for 10 min', async () => {
  const { loadPanel } = await import('./panel-dom.mjs');
  const clock = { now: 9_000_000 };
  const p = loadPanel({ clock, timers: [] });
  const F = p.window.KADANS_FIXTURES;
  const base = F.compact.agents;
  const id = base[0].id;
  const N = F.compact.status.now; // the panel's clock is the status time
  const show = (at) => {
    p.window.kadans.reset();
    p.window.kadans.render({ ...F.compact, agents: base.map((a) => (a.id === id ? { ...a, autoCompactedAt: at } : a)) });
    return p.html();
  };
  assert.match(show(N - 3 * MIN), /Auto-compacted · 3m/);
  assert.doesNotMatch(show(N - 11 * MIN), /Auto-compacted/);
  assert.doesNotMatch(show(null), /Auto-compacted/);
});
