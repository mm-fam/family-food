// Smoke tests for the backend (apps-script/Code.gs), run with `node --test tests/*.test.js`.
// The Checks workflow runs these on every push; a failure stops the backend deploy.
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

test('cart helper heartbeat: the watcher check-in shows in state', () => {
  const b = fresh();
  assert.strictEqual(b.call({ action: 'cartJobsOpen', pass: PASS, chrome: '0' }).ok, true);
  const s = b.call({ action: 'state', pass: PASS, by: 'Pat' }).state.settings;
  assert.ok(s.watcher_seen, 'watcher_seen set');
  assert.strictEqual(s.watcher_chrome, '0');
});

test('Check all stores queues a sign-in check plus a cart check per store', () => {
  const b = fresh();
  const r = b.call({ action: 'cartJob', pass: PASS, by: 'Pat', store: 'ALL', kind: 'signin' });
  assert.strictEqual(r.ok, true, r.error);
  const open = r.state.cartJobs.filter((j) => j.status === 'queued');
  assert.deepStrictEqual(open.filter((j) => j.kind === 'check').map((j) => j.store).sort(), ['AMZ', 'GE', 'TGT', 'WF']);
  assert.strictEqual(open.filter((j) => j.kind === 'signin').length, 1);
  const again = b.call({ action: 'cartJob', pass: PASS, by: 'Pat', store: 'ALL', kind: 'signin' });
  assert.strictEqual(again.result.already, true); // a second tap doesn't pile up jobs
});

test("Laptop's on: one 'all' job plus a check per store", () => {
  const b = fresh();
  const r = b.call({ action: 'cartJob', pass: PASS, by: 'Sam', store: 'ALL', kind: 'all' });
  assert.strictEqual(r.ok, true, r.error);
  const open = r.state.cartJobs.filter((j) => j.status === 'queued');
  assert.strictEqual(open.filter((j) => j.kind === 'all').length, 1);
  assert.strictEqual(open.filter((j) => j.kind === 'check').length, 4);
  assert.ok(!b.call({ action: 'cartJob', pass: PASS, by: 'Kim', store: 'ALL', kind: 'all' }).ok, 'kids can’t start it');
});

test('store options: option rows never become what we buy; which cards and picks (api 51)', () => {
  const t = require('./fixture').tabs();
  t.Items.push(require('./fixture').H.Items.map((h) => ({ id: 'i007', name: 'To-go coffee cups', store: 'TGT', group: 'Paper & cleaning', status: 'Sometimes', notes: 'Added in app by Pat' })[h] || ''));
  t.Products.push(['i007', 'TGT', 'Compostable Hot Cups with Lids - 16oz/12ct - up&up', '16 oz, 12 ct', '', 'likely', 'test', '', '', '', 4.49, 0.37, 'ct', "'2026-11-04", '', '']);
  t.Products.push(['i007', 'TGT', 'Dixie To Go Disposable Hot Cups & Lids - 16oz', '16 oz', '', 'option', 'options 2026-11-05', '', '', '', 6.39, 0.36, 'ct', "'2026-11-05", '', '18 ct']);
  t.Products.push(['i007', 'TGT', 'Dixie To Go Disposable Hot Cups & Lids - 12oz', '12 oz', '', 'option', 'options 2026-11-05', '', '', '', 5.99, 0.23, 'ct', "'2026-11-05", '', '26 ct']);
  t.Products.push(['i005', 'GE', 'Kerrygold Butter', '8 oz', '', 'option', 'options 2026-11-05', '', '', '', 4.99, 0.62, 'oz', "'2026-11-05", '', '']);
  t.Settings.push(['options_new', 'Y']);
  const b = loadBackend(t, { FAMILY_PASSCODE: PASS });
  let s = b.call({ action: 'state', pass: PASS, by: 'Pat' }).state;
  // An option alone is never what we buy; the guess stays until someone picks.
  assert.ok(!(s.products.i005 && s.products.i005.GE), 'option row is not what we buy');
  assert.match(s.products.i007.TGT.name, /up&up/);
  // One card for the cups (the guess + 2 options); butter has only one choice, so no card.
  const cards = s.review.filter((r) => r.type === 'which');
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].audience, 'Pat');
  assert.match(cards[0].detail, /Which To-go coffee cups at Target\? \(i007\) Options: .*what we buy now; Dixie .*; None of these$/);
  assert.ok(!/options_new', 'Y'/.test(JSON.stringify(rows(b, 'Settings'))));
  // Asking again doesn't repeat it.
  b.call({ action: 'state', pass: PASS, by: 'Pat' });
  assert.strictEqual(rows(b, 'Review').filter((r) => r[2] === 'which').length, 1);
  // A kid's answer changes nothing; a parent's picks the 16 oz Dixie.
  const label = cards[0].detail.split('Options: ')[1].split('; ').find((x) => /12oz/.test(x) === false && /^Dixie/.test(x));
  let r = b.call({ action: 'reviewAnswer', pass: PASS, by: 'Kim', id: cards[0].id, answer: label + ' (Kim)' });
  assert.strictEqual(r.result.which, null);
  r = b.call({ action: 'reviewAnswer', pass: PASS, by: 'Pat', id: cards[0].id, answer: label + ' (Pat)' });
  assert.strictEqual(r.result.which.product, 'Dixie To Go Disposable Hot Cups & Lids - 16oz');
  assert.strictEqual(r.state.products.i007.TGT.name, 'Dixie To Go Disposable Hot Cups & Lids - 16oz');
  const p = rows(b, 'Products');
  assert.strictEqual(p.find((x) => /up&up/.test(x[2]))[5], 'alt');
  // Item screen: every product we know, the current one marked; Use this switches back.
  const info = b.call({ action: 'itemInfo', pass: PASS, by: 'Pat', item_id: 'i007' }).result;
  assert.strictEqual(info.products.length, 3);
  assert.strictEqual(info.products.filter((x) => x.current).length, 1);
  assert.match(b.call({ action: 'productPick', pass: PASS, by: 'Kim', item_id: 'i007', store: 'TGT', product: 'x' }).error, /parent/);
  r = b.call({ action: 'productPick', pass: PASS, by: 'Sam', item_id: 'i007', store: 'TGT', product: 'Compostable Hot Cups with Lids - 16oz/12ct - up&up' });
  assert.strictEqual(r.ok, true, r.error);
  assert.match(r.state.products.i007.TGT.name, /up&up/);
});

test('vote from the meal card: latest vote wins, open card closes, no points (api 52)', () => {
  const t = tabs();
  t.Review.push(['r901', '2026-11-01', 'vote', 'Dinner vote: how do you feel about Pancakes? (m01) Options: 😍; 🙂; 😐; 👎', 'answered', '🙂 (Kim)', 'Kim', '', '', '', '', '', '2026-11-01', '', '', '', ''],
    ['r902', '2026-11-01', 'vote', 'Dinner vote: how do you feel about Pancakes? (m01) Options: 😍; 🙂; 😐; 👎', 'open', '', 'Pat', '', '', '', '', '', '', '', '', '', '']);
  const b = loadBackend(t, { FAMILY_PASSCODE: PASS });
  let r = b.call({ action: 'mealVote', pass: PASS, by: 'Kim', meal_id: 'm01', vote: '😍' });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.state.mealStats.m01.voters.Kim, '😍');
  r = b.call({ action: 'mealVote', pass: PASS, by: 'pat', meal_id: 'm01', vote: '👎' });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.state.mealStats.m01.voters, { Kim: '😍', Pat: '👎' });
  const rv = rows(b, 'Review');
  const h = rv[0];
  const open = rv.find((x) => x[0] === 'r902');
  assert.strictEqual(open[h.indexOf('status')], 'closed');
  const mine = rv[rv.length - 1];
  assert.strictEqual(mine[h.indexOf('status')], 'closed');
  assert.strictEqual(Number(mine[h.indexOf('points')]) || 0, 0);
  assert.ok(b.call({ action: 'mealVote', pass: PASS, by: 'Kim', meal_id: 'm01', vote: 'yay' }).error);
  assert.ok(b.call({ action: 'mealVote', pass: PASS, by: 'Kim', meal_id: 'm99', vote: '😍' }).error);
  assert.ok(b.call({ action: 'mealVote', pass: PASS, by: 'Nobody', meal_id: 'm01', vote: '😍' }).error);
});

test('mini fridge tag: parents set Items mini_fridge, kids can’t (api 53)', () => {
  const b = loadBackend(tabs(), { FAMILY_PASSCODE: PASS });
  let r = b.call({ action: 'itemSave', pass: PASS, by: 'Pat', id: 'i002', fields: { mini_fridge: 'yes' } });
  assert.strictEqual(r.ok, true, r.error);
  const it = r.state.items.find((x) => x.id === 'i002');
  assert.strictEqual(it.mini_fridge, 'Y');
  r = b.call({ action: 'itemSave', pass: PASS, by: 'Pat', id: 'i002', fields: { mini_fridge: '' } });
  assert.strictEqual(r.state.items.find((x) => x.id === 'i002').mini_fridge, '');
  assert.ok(!b.call({ action: 'itemSave', pass: PASS, by: 'Kim', id: 'i002', fields: { mini_fridge: 'Y' } }).ok);
});

test('pantry staple: parents set Items pantry, kids can’t (api 54)', () => {
  const b = loadBackend(tabs(), { FAMILY_PASSCODE: PASS });
  let r = b.call({ action: 'itemSave', pass: PASS, by: 'Pat', id: 'i002', fields: { pantry: 'yes' } });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.state.items.find((x) => x.id === 'i002').pantry, 'Y');
  r = b.call({ action: 'itemSave', pass: PASS, by: 'Pat', id: 'i002', fields: { pantry: '' } });
  assert.strictEqual(r.state.items.find((x) => x.id === 'i002').pantry, '');
  assert.ok(!b.call({ action: 'itemSave', pass: PASS, by: 'Kim', id: 'i002', fields: { pantry: 'Y' } }).ok);
});

test('missionsAsk: a parent sends Missing for meals to the kids as missions (api 55)', () => {
  const b = loadBackend(tabs(), { FAMILY_PASSCODE: PASS });
  b.call({ action: 'add', pass: PASS, by: 'Pat', item_id: 'i003' }); // on the List: skipped
  let r = b.call({ action: 'missionsAsk', pass: PASS, by: 'Pat', items: [{ id: 'i001', why: 'Pancakes' }, { id: 'i002', why: 'Pancakes' }, { id: 'i003' }, { id: 'i005' }, { id: 'i999' }] });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.result.sent, 3);
  const checks = r.state.review.filter((x) => x.type === 'check' && /meal plan/.test(x.detail));
  assert.strictEqual(checks.length, 3);
  assert.ok(checks.some((x) => x.audience === 'Kim') && checks.some((x) => x.audience === 'Lee'));
  assert.ok(/It's for Pancakes\. \(i001\) Options: Plenty; Some; A little; Out/.test(checks.find((x) => /\(i001\)/.test(x.detail)).detail));
  // Sending again doesn't double up; kids can't send.
  r = b.call({ action: 'missionsAsk', pass: PASS, by: 'Pat', items: [{ id: 'i001' }] });
  assert.strictEqual(r.result.sent, 0);
  assert.ok(!b.call({ action: 'missionsAsk', pass: PASS, by: 'Kim', items: [{ id: 'i004' }] }).ok);
  // A kid's answer works like any mission: Out puts it on the List as a request.
  const card = checks.find((x) => /\(i002\)/.test(x.detail));
  r = b.call({ action: 'reviewAnswer', pass: PASS, by: card.audience, id: card.id, answer: 'Out' });
  assert.strictEqual(r.ok, true, r.error);
  assert.ok(r.state.list.some((x) => x.item_id === 'i002' && x.status === 'requested'));
});

test('mission fairness: 6 missions a day count; bulk missions alternate, whoever is behind first (api 57)', () => {
  const b = fresh();
  const today = b.isoDate(new Date());
  const rv = rows(b, 'Review');
  const H = rv[0];
  const row = (o) => H.map((h) => (o[h] === undefined ? '' : o[h]));
  // Kim answers 8 missions today (24 face value) and 9 quick cards; Lee answers 1 quick card.
  for (let i = 0; i < 8; i++) rv.push(row({ id: 'r9' + i, created: today, type: 'check', detail: 'Go check (i001)', status: 'closed', answer: 'Out (Kim)', audience: 'Kim', answered_at: today + 'T10:0' + i + ':00', points: 3, points_to: 'Kim', points_why: 'check' }));
  for (let i = 0; i < 9; i++) rv.push(row({ id: 'r8' + i, created: today, type: 'profile', detail: 'q', status: 'closed', answer: 'Yes (Kim)', audience: 'Kim', answered_at: today + 'T11:0' + i + ':00', points: 1, points_to: 'Kim', points_why: 'other' }));
  rv.push(row({ id: 'r700', created: today, type: 'profile', detail: 'q', status: 'closed', answer: 'Yes (Lee)', audience: 'Lee', answered_at: today + 'T11:00:00', points: 1, points_to: 'Lee', points_why: 'other' }));
  let r = b.call({ action: 'state', pass: PASS, by: 'Pat' });
  assert.strictEqual(r.ok, true, r.error);
  const P = r.state.points;
  assert.strictEqual(P.today.Kim, 6 * 3 + 8, 'missions cap at 6, quick cards at 8');
  assert.strictEqual(P.missionToday.Kim, 8);
  assert.strictEqual(P.missionCap, 6);
  assert.ok(P.rules.find((x) => x.key === 'check').cap === 6);
  // Bulk missions: Lee is behind, so Lee gets the 1st, 3rd and 5th (3 of 5).
  r = b.call({ action: 'missionsAsk', pass: PASS, by: 'Pat', items: ['i001', 'i002', 'i003', 'i004', 'i005'].map((id) => ({ id })) });
  assert.strictEqual(r.ok, true, r.error);
  const to = r.result.to.reduce((m, x) => ((m[x.kid] = x.n), m), {});
  assert.ok(to.Lee >= to.Kim && to.Lee - to.Kim <= 1, JSON.stringify(to));
  // mission_cap 0 turns the limit off.
  b._ss.getSheetByName('Settings')._data.push(['mission_cap', '0']);
  r = b.call({ action: 'state', pass: PASS, by: 'Pat' });
  assert.strictEqual(r.state.points.today.Kim, 8 * 3 + 8);
});
