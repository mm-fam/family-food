/**
 * Poppy 2.0 — backend for the family grocery app.
 *
 * Lives inside the "Poppy 2.0 (app data)" Google Sheet (Extensions → Apps Script).
 * Deployed as a web app; the GitHub Pages front end talks to it with POST requests.
 *
 * Setup (once):
 *   1. Project Settings → Script Properties → add FAMILY_PASSCODE = <your passcode>
 *   2. Run setup() once from the editor and approve the permissions prompt.
 *   3. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 *   4. Copy the /exec URL into config.js in the repo.
 */

const TABS = {
  items: 'Items',
  list: 'List',
  meals: 'Meals',
  plan: 'Plan',
  receipts: 'Receipts',
  review: 'Review',
  settings: 'Settings',
  stock: 'Stock',
};

// Stock is an append-only log of "we have it" sightings (created on first use).
const STOCK_HEAD = ['at', 'item_id', 'level', 'expires', 'who', 'source', 'list_id'];
const LEVELS = ['plenty', 'some', 'low', 'out'];
const HOLD_DAYS = 7;

// Statuses a List row moves through.
const ACTIVE = ['requested', 'needed', 'carted'];
const DONE = ['bought', 'skipped', 'have']; // have = we already had it, nothing bought

// Items stats columns (J:M) are formulas over Receipts; new item rows get them too.
const ITEM_FORMULAS_R1C1 = [
  '=COUNTUNIQUEIFS(Receipts!C3:C3,Receipts!C5:C5,RC1)',
  '=IF(RC10=0,"",MINIFS(Receipts!C1:C1,Receipts!C5:C5,RC1))',
  '=IF(RC10=0,"",MAXIFS(Receipts!C1:C1,Receipts!C5:C5,RC1))',
  '=IF(RC10<2,"",ROUND((RC12-RC11)/(RC10-1),0))',
];

/* ---------------------------------------------------------------- entry points */

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents || '{}');
  } catch (err) {
    return reply({ ok: false, error: 'bad_json' });
  }
  return handle(req);
}

// GET is handy for a quick check in the browser: /exec?pass=...&action=ping
function doGet(e) {
  return handle(e.parameter || {});
}

function handle(req) {
  const pass = PropertiesService.getScriptProperties().getProperty('FAMILY_PASSCODE');
  if (!pass) return reply({ ok: false, error: 'passcode_not_set' });
  if (String(req.pass || '') !== pass) return reply({ ok: false, error: 'wrong_passcode' });

  const actions = {
    ping: () => ({ pong: true }),
    state: () => getState(),
    add: () => withLock(() => addToList(req)),
    update: () => withLock(() => updateListRow(req)),
    addMeal: () => withLock(() => addMealToList(req)),
    planSet: () => withLock(() => setPlan(req)),
    mealSave: () => withLock(() => saveMeal(req)),
    itemSave: () => withLock(() => saveItem(req)),
    reviewAnswer: () => withLock(() => answerReview(req)),
    reviewPass: () => withLock(() => passReview(req)),
    listHave: () => withLock(() => listHave(req)),
    listHold: () => withLock(() => listHold(req)),
    requestOrder: () => withLock(() => requestOrder(req)),
  };
  const fn = actions[req.action];
  if (!fn) return reply({ ok: false, error: 'unknown_action' });
  try {
    const out = fn();
    // Every write returns fresh state so the app never has to guess.
    const state = req.action === 'state' || req.action === 'ping' ? out : getState();
    return reply({ ok: true, result: req.action === 'state' ? undefined : out, state: state });
  } catch (err) {
    return reply({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* ---------------------------------------------------------------- sheet helpers */

function sheet(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Missing tab: ' + name);
  return sh;
}

// Reads a tab into objects keyed by its header row. Each object knows its row number.
function readTab(name) {
  const sh = sheet(name);
  const values = sh.getDataRange().getValues();
  const head = values.shift().map(String);
  return values
    .map((row, i) => {
      const o = { _row: i + 2 };
      head.forEach((h, j) => (o[h] = row[j] instanceof Date ? isoDate(row[j]) : row[j]));
      return o;
    })
    .filter((o) => String(o[head[0]] || '') !== '');
}

function headers(name) {
  const sh = sheet(name);
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}

function appendObj(name, obj) {
  const head = headers(name);
  sheet(name).appendRow(head.map((h) => (obj[h] === undefined ? '' : obj[h])));
}

function setFields(name, rowNum, fields) {
  const head = headers(name);
  const sh = sheet(name);
  Object.keys(fields).forEach((k) => {
    const col = head.indexOf(k);
    if (col >= 0) sh.getRange(rowNum, col + 1).setValue(fields[k]);
  });
}

function nextId(rows, key, prefix, width) {
  let max = 0;
  rows.forEach((r) => {
    const n = parseInt(String(r[key]).replace(prefix, ''), 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return prefix + String(max + 1).padStart(width, '0');
}

function isoDate(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function nowStamp() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
}

function daysBetween(isoA, isoB) {
  const a = new Date(isoA + 'T12:00:00');
  const b = new Date(isoB + 'T12:00:00');
  return Math.round((b - a) / 86400000);
}

function settingsMap() {
  const m = {};
  readTab(TABS.settings).forEach((r) => (m[r.key] = r.value));
  return m;
}

function isKid(name) {
  const kids = String(settingsMap().kids || '').split(',').map((s) => s.trim().toLowerCase());
  return kids.indexOf(String(name || '').trim().toLowerCase()) >= 0;
}

/* ---------------------------------------------------------------- reads */

function getState() {
  const items = readTab(TABS.items);
  const list = readTab(TABS.list);
  const today = isoDate(new Date());
  const open = list.filter((r) => ACTIVE.indexOf(r.status) >= 0);
  const onList = {};
  open.forEach((r) => r.item_id && (onList[r.item_id] = true));
  // "Next run" rows stay needed but are hidden until hold_until passes.
  const isHeld = (r) => r.hold_until && String(r.hold_until).slice(0, 10) > today;
  const active = open.filter((r) => !isHeld(r));
  const held = open.filter(isHeld);

  // A fresh "we have plenty/some/a count" sighting (last 7 days) holds back "probably due".
  const stocked = {};
  if (SpreadsheetApp.getActive().getSheetByName(TABS.stock)) {
    readTab(TABS.stock).forEach((s) => {
      const lvl = String(s.level).toLowerCase();
      const fresh = s.at && daysBetween(String(s.at).slice(0, 10), today) <= 7;
      if (s.item_id && fresh && (lvl === 'plenty' || lvl === 'some' || Number(lvl) > 0)) stocked[s.item_id] = true;
    });
  }

  // "Probably due": we have a buying rhythm for it, it's about that time, and it isn't listed.
  const due = items
    .filter((it) => it.status !== 'Drop' && it.avg_days && it.last_bought && !onList[it.id] && !stocked[it.id])
    .map((it) => ({ id: it.id, since: daysBetween(it.last_bought, today), every: Number(it.avg_days) }))
    .filter((d) => d.since >= d.every - 2)
    .sort((a, b) => b.since / b.every - a.since / a.every)
    .slice(0, 12);

  const settings = settingsMap();
  // Recently finished rows so the app can show "cleared by receipt" and allow undo.
  const recent = list
    .filter((r) => DONE.indexOf(r.status) >= 0 && r.updated_at && daysBetween(String(r.updated_at).slice(0, 10), today) <= 3)
    .slice(-20);

  return {
    api: 3, // bump when the app needs a newer backend; 2 = reviewPass + Review audience; 3 = listHave/listHold
    today: today,
    items: items.map(stripRow),
    list: active.map(stripRow),
    held: held.map(stripRow),
    recent: recent.map(stripRow),
    meals: readTab(TABS.meals).map(stripRow),
    plan: readTab(TABS.plan).filter((p) => String(p.week_of) === weekOf(today)).map(stripRow),
    weekOf: weekOf(today),
    review: readTab(TABS.review).filter((r) => r.status === 'open').map(stripRow),
    due: due,
    settings: {
      parents: String(settings.parents || '').split(',').map((s) => s.trim()).filter(String),
      kids: String(settings.kids || '').split(',').map((s) => s.trim()).filter(String),
      ge_order_day: settings.ge_order_day || '',
      wf_order_day: settings.wf_order_day || '',
      order_requested: settings.order_requested || '',
    },
  };
}

function stripRow(o) {
  const c = Object.assign({}, o);
  delete c._row;
  return c;
}

// Weeks start on Sunday.
function weekOf(iso) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() - d.getDay());
  return isoDate(d);
}

/* ---------------------------------------------------------------- writes */

function findItemByName(items, name) {
  const n = String(name || '').trim().toLowerCase();
  return items.find((it) => String(it.name).toLowerCase() === n);
}

function createItem(fields) {
  const items = readTab(TABS.items);
  const id = nextId(items, 'id', 'i', 3);
  appendObj(TABS.items, {
    id: id,
    name: String(fields.name).trim(),
    store: fields.store || 'Either',
    group: fields.group || 'Other',
    brand_size: fields.brand_size || '',
    notes: fields.by ? 'Added in app by ' + fields.by : '',
  });
  const sh = sheet(TABS.items);
  const row = sh.getLastRow();
  sh.getRange(row, 10, 1, 4).setFormulasR1C1([ITEM_FORMULAS_R1C1]);
  sh.getRange(row, 11, 1, 2).setNumberFormat('yyyy-mm-dd');
  return id;
}

function addToList(req) {
  if (!req.by) throw new Error('Missing name');
  const items = readTab(TABS.items);
  let item = req.item_id ? items.find((it) => it.id === req.item_id) : findItemByName(items, req.name);
  let itemId = item ? item.id : '';
  if (!item) {
    if (!String(req.name || '').trim()) throw new Error('Missing item name');
    itemId = createItem({ name: req.name, store: req.store, group: req.group, by: req.by });
    item = { id: itemId, name: String(req.name).trim(), store: req.store || 'Either' };
  }

  const list = readTab(TABS.list);
  const qty = Number(req.qty) || 1;
  const existing = list.find((r) => r.item_id === itemId && ACTIVE.indexOf(r.status) >= 0);
  if (existing) {
    // Already on the list: bump the quantity instead of adding a duplicate row.
    const today = isoDate(new Date());
    if (existing.hold_until && String(existing.hold_until).slice(0, 10) > today) {
      // Someone needs it now after all: bring it back instead of bumping the quantity.
      setFields(TABS.list, existing._row, { hold_until: '', updated_at: nowStamp() });
      return { id: existing.id, merged: true, unheld: true };
    }
    setFields(TABS.list, existing._row, { qty: (Number(existing.qty) || 1) + (req.bump === false ? 0 : qty), updated_at: nowStamp() });
    return { id: existing.id, merged: true };
  }

  const id = nextId(list, 'id', 'L', 5);
  appendObj(TABS.list, {
    id: id,
    item_id: itemId,
    name: item.name,
    store: req.store || item.store || 'Either',
    qty: qty,
    note: req.note || '',
    added_by: req.by,
    added_at: nowStamp(),
    status: isKid(req.by) ? 'requested' : 'needed',
    updated_at: nowStamp(),
    meal_id: req.meal_id || '',
  });
  return { id: id, merged: false };
}

function updateListRow(req) {
  const row = readTab(TABS.list).find((r) => r.id === req.id);
  if (!row) throw new Error('List row not found');
  const allowed = ['qty', 'note', 'status', 'store', 'hold_until'];
  const f = {};
  allowed.forEach((k) => req.fields && req.fields[k] !== undefined && (f[k] = req.fields[k]));
  if (f.status && ACTIVE.concat(DONE).indexOf(f.status) < 0) throw new Error('Bad status');
  if (f.status === 'needed' && row.status === 'requested' && isKid(req.by)) throw new Error('Only parents can approve');
  f.updated_at = nowStamp();
  setFields(TABS.list, row._row, f);
  return { id: row.id };
}

function addMealToList(req) {
  const meal = readTab(TABS.meals).find((m) => m.id === req.meal_id);
  if (!meal) throw new Error('Meal not found');
  const ids = req.item_ids && req.item_ids.length ? req.item_ids : String(meal.item_ids).split(';').filter(String);
  ids.forEach((itemId) => addToList({ item_id: itemId, by: req.by, meal_id: meal.id, bump: false }));
  return { added: ids.length };
}

function setPlan(req) {
  const week = req.week_of || weekOf(isoDate(new Date()));
  const plan = readTab(TABS.plan);
  const existing = plan.find((p) => String(p.week_of) === week && p.day === req.day);
  if (existing) {
    if (!req.meal_id) sheet(TABS.plan).deleteRow(existing._row);
    else setFields(TABS.plan, existing._row, { meal_id: req.meal_id });
  } else if (req.meal_id) {
    appendObj(TABS.plan, { week_of: "'" + week, day: req.day, meal_id: req.meal_id });
  }
  return { day: req.day };
}

function saveMeal(req) {
  const meals = readTab(TABS.meals);
  const ids = (req.item_ids || []).join(';');
  const existing = req.id ? meals.find((m) => m.id === req.id) : null;
  if (existing) {
    setFields(TABS.meals, existing._row, { name: req.name || existing.name, item_ids: ids, notes: req.notes || existing.notes });
    return { id: existing.id };
  }
  const id = nextId(meals, 'id', 'm', 2);
  appendObj(TABS.meals, { id: id, name: req.name, item_ids: ids, notes: req.notes || '' });
  return { id: id };
}

function saveItem(req) {
  if (isKid(req.by)) throw new Error('Only parents can edit items');
  if (!req.id && req.fields && req.fields.name) {
    return { id: createItem(Object.assign({ by: req.by }, req.fields)) };
  }
  const item = readTab(TABS.items).find((it) => it.id === req.id);
  if (!item) throw new Error('Item not found');
  const allowed = ['name', 'store', 'group', 'brand_size', 'ok_swap', 'status', 'notes'];
  const f = {};
  allowed.forEach((k) => req.fields && req.fields[k] !== undefined && (f[k] = req.fields[k]));
  setFields(TABS.items, item._row, f);
  return { id: item.id };
}

function answerReview(req) {
  const r = readTab(TABS.review).find((x) => x.id === req.id);
  if (!r) throw new Error('Review item not found');
  setFields(TABS.review, r._row, { answer: req.answer || '', status: 'answered' });
  return { id: r.id };
}

// Hand a question to someone else: sets who sees it (a person's name, or 'parents' / 'all').
function passReview(req) {
  const r = readTab(TABS.review).find((x) => x.id === req.id);
  if (!r) throw new Error('Review item not found');
  const head = headers(TABS.review);
  if (head.indexOf('audience') < 0) throw new Error('Review tab needs an audience column');
  const to = String(req.to || '').trim();
  const settings = settingsMap();
  const people = String(settings.parents || '').split(',').concat(String(settings.kids || '').split(','))
    .map((s) => s.trim().toLowerCase()).filter(String);
  if (['parents', 'all'].indexOf(to.toLowerCase()) < 0 && people.indexOf(to.toLowerCase()) < 0) throw new Error('Unknown person: ' + to);
  setFields(TABS.review, r._row, { audience: to, passed_by: req.by || '' });
  return { id: r.id, to: to };
}

/* ---------------------------------------------------------------- stock ("we have it") */

function stockSheet() {
  let sh = SpreadsheetApp.getActive().getSheetByName(TABS.stock);
  if (!sh) {
    sh = SpreadsheetApp.getActive().insertSheet(TABS.stock);
    sh.appendRow(STOCK_HEAD);
    sh.setFrozenRows(1);
  }
  return sh;
}

// level: plenty / some / low / out, or a count like "6".
function cleanLevel(level) {
  const v = String(level || '').trim().toLowerCase();
  if (!v) return '';
  if (LEVELS.indexOf(v) >= 0) return v;
  if (/^\d{1,3}$/.test(v)) return v;
  throw new Error('Bad amount: ' + level);
}

function logStock(o) {
  stockSheet();
  appendObj(TABS.stock, {
    at: nowStamp(),
    item_id: o.item_id || '',
    level: o.level,
    expires: o.expires ? "'" + o.expires : '',
    who: o.who || '',
    source: o.source || 'list',
    list_id: o.list_id || '',
  });
}

function listNote(row, text) {
  return row.note ? row.note + '; ' + text : text;
}

// "We have it": nothing bought. The row is done (status have) and the sighting is logged.
function listHave(req) {
  const row = readTab(TABS.list).find((r) => r.id === req.id);
  if (!row) throw new Error('List row not found');
  const level = cleanLevel(req.level) || 'some';
  setFields(TABS.list, row._row, { status: 'have', hold_until: '', note: listNote(row, 'had ' + level + ' (' + (req.by || '?') + ')'), updated_at: nowStamp() });
  logStock({ item_id: row.item_id, level: level, expires: req.expires, who: req.by, source: 'list', list_id: row.id });
  return { id: row.id, level: level };
}

// "Next run": keep it on the list but hide it until hold_until (default a week out).
function listHold(req) {
  const row = readTab(TABS.list).find((r) => r.id === req.id);
  if (!row) throw new Error('List row not found');
  const d = new Date();
  d.setDate(d.getDate() + (Number(req.days) || HOLD_DAYS));
  const until = req.until || isoDate(d);
  const level = cleanLevel(req.level);
  const f = { hold_until: "'" + until, updated_at: nowStamp() };
  if (level) f.note = listNote(row, 'had ' + level + ' (' + (req.by || '?') + ')');
  setFields(TABS.list, row._row, f);
  if (level) logStock({ item_id: row.item_id, level: level, who: req.by, source: 'list', list_id: row.id });
  return { id: row.id, hold_until: until };
}

function requestOrder(req) {
  const s = readTab(TABS.settings).find((r) => r.key === 'order_requested');
  const value = req.store ? req.store + ' requested by ' + req.by + ' at ' + nowStamp() : '';
  if (s) setFields(TABS.settings, s._row, { value: value });
  else appendObj(TABS.settings, { key: 'order_requested', value: value });
  return { order_requested: value };
}

/* ---------------------------------------------------------------- nightly + setup */

// Runs nightly: moves bought/skipped rows older than 14 days to a List Archive tab.
function nightly() {
  withLock(() => {
    const sh = sheet(TABS.list);
    const list = readTab(TABS.list);
    const today = isoDate(new Date());
    let archive = SpreadsheetApp.getActive().getSheetByName('List Archive');
    if (!archive) {
      archive = SpreadsheetApp.getActive().insertSheet('List Archive');
      archive.appendRow(headers(TABS.list));
    }
    const head = headers(TABS.list);
    const old = list.filter(
      (r) => DONE.indexOf(r.status) >= 0 && r.updated_at && daysBetween(String(r.updated_at).slice(0, 10), today) > 14
    );
    old
      .sort((a, b) => b._row - a._row)
      .forEach((r) => {
        archive.appendRow(head.map((h) => r[h]));
        sh.deleteRow(r._row);
      });
  });
}

function setup() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'nightly')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('nightly').timeBased().everyDays(1).atHour(3).create();
  const pass = PropertiesService.getScriptProperties().getProperty('FAMILY_PASSCODE');
  Logger.log(pass ? 'Setup done. Passcode is set.' : 'Setup done. Now add FAMILY_PASSCODE in Project Settings → Script Properties.');
}
