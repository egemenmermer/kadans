// k17-orca-sync: for a chat hosted in Orca, Orca's agent state is the source of truth; one orca call per refresh; cheap
// transcript cache; `agents --brief`. Everything lives in temp dirs with fixture Orca JSON: no real ~/.claude, ~/.kadans,
// orca or terminal is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASKED_MS,
  ORCA_STATUS,
  appendEvent,
  briefOf,
  listAgents,
  listAgentsAsync,
  orcaFetch,
  orcaStatus,
  readBrief,
  readOrca,
  readPanes,
  readRegistry,
  realInspect,
  resolveStatus,
  scanTranscript,
  sessionStatus,
} from '../lib/agents.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
const NOW = Date.parse('2026-10-26T12:00:00Z');
const MIN = 60_000;
const START = Date.parse('2026-10-26T09:00:00Z');
const tmp = () => mkdtempSync(join(tmpdir(), 'kadans-orca-'));
const jsonl = (rows) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');
const asst = (id, tokens) => ({ type: 'assistant', requestId: `r-${id}`, message: { id, model: 'claude-sonnet-5', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: tokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });

// A kadans home with one session per spec: { id, events: [[offsetMs, ev, extra]], quietMin }. The transcript's mtime is
// the last event's time. Returns { home, proj, transcripts }.
function world(specs, now = NOW) {
  const home = tmp();
  const proj = join(tmp(), 'repo');
  mkdirSync(join(proj, '.git'), { recursive: true });
  const transcripts = {};
  for (const x of specs) {
    const t = join(tmp(), 'projects', '-repo', `${x.id}.jsonl`);
    mkdirSync(dirname(t), { recursive: true });
    writeFileSync(t, jsonl([{ type: 'user', message: { role: 'user', content: `Task of ${x.id}` } }]));
    let last = now - 10 * MIN;
    for (const [off, ev, extra = {}] of x.events ?? []) {
      appendEvent(home, { t: now + off, ev, sid: x.id, cwd: proj, transcript: t, ...extra }, now);
      last = Math.max(last, now + off);
    }
    utimesSync(t, new Date(last), new Date(last));
    transcripts[x.id] = t;
  }
  return { home, proj, transcripts };
}

// Fixture Orca JSON: one claude agent per entry { paneKey, state, stateStartedAt, updatedAt }, all in `proj`; terminals
// for the given pane keys. Records every call.
function fakeOrca(proj, agents, { terminals = true, calls = [] } = {}) {
  const ps = { ok: true, result: { truncated: false, worktrees: [{ path: proj, repo: 'repo', displayName: 'main', agents: agents.map((a) => ({ agentType: 'claude', prompt: 'secret prompt text', lastAssistantMessage: 'secret reply', ...a })) }] } };
  const tl = { ok: true, result: { truncated: false, terminals: agents.map((a, i) => ({ handle: `term_${i}`, tabId: a.paneKey.split(':')[0], leafId: a.paneKey.split(':')[1], title: 'secret title', preview: 'secret preview', worktreePath: proj })) } };
  const run = (args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'worktree' && args[1] === 'ps') return JSON.stringify(ps);
    if (args[0] === 'terminal' && args[1] === 'list' && terminals) return JSON.stringify(tl);
    throw new Error(`unexpected orca ${args.join(' ')}`);
  };
  run.calls = calls;
  return run;
}

const hosted = (sid, paneKey, handle = null) => [{ pid: 777, sessionId: sid, start: NOW - 60 * MIN, paneKey, handle }];

test('orcaStatus: every Orca agent state maps to an existing Kadans status; unknown states give no verdict', () => {
  assert.deepEqual(ORCA_STATUS, { working: 'working', waiting: 'needs-you', blocked: 'needs-you', attention: 'needs-you', done: 'idle', idle: 'idle' });
  assert.equal(orcaStatus('needs-input'), 'needs-you'); // a future state that reads like waiting
  assert.equal(orcaStatus('permission_request'), 'needs-you');
  assert.equal(orcaStatus('mystery'), null);
  assert.equal(orcaStatus(null), null);
  for (const v of Object.values(ORCA_STATUS)) assert.ok(['working', 'needs-you', 'idle'].includes(v)); // no new status values (k18 keys on them)
});

test('listAgents: each Orca state lands on the row as Kadans status, with stateSince from Orca', () => {
  const states = ['working', 'waiting', 'blocked', 'done', 'idle', 'attention'];
  const { home, proj } = world(states.map((st, i) => ({ id: `s-${st}`, events: [[-20 * MIN, 'UserPromptSubmit', { prompt: 'go' }], [-15 * MIN, 'Stop', { asked: true }]] })));
  const agents = states.map((state, i) => ({ paneKey: `t${i}:l${i}`, state, stateStartedAt: NOW - (i + 1) * MIN, updatedAt: NOW - 1000 }));
  const h = states.flatMap((st, i) => hosted(`s-${st}`, `t${i}:l${i}`, `term_${i}`));
  const list = listAgents(home, { now: NOW, run: fakeOrca(proj, agents), hosted: h, alive: () => true });
  const by = Object.fromEntries(list.map((a) => [a.id, a]));
  assert.deepEqual(states.map((st) => by[`s-${st}`].status), ['working', 'needs-you', 'needs-you', 'idle', 'idle', 'needs-you']);
  assert.deepEqual(states.map((st, i) => by[`s-${st}`].stateSince), states.map((_, i) => NOW - (i + 1) * MIN));
  assert.ok(states.every((st) => by[`s-${st}`].stateSource === 'orca'));
  assert.ok(states.every((st) => by[`s-${st}`].orca.terminal === `term_${states.indexOf(st)}`)); // the handle from the process environment
  assert.ok(list.every((a) => a.lastSeen >= NOW - 1000)); // Orca's updatedAt counts as a sign of life
  // nothing of Orca's text reaches the row (prompt pairing uses it in memory only)
  const text = JSON.stringify(list);
  assert.doesNotMatch(text, /secret (prompt|reply|title|preview)/);
});

test('a stale asked-question needs-you clears when Orca says done; outside Orca it expires after 30 minutes', () => {
  // the repro: Stop with a question 6 hours ago; Orca says done since then
  const stop = -6 * 60 * MIN;
  const { home, proj } = world([{ id: 'ask', events: [[stop - MIN, 'UserPromptSubmit', { prompt: 'go' }], [stop, 'Stop', { asked: true }]] }]);
  const orca = fakeOrca(proj, [{ paneKey: 't1:l1', state: 'done', stateStartedAt: NOW + stop + 50, updatedAt: NOW + stop + 50 }]);
  const row = listAgents(home, { now: NOW, run: orca, hosted: hosted('ask', 't1:l1', 'term_0'), alive: () => true })[0];
  assert.deepEqual([row.status, row.stateSource, row.stateSince], ['idle', 'orca', NOW + stop + 50]);
  // Orca's Stop landed a hair before Kadans' Stop hook: the hook side is newer, but for an Orca chat the question rule is off
  const early = fakeOrca(proj, [{ paneKey: 't1:l1', state: 'done', stateStartedAt: NOW + stop - 30, updatedAt: NOW + stop - 30 }]);
  const row2 = listAgents(home, { now: NOW, run: early, hosted: hosted('ask', 't1:l1', 'term_0'), alive: () => true })[0];
  assert.deepEqual([row2.status, row2.stateSource], ['idle', 'hooks']);
  // the same chat outside Orca: needs-you for 30 minutes after the Stop, idle afterwards (the old rule said forever)
  const s = { endedAt: null, lastEventAt: NOW - MIN, lastSeen: NOW - MIN, pid: 9, needsAt: null, turn: 'stopped', stopAt: NOW - MIN, asked: true }; // a live pid keeps it listed
  assert.equal(sessionStatus(s, { now: NOW }), 'needs-you');
  assert.equal(sessionStatus(s, { now: NOW - MIN + ASKED_MS }), 'needs-you');
  assert.equal(sessionStatus(s, { now: NOW - MIN + ASKED_MS + 1 }), 'idle');
  // through the list, no Orca at all, a live pid keeps the chat listed: needs-you at 26 minutes, idle at 31
  const plain = world([{ id: 'ask2', events: [[-32 * MIN, 'UserPromptSubmit', { prompt: 'go', pid: 4242 }], [-31 * MIN, 'Stop', { asked: true }]] }]);
  assert.equal(listAgents(plain.home, { now: NOW - 5 * MIN, alive: () => true })[0].status, 'needs-you');
  assert.equal(listAgents(plain.home, { now: NOW, alive: () => true })[0].status, 'idle');
});

test('resolveStatus: the newer of Orca\'s last word (updatedAt) and the hook event wins; a dead process or SessionEnd still ends the row', () => {
  const base = { id: 'x', endedAt: null, lastSeen: NOW - MIN, pid: null, needsAt: null, turn: 'stopped', turnAt: NOW - 9 * MIN, stopAt: NOW - 5 * MIN, lastEventAt: NOW - 5 * MIN, asked: false };
  const o = (state, at, updated = at) => ({ state, stateStartedAt: at, updatedAt: updated });
  // Orca done at T, the owner typed at T+5s (hook newer): working until Orca catches up
  const typed = { ...base, turn: 'open', turnAt: NOW - 5 * MIN + 5000, lastEventAt: NOW - 5 * MIN + 5000 };
  assert.deepEqual(resolveStatus(typed, o('done', NOW - 5 * MIN), { now: NOW }), { status: 'working', stateSince: NOW - 5 * MIN + 5000, stateSource: 'hooks' });
  // Orca working at T+10s is newer than that prompt: Orca wins
  assert.deepEqual(resolveStatus(typed, o('working', NOW - 5 * MIN + 10_000), { now: NOW }), { status: 'working', stateSince: NOW - 5 * MIN + 10_000, stateSource: 'orca' });
  // a permission prompt (hook) at T+12s beats Orca's working at T+10s; Orca's waiting at T+12.5s says the same
  const perm = { ...typed, needsAt: NOW - 5 * MIN + 12_000, lastEventAt: NOW - 5 * MIN + 12_000 };
  assert.deepEqual(resolveStatus(perm, o('working', NOW - 5 * MIN + 10_000), { now: NOW }), { status: 'needs-you', stateSince: NOW - 5 * MIN + 12_000, stateSource: 'hooks' });
  assert.equal(resolveStatus(perm, o('waiting', NOW - 5 * MIN + 12_500), { now: NOW }).status, 'needs-you');
  // answered: Orca working again, newer than the prompt
  assert.deepEqual(resolveStatus(perm, o('working', NOW - 4 * MIN), { now: NOW }), { status: 'working', stateSince: NOW - 4 * MIN, stateSource: 'orca' });
  // an Orca state Kadans cannot map: the hook rules stay in charge (with the question rule)
  assert.deepEqual(resolveStatus({ ...base, asked: true }, o('mystery', NOW), { now: NOW }), { status: 'needs-you', stateSince: NOW - 5 * MIN, stateSource: 'hooks' });
  // no Orca timestamp at all: Orca is still the source of truth
  assert.equal(resolveStatus({ ...base, asked: true }, { state: 'working', stateStartedAt: null, updatedAt: null }, { now: NOW }).status, 'working');
  // ended stays ended whatever Orca says
  assert.equal(resolveStatus({ ...base, pid: 5 }, o('working', NOW), { now: NOW, alive: () => false }).status, 'ended');
  assert.equal(resolveStatus({ ...base, endedAt: NOW - MIN, lastEventAt: NOW - 2 * MIN }, o('working', NOW), { now: NOW }).status, 'ended');
  // not in Orca: hooks, with their own since
  assert.deepEqual(resolveStatus(base, null, { now: NOW }), { status: 'idle', stateSince: NOW - 5 * MIN, stateSource: 'hooks' });
  // the live repro's lead agent: Orca says working since 9 hours (its sub-agents run) and confirmed it 11 s ago, while
  // Kadans saw the lead's Stop 5 minutes ago and sub-agent events since: Orca's view is newer and wins, since its start
  const lead = { ...base, lastEventAt: NOW - 74_000 };
  assert.deepEqual(resolveStatus(lead, o('working', NOW - 9 * 3600_000, NOW - 11_000), { now: NOW }), { status: 'working', stateSince: NOW - 9 * 3600_000, stateSource: 'orca' });
  // the same with Orca's word older than the Stop: the hook rules, idle (Orca has not caught up yet)
  assert.equal(resolveStatus(lead, o('working', NOW - 9 * 3600_000, NOW - 80_000), { now: NOW }).status, 'idle');
});

test('readOrca: one `worktree ps` per refresh; `terminal list` only for a pane with no known handle, then cached in the pane map', () => {
  const home = tmp();
  const proj = join(tmp(), 'repo');
  const agents = [{ paneKey: 't1:l1', state: 'working', stateStartedAt: NOW, updatedAt: NOW }, { paneKey: 't2:l2', state: 'done', stateStartedAt: NOW, updatedAt: NOW }];
  // every pane has a hosted process: ps only
  const a = fakeOrca(proj, agents);
  const r1 = readOrca(a, { home, hosted: [{ paneKey: 't1:l1', handle: 'term_x' }, { paneKey: 't2:l2', handle: 'term_y' }], now: NOW });
  assert.deepEqual(a.calls, ['worktree ps']);
  assert.deepEqual(r1.agents.map((x) => [x.paneKey, x.terminal, x.state, x.stateStartedAt, x.title]), [['t1:l1', 'term_x', 'working', NOW, null], ['t2:l2', 'term_y', 'done', NOW, null]]);
  // an unknown pane: one terminal list, and the pane map remembers the handles (ids only)
  const b = fakeOrca(proj, agents);
  const r2 = readOrca(b, { home, hosted: [{ paneKey: 't1:l1', handle: 'term_x' }], now: NOW });
  assert.deepEqual(b.calls, ['worktree ps', 'terminal list']);
  assert.deepEqual(r2.agents.map((x) => x.terminal), ['term_x', 'term_1']);
  const map = readFileSync(join(home, 'orca-panes.json'), 'utf8');
  assert.doesNotMatch(map, /secret/);
  assert.deepEqual(JSON.parse(map), { t: NOW, panes: { 't1:l1': { handle: 'term_0', path: proj }, 't2:l2': { handle: 'term_1', path: proj } }, procs: {} });
  // next refresh: the map serves the handle, no second call
  const c = fakeOrca(proj, agents);
  assert.deepEqual(readOrca(c, { home, hosted: [], now: NOW + 1000 }).agents.map((x) => x.terminal), ['term_0', 'term_1']);
  assert.deepEqual(c.calls, ['worktree ps']);
  // a brand-new pane within the minute waits for the next window rather than listing again
  const d = fakeOrca(proj, [...agents, { paneKey: 't3:l3', state: 'working', stateStartedAt: NOW, updatedAt: NOW }]);
  assert.deepEqual(readOrca(d, { home, hosted: [], now: NOW + 30_000 }).agents.map((x) => x.terminal), ['term_0', 'term_1', null]);
  assert.deepEqual(d.calls, ['worktree ps']);
  const e = fakeOrca(proj, [...agents, { paneKey: 't3:l3', state: 'working', stateStartedAt: NOW, updatedAt: NOW }]);
  assert.deepEqual(readOrca(e, { home, hosted: [], now: NOW + 61_000 }).agents.map((x) => x.terminal), ['term_0', 'term_1', 'term_2']);
  assert.deepEqual(e.calls, ['worktree ps', 'terminal list']);
  // a failing terminal list leaves the handle empty and nothing else breaks
  const f = fakeOrca(proj, [{ paneKey: 't9:l9', state: 'working', stateStartedAt: NOW, updatedAt: NOW }], { terminals: false });
  assert.deepEqual(readOrca(f, { home: null, hosted: [], now: NOW }).agents.map((x) => x.terminal), [null]);
  // orca missing or failing: null (the hook rules apply)
  assert.equal(readOrca(null), null);
  assert.equal(readOrca(() => { throw new Error('timeout'); }), null);
  assert.equal(readOrca(() => 'not json'), null);
});

test('listAgents: orca missing or slow falls back to the hook rules; orcaFetch gives up after its timeout', async () => {
  const { home, proj } = world([{ id: 'w', events: [[-3 * MIN, 'UserPromptSubmit', { prompt: 'go' }]] }]);
  const row = (list) => list.find((a) => a.id === 'w');
  // a runner that throws (the sync runner does so on a 1 s timeout)
  assert.deepEqual([row(listAgents(home, { now: NOW, run: () => { throw new Error('orca timed out'); }, alive: () => true })).status, row(listAgents(home, { now: NOW, run: null, alive: () => true })).stateSource], ['working', 'hooks']);
  // a slow orca binary in the async path
  const slow = join(tmp(), 'slow-orca.sh');
  writeFileSync(slow, '#!/bin/sh\nsleep 3\necho "{}"\n');
  chmodSync(slow, 0o755);
  const t0 = Date.now();
  assert.equal(await orcaFetch({ PATH: process.env.PATH, KADANS_ORCA_BIN: slow }, 150), null);
  assert.ok(Date.now() - t0 < 2500, 'gave up at the timeout, not after the sleep');
  const list = await listAgentsAsync(home, { env: { PATH: process.env.PATH, KADANS_ORCA_BIN: slow }, timeout: 150, now: NOW, alive: () => true, claudeDirs: [] });
  assert.deepEqual([row(list).status, row(list).stateSource], ['working', 'hooks']);
  assert.equal(await orcaFetch({ PATH: process.env.PATH, KADANS_ORCA: '0' }), null);
  assert.equal(await orcaFetch({ PATH: '/nonexistent' }), null);
  // a fast fake orca in the async path is read like the sync one, with the ps fetched in the background
  const fast = join(tmp(), 'fast-orca.sh');
  const ps = { ok: true, result: { worktrees: [{ path: proj, repo: 'repo', displayName: 'main', agents: [{ paneKey: 't1:l1', state: 'waiting', agentType: 'claude', stateStartedAt: NOW - MIN, updatedAt: NOW }] }] } };
  writeFileSync(fast, `#!/bin/sh\ncase "$1 $2" in\n  "worktree ps") echo '${JSON.stringify(ps)}' ;;\n  *) exit 3 ;;\nesac\n`);
  chmodSync(fast, 0o755);
  const synced = await listAgentsAsync(home, { env: { PATH: process.env.PATH, KADANS_ORCA_BIN: fast }, now: NOW, alive: () => true, hosted: hosted('w', 't1:l1', 'term_0') });
  assert.deepEqual([row(synced).status, row(synced).stateSource, row(synced).stateSince], ['needs-you', 'orca', NOW - MIN]);
});

test('scanTranscript: a cache hit (same path, size, mtime) returns the cached state without opening the file; growth reads only the tail', () => {
  const dir = tmp();
  const f = join(dir, 's.jsonl');
  writeFileSync(f, jsonl([{ type: 'user', message: { role: 'user', content: 'start'.padEnd(400, 'x') } }, asst('m1', 100)]));
  const first = scanTranscript(f, null);
  assert.deepEqual([first.done + first.cur, first.size, first.offset], [100, readFileSync(f).length, readFileSync(f).length]);
  assert.ok(Number.isFinite(first.mtime) && first.mtime > 0);
  // unchanged: the very same object comes back (no read, nothing to write)
  assert.equal(scanTranscript(f, first), first);
  // overwrite the head in place with a line that would count 900 more tokens if it were read again (same length)
  const head = readFileSync(f, 'utf8').split('\n')[0];
  const fake = JSON.stringify(asst('m9', 900));
  const fd = openSync(f, 'r+');
  writeSync(fd, fake.padEnd(head.length, ' '), 0);
  closeSync(fd);
  assert.ok(fake.length <= head.length, 'fixture: the fake line must fit the head');
  // then append: only the tail is read, so the head change is never seen
  writeFileSync(f, jsonl([asst('m2', 5)]), { flag: 'a' });
  const second = scanTranscript(f, first);
  assert.notEqual(second, first);
  assert.deepEqual([second.done + second.cur, second.offset], [105, readFileSync(f).length]);
  // a fresh scan (no cache) does see the rewritten head: 900 + 100 + 5
  assert.equal(scanTranscript(f, null).done + scanTranscript(f, null).cur, 1005);
  // a shorter file (rewritten) is scanned from the start
  writeFileSync(f, jsonl([asst('m3', 7)]));
  assert.equal(scanTranscript(f, second).done + scanTranscript(f, second).cur, 7);
});

test('listAgents: an unchanged transcript cache is not rewritten; a grown one is', () => {
  const { home, transcripts } = world([{ id: 'c1', events: [[-3 * MIN, 'UserPromptSubmit', { prompt: 'go' }]] }]);
  listAgents(home, { now: NOW, alive: () => true });
  const cacheFile = join(home, 'agents-cache.json');
  const before = readFileSync(cacheFile, 'utf8');
  const stamp = NOW - 60 * MIN;
  utimesSync(cacheFile, new Date(stamp), new Date(stamp));
  listAgents(home, { now: NOW, alive: () => true });
  assert.equal(readFileSync(cacheFile, 'utf8'), before);
  assert.equal(Math.round(statMtime(cacheFile)), stamp); // not rewritten
  writeFileSync(transcripts.c1, jsonl([asst('m1', 11)]), { flag: 'a' });
  assert.equal(listAgents(home, { now: NOW, alive: () => true })[0].tokens, 11);
  assert.notEqual(readFileSync(cacheFile, 'utf8'), before);
  // scan: false reads no transcript at all and keeps the cache as it is
  writeFileSync(transcripts.c1, jsonl([asst('m2', 22)]), { flag: 'a' });
  const after = readFileSync(cacheFile, 'utf8');
  assert.equal(listAgents(home, { now: NOW, alive: () => true, scan: false })[0].tokens, 11);
  assert.equal(readFileSync(cacheFile, 'utf8'), after);
});

function statMtime(f) {
  return spawnSync('stat', ['-f', '%m', f], { encoding: 'utf8' }).stdout.trim() * 1000;
}

test('briefOf and readBrief: the fixed shape, no double count of a second terminal on one session, freshness window', () => {
  const list = [
    { id: 'a', status: 'working' },
    { id: 'b', status: 'needs-you' },
    { id: 'c', status: 'idle' },
    { id: 'd', status: 'ended' },
    { id: 'orca:term_x', status: 'working', sameSessionAs: 'a' },
    { id: 'orca:term_y', status: 'needs-you' },
  ];
  assert.deepEqual(briefOf(list, NOW), { working: 1, needsYou: 2, t: NOW });
  assert.deepEqual(Object.keys(briefOf([], NOW)), ['working', 'needsYou', 't']);
  const home = tmp();
  assert.equal(readBrief(home, NOW), null);
  writeFileSync(join(home, 'agents-brief.json'), JSON.stringify({ working: 2, needsYou: 1, t: NOW - 1500, extra: 'x' }));
  assert.deepEqual(readBrief(home, NOW), { working: 2, needsYou: 1, t: NOW - 1500 });
  assert.equal(readBrief(home, NOW + 1000), null); // older than 2 s
  assert.equal(readBrief(home, NOW - 2000), null); // from the future (clock jump)
  writeFileSync(join(home, 'agents-brief.json'), '{"working":"2"}');
  assert.equal(readBrief(home, NOW), null);
  // every full list writes the brief
  const { home: h2, proj } = world([{ id: 'w', events: [[-3 * MIN, 'UserPromptSubmit', { prompt: 'go' }]] }, { id: 'q', events: [[-4 * MIN, 'UserPromptSubmit', { prompt: 'go' }], [-3 * MIN, 'Stop', { asked: true }]] }]);
  listAgents(h2, { now: NOW, alive: () => true });
  assert.deepEqual(JSON.parse(readFileSync(join(h2, 'agents-brief.json'), 'utf8')), { working: 1, needsYou: 1, t: NOW });
  // with Orca: Orca's verdict counts
  listAgents(h2, { now: NOW, alive: () => true, run: fakeOrca(proj, [{ paneKey: 't1:l1', state: 'done', stateStartedAt: NOW - 2 * MIN, updatedAt: NOW }]), hosted: hosted('q', 't1:l1', 'term_0') });
  assert.deepEqual(JSON.parse(readFileSync(join(h2, 'agents-brief.json'), 'utf8')), { working: 1, needsYou: 0, t: NOW });
});

test('cli: agents --brief --json prints exactly {working, needsYou, t}; a fresh brief file is served without any orca call', () => {
  const { home, proj } = world([{ id: 'w', events: [[-3 * MIN, 'UserPromptSubmit', { prompt: 'go' }]] }], Date.now());
  const root = tmp();
  const log = join(root, 'orca.log');
  const ps = { ok: true, result: { worktrees: [{ path: proj, repo: 'repo', displayName: 'main', agents: [{ paneKey: 't1:l1', state: 'waiting', agentType: 'claude', stateStartedAt: Date.now() - MIN, updatedAt: Date.now() }] }] } };
  const fake = join(root, 'fake-orca.sh');
  writeFileSync(fake, `#!/bin/sh\necho "$*" >> "${log}"\ncase "$1 $2" in\n  "worktree ps") echo '${JSON.stringify(ps)}' ;;\n  "terminal list") echo '{"ok":true,"result":{"terminals":[{"handle":"term_A","tabId":"t1","leafId":"l1","title":"Tune the gauge","preview":"secret"}]}}' ;;\n  *) exit 3 ;;\nesac\n`);
  chmodSync(fake, 0o755);
  const env = { PATH: process.env.PATH, HOME: root, KADANS_HOME: home, CLAUDE_CONFIG_DIR: join(root, 'claude'), KADANS_ORCA_BIN: fake };
  const cli = (args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 15000 });
  const r = cli(['agents', '--brief', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const b = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(b), ['working', 'needsYou', 't']);
  assert.ok(Number.isInteger(b.working) && Number.isInteger(b.needsYou) && Number.isInteger(b.t));
  assert.deepEqual([b.working, b.needsYou], [0, 1]); // Orca: waiting (the one-agent-one-session guess pairs them in this folder)
  assert.match(readFileSync(log, 'utf8'), /worktree ps/);
  // the full list wrote a fresh brief: the next brief call reads it and runs no orca at all
  const lines = readFileSync(log, 'utf8').split('\n').length;
  const r2 = cli(['agents', '--brief', '--json']);
  assert.deepEqual(JSON.parse(r2.stdout), b);
  assert.equal(readFileSync(log, 'utf8').split('\n').length, lines);
  // a full list carries the new fields and no new status values
  const full = JSON.parse(cli(['agents', '--json']).stdout);
  assert.ok(full.every((a) => ['working', 'needs-you', 'idle', 'ended'].includes(a.status)));
  assert.ok(full.every((a) => 'stateSince' in a && ['orca', 'hooks'].includes(a.stateSource)));
  assert.doesNotMatch(JSON.stringify(full), /secret/); // the terminal preview is never shown
  // k24: a row with no Claude Code title takes the Orca tab title (in memory only: not in the pane map, not in orca.title)
  const w = full.find((x) => x.id === 'w');
  assert.deepEqual([w.title, w.titleSource, w.orca?.title ?? null], ['Tune the gauge', 'orca', null]);
  assert.doesNotMatch(readFileSync(join(home, 'orca-panes.json'), 'utf8'), /Tune/);
});

test('realInspect: per-pid ps; a claude process known to the pane map skips the environment lookup; others are not remembered', () => {
  const procs = {};
  const me = realInspect(process.pid, procs);
  assert.ok(me && Number.isFinite(me.start) && /node/.test(me.comm));
  assert.deepEqual([me.paneKey, me.handle, Object.keys(procs)], [null, null, []]); // not claude: nothing looked up or kept
  assert.equal(realInspect(99990, procs), null);
  // the registry hands the pane map's memory through: an unknown (pid, start) is added, a known one is served from it
  const seen = [];
  const fake = (pid, memory) => {
    seen.push(pid);
    const key = `${pid}:${START}`;
    if (memory && !memory[key]) memory[key] = { paneKey: `t${pid}:l${pid}`, handle: `term_${pid}` };
    return { start: START, comm: 'claude', ...memory?.[key] };
  };
  const dir = tmp();
  mkdirSync(join(dir, 'sessions'));
  writeFileSync(join(dir, 'sessions', '41.json'), JSON.stringify({ pid: 41, sessionId: 's41', procStart: new Date(START).toUTCString().replace(/^(\w{3}), (\d+) (\w{3}) (\d{4}) ([\d:]{8}) GMT$/, (_, d, n, m, y, t) => `${d} ${m} ${String(Number(n))} ${t} ${y}`) }));
  const memory = {};
  const reg = readRegistry([dir], fake, memory);
  assert.deepEqual(reg.hosted, [{ pid: 41, sessionId: 's41', start: START, paneKey: 't41:l41', handle: 'term_41' }]);
  assert.deepEqual(memory, { [`41:${START}`]: { paneKey: 't41:l41', handle: 'term_41' } });
  assert.deepEqual(readPanes(tmp()), { t: 0, panes: {}, procs: {} });
});

test('titles (k24): owner > Claude Code title > Orca tab title > prompt; `terminal list` only for a row with no Claude Code title', () => {
  const titled = (_, extra = {}) => {
    const { home, proj, transcripts } = world([{ id: 'w', events: [[-3 * MIN, 'UserPromptSubmit', { prompt: 'Please fix the login form' }]] }]);
    if (extra.aiTitle) writeFileSync(transcripts.w, jsonl([{ type: 'user', message: { role: 'user', content: 'Please fix the login form' } }, { type: 'ai-title', aiTitle: extra.aiTitle }]));
    if (extra.owner) writeFileSync(join(home, 'titles.json'), JSON.stringify({ w: extra.owner }));
    return { home, proj };
  };
  const pane = [{ paneKey: 't1:l1', state: 'working', stateStartedAt: NOW, updatedAt: NOW }];
  const orcaWith = (proj, title) => {
    const calls = [];
    const base = fakeOrca(proj, pane, { calls });
    const run = (args) => (args[1] === 'list' ? (calls.push('terminal list'), JSON.stringify({ ok: true, result: { terminals: [{ handle: 'term_0', tabId: 't1', leafId: 'l1', title, preview: 'secret preview' }] } })) : base(args));
    run.calls = calls;
    return run;
  };
  // Claude Code title: no terminal list at all (the pane handle is known from the hosted process)
  let w = titled(null, { aiTitle: 'Login form fix' });
  let run = orcaWith(w.proj, 'Tab says something else');
  let [a] = listAgents(w.home, { now: NOW, alive: () => true, run, hosted: hosted('w', 't1:l1', 'term_0') });
  assert.deepEqual([a.title, a.titleSource, run.calls], ['Login form fix', 'session', ['worktree ps']]);
  // owner title: no terminal list either
  w = titled(null, { owner: 'Mine' });
  run = orcaWith(w.proj, 'Tab title');
  [a] = listAgents(w.home, { now: NOW, alive: () => true, run, hosted: hosted('w', 't1:l1', 'term_0') });
  assert.deepEqual([a.title, a.titleSource, run.calls], ['Mine', 'owner', ['worktree ps']]);
  // no Claude Code title: one terminal list; the tab title, control characters stripped, wins over the prompt
  w = titled(null);
  run = orcaWith(w.proj, '\u2733 Review the \u001b[31mrelease\u0007 notes');
  [a] = listAgents(w.home, { now: NOW, alive: () => true, run, hosted: hosted('w', 't1:l1', 'term_0') });
  assert.deepEqual([a.title, a.titleSource, run.calls], ['Review the [31mrelease notes', 'orca', ['worktree ps', 'terminal list']]);
  assert.doesNotMatch(a.title, /[\u0000-\u001f\u007f]/);
  assert.equal(a.orca.title, null); // shown as the row title only, never as Orca data
  const stored = ['orca-panes.json', 'agents-cache.json', 'agents-brief.json', 'titles.json'].map((f) => {
    try {
      return readFileSync(join(w.home, f), 'utf8');
    } catch {
      return '';
    }
  });
  assert.doesNotMatch(stored.join(''), /Review|secret/); // never stored
  // a generic tab title (a shell name): the cleaned prompt
  w = titled(null);
  run = orcaWith(w.proj, 'zsh');
  [a] = listAgents(w.home, { now: NOW, alive: () => true, run, hosted: hosted('w', 't1:l1', 'term_0') });
  assert.deepEqual([a.title, a.titleSource], ['Task of w', 'prompt']); // the transcript's first prompt
  // the pane map refresh already ran terminal list: its titles are reused, still one call
  w = titled(null);
  run = orcaWith(w.proj, 'Tab title here');
  [a] = listAgents(w.home, { now: NOW, alive: () => true, run, hosted: [] });
  assert.deepEqual([a.title, a.titleSource, run.calls], ['Tab title here', 'orca', ['worktree ps', 'terminal list']]);
  // --brief (no transcript reads): no title lookup
  w = titled(null);
  run = orcaWith(w.proj, 'Tab title here');
  listAgents(w.home, { now: NOW, alive: () => true, run, hosted: hosted('w', 't1:l1', 'term_0'), scan: false });
  assert.deepEqual(run.calls, ['worktree ps']);
});
