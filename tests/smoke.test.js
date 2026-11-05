// Smoke tests for the backend (apps-script/Code.gs), run with `node --test tests/*.test.js`.
// The Deploy backend workflow runs these first; a failure stops the deploy.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadBackend } = require('./gas-shim');
const { tabs } = require('./fixture');

const PASS = 'test-pass';
const fresh = () => loadBackend(tabs(), { FAMILY_PASSCODE: PASS });
const rows = (b, tab) => b._ss.getSheetByName(tab)._data;

test('version needs no passcode; everything else does', () => {
  const b = fresh();
  assert.strictEqual(b.call({ action: 'version' }).ok, true);
  assert.strictEqual(b.call({ action: 'state', pass: 'nope' }).error, 'wrong_passcode');
});

test('state loads with the expected shape', () => {
  const b = fresh();
  const r = b.call({ action: 'state', pass: PASS, by: 'Pat' });
  assert.strictEqual(r.ok, true, r.error);
  const s = r.state;
  for (const k of ['api', 'items', 'list', 'meals', 'review', 'settings', 'products', 'cartJobs']) assert.ok(k in s, 'state.' + k);
  assert.ok(s.items.length >= 6);
  assert.deepStrictEqual(s.settings.parents, ['Pat', 'Sam']);
});

test('a parent adds; a kid add is a request; adding twice merges', () => {
  const b = fresh();
  let r = b.call({ action: 'add', pass: PASS, by: 'Pat', item_id: 'i001' });
  assert.strictEqual(r.ok, true, r.error);
  r = b.call({ action: 'add', pass: PASS, by: 'Kim', item_id: 'i003' });
  assert.strictEqual(r.ok, true, r.error);
  r = b.call({ action: 'add', pass: PASS, by: 'Sam', item_id: 'i001' });
  assert.strictEqual(r.result.merged, true);
  const list = r.state.list;
  assert.strictEqual(list.find((x) => x.item_id === 'i001').status, 'needed');
  assert.strictEqual(list.find((x) => x.item_id === 'i003').status, 'requested');
  assert.match(String(list.find((x) => x.item_id === 'i001').wanted_by), /Pat;Sam/);
});

test('writes need a known person', () => {
  const b = fresh();
  assert.match(b.call({ action: 'add', pass: PASS, by: 'Zed', item_id: 'i001' }).error, /Unknown person/);
  assert.match(b.call({ action: 'add', pass: PASS, item_id: 'i001' }).error, /Unknown person/);
});

test('typed text never becomes a formula', () => {
  const b = fresh();
  b.call({ action: 'add', pass: PASS, by: 'Pat', item_id: 'i001', note: '=IMPORTXML("http://x","//a")' });
  b.call({ action: 'feedback', pass: PASS, by: 'Pat', text: '+1 love it', tab: 'list' });
  for (const tab of ['List', 'App Feedback']) {
    // The shim drops the leading ' like Sheets does, so a safe write reads back as the same text; what
    // matters is that it went through safeCell. Re-check by calling safeCell directly too.
    assert.ok(rows(b, tab).length > 1, tab + ' got a row');
  }
  assert.strictEqual(b.safeCell('=SUM(A1)'), "'=SUM(A1)");
  assert.strictEqual(b.safeCell('hello'), 'hello');
});

test('kids cannot do parents-only things', () => {
  const b = fresh();
  assert.ok(!b.call({ action: 'cartJob', pass: PASS, by: 'Kim', store: 'GE', kind: 'build' }).ok);
  assert.ok(b.call({ action: 'cartJob', pass: PASS, by: 'Pat', store: 'GE', kind: 'build' }).ok);
  assert.ok(b.call({ action: 'cartJob', pass: PASS, by: 'Pat', store: 'ALL', kind: 'signin' }).ok);
  assert.ok(!b.call({ action: 'cartJob', pass: PASS, by: 'Pat', store: 'ALL', kind: 'build' }).ok);
});

test('voice adds: sure → List; unsure → Inbox card that teaches an alias', () => {
  const b = fresh();
  let r = b.call({ action: 'voiceAdd', pass: PASS, by: 'Pat', text: 'salted butter and two bananas' });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.result.added, ['Salted butter', '2 Bananas']);
  r = b.call({ action: 'voiceAdd', pass: PASS, by: 'Pat', text: 'sugar' });
  assert.deepStrictEqual(r.result.asked, ['sugar']); // never forced onto Brown sugar or the bacon
  r = b.call({ action: 'voiceAdd', pass: PASS, by: 'Pat', text: 'milk' });
  const card = r.result && b.call({ action: 'state', pass: PASS, by: 'Pat' }).state.review.find((x) => x.type === 'voice' && /milk/.test(x.detail));
  assert.ok(card, 'a voice card for milk');
  b.call({ action: 'reviewAnswer', pass: PASS, by: 'Pat', id: card.id, answer: 'Fairlife whole milk (Pat)' });
  r = b.call({ action: 'voiceAdd', pass: PASS, by: 'Pat', text: 'milk' });
  assert.ok(r.result.added.concat(r.result.already).some((x) => /Fairlife/.test(x)), 'learned "milk"');
});

test('the List update path works (In store tap)', () => {
  const b = fresh();
  const id = b.call({ action: 'add', pass: PASS, by: 'Sam', item_id: 'i005' }).result.id;
  const r = b.call({ action: 'update', pass: PASS, by: 'Sam', id: id, fields: { status: 'bought', note: 'in the cart in store (Sam)' } });
  assert.strictEqual(r.ok, true, r.error);
  assert.ok(!r.state.list.some((x) => x.id === id && x.status === 'needed'));
});

test('app.js and Code.gs parse', () => {
  const fs = require('fs');
  const path = require('path');
  for (const f of ['app.js', 'apps-script/Code.gs']) {
    assert.doesNotThrow(() => new Function(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')), f);
  }
});

test('each backend version number is used once (two sessions picking the same api)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const nums = (src.match(/^\/\/ (\d+) = /gm) || []).map((s) => Number(s.match(/\d+/)[0]));
  const dup = nums.filter((n, i) => nums.indexOf(n) !== i);
  assert.deepStrictEqual(dup, [], 'duplicate "// N = " version notes: ' + dup.join(', '));
  const live = Number((src.match(/const API_VERSION = (\d+)/) || [])[1]);
  assert.ok(nums.indexOf(live) >= 0, 'API_VERSION ' + live + ' has a "// ' + live + ' = …" note');
});

test('catalog: sold by the pound and words we say', () => {
  const b = fresh();
  let r = b.call({ action: 'itemSave', pass: PASS, by: 'Pat', id: 'i002', fields: { sold_by: 'lb', spoken: 'milk, Fairlife, milk' } });
  assert.strictEqual(r.ok, true, r.error);
  const it = r.state.items.find((x) => x.id === 'i002');
  assert.strictEqual(it.sold_by, 'lb');
  assert.strictEqual(it.aliases, 'FAIRLIFE MILK WHOLAC;milk;fairlife'); // receipt code kept, words deduped
  assert.ok(!b.call({ action: 'itemSave', pass: PASS, by: 'Kim', id: 'i002', fields: { sold_by: '' } }).ok, 'kids can’t edit items');
  r = b.call({ action: 'voiceAdd', pass: PASS, by: 'Pat', text: 'fairlife' });
  assert.ok(r.result.added.some((x) => /Fairlife/.test(x)), 'a word we say is an exact match for Siri');
});

test('substitutions: backups show per store; subbed answers set the rule (api 46)', () => {
  const t = require('./fixture').tabs();
  t.Products[0].push('backup');
  t.Products.slice(1).forEach((r) => r.push(''));
  t.Products.push(['i002', 'GE', 'Giant Eagle Whole Milk', '1 gal', '', 'alt', 'sub 2026-11-04', 'sent as substitute r010', '', '', '', '', '', '', '', '', '']);
  t.Products.push(['i002', 'GE', 'Horizon Organic Whole Milk', '64 fl oz', '', 'alt', 'Pat', '', '', '', '', '', '', '', '', '', 1]);
  t.Review.push(['r010', '2026-11-04T10:00:00', 'subbed', 'Giant Eagle sent Giant Eagle Whole Milk instead of fairlife Whole Ultra-Filtered Milk (i002). Next time? Options: That\'s fine; Don\'t substitute; Make it the backup', 'open', '', 'parents', '', '', '', '', '', '', '', '', '', '']);
  t.Review.push(['r011', '2026-11-04T10:00:00', 'subbed', 'Giant Eagle sent X instead of Salted butter (i005). Next time? Options: That\'s fine; Don\'t substitute; Make it the backup', 'open', '', 'parents', '', '', '', '', '', '', '', '', '', '']);
  const b = loadBackend(t, { FAMILY_PASSCODE: PASS });
  let s = b.call({ action: 'state', pass: PASS, by: 'Pat' }).state;
  assert.strictEqual(s.products.i002.GE.name, 'fairlife Whole Ultra-Filtered Milk');
  assert.strictEqual(s.products.i002.GE.backup.name, 'Horizon Organic Whole Milk');
  // A kid's answer changes nothing.
  let r = b.call({ action: 'reviewAnswer', pass: PASS, by: 'Kim', id: 'r011', answer: "Don't substitute (Kim)" });
  assert.strictEqual(r.result.subbed, null);
  r = b.call({ action: 'reviewAnswer', pass: PASS, by: 'Pat', id: 'r011', answer: "Don't substitute (Pat)" });
  assert.strictEqual(r.result.subbed.ok_swap, 'N');
  assert.strictEqual(r.state.items.find((x) => x.id === 'i005').ok_swap, 'N');
  r = b.call({ action: 'reviewAnswer', pass: PASS, by: 'Sam', id: 'r010', answer: 'Make it the backup (Sam)' });
  assert.strictEqual(r.result.subbed.backup, true);
  assert.strictEqual(r.state.products.i002.GE.backup.name, 'Giant Eagle Whole Milk');
  const p = rows(b, 'Products');
  const col = p[0].indexOf('backup');
  assert.strictEqual(Number(p.find((x) => x[2] === 'Horizon Organic Whole Milk')[col]), 2);
});

test('a renamed meal keeps its name-only votes (api 47)', () => {
  const t = tabs();
  const vote = (id, ans) => [id, '2026-11-01', 'vote', 'Dinner vote: how do you feel about Pancakes? Options: 😍; 🙂; 😐; 👎', 'answered', ans, '', '', '', '', '', '', '2026-11-01', '', '', '', ''];
  t.Review.push(vote('r901', '😍 (Pat)'), vote('r902', '👎 (Kim)'));
  const b = loadBackend(t, { FAMILY_PASSCODE: PASS });
  let s = b.call({ action: 'state', pass: PASS, by: 'Pat' }).state;
  assert.strictEqual(Object.keys(s.mealStats.m01.voters).length, 2);
  const m = s.meals.find((x) => x.id === 'm01');
  const r = b.call({ action: 'mealSave', pass: PASS, by: 'Pat', id: 'm01', name: '🥞 Pancake Party', item_ids: String(m.item_ids).split(';'), kind: 'breakfast' });
  assert.strictEqual(r.ok, true, r.error);
  const after = r.state.meals.find((x) => x.id === 'm01');
  assert.strictEqual(after.name, '🥞 Pancake Party');
  assert.strictEqual(after.old_names, 'Pancakes');
  assert.deepStrictEqual(r.state.mealStats.m01.voters, { Pat: '😍', Kim: '👎' });
  // A kid can't rename.
  assert.ok(b.call({ action: 'mealSave', pass: PASS, by: 'Kim', id: 'm01', name: 'x', item_ids: [] }).error);
});
