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
    GE: { name: 'Giant Eagle', cls: 'ge' },
    WF: { name: 'Whole Foods', cls: 'wf' },
    TGT: { name: 'Target', cls: 'tgt' },
    Either: { name: 'Either grocery store', cls: 'either' },
  };
  const STORE_ORDER = ['GE', 'WF', 'TGT', 'Either'];
  const CART_STORES = ['GE', 'WF', 'TGT'];
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
    tab: store.get('ff_tab') || 'list',
    storeFilter: 'all',
    editMode: false,
    query: '',
    staplesQuery: '',
    openDay: null,
    mealPick: {},      // day -> { itemId: true/false } (need it?)
    sheet: null,       // bottom sheet { type, ...draft }
    toast: null,
    setupError: '',
    loading: false,
  };

  let seq = 0;
  let applied = 0;

  /* ------------------------------------------------------------ api */
  function apiUrl() { return (window.FF_CONFIG && window.FF_CONFIG.API_URL) || ''; }

  async function api(action, payload) {
    const mine = ++seq;
    const body = Object.assign({ action: action, pass: S.pass, by: S.me }, payload || {});
    // text/plain keeps this a "simple" request, so Apps Script needs no CORS preflight.
    const res = await fetch(apiUrl(), { method: 'POST', body: JSON.stringify(body) });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'Something went wrong');
    if (j.state && mine >= applied) { applied = mine; S.data = j.state; }
    return j;
  }

  async function refresh() {
    if (!S.pass || !apiUrl()) return;
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
    if (optimistic) { optimistic(); render(); }
    if (toastMsg) showToast(toastMsg, undo);
    try { await api(action, payload); render(); }
    catch (e) { handleError(e); refresh(); }
  }

  /* ------------------------------------------------------------ data helpers */
  const D = () => S.data || { items: [], list: [], held: [], recent: [], meals: [], plan: [], review: [], due: [], settings: { parents: [], kids: [] } };
  const itemById = (id) => D().items.find((i) => i.id === id);
  const mealById = (id) => D().meals.find((m) => m.id === id);
  const listRowFor = (itemId) => D().list.find((r) => r.item_id === itemId);
  const isKid = (name) => D().settings.kids.map((k) => k.toLowerCase()).indexOf(String(name || '').toLowerCase()) >= 0;
  const amParent = () => !isKid(S.me);
  const storeOf = (code) => STORES[code] || STORES.Either;
  const mealItems = (meal) => String(meal && meal.item_ids || '').split(';').filter(Boolean);
  const tmpId = () => 'tmp' + Date.now() + Math.floor(Math.random() * 1000);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function searchItems(q, limit) {
    const n = q.trim().toLowerCase();
    if (!n) return [];
    const hits = D().items.filter((i) => i.status !== 'Drop' && String(i.name).toLowerCase().indexOf(n) >= 0);
    hits.sort((a, b) => {
      const as = String(a.name).toLowerCase().indexOf(n) === 0 ? 0 : 1;
      const bs = String(b.name).toLowerCase().indexOf(n) === 0 ? 0 : 1;
      return as - bs || (Number(b.orders) || 0) - (Number(a.orders) || 0);
    });
    return hits.slice(0, limit || 6);
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
    const existing = listRowFor(item.id);
    if (existing) { showToast(item.name + ' is already on the list'); return; }
    const status = isKid(S.me) ? 'requested' : 'needed';
    const row = Object.assign({ id: tmpId(), item_id: item.id, name: item.name, store: item.store || 'Either', qty: 1, note: '', added_by: S.me, status: status }, extra || {});
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
      D().list.push({ id: tmpId(), item_id: '', name: clean, store: storeCode || 'Either', qty: 1, added_by: S.me, status: status });
    }, (status === 'requested' ? 'Asked for ' : 'Added ') + clean);
  }

  function setStatus(row, status, msg) {
    const before = row.status;
    act('update', { id: row.id, fields: { status: status } }, () => {
      row.status = status;
      if (status === 'bought' || status === 'skipped' || status === 'have') {
        D().list = D().list.filter((r) => r !== row);
        D().recent.push(Object.assign({}, row, { status: status, updated_at: D().today }));
      }
    }, msg, msg && (status === 'bought' || status === 'skipped') ? () => restore(row, before) : null);
  }

  function restore(row, status) {
    const to = status || 'needed';
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
    act('listHave', { id: row.id, level: level }, () => {
      D().list = D().list.filter((r) => r !== row);
      D().recent.push(Object.assign({}, row, { status: 'have', note: 'had ' + level, updated_at: D().today }));
    }, 'Got it: we have ' + levelText(level), () => restore(row, row.status));
  }

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
    if (!apiUrl()) root.innerHTML = viewNoBackend();
    else if (!S.pass || !S.data) root.innerHTML = viewSetup();
    else if (!S.me) root.innerHTML = viewPickPerson();
    else root.innerHTML = viewApp();
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
    return '<div class="setup"><h1>Poppy 2.0</h1><p class="note">The app isn’t connected to its Google Sheet yet. Add the Apps Script URL to <b>config.js</b> (see the README).</p></div>';
  }

  function viewSetup() {
    return '<form class="setup" data-form="unlock">' +
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
    return '<div class="setup"><div><div class="eyebrow">Poppy 2.0</div><h1>Who’s this?</h1></div>' +
      '<p class="note">Pick your name so everyone knows who added what.</p>' +
      '<div class="people">' + people.map((p) => '<button data-act="pick-me" data-name="' + esc(p) + '">' + esc(p) + '</button>').join('') + '</div></div>';
  }

  function viewApp() {
    const titles = { list: 'The List', staples: 'Staples', meals: 'Meals', ask: 'Ask', order: 'Order' };
    const eyebrows = { list: 'Poppy 2.0', staples: 'We’re out of…', meals: 'Week of ' + fmtDate(D().weekOf), ask: 'Your say', order: 'Order day' };
    let top = '<header class="top"><div class="top-row"><div><div class="eyebrow">' + esc(eyebrows[S.tab]) + '</div><h1>' + titles[S.tab] + '</h1></div>' +
      '<button class="me" data-act="switch-me" aria-label="Switch person">' + esc(S.me) + '</button></div>';
    if (S.tab === 'list') top += viewAddBar();
    if (S.tab === 'staples') top += viewStaplesFilters();
    top += '</header>';

    let body = '';
    if (S.tab === 'list') body = viewList();
    if (S.tab === 'staples') body = viewStaples();
    if (S.tab === 'meals') body = viewMeals();
    if (S.tab === 'ask') body = viewAsk();
    if (S.tab === 'order') body = viewOrder();

    return top + '<main>' + body + '</main>' + viewNav() + viewSheet() + viewToast();
  }

  function viewNav() {
    const req = D().list.filter((r) => r.status === 'requested').length;
    const review = myQuestions().length;
    const tab = (id, label, badge) => '<button data-act="tab" data-tab="' + id + '" class="' + (S.tab === id ? 'on' : '') + '">' + label +
      (badge ? '<span class="dot">' + badge + '</span>' : '') + '</button>';
    return '<nav class="tabs" aria-label="Sections"><div class="inner">' +
      tab('list', 'List', amParent() ? req : 0) + tab('staples', 'Staples') + tab('meals', 'Meals') + tab('ask', 'Ask', review) + tab('order', 'Order') +
      '</div></nav>';
  }

  function viewToast() {
    if (!S.toast || S.sheet) return '';
    return '<div class="toast" role="status"><span>' + esc(S.toast.text) + '</span>' + (S.toast.undo ? '<button data-act="undo">Undo</button>' : '') + '</div>';
  }

  /* ---------- list ---------- */
  function viewAddBar() {
    const q = S.query;
    let sug = '';
    if (q.trim()) {
      const hits = searchItems(q, 6);
      const exact = hits.some((h) => String(h.name).toLowerCase() === q.trim().toLowerCase());
      sug = '<div class="suggest">' + hits.map((h) => {
        const onList = listRowFor(h.id);
        return '<button data-act="add-item" data-id="' + h.id + '"><span class="s-name">' + esc(h.name) + '</span><span class="s-meta">' +
          (onList ? 'on list' : esc(storeOf(h.store).name)) + '</span></button>';
      }).join('') + (exact ? '' : '<button data-act="add-new"><span class="s-name">Add “' + esc(q.trim()) + '”</span><span class="s-meta">new item</span></button>') + '</div>';
    }
    return '<form class="addbar" data-form="add" autocomplete="off"><label class="sr" for="add">Add an item</label>' +
      '<input id="add" class="field" placeholder="' + (isKid(S.me) ? 'Ask for something…' : 'Add an item…') + '" value="' + esc(q) + '" enterkeyhint="done">' +
      '<button class="btn-icon" type="submit" aria-label="Add item">+</button>' + sug + '</form>';
  }

  function rowHtml(r, opts) {
    const meta = [];
    if (Number(r.qty) > 1) meta.push('×' + r.qty);
    if (r.note) meta.push(esc(r.note));
    if (r.meal_id && mealById(r.meal_id)) meta.push(esc(mealById(r.meal_id).name));
    const item = itemById(r.item_id);
    if (item && item.brand_size) meta.push(esc(item.brand_size));
    const who = String(r.added_by || '?').charAt(0).toUpperCase();
    let right = '<span class="who' + (isKid(r.added_by) ? ' kid' : '') + '" title="Added by ' + esc(r.added_by) + '">' + esc(who) + '</span>';
    if (opts && opts.request) {
      const btns = amParent()
        ? '<button class="btn btn-primary" data-act="approve" data-id="' + r.id + '">Approve</button><button class="btn btn-quiet" data-act="skip" data-id="' + r.id + '">Skip</button>'
        : (r.added_by === S.me ? '<button class="btn btn-quiet" data-act="skip" data-id="' + r.id + '">Cancel</button>' : '');
      return '<div class="row"><span class="who kid" title="Asked by ' + esc(r.added_by) + '">' + esc(who) + '</span>' +
        '<div class="row-main"><span class="row-name">' + esc(r.name) + '</span>' +
        (meta.length ? '<span class="row-meta">' + meta.join(' · ') + '</span>' : '') + '</div>' + btns + '</div>';
    }
    return '<div class="row"><button class="check" data-act="bought" data-id="' + r.id + '" aria-label="Mark ' + esc(r.name) + ' bought"></button>' +
      '<button class="row-main" data-act="open-row" data-id="' + r.id + '"><span class="row-name">' + esc(r.name) + '</span>' +
      (meta.length ? '<span class="row-meta">' + meta.join(' · ') + '</span>' : '') + '</button>' + right + '</div>';
  }

  function viewList() {
    const list = D().list;
    const requests = list.filter((r) => r.status === 'requested');
    const active = list.filter((r) => r.status !== 'requested');
    let html = '';

    if (requests.length) {
      html += '<section class="card requests"><div class="card-head">' + (amParent() ? 'REQUESTS · ' + requests.length : 'WAITING FOR A PARENT · ' + requests.length) + '</div>' +
        requests.map((r) => rowHtml(r, { request: true })).join('') + '</section>';
    }

    STORE_ORDER.forEach((code) => {
      const rows = active.filter((r) => (r.store || 'Either') === code);
      if (!rows.length) return;
      const st = storeOf(code);
      html += '<section class="card"><div class="card-head head-' + st.cls + '"><span>' + st.name.toUpperCase() + ' · ' + rows.length + '</span>' +
        (code === 'Either' ? '<span class="sub">tap to pick a store</span>' : '') + '</div>' + rows.map((r) => rowHtml(r)).join('') + '</section>';
    });

    if (!list.length) html += '<div class="empty">Nothing on the list yet.<br>Add something above, or tap a few Staples.</div>';

    const due = D().due.map((d) => Object.assign({}, d, { item: itemById(d.id) })).filter((d) => d.item);
    if (due.length && !isKid(S.me)) {
      html += '<section class="card dashed"><div class="card-head head-either">PROBABLY DUE</div>' + due.map((d) =>
        '<div class="row"><div class="row-main"><span class="row-name">' + esc(d.item.name) + '</span><span class="row-meta">' + esc(storeOf(d.item.store).name) +
        ' · usually every ~' + d.every + ' days · last ' + esc(daysAgo(d.item.last_bought)) + '</span></div>' +
        '<button class="btn btn-outline" data-act="add-item" data-id="' + d.id + '">+ Add</button></div>').join('') + '</section>';
    }

    const held = D().held || [];
    if (held.length) {
      html += '<section class="card dashed"><div class="card-head head-either">NEXT WEEK · ' + held.length + '</div>' + held.map((r) =>
        '<div class="row"><div class="row-main"><span class="row-name">' + esc(r.name) + '</span><span class="row-meta">' + esc(storeOf(r.store).name) +
        (r.hold_until ? ' · back ' + esc(shortDay(r.hold_until)) : '') + '</span></div>' +
        '<button class="btn btn-plain" data-act="unhold" data-id="' + r.id + '">Need it now</button></div>').join('') + '</section>';
    }

    const recent = D().recent.slice().reverse().slice(0, 8);
    if (recent.length) {
      html += '<section class="card dashed"><div class="card-head head-either">RECENTLY DONE</div>' + recent.map((r) =>
        '<div class="row"><div class="row-main"><span class="row-name">' + esc(r.name) + '</span><span class="row-meta">' + (r.status === 'bought' ? 'Bought' : r.status === 'have' ? 'Had it' + (haveLevel(r) ? ' (' + esc(haveLevel(r)) + ')' : '') + ', not bought' : 'Removed') + '</span></div>' +
        '<button class="btn btn-plain" data-act="restore" data-id="' + r.id + '">Put back</button></div>').join('') + '</section>';
    }
    return html;
  }

  /* ---------- staples ---------- */
  function viewStaplesFilters() {
    const pill = (v, label, cls) => '<button class="pill ' + (cls || '') + (S.storeFilter === v ? ' on' : '') + '" data-act="filter" data-v="' + v + '">' + label + '</button>';
    return '<div class="chips-row">' + pill('all', 'All') + pill('GE', 'Giant Eagle', 'ge') + pill('WF', 'Whole Foods', 'wf') + pill('TGT', 'Target', 'tgt') +
      (amParent() ? '<button class="pill edit' + (S.editMode ? ' on' : '') + '" data-act="edit-mode" style="margin-left:auto">' + (S.editMode ? 'Done' : 'Edit') + '</button>' : '') + '</div>' +
      '<div class="addbar"><label class="sr" for="sq">Find a staple</label><input id="sq" class="field" placeholder="Find a staple…" value="' + esc(S.staplesQuery) + '" data-input="staples-q"></div>';
  }

  function viewStaples() {
    const q = S.staplesQuery.trim().toLowerCase();
    let items = D().items.filter((i) => S.editMode || i.status !== 'Drop');
    if (S.storeFilter !== 'all') items = items.filter((i) => i.store === S.storeFilter || (i.store === 'Either' && takesEither(S.storeFilter)));
    if (q) items = items.filter((i) => String(i.name).toLowerCase().indexOf(q) >= 0);
    const groups = GROUPS.concat(Array.from(new Set(items.map((i) => i.group))).filter((g) => GROUPS.indexOf(g) < 0));
    let html = '';
    if (S.editMode) html += '<button class="btn btn-outline btn-block" data-act="new-item">+ New staple</button>';
    groups.forEach((g) => {
      const inGroup = items.filter((i) => (i.group || 'Other') === g)
        .sort((a, b) => (Number(b.orders) || 0) - (Number(a.orders) || 0) || String(a.name).localeCompare(b.name));
      if (!inGroup.length) return;
      html += '<div class="group"><div class="group-title">' + esc(g) + '</div><div class="chips">' + inGroup.map((i) => {
        const on = !!listRowFor(i.id);
        return '<button class="chip ' + storeOf(i.store).cls + (on ? ' on' : '') + (i.status === 'Drop' ? ' dropped' : '') + '" data-act="chip" data-id="' + i.id + '"' +
          ' aria-pressed="' + on + '">' + esc(i.name) + '</button>';
      }).join('') + '</div></div>';
    });
    if (!html) html = '<div class="empty">No staples match.</div>';
    html += '<p class="hint">' + (S.editMode ? 'Tap a staple to change its store, brand, or whether a swap is OK.' :
      'Tap to add to the List, tap again to take it off. Orange edge = Giant Eagle, green = Whole Foods, red = Target, gray = either grocery store.') + '</p>';
    return html;
  }

  /* ---------- meals ---------- */
  function viewMeals() {
    const plan = {};
    D().plan.forEach((p) => (plan[p.day] = p.meal_id));
    const todayIdx = new Date(D().today + 'T12:00:00').getDay();
    const meals = D().meals.slice().sort((a, b) => String(a.name).localeCompare(b.name));
    let html = '<section class="card">' + DAYS.map((day, idx) => {
      const mealId = plan[day] || '';
      const meal = mealById(mealId);
      const open = S.openDay === day && meal;
      let row = '<div class="day"><div class="day-row"><span class="day-label' + (idx === todayIdx ? ' today' : '') + '">' + day + '</span>' +
        '<label class="sr" for="plan-' + day + '">Dinner on ' + day + '</label><select id="plan-' + day + '" class="select" data-input="plan" data-day="' + day + '">' +
        '<option value="">—</option>' + meals.map((m) => '<option value="' + m.id + '"' + (m.id === mealId ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('') +
        '</select>' + (meal ? '<button class="btn btn-plain" data-act="toggle-day" data-day="' + day + '">' + (open ? 'Hide' : 'Shop') + '</button>' : '') + '</div>';
      if (open) row += viewIngredients(day, meal);
      return row + '</div>';
    }).join('') + '</section>';

    html += '<section class="card"><div class="card-head"><span>OUR MEALS</span><button class="btn btn-outline" data-act="new-meal">+ New meal</button></div>' +
      (meals.length ? meals.map((m) => '<div class="row"><button class="row-main" data-act="edit-meal" data-id="' + m.id + '"><span class="row-name">' + esc(m.name) + '</span>' +
        '<span class="row-meta">' + mealItems(m).map((id) => itemById(id)).filter(Boolean).map((i) => esc(i.name)).join(', ') + '</span></button></div>').join('')
        : '<div class="empty">No meals yet.</div>') + '</section>';
    html += '<p class="hint">Pick dinners for the week, tap Shop to see what you need, and add the rest to the List in one tap.</p>';
    return html;
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

  // Deck order: questions put off with "Later" go to the back for this session.
  function askDeck() {
    const later = S.askLater || [];
    const qs = myQuestions();
    return qs.filter((q) => later.indexOf(q.id) < 0).concat(later.map((id) => qs.find((q) => q.id === id)).filter(Boolean));
  }

  function viewAsk() {
    const deck = askDeck();
    if (!deck.length) {
      return '<div class="ask-done"><div class="ask-done-mark">✓</div><b>All caught up</b><span class="note">Questions about favorites and dinner votes will show up here.</span></div>' +
        '<p class="hint">Answers teach Poppy what the family likes. Votes help pick dinners; a parent makes the final call.</p>';
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

    let html = '<div class="ask-progress"><span>' + pos + ' of ' + total + '</span><div class="bar"><i style="width:' + Math.round(100 * (pos - 1) / total) + '%"></i></div></div>';
    html += '<section class="qcard" data-swipe="' + (kind === 'yesno' ? 'yesno' : 'later') + '" data-id="' + r.id + '">' +
      (r.passed_by && String(r.passed_by).toLowerCase() !== String(S.me).toLowerCase() ? '<div class="passed-note">' + esc(r.passed_by) + ' passed this to you</div>' : '') +
      '<div class="qcard-q">' + esc(sp.q.replace(/\s*\(i\d{3,}\)/g, '')) + '</div>' + control + (typing ? textBox :
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
    let html = '<div class="stats">' + stat(count('GE'), 'Giant Eagle') + stat(count('WF'), 'Whole Foods') + stat(count('TGT'), 'Target') +
      stat(count('Either'), 'either grocery') + '</div>';
    if (req) html += '<p class="note">' + req + ' request' + (req > 1 ? 's' : '') + ' still waiting on the List tab.</p>';

    CART_STORES.forEach((code) => {
      const st = storeOf(code);
      const day = code === 'GE' ? D().settings.ge_order_day : code === 'WF' ? D().settings.wf_order_day : 'monthly Drive Up';
      const n = count(code) + (takesEither(code) ? count('Either') : 0);
      html += '<section class="card store-card"><div class="store-title"><b class="head-' + st.cls + '">' + st.name + '</b><span class="note">' + count(code) + (count(code) === 1 ? ' item' : ' items') + (day ? ' · usually ' + esc(day) : '') + '</span></div>' +
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
    const storeOpts = [['GE', 'Giant Eagle'], ['WF', 'Whole Foods'], ['TGT', 'Target'], ['Either', 'Either']];

    if (sh.type === 'row') {
      inner = '<h2>' + esc(sh.name) + '</h2>' +
        '<div><label>How many</label><div class="stepper"><button type="button" data-act="qty" data-d="-1" aria-label="Fewer">−</button><b>' + sh.qty + '</b><button type="button" data-act="qty" data-d="1" aria-label="More">+</button></div></div>' +
        '<div><label for="sh-note">Note</label><input id="sh-note" class="field" style="width:100%" data-input="draft" data-field="note" value="' + esc(sh.note) + '" placeholder="Brand, size, flavor…"></div>' +
        '<div><label>Store</label>' + seg('store', storeOpts, sh.store) + '</div>' +
        (canStock()
          ? '<div class="sheet-actions"><button class="btn btn-primary" data-act="save-row">Save</button><button class="btn btn-outline" data-act="row-bought">Bought it</button></div>' +
            '<div class="have-box"><label>Already have some at home?</label>' +
            seg('level', [['plenty', 'Plenty'], ['some', 'Some'], ['low', 'A little'], ['count', 'Count…']], sh.level) +
            (sh.level === 'count' ? '<div class="stepper" style="margin-top:8px"><button type="button" data-act="count" data-d="-1" aria-label="Fewer">−</button><b>' + sh.count + '</b><button type="button" data-act="count" data-d="1" aria-label="More">+</button><span class="note">at home</span></div>' : '') +
            '<div class="sheet-actions" style="margin-top:10px"><button class="btn btn-outline" data-act="row-have"' + (sh.level ? '' : ' disabled') + '>We have it · done</button><button class="btn btn-outline" data-act="row-hold">Next week</button></div>' +
            '<p class="note">“We have it” takes it off without buying. “Next week” hides it for 7 days, then it comes back.</p></div>'
          : '<div class="sheet-actions"><button class="btn btn-primary" data-act="save-row">Save</button><button class="btn btn-outline" data-act="row-bought">Got it</button></div>') +
        '<button class="btn btn-danger btn-block" data-act="row-remove">Take off the list</button>';
    }

    if (sh.type === 'item') {
      inner = '<h2>' + (sh.id ? 'Edit staple' : 'New staple') + '</h2>' +
        '<div><label for="sh-name">Name</label><input id="sh-name" class="field" style="width:100%" data-input="draft" data-field="name" value="' + esc(sh.name) + '"></div>' +
        '<div><label>Store</label>' + seg('store', storeOpts, sh.store) + '</div>' +
        '<div><label for="sh-group">Aisle</label><select id="sh-group" class="select" style="width:100%" data-input="draft" data-field="group">' +
        GROUPS.map((g) => '<option' + (g === sh.group ? ' selected' : '') + '>' + esc(g) + '</option>').join('') + '</select></div>' +
        '<div><label for="sh-brand">Brand / size</label><input id="sh-brand" class="field" style="width:100%" data-input="draft" data-field="brand_size" value="' + esc(sh.brand_size) + '"></div>' +
        '<div><label>OK to swap if it’s out?</label>' + seg('ok_swap', [['Y', 'Yes'], ['N', 'No, skip it'], ['', 'Ask me']], sh.ok_swap) + '</div>' +
        '<div><label>How often</label>' + seg('status', [['Always', 'Always'], ['Sometimes', 'Sometimes'], ['', 'Not set'], ['Drop', 'Stop buying']], sh.status) + '</div>' +
        '<div><label for="sh-notes">Notes</label><input id="sh-notes" class="field" style="width:100%" data-input="draft" data-field="notes" value="' + esc(sh.notes) + '" placeholder="e.g. Gia only eats strawberry"></div>' +
        (sh.orders ? '<p class="note">Bought in ' + sh.orders + ' order' + (sh.orders > 1 ? 's' : '') + (sh.last_bought ? ', last ' + esc(daysAgo(sh.last_bought)) : '') + (sh.avg_days ? ', about every ' + sh.avg_days + ' days' : '') + '.</p>' : '') +
        '<div class="sheet-actions"><button class="btn btn-primary" data-act="save-item"' + (String(sh.name).trim() ? '' : ' disabled') + '>Save</button></div>';
    }

    if (sh.type === 'meal') {
      const hits = searchItems(sh.q || '', 5).filter((i) => sh.item_ids.indexOf(i.id) < 0);
      inner = '<h2>' + (sh.id ? 'Edit meal' : 'New meal') + '</h2>' +
        '<div><label for="sh-mname">Name</label><input id="sh-mname" class="field" style="width:100%" data-input="draft" data-field="name" value="' + esc(sh.name) + '" placeholder="e.g. Taco night"></div>' +
        '<div><label>Ingredients</label><div class="ing-edit">' + (sh.item_ids.length ? sh.item_ids.map((id) => {
          const it = itemById(id);
          return it ? '<button type="button" data-act="ing-remove" data-id="' + id + '" aria-label="Remove ' + esc(it.name) + '">' + esc(it.name) + ' ✕</button>' : '';
        }).join('') : '<span class="note">None yet.</span>') + '</div></div>' +
        '<div style="position:relative"><label for="sh-mq">Add an ingredient</label><input id="sh-mq" class="field" style="width:100%" data-input="draft" data-field="q" value="' + esc(sh.q || '') + '" placeholder="Search staples…" autocomplete="off">' +
        (hits.length ? '<div class="suggest" style="right:0">' + hits.map((h) => '<button type="button" data-act="ing-add" data-id="' + h.id + '"><span class="s-name">' + esc(h.name) + '</span><span class="s-meta">' + esc(storeOf(h.store).name) + '</span></button>').join('') + '</div>' : '') + '</div>' +
        '<div class="sheet-actions"><button class="btn btn-primary" data-act="save-meal"' + (String(sh.name).trim() ? '' : ' disabled') + '>Save</button></div>';
    }

    return '<div class="scrim" data-act="close-sheet"><div class="sheet" role="dialog" aria-modal="true">' + inner +
      '<button class="btn btn-plain btn-block" data-act="close-sheet">Cancel</button></div></div>';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  /* ------------------------------------------------------------ events */
  function rowById(id) { return D().list.find((r) => r.id === id) || D().recent.find((r) => r.id === id); }

  const handlers = {
    'pick-me': (el) => { S.me = el.dataset.name; store.set('ff_me', S.me); render(); },
    'switch-me': () => { S.me = ''; S.toast = null; S.query = ''; S.sheet = null; store.del('ff_me'); render(); },
    tab: (el) => { if (el.dataset.tab === 'ask' && S.tab !== 'ask') { S.askAnswered = 0; resetAskCard(); } S.tab = el.dataset.tab; store.set('ff_tab', S.tab); S.query = ''; S.sheet = null; render(); window.scrollTo(0, 0); },
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
    'ask-later': (el) => { S.askLater = (S.askLater || []).filter((x) => x !== el.dataset.id).concat([el.dataset.id]); flyCard('left', () => { resetAskCard(); render(); }); },
    'review-skip': (el) => answerQuestion(el.dataset.id, 'skip', 'up', 'Skipped'),
    undo: () => { const u = S.toast && S.toast.undo; S.toast = null; if (u) u(); else render(); },

    'add-item': (el) => { const it = itemById(el.dataset.id); S.query = ''; if (it) addItem(it); else render(); },
    'add-new': () => { const q = S.query; S.query = ''; addNew(q); },
    approve: (el) => { const r = rowById(el.dataset.id); if (r) act('update', { id: r.id, fields: { status: 'needed' } }, () => (r.status = 'needed'), 'Approved ' + r.name); },
    skip: (el) => { const r = rowById(el.dataset.id); if (r) setStatus(r, 'skipped', 'Skipped ' + r.name); },
    bought: (el) => { const r = rowById(el.dataset.id); if (r) setStatus(r, 'bought', 'Got ' + r.name); },
    restore: (el) => { const r = rowById(el.dataset.id); if (r) restore(r); },
    'open-row': (el) => {
      const r = rowById(el.dataset.id);
      if (r) { S.sheet = { type: 'row', id: r.id, name: r.name, qty: Number(r.qty) || 1, note: r.note || '', store: r.store || 'Either', level: '', count: 1 }; render(); }
    },

    filter: (el) => { S.storeFilter = el.dataset.v; render(); },
    'edit-mode': () => { S.editMode = !S.editMode; render(); },
    chip: (el) => {
      const it = itemById(el.dataset.id);
      if (!it) return;
      if (S.editMode) { openItem(it); return; }
      const row = listRowFor(it.id);
      if (row) setStatus(row, 'skipped', 'Took ' + it.name + ' off');
      else addItem(it);
    },
    'new-item': () => openItem(null),

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
    'new-meal': () => { S.sheet = { type: 'meal', id: '', name: '', item_ids: [], q: '' }; render(); },
    'edit-meal': (el) => { const m = mealById(el.dataset.id); if (m) { S.sheet = { type: 'meal', id: m.id, name: m.name, item_ids: mealItems(m), q: '' }; render(); } },
    'ing-add': (el) => { S.sheet.item_ids.push(el.dataset.id); S.sheet.q = ''; render(); const f = document.getElementById('sh-mq'); if (f) f.focus(); },
    'ing-remove': (el) => { S.sheet.item_ids = S.sheet.item_ids.filter((id) => id !== el.dataset.id); render(); },
    'save-meal': () => {
      const sh = S.sheet;
      if (!String(sh.name).trim()) return;
      S.sheet = null;
      act('mealSave', { id: sh.id, name: sh.name.trim(), item_ids: sh.item_ids }, () => {
        const m = mealById(sh.id);
        if (m) { m.name = sh.name.trim(); m.item_ids = sh.item_ids.join(';'); }
        else D().meals.push({ id: tmpId(), name: sh.name.trim(), item_ids: sh.item_ids.join(';') });
      }, 'Saved ' + sh.name.trim());
    },

    'request-order': (el) => {
      const code = el.dataset.store;
      act('requestOrder', { store: storeOf(code).name }, () => { D().settings.order_requested = storeOf(code).name + ' requested by ' + S.me; }, 'Cart requested');
    },
    'clear-order': () => act('requestOrder', { store: '' }, () => { D().settings.order_requested = ''; }),

    seg: (el) => { S.sheet[el.dataset.field] = el.dataset.v; render(); },
    qty: (el) => { S.sheet.qty = Math.max(1, S.sheet.qty + Number(el.dataset.d)); render(); },
    'save-row': () => {
      const sh = S.sheet; const r = rowById(sh.id); S.sheet = null;
      if (!r) { render(); return; }
      act('update', { id: r.id, fields: { qty: sh.qty, note: sh.note, store: sh.store } }, () => { r.qty = sh.qty; r.note = sh.note; r.store = sh.store; }, 'Saved');
    },
    'row-bought': () => { const r = rowById(S.sheet.id); S.sheet = null; if (r) setStatus(r, 'bought', 'Bought ' + r.name); else render(); },
    count: (el) => { S.sheet.count = Math.max(1, Math.min(999, S.sheet.count + Number(el.dataset.d))); render(); },
    'row-have': () => {
      const sh = S.sheet; const r = rowById(sh.id);
      if (!sh.level) return;
      S.sheet = null;
      if (r) markHave(r, sh.level === 'count' ? String(sh.count) : sh.level); else render();
    },
    'row-hold': () => {
      const sh = S.sheet; const r = rowById(sh.id); S.sheet = null;
      if (r) holdRow(r, sh.level === 'count' ? String(sh.count) : sh.level); else render();
    },
    unhold: (el) => { const r = (D().held || []).find((x) => x.id === el.dataset.id); if (r) unhold(r); },
    'row-remove': () => { const r = rowById(S.sheet.id); S.sheet = null; if (r) setStatus(r, 'skipped', 'Took ' + r.name + ' off'); else render(); },
    'save-item': () => {
      const sh = S.sheet;
      if (!String(sh.name).trim()) return;
      S.sheet = null;
      const fields = { name: sh.name.trim(), store: sh.store, group: sh.group, brand_size: sh.brand_size, ok_swap: sh.ok_swap, status: sh.status, notes: sh.notes };
      act('itemSave', { id: sh.id, fields: fields }, () => {
        const it = itemById(sh.id);
        if (it) Object.assign(it, fields);
        else D().items.push(Object.assign({ id: tmpId() }, fields));
      }, 'Saved ' + fields.name);
    },
    'close-sheet': (el, ev) => { if (ev.target === el) { S.sheet = null; render(); } },
  };

  function openItem(it) {
    S.sheet = it
      ? { type: 'item', id: it.id, name: it.name, store: it.store || 'Either', group: it.group || 'Other', brand_size: it.brand_size || '', ok_swap: it.ok_swap || '', status: it.status || '', notes: it.notes || '', orders: Number(it.orders) || 0, last_bought: it.last_bought, avg_days: it.avg_days }
      : { type: 'item', id: '', name: '', store: S.storeFilter !== 'all' ? S.storeFilter : 'Either', group: 'Other', brand_size: '', ok_swap: '', status: '', notes: '' };
    render();
  }

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el) {
      if (S.query && !ev.target.closest('.addbar')) { S.query = ''; render(); }
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
    if (kind === 'draft' && S.sheet) {
      S.sheet[el.dataset.field] = el.value;
      // Only the meal search and name-gated Save buttons need a redraw while typing.
      if (el.dataset.field === 'q' || el.dataset.field === 'name') render();
    }
  });

  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.dataset && el.dataset.input === 'plan') {
      const day = el.dataset.day; const mealId = el.value;
      S.openDay = mealId ? day : null;
      S.mealPick[day] = {};
      act('planSet', { day: day, meal_id: mealId, week_of: D().weekOf }, () => {
        D().plan = D().plan.filter((p) => p.day !== day);
        if (mealId) D().plan.push({ week_of: D().weekOf, day: day, meal_id: mealId });
      });
    }
    if (el.dataset && el.dataset.input === 'ask-sel') { S.askSel = el.value; render(); }
    if (el.dataset && el.dataset.input === 'draft' && el.tagName === 'SELECT' && S.sheet) S.sheet[el.dataset.field] = el.value;
  });

  document.addEventListener('submit', async (ev) => {
    const form = ev.target;
    ev.preventDefault();
    if (form.dataset.form === 'unlock') {
      const v = document.getElementById('pass').value.trim();
      if (!v) return;
      S.pass = v; S.loading = true; S.setupError = ''; render();
      try { await api('state'); store.set('ff_pass', v); }
      catch (e) {
        S.pass = '';
        S.setupError = String(e.message) === 'wrong_passcode' ? 'That passcode didn’t work.' : 'Couldn’t reach the server (' + e.message + ').';
      }
      S.loading = false; render();
    }
    if (form.dataset.form === 'add') {
      const q = S.query.trim();
      if (!q) return;
      const hits = searchItems(q, 1);
      S.query = '';
      if (hits.length && String(hits[0].name).toLowerCase() === q.toLowerCase()) addItem(hits[0]);
      else addNew(q);
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
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => {
    // Don't redraw under someone mid-edit.
    if (document.hidden || S.sheet || S.query) return;
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) return;
    refresh();
  }, POLL_MS);

  render();
  if (S.pass && apiUrl()) refresh();
})();
