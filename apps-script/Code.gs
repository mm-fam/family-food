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
  ideas: 'Meal Ideas',
  feedback: 'App Feedback',
  products: 'Products',
  jobs: 'Cart Jobs',
};

// Cart Jobs (api 12): a parent taps "Build the cart" / "Check the cart" on a phone; the job waits here until
// Claude's cart runner (a scheduled task on the owner's computer, which has Chrome signed in to the stores)
// picks it up and writes back status + result. Created on first use.
const JOBS_HEAD = ['id', 'at', 'by', 'store', 'kind', 'status', 'started_at', 'finished_at', 'result', 'notes'];
const JOB_STORES = ['GE', 'WF', 'TGT', 'AMZ'];
const JOB_KINDS = ['build', 'check'];
const JOB_OPEN = ['queued', 'running', 'waiting']; // waiting = runner tried, computer/Chrome/sign-in not ready; it retries
const JOB_SHOW_DAYS = 14;

// App Feedback: anything anyone says about the app from the 💡 button in the header (created on first use).
const FEEDBACK_HEAD = ['id', 'at', 'who', 'tab', 'text', 'status', 'notes'];
// Automatic Q&A cards (api 9), made once a day the first time anyone opens the app.
const RATE_OPTIONS = '😍; 🙂; 😐; 👎';
const RATE_BACK_DAYS = 3;      // catch up at most this many days if nobody opened the app
const RATE_NEW_TIMES = 2;      // a meal counts as "new" for its first 3 times (made before ≤ 2)
const RATE_EXPIRE_DAYS = 5;
const RATE_SLOTS = ['dinner', 'breakfast']; // "after breakfast or dinners, if we try something new" (family demo, Nov 1)
const RATE_PER_DAY = 2;    // unanswered "How was it?" cards close after this
const STILL_PER_PERSON = 2;    // "Still eating …?" cards per person per week
const STILL_EVERY_DAYS = 7;
const STILL_REASK_DAYS = 90;
const NON_FOOD = ['Personal care', 'Household', 'Paper & cleaning', 'Other'];

// Stock is an append-only log of "we have it" sightings (created on first use).
const STOCK_HEAD = ['at', 'item_id', 'level', 'expires', 'who', 'source', 'list_id'];
const LEVELS = ['plenty', 'some', 'low', 'out'];
const HOLD_DAYS = 7;
// Meal Ideas: pasted recipes / links / ideas from the app. Claude turns them into Meals rows (created on first use).
const IDEAS_HEAD = ['id', 'at', 'who', 'text', 'status', 'meal_id', 'notes'];
const IDEA_MAX = 6000; // characters kept from a pasted idea
// Dinner-vote emoji → score (4 = love it).
const VOTE_SCORE = { '😍': 4, '🙂': 3, '😐': 2, '👎': 1 };
// Backend version. Bump when the app needs something new from the backend.
// 2 = reviewPass + Review audience; 3 = listHave/listHold; 4 = wanted_by; 5 = itemInfo + stockLog + state.stock;
// 6 = Plan by date (rolling planDays window, planSet {date}); 7 = mealIdea + state.ideas + state.mealStats;
// 8 = meal slots: Plan slot (breakfast/lunch/snack/dinner) + note (e.g. leftovers), Meals kind, planSet {slot, note}.
// 9 = Items store_only, mealRequest (kids ask for a meal; Review type meal_request + asked_by), feedback (App Feedback tab),
//     daily "How was it?" (type rate) and weekly "Still eating?" (type still) cards; kids can't planSet / mealSave.
// 10 = reviewLater: "Later" on a Q&A card is saved (Review later_count + later_at), so put-off cards
//      stay at the back of the deck across days and the morning check can recycle or retire them.
// 11 = products: state.products = the exact product we buy per item per store (Products tab, written by
//      Claude), with aisle when known, for the item screen and In-store aisle order. List rows can carry
//      `cart` (store code) + `cart_at` when Claude put them in a store's online cart (status carted).
// 12 = cart jobs: cartJob {store, kind: build|check} queues a job in the Cart Jobs tab for Claude's cart runner,
//      cartJobCancel {id} cancels a queued one; state.cartJobs = recent jobs with status + result.
const API_VERSION = 12;
const SLOTS = ['breakfast', 'lunch', 'snack', 'dinner']; // blank slot / kind = dinner
const PLAN_DAYS = 14; // Meals tab shows a rolling window: today + the next 13 days.
const PLAN_KEEP_DAYS = 14; // nightly moves Plan rows older than this to Plan Archive.
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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
  // No passcode needed: only says which backend version is live (the deploy workflow checks it).
  if (req.action === 'version') return reply({ ok: true, api: API_VERSION });
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
    reviewLater: () => withLock(() => laterReview(req)),
    listHave: () => withLock(() => listHave(req)),
    listHold: () => withLock(() => listHold(req)),
    requestOrder: () => withLock(() => requestOrder(req)),
    cartJob: () => withLock(() => addCartJob(req)),
    cartJobCancel: () => withLock(() => cancelCartJob(req)),
    itemInfo: () => itemInfo(req),
    stockLog: () => withLock(() => stockLogAction(req)),
    mealIdea: () => withLock(() => addMealIdea(req)),
    mealRequest: () => withLock(() => addMealRequest(req)),
    feedback: () => withLock(() => addFeedback(req)),
  };
  const fn = actions[req.action];
  if (!fn) return reply({ ok: false, error: 'unknown_action' });
  try {
    const out = fn();
    // Every write returns fresh state so the app never has to guess.
    // Reads that don't change anything skip the full state.
    const state = req.action === 'state' || req.action === 'ping' ? out : req.action === 'itemInfo' ? undefined : getState();
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

// Adds a header at the end of a tab if it isn't there yet (new columns always go at the end).
function ensureColumn(name, col) {
  const head = headers(name);
  if (head.indexOf(col) >= 0) return;
  sheet(name).getRange(1, head.length + 1).setValue(col);
}

function setSetting(key, value) {
  const s = readTab(TABS.settings).find((r) => r.key === key);
  if (s) setFields(TABS.settings, s._row, { value: value });
  else appendObj(TABS.settings, { key: key, value: value });
}

function people() {
  const st = settingsMap();
  return String(st.parents || '').split(',').concat(String(st.kids || '').split(',')).map((x) => x.trim()).filter(String);
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
  dailyCards();
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
  const stockLatest = {}; // item_id -> latest sighting { level, at, who }
  if (SpreadsheetApp.getActive().getSheetByName(TABS.stock)) {
    readTab(TABS.stock).forEach((s) => {
      if (s.item_id) stockLatest[s.item_id] = { level: String(s.level), at: String(s.at).slice(0, 10), who: s.who || '' };
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

  const meals = readTab(TABS.meals);

  return {
    api: API_VERSION,
    today: today,
    items: items.map(stripRow),
    list: active.map(stripRow),
    held: held.map(stripRow),
    recent: recent.map(stripRow),
    meals: meals.map(stripRow),
    mealStats: mealStats(meals, today),
    ideas: recentIdeas(today),
    plan: readTab(TABS.plan)
      .map((p) => Object.assign(stripRow(p), { date: planDate(p), slot: planSlot(p) }))
      .filter((p) => p.date && daysBetween(today, p.date) >= 0 && daysBetween(today, p.date) < PLAN_DAYS),
    planDays: PLAN_DAYS,
    weekOf: weekOf(today),
    review: readTab(TABS.review).filter((r) => r.status === 'open').map(stripRow),
    due: due,
    stock: stockLatest,
    products: productsMap(),
    cartJobs: recentCartJobs(today),
    settings: {
      parents: String(settings.parents || '').split(',').map((s) => s.trim()).filter(String),
      kids: String(settings.kids || '').split(',').map((s) => s.trim()).filter(String),
      ge_order_day: settings.ge_order_day || '',
      wf_order_day: settings.wf_order_day || '',
      order_requested: settings.order_requested || '',
      admins: String(settings.admins || '').split(',').map((s) => s.trim()).filter(String),
    },
  };
}

function stripRow(o) {
  const c = Object.assign({}, o);
  delete c._row;
  return c;
}

// Products tab (Claude writes it): the exact product per item per store. For each item + store, keep the
// best row: exact before likely before alt, then the newest last_bought. Returns
// { item_id: { GE: { name, size, aisle } } }. Missing tab = {}.
function productsMap() {
  if (!SpreadsheetApp.getActive().getSheetByName(TABS.products)) return {};
  const rank = { exact: 0, likely: 1, alt: 2 };
  const best = {};
  readTab(TABS.products).forEach((p) => {
    if (!p.item_id || !p.store) return;
    const k = p.item_id + '|' + p.store;
    const r = rank[String(p.match)] === undefined ? 3 : rank[String(p.match)];
    const b = best[k];
    const newer = String(p.last_bought || '') > String((b && b.last_bought) || '');
    if (!b || r < b._r || (r === b._r && newer)) best[k] = Object.assign({ _r: r }, p);
  });
  const out = {};
  Object.keys(best).forEach((k) => {
    const p = best[k];
    out[p.item_id] = out[p.item_id] || {};
    out[p.item_id][p.store] = { name: String(p.product || ''), size: String(p.size || ''), aisle: String(p.aisle || '') };
  });
  return out;
}

// Weeks start on Sunday.
function weekOf(iso) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() - d.getDay());
  return isoDate(d);
}

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

// A Plan row's real date. Rows from before the date column fall back to week_of + day.
function planDate(p) {
  if (p.date) return String(p.date).slice(0, 10);
  const idx = DAY_NAMES.indexOf(String(p.day));
  return p.week_of && idx >= 0 ? addDays(String(p.week_of).slice(0, 10), idx) : '';
}

// A Plan row's meal slot. Rows from before the slot column are dinners.
function planSlot(p) {
  const s = String(p.slot || '').trim().toLowerCase();
  return SLOTS.indexOf(s) >= 0 ? s : 'dinner';
}

// Leftover rows (note starts with "Leftover") don't count as made and add no ingredients.
function isLeftover(p) {
  return /^leftover/i.test(String(p.note || ''));
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
    // Someone else asking for the same thing is recorded by name, not as a silent qty bump,
    // so the family can see "Mike + Joni" and decide whether that means one or two.
    const wanted = wantedList(existing);
    const f = { updated_at: nowStamp() };
    const already = wanted.map((w) => w.toLowerCase()).indexOf(String(req.by).toLowerCase()) >= 0;
    if (!already) f.wanted_by = wanted.concat([req.by]).join(';');
    if (req.bump === true) f.qty = (Number(existing.qty) || 1) + qty;
    setFields(TABS.list, existing._row, f);
    return { id: existing.id, merged: true, already: already };
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
    wanted_by: req.by,
  });
  return { id: id, merged: false };
}

// Everyone who asked for a List row: wanted_by (Mike;Joni), falling back to added_by for older rows.
function wantedList(row) {
  const names = String(row.wanted_by || '').split(';').map((s) => s.trim()).filter(String);
  return names.length ? names : [String(row.added_by || '').trim()].filter(String);
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

// One meal per date and slot (slot defaults to dinner). Older apps send week_of + day instead of date.
// A row can carry a note ("Leftover wraps") with or without a meal.
function setPlan(req) {
  if (isKid(req.by)) throw new Error('Ask a parent to plan it');
  const date = req.date
    ? String(req.date).slice(0, 10)
    : planDate({ week_of: req.week_of || weekOf(isoDate(new Date())), day: req.day });
  if (!date) throw new Error('Plan needs a date');
  const plan = readTab(TABS.plan);
  const slot = SLOTS.indexOf(String(req.slot || '').toLowerCase()) >= 0 ? String(req.slot).toLowerCase() : 'dinner';
  const existing = plan.find((p) => planDate(p) === date && planSlot(p) === slot);
  const fields = { week_of: "'" + weekOf(date), day: DAY_NAMES[new Date(date + 'T12:00:00').getDay()], date: "'" + date };
  if (headers(TABS.plan).indexOf('slot') >= 0) fields.slot = slot;
  const note = req.note === undefined ? null : String(req.note || '');
  if (note !== null && headers(TABS.plan).indexOf('note') >= 0) fields.note = note;
  const keep = req.meal_id || (note !== null ? note : existing && existing.note);
  if (existing) {
    if (!keep) sheet(TABS.plan).deleteRow(existing._row);
    else setFields(TABS.plan, existing._row, Object.assign(fields, { meal_id: req.meal_id || '' }));
  } else if (keep) {
    appendObj(TABS.plan, Object.assign(fields, { meal_id: req.meal_id || '' }));
  }
  return { date: date, day: fields.day, slot: slot };
}

function saveMeal(req) {
  if (isKid(req.by)) throw new Error('Only parents can edit meals');
  const meals = readTab(TABS.meals);
  const ids = (req.item_ids || []).join(';');
  const existing = req.id ? meals.find((m) => m.id === req.id) : null;
  if (existing) {
    const f = { name: req.name || existing.name, item_ids: ids, notes: req.notes || existing.notes };
    if (req.kind && headers(TABS.meals).indexOf('kind') >= 0) f.kind = String(req.kind).toLowerCase();
    setFields(TABS.meals, existing._row, f);
    return { id: existing.id };
  }
  const id = nextId(meals, 'id', 'm', 2);
  const row = { id: id, name: req.name, item_ids: ids, notes: req.notes || '' };
  if (headers(TABS.meals).indexOf('kind') >= 0) row.kind = SLOTS.indexOf(String(req.kind || '').toLowerCase()) >= 0 ? String(req.kind).toLowerCase() : 'dinner';
  appendObj(TABS.meals, row);
  return { id: id };
}

function saveItem(req) {
  if (isKid(req.by)) throw new Error('Only parents can edit items');
  if (!req.id && req.fields && req.fields.name) {
    return { id: createItem(Object.assign({ by: req.by }, req.fields)) };
  }
  const item = readTab(TABS.items).find((it) => it.id === req.id);
  if (!item) throw new Error('Item not found');
  const allowed = ['name', 'store', 'group', 'brand_size', 'ok_swap', 'status', 'notes', 'store_only'];
  const f = {};
  allowed.forEach((k) => req.fields && req.fields[k] !== undefined && (f[k] = req.fields[k]));
  if (f.store_only !== undefined) { f.store_only = /^y/i.test(String(f.store_only)) ? 'Y' : ''; ensureColumn(TABS.items, 'store_only'); }
  setFields(TABS.items, item._row, f);
  return { id: item.id };
}

function answerReview(req) {
  const r = readTab(TABS.review).find((x) => x.id === req.id);
  if (!r) throw new Error('Review item not found');
  setFields(TABS.review, r._row, { answer: req.answer || '', status: 'answered' });
  return { id: r.id };
}

// "Later" on a Q&A card: count it and stamp when, so the card stays at the back of the deck
// (app sorts by later_at) and the morning check can retire cards put off 3+ times.
function laterReview(req) {
  const r = readTab(TABS.review).find((x) => x.id === req.id);
  if (!r) throw new Error('Review item not found');
  ensureColumn(TABS.review, 'later_count');
  ensureColumn(TABS.review, 'later_at');
  setFields(TABS.review, r._row, { later_count: (Number(r.later_count) || 0) + 1, later_at: "'" + nowStamp() });
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

/* ---------------------------------------------------------------- meal ideas + meal stats */

function ideasSheet() {
  let sh = SpreadsheetApp.getActive().getSheetByName(TABS.ideas);
  if (!sh) {
    sh = SpreadsheetApp.getActive().insertSheet(TABS.ideas);
    sh.appendRow(IDEAS_HEAD);
    sh.setFrozenRows(1);
  }
  return sh;
}

// Anyone pastes a recipe, link or idea; Claude reads new rows each morning and makes the meal.
function addMealIdea(req) {
  const text = String(req.text || '').trim().slice(0, IDEA_MAX);
  if (!text) throw new Error('Paste the idea first');
  ideasSheet();
  const id = nextId(readTab(TABS.ideas), 'id', 'x', 3);
  appendObj(TABS.ideas, { id: id, at: nowStamp(), who: req.by || '', text: text, status: 'new', meal_id: '', notes: '' });
  return { id: id };
}

// Ideas still being worked on, plus ones finished in the last 14 days (so people see what happened).
function recentIdeas(today) {
  if (!SpreadsheetApp.getActive().getSheetByName(TABS.ideas)) return [];
  return readTab(TABS.ideas)
    .filter((x) => x.status === 'new' || x.status === 'asked' || daysBetween(String(x.at).slice(0, 10), today) <= 14)
    .slice(-10)
    .map((x) => ({ id: x.id, at: String(x.at).slice(0, 10), who: x.who, text: String(x.text).slice(0, 160), status: x.status, meal_id: x.meal_id, notes: x.notes }));
}

// Per meal: family votes, how often it's been on the plan, next planned date, rough cost.
// Everything is computed from Review, Plan (+ Plan Archive) and Receipts; nothing is typed.
function mealStats(meals, today) {
  const out = {};
  meals.forEach((m) => (out[m.id] = { votes: {}, voters: {}, score: 0, made: 0, last: '', next: '', cost: 0, priced: 0, linked: 0 }));

  // Votes: "Dinner vote: how do you feel about <name>? (mNN)". Latest answer per person wins.
  const byName = {};
  meals.forEach((m) => (byName[String(m.name).toLowerCase()] = m.id));
  readTab(TABS.review).forEach((r) => {
    if ((String(r.type) !== 'vote' && String(r.type) !== 'rate') || !r.answer) return;
    const d = String(r.detail);
    let id = (d.match(/\((m\d{2,})\)/) || [])[1];
    if (!id) { const n = (d.match(/about (.+?)\?/) || [])[1]; id = n && byName[n.toLowerCase()]; }
    if (!id || !out[id]) return;
    const a = String(r.answer).trim();
    const emoji = Object.keys(VOTE_SCORE).find((e) => a.indexOf(e) === 0);
    if (!emoji) return;
    const who = (a.match(/\(([^)]+)\)\s*$/) || [])[1] || r.audience || '?';
    out[id].voters[who] = emoji;
  });

  // Plan history: dates before today count as made; the first date from today on is "next".
  let plan = readTab(TABS.plan);
  if (SpreadsheetApp.getActive().getSheetByName('Plan Archive')) plan = plan.concat(readTab('Plan Archive'));
  plan.forEach((p) => {
    const st = out[p.meal_id]; const d = planDate(p);
    if (!st || !d || isLeftover(p)) return;
    if (d < today) { st.made++; if (d > st.last) st.last = d; }
    else if (!st.next || d < st.next) st.next = d;
  });

  // Cost: latest unit price of each linked ingredient (one of each).
  const price = {};
  readTab(TABS.receipts).forEach((r) => {
    const v = Number(r.price);
    if (!r.item_id || !(v > 0)) return;
    const d = String(r.date).slice(0, 10);
    if (!price[r.item_id] || d >= price[r.item_id].d) price[r.item_id] = { d: d, v: v };
  });
  meals.forEach((m) => {
    const st = out[m.id];
    const ids = String(m.item_ids || '').split(';').filter(String);
    st.linked = ids.length;
    ids.forEach((id) => { if (price[id]) { st.cost += price[id].v; st.priced++; } });
    st.cost = Math.round(st.cost * 100) / 100;
    const vs = Object.keys(st.voters).map((w) => st.voters[w]);
    vs.forEach((e) => (st.votes[e] = (st.votes[e] || 0) + 1));
    st.score = vs.length ? Math.round((vs.reduce((t, e) => t + VOTE_SCORE[e], 0) / vs.length) * 10) / 10 : 0;
  });
  return out;
}

/* ---------------------------------------------------------------- kids' meal requests, app feedback */

// A kid asks for a meal; a parent picks the day (Meals tab → Plan it / Not now).
function addMealRequest(req) {
  const meal = readTab(TABS.meals).find((m) => m.id === req.meal_id);
  if (!meal) throw new Error('Meal not found');
  const slot = SLOTS.indexOf(String(req.slot || '').toLowerCase()) >= 0 ? String(req.slot).toLowerCase() : 'dinner';
  const when = ['this week', 'next week', 'anytime'].indexOf(String(req.when || '').toLowerCase()) >= 0 ? String(req.when).toLowerCase() : 'anytime';
  ensureColumn(TABS.review, 'asked_by');
  const review = readTab(TABS.review);
  const dup = review.find((r) => r.type === 'meal_request' && r.status === 'open' && String(r.asked_by) === String(req.by) && String(r.detail).indexOf('(' + meal.id + ')') >= 0);
  if (dup) return { id: dup.id, already: true };
  const id = nextId(review, 'id', 'r', 3);
  appendObj(TABS.review, {
    id: id, created: nowStamp(), type: 'meal_request', status: 'open', audience: 'parents', asked_by: req.by || '',
    detail: (req.by || 'Someone') + ' wants ' + meal.name + ' for ' + slot + ', ' + when + '. (' + meal.id + ') Options: Plan it; Not now',
  });
  return { id: id };
}

function addFeedback(req) {
  const text = String(req.text || '').trim().slice(0, IDEA_MAX);
  if (!text) throw new Error('Type something first');
  let sh = SpreadsheetApp.getActive().getSheetByName(TABS.feedback);
  if (!sh) { sh = SpreadsheetApp.getActive().insertSheet(TABS.feedback); sh.appendRow(FEEDBACK_HEAD); sh.setFrozenRows(1); }
  const id = nextId(readTab(TABS.feedback), 'id', 'f', 3);
  appendObj(TABS.feedback, { id: id, at: nowStamp(), who: req.by || '', tab: req.tab || '', text: text, status: 'new', notes: '' });
  return { id: id };
}

/* ---------------------------------------------------------------- automatic Q&A cards */

// Once a day, the first time anyone opens the app (no trigger needed):
//  - "How was <meal>?" for each person, the day after a meal that's still new to us (first 3 times),
//  - unanswered ones older than RATE_EXPIRE_DAYS are closed,
//  - once a week, a couple of "Still eating <item>?" cards per person.
function dailyCards() {
  const today = isoDate(new Date());
  const st = settingsMap();
  if (String(st.cards_through || '') >= today) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    if (String(settingsMap().cards_through || '') >= today) return;
    ensureColumn(TABS.review, 'asked_by');
    const everyone = people();
    let review = readTab(TABS.review);
    let n = nextIdNum(review);
    const add = (o) => { appendObj(TABS.review, Object.assign({ id: 'r' + String(n++).padStart(3, '0'), created: nowStamp(), status: 'open', answer: '' }, o)); };

    // Close stale, unanswered "How was it?" cards.
    review.forEach((r) => {
      if (r.type === 'rate' && r.status === 'open' && r.created && daysBetween(String(r.created).slice(0, 10), today) > RATE_EXPIRE_DAYS) {
        setFields(TABS.review, r._row, { status: 'closed' });
      }
    });

    // How was it?
    const meals = readTab(TABS.meals);
    const mealOf = {}; meals.forEach((m) => (mealOf[m.id] = m));
    let plan = readTab(TABS.plan);
    if (SpreadsheetApp.getActive().getSheetByName('Plan Archive')) plan = plan.concat(readTab('Plan Archive'));
    const madeBefore = (id, d) => plan.filter((p) => p.meal_id === id && !isLeftover(p) && planDate(p) && planDate(p) < d).length;
    const from = st.cards_through ? addDays(String(st.cards_through).slice(0, 10), 1) : addDays(today, -1);
    const start = from < addDays(today, -RATE_BACK_DAYS) ? addDays(today, -RATE_BACK_DAYS) : from;
    // Dinners first, then breakfast; at most RATE_PER_DAY cards per person per day so the deck stays fun.
    for (let d = start; d < today; d = addDays(d, 1)) {
      const when = d === addDays(today, -1) ? 'yesterday' : 'on ' + DAY_NAMES[new Date(d + 'T12:00:00').getDay()];
      const rows = plan.filter((p) => planDate(p) === d && p.meal_id && mealOf[p.meal_id] && !isLeftover(p) && RATE_SLOTS.indexOf(planSlot(p)) >= 0)
        .filter((p) => madeBefore(p.meal_id, d) <= RATE_NEW_TIMES) // only meals still new to us
        .sort((a, b) => RATE_SLOTS.indexOf(planSlot(a)) - RATE_SLOTS.indexOf(planSlot(b)));
      everyone.forEach((who) => {
        let given = 0;
        rows.forEach((p) => {
          if (given >= RATE_PER_DAY) return;
          const open = review.some((r) => r.type === 'rate' && r.status === 'open' && String(r.audience) === who && String(r.detail).indexOf('(' + p.meal_id + ')') >= 0);
          if (open) return;
          const slot = planSlot(p);
          add({ type: 'rate', audience: who, detail: 'How was ' + mealOf[p.meal_id].name + ' ' + when + (slot === 'dinner' ? '' : ' (' + slot + ')') + '? (' + p.meal_id + ') Options: ' + RATE_OPTIONS });
          review.push({ type: 'rate', status: 'open', audience: who, detail: '(' + p.meal_id + ')' });
          given++;
        });
      });
    }

    // Still eating? Weekly, a couple per person, from things we buy regularly.
    if (!st.still_through || daysBetween(String(st.still_through).slice(0, 10), today) >= STILL_EVERY_DAYS) {
      const items = readTab(TABS.items).filter((i) => i.status !== 'Drop' && Number(i.orders) >= 2 && NON_FOOD.indexOf(String(i.group)) < 0);
      everyone.forEach((who, k) => {
        const recent = {};
        review.forEach((r) => {
          if (r.type === 'still' && String(r.audience) === who && r.created && daysBetween(String(r.created).slice(0, 10), today) <= STILL_REASK_DAYS) {
            const m = String(r.detail).match(/\((i\d{3,})\)/); if (m) recent[m[1]] = true;
          }
        });
        const pool = items.filter((i) => !recent[i.id]);
        // Rotate through the pool by week and person, so each person gets different ones.
        const wk = Math.floor(new Date(today + 'T12:00:00').getTime() / (7 * 86400000));
        for (let j = 0; j < Math.min(STILL_PER_PERSON, pool.length); j++) {
          const it = pool[(wk * 7 + k * 3 + j * 11) % pool.length];
          if (recent[it.id]) continue;
          recent[it.id] = true;
          add({ type: 'still', audience: who, detail: 'Still eating ' + it.name + '? (' + it.id + ') Options: Yes; No' });
        }
      });
      setSetting('still_through', "'" + today);
    }
    setSetting('cards_through', "'" + today);
  } finally {
    lock.releaseLock();
  }
}

function nextIdNum(rows) {
  let max = 0;
  rows.forEach((r) => { const v = parseInt(String(r.id).replace(/^r/, ''), 10); if (!isNaN(v) && v > max) max = v; });
  return max + 1;
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

// History for one item (the app's item screen): purchases, "at home" sightings, answered questions.
function itemInfo(req) {
  const id = String(req.item_id || '');
  if (!id) throw new Error('Missing item');
  const purchases = readTab(TABS.receipts)
    .filter((r) => r.item_id === id)
    .map((r) => ({ date: String(r.date).slice(0, 10), store: r.store, price: r.price, qty: r.qty }))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 6);
  const stock = SpreadsheetApp.getActive().getSheetByName(TABS.stock)
    ? readTab(TABS.stock).filter((s) => s.item_id === id).slice(-4).reverse()
      .map((s) => ({ at: String(s.at).slice(0, 10), level: String(s.level), who: s.who || '' }))
    : [];
  const tag = '(' + id + ')';
  const answers = readTab(TABS.review)
    .filter((r) => String(r.detail).indexOf(tag) >= 0 && String(r.answer || '').trim() && String(r.answer).indexOf('skip') !== 0)
    .slice(-5).reverse()
    .map((r) => ({ q: String(r.detail).replace(/\s*Options:[\s\S]*$/, '').replace(/\s*\(i\d{3,}\)/g, ''), answer: String(r.answer) }));
  return { item_id: id, purchases: purchases, stock: stock, answers: answers };
}

// "We have some" from the item screen when it isn't on the List: just log the sighting.
function stockLogAction(req) {
  const level = cleanLevel(req.level);
  if (!req.item_id || !level) throw new Error('Missing item or amount');
  logStock({ item_id: req.item_id, level: level, who: req.by, source: 'shop' });
  return { item_id: req.item_id, level: level };
}

function requestOrder(req) {
  const s = readTab(TABS.settings).find((r) => r.key === 'order_requested');
  const value = req.store ? req.store + ' requested by ' + req.by + ' at ' + nowStamp() : '';
  if (s) setFields(TABS.settings, s._row, { value: value });
  else appendObj(TABS.settings, { key: 'order_requested', value: value });
  return { order_requested: value };
}

/* ---------------------------------------------------------------- cart jobs (api 12) */

function jobsSheet() {
  let sh = SpreadsheetApp.getActive().getSheetByName(TABS.jobs);
  if (!sh) { sh = SpreadsheetApp.getActive().insertSheet(TABS.jobs); sh.appendRow(JOBS_HEAD); sh.setFrozenRows(1); }
  return sh;
}

// Parents only. One open job per store + kind: asking again returns the one already waiting.
function addCartJob(req) {
  if (isKid(req.by)) throw new Error('Ask a parent to do this');
  const store = String(req.store || '').toUpperCase();
  const kind = String(req.kind || 'build').toLowerCase();
  if (JOB_STORES.indexOf(store) < 0) throw new Error('Unknown store');
  if (JOB_KINDS.indexOf(kind) < 0) throw new Error('Unknown job');
  jobsSheet();
  const rows = readTab(TABS.jobs);
  const open = rows.find((r) => r.store === store && r.kind === kind && JOB_OPEN.indexOf(String(r.status)) >= 0);
  if (open) return { id: open.id, already: true };
  const id = nextId(rows, 'id', 'c', 3);
  appendObj(TABS.jobs, { id: id, at: nowStamp(), by: req.by || '', store: store, kind: kind, status: 'queued' });
  return { id: id };
}

function cancelCartJob(req) {
  if (isKid(req.by)) throw new Error('Ask a parent to do this');
  if (!SpreadsheetApp.getActive().getSheetByName(TABS.jobs)) throw new Error('No such job');
  const row = readTab(TABS.jobs).find((r) => r.id === req.id);
  if (!row) throw new Error('No such job');
  if (String(row.status) === 'running') throw new Error('Claude is already working on it');
  if (JOB_OPEN.indexOf(String(row.status)) < 0) return { id: row.id, status: row.status };
  setFields(TABS.jobs, row._row, { status: 'cancelled', finished_at: nowStamp(), notes: 'Cancelled by ' + (req.by || 'someone') });
  return { id: row.id, status: 'cancelled' };
}

function recentCartJobs(today) {
  if (!SpreadsheetApp.getActive().getSheetByName(TABS.jobs)) return [];
  return readTab(TABS.jobs)
    .filter((r) => JOB_OPEN.indexOf(String(r.status)) >= 0 || daysBetween(String(r.at).slice(0, 10), today) <= JOB_SHOW_DAYS)
    .map((r) => ({ id: r.id, at: String(r.at), by: r.by, store: r.store, kind: r.kind, status: String(r.status),
      started_at: String(r.started_at || ''), finished_at: String(r.finished_at || ''), result: String(r.result || '') }))
    .reverse()
    .slice(0, 12);
}

/* ---------------------------------------------------------------- nightly + setup */

// Runs nightly: moves bought/skipped List rows older than 14 days to List Archive,
// and past Plan rows older than PLAN_KEEP_DAYS to Plan Archive.
function nightly() {
  withLock(() => {
    archivePlan();
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

function archivePlan() {
  const sh = sheet(TABS.plan);
  const head = headers(TABS.plan);
  const today = isoDate(new Date());
  let archive = SpreadsheetApp.getActive().getSheetByName('Plan Archive');
  if (!archive) {
    archive = SpreadsheetApp.getActive().insertSheet('Plan Archive');
    archive.appendRow(head);
  } else if (archive.getLastColumn() < head.length) {
    archive.getRange(1, 1, 1, head.length).setValues([head]); // new Plan columns (slot, note) reach the archive too
  }
  readTab(TABS.plan)
    .filter((p) => planDate(p) && daysBetween(planDate(p), today) > PLAN_KEEP_DAYS)
    .sort((a, b) => b._row - a._row)
    .forEach((p) => {
      archive.appendRow(head.map((h) => (h === 'date' ? "'" + planDate(p) : h === 'week_of' ? "'" + String(p.week_of) : p[h])));
      sh.deleteRow(p._row);
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
