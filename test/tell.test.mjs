// k49: "Tell" an agent. The send guard (lib/compact.mjs sendGuard) lets a message reach a WORKING Claude Code chat when its
// input box is empty, and still refuses a dialog, a draft or a screen it cannot read; Codex idle only. Recorded screen
// fixtures only (no real chat text); fake orca callers only: nothing reaches a real terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SEND_REFUSAL, draftGuard, inputBoxState, sendGuard } from '../lib/compact.mjs';
import { sendAgent } from '../lib/agents.mjs';
import { readRemote, remoteCompact, remoteSend } from '../lib/remote.mjs';

const RULE = '─'.repeat(60);
const screen = (tail) => JSON.stringify({ ok: true, result: { terminal: { handle: 'term_A', status: 'running', source: 'screen', tail, nextCursor: null } } });

// Rendered screens, top to bottom, as `orca terminal read --screen --json` gives them.
const SCREENS = {
  idle: ['  ⏺ Done. The tests pass.', '', RULE, '❯ ', RULE, '  ? for shortcuts'],
  working: ['  ⏺ Reading the test file.', '', '✻ Thinking… (12s · ↑ 1.2k tokens · esc to interrupt)', '', RULE, '❯ ', RULE,
    '  ⏵⏵ accept edits on (shift+tab to cycle)'],
  // a message already queued while it works: the box is empty again, so another one may follow
  workingQueued: ['✢ Envisioning… (40s · esc to interrupt)', '  ⎿  Press up to edit queued messages', '', RULE, '❯ ', RULE, '  ? for shortcuts'],
  workingDraft: ['✻ Thinking… (3s · esc to interrupt)', '', RULE, '❯ and do not touch the', RULE, '  ? for shortcuts'],
  dialog: [' Bash command', '   rm -rf build', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and do not ask again',
    '   3. No, and tell Claude what to do differently', '', ' Esc to cancel'],
  question: ['☐ Pick one', '', 'Which file should I change?', '', '❯ 1. panel.js', '  2. panel.css', '', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'],
  // a dialog shown while the spinner line is still on screen: the dialog wins
  workingDialog: ['✻ Thinking… (9s · esc to interrupt)', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel'],
  draft: ['  ⏺ Done.', '', RULE, '❯ please also rename the helper and', RULE, '  ? for shortcuts'],
  unknown: ['$ ls', 'README.md  lib  test', '$ '],
  // Codex CLI: working line above its composer (a rule-boxed variant, so only the agent type refuses it) and its own layout
  codexWorkingBoxed: ['• Working (12s • esc to interrupt)', '', RULE, '› ', RULE, '  ⏎ send   ⇧⏎ newline   ⌃C quit'],
  codexWorking: ['• Working (12s • esc to interrupt)', '', '› Ask Codex to do anything', '', '  ⏎ send   ⇧⏎ newline   ⌃T transcript   ⌃C quit'],
  codexIdle: ['• Done.', '', '› Ask Codex to do anything', '', '  ⏎ send   ⇧⏎ newline   ⌃T transcript   ⌃C quit'],
};

test('k49 guard: a working Claude chat with an empty box is accepted; dialog, question, draft and unknown screens are refused', () => {
  assert.deepEqual(sendGuard(screen(SCREENS.idle)), { ok: true, working: false });
  assert.deepEqual(sendGuard(screen(SCREENS.working)), { ok: true, working: true });
  assert.deepEqual(sendGuard(screen(SCREENS.workingQueued)), { ok: true, working: true });
  const refused = { workingDraft: SEND_REFUSAL.draft, draft: SEND_REFUSAL.draft, dialog: SEND_REFUSAL.other, question: SEND_REFUSAL.other,
    workingDialog: SEND_REFUSAL.other, unknown: SEND_REFUSAL.other };
  for (const [name, why] of Object.entries(refused)) assert.deepEqual(sendGuard(screen(SCREENS[name])), { ok: false, why }, name);
  for (const raw of ['not json', '{}', JSON.stringify({ result: { terminal: { source: 'stream', tail: SCREENS.idle } } }), screen([])]) {
    assert.deepEqual(sendGuard(raw), { ok: false, why: SEND_REFUSAL.other }, raw);
  }
  // compact keeps the k48 rule: a working chat is a dialog to it (never /compact a working chat)
  assert.equal(draftGuard(screen(SCREENS.working)).ok, false);
  assert.equal(inputBoxState(SCREENS.working), 'dialog');
  assert.equal(inputBoxState(SCREENS.working, { allowWorking: true }), 'empty');
});

test('k49 guard: Codex is idle only; a working Codex screen is refused even with an empty box', () => {
  assert.deepEqual(sendGuard(screen(SCREENS.codexWorkingBoxed), { agentType: 'codex' }), { ok: false, why: SEND_REFUSAL.working });
  assert.equal(sendGuard(screen(SCREENS.codexWorking), { agentType: 'codex' }).ok, false);
  // its composer shows a placeholder a text-only screen cannot tell from typed text: not read as an empty box
  assert.equal(sendGuard(screen(SCREENS.codexIdle), { agentType: 'codex' }).ok, false);
  assert.deepEqual(sendGuard(screen(SCREENS.idle), { agentType: 'codex' }), { ok: true, working: false });
  // the same boxed working screen is fine for Claude Code
  assert.equal(sendGuard(screen(SCREENS.codexWorkingBoxed)).ok, true);
});

const MSG = 'SECRET-MESSAGE carry on, and be careful with the migrations';
const row = { id: 's1', source: 'claude', status: 'working', pid: null, orca: { terminal: 'term_A', worktree: 'w', repo: 'r', state: 'working', title: 't' } };
const READ = ['terminal', 'read', '--terminal', 'term_A', '--screen', '--json'];

test('k49 sendAgent: a working chat gets the message after the guard; needs-you, a dialog or a draft send nothing', () => {
  const calls = [];
  const r = sendAgent(row, MSG, { run: (argv) => { calls.push(argv); return argv[1] === 'read' ? screen(SCREENS.working) : '{"ok":true}'; } });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(calls, [READ, ['terminal', 'send', '--terminal', 'term_A', '--text', MSG, '--enter']]);
  for (const name of ['workingDraft', 'workingDialog', 'question', 'unknown']) {
    const c = [];
    const x = sendAgent(row, MSG, { run: (argv) => { c.push(argv); return screen(SCREENS[name]); } });
    assert.equal(x.ok, false, name);
    assert.ok(!x.why.includes(MSG));
    assert.deepEqual(c, [READ], `${name}: read only, nothing typed`);
  }
  for (const status of ['needs-you', 'ended', 'slowed']) {
    const c = [];
    assert.equal(sendAgent({ ...row, status }, MSG, { run: (argv) => { c.push(argv); return screen(SCREENS.working); } }).ok, false, status);
    assert.deepEqual(c, []);
  }
});

// ---------- another computer ----------
const NOW = 1_800_000_000_000;
const ENVS = JSON.stringify({ ok: true, result: { environments: [{ id: 'env-1', name: 'other', endpoints: [{ endpoint: 'ws://10.0.0.2' }], pairedDeviceId: 'dev' }] } });
const ps = (state, agentType = 'claude') => JSON.stringify({ ok: true, result: { worktrees: [{ repo: 'proj', path: '/opt/proj', displayName: 'main',
  agents: [{ paneKey: 'tab-1:1', state, agentType, prompt: 'Fix the sound', stateStartedAt: NOW - 60_000, updatedAt: NOW - 5000 }] }] } });
const TL = JSON.stringify({ ok: true, result: { terminals: [{ tabId: 'tab-1', leafId: '1', handle: 'term_r1', writable: true }] } });
const ok = (text) => ({ ok: true, text });
function caller({ state = 'working', tail = SCREENS.working, agentType = 'claude' } = {}) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'environment') return ok(ENVS);
    if (args[0] === 'worktree') return ok(ps(state, agentType));
    return { list: ok(TL), read: ok(screen(tail)), send: ok('{"ok":true}') }[args[1]] ?? { ok: false };
  };
  fn.calls = calls;
  return fn;
}
const withHome = (fn) => {
  const home = mkdtempSync(join(tmpdir(), 'kadans-tell-'));
  return Promise.resolve(fn(home)).finally(() => rmSync(home, { recursive: true, force: true }));
};
const ID = 'remote:other:tab-1:1';

test('k49 remote: a working Claude chat there takes no message (a dialog could take the Enter); nor a dialog or Codex', () => withHome(async (home) => {
  const [r] = await readRemote(home, { call: caller(), now: NOW });
  assert.deepEqual([r.status, r.canSend, r.canCompact], ['working', false, false]);
  let call = caller();
  const sent = await remoteSend(home, ID, MSG, { call });
  assert.equal(sent.ok, false);
  assert.match(sent.why, /working/);
  assert.ok(!sent.why.includes(MSG));
  assert.ok(!call.calls.some((c) => c.startsWith('terminal send')));
  call = caller();
  assert.match((await remoteCompact(home, ID, { call })).why, /working/); // compact stays idle only
  for (const opts of [{ tail: SCREENS.workingDialog }, { tail: SCREENS.workingDraft }, { state: 'waiting' }, { agentType: 'codex', tail: SCREENS.codexWorkingBoxed }]) {
    call = caller(opts);
    const x = await remoteSend(home, ID, MSG, { call });
    assert.equal(x.ok, false, JSON.stringify(opts));
    assert.ok(!x.why.includes(MSG));
    assert.ok(!call.calls.some((c) => c.startsWith('terminal send')), JSON.stringify(opts));
  }
}));
