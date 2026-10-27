import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, statSync, utimesSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENDED_MS,
  appendEvent,
  collectSessions,
  endsWithQuestion,
  eventFromInput,
  findAgent,
  findClaudePid,
  listAgents,
  matchOrca,
  projectName,
  readEvents,
  readHosted,
  renderAgents,
  runEvent,
  scanSubagent,
  scanTranscript,
  sessionStatus,
  stopAgent,
} from '../lib/agents.mjs';
import { appendSample } from '../lib/samples.mjs';
import { applyOrder, readOrder, setOrder } from '../lib/order.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
const NOW = Date.parse('2026-10-26T12:00:00Z');
const DEFAULT_NOW = NOW;
const MIN = 60_000;

// Everything lives in a temp dir: the real ~/.claude and ~/.kadans are never read or written.
function tmp() {
  return mkdtempSync(join(tmpdir(), 'kadans-agents-'));
}

const asst = (id, model, usage, text = 'ok') => ({ type: 'assistant', requestId: `r-${id}`, message: { id, model, role: 'assistant', content: [{ type: 'text', text }], usage } });
const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const U = (i, o, cc, cr = 999) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cc, cache_read_input_tokens: cr });
const jsonl = (rows) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');

test('scanTranscript: one count per message id, cache reads ignored, incremental with a torn last line', () => {
  const dir = tmp();
  const f = join(dir, 's.jsonl');
  writeFileSync(
    f,
    jsonl([
      user('<command-name>/clear</command-name>'),
      user('caveat', { isMeta: true }),
      user('Build the agents list for the menu bar'),
      asst('m1', 'claude-sonnet-5', U(10, 5, 100)), // two content blocks of one message: same usage repeated
      asst('m1', 'claude-sonnet-5', U(10, 7, 100)), // last line of a message wins
      user([{ type: 'tool_result', content: 'x' }]),
      asst('m2', '<synthetic>', U(0, 0, 0)),
    ]),
  );
  let st = scanTranscript(f, null);
  assert.equal(st.done + st.cur, 117);
  assert.equal(st.model, 'claude-sonnet-5');
  assert.equal(st.firstPrompt, 'Build the agents list for the menu bar');
  const half = JSON.stringify(asst('m3', 'claude-opus-5', U(1, 2, 3)));
  appendFileSync(f, half.slice(0, 20)); // a write in progress
  st = scanTranscript(f, st);
  assert.equal(st.done + st.cur, 117);
  appendFileSync(f, `${half.slice(20)}\n`);
  st = scanTranscript(f, st);
  assert.equal(st.done + st.cur, 123);
  assert.equal(st.model, 'claude-opus-5');
  const again = scanTranscript(f, st);
  assert.deepEqual(again, st); // nothing new: nothing changes
  writeFileSync(f, jsonl([asst('z', 'claude-haiku-5', U(1, 1, 1))])); // rewritten shorter: start over
  st = scanTranscript(f, st);
  assert.equal(st.done + st.cur, 3);
});

test('events: appended under the lock, read back sorted, days past the 2-day window deleted', () => {
  const home = tmp();
  appendEvent(home, { t: NOW - 3 * 24 * 3600_000, ev: 'Stop', sid: 'old' }, NOW - 3 * 24 * 3600_000);
  assert.ok(existsSync(join(home, 'events', '2026-10-23.jsonl')));
  appendEvent(home, { t: NOW, ev: 'Stop', sid: 'b' }, NOW);
  appendEvent(home, { t: NOW - MIN, ev: 'SessionStart', sid: 'a' }, NOW);
  assert.equal(existsSync(join(home, 'events', '2026-10-23.jsonl')), false);
  appendFileSync(join(home, 'events', '2026-10-26.jsonl'), '{"t":broken\n');
  assert.deepEqual(readEvents(home, NOW).map((e) => e.sid), ['a', 'b']);
});

test('eventFromInput: keeps only what the list needs; prompt clipped to 120 chars; idle notifications dropped', () => {
  const base = { session_id: 's1', cwd: '/p', transcript_path: '/t.jsonl' };
  const e = eventFromInput({ ...base, hook_event_name: 'UserPromptSubmit', prompt: `  ${'x'.repeat(300)}` }, NOW, { pid: 42 });
  assert.equal(e.prompt.length, 120);
  assert.equal(e.pid, 42);
  assert.equal(eventFromInput({ ...base, hook_event_name: 'Notification', notification_type: 'idle_prompt' }, NOW), null);
  assert.equal(eventFromInput({ ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt' }, NOW).kind, 'permission_prompt');
  assert.deepEqual(eventFromInput({ ...base, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }, NOW), {
    t: NOW, ev: 'SubagentStart', sid: 's1', cwd: '/p', transcript: '/t.jsonl', agentId: 'a1', agentType: 'Explore',
  });
  assert.equal(eventFromInput({ ...base, hook_event_name: 'PreToolUse' }, NOW), null);
  assert.equal(eventFromInput({ hook_event_name: 'Stop' }, NOW), null);
});

test('findClaudePid walks up through the hook shell; endsWithQuestion', () => {
  const tree = { 30: { ppid: 20, comm: '/bin/sh' }, 20: { ppid: 10, comm: '/Users/x/.local/bin/claude' }, 10: { ppid: 1, comm: 'zsh' } };
  assert.equal(findClaudePid(30, (p) => tree[p] ?? null), 20);
  assert.equal(findClaudePid(10, (p) => tree[p] ?? null), null);
  assert.equal(endsWithQuestion('Shall I merge it?'), true);
  assert.equal(endsWithQuestion('**Merge now?**\n'), true);
  assert.equal(endsWithQuestion('Done. Tests pass.'), false);
  assert.equal(endsWithQuestion(null), false);
});

test('runEvent: records, prints nothing; Stop reads the question from the transcript tail when the input has none', () => {
  const home = tmp();
  const t = join(home, 't.jsonl');
  writeFileSync(t, jsonl([user('hi'), asst('m1', 'claude-sonnet-5', U(1, 1, 1), 'Which option do you want?')]));
  const ps = (p) => ({ 7: { ppid: 5, comm: 'sh' }, 5: { ppid: 1, comm: 'claude' } })[p] ?? null;
  const base = { session_id: 's1', cwd: home, transcript_path: t };
  assert.equal(runEvent(JSON.stringify({ ...base, hook_event_name: 'SessionStart', source: 'startup' }), {}, { home, now: NOW, ps, ppid: 7 }), '');
  runEvent(JSON.stringify({ ...base, hook_event_name: 'Stop' }), {}, { home, now: NOW + 1, ps, ppid: 7 });
  runEvent(JSON.stringify({ ...base, hook_event_name: 'Stop', last_assistant_message: 'Merged.' }), {}, { home, now: NOW + 2, ps, ppid: 7 });
  const ev = readEvents(home, NOW + 3);
  assert.equal(ev[0].pid, 5);
  assert.equal(ev[0].source, 'startup');
  assert.deepEqual(ev.slice(1).map((e) => [e.ev, e.asked, e.pid]), [['Stop', true, undefined], ['Stop', false, undefined]]);
  assert.throws(() => runEvent('not json', {}, { home }));
});

function session(over = {}) {
  return { id: 's', cwd: '/p', transcript: null, startedAt: NOW - 60 * MIN, lastSeen: NOW - MIN, lastEventAt: NOW - MIN, pid: null, firstPrompt: null, lastPrompt: null, turn: null, stopAt: null, asked: false, needsAt: null, endedAt: null, subagents: new Map(), ...over };
}

test('sessionStatus: working, needs-you, idle, ended', () => {
  const st = (over, opts = {}) => sessionStatus(session(over), { now: NOW, ...opts });
  assert.equal(st({ turn: 'open', lastSeen: NOW - 20 * MIN }), 'working'); // open turn, quiet tool run
  assert.equal(st({ turn: 'stopped', stopAt: NOW - MIN, asked: true }), 'needs-you');
  assert.equal(st({ turn: 'stopped', stopAt: NOW - MIN }), 'idle');
  assert.equal(st({ turn: 'stopped', stopAt: NOW - 5 * MIN }, { activity: NOW - 30_000 }), 'working'); // woke without a prompt
  assert.equal(st({ turn: 'open', needsAt: NOW - MIN }), 'needs-you'); // permission prompt
  assert.equal(st({ turn: 'open', needsAt: NOW - 2 * MIN }, { activity: NOW - MIN }), 'working'); // answered since
  assert.equal(st({ endedAt: NOW - MIN, lastEventAt: NOW - 2 * MIN }), 'ended');
  assert.equal(st({ turn: 'open', pid: 9 }, { alive: () => false }), 'ended');
  assert.equal(st({ turn: 'open', lastSeen: NOW - ENDED_MS - 1 }), 'ended');
  assert.equal(st({ turn: 'stopped', lastSeen: NOW - ENDED_MS - 1 }, { orcaLive: true }), 'idle'); // live Orca terminal
  assert.equal(st({ lastSeen: NOW - MIN }), 'working'); // no hooks yet: a fresh status-line sample
  assert.equal(st({ lastSeen: NOW - 10 * MIN }), 'idle');
});

test('collectSessions: prompts, subagents, resume after SessionEnd', () => {
  const ev = (t, e, x = {}) => ({ t: NOW + t, ev: e, sid: 's1', cwd: '/p', transcript: null, ...x });
  const m = collectSessions(
    [
      ev(0, 'SessionStart', { pid: 11 }),
      ev(1, 'UserPromptSubmit', { prompt: 'first' }),
      ev(2, 'SubagentStart', { agentId: 'a1', agentType: 'Explore' }),
      ev(3, 'SubagentStart', { agentId: 'a2', agentType: 'Plan' }),
      ev(4, 'SubagentStop', { agentId: 'a1', agentType: 'Explore' }),
      ev(5, 'Stop', { asked: false }),
      ev(6, 'SessionEnd', { reason: 'clear' }),
      ev(7, 'SessionStart', { source: 'resume' }),
      ev(8, 'UserPromptSubmit', { prompt: 'second' }),
    ],
    [{ t: NOW - 5000, session_id: 's1', cwd: '/p', transcript: '/p/t.jsonl', limits: {} }],
  );
  const s = m.get('s1');
  assert.deepEqual([s.firstPrompt, s.lastPrompt, s.turn, s.endedAt, s.pid, s.startedAt, s.transcript], ['first', 'second', 'open', null, 11, NOW - 5000, '/p/t.jsonl']);
  assert.deepEqual([...s.subagents.values()].map((a) => [a.id, a.type, a.status]), [['a1', 'Explore', 'done'], ['a2', 'Plan', 'running']]);
});

test('projectName: git root name; a linked worktree reports its main repository', () => {
  const root = tmp();
  mkdirSync(join(root, 'kadans', '.git', 'worktrees', 'k3'), { recursive: true });
  mkdirSync(join(root, 'kadans', 'lib'));
  mkdirSync(join(root, 'trees', 'k3', 'lib'), { recursive: true });
  writeFileSync(join(root, 'trees', 'k3', '.git'), `gitdir: ${join(root, 'kadans', '.git', 'worktrees', 'k3')}\n`);
  assert.equal(projectName(join(root, 'kadans', 'lib')), 'kadans');
  assert.equal(projectName(join(root, 'trees', 'k3', 'lib')), 'kadans');
  assert.equal(projectName(null), null);
});

test('matchOrca: by folder, ties broken by prompt, otherwise ambiguous', () => {
  const dir = tmp();
  const a = session({ id: 'a', cwd: dir, firstPrompt: 'fix the bot' });
  const b = session({ id: 'b', cwd: dir, firstPrompt: 'write tests', lastPrompt: 'go on' });
  const o = (prompt) => ({ paneKey: 'p', terminal: `term_${prompt}`, state: 'working', prompt, path: dir });
  let r = matchOrca([a, b], [o('go on'), o('fix the bot')]);
  assert.equal(r.bySession.get('b').terminal, 'term_go on');
  assert.equal(r.bySession.get('a').terminal, 'term_fix the bot');
  r = matchOrca([a, b], [o('something else')]);
  assert.equal(r.bySession.size, 0);
  assert.equal(r.left[0].ambiguous, true);
  r = matchOrca([], [o('x')], [session({ id: 'old', cwd: dir, lastSeen: 1 }), session({ id: 'new', cwd: dir, lastSeen: 2 })]);
  assert.equal(r.bySession.has('new'), true); // one agent, only quiet sessions: the latest one in that folder
  // one session, two Orca agents, no evidence: no pair (a guess could make `agent stop` close the wrong terminal)
  r = matchOrca([a], [o('one'), o('two')]);
  assert.deepEqual([r.bySession.size, r.left.map((x) => x.ambiguous)], [0, [true, true]]);
  // ... the same with a matching prompt pairs the right terminal; the other stays its own row
  r = matchOrca([a], [o('other'), o('fix the bot')]);
  assert.equal(r.bySession.get('a').terminal, 'term_fix the bot');
  assert.deepEqual(r.left.map((x) => x.terminal), ['term_other']);
  // two quiet sessions, two agents: no pair
  r = matchOrca([], [o('p'), o('q')], [session({ id: 'q1', cwd: dir }), session({ id: 'q2', cwd: dir })]);
  assert.equal(r.bySession.size, 0);
  // the session id in the terminal preview is definitive
  const u1 = session({ id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', cwd: dir });
  const u2 = session({ id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', cwd: dir });
  r = matchOrca([u1, u2], [{ ...o('zzz'), text: "rooms % claude '--resume' 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'" }]);
  assert.equal(r.bySession.get(u1.id).terminal, 'term_zzz');
});

// Process ancestry: the claude process of a session carries the Orca pane / terminal of its shell.
const PANE = (n) => `tab${n}:leaf${n}`;
const host = (n, sid, over = {}) => ({ pid: 100 + n, sessionId: sid, start: NOW - n * MIN, paneKey: PANE(n), handle: `term_${n}`, ...over });
const orcaAgent = (n, dir, over = {}) => ({ paneKey: PANE(n), terminal: `term_${n}`, state: 'working', prompt: 'same title', path: dir, title: 'same title', ...over });

test('matchOrca: a claude process inside the pane links its session, in any folder', () => {
  const dir = tmp();
  const a = session({ id: 'a', cwd: '/somewhere/else' });
  const b = session({ id: 'b', cwd: dir });
  const r = matchOrca([a, b], [orcaAgent(1, dir)], [], [host(1, 'a')]);
  assert.equal(r.bySession.get('a').terminal, 'term_1');
  assert.equal(r.bySession.has('b'), false);
  assert.equal(r.left.length, 0);
  // a session that is only quiet (closed to the 30 min rule) but still has its process counts too
  const q = matchOrca([], [orcaAgent(1, dir)], [a], [host(1, 'a')]);
  assert.equal(q.bySession.get('a').terminal, 'term_1');
  // the terminal handle alone links when the pane key is not known on one side
  const h = matchOrca([a], [orcaAgent(1, dir, { paneKey: null })], [], [host(1, 'a')]);
  assert.equal(h.bySession.get('a').terminal, 'term_1');
});

test('matchOrca: equal title, folder or pane of another process is not evidence', () => {
  const dir = tmp();
  const a = session({ id: 'a', cwd: dir, firstPrompt: 'same title' });
  const b = session({ id: 'b', cwd: dir, firstPrompt: 'other' });
  // two candidate sessions, one agent with a title / prompt that equals nothing: no link
  let r = matchOrca([a, b], [orcaAgent(1, dir, { prompt: 'nothing alike', title: 'a-title' })], [], []);
  assert.equal(r.bySession.size, 0);
  assert.equal(r.left[0].ambiguous, true);
  // a process in pane 2 says nothing about pane 1
  r = matchOrca([a, b], [orcaAgent(1, dir, { prompt: 'nothing alike' })], [], [host(2, 'a')]);
  assert.equal(r.bySession.size, 0);
  // a session id the list does not know is ignored
  r = matchOrca([a, b], [orcaAgent(1, dir, { prompt: 'nothing alike' })], [], [host(1, 'ghost')]);
  assert.equal(r.bySession.size, 0);
  // a pane that runs processes of two different sessions: no process link
  r = matchOrca([a, b], [orcaAgent(1, dir, { prompt: 'nothing alike' })], [], [host(1, 'a', { pid: 1 }), host(1, 'b', { pid: 2 })]);
  assert.equal(r.bySession.size, 0);
});

test('matchOrca: two Orca agents in one folder are never cross-linked', () => {
  const dir = tmp();
  const a = session({ id: 'a', cwd: dir });
  const b = session({ id: 'b', cwd: dir });
  const agents = [orcaAgent(1, dir), orcaAgent(2, dir)];
  let r = matchOrca([a, b], agents, [], [host(2, 'a'), host(1, 'b')]);
  assert.deepEqual([r.bySession.get('a').terminal, r.bySession.get('b').terminal], ['term_2', 'term_1']);
  r = matchOrca([a, b], [...agents].reverse(), [], [host(2, 'a'), host(1, 'b')]);
  assert.deepEqual([r.bySession.get('a').terminal, r.bySession.get('b').terminal], ['term_2', 'term_1']);
  // evidence for one pane only: the other agent stays unpaired (no guess from the single leftover session)
  r = matchOrca([a, b], agents, [], [host(1, 'a')]);
  assert.deepEqual([r.bySession.get('a').terminal, r.bySession.has('b')], ['term_1', false]);
  assert.deepEqual(r.left.map((x) => [x.terminal, x.ambiguous]), [['term_2', true]]);
});

test('matchOrca: one session in two panes goes to the newest process, the other pane is tagged sameSessionAs', () => {
  const dir = tmp();
  const a = session({ id: 'a', cwd: dir });
  const agents = [orcaAgent(1, dir), orcaAgent(2, dir)];
  let r = matchOrca([a], agents, [], [host(1, 'a'), host(2, 'a', { start: NOW })]);
  assert.equal(r.bySession.get('a').terminal, 'term_2');
  assert.deepEqual(r.left.map((x) => [x.terminal, x.sameSessionAs, x.ambiguous]), [['term_1', 'a', false]]);
  // same start time: no way to tell, nothing is linked this way
  r = matchOrca([a], agents, [], [host(1, 'a', { start: NOW }), host(2, 'a', { start: NOW })]);
  assert.equal(r.left.some((x) => x.sameSessionAs), false);
});

test('readHosted: only live interactive claude processes that started when the file says', () => {
  const dir = tmp();
  mkdirSync(join(dir, 'sessions'));
  const put = (pid, over = {}) => writeFileSync(join(dir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: `s${pid}`, kind: 'interactive', procStart: 'Mon Oct 26 10:00:00 2026', ...over }));
  put(11);
  put(12, { kind: 'sdk' });
  put(13);
  put(14);
  put(15, { pid: 99 }); // file name and pid disagree
  put(16, { procStart: 'junk' });
  writeFileSync(join(dir, 'sessions', 'notes.txt'), 'x');
  writeFileSync(join(dir, 'sessions', '17.json'), '{broken');
  const start = Date.parse('2026-10-26T10:00:00Z'); // procStart is UTC
  const procs = {
    11: { start, comm: '/Users/me/.local/bin/claude', paneKey: 'tA:lA', handle: 'term_x' },
    12: { start, comm: 'claude', paneKey: 'tB:lB', handle: null },
    13: { start: start + 60_000, comm: 'claude', paneKey: 'tC:lC', handle: null }, // pid reused later
    14: { start, comm: 'node', paneKey: 'tD:lD', handle: null }, // no longer claude
    15: { start, comm: 'claude', paneKey: 'tE:lE', handle: null },
    16: { start, comm: 'claude', paneKey: 'tF:lF', handle: null },
  };
  const seen = [];
  const got = readHosted([dir, join(dir, 'missing')], (pid) => (seen.push(pid), procs[pid] ?? null));
  assert.deepEqual(got, [{ pid: 11, sessionId: 's11', start, paneKey: 'tA:lA', handle: 'term_x' }]);
  assert.equal(seen.includes(16), false); // an unreadable start time is rejected before ps is asked
  // a process outside Orca (no pane, no handle) is not worth listing
  procs[11] = { start, comm: 'claude', paneKey: null, handle: null };
  assert.deepEqual(readHosted([dir], (pid) => procs[pid] ?? null), []);
});

// A fake orca runner from fixture JSON; records every call.
function fakeOrca(dir, calls = []) {
  const ps = {
    ok: true,
    result: {
      truncated: false,
      worktrees: [
        { path: dir, repo: 'kadans', displayName: 'k3-agents', agents: [{ paneKey: 'tab1:leaf1', state: 'working', agentType: 'claude', prompt: 'Build the agents list for the menu bar', updatedAt: NOW - 1000 }] },
        { path: '/elsewhere/bot', repo: 'twitter-bot', displayName: 'main', agents: [
          { paneKey: 'tab2:leaf2', state: 'done', agentType: 'claude', prompt: 'post the batch', updatedAt: NOW - 3 * MIN },
          { paneKey: 'tab3:leaf3', state: 'working', agentType: 'codex', prompt: 'not claude' },
        ] },
      ],
    },
  };
  const tl = { ok: true, result: { truncated: false, terminals: [
    { handle: 'term_A', tabId: 'tab1', leafId: 'leaf1', title: '✳ Agents list', worktreePath: dir },
    { handle: 'term_B', tabId: 'tab2', leafId: 'leaf2', title: 'bot', worktreePath: '/elsewhere/bot' },
  ] } };
  return (args) => {
    calls.push(args);
    if (args[0] === 'worktree' && args[1] === 'ps') return JSON.stringify(ps);
    if (args[0] === 'terminal' && args[1] === 'list') return JSON.stringify(tl);
    if (args[0] === 'terminal' && args[1] === 'close') return '{"ok":true}';
    throw new Error(`unexpected orca ${args.join(' ')}`);
  };
}

// A KADANS_HOME with one live session (samples + events + transcript + subagent meta) and one closed session.
function fixtureHome(NOW = DEFAULT_NOW, pid = 4242) {
  const root = tmp();
  const home = join(root, 'kadans');
  const proj = join(root, 'kadans-repo');
  mkdirSync(join(proj, '.git'), { recursive: true });
  const tdir = join(root, 'claude', 'projects', '-repo');
  mkdirSync(join(tdir, 's1', 'subagents'), { recursive: true });
  const t = join(tdir, 's1.jsonl');
  writeFileSync(t, jsonl([user('Build the agents list for the menu bar'), asst('m1', 'claude-opus-5', U(100, 50, 1000)), asst('m1', 'claude-opus-5', U(100, 60, 1000))]));
  writeFileSync(join(tdir, 's1', 'subagents', 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find the hook formats' }));
  appendSample(home, 'acct', { t: NOW - 10 * MIN, session_id: 's1', cwd: proj, transcript: t, limits: { five_hour: { pct: 1, resetsAt: NOW } } }, NOW - 10 * MIN);
  const base = { sid: 's1', cwd: proj, transcript: t };
  appendEvent(home, { t: NOW - 9 * MIN, ev: 'SessionStart', pid, ...base }, NOW);
  appendEvent(home, { t: NOW - 8 * MIN, ev: 'UserPromptSubmit', prompt: 'Build the agents list for the menu bar', ...base }, NOW);
  appendEvent(home, { t: NOW - 7 * MIN, ev: 'SubagentStart', agentId: 'a1', agentType: 'Explore', ...base }, NOW);
  appendEvent(home, { t: NOW - 50 * MIN, ev: 'SessionStart', sid: 's0', cwd: proj, transcript: null }, NOW);
  appendEvent(home, { t: NOW - 40 * MIN, ev: 'SessionEnd', sid: 's0', cwd: proj, transcript: null }, NOW);
  return { root, home, proj, t };
}

test('listAgents: fields, tokens, subagents, Orca match and Orca-only agents; ended ones only with all', () => {
  const { home, proj, t } = fixtureHome();
  const calls = [];
  const list = listAgents(home, { now: NOW, run: fakeOrca(proj, calls), alive: () => true });
  assert.deepEqual(list.map((a) => [a.id, a.status, a.source]), [['s1', 'working', 'claude'], ['orca:term_B', 'idle', 'orca']]);
  const [a, o] = list;
  assert.deepEqual(a, {
    id: 's1',
    source: 'claude',
    project: 'kadans',
    cwd: proj,
    model: 'claude-opus-5',
    tokens: 1160,
    context: { tokens: 2099, window: 200_000, pct: 1, advice: 'none', why: null }, // 100 + 1000 + 999 cache reads; working
    startedAt: NOW - 10 * MIN,
    lastSeen: a.lastSeen,
    status: 'working',
    stateSince: NOW - 1000, // Orca's state is the source of truth for an Orca-hosted chat (k17): its updatedAt here
    stateSource: 'orca',
    stale: false,
    account: 'acct',
    pace: { mode: 'none', until: null },
    lean: { rereads: 0, bigOutputs: 0 },
    progress: null,
    title: 'Agents list', // no Claude Code title in the transcript: the Orca tab title again (k24), before the prompt
    titleSource: 'orca',
    firstPrompt: 'Build the agents list for the menu bar',
    subagents: [{ id: 'a1', type: 'Explore', description: 'Find the hook formats', status: 'running', tokens: null, context: null, progress: null }], // no sub-agent transcript yet
    subagentTokens: null,
    pid: 4242,
    pidAt: NOW - 9 * MIN, // the SessionStart that recorded the pid
    orca: { terminal: 'term_A', worktree: 'k3-agents', repo: 'kadans', state: 'working', title: null },
  });
  assert.ok(a.lastSeen >= NOW - 7 * MIN);
  assert.deepEqual([o.project, o.cwd, o.firstPrompt, o.orca.terminal, o.orca.ambiguous], ['twitter-bot', '/elsewhere/bot', 'post the batch', 'term_B', false]);
  assert.ok(calls.every((c) => c.includes('--json')));
  // the transcript offset is saved: a second call reads nothing old again, and new lines add up
  const cache = JSON.parse(readFileSync(join(home, 'agents-cache.json'), 'utf8'));
  assert.equal(cache.s1.offset, readFileSync(t).length);
  appendFileSync(t, jsonl([asst('m2', 'claude-sonnet-5', U(1, 1, 1))]));
  assert.equal(listAgents(home, { now: NOW, alive: () => true })[0].tokens, 1163);
  // without Orca; with ended sessions
  const all = listAgents(home, { now: NOW, alive: () => true, all: true });
  assert.deepEqual(all.map((x) => [x.id, x.status, x.orca]), [['s1', 'working', null], ['s0', 'ended', null]]);
  // a session that never reported its transcript: found under <claude dir>/projects/<cwd as dashes>/<id>.jsonl
  const claude = join(dirname(home), 'cfg');
  const guessed = join(claude, 'projects', proj.replace(/[^a-zA-Z0-9]/g, '-'), 's7.jsonl');
  mkdirSync(dirname(guessed), { recursive: true });
  writeFileSync(guessed, jsonl([asst('g1', 'claude-haiku-5', U(2, 2, 2))]));
  appendEvent(home, { t: NOW - MIN, ev: 'UserPromptSubmit', sid: 's7', cwd: proj, transcript: null, prompt: 'p' }, NOW);
  const s7 = listAgents(home, { now: NOW, alive: () => true, claudeDirs: [claude] }).find((x) => x.id === 's7');
  assert.deepEqual([s7.tokens, s7.model], [6, 'claude-haiku-5']);
  // a broken Orca is just absent
  assert.equal(listAgents(home, { now: NOW, run: () => 'nope', alive: () => true }).length, 2);
  assert.match(renderAgents(list, NOW), /^STATUS\s+PROJECT.*\nworking\s+kadans\s+opus-5\s+1k\s+\d+m\s+1\s+s1\s+Agents list\n/); // the tab title (k24)
});

test('listAgents: a hosted claude process folds the Orca terminal into the session row; without it nothing changes', () => {
  const { home, proj } = fixtureHome();
  // the session s1 lives in the pane of term_B (another folder): one row, term_B kept for stop; term_A is left on its own
  const hosted = [{ pid: 7, sessionId: 's1', start: NOW - MIN, paneKey: 'tab2:leaf2', handle: 'term_B' }];
  const list = listAgents(home, { now: NOW, run: fakeOrca(proj), alive: () => true, hosted });
  assert.deepEqual(list.map((a) => [a.id, a.source, a.orca?.terminal, a.orca?.ambiguous]).sort(), [['orca:term_A', 'orca', 'term_A', false], ['s1', 'claude', 'term_B', undefined]]);
  list.sort((x, y) => (x.id === 's1' ? -1 : 1) - (y.id === 's1' ? -1 : 1));
  assert.equal(list[0].model, 'claude-opus-5');
  const run = (args) => (calls.push(args), '{"ok":true}');
  const calls = [];
  assert.deepEqual(stopAgent(list[0], { run }), { ok: true, how: 'closed Orca terminal term_B' });
  assert.deepEqual(calls, [['terminal', 'close', '--terminal', 'term_B', '--json']]);
  // no process evidence: the old rules decide, and the stop target is the same as before
  const plain = listAgents(home, { now: NOW, run: fakeOrca(proj), alive: () => true, hosted: [] });
  assert.deepEqual(plain.map((a) => [a.id, a.orca?.terminal]), [['s1', 'term_A'], ['orca:term_B', 'term_B']]);
  assert.equal(plain[1].sameSessionAs, undefined);
  // the default reads <claude dir>/sessions (none here): same result
  assert.deepEqual(listAgents(home, { now: NOW, run: fakeOrca(proj), alive: () => true, claudeDirs: [join(home, 'nope')] }).map((a) => a.id), ['s1', 'orca:term_B']);
});

test('renderAgents: a second Orca terminal on a listed session is folded into a footer line', () => {
  const row = { status: 'working', project: 'p', model: null, tokens: null, lastSeen: NOW, subagents: [], pace: null, stale: false };
  const list = [{ ...row, id: 's1', source: 'claude', title: 'Main' }, { ...row, id: 'orca:term_9', source: 'orca', title: 'Main', sameSessionAs: 's1' }];
  const text = renderAgents(list, NOW);
  assert.equal(text.includes('orca:term_9'), false);
  assert.match(text, /1 more Orca terminal on a session listed above not shown \(--all lists them\)/);
  assert.match(renderAgents(list, NOW, { all: true }), /orca:term_9/);
});

test('stopAgent: Orca terminal close, SIGTERM to a verified claude pid, otherwise a reason', () => {
  const calls = [];
  const run = (args) => calls.push(args);
  const orcaAgent = { id: 's1', pid: 5, orca: { terminal: 'term_A' } };
  assert.deepEqual(stopAgent(orcaAgent, { run }), { ok: true, how: 'closed Orca terminal term_A' });
  assert.deepEqual(calls, [['terminal', 'close', '--terminal', 'term_A', '--json']]);
  assert.equal(stopAgent({ ...orcaAgent, orca: { terminal: 'term_A', ambiguous: true }, pid: null }, { run }).ok, false);
  const kills = [];
  const kill = (pid, sig) => kills.push([pid, sig]);
  assert.equal(stopAgent({ id: 's2', pid: 77, orca: null }, { ps: () => ({ ppid: 1, comm: '/x/claude' }), kill }).ok, true);
  assert.deepEqual(kills, [[77, 'SIGTERM']]);
  const reused = stopAgent({ id: 's2', pid: 77, orca: null }, { ps: () => ({ ppid: 1, comm: 'Safari' }), kill });
  assert.match(reused.why, /no longer a claude process/);
  assert.match(stopAgent({ id: 's3', pid: null, orca: null }, { kill }).why, /no pid recorded/);
  assert.match(stopAgent({ id: 'orca:pane', source: 'orca', pid: null, orca: { terminal: null } }, { kill }).why, /no terminal handle/);
  assert.equal(kills.length, 1);
  const agents = [{ id: 'abcdef12' }, { id: 'abcdef34' }, { id: 'orca:term_B' }];
  assert.equal(findAgent(agents, 'abcdef12').agent.id, 'abcdef12');
  assert.match(findAgent(agents, 'abcdef').why, /2 agents/);
  assert.equal(findAgent(agents, 'term_B').agent.id, 'orca:term_B');
  assert.match(findAgent(agents, 'zz').why, /no agent/);
});

// CLI: a fake `orca` script stands in for the real one (KADANS_ORCA_BIN); it logs its arguments.
function cliSandbox() {
  const { root, home, proj } = fixtureHome(Date.now(), process.pid); // a live pid: the test runner
  const log = join(root, 'orca.log');
  const ps = JSON.stringify({ ok: true, result: { worktrees: [{ path: proj, repo: 'kadans', displayName: 'k3', agents: [{ paneKey: 't1:l1', state: 'working', agentType: 'claude', prompt: 'x' }] }] } });
  const tl = JSON.stringify({ ok: true, result: { terminals: [{ handle: 'term_A', tabId: 't1', leafId: 'l1', title: 'k3' }] } });
  writeFileSync(join(root, 'ps.json'), ps);
  writeFileSync(join(root, 'tl.json'), tl);
  const fake = join(root, 'fake-orca.sh');
  writeFileSync(fake, `#!/bin/sh\necho "$*" >> "${log}"\ncase "$1 $2" in\n  "worktree ps") cat "${join(root, 'ps.json')}" ;;\n  "terminal list") cat "${join(root, 'tl.json')}" ;;\n  "terminal close") echo '{"ok":true}' ;;\n  *) exit 3 ;;\nesac\n`);
  chmodSync(fake, 0o755);
  const env = { PATH: process.env.PATH, HOME: root, KADANS_HOME: home, CLAUDE_CONFIG_DIR: join(root, 'claude'), KADANS_ORCA_BIN: fake, KADANS_ORCA_TIMEOUT_MS: '30000' };
  return { root, home, proj, log, env };
}

const cli = (env, args, input = '') => {
  const r = spawnSync(process.execPath, [BIN, ...args], { input, env, encoding: 'utf8', timeout: 15000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('cli: agents --json, agents table, agent stop through the fake orca, hook event is silent', () => {
  const sb = cliSandbox();
  const j = cli(sb.env, ['agents', '--json']);
  assert.equal(j.code, 0, j.err);
  const list = JSON.parse(j.out);
  assert.equal(list[0].id, 's1');
  assert.equal(list[0].orca.terminal, 'term_A');
  assert.match(cli(sb.env, ['agents']).out, /^STATUS/);
  const s = cli(sb.env, ['agent', 'stop', 's1']);
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /closed Orca terminal term_A/);
  assert.match(readFileSync(sb.log, 'utf8'), /^terminal close --terminal term_A --json$/m);
  assert.equal(cli(sb.env, ['agent', 'stop', 'nope']).code, 2);
  const h = cli({ ...sb.env, KADANS_ORCA: '0' }, ['hook', 'event'], JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's9', cwd: sb.proj, prompt: 'hello' }));
  assert.deepEqual([h.code, h.out], [0, '']);
  assert.ok(readEvents(sb.home, Date.now()).some((e) => e.sid === 's9' && e.prompt === 'hello'));
  assert.deepEqual([cli(sb.env, ['hook', 'event'], 'garbage').code, cli(sb.env, ['hook', 'event'], 'garbage').out], [0, '']);
});

test('stopAgent: a pid reused by another claude process after it was recorded is never signalled', () => {
  const ev = (t, e, x = {}) => ({ t: NOW + t, ev: e, sid: 's1', cwd: '/p', transcript: null, ...x });
  const s = collectSessions([ev(0, 'SessionStart', { pid: 11 }), ev(5000, 'UserPromptSubmit', { pid: 11, prompt: 'hi' }), ev(9000, 'Stop', { asked: false })], []).get('s1');
  assert.equal(s.pidAt, NOW + 5000); // when the pid was last seen running this session
  const kills = [];
  const kill = (pid, sig) => kills.push([pid, sig]);
  const ps = () => ({ ppid: 1, comm: '/opt/bin/claude' });
  const agent = { id: 's1', pid: 11, pidAt: NOW + 5000, orca: null };
  // The session's claude died without SessionEnd; a new claude process (another session) got pid 11 an hour later.
  const reused = stopAgent(agent, { ps, kill, started: () => NOW + 60 * MIN });
  assert.equal(reused.ok, false);
  assert.match(reused.why, /pid 11 now belongs to a newer process/);
  assert.equal(stopAgent(agent, { ps, kill, started: () => NOW + 60 * MIN, dryRun: true }).ok, false);
  assert.deepEqual(kills, []);
  // The same process (started before the pid was recorded; ps start times have 1 s resolution) is stopped.
  assert.equal(stopAgent(agent, { ps, kill, started: () => NOW - 30 * MIN }).ok, true);
  assert.equal(stopAgent(agent, { ps, kill, started: () => NOW + 5500 }).ok, true);
  assert.deepEqual(kills, [[11, 'SIGTERM'], [11, 'SIGTERM']]);
});

// k31: sub-agent numbers from <transcript dir>/<sid>/subagents/agent-<id>.jsonl (sidechain lines throughout).
const side = (row) => ({ ...row, isSidechain: true, agentId: 'a1' });

test('scanSubagent: sidechain usage counted once per message id, newest context, incremental', () => {
  const f = join(tmp(), 'agent-a1.jsonl');
  writeFileSync(f, jsonl([side(user('Find the hook formats')), side(asst('m1', 'claude-haiku-5', U(10, 5, 100, 400))), side(asst('m1', 'claude-haiku-5', U(10, 7, 100, 400)))]));
  const st = scanSubagent(f, null);
  assert.deepEqual([st.done + st.cur, st.ctx], [117, 510]);
  assert.equal(Object.hasOwn(st, 'firstPrompt') || Object.hasOwn(st, 'promptRaw'), false, 'numbers only: no prompt kept');
  appendFileSync(f, jsonl([side(asst('m2', 'claude-haiku-5', U(3, 2, 0, 600))), side(asst('m3', '<synthetic>', U(0, 0, 0, 0)))]));
  const next = scanSubagent(f, st);
  assert.deepEqual([next.done + next.cur, next.ctx], [122, 603]);
  assert.equal(scanSubagent(f, next), next, 'unchanged file: the cached state itself');
  assert.equal(scanSubagent(join(tmp(), 'missing.jsonl'), null), null);
});

test('listAgents: sub-agent tokens and context, their sum, cache hit without a read, hostile ids ignored', () => {
  const { home, proj, t } = fixtureHome();
  const sub = join(dirname(t), 's1', 'subagents', 'agent-a1.jsonl');
  writeFileSync(sub, jsonl([side(asst('x1', 'claude-haiku-5', U(40, 10, 50, 300)))]));
  appendEvent(home, { t: NOW - 6 * MIN, ev: 'SubagentStart', agentId: 'a2', agentType: 'Plan', sid: 's1', cwd: proj, transcript: t }, NOW);
  appendEvent(home, { t: NOW - 6 * MIN, ev: 'SubagentStart', agentId: '../../s1', agentType: 'Plan', sid: 's1', cwd: proj, transcript: t }, NOW);
  const row = listAgents(home, { now: NOW, alive: () => true })[0];
  assert.deepEqual(row.subagents.map((a) => [a.id, a.tokens, a.context]), [['a1', 100, 390], ['a2', null, null], ['../../s1', null, null]]);
  assert.equal(row.subagentTokens, 100);
  const cache = JSON.parse(readFileSync(join(home, 'agents-cache.json'), 'utf8'));
  assert.deepEqual(Object.keys(cache).sort(), ['s1', 's1/a1']);
  // cache hit: same size and mtime -> the file is not read (different bytes of the same length stay unseen)
  const { mtimeMs, size } = statSync(sub);
  const swapped = jsonl([side(asst('x1', 'claude-haiku-5', U(90, 10, 50, 300)))]);
  assert.equal(Buffer.byteLength(swapped), size);
  writeFileSync(sub, swapped);
  utimesSync(sub, new Date(mtimeMs), new Date(mtimeMs));
  assert.equal(listAgents(home, { now: NOW, alive: () => true })[0].subagentTokens, 100);
  // grown: only the new bytes are read
  appendFileSync(sub, jsonl([side(asst('x2', 'claude-haiku-5', U(1, 1, 1, 0)))]));
  const again = listAgents(home, { now: NOW, alive: () => true })[0];
  assert.deepEqual([again.subagentTokens, again.subagents[0].context], [103, 2]);
});

// k31: the owner's row order.
test('order: new live rows first, then the stored order (ordered: true), ended last; ended ids drop out; a slow Orca keeps orca ids', () => {
  const { home, proj } = fixtureHome();
  const opts = { now: NOW, run: fakeOrca(proj), alive: () => true };
  assert.deepEqual(listAgents(home, opts).map((a) => [a.id, a.ordered]), [['s1', undefined], ['orca:term_B', undefined]]);
  setOrder(home, ['orca:term_B', 's1', 's1']);
  assert.deepEqual(readOrder(home), ['orca:term_B', 's1']);
  assert.deepEqual(listAgents(home, opts).map((a) => [a.id, a.ordered]), [['orca:term_B', true], ['s1', true]]);
  // only one id ordered: the new live row stays on top, the ordered one follows
  setOrder(home, ['orca:term_B']);
  assert.deepEqual(listAgents(home, opts).map((a) => [a.id, a.ordered ?? false]), [['s1', false], ['orca:term_B', true]]);
  // without Orca's answer the orca id is not listed but stays stored
  listAgents(home, { now: NOW, alive: () => true });
  assert.deepEqual(readOrder(home), ['orca:term_B']);
  // an ended id (s0) and a vanished session id leave the stored order; ended rows are never shown as ordered
  setOrder(home, ['s0', 'gone-session', 's1']);
  const all = listAgents(home, { now: NOW, alive: () => true, all: true });
  assert.deepEqual(all.map((a) => [a.id, a.ordered ?? false]), [['s1', true], ['s0', false]]);
  assert.deepEqual(readOrder(home), ['s1']);
  // an unchanged order is not rewritten
  const file = join(home, 'order.json');
  utimesSync(file, new Date(NOW - 60 * MIN), new Date(NOW - 60 * MIN));
  listAgents(home, opts);
  assert.equal(Math.round(statSync(file).mtimeMs), NOW - 60 * MIN);
});

test('applyOrder: an orca id missing while Orca answered is gone', () => {
  const rows = [{ id: 'a', status: 'idle' }, { id: 'b', status: 'working' }];
  const r = applyOrder(rows, ['orca:x', 'b'], { present: new Set(['a', 'b']), orcaRead: true });
  assert.deepEqual([r.list.map((a) => a.id), r.gone], [['a', 'b'], ['orca:x']]);
  assert.deepEqual(applyOrder(rows, ['orca:x'], { present: new Set(['a', 'b']) }).gone, []);
});

// k35: progress from the transcript: `kadans progress` Bash calls, TodoWrite, task tools; main chain and sub-agents.
const tool = (id, name, input) => ({ type: 'assistant', requestId: `r-${id}`, message: { id, model: 'claude-opus-5', role: 'assistant',
  content: [{ type: 'text', text: 'step' }, { type: 'tool_use', id: `tu-${id}`, name, input }], usage: U(1, 1, 0, 0) } });
const bash = (id, command) => tool(id, 'Bash', { command, description: 'progress' });

test('scanTranscript (k35): newest progress of the main chain; sidechain lines ignored; a new prompt clears it', () => {
  const f = join(tmp(), 'p.jsonl');
  writeFileSync(f, jsonl([user('Do the five things'), bash('p1', 'kadans progress 1/5 "Reading the code"'),
    bash('p2', 'npm test && kadans progress 2/5 "Writing tests"'), side(bash('p3', 'kadans progress 9/9 "Sub work"'))]));
  let st = scanTranscript(f, null);
  assert.deepEqual(st.progress, { done: 2, total: 5, step: 'Writing tests' });
  appendFileSync(f, jsonl([tool('p4', 'TodoWrite', { todos: [{ content: 'A', status: 'completed', activeForm: 'Doing A' },
    { content: 'B', status: 'in_progress', activeForm: 'Doing B' }, { content: 'C', status: 'pending', activeForm: 'Doing C' }] })]));
  st = scanTranscript(f, st);
  assert.deepEqual(st.progress, { done: 1, total: 3, step: 'Doing B' }, 'the newest call wins, whatever its kind');
  appendFileSync(f, jsonl([bash('p5', 'grep -rn "kadans progress 4/4" lib')]));
  st = scanTranscript(f, st);
  assert.deepEqual(st.progress, { done: 1, total: 3, step: 'Doing B' }, 'a command that only mentions it does not count');
  appendFileSync(f, jsonl([user('Now something else')]));
  st = scanTranscript(f, st);
  assert.equal(st.progress, null);
  // a state cached before k35 (no progress field) picks it up from the next new lines, without a rescan
  const old = { ...st };
  delete old.progress;
  delete old.tasks;
  appendFileSync(f, jsonl([bash('p6', "kadans progress 3/4 'Last bits'")]));
  assert.deepEqual(scanTranscript(f, old).progress, { done: 3, total: 4, step: 'Last bits' });
});

test('scanTranscript (k35): TaskCreate / TaskUpdate inputs count as progress', () => {
  const f = join(tmp(), 't.jsonl');
  writeFileSync(f, jsonl([user('Plan it'), tool('t1', 'TaskCreate', { subject: 'Parse', activeForm: 'Parsing' }),
    tool('t2', 'TaskCreate', { subject: 'Render' }), tool('t3', 'TaskCreate', { subject: 'Ship' }),
    tool('t4', 'TaskUpdate', { taskId: '1', status: 'completed' }), tool('t5', 'TaskUpdate', { taskId: '2', status: 'in_progress' }),
    tool('t6', 'TaskUpdate', { taskId: '3', status: 'deleted' })]));
  assert.deepEqual(scanTranscript(f, null).progress, { done: 1, total: 2, step: 'Render' });
});

test('listAgents (k35): the row and its sub-agent carry their progress', () => {
  const { home, t } = fixtureHome();
  appendFileSync(t, jsonl([bash('k1', 'kadans progress 2/3 "Wiring the panel"')]));
  writeFileSync(join(dirname(t), 's1', 'subagents', 'agent-a1.jsonl'), jsonl([side(bash('x1', "node '/opt/kadans/bin/kadans.mjs' progress 1/4 'Reading docs'"))]));
  const row = listAgents(home, { now: NOW, alive: () => true })[0];
  assert.deepEqual(row.progress, { done: 2, total: 3, step: 'Wiring the panel' });
  assert.deepEqual(row.subagents[0].progress, { done: 1, total: 4, step: 'Reading docs' });
});
