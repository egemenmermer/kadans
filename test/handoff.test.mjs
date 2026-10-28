// k54: "Continue on kasa" (lib/handoff.mjs). Temp git repos with a local bare repo as origin, a temp Claude config folder
// with an invented transcript, fake orca callers and a fake hub: nothing reaches a real chat, terminal, Orca or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import {
  ERR, HANDOFF_INSTRUCTION, LATE_MS, TASK_MAX, askHandoff, canonicalRemote, checkReady, gitRunner, handoffLine, handoffStatus,
  matchRepos, readAsks, startHandoff, taskText, transcriptCandidate, validBranch, validNotePath,
} from '../lib/handoff.mjs';
import { SEND_REFUSAL } from '../lib/compact.mjs';
import { messageText } from '../lib/text.mjs';
import { ALLOWED_ACTIONS, NEEDS_AGENT, SENDS, createPhoneServer, planAction } from '../lib/serve.mjs';
import { newPairCode } from '../lib/phone.mjs';
import { writeAtomic } from '../lib/store.mjs';
import { assertNoInjection, fixture, flush, loadPanel } from './panel-dom.mjs';

const NOTE_SECRET = 'SECRET-NOTE-K54 the next steps live only in the note';
const CHAT_SECRET = 'SECRET-CHAT-K54 something the chat said';
const RULE = '─'.repeat(60);
const screen = (tail) => JSON.stringify({ ok: true, result: { terminal: { handle: 'term_A', status: 'running', source: 'screen', tail, nextCursor: null } } });
const SCREENS = {
  idle: ['  ⏺ Done.', '', RULE, '❯ ', RULE, '  ? for shortcuts'],
  working: ['✻ Thinking… (12s · esc to interrupt)', '', RULE, '❯ ', RULE, '  ? for shortcuts'],
  draft: ['  ⏺ Done.', '', RULE, '❯ please also rename the helper and', RULE, '  ? for shortcuts'],
  dialog: [' Bash command', '   rm -rf build', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'],
  unknown: ['$ ls', 'README.md  lib  test', '$ '],
};

// git with no global or system config (no signing, hooks or templates from the owner's setup)
function gitEnv(root) {
  return { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', LANG: 'C' };
}
function sh(env, cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
// A work repo whose origin is a local bare repo, with one pushed commit on main.
function repos() {
  const root = mkdtempSync(join(tmpdir(), 'kadans-k54-'));
  const env = gitEnv(root);
  const bare = join(root, 'origin.git');
  const work = join(root, 'game');
  sh(env, root, 'init', '--bare', '-b', 'main', bare);
  sh(env, root, 'init', '-b', 'main', work);
  sh(env, work, 'remote', 'add', 'origin', bare);
  writeFileSync(join(work, 'README.md'), 'game\n');
  sh(env, work, 'add', '.');
  sh(env, work, 'commit', '-m', 'first');
  sh(env, work, 'push', '-q', 'origin', 'main');
  const home = join(root, 'kadans');
  const claude = join(root, 'claude');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return { root, env, bare, work, home, claude, git: gitRunner(env) };
}
// The chat writes, commits and (optionally) pushes a note, the way the instruction asks.
function writeNote(r, { branch = 'feat/rain', name = '2026-10-27-rain-loop.md', push = true, date = null } = {}) {
  const env = date ? { ...r.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : r.env;
  if (sh(env, r.work, 'branch', '--list', branch) === '') sh(env, r.work, 'switch', '-q', '-c', branch);
  else sh(env, r.work, 'switch', '-q', branch);
  mkdirSync(join(r.work, 'docs', 'handoff'), { recursive: true });
  writeFileSync(join(r.work, 'docs', 'handoff', name), `# Handoff\n${NOTE_SECRET}\n`);
  sh(env, r.work, 'add', '.');
  sh(env, r.work, 'commit', '-q', '-m', 'handoff note');
  if (push) sh(env, r.work, 'push', '-q', 'origin', branch);
  return { branch, path: `docs/handoff/${name}` };
}
const SID = '00000000-1d2a-4c3b-9e8f-7a6b5c4d3e2f';
function transcript(r, lines) {
  const dir = join(r.claude, 'projects', r.work.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SID}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}
const said = (text, at) => ({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const typed = (text, at) => ({ type: 'user', timestamp: new Date(at).toISOString(), message: { role: 'user', content: text } });
const agentIn = (r, extra = {}) => ({ id: SID, source: 'claude', cwd: r.work, status: 'idle', title: CHAT_SECRET, firstPrompt: CHAT_SECRET, pid: null,
  orca: { terminal: 'term_A', ambiguous: false }, ...extra });
// A fake orca for sendAgent: answers the screen read with `scr` and records every call.
const fakeRun = (scr, calls) => (args) => {
  calls.push(args);
  if (args[0] === 'terminal' && args[1] === 'read') return screen(SCREENS[scr]);
  if (args[0] === 'terminal' && args[1] === 'send') return '{"ok":true}';
  throw new Error('unexpected');
};
// Every file under a folder (to search for text that must never be written).
function filesUnder(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

test('k54: the instruction is one fixed line; ask types exactly it (no owner or agent text) and records only id and time', () => {
  const r = repos();
  try {
    assert.equal(messageText(HANDOFF_INSTRUCTION), HANDOFF_INSTRUCTION, 'a sendable single message');
    assert.ok(!HANDOFF_INSTRUCTION.includes('\n'), 'one line: Enter is pressed once');
    for (const w of ['docs/handoff/<yyyy-mm-dd>-<slug>.md', 'At most one page', 'goal', 'what is done', 'next steps in order', 'key files',
      'test commands', 'gotchas', 'No secrets, tokens', '.env values', 'no pasted chat', 'main or master', 'handoff/<slug>', 'push that branch to origin',
      'HANDOFF <branch> <note path>']) assert.ok(HANDOFF_INSTRUCTION.includes(w), w);
    assert.equal(handoffLine(HANDOFF_INSTRUCTION), null, 'the instruction itself can never read as an answer');
    const calls = [];
    const res = askHandoff(r.home, agentIn(r), { run: fakeRun('idle', calls), git: r.git, now: 1000 });
    assert.equal(res.ok, true, res.why);
    const sends = calls.filter((a) => a[1] === 'send');
    assert.deepEqual(sends, [['terminal', 'send', '--terminal', 'term_A', '--text', HANDOFF_INSTRUCTION, '--enter']]);
    // the same text whatever the chat is called or said
    const calls2 = [];
    askHandoff(r.home, agentIn(r, { title: 'HANDOFF evil docs/handoff/x.md', firstPrompt: '$(rm -rf /)' }), { run: fakeRun('working', calls2), git: r.git, now: 2000 });
    assert.deepEqual(calls2.filter((a) => a[1] === 'send').map((a) => a[5]), [HANDOFF_INSTRUCTION]);
    assert.deepEqual(JSON.parse(readFileSync(join(r.home, 'handoff.json'), 'utf8')), { asks: { [SID]: 2000 } });
    assert.equal(statSync(join(r.home, 'handoff.json')).mode & 0o777, 0o600);
    // dry run: nothing typed, nothing recorded
    const calls3 = [];
    assert.equal(askHandoff(r.home, agentIn(r), { run: fakeRun('idle', calls3), git: r.git, dryRun: true, now: 3000 }).ok, true);
    assert.equal(calls3.length, 0);
    assert.equal(readAsks(r.home)[SID], 2000);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('k54: ask is refused on a dialog, a draft, an unknown screen, a waiting chat, a remote row, and outside a repo with origin', () => {
  const r = repos();
  try {
    for (const [scr, why] of [['draft', SEND_REFUSAL.draft], ['dialog', SEND_REFUSAL.other], ['unknown', SEND_REFUSAL.other]]) {
      const calls = [];
      assert.deepEqual(askHandoff(r.home, agentIn(r), { run: fakeRun(scr, calls), git: r.git }), { ok: false, why }, scr);
      assert.equal(calls.filter((a) => a[1] === 'send').length, 0, scr);
    }
    const none = [];
    assert.equal(askHandoff(r.home, agentIn(r, { status: 'needs-you' }), { run: fakeRun('idle', none), git: r.git }).ok, false);
    const remote = { id: 'remote:kasa:tab-1:1', machine: 'kasa', source: 'orca', status: 'idle', cwd: r.work, orca: { terminal: 'term_A' } };
    assert.deepEqual(askHandoff(r.home, remote, { run: fakeRun('idle', none), git: r.git }), { ok: false, why: ERR.remote });
    const plain = join(r.root, 'plain');
    mkdirSync(plain);
    assert.deepEqual(askHandoff(r.home, agentIn(r, { cwd: plain }), { run: fakeRun('idle', none), git: r.git }), { ok: false, why: ERR.git });
    sh(r.env, r.work, 'remote', 'remove', 'origin');
    assert.deepEqual(askHandoff(r.home, agentIn(r), { run: fakeRun('idle', none), git: r.git }), { ok: false, why: ERR.git });
    assert.equal(none.length, 0, 'no screen read, nothing typed');
    assert.deepEqual(readAsks(r.home), {});
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('k54: ready only when the branch holds the note and origin has the same commit (local bare repo as origin)', async () => {
  const r = repos();
  try {
    const t0 = Date.now() - 60_000;
    writeAtomic(join(r.home, 'handoff.json'), JSON.stringify({ asks: { [SID]: t0 } }));
    const st = (now = Date.now()) => handoffStatus(r.home, agentIn(r), { git: r.git, claudeDirs: [r.claude], now });
    assert.equal((await st()).state, 'waiting');
    assert.equal((await st(t0 + LATE_MS)).state, 'late');
    // committed, not pushed: not ready (the commit fallback finds it, ls-remote does not)
    const c = writeNote(r, { push: false });
    assert.deepEqual(checkReady(r.work, c, { git: r.git }), { ready: false, why: 'push' });
    assert.equal((await st()).state, 'waiting');
    // the chat claims a HANDOFF that is not pushed: text cannot make it ready
    transcript(r, [typed(HANDOFF_INSTRUCTION, t0 + 1000), said(`Done.\nHANDOFF ${c.branch} ${c.path}`, t0 + 2000)]);
    assert.equal((await st()).state, 'waiting');
    // pushed: ready, from the transcript line
    sh(r.env, r.work, 'push', '-q', 'origin', c.branch);
    const ok = await st();
    assert.deepEqual([ok.state, ok.branch, ok.path], ['ready', c.branch, c.path]);
    // a newer local commit (not pushed): the shas differ, not ready
    writeFileSync(join(r.work, 'more.txt'), 'x\n');
    sh(r.env, r.work, 'add', '.');
    sh(r.env, r.work, 'commit', '-q', '-m', 'more');
    assert.equal((await st()).state, 'waiting');
    sh(r.env, r.work, 'push', '-q', 'origin', c.branch);
    assert.equal((await st()).state, 'ready');
    // a HANDOFF line naming a note the branch does not hold, or a branch that does not exist
    assert.deepEqual(checkReady(r.work, { branch: c.branch, path: 'docs/handoff/2026-10-27-other.md' }, { git: r.git }), { ready: false, why: 'note' });
    assert.deepEqual(checkReady(r.work, { branch: 'feat/none', path: c.path }, { git: r.git }), { ready: false, why: 'branch' });
    // a tag with the branch's name pushed to origin does not count as the branch
    sh(r.env, r.work, 'switch', '-q', 'main');
    sh(r.env, r.work, 'tag', 'feat/tagonly');
    sh(r.env, r.work, 'push', '-q', 'origin', 'refs/tags/feat/tagonly');
    assert.deepEqual(checkReady(r.work, { branch: 'feat/tagonly', path: c.path }, { git: r.git }), { ready: false, why: 'branch' });
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('k54: an older pushed note does not count after a new ask (transcript and commit both bounded by the ask)', async () => {
  const r = repos();
  try {
    const old = writeNote(r, { date: '2026-01-01T10:00:00Z' });
    const oldAt = Date.parse('2026-01-01T10:00:05Z');
    transcript(r, [said(`HANDOFF ${old.branch} ${old.path}`, oldAt)]);
    const st = () => handoffStatus(r.home, agentIn(r), { git: r.git, claudeDirs: [r.claude] });
    assert.equal((await st()).state, 'none', 'never asked: an old pushed note never makes the chat ready (rev-2 M1)');
    writeAtomic(join(r.home, 'handoff.json'), JSON.stringify({ asks: { [SID]: Date.now() - 1000 } }));
    assert.equal((await st()).state, 'waiting', 'asked again: the old note is not the answer');
    const fresh = writeNote(r, { name: '2026-10-27-second-try.md' });
    const now = await st();
    assert.deepEqual([now.state, now.path], ['ready', fresh.path], 'the new commit after the ask counts (commit fallback)');
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('k54: hostile branch and path strings are refused before any git call; the transcript gives only { branch, path }', () => {
  const badBranches = ['-x', '--upload-pack=evil', 'a..b', 'a b', '$(touch x)', '`id`', 'a\nb', 'a//b', 'x.lock', 'x.lock/y', '.hidden', 'a/.b', 'HEAD',
    'feat/', '/feat', 'a'.repeat(101), 'a;b', 'a|b', 'a~1', 'a^', 'a:b', 'a\\b', 'é', ''];
  for (const b of badBranches) assert.equal(validBranch(b), null, JSON.stringify(b));
  for (const b of ['feat/rain', 'handoff/rain-loop', 'k/k54-handoff', 'v1.2_fix', 'a'.repeat(100)]) assert.equal(validBranch(b), b);
  const badPaths = ['../x.md', 'docs/handoff/../x.md', 'docs/handoff/..md', 'docs/handoff/a b.md', 'docs/handoff/$(x).md', 'docs/handoff/`x`.md',
    'docs/handoff/x.md\n', 'docs/handoff/-x.md', 'docs/handoff/.x.md', 'docs/handoff/x.txt', 'docs/handoff/sub/x.md', '/docs/handoff/x.md',
    'docs/other/x.md', `docs/handoff/${'a'.repeat(81)}.md`];
  for (const p of badPaths) assert.equal(validNotePath(p), null, JSON.stringify(p));
  assert.equal(validNotePath('docs/handoff/2026-10-27-rain.md'), 'docs/handoff/2026-10-27-rain.md');
  const calls = [];
  const git = (cwd, args) => { calls.push(args); return { ok: true, out: '' }; };
  for (const b of badBranches) assert.deepEqual(checkReady('/x', { branch: b, path: 'docs/handoff/x.md' }, { git }), { ready: false, why: 'bad' });
  for (const p of badPaths) assert.deepEqual(checkReady('/x', { branch: 'feat/x', path: p }, { git }), { ready: false, why: 'bad' });
  assert.equal(calls.length, 0, 'no git call for a refused name');
  for (const line of ['HANDOFF -x docs/handoff/x.md', 'HANDOFF a..b docs/handoff/x.md', 'HANDOFF feat/x docs/handoff/../x.md', 'HANDOFF feat/x docs/handoff/x.md extra',
    'HANDOFF $(id) docs/handoff/x.md', 'say HANDOFF feat/x docs/handoff/x.md', 'HANDOFF <branch> <note path>', '`HANDOFF feat/x docs/handoff/x.md']) {
    assert.equal(handoffLine(line), null, line);
  }
  assert.deepEqual(handoffLine('Pushed.\n`HANDOFF feat/x docs/handoff/x.md`'), { branch: 'feat/x', path: 'docs/handoff/x.md' });
  // an invented transcript: only assistant lines at or after the ask count, and only branch and path come back
  const dir = mkdtempSync(join(tmpdir(), 'kadans-k54-t-'));
  try {
    const f = join(dir, 't.jsonl');
    writeFileSync(f, [typed('HANDOFF feat/user docs/handoff/user.md', 5000), said(`${CHAT_SECRET}\nHANDOFF feat/old docs/handoff/old.md`, 1000),
      said(`${CHAT_SECRET}\nHANDOFF feat/new docs/handoff/new.md`, 6000), '{"partial'].map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
    assert.deepEqual(transcriptCandidate(f, 2000), { branch: 'feat/new', path: 'docs/handoff/new.md' });
    assert.equal(transcriptCandidate(f, 7000), null);
    assert.deepEqual(transcriptCandidate(f, null), { branch: 'feat/new', path: 'docs/handoff/new.md' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('k54: the task text is built only from the validated parts and fits in 400 characters', () => {
  const b = 'a'.repeat(100);
  const p = `docs/handoff/${'b'.repeat(80)}.md`;
  const t = taskText(b, p);
  assert.ok(t && t.length <= TASK_MAX, String(t?.length));
  assert.equal(messageText(t), t);
  const shape = (x) => x.replace(b, '<B>').replace(p, '<P>');
  assert.equal(shape(t), shape(taskText('feat/x', 'docs/handoff/x.md').replace('feat/x', b).replace('docs/handoff/x.md', p)));
  assert.equal(shape(t), 'Continue the work in <P> on branch <B>. First run `git fetch origin` and switch this worktree to that branch. '
    + 'Read the note, then continue with its next steps in order. Commit often. Do not push unless asked.');
  for (const [x, y] of [['-x', 'docs/handoff/x.md'], ['feat/x', '../x.md'], ['$(id)', 'docs/handoff/x.md'], ['feat/x', 'docs/handoff/x.md\nrm -rf /']]) {
    assert.equal(taskText(x, y), null);
  }
});

test('k54: matching the repo on the other computer: by origin, else by name; ambiguous or none -> the owner picks; URLs never returned', () => {
  assert.equal(canonicalRemote('https://github.com/Owner/Game.git'), 'github.com/owner/game');
  assert.equal(canonicalRemote('https://user:TOKEN@example.invalid/Owner/Game.git'), 'example.invalid/owner/game'); // user and token dropped
  assert.equal(canonicalRemote('git@example.invalid:Owner/Game.git'), 'example.invalid/owner/game'); // scp form
  assert.equal(canonicalRemote('ssh://git@example.invalid:22/Owner/Game'), 'example.invalid/owner/game'); // ssh with a port
  assert.equal(canonicalRemote('github.com/owner/game'), 'github.com/owner/game');
  const list = [
    { id: 'r1', displayName: 'game', kind: 'git', path: 'C:/src/game', gitRemoteIdentity: { canonicalKey: 'github.com/owner/game', remoteUrl: 'https://x@example.invalid/owner/game' } },
    { id: 'r2', displayName: 'tools', kind: 'git', path: '/src/tools', gitRemoteIdentity: null },
    { id: 'r3', displayName: 'notes', kind: 'folder', path: '/src/notes' },
    { id: '-bad', displayName: 'bad', kind: 'git' },
  ];
  const a = matchRepos(list, { key: 'github.com/owner/game', names: ['other'] });
  assert.deepEqual(a, { list: [{ id: 'r1', name: 'game' }, { id: 'r2', name: 'tools' }], repo: 'r1' });
  assert.ok(!JSON.stringify(a).includes('remoteUrl') && !JSON.stringify(a).includes('/src'));
  assert.equal(matchRepos(list, { key: null, names: ['tools'] }).repo, 'r2', 'by name when there is no origin match');
  assert.equal(matchRepos([...list, { id: 'r4', displayName: 'Game', kind: 'git' }], { key: null, names: ['game'] }).repo, null, 'two by name: the owner picks');
  assert.equal(matchRepos(list, { key: 'github.com/x/y', names: ['nothing'] }).repo, null);
});

// A fake orca for the inbox calls (environment list, repo list, worker-start) and a hub that is on.
function fakeOrca(calls) {
  return async (args) => {
    calls.push(args);
    const j = (result) => ({ ok: true, text: JSON.stringify({ ok: true, result }) });
    if (args[0] === 'environment') return { ok: true, text: JSON.stringify({ ok: true, result: { environments: [{ id: 'env-kasa', name: 'kasa' }, { id: 'env-prod', name: 'web-prod' }] } }) };
    if (args[0] === 'repo') return j({ repos: [{ id: 'repo-game', displayName: 'game', kind: 'git', path: '/src/game', gitRemoteIdentity: null }] });
    if (args[1] === 'worker-start') return j({ dispatchId: 'disp_k54', taskId: 'task_k54', state: 'ready' });
    return { ok: false, text: '' };
  };
}
const HUB = async () => ({ on: true, bound: true });

test('k54: start needs confirmed, a fresh ready check and a paired computer; the spec is the built text only', async () => {
  const r = repos();
  try {
    writeAtomic(join(r.home, 'inbox.json'), JSON.stringify({ runId: 'run_1', coordinator: 'term_hub', tasks: {} }));
    const calls = [];
    const deps = { git: r.git, claudeDirs: [r.claude], call: fakeOrca(calls), hub: HUB, rand: () => 'beef' };
    const agent = agentIn(r);
    assert.deepEqual(await startHandoff(r.home, agent, { machine: 'env-kasa', repo: 'repo-game' }, deps), { ok: false, why: ERR.confirm });
    assert.deepEqual(await startHandoff(r.home, agent, { machine: 'env-kasa', repo: 'repo-game', confirmed: 'true' }, deps), { ok: false, why: ERR.confirm });
    assert.deepEqual(await startHandoff(r.home, agent, { machine: 'local', repo: 'repo-game', confirmed: true }, deps), { ok: false, why: ERR.local });
    assert.deepEqual(await startHandoff(r.home, agent, { machine: 'env-kasa', repo: 'repo-game', confirmed: true }, deps), { ok: false, why: ERR.notReady });
    assert.equal(calls.length, 0, 'nothing reached orca');
    writeAtomic(join(r.home, 'handoff.json'), JSON.stringify({ asks: { [SID]: Date.now() - 1000 } }));
    const c = writeNote(r);
    transcript(r, [said(`${CHAT_SECRET}\nHANDOFF ${c.branch} ${c.path}`, Date.now())]);
    // the status for the page: ready, kasa only (no This Mac, no prod), the repo matched by name
    const st = await handoffStatus(r.home, agent, { ...deps, machine: 'env-kasa' });
    assert.deepEqual(st.machines, [{ id: 'env-kasa', name: 'kasa' }]);
    assert.deepEqual([st.state, st.machine, st.repo], ['ready', { id: 'env-kasa', name: 'kasa' }, 'repo-game']);
    // a client cannot add text, branch or path: the request's extra fields are ignored
    calls.length = 0;
    const res = await startHandoff(r.home, agent, { machine: 'env-kasa', repo: 'repo-game', confirmed: true, text: 'EVIL', branch: 'evil', path: 'docs/handoff/evil.md' }, deps);
    assert.deepEqual(res, { ok: true, dispatchId: 'disp_k54', taskId: 'task_k54', machine: 'env-kasa' });
    const start = calls.find((a) => a[1] === 'worker-start');
    assert.equal(start[start.indexOf('--spec') + 1], taskText(c.branch, c.path));
    assert.ok(!start.join(' ').includes('EVIL') && !start.join(' ').includes('evil'));
    assert.deepEqual(start.slice(start.indexOf('--on'), start.indexOf('--on') + 2), ['--on', 'env-kasa']);
    assert.ok(!calls.some((a) => a[0] === 'orchestration' && ['send', 'reply', 'check'].includes(a[1])));
    assert.deepEqual(readAsks(r.home), {}, 'the ask is done');
    assert.equal((await handoffStatus(r.home, agent, deps)).state, 'none', 'after a start the same note is not ready again (rev-2 M1)');
    writeAtomic(join(r.home, 'handoff.json'), JSON.stringify({ asks: { [SID]: Date.now() - 1000 } }));
    const box = JSON.parse(readFileSync(join(r.home, 'inbox.json'), 'utf8'));
    assert.deepEqual(box.tasks.disp_k54.machine, 'env-kasa', 'the task shows in the inbox as Kadans started it');
    // prod-looking computer: refused by the inbox rules
    assert.deepEqual(await startHandoff(r.home, agent, { machine: 'env-prod', repo: 'repo-game', confirmed: true }, deps), { ok: false, why: 'refused: Kadans never starts work on a production host' });
    // nothing of the note or the chat in any Kadans file
    for (const f of filesUnder(r.home)) {
      const text = readFileSync(f, 'utf8');
      for (const x of [NOTE_SECRET, CHAT_SECRET, 'SECRET', c.branch, c.path]) assert.ok(!text.includes(x), `${x} in ${f}`);
    }
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('k54 phone: handoff-ask/status/start are allowed for paired devices; start needs confirmed; ask and start share the k48 limit', async () => {
  for (const a of ['handoff-ask', 'handoff-status', 'handoff-start']) assert.ok(ALLOWED_ACTIONS.includes(a) && NEEDS_AGENT.has(a), a);
  assert.ok(SENDS.has('handoff-ask') && SENDS.has('handoff-start') && !SENDS.has('handoff-status'));
  const ids = new Set(['a1', 'remote:kasa:tab:1']);
  assert.deepEqual(planAction({ action: 'handoff-ask', id: 'a1', text: 'EVIL' }, ids), { action: 'handoff-ask', id: 'a1', args: ['handoff', 'a1', '--ask'], timeout: 30_000 });
  assert.match(planAction({ action: 'handoff-ask', id: 'remote:kasa:tab:1' }, ids).why, /^refused: /);
  assert.match(planAction({ action: 'handoff-ask', id: 'zz' }, ids).why, /^refused: /);
  assert.deepEqual(planAction({ action: 'handoff-status', id: 'a1', machine: 'env-kasa' }, ids).args, ['handoff', 'a1', '--status', '--json', '--to', 'env-kasa']);
  assert.match(planAction({ action: 'handoff-status', id: 'a1', machine: 'local' }, ids).why, /^refused: /);
  const start = { action: 'handoff-start', id: 'a1', machine: 'env-kasa', repo: 'repo-game', text: 'EVIL', branch: 'evil', path: 'docs/handoff/evil.md' };
  assert.equal(planAction(start, ids).why, 'refused: starting a task needs the confirm step');
  assert.equal(planAction({ ...start, confirmed: 'true' }, ids).why, 'refused: starting a task needs the confirm step');
  for (const bad of [{ machine: '-x' }, { machine: 'local' }, { repo: '/src/game' }, { repo: undefined }]) assert.match(planAction({ ...start, confirmed: true, ...bad }, ids).why, /^refused: /);
  const plan = planAction({ ...start, confirmed: true }, ids);
  assert.deepEqual(plan, { action: 'handoff-start', id: 'a1', args: ['handoff', 'a1', '--start', '--to', 'env-kasa', '--repo', 'repo-game', '--yes'], timeout: 170_000 });
  assert.equal(plan.input, undefined, 'no text goes to the CLI');

  const home = mkdtempSync(join(tmpdir(), 'kadans-k54-serve-'));
  const clock = { t: 1_000_000 };
  const calls = [];
  const okJson = (v) => ({ code: 0, out: `${JSON.stringify(v)}\n`, err: '', timedOut: false });
  const run = async (args, o = {}) => {
    calls.push({ args, input: o.input ?? null });
    const key = args.join(' ');
    if (key === 'agents --json') return okJson([{ id: 'a1' }]);
    if (key === 'status --json') return okJson({ version: 1, accounts: [] });
    if (key === 'config get --json') return okJson({ version: 1, phone: true });
    if (args[0] === 'handoff' && args[2] === '--status') return okJson({ ok: true, state: 'waiting', askedAt: 1 });
    if (args[0] === 'handoff' && args[2] === '--start') return { code: 0, out: 'disp_k54\n', err: '', timedOut: false };
    if (args[0] === 'handoff' && args[2] === '--ask') return { code: 2, out: `${CHAT_SECRET}\n`, err: 'kadans: not asked: That chat has unsent text: nothing was sent\n', timedOut: false };
    return { code: 0, out: 'done\n', err: '', timedOut: false };
  };
  const server = createPhoneServer({ home, run, now: () => clock.t });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const req = (path, body, token) => new Promise((done, fail) => {
    const data = JSON.stringify(body);
    const h = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const q = request({ host: '127.0.0.1', port, method: 'POST', path, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); done({ status: res.statusCode, text, json: JSON.parse(text) }); });
    });
    q.on('error', fail);
    q.end(data);
  });
  try {
    assert.equal((await req('/api/action', { action: 'handoff-status', id: 'a1' })).status, 401, 'not paired: nothing runs');
    const { code } = newPairCode(home, clock.t);
    const { token } = (await req('/api/pair', { code, name: 'phone' })).json;
    const post = (body) => { clock.t += 1000; return req('/api/action', body, token); };
    let r = await post({ action: 'handoff-status', id: 'a1', machine: 'env-kasa' });
    assert.deepEqual(r.json, { action: 'handoff-status', id: 'a1', ok: true, why: '', handoff: { ok: true, state: 'waiting', askedAt: 1 } });
    r = await post({ action: 'handoff-ask', id: 'a1' });
    assert.deepEqual(r.json, { action: 'handoff-ask', id: 'a1', ok: false, why: 'not asked: That chat has unsent text: nothing was sent' });
    assert.ok(!r.text.includes('SECRET'), 'the why comes from stderr only');
    assert.equal((await post({ ...start })).status, 400, 'unconfirmed start: refused before anything runs');
    r = await post({ ...start, confirmed: true });
    assert.deepEqual(r.json, { action: 'handoff-start', id: 'a1', ok: true, why: '', dispatchId: 'disp_k54' });
    const sent = calls.filter((c) => c.args[0] === 'handoff');
    assert.ok(sent.every((c) => c.input === null), 'no stdin text for any handoff action');
    assert.ok(!JSON.stringify(sent).includes('EVIL') && !JSON.stringify(sent).includes('evil'));
    // the k48 limit (6 per device per minute): ask + start so far; 4 more sends pass with agent-send mixed in, the 7th waits
    for (let i = 0; i < 2; i++) assert.equal((await post({ action: 'handoff-ask', id: 'a1' })).status, 200);
    assert.equal((await post({ action: 'agent-send', id: 'a1', text: 'ok' })).status, 200);
    assert.equal((await post({ action: 'handoff-start', ...start, confirmed: true })).status, 200);
    const busy = await post({ action: 'handoff-ask', id: 'a1' });
    assert.deepEqual([busy.status, busy.json.why], [429, 'Too many messages; wait a minute']);
    assert.equal((await post({ action: 'handoff-status', id: 'a1' })).status, 200, 'status is a read, not a send');
    server.flushSeen();
    for (const f of filesUnder(home)) assert.ok(!readFileSync(f, 'utf8').includes('SECRET'), f);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------- the page (app/web/panel.js "continue on another computer (k54)") in the fake DOM of panel-dom.mjs ----------
const PN = 1792964040000; // fixtures/_base.js KF.N
function page(opts = {}) {
  const clock = { now: PN };
  const p = loadPanel({ clock, timers: [], ...opts });
  if (!opts.http) p.window.kadans.reset();
  const of = (action) => JSON.parse(JSON.stringify(p.sent.filter((m) => m.action === action)));
  const result = (r) => p.window.kadans.result(r);
  return { p, clock, of, result };
}
const READY = { ok: true, state: 'ready', askedAt: PN, branch: 'feat/rain-loop', path: 'docs/handoff/2026-10-27-rain-loop.md',
  machine: { id: 'env-0001', name: 'kasa' }, repo: 'repo-0001', repos: [{ id: 'repo-0001', name: 'rain-sounds' }, { id: 'repo-0003', name: 'tools' }] };

test('k54 page: Continue on kasa -> confirm -> handoff-ask {id} -> Writing handoff… -> status on refresh -> step 2 -> handoff-start', () => {
  const { p, clock, of, result } = page();
  const data = fixture(p, 'handoff');
  p.window.kadans.render(data);
  assert.doesNotMatch(p.html(), /data-do="handoff"/, 'polish-2: in the row\'s More menu, not on the row');
  p.tap({ do: 'more', id: 'fx-0601' });
  assert.match(p.html(), /aria-label="Continue on kasa" data-do="handoff" data-id="fx-0601"/);
  p.tap({ do: 'handoff', id: 'fx-0601' });
  assert.match(p.html(), /class="tell ho" role="group" aria-label="Continue on kasa"[\s\S]*Kadans asks this chat to write a one-page handoff note and push its branch\./);
  assert.deepEqual(p.sent.filter((m) => m.action !== 'size' && m.action !== 'inbox'), [], 'the confirm line sends nothing');
  p.tap({ do: 'ho-ask', id: 'fx-0601' });
  assert.deepEqual(of('handoff-ask'), [{ action: 'handoff-ask', id: 'fx-0601' }], 'ids only: no text');
  assert.match(p.html(), /Asking…/);
  result({ action: 'handoff-ask', id: 'fx-0601', ok: true, why: '' });
  assert.match(p.html(), /Writing handoff…/);
  assert.doesNotMatch(p.html(), /class="tell ho"/);
  // the normal refresh: a status read only when due
  p.window.kadans.render({ agents: data.agents });
  assert.equal(of('handoff-status').length, 0);
  clock.now += 16_000;
  p.window.kadans.render({ agents: data.agents });
  p.window.kadans.render({ agents: data.agents });
  assert.deepEqual(of('handoff-status'), [{ action: 'handoff-status', id: 'fx-0601', machine: 'env-0001' }], 'one at a time');
  result({ action: 'handoff-status', id: 'fx-0601', ok: true, why: '', handoff: { ok: true, state: 'waiting', askedAt: PN } });
  assert.match(p.html(), /Writing handoff…/);
  // the chat asks for permission to push: the row says Needs you (not Writing handoff…), and the checks go on
  const asking = data.agents.map((x) => (x.id === 'fx-0601' ? { ...x, status: 'needs-you' } : x));
  p.window.kadans.render({ agents: asking });
  assert.doesNotMatch(p.html(), /Writing handoff…/);
  assert.match(p.html(), /Needs you/);
  clock.now += 16_000;
  p.window.kadans.render({ agents: asking });
  assert.equal(of('handoff-status').length, 2, 'still checking while the chat waits');
  result({ action: 'handoff-status', id: 'fx-0601', ok: true, why: '', handoff: { ok: true, state: 'waiting', askedAt: PN } });
  p.window.kadans.render({ agents: data.agents });
  assert.match(p.html(), /Writing handoff…/);
  clock.now += 16_000;
  p.window.kadans.render({ agents: data.agents });
  result({ action: 'handoff-status', id: 'fx-0601', ok: true, why: '', handoff: READY });
  assert.match(p.html(), /Handoff ready · <span class="code">feat\/rain-loop<\/span>\. Start on kasa · rain-sounds\?/);
  p.tap({ do: 'ho-start', id: 'fx-0601' });
  assert.deepEqual(of('handoff-start'), [{ action: 'handoff-start', id: 'fx-0601', machine: 'env-0001', repo: 'repo-0001', confirmed: true }]);
  assert.match(p.html(), /Starting on kasa…/);
  result({ action: 'handoff-start', id: 'fx-0601', ok: true, why: '', dispatchId: 'disp_k54' });
  assert.match(p.html(), /Started on kasa/);
  assertNoInjection(p.html(), 'k54 flow');
});

test('k54 page: no action without a paired computer, on a remote or waiting row; two computers -> Continue on… with a menu', () => {
  const { p, of } = page();
  const data = fixture(p, 'handoff');
  p.window.kadans.render({ ...data, inbox: { ready: false, hub: 'off', machines: [{ id: 'local', name: 'This Mac' }], items: [] } });
  p.tap({ do: 'more', id: 'fx-0601' });
  assert.match(p.html(), /data-key="menu:more:fx-0601"/);
  assert.doesNotMatch(p.html(), /data-do="handoff"/, 'inbox off: no computer to continue on');
  p.tap({ do: 'more', id: 'fx-0601' });
  const remote = { id: 'remote:kasa:tab-1:1', source: 'orca', machine: 'kasa', status: 'idle', canSend: true, canStop: true, title: 'There', orca: null };
  const waiting = { ...data.agents[1], id: 'fx-0603', status: 'needs-you' };
  p.window.kadans.render({ ...data, agents: [...data.agents, remote, waiting] });
  p.tap({ do: 'more', id: 'fx-0601' });
  assert.match(p.html(), /data-do="handoff" data-id="fx-0601"/);
  assert.doesNotMatch(p.html(), /data-do="handoff" data-id="remote:/); // Tell and Close on its row: no menu
  p.tap({ do: 'more', id: 'fx-0603' });
  assert.match(p.html(), /data-key="menu:more:fx-0603"/);
  assert.doesNotMatch(p.html(), /data-do="handoff" data-id="fx-0603"/);
  p.tap({ do: 'more', id: 'fx-0603' });
  p.window.kadans.render(fixture(p, 'handoff_pick'));
  p.tap({ do: 'more', id: 'fx-0601' });
  assert.match(p.html(), /aria-label="Continue on…" data-do="handoff" data-id="fx-0601" aria-haspopup="menu"/);
  p.tap({ do: 'handoff', id: 'fx-0601' });
  assert.match(p.html(), /role="menu" aria-label="Continue on"[\s\S]*data-v="env-0001"[\s\S]*>kasa<[\s\S]*data-v="env-0003"[\s\S]*>PC</);
  p.tap({ do: 'ho-machine', id: 'fx-0601', v: 'env-0003' });
  assert.match(p.html(), /aria-label="Continue on PC"/);
  p.tap({ do: 'ho-cancel', id: 'fx-0601' });
  assert.doesNotMatch(p.html(), /class="tell ho"/);
  assert.equal(of('handoff-ask').length, 0, 'Cancel sends nothing');
});

test('k54 page: the late line, the repo choice and refusals are fixed lines (never the CLI text)', () => {
  const { p, clock, of, result } = page();
  const data = fixture(p, 'handoff');
  p.window.kadans.render(data);
  p.tap({ do: 'handoff', id: 'fx-0601' });
  p.tap({ do: 'ho-ask', id: 'fx-0601' });
  result({ action: 'handoff-ask', id: 'fx-0601', ok: false, why: `not asked: That chat has unsent text: nothing was sent ${CHAT_SECRET}` });
  assert.match(p.html(), /That chat has unsent text\. Nothing was sent\./);
  assert.ok(!p.html().includes('SECRET'));
  p.tap({ do: 'handoff', id: 'fx-0601' });
  p.tap({ do: 'ho-ask', id: 'fx-0601' });
  result({ action: 'handoff-ask', id: 'fx-0601', ok: true, why: '' });
  clock.now += 15 * 60_000 + 1000;
  p.window.kadans.render({ agents: data.agents });
  assert.match(p.html(), /No handoff yet\. Check the chat\./);
  result({ action: 'handoff-status', id: 'fx-0601', ok: true, why: '', handoff: { ...READY, repo: null } });
  assert.match(p.html(), /Which project on kasa\?[\s\S]*data-do="ho-repo" data-id="fx-0601" data-v="repo-0001"/);
  assert.doesNotMatch(p.html(), /data-do="ho-start"/, 'no Start before a project is picked');
  p.tap({ do: 'ho-repo', id: 'fx-0601', v: 'repo-0003' });
  assert.match(p.html(), /Start on kasa · tools\?/);
  p.tap({ do: 'ho-start', id: 'fx-0601' });
  result({ action: 'handoff-start', id: '', ok: false, why: `The inbox is off. Tap Set up. ${NOTE_SECRET}` });
  assert.match(p.html(), /The inbox is off\. Set it up in the Inbox first\./);
  assert.ok(!p.html().includes('SECRET'));
  assert.deepEqual(of('handoff-start').at(-1), { action: 'handoff-start', id: 'fx-0601', machine: 'env-0001', repo: 'repo-0003', confirmed: true });
});

test('k54 phone: the steps are a bottom sheet and the three actions go over HTTP (the page allow-list)', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url.includes('state')) return { status: 200, json: async () => ({ status: null, agents: [] }) };
    const out = { action: body.action, id: body.id ?? '', ok: true, why: '' };
    if (body.action === 'handoff-status') out.handoff = READY;
    return { status: 200, json: async () => out };
  };
  const store = new Map([['kadans.token', 'tok']]);
  const { p } = page({ http: { fetch, store } });
  await flush();
  p.window.kadans.render(fixture(p, 'handoff'));
  p.tap({ do: 'handoff', id: 'fx-0601' });
  assert.match(p.html(), /class="tell ho sheet"/);
  p.tap({ do: 'ho-ask', id: 'fx-0601' });
  await flush();
  p.window.kadans.send({ action: 'handoff-status', id: 'fx-0601', machine: 'env-0001' });
  await flush();
  assert.match(p.html(), /class="tell ho sheet"[\s\S]*Start on kasa · rain-sounds\?/);
  p.tap({ do: 'ho-start', id: 'fx-0601' });
  await flush();
  const acts = calls.filter((c) => c.url === 'api/action').map((c) => c.body);
  assert.deepEqual(acts.filter((b) => b.action.startsWith('handoff')), [{ action: 'handoff-ask', id: 'fx-0601' },
    { action: 'handoff-status', id: 'fx-0601', machine: 'env-0001' }, { action: 'handoff-start', id: 'fx-0601', machine: 'env-0001', repo: 'repo-0001', confirmed: true }]);
  assert.deepEqual([...store.keys()], ['kadans.token']);
});
