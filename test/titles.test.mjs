import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanTitle, cut, orcaTitle, pickTitle, readTitles, setTitle } from '../lib/titles.mjs';
import { STALE_MS, appendEvent, listAgents, renderAgents, scanTranscript } from '../lib/agents.mjs';
import { appendSample } from '../lib/samples.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'kadans-titles-'));
const jsonl = (rows) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');

test('cleanTitle: first sentence, capitalised, trailing dot dropped', () => {
  assert.equal(cleanTitle('fix the login bug. then run the tests'), 'Fix the login bug');
  assert.equal(cleanTitle('  why   is the\tgauge wrong?  It says 72%'), 'Why is the gauge wrong?');
  assert.equal(cleanTitle('Ok. Make the build faster'), 'Ok. Make the build faster'); // a tiny lead takes the next one
  assert.equal(cleanTitle(''), null);
  assert.equal(cleanTitle(null), null);
});

test('cleanTitle: pasted blocks and logs are dropped', () => {
  assert.equal(cleanTitle('[Pasted text #1 +40 lines] summarise this for me'), 'Summarise this for me');
  assert.equal(cleanTitle('Here:\n```js\nconst a = 1;\n```\nwhy is this broken'), 'Here: why is this broken');
  assert.equal(cleanTitle('```\nunterminated paste {"a":1}'), null);
  assert.equal(cleanTitle('12:00:01 E [x=1,y=2] 0x7f3a\n2026-10-26 99 77 {}\nfix the crash above'), 'Fix the crash above');
  assert.equal(cleanTitle('[Image #2] what is wrong in this screen'), 'What is wrong in this screen');
});

test('cleanTitle: XML-like tags, slash commands, shell prefixes', () => {
  assert.equal(cleanTitle('<system-reminder>secret stuff</system-reminder>add dark mode'), 'Add dark mode');
  assert.equal(cleanTitle('<b>add</b> <i>dark mode</i> please'), 'Please'); // tag blocks go with their content
  assert.equal(cleanTitle('/model opus'), null);
  assert.equal(cleanTitle('/clear\nwrite the release notes'), 'Write the release notes');
  assert.equal(cleanTitle('$ npm test fails on CI'), 'Npm test fails on CI');
});

test('cleanTitle: paths, URLs and @mentions go, plain slashes stay', () => {
  assert.equal(cleanTitle('read /Users/me/proj/lib/a.mjs and https://example.com/x?y=1 then fix the parser'), 'Read and then fix the parser');
  assert.equal(cleanTitle('look at ~/notes/todo.md and ./src/app.ts for and/or cases'), 'Look at and for and/or cases');
  assert.equal(cleanTitle('compare lib/agents.mjs with @docs/SPEC.md quickly'), 'Compare with quickly');
  assert.equal(cleanTitle('"/mnt/Big Disk/Work/Projects" is full, clean it'), 'Is full, clean it');
});

test('cleanTitle: Turkish letters survive and capitalise the Turkish way', () => {
  assert.equal(cleanTitle('işleri bitir ve testleri çalıştır.'), 'İşleri bitir ve testleri çalıştır');
  assert.equal(cleanTitle('şu ekranı düzelt'), 'Şu ekranı düzelt');
  assert.equal(cleanTitle('ılık bir başlık yaz'), 'Ilık bir başlık yaz');
  assert.equal(cleanTitle('öğle arası ğ ü ç ö'), 'Öğle arası ğ ü ç ö');
  assert.equal(cleanTitle('install it'), 'Install it'); // English text keeps i -> I
});

test('cleanTitle / cut: long text is cut at a word boundary to 60 characters', () => {
  const long = 'please rewrite the whole onboarding flow so that it explains the gauge and the brake in plain words';
  const t = cleanTitle(long);
  assert.ok([...t].length <= 60, t);
  assert.ok(t.endsWith('…'));
  assert.equal(t, 'Please rewrite the whole onboarding flow so that it…');
  const tr = cleanTitle('çalışma alanındaki bütün ağaçları gözden geçir ve gereksiz olanları sil ki disk dolmasın');
  assert.ok([...tr].length <= 60 && tr.endsWith('…') && !/\s…$/.test(tr), tr);
  assert.equal(cut('x'.repeat(80)).length, 60); // one long word: hard cut
  assert.equal(cut('short'), 'short');
});

test('orcaTitle: Claude Code tab titles count, shells, paths and names do not', () => {
  assert.equal(orcaTitle('✳ Fix the gauge note'), 'Fix the gauge note');
  assert.equal(orcaTitle('⠂ Writing tests'), 'Writing tests');
  for (const t of ['claude', '✳ Claude Code', 'zsh', '~/proj', '/Users/x', 'me@mac: ~', '', null]) assert.equal(orcaTitle(t), null, String(t));
  assert.equal(orcaTitle('kadans', { names: ['kadans'] }), null);
  assert.equal(orcaTitle('claude --resume abc-12345', { id: 'abc-12345' }), null);
});

test('pickTitle: owner > session (custom > ai) > Orca > prompt', () => {
  const scan = { customTitle: null, aiTitle: 'Fix gauge note rounding' };
  const orca = { title: '✳ Orca title here' };
  const prompt = 'please do the thing';
  assert.deepEqual(pickTitle({ id: 'a', owner: 'Mine', scan, orca, prompt }), { title: 'Mine', titleSource: 'owner' });
  assert.deepEqual(pickTitle({ id: 'a', scan: { ...scan, customTitle: 'renamed it' }, orca, prompt }), { title: 'Renamed it', titleSource: 'session' });
  assert.deepEqual(pickTitle({ id: 'a', scan, orca, prompt }), { title: 'Fix gauge note rounding', titleSource: 'session' });
  assert.deepEqual(pickTitle({ id: 'a', scan: null, orca, prompt }), { title: 'Orca title here', titleSource: 'orca' });
  assert.deepEqual(pickTitle({ id: 'a', scan: null, orca: { title: 'zsh' }, prompt }), { title: 'Please do the thing', titleSource: 'prompt' });
  assert.deepEqual(pickTitle({ id: 'a' }), { title: null, titleSource: null });
});

test('setTitle / readTitles: stored per agent id, empty text clears', () => {
  const home = tmp();
  assert.equal(setTitle(home, 's1', '  my   build  '), 'my build');
  assert.deepEqual(readTitles(home), { s1: 'my build' });
  assert.equal(setTitle(home, 's1', ''), null);
  assert.deepEqual(readTitles(home), {});
});

test('scanTranscript: keeps the last ai-title and custom-title; old cache states are rescanned', () => {
  const dir = tmp();
  const f = join(dir, 's.jsonl');
  writeFileSync(f, jsonl([
    { type: 'user', message: { role: 'user', content: 'first line\nsecond line' } },
    { type: 'ai-title', aiTitle: 'Early title', sessionId: 's' },
    { type: 'ai-title', aiTitle: 'Later title', sessionId: 's' },
  ]));
  const st = scanTranscript(f, null);
  assert.deepEqual([st.aiTitle, st.customTitle, st.promptRaw, st.firstPrompt], ['Later title', null, 'first line\nsecond line', 'first line second line']);
  const old = { path: f, offset: st.offset, done: 0, curId: null, cur: 0, model: null, firstPrompt: 'x' }; // a k3 cache entry
  assert.equal(scanTranscript(f, old).aiTitle, 'Later title');
});

test('listAgents: owner title wins, idle 2+ hours is stale; the text list hides stale rows unless --all', () => {
  const root = tmp();
  const home = join(root, 'kadans');
  const proj = join(root, 'repo');
  mkdirSync(proj, { recursive: true });
  const NOW = Date.parse('2026-10-26T12:00:00Z');
  const t1 = join(root, 'a.jsonl');
  writeFileSync(t1, jsonl([{ type: 'user', message: { role: 'user', content: 'build the thing' } }, { type: 'custom-title', customTitle: 'release prep', sessionId: 'a' }]));
  const t2 = join(root, 'b.jsonl');
  writeFileSync(t2, jsonl([{ type: 'user', message: { role: 'user', content: 'an old chat' } }]));
  const ev = (t, sid, e, transcript, extra = {}) => appendEvent(home, { t, ev: e, sid, cwd: proj, transcript, ...extra }, NOW);
  ev(NOW - 5 * 60_000, 'a', 'UserPromptSubmit', t1, { prompt: 'build the thing' });
  ev(NOW - 4 * 60_000, 'a', 'Stop', t1);
  ev(NOW - STALE_MS - 40 * 60_000, 'b', 'SessionStart', t2, { pid: 999_999 }); // alive() says yes: quiet but still running
  ev(NOW - STALE_MS - 30 * 60_000, 'b', 'UserPromptSubmit', t2, { prompt: 'an old chat' });
  ev(NOW - STALE_MS - 20 * 60_000, 'b', 'Stop', t2);
  appendSample(home, 'acct', { t: NOW - STALE_MS - 20 * 60_000, session_id: 'b', cwd: proj, transcript: t2, limits: {} }, NOW - STALE_MS - 20 * 60_000);
  const old = Date.now() - 30 * 60_000; // transcript mtimes count as activity: age them
  utimesSync(t1, old / 1000, (NOW - 4 * 60_000) / 1000);
  utimesSync(t2, old / 1000, (NOW - STALE_MS - 20 * 60_000) / 1000);
  let list = listAgents(home, { now: NOW, alive: () => true, claudeDirs: [] });
  const a = list.find((x) => x.id === 'a');
  const b = list.find((x) => x.id === 'b');
  assert.deepEqual([a.status, a.stale, a.title, a.titleSource], ['idle', false, 'Release prep', 'session']);
  assert.deepEqual([b.status, b.stale, b.title, b.titleSource], ['idle', true, 'An old chat', 'prompt']);
  setTitle(home, 'a', 'Owner name');
  list = listAgents(home, { now: NOW, alive: () => true, claudeDirs: [] });
  assert.equal(list.find((x) => x.id === 'a').title, 'Owner name');
  const text = renderAgents(list, NOW);
  assert.match(text, /Owner name/);
  assert.doesNotMatch(text, /An old chat/);
  assert.match(text, /1 idle for 2\+ hours not shown/);
  assert.match(renderAgents(list, NOW, { all: true }), /An old chat/);
});

