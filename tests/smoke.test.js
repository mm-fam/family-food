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
