// k51: one inbox for both computers, on Orca orchestration with this Mac as the hub. Kadans keeps one Orca Run (a durable
// namespace and coordinator inbox), starts supervised Claude workers in it on this Mac or on a paired computer, and shows
// what they report back (questions, escalations, worker_done, other messages) next to the Run's tasks.
//
// Orca binds a Run to a coordinator terminal PANE: `run-create` and `worker-start` refuse a caller without one, and so
// does `reply` to a question. Kadans runs from the menu bar app, the phone server or a shell, so (k53) Kadans opens its
// own "Kadans inbox" Orca tab (lib/hub.mjs): the hub inside it binds the Run to that pane and keeps { runId, coordinator }
// here. Every mutation passes `--run <runId> --from <coordinator>`, with Orca's agent-session variables removed from the
// child's environment (so a kadans started inside some Orca chat can never act as that chat), and runs only while the
// hub answers (else one fixed line: ERR.off).
//
// Safety rules (tested in test/inbox.test.mjs):
// - Agent text (subjects, bodies, payloads, task specs) is read into memory only, shown as a preview of at most
//   PREVIEW_MAX characters through stripControl, and never written to a file, cache or log. inbox.json holds ids only.
// - Nothing read from the inbox ever triggers an action: readInbox makes read-only calls (inbox, task-list, environment
//   list) whatever the messages say; only startTask / replyTo / sendFollowUp act, and only when the owner calls them.
// - Kadans never runs `orchestration check` (its default consumes another pane's mail) and never retries a start.
// - Machines come only from the paired computers (`orca environment list`), never from `orca host list`; a name that looks
//   like production is refused.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ensureHome, writeAtomic } from './store.mjs';
import { messageText, stripControl } from './text.mjs';
import { parseEnvs, remoteCaller } from './remote.mjs';
import { hubStatus } from './hub.mjs';

export const INBOX_FILE = 'inbox.json';
export const PREVIEW_MAX = 280;
export const TITLE_MAX = 80;
export const INBOX_LIMIT = 200; // `inbox` lists the newest rows of EVERY Run: room so other Runs do not push ours out
export const READ_TIMEOUT_MS = 8000;
export const ACT_TIMEOUT_MS = 30_000; // reply, send
export const START_TIMEOUT_MS = 150_000; // worker-start: new worktree, setup, maybe a network hop
export const RUN_OBJECTIVE = 'Kadans inbox: tasks the owner starts from Kadans on this Mac and paired computers';
export const LOCAL = 'local';
export const LOCAL_NAME = 'This Mac';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Fixed sentences (the CLI prints them after "kadans: "). Nothing from orca, a message or the owner's text goes in.
export const ERR = {
  noOrca: 'orca not found (install Orca, or set KADANS_ORCA_BIN)',
  off: 'The inbox is off. Tap Set up.',
  setupWhere: 'the inbox hub runs only inside its own Orca tab (tap Set up in Kadans, or run `kadans inbox setup`)',
  setup: 'Orca did not create the Kadans Run (the terminal must be a live Orca terminal)',
  read: 'could not read the inbox from Orca',
  machine: 'refused: that is not this Mac or a paired computer',
  prod: 'refused: Kadans never starts work on a production host',
  machines: 'could not read the paired computers from orca',
  repos: 'could not read the repos of that computer',
  repo: 'refused: that repo is not in the repo list of that computer',
  text: 'refused: the text comes on stdin only: 1 to 4000 printable characters, not starting with -, !, / or #',
  model: 'refused: model is a short provider id and effort one of low, medium, high, xhigh, max (effort needs a model)',
  confirm: 'refused: starting a task needs the confirm step',
  start: 'Orca did not confirm the start (nothing is retried): check `kadans inbox` before starting it again',
  msg: 'refused: no open question or escalation with that id in the Kadans inbox',
  dispatch: 'refused: no task of the Kadans inbox has that dispatch id',
  reply: 'not sent: Orca did not take the reply',
  send: 'not sent: Orca did not take the message',
};

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/; // orca ids and handles: never a flag, a colon or a path
const validId = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : null);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/;
const PROD_RE = /(^|[-_. ])prod(uction)?($|[-_. ])/i; // web-prod, prod.db, Production; not ProDesk or product-pc
const KINDS = { question: 'question', escalation: 'escalation', worker_done: 'done' };
const SKIP_TYPES = new Set(['heartbeat']);
const TASK_STATUS = new Set(['pending', 'ready', 'blocked', 'dispatched', 'running', 'completed', 'failed', 'cancelled', 'canceled']);

// ---------- state: $KADANS_HOME/inbox.json (0600, ids and times only) ----------

const fileOf = (home) => join(home, INBOX_FILE);

export function readInboxState(home) {
  let s;
  try {
    s = JSON.parse(readFileSync(fileOf(home), 'utf8'));
  } catch {
    s = null;
  }
  const tasks = {};
  for (const [d, t] of Object.entries(s?.tasks ?? {})) {
    if (validId(d) && t && typeof t === 'object') tasks[d] = { taskId: validId(t.taskId), machine: t.machine === LOCAL ? LOCAL : validId(t.machine), at: Number.isFinite(t.at) ? t.at : null };
  }
  return { runId: validId(s?.runId), coordinator: validId(s?.coordinator), tasks };
}

function writeInboxState(home, state) {
  ensureHome(home);
  const out = { runId: state.runId ?? null, coordinator: state.coordinator ?? null, tasks: {} };
  for (const [d, t] of Object.entries(state.tasks ?? {})) out.tasks[d] = { taskId: t.taskId ?? null, machine: t.machine ?? null, at: t.at ?? null };
  writeAtomic(fileOf(home), `${JSON.stringify(out, null, 2)}\n`);
}

// ---------- orca ----------

// The orca caller for the inbox: every ORCA_* variable is removed (the terminal handle, pane key, launch token, agent
// session and host stamp are what Orca reads as the caller's identity and attestation), so the child never speaks as the
// terminal or chat that happens to run kadans; every mutation names the Kadans coordinator with --from instead. orca
// needs none of them to reach the app (the menu bar app runs it without any; checked read-only with run-list).
export function inboxCaller(env = process.env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('ORCA_')));
  return remoteCaller(clean, { childEnv: clean });
}

const parse = (r) => {
  if (!r?.ok) return null;
  try {
    const j = JSON.parse(r.text);
    return j && j.ok !== false ? j.result ?? null : null;
  } catch {
    return null;
  }
};

// ---------- setup: bind the one Kadans Run (owner action, inside an Orca terminal) ----------

// handle: ORCA_TERMINAL_HANDLE of the terminal running setup. -> { ok, runId, created } | { ok: false, why }.
// An existing Run that Orca still lists is reused (created once); only when there is none is one created.
export async function setupInbox(home, { call, handle, inAgent = false } = {}) {
  const h = validId(handle);
  if (!h || inAgent) return { ok: false, why: ERR.setupWhere };
  if (!call) return { ok: false, why: ERR.noOrca };
  const state = readInboxState(home);
  if (state.runId) {
    const runs = parse(await call(['orchestration', 'run-list', '--json', '--limit', '500'], READ_TIMEOUT_MS))?.runs;
    if (!Array.isArray(runs)) return { ok: false, why: ERR.read };
    if (runs.some((r) => r?.id === state.runId && !r.legacy)) {
      if (state.coordinator === h) return { ok: true, runId: state.runId, created: false };
      // another terminal (or the same one under a new handle after an Orca restart): bind the SAME Run to it
      const used = parse(await call(['orchestration', 'run-use', '--id', state.runId, '--from', h, '--json'], ACT_TIMEOUT_MS));
      if (!used) return { ok: false, why: ERR.setup };
      writeInboxState(home, { ...state, coordinator: h });
      return { ok: true, runId: state.runId, created: false };
    }
  }
  const run = parse(await call(['orchestration', 'run-create', '--objective', RUN_OBJECTIVE, '--from', h, '--json'], ACT_TIMEOUT_MS))?.run;
  const runId = validId(run?.id);
  if (!runId) return { ok: false, why: ERR.setup };
  writeInboxState(home, { runId, coordinator: h, tasks: {} });
  return { ok: true, runId, created: true };
}

// ---------- machines and repos ----------

// -> { ok, list: [{ id, name }] } with this Mac first, then the paired computers; prod-looking ones are left out.
export async function listMachines({ call } = {}) {
  if (!call) return { ok: false, why: ERR.noOrca };
  let envs;
  try {
    envs = parseEnvs((await call(['environment', 'list', '--json'], READ_TIMEOUT_MS)).text);
  } catch {
    return { ok: false, why: ERR.machines };
  }
  return { ok: true, list: [{ id: LOCAL, name: LOCAL_NAME }, ...envs.filter((e) => !PROD_RE.test(e.name) && !PROD_RE.test(e.id))] };
}

// machine: 'local' or a paired computer's id (or its exact, unique name). -> { ok, env: null | envId, name } | { ok: false, why }.
export async function resolveMachine(machine, { call } = {}) {
  if (machine === LOCAL) return { ok: true, env: null, id: LOCAL, name: LOCAL_NAME };
  if (typeof machine !== 'string' || !machine || machine.length > 100 || machine.startsWith('-')) return { ok: false, why: ERR.machine };
  if (!call) return { ok: false, why: ERR.noOrca };
  let envs;
  try {
    envs = parseEnvs((await call(['environment', 'list', '--json'], READ_TIMEOUT_MS)).text);
  } catch {
    return { ok: false, why: ERR.machines };
  }
  let hit = envs.filter((e) => e.id === machine);
  if (!hit.length) hit = envs.filter((e) => e.name === machine);
  if (hit.length !== 1 || !validId(hit[0].id)) return { ok: false, why: ERR.machine };
  if (PROD_RE.test(hit[0].name) || PROD_RE.test(hit[0].id)) return { ok: false, why: ERR.prod };
  return { ok: true, env: hit[0].id, id: hit[0].id, name: hit[0].name };
}

// One machine's repos (git repos only: a new top-level worktree needs one) -> { ok, list: [{ id, name }] }. Never a path.
export async function listRepos(machine, { call } = {}) {
  if (!call) return { ok: false, why: ERR.noOrca };
  const m = await resolveMachine(machine, { call });
  if (!m.ok) return m;
  const args = m.env ? ['repo', 'list', '--environment', m.env, '--json'] : ['repo', 'list', '--json'];
  const repos = parse(await call(args, READ_TIMEOUT_MS))?.repos;
  if (!Array.isArray(repos)) return { ok: false, why: ERR.repos };
  const list = repos.filter((r) => validId(r?.id) && (r.kind ?? 'git') === 'git')
    .map((r) => ({ id: r.id, name: clip(r.displayName ?? r.name ?? r.id, 60) }));
  return { ok: true, machine: m.id, list };
}

// ---------- reading the inbox (read-only calls only) ----------

const clip = (s, n) => {
  const t = stripControl(s).replace(/\s+/gu, ' ').trim();
  const cps = Array.from(t);
  return cps.length > n ? `${cps.slice(0, n - 1).join('')}…` : t;
};
const payloadOf = (p) => {
  if (typeof p !== 'string' || p.length > 100_000) return {};
  try {
    const j = JSON.parse(p);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
};
const atOf = (v) => {
  const t = Date.parse(typeof v === 'string' ? v : '');
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

// Pure: the raw `inbox --json` and `task-list --run --json` answers -> the items, newest first. Exported for tests.
export function mapInbox({ runId, messages, tasks, state, names, ready }) {
  const taskById = new Map();
  const taskByHandle = new Map();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!validId(t?.id)) continue;
    taskById.set(t.id, t);
    if (validId(t.assignee_handle)) taskByHandle.set(t.assignee_handle, t);
  }
  const dispatchOfTask = new Map();
  for (const [d, s] of Object.entries(state.tasks)) if (s.taskId) dispatchOfTask.set(s.taskId, d);
  const machineOf = (dispatchId) => {
    const m = dispatchId ? state.tasks[dispatchId]?.machine ?? null : null;
    return { machine: m, machineName: m === LOCAL ? LOCAL_NAME : m ? names.get(m) ?? 'a paired computer' : null };
  };
  const titleOf = (t) => (t ? clip(t.task_title || t.display_name || 'Task', TITLE_MAX) : null);

  const rows = (Array.isArray(messages) ? messages : []).filter((m) => m && m.run_id === runId && validId(m.id) && !SKIP_TYPES.has(m.type));
  const answered = new Set(rows.map((m) => m.thread_id).filter(Boolean));
  const items = [];
  for (const m of rows) {
    if (m.to_handle !== `run:${runId}`) {
      // our own replies and follow-ups (to dispatch:<id>) only mark the thread answered; they are not inbox items
      continue;
    }
    const p = payloadOf(m.payload);
    let task = validId(p.taskId) ? taskById.get(p.taskId) : undefined;
    if (!task && validId(m.from_handle)) task = taskByHandle.get(m.from_handle);
    const dispatchId = validId(p.dispatchId) ?? (task ? validId(task.dispatch_id) ?? dispatchOfTask.get(task.id) ?? null : null);
    const kind = KINDS[m.type] ?? 'message';
    let status;
    if (kind === 'done') status = p.outcome === 'failed' ? 'failed' : p.outcome === 'succeeded' ? 'succeeded' : 'done';
    else if (kind === 'question' || kind === 'escalation') status = answered.has(m.id) ? 'answered' : 'open';
    else status = m.read ? 'read' : 'new';
    const preview = clip([m.subject, m.body].filter((x) => typeof x === 'string' && x).join(' — '), PREVIEW_MAX);
    items.push({
      id: m.id,
      kind,
      ...machineOf(dispatchId),
      title: titleOf(task) ?? { question: 'Question', escalation: 'Escalation', done: 'Done', message: 'Message' }[kind],
      preview,
      at: atOf(m.created_at),
      status,
      canReply: Boolean(ready) && (kind === 'question' || kind === 'escalation') && status === 'open',
      dispatchId,
    });
  }
  for (const t of taskById.values()) {
    if (t.run_id && t.run_id !== runId) continue;
    const dispatchId = validId(t.dispatch_id) ?? dispatchOfTask.get(t.id) ?? null;
    items.push({
      id: t.id,
      kind: 'task',
      ...machineOf(dispatchId),
      title: titleOf(t),
      preview: '',
      at: atOf(t.created_at),
      status: TASK_STATUS.has(t.status) ? t.status : 'unknown',
      canReply: false,
      dispatchId,
    });
  }
  items.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  return items;
}

// -> { ok: true, ready, hub, machines, items } | { ok: false, why }. hub: 'on' when the hub answers on its socket; ready:
// the hub answers and the Kadans Run is bound to its tab. No Run kept yet: items empty, nothing called.
// hub: the hub probe (tests inject one; default asks $KADANS_HOME/hub.sock).
export async function readInbox(home, { call, hub = hubStatus } = {}) {
  const state = readInboxState(home);
  const h = await hub(home);
  const hubOn = h.on ? 'on' : 'off';
  if (!state.runId) return { ok: true, ready: false, hub: hubOn, machines: [{ id: LOCAL, name: LOCAL_NAME }], items: [] };
  if (!call) return { ok: false, why: ERR.noOrca };
  const [ib, tl, ms] = await Promise.all([
    call(['orchestration', 'inbox', '--json', '--limit', String(INBOX_LIMIT)], READ_TIMEOUT_MS),
    call(['orchestration', 'task-list', '--run', state.runId, '--json'], READ_TIMEOUT_MS),
    listMachines({ call }),
  ]);
  const messages = parse(ib)?.messages;
  const tasks = parse(tl)?.tasks;
  if (!Array.isArray(messages) || !Array.isArray(tasks)) return { ok: false, why: ERR.read };
  const machines = ms.ok ? ms.list : [{ id: LOCAL, name: LOCAL_NAME }];
  const names = new Map(machines.map((m) => [m.id, m.name]));
  const ready = Boolean(h.on && h.bound && state.coordinator);
  return { ok: true, ready, hub: hubOn, machines, items: mapInbox({ runId: state.runId, messages, tasks, state, names, ready }) };
}

// ---------- owner actions ----------

// The state to act with, only while the hub answers and the Run is bound to its tab; else null (ERR.off).
async function readyState(home, hub = hubStatus) {
  const h = await hub(home);
  if (!h.on || !h.bound) return null;
  const s = readInboxState(home);
  return s.runId && s.coordinator ? s : null;
}

// A short worktree name: kadans-<first words of the text, a-z0-9>-<4 hex>.
export function slugName(text, rand = () => randomBytes(2).toString('hex')) {
  const words = String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
  let slug = '';
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > 24) break;
    slug = next;
  }
  return `kadans-${slug || 'task'}-${rand()}`;
}

// The exact worker-start argv (pure; exported for tests). The text is the spec: it sits in orca's argv for the call.
export function startArgs({ runId, coordinator, env, repoId, text, name, model, effort }) {
  const firstLine = text.split('\n').find((l) => l.trim()) ?? 'Task';
  const args = ['orchestration', 'worker-start', '--spec', text, '--task-title', clip(firstLine, 60)];
  if (env) args.push('--on', env);
  args.push('--worktree', 'new-top-level', '--repo', `id:${repoId}`, '--name', name, '--agent', 'claude');
  if (model) args.push('--model', model);
  if (model && effort) args.push('--effort', effort);
  args.push('--run', runId, '--from', coordinator, '--json');
  return args;
}

// Starts one supervised Claude worker. req: { machine, repo, text, model?, effort?, confirmed }. -> { ok, dispatchId,
// taskId, machine } | { ok: false, why }. Never retried: a failed or unknown start is reported, the owner decides.
export async function startTask(home, req, { call, now = Date.now(), rand, hub } = {}) {
  if (req?.confirmed !== true) return { ok: false, why: ERR.confirm };
  const text = messageText(req.text);
  if (text === null) return { ok: false, why: ERR.text };
  const model = req.model == null ? null : MODEL_RE.test(String(req.model)) ? String(req.model) : undefined;
  const effort = req.effort == null ? null : EFFORTS.includes(req.effort) ? req.effort : undefined;
  if (model === undefined || effort === undefined || (effort && !model)) return { ok: false, why: ERR.model };
  const state = await readyState(home, hub);
  if (!state) return { ok: false, why: ERR.off };
  if (!call) return { ok: false, why: ERR.noOrca };
  const m = await resolveMachine(req.machine, { call });
  if (!m.ok) return m;
  const repos = await listRepos(m.id, { call });
  if (!repos.ok) return repos;
  const want = typeof req.repo === 'string' ? req.repo.replace(/^id:/, '') : '';
  const repo = repos.list.find((r) => r.id === want);
  if (!repo) return { ok: false, why: ERR.repo };
  const args = startArgs({ runId: state.runId, coordinator: state.coordinator, env: m.env, repoId: repo.id, text, name: slugName(text, rand), model, effort });
  const res = parse(await call(args, START_TIMEOUT_MS));
  const dispatchId = validId(res?.dispatchId);
  if (!dispatchId || (res.state && res.state !== 'ready')) return { ok: false, why: ERR.start };
  const fresh = readInboxState(home);
  fresh.tasks[dispatchId] = { taskId: validId(res.taskId), machine: m.id, at: now };
  writeInboxState(home, fresh);
  return { ok: true, dispatchId, taskId: validId(res.taskId), machine: m.id };
}

// Answers an open question or escalation of the Kadans Run (the id must be in a fresh read of the inbox).
export async function replyTo(home, id, rawText, { call, hub } = {}) {
  const text = messageText(rawText);
  if (text === null) return { ok: false, why: ERR.text };
  const msgId = validId(id);
  const state = await readyState(home, hub);
  if (!state) return { ok: false, why: ERR.off };
  if (!msgId) return { ok: false, why: ERR.msg };
  const box = await readInbox(home, { call, hub });
  if (!box.ok) return box;
  if (!box.items.some((i) => i.id === msgId && i.canReply)) return { ok: false, why: ERR.msg };
  const r = parse(await call(['orchestration', 'reply', '--id', msgId, '--body', text, '--run', state.runId, '--from', state.coordinator, '--json'], ACT_TIMEOUT_MS));
  return r ? { ok: true, id: msgId } : { ok: false, why: ERR.reply };
}

// A follow-up to one of the Kadans Run's dispatches (Orca relays it to a worker on another computer).
export async function sendFollowUp(home, dispatchId, rawText, { call, hub } = {}) {
  const text = messageText(rawText);
  if (text === null) return { ok: false, why: ERR.text };
  const d = validId(dispatchId);
  const state = await readyState(home, hub);
  if (!state) return { ok: false, why: ERR.off };
  if (!d) return { ok: false, why: ERR.dispatch };
  if (!call) return { ok: false, why: ERR.noOrca };
  const tasks = parse(await call(['orchestration', 'task-list', '--run', state.runId, '--json'], READ_TIMEOUT_MS))?.tasks;
  if (!Array.isArray(tasks)) return { ok: false, why: ERR.read };
  if (!state.tasks[d] && !tasks.some((t) => t?.dispatch_id === d)) return { ok: false, why: ERR.dispatch };
  const r = parse(await call(['orchestration', 'send', '--to', `dispatch:${d}`, '--subject', 'Follow-up from the owner', '--body', text, '--run', state.runId, '--from', state.coordinator, '--json'], ACT_TIMEOUT_MS));
  return r ? { ok: true, dispatchId: d } : { ok: false, why: ERR.send };
}
