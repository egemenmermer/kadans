// k52: the inbox, as `kadans inbox --json` gives it (k51 contract): a question from kasa, an escalation on this Mac, two
// running tasks (one with an update), done reports, one offline computer. The `after` hooks open the Inbox, a reply, or
// New task (the repos answer is rendered by hand: fixtures reach no CLI). Invented data only.
(function (K) {
  const F = K.KADANS_FIXTURES;
  const N = KF.N, M = KF.M;
  const iso = (t) => new Date(t).toISOString();
  const machines = [{ id: 'local', name: 'This Mac' }, { id: 'env-0001', name: 'kasa' }, { id: 'env-0003', name: 'PC' }];
  const kasa = { machine: 'env-0001', machineName: 'kasa' };
  const here = { machine: 'local', machineName: 'This Mac' };
  const items = () => [
    Object.assign({ id: 'msg_q1', kind: 'question', title: 'Make the rain sound loop without a gap',
      preview: 'Which sample rate? — The old clips are 44.1 kHz and the new ones 48 kHz. Resample the old ones, or keep both?',
      at: iso(N - 3 * M), status: 'open', canReply: true, dispatchId: 'disp_0001' }, kasa),
    Object.assign({ id: 'msg_e1', kind: 'escalation', title: 'Fix the flaky login test',
      preview: 'Blocked — The test needs a staging account I can’t create. Add one, or should I mock the call?',
      at: iso(N - 9 * M), status: 'open', canReply: true, dispatchId: 'disp_0002' }, here),
    Object.assign({ id: 'msg_m1', kind: 'message', title: 'Fix the flaky login test', preview: 'Progress — Found the race: the token refresh runs twice.',
      at: iso(N - 12 * M), status: 'new', canReply: false, dispatchId: 'disp_0002' }, here),
    Object.assign({ id: 'task_1', kind: 'task', title: 'Make the rain sound loop without a gap', preview: '', at: iso(N - 25 * M),
      status: 'running', canReply: false, dispatchId: 'disp_0001' }, kasa),
    Object.assign({ id: 'task_2', kind: 'task', title: 'Fix the flaky login test', preview: '', at: iso(N - 31 * M),
      status: 'running', canReply: false, dispatchId: 'disp_0002' }, here),
    Object.assign({ id: 'msg_d1', kind: 'done', title: 'Refresh README screenshots',
      preview: 'Done — Six screenshots updated, light and dark. The branch is ready for review.',
      at: iso(N - 52 * M), status: 'succeeded', canReply: false, dispatchId: 'disp_0003' }, kasa),
    Object.assign({ id: 'task_3', kind: 'task', title: 'Refresh README screenshots', preview: '', at: iso(N - 70 * M),
      status: 'completed', canReply: false, dispatchId: 'disp_0003' }, kasa),
    Object.assign({ id: 'msg_d2', kind: 'done', title: 'Tidy the changelog',
      preview: 'Failed — The changelog has merge markers from an old rebase; I stopped before touching them.',
      at: iso(N - 130 * M), status: 'failed', canReply: false, dispatchId: 'disp_0004' }, here),
  ];
  const offlinePc = { id: 'remote:PC', source: 'orca', machine: 'PC', project: null, status: 'idle', model: null, tokens: null, startedAt: null,
    lastSeen: null, pid: null, subagents: [], title: null, titleSource: null, orca: null, machineStale: true, machineOffline: true };
  const base = (inbox) => ({ status: KF.status(), agents: KF.base().concat([offlinePc]), inbox });
  const busy = () => ({ ready: true, machines, items: items() });
  const repos = { machine: 'env-0001', list: [{ id: 'repo-0001', name: 'rain-sounds' }, { id: 'repo-0002', name: 'Tidepool' },
    { id: 'repo-0003', name: 'Quarry' }, { id: 'repo-0004', name: 'Fernway' }] };

  const host = (doc) => (doc && doc.defaultView) || window;
  const click = (doc, sel) => doc.querySelector(sel)?.click();
  const open = (doc) => click(doc, '[data-do="inbox"]');
  const phone = (doc) => { if (doc.documentElement) doc.documentElement.dataset.shell = 'phone'; host(doc).kadans.render({}); };
  const type = (doc, sel, text) => {
    const f = doc.querySelector(sel);
    if (!f) return;
    f.value = text;
    if (typeof Event === 'function' && f.dispatchEvent) f.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const reply = (doc) => { click(doc, '[data-do="reply"][data-id="msg_q1"]'); type(doc, 'textarea.tl', 'Resample the old ones to 48 kHz.'); };
  const newTask = (confirm) => (doc) => {
    open(doc);
    click(doc, '[data-do="nt-open"]');
    click(doc, '[data-do="nt-machine"][data-id="env-0001"]');
    host(doc).kadans.render({ repos });
    click(doc, '[data-do="nt-repo"][data-id="repo-0001"]');
    type(doc, 'textarea.ntx', 'Make the rain loop seamless: crossfade the last 200 ms into the start, then add a test for the gap.');
    if (confirm) click(doc, '[data-do="nt-next"]');
  };

  F.inbox_badge = base(busy()); // the main panel: the tray shows 2 (the question and the escalation)
  F.inbox_empty = Object.assign(base({ ready: true, machines, items: [] }), { after: open });
  F.inbox_busy = Object.assign(base(busy()), { after: open });
  F.inbox_busy_reply = Object.assign(base(busy()), { after(doc) { open(doc); reply(doc); } });
  F.inbox_new_task = Object.assign(base(busy()), { after: newTask(false) });
  F.inbox_new_task_confirm = Object.assign(base(busy()), { after: newTask(true) });
  F.inbox_not_ready = Object.assign(base({ ready: false, machines: [{ id: 'local', name: 'This Mac' }], items: [] }), { after: open });
  F.inbox_busy_phone = Object.assign(base(busy()), { after(doc) { phone(doc); open(doc); reply(doc); } });
  F.inbox_new_task_phone = Object.assign(base(busy()), { after(doc) { phone(doc); newTask(false)(doc); } });
})(window);
