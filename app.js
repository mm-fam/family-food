/* Poppy 2.0 — phone app. Plain JS, no build step. */
(function () {
  'use strict';

  /* ------------------------------------------------------------ storage */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } },
  };

  const STORES = {
    GE: { name: 'Giant Eagle', cls: 'ge', short: 'GE' },
    WF: { name: 'Whole Foods', cls: 'wf' },
    TGT: { name: 'Target', cls: 'tgt' },
    AMZ: { name: 'Amazon', cls: 'amz' },
    Either: { name: 'Either grocery store', cls: 'either' },
  };
  const STORE_ORDER = ['GE', 'WF', 'TGT', 'AMZ', 'Either'];
  const CART_STORES = ['GE', 'WF', 'TGT', 'AMZ'];
  // "Either" means Giant Eagle or Whole Foods. Target is always picked on purpose.
  const takesEither = (code) => code === 'GE' || code === 'WF';
  const GROUPS = ['Produce', 'Dairy', 'Cheese & deli', 'Meat', 'Bakery', 'Breakfast', 'Snacks', 'Pantry', 'Frozen',
    'Personal care', 'Household', 'Paper & cleaning', 'Other'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const POLL_MS = 20000;

  const S = {
    pass: store.get('ff_pass') || '',
    me: store.get('ff_me') || '',
    data: null,
    tab: ({ need: 'list', staples: 'shop', order: 'list' })[store.get('ff_tab')] || store.get('ff_tab') || 'list',
    instore: store.get('ff_instore') || '', // In-store mode on the List: store being shopped (GE / WF / TGT / all); '' = at home
    shopFilter: 'all', // Shop tab smart filter
    shopStore: 'all',  // Shop tab store filter
    storeFilter: 'all',
    editMode: false,
    query: '',
    staplesQuery: '',
    openDay: null,
    mealPick: {},      // date -> { itemId: true/false } (need it?)
    mealSort: 'az',    // Our meals order: az / top / cost / stale
    sheet: null,       // bottom sheet { type, ...draft }
    toast: null,
    setupError: '',
    loading: false,    // first unlock in progress
    bootError: '',     // saved passcode, but the first load failed
    slow: false,       // first load is taking a while (Apps Script waking up)
  };

  let seq = 0;
  let applied = 0;

  /* ------------------------------------------------------------ api */
  function apiUrl() { return (window.FF_CONFIG && window.FF_CONFIG.API_URL) || ''; }

  // Writes in flight. A plain state read that started before (or during) a write can come back
  // with the old data and flash it for a second (Nov 1 demo: an approved request popped back up),
  // so reads are ignored while a write is pending and anything older than the last write is dropped.
  let writing = 0;
  let lastWrite = 0;
  const READS = { state: 1, ping: 1, itemInfo: 1 };
  async function api(action, payload) {
    const mine = ++seq;
    const isWrite = !READS[action];
    if (isWrite) { writing++; lastWrite = mine; }
    const body = Object.assign({ action: action, pass: S.pass, by: S.me }, payload || {});
    try {
      // text/plain keeps this a "simple" request, so Apps Script needs no CORS preflight.
      const res = await fetch(apiUrl(), { method: 'POST', body: JSON.stringify(body) });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || 'Something went wrong');
      const stale = mine < lastWrite || (!isWrite && writing > 0);
      if (j.state && mine >= applied && !(stale && S.data)) { applied = mine; S.data = j.state; }
      return j;
    } finally { if (isWrite) writing--; }
  }

  async function refresh() {
    if (!S.pass || !apiUrl() || !S.data) return; // before the first load, firstLoad() owns the screen
    try { await api('state'); if (!S.dragging) render(); }
    catch (e) { handleError(e); }
  }

  function handleError(e) {
    const msg = String(e && e.message || e);
    if (msg === 'wrong_passcode') {
      S.pass = ''; store.del('ff_pass'); S.setupError = 'That passcode didn’t work.'; render(); return;
    }
    showToast(msg === 'Failed to fetch' ? 'Can’t reach the server. Check your connection.' : msg);
    render();
  }

  // Apply a change locally right away, then send it. Server state replaces ours when it answers.
  async function act(action, payload, optimistic, toastMsg, undo) {
    if (toastMsg) showToast(toastMsg, undo);
    if (optimistic) optimistic();
    render();
    try { await api(action, payload); render(); }
    catch (e) { handleError(e); refresh(); }
  }

  /* ------------------------------------------------------------ data helpers */
  const D = () => S.data || { items: [], list: [], held: [], recent: [], meals: [], plan: [], review: [], due: [], stock: {}, mealStats: {}, ideas: [], settings: { parents: [], kids: [] } };
  const itemById = (id) => D().items.find((i) => i.id === id);
  const mealById = (id) => D().meals.find((m) => m.id === id);
  const listRowFor = (itemId) => D().list.find((r) => r.item_id === itemId);
  const isKid = (name) => D().settings.kids.map((k) => k.toLowerCase()).indexOf(String(name || '').toLowerCase()) >= 0;
  const amParent = () => !isKid(S.me);
  // Admin screen (cart requests, behind-the-scenes): Settings "admins", else the first parent.
  const isAdmin = () => {
    const a = (D().settings.admins && D().settings.admins.length) ? D().settings.admins : D().settings.parents.slice(0, 1);
    return a.map((x) => x.toLowerCase()).indexOf(String(S.me).toLowerCase()) >= 0;
  };
  // Everyone who asked for a row (wanted_by "Mike;Joni"), falling back to added_by.
  const wantedBy = (r) => {
    const w = String(r.wanted_by || '').split(';').map((x) => x.trim()).filter(String);
    return w.length ? w : [r.added_by].filter(Boolean);
  };
  const iWant = (r) => wantedBy(r).map((x) => x.toLowerCase()).indexOf(String(S.me).toLowerCase()) >= 0;
  const nowIso = () => {
    const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  };
  const storeOf = (code) => STORES[code] || STORES.Either;
  const mealItems = (meal) => String(meal && meal.item_ids || '').split(';').filter(Boolean);
  const tmpId = () => 'tmp' + Date.now() + Math.floor(Math.random() * 1000);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------- search: every word, across name, brand, aisle and receipt aliases ---------- */
  // "breakfast sandwiches" finds things in the Breakfast aisle and anything called a sandwich.
  const stem = (w) => w.replace(/(ies)$/, 'y').replace(/(sses|shes|ches|xes)$/, (m) => m.slice(0, -2)).replace(/([^s])s$/, '$1');
  const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9&' ]+/g, ' ').split(/\s+/).filter(Boolean).map(stem);
  function itemWords(i) {
    return words([i.name, i.brand_size, i.group, String(i.aliases || '').replace(/;/g, ' ')].join(' '));
  }
  // Score = how many query words an item matches (word starts, so "turk" finds turkey). 0 = no match.
  function matchScore(i, qw) {
    if (!qw.length) return 0;
    const iw = itemWords(i);
    return qw.filter((w) => iw.some((x) => x.indexOf(w) === 0 || (w.length >= 4 && x.indexOf(w) >= 0))).length;
  }
  // Items that match every word; if none do, the closest ones (most words matched).
  function findItems(q, pool) {
    const qw = words(q);
    if (!qw.length) return { all: true, hits: pool };
    const scored = pool.map((i) => ({ i: i, s: matchScore(i, qw) })).filter((x) => x.s > 0);
    const full = scored.filter((x) => x.s === qw.length);
    const use = full.length ? full : scored;
    const best = use.length ? Math.max.apply(null, use.map((x) => x.s)) : 0;
    return { all: !!full.length, hits: use.filter((x) => full.length || x.s === best).map((x) => x.i) };
  }

  function searchItems(q, limit) {
    const n = q.trim().toLowerCase();
    if (!n) return [];
    const hits = findItems(n, D().items.filter((i) => i.status !== 'Drop')).hits.slice();
    hits.sort((a, b) => {
      const as = String(a.name).toLowerCase().indexOf(n) === 0 ? 0 : 1;
      const bs = String(b.name).toLowerCase().indexOf(n) === 0 ? 0 : 1;
      return as - bs || (Number(b.orders) || 0) - (Number(a.orders) || 0);
    });
    return hits.slice(0, limit || 6);
  }

  /* ---------- plan dates (rolling window; one dinner per date) ---------- */
  function addDays(iso, n) {
    const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  const dayName = (iso) => DAYS[new Date(String(iso).slice(0, 10) + 'T12:00:00').getDay()];
  const md = (iso) => { const d = new Date(String(iso).slice(0, 10) + 'T12:00:00'); return (d.getMonth() + 1) + '/' + d.getDate(); };
  // Backend api 6 sends date; older backends send week_of + day.
  function planDate(p) {
    if (p.date) return String(p.date).slice(0, 10);
    const idx = DAYS.indexOf(p.day);
    return p.week_of && idx >= 0 ? addDays(p.week_of, idx) : '';
  }
  function planDates() {
    const n = D().planDays || 14;
    return Array.from({ length: n }, (_, i) => addDays(D().today, i));
  }
  // Meal slots (api 8). Plan rows and meals without one are dinners.
  const SLOTS = [['breakfast', 'Breakfast', '🥣'], ['lunch', 'Lunch', '🥪'], ['snack', 'Snack', '🍎'], ['dinner', 'Dinner', '🍽']];
  const canSlots = () => Number(D().api || 0) >= 8;
  const slotOf = (p) => { const v = String(p.slot || '').toLowerCase(); return SLOTS.some((x) => x[0] === v) ? v : 'dinner'; };
  const kindOf = (m) => { const v = String((m && m.kind) || '').toLowerCase(); return SLOTS.some((x) => x[0] === v) ? v : 'dinner'; };
  const slotLabel = (k) => (SLOTS.find((x) => x[0] === k) || SLOTS[3])[1];
  const slotIcon = (k) => (SLOTS.find((x) => x[0] === k) || SLOTS[3])[2];
  const isLeftover = (p) => /^leftover/i.test(String(p.note || ''));
  // date -> meal_id for one slot (dinner by default).
  function planByDate(slot) {
    const want = slot || 'dinner';
    const m = {};
    D().plan.forEach((p) => { const d = planDate(p); if (d && slotOf(p) === want && p.meal_id) m[d] = p.meal_id; });
    return m;
  }
  // The rows planned on one date, by slot.
  function planDay(date) {
    const o = {};
    D().plan.forEach((p) => { if (planDate(p) === date) o[slotOf(p)] = p; });
    return o;
  }
  // What a plan row says: the meal's name, "Leftover <meal>" or its note.
  function planText(p) {
    if (!p) return '';
    const m = mealById(p.meal_id || '');
    if (isLeftover(p)) return m ? 'Leftover ' + m.name : String(p.note);
    return m ? m.name : String(p.note || '');
  }

  function shortDay(iso) {
    const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
    return isNaN(d) ? '' : DAYS[d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate();
  }

  // Pulls the last "had …" from a row note, e.g. "had 6 (Joni)" → "6".
  function haveLevel(r) {
    const m = String(r.note || '').match(/had ([^;(]+?)\s*(\(|;|$)/g);
    if (!m) return '';
    const last = m[m.length - 1].replace(/^had\s*/, '').replace(/[\s(;]+$/, '');
    return levelText(last.trim());
  }

  function daysAgo(iso) {
    if (!iso) return '';
    const d = Math.round((new Date(D().today + 'T12:00:00') - new Date(String(iso).slice(0, 10) + 'T12:00:00')) / 86400000);
    if (d <= 0) return 'today';
    if (d === 1) return 'yesterday';
    return d + ' days ago';
  }

  /* ------------------------------------------------------------ actions */
  function addItem(item, extra) {
    const held = D().held || [];
    const existing = listRowFor(item.id) || held.find((r) => r.item_id === item.id);
    if (existing) {
      const isHeld = held.indexOf(existing) >= 0;
      if (iWant(existing) && !isHeld) { showToast(item.name + ' is already on the list'); return; }
      const others = wantedBy(existing).filter((w) => w.toLowerCase() !== String(S.me).toLowerCase());
      act('add', { item_id: item.id, qty: 1 }, () => {
        if (!iWant(existing)) existing.wanted_by = wantedBy(existing).concat([S.me]).join(';');
        if (isHeld) { D().held = held.filter((r) => r !== existing); D().list.push(existing); }
      }, isHeld ? item.name + ' is back on the list' : others.join(' + ') + ' already asked. Added you too.');
      return;
    }
    const status = isKid(S.me) ? 'requested' : 'needed';
    const row = Object.assign({ id: tmpId(), item_id: item.id, name: item.name, store: item.store || 'Either', qty: 1, note: '', added_by: S.me, wanted_by: S.me, status: status }, extra || {});
    act('add', { item_id: item.id, qty: row.qty, meal_id: row.meal_id || '' }, () => { D().list.push(row); },
      status === 'requested' ? 'Asked for ' + item.name : 'Added ' + item.name);
  }

  function addNew(name, storeCode) {
    const clean = name.trim();
    if (!clean) return;
    const known = D().items.find((i) => String(i.name).toLowerCase() === clean.toLowerCase());
    if (known) { addItem(known); return; }
    const status = isKid(S.me) ? 'requested' : 'needed';
    act('add', { name: clean, store: storeCode || 'Either' }, () => {
      D().list.push({ id: tmpId(), item_id: '', name: clean, store: storeCode || 'Either', qty: 1, added_by: S.me, wanted_by: S.me, status: status });
    }, (status === 'requested' ? 'Asked for ' : 'Added ') + clean);
  }

  function setStatus(row, status, msg) {
    const before = row.status;
    act('update', { id: row.id, fields: { status: status } }, () => {
      row.status = status;
      if (status === 'bought' || status === 'skipped' || status === 'have') {
        D().list = D().list.filter((r) => r !== row);
        D().recent.push(Object.assign({}, row, { status: status, updated_at: nowIso() }));
        if (msg && !S.instore) fadeRow(row, status === 'bought' ? 'Bought (' + S.me + ')' : before === 'requested' ? 'Skipped' : 'Taken off', before);
      }
    }, msg, msg && (status === 'bought' || status === 'skipped') ? () => restore(row, before) : null);
  }

  function restore(row, status) {
    const to = status || 'needed';
    delete S.fading[row.id];
    act('update', { id: row.id, fields: { status: to } }, () => {
      D().recent = D().recent.filter((r) => r.id !== row.id);
      D().list = D().list.filter((r) => r.id !== row.id);
      D().list.push(Object.assign({}, row, { status: to }));
    }, 'Back on the list');
  }

  const LEVEL_LABEL = { plenty: 'plenty', some: 'some', low: 'a little' };
  const levelText = (lv) => (/^\d+$/.test(String(lv)) ? String(lv) : (LEVEL_LABEL[lv] || lv));

  // We already have it at home: nothing bought, sighting logged.
  function markHave(row, level) {
    const before = row.status;
    act('listHave', { id: row.id, level: level }, () => {
      D().list = D().list.filter((r) => r !== row);
      D().recent.push(Object.assign({}, row, { status: 'have', note: 'had ' + level, updated_at: D().today }));
      fadeRow(row, 'We have ' + levelText(level) + ' (' + S.me + ')', before);
    }, 'Off the list: we have ' + levelText(level), () => restore(row, before));
  }

  // A row that just left the List stays in place for a few seconds, crossed out, with Undo,
  // so nobody wonders where it went (Nov 1 family demo: it "just disappeared").
  S.fading = {};
  function fadeRow(row, label, before) {
    S.fading[row.id] = { row: Object.assign({}, row), label: label, before: before || 'needed', until: Date.now() + 6000 };
    setTimeout(() => { if (S.fading[row.id] && S.fading[row.id].until <= Date.now()) { delete S.fading[row.id]; render(); } }, 6100);
  }
  const fadingRows = () => Object.keys(S.fading).map((k) => S.fading[k]).filter((f) => f.until > Date.now() && !D().list.some((r) => r.id === f.row.id));

  // Not needed this run: hide it for a week, then it comes back.
  function holdRow(row, level) {
    act('listHold', { id: row.id, level: level || '' }, () => {
      D().list = D().list.filter((r) => r !== row);
      (D().held = D().held || []).push(Object.assign({}, row));
    }, row.name + ' moved to next week', () => unhold(row));
  }

  function unhold(row) {
    act('update', { id: row.id, fields: { hold_until: '' } }, () => {
      D().held = (D().held || []).filter((r) => r.id !== row.id);
      D().list = D().list.filter((r) => r.id !== row.id);
      D().list.push(Object.assign({}, row, { hold_until: '' }));
    }, 'Back on the list');
  }

  /* ------------------------------------------------------------ toast */
  let toastTimer = null;
  function showToast(text, undo) {
    S.toast = { text: text, undo: undo || null };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { S.toast = null; render(); }, undo ? 5000 : 2600);
  }

  /* ------------------------------------------------------------ views */
  function render() {
    const root = document.getElementById('app');
    const focus = captureFocus();
    const scrolls = {};
    root.querySelectorAll('[data-keep-scroll]').forEach((el) => { if (el.id) scrolls[el.id] = el.scrollLeft; });
    if (!apiUrl()) root.innerHTML = viewNoBackend();
    else if (S.pass && !S.data) root.innerHTML = viewLoading();
    else if (!S.pass) root.innerHTML = viewSetup();
    else if (!S.me) root.innerHTML = viewPickPerson();
    else root.innerHTML = viewApp();
    Object.keys(scrolls).forEach((id) => { const el = document.getElementById(id); if (el) el.scrollLeft = scrolls[id]; });
    restoreFocus(focus);
  }

  function captureFocus() {
    const el = document.activeElement;
    if (!el || !el.id) return null;
    return { id: el.id, start: el.selectionStart, end: el.selectionEnd };
  }
  function restoreFocus(f) {
    if (!f) return;
    const el = document.getElementById(f.id);
    if (!el) return;
    el.focus();
    try { if (f.start != null) el.setSelectionRange(f.start, f.end); } catch (e) { /* not a text field */ }
  }

  function viewNoBackend() {
    return '<div class="setup"><img class="setup-logo" src="icons/poppy-logo.png" alt="Poppy 2.0" width="120" height="120"><h1>Poppy 2.0</h1><p class="note">The app isn’t connected to its Google Sheet yet. Add the Apps Script URL to <b>config.js</b> (see the README).</p></div>';
  }

  // Shown while the first state loads: right after Unlock, and on every return visit (saved passcode).
  function viewLoading() {
    const msg = S.bootError ? '' :
      '<div class="spinner" aria-hidden="true"></div>' +
      '<p class="note" role="status">' + (S.loading ? 'Checking the passcode…' : 'Getting the list…') + '</p>' +
      (S.slow ? '<p class="note small">Still working. The server takes a few seconds to wake up after a quiet spell.</p>' : '');
    const err = S.bootError ?
      '<div class="error">' + esc(S.bootError) + '</div>' +
      '<button class="btn btn-primary btn-block" data-act="boot-retry">Try again</button>' : '';
    return '<div class="setup loading-screen">' +
      '<img class="setup-logo' + (S.bootError ? '' : ' pulse') + '" src="icons/poppy-logo.png" alt="Poppy 2.0" width="120" height="120">' +
      '<div><div class="eyebrow">Poppy 2.0</div></div>' + msg + err + '</div>';
  }

  // First load of state (return visit or right after Unlock). Shows a "still working" hint after 4 s.
  async function firstLoad() {
    S.bootError = ''; S.slow = false; render();
    const t = setTimeout(() => { if (!S.data) { S.slow = true; render(); } }, 4000);
    try { await api('state'); return true; }
    catch (e) {
      const msg = String(e && e.message || e);
      if (msg === 'wrong_passcode') {
        S.pass = ''; store.del('ff_pass'); S.setupError = 'That passcode didn’t work.';
      } else {
        S.bootError = msg === 'Failed to fetch' ? 'Couldn’t reach the server. Check your connection.' : 'Couldn’t load the list (' + msg + ').';
      }
      return false;
    } finally { clearTimeout(t); S.slow = false; render(); }
  }

  function viewSetup() {
    return '<form class="setup" data-form="unlock">' +
      '<img class="setup-logo" src="icons/poppy-logo.png" alt="Poppy 2.0" width="120" height="120">' +
      '<div><div class="eyebrow">Welcome to</div><h1>Poppy 2.0</h1></div>' +
      '<p class="note">Enter the family passcode. You only do this once on each phone.</p>' +
      '<label class="sr" for="pass">Family passcode</label>' +
      '<input id="pass" class="field" type="password" autocomplete="current-password" placeholder="Family passcode" value="">' +
      (S.setupError ? '<div class="error">' + esc(S.setupError) + '</div>' : '') +
      '<button class="btn btn-primary btn-block" type="submit"' + (S.loading ? ' disabled' : '') + '>' + (S.loading ? 'Checking…' : 'Unlock') + '</button>' +
      '</form>';
  }

  function viewPickPerson() {
    const people = D().settings.parents.concat(D().settings.kids);
    return '<div class="setup">' +
      '<img class="setup-logo" src="icons/poppy-logo.png" alt="Poppy 2.0" width="120" height="120">' +
      '<div><div class="eyebrow">Poppy 2.0</div><h1>Who’s this?</h1></div>' +
      '<p class="note">Pick your name so everyone knows who added what.</p>' +
      '<div class="people">' + people.map((p) => '<button data-act="pick-me" data-name="' + esc(p) + '">' + esc(p) + '</button>').join('') + '</div></div>';
  }

  function viewApp() {
    if (S.tab === 'order') S.tab = 'admin';
    if (S.tab === 'need') S.tab = 'list';
    if (S.tab === 'admin' && !isAdmin()) S.tab = 'list';
    const instore = S.tab === 'list' && S.instore;
    const n = D().list.filter((r) => r.status !== 'requested').length;
    const titles = { list: 'List', shop: 'Shop', meals: 'Meals', ask: 'Inbox', admin: 'Behind the scenes' };
    const eyebrows = { list: n + ' on the list', shop: 'Add to the List', meals: 'Next 2 weeks', ask: inboxEyebrow(), admin: 'Just for ' + S.me };
    const title = instore ? 'In store' : titles[S.tab];
    const eyebrow = instore ? (S.instore === 'all' ? 'Every store' : storeOf(S.instore).name) : eyebrows[S.tab];
    let right = '';
    if (instore) right = '<button class="btn btn-primary shop-done" data-act="store-done">Done</button>';
    else {
      if (S.tab === 'list') right += '<button class="btn btn-outline shop-btn" data-act="store-start">🛒 In store</button>';
      if (canV9()) right += '<button class="gear idea-btn" data-act="open-feedback" aria-label="Idea or feedback about the app">💡</button>';
      if (isAdmin()) right += '<button class="gear' + (S.tab === 'admin' ? ' on' : '') + '" data-act="tab" data-tab="' + (S.tab === 'admin' ? 'list' : 'admin') + '" aria-label="Behind the scenes">⚙</button>';
      right += '<button class="me" data-act="switch-me" aria-label="Switch person">' + esc(S.me) + '</button>';
    }
    let top = '<header class="top"><div class="top-row"><div><div class="eyebrow">' + esc(eyebrow) + '</div><h1>' + title + '</h1></div>' +
      '<div class="top-right">' + right + '</div></div>';
    if (instore) top += viewStorePicker();
    else if (S.tab === 'shop') top += viewShopTop();
    top += '</header>';

    let body = '';
    if (S.tab === 'list') body = instore ? viewInStore() : viewList();
    if (S.tab === 'shop') body = viewShop();
    if (S.tab === 'meals') body = viewMeals();
    if (S.tab === 'ask') body = viewAsk();
    if (S.tab === 'admin') body = viewOrder();

    return top + '<main>' + body + '</main>' + viewNav() + viewSheet() + viewToast();
  }

  function viewNav() {
    const req = D().list.filter((r) => r.status === 'requested').length;
    const review = myQuestions().length + myApprovals();
    // List badge = everything still on the list (held "Next week" rows live in D().held, so they don't count).
    // Green for a count; orange when a parent has kids' requests waiting.
    const onList = D().list.filter((r) => r.status === 'requested' || r.status === 'needed' || r.status === 'carted').length;
    const tab = (id, label, badge, cls) => '<button data-act="tab" data-tab="' + id + '" class="' + (S.tab === id ? 'on' : '') + '">' + esc(label) +
      (badge ? '<span class="dot' + (cls ? ' ' + cls : '') + '">' + badge + '</span>' : '') + '</button>';
    return '<nav class="tabs" aria-label="Sections"><div class="inner">' +
      tab('list', S.instore ? 'In store' : 'List', onList, amParent() && req ? '' : 'count') + tab('shop', 'Shop') + tab('meals', 'Meals') + tab('ask', 'Inbox', review) +
      '</div></nav>';
  }

  function viewToast() {
    // Inside a sheet only the meal card shows toasts (so planning a night can be undone); they sit at the top there.
    if (!S.toast || (S.sheet && ['mealcard', 'hearth', 'day'].indexOf(S.sheet.type) < 0)) return '';
    return '<div class="toast' + (S.sheet ? ' top' : '') + '" role="status"><span>' + esc(S.toast.text) + '</span>' + (S.toast.undo ? '<button data-act="undo">Undo</button>' : '') + '</div>';
  }

  /* ---------- list ---------- */
  // Accordions: { 's:GE': true (closed), 'g:GE:Dairy': false (open), ... }. Everything starts folded
  // each time the app opens (stores and aisles show a one-line peek); what you open stays open until you leave.
  S.closed = {};
  store.del('ff_closed'); // older versions remembered folds across launches
  const isClosed = (key) => (key in S.closed ? !!S.closed[key] : true);
  function setClosed(key, v) { S.closed[key] = v; }

  const groupOf = (r) => { const it = itemById(r.item_id); return (it && it.group) || 'Other'; };
  const groupsIn = (rows) => GROUPS.concat(Array.from(new Set(rows.map(groupOf))).filter((g) => GROUPS.indexOf(g) < 0))
    .filter((g) => rows.some((r) => groupOf(r) === g));

  // "Mike + Joni": who asked. Two or more names are highlighted so a double ask gets a second look.
  function whoHtml(r) {
    const names = wantedBy(r);
    if (!names.length) return '';
    const many = names.length > 1;
    const kid = !many && isKid(names[0]);
    return '<span class="who-names' + (many ? ' many' : '') + (kid ? ' kid' : '') + '" title="Asked by ' + esc(names.join(', ')) + '">' + esc(names.join(' + ')) + '</span>';
  }

  function mealTag(r) {
    const m = r && r.meal_id && mealById(r.meal_id);
    return m ? '<span class="meal-tag">🍽 ' + esc(m.name) + '</span>' : '';
  }

  function rowMeta(r) {
    const meta = [];
    if (Number(r.qty) > 1) meta.push('×' + r.qty);
    if (r.note) meta.push(esc(r.note));
    return meta;
  }

  // Store-only items (Items.store_only = Y): the one thing about stores the List still shows loudly.
  const storeOnly = (r) => { const it = itemById(r.item_id); return !!(it && /^y/i.test(String(it.store_only || '')) && it.store && it.store !== 'Either'); };
  const onlyAt = (r) => (storeOnly(r) ? itemById(r.item_id).store : '');
  function storeMark(r) {
    const code = onlyAt(r);
    if (code) return '<span class="only-tag ' + storeOf(code).cls + '">Only at ' + esc(storeOf(code).name) + '</span>';
    const s = r.store || 'Either';
    return s === 'Either' ? '' : '<span class="store-dot ' + storeOf(s).cls + '" title="Usually from ' + esc(storeOf(s).name) + '"></span>';
  }

  // Claude put it in a store's online cart (status carted; List.cart = store code, api 11).
  const cartStore = (r) => (r && r.status === 'carted' ? String(r.cart || r.store || '') : '');
  function cartTag(r) {
    const code = cartStore(r);
    if (!r || r.status !== 'carted') return '';
    const s = code && code !== 'Either' ? storeOf(code) : null;
    return '<span class="cart-tag ' + (s ? s.cls : 'either') + '">🛒 In ' + (s ? esc(s.short || s.name) + ' ' : '') + 'cart</span>';
  }

  // At home a tap opens the item screen. Only In-store mode checks things off.
  function listRow(r) {
    const meta = rowMeta(r);
    const tag = mealTag(r);
    const only = onlyAt(r) ? storeMark(r) : '';
    const cart = cartTag(r);
    return '<div class="row"><button class="row-main" data-act="open-row" data-id="' + r.id + '"><span class="row-name">' + (only ? '' : storeMark(r)) + esc(r.name) + '</span>' +
      (meta.length ? '<span class="row-meta">' + meta.join(' · ') + '</span>' : '') + (tag || only || cart ? '<span class="tags">' + cart + only + tag + '</span>' : '') + '</button>' + whoHtml(r) + '</div>';
  }

  // Just taken off: crossed out for a few seconds with Undo.
  function fadedRow(f) {
    return '<div class="row faded"><span class="row-main"><span class="row-name">' + esc(f.row.name) + '</span><span class="row-meta">' + esc(f.label) + '</span></span>' +
      '<button class="btn btn-plain" data-act="unfade" data-id="' + esc(f.row.id) + '">Undo</button></div>';
  }

  function requestRow(r) {
    const btns = amParent()
      ? '<button class="btn btn-primary" data-act="approve" data-id="' + r.id + '">Approve</button><button class="btn btn-quiet" data-act="skip" data-id="' + r.id + '">Skip</button>'
      : (iWant(r) ? '<button class="btn btn-quiet" data-act="skip" data-id="' + r.id + '">Cancel</button>' : '');
    return '<div class="row"><button class="row-main" data-act="open-row" data-id="' + r.id + '"><span class="row-name">' + esc(r.name) + '</span>' +
      '<span class="row-meta">' + ['asked by ' + esc(wantedBy(r).join(' + '))].concat(rowMeta(r)).join(' · ') + '</span>' +
      (mealTag(r) ? '<span class="tags">' + mealTag(r) + '</span>' : '') + '</button>' + btns + '</div>';
  }

  // Opened from a link in a browser (not the home-screen app): show how to add it, once, dismissible.
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; render(); });
  function viewInstallTip() {
    let standalone = false;
    try { standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; } catch (e) { /* old browser */ }
    if (standalone || store.get('ff_tip_off')) return '';
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const how = installEvt ? '<button class="btn btn-primary" data-act="install">Add to Home Screen</button>'
      : ios ? '<ol class="tip-steps"><li>Tap <b>Share</b> <span class="share-ico" aria-hidden="true">⬆︎</span> at the bottom of Safari (in Chrome, at the top right)</li><li>Scroll down, tap <b>Add to Home Screen</b></li><li>Tap <b>Add</b>. Open Poppy from the robot icon from now on.</li></ol>'
        : '<p class="note">Open the browser menu (⋮) and tap <b>Add to Home screen</b> or <b>Install app</b>.</p>';
    return '<section class="card tip"><div class="tip-head"><b>Put Poppy on your Home Screen</b><button class="x-btn" data-act="tip-off" aria-label="Hide this tip">✕</button></div>' + how + '</section>';
  }

  const chev = (closed) => '<span class="chev" aria-hidden="true">' + (closed ? '▸' : '▾') + '</span>';

  function viewList() {
    const list = D().list;
    const requests = list.filter((r) => r.status === 'requested');
    const active = list.filter((r) => r.status !== 'requested');
    let html = '';

    html += viewInstallTip();
    if (requests.length) {
      html += '<section class="card requests"><div class="card-head">' + (amParent() ? 'REQUESTS · ' + requests.length : 'WAITING FOR A PARENT · ' + requests.length) + '</div>' +
        requests.map(requestRow).join('') + '</section>';
    }

    // One living list, by aisle (Nov 1 family demo: timing matters more than the store; whatever store
    // we're at, grab what we can). Only store-only items say so; others carry a small store dot.
    const faded = fadingRows();
    const fadedIds = {};
    faded.forEach((f) => (fadedIds[f.row.id] = f));
    const all = active.concat(faded.map((f) => f.row));
    const aisles = groupsIn(all);
    if (active.length || faded.length) {
      const allClosed = aisles.every((g) => isClosed('a:' + g));
      const only = active.filter(storeOnly).length;
      html += '<div class="list-tools"><span>' + active.length + ' item' + (active.length === 1 ? '' : 's') + (only ? ' · ' + only + ' store-only' : '') + '</span>' +
        '<button class="link-btn" data-act="fold-all">' + (allClosed ? 'Open all' : 'Close all') + '</button></div>';
    }
    aisles.forEach((g) => {
      const rows = all.filter((r) => groupOf(r) === g);
      const live = rows.filter((r) => !fadedIds[r.id]);
      const key = 'a:' + g;
      // An aisle with a row that just left stays open so the Undo is visible.
      const closed = isClosed(key) && !rows.some((r) => fadedIds[r.id]);
      html += '<section class="card acc"><button class="card-head acc-head" data-act="fold" data-key="' + esc(key) + '" aria-expanded="' + !closed + '">' +
        '<span>' + esc(g.toUpperCase()) + ' · ' + live.length + '</span>' + chev(closed) + '</button>';
      if (closed) {
        html += '<button class="peek" data-act="fold" data-key="' + esc(key) + '">' + esc(live.slice(0, 6).map((r) => r.name).join(', ')) + (live.length > 6 ? '…' : '') + '</button>';
      } else {
        html += rows.map((r) => (fadedIds[r.id] ? fadedRow(fadedIds[r.id]) : listRow(r))).join('');
      }
      html += '</section>';
    });

    if (!list.length && !faded.length) html += '<div class="empty">The list is empty.<br><button class="btn btn-outline" style="margin-top:12px" data-act="tab" data-tab="shop">Add things in Shop</button></div>';

    const held = D().held || [];
    if (held.length) {
      const c = isClosed('held');
      html += '<section class="card dashed"><button class="card-head acc-head head-either" data-act="fold" data-key="held"><span>NEXT WEEK · ' + held.length + '</span>' + chev(c) + '</button>' +
        (c ? '' : held.map((r) => '<div class="row"><button class="row-main" data-act="open-row" data-id="' + r.id + '"><span class="row-name">' + esc(r.name) + '</span><span class="row-meta">' + esc(storeOf(r.store).name) +
          (r.hold_until ? ' · back ' + esc(shortDay(r.hold_until)) : '') + '</span></button>' +
          '<button class="btn btn-plain" data-act="unhold" data-id="' + r.id + '">Need it now</button></div>').join('')) + '</section>';
    }

    html += '<p class="hint">One list for every store: wherever you shop, grab what you can. A colored dot is where we usually get it; “Only at …” means the other stores don’t carry it. Tap an item to say we have it, push it to next week, or see its history. In the store, tap 🛒 In store to check things off.</p>';
    return html;
  }

  /* ---------- in-store mode (on the List) ---------- */
  function viewStorePicker() {
    const pill = (v, label, cls) => '<button class="pill ' + (cls || '') + (S.instore === v ? ' on' : '') + '" data-act="store-pick" data-v="' + v + '">' + label + '</button>';
    return '<div class="chips-row">' + pill('GE', 'Giant Eagle', 'ge') + pill('WF', 'Whole Foods', 'wf') + pill('TGT', 'Target', 'tgt') + pill('all', 'All') + '</div>';
  }

  // Wherever we are, grab what we can: every row shows, except ones only another store carries.
  const inStore = (r) => {
    if (S.instore === 'all') return true;
    const only = onlyAt(r);
    return !only || only === S.instore;
  };
  // Bought today counts as "in the cart", so a shared trip shows everyone's checks.
  const boughtToday = (r) => r.status === 'bought' && String(r.updated_at || '').slice(0, 10) === D().today;

  function viewInStore() {
    const open = D().list.filter(inStore);
    const done = D().recent.filter((r) => boughtToday(r) && inStore(r));
    const rows = open.map((r) => ({ r: r, done: false })).concat(done.map((r) => ({ r: r, done: true })));
    if (!rows.length) return '<div class="empty">Nothing on the list for ' + esc(S.instore === 'all' ? 'any store' : storeOf(S.instore).name) + '.</div>';
    let html = '<div class="shop-progress"><span>' + done.length + ' of ' + rows.length + ' in the cart</span><div class="bar"><i style="width:' + Math.round(100 * done.length / rows.length) + '%"></i></div></div>';
    // At a store we know aisles for (Products.aisle, api 11): walk the store in aisle order; the rest by group.
    const aisleOf = (r) => {
      if (!S.instore || S.instore === 'all') return '';
      const p = ((D().products || {})[r.item_id] || {})[S.instore];
      return (p && p.aisle) || '';
    };
    const sectionOf = (r) => aisleOf(r) || groupOf(r);
    const aisleNum = (a) => { const m = String(a).match(/\d+/); return m ? Number(m[0]) : 999; };
    const aisles = Array.from(new Set(rows.map((x) => aisleOf(x.r)).filter(String))).sort((a, b) => aisleNum(a) - aisleNum(b) || a.localeCompare(b));
    const rest = groupsIn(rows.filter((x) => !aisleOf(x.r)).map((x) => x.r));
    aisles.concat(rest).forEach((g) => {
      const inG = rows.filter((x) => sectionOf(x.r) === g);
      const left = inG.filter((x) => !x.done).length;
      html += '<section class="card"><div class="card-head"><span>' + esc(g.toUpperCase()) + '</span><span class="sub">' + (left ? left + ' left' : 'done') + '</span></div>' + inG.map((x) => {
        const r = x.r;
        const meta = rowMeta(r);
        if (onlyAt(r)) meta.unshift('only at ' + esc(storeOf(onlyAt(r)).name));
        else if ((r.store || 'Either') !== 'Either' && (S.instore === 'all' || r.store !== S.instore)) meta.unshift('usually ' + esc(storeOf(r.store).name));
        if (r.status === 'requested') meta.unshift('asked by ' + esc(wantedBy(r).join(' + ')));
        if (r.status === 'carted') meta.unshift('in the ' + esc(storeOf(cartStore(r) || r.store).name) + ' online cart');
        return '<button class="row shop-row' + (x.done ? ' done' : '') + '" data-act="' + (x.done ? 'store-uncheck' : 'store-check') + '" data-id="' + r.id + '" aria-pressed="' + x.done + '">' +
          '<span class="check' + (x.done ? ' on' : '') + '" aria-hidden="true">' + (x.done ? '✓' : '') + '</span>' +
          '<span class="row-main"><span class="row-name">' + esc(r.name) + '</span>' + (meta.length ? '<span class="row-meta">' + meta.join(' · ') + '</span>' : '') +
          (mealTag(r) && !x.done ? '<span class="tags">' + mealTag(r) + '</span>' : '') + '</span>' +
          (wantedBy(r).length > 1 && !x.done ? whoHtml(r) : '') + '</button>';
      }).join('') + '</section>';
    });
    html += '<p class="hint">Tap to put it in the cart, tap again to take it out. Everyone in the store sees the same checks. Tap Done when you check out.</p>';
    return html;
  }

  /* ---------- shop tab (add things) ---------- */
  // Smart filters. Each returns item ids; pills with nothing in them are hidden.
  function smartSets() {
    const items = D().items.filter((i) => i.status !== 'Drop');
    const listed = {};
    D().list.concat(D().held || []).forEach((r) => (listed[r.item_id] = true));
    const today = D().today;
    const ago = (iso) => (iso ? Math.round((new Date(today + 'T12:00:00') - new Date(String(iso).slice(0, 10) + 'T12:00:00')) / 86400000) : 9999);
    const window = planDates();
    const dinnerIds = [];
    D().plan.forEach((p) => {
      if (isLeftover(p) || !p.meal_id || window.indexOf(planDate(p)) < 0) return;
      mealItems(mealById(p.meal_id)).forEach((id) => dinnerIds.indexOf(id) < 0 && dinnerIds.push(id));
    });
    const stock = D().stock || {};
    return {
      due: D().due.map((d) => d.id).filter((id) => !listed[id]),
      usual: items.filter((i) => i.status === 'Always' || Number(i.orders) >= 2).map((i) => i.id),
      dinners: dinnerIds.filter((id) => itemById(id)),
      low: Object.keys(stock).filter((id) => (stock[id].level === 'low' || stock[id].level === 'out') && ago(stock[id].at) <= 14),
      recent: items.filter((i) => ago(i.last_bought) <= 14).map((i) => i.id),
      onlist: Object.keys(listed).filter((id) => itemById(id)),
      listed: listed,
    };
  }
  const SMART = [['all', 'All'], ['due', 'Probably due'], ['dinners', 'For meals'], ['usual', 'Usuals'], ['low', 'Running low'], ['recent', 'Bought lately'], ['onlist', 'On the list']];

  function viewShopTop() {
    const sets = smartSets();
    const f = S.shopFilter || 'all';
    const pill = (v, label, n) => '<button class="pill' + (f === v ? ' on' : '') + '" data-act="shop-filter" data-v="' + v + '">' + label + (n != null ? ' <span class="pill-n">' + n + '</span>' : '') + '</button>';
    const spill = (v, label, cls) => '<button class="pill small ' + (cls || '') + ((S.shopStore || 'all') === v ? ' on' : '') + '" data-act="shop-store" data-v="' + v + '">' + label + '</button>';
    return '<form class="addbar" data-form="add" autocomplete="off"><label class="sr" for="add">Search or add</label>' +
      '<input id="add" class="field" type="search" placeholder="' + (isKid(S.me) ? 'Search or ask for something…' : 'Search or add something new…') + '" value="' + esc(S.query) + '" enterkeyhint="done"></form>' +
      '<div class="pill-scroll">' + SMART.filter((p) => p[0] === 'all' || sets[p[0]].length).map((p) => pill(p[0], p[1], p[0] === 'all' ? null : sets[p[0]].length)).join('') + '</div>' +
      '<div class="chips-row">' + spill('all', 'Every store') + spill('GE', 'Giant Eagle', 'ge') + spill('WF', 'Whole Foods', 'wf') + spill('TGT', 'Target', 'tgt') + spill('AMZ', 'Amazon', 'amz') + '</div>';
  }

  function viewShop() {
    const sets = smartSets();
    const f = S.shopFilter || 'all';
    const q = S.query.trim().toLowerCase();
    const st = S.shopStore || 'all';
    let items = D().items.filter((i) => i.status !== 'Drop' || f === 'onlist');
    if (f !== 'all') { const ids = sets[f]; items = ids.map(itemById).filter(Boolean); }
    if (st !== 'all') items = items.filter((i) => i.store === st || (i.store === 'Either' && takesEither(st)));
    let close = false;
    if (q) { const fr = findItems(q, items); items = fr.hits; close = !fr.all && items.length > 0; }

    let html = '';
    if (q && !D().items.some((i) => String(i.name).toLowerCase() === q)) {
      html += '<button class="new-item" data-act="add-new"><span class="add-btn" aria-hidden="true">+</span><span>Add “' + esc(S.query.trim()) + '” as ' + (isKid(S.me) ? 'a request' : 'something new') + '</span></button>';
    }
    if (close) html += '<p class="note search-close">Nothing matches every word. Closest matches:</p>';
    const row = (i) => {
      const on = !!sets.listed[i.id];
      const meta = ['<span class="store-dot ' + storeOf(i.store).cls + '"></span>' + esc(storeOf(i.store).name)];
      if (i.last_bought) meta.push('bought ' + esc(daysAgo(i.last_bought)));
      const stk = (D().stock || {})[i.id];
      if (stk) meta.push('at home: ' + esc(levelText(stk.level)) + ' (' + esc(daysAgo(stk.at)) + ')');
      return '<div class="row"><button class="row-main" data-act="open-item" data-id="' + i.id + '"><span class="row-name">' + esc(i.name) + '</span><span class="row-meta">' + meta.join(' · ') + '</span></button>' +
        (on ? '<button class="add-btn on" data-act="open-item" data-id="' + i.id + '" aria-label="' + esc(i.name) + ' is on the list">✓</button>'
          : '<button class="add-btn" data-act="add-item" data-id="' + i.id + '" aria-label="Add ' + esc(i.name) + '">+</button>') + '</div>';
    };
    if (f === 'due' || f === 'dinners' || f === 'low') {
      if (items.length) html += '<section class="card">' + items.map(row).join('') + '</section>';
    } else {
      const sorted = items.slice().sort((a, b) => (Number(b.orders) || 0) - (Number(a.orders) || 0) || String(a.name).localeCompare(b.name));
      const groups = GROUPS.concat(Array.from(new Set(sorted.map((i) => i.group || 'Other'))).filter((g) => GROUPS.indexOf(g) < 0));
      const used = groups.filter((g) => sorted.some((i) => (i.group || 'Other') === g));
      // Aisles start folded with a peek of names; a search opens everything it matches.
      const keyOf = (g) => 'p:' + f + ':' + g;
      if (used.length > 1 && !q) {
        const allClosed = used.every((g) => isClosed(keyOf(g)));
        html += '<div class="list-tools"><span>' + sorted.length + ' item' + (sorted.length === 1 ? '' : 's') + '</span>' +
          '<button class="link-btn" data-act="shop-fold-all" data-keys="' + esc(used.map(keyOf).join('|')) + '">' + (allClosed ? 'Open all' : 'Close all') + '</button></div>';
      }
      used.forEach((g) => {
        const inG = sorted.filter((i) => (i.group || 'Other') === g);
        const key = keyOf(g);
        const closed = !q && used.length > 1 && isClosed(key);
        html += '<section class="card acc"><button class="card-head acc-head" data-act="fold" data-key="' + esc(key) + '" aria-expanded="' + !closed + '"><span>' + esc(g.toUpperCase()) + ' · ' + inG.length + '</span>' + chev(closed) + '</button>' +
          (closed ? '<button class="peek" data-act="fold" data-key="' + esc(key) + '">' + esc(inG.slice(0, 8).map((i) => i.name).join(', ')) + (inG.length > 8 ? '…' : '') + '</button>' : inG.map(row).join('')) + '</section>';
      });
    }
    if (!items.length && !q) html += '<div class="empty">Nothing here right now.</div>';
    html += '<p class="hint">Tap + to put it on the List. Tap a name to see its history, say we have some, or change its store.</p>';
    return html;
  }

  /* ---------- item screen (from the List or Shop) ---------- */
  const canInfo = () => Number(D().api || 0) >= 5;
  // api 9: store_only, kids' meal requests, app feedback, "How was it?" / "Still eating?" cards.
  const canV9 = () => Number(D().api || 0) >= 9;

  function openItemSheet(itemId, rowId, name) {
    const it = itemById(itemId);
    S.sheet = {
      type: 'item', item_id: itemId || '', row_id: rowId || '', name: (it && it.name) || name || '', level: '', count: 1, details: false, info: null,
      d: it ? Object.assign({ store: it.store || 'Either', ok_swap: it.ok_swap || '', status: it.status || '', brand_size: it.brand_size || '', notes: it.notes || '', group: it.group || 'Other' }, canV9() ? { store_only: /^y/i.test(String(it.store_only || '')) ? 'Y' : '' } : {}) : null,
    };
    render();
    if (itemId && canInfo() && String(itemId).indexOf('tmp') !== 0) {
      const mine = S.sheet;
      api('itemInfo', { item_id: itemId }).then((j) => { if (S.sheet === mine) { mine.info = j.result || {}; render(); } }).catch(() => { if (S.sheet === mine) { mine.info = { failed: true }; render(); } });
    }
  }

  const fmtShort = (iso) => { const d = new Date(String(iso).slice(0, 10) + 'T12:00:00'); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
  const money = (v) => (v === '' || v == null || isNaN(Number(v)) ? '' : '$' + Number(v).toFixed(2));

  function viewItemSheet(sh) {
    const it = itemById(sh.item_id);
    const row = (sh.row_id && (D().list.find((r) => r.id === sh.row_id) || (D().held || []).find((r) => r.id === sh.row_id))) ||
      (sh.item_id && (listRowFor(sh.item_id) || (D().held || []).find((r) => r.item_id === sh.item_id)));
    const held = row && (D().held || []).indexOf(row) >= 0;
    const kid = isKid(S.me);
    const subs = [];
    if (it && it.group) subs.push(esc(it.group));
    if (it && it.brand_size) subs.push(esc(it.brand_size));
    const storeCode = (row && row.store) || (it && it.store) || 'Either';
    let h = '<div class="is-head"><div><h2>' + esc(sh.name) + '</h2><div class="is-sub"><span class="store-dot ' + storeOf(storeCode).cls + '"></span>' + esc(storeOf(storeCode).name) +
      (subs.length ? ' · ' + subs.join(' · ') : '') + '</div></div><button class="x-btn" data-act="close-x" aria-label="Close">✕</button></div>';
    // What we actually buy, store by store (Products tab, api 11).
    const prods = (D().products || {})[sh.item_id] || {};
    const pk = ['GE', 'WF', 'TGT', 'AMZ'].filter((k) => prods[k]).concat(Object.keys(prods).filter((k) => ['GE', 'WF', 'TGT', 'AMZ'].indexOf(k) < 0));
    if (pk.length) {
      h += '<div class="is-products">' + pk.map((k) => {
        const p = prods[k];
        return '<div class="is-prod"><span class="store-dot ' + storeOf(k).cls + '"></span><span><b>' + esc(storeOf(k).name) + ':</b> ' + esc(p.name) +
          (p.size ? ' · ' + esc(p.size) : '') + (p.aisle ? ' <span class="aisle-tag">' + esc(p.aisle) + '</span>' : '') + '</span></div>';
      }).join('') + '</div>';
    }

    // Where it stands
    if (row) {
      const inCart = row.status === 'carted' ? (cartStore(row) && cartStore(row) !== 'Either' ? 'In the ' + storeOf(cartStore(row)).name + ' cart' : 'In the cart') : '';
      h += '<div class="is-status on"><b>' + (held ? 'Next week' : row.status === 'requested' ? 'Asked for' : inCart || 'On the list') + '</b> · asked by ' + esc(wantedBy(row).join(' + ')) +
        (mealTag(row) ? ' ' + mealTag(row) : '') + '</div>';
      if (wantedBy(row).length > 1) h += '<p class="note">' + esc(wantedBy(row).join(' and ')) + ' both asked. Same one, or one each? Set how many.</p>';
      h += '<div class="is-line"><span class="is-label">How many</span><div class="stepper small"><button type="button" data-act="row-qty" data-d="-1" aria-label="Fewer">−</button><b>' + (Number(row.qty) || 1) + '</b><button type="button" data-act="row-qty" data-d="1" aria-label="More">+</button></div></div>';
      h += '<input class="field" data-input="row-note" data-id="' + row.id + '" value="' + esc(row.note || '') + '" placeholder="Note: brand, size, flavor…">';
    } else {
      h += '<button class="btn btn-primary btn-block" data-act="add-item" data-id="' + esc(sh.item_id) + '">' + (kid ? 'Ask for it' : 'Add to the List') + '</button>';
    }

    // We have some (one tap)
    if (canStock() && (row ? !held : canInfo())) {
      const lv = (v, label) => '<button type="button" class="' + (sh.level === v ? 'on' : '') + '" data-act="have-level" data-v="' + v + '">' + label + '</button>';
      h += '<div class="is-block"><div class="is-label">' + (row ? 'Have some at home already?' : 'How much is at home?') + '</div><div class="seg">' +
        lv('plenty', 'Plenty') + lv('some', 'Some') + lv('low', 'A little') + lv('count', 'Count…') + '</div>' +
        (sh.level === 'count' ? '<div class="is-line"><div class="stepper small"><button type="button" data-act="have-count" data-d="-1" aria-label="Fewer">−</button><b>' + sh.count + '</b><button type="button" data-act="have-count" data-d="1" aria-label="More">+</button></div><button class="btn btn-outline" data-act="have-count-save">Save</button></div>' : '') +
        '<p class="note">' + (row ? 'Plenty, Some or a count takes it off the List (nothing bought). A little keeps it on.' : 'Logged so Poppy knows; it isn’t added to the list.') + '</p></div>';
    }

    // Quiet actions
    if (row) {
      const acts = [];
      if (held) acts.push('<button class="btn btn-plain" data-act="unhold" data-id="' + row.id + '">Need it now</button>');
      else if (canStock()) acts.push('<button class="btn btn-plain" data-act="row-hold">Next week</button>');
      acts.push('<button class="btn btn-plain" data-act="row-bought">Bought it</button>');
      acts.push('<button class="btn btn-plain danger" data-act="row-remove">Take off</button>');
      h += '<div class="is-actions">' + acts.join('') + '</div>';
    }

    // History
    if (it) {
      const facts = [];
      if (Number(it.orders)) facts.push('Bought in ' + it.orders + ' order' + (Number(it.orders) > 1 ? 's' : ''));
      if (it.last_bought) facts.push('last ' + esc(daysAgo(it.last_bought)));
      if (it.avg_days) facts.push('about every ' + it.avg_days + ' days');
      const info = sh.info;
      let hist = facts.length ? '<p class="is-fact">' + facts.join(' · ') + '</p>' : '<p class="note">No purchases on record yet.</p>';
      if (info && info.purchases && info.purchases.length) {
        hist += '<ul class="is-list">' + info.purchases.map((p) => '<li><span>' + esc(fmtShort(p.date)) + '</span><span>' + esc(storeOf(p.store).name) + '</span><span>' + esc(money(p.price)) + (Number(p.qty) > 1 ? ' ×' + p.qty : '') + '</span></li>').join('') + '</ul>';
      }
      const sightings = (info && info.stock) || ((D().stock || {})[it.id] ? [D().stock[it.id]] : []);
      if (sightings.length) hist += '<p class="is-fact">At home: ' + sightings.slice(0, 3).map((s) => esc(levelText(s.level)) + ' (' + esc(s.who || '?') + ', ' + esc(fmtShort(s.at)) + ')').join(' · ') + '</p>';
      if (canInfo() && !info) hist += '<p class="note">Loading history…</p>';
      h += '<div class="is-block"><div class="is-label">History</div>' + hist + '</div>';

      const notes = [];
      if (it.notes) notes.push('<li>' + esc(it.notes) + '</li>');
      ((info && info.answers) || []).forEach((a) => notes.push('<li><span class="q">' + esc(a.q) + '</span> <b>' + esc(a.answer) + '</b></li>'));
      if (notes.length) h += '<div class="is-block"><div class="is-label">What we know</div><ul class="is-notes">' + notes.join('') + '</ul></div>';
    }

    // Details (store, swaps, how often) folded away
    if (it && sh.d) {
      h += '<button class="is-toggle" data-act="toggle-details" aria-expanded="' + !!sh.details + '"><span>Details · store, swaps, how often</span>' + chev(!sh.details) + '</button>';
      if (sh.details) {
        const seg = (field, opts) => '<div class="seg">' + opts.map((o) => '<button type="button" data-act="d-seg" data-field="' + field + '" data-v="' + esc(o[0]) + '" class="' + (String(sh.d[field]) === String(o[0]) ? 'on' : '') + '"' + (kid ? ' disabled' : '') + '>' + esc(o[1]) + '</button>').join('') + '</div>';
        h += '<div class="is-details">' +
          '<div><label>Store we use</label>' + seg('store', [['GE', 'Giant Eagle'], ['WF', 'Whole Foods'], ['TGT', 'Target'], ['AMZ', 'Amazon'], ['Either', 'Either']]) + '</div>' +
          (canV9() ? '<div><label>Can other stores get it?</label>' + seg('store_only', [['', 'Yes, any store'], ['Y', 'Only this store']]) + '</div>' : '') +
          '<div><label>OK to swap if it’s out?</label>' + seg('ok_swap', [['Y', 'Yes'], ['N', 'No, skip it'], ['', 'Ask me']]) + '</div>' +
          '<div><label>How often</label>' + seg('status', [['Always', 'Always'], ['Sometimes', 'Sometimes'], ['Drop', 'Stop buying']]) + '</div>' +
          '<div><label for="d-brand">Brand / size</label><input id="d-brand" class="field" style="width:100%" data-input="d" data-field="brand_size" value="' + esc(sh.d.brand_size) + '"' + (kid ? ' disabled' : '') + '></div>' +
          '<div><label for="d-aisle">Aisle</label><select id="d-aisle" class="select" style="width:100%" data-input="d" data-field="group"' + (kid ? ' disabled' : '') + '>' + GROUPS.map((g) => '<option' + (g === sh.d.group ? ' selected' : '') + '>' + esc(g) + '</option>').join('') + '</select></div>' +
          '<div><label for="d-notes">Notes</label><input id="d-notes" class="field" style="width:100%" data-input="d" data-field="notes" value="' + esc(sh.d.notes) + '" placeholder="e.g. Gia only eats strawberry"' + (kid ? ' disabled' : '') + '></div>' +
          (kid ? '<p class="note">A parent can change these.</p>' : '<button class="btn btn-primary btn-block" data-act="save-details">Save details</button>') + '</div>';
      }
    }
    return h;
  }

  /* ---------- meals ---------- */
  // Dinner plan as two swipeable week strips: this week (today → Saturday) on top, next week
  // (Sun → Sat) below, folded until tapped. Days past next Saturday stay reachable from the meal card.
  function planWeeks() {
    const today = D().today;
    const sun = addDays(today, 7 - DAYS.indexOf(dayName(today)));
    const all = planDates();
    return {
      thisWeek: all.filter((d) => d < sun),
      nextWeek: all.filter((d) => d >= sun && d < addDays(sun, 7)),
      nextSun: sun,
    };
  }

  function dayTile(day, plan, meals) {
    const meal = mealById(plan[day] || '');
    const isToday = day === D().today;
    const open = S.openDay === day && meal;
    const rows = canSlots() ? planDay(day) : {};
    if (canSlots()) {
      // All four meals, top to bottom, same size (Nov 1 family demo): breakfast, lunch, snack, dinner.
      const any = SLOTS.some((x) => planText(rows[x[0]]));
      const lines = SLOTS.map((x) => {
        const t = planText(rows[x[0]]);
        return '<span class="dt-line' + (t ? '' : ' none') + '"><span class="dt-k"><i aria-hidden="true">' + x[2] + '</i>' + x[1] + '</span><span class="dt-v">' + esc(t || '—') + '</span></span>';
      }).join('');
      return '<div class="day-tile slots4' + (any ? ' set' : '') + (isToday ? ' today' : '') + (open ? ' open' : '') + '">' +
        '<button class="dt-all" data-act="open-day" data-day="' + day + '" aria-label="' + esc((isToday ? 'Today, ' : '') + dayName(day) + ' ' + md(day)) + '">' +
        '<span class="dt-head"><b>' + (isToday ? 'Today' : dayName(day)) + '</b><small>' + (isToday ? dayName(day) + ' ' : '') + md(day) + ' ›</small></span>' + lines + '</button>' +
        (meal ? '<button class="dt-ing" data-act="toggle-day" data-day="' + day + '" aria-expanded="' + !!open + '">' + (open ? 'Hide' : 'Dinner ingredients') + '</button>' : '<span class="dt-ing ghost"></span>') +
        '</div>';
    }
    const others = '';
    return '<div class="day-tile' + (meal ? ' set' : '') + (isToday ? ' today' : '') + (open ? ' open' : '') + '">' +
      (canSlots()
        ? '<button class="dt-head dt-day" data-act="open-day" data-day="' + day + '" aria-label="Whole day: ' + dayName(day) + ' ' + md(day) + '"><b>' + (isToday ? 'Today' : dayName(day)) + '</b><small>' + md(day) + ' ›</small></button>'
        : '<div class="dt-head"><b>' + (isToday ? 'Today' : dayName(day)) + '</b><small>' + md(day) + '</small></div>') +
      '<div class="dt-pick"><span class="dt-meal">' + (meal ? esc(meal.name) : '+ Pick dinner') + '</span>' +
      '<label class="sr" for="plan-' + day + '">Dinner on ' + dayName(day) + ' ' + md(day) + '</label><select id="plan-' + day + '" data-input="plan" data-day="' + day + '">' +
      mealOptions(meals, 'dinner', meal ? meal.id : '') +
      '</select></div>' +
      (others ? '<button class="dt-slots" data-act="open-day" data-day="' + day + '" aria-label="Breakfast, lunch and snack on ' + dayName(day) + '">' + others + '</button>' : '') +
      (meal ? '<button class="dt-ing" data-act="toggle-day" data-day="' + day + '" aria-expanded="' + !!open + '">' + (open ? 'Hide' : 'Ingredients') + '</button>' : '<span class="dt-ing ghost"></span>') +
      '</div>';
  }

  // Picker options: meals of this slot's kind first, the rest under "Other meals".
  function mealOptions(meals, slot, selected) {
    const opt = (m) => '<option value="' + m.id + '"' + (m.id === selected ? ' selected' : '') + '>' + esc(m.name) + '</option>';
    if (!canSlots()) return '<option value="">—</option>' + meals.map(opt).join('');
    const mine = meals.filter((m) => kindOf(m) === slot);
    const rest = meals.filter((m) => kindOf(m) !== slot);
    return '<option value="">—</option>' + mine.map(opt).join('') + (rest.length ? '<optgroup label="Other meals">' + rest.map(opt).join('') + '</optgroup>' : '');
  }

  // One day, all four meals: pick each, open its card.
  function viewDaySheet(sh) {
    const rows = planDay(sh.day);
    const meals = D().meals.slice().sort((a, b) => String(a.name).localeCompare(b.name));
    const readOnly = canV9() && isKid(S.me); // kids ask for meals from the meal card; parents plan
    return '<div class="is-head"><div><h2>' + esc((sh.day === D().today ? 'Today · ' : '') + dayName(sh.day) + ' ' + md(sh.day)) + '</h2></div>' +
      '<button class="x-btn" data-act="close-x" aria-label="Close">✕</button></div>' +
      SLOTS.map((x) => {
        const p = rows[x[0]];
        const m = p && mealById(p.meal_id || '');
        const t = planText(p);
        if (readOnly) {
          return '<div class="slot-row"><div class="slot-label"><i aria-hidden="true">' + x[2] + '</i>' + x[1] + '</div>' +
            '<div class="slot-pick' + (t ? ' set' : '') + '"><span>' + esc(t || '—') + '</span></div>' +
            (m ? '<button class="btn btn-plain slot-open" data-act="open-meal" data-id="' + m.id + '" aria-label="Open ' + esc(m.name) + '">↗</button>' : '<span class="slot-open"></span>') + '</div>';
        }
        return '<div class="slot-row"><div class="slot-label"><i aria-hidden="true">' + x[2] + '</i>' + x[1] + '</div>' +
          '<div class="slot-pick' + (t ? ' set' : '') + '"><span>' + esc(t || '+ Pick ' + x[1].toLowerCase()) + '</span>' +
          '<label class="sr" for="slot-' + x[0] + '">' + x[1] + '</label><select id="slot-' + x[0] + '" data-input="slot-plan" data-day="' + sh.day + '" data-slot="' + x[0] + '">' +
          mealOptions(meals, x[0], m ? m.id : '') + '</select></div>' +
          (m ? '<button class="btn btn-plain slot-open" data-act="open-meal" data-id="' + m.id + '" aria-label="Open ' + esc(m.name) + '">↗</button>' : '<span class="slot-open"></span>') + '</div>';
      }).join('') +
      '<p class="note">' + (readOnly ? 'Want something? Tap a meal in Our meals and Ask for it. A parent picks the day.' : 'Picking a meal replaces what was there. Leftovers come over from Hearth as they are.') + '</p>';
  }

  // Text for Hearth Helper: one block per day, Breakfast / Lunch / Snack / Dinner.
  function hearthText(days) {
    const out = [];
    days.forEach((d) => {
      const rows = planDay(d);
      const lines = SLOTS.map((x) => (planText(rows[x[0]]) ? x[1] + ': ' + planText(rows[x[0]]) : '')).filter(String);
      if (lines.length) out.push(dayName(d) + ' ' + fmtLong(d) + '\n' + lines.join('\n'));
    });
    if (!out.length) return '';
    const first = days[0]; const last = days[days.length - 1];
    return 'Please update our Hearth Meal Plan for ' + fmtLong(first) + ' – ' + fmtLong(last) + ', ' + first.slice(0, 4) + '.\n' +
      'Use these exact meal names in the Breakfast, Lunch, Snack and Dinner rows, for the whole family. ' +
      'Replace whatever is already in those spots. Leave any spot I don\'t list as it is. Meal plan only: no calendar events or reminders.\n\n' +
      out.join('\n\n');
  }
  function fmtLong(iso) {
    const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function hearthDays(which) {
    const w = planWeeks();
    return which === 'next' ? w.nextWeek : w.thisWeek;
  }
  function viewHearthSheet(sh) {
    const days = hearthDays(sh.week);
    const text = hearthText(days);
    const w = planWeeks();
    return '<div class="is-head"><div><h2>Send to Hearth</h2><div class="is-sub">Paste this to Hearth Helper in the Hearth app.</div></div>' +
      '<button class="x-btn" data-act="close-x" aria-label="Close">✕</button></div>' +
      '<div class="seg">' + [['this', 'This week'], ['next', 'Next week · ' + md(w.nextSun)]].map((o) =>
        '<button type="button" data-act="hearth-week" data-v="' + o[0] + '" class="' + (sh.week === o[0] ? 'on' : '') + '">' + esc(o[1]) + '</button>').join('') + '</div>' +
      (text
        ? '<label class="sr" for="hearth-text">Text for Hearth Helper</label><textarea id="hearth-text" class="field hearth-text" rows="12" readonly>' + esc(text) + '</textarea>' +
          '<div class="sheet-actions"><button class="btn btn-primary" data-act="hearth-copy">Copy</button>' +
          (navigator.share ? '<button class="btn btn-outline" data-act="hearth-share">Share…</button>' : '') + '</div>' +
          '<p class="note">Copy, open Hearth → Hearth Helper, paste and send. Check its preview before you approve. ' + (sh.week === 'this' ? 'This week starts today; earlier days stay as they are in Hearth.' : '') + '</p>'
        : '<p class="note">Nothing planned for that week yet.</p>');
  }

  function weekStrip(id, days, plan, meals) {
    let h = '<div class="week-strip" id="strip-' + id + '" data-keep-scroll>' + days.map((d) => dayTile(d, plan, meals)).join('') + '</div>';
    const openDay = days.indexOf(S.openDay) >= 0 && mealById(plan[S.openDay] || '') ? S.openDay : null;
    if (openDay) h += '<div class="strip-ing"><div class="strip-ing-head">' + esc(shortDay(openDay) + ' · ' + mealById(plan[openDay]).name) + '</div>' + viewIngredients(openDay, mealById(plan[openDay])) + '</div>';
    return h;
  }

  function viewMeals() {
    const plan = planByDate();
    const meals = D().meals.slice().sort((a, b) => String(a.name).localeCompare(b.name));
    const w = planWeeks();
    const planned = (days) => days.filter((d) => (canSlots() ? SLOTS.some((x) => planText(planDay(d)[x[0]])) : mealById(plan[d] || '')));
    const hearthBtn = canSlots() && amParent() ? '<button class="btn btn-outline btn-sm" data-act="open-hearth">→ Hearth</button>' : '';
    let html = viewMealRequests();
    html += '<section class="card"><div class="card-head"><span>THIS WEEK</span><span class="head-btns"><span class="sub">' + planned(w.thisWeek).length + ' of ' + w.thisWeek.length + (canSlots() ? ' days' : ' dinners') + '</span>' + hearthBtn + '</span></div>' +
      weekStrip('this', w.thisWeek, plan, meals) + '</section>';

    if (w.nextWeek.length) {
      const closed = isClosed('w:next');
      const pn = planned(w.nextWeek);
      html += '<section class="card acc"><button class="card-head acc-head" data-act="fold" data-key="w:next" aria-expanded="' + !closed + '">' +
        '<span>NEXT WEEK · ' + md(w.nextSun) + '–' + md(addDays(w.nextSun, 6)) + '</span><span class="head-btns"><span class="sub">' + pn.length + ' planned</span>' + chev(closed) + '</span></button>';
      html += closed
        ? '<button class="peek" data-act="fold" data-key="w:next">' + (pn.length ? esc(pn.map((d) => dayName(d) + ' ' + (mealById(plan[d] || '') ? mealById(plan[d]).name : SLOTS.map((x) => planText(planDay(d)[x[0]])).filter(String)[0])).join(', ')) : 'Nothing planned yet. Tap to plan.') + '</button>'
        : weekStrip('next', w.nextWeek, plan, meals);
      html += '</section>';
    }

    html += viewIdeas();

    const kinds = canSlots() ? SLOTS.filter((x) => meals.some((m) => kindOf(m) === x[0])) : [];
    if (S.mealKind && S.mealKind !== 'all' && !kinds.some((x) => x[0] === S.mealKind)) S.mealKind = 'all';
    const shown = kinds.length > 1 && S.mealKind && S.mealKind !== 'all' ? meals.filter((m) => kindOf(m) === S.mealKind) : meals;
    const sorted = sortMeals(shown);
    const kindPill = (v, label, n) => '<button class="pill small' + ((S.mealKind || 'all') === v ? ' on' : '') + '" data-act="meal-kind" data-v="' + v + '">' + label + ' <span class="pill-n">' + n + '</span></button>';
    const kindRow = kinds.length > 1 ? '<div class="chips-row meal-kinds">' + kindPill('all', 'All', meals.length) +
      kinds.slice(-1).concat(kinds.slice(0, -1).filter((x) => x[0] !== 'dinner')).filter((x, i, arr) => arr.indexOf(x) === i).map((x) => kindPill(x[0], x[1] === 'Lunch' ? 'Lunches' : x[1] + 's', meals.filter((m) => kindOf(m) === x[0]).length)).join('') + '</div>' : '';
    const sortPill = (v, label) => '<button class="pill small' + (S.mealSort === v ? ' on' : '') + '" data-act="meal-sort" data-v="' + v + '">' + label + '</button>';
    html += '<section class="card"><div class="card-head"><span>OUR MEALS · ' + meals.length + '</span><span class="head-btns">' +
      // 💡 Idea covers new meals (Nov 1); + New stays only for backends without meal ideas.
      (canIdeas() ? '<button class="btn btn-outline" data-act="new-idea">💡 Meal idea</button>' : '<button class="btn btn-outline" data-act="new-meal">+ New</button>') + '</span></div>' + kindRow +
      (canStats() && meals.length > 3 ? '<div class="chips-row meal-sorts">' + sortPill('az', 'A–Z') + sortPill('top', 'Favorites') + sortPill('cost', 'Cheapest') + sortPill('stale', 'Not lately') + '</div>' : '') +
      (sorted.length ? sorted.map((m) => '<div class="row"><button class="row-main" data-act="open-meal" data-id="' + m.id + '"><span class="row-name">' + (canSlots() && kindOf(m) !== 'dinner' ? '<span class="kind-dot" title="' + slotLabel(kindOf(m)) + '">' + slotIcon(kindOf(m)) + '</span>' : '') + esc(m.name) + '</span>' +
        '<span class="row-meta">' + mealItems(m).map((id) => itemById(id)).filter(Boolean).map((i) => esc(i.name)).join(', ') + '</span>' +
        (mealTags(m).length ? '<span class="tags">' + mealTags(m).join('') + '</span>' : '') + '</button></div>').join('')
        : '<div class="empty">No meals yet.</div>') + '</section>';
    html += '<p class="hint">Tap a meal to put it on a day, see its ingredients or edit it.' + (canSlots() ? ' Tap a day for breakfast, lunch and snack.' : '') + '' + (canIdeas() ? ' Found a good one online? Tap 💡 Idea and paste it; Poppy adds it to Our meals.' : '') + '</p>';
    return html;
  }

  /* ---------- meal stats, tags, card ---------- */
  const canStats = () => Number(D().api || 0) >= 7;
  const canIdeas = canStats;
  const VOTE_ORDER = ['😍', '🙂', '😐', '👎'];
  const statOf = (id) => (D().mealStats || {})[id] || null;
  const tierOf = (cost) => (cost < 15 ? '$' : cost < 30 ? '$$' : '$$$');
  // A meal's cost shows only when most of its linked ingredients have a receipt price.
  const costKnown = (st) => st && st.linked && st.priced * 2 >= st.linked && st.cost > 0;

  // Tags shown on each meal as you scroll: votes, next/last made, rough cost.
  function mealTags(m) {
    const st = statOf(m.id);
    const tags = [];
    if (!st) return tags;
    const voters = Object.keys(st.voters || {});
    if (voters.length) {
      const counts = VOTE_ORDER.filter((e) => st.votes[e]).map((e) => e + (st.votes[e] > 1 ? st.votes[e] : '')).join(' ');
      const fav = voters.length >= 2 && st.score >= 3.5;
      tags.push('<span class="stat-tag' + (fav ? ' fav' : st.score && st.score < 2 ? ' meh' : '') + '" title="' + esc(voters.map((w) => w + ' ' + st.voters[w]).join(', ')) + '">' + (fav ? 'Favorite · ' : '') + counts + '</span>');
    }
    if (st.next) tags.push('<span class="stat-tag next">' + (st.next === D().today ? (kindOf(m) === 'dinner' ? 'Tonight' : 'Today') : 'Next ' + esc(shortDay(st.next))) + '</span>');
    if (st.made) tags.push('<span class="stat-tag">Made ' + st.made + '× · last ' + esc(md(st.last)) + '</span>');
    if (costKnown(st)) tags.push('<span class="stat-tag" title="Latest receipt prices of ' + st.priced + ' of ' + st.linked + ' ingredients">' + tierOf(st.cost) + ' · ~$' + Math.round(st.cost) + (st.priced < st.linked ? '+' : '') + '</span>');
    if (!voters.length && !st.made && !st.next) tags.push('<span class="stat-tag new">New</span>');
    return tags;
  }

  function sortMeals(meals) {
    const k = S.mealSort || 'az';
    const st = (m) => statOf(m.id) || {};
    const by = {
      az: () => 0,
      top: (a, b) => (st(b).score || 0) - (st(a).score || 0) || Object.keys(st(b).voters || {}).length - Object.keys(st(a).voters || {}).length,
      cost: (a, b) => (costKnown(st(a)) ? st(a).cost : 1e9) - (costKnown(st(b)) ? st(b).cost : 1e9),
      stale: (a, b) => String(st(a).last || '0000') < String(st(b).last || '0000') ? -1 : String(st(a).last || '0000') > String(st(b).last || '0000') ? 1 : 0,
    }[k] || (() => 0);
    return meals.slice().sort((a, b) => by(a, b) || String(a.name).localeCompare(b.name));
  }

  /* ---------- kids' meal requests (api 9) ---------- */
  // Review rows of type meal_request: "<who> wants <meal> for <slot>, <when>. (mNN) Options: Plan it; Not now".
  function mealRequests() {
    return (D().review || []).filter((r) => r.type === 'meal_request').map((r) => {
      const d = String(r.detail || '');
      const m = mealById((d.match(/\((m\d{2,})\)/) || [])[1] || '');
      const w = d.match(/ for (breakfast|lunch|snack|dinner), (this week|next week|anytime)/i) || [];
      return { r: r, meal: m, who: r.asked_by || (d.match(/^(\S+) wants/) || [])[1] || '?', slot: (w[1] || '').toLowerCase(), when: w[2] || '' };
    }).filter((x) => x.meal);
  }
  function viewMealRequests() {
    if (!canV9()) return '';
    const all = mealRequests();
    const mine = amParent() ? all : all.filter((x) => String(x.who).toLowerCase() === String(S.me).toLowerCase());
    if (!mine.length) return '';
    return '<section class="card requests"><div class="card-head">' + (amParent() ? 'MEAL REQUESTS · ' : 'WAITING FOR A PARENT · ') + mine.length + '</div>' + mine.map((x) =>
      '<div class="row"><button class="row-main" data-act="open-meal" data-id="' + x.meal.id + '" data-req="' + esc(x.r.id) + '"><span class="row-name">' + esc(x.meal.name) + '</span>' +
      '<span class="row-meta">' + esc([amParent() ? x.who + ' asked' : 'You asked', x.slot ? slotLabel(x.slot).toLowerCase() : '', x.when].filter(String).join(' · ')) + '</span></button>' +
      (amParent() ? '<button class="btn btn-primary" data-act="open-meal" data-id="' + x.meal.id + '" data-req="' + esc(x.r.id) + '">Plan it</button><button class="btn btn-quiet" data-act="req-no" data-id="' + esc(x.r.id) + '">Not now</button>'
        : '<button class="btn btn-quiet" data-act="req-cancel" data-id="' + esc(x.r.id) + '">Cancel</button>') + '</div>').join('') + '</section>';
  }

  // Ideas people pasted, with where they stand. Done ones link to the new meal.
  function viewIdeas() {
    const ideas = (D().ideas || []).slice().reverse();
    if (!ideas.length) return '';
    const label = { new: 'Poppy is adding it', asked: 'Waiting for a parent', done: 'Added', declined: 'Not added' };
    return '<section class="card"><div class="card-head"><span>MEAL IDEAS · ' + ideas.length + '</span></div>' + ideas.map((x) => {
      const m = x.meal_id && mealById(x.meal_id);
      const first = String(x.text).split('\n')[0];
      return '<div class="row"><button class="row-main" data-act="' + (m ? 'open-meal' : 'open-idea') + '" data-id="' + esc(m ? m.id : x.id) + '"><span class="row-name">' + esc(m ? m.name : first) + '</span>' +
        '<span class="row-meta">' + esc((x.who || 'Someone') + ' · ' + daysAgo(x.at)) + (x.notes && x.status !== 'done' ? ' · ' + esc(x.notes) : '') + '</span></button>' +
        '<span class="idea-status ' + esc(x.status || 'new') + '">' + esc(label[x.status] || x.status) + '</span></div>';
    }).join('') + '</section>';
  }

  // The meal card: plan it on a night, its ingredients, its stats, edit.
  function viewMealCard(sh) {
    const m = mealById(sh.id);
    if (!m) return '<p class="note">That meal is gone.</p>';
    const slot = canSlots() ? kindOf(m) : 'dinner';
    const plan = planByDate(slot);
    const weeks = [];
    planDates().forEach((d) => {
      const wk = addDays(d, -DAYS.indexOf(dayName(d)));
      if (!weeks.length || weeks[weeks.length - 1].wk !== wk) weeks.push({ wk: wk, days: [] });
      weeks[weeks.length - 1].days.push(d);
    });
    const thisWk = addDays(D().today, -DAYS.indexOf(dayName(D().today)));
    const wkLabel = (wk) => (wk === thisWk ? 'This week' : wk === addDays(thisWk, 7) ? 'Next week' : 'Week of ' + md(wk));
    let h = '<div class="is-head"><div><h2>' + esc(m.name) + '</h2>' + (mealTags(m).length ? '<div class="tags">' + mealTags(m).join('') + '</div>' : '') + '</div>' +
      '<button class="x-btn" data-act="close-x" aria-label="Close">✕</button></div>';
    const kidAsks = canV9() && isKid(S.me);
    if (kidAsks) {
      const pending = mealRequests().find((x) => x.meal.id === m.id && String(x.who).toLowerCase() === String(S.me).toLowerCase());
      const ask = sh.ask || (sh.ask = { slot: slot, when: 'next week' });
      const seg2 = (field, opts) => '<div class="seg">' + opts.map((o) => '<button type="button" data-act="ask-meal-seg" data-field="' + field + '" data-v="' + esc(o[0]) + '" class="' + (ask[field] === o[0] ? 'on' : '') + '">' + esc(o[1]) + '</button>').join('') + '</div>';
      h += '<div class="is-block first"><div class="is-label">Want this?</div>' + (pending
        ? '<p class="is-fact">You asked for it (' + esc([slotLabel(pending.slot || slot).toLowerCase(), pending.when].filter(String).join(', ')) + '). Waiting for a parent.</p>'
        : seg2('slot', SLOTS.map((x) => [x[0], x[1]])) + seg2('when', [['this week', 'This week'], ['next week', 'Next week'], ['anytime', 'Anytime']]) +
          '<button class="btn btn-primary btn-block" data-act="ask-meal">Ask for it</button><p class="note">A parent picks the day.</p>') + '</div>';
    }
    if (sh.req && amParent()) {
      const rq = mealRequests().find((x) => x.r.id === sh.req);
      if (rq) h += '<div class="is-status on"><b>' + esc(rq.who) + ' asked</b> · ' + esc([slotLabel(rq.slot || slot).toLowerCase(), rq.when].filter(String).join(', ')) + '. Pick a day below.</div>';
    }
    if (!kidAsks) h += '<div class="is-block first"><div class="is-label">' + (slot === 'dinner' ? 'Put it on a night' : 'Put it on a day · ' + slotLabel(slot)) + '</div>' + weeks.map((w) =>
      '<div class="wk"><div class="wk-label">' + wkLabel(w.wk) + '</div><div class="day-chips">' + w.days.map((d) => {
        const other = plan[d] && plan[d] !== m.id && mealById(plan[d]);
        const mine = plan[d] === m.id;
        return '<button class="day-chip' + (mine ? ' on' : other ? ' taken' : '') + '" data-act="plan-meal" data-day="' + d + '" aria-pressed="' + mine + '"' +
          ' aria-label="' + esc(dayName(d) + ' ' + md(d) + (mine ? ', planned' : other ? ', ' + other.name + ' planned' : '')) + '">' +
          '<b>' + (d === D().today ? 'Today' : dayName(d)) + '</b><small>' + (mine ? '✓' : other ? esc(other.name) : md(d)) + '</small></button>';
      }).join('') + '</div></div>').join('') +
      '<p class="note">Tap a ' + (slot === 'dinner' ? 'night' : 'day') + ' to plan it, tap again to take it off. One with something else on it gets swapped.</p></div>';

    const ids = mealItems(m).filter((id) => itemById(id));
    const need = ids.filter((id) => !listRowFor(id));
    h += '<div class="is-block"><div class="is-label">Ingredients</div>' + (ids.length
      ? '<ul class="is-notes">' + ids.map((id) => '<li>' + esc(itemById(id).name) + (listRowFor(id) ? ' <span class="tag tag-listed">On list</span>' : '') + '</li>').join('') + '</ul>' +
        (need.length ? '<button class="btn btn-outline btn-block" data-act="meal-add-all" data-id="' + m.id + '">Add ' + need.length + ' to the List</button>' : '<p class="note">Everything is on the List already.</p>')
      : '<p class="note">No ingredients linked yet.</p>') + '</div>';
    if (m.notes) h += '<div class="is-block"><div class="is-label">Notes</div><p class="is-fact">' + esc(m.notes) + '</p></div>';
    if (!kidAsks) h += '<div class="is-actions"><button class="btn btn-plain" data-act="edit-meal" data-id="' + m.id + '">Edit meal</button></div>';
    return h;
  }

  function viewIdeaSheet(sh) {
    const kid = isKid(S.me);
    return '<h2>Share a meal idea</h2>' +
      '<p class="note">Paste a recipe, a link, or just the idea (from Google, an AI chat, a friend). Poppy reads it, matches the ingredients to what we buy and adds it to Our meals' +
      (kid ? ' once a parent says yes.' : ', usually by the next morning.') + '</p>' +
      '<label class="sr" for="idea-text">Meal idea</label><textarea id="idea-text" class="field idea-text" data-input="draft" data-field="text" rows="8" placeholder="e.g. Sheet-pan chicken fajitas: chicken thighs, 3 bell peppers, onion, fajita seasoning, tortillas…">' + esc(sh.text || '') + '</textarea>' +
      '<div class="sheet-actions"><button class="btn btn-primary" data-act="save-idea"' + (String(sh.text || '').trim() ? '' : ' disabled') + '>Send to Poppy</button></div>';
  }

  function viewIdeaView(sh) {
    const x = (D().ideas || []).find((i) => i.id === sh.id);
    if (!x) return '<p class="note">That idea is gone.</p>';
    return '<div class="is-head"><div><h2>Meal idea</h2><div class="is-sub">' + esc((x.who || 'Someone') + ' · ' + daysAgo(x.at)) + '</div></div><button class="x-btn" data-act="close-x" aria-label="Close">✕</button></div>' +
      '<p class="is-fact idea-body">' + esc(x.text) + (String(x.text).length >= 160 ? '…' : '') + '</p>' +
      (x.notes ? '<p class="note">' + esc(x.notes) + '</p>' : '<p class="note">Poppy turns it into a meal on the next morning check.</p>');
  }

  function planMeal(date, mealId) {
    const slot = canSlots() ? kindOf(mealById(mealId)) : 'dinner';
    const before = planByDate(slot)[date] || '';
    const to = before === mealId ? '' : mealId;
    const wk = addDays(date, -DAYS.indexOf(dayName(date)));
    const m = mealById(mealId); const prev = before && before !== mealId ? mealById(before) : null;
    const msg = to ? m.name + ' on ' + (date === D().today ? 'tonight' : shortDay(date)) + (prev ? ' (instead of ' + prev.name + ')' : '') : 'Took ' + m.name + ' off ' + shortDay(date);
    const send = (meal) => act('planSet', { date: date, day: dayName(date), week_of: wk, meal_id: meal, slot: slot, note: '' }, () => {
      D().plan = D().plan.filter((p) => !(planDate(p) === date && slotOf(p) === slot));
      if (meal) D().plan.push({ date: date, week_of: wk, day: dayName(date), meal_id: meal, slot: slot });
    }, meal === to ? msg : null, meal === to ? () => send(before) : null);
    send(to);
  }

  function viewIngredients(day, meal) {
    const picks = S.mealPick[day] || (S.mealPick[day] = {});
    const ids = mealItems(meal);
    let toAdd = 0;
    const rows = ids.map((id) => {
      const item = itemById(id);
      if (!item) return '';
      if (listRowFor(id)) return '<div class="ing-row"><span class="row-name">' + esc(item.name) + '</span><span class="tag tag-listed">On list</span></div>';
      const need = picks[id] !== false;
      if (need) toAdd++;
      return '<div class="ing-row"><span class="row-name">' + esc(item.name) + '</span><button class="tag ' + (need ? 'tag-need' : 'tag-have') + '" data-act="ing" data-day="' + day + '" data-id="' + id + '">' +
        (need ? 'Need' : 'Have it') + '</button></div>';
    }).join('');
    return '<div class="ing">' + rows + (toAdd ? '<button class="btn btn-primary btn-block" data-act="add-meal" data-day="' + day + '" data-id="' + meal.id + '">Add ' + toAdd + ' to the List</button>'
      : '<div class="note">Everything for ' + esc(meal.name) + ' is covered.</div>') + '</div>';
  }

  /* ---------- ask ---------- */
  // Questions for the current person. Review rows have no audience column yet,
  // so today every open question goes to the parents. Per-person questions come next.
  function myQuestions() {
    const review = D().review || [];
    return review.filter((r) => {
      if (r.type === 'meal_request') return false; // shown on the Meals tab instead
      const aud = String(r.audience || 'parents').trim();
      if (aud === 'all') return true;
      if (aud === 'parents') return amParent();
      return aud.toLowerCase() === String(S.me).toLowerCase();
    });
  }

  // Until Review has an options column, quick picks ride at the end of detail as "Options: A; B; C".
  function splitOptions(detail) {
    const m = String(detail || '').match(/^([\s\S]*?)\s*Options:\s*(.+)$/);
    if (!m) return { q: String(detail || ''), opts: [] };
    return { q: m[1], opts: m[2].split(';').map((o) => o.trim()).filter(String) };
  }
  const isTypeOpt = (o) => /type it|^other$/i.test(o);
  const isSkipOpt = (o) => /^don.?t care$/i.test(o);
  const cleanOpt = (o) => o.replace(/\s*\(type it\)/i, '');

  // The card's control comes from its options, so Claude picks the interaction by how it words them:
  //   Yes; No            -> yes/no (big buttons, swipe right = yes, left = no)
  //   short emoji/labels -> emoji row (ratings, kid-friendly)
  //   2-4 options        -> big tap buttons
  //   5+ options         -> dropdown
  //   no options         -> text box
  function questionKind(opts) {
    const real = opts.filter((o) => !isSkipOpt(o));
    if (real.length === 2 && /^yes\b/i.test(real[0]) && /^no\b/i.test(real[1])) return 'yesno';
    if (real.length >= 2 && real.every((o) => /\p{Extended_Pictographic}/u.test(o) && !/[a-z0-9]/i.test(o) && o.length <= 4)) return 'emoji';
    if (real.length >= 5) return 'dropdown';
    if (real.length) return 'pick';
    return 'text';
  }

  /* Inbox sections (Nov 1, Mike): the deck is grouped, most important first.
     Kids:    Due soon -> How was it? -> Missions -> Quick questions
     Parents: (Approvals list above the deck) -> Decisions -> Due soon -> How was it? -> Missions -> Quick questions
     A Review `section` column wins when it exists; otherwise the section comes from the card's type and text. */
  const SECTIONS = {
    due: { icon: '⏰', label: 'Due soon' },
    decision: { icon: '⚖', label: 'Decisions' },
    rate: { icon: '🍽', label: 'How was it?' },
    mission: { icon: '🔎', label: 'Missions' },
    question: { icon: '💬', label: 'Quick questions' },
  };
  const sectionOrder = () => amParent() ? ['decision', 'due', 'rate', 'mission', 'question'] : ['due', 'rate', 'mission', 'question'];
  function sectionOf(r) {
    const sec = String(r.section || '').toLowerCase();
    if (SECTIONS[sec]) return sec;
    const t = String(r.type || '').toLowerCase(), d = String(r.detail || '');
    if (t === 'task' || r.due_at || /^school lunches for next week/i.test(d) || /\bdue (by )?(mon|tues|wednes|thurs|fri|satur|sun)day\b/i.test(d)) return 'due';
    if (t === 'rate' || t === 'still') return 'rate';
    if (t === 'check' || t === 'mission') return 'mission';
    if (amParent() && (['clarify', 'swap', 'miss', 'unknown_code'].indexOf(t) >= 0 ||
      (t === 'preference' && /\((i\d{3,}|x\d{3,})\)|stop buying|add it to our meals/i.test(d)))) return 'decision';
    return 'question';
  }

  // Approvals for parents: kids' List requests and meal requests (they also stay on List and Meals).
  function myApprovals() {
    if (!amParent()) return 0;
    return D().list.filter((r) => r.status === 'requested').length + (canV9() ? mealRequests().length : 0);
  }
  function inboxEyebrow() {
    const n = myQuestions().length + myApprovals();
    return n ? n + ' waiting for you' : 'All caught up';
  }

  // Deck order: by section (see sectionOrder), then inside a section cards never put off first (sheet
  // order), then saved "Later" cards, oldest Later first (api 10), then anything put off this session.
  // A section chip narrows the deck to one section.
  function askDeck(all) {
    const later = S.askLater || [];
    const order = sectionOrder();
    let qs = myQuestions().map((q, i) => ({ q: q, i: i, s: order.indexOf(sectionOf(q)), lt: later.indexOf(q.id) })).sort((a, b) => {
      if (a.s !== b.s) return a.s - b.s;
      if ((a.lt >= 0) !== (b.lt >= 0)) return a.lt >= 0 ? 1 : -1;
      if (a.lt >= 0) return a.lt - b.lt;
      const la = String(a.q.later_at || ''), lb = String(b.q.later_at || '');
      if (!la !== !lb) return la ? 1 : -1;
      return la < lb ? -1 : la > lb ? 1 : a.i - b.i;
    }).map((x) => x.q);
    if (!all && S.askSection) {
      const only = qs.filter((q) => sectionOf(q) === S.askSection);
      if (only.length) qs = only; else S.askSection = '';
    }
    return qs;
  }

  function viewSectionChips() {
    const counts = {};
    myQuestions().forEach((q) => { const k = sectionOf(q); counts[k] = (counts[k] || 0) + 1; });
    const keys = sectionOrder().filter((k) => counts[k]);
    if (keys.length < 2) return '';
    const chip = (k, label, n) => '<button type="button" class="sec-chip' + ((S.askSection || '') === k ? ' on' : '') + '" data-act="ask-section" data-sec="' + k + '">' + label + (n ? ' <b>' + n + '</b>' : '') + '</button>';
    return '<div class="sec-chips">' + chip('', 'All', 0) + keys.map((k) => chip(k, SECTIONS[k].icon + ' ' + SECTIONS[k].label, counts[k])).join('') + '</div>';
  }

  function viewApprovals() {
    if (!amParent()) return '';
    const reqs = D().list.filter((r) => r.status === 'requested');
    let h = '';
    if (reqs.length) h += '<section class="card requests"><div class="card-head">✅ APPROVALS · ' + reqs.length + '</div>' + reqs.map(requestRow).join('') + '</section>';
    h += viewMealRequests();
    return h;
  }

  function viewAsk() {
    const deck = askDeck();
    const top = viewApprovals();
    if (!deck.length) {
      return top + '<div class="ask-done"><div class="ask-done-mark">✓</div><b>All caught up</b><span class="note">Lunch picks, How was it?, missions and questions show up here.</span></div>' +
        '<p class="hint">Everything here teaches Poppy what the family needs. A parent makes the final call.</p>';
    }
    const r = deck[0];
    const sp = splitOptions(r.detail);
    const kind = questionKind(sp.opts);
    const real = sp.opts.filter((o) => !isSkipOpt(o));
    const typing = S.askTyping === r.id || kind === 'text';
    const total = deck.length + (S.askAnswered || 0);
    const pos = (S.askAnswered || 0) + 1;

    let control = '';
    if (kind === 'yesno') {
      const noTypes = isTypeOpt(real[1]);
      control = '<div class="yn">' +
        '<button type="button" class="yn-btn yn-no" data-act="' + (noTypes ? 'ask-type' : 'ask-pick') + '" data-id="' + r.id + '" data-v="' + esc(cleanOpt(real[1])) + '">' +
        '<span class="yn-icon">✕</span>' + esc(noTypes ? 'No…' : cleanOpt(real[1])) + '</button>' +
        '<button type="button" class="yn-btn yn-yes" data-act="ask-pick" data-id="' + r.id + '" data-v="' + esc(real[0]) + '"><span class="yn-icon">✓</span>' + esc(real[0]) + '</button></div>' +
        '<div class="swipe-hint">← swipe for no · swipe for yes →</div>';
    } else if (kind === 'emoji') {
      control = '<div class="emoji-row">' + real.map((o) => '<button type="button" class="emoji-btn" data-act="ask-pick" data-id="' + r.id + '" data-v="' + esc(o) + '">' + esc(o) + '</button>').join('') + '</div>';
    } else if (kind === 'pick') {
      control = '<div class="pick-list">' + real.map((o) => isTypeOpt(o)
        ? '<button type="button" class="pick-btn pick-other" data-act="ask-type" data-id="' + r.id + '">' + esc(cleanOpt(o)) + '…</button>'
        : '<button type="button" class="pick-btn" data-act="ask-pick" data-id="' + r.id + '" data-v="' + esc(o) + '">' + esc(o) + '</button>').join('') + '</div>';
    } else if (kind === 'dropdown') {
      control = '<div class="drop"><label class="sr" for="ask-sel">Choose</label><select id="ask-sel" class="field" data-input="ask-sel">' +
        '<option value="">Choose one…</option>' + real.filter((o) => !isTypeOpt(o)).map((o) => '<option' + (S.askSel === o ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>' +
        '<button type="button" class="btn btn-primary" data-act="ask-sel-save" data-id="' + r.id + '"' + (S.askSel ? '' : ' disabled') + '>Save</button></div>';
    }

    const textBox = '<form class="ask-text" data-form="ask-text" data-id="' + r.id + '"><label class="sr" for="ask-in">Answer</label>' +
      '<input id="ask-in" class="field" data-input="ask-draft" value="' + esc(S.askDraft || '') + '" placeholder="' + (kind === 'text' ? 'Type an answer…' : 'Type your answer…') + '">' +
      '<button class="btn btn-primary" type="submit">Save</button></form>';

    const sec = SECTIONS[sectionOf(r)];
    let html = top + viewSectionChips() + '<div class="ask-progress"><span>' + pos + ' of ' + total + '</span><div class="bar"><i style="width:' + Math.round(100 * (pos - 1) / total) + '%"></i></div></div>';
    html += '<section class="qcard" data-swipe="' + (kind === 'yesno' ? 'yesno' : 'later') + '" data-id="' + r.id + '">' +
      (r.passed_by && String(r.passed_by).toLowerCase() !== String(S.me).toLowerCase() ? '<div class="passed-note">' + esc(r.passed_by) + ' passed this to you</div>' : '') +
      '<div class="qcard-sec">' + sec.icon + ' ' + esc(sec.label) + '</div>' +
      '<div class="qcard-q">' + esc(sp.q.replace(/\s*\((i\d{3,}|m\d{2,}|x\d{3,}|r\d{3,})\)/g, '')) + '</div>' + control + (typing ? textBox :
        (kind !== 'text' ? '<button type="button" class="link-btn" data-act="ask-type" data-id="' + r.id + '">Something else? Type it</button>' : '')) +
      (S.askPassing === r.id ? viewPassPicker(r) :
      '<div class="qcard-foot"><button type="button" class="btn btn-plain" data-act="review-skip" data-id="' + r.id + '">Don’t care</button>' +
      (canPass() ? '<button type="button" class="btn btn-plain" data-act="ask-pass" data-id="' + r.id + '">Pass ↗</button>' : '') +
      (deck.length > 1 ? '<button type="button" class="btn btn-plain" data-act="ask-later" data-id="' + r.id + '">Later →</button>' : '') + '</div>') + '</section>';
    if (deck.length > 1) html += '<div class="deck-edge"></div>';
    html += '<p class="hint">' + (kind === 'yesno' ? 'Swipe the card right for yes, left for no. ' : '') + 'Answers teach Poppy what the family likes. A parent makes the final call.</p>';
    return html;
  }

  function resetAskCard() { S.askTyping = null; S.askDraft = ''; S.askSel = ''; S.askPassing = null; }

  // Passing needs backend api 2 (reviewPass + the Review audience column).
  const canPass = () => Number(D().api || 0) >= 2;
  const canStock = () => Number(D().api || 0) >= 3;

  function viewPassPicker(r) {
    const people = D().settings.parents.concat(D().settings.kids).filter((p) => p.toLowerCase() !== String(S.me).toLowerCase());
    return '<div class="pass-pick"><div class="pass-title">Who should answer this?</div><div class="pass-people">' +
      people.map((p) => '<button type="button" class="pass-person" data-act="ask-pass-to" data-id="' + r.id + '" data-to="' + esc(p) + '">' +
        '<span class="pass-initial">' + esc(p.charAt(0).toUpperCase()) + '</span>' + esc(p) + '</button>').join('') +
      '</div><button type="button" class="btn btn-plain" data-act="ask-pass" data-id="' + r.id + '">Cancel</button></div>';
  }

  // Slide the current card off screen, then run done().
  function flyCard(dir, done) {
    const card = document.querySelector('.qcard');
    if (!card) { done(); return; }
    const x = dir === 'right' ? 480 : dir === 'left' ? -480 : 0;
    const y = dir === 'up' ? -420 : 0;
    card.style.transition = 'transform 220ms ease-in, opacity 220ms ease-in';
    card.style.transform = 'translate(' + x + 'px,' + y + 'px) rotate(' + (x / 24) + 'deg)';
    card.style.opacity = '0';
    setTimeout(done, 200);
  }

  function answerQuestion(id, value, dir, toastMsg) {
    flyCard(dir || 'right', () => {
      resetAskCard();
      S.askAnswered = (S.askAnswered || 0) + 1;
      S.askLater = (S.askLater || []).filter((x) => x !== id);
      act('reviewAnswer', { id: id, answer: value + ' (' + S.me + ')' }, () => { D().review = D().review.filter((r) => r.id !== id); }, toastMsg || 'Got it');
    });
  }

  /* ---------- order ---------- */
  function viewOrder() {
    const list = D().list.filter((r) => r.status !== 'requested');
    const count = (code) => list.filter((r) => (r.store || 'Either') === code).length;
    const req = D().list.filter((r) => r.status === 'requested').length;
    const requested = D().settings.order_requested;
    const stat = (n, label) => '<div class="stat"><b>' + n + '</b><span>' + label + '</span></div>';
    let html = '<div class="stats">' + stat(count('GE'), 'Giant Eagle') + stat(count('WF'), 'Whole Foods') + stat(count('TGT'), 'Target') + stat(count('AMZ'), 'Amazon') +
      stat(count('Either'), 'either grocery') + '</div>';
    if (req) html += '<p class="note">' + req + ' request' + (req > 1 ? 's' : '') + ' still waiting on the List.</p>';

    CART_STORES.forEach((code) => {
      const st = storeOf(code);
      const day = code === 'GE' ? D().settings.ge_order_day : code === 'WF' ? D().settings.wf_order_day : code === 'TGT' ? 'monthly Drive Up' : '';
      const n = count(code) + (takesEither(code) ? count('Either') : 0);
      const inCart = D().list.filter((r) => r.status === 'carted' && cartStore(r) === code).length;
      html += '<section class="card store-card"><div class="store-title"><b class="head-' + st.cls + '">' + st.name + '</b><span class="note">' + count(code) + (count(code) === 1 ? ' item' : ' items') + (day ? ' · usually ' + esc(day) : '') + (inCart ? ' · ' + inCart + ' in the online cart' : '') + '</span></div>' +
        (amParent() ? '<button class="btn ' + (code === 'GE' ? 'btn-primary' : 'btn-outline') + ' btn-block" data-act="request-order" data-store="' + code + '"' + (n ? '' : ' disabled') + '>Ask Claude to build the ' + st.name + ' cart</button>' : '') +
        '</section>';
    });
    if (requested) {
      html += '<section class="card store-card"><div class="note"><b>Cart requested:</b> ' + esc(requested) + '. Claude fills the cart on Mike’s computer, then any swaps show up in Ask.</div>' +
        (amParent() ? '<button class="btn btn-plain" data-act="clear-order">Clear</button>' : '') + '</section>';
    }
    html += '<p class="hint">Carts are filled for you to review. A person always taps checkout.</p>';
    return html;
  }

  /* ---------- bottom sheets ---------- */
  function viewSheet() {
    const sh = S.sheet;
    if (!sh) return '';
    let inner = '';
    const seg = (field, options, value) => '<div class="seg">' + options.map((o) => '<button type="button" data-act="seg" data-field="' + field + '" data-v="' + esc(o[0]) + '" class="' + (String(value) === String(o[0]) ? 'on' : '') + '">' + esc(o[1]) + '</button>').join('') + '</div>';
    const storeOpts = [['GE', 'Giant Eagle'], ['WF', 'Whole Foods'], ['TGT', 'Target'], ['AMZ', 'Amazon'], ['Either', 'Either']];

    if (sh.type === 'item') inner = viewItemSheet(sh);
    if (sh.type === 'mealcard') inner = viewMealCard(sh);
    if (sh.type === 'idea') inner = viewIdeaSheet(sh);
    if (sh.type === 'ideaview') inner = viewIdeaView(sh);
    if (sh.type === 'day') inner = viewDaySheet(sh);
    if (sh.type === 'hearth') inner = viewHearthSheet(sh);
    if (sh.type === 'feedback') {
      inner = '<h2>💡 Idea for Poppy</h2><p class="note">Something confusing, missing, or a great idea? Say it any way you like. Every one gets read.</p>' +
        '<label class="sr" for="fb-text">Your idea or feedback</label><textarea id="fb-text" class="field idea-text" data-input="draft" data-field="text" rows="6" placeholder="e.g. I wish I could see what’s for lunch tomorrow on the List">' + esc(sh.text || '') + '</textarea>' +
        '<div class="sheet-actions"><button class="btn btn-primary" data-act="save-feedback"' + (String(sh.text || '').trim() ? '' : ' disabled') + '>Send</button></div>' +
        (canIdeas() ? '<button class="link-btn" data-act="feedback-to-meal">Got a meal idea instead? Share it here →</button>' : '');
    }

    if (sh.type === 'meal') {
      const hits = searchItems(sh.q || '', 5).filter((i) => sh.item_ids.indexOf(i.id) < 0);
      inner = '<h2>' + (sh.id ? 'Edit meal' : 'New meal') + '</h2>' +
        '<div><label for="sh-mname">Name</label><input id="sh-mname" class="field" style="width:100%" data-input="draft" data-field="name" value="' + esc(sh.name) + '" placeholder="e.g. Taco night"></div>' +
        (canSlots() ? '<div><label>Usually for</label>' + seg('kind', SLOTS.map((x) => [x[0], x[1]]), sh.kind || 'dinner') + '</div>' : '') +
        '<div><label>Ingredients</label><div class="ing-edit">' + (sh.item_ids.length ? sh.item_ids.map((id) => {
          const it = itemById(id);
          return it ? '<button type="button" data-act="ing-remove" data-id="' + id + '" aria-label="Remove ' + esc(it.name) + '">' + esc(it.name) + ' ✕</button>' : '';
        }).join('') : '<span class="note">None yet.</span>') + '</div></div>' +
        '<div style="position:relative"><label for="sh-mq">Add an ingredient</label><input id="sh-mq" class="field" style="width:100%" data-input="draft" data-field="q" value="' + esc(sh.q || '') + '" placeholder="Search staples…" autocomplete="off">' +
        (hits.length ? '<div class="suggest" style="right:0">' + hits.map((h) => '<button type="button" data-act="ing-add" data-id="' + h.id + '"><span class="s-name">' + esc(h.name) + '</span><span class="s-meta">' + esc(storeOf(h.store).name) + '</span></button>').join('') + '</div>' : '') + '</div>' +
        '<div class="sheet-actions"><button class="btn btn-primary" data-act="save-meal"' + (String(sh.name).trim() ? '' : ' disabled') + '>Save</button></div>';
    }

    const hasX = ['item', 'mealcard', 'ideaview', 'day', 'hearth'].indexOf(sh.type) >= 0;
    return '<div class="scrim" data-act="close-sheet"><div class="sheet' + (hasX ? ' item-sheet' : '') + '" role="dialog" aria-modal="true">' + inner +
      (hasX ? '' : '<button class="btn btn-plain btn-block" data-act="close-sheet">Cancel</button>') + '</div></div>';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  /* ------------------------------------------------------------ events */
  function rowById(id) { return D().list.find((r) => r.id === id) || D().recent.find((r) => r.id === id); }

  const handlers = {
    'boot-retry': () => { firstLoad(); },
    'tip-off': () => { store.set('ff_tip_off', '1'); render(); },
    install: async () => { if (!installEvt) return; installEvt.prompt(); try { await installEvt.userChoice; } catch (e) { /* dismissed */ } installEvt = null; store.set('ff_tip_off', '1'); render(); },
    'pick-me': (el) => { S.me = el.dataset.name; store.set('ff_me', S.me); render(); },
    'switch-me': () => { S.me = ''; S.toast = null; S.query = ''; S.sheet = null; store.del('ff_me'); render(); },
    tab: (el) => { if (el.dataset.tab === 'ask' && S.tab !== 'ask') { S.askAnswered = 0; resetAskCard(); } S.tab = el.dataset.tab; store.set('ff_tab', S.tab); S.query = ''; S.sheet = null; render(); window.scrollTo(0, 0); },
    'ask-section': (el) => { S.askSection = el.dataset.sec || ''; S.askAnswered = 0; resetAskCard(); render(); },
    'ask-pick': (el) => answerQuestion(el.dataset.id, el.dataset.v, el.dataset.v === 'Yes' || /^yes/i.test(el.dataset.v) ? 'right' : 'left'),
    'ask-type': (el) => { S.askTyping = el.dataset.id; render(); const f = document.getElementById('ask-in'); if (f) f.focus(); },
    'ask-sel-save': (el) => { if (S.askSel) answerQuestion(el.dataset.id, S.askSel); },
    'ask-pass': (el) => { S.askPassing = S.askPassing === el.dataset.id ? null : el.dataset.id; render(); },
    'ask-pass-to': (el) => {
      const id = el.dataset.id; const to = el.dataset.to;
      flyCard('up', () => {
        resetAskCard();
        act('reviewPass', { id: id, to: to }, () => {
          const q = D().review.find((x) => x.id === id);
          if (q) { q.audience = to; q.passed_by = S.me; }
        }, 'Passed to ' + to);
      });
    },
    'ask-later': (el) => {
      const id = el.dataset.id;
      S.askLater = (S.askLater || []).filter((x) => x !== id).concat([id]);
      flyCard('left', () => {
        resetAskCard();
        // api 10 saves it, so the card stays at the back tomorrow too and can be recycled.
        if (Number(D().api || 0) >= 10) {
          act('reviewLater', { id: id }, () => {
            const q = D().review.find((x) => x.id === id);
            if (q) { q.later_count = (Number(q.later_count) || 0) + 1; q.later_at = new Date().toISOString(); }
          });
        } else render();
      });
    },
    'review-skip': (el) => answerQuestion(el.dataset.id, 'skip', 'up', 'Skipped'),
    undo: () => { const u = S.toast && S.toast.undo; S.toast = null; if (u) u(); else render(); },

    approve: (el) => { const r = rowById(el.dataset.id); if (r) act('update', { id: r.id, fields: { status: 'needed' } }, () => (r.status = 'needed'), 'Approved ' + r.name); },
    skip: (el) => { const r = rowById(el.dataset.id); if (r) setStatus(r, 'skipped', 'Skipped ' + r.name); },
    restore: (el) => { const r = rowById(el.dataset.id); if (r) restore(r); },
    'toggle-day': (el) => { S.openDay = S.openDay === el.dataset.day ? null : el.dataset.day; render(); },
    ing: (el) => { const p = S.mealPick[el.dataset.day] || (S.mealPick[el.dataset.day] = {}); p[el.dataset.id] = p[el.dataset.id] === false; render(); },
    'add-meal': (el) => {
      const meal = mealById(el.dataset.id);
      const picks = S.mealPick[el.dataset.day] || {};
      const ids = mealItems(meal).filter((id) => itemById(id) && !listRowFor(id) && picks[id] !== false);
      if (!ids.length) return;
      const status = isKid(S.me) ? 'requested' : 'needed';
      S.openDay = null;
      act('addMeal', { meal_id: meal.id, item_ids: ids }, () => {
        ids.forEach((id) => { const it = itemById(id); D().list.push({ id: tmpId(), item_id: id, name: it.name, store: it.store, qty: 1, added_by: S.me, status: status, meal_id: meal.id }); });
      }, 'Added ' + ids.length + ' for ' + meal.name);
    },
    'open-meal': (el) => { if (mealById(el.dataset.id)) { S.sheet = { type: 'mealcard', id: el.dataset.id, req: el.dataset.req || '' }; render(); } },
    'plan-meal': (el) => {
      const sh = S.sheet; if (!sh || sh.type !== 'mealcard') return;
      planMeal(el.dataset.day, sh.id);
      // Planning it from a kid's request answers the request.
      if (sh.req) { const id = sh.req; sh.req = ''; act('reviewAnswer', { id: id, answer: 'Yes, ' + shortDay(el.dataset.day) + ' (' + S.me + ')' }, () => { D().review = D().review.filter((r) => r.id !== id); }); }
    },
    'ask-meal-seg': (el) => { S.sheet.ask[el.dataset.field] = el.dataset.v; render(); },
    'ask-meal': () => {
      const sh = S.sheet; const m = mealById(sh.id); if (!m) return;
      const a = sh.ask;
      act('mealRequest', { meal_id: m.id, slot: a.slot, when: a.when }, () => {
        D().review.push({ id: tmpId(), type: 'meal_request', status: 'open', audience: 'parents', asked_by: S.me, detail: S.me + ' wants ' + m.name + ' for ' + a.slot + ', ' + a.when + '. (' + m.id + ') Options: Plan it; Not now' });
      }, 'Asked for ' + m.name);
    },
    'req-no': (el) => { const id = el.dataset.id; act('reviewAnswer', { id: id, answer: 'Not now (' + S.me + ')' }, () => { D().review = D().review.filter((r) => r.id !== id); }, 'Said not now'); },
    'req-cancel': (el) => { const id = el.dataset.id; act('reviewAnswer', { id: id, answer: 'Cancelled (' + S.me + ')' }, () => { D().review = D().review.filter((r) => r.id !== id); }, 'Cancelled'); },
    'open-feedback': () => { S.sheet = { type: 'feedback', text: '' }; render(); const f = document.getElementById('fb-text'); if (f) f.focus(); },
    'save-feedback': () => {
      const text = String((S.sheet && S.sheet.text) || '').trim(); if (!text) return;
      S.sheet = null;
      act('feedback', { text: text, tab: S.tab }, null, 'Thanks! Sent.');
    },
    'feedback-to-meal': () => { S.sheet = { type: 'idea', text: (S.sheet && S.sheet.text) || '' }; render(); },
    'meal-add-all': (el) => {
      const meal = mealById(el.dataset.id);
      const ids = mealItems(meal).filter((id) => itemById(id) && !listRowFor(id));
      if (!ids.length) return;
      const status = isKid(S.me) ? 'requested' : 'needed';
      act('addMeal', { meal_id: meal.id, item_ids: ids }, () => {
        ids.forEach((id) => { const it = itemById(id); D().list.push({ id: tmpId(), item_id: id, name: it.name, store: it.store, qty: 1, added_by: S.me, wanted_by: S.me, status: status, meal_id: meal.id }); });
      }, 'Added ' + ids.length + ' for ' + meal.name);
    },
    'meal-sort': (el) => { S.mealSort = el.dataset.v; render(); },
    'new-idea': () => { S.sheet = { type: 'idea', text: '' }; render(); const f = document.getElementById('idea-text'); if (f) f.focus(); },
    'open-idea': (el) => { S.sheet = { type: 'ideaview', id: el.dataset.id }; render(); },
    'save-idea': () => {
      const text = String((S.sheet && S.sheet.text) || '').trim();
      if (!text) return;
      S.sheet = null;
      act('mealIdea', { text: text }, () => {
        (D().ideas = D().ideas || []).push({ id: tmpId(), at: D().today, who: S.me, text: text.slice(0, 160), status: 'new', meal_id: '', notes: '' });
      }, 'Sent. Poppy will add it to Our meals.');
    },
    'new-meal': () => { S.sheet = { type: 'meal', id: '', name: '', item_ids: [], q: '', kind: S.mealKind && S.mealKind !== 'all' ? S.mealKind : 'dinner' }; render(); },
    'edit-meal': (el) => { const m = mealById(el.dataset.id); if (m) { S.sheet = { type: 'meal', id: m.id, name: m.name, item_ids: mealItems(m), q: '', kind: kindOf(m) }; render(); } },
    'meal-kind': (el) => { S.mealKind = el.dataset.v; render(); },
    'open-day': (el) => { S.sheet = { type: 'day', day: el.dataset.day }; render(); },
    'open-hearth': () => { S.sheet = { type: 'hearth', week: 'this' }; render(); },
    'hearth-week': (el) => { S.sheet.week = el.dataset.v; render(); },
    'hearth-copy': async () => {
      const text = hearthText(hearthDays(S.sheet.week));
      try { await navigator.clipboard.writeText(text); showToast('Copied. Paste it to Hearth Helper.'); }
      catch (e) { const f = document.getElementById('hearth-text'); if (f) { f.focus(); f.select(); } showToast('Select all and copy'); }
    },
    'hearth-share': async () => {
      try { await navigator.share({ text: hearthText(hearthDays(S.sheet.week)) }); } catch (e) { /* cancelled */ }
    },
    'ing-add': (el) => { S.sheet.item_ids.push(el.dataset.id); S.sheet.q = ''; render(); const f = document.getElementById('sh-mq'); if (f) f.focus(); },
    'ing-remove': (el) => { S.sheet.item_ids = S.sheet.item_ids.filter((id) => id !== el.dataset.id); render(); },
    'save-meal': () => {
      const sh = S.sheet;
      if (!String(sh.name).trim()) return;
      S.sheet = null;
      act('mealSave', { id: sh.id, name: sh.name.trim(), item_ids: sh.item_ids, kind: sh.kind || 'dinner' }, () => {
        const m = mealById(sh.id);
        if (m) { m.name = sh.name.trim(); m.item_ids = sh.item_ids.join(';'); m.kind = sh.kind || 'dinner'; }
        else D().meals.push({ id: tmpId(), name: sh.name.trim(), item_ids: sh.item_ids.join(';'), kind: sh.kind || 'dinner' });
      }, 'Saved ' + sh.name.trim());
    },

    'request-order': (el) => {
      const code = el.dataset.store;
      act('requestOrder', { store: storeOf(code).name }, () => { D().settings.order_requested = storeOf(code).name + ' requested by ' + S.me; }, 'Cart requested');
    },
    'clear-order': () => act('requestOrder', { store: '' }, () => { D().settings.order_requested = ''; }),

    seg: (el) => { S.sheet[el.dataset.field] = el.dataset.v; render(); },
    unhold: (el) => { const r = (D().held || []).find((x) => x.id === el.dataset.id); if (r) unhold(r); },
    'open-row': (el) => {
      const r = rowById(el.dataset.id) || (D().held || []).find((x) => x.id === el.dataset.id);
      if (r) openItemSheet(r.item_id, r.id, r.name);
    },
    'open-item': (el) => openItemSheet(el.dataset.id),
    'add-item': (el) => {
      const it = itemById(el.dataset.id);
      if (!it) { render(); return; }
      addItem(it);
    },
    'add-new': () => { const q = S.query; S.query = ''; addNew(q); },
    'close-x': () => { S.sheet = null; render(); },
    'row-qty': (el) => {
      const r = sheetRow(); if (!r) return;
      const q = Math.max(1, (Number(r.qty) || 1) + Number(el.dataset.d));
      act('update', { id: r.id, fields: { qty: q } }, () => { r.qty = q; });
    },
    'have-level': (el) => {
      const v = el.dataset.v;
      if (v === 'count') { S.sheet.level = 'count'; render(); return; }
      haveDone(v);
    },
    'have-count': (el) => { S.sheet.count = Math.max(1, Math.min(999, S.sheet.count + Number(el.dataset.d))); render(); },
    'have-count-save': () => haveDone(String(S.sheet.count)),
    'row-hold': () => { const r = sheetRow(); S.sheet = null; if (r) holdRow(r, ''); else render(); },
    'row-bought': () => { const r = sheetRow(); S.sheet = null; if (r) setStatus(r, 'bought', 'Bought ' + r.name); else render(); },
    'row-remove': () => { const r = sheetRow(); S.sheet = null; if (r) setStatus(r, 'skipped', 'Took ' + r.name + ' off'); else render(); },
    'toggle-details': () => { S.sheet.details = !S.sheet.details; render(); },
    'd-seg': (el) => { S.sheet.d[el.dataset.field] = el.dataset.v; render(); },
    'save-details': () => {
      const sh = S.sheet; const it = itemById(sh.item_id);
      if (!it || isKid(S.me)) return;
      const fields = Object.assign({}, sh.d);
      const r = sheetRow();
      sh.details = false;
      act('itemSave', { id: it.id, fields: fields }, () => { Object.assign(it, fields); }, 'Saved');
      if (r && r.store !== fields.store) act('update', { id: r.id, fields: { store: fields.store } }, () => { r.store = fields.store; });
    },
    fold: (el) => { const k = el.dataset.key; setClosed(k, !isClosed(k)); render(); },
    'fold-all': () => {
      const keys = groupsIn(D().list.filter((r) => r.status !== 'requested')).map((g) => 'a:' + g);
      const close = !keys.every((k) => isClosed(k));
      keys.forEach((k) => setClosed(k, close));
      render();
    },
    unfade: (el) => {
      const f = S.fading[el.dataset.id];
      if (!f) return;
      S.toast = null;
      restore(f.row, f.before);
    },
    'shop-fold-all': (el) => {
      const keys = String(el.dataset.keys || '').split('|').filter(String);
      const close = !keys.every((k) => isClosed(k));
      keys.forEach((k) => setClosed(k, close));
      render();
    },
    'shop-filter': (el) => { S.shopFilter = el.dataset.v; render(); window.scrollTo(0, 0); },
    'shop-store': (el) => { S.shopStore = el.dataset.v; render(); },
    'store-start': () => { S.instore = store.get('ff_instore_last') || 'GE'; store.set('ff_instore', S.instore); S.tab = 'list'; render(); window.scrollTo(0, 0); },
    'store-pick': (el) => { S.instore = el.dataset.v; store.set('ff_instore', S.instore); store.set('ff_instore_last', S.instore); render(); },
    'store-done': () => {
      const n = D().recent.filter((r) => boughtToday(r) && inStore(r)).length;
      store.set('ff_instore_last', S.instore); S.instore = ''; store.del('ff_instore');
      showToast(n ? n + ' bought' : 'Back home'); render(); window.scrollTo(0, 0);
    },
    'store-check': (el) => { const r = D().list.find((x) => x.id === el.dataset.id); if (r) setStatus(r, 'bought'); },
    'store-uncheck': (el) => {
      const r = D().recent.find((x) => x.id === el.dataset.id);
      if (!r) return;
      act('update', { id: r.id, fields: { status: 'needed' } }, () => {
        D().recent = D().recent.filter((x) => x.id !== r.id);
        D().list.push(Object.assign({}, r, { status: 'needed' }));
      });
    },
    'close-sheet': (el, ev) => { if (ev.target === el) { S.sheet = null; render(); } },
  };

  // The List row the open item screen is about (if any).
  function sheetRow() {
    const sh = S.sheet; if (!sh) return null;
    return (sh.row_id && (D().list.find((r) => r.id === sh.row_id) || (D().held || []).find((r) => r.id === sh.row_id))) ||
      (sh.item_id && (listRowFor(sh.item_id) || (D().held || []).find((r) => r.item_id === sh.item_id))) || null;
  }

  // "We have some": on the List it closes the row (status have); otherwise it's just a Stock sighting.
  function haveDone(level) {
    const sh = S.sheet; const r = sheetRow();
    S.sheet = null;
    // "A little" means we still need it: log the sighting, keep it on the List.
    if (r && level !== 'low') { markHave(r, level); return; }
    const it = itemById(sh.item_id);
    if (r) {
      act('stockLog', { item_id: sh.item_id, level: level }, () => {
        (D().stock = D().stock || {})[sh.item_id] = { level: level, at: D().today, who: S.me };
      }, 'Noted: a little left. ' + (it ? it.name : 'It') + ' stays on the List.');
      return;
    }
    act('stockLog', { item_id: sh.item_id, level: level }, () => {
      (D().stock = D().stock || {})[sh.item_id] = { level: level, at: D().today, who: S.me };
    }, 'Noted: ' + levelText(level) + ' at home' + (it ? ' (' + it.name + ')' : ''));
  }

  function openItem(it) {
    if (it && it.id) { openItemSheet(it.id); return; }
    S.sheet = it
      ? { type: 'item', id: it.id, name: it.name, store: it.store || 'Either', group: it.group || 'Other', brand_size: it.brand_size || '', ok_swap: it.ok_swap || '', status: it.status || '', notes: it.notes || '', orders: Number(it.orders) || 0, last_bought: it.last_bought, avg_days: it.avg_days }
      : { type: 'item', id: '', name: '', store: S.storeFilter !== 'all' ? S.storeFilter : 'Either', group: 'Other', brand_size: '', ok_swap: '', status: '', notes: '' };
    render();
  }

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el) {
      return;
    }
    const fn = handlers[el.dataset.act];
    if (!fn) return;
    if (el.dataset.act === 'close-sheet') { fn(el, ev); return; }
    ev.preventDefault();
    fn(el, ev);
  });

  document.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.id === 'add') { S.query = el.value; render(); return; }
    const kind = el.dataset && el.dataset.input;
    if (kind === 'staples-q') { S.staplesQuery = el.value; render(); }
    if (kind === 'ask-draft') { S.askDraft = el.value; }
    if (kind === 'd' && S.sheet && S.sheet.d) S.sheet.d[el.dataset.field] = el.value;
    if (kind === 'draft' && S.sheet) {
      S.sheet[el.dataset.field] = el.value;
      // Only the meal search and name-gated Save buttons need a redraw while typing.
      if (el.dataset.field === 'q' || el.dataset.field === 'name') render();
      if (el.dataset.field === 'text') { const b = document.querySelector('[data-act="save-idea"], [data-act="save-feedback"]'); if (b) b.disabled = !el.value.trim(); }
    }
  });

  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.dataset && el.dataset.input === 'plan') {
      const day = el.dataset.day; const mealId = el.value;
      S.openDay = mealId ? day : null;
      S.mealPick[day] = {};
      // day here is the ISO date. week_of + day ride along so an older backend files it correctly.
      const wk = addDays(day, -DAYS.indexOf(dayName(day)));
      act('planSet', { date: day, day: dayName(day), week_of: wk, meal_id: mealId, slot: 'dinner', note: '' }, () => {
        D().plan = D().plan.filter((p) => !(planDate(p) === day && slotOf(p) === 'dinner'));
        if (mealId) D().plan.push({ date: day, week_of: wk, day: dayName(day), meal_id: mealId, slot: 'dinner' });
      });
    }
    if (el.dataset && el.dataset.input === 'slot-plan') {
      const day = el.dataset.day; const slot = el.dataset.slot; const mealId = el.value;
      const wk = addDays(day, -DAYS.indexOf(dayName(day)));
      act('planSet', { date: day, day: dayName(day), week_of: wk, meal_id: mealId, slot: slot, note: '' }, () => {
        D().plan = D().plan.filter((p) => !(planDate(p) === day && slotOf(p) === slot));
        if (mealId) D().plan.push({ date: day, week_of: wk, day: dayName(day), meal_id: mealId, slot: slot });
      });
    }
    if (el.dataset && el.dataset.input === 'ask-sel') { S.askSel = el.value; render(); }
    if (el.dataset && el.dataset.input === 'd' && S.sheet && S.sheet.d) S.sheet.d[el.dataset.field] = el.value;
    if (el.dataset && el.dataset.input === 'row-note') {
      const r = D().list.find((x) => x.id === el.dataset.id) || (D().held || []).find((x) => x.id === el.dataset.id);
      if (r && r.note !== el.value) { const v = el.value; act('update', { id: r.id, fields: { note: v } }, () => { r.note = v; }, 'Note saved'); }
    }
    if (el.dataset && el.dataset.input === 'draft' && el.tagName === 'SELECT' && S.sheet) S.sheet[el.dataset.field] = el.value;
  });

  document.addEventListener('submit', async (ev) => {
    const form = ev.target;
    ev.preventDefault();
    if (form.dataset.form === 'unlock') {
      const v = document.getElementById('pass').value.trim();
      if (!v) return;
      const f = document.getElementById('pass'); if (f) f.blur();
      S.pass = v; S.loading = true; S.setupError = '';
      const ok = await firstLoad();
      S.loading = false;
      if (ok) store.set('ff_pass', v);
      else if (S.pass) { S.pass = ''; S.setupError = S.bootError; S.bootError = ''; }
      render();
    }
    if (form.dataset.form === 'add') {
      const q = S.query.trim();
      if (!q) return;
      const hits = searchItems(q, 1);
      S.query = '';
      if (hits.length && String(hits[0].name).toLowerCase() === q.toLowerCase()) addItem(hits[0]);
      else addNew(q);
      render();
      const f = document.getElementById('add'); if (f) f.blur();
    }
    if (form.dataset.form === 'ask-text') {
      const answer = (S.askDraft || '').trim();
      if (!answer) return;
      const f = document.getElementById('ask-in'); if (f) f.blur();
      answerQuestion(form.dataset.id, answer);
    }
  });

  // Swipe on question cards: yes/no cards answer (right = yes, left = no); others go to "Later" on a left swipe.
  let drag = null;
  document.addEventListener('pointerdown', (ev) => {
    const card = ev.target.closest('.qcard');
    if (!card || ev.target.closest('button, input, select, a, label')) return;
    drag = { card: card, x: ev.clientX, y: ev.clientY, dx: 0, moved: false };
    S.dragging = true;
  });
  document.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    drag.dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (!drag.moved && Math.abs(drag.dx) < 8) return;
    if (!drag.moved && Math.abs(dy) > Math.abs(drag.dx)) { drag = null; S.dragging = false; return; }
    drag.moved = true;
    drag.card.style.transition = 'none';
    drag.card.style.transform = 'translateX(' + drag.dx + 'px) rotate(' + (drag.dx / 20) + 'deg)';
    const yn = drag.card.dataset.swipe === 'yesno';
    drag.card.classList.toggle('lean-yes', yn && drag.dx > 40);
    drag.card.classList.toggle('lean-no', yn && drag.dx < -40);
    drag.card.classList.toggle('lean-later', !yn && drag.dx < -40);
  });
  const endDrag = () => {
    if (!drag) return;
    const d = drag; drag = null; S.dragging = false;
    if (!d.moved) return;
    const id = d.card.dataset.id;
    const yn = d.card.dataset.swipe === 'yesno';
    if (Math.abs(d.dx) > 90) {
      if (yn) {
        const yes = d.card.querySelector('.yn-yes'); const no = d.card.querySelector('.yn-no');
        const btn = d.dx > 0 ? yes : no;
        if (btn && btn.dataset.act === 'ask-type') { S.askTyping = id; render(); return; }
        if (btn) { answerQuestion(id, btn.dataset.v, d.dx > 0 ? 'right' : 'left'); return; }
      } else if (d.dx < 0 && askDeck().length > 1) { handlers['ask-later']({ dataset: { id: id } }); return; }
    }
    d.card.style.transition = 'transform 180ms ease-out';
    d.card.style.transform = '';
    d.card.classList.remove('lean-yes', 'lean-no', 'lean-later');
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (S.sheet) { S.sheet = null; render(); }
      else if (S.query) { S.query = ''; render(); }
    }
  });

  /* ------------------------------------------------------------ boot */
  let stripTouched = 0;
  document.addEventListener('scroll', (ev) => { if (ev.target && ev.target.classList && ev.target.classList.contains('week-strip')) stripTouched = Date.now(); }, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => {
    // Don't redraw under someone mid-edit.
    if (document.hidden || S.sheet || S.query) return;
    if (Date.now() - stripTouched < 3000) return; // mid-swipe through a week strip
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) return;
    refresh();
  }, POLL_MS);

  if (S.pass && apiUrl()) firstLoad(); else render();
})();
