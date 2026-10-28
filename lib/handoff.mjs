// k54: "Continue on kasa". Kadans asks a local Claude Code chat to write a one-page handoff note, commit it and push its
// branch, checks with read-only git that the note really is on origin, then starts a task on a paired computer (k51
// task-new) whose prompt only points at that note. The other computer starts from a one-page brief, not the whole chat,
// so the context is not paid for twice.
//
// Safety rules (tested in test/handoff.test.mjs):
// - What Kadans types into the chat is ONE fixed English instruction (HANDOFF_INSTRUCTION): no owner text, no agent text.
//   It goes through the k48/k49 send path (sendAgent: idle, or working with an empty input box; a dialog, a draft or an
//   unknown screen is refused). Only chats on this Mac: a remote row is refused.
// - Kadans itself never runs `git push` (nor fetch, commit or anything else that writes): the push happens inside the
//   owner's chat, under that chat's own permission rules. Kadans' git is read-only: rev-parse, cat-file -e, log,
//   symbolic-ref, remote get-url, check-ref-format and ls-remote, with optional locks off and no terminal prompt.
// - Ready cannot be faked by text: the local branch must exist, hold the note (`cat-file -e`), and origin must report the
//   same commit for refs/heads/<branch> (`ls-remote`). The branch and path come from the chat's newest
//   "HANDOFF <branch> <path>" line (read in memory from the transcript tail, assistant messages after the ask only) or the
//   newest commit under docs/handoff/ (after the ask), and must pass strict validation first.
// - Nothing of the note or the chat is kept: handoff.json holds agent ids and ask times only; branch and path are worked out
//   again on every status call. Git's stderr and the origin URL (it may carry a token) are never shown or kept.
// - The task text on the other computer is built here from the validated branch and path only (at most TASK_MAX
//   characters); a client never supplies it.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ensureHome, writeAtomic } from './store.mjs';
import { messageText } from './text.mjs';
import { guessTranscript, projectName, sendAgent } from './agents.mjs';
import { ERR as INBOX_ERR, LOCAL, READ_TIMEOUT_MS, listMachines, resolveMachine, startTask } from './inbox.mjs';

export const HANDOFF_FILE = 'handoff.json';
export const LATE_MS = 15 * 60_000; // no ready handoff this long after the ask: "No handoff yet. Check the chat."
export const KEEP_MS = 24 * 3600_000; // asks older than this are dropped from handoff.json
export const TASK_MAX = 400;
export const COMMIT_SLACK_MS = 5000; // the note's commit may carry a time a little before the ask was recorded
export const GIT_TIMEOUT_MS = 8000;
export const LS_REMOTE_TIMEOUT_MS = 20_000; // the one network call (read-only)

// The one instruction Kadans types into the chat. Fixed text: nothing from the owner, the chat or the agent goes in.
// One line (no newline: Enter would send half of it).
export const HANDOFF_INSTRUCTION = 'Kadans handoff: write a handoff note for another agent that continues this work on another computer. '
  + 'Save it as docs/handoff/<yyyy-mm-dd>-<slug>.md (today\'s date; slug: 2 to 5 lowercase words joined by "-", only a-z and 0-9). '
  + 'At most one page, with: goal, what is done, next steps in order, key files, test commands, gotchas. '
  + 'No secrets, tokens, passwords or .env values, and no pasted chat. '
  + 'If the current branch is main or master, first create and switch to a new branch handoff/<slug>. '
  + 'Commit the note on the current branch (with any finished work the next agent needs, never secrets or .env files), then push that branch to origin. '
  + 'When it is pushed, answer with exactly one line: HANDOFF <branch> <note path>';

// Fixed sentences (the CLI prints them after "kadans: "). Nothing from git, the chat or the note goes in.
export const ERR = {
  remote: 'refused: a handoff starts from a chat on this Mac',
  agent: 'refused: that is not a chat Kadans knows on this Mac',
  git: 'refused: that chat\'s folder is not a git repo with an origin remote',
  notReady: 'refused: that chat has no pushed handoff note yet',
  confirm: INBOX_ERR.confirm,
  local: 'refused: continue on a paired computer, not on this Mac',
  bad: 'refused: the branch or note path is not accepted',
  none: 'refused: no paired computer to continue on',
};

// ---------- validation ----------

const BRANCH_RE = /^[A-Za-z0-9._/-]{1,100}$/;
const PATH_RE = /^docs\/handoff\/[A-Za-z0-9._-]{1,80}\.md$/;
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

// A branch name Kadans will hand to git: the strict pattern plus git's own ref rules that the pattern lets through.
// `git check-ref-format --branch` runs too (checkReady) as a second opinion.
export function validBranch(b) {
  if (typeof b !== 'string' || !BRANCH_RE.test(b)) return null;
  if (b.startsWith('-') || b.startsWith('/') || b.endsWith('/') || b.endsWith('.') || b.includes('..') || b.includes('//')) return null;
  if (/(^|\/)\./.test(b) || /\.lock(\/|$)/.test(b) || b === 'HEAD') return null;
  return b;
}

export function validNotePath(p) {
  if (typeof p !== 'string' || !PATH_RE.test(p) || p.includes('..')) return null;
  const name = p.slice('docs/handoff/'.length);
  return name.startsWith('.') || name.startsWith('-') ? null : p;
}

// The task for the other computer, from the validated parts only. null when either part is refused or it would not fit.
export function taskText(branch, path) {
  const b = validBranch(branch);
  const p = validNotePath(path);
  if (!b || !p) return null;
  const t = `Continue the work in ${p} on branch ${b}. First run \`git fetch origin\` and switch this worktree to that branch. `
    + 'Read the note, then continue with its next steps in order. Commit often. Do not push unless asked.';
  return t.length <= TASK_MAX && messageText(t) === t ? t : null;
}

// ---------- read-only git ----------

// (cwd, args, timeout) -> { ok, out }. stderr is dropped (it can repeat a remote URL with a token). No prompt, no
// optional locks (so no index refresh writes), stdin closed; the GIT_* variables that would point git elsewhere are
// removed. Only the read-only verbs in READ_VERBS run.
const READ_VERBS = new Set(['rev-parse', 'cat-file', 'ls-remote', 'log', 'symbolic-ref', 'check-ref-format', 'remote']);
const GIT_AWAY = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_COMMON_DIR', 'GIT_PREFIX'];
export function gitRunner(env = process.env) {
  const childEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !GIT_AWAY.includes(k)));
  Object.assign(childEnv, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GCM_INTERACTIVE: 'never' });
  return (cwd, args, timeout = GIT_TIMEOUT_MS) => {
    if (!READ_VERBS.has(args[0]) || (args[0] === 'remote' && args[1] !== 'get-url')) return { ok: false, out: '' };
    const r = spawnSync('git', ['-C', cwd, ...args], { env: childEnv, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 });
    return { ok: r.status === 0 && !r.error, out: r.stdout ?? '' };
  };
}

// The repo has an origin remote (the ask is refused before anything is typed otherwise).
export function hasOrigin(cwd, { git }) {
  if (!cwd || !git(cwd, ['rev-parse', '--is-inside-work-tree']).ok) return false;
  return git(cwd, ['remote', 'get-url', 'origin']).ok;
}

// Ready = the local branch exists, holds the note, and origin reports the same commit for refs/heads/<branch>.
// -> { ready: true, sha } | { ready: false, why: 'bad' | 'branch' | 'note' | 'push' }.
export function checkReady(cwd, cand, { git }) {
  const b = validBranch(cand?.branch);
  const p = validNotePath(cand?.path);
  if (!cwd || !b || !p || !git(cwd, ['check-ref-format', '--branch', b]).ok) return { ready: false, why: 'bad' };
  const local = git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}^{commit}`]);
  const sha = local.ok ? local.out.trim() : '';
  if (!SHA_RE.test(sha)) return { ready: false, why: 'branch' };
  if (!git(cwd, ['cat-file', '-e', `${sha}:${p}`]).ok) return { ready: false, why: 'note' };
  const remote = git(cwd, ['ls-remote', 'origin', `refs/heads/${b}`], LS_REMOTE_TIMEOUT_MS);
  if (!remote.ok) return { ready: false, why: 'push' };
  // ls-remote patterns match the tail of a ref name: keep only the exact ref, and it must be the only one.
  const hits = remote.out.split('\n').map((l) => l.split('\t')).filter((x) => x.length === 2 && x[1].trim() === `refs/heads/${b}`);
  if (hits.length !== 1 || hits[0][0].trim() !== sha) return { ready: false, why: 'push' };
  return { ready: true, sha };
}

// ---------- where the candidate comes from ----------

// "HANDOFF <branch> <path>" as its own line (one pair of backticks around it is fine). Validation happens after.
const LINE_RE = /^(`?)HANDOFF ([A-Za-z0-9._/-]{1,100}) (docs\/handoff\/[A-Za-z0-9._-]{1,80}\.md)\1$/;
export function handoffLine(text) {
  let hit = null;
  for (const raw of String(text ?? '').split('\n')) {
    const m = LINE_RE.exec(raw.trim());
    if (m && validBranch(m[2]) && validNotePath(m[3])) hit = { branch: m[2], path: m[3] };
  }
  return hit;
}

// The chat's newest HANDOFF line in an assistant message written at or after `since` (ms; null: any), from the last
// tailBytes of the transcript. Read in memory; only { branch, path } leaves this function.
export function transcriptCandidate(file, since = null, tailBytes = 512 * 1024) {
  if (!file) return null;
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = statSync(file).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('HANDOFF') || !line.includes('"assistant"')) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue; // the partial first line of the tail
      }
      if (d?.type !== 'assistant' || d.message?.role !== 'assistant') continue;
      const at = Date.parse(d.timestamp ?? '');
      if (since !== null && !(at >= since)) continue;
      const c = d.message.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join('\n') : '';
      const hit = handoffLine(text);
      if (hit) return hit;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}

// The session's transcript: where Claude Code keeps it for the chat's folder, else any project folder holding <id>.jsonl.
export function findTranscript(claudeDirs, cwd, sid) {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(String(sid ?? ''))) return null;
  const guess = guessTranscript(claudeDirs, cwd, sid);
  if (guess) return guess;
  for (const d of claudeDirs) {
    let dirs = [];
    try {
      dirs = readdirSync(join(d, 'projects'));
    } catch {
      continue;
    }
    for (const p of dirs) {
      const f = join(d, 'projects', p, `${sid}.jsonl`);
      if (existsSync(f)) return f;
    }
  }
  return null;
}

// The current branch's newest commit that adds or changes a note under docs/handoff/, made at or after `since`.
export function commitCandidate(cwd, since = null, { git }) {
  const head = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = head.ok ? validBranch(head.out.trim()) : null;
  if (!branch) return null;
  const log = git(cwd, ['log', '-1', '--format=%ct', '--name-only', '--diff-filter=AM', `refs/heads/${branch}`, '--', 'docs/handoff/']);
  if (!log.ok) return null;
  const [first, ...rest] = log.out.split('\n').map((l) => l.trim()).filter(Boolean);
  const at = Number(first) * 1000;
  if (!Number.isFinite(at) || (since !== null && at < since - COMMIT_SLACK_MS)) return null;
  const path = rest.map(validNotePath).find(Boolean);
  return path ? { branch, path } : null;
}

// ---------- asks: $KADANS_HOME/handoff.json (0600, agent ids and times only) ----------

export function readAsks(home) {
  try {
    const j = JSON.parse(readFileSync(join(home, HANDOFF_FILE), 'utf8'));
    const asks = j && typeof j.asks === 'object' && j.asks ? j.asks : {};
    return Object.fromEntries(Object.entries(asks).filter(([k, v]) => AGENT_RE.test(k) && Number.isFinite(v)));
  } catch {
    return {};
  }
}
function writeAsks(home, asks, now) {
  ensureHome(home);
  const keep = Object.fromEntries(Object.entries(asks).filter(([, t]) => now - t < KEEP_MS));
  writeAtomic(join(home, HANDOFF_FILE), `${JSON.stringify({ asks: keep })}\n`);
}

// ---------- the three steps ----------

const localChat = (agent) => {
  if (!agent || typeof agent.id !== 'string' || !AGENT_RE.test(agent.id)) return { ok: false, why: ERR.agent };
  if (agent.machine || agent.id.startsWith('remote:')) return { ok: false, why: ERR.remote };
  if (agent.agentType && agent.agentType !== 'claude') return { ok: false, why: ERR.agent };
  return null;
};

// Step 1: types HANDOFF_INSTRUCTION into the chat (k49 send guard) and records when. -> { ok, how } | { ok: false, why }.
export function askHandoff(home, agent, { run = null, git, ps, started, dryRun = false, now = Date.now() } = {}) {
  const bad = localChat(agent);
  if (bad) return bad;
  if (!hasOrigin(agent.cwd, { git })) return { ok: false, why: ERR.git };
  const opts = { run, dryRun };
  if (ps) opts.ps = ps;
  if (started) opts.started = started;
  const r = sendAgent(agent, HANDOFF_INSTRUCTION, opts);
  if (!r.ok) return r;
  if (dryRun) return { ok: true, how: r.how };
  writeAsks(home, { ...readAsks(home), [agent.id]: now }, now);
  return { ok: true, how: 'asked the chat for a handoff note' };
}

// The other computer's git repos with the one that matches this chat's repo (by origin, else by name). The origin URL
// is compared in memory as host/owner/repo and never returned.
export function canonicalRemote(url) {
  let s = String(url ?? '').trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // scheme
  s = s.replace(/^[^@/]*@/, ''); // user / token
  const scp = /^([^/:]+):(?!\d+\/)(.+)$/.exec(s); // git@host:owner/repo
  if (scp) s = `${scp[1]}/${scp[2]}`;
  s = s.replace(/^([^/:]+):\d+\//, '$1/'); // host:port/
  s = s.replace(/\.git\/?$/i, '').replace(/\/+$/, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return parts.join('/').toLowerCase();
}

const parseResult = (r) => {
  if (!r?.ok) return null;
  try {
    const j = JSON.parse(r.text);
    return j && j.ok !== false ? j.result ?? null : null;
  } catch {
    return null;
  }
};

export function matchRepos(repos, { key, names }) {
  const list = (Array.isArray(repos) ? repos : []).filter((r) => r && typeof r.id === 'string' && ID_RE.test(r.id) && (r.kind ?? 'git') === 'git');
  const lower = (v) => String(v ?? '').toLowerCase();
  let hits = key ? list.filter((r) => canonicalRemote(r.gitRemoteIdentity?.canonicalKey) === key) : [];
  if (!hits.length) {
    const want = new Set(names.filter(Boolean).map(lower));
    hits = list.filter((r) => want.has(lower(r.displayName)) || want.has(lower(r.name)) || (typeof r.path === 'string' && want.has(lower(basename(r.path)))));
  }
  const shown = list.map((r) => ({ id: r.id, name: String(r.displayName ?? r.name ?? r.id).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 60) || r.id }));
  return { list: shown, repo: hits.length === 1 ? hits[0].id : null };
}

async function targetsFor(agent, machine, { call, git }) {
  const m = await resolveMachine(machine, { call });
  if (!m.ok) return m;
  if (m.id === LOCAL) return { ok: false, why: ERR.local };
  const repos = parseResult(await call(['repo', 'list', '--environment', m.env, '--json'], READ_TIMEOUT_MS))?.repos;
  if (!Array.isArray(repos)) return { ok: false, why: INBOX_ERR.repos };
  const url = git(agent.cwd, ['remote', 'get-url', 'origin']);
  const key = url.ok ? canonicalRemote(url.out) : null;
  const names = [projectName(agent.cwd), key ? key.split('/').pop() : null];
  const { list, repo } = matchRepos(repos, { key, names });
  return { ok: true, machine: { id: m.id, name: m.name }, repos: list, repo };
}

// Status: { ok, state: 'ready' | 'waiting' | 'late' | 'none', askedAt, branch?, path?, machines?, machine?, repos?, repo? }.
// With `machine` (a paired computer's id) and a ready handoff, that computer's repos and the preselected match.
export async function handoffStatus(home, agent, { git, claudeDirs = [], call = null, machine = null, now = Date.now() } = {}) {
  const bad = localChat(agent);
  if (bad) return bad;
  const askedAt = readAsks(home)[agent.id] ?? null;
  // No ask on record: nothing counts as an answer (an old pushed note must never make a chat ready).
  if (askedAt === null) return { ok: true, state: 'none', askedAt };
  let cand = transcriptCandidate(findTranscript(claudeDirs, agent.cwd, agent.id), askedAt);
  let ready = cand && agent.cwd ? checkReady(agent.cwd, cand, { git }) : null;
  if (!ready?.ready && agent.cwd) {
    const c = commitCandidate(agent.cwd, askedAt, { git });
    if (c && (c.branch !== cand?.branch || c.path !== cand?.path)) {
      cand = c;
      ready = checkReady(agent.cwd, c, { git });
    }
  }
  if (!ready?.ready) {
    const state = askedAt === null ? 'none' : now - askedAt >= LATE_MS ? 'late' : 'waiting';
    return { ok: true, state, askedAt };
  }
  const out = { ok: true, state: 'ready', askedAt, branch: cand.branch, path: cand.path };
  if (!call) return out;
  const ms = await listMachines({ call });
  if (ms.ok) out.machines = ms.list.filter((m) => m.id !== LOCAL);
  if (machine) {
    const t = await targetsFor(agent, machine, { call, git });
    if (!t.ok) return { ...out, why: t.why };
    Object.assign(out, { machine: t.machine, repos: t.repos, repo: t.repo });
  }
  return out;
}

// Step 3: starts the task on the paired computer, with the text built here from a fresh ready check. req: { machine,
// repo, confirmed }. -> startTask's answer.
export async function startHandoff(home, agent, req, { git, claudeDirs = [], call, hub, rand, now = Date.now() } = {}) {
  if (req?.confirmed !== true) return { ok: false, why: ERR.confirm };
  const bad = localChat(agent);
  if (bad) return bad;
  if (req.machine === LOCAL) return { ok: false, why: ERR.local };
  const st = await handoffStatus(home, agent, { git, claudeDirs, now });
  if (!st.ok) return st;
  if (st.state !== 'ready') return { ok: false, why: ERR.notReady };
  const text = taskText(st.branch, st.path);
  if (!text) return { ok: false, why: ERR.bad };
  const r = await startTask(home, { machine: req.machine, repo: req.repo, text, confirmed: true }, { call, hub, rand, now });
  if (r.ok) {
    const asks = readAsks(home);
    delete asks[agent.id];
    writeAsks(home, asks, now);
  }
  return r;
}
