import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configView, setSetting } from '../lib/config.mjs';
import { BIG_CHARS, BRIEF, briefText, KEEP_MS, MAX_FILES, MAX_SESSIONS, leanFile, leanOf, prune, readLean, runLean } from '../lib/lean.mjs';
import { progressProgram } from '../lib/progress.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadans.mjs');
const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 27, 12, 0);
const SID = 'aaaaaaaa-1111-2222-3333-444444444444';

function setup(cfg = null) {
  const home = mkdtempSync(join(tmpdir(), 'kadans-lean-'));
  if (cfg) writeFileSync(join(home, 'config.json'), JSON.stringify(cfg));
  const file = join(home, 'notes.txt');
  writeFileSync(file, 'line one\nline two\n');
  return { home, file, env: { KADANS_HOME: home } };
}

const run = (env, input, now = NOW) => runLean(JSON.stringify({ session_id: SID, ...input }), env, { now });
const ctx = (s) => (s ? JSON.parse(s).hookSpecificOutput.additionalContext : null);
const pre = (env, file, ti = {}, now) => run(env, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: file, ...ti } }, now);
const post = (env, file, { ti = {}, res, now } = {}) =>
  run(env, {
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: file, ...ti },
    tool_response: res ?? { type: 'text', file: { filePath: file, content: 'line one\nline two\n', numLines: 2, startLine: 1, totalLines: 2 } },
  }, now);

test('SessionStart: one brief of at most 60 words, none on resume', () => {
  const { env } = setup();
  assert.ok(BRIEF.split(/\s+/).length <= 60);
  const o = JSON.parse(run(env, { hook_event_name: 'SessionStart', source: 'startup' }));
  assert.equal(o.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(o.hookSpecificOutput.additionalContext, briefText(progressProgram(env.PATH)));
  assert.equal(run(env, { hook_event_name: 'SessionStart', source: 'resume' }), '');
});

test('re-read of an unchanged file read in full: nudge, counted; first read: none', () => {
  const { env, home, file } = setup();
  assert.equal(pre(env, file), ''); // never read
  assert.equal(post(env, file), '');
  const o = JSON.parse(pre(env, file, {}, NOW + 5 * MIN));
  assert.equal(o.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(o.hookSpecificOutput.permissionDecision, undefined); // a nudge, never a deny
  assert.equal(o.hookSpecificOutput.additionalContext, 'Already read notes.txt 5 min ago, unchanged: use it or read a range.');
  assert.deepEqual(leanOf(readLean(home), SID), { rereads: 1, bigOutputs: 0 });
  const kept = readFileSync(leanFile(home), 'utf8');
  assert.ok(!kept.includes('line one'), 'never stores contents');
});

test('no nudge when the file changed (size or mtime)', () => {
  const { env, file } = setup();
  post(env, file);
  writeFileSync(file, 'line one\nline two\nline three\n');
  assert.equal(pre(env, file), '');
  post(env, file); // re-recorded
  const t = new Date(NOW + 60 * MIN);
  utimesSync(file, t, t); // same size, new mtime
  assert.equal(pre(env, file), '');
});

test('no nudge for a range read now, or when the earlier read was a range or cut short', () => {
  const { env, file } = setup();
  post(env, file);
  assert.equal(pre(env, file, { offset: 10, limit: 20 }), '');
  assert.equal(pre(env, file, { limit: 5 }), '');
  const r = setup();
  post(r.env, r.file, { ti: { offset: 1, limit: 1 } });
  assert.equal(pre(r.env, r.file), '');
  const c = setup();
  post(c.env, c.file, { res: { type: 'text', file: { filePath: c.file, content: 'x', numLines: 2000, startLine: 1, totalLines: 5000 } } });
  assert.equal(pre(c.env, c.file), '');
});

test('file_unchanged stub keeps the earlier record; subagents keep their own reads', () => {
  const { env, file } = setup();
  post(env, file);
  post(env, file, { res: { type: 'file_unchanged', file: { filePath: file } } });
  assert.ok(ctx(pre(env, file)));
  const sub = run(env, { hook_event_name: 'PreToolUse', agent_id: 'sub1', tool_name: 'Read', tool_input: { file_path: file } });
  assert.equal(sub, ''); // the subagent has not read it
});

test('compact or clear resets the reads of the session', () => {
  const { env, file } = setup();
  post(env, file);
  assert.ok(ctx(pre(env, file)));
  run(env, { hook_event_name: 'SessionStart', source: 'compact' });
  assert.equal(pre(env, file), '');
});

test('big output on Bash, Read and Grep: nudge over the threshold, none at it', () => {
  const { env, home, file } = setup();
  const bash = (n) =>
    run(env, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: { stdout: 'a'.repeat(n), stderr: '' } });
  assert.equal(bash(BIG_CHARS), '');
  assert.equal(ctx(bash(40_000)), 'That output was large (~40k chars): next time pipe through tail/grep or read a range.');
  const grep = run(env, { hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' }, tool_response: { mode: 'content', content: 'b'.repeat(20_000), numLines: 400 } });
  assert.match(ctx(grep), /~20k chars/);
  const big = { type: 'text', file: { filePath: file, content: 'c'.repeat(16_000), numLines: 300, startLine: 1, totalLines: 300 } };
  assert.match(ctx(post(env, file, { res: big })), /~16k chars/);
  const other = run(env, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: {}, tool_response: { content: 'd'.repeat(50_000) } });
  assert.equal(other, '');
  const img = post(env, join(home, 'shot.png'), { res: { type: 'image', file: { base64: 'e'.repeat(100_000), type: 'image/png' } } });
  assert.equal(img, ''); // base64 of an image is not "large output"
  assert.deepEqual(leanOf(readLean(home), SID), { rereads: 0, bigOutputs: 3 });
});

test('off switch: lean false says nothing and never writes lean.json', () => {
  const { env, home, file } = setup({ lean: false });
  assert.equal(run(env, { hook_event_name: 'SessionStart', source: 'startup' }), '');
  assert.equal(post(env, file), '');
  assert.equal(pre(env, file), '');
  const bash = run(env, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: { stdout: 'a'.repeat(50_000) } });
  assert.equal(bash, '');
  assert.equal(existsSync(leanFile(home)), false);
});

test('bounded state: old sessions dropped, newest sessions and files kept', () => {
  const sessions = {};
  for (let i = 0; i < MAX_SESSIONS + 10; i++) sessions[`s${i}`] = { at: NOW - i * MIN, rereads: 0, bigOutputs: 0, reads: {} };
  sessions.old = { at: NOW - KEEP_MS - 1, reads: {} };
  const reads = {};
  for (let i = 0; i < MAX_FILES + 20; i++) reads[`/f/${i}`] = { size: 1, mtimeMs: 1, full: true, at: NOW - i };
  sessions.s0.reads = reads;
  const st = prune({ sessions }, NOW);
  assert.equal(Object.keys(st.sessions).length, MAX_SESSIONS);
  assert.ok(!('old' in st.sessions) && !(`s${MAX_SESSIONS}` in st.sessions));
  assert.equal(Object.keys(st.sessions.s0.reads).length, MAX_FILES);
  assert.ok('/f/0' in st.sessions.s0.reads && !(`/f/${MAX_FILES}` in st.sessions.s0.reads));
});

test('bad input is ignored: odd session ids, relative paths', () => {
  const { env, home } = setup();
  assert.equal(runLean(JSON.stringify({ session_id: '__proto__', hook_event_name: 'SessionStart' }), env, { now: NOW }), '');
  assert.equal(post(env, 'notes.txt'), '');
  assert.equal(existsSync(leanFile(home)), false);
});

test('kadans hook lean via the CLI (fails open, prints the brief)', () => {
  const { home } = setup();
  const env = { ...process.env, KADANS_HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude') };
  const ok = spawnSync(process.execPath, [BIN, 'hook', 'lean'], { input: JSON.stringify({ session_id: SID, hook_event_name: 'SessionStart', source: 'startup' }), env, encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(ctx(ok.stdout.trim()), briefText(progressProgram(env.PATH)));
  const bad = spawnSync(process.execPath, [BIN, 'hook', 'lean'], { input: 'not json', env, encoding: 'utf8' });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
});

test('config: lean on by default; `config set lean false` turns every nudge off, true turns them back on', () => {
  const { env, home, file } = setup();
  assert.equal(configView(home, 'k').lean, true);
  setSetting(home, 'lean', 'false', { ownKey: 'k' });
  assert.equal(configView(home, 'k').lean, false);
  assert.equal(run(env, { hook_event_name: 'SessionStart', source: 'startup' }), '');
  assert.equal(post(env, file), '');
  assert.throws(() => setSetting(home, 'lean', 'maybe', { ownKey: 'k' }), /true or false/);
  setSetting(home, 'lean', 'true', { ownKey: 'k' });
  assert.equal(ctx(run(env, { hook_event_name: 'SessionStart', source: 'startup' })), briefText(progressProgram(env.PATH)));
});

test('lean rides on the existing hooks: pace-post adds the big-output note, event adds the SessionStart brief', () => {
  const home = mkdtempSync(join(tmpdir(), 'kadans-lean-cli-'));
  const bin = BIN;
  const env = { ...process.env, KADANS_HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude') };
  const run = (kind, input) => spawnSync(process.execPath, [bin, 'hook', kind], { input: JSON.stringify(input), env, encoding: 'utf8' });
  const sid = '11111111-2222-3333-4444-555555555555';
  const post = run('pace-post', { session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat big' }, tool_response: { stdout: 'x'.repeat(20000) } });
  assert.equal(post.status, 0);
  assert.match(JSON.parse(post.stdout).hookSpecificOutput.additionalContext, /large/i);
  const start = run('event', { session_id: sid, hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(start.status, 0);
  assert.ok(JSON.parse(start.stdout).hookSpecificOutput.additionalContext.length > 20);
  const other = run('event', { session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  assert.equal(other.stdout.trim(), '');
});
