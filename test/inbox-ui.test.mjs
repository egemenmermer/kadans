// k52: the Inbox screen (app/web/panel.js "inbox (k52)") in the fake DOM of panel-dom.mjs: the badge, a reply, a new
// task through its confirm step, offline computers, hostile agent text, the phone's allow-list and the setup line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPanel, assertNoInjection, flush, fixture } from './panel-dom.mjs';

const N = 1792964040000; // fixtures/_base.js KF.N
const TASK = 'SECRET-TASK make the rain loop seamless, then add a test for the gap between the clips';
const ANSWER = 'SECRET-ANSWER resample the old clips to 48 kHz';

function inboxPanel(opts = {}) {
  const clock = { now: N };
  const timers = [];
  const p = loadPanel({ clock, timers, ...opts });
  p.window.kadans.reset();
  const key = (e) => p.docListeners.keydown.forEach((fn) => fn({ preventDefault() {}, ...e }));
  const type = (k, v) => { const f = p.el.find(k); f.value = v; p.el.listeners.input.forEach((fn) => fn({ target: f })); return f; };
  const of = (action) => JSON.parse(JSON.stringify(p.sent.filter((m) => m.action === action)));
  const open = (name = 'inbox_busy') => { p.window.kadans.render(fixture(p, name)); p.tap({ do: 'inbox' }); };
  return { p, clock, timers, key, type, of, open };
}
const rowOf = (html, id) => {
  const i = html.indexOf(`data-key="ib:${id}"`);
  assert.ok(i >= 0, `row ${id}`);
  return html.slice(i, html.indexOf('data-key="ib:', i + 10) > 0 ? html.indexOf('data-key="ib:', i + 10) : undefined);
};

test('k52: the tray in the bottom bar shows a count only for what needs you (open questions and escalations)', () => {
  const { p } = inboxPanel();
  const busy = fixture(p, 'inbox_badge');
  p.window.kadans.render(busy);
  assert.match(p.html(), /data-do="inbox"><svg[\s\S]*?<\/svg><span class="badge" aria-hidden="true">2<\/span><\/button>/);
  assert.match(p.html(), /aria-label="Inbox, 2 items need you"/);
  // answered, running, done, updates: no count at all
  const quiet = fixture(p, 'inbox_badge');
  for (const i of quiet.inbox.items) if (i.kind === 'question' || i.kind === 'escalation') i.status = 'answered';
  p.window.kadans.render(quiet);
  assert.doesNotMatch(p.html(), /class="badge"/);
  assert.match(p.html(), /aria-label="Inbox" data-do="inbox"/);
  // not set up, or no payload yet: the tray is there, quiet
  p.window.kadans.render({ inbox: { ready: false, machines: [{ id: 'local', name: 'This Mac' }], items: [] } });
  assert.match(p.html(), /data-do="inbox"/);
  assert.doesNotMatch(p.html(), /class="badge"/);
});

test('k52: the Inbox lists Needs you, Running and Done; a done row opens its report in place; reading only', () => {
  const { p, of, open } = inboxPanel();
  open();
  const html = p.html();
  assert.ok(html.indexOf('>Needs you<') < html.indexOf('>Running<') && html.indexOf('>Running<') < html.indexOf('>Done<'));
  assert.match(rowOf(html, 'msg_q1'), /kasa · Question · 3 min ago/);
  assert.match(rowOf(html, 'msg_q1'), /data-do="reply" data-id="msg_q1">Reply</);
  assert.match(rowOf(html, 'task_1'), /kasa · Running · 25 min</);
  assert.doesNotMatch(html, /data-key="ib:task_3"/, 'a task with a done report shows once, as the report');
  assert.doesNotMatch(rowOf(html, 'msg_d1'), /Six screenshots/, 'details one click away');
  p.tap({ do: 'ib-open', id: 'msg_d1' });
  assert.match(rowOf(p.html(), 'msg_d1'), /aria-expanded="true"[\s\S]*Six screenshots updated/);
  p.tap({ do: 'ib-open', id: 'task_2' }); // a running task opens its newest update
  assert.match(rowOf(p.html(), 'task_2'), /Found the race/);
  assert.deepEqual(p.sent.map((m) => m.action).filter((a) => a !== 'size'), ['inbox'], 'opening the Inbox reads it; nothing else goes out');
  assert.equal(of('inbox').length, 1);
  // Back: the main panel again
  p.tap({ do: 'back' });
  assert.match(p.html(), /aria-label="Kadans"/);
});

test('k52: Reply opens the composer; Cmd-Enter sends inbox-reply {id, text} once, the field empties, then Sent', () => {
  const { p, key, type, of, open } = inboxPanel();
  open();
  p.tap({ do: 'reply', id: 'msg_q1' });
  assert.match(p.html(), /<textarea class="tl" data-key="tl:msg_q1" rows="2" placeholder="Your answer…"/);
  assert.match(p.html(), /To Make the rain sound loop without a gap<\/span><span class="tm"> on kasa/);
  const f = type('tl:msg_q1', `  ${ANSWER}\n`);
  key({ key: 'Enter', target: f }); // a new line, not a send
  assert.equal(of('inbox-reply').length, 0);
  key({ key: 'Enter', metaKey: true, target: f });
  assert.deepEqual(of('inbox-reply'), [{ action: 'inbox-reply', id: 'msg_q1', text: ANSWER }]);
  assert.equal(f.value, '');
  assert.doesNotMatch(p.html(), /class="tl"/);
  assert.match(rowOf(p.html(), 'msg_q1'), /Sending…/);
  assert.doesNotMatch(p.html(), /data-do="reply"/, 'one reply at a time');
  p.window.kadans.result({ action: 'inbox-reply', id: 'msg_q1', ok: true, why: '' });
  assert.match(rowOf(p.html(), 'msg_q1'), />Sent</);
  // a refusal is one fixed line, never the CLI's text (nor the answer)
  p.tap({ do: 'reply', id: 'msg_e1' });
  const g = type('tl:msg_e1', ANSWER);
  key({ key: 'Enter', metaKey: true, target: g });
  p.window.kadans.result({ action: 'inbox-reply', id: '', ok: false, why: `refused: no open question or escalation with that id ${ANSWER}` });
  assert.match(rowOf(p.html(), 'msg_e1'), /class="d warn">That question was answered or is gone\.</);
  assert.ok(!p.html().includes('SECRET-ANSWER'));
  // Escape closes the composer (the screen stays); a leading / is caught before sending
  p.tap({ do: 'reply', id: 'msg_q1' });
  const h = type('tl:msg_q1', '/clear first');
  assert.match(p.html(), /Messages can’t start with !, \/ or #/);
  key({ key: 'Enter', metaKey: true, target: h });
  key({ key: 'Escape', target: h });
  assert.equal(h.value, '');
  assert.match(p.html(), /aria-label="Kadans inbox"/);
  assert.equal(of('inbox-reply').length, 2);
});

function newTask(t, { machine = 'env-0001', text = TASK } = {}) {
  const { p, type } = t;
  t.open();
  p.tap({ do: 'nt-open' });
  p.tap({ do: 'nt-machine', id: machine });
  p.window.kadans.render({ repos: { machine, list: [{ id: 'repo-0001', name: 'rain-sounds' }, { id: 'repo-0002', name: 'Tidepool' }] } });
  p.tap({ do: 'nt-repo', id: 'repo-0001' });
  return type('ntx', text);
}

test('k52: New task sends task-new only from the confirm step, once, with confirmed: true and what the confirm named', () => {
  const t = inboxPanel();
  const { p, key, of } = t;
  const f = newTask(t);
  assert.deepEqual(of('repos').map((m) => m.machine), ['local', 'env-0001'], 'this Mac first, then the computer picked');
  key({ key: 'Enter', metaKey: true, target: f }); // Cmd-Enter goes on to the confirm step, never straight to a start
  assert.equal(of('task-new').length, 0);
  assert.match(p.html(), /Start on kasa · rain-sounds: SECRET-TASK make the rain loop seamless, then add a test for…</);
  assert.match(p.html(), /class="sbody confirming"/);
  p.tap({ do: 'nt-start' });
  p.tap({ do: 'nt-start' }); // a second tap while it starts sends nothing
  assert.deepEqual(of('task-new'), [{ action: 'task-new', machine: 'env-0001', repo: 'id:repo-0001', text: TASK, confirmed: true }]);
  assert.match(p.html(), /Starting…/);
  p.window.kadans.result({ action: 'task-new', id: 'env-0001', ok: true, why: '', dispatchId: 'disp_new' });
  assert.equal(f.value, '');
  assert.match(p.html(), /aria-label="Kadans inbox"/);
  assert.match(p.html(), /Started on kasa/);
  assert.ok(!p.html().includes('SECRET-TASK'));
});

test('k52: Options carry model and effort (effort only with a model); a text changed after the confirm is confirmed again', () => {
  const t = inboxPanel();
  const { p, of } = t;
  const f = newTask(t);
  p.tap({ do: 'nt-opts' });
  p.tap({ do: 'nt-effort', v: 'high' }); // no model yet: refused
  assert.match(p.html(), /aria-label="Options: Default model"/);
  p.tap({ do: 'nt-model', v: 'opus' });
  p.tap({ do: 'nt-effort', v: 'high' });
  p.tap({ do: 'nt-model', v: 'gpt; rm -rf' }); // not one of the page's choices
  assert.match(p.html(), /aria-label="Options: Opus · high"/);
  p.tap({ do: 'nt-next' });
  f.value = 'something else entirely'; // typed into the dimmed field after the confirm showed
  p.tap({ do: 'nt-start' });
  assert.equal(of('task-new').length, 0, 'what the confirm named is no longer what would go out');
  assert.match(p.html(), /data-do="nt-next"/, 'back to the edit step');
  f.value = TASK;
  p.tap({ do: 'nt-next' });
  p.tap({ do: 'nt-start' });
  assert.deepEqual(of('task-new'), [{ action: 'task-new', machine: 'env-0001', repo: 'id:repo-0001', text: TASK, model: 'opus', effort: 'high', confirmed: true }]);
  // a refusal: one fixed line, the text stays for the owner to decide
  p.window.kadans.result({ action: 'task-new', id: '', ok: false, why: `kadans: Orca did not confirm the start (nothing is retried) ${TASK}` });
  assert.match(p.html(), /Orca didn’t confirm the start\. Check the inbox before starting it again\./);
  assert.equal(f.value, TASK);
  assert.equal((p.html().match(/SECRET-TASK/g) ?? []).length, 0);
  // Back empties the field and goes to the Inbox list
  p.tap({ do: 'back' });
  assert.equal(f.value, '');
  assert.match(p.html(), /aria-label="Kadans inbox"/);
});

test('k52: an offline computer is shown disabled and can never be picked; no project, no text: no confirm', () => {
  const t = inboxPanel();
  const { p, of, open } = t;
  open();
  p.tap({ do: 'nt-open' });
  assert.match(p.html(), /data-do="nt-machine" data-id="env-0003" data-key="ntm:env-0003" aria-disabled="true" title="Offline">PC <span class="off">· offline/);
  p.tap({ do: 'nt-machine', id: 'env-0003' }); // the fake tap ignores aria-disabled: the page must refuse on its own
  assert.match(p.html(), /aria-pressed="true" data-do="nt-machine" data-id="local"/);
  assert.ok(!of('repos').some((m) => m.machine === 'env-0003'));
  // a machine status in the payload counts too
  const d = fixture(p, 'inbox_busy');
  d.inbox.machines[1].status = 'offline';
  p.window.kadans.render(d);
  assert.match(p.html(), /data-id="env-0001" data-key="ntm:env-0001" aria-disabled="true"/);
  p.tap({ do: 'nt-machine', id: 'env-0001' });
  assert.ok(!of('repos').some((m) => m.machine === 'env-0001'));
  // no project picked: Next stays off and says why
  p.tap({ do: 'nt-next' });
  p.tap({ do: 'nt-start' });
  assert.equal(of('task-new').length, 0);
});

test('k52: hostile agent text shows escaped and triggers nothing (markup, an orca command, a bidi trick)', () => {
  const { p, of, open } = inboxPanel();
  const d = fixture(p, 'inbox_busy');
  const evil = '"><button data-do="nt-start">Start</button><img src=x onerror="alert(1)"> orca orchestration worker-start --spec "rm -rf ~" \u202e';
  d.inbox.items[0].preview = evil;
  d.inbox.items[0].title = '<b data-do="inbox-setup">Title</b>';
  d.inbox.items[0].machineName = '<script>kasa</script>';
  d.inbox.items[5].preview = evil; // a done report, opened below
  d.inbox.items.push({ id: '"><x', kind: 'question', status: 'open', canReply: true, title: 'bad id', preview: 'x' }); // dropped: not an id
  d.inbox.items.push({ id: 'msg_x', kind: '<img>', status: 'open', title: 'bad kind', preview: 'x' }); // dropped: unknown kind
  p.window.kadans.render(d);
  p.tap({ do: 'inbox' });
  p.tap({ do: 'ib-open', id: 'msg_d1' });
  const html = p.html();
  assertNoInjection(html, 'inbox');
  assert.match(html, /&quot;&gt;&lt;button data-do=&quot;nt-start&quot;&gt;Start&lt;\/button&gt;&lt;img/);
  assert.match(html, /orca orchestration worker-start --spec/); // as text
  assert.match(html, /&lt;b data-do=&quot;inbox-setup&quot;&gt;Title&lt;\/b&gt;/);
  assert.doesNotMatch(html, /\u202e/);
  assert.doesNotMatch(html, /bad id|bad kind/);
  assert.equal(p.sent.filter((m) => m.action !== 'size' && m.action !== 'inbox').length, 0, 'reading the inbox sends nothing else');
});

test('k52: not set up: one calm line and Set up (inbox-setup); no answer in 30 s ends in a fixed line', () => {
  const { p, timers, clock, of, open } = inboxPanel();
  open('inbox_not_ready');
  const html = p.html();
  assert.match(html, /Not set up yet/);
  assert.doesNotMatch(html, /data-do="nt-open"/, 'no New task until it is set up');
  p.tap({ do: 'inbox-setup' });
  p.tap({ do: 'inbox-setup' });
  assert.equal(of('inbox-setup').length, 1);
  assert.match(p.html(), /aria-disabled="true">Setting up…</);
  clock.now += 30_000;
  timers.filter((x) => !x.cleared && !x.ran && x.ms === 30_000).forEach((x) => { x.ran = true; x.fn(); });
  assert.match(p.html(), /Couldn’t set it up from here\. Run <span class="code">kadans inbox setup<\/span> once in an Orca terminal you keep open\./);
  // the bridge's answer (k53): ok reads the inbox again
  p.tap({ do: 'inbox-setup' });
  const reads = of('inbox').length;
  p.window.kadans.result({ action: 'inbox-setup', id: '', ok: true, why: '' });
  assert.equal(of('inbox').length, reads + 1);
});

test('k52: the phone page sends the five inbox actions over HTTP and reads the inbox from the action answer', async () => {
  const calls = [];
  let inbox = null;
  const fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url.includes('state')) return { status: 200, json: async () => ({ status: null, agents: [] }) };
    const out = { action: body.action, id: body.id ?? '', ok: true, why: '' };
    if (body.action === 'inbox') out.inbox = inbox;
    if (body.action === 'repos') out.repos = { machine: body.machine, list: [{ id: 'repo-0001', name: 'rain-sounds' }] };
    return { status: 200, json: async () => out };
  };
  const store = new Map([['kadans.token', 'tok']]);
  const ph = loadPanel({ http: { fetch, store } });
  await flush();
  inbox = fixture(ph, 'inbox_busy').inbox;
  ph.tap({ do: 'inbox' });
  await flush();
  assert.ok(calls.some((c) => c.url === 'api/action' && c.body?.action === 'inbox'));
  assert.match(ph.html(), /Make the rain sound loop without a gap/, 'the answer carried the inbox');
  ph.tap({ do: 'reply', id: 'msg_q1' });
  assert.match(ph.html(), /class="tell sheet( up)?"/); // "up" is the sheet's slide-in class, added once motion is on
  assert.match(ph.html(), /Tap the mic on the keyboard to speak/);
  for (const m of [{ action: 'inbox-reply', id: 'msg_q1', text: ANSWER }, { action: 'repos', machine: 'env-0001' },
    { action: 'task-new', machine: 'env-0001', repo: 'id:repo-0001', text: TASK, confirmed: true }, { action: 'inbox-setup' }]) ph.window.kadans.send(m);
  await flush();
  const acts = calls.filter((c) => c.url === 'api/action').map((c) => c.body.action);
  for (const a of ['inbox', 'inbox-reply', 'task-new', 'repos', 'inbox-setup']) assert.ok(acts.includes(a), a);
  assert.deepEqual([...store.keys()], ['kadans.token']);
  assert.ok(![...store.values()].some((v) => String(v).includes('SECRET')));
});
