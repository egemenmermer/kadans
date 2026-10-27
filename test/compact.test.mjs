import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPACT_DEFAULTS, DRAFT_REFUSAL, compactAdvice, compactPlan, contextOf, contextWindow, draftGuard, inputBoxState, screenReadArgv } from '../lib/compact.mjs';
import { appendEvent, compactAgent, lastContext, renderAgents, scanTranscript, sendAgent } from '../lib/agents.mjs';
import { messageText } from '../lib/text.mjs';
import { appendSample, sampleFromPayload } from '../lib/samples.mjs';
import { loadConfig } from '../lib/pace.mjs';
import { parseSetting } from '../lib/config.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
const MIN = 60_000;
const NOW = Date.parse('2026-10-26T12:00:00Z');
const tmp = () => mkdtempSync(join(tmpdir(), 'kadans-compact-'));
const jsonl = (rows) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');
// One assistant line; ctx = input + cache writes + cache reads.
const asst = (id, { i = 1, cc = 0, cr = 0, o = 10, model = 'claude-opus-5', at = NOW, side = false, c1h = null } = {}) => ({
  type: 'assistant',
  isSidechain: side,
  timestamp: new Date(at).toISOString(),
  message: {
    id,
    model,
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: i, output_tokens: o, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, ...(c1h === null ? {} : { cache_creation: c1h ? { ephemeral_1h_input_tokens: cc, ephemeral_5m_input_tokens: 0 } : { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: cc } }) },
  },
});

// ---------- advice ----------

test('compactAdvice: thresholds at each edge, idle-cache rule, only idle sessions', () => {
  const W = 200_000;
  const a = (tokens, extra = {}) => compactAdvice({ tokens, window: W, status: 'idle', idleMs: 0, ...extra }).advice;
  // under 60k: never, even at a tiny window
  assert.equal(compactAdvice({ tokens: 59_999, window: 60_000, status: 'idle', idleMs: 60 * MIN }).advice, 'none');
  assert.equal(compactAdvice({ tokens: 60_000, window: 60_000, status: 'idle', idleMs: 0 }).advice, 'now');
  // soon at 40 %, now at 60 % (exact edges and one token below)
  assert.equal(a(79_999), 'none');
  assert.equal(a(80_000), 'soon');
  assert.equal(a(119_999), 'soon');
  assert.equal(a(120_000), 'now');
  // idle 5+ min with 100k+: now (cache gone); 4 min or 99,999 tokens: not by that rule
  assert.equal(a(100_000, { idleMs: 5 * MIN }), 'now');
  assert.equal(a(100_000, { idleMs: 5 * MIN - 1 }), 'soon');
  assert.equal(a(99_999, { idleMs: 60 * MIN }), 'soon');
  // a 1-hour prompt cache: idle counts from 60 minutes
  assert.equal(a(100_000, { idleMs: 30 * MIN, cache1h: true }), 'soon');
  assert.equal(a(100_000, { idleMs: 60 * MIN, cache1h: true }), 'now');
  // never for a working, waiting or ended session, whatever the size
  for (const status of ['working', 'needs-you', 'ended', undefined]) {
    assert.deepEqual(compactAdvice({ tokens: 190_000, window: W, status, idleMs: 60 * MIN }), { advice: 'none', why: null }, String(status));
  }
  // why: one short sentence; the idle reason wins when both hold
  assert.deepEqual(compactAdvice({ tokens: 152_000, window: W, status: 'idle', idleMs: MIN }), { advice: 'now', why: 'Re-reads 152k tokens every turn' });
  assert.deepEqual(compactAdvice({ tokens: 130_000, window: W, status: 'idle', idleMs: 12 * MIN + 59_000 }), { advice: 'now', why: 'Idle 12 min: next turn re-reads all 130k' });
  assert.deepEqual(compactAdvice({ tokens: 90_000, window: W, status: 'idle', idleMs: 0 }), { advice: 'soon', why: 'Re-reads 90k tokens every turn' });
  // thresholds come from config
  const cfg = { soonPct: 30, nowPct: 50, idleMin: 10 };
  assert.equal(compactAdvice({ tokens: 60_000, window: W, status: 'idle' }, cfg).advice, 'soon');
  assert.equal(compactAdvice({ tokens: 100_000, window: W, status: 'idle' }, cfg).advice, 'now');
  assert.equal(compactAdvice({ tokens: 90_000, window: 1e6, status: 'idle', idleMs: 9 * MIN }, { ...cfg, idleMin: 10 }).advice, 'none');
  assert.equal(compactAdvice({ tokens: 100_000, window: 1e6, status: 'idle', idleMs: 10 * MIN }, cfg).advice, 'now');
});

test('contextWindow and contextOf: 1M for "[1m]" ids or a context over 200k; unknown model falls back to 200k; null without tokens', () => {
  assert.equal(contextWindow('claude-sonnet-5[1m]'), 1e6);
  assert.equal(contextWindow('opus-1m'), 1e6);
  assert.equal(contextWindow('claude-opus-5'), 200_000);
  assert.equal(contextWindow('claude-opus-5-21m'), 200_000);
  assert.equal(contextWindow(null), 200_000);
  assert.equal(contextWindow(null, 250_000), 1e6); // only a 1M window holds that
  assert.deepEqual(contextOf({ tokens: 150_000, model: null, status: 'idle', idleMs: 0 }), { tokens: 150_000, window: 200_000, pct: 75, advice: 'now', why: 'Re-reads 150k tokens every turn' });
  assert.deepEqual(contextOf({ tokens: 150_000, model: 'claude-opus-5[1m]', status: 'idle', idleMs: 0 }), { tokens: 150_000, window: 1e6, pct: 15, advice: 'none', why: null });
  assert.deepEqual(contextOf({ tokens: 250_000, model: undefined, status: 'working' }), { tokens: 250_000, window: 1e6, pct: 25, advice: 'none', why: null });
  assert.equal(contextOf({ tokens: null, model: 'x', status: 'idle' }), null);
  assert.equal(contextOf({ tokens: 0, model: 'x', status: 'idle' }), null);
});

// ---------- transcript ----------

test('scanTranscript: context from the newest main-chain message; sidechain, synthetic and empty lines skipped; old cache gets it from the tail', () => {
  const dir = tmp();
  const f = join(dir, 's.jsonl');
  writeFileSync(f, jsonl([
    { type: 'user', message: { role: 'user', content: 'Plan the release' } },
    asst('m1', { i: 5, cc: 1000, cr: 20_000, at: NOW - 10 * MIN }),
    asst('m2', { i: 3, cc: 2000, cr: 150_000, at: NOW - 6 * MIN, c1h: true }),
    asst('m2', { i: 3, cc: 2000, cr: 150_000, at: NOW - 6 * MIN, c1h: true }), // second block of the same message
    asst('x1', { i: 1, cc: 1, cr: 900_000, side: true, at: NOW - 5 * MIN }),
    asst('x2', { i: 0, cc: 0, cr: 0, model: '<synthetic>', at: NOW - 4 * MIN }),
  ]));
  const st = scanTranscript(f, null);
  assert.deepEqual([st.ctx, st.ctxAt, st.cache1h], [152_003, NOW - 6 * MIN, true]);
  // incremental: a newer message replaces it; a message with no cache write keeps the known cache lifetime
  writeFileSync(f, readFileSync(f, 'utf8') + jsonl([asst('m3', { i: 7, cc: 0, cr: 160_000, at: NOW - MIN, c1h: false })]));
  const next = scanTranscript(f, st);
  assert.deepEqual([next.ctx, next.ctxAt, next.cache1h], [160_007, NOW - MIN, true]);
  // a cached state from before this field (same scan version, no ctx key) is filled from the tail, not rescanned
  const { ctx, ctxAt, cache1h, ...old } = next;
  const migrated = scanTranscript(f, old);
  assert.equal(migrated.offset, next.offset);
  assert.equal(migrated.ctx, 160_007);
  assert.deepEqual(lastContext(join(dir, 'missing.jsonl')), { ctx: null, ctxAt: null, cache1h: null });
  // the 5-minute cache is reported as such
  writeFileSync(f, jsonl([asst('m9', { i: 1, cc: 500, cr: 70_000, at: NOW, c1h: false })]));
  assert.equal(scanTranscript(f, null).cache1h, false);
});

test('sampleFromPayload keeps the status line model id (for the context window); none when absent', () => {
  const rl = { five_hour: { used_percentage: 1, resets_at: NOW / 1000 + 3600 } };
  assert.equal(sampleFromPayload({ rate_limits: rl, model: { id: 'claude-opus-5[1m]', display_name: 'Opus' } }, NOW).model, 'claude-opus-5[1m]');
  assert.equal('model' in sampleFromPayload({ rate_limits: rl }, NOW), false);
});

// ---------- compact ----------

const idleRow = { id: 's1', source: 'claude', status: 'idle', pid: null, orca: { terminal: 'term_A', worktree: 'w', repo: 'r', state: 'done', title: 't' } };
const SEND = ['terminal', 'send', '--terminal', 'term_A', '--text', '/compact', '--enter'];
const READ = ['terminal', 'read', '--terminal', 'term_A', '--screen', '--json'];

// Fixture screens (rendered, top to bottom) as `orca terminal read --screen --json` answers them. No real chat text.
const RULE = '─'.repeat(60);
const EMPTY = ['  ⏺ Done. The tests pass.', '', RULE, '❯ ', RULE, '  ? for shortcuts'];
const TYPED = ['  ⏺ Done. The tests pass.', '', RULE, '❯ please also rename the helper and', RULE, '  ? for shortcuts'];
const MULTI = ['  ⏺ Done.', '', RULE, '❯ first line', '  second line', RULE, '  ? for shortcuts'];
const BOXED = ['  ⏺ Done.', '╭' + '─'.repeat(58) + '╮', '│ >                                                        │', '╰' + '─'.repeat(58) + '╯', '  ? for shortcuts'];
const BOXED_TEXT = ['  ⏺ Done.', '╭' + '─'.repeat(58) + '╮', '│ > half a thought                                         │', '╰' + '─'.repeat(58) + '╯'];
const DIALOG = [' Bash command', '   rm -rf build', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and do not ask again', '   3. No, and tell Claude what to do differently', '', ' Esc to cancel'];
const screen = (tail, over = {}) => JSON.stringify({ ok: true, result: { terminal: { handle: 'term_A', status: 'running', source: 'screen', tail, nextCursor: null, ...over } } });
// A runner that answers the screen read with `answer` (a string or a function) and records every call.
const runner = (answer, calls = []) => (args) => {
  calls.push(args);
  if (args[1] === 'read') return typeof answer === 'function' ? answer() : answer;
  return '{"ok":true}';
};

test('compactAgent: refused for working, waiting, ended, ambiguous, Orca-only and no-Orca chats; nothing sent', () => {
  const calls = [];
  const run = runner(screen(EMPTY), calls);
  const why = (row, deps = {}) => compactAgent(row, { run, ...deps }).why;
  assert.match(why({ ...idleRow, status: 'working' }), /working/);
  assert.match(why({ ...idleRow, status: 'needs-you' }), /question or permission/);
  assert.match(why({ ...idleRow, status: 'ended' }), /ended/);
  assert.match(why({ ...idleRow, orca: { ...idleRow.orca, ambiguous: true } }), /several Claude sessions.*Type \/compact in that chat/);
  assert.match(why({ ...idleRow, orca: null }), /not run in an Orca terminal.*Type \/compact in that chat/);
  assert.match(why({ ...idleRow, orca: { ...idleRow.orca, terminal: null } }), /Type \/compact in that chat/);
  assert.match(why({ ...idleRow, id: 'orca:term_A', source: 'orca' }), /Type \/compact in that chat/);
  assert.match(compactAgent(idleRow, { run: null }).why, /orca CLI is not available/);
  // pid checks as for stop: a pid that is no longer claude, or was reused by a newer claude process
  const pidRow = { ...idleRow, pid: 77, pidAt: NOW };
  assert.match(why(pidRow, { ps: () => ({ ppid: 1, comm: 'Safari' }) }), /no longer a claude process/);
  assert.match(why(pidRow, { ps: () => ({ ppid: 1, comm: '/opt/bin/claude' }), started: () => NOW + 60 * MIN }), /newer process/);
  assert.match(why(pidRow, { ps: () => null, dryRun: true }), /no longer a claude process/);
  assert.deepEqual(calls, []);
  assert.equal(compactPlan({ ...idleRow, status: 'idle' }).ok, true);
});

test('compactAgent: dry run gives the exact argv and runs nothing; a real one sends exactly that through the runner', () => {
  const calls = [];
  const run = runner(screen(EMPTY), calls);
  const dry = compactAgent(idleRow, { run, dryRun: true });
  const how = `would read the screen: ${JSON.stringify(['orca', ...READ])}, and only if the input line is empty run: ${JSON.stringify(['orca', ...SEND])}`;
  assert.deepEqual(dry, { ok: true, argv: ['orca', ...SEND], readArgv: ['orca', ...READ], how });
  assert.deepEqual(calls, []);
  const pidRow = { ...idleRow, pid: 77, pidAt: NOW };
  const ok = compactAgent(pidRow, { run, ps: () => ({ ppid: 1, comm: '/opt/bin/claude' }), started: () => NOW - 30 * MIN });
  assert.deepEqual(ok, { ok: true, argv: ['orca', ...SEND], how: 'sent /compact to Orca terminal term_A' });
  assert.deepEqual(calls, [READ, SEND]); // read first, then send
  const failing = compactAgent(idleRow, { run: (args) => { if (args[1] === 'read') return screen(EMPTY); throw new Error('orca terminal send failed: gone'); } });
  assert.deepEqual(failing, { ok: false, why: 'orca terminal send failed: gone' });
});

test('inputBoxState: empty prompt, typed text (also several lines, boxed layout), dialogs and unreadable screens', () => {
  assert.equal(inputBoxState(EMPTY), 'empty');
  assert.equal(inputBoxState([...EMPTY, '', '']), 'empty'); // trailing blank rows
  assert.equal(inputBoxState(BOXED), 'empty');
  assert.equal(inputBoxState(TYPED), 'text');
  assert.equal(inputBoxState(MULTI), 'text'); // the draft goes on below the first line
  assert.equal(inputBoxState(BOXED_TEXT), 'text');
  assert.equal(inputBoxState(['  ⏺ Done.', RULE, '❯ x', RULE]), 'text'); // no footer row at all
  assert.equal(inputBoxState(['  ⏺ Done.', RULE, '❯', RULE, '  ? for shortcuts']), 'empty'); // trailing space trimmed by the renderer
  assert.equal(inputBoxState(DIALOG), 'dialog');
  assert.equal(inputBoxState(['  ⏺ Working', '', ' ✻ Thinking… (esc to interrupt)', RULE, '❯ ', RULE]), 'dialog'); // busy: not a prompt to type into
  assert.equal(inputBoxState([]), 'unknown');
  assert.equal(inputBoxState(['', '  ']), 'unknown');
  assert.equal(inputBoxState(['$ ls', 'a b c']), 'unknown'); // a plain shell, no input box
  assert.equal(inputBoxState([RULE, '$ ', RULE]), 'unknown'); // a box without the prompt marker
  assert.equal(inputBoxState(['  ⏺ Done.', RULE, RULE]), 'unknown'); // nothing between the rules
  assert.equal(inputBoxState([RULE, '❯ ', RULE, ...Array(8).fill('  more output')]), 'unknown'); // box not at the bottom
  assert.equal(inputBoxState(null), 'unknown');
  assert.equal(inputBoxState([42, null]), 'unknown');
  // numbered text in the chat above the box is not a dialog; only the selection marker is
  assert.equal(inputBoxState(['  1. first point', '  2. second point', RULE, '❯ ', RULE]), 'empty');
});

test('draftGuard: empty input line passes; text, dialog, a stream read and garbage refuse (fail closed)', () => {
  assert.deepEqual(draftGuard(screen(EMPTY)), { ok: true });
  assert.deepEqual(draftGuard(screen(EMPTY.join('\n'))), { ok: true }); // tail as one string
  assert.deepEqual(draftGuard(screen(TYPED)), { ok: false, why: DRAFT_REFUSAL });
  assert.equal(DRAFT_REFUSAL, 'That chat has unsent text: type /compact there yourself');
  assert.match(draftGuard(screen(DIALOG)).why, /waiting on a dialog or question/);
  for (const bad of [
    screen(EMPTY, { source: 'screen-unavailable' }), // Orca fell back to the raw stream
    screen(EMPTY, { source: 'stream' }),
    screen(EMPTY, { source: undefined }),
    screen(null),
    screen(['$ ls']),
    'not json',
    '',
    '{}',
    '{"result":{}}',
    '{"result":{"terminal":null}}',
  ]) {
    const g = draftGuard(bad);
    assert.equal(g.ok, false, bad);
    assert.match(g.why, /type \/compact there yourself/);
  }
  assert.deepEqual(screenReadArgv('term_A'), READ);
});

test('compactAgent: draft guard reads first and sends only when the input line is empty; otherwise nothing is sent', () => {
  const sent = (calls) => calls.filter((c) => c[1] === 'send');
  const calls = [];
  assert.equal(compactAgent(idleRow, { run: runner(screen(EMPTY), calls) }).ok, true);
  assert.deepEqual(calls, [READ, SEND]);
  for (const [name, answer, why] of [
    ['text', screen(TYPED), /unsent text: type \/compact there yourself/],
    ['multi-line draft', screen(MULTI), /unsent text/],
    ['dialog', screen(DIALOG), /dialog or question/],
    ['stream only', screen(EMPTY, { source: 'screen-unavailable' }), /Could not read/],
    ['garbage', 'oops', /Could not read/],
    ['read fails', () => { throw new Error('orca terminal read failed: no such terminal'); }, /Could not read that chat's screen \(orca terminal read failed/],
  ]) {
    const c = [];
    const r = compactAgent(idleRow, { run: runner(answer, c) });
    assert.equal(r.ok, false, name);
    assert.match(r.why, why, name);
    assert.deepEqual(c, [READ], `${name}: only the read-only call ran`);
    assert.deepEqual(sent(c), []);
  }
  // the pid checks still come first: a dead pid never reaches the screen read
  const c = [];
  const r = compactAgent({ ...idleRow, pid: 77, pidAt: NOW }, { run: runner(screen(EMPTY), c), ps: () => null });
  assert.match(r.why, /no longer a claude process/);
  assert.deepEqual(c, []);
});

test('renderAgents: rows with advice show their context', () => {
  const row = { status: 'idle', project: 'p', model: 'claude-opus-5', tokens: 5e6, lastSeen: NOW, subagents: [], pace: null, stale: false, source: 'claude' };
  const text = renderAgents([
    { ...row, id: 'aaaaaaaa1', title: 'Big', context: { tokens: 152_000, window: 200_000, pct: 76, advice: 'now', why: 'x' } },
    { ...row, id: 'bbbbbbbb2', title: 'Mid', context: { tokens: 92_000, window: 200_000, pct: 46, advice: 'soon', why: 'x' } },
    { ...row, id: 'cccccccc3', title: 'Small', context: { tokens: 20_000, window: 200_000, pct: 10, advice: 'none', why: null } },
    { ...row, id: 'dddddddd4', title: 'Unknown', context: null },
  ], NOW);
  assert.match(text, /Big {2}\(ctx 152k · compact\)$/m);
  assert.match(text, /Mid {2}\(ctx 92k · compact soon\)$/m);
  assert.match(text, /Small$/m);
  assert.match(text, /Unknown$/m);
});

// ---------- config ----------

test('config: compact thresholds default, validated in loadConfig, settable via config set', () => {
  const home = tmp();
  assert.deepEqual(loadConfig(home).compact, COMPACT_DEFAULTS);
  assert.deepEqual(COMPACT_DEFAULTS, { soonPct: 40, nowPct: 60, idleMin: 5 });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ compact: { soonPct: 30, nowPct: 'x', idleMin: 0 } }));
  assert.deepEqual(loadConfig(home).compact, { soonPct: 30, nowPct: 60, idleMin: 5 });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ compact: { soonPct: 80, nowPct: 50, idleMin: 120.5 } }));
  assert.deepEqual(loadConfig(home).compact, { soonPct: 50, nowPct: 50, idleMin: 5 }); // soon never after now
  writeFileSync(join(home, 'config.json'), JSON.stringify({ compact: [1] }));
  assert.deepEqual(loadConfig(home).compact, COMPACT_DEFAULTS);
  assert.deepEqual(parseSetting('compact.soonPct', '35', 'k'), { path: ['compact', 'soonPct'], value: 35 });
  assert.deepEqual(parseSetting('compact.nowPct', '95', 'k'), { path: ['compact', 'nowPct'], value: 95 });
  assert.deepEqual(parseSetting('compact.idleMin', '120', 'k'), { path: ['compact', 'idleMin'], value: 120 });
  assert.match(parseSetting('compact.nowPct', '96', 'k').error, /10-95/);
  assert.match(parseSetting('compact.idleMin', '0', 'k').error, /1-120/);
  assert.match(parseSetting('compact.soonPct', '-5', 'k').error, /whole number/);
});

// ---------- CLI (fake orca only) ----------

// One idle session (stopped 10 min ago, 150k context) in an Orca terminal; a fake `orca` script logs every call.
function cliSandbox({ state = 'done', tail = EMPTY } = {}) {
  const root = tmp();
  const home = join(root, 'kadans');
  const proj = join(root, 'repo');
  mkdirSync(join(proj, '.git'), { recursive: true });
  mkdirSync(home);
  const now = Date.now();
  const t = join(root, 'claude', 'projects', '-repo', 's1.jsonl');
  mkdirSync(dirname(t), { recursive: true });
  writeFileSync(t, jsonl([{ type: 'user', message: { role: 'user', content: 'Plan the release' } }, asst('m1', { i: 2, cc: 1000, cr: 149_000, at: now - 10 * MIN })]));
  utimesSync(t, new Date(now - 10 * MIN), new Date(now - 10 * MIN));
  appendSample(home, 'acct', { t: now - MIN, session_id: 's1', cwd: proj, transcript: t, model: 'claude-opus-5', limits: { five_hour: { pct: 1, resetsAt: now + 3600e3 } } }, now);
  appendEvent(home, { t: now - 11 * MIN, ev: 'UserPromptSubmit', sid: 's1', cwd: proj, transcript: t, prompt: 'Plan the release' }, now);
  appendEvent(home, { t: now - 10 * MIN, ev: 'Stop', sid: 's1', cwd: proj, transcript: t, asked: false }, now);
  const log = join(root, 'orca.log');
  writeFileSync(join(root, 'screen.json'), screen(tail));
  writeFileSync(join(root, 'ps.json'), JSON.stringify({ ok: true, result: { worktrees: [{ path: proj, repo: 'repo', displayName: 'main', agents: [{ paneKey: 't1:l1', state, agentType: 'claude', prompt: 'Plan the release' }] }] } }));
  writeFileSync(join(root, 'tl.json'), JSON.stringify({ ok: true, result: { terminals: [{ handle: 'term_A', tabId: 't1', leafId: 'l1', title: 'main' }] } }));
  const fake = join(root, 'fake-orca.sh');
  writeFileSync(fake, `#!/bin/sh\necho "$*" >> "${log}"\ncase "$1 $2" in\n  "worktree ps") cat "${join(root, 'ps.json')}" ;;\n  "terminal list") cat "${join(root, 'tl.json')}" ;;\n  "terminal read") cat "${join(root, 'screen.json')}" ;;\n  "terminal send") echo '{"ok":true}' ;;\n  *) exit 3 ;;\nesac\n`);
  chmodSync(fake, 0o755);
  const env = { PATH: process.env.PATH, HOME: root, KADANS_HOME: home, CLAUDE_CONFIG_DIR: join(root, 'claude'), KADANS_ORCA_BIN: fake, KADANS_ORCA_TIMEOUT_MS: '30000' };
  return { root, home, log, env };
}

const cli = (env, args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 15000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const reads = (log) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('terminal read')) : []);
const sends = (log) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('terminal send')) : []);

test('cli: agents --json carries context; the text list shows it; agent compact --dry-run sends nothing, a click sends /compact once', () => {
  const sb = cliSandbox();
  const j = cli(sb.env, ['agents', '--json']);
  assert.equal(j.code, 0, j.err);
  const [a] = JSON.parse(j.out);
  assert.equal(a.status, 'idle');
  assert.deepEqual(a.context, { tokens: 150_002, window: 200_000, pct: 75, advice: 'now', why: 'Idle 10 min: next turn re-reads all 150k' });
  assert.match(cli(sb.env, ['agents']).out, /\(ctx 150k · compact\)$/m);
  const dry = cli(sb.env, ['agent', 'compact', 's1', '--dry-run']);
  assert.equal(dry.code, 0, dry.err);
  assert.equal(dry.out, `dry run: nothing sent\ns1: would read the screen: ${JSON.stringify(['orca', ...READ])}, and only if the input line is empty run: ${JSON.stringify(['orca', ...SEND])}\n`);
  assert.deepEqual(reads(sb.log), []); // a dry run reads nothing either
  assert.deepEqual(sends(sb.log), []);
  const real = cli(sb.env, ['agent', 'compact', 's1']);
  assert.equal(real.code, 0, real.err);
  assert.equal(real.out, 's1: sent /compact to Orca terminal term_A\n');
  assert.deepEqual(reads(sb.log), ['terminal read --terminal term_A --screen --json']);
  assert.deepEqual(sends(sb.log), ['terminal send --terminal term_A --text /compact --enter']);
  assert.equal(cli(sb.env, ['agent', 'compact']).code, 2);
  assert.equal(cli(sb.env, ['agent', 'compact', 'nope']).code, 2);
});

test('cli: agent compact refuses a working chat and a chat outside Orca, sends nothing', () => {
  const sb = cliSandbox({ state: 'working' });
  const w = cli(sb.env, ['agent', 'compact', 's1']);
  assert.equal(w.code, 2);
  assert.match(w.err, /not compacted: it is working/);
  assert.deepEqual(sends(sb.log), []);
  const off = cliSandbox();
  const n = cli({ ...off.env, KADANS_ORCA: '0' }, ['agent', 'compact', 's1', '--dry-run']);
  assert.equal(n.code, 2);
  assert.match(n.err, /Type \/compact in that chat/);
  assert.deepEqual(sends(off.log), []);
});

test('cli: agent compact refuses a chat with unsent text or a dialog, and sends nothing', () => {
  for (const [tail, why] of [[TYPED, /not compacted: That chat has unsent text: type \/compact there yourself/], [DIALOG, /dialog or question/]]) {
    const sb = cliSandbox({ tail });
    const r = cli(sb.env, ['agent', 'compact', 's1']);
    assert.equal(r.code, 2);
    assert.match(r.err, why);
    assert.equal(reads(sb.log).length, 1);
    assert.deepEqual(sends(sb.log), []);
  }
});

// ---------- k12: Off, compact_boundary ----------

const boundary = ({ pre = 152_000, post = 21_000, at = NOW, side = false, extra = {} } = {}) => ({
  type: 'system', subtype: 'compact_boundary', isSidechain: side, timestamp: new Date(at).toISOString(), content: 'Conversation compacted',
  compactMetadata: { trigger: 'manual', preTokens: pre, postTokens: post, ...extra },
});

test('config: compact.soonPct 101 means Off; it round-trips, skips the nowPct cap and advises nothing', () => {
  assert.deepEqual(parseSetting('compact.soonPct', '101', 'k'), { path: ['compact', 'soonPct'], value: 101 });
  for (const v of ['100', '96', '102', '1010', '9', '101.0', '+101', '']) assert.ok(parseSetting('compact.soonPct', v, 'k').error, v);
  assert.match(parseSetting('compact.soonPct', '200', 'k').error, /10-95, or 101 for Off/);
  assert.ok(parseSetting('compact.nowPct', '101', 'k').error, 'only soonPct has an Off value');
  const home = tmp();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ compact: { soonPct: 101, nowPct: 50, idleMin: 5 } }));
  assert.deepEqual(loadConfig(home).compact, { soonPct: 101, nowPct: 50, idleMin: 5 }); // not capped to nowPct
  writeFileSync(join(home, 'config.json'), JSON.stringify({ compact: { soonPct: 100, nowPct: 50 } }));
  assert.equal(loadConfig(home).compact.soonPct, 40); // 100 is no value: the default
  const cfg = { ...COMPACT_DEFAULTS, soonPct: 101 };
  const big = { tokens: 190_000, window: 200_000, status: 'idle', idleMs: 90 * MIN };
  assert.equal(compactAdvice(big, COMPACT_DEFAULTS).advice, 'now');
  assert.deepEqual(compactAdvice(big, cfg), { advice: 'none', why: null });
  assert.deepEqual(compactAdvice({ ...big, tokens: 190_000, idleMs: 0 }, cfg), { advice: 'none', why: null });
  assert.deepEqual(contextOf({ tokens: 190_000, model: 'claude-opus-5', status: 'idle', idleMs: 90 * MIN }, cfg), { tokens: 190_000, window: 200_000, pct: 95, advice: 'none', why: null });
});

test('cli: config set compact.soonPct 101 is stored; agents --json and the text list then advise nothing; 40 brings it back', () => {
  const sb = cliSandbox();
  assert.equal(cli(sb.env, ['agents', '--json']).out.includes('"advice": "now"'), true);
  const set = cli(sb.env, ['config', 'set', 'compact.soonPct', '101']);
  assert.equal(set.code, 0, set.err);
  assert.equal(JSON.parse(readFileSync(join(sb.home, 'config.json'), 'utf8')).compact.soonPct, 101);
  assert.equal(JSON.parse(cli(sb.env, ['config', 'get', '--json']).out).compact.soonPct, 101);
  const [a] = JSON.parse(cli(sb.env, ['agents', '--json']).out);
  assert.deepEqual([a.context.tokens, a.context.advice, a.context.why], [150_002, 'none', null]);
  assert.doesNotMatch(cli(sb.env, ['agents']).out, /compact\)/);
  assert.equal(cli(sb.env, ['config', 'set', 'compact.soonPct', '96']).code, 2);
  assert.equal(cli(sb.env, ['config', 'set', 'compact.soonPct', '40']).code, 0);
  assert.equal(JSON.parse(cli(sb.env, ['agents', '--json']).out)[0].context.advice, 'now');
});

test('scanTranscript: a main-chain compact_boundary newer than the last assistant message sets the context to postTokens', () => {
  const dir = tmp();
  const f = join(dir, 's.jsonl');
  writeFileSync(f, jsonl([
    asst('m1', { i: 2, cc: 1000, cr: 149_000, at: NOW - 20 * MIN, c1h: true }),
    { type: 'system', subtype: 'informational', content: 'x', timestamp: new Date(NOW - 15 * MIN).toISOString() },
  ]));
  const st = scanTranscript(f, null);
  assert.deepEqual([st.ctx, st.ctxAt], [150_002, NOW - 20 * MIN]);
  // the boundary: ctx = postTokens at the boundary's time; the lifetime token sum and cache lifetime are untouched
  writeFileSync(f, readFileSync(f, 'utf8') + jsonl([boundary({ at: NOW - 10 * MIN })]));
  const after = scanTranscript(f, st);
  assert.deepEqual([after.ctx, after.ctxAt, after.cache1h], [21_000, NOW - 10 * MIN, true]);
  assert.equal(after.done + after.cur, st.done + st.cur);
  // a fresh scan and the tail reader (old cache without ctx) agree
  assert.deepEqual([scanTranscript(f, null).ctx, lastContext(f).ctx, lastContext(f).ctxAt], [21_000, 21_000, NOW - 10 * MIN]);
  // the next assistant message replaces it again
  writeFileSync(f, readFileSync(f, 'utf8') + jsonl([asst('m2', { i: 1, cc: 0, cr: 30_000, at: NOW - 5 * MIN })]));
  assert.equal(scanTranscript(f, after).ctx, 30_001);
  // a sidechain boundary, one without postTokens, and an older one (out of order) change nothing
  const g = join(dir, 't.jsonl');
  writeFileSync(g, jsonl([asst('m1', { i: 2, cc: 1000, cr: 149_000, at: NOW - 5 * MIN }), boundary({ side: true, at: NOW }),
    { ...boundary({ at: NOW }), compactMetadata: { preTokens: 5 } }, boundary({ post: 7_000, at: NOW - 30 * MIN })]));
  assert.equal(scanTranscript(g, null).ctx, 150_002);
});

test('cli: after a compact_boundary the row shows the smaller context and no compact advice, idle time counted from it', () => {
  const sb = cliSandbox();
  const t = join(sb.root, 'claude', 'projects', '-repo', 's1.jsonl');
  const now = Date.now();
  writeFileSync(t, readFileSync(t, 'utf8') + jsonl([boundary({ pre: 150_002, post: 18_500, at: now - 2 * MIN })]));
  const [a] = JSON.parse(cli(sb.env, ['agents', '--json']).out);
  assert.deepEqual(a.context, { tokens: 18_500, window: 200_000, pct: 9.3, advice: 'none', why: null });
});

// ---------- k48: agent send ----------
const ch = (n) => String.fromCodePoint(n);
const MSG = 'SECRET-MSG ship the fix once the tests pass';

test('k48 send: messageText keeps 1 to 4000 printable characters plus newlines; refuses control, bidi, separators and a leading "-"', () => {
  for (const t of ['!rm -rf ~', '  !ls', '/clear', '/compact', '#remember this', '-x']) assert.equal(messageText(t), null, t);
  assert.equal(messageText('be careful with /tmp and #3!'), 'be careful with /tmp and #3!');
  assert.equal(messageText('  hello\r\nworld\r\n'), 'hello\nworld');
  assert.equal(messageText('ünïcödé 🚀\n\nnext'), 'ünïcödé 🚀\n\nnext');
  assert.equal(messageText('x'.repeat(4000)), 'x'.repeat(4000));
  assert.equal([...messageText('🚀'.repeat(4000))].length, 4000);
  for (const bad of ['', '  \n ', 'x'.repeat(4001), '🚀'.repeat(4001), `a${ch(9)}b`, `a${ch(0x1b)}[31mb`, `a${ch(7)}`, `a${ch(0)}b`, `a${ch(0x9b)}b`,
    `a${ch(0x202e)}b`, `a${ch(0x2066)}b`, `a${ch(0x2028)}b`, `a${ch(0xfeff)}b`, '--enter', '-x', ' -x', null, 5, {}, ['x']]) {
    assert.equal(messageText(bad), null, JSON.stringify(bad));
  }
});

test('k48 send: types the message plus Enter only after the draft guard; refusals are fixed and never repeat the text', () => {
  const calls = [];
  const run = (argv) => { calls.push(argv); return argv[1] === 'read' ? screen(EMPTY) : '{"ok":true}'; };
  const r = sendAgent(idleRow, MSG, { run });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(calls, [READ, ['terminal', 'send', '--terminal', 'term_A', '--text', MSG, '--enter']]);
  assert.ok(!r.how.includes(MSG));
  for (const [tail, why] of [[TYPED, /unsent text/], [MULTI, /unsent text/], [DIALOG, /dialog/], [[], /could not be read/]]) {
    const c = [];
    const x = sendAgent(idleRow, MSG, { run: (argv) => { c.push(argv); return screen(tail); } });
    assert.equal(x.ok, false);
    assert.match(x.why, why);
    assert.deepEqual(c, [READ]); // read only: nothing typed
  }
  // orcaRunner's error repeats the whole argv (the text too): the refusal never passes it on
  const fails = sendAgent(idleRow, MSG, { run: (argv) => { if (argv[1] === 'send') throw new Error(`orca ${argv.join(' ')} failed`); return screen(EMPTY); } });
  assert.deepEqual(fails, { ok: false, why: 'Orca did not take the message' });
  // k49: a working chat is no longer refused here (the send guard decides on its screen; test/tell.test.mjs)
  for (const row of [{ ...idleRow, status: 'needs-you' }, { ...idleRow, status: 'ended' }, { ...idleRow, orca: null },
    { ...idleRow, orca: { ...idleRow.orca, ambiguous: true } }, { ...idleRow, id: 'remote:other:t:1', machine: 'other', orca: { terminal: null } }]) {
    const c = [];
    const x = sendAgent(row, MSG, { run: (argv) => { c.push(argv); return screen(EMPTY); } });
    assert.equal(x.ok, false);
    assert.deepEqual(c, []);
  }
  assert.equal(sendAgent(idleRow, MSG, { run: null }).ok, false);
  const dry = [];
  assert.equal(sendAgent(idleRow, MSG, { run: (a) => dry.push(a), dryRun: true }).ok, true);
  assert.deepEqual(dry, []);
});

test('k48 cli: agent send takes the text on stdin only, types it once, never echoes it; bad text, an argument or a draft send nothing', () => {
  const sb = cliSandbox();
  const send = (args, input, env = sb.env) => {
    const r = spawnSync(process.execPath, [BIN, 'agent', 'send', ...args], { env, encoding: 'utf8', input, timeout: 15000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const dry = send(['s1', '--dry-run'], MSG);
  assert.equal(dry.code, 0, dry.err);
  assert.deepEqual(sends(sb.log), []);
  const ok = send(['s1'], `${MSG}\n`);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /^s1: sent the message to Orca terminal term_A$/m);
  assert.ok(!(ok.out + ok.err).includes('SECRET-MSG'));
  assert.deepEqual(sends(sb.log), [`terminal send --terminal term_A --text ${MSG} --enter`]);
  for (const [args, input] of [[['s1'], `SECRET-MSG${ch(7)}`], [['s1'], ''], [['s1'], 'x'.repeat(4001)], [['s1', 'SECRET-MSG'], 'hi'], [[], 'SECRET-MSG']]) {
    const r = send(args, input);
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.ok(!(r.out + r.err).includes('SECRET-MSG'), r.err);
  }
  assert.equal(sends(sb.log).length, 1, 'refusals typed nothing');
  const draft = cliSandbox({ tail: TYPED });
  const d = send(['s1'], MSG, draft.env);
  assert.equal(d.code, 2);
  assert.match(d.err, /unsent text: nothing was sent/);
  assert.ok(!d.err.includes('SECRET-MSG'));
  assert.deepEqual(sends(draft.log), []);
});
