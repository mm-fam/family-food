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
    // Deliveries (Nov 2): food that arrives on its own. Never a store: no List, carts, In store or Either.
    WG: { name: 'Wildgrain', cls: 'wg', delivery: 'Comes in the Wildgrain box (about every 30 days) and lives in the freezer.' },
    BB: { name: 'Bleu Box', cls: 'bb', delivery: 'Comes with a Bleu Box order: ready meals, mostly just heat and eat.' },
    DLV: { name: 'Deliveries', cls: 'dlv' },
    Either: { name: 'Either grocery store', cls: 'either' },
  };
  const STORE_ORDER = ['GE', 'WF', 'TGT', 'AMZ', 'Either'];
  const CART_STORES = ['GE', 'WF', 'TGT', 'AMZ'];
  // "Either" means Giant Eagle or Whole Foods. Target is always picked on purpose.
  const takesEither = (code) => code === 'GE' || code === 'WF';
  const isDelivery = (code) => !!(STORES[code] && STORES[code].delivery);
  const DELIVERY_OPTS = [['WG', 'Wildgrain'], ['BB', 'Bleu Box']];
  const GROUPS = ['Produce', 'Dairy', 'Cheese & deli', 'Meat', 'Bakery', 'Breakfast', 'Snacks', 'Pantry', 'Frozen',
    'Mini fridge', 'Personal care', 'Household', 'Paper & cleaning', 'Other'];
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
    shopSort: 'most',  // Shop tab sort: most / last / az
    shopHideListed: false,
    shopFiltersOpen: false, // Filter panel; folded each time the app opens
    storeFilter: 'all',
    editMode: false,
    query: '',
    staplesQuery: '',
    openDay: null,
    mealPick: {},      // date -> { itemId: true/false } (need it?)
    mealQuery: '',     // Our meals search (name or ingredient)
    mealFiltersOpen: false,
    mealSort: 'top',   // Our meals order: top (sections by rating, default since Nov 4) / az / cost / stale
    sheet: null,       // bottom sheet { type, ...draft }
    toast: null,
    setupError: '',
    loading: false,    // first unlock in progress
    bootError: '',     // saved passcode, but the first load failed
    slow: false,       // first load is taking a while (Apps Script waking up)
    stale: false,      // showing the copy saved on this phone while fresh state loads
  };

  // Speed (Nov 2): the last state is kept on the phone, so opening Poppy shows the List at once
  // and fresh data replaces it a few seconds later (a small "Updating…" pill shows meanwhile).
  // Copies older than SAVED_MAX_DAYS are ignored, and a wrong passcode clears it.
  const SAVED_KEY = 'ff_state';
  const SAVED_MAX_DAYS = 3;
  let saveTimer = null;
  function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!S.data) return;
      try { localStorage.setItem(SAVED_KEY, JSON.stringify({ at: Date.now(), state: S.data })); }
      catch (e) { store.del(SAVED_KEY); } // too big for this phone or private mode: never leave an old copy behind
    }, 1500);
  }
  function loadSavedState() {
    try {
      const j = JSON.parse(store.get(SAVED_KEY) || 'null');
      if (j && j.state && j.state.items && Date.now() - j.at < SAVED_MAX_DAYS * 86400000) return j.state;
    } catch (e) { /* bad copy */ }
    return null;
  }
  function forgetSavedState() { clearTimeout(saveTimer); store.del(SAVED_KEY); }
  if (S.pass) { const saved = loadSavedState(); if (saved) { S.data = saved; S.stale = true; } }
  // Deep link from a printed recipe card's QR code (Nov 4): ?meal=mNN opens that meal card once we know who you are.
  try { const dm = new URLSearchParams(location.search).get('meal'); if (/^m\d+$/.test(dm || '')) S.deepMeal = dm; } catch (e) { /* no URL */ }

  let seq = 0;
  let applied = 0;

  /* ------------------------------------------------------------ api */
  function apiUrl() { return (window.FF_CONFIG && window.FF_CONFIG.API_URL) || ''; }

  // Writes in flight. A plain state read that started before (or during) a write can come back
  // with the old data and flash it for a second (Nov 1 demo: an approved request popped back up),
  // so reads are ignored while a write is pending and anything older than the last write is dropped.
  let writing = 0;
  let lastWrite = 0;
  const READS = { state: 1, ping: 1, itemInfo: 1, pointsLog: 1 };
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
      if (j.state && mine >= applied && !(stale && S.data && !S.stale)) { applied = mine; S.data = j.state; S.stale = false; saveState(); }
      return j;
    } finally { if (isWrite) writing--; }
  }

  /* Offline outbox (hardening, Nov 4): a change made with no signal (an aisle with no bars) is kept on the phone
     in order and sent when the connection is back, instead of being lost. Only network failures queue; a server
     "no" (wrong passcode, a kid trying a parent's action) still shows as an error. While anything waits, the screen
     keeps the change it already showed and a small pill says how many are waiting. */
  const OUTBOX = 'ff_outbox';
  function outbox() { try { return JSON.parse(store.get(OUTBOX) || '[]'); } catch (e) { return []; } }
  function setOutbox(q) { if (q.length) store.set(OUTBOX, JSON.stringify(q)); else store.del(OUTBOX); }
  function isOffline(e) {
    const m = String(e && e.message || e);
    return m === 'Failed to fetch' || /networkerror|load failed|network connection|internet connection/i.test(m) || navigator.onLine === false;
  }
  let flushing = false;
  async function flushOutbox() {
    if (flushing || !S.pass || !apiUrl()) return;
    let q = outbox();
    if (!q.length) return;
    flushing = true;
    let sent = 0;
    try {
      while (q.length) {
        const job = q[0];
        try { await api(job.action, Object.assign({}, job.payload, { by: job.by })); sent++; }
        catch (e) {
          if (isOffline(e)) break;
          showToast('A saved change couldn’t be sent: ' + String(e && e.message || e));
        }
        q.shift();
        setOutbox(q);
      }
    } finally { flushing = false; }
    if (sent && !outbox().length) showToast('Back online: ' + sent + ' saved change' + (sent === 1 ? '' : 's') + ' sent');
    if (!S.dragging) render();
  }

  async function refresh() {
    if (!S.pass || !apiUrl() || !S.data) return; // before the first load, firstLoad() owns the screen
    if (outbox().length) { await flushOutbox(); if (outbox().length) { render(); return; } }
    try { await api('state'); if (!S.dragging) render(); }
    catch (e) { handleError(e); }
  }

  function handleError(e) {
    const msg = String(e && e.message || e);
    if (msg === 'wrong_passcode') {
      S.pass = ''; store.del('ff_pass'); forgetSavedState(); S.data = null; S.stale = false; S.setupError = 'That passcode didn’t work.'; render(); return;
    }
    showToast(msg === 'Failed to fetch' ? 'Can’t reach the server. Check your connection.' : msg);
    render();
  }

  // Apply a change locally right away, then send it. Server state replaces ours when it answers.
  async function act(action, payload, optimistic, toastMsg, undo) {
    if (toastMsg) showToast(toastMsg, undo);
    if (optimistic) optimistic();
    render();
    // Something is already waiting to send: keep the order, queue this one behind it.
    if (outbox().length) { const q = outbox(); q.push({ action: action, payload: payload || {}, by: S.me, at: Date.now() }); setOutbox(q); render(); flushOutbox(); return; }
    try {
      const j = await api(action, payload);
      // api 62: the backend used an item of the same kind that was already on the List instead of adding another.
      const sk = j && j.result && j.result.same_kind ? [].concat(j.result.same_kind) : [];
      if (sk.length) showToast(sk.map((x) => x.used + ' is already on the List: it covers ' + x.asked).join(' · '));
      render();
      return j;
    }
    catch (e) {
      if (isOffline(e)) {
        const q = outbox(); q.push({ action: action, payload: payload || {}, by: S.me, at: Date.now() }); setOutbox(q);
        showToast('No signal. Saved on this phone; it sends when you’re back online.');
        render();
        return;
      }
      handleError(e); refresh();
    }
  }

  /* ------------------------------------------------------------ data helpers */
  const D = () => S.data || { items: [], list: [], held: [], recent: [], meals: [], plan: [], review: [], due: [], stock: {}, mealStats: {}, ideas: [], settings: { parents: [], kids: [] } };
  const itemById = (id) => D().items.find((i) => i.id === id);
  const mealById = (id) => D().meals.find((m) => m.id === id);
  // Make more (Nov 3, Mom's idea, api 35): Meals meat_qty (blank = 1) = how many of each meat go on the List.
  const canMeatQty = () => Number(D().api || 0) >= 35;
  const meatQty = (m) => { const n = parseInt(m && m.meat_qty, 10); return n >= 2 && n <= 3 ? n : 1; };
  const isMeat = (id) => { const it = itemById(id); return !!(it && String(it.group) === 'Meat'); };
  const listRowFor = (itemId) => D().list.find((r) => r.item_id === itemId);
  // Same kind (api 62): Items `kind` groups things one of which covers the others for a meal (shredded cheddar,
  // a cheddar chunk). Set from a parent's Yes on a kind card.
  const canV62 = () => Number(D().api || 0) >= 62;
  const kindKey = (it) => String((it && it.kind) || '').trim().toLowerCase();
  const sameKindRow = (item) => {
    const k = kindKey(item);
    if (!k) return null;
    return D().list.concat(D().held || []).find((r) => r.item_id && r.item_id !== item.id && kindKey(itemById(r.item_id)) === k) || null;
  };
  const isKid = (name) => D().settings.kids.map((k) => k.toLowerCase()).indexOf(String(name || '').toLowerCase()) >= 0;
  const amParent = () => !isKid(S.me);
  // Admin screen (cart requests, behind-the-scenes): Settings "admins", else the first parent.
  const isAdmin = () => {
    const a = (D().settings.admins && D().settings.admins.length) ? D().settings.admins : D().settings.parents.slice(0, 1);
    return a.map((x) => x.toLowerCase()).indexOf(String(S.me).toLowerCase()) >= 0;
  };
  // Everyone who asked for a row (wanted_by "owner;parent"), falling back to added_by.
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
    // The store's own product names count too ("Nounos Creamery", "skyr", "Fage").
    const prods = ((S.data && S.data.products) || {})[i.id] || {};
    const pnames = Object.keys(prods).map((k) => prods[k] && prods[k].name).filter(Boolean).join(' ');
    return words([i.name, i.brand_size, i.group, String(i.aliases || '').replace(/;/g, ' '), pnames].join(' '));
  }
  // Search order (Nov 2: "yogurt" put Nounos below Chobani and a GE tub nobody's bought since June, under the
  // phone keyboard). How well the NAME matches comes first, then what we buy now: items still bought at their
  // usual pace, most often first. Raw order counts mislead: GE has years of history, WF only a few receipts.
  function nameTier(i, n, qw) {
    // "yog" is as good a match for "Nounos Greek yogurt" as for "Yoggies": what we buy decides between them.
    const name = String(i.name || '').toLowerCase();
    const nw = words(name);
    if (qw.every((w) => nw.some((x) => x.indexOf(w) === 0))) return 0;
    if (qw.every((w) => name.indexOf(w) >= 0)) return 1;
    return 2; // matched on brand, aisle, aliases or a store product name
  }
  function useTier(i) {
    if (!i.last_bought) return [3, 9999];
    const d = Math.round((new Date(D().today + 'T12:00:00') - new Date(String(i.last_bought).slice(0, 10) + 'T12:00:00')) / 86400000);
    const avg = Number(i.avg_days) || 0;
    if (avg && d <= Math.max(2 * avg, 45)) return [0, avg]; // still buying it at its usual pace
    if (d <= 180) return [1, d];
    return [2, d];
  }
  function rankHits(hits, q) {
    const n = String(q).trim().toLowerCase();
    const qw = words(n);
    return hits.map((i) => ({ i: i, t: nameTier(i, n, qw), u: useTier(i) })).sort((a, b) =>
      a.t - b.t || a.u[0] - b.u[0] || a.u[1] - b.u[1] || (Number(b.i.orders) || 0) - (Number(a.i.orders) || 0) ||
      String(a.i.name).localeCompare(b.i.name)).map((x) => x.i);
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
    return rankHits(findItems(n, D().items.filter((i) => i.status !== 'Drop')).hits, n).slice(0, limit || 6);
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
  const isLeftover = (p) => /^leftover/i.test(String(p.note || ''));
  // date -> meal_id for one slot (dinner by default).
  function planByDate(slot) {
    const want = slot || 'dinner';
    const m = {};
    D().plan.forEach((p) => { const d = planDate(p); if (d && slotOf(p) === want && p.meal_id) m[d] = p.meal_id; });
    return m;
  }
  // Planned items (api 30): a slot can hold something we buy instead of a meal. Meals have 2+ ingredients
  // and a recipe; a snack like trail mix is just an item.
  const canPlanItems = () => Number(D().api || 0) >= 30;
  const planItem = (p) => (p && !p.meal_id && p.item_id ? itemById(p.item_id) : null);
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
    const it = !m && p.item_id ? itemById(p.item_id) : null; // a planned item, e.g. a snack we just buy (api 30)
    return m ? m.name : it ? it.name : String(p.note || '');
  }

  // Who's cooking + who planned it (Nov 6, owner, api 60): Plan cook ("Mike; Gianna"), planned_by, planned_at, asked_by.
  const canCook = () => Number(D().api || 0) >= 60;
  const cooksOf = (p) => String((p && p.cook) || '').split(';').map((x) => x.trim()).filter(String);
  const nameList = (a) => a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' & ' + a[a.length - 1];
  function cookShort(p) {
    const c = cooksOf(p);
    return c.length ? nameList(c) : '';
  }
  // "Planned by Joni · Nov 6 · Cecilia asked for it"
  function plannedLine(p) {
    if (!p) return '';
    const bits = [];
    if (p.planned_by) bits.push('Planned by ' + p.planned_by + (p.planned_at ? ' · ' + fmtLong(p.planned_at) : ''));
    if (p.asked_by) bits.push(nameList(String(p.asked_by).split(';').map((x) => x.trim()).filter(String)) + ' asked for it');
    return bits.join(' · ');
  }
  // One row of name chips. Tap your own to sign up or step off; parents can tap anyone.
  function cookBlock(date, slot, p) {
    if (!canCook() || !p || !mealById(p.meal_id || '') || isLeftover(p)) return '';
    const fam = (D().settings.parents || []).concat(D().settings.kids || []);
    const on = cooksOf(p).map((x) => x.toLowerCase());
    const me = String(S.me).toLowerCase();
    const mineOn = on.indexOf(me) >= 0;
    const chips = fam.map((n) => {
      const isOn = on.indexOf(n.toLowerCase()) >= 0;
      const can = amParent() || n.toLowerCase() === me;
      return '<button type="button" class="cook-chip' + (isOn ? ' on' : '') + '" data-act="cook-toggle" data-day="' + date + '" data-slot="' + slot + '" data-name="' + esc(n) + '" aria-pressed="' + isOn + '"' + (can ? '' : ' disabled') + '>' +
        (isOn ? '🧑‍🍳 ' : '') + esc(n) + '</button>';
    }).join('');
    const line = plannedLine(p);
    return '<div class="cook-block"><div class="cook-label">' + (on.length ? 'Cooking' : 'Who’s cooking?') + '</div><div class="cook-chips">' + chips + '</div>' +
      (!amParent() && !mineOn ? '<div class="cook-hint">Tap your name to cook it.</div>' : '') +
      (line ? '<div class="cook-by">' + esc(line) + '</div>' : '') + '</div>';
  }

  function shortDay(iso) {
    const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
    return isNaN(d) ? '' : DAYS[d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate();
  }

  // Pulls the last "had …" from a row note, e.g. "had 6 (parent)" → "6".
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
    if (isDelivery(item.store)) { showToast(item.name + ' comes from ' + storeOf(item.store).name + ', nothing to buy'); return; }
    const held = D().held || [];
    const existing = listRowFor(item.id) || held.find((r) => r.item_id === item.id);
    if (existing) {
      const isHeld = held.indexOf(existing) >= 0;
      if (iWant(existing) && !isHeld) { showToast(item.name + ' is already on the list'); return; }
      const others = wantedBy(existing).filter((w) => w.toLowerCase() !== String(S.me).toLowerCase());
      act('add', { item_id: item.id, qty: 1 }, () => {
        if (!iWant(existing)) existing.wanted_by = wantedBy(existing).concat([S.me]).join(';');
        if (isHeld) { D().held = held.filter((r) => r !== existing); D().list.push(existing); }
      }, isHeld ? item.name + ' is back on the list' : others.join(' + ') + ' already asked. Added you too.' + (amParent() ? ptsTag('list_add') : ''));
      return;
    }
    // api 62: something of the same kind is already on the List → ask before adding a second one.
    const anyway = !!(extra && extra._anyway);
    const peer = canV62() && !anyway ? sameKindRow(item) : null;
    if (peer) { S.sheet = { type: 'samekind', item_id: item.id, row_id: peer.id, meal_id: (extra && extra.meal_id) || '' }; render(); return; }
    extra = Object.assign({}, extra || {}); delete extra._anyway;
    const status = isKid(S.me) ? 'requested' : 'needed';
    const row = Object.assign({ id: tmpId(), item_id: item.id, name: item.name, store: item.store || 'Either', qty: 1, note: '', added_by: S.me, wanted_by: S.me, status: status }, extra);
    act('add', Object.assign({ item_id: item.id, qty: row.qty, meal_id: row.meal_id || '' }, anyway ? { anyway: true } : {}), () => { D().list.push(row); },
      status === 'requested' ? 'Asked for ' + item.name + (ptsTag('list_add') ? ' · +1 when a parent approves' : '') : 'Added ' + item.name + ptsTag('list_add'));
  }

  function addNew(name, storeCode) {
    const clean = name.trim();
    if (!clean) return;
    const known = D().items.find((i) => String(i.name).toLowerCase() === clean.toLowerCase());
    if (known) { addItem(known); return; }
    const status = isKid(S.me) ? 'requested' : 'needed';
    const p = act('add', { name: clean, store: storeCode || 'Either' }, () => {
      D().list.push({ id: tmpId(), item_id: '', name: clean, store: storeCode || 'Either', qty: 1, added_by: S.me, wanted_by: S.me, status: status });
    }, status === 'requested' ? 'Asked for ' + clean + (ptsTag('list_add') ? ' · +1 when a parent approves' : '') : 'Added ' + clean + ptsTag('list_add'));
    // Catalog quality (api 45): a parent's brand-new item opens with Details, so brand/size, aisle, store and
    // how it's sold get filled in while it's fresh. Kids' adds stay requests; a parent tidies them on approval.
    if (!isKid(S.me) && canV45() && p && p.then) p.then(() => {
      const it = D().items.find((i) => String(i.name).toLowerCase() === clean.toLowerCase());
      const row = it && D().list.find((r) => r.item_id === it.id && r.status !== 'bought');
      if (!it || S.sheet) return;
      openItemSheet(it.id, row ? row.id : '');
      if (S.sheet) { S.sheet.open = { details: true }; S.sheet.fresh = true; render(); }
    });
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

  const LEVEL_LABEL = { plenty: 'plenty', some: 'some', low: 'a little', out: 'none left', waste: 'tossed it' };
  const levelText = (lv) => (/^\d+$/.test(String(lv)) ? String(lv) : (LEVEL_LABEL[lv] || lv));

  // We already have it at home: nothing bought, sighting logged.
  function markHave(row, level) {
    const before = row.status;
    // api 20: a kid's "we have it" asks a parent first; the row stays until a parent agrees.
    if (isKid(S.me) && Number(D().api || 0) >= 20) {
      act('listHave', { id: row.id, level: level }, () => {
        (D().stock = D().stock || {})[row.item_id] = { level: level, at: D().today, who: S.me };
      }, 'Asked a parent to take ' + row.name + ' off the List');
      return;
    }
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

  // Later: keep it on the List but out of the way until a date (Next week, In 2 weeks) or with no date
  // (LATER_NO_DATE). Built on hold_until, so every "held" rule in the backend applies unchanged.
  function holdRow(row, level, until) {
    const back = until && until < '9000' ? ' until ' + shortDay(until) : until ? '' : ' until next week';
    act('listHold', Object.assign({ id: row.id, level: level || '' }, until ? { until: until } : {}), () => {
      D().list = D().list.filter((r) => r !== row);
      (D().held = D().held || []).push(Object.assign({}, row, { hold_until: until || addDays(D().today, 7) }));
    }, row.name + ' moved to Later' + back, () => unhold(row));
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
    if (S.deepMeal && S.data && S.pass && S.me) {
      const id = S.deepMeal; S.deepMeal = '';
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* fine */ }
      if (mealById(id)) { S.tab = 'meals'; S.sheet = { type: 'mealcard', id: id }; }
    }
    const root = document.getElementById('app');
    const focus = captureFocus();
    const scrolls = {};
    root.querySelectorAll('[data-keep-scroll]').forEach((el) => { if (el.id) scrolls[el.id] = el.scrollLeft; });
    // The open sheet keeps its scroll position across renders (Nov 4: opening Details at the bottom jumped back up).
    const sheetEl = root.querySelector('.sheet');
    const sheetTop = sheetEl && S.sheet && S.sheet === S._sheetSeen ? sheetEl.scrollTop : 0;
    if (!apiUrl()) root.innerHTML = viewNoBackend();
    else if (S.pass && !S.data) root.innerHTML = viewLoading();
    else if (!S.pass) root.innerHTML = viewSetup();
    else if (!S.me) root.innerHTML = viewPickPerson();
    else root.innerHTML = viewApp();
    Object.keys(scrolls).forEach((id) => { const el = document.getElementById(id); if (el) el.scrollLeft = scrolls[id]; });
    const sheetNew = root.querySelector('.sheet');
    if (sheetNew && sheetTop) sheetNew.scrollTop = sheetTop;
    S._sheetSeen = S.sheet;
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
    if (S.data && S.stale) {
      // A saved copy is on screen already: load fresh state quietly behind it (changes saved offline go first).
      render();
      if (outbox().length) { await flushOutbox(); if (outbox().length) return true; }
      try { await api('state'); }
      catch (e) { handleError(e); }
      if (!S.dragging) render();
      return true;
    }
    S.bootError = ''; S.slow = false; render();
    const t = setTimeout(() => { if (!S.data) { S.slow = true; render(); } }, 4000);
    try { await api('state'); return true; }
    catch (e) {
      const msg = String(e && e.message || e);
      if (msg === 'wrong_passcode') {
        S.pass = ''; store.del('ff_pass'); forgetSavedState(); S.setupError = 'That passcode didn’t work.';
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
    if (S.tab === 'admin' && canCarts()) S.tab = 'carts';
    if (S.tab === 'admin' && !isAdmin()) S.tab = 'list';
    if (S.tab === 'carts' && !canCarts()) S.tab = isAdmin() ? 'admin' : 'list';
    const instore = S.tab === 'list' && S.instore;
    const n = D().list.filter((r) => r.status !== 'requested').length;
    const titles = { list: 'List', shop: 'Shop', meals: 'Meals', ask: 'Inbox', admin: 'Behind the scenes', carts: S.cartOpen ? storeOf(S.cartOpen).name : 'Carts' };
    const inCarts = D().list.filter((r) => r.status === 'carted').length;
    const eyebrows = { list: n + ' on the list', shop: 'Add to the List', meals: 'Next 2 weeks', ask: inboxEyebrow(), admin: 'Just for ' + S.me, carts: inCarts + ' in online carts' };
    const title = instore ? 'In store' : titles[S.tab];
    const eyebrow = instore ? (S.instore === 'all' ? 'Every store' : storeOf(S.instore).name) : (S.tab === 'list' && canCarts() ? '' : eyebrows[S.tab]);
    let right = '';
    if (instore) right = '<button class="btn btn-primary shop-done" data-act="store-done">Done</button>';
    else if (canCarts()) {
      // Nov 2 header (owner): the cart is the main button, In store is secondary, 💡 and switching live under your name.
      right += cartButton();
      if (S.tab === 'list') right += '<button class="btn btn-plain shop-btn small" data-act="store-start">🏪 In store</button>';
      // Nov 2 (owner): a mini ⚙ and a mini 💡 stacked in the name cell, so an idea is one tap away.
      right += '<div class="me me-cell"><button class="me-name" data-act="open-me" aria-label="Options for ' + esc(S.me) + '">' + esc(S.me) + '</button>' +
        '<span class="me-icons"><button data-act="open-me" aria-label="Settings and switching">⚙</button>' +
        (canV9() ? '<button data-act="open-feedback" aria-label="Idea or feedback about the app">💡</button>' : '') + '</span></div>';
    } else {
      if (S.tab === 'list') right += '<button class="btn btn-outline shop-btn" data-act="store-start">🛒 In store</button>';
      if (canV9()) right += '<button class="gear idea-btn" data-act="open-feedback" aria-label="Idea or feedback about the app">💡</button>';
      if (canCarts()) right += '<button class="gear' + (S.tab === 'carts' ? ' on' : '') + '" data-act="tab" data-tab="' + (S.tab === 'carts' ? 'list' : 'carts') + '" aria-label="Online carts">🛒</button>';
      else if (isAdmin()) right += '<button class="gear' + (S.tab === 'admin' ? ' on' : '') + '" data-act="tab" data-tab="' + (S.tab === 'admin' ? 'list' : 'admin') + '" aria-label="Behind the scenes">⚙</button>';
      right += '<button class="me" data-act="switch-me" aria-label="Switch person">' + esc(S.me) + '</button>';
    }
    let top = '<header class="top"><div class="top-row"><div>' + (eyebrow ? '<div class="eyebrow">' + esc(eyebrow) + '</div>' : '') + '<h1>' + title + '</h1></div>' +
      '<div class="top-right">' + right + '</div></div>';
    const waiting = outbox().length;
    if (waiting) top += '<div class="stale-pill" role="status">⏳ ' + waiting + ' change' + (waiting === 1 ? '' : 's') + ' waiting for signal</div>';
    else if (S.stale) top += '<div class="stale-pill" role="status">Updating…</div>';
    if (instore) top += viewStorePicker();
    else if (S.tab === 'shop') top += viewShopTop();
    top += '</header>';

    let body = '';
    if (S.tab === 'list') body = instore ? viewInStore() : viewList();
    if (S.tab === 'shop') body = viewShop();
    if (S.tab === 'meals') body = viewMeals();
    if (S.tab === 'ask') body = viewAsk();
    if (S.tab === 'admin') body = viewOrder();
    if (S.tab === 'carts') body = viewCarts();

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

  // Mini fridge drinks (Items.mini_fridge = Y) get their own List section, whatever their aisle (Mike, Nov 6).
  const groupOf = (r) => { const it = itemById(r.item_id); if (it && /^y/i.test(String(it.mini_fridge || ''))) return 'Mini fridge'; return (it && it.group) || 'Other'; };
  const groupsIn = (rows) => GROUPS.concat(Array.from(new Set(rows.map(groupOf))).filter((g) => GROUPS.indexOf(g) < 0))
    .filter((g) => rows.some((r) => groupOf(r) === g));

  // "owner + parent": who asked. Two or more names are highlighted so a double ask gets a second look.
  function whoHtml(r) {
    const names = wantedBy(r);
    if (!names.length) return '';
    const many = names.length > 1;
    const kid = !many && isKid(names[0]);
    return '<span class="who-names' + (many ? ' many' : '') + (kid ? ' kid' : '') + '" title="Asked by ' + esc(names.join(', ')) + '">' + esc(names.join(' + ')) + '</span>';
  }

  // Which meal a List row is for: the meal it was added for (meal_id), or else a meal planned in the next
  // 7 days that uses this item (owner, Nov 1: filter the List to meal items vs just stock).
  function mealFor(r) {
    if (!r) return null;
    // A meal link only counts while that meal is on the plan (2 days back through the plan window); a meal that
    // came off the plan (Hearth replaced the week) leaves its rows as plain stock until a parent settles them.
    const m = r.meal_id && mealById(r.meal_id);
    const fresh = r.added_at && String(r.added_at).slice(0, 10) === D().today; // added for it today: planning may come next
    if (m && (fresh || mealPlanned(m.id))) return { meal: m, date: '', planned: false };
    if (!r.item_id) return null;
    const today = D().today, last = addDays(today, 6);
    let best = null;
    (D().plan || []).forEach((p) => {
      const d = planDate(p);
      if (!d || d < today || d > last || isLeftover(p)) return;
      if (planItem(p)) { if (p.item_id === r.item_id && (!best || d < best.date)) best = { meal: planItem(p), date: d, planned: true }; return; }
      if (!p.meal_id) return;
      const meal = mealById(p.meal_id);
      if (meal && mealItems(meal).indexOf(r.item_id) >= 0 && (!best || d < best.date)) best = { meal: meal, date: d, planned: true };
    });
    return best;
  }
  const forMeal = (r) => !!mealFor(r);
  function mealPlanned(id) {
    const from = addDays(D().today, -2), to = addDays(D().today, (D().planDays || 14));
    return (D().plan || []).some((p) => { const d = planDate(p); return p.meal_id === id && d && d >= from && d <= to; });
  }
  function mealTag(r) {
    const f = mealFor(r);
    if (!f) return '';
    return f.planned ? '<span class="meal-tag soft">🍽 ' + esc(shortDay(f.date).split(' ')[0]) + ' · ' + esc(f.meal.name) + '</span>'
      : '<span class="meal-tag">🍽 ' + esc(f.meal.name) + '</span>';
  }
  // List filter pills: All · Needs a cart · For meals · Stock (not tied to a meal). Starts on All each time the
  // app opens. One List (owner, Nov 2): rows in a cart stay in their aisle with their 🛒 tag; "Needs a cart"
  // narrows to the rows no online cart has yet. needsCart is defined below; kindOk only runs at render time.
  S.listKind = 'all';
  const kindOk = (r) => S.listKind === 'all' || (S.listKind === 'cart' ? (canCarts() && needsCart(r)) : S.listKind === 'meal' ? forMeal(r) : !forMeal(r));
  // Pack sizes (Nov 3, the owner's idea): how many come in one package. Products `pack` when Claude filled it,
  // else read from the store's product name ("… Frozen - 8 Count", "8 Cups", "Pack of 12") or a size like "14 each".
  const PACK_WORDS = 'count|ct|cups?|bars?|pouches|pouch|sandwiche?s|rolls?|bottles?|cans?|pieces?|pcs|each|packs?|pk|pods?|sticks?|cakes?|pies?|bags?|boxes?|cartons?|links?|patties|eggs?';
  const PACK_RE = new RegExp('(?:^|[\\s(,-])(\\d{1,3})\\s*-?\\s*(?:' + PACK_WORDS + ')\\b', 'i');
  function packCount(text) {
    const t = String(text || '');
    const m = t.match(/\bpack of (\d{1,3})\b/i) || t.match(PACK_RE);
    const n = m ? parseInt(m[1], 10) : 0;
    return n >= 2 && n <= 500 ? n : 0;
  }
  // { count, size, text } for an item at a store (falls back to any store we know the product at), or null.
  function packOf(itemId, store) {
    const prods = (D().products || {})[itemId] || {};
    const k = prods[store] ? store : CART_STORES.find((x) => prods[x]) || Object.keys(prods)[0];
    const p = k && prods[k];
    if (!p) return null;
    const size = String(p.size || '').trim();
    const count = packCount(p.pack) || packCount(p.name) || packCount(size);
    const sizeOnly = size && !(count && packCount(size) === count && !/\d\s*(oz|lb|g|kg|ml|l|fl)\b/i.test(size)) ? size : '';
    if (!count && !sizeOnly) return null;
    return { count: count, size: sizeOnly, text: count ? count + ' ct' + (sizeOnly ? ' · ' + sizeOnly : '') : sizeOnly, store: k };
  }
  const packHtml = (pk) => (pk ? '<span class="pack">' + (pk.count ? '📦 ' : '') + esc(pk.text) + '</span>' : '');

  // Sold by the pound (api 45): qty is pounds, in ½ lb steps.
  const canV45 = () => Number(D().api || 0) >= 45;
  const canOptions = () => Number(D().api || 0) >= 51; // store options + Which one? cards + Use this
  const canV46 = () => Number(D().api || 0) >= 46; // substitution rules + backups
  const byLb = (itemId) => { const it = itemId && itemById(itemId); return !!(it && canV45() && it.sold_by === 'lb'); };
  const lbText = (q) => { const n = Number(q) || 0.5; return (n % 1 ? String(n).replace(/\.5$/, '½').replace(/^0½/, '½') : String(n)) + ' lb'; };
  function rowMeta(r) {
    const meta = [];
    if (byLb(r.item_id)) { meta.push('<span class="pack">⚖ ' + esc(lbText(r.qty)) + '</span>'); if (r.note) meta.push(esc(r.note)); return meta; }
    const pk = r.item_id ? packOf(r.item_id, cartStore(r) || r.store) : null;
    if (pk && pk.count) { if (Number(r.qty) > 1) meta.push('×' + r.qty); meta.push(packHtml(pk)); }
    else if (pk) meta.push((Number(r.qty) > 1 ? '×' + r.qty + ' ' : '') + '<span class="pack">' + esc(Number(r.qty) > 1 ? '(' + pk.text + ' each)' : pk.text) + '</span>');
    else if (Number(r.qty) > 1) meta.push('×' + r.qty);
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

  // api 53: drinks for the mini fridges (Items.mini_fridge = Y) wear a small tag wherever they show.
  const isFridge = (id) => { const it = itemById(id); return !!(it && /^y/i.test(String(it.mini_fridge || ''))); };
  const fridgeTag = (id) => (isFridge(id) ? ' <span class="fridge-tag">🥤 Mini fridge</span>' : '');

  // Claude put it in a store's online cart (status carted; List.cart = store code, api 11).
  const cartStore = (r) => (r && r.status === 'carted' ? String(r.cart || r.store || '') : '');
  /* Carts by line (api 25, Nov 2): each List row knows where it stands with the online carts.
     cart_want = the store a parent asked for (or 'out'); the cart runner on the cart computer does it, then
     sets status carted + cart, or leaves a reason in cart_note ("GE: out of stock"). Tags only say "In the
     cart" once the runner has seen it there. */
  const canCarts = () => Number(D().api || 0) >= 25;
  function cartState(r) {
    if (!r) return { kind: 'none' };
    const want = String(r.cart_want || '');
    const inCart = cartStore(r);
    if (inCart && want === 'out') return { kind: 'leaving', store: inCart };
    if (inCart && want && want !== inCart && CART_STORES.indexOf(want) >= 0) return { kind: 'moving', store: want, from: inCart };
    // api 34: cart_want = the cart it's already in = a qty change waiting for the runner.
    if (inCart && want === inCart) return { kind: 'in', store: inCart, qty: true };
    if (inCart) return { kind: 'in', store: inCart };
    if (r.status === 'needed' && CART_STORES.indexOf(want) >= 0) return { kind: 'going', store: want };
    if (r.status === 'needed' && r.cart_note) {
      const m = String(r.cart_note).match(/^(GE|WF|TGT|AMZ):\s*(.*)$/);
      return { kind: 'failed', store: m ? m[1] : '', note: m ? m[2] : String(r.cart_note) };
    }
    return { kind: 'none' };
  }
  // A row that could go in a cart now: on the List (not a request, not next week) and in no cart.
  const needsCart = (r) => r.status === 'needed' && (cartState(r).kind === 'none' || cartState(r).kind === 'failed');
  const sName = (code) => { const s = storeOf(code); return s.short || s.name; };
  const sCls = (code) => (code && code !== 'Either' ? storeOf(code).cls : 'either');
  function cartTag(r) {
    if (!r) return '';
    const c = cartState(r);
    if (c.kind === 'in' && c.qty) return '<span class="cart-tag soft ' + sCls(c.store) + '">⏳ Updating ' + esc(sName(c.store)) + ' cart</span>';
    if (c.kind === 'in') return '<span class="cart-tag ' + sCls(c.store) + '">🛒 In ' + (c.store && c.store !== 'Either' ? esc(sName(c.store)) + ' ' : '') + 'cart</span>';
    if (c.kind === 'going') return '<span class="cart-tag soft ' + sCls(c.store) + '">⏳ Adding to ' + esc(sName(c.store)) + ' cart</span>';
    if (c.kind === 'moving') return '<span class="cart-tag soft ' + sCls(c.store) + '">⏳ Moving to ' + esc(sName(c.store)) + ' cart</span>';
    if (c.kind === 'leaving') return '<span class="cart-tag soft ' + sCls(c.store) + '">⏳ Removing from ' + esc(sName(c.store)) + ' cart</span>';
    if (c.kind === 'failed') return '<span class="cart-tag warn" title="' + esc(c.note) + '">⚠ Not added' + (c.store ? ' to ' + esc(sName(c.store)) : '') + '</span>';
    return '';
  }
  // Which cart Poppy would put a row in, and why (shown before anything happens).
  function pickCart(r) {
    const it = itemById(r.item_id);
    const prods = (D().products || {})[r.item_id] || {};
    const only = onlyAt(r);
    if (CART_STORES.indexOf(only) >= 0) return { store: only, why: 'only sold there', guess: !prods[only] };
    const s = r.store && r.store !== 'Either' ? r.store : (it && it.store) || 'Either';
    // Best-price items (api 40): the cheapest store for the same product, when it clears the price rule.
    if (canBest() && isBest(it)) { const c = cheaperElsewhere(r.item_id, CART_STORES.indexOf(s) >= 0 ? s : 'GE'); if (c) return { store: c.store, why: 'best price: about $' + c.save.toFixed(2) + ' less there' }; }
    if (CART_STORES.indexOf(s) >= 0) return { store: s, why: 'where we usually get it', guess: !prods[s] };
    // Either grocery store: the one we know the product at, then the cheaper one, then a cart already going.
    const both = ['GE', 'WF'];
    const has = both.filter((k) => prods[k]);
    const busy = both.filter((k) => D().list.some((x) => { const c = cartState(x); return (c.kind === 'in' || c.kind === 'going') && c.store === k; }));
    if (has.length === 2) {
      const p = itemPrices(r.item_id).filter((x) => both.indexOf(x.store) >= 0);
      if (p.length === 2 && p[0].unit === p[1].unit && (Number(p[1].unit_price) - Number(p[0].unit_price)) / Number(p[1].unit_price) >= PRICE_MIN_PCT) return { store: p[0].store, why: 'either store; cheaper there' };
      if (busy.length === 1) return { store: busy[0], why: 'either store; that cart is already going' };
      return { store: 'GE', why: 'either store; Giant Eagle is the big order' };
    }
    if (has.length === 1) return { store: has[0], why: 'either store; the one we know the product at' };
    return { store: busy[0] || 'GE', why: 'best guess', guess: true };
  }
  // Send rows to carts: pairs = [{ r, store }].
  function pushRows(pairs, msg) {
    if (!pairs.length) return;
    const stores = {};
    act('cartPush', { rows: pairs.map((p) => ({ id: p.r.id, store: p.store })) }, () => {
      pairs.forEach((p) => {
        if (p.r.status === 'carted' && String(p.r.cart) === p.store) { if (p.r.cart_want !== p.store) p.r.cart_want = ''; return; }
        p.r.cart_want = p.store; p.r.cart_note = ''; stores[p.store] = 1;
      });
      Object.keys(stores).forEach(queueLocal);
    }, msg);
  }
  function queueLocal(code) {
    const open = jobs().find((j) => j.store === code && j.kind === 'build' && JOB_OPEN.indexOf(j.status) >= 0);
    if (!open) D().cartJobs = [{ id: tmpId(), at: nowIso(), by: S.me, store: code, kind: 'build', status: 'queued' }].concat(jobs());
  }
  function pushSummary(pairs) {
    const n = {};
    pairs.forEach((p) => (n[p.store] = (n[p.store] || 0) + 1));
    return Object.keys(n).map((k) => n[k] + ' ' + sName(k)).join(' · ');
  }

  /* Prices (api 23): Products rows carry price, unit_price, unit, price_at per store. Only fresh prices
     (30 days) in the same unit are compared. A List tag shows only when another store is 10%+ and $0.50+
     cheaper for the same amount (owner, Nov 2), and never for store-only or "either store" rows. */
  const PRICE_FRESH_DAYS = 30;
  const PRICE_MIN_PCT = 0.10;
  const PRICE_MIN_SAVE = 0.50;
  const priceAge = (iso) => (iso ? Math.round((new Date(D().today + 'T12:00:00') - new Date(String(iso).slice(0, 10) + 'T12:00:00')) / 86400000) : 9999);
  const hasPrice = (p) => !!(p && p.unit_price !== '' && p.unit_price != null && Number(p.unit_price) > 0 && p.unit);
  const freshPrice = (p) => hasPrice(p) && priceAge(p.price_at) <= PRICE_FRESH_DAYS;
  // Like items only: an `alt` Products row is a different product (another brand, organic vs not), never compared.
  const likeItem = (p) => !!p && p.match !== 'alt';
  const fmtUnit = (p) => { const v = Number(p.unit_price); return (v < 1 ? (v * 100).toFixed(1).replace(/\.0$/, '') + '¢' : '$' + v.toFixed(2)) + '/' + p.unit; };
  // Fresh, priced products for an item: [{ store, ...product }], cheapest first.
  function itemPrices(itemId) {
    const prods = (D().products || {})[itemId] || {};
    return Object.keys(prods).map((k) => Object.assign({ store: k }, prods[k])).filter((p) => freshPrice(p) && likeItem(p))
      .sort((a, b) => Number(a.unit_price) - Number(b.unit_price));
  }
  // Is another store meaningfully cheaper than `base` for this item? → { store, pct, save } or null.
  function cheaperElsewhere(itemId, base) {
    if (!base || base === 'Either') return null;
    const it = itemById(itemId);
    if (it && /^y/i.test(String(it.store_only || ''))) return null;
    const rows = itemPrices(itemId);
    const b = rows.find((p) => p.store === base);
    if (!b) return null;
    const c = rows.find((p) => p.store !== base && p.unit === b.unit);
    if (!c) return null;
    const pct = (Number(b.unit_price) - Number(c.unit_price)) / Number(b.unit_price);
    const amount = Number(b.price) > 0 ? Number(b.price) / Number(b.unit_price) : 1;
    const save = (Number(b.unit_price) - Number(c.unit_price)) * amount;
    return pct >= PRICE_MIN_PCT && save >= PRICE_MIN_SAVE ? { store: c.store, pct: pct, save: save } : null;
  }
  /* Week price tag + a cheaper week (Mom's 💡 idea, Nov 6: "tell us the price tag of the week and then offer
     suggestions for a cheaper week, in case we need it"). App only, from Products shelf prices (api 23):
     every ingredient of the week's planned meals and planned items counted once for the week (garlic in three
     meals is one buy), one package each (meats × the meal's meat_qty), at the store we usually buy it, else the
     cheapest like item. Pantry staples, dropped items and delivery boxes (Wildgrain) are left out. A rough
     guide, not a receipt. Cheaper week = swap a planned dinner for a well-liked dinner that costs $5+ less,
     counting only what each meal adds to the week. Parents only; a swap is a normal planSet. */
  const canWeekCost = () => Number(D().api || 0) >= 23;
  const WEEK_SWAP_MIN = 5;
  function itemPackPrice(id) {
    const it = itemById(id);
    if (!it) return null;
    const prods = (D().products || {})[id] || {};
    const ok = (k) => { const p = prods[k]; return p && likeItem(p) && Number(p.price) > 0 ? { v: Number(p.price), store: k, size: String(p.size || '') } : null; };
    const usual = it.store && it.store !== 'Either' ? ok(it.store) : null;
    if (usual) return usual;
    const all = Object.keys(prods).map(ok).filter(Boolean).sort((a, b) => a.v - b.v);
    return all[0] || null;
  }
  const weekCounts = (id) => { const it = itemById(id); return !!it && it.status !== 'Drop' && !isDelivery(it.store) && !isPantry(id); };
  /* How much of one package a meal uses (owner, Nov 6 evening: "we aren't using a full dozen eggs for one of those
     meals"; the first version charged a whole package of everything). A rough rule by kind of thing, not a recipe:
     meat = the whole pack (× meat_qty); eggs ⅓ of a dozen; sauces, dressings, oils, spices, spreads, peanut butter ⅛;
     big milk / juice jugs ¼; cans, boxes of pasta, puff pastry 1; produce, cheese, bread, frozen ½ (cheap loose produce
     priced each, like bananas or limes: 2–3 of them); other pantry ¼. A planned item (a snack we buy) = ½ a package. */
  const CONDIMENT = /sauce|dressing|ranch|\boil\b|vinegar|mustard|ketchup|mayo|paste|seasoning|spice|\bsalt\b|black pepper|honey|jelly|fruit spread|preserves|peanut butter|syrup|redhot|cholula|soy|sesame|vanilla|cornstarch|sugar|bisquick|panko|bread crumbs|croutons|cooking spray/i;
  const WHOLE_CAN = /beans?\b|tomatoes \(canned\)|contadina|coconut milk|broth|pasta|rotini|fusilli|gnocchi|puff pastry|pizza dough|pizza crust|tortellini|ravioli/i;
  function useShare(id, meal) {
    const it = itemById(id); if (!it) return 0;
    if (!meal) return 0.5;
    if (isMeat(id)) return meatQty(meal);
    const nm = String(it.name || '') + ' ' + String(it.brand_size || '');
    const g = String(it.group || '');
    if (/egg white/i.test(nm)) return 0.5;
    if (/\beggs?\b/i.test(it.name)) return 1 / 3;
    if (CONDIMENT.test(nm)) return 0.125;
    if (/salsa|guacamole|\bdip\b/i.test(nm)) return 1 / 3;
    if (WHOLE_CAN.test(nm)) return 1;
    if (g === 'Dairy') return /milk|juice|creamer/i.test(nm) ? 0.25 : /butter/i.test(nm) ? 0.25 : 0.5;
    if (g === 'Produce') { const pr = itemPackPrice(id); return pr && pr.v < 0.5 ? 3 : pr && pr.v < 1.5 ? 2 : 0.5; }
    if (g === 'Pantry' || g === 'Breakfast' || g === 'Snacks') return 0.25;
    return 0.5;
  }
  const SHARE_TXT = { 0.125: '⅛', 0.25: '¼', 0.5: '½', 2: '×2', 3: '×3' };
  const shareText = (v) => SHARE_TXT[v] || (Math.abs(v - 1 / 3) < 0.01 ? '⅓' : v === 1 ? '' : '×' + v);
  // What one meal uses: { id: share of a package }.
  function mealNeeds(meal) {
    const o = {};
    mealItems(meal).forEach((id) => { if (weekCounts(id)) o[id] = useShare(id, meal); });
    return o;
  }
  const needsCost = (need) => Object.keys(need).reduce((t, id) => {
    const pr = itemPackPrice(id); return t + (pr ? pr.v * need[id] : 0);
  }, 0);
  // The week: { total, entries: [{ date, slot, name, meal, need, cost }], priced, count, unpriced: [names], saveStores }.
  // Total = the sum of each meal's share, i.e. what the week's food uses, not a shopping bill.
  function weekCost(days) {
    const entries = [];
    (D().plan || []).forEach((p) => {
      const d = planDate(p);
      if (!d || days.indexOf(d) < 0 || isLeftover(p)) return;
      const meal = p.meal_id ? mealById(p.meal_id) : null;
      const pi = !meal ? planItem(p) : null;
      if (!meal && !pi) return;
      // The same meal at lunch or breakfast the day after (or the day of) its dinner is leftovers, even
      // without a "Leftover" note (Thu lunch = Wed's chili): it costs nothing more.
      const left = meal && slotOf(p) !== 'dinner' && [d, addDays(d, -1)].some((x) => planByDate('dinner')[x] === meal.id);
      const need = left ? {} : meal ? mealNeeds(meal) : (weekCounts(pi.id) ? { [pi.id]: useShare(pi.id, null) } : {});
      entries.push({ date: d, slot: slotOf(p), name: (left ? 'Leftover ' : '') + (meal ? meal.name : pi.name), meal: left ? null : meal, need: need, cost: needsCost(need), left: left });
    });
    entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : SLOTS.findIndex((x) => x[0] === a.slot) - SLOTS.findIndex((x) => x[0] === b.slot)));
    const all = {};
    entries.forEach((e) => Object.keys(e.need).forEach((id) => (all[id] = (all[id] || 0) + e.need[id])));
    let priced = 0, saveStores = 0; const unpriced = [];
    Object.keys(all).forEach((id) => {
      const pr = itemPackPrice(id);
      if (!pr) { unpriced.push(itemById(id).name); return; }
      priced++;
      const c = cheaperElsewhere(id, pr.store); if (c) saveStores += c.save * Math.max(1, Math.ceil(all[id] - 0.01));
    });
    const total = entries.reduce((t, e) => t + e.cost, 0);
    return { total: total, entries: entries, priced: priced, count: Object.keys(all).length, unpriced: unpriced.sort(), saveStores: saveStores };
  }
  // A meal we can price: 2+ linked ingredients we count, most of them priced.
  function mealPriceable(meal) {
    const ids = Object.keys(mealNeeds(meal));
    return ids.length >= 2 && ids.filter((id) => itemPackPrice(id)).length * 3 >= ids.length * 2;
  }
  // Up to 3 swaps, biggest saving first: { entry, to, save }.
  function cheaperWeek(wc, days) {
    const today = D().today;
    // Not a meal planned within a week either side (the curry Saturday shouldn't come back Thursday).
    const lo = addDays(days[0], -7), hi = addDays(days[days.length - 1], 7);
    const inWeek = {}; (D().plan || []).forEach((p) => { const d = planDate(p); if (p.meal_id && d && d >= lo && d <= hi) inWeek[p.meal_id] = 1; });
    const stats = D().mealStats || {};
    // Well liked = votes average 🙂 or better, or no votes yet but we've made it before.
    const liked = (m) => { const st = stats[m.id] || {}; return st.score ? st.score >= 3 : Number(st.made || 0) > 0; };
    const cands = D().meals.filter((m) => kindOf(m) === 'dinner' && !inWeek[m.id] && liked(m) && mealPriceable(m));
    const out = []; const used = {};
    wc.entries.filter((e) => e.meal && e.slot === 'dinner' && e.date >= addDays(today, 2) && mealPriceable(e.meal)) // tonight's and tomorrow's food is bought
      .map((e) => {
        let best = null;
        cands.forEach((m) => {
          const save = e.cost - needsCost(mealNeeds(m));
          const score = (stats[m.id] && stats[m.id].score) || 0;
          if (save >= WEEK_SWAP_MIN && (!best || save + score > best.save + best.score)) best = { entry: e, to: m, save: save, score: score };
        });
        return best;
      }).filter(Boolean).sort((a, b) => b.save - a.save)
      .forEach((x) => { if (out.length < 3 && !used[x.to.id]) { used[x.to.id] = 1; out.push(x); } });
    return out;
  }
  const dollars = (v) => '$' + Math.round(v);
  function weekCostLine(which, days) {
    if (!canWeekCost() || !amParent()) return '';
    const wc = weekCost(days);
    if (!wc.priced) return '';
    return '<button class="week-cost" data-act="open-weekcost" data-v="' + which + '"><span class="week-cost-txt">💲 About <b>' + dollars(wc.total) + '</b> ' + (which === 'next' ? 'next week' : 'this week') + '</span>' +
      '<span class="week-cost-go">Cheaper week ›</span></button>';
  }
  function viewWeekCostSheet(sh) {
    const w = planWeeks();
    const days = sh.week === 'next' ? w.nextWeek : w.thisWeek;
    const wc = weekCost(days);
    const swaps = cheaperWeek(wc, days);
    let h = '<div class="is-head"><div><h2>💲 Price tag of the week</h2><div class="is-sub">A rough guide from store shelf prices</div></div>' +
      '<button class="x-btn" data-act="close-x" aria-label="Close">✕</button></div>' +
      '<div class="seg">' + [['this', 'This week'], ['next', 'Next week · ' + md(w.nextSun)]].map((o) =>
        '<button type="button" data-act="weekcost-week" data-v="' + o[0] + '" class="' + (sh.week === o[0] ? 'on' : '') + '">' + esc(o[1]) + '</button>').join('') + '</div>';
    if (!wc.entries.length) return h + '<p class="note">Nothing planned for that week yet.</p>';
    h += '<div class="wc-total"><span class="wc-big">' + dollars(wc.total) + '</span><span class="muted">' + wc.entries.length + ' meals and snacks · ' + wc.priced + ' of ' + wc.count + ' ingredients priced</span></div>';
    h += '<p class="note">What the week\'s food uses: each meal pays its share of each package (a whole pack of meat, about ⅓ of a dozen eggs, ⅛ of a bottle of sauce) at the store we usually buy it. Leaves out pantry staples and Wildgrain.' +
      (wc.unpriced.length ? ' No price yet: ' + esc(wc.unpriced.slice(0, 8).join(', ')) + (wc.unpriced.length > 8 ? ' and ' + (wc.unpriced.length - 8) + ' more' : '') + '.' : '') + '</p>';
    h += '<h3 class="wc-h">💡 A cheaper week</h3>';
    if (swaps.length) {
      const saveAll = swaps.reduce((t, x) => t + x.save, 0);
      h += '<p class="note">' + (swaps.length === 1 ? 'Swap this dinner for one' : 'Swap these dinners for ones') + ' the family likes and save about <b>' + dollars(saveAll) + '</b>.</p>';
      swaps.forEach((x) => {
        h += '<div class="wc-swap"><div class="wc-swap-txt"><span class="muted">' + esc(shortDay(x.entry.date)) + '</span> ' + esc(x.entry.meal.name) + ' → <b>' + esc(x.to.name) + '</b><span class="wc-save">save ~' + dollars(x.save) + '</span></div>' +
          '<button class="btn btn-outline btn-sm" data-act="weekcost-swap" data-date="' + x.entry.date + '" data-to="' + x.to.id + '">Swap</button></div>';
      });
    } else h += '<p class="note">Nothing to swap: no well-liked dinner would save $' + WEEK_SWAP_MIN + ' or more on the days still ahead.</p>';
    if (wc.saveStores >= 2) h += '<p class="note">🛒 Getting a few things at the cheaper store would save about ' + dollars(wc.saveStores) + ' more (the $ tags on the List).</p>';
    h += '<h3 class="wc-h">By meal</h3>';
    wc.entries.slice().sort((a, b) => b.cost - a.cost).forEach((e) => {
      // The two priciest ingredients, so a big number explains itself (a jar of vanilla paste for pancakes).
      const top = Object.keys(e.need).map((id) => ({ id: id, pr: itemPackPrice(id) })).filter((x) => x.pr).sort((a, b) => b.pr.v * e.need[b.id] - a.pr.v * e.need[a.id]).slice(0, 2)
        .map((x) => itemById(x.id).name + (shareText(e.need[x.id]) ? ' ' + shareText(e.need[x.id]) : '') + ' ' + dollars(x.pr.v * e.need[x.id]));
      h += '<div class="wc-row"><span class="muted">' + esc(shortDay(e.date) + ' · ' + slotLabel(e.slot)) + '</span><span class="wc-name">' + esc(e.name) +
        (top.length > 1 && e.cost >= 8 ? '<span class="wc-top">' + esc(top.join(' · ')) + '</span>' : '') + '</span><span class="wc-cost">' + (e.left ? '$0' : e.cost ? '~' + dollars(e.cost) : '–') + '</span></div>';
    });
    return h + '<p class="note">⅓, ¼, ⅛ = the share of a package that meal uses (a rough rule, not the recipe). After a swap, send the week to Hearth.</p>';
  }
  const rowCheaper = (r) => (r && Number(D().api || 0) >= 23 ? cheaperElsewhere(r.item_id, r.store || 'Either') : null);
  function priceTag(r) {
    const c = rowCheaper(r);
    return c ? '<span class="price-tag" title="Same amount, about $' + c.save.toFixed(2) + ' less">$ ' + Math.round(c.pct * 100) + '% less at ' + esc(storeOf(c.store).short || storeOf(c.store).name) + '</span>' : '';
  }

  // At home a tap opens the item screen. Only In-store mode checks things off.
  // A cart line's price (Nov 5, owner: "cart total at the top but no price at the item level"): the store's
  // latest price for the product we buy there (Products, written by every cart build/check and the price pass) × qty.
  // Sold by the pound: price is per lb, qty is pounds. null when that store has no price for it yet.
  function linePrice(r, code) {
    const p = ((D().products || {})[r.item_id] || {})[code];
    const each = p ? Number(p.price) : 0;
    if (!(each > 0)) return null;
    const lb = byLb(r.item_id);
    const q = lb ? (Number(r.qty) || 0.5) : Math.max(1, Math.round(Number(r.qty) || 1));
    const age = p.price_at ? (Date.now() - new Date(String(p.price_at).replace(/^'/, '').slice(0, 10) + 'T12:00').getTime()) / 864e5 : 99;
    return { total: each * q, each: each, qty: q, lb: lb, sale: p.sale === 'Y', old: !(age <= 14) };
  }
  function linePriceHtml(r, code) {
    const lp = linePrice(r, code);
    if (!lp) return '<span class="line-price none" title="No price from the store yet">—</span>';
    const sub = lp.lb ? fmtMoney(lp.each) + '/lb' : lp.qty > 1 ? lp.qty + ' × ' + fmtMoney(lp.each) : (lp.sale ? 'sale' : '');
    return '<span class="line-price' + (lp.old ? ' old' : '') + '" title="' + (lp.old ? 'Price from more than 2 weeks ago' : 'Latest store price') + '"><b>' + fmtMoney(lp.total) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span>';
  }
  function listRow(r, priceAt) {
    const meta = rowMeta(r);
    const tag = mealTag(r);
    const only = onlyAt(r) ? storeMark(r) : '';
    const cart = cartTag(r);
    const price = r.status === 'needed' ? priceTag(r) : '';
    return '<div class="row"><button class="row-main" data-act="open-row" data-id="' + r.id + '"><span class="row-name">' + (only ? '' : storeMark(r)) + esc(r.name) + fridgeTag(r.item_id) + '</span>' +
      (meta.length ? '<span class="row-meta">' + meta.join(' · ') + '</span>' : '') + (tag || only || cart || price ? '<span class="tags">' + cart + only + tag + price + '</span>' : '') + '</button>' + whoHtml(r) + (priceAt ? linePriceHtml(r, priceAt) : '') + '</div>';
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
    return '<div class="row"><button class="row-main" data-act="open-row" data-id="' + r.id + '"><span class="row-name">' + esc(r.name) + fridgeTag(r.item_id) + '</span>' +
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

  /* ---------- the List (Nov 2, owner): what's still open ----------
     Carts live on the Carts screen now, so the List answers one question: what do we still have to deal with?
     Top to bottom: a summary line, 🍽 Missing for meals (planned in the next 7 days, not on the List, not seen
     at home lately), the List itself (one section by aisle; rows in a cart carry their 🛒 tag, the Needs a cart
     pill narrows to the rest; owner, Nov 2 ~10:20 am), Later (parked on purpose:
     "Next week", "In 2 weeks" or no date, built on hold_until; no date = LATER_NO_DATE). */
  const LATER_NO_DATE = '9999-12-31';
  const laterBack = (r) => { const u = String(r.hold_until || '').slice(0, 10); return !u || u >= '9000' ? '' : u; };
  const inCartNow = (r) => canCarts() && (r.status === 'carted' || r.status === 'needed') && ['in', 'going', 'moving', 'leaving'].indexOf(cartState(r).kind) >= 0;

  // api 54: pantry staples (Items.pantry = Y: garlic, soy sauce, ketchup…) are assumed on hand. They only count as
  // missing for a meal when the latest sighting in the last 14 days is low / out.
  const isPantry = (id) => { const it = itemById(id); return !!(it && /^y/i.test(String(it.pantry || ''))); };
  // Today's meals stop counting once their time has passed (owner, Nov 4: tonight's dinner was still "missing" at
  // midnight). Breakfast after 10, lunch after 2, snack after 5, dinner (blank slot) after 8, phone time.
  const SLOT_DONE_HOUR = { breakfast: 10, lunch: 14, snack: 17, dinner: 20 };
  const slotOver = (p) => new Date().getHours() >= (SLOT_DONE_HOUR[String(p.slot || '').toLowerCase()] || 20);

  // Ingredients of meals planned in the next 7 days that nobody has dealt with yet. Many meals (from Hearth
  // screenshots) have few or no ingredients linked, so the card also says which meals it can't check.
  function missingForMeals() {
    const today = D().today, last = addDays(today, 6);
    const onList = {};
    D().list.concat(D().held || []).forEach((r) => r.item_id && (onList[r.item_id] = 1));
    (D().recent || []).forEach((r) => { if (r.item_id && (r.status === 'bought' || r.status === 'have') && addDays(String(r.updated_at || '').slice(0, 10) || '2000-01-01', 3) >= today) onList[r.item_id] = 1; });
    // api 62: shredded cheddar on the List (or just bought) covers a meal that links the cheddar chunk.
    const kindsOn = {};
    Object.keys(onList).forEach((id) => { const k = kindKey(itemById(id)); if (k) kindsOn[k] = 1; });
    D().items.forEach((it) => { const k = kindKey(it); if (k && kindsOn[k]) onList[it.id] = 1; });
    const stock = D().stock || {};
    const lowNow = (id) => { const s = stock[id]; return !!(s && (s.level === 'low' || s.level === 'out') && addDays(String(s.at).slice(0, 10), 14) >= today); };
    const seen = (id) => { if (isPantry(id)) return !lowNow(id); const s = stock[id]; return s && s.level !== 'low' && s.level !== 'out' && s.level !== 'waste' && addDays(String(s.at).slice(0, 10), 7) >= today; };
    const byMeal = [];
    const taken = {};
    const blank = [];
    let meals = 0;
    (D().plan || []).slice().sort((a, b) => (planDate(a) < planDate(b) ? -1 : 1)).forEach((p) => {
      const d = planDate(p);
      if (!d || d < today || d > last || isLeftover(p)) return;
      if (d === today && slotOver(p)) return;
      const pi = planItem(p);
      if (pi) {
        if (pi.status !== 'Drop' && !isDelivery(pi.store) && !onList[pi.id] && !seen(pi.id) && !taken[pi.id]) { taken[pi.id] = 1; byMeal.push({ date: d, meal: { id: '', name: pi.name }, ids: [pi.id] }); }
        return;
      }
      if (!p.meal_id) return;
      const meal = mealById(p.meal_id);
      if (!meal) return;
      meals++;
      if (!mealItems(meal).some((id) => itemById(id))) { if (!blank.some((m) => m.id === meal.id)) blank.push(meal); return; }
      const ids = mealItems(meal).filter((id) => { const it = itemById(id); return it && it.status !== 'Drop' && !isDelivery(it.store) && !onList[id] && !seen(id) && !taken[id]; });
      if (!ids.length) return;
      ids.forEach((id) => (taken[id] = 1));
      byMeal.push({ date: d, meal: meal, ids: ids });
    });
    return { groups: byMeal, blank: blank, meals: meals };
  }
  // Compact on purpose (owner, Nov 2 ~9:28 am: it took too much room from the List itself). Nothing missing →
  // one quiet line. Meals with no ingredients set up sit behind a small link that opens a sheet.
  function viewMissing() {
    if (isKid(S.me)) return ''; // meal ingredients are the parents' job (owner, Nov 4)
    const m = missingForMeals();
    const groups = m.groups;
    if (!groups.length && !m.blank.length) return '';
    const gap = m.blank.length ? '<button class="link-btn miss-link" data-act="meal-gaps">' + m.blank.length + ' unchecked ›</button>' : '';
    if (!groups.length) return '<div class="miss-line">🍽 Nothing missing for meals' + (gap ? ' · ' + gap : '') + '</div>';
    const n = groups.reduce((t, g) => t + g.ids.length, 0);
    const kid = isKid(S.me);
    // api 55: who's already checking what (open 🔎 mission cards), so the girls' answers show up right here.
    const checking = {};
    (D().review || []).forEach((r) => { if (r.type === 'check' && r.status === 'open') { const m = String(r.detail).match(/\((i\d{3,})\)/); if (m) checking[m[1]] = r.audience; } });
    const toSend = [];
    groups.forEach((g) => g.ids.forEach((id) => { if (!checking[id]) toSend.push({ id: id, why: g.meal.name }); }));
    const out = n - toSend.length;
    const send = canMissionsAsk() && (D().settings.kids || []).length
      ? '<div class="miss-send">' + (toSend.length ? '<button class="btn btn-outline btn-sm" data-act="miss-send" data-items="' + esc(JSON.stringify(toSend)) + '">🔎 Have the girls check ' + toSend.length + '</button>' : '') +
        (out ? '<span class="row-meta">🔎 ' + out + ' out for checking</span>' : '') + '</div>'
      : '';
    return '<section class="card missing"><div class="card-head"><span>🍽 MISSING FOR MEALS · ' + n + '</span>' + (gap ? '<span class="sub">' + gap + '</span>' : '') + '</div>' + send + groups.map((g) =>
      '<div class="miss-row"><div class="miss-main"><div class="miss-items">' +
        g.ids.map((id) => '<button class="link-btn" data-act="open-item" data-id="' + esc(id) + '">' + esc(itemById(id).name) + '</button>' + (checking[id] ? '<span class="miss-chk"> 🔎 ' + esc(checking[id]) + '</span>' : '')).join(', ') + '</div>' +
        '<div class="row-meta">' + esc(shortDay(g.date).split(' ')[0]) + ' · ' + esc(g.meal.name) + '</div></div>' +
      '<div class="miss-btns"><button class="btn btn-outline btn-sm" data-act="miss-add" data-meal="' + esc(g.meal.id) + '" data-ids="' + esc(g.ids.join(',')) + '">' + (kid ? 'Ask' : 'Add') + '</button>' +
        (kid ? '' : '<button class="btn btn-plain btn-sm" data-act="miss-have" data-meal="' + esc(g.meal.id) + '" data-name="' + esc(g.meal.name) + '" data-ids="' + esc(g.ids.join(',')) + '">Have</button>') + '</div></div>').join('') + '</section>';
  }
  // Have → one sheet per meal row: everything starts ticked "have"; untick what we still need. Parents can also
  // mark a row as a pantry staple (api 54) so it stops coming up. Save = Stock "some" for the ticked ones,
  // the unticked ones go on the List for that meal, pantry changes saved on the item.
  function viewMissHave(sh) {
    const have = sh.ids.filter((id) => sh.have[id]).length, need = sh.ids.length - have;
    return '<div class="is-head"><div><h2>What do we have?</h2><div class="is-sub">' + esc(sh.name) + ' · tap what we still need</div></div><button class="x-btn" data-act="close-x" aria-label="Close">✕</button></div>' +
      sh.ids.map((id) => {
        const it = itemById(id); if (!it) return '';
        const h = !!sh.have[id], p = !!sh.pantry[id];
        return '<div class="row mh-row"><button class="row-main" data-act="mh-toggle" data-id="' + esc(id) + '" aria-pressed="' + h + '">' +
          '<span class="row-name">' + (h ? '✅ ' : '🛒 ') + esc(it.name) + '</span><span class="row-meta">' + (h ? 'We have it' : 'Need it: goes on the List') + '</span></button>' +
          (canPantry() ? '<button class="chip mh-pantry' + (p ? ' on' : '') + '" data-act="mh-pantry" data-id="' + esc(id) + '" aria-pressed="' + p + '">' + (canStaples() ? '🧺 Staple' : '🫙 Always have') + '</button>' : '') + '</div>';
      }).join('') +
      (canPantry() ? '<p class="note">' + (canStaples() ? '🧺 Staple = we never want to run out. Poppy stops asking about it for meals; the girls check it every week instead.' : '🫙 Always have = a pantry staple. Poppy stops asking about it for meals unless someone marks it low or out.') + '</p>' : '') +
      '<div class="sheet-actions"><button class="btn btn-primary" data-act="mh-save">' +
        (have && need ? 'Have ' + have + ' · add ' + need : need ? 'Add ' + need + ' to the List' : 'We have ' + (have > 1 ? 'all ' + have : 'it')) + '</button></div>';
  }
  // api 63: staples (Items pantry = Y) are things we never want to run out of. The girls check each one weekly
  // (slow ones every 3 weeks) through their missions; before an order a parent sends a sweep of anything not looked
  // at in STAPLE_SWEEP days. Parents see one quiet line on the List; tapping it opens the full list.
  const STAPLE_SWEEP = 4;
  function staplesInfo() {
    const today = D().today;
    const onList = {};
    D().list.concat(D().held || []).forEach((r) => r.item_id && (onList[r.item_id] = 1));
    const checking = {};
    (D().review || []).forEach((r) => { if (r.type === 'check' && r.status === 'open') { const m = String(r.detail).match(/\((i\d{3,})\)/); if (m) checking[m[1]] = r.audience; } });
    const rows = (D().staples || []).filter((x) => itemById(x.id)).map((x) => {
      const age = x.last ? Math.round((new Date(today + 'T12:00:00') - new Date(x.last + 'T12:00:00')) / 86400000) : 9999;
      return Object.assign({}, x, { age: age, low: (x.level === 'low' || x.level === 'out' || x.level === '0') && age <= 14, onList: !!onList[x.id], checking: checking[x.id] || '' });
    });
    const sweep = rows.filter((x) => x.age >= STAPLE_SWEEP && !x.onList && !x.checking).map((x) => ({ id: x.id }));
    return { rows: rows, sweep: sweep, low: rows.filter((x) => x.low && !x.onList), due: rows.filter((x) => x.due && !x.checking && !x.onList), checking: rows.filter((x) => x.checking) };
  }
  function viewStaplesLine() {
    if (!canStaples() || isKid(S.me)) return '';
    const st = staplesInfo();
    if (!st.rows.length) return '';
    const bits = [];
    if (st.low.length) bits.push('<b>' + st.low.length + ' low</b>');
    if (st.checking.length) bits.push('🔎 ' + st.checking.length + ' out for checking');
    if (st.due.length) bits.push(st.due.length + ' due for a look');
    if (!bits.length) bits.push('all checked');
    return '<div class="miss-line">🧺 Staples · ' + bits.join(' · ') + ' · <button class="link-btn miss-link" data-act="staples">See all ›</button></div>';
  }
  function viewStaplesSheet() {
    const st = staplesInfo();
    const kids = (D().settings.kids || []).length;
    const order = st.rows.slice().sort((a, b) => (b.low - a.low) || (b.age - a.age));
    const send = canMissionsAsk() && kids && !isKid(S.me)
      ? (st.sweep.length ? '<div class="sheet-actions"><button class="btn btn-primary" data-act="staples-send" data-items="' + esc(JSON.stringify(st.sweep)) + '">🔎 Have the girls check ' + st.sweep.length + '</button></div>' +
          '<p class="note">Before an order: sends every staple nobody has looked at in ' + STAPLE_SWEEP + '+ days. Low or out goes on the List for you to OK.</p>'
        : '<p class="note">Everything has had a look in the last ' + STAPLE_SWEEP + ' days.</p>')
      : '';
    return '<div class="is-head"><div><h2>🧺 Staples</h2><div class="is-sub">Never run out of these · ' + st.rows.length + ' items</div></div><button class="x-btn" data-act="close-x" aria-label="Close">✕</button></div>' +
      send +
      order.map((x) => {
        const it = itemById(x.id);
        const lv = { plenty: 'Plenty', some: 'Some', low: 'A little', out: 'Out', waste: 'Tossed' }[x.level] || (x.level ? x.level + ' left' : '');
        const meta = x.onList ? '🛒 On the List' : x.checking ? '🔎 ' + x.checking + ' is checking' : x.last ? lv + ' · ' + daysAgo(x.last) : 'Never checked';
        return '<div class="row"><button class="row-main" data-act="open-item" data-id="' + esc(x.id) + '"><span class="row-name">' + (x.low && !x.onList ? '⚠️ ' : '') + esc(it.name) + '</span><span class="row-meta">' + esc(meta) + '</span></button></div>';
      }).join('') +
      '<p class="note">The girls check each staple about once a week (things we buy rarely, every 3 weeks). Add or remove one on its item screen → Details → Staple?</p>';
  }
  // api 62: "Shredded cheddar is already on the List. Use that?" before a second item of the same kind goes on.
  function viewSameKind(sh) {
    const it = itemById(sh.item_id);
    const row = D().list.concat(D().held || []).find((r) => r.id === sh.row_id);
    if (!it || !row) return '<div class="is-head"><div><h2>All set</h2></div><button class="x-btn" data-act="close-x" aria-label="Close">✕</button></div>';
    const meal = row.meal_id && mealById(row.meal_id);
    const where = row.status === 'carted' && row.cart ? ' It’s in the ' + storeOf(row.cart).name + ' cart.' : '';
    return '<div class="is-head"><div><h2>Already on the List</h2><div class="is-sub">' + esc(row.name) + ' and ' + esc(it.name) + ' are the same kind</div></div><button class="x-btn" data-act="close-x" aria-label="Close">✕</button></div>' +
      '<p class="note">' + esc(row.name) + ' is on the List' + (meal ? ' for ' + esc(meal.name) : '') + '.' + esc(where) + ' One should cover both, so we don’t end up with two.</p>' +
      '<div class="sheet-actions"><button class="btn btn-primary" data-act="sk-use">Use ' + esc(row.name) + '</button>' +
      '<button class="btn btn-plain" data-act="sk-anyway">Add ' + esc(it.name) + ' anyway</button></div>';
  }
  function viewMealGaps() {
    const m = missingForMeals();
    return '<div class="is-head"><div><h2>Meals Poppy can’t check</h2><div class="is-sub">' + m.blank.length + ' of ' + m.meals + ' meals this week have no ingredients set up</div></div><button class="x-btn" data-act="close-x" aria-label="Close">✕</button></div>' +
      m.blank.map((x) => '<div class="row"><button class="row-main" data-act="open-meal" data-id="' + esc(x.id) + '"><span class="row-name">' + esc(x.name) + '</span><span class="row-meta">Tap → Edit meal to add ingredients</span></button></div>').join('') +
      '<p class="note">Missing for meals only checks ingredients a meal has set up, so meals with just one or two linked can also be missing things.</p>';
  }

  // Aisle accordions for a set of rows (faded rows keep their aisle open so Undo shows).
  function aisleCards(all, fadedIds) {
    let html = '';
    groupsIn(all).forEach((g) => {
      const rows = all.filter((r) => groupOf(r) === g);
      const live = rows.filter((r) => !fadedIds[r.id]);
      const key = 'a:' + g;
      const closed = isClosed(key) && !rows.some((r) => fadedIds[r.id]);
      html += '<section class="card acc"><button class="card-head acc-head" data-act="fold" data-key="' + esc(key) + '" aria-expanded="' + !closed + '">' +
        '<span>' + esc(g.toUpperCase()) + ' · ' + live.length + '</span>' + chev(closed) + '</button>';
      if (closed) html += '<button class="peek" data-act="fold" data-key="' + esc(key) + '">' + esc(live.slice(0, 6).map((r) => r.name).join(', ')) + (live.length > 6 ? '…' : '') + '</button>';
      else html += rows.map((r) => (fadedIds[r.id] ? fadedRow(fadedIds[r.id]) : listRow(r))).join('');
      html += '</section>';
    });
    return html;
  }

  function viewList() {
    const list = D().list;
    const requests = list.filter((r) => r.status === 'requested');
    const active = list.filter((r) => r.status !== 'requested');
    const held = D().held || [];
    let html = '';

    html += viewInstallTip();
    html += viewSigninWarn();
    if (!canCarts()) html += viewJobBanner();
    html += viewUseSoon();
    if (requests.length) {
      html += '<section class="card requests"><div class="card-head">' + (amParent() ? 'REQUESTS · ' + requests.length : 'WAITING FOR A PARENT · ' + requests.length) + '</div>' +
        requests.map(requestRow).join('') + '</section>';
    }

    const faded = fadingRows();
    const fadedIds = {};
    faded.forEach((f) => (fadedIds[f.row.id] = f));
    const carts = active.filter(inCartNow);
    const open = active.filter((r) => !inCartNow(r));

    // Summary: what still needs a cart, and how much is already in one (tap → Carts screen).
    if (active.length || held.length) {
      const bits = [];
      if (canCarts()) {
        bits.push('<b>' + open.length + ' need' + (open.length === 1 ? 's' : '') + ' a cart</b>');
        if (carts.length) bits.push('<button class="link-btn inline" data-act="tab" data-tab="carts">' + carts.length + ' in carts ›</button>');
      } else bits.push('<b>' + active.length + ' on the List</b>');
      if (held.length) bits.push(held.length + ' later');
      html += '<div class="list-sum">' + bits.join(' · ') + '</div>';
    }

    html += viewMissing();
    html += viewStaplesLine();

    // One List by aisle (owner, Nov 2): in-cart rows sit with the rest and show their 🛒 tag.
    // Pills: All · 🛒 Needs a cart · 🍽 Meals · 🧺 Stock.
    const shown = active.filter(kindOk);
    const all = shown.concat(faded.map((f) => f.row).filter(kindOk));
    if (active.length || faded.length) {
      const nMeal = active.filter(forMeal).length;
      const pill = (v, label, n) => '<button class="pill small' + (S.listKind === v ? ' on' : '') + '" data-act="list-kind" data-v="' + v + '" aria-pressed="' + (S.listKind === v) + '">' + label + ' <span class="pill-n">' + n + '</span></button>';
      const nNeed = canCarts() ? active.filter(needsCart).length : 0;
      const push = canCarts() && amParent() ? shown.filter(needsCart).length : 0;
      const allClosed = groupsIn(all).every((g) => isClosed('a:' + g));
      html += '<div class="sec-head"><span class="sec-title">On the List · ' + shown.length +
        ' <button class="link-btn inline fold-link" data-act="fold-all">' + (allClosed ? 'Open all' : 'Close all') + '</button></span>' +
        (push ? '<button class="btn btn-outline btn-sm" data-act="push-all">🛒 Put ' + push + ' in carts</button>' : '') + '</div>' +
        '<div class="list-tools"><span class="chips-row tight">' + pill('all', 'All', active.length) + (canCarts() ? pill('cart', '🛒 Needs a cart', nNeed) : '') +
        pill('meal', '🍽 Meals', nMeal) + pill('stock', '🧺 Stock', active.length - nMeal) + '</span></div>';
      if (!shown.length && !faded.length) html += '<div class="empty small">' + ({ cart: 'Everything on the List is in a cart.', meal: 'Nothing here is for a planned meal this week.', stock: 'Everything here is for a meal.' }[S.listKind] || '') + '</div>';
      html += aisleCards(all, fadedIds);
    }

    if (!list.length && !faded.length && !held.length) html += '<div class="empty">The list is empty.<br><button class="btn btn-outline" style="margin-top:12px" data-act="tab" data-tab="shop">Add things in Shop</button></div>';

    // Later: we need it, just not this order.
    if (held.length) {
      const c = isClosed('held');
      html += '<section class="card dashed acc"><button class="card-head acc-head head-either" data-act="fold" data-key="held" aria-expanded="' + !c + '"><span>⏸ LATER · ' + held.length + '</span>' + chev(c) + '</button>' +
        (c ? '<button class="peek" data-act="fold" data-key="held">' + esc(held.slice(0, 6).map((r) => r.name).join(', ')) + (held.length > 6 ? '…' : '') + '</button>'
          : held.map((r) => '<div class="row"><button class="row-main" data-act="open-row" data-id="' + r.id + '"><span class="row-name">' + esc(r.name) + '</span><span class="row-meta">' +
            (laterBack(r) ? 'back ' + esc(shortDay(laterBack(r))) : 'no date') + '</span></button>' +
            '<button class="btn btn-plain" data-act="unhold" data-id="' + r.id + '">Need it now</button></div>').join('')) + '</section>';
    }

    html += '<p class="hint">The List is what’s still open. 🍽 Missing for meals = things this week’s meals use that aren’t on the List or seen at home. ' +
      (canCarts() ? '🛒 tags show what’s already in an online cart; Needs a cart = the rest. ' : '') + '⏸ Later = we need it, just not this order (tap an item → Later). Search and browse everything in Shop.</p>';
    return html;
  }

  /* ---------- use soon (api 22) ---------- */
  // Perishables near their last good day (bought date + Items shelf_days). Used it / Tossed / Still good.
  const canUseSoon = () => Number(D().api || 0) >= 22;
  // api 29: Items open_to_try ("we'd try something else": the price pass looks up alternatives, offered as `try` cards).
  const canTry = () => Number(D().api || 0) >= 29;
  // api 40 (Nov 4, owner): "any store, best price" items (Items best_price = Y).
  const canBest = () => Number(D().api || 0) >= 40;
  const isBest = (it) => !!it && /^y/i.test(String(it.best_price || ''));
  function useSoonWhen(x) {
    if (x.left >= 1) return 'good through tomorrow';
    if (x.left === 0) return 'last good day today';
    return 'probably past it · still there?';
  }
  function viewUseSoon() {
    if (!canUseSoon()) return '';
    const rows = D().useSoon || [];
    if (!rows.length) return '';
    return '<section class="card use-soon"><div class="card-head">⏳ USE SOON · ' + rows.length + '</div>' + rows.map((x) => {
      const past = x.left < 0;
      return '<div class="us-row' + (past ? ' past' : '') + '"><button class="row-main" data-act="open-item" data-id="' + esc(x.item_id) + '"><span class="row-name">' + esc(x.name) + '</span>' +
        '<span class="row-meta">' + esc(useSoonWhen(x)) + ' · bought ' + esc(daysAgo(x.bought)) + '</span></button>' +
        '<div class="us-btns"><button class="btn btn-outline btn-sm" data-act="use-soon" data-id="' + esc(x.item_id) + '" data-what="used">Used it</button>' +
        '<button class="btn btn-outline btn-sm" data-act="use-soon" data-id="' + esc(x.item_id) + '" data-what="tossed">Tossed</button>' +
        '<button class="btn btn-plain btn-sm" data-act="use-soon" data-id="' + esc(x.item_id) + '" data-what="good">Still good</button></div></div>';
    }).join('') + '</section>';
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
    // A virtual cart (owner, Nov 1): tapping a row puts it in the cart, and it leaves the List for good (status
    // bought, logged). No crossed-out rows, no taking it back out here; to get it back, add it again from Shop,
    // where the item shows what happened to it ("in the cart today").
    const open = D().list.filter(inStore);
    const cart = D().recent.filter((r) => boughtToday(r) && inStore(r));
    const rows = open.map((r) => ({ r: r, done: false }));
    const total = open.length + cart.length;
    let html = total ? '<div class="shop-progress"><span>🛒 ' + cart.length + ' in the cart · ' + open.length + ' to go</span><div class="bar"><i style="width:' + Math.round(100 * cart.length / total) + '%"></i></div></div>' : '';
    if (!open.length) html += '<div class="empty">' + (cart.length ? 'Everything’s in the cart. Tap Done when you check out.' : 'Nothing on the list for ' + esc(S.instore === 'all' ? 'any store' : storeOf(S.instore).name) + '.') + '</div>';
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
          '<span class="row-main"><span class="row-name">' + esc(r.name) + fridgeTag(r.item_id) + '</span>' + (meta.length ? '<span class="row-meta">' + meta.join(' · ') + '</span>' : '') +
          (mealTag(r) && !x.done ? '<span class="tags">' + mealTag(r) + '</span>' : '') + '</span>' +
          (wantedBy(r).length > 1 && !x.done ? whoHtml(r) : '') + '</button>';
      }).join('') + '</section>';
    });
    if (cart.length) {
      const c = isClosed('cart');
      html += '<section class="card in-cart"><button class="card-head acc-head" data-act="fold" data-key="cart" aria-expanded="' + !c + '"><span>🛒 IN THE CART · ' + cart.length + '</span>' + chev(c) + '</button>' +
        (c ? '<button class="peek" data-act="fold" data-key="cart">' + esc(cart.slice(-8).reverse().map((r) => r.name).join(', ')) + (cart.length > 8 ? '…' : '') + '</button>'
          : cart.slice().reverse().map((r) => '<div class="row"><button class="row-main" data-act="open-item" data-id="' + esc(r.item_id) + '"><span class="row-name">' + esc(r.name) + fridgeTag(r.item_id) + '</span>' +
            (Number(r.qty) > 1 ? '<span class="row-meta">×' + esc(r.qty) + '</span>' : '') + '</button></div>').join('')) + '</section>';
    }
    html += '<p class="hint">Tap an item to put it in the cart; it comes off the List. Everyone shopping sees the same cart. Put something in by mistake? Add it back from Shop. Tap Done when you check out.</p>';
    return html;
  }

  /* ---------- shop tab (add things) ---------- */
  // Why something left the List lately (the last finished List row for it, past week): shown on its Shop row,
  // so "where did it go?" has an answer. e.g. "In the cart today (parent)", "We had some · yesterday", "Taken off · Sun".
  function lastOutcome(itemId) {
    const rows = (D().recent || []).filter((r) => r.item_id === itemId).sort((a, b) => String(a.updated_at) < String(b.updated_at) ? 1 : -1);
    const r = rows[0];
    if (!r) return null;
    const when = daysAgo(r.updated_at);
    const who = (String(r.note || '').match(/\(([A-Z][a-z]+)\)\s*$/) || [])[1];
    const by = who ? ' (' + who + ')' : '';
    if (r.status === 'bought') return { cls: 'bought', text: (/in the cart in store/.test(r.note || '') ? '🛒 In the cart ' : '✓ Bought ') + when + by };
    if (r.status === 'have') return { cls: 'have', text: '🏠 We had some · ' + when + by };
    return { cls: 'off', text: 'Taken off the List · ' + when + by };
  }

  // Smart filters. Each returns item ids; pills with nothing in them are hidden.
  // Nov 2 (owner): "On the list" is gone (the List tab is that view); "Not lately" and "Cheaper elsewhere" are new.
  function smartSets() {
    const items = D().items.filter((i) => i.status !== 'Drop');
    const listed = {};
    D().list.concat(D().held || []).forEach((r) => (listed[r.item_id] = true));
    const today = D().today;
    const ago = (iso) => (iso ? Math.round((new Date(today + 'T12:00:00') - new Date(String(iso).slice(0, 10) + 'T12:00:00')) / 86400000) : 9999);
    const window = planDates();
    const dinnerIds = [];
    D().plan.forEach((p) => {
      if (isLeftover(p) || window.indexOf(planDate(p)) < 0) return;
      if (planItem(p)) { if (dinnerIds.indexOf(p.item_id) < 0) dinnerIds.push(p.item_id); return; }
      if (!p.meal_id) return;
      mealItems(mealById(p.meal_id)).forEach((id) => dinnerIds.indexOf(id) < 0 && dinnerIds.push(id));
    });
    const stock = D().stock || {};
    const usual = (i) => i.status === 'Always' || Number(i.orders) >= 2;
    return {
      due: D().due.map((d) => d.id).filter((id) => !listed[id]),
      usual: items.filter(usual).map((i) => i.id),
      dinners: dinnerIds.filter((id) => itemById(id)),
      // Running low clears once it's on the List or bought since (api 28 last_bought counts receipts and List buys);
      // a later Plenty / Some sighting replaces it (stock[id] is the newest sighting).
      low: Object.keys(stock).filter((id) => {
        const st = stock[id], it = itemById(id);
        if (!it || listed[id] || !(st.level === 'low' || st.level === 'out') || ago(st.at) > 14) return false;
        return !(it.last_bought && String(it.last_bought).slice(0, 10) >= String(st.at).slice(0, 10));
      }),
      recent: items.filter((i) => ago(i.last_bought) <= 14).map((i) => i.id),
      // A usual we haven't bought in a month and at least twice its normal gap: easy to forget.
      stale: items.filter((i) => usual(i) && i.last_bought && !listed[i.id] && ago(i.last_bought) >= Math.max(30, 2 * (Number(i.avg_days) || 0))).map((i) => i.id),
      cheaper: Number(D().api || 0) >= 23 ? items.filter((i) => cheaperElsewhere(i.id, i.store)).map((i) => i.id) : [],
      listed: listed,
    };
  }
  const SMART = [['all', 'Everything'], ['due', '⏰ Probably due'], ['dinners', '🍽 For meals'], ['usual', '⭐ Usuals'], ['low', '📉 Running low'],
    ['recent', '🕘 Bought lately'], ['stale', '💤 Not lately'], ['cheaper', '💲 Cheaper elsewhere']];
  const SHOP_STORES = [['all', 'All'], ['GE', 'Giant Eagle'], ['WF', 'Whole Foods'], ['TGT', 'Target'], ['AMZ', 'Amazon'], ['DLV', '🧊 Deliveries']];
  const SHOP_SORTS = [['most', 'Most bought'], ['last', 'Last bought'], ['az', 'A–Z']];

  // Shop top (Nov 2, owner): search with a ✕ to clear it, and a Filter button that opens the filter panel
  // (Show / Store on one row / Sort / Hide what's on the List). Folded each time; when filters are on, a
  // one-line summary with Clear sits under the search so nothing is hidden by surprise.
  function shopFiltersOn() {
    const on = [];
    if ((S.shopFilter || 'all') !== 'all') on.push((SMART.find((p) => p[0] === S.shopFilter) || [])[1]);
    if ((S.shopStore || 'all') !== 'all') on.push(storeOf(S.shopStore).name);
    if (S.shopHideListed) on.push('Not on the List');
    if ((S.shopSort || 'most') !== 'most') on.push('Sorted ' + (SHOP_SORTS.find((p) => p[0] === S.shopSort) || [])[1]);
    return on.filter(Boolean);
  }

  function viewShopTop() {
    const sets = smartSets();
    const f = S.shopFilter || 'all';
    const st = S.shopStore || 'all';
    const sort = S.shopSort || 'most';
    const on = shopFiltersOn();
    const open = !!S.shopFiltersOpen;
    let h = '<div class="shop-search"><form class="addbar" data-form="add" autocomplete="off"><label class="sr" for="add">Search or add</label>' +
      '<input id="add" class="field" type="search" placeholder="' + (isKid(S.me) ? 'Search or ask…' : 'Search or add…') + '" value="' + esc(S.query) + '" enterkeyhint="done">' +
      (S.query ? '<button type="button" class="search-x" data-act="shop-clear-q" aria-label="Clear the search">✕</button>' : '') + '</form>' +
      '<button type="button" class="filter-btn' + (open ? ' open' : '') + (on.length ? ' active' : '') + '" data-act="shop-filters" aria-expanded="' + open + '" aria-controls="shop-filters">' +
      '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M4.5 8h7M7 12h2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>' +
      '<span>Filter</span>' + (on.length ? '<span class="filter-n">' + on.length + '</span>' : '') + '</button></div>';
    if (open) {
      const pill = (v, label, n) => '<button type="button" class="pill small' + (f === v ? ' on' : '') + '" data-act="shop-filter" data-v="' + v + '" aria-pressed="' + (f === v) + '">' + label + (n != null ? ' <span class="pill-n">' + n + '</span>' : '') + '</button>';
      const seg = (act, cur, v, label, cls) => '<button type="button" class="' + (cls || '') + (cur === v ? ' on' : '') + '" data-act="' + act + '" data-v="' + v + '" aria-pressed="' + (cur === v) + '">' + label + '</button>';
      h += '<div class="filter-panel" id="shop-filters">' +
        '<div class="fp-label">Show</div><div class="chips-row">' + SMART.filter((p) => p[0] === 'all' || p[0] === f || sets[p[0]].length).map((p) => pill(p[0], p[1], p[0] === 'all' ? null : sets[p[0]].length)).join('') + '</div>' +
        '<div class="fp-label">Store</div><div class="seg seg-stores">' + SHOP_STORES.map((p) => seg('shop-store', st, p[0], p[1], p[0] === 'all' ? '' : storeOf(p[0]).cls)).join('') + '</div>' +
        '<div class="fp-label">Sort</div><div class="seg">' + SHOP_SORTS.map((p) => seg('shop-sort', sort, p[0], p[1])).join('') + '</div>' +
        '<button type="button" class="fp-check' + (S.shopHideListed ? ' on' : '') + '" role="switch" aria-checked="' + !!S.shopHideListed + '" data-act="shop-hide-listed"><span class="sw" aria-hidden="true"></span>Hide what’s already on the List</button>' +
        '<div class="fp-foot">' + (on.length ? '<button type="button" class="link-btn" data-act="shop-filters-clear">Clear filters</button>' : '<span></span>') +
        '<button type="button" class="btn btn-primary small" data-act="shop-filters">Done</button></div></div>';
    } else if (on.length) {
      h += '<div class="filter-sum"><span>' + esc(on.join(' · ')) + '</span><button type="button" class="link-btn" data-act="shop-filters-clear">Clear</button></div>';
    }
    return h;
  }

  function viewShop() {
    const sets = smartSets();
    const f = S.shopFilter || 'all';
    const q = S.query.trim().toLowerCase();
    const st = S.shopStore || 'all';
    let items = D().items.filter((i) => i.status !== 'Drop');
    if (f !== 'all') { const ids = sets[f] || []; items = ids.map(itemById).filter(Boolean); }
    if (S.shopHideListed) items = items.filter((i) => !sets.listed[i.id]);
    if (st === 'DLV') items = items.filter((i) => isDelivery(i.store));
    else if (st !== 'all') items = items.filter((i) => i.store === st || (i.store === 'Either' && takesEither(st)));
    let close = false;
    if (q) { const fr = findItems(q, items); items = fr.hits; close = !fr.all && items.length > 0; }

    let html = '';
    // With matches, "Add … as something new" goes under them: on a phone the keyboard leaves room for ~3 rows.
    const addNewBtn = (q && !D().items.some((i) => String(i.name).toLowerCase() === q))
      ? '<button class="new-item" data-act="add-new"><span class="add-btn" aria-hidden="true">+</span><span>Add “' + esc(S.query.trim()) + '” as ' + (isKid(S.me) ? 'a request' : 'something new') + '</span></button>' : '';
    if (addNewBtn && (!items.length || close)) html += addNewBtn;
    if (close) html += '<p class="note search-close">Nothing matches every word. Closest matches:</p>';
    const row = (i) => {
      const on = !!sets.listed[i.id];
      const meta = ['<span class="store-dot ' + storeOf(i.store).cls + '"></span>' + esc(storeOf(i.store).name)];
      const last = !on && lastOutcome(i.id);
      if (last) meta.unshift('<span class="outcome ' + last.cls + '">' + esc(last.text) + '</span>');
      else if (i.last_bought) meta.push('bought ' + esc(daysAgo(i.last_bought)));
      const pt = priceTag({ item_id: i.id, store: i.store });
      if (pt) meta.push(pt);
      const pkS = packOf(i.id, i.store);
      if (pkS) meta.push(packHtml(pkS));
      const stk = (D().stock || {})[i.id];
      if (stk) meta.push('at home: ' + esc(levelText(stk.level)) + ' (' + esc(daysAgo(stk.at)) + ')');
      return '<div class="row"><button class="row-main" data-act="open-item" data-id="' + i.id + '"><span class="row-name">' + esc(i.name) + fridgeTag(i.id) + '</span><span class="row-meta">' + meta.join(' · ') + '</span></button>' +
        (isDelivery(i.store) ? '<button class="add-btn dlv" data-act="open-item" data-id="' + i.id + '" aria-label="' + esc(i.name) + ' comes from ' + esc(storeOf(i.store).name) + '">🧊</button>'
          : on ? '<button class="add-btn on" data-act="open-item" data-id="' + i.id + '" aria-label="' + esc(i.name) + ' is on the list">✓</button>'
          : '<button class="add-btn" data-act="add-item" data-id="' + i.id + '" aria-label="Add ' + esc(i.name) + '">+</button>') + '</div>';
    };
    if (q) {
      // A search is one list, best match first (not by aisle), so the right item is the top row.
      if (items.length) html += '<section class="card">' + rankHits(items, q).map(row).join('') + '</section>';
      if (addNewBtn && items.length && !close) html += addNewBtn;
    } else if (f === 'due' || f === 'dinners' || f === 'low') {
      if (items.length) html += '<section class="card">' + items.map(row).join('') + '</section>';
    } else {
      const sort = S.shopSort || 'most';
      const byName = (a, b) => String(a.name).localeCompare(b.name);
      const sorted = items.slice().sort(sort === 'az' ? byName
        : sort === 'last' ? (a, b) => String(b.last_bought || '').localeCompare(String(a.last_bought || '')) || byName(a, b)
          : (a, b) => (Number(b.orders) || 0) - (Number(a.orders) || 0) || byName(a, b));
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
  const canFridge = () => Number(D().api || 0) >= 53;
  const canPantry = () => Number(D().api || 0) >= 54;
  const canMissionsAsk = () => Number(D().api || 0) >= 55;
  const canStaples = () => Number(D().api || 0) >= 63;

  function openItemSheet(itemId, rowId, name) {
    const it = itemById(itemId);
    S.sheet = {
      type: 'item', item_id: itemId || '', row_id: rowId || '', name: (it && it.name) || name || '', level: '', count: 1, details: false, info: null,
      d: it ? Object.assign({ store: it.store || 'Either', ok_swap: it.ok_swap || '', status: it.status || '', brand_size: it.brand_size || '', notes: it.notes || '', group: it.group || 'Other' }, canV9() ? { store_only: /^y/i.test(String(it.store_only || '')) ? 'Y' : '' } : {}, canUseSoon() ? { shelf_days: it.shelf_days ? String(it.shelf_days) : '' } : {}, canTry() ? { open_to_try: /^y/i.test(String(it.open_to_try || '')) ? 'Y' : '' } : {}, canBest() ? { best_price: isBest(it) ? 'Y' : '' } : {}, canFridge() ? { mini_fridge: isFridge(it.id) ? 'Y' : '' } : {}, canPantry() ? { pantry: isPantry(it.id) ? 'Y' : '' } : {}, canV45() ? { sold_by: it.sold_by === 'lb' ? 'lb' : '', spoken: String(it.aliases || '').split(';').map((x) => x.trim()).filter((x) => /[a-z]/.test(x)).join(', ') } : {}) : null,
    };
    render();
    if (itemId && canInfo() && String(itemId).indexOf('tmp') !== 0) {
      const mine = S.sheet;
      api('itemInfo', { item_id: itemId }).then((j) => { if (S.sheet === mine) { mine.info = j.result || {}; render(); } }).catch(() => { if (S.sheet === mine) { mine.info = { failed: true }; render(); } });
    }
  }

  const fmtShort = (iso) => { const d = new Date(String(iso).slice(0, 10) + 'T12:00:00'); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
  const money = (v) => (v === '' || v == null || isNaN(Number(v)) ? '' : '$' + Number(v).toFixed(2));

  // Item screen (Nov 2 cleanup, owner): quick things up top (where it stands, how many, cart, have some,
  // Next week / Bought it / Take off), then four folded sections for the deeper look: What we buy (product,
  // aisle and price per store in one list), History, What we know, Details. Sections start folded every time.
  function viewItemSheet(sh) {
    const it = itemById(sh.item_id);
    const row = (sh.row_id && (D().list.find((r) => r.id === sh.row_id) || (D().held || []).find((r) => r.id === sh.row_id))) ||
      (sh.item_id && (listRowFor(sh.item_id) || (D().held || []).find((r) => r.item_id === sh.item_id)));
    const held = row && (D().held || []).indexOf(row) >= 0;
    const kid = isKid(S.me);
    const open = sh.open || (sh.open = {});
    const storeCode = (row && row.store) || (it && it.store) || 'Either';
    // Store · aisle under the name (Nov 4, owner: "I went to the item to change it and couldn't"): for parents it's a
    // button that opens Details and scrolls to it, where store and aisle are edited. Kids see plain text.
    const subTxt = '<span class="store-dot ' + storeOf(storeCode).cls + '"></span>' + esc(storeOf(storeCode).name) + (it && it.group ? ' · ' + esc(it.group) : '');
    let h = '<div class="is-head"><div><h2>' + esc(sh.name) + (sh.item_id ? fridgeTag(sh.item_id) : '') + '</h2>' +
      (it && sh.d && !kid ? '<button type="button" class="is-sub is-sub-edit" data-act="is-edit" aria-label="Change store or aisle">' + subTxt + ' <span class="is-sub-pen">✎ change</span></button>' : '<div class="is-sub">' + subTxt + '</div>') + '</div><button class="x-btn" data-act="close-x" aria-label="Close">✕</button></div>' +
      viewItemProduct(sh.item_id, storeCode, it); // not in the sticky head: it scrolls away

    // ---- Quick: where it stands, how many, the cart
    if (row) {
      const cartable = canCarts() && !held && (row.status === 'needed' || row.status === 'carted');
      const c = cartable ? cartState(row) : null;
      const full = (code) => esc(storeOf(code).name);
      let what = held ? '⏸ Later' + (laterBack(row) ? ' · back ' + esc(shortDay(laterBack(row))) : '') : row.status === 'requested' ? 'Asked for' : 'On the List';
      if (c) {
        if (c.kind === 'in' && c.qty) what = '⏳ Waiting on Claude to change how many in the ' + full(c.store) + ' cart';
        else if (c.kind === 'in') what = '🛒 In the ' + full(c.store) + ' cart';
        else if (c.kind === 'going') what = '⏳ Waiting on Claude to add it to the ' + full(c.store) + ' cart';
        else if (c.kind === 'moving') what = '⏳ Waiting on Claude to move it to the ' + full(c.store) + ' cart';
        else if (c.kind === 'leaving') what = '⏳ Waiting on Claude to take it out of the ' + full(c.store) + ' cart';
        else if (c.kind === 'failed') what = '⚠ Couldn’t add it' + (c.store ? ' to ' + full(c.store) : '');
      } else if (row.status === 'carted' && cartStore(row) && cartStore(row) !== 'Either') what = '🛒 In the ' + full(cartStore(row)) + ' cart';
      h += '<div class="is-now"><div class="is-now-text"><b>' + what + '</b> <span class="is-who">(' + esc(wantedBy(row).join(' + ')) + ')</span>' +
        (mealTag(row) ? '<div class="is-now-meal">' + mealTag(row) + '</div>' : '') +
        (packOf(row.item_id, cartStore(row) || row.store) ? '<div class="is-now-pack pack">' + (packOf(row.item_id, cartStore(row) || row.store).count ? '📦 ' : '') + 'Each one: ' + esc(packOf(row.item_id, cartStore(row) || row.store).text) + '</div>' : '') +
        (c && c.kind === 'failed' && c.note ? '<div class="note">' + esc(c.note) + '</div>' : '') + '</div>' +
        '<div class="stepper small" aria-label="How many"><button type="button" data-act="row-qty" data-d="-1" aria-label="Fewer">−</button><b>' + (byLb(row.item_id) ? esc(lbText(row.qty)) : (Number(row.qty) || 1)) +
        '</b><button type="button" data-act="row-qty" data-d="1" aria-label="More">+</button></div></div>';
      if (c && !kid) h += viewCartButtons(row, c, sh);
      h += row.note || sh.noteOpen
        ? '<input class="field" data-input="row-note" data-id="' + row.id + '" value="' + esc(row.note || '') + '" placeholder="Note: brand, size, flavor…">'
        : '';
    } else if (isDelivery(storeCode)) {
      h += '<div class="dlv-note">🧊 ' + esc(storeOf(storeCode).delivery) + ' Nothing to buy; say how much is left below.</div>';
    } else {
      h += '<button class="btn btn-primary btn-block" data-act="add-item" data-id="' + esc(sh.item_id) + '">' + (kid ? 'Ask for it' : 'Add to the List') + '</button>';
    }

    // ---- Quick: have some at home (one tap)
    if (canStock() && (row ? !held : canInfo())) {
      const lv = (v, label) => '<button type="button" class="' + (sh.level === v ? 'on' : '') + '" data-act="have-level" data-v="' + v + '">' + label + '</button>';
      h += '<div class="is-quick"><div class="is-label">' + (row ? 'Already have some?' : 'How much is at home?') + '</div><div class="seg">' +
        lv('plenty', 'Plenty') + lv('some', 'Some') + lv('low', 'A little') + lv('count', 'Count…') + '</div>' +
        (sh.level === 'count' ? '<div class="is-line"><div class="stepper small"><button type="button" data-act="have-count" data-d="-1" aria-label="Fewer">−</button><b>' + sh.count + '</b><button type="button" data-act="have-count" data-d="1" aria-label="More">+</button></div><button class="btn btn-outline" data-act="have-count-save">Save</button></div>' : '') +
        (row ? '<p class="note">Plenty or Some takes it off the List.</p>' : '') + '</div>';
    }

    // ---- Quick: the quiet row
    if (row) {
      const acts = [];
      if (held) acts.push('<button class="btn btn-plain" data-act="unhold" data-id="' + row.id + '">Need it now</button>');
      else if (canStock() && !sh.laterOpen) acts.push('<button class="btn btn-plain" data-act="row-later">Later…</button>');
      acts.push('<button class="btn btn-plain" data-act="row-bought">Bought it</button>');
      if (!row.note && !sh.noteOpen) acts.push('<button class="btn btn-plain" data-act="is-note">Note</button>');
      acts.push('<button class="btn btn-plain danger" data-act="row-remove">Take off</button>');
      h += '<div class="is-actions">' + acts.join('') + '</div>';
      if (sh.laterOpen && !held) {
        h += '<div class="is-quick"><div class="is-label">We need it, just not this order. Back on the List…</div><div class="seg">' +
          '<button type="button" data-act="row-hold" data-until="' + addDays(D().today, 7) + '">Next week</button>' +
          '<button type="button" data-act="row-hold" data-until="' + addDays(D().today, 14) + '">In 2 weeks</button>' +
          '<button type="button" data-act="row-hold" data-until="' + LATER_NO_DATE + '">No date</button></div></div>';
      }
    }

    // ---- More: folded sections
    const acc = (key, title, peek, body) => '<div class="is-acc' + (open[key] ? ' open' : '') + '"><button class="is-acc-head" data-act="is-fold" data-k="' + key + '" aria-expanded="' + !!open[key] + '">' +
      '<span class="is-acc-t"><b>' + title + '</b>' + (peek && !open[key] ? '<small>' + peek + '</small>' : '') + '</span>' + chev(!open[key]) + '</button>' +
      (open[key] ? '<div class="is-acc-body">' + body() + '</div>' : '') + '</div>';
    let more = '';

    // What we buy: one row per store with the product, its aisle and its price per unit (cheapest in green).
    const prods = (D().products || {})[sh.item_id] || {};
    const pk = CART_STORES.filter((k) => prods[k]).concat(Object.keys(prods).filter((k) => CART_STORES.indexOf(k) < 0));
    if (pk.length) {
      const showPrice = Number(D().api || 0) >= 23;
      const priced = showPrice ? pk.map((k) => Object.assign({ store: k }, prods[k])).filter(hasPrice) : [];
      const unit = priced.length ? (itemPrices(sh.item_id)[0] || priced[0]).unit : '';
      const cmp = priced.filter((p) => p.unit === unit && freshPrice(p) && likeItem(p));
      const low = cmp.length > 1 ? cmp.slice().sort((a, b) => Number(a.unit_price) - Number(b.unit_price))[0] : null;
      const peek = low ? 'Cheapest at ' + esc(storeOf(low.store).name) + ' · ' + esc(fmtUnit(low))
        : pk.length > 1 ? esc(pk.map((k) => storeOf(k).name).join(', '))
        : esc(storeOf(pk[0]).name + ': ' + prods[pk[0]].name);
      more += acc('buy', 'What we buy', peek, () => {
        let b = pk.map((k) => {
          const p = Object.assign({ store: k }, prods[k]);
          const pr = hasPrice(p) && p.unit === unit && showPrice;
          const stale = pr && (!freshPrice(p) || !likeItem(p));
          return '<div class="buy-row' + (low && low.store === k ? ' best' : '') + '"><span class="store-dot ' + storeOf(k).cls + '"></span>' +
            '<div class="buy-main"><div><b>' + esc(storeOf(k).name) + '</b>' + (p.aisle ? ' <span class="aisle-tag">' + esc(p.aisle) + '</span>' : '') + '</div>' +
            '<small>' + esc(p.name) + (sizeIfNew(p.name, p.size) ? ' · ' + esc(p.size) : '') + (packCount(p.pack) || packCount(p.name) || packCount(p.size) ? ' · 📦 ' + (packCount(p.pack) || packCount(p.name) || packCount(p.size)) + ' ct' : '') + '</small>' +
            (p.backup && p.backup.name ? '<small class="sub-line">↪ If it’s out: ' + esc(p.backup.name) + '</small>' : '') + '</div>' +
            '<span class="price-val' + (stale ? ' stale' : '') + '">' + (Number(p.price) > 0 && showPrice ? '<b>' + money(p.price) + '</b>' : '') + (pr ? '<small>' + fmtUnit(p) + (likeItem(p) ? '' : '*') + '</small>' : '') + '</span></div>';
        }).join('');
        pk.forEach((k) => {
          const x = prods[k].sb && Object.assign({ store: k }, prods[k].sb);
          const ours = prods[k];
          if (!x || !freshPrice(x) || !hasPrice(ours) || ours.unit !== x.unit) return;
          const pct = (Number(ours.unit_price) - Number(x.unit_price)) / Number(ours.unit_price);
          if (pct >= PRICE_MIN_PCT) b += '<p class="price-note">💡 ' + esc(storeOf(k).name) + ' store brand: ' + esc(x.name) + ', ' + fmtUnit(x) + ' (' + Math.round(pct * 100) + '% less)</p>';
        });
        if (priced.length) {
          const dates = priced.map((p) => p.price_at).filter(Boolean).sort();
          b += '<p class="price-note">Prices from ' + (dates.length ? esc(fmtShort(dates[0])) + (dates[0] !== dates[dates.length - 1] ? '–' + esc(fmtShort(dates[dates.length - 1])) : '') : 'an unknown day') +
            (priced.some((p) => !freshPrice(p) || !likeItem(p)) ? '. Grey = old price' + (priced.some((p) => !likeItem(p)) ? '; * = a different product there' : '') + ', not compared' : '') + '.</p>';
        }
        return b;
      });
    }

    // Options at the store (api 51, Nov 4, owner: "a better way of understanding what options we have at these
    // stores"): every product Poppy has seen for this item, per store, from the cart runner's lookups, receipts and
    // carts. ✓ = what we buy there; a parent's Use this makes another one what the next cart build adds.
    const ip = canOptions() && sh.info && Array.isArray(sh.info.products) ? sh.info.products : [];
    const optStores = CART_STORES.filter((k) => ip.filter((p) => p.store === k).length > 1 || ip.some((p) => p.store === k && p.match === 'option'));
    if (optStores.length) {
      const nAt = optStores.map((k) => ip.filter((p) => p.store === k).length + ' at ' + storeOf(k).name).join(' · ');
      more += acc('opts', 'Options at the store', esc(nAt), () => optStores.map((k) => {
        const rows = ip.map((p, i) => Object.assign({ i: i }, p)).filter((p) => p.store === k)
          .sort((a, b) => (b.current - a.current) || ((Number(a.unit_price) || 1e9) - (Number(b.unit_price) || 1e9))).slice(0, 6);
        return '<div class="opt-store"><span class="store-dot ' + storeOf(k).cls + '"></span><b>' + esc(storeOf(k).name) + '</b></div>' + rows.map((p) => {
          const n = packCount(p.pack) || packCount(p.name) || packCount(p.size);
          return '<div class="buy-row opt-row' + (p.current ? ' best' : '') + '"><div class="buy-main"><div>' + esc(p.name) + '</div><small>' +
            [sizeIfNew(p.name, p.size), n ? '📦 ' + n + ' ct' : '', p.current ? '✓ What we buy' : p.match === 'option' ? 'Seen ' + esc(fmtShort(p.price_at) || 'lately') : p.match === 'alt' ? 'Bought before / backup' : ''].filter(Boolean).map(esc).join(' · ') + '</small></div>' +
            '<span class="price-val">' + (Number(p.price) > 0 ? '<b>' + money(p.price) + '</b>' : '') + (hasPrice(p) ? '<small>' + fmtUnit(p) + '</small>' : '') +
            (!p.current && amParent() ? '<button class="btn btn-outline btn-small" data-act="opt-use" data-i="' + p.i + '">Use this</button>' : '') + '</span></div>';
        }).join('');
      }).join('') + '<p class="note">Claude looks these up at the store for new items. Use this = the next cart build adds that one.</p>');
    }

    if (it) {
      const facts = [];
      if (Number(it.orders)) facts.push('Bought in ' + it.orders + ' order' + (Number(it.orders) > 1 ? 's' : ''));
      if (it.last_bought) facts.push('last ' + esc(daysAgo(it.last_bought)));
      if (it.avg_days) facts.push('about every ' + it.avg_days + ' days');
      if (!facts.length) {
        // No receipts yet (e.g. items from store order history): use the newest store last-bought date we have.
        const lb = Object.keys(prods).map((k) => ({ k, d: String(prods[k].last_bought || '') })).filter((x) => x.d).sort((a, b) => (a.d < b.d ? 1 : -1))[0];
        if (lb) facts.push('Last bought ' + esc(fmtShort(lb.d)) + ' at ' + esc(storeOf(lb.k).name) + ' (store history)');
      }
      const info = sh.info;
      more += acc('hist', 'History', facts.length ? facts.join(' · ') : 'No purchases on record yet', () => {
        let hist = facts.length ? '<p class="is-fact">' + facts.join(' · ') + '</p>' : '<p class="note">No purchases on record yet.</p>';
        if (info && info.purchases && info.purchases.length) {
          hist += '<ul class="is-list">' + info.purchases.map((p) => '<li><span>' + esc(fmtShort(p.date)) + '</span><span>' + esc(storeOf(p.store).name) + '</span><span>' + esc(money(p.price)) + (Number(p.qty) > 1 ? ' ×' + p.qty : '') + '</span></li>').join('') + '</ul>';
        }
        const sightings = (info && info.stock) || ((D().stock || {})[it.id] ? [D().stock[it.id]] : []);
        if (sightings.length) hist += '<p class="is-fact">At home: ' + sightings.slice(0, 3).map((s) => esc(levelText(s.level)) + ' (' + esc(s.who || '?') + ', ' + esc(fmtShort(s.at)) + ')').join(' · ') + '</p>';
        if (canInfo() && !info) hist += '<p class="note">Loading history…</p>';
        return hist || '<p class="note">Nothing more yet.</p>';
      });

      const notes = [];
      if (it.notes) notes.push({ html: esc(it.notes), text: it.notes });
      ((info && info.answers) || []).forEach((a) => notes.push({ html: '<span class="q">' + esc(a.q) + '</span> <b>' + esc(a.answer) + '</b>', text: a.answer }));
      if (notes.length) {
        const first = String(notes[0].text);
        more += acc('know', 'What we know', esc(first.length > 48 ? first.slice(0, 46) + '…' : first) + (notes.length > 1 ? ' · +' + (notes.length - 1) + ' more' : ''),
          () => '<ul class="is-notes">' + notes.map((n) => '<li>' + n.html + '</li>').join('') + '</ul>');
      }
    }

    // Details (store, swaps, how often): parents edit, kids read.
    if (it && sh.d) {
      const swap = canV46() ? ({ Y: 'store may substitute', N: 'don’t substitute' }[sh.d.ok_swap] || 'ask about substitutes') : ({ Y: 'swap OK', N: 'no swaps' }[sh.d.ok_swap] || 'ask before swapping');
      const keep = { Always: 'always keep it', Sometimes: 'now and then', Drop: 'stopped buying' }[sh.d.status] || '';
      more += acc('details', 'Details', esc([keep, swap, sh.d.pantry === 'Y' ? (canStaples() ? 'staple' : 'pantry staple') : '', sh.d.open_to_try === 'Y' ? 'open to something else' : ''].filter(String).join(' · ')) + (kid ? '' : ' · edit'), () => {
        const seg = (field, opts) => '<div class="seg' + (opts.length > 4 ? ' seg-grid' : '') + '">' + opts.map((o) => '<button type="button" data-act="d-seg" data-field="' + field + '" data-v="' + esc(o[0]) + '" class="' + (String(sh.d[field]) === String(o[0]) ? 'on' : '') + '"' + (kid ? ' disabled' : '') + '>' + esc(o[1]) + '</button>').join('') + '</div>';
        return '<div class="is-details">' + (sh.fresh && !kid ? '<p class="note fresh-note">✨ New to Poppy. Fill in the brand and size, the aisle, where we get it and how it’s sold, so search, Siri and the carts get it right.</p>' : '') +
          '<div><label>Store we use</label>' + seg('store', [['GE', 'Giant Eagle'], ['WF', 'Whole Foods'], ['TGT', 'Target'], ['AMZ', 'Amazon'], ['Either', 'Either']].concat(DELIVERY_OPTS)) + '</div>' +
          (canV9() ? '<div><label>Can other stores get it?</label>' + seg('store_only', [['', 'Yes, any store'], ['Y', 'Only this store']]) + '</div>' : '') +
          (canFridge() ? '<div><label>Goes in the mini fridge?</label>' + seg('mini_fridge', [['', 'No'], ['Y', '🥤 Yes']]) + '</div>' : '') +
          (canPantry() ? (canStaples()
            ? '<div><label>Staple?</label>' + seg('pantry', [['', 'No'], ['Y', '🧺 Never run out']]) + '<p class="note">Yes = Missing for meals assumes we have it, and the girls check it every week (things we buy rarely, every 3 weeks) and before orders.</p></div>'
            : '<div><label>Pantry staple?</label>' + seg('pantry', [['', 'No'], ['Y', '🫙 We always have it']]) + '<p class="note">Yes = Missing for meals assumes we have it, unless someone marks it low or out.</p></div>') : '') +
          (canV46() ? '<div><label>If the store is out of it</label>' + seg('ok_swap', [['Y', 'Let the store pick'], ['N', 'Don’t substitute'], ['', 'Ask me']]) + '<p class="note">Claude sets this on each line of the online cart. A backup we picked (shown under What we buy) comes first. Ask me = the store’s default, and you get a ⚖ Decisions card if it swaps something.</p></div>'
            : '<div><label>OK to swap if it’s out?</label>' + seg('ok_swap', [['Y', 'Yes'], ['N', 'No, skip it'], ['', 'Ask me']]) + '</div>') +
          (canBest() ? '<div><label>Shop for the best price?</label>' + seg('best_price', [['', 'No, our usual store'], ['Y', 'Yes, any store']]) + '<p class="note">Yes = Claude checks this product’s price at all four stores. When it’s on the List and another store is cheaper, you get a ⚖ Decisions card with every price, and pick the cart.</p></div>' : '') +
          (canTry() ? '<div><label>Open to trying something else?</label>' + seg('open_to_try', [['', 'No, we like it'], ['Y', 'Yes, suggest some']]) + '<p class="note">Yes = Claude looks for other brands and store brands at our stores and asks you in the Inbox (⚖ Decisions). Nothing changes until you say so.</p></div>' : '') +
          // "How often" alone didn't say what it asked (owner, Nov 4). Same values: Always / Sometimes / Drop.
          '<div><label>Do we keep buying it?</label>' + seg('status', [['Always', 'Always keep it'], ['Sometimes', 'Now and then'], ['Drop', 'Stop buying']]) + '<p class="note">Always = a staple we try never to run out of. Now and then = we buy it when we want it. Stop buying = Poppy stops suggesting it.</p></div>' +
          (canV45() ? '<div><label>How it’s sold</label>' + seg('sold_by', [['', 'Each / package'], ['lb', 'By the pound']]) + '<p class="note">By the pound = the List and carts count pounds (½ lb steps). Put the cut and thickness in the trip note, e.g. “ribeye, 1½ in thick, 2 steaks”.</p></div>' +
            '<div><label for="d-spoken">Words we say</label><input id="d-spoken" class="field" style="width:100%" data-input="d" data-field="spoken" value="' + esc(sh.d.spoken || '') + '" placeholder="e.g. milk, fairlife"' + (kid ? ' disabled' : '') + '><p class="note">What the family calls it, comma-separated. Shop search and Siri find it by these.</p></div>' : '') +
          '<div><label for="d-brand">Brand / size</label><input id="d-brand" class="field" style="width:100%" data-input="d" data-field="brand_size" value="' + esc(sh.d.brand_size) + '"' + (kid ? ' disabled' : '') + '></div>' +
          '<div><label for="d-aisle">Aisle / description</label><select id="d-aisle" class="select" style="width:100%" data-input="d" data-field="group"' + (kid ? ' disabled' : '') + '>' + GROUPS.map((g) => '<option' + (g === sh.d.group ? ' selected' : '') + '>' + esc(g) + '</option>').join('') + '</select></div>' +
          (canUseSoon() ? '<div><label for="d-shelf">Stays good about (days)</label><input id="d-shelf" class="field" style="width:100%" inputmode="numeric" data-input="d" data-field="shelf_days" value="' + esc(sh.d.shelf_days) + '" placeholder="Blank = doesn’t go bad fast"' + (kid ? ' disabled' : '') + '></div>' : '') +
          '<div><label for="d-notes">Notes</label><input id="d-notes" class="field" style="width:100%" data-input="d" data-field="notes" value="' + esc(sh.d.notes) + '" placeholder="e.g. Gia only eats strawberry"' + (kid ? ' disabled' : '') + '></div>' +
          (kid ? '<p class="note">A parent can change these.</p>' : '<button class="btn btn-primary btn-block" data-act="save-details">Save details</button>') + '</div>';
      });
    }
    if (more) h += '<div class="is-more">' + more + '</div>';
    return h;
  }

  // Item screen header (Nov 4, owner: "there's no price"): the exact product we buy and its shelf price, up top.
  // Product = the usual store's Products row (else the first one we know); falls back to Items brand_size.
  // Price only from a like item (not an `alt` row); the date shows how old it is.
  function viewItemProduct(itemId, storeCode, it) {
    const prods = (D().products || {})[itemId] || {};
    const k = prods[storeCode] ? storeCode : CART_STORES.find((x) => prods[x]) || Object.keys(prods)[0];
    const p = k && prods[k];
    const name = (p && p.name) || (it && it.brand_size) || '';
    const priced = p && likeItem(p) && Number(p.price) > 0;
    if (!name && !priced) return '';
    const bits = [];
    if (priced && hasPrice(p)) bits.push(fmtUnit(p));
    if (priced && k !== storeCode) bits.push('at ' + storeOf(k).name);
    if (priced && p.price_at) bits.push(fmtShort(p.price_at));
    let all = '';
    if (canBest() && isBest(it)) {
      // Best-price items: every store's price for the same product, cheapest first (green), same unit only.
      const rows = itemPrices(itemId).filter((x) => !priced || !hasPrice(p) || x.unit === p.unit);
      all = rows.length > 1
        ? '<div class="is-best">' + rows.map((x, i) => '<span class="' + (i === 0 ? 'best' : '') + '"><span class="store-dot ' + storeOf(x.store).cls + '"></span>' + esc(storeOf(x.store).name) + ' <b>' + money(x.price) + '</b>' + (x.sale === 'Y' ? ' sale' : '') + '</span>').join('') + '</div>'
        : '<p class="note">💲 Best price: Claude checks the other stores on the next price pass.</p>';
    }
    return '<div class="is-prod">' + (name ? '<span class="is-prod-name">' + esc(name) + '</span>' : '') +
      (priced ? '<span class="is-prod-price"><b>' + money(p.price) + '</b>' + (bits.length ? ' <small>' + esc(bits.join(' · ')) + '</small>' : '') + '</span>' : '') + all + '</div>';
  }
  // Drop a size that the product name already ends with ("…, 12 oz" + "12 oz").
  const sizeIfNew = (name, size) => (size && String(name || '').toLowerCase().replace(/\s+/g, ' ').indexOf(String(size).toLowerCase().replace(/\s+/g, ' ')) < 0 ? size : '');

  // The item screen's cart buttons (api 25), parents only. The status line above already says where it stands.
  // Moving to another store sits behind one "Move…" / "Other store…" tap.
  function viewCartButtons(row, c, sh) {
    const full = (code) => esc(storeOf(code).name);
    const chips = (skip, act) => '<div class="cart-move">' + CART_STORES.filter((k) => k !== skip).map((k) =>
      '<button class="pill small ' + storeOf(k).cls + '" data-act="' + act + '" data-store="' + k + '">' + esc(sName(k)) + '</button>').join('') + '</div>';
    let b = '';
    if (c.kind === 'in') {
      b = '<div class="is-cart"><button class="btn btn-outline" data-act="cart-remove">Take it out of the cart</button><button class="btn btn-plain" data-act="is-move">' + (sh.move ? 'Cancel' : 'Move…') + '</button></div>' +
        (sh.move ? chips(c.store, 'cart-put') : '');
    } else if (c.kind === 'going') {
      b = '<div class="is-cart"><button class="btn btn-plain" data-act="cart-remove">Don’t add it</button></div>';
    } else if (c.kind === 'moving') {
      b = '<div class="is-cart"><button class="btn btn-plain" data-act="cart-put" data-store="' + c.from + '">Keep it in ' + esc(sName(c.from)) + '</button></div>';
    } else if (c.kind === 'leaving') {
      b = '<div class="is-cart"><button class="btn btn-plain" data-act="cart-put" data-store="' + c.store + '">Keep it in</button></div>';
    } else {
      const p = pickCart(row);
      const pick = sh.cartPick || p.store;
      b = '<div class="is-cart"><button class="btn btn-primary" data-act="cart-put" data-store="' + pick + '">🛒 Put in the ' + full(pick) + ' cart</button><button class="btn btn-plain" data-act="is-move">' + (sh.move ? 'Cancel' : 'Other store…') + '</button></div>' +
        (sh.move ? chips(pick, 'cart-pick') + (pick === p.store ? '<p class="note">Poppy’s pick: ' + esc(p.why) + (p.guess ? '. No exact product there yet, so Claude searches for it.' : '.') + '</p>' : '') : '');
    }
    return b;
  }

  /* ---------- header cart button (Nov 2) ---------- */
  // One cart with a colored count in each corner: GE top-left, Whole Foods top-right, Target bottom-left,
  // Amazon bottom-right. A count = lines in that cart plus lines on their way in. A soft pulse while Claude has work.
  function cartCounts() {
    const n = { GE: 0, WF: 0, TGT: 0, AMZ: 0 };
    D().list.forEach((r) => {
      const c = cartState(r);
      if ((c.kind === 'in' || c.kind === 'going' || c.kind === 'moving') && n[c.store] !== undefined) n[c.store]++;
    });
    return n;
  }
  function cartButton() {
    const n = cartCounts();
    const busy = jobs().some((j) => JOB_OPEN.indexOf(j.status) >= 0);
    const total = CART_STORES.reduce((t, k) => t + n[k], 0);
    const corner = (k, pos) => '<span class="cc ' + pos + ' ' + storeOf(k).cls + (n[k] ? '' : ' zero') + '">' + n[k] + '</span>';
    const label = 'Online carts: ' + CART_STORES.filter((k) => n[k]).map((k) => n[k] + ' ' + storeOf(k).name).join(', ') + (busy ? '. Claude has changes waiting.' : '');
    return '<button class="cart-btn' + (S.tab === 'carts' ? ' on' : '') + (busy ? ' busy' : '') + '" data-act="tab" data-tab="' + (S.tab === 'carts' ? 'list' : 'carts') + '" aria-label="' + esc(total ? label : 'Online carts: empty') + '">' +
      '<span class="cart-ico" aria-hidden="true">🛒</span>' + corner('GE', 'tl') + corner('WF', 'tr') + corner('TGT', 'bl') + corner('AMZ', 'br') + '</button>';
  }
  function viewMeSheet() {
    return '<div class="is-head"><div><h2>' + esc(S.me) + '</h2><div class="is-sub">' + (isKid(S.me) ? 'Kid profile' : 'Parent') + '</div></div><button class="x-btn" data-act="close-x" aria-label="Close">✕</button></div>' +
      '<div class="me-menu">' +
      (canV9() ? '<button class="me-item" data-act="open-feedback"><span>💡</span><span><b>Idea for Poppy</b><small>Something confusing, missing, or a great idea</small></span></button>' : '') +
      (canIdeas() ? '<button class="me-item" data-act="new-idea"><span>🍽</span><span><b>Meal idea</b><small>A recipe, a link, or just a dinner you’d like</small></span></button>' : '') +
      '<button class="me-item" data-act="switch-me"><span>🔄</span><span><b>Switch person</b><small>Not ' + esc(S.me) + '? Pick who’s using the phone</small></span></button>' +
      '</div>';
  }

  /* ---------- carts (api 25) ---------- */
  // Rows tied to one store's cart: in it, on the way in, on the way out.
  function cartRows(code) {
    const out = { in: [], going: [], leaving: [], failed: [] };
    D().list.forEach((r) => {
      const c = cartState(r);
      if (c.kind === 'in' && c.store === code) out.in.push(r);
      if (c.kind === 'going' && c.store === code) out.going.push(r);
      if (c.kind === 'moving' && c.store === code) out.going.push(r);
      if (c.kind === 'moving' && c.from === code) out.leaving.push(r);
      if (c.kind === 'leaving' && c.store === code) out.leaving.push(r);
      if (c.kind === 'failed' && c.store === code) out.failed.push(r);
    });
    return out;
  }
  const lastDone = (code) => jobs().find((j) => j.store === code && j.status === 'done');
  const jstamp = (v) => String(v || '').replace(' ', 'T').replace(/T(\d):/, 'T0$1:');
  // A queued re-read (check) that's older than the store's newest finished update is already covered by it (Nov 4:
  // a 9:48 check sat "waiting" after a 10:05 build had re-read the cart). It isn't shown as waiting.
  const coveredCheck = (j) => j.kind === 'check' && j.status === 'queued' && jobs().some((d) => d.store === j.store && d.status === 'done' && jstamp(d.finished_at) > jstamp(j.at));
  const openJobs = (code) => jobs().filter((j) => j.store === code && JOB_OPEN.indexOf(j.status) >= 0 && !coveredCheck(j));
  // Cart totals (api 26): the store's own cart subtotal and line count from the latest finished job.
  const lastTotal = (code) => jobs().find((j) => j.store === code && j.status === 'done' && j.subtotal !== '' && j.subtotal != null);
  const fmtMoney = (v) => '$' + Number(v).toFixed(2);
  // Where one cart stands, in plain words: { icon, cls, text }.
  // Is the cart helper on the home computer ready? The watcher checks in every minute while the computer is on
  // (Settings watcher_seen, api 48, with whether Chrome is open); runner_seen is when Claude last ran a job there.
  function helperState() {
    const st = D().settings || {};
    const w = String(st.watcher_seen || ''), r = String(st.runner_seen || '');
    const lastJob = (D().cartJobs || []).map((j) => jstamp(j.finished_at || j.started_at)).filter(String).sort().pop() || '';
    const seen = [w, r, lastJob].filter(String).sort().pop() || '';
    if ((D().cartJobs || []).some((j) => j.status === 'running')) return { ok: true, seen: seen, text: 'Cart helper is working on the home computer now.' };
    if (!seen) return { ok: false, never: true, text: 'The cart helper on the home computer hasn’t checked in yet.' };
    const mins = (Date.now() - new Date(seen.replace(' ', 'T')).getTime()) / 60000;
    if (w && mins < 5 && String(st.watcher_chrome) === '0') return { ok: false, chrome: true, seen: seen, text: 'Home computer is on, but Chrome is closed. Open Chrome there and cart changes start within a minute.' };
    if (w && mins < 5) return { ok: true, seen: seen, text: 'Cart helper is ready on the home computer. Changes start within a minute.' };
    if (seen === lastJob && mins < 10) return { ok: true, seen: seen, text: 'Cart helper just finished an update on the home computer.' };
    return { ok: false, seen: seen, text: 'Cart helper last checked in ' + fmtWhen(seen) + '. The home computer may be asleep or off; changes wait until it’s back.' };
  }
  function cartStatus(code) {
    const r = cartRows(code);
    const open = openJobs(code);
    const running = open.find((j) => j.status === 'running');
    const waiting = open.find((j) => j.status === 'waiting');
    const last = jobs().find((j) => j.store === code && (j.status === 'done' || j.status === 'failed'));
    const todo = [];
    if (r.going.length) todo.push(r.going.length + ' to add');
    if (r.leaving.length) todo.push(r.leaving.length + ' to take out');
    if (open.some((j) => j.kind === 'check') && !todo.length) todo.push('a fresh look at the cart');
    if (running) return { cls: 'run', text: '🔄 Claude is updating this cart right now.' };
    if (open.length) {
      const hs = helperState();
      return { cls: 'wait', text: '⏳ Waiting on Claude: ' + (todo.join(', ') || 'an update') + '. ' + (hs.ok ? 'Starting within a minute.' : hs.never ? 'It starts when the home computer is on with Chrome open.' : hs.chrome ? 'Waiting for Chrome on the home computer.' : 'The home computer is asleep or off (last seen ' + fmtWhen(hs.seen) + '), so this waits until it’s back.') };
    }
    if (r.going.length || r.leaving.length) return { cls: 'wait', text: '⏳ ' + todo.join(', ') + ' not sent yet.' };
    if (last && last.status === 'failed') return { cls: 'fail', text: '⚠ The last update didn’t work: ' + (last.result || 'no reason given') + '.' };
    // Nov 6 (Mike: "it says tap to see why but nothing happens"): this line is now a button that jumps to the
    // ⚠ COULDN'T ADD list (now right under this card), and one item is named with its reason.
    if (r.failed.length === 1) { const f = cartState(r.failed[0]); return { cls: 'fail', jump: true, text: '⚠ ' + r.failed[0].name + ' couldn’t be added' + (f.note ? ' (' + f.note + ')' : '') + '. Tap to see it.' }; }
    if (r.failed.length) return { cls: 'fail', jump: true, text: '⚠ ' + r.failed.length + ' couldn’t be added. Tap to see why.' };
    return { cls: 'ok', text: '✓ Up to date' };
  }
  function totalLine(code) {
    const t = lastTotal(code);
    if (!t) return { money: '—', sub: 'Total not read yet' };
    return { money: fmtMoney(t.subtotal), sub: (Number(t.lines) || 0) + ' item' + (Number(t.lines) === 1 ? '' : 's') + ' · as of ' + fmtWhen(t.finished_at || t.at) };
  }
  // One store at a glance (Nov 4, owner: "super simplify our world with our four shopping carts"):
  // a dot (ok / wait / fail) and, only when something needs you, one short line.
  function cardState(code) {
    const r = cartRows(code);
    const open = openJobs(code);
    const si = Number(D().api || 0) >= 42 ? signinState() : { out: [] };
    const last = jobs().find((j) => j.store === code && (j.status === 'done' || j.status === 'failed'));
    if (open.some((j) => j.status === 'running')) return { cls: 'run', text: '🔄 Updating now' };
    if (si.out.indexOf(code) >= 0 && !open.length) return { cls: 'fail', text: 'Signed out on the laptop' };
    const todo = [];
    if (r.going.length) todo.push(r.going.length + ' to add');
    if (r.leaving.length) todo.push(r.leaving.length + ' to take out');
    if (open.length) return { cls: 'wait', text: '⏳ ' + (todo.join(', ') || (open.every((j) => j.kind === 'check') ? 'Waiting to re-read' : 'Waiting to update')) };
    if (todo.length) return { cls: 'wait', text: '⏳ ' + todo.join(', ') + ' (not sent yet)' };
    if (last && last.status === 'failed') return { cls: 'fail', text: last.result || 'Last update didn’t work' };
    if (r.failed.length) return { cls: 'fail', text: r.failed.length + ' couldn’t be added' };
    return { cls: 'ok', text: '' };
  }
  // The one sentence at the top: the most important thing about all four carts right now.
  function cartsSummary(states) {
    const hs = helperState();
    const busy = CART_STORES.filter((k) => states[k].cls === 'run' || states[k].cls === 'wait');
    const running = CART_STORES.some((k) => states[k].cls === 'run') || signinJobs().some((j) => j.status === 'running');
    const fail = CART_STORES.filter((k) => states[k].cls === 'fail');
    const big = (D().cartJobs || []).find((j) => j.kind === 'all' && JOB_OPEN.indexOf(j.status) >= 0);
    const asleep = !hs.ok && !hs.never;
    const nap = hs.chrome ? 'Chrome is closed on the laptop · updates run when it’s open' : 'Laptop asleep · updates run when it’s on';
    if (big && big.status === 'running') return { cls: 'run', text: 'Laptop is working: carts, then order history and prices' };
    if ((big || busy.length) && !running && asleep) return { cls: 'off', text: nap };
    if (big) return { cls: 'run', text: 'Starting on the laptop…' };
    if (busy.length) return { cls: 'run', text: 'Updating carts · ' + (CART_STORES.length - busy.length) + ' of ' + CART_STORES.length + ' done' };
    if (fail.length === 1) return { cls: 'fail', text: storeOf(fail[0]).name + ': ' + states[fail[0]].text.charAt(0).toLowerCase() + states[fail[0]].text.slice(1) };
    if (fail.length) return { cls: 'fail', text: fail.map((k) => storeOf(k).name).join(', ') + ' need a look' };
    return { cls: 'ok', text: 'All carts up to date' };
  }
  function viewCarts() {
    if (S.cartOpen) return viewCartDetail(S.cartOpen);
    const known = CART_STORES.filter((k) => lastTotal(k));
    const sum = known.reduce((t, k) => t + Number(lastTotal(k).subtotal), 0);
    const items = known.reduce((t, k) => t + (Number(lastTotal(k).lines) || 0), 0);
    const states = {};
    CART_STORES.forEach((k) => (states[k] = cardState(k)));
    const sum1 = cartsSummary(states);
    const checking = signinJobs().some((j) => JOB_OPEN.indexOf(j.status) >= 0);
    let html = '<section class="card carts-total"><div class="ct-label">All carts</div><div class="ct-money">' + (known.length ? fmtMoney(sum) : '—') + '</div>' +
      '<div class="cart-sub">' + items + ' item' + (items === 1 ? '' : 's') + '</div>' +
      '<div class="carts-summary cs-' + sum1.cls + '"><span class="cdot cd-' + ({ off: 'wait', run: 'wait' }[sum1.cls] || sum1.cls) + '" aria-hidden="true"></span>' + esc(sum1.text) + '</div>' +
      (amParent() && Number(D().api || 0) >= 50 ? '<button class="btn btn-primary btn-block" data-act="cart-job" data-kind="all" data-store="ALL">Update carts</button>' : '') +
      '</section>';
    CART_STORES.forEach((code) => {
      const st = storeOf(code);
      const t = lastTotal(code);
      const c = states[code];
      html += '<button class="card cart-card" data-act="cart-open" data-store="' + code + '">' +
        '<div class="cart-card-top"><b class="head-' + st.cls + '"><span class="cdot cd-' + c.cls + '" aria-hidden="true"></span>' + esc(st.name) + '</b><span class="cart-money">' + (t ? fmtMoney(t.subtotal) : '—') + ' <span class="chev" aria-hidden="true">›</span></span></div>' +
        '<div class="cart-sub">' + (t ? (Number(t.lines) || 0) + ' item' + (Number(t.lines) === 1 ? '' : 's') + ' · ' + esc(fmtWhen(t.finished_at || t.at)) : 'Not read yet') + '</div>' +
        (c.text ? '<div class="cart-status st-' + c.cls + '">' + esc(c.text) + '</div>' : '') + '</button>';
    });
    html += '<p class="hint carts-foot">Claude fills the carts on the laptop. A person always places the order.</p>';
    return html;
  }
  function viewCartDetail(code) {
    const st = storeOf(code);
    const r = cartRows(code);
    const kid = isKid(S.me);
    const ready = D().list.filter((x) => needsCart(x) && pickCart(x).store === code);
    const busyCheck = openJobs(code).some((j) => j.kind === 'check');
    let html = '<button class="back-bar" data-act="cart-back" aria-label="Back to all carts"><span class="bb-chev" aria-hidden="true">‹</span> All carts</button>';
    const t = totalLine(code);
    const s2 = cartStatus(code);
    const done = lastDone(code);
    html += '<section class="card store-card"><div class="cart-card-top"><b class="head-' + st.cls + '">' + esc(st.name) + '</b><span class="cart-money">' + t.money + '</span></div>' +
      '<div class="cart-sub">' + esc(t.sub) + '</div>' + (s2.jump ? '<button class="cart-status st-' + s2.cls + ' cart-jump" data-act="cart-jump">' + esc(s2.text) + '</button>' : '<div class="cart-status st-' + s2.cls + '">' + esc(s2.text) + '</div>') +
      (done && done.result ? '<div class="cart-sub">Last update ' + esc(fmtWhen(done.finished_at || done.at)) + ': ' + esc(done.result) + '</div>' : '');
    if (!kid) {
      html += cheaperNote(code);
      html += '<div class="job-btns">' + (ready.length ? '<button class="btn btn-primary" data-act="push-store" data-store="' + code + '">Put ' + ready.length + ' from the List in…</button>' : '') +
        '</div>';
    }
    html += '</section>';
    const sect = (label, rows, empty, id) => rows.length ? '<section class="card"' + (id ? ' id="' + id + '"' : '') + '><div class="card-head">' + label + ' · ' + rows.length + '</div>' +
      rows.slice().sort((a, b) => groupOf(a).localeCompare(groupOf(b)) || String(a.name).localeCompare(String(b.name))).map((x) => listRow(x, code)).join('') + '</section>' : (empty || '');
    html += sect('⚠ COULDN’T ADD', r.failed, '', 'cart-failed');
    html += sect('⏳ GOING IN', r.going);
    html += sect('🛒 IN THE CART', r.in, '<div class="empty">Nothing in the ' + esc(st.name) + ' cart that Poppy knows about.' + (kid ? '' : ' Check the cart reads what’s really there.') + '</div>');
    html += sect('⏳ COMING OUT', r.leaving);
    const lined = r.in.concat(r.going);
    const unpriced = lined.filter((x) => !linePrice(x, code)).length;
    if (lined.length) html += '<p class="hint">Item prices are ' + esc(st.name) + '’s latest price for what we buy, times the quantity; the total at the top is the cart’s own.' + (unpriced ? ' ' + unpriced + ' without a price yet (—) get one on the next update.' : '') + '</p>';
    html += '<p class="hint">Tap an item to take it out, move it to another store’s cart, or see why it wasn’t added. Things someone put in on the store’s own site show up after a check.</p>';
    return html;
  }
  // Put-in-carts sheet: Poppy's pick per row, changeable, nothing happens until the button.
  function openPushSheet(rows) {
    const picks = {};
    rows.forEach((r) => (picks[r.id] = pickCart(r).store));
    S.sheet = { type: 'pushall', ids: rows.map((r) => r.id), picks: picks };
    render();
  }
  function viewPushSheet(sh) {
    const rows = sh.ids.map((id) => D().list.find((r) => r.id === id)).filter((r) => r && needsCart(r));
    const chosen = rows.filter((r) => sh.picks[r.id]);
    let h = '<div class="is-head"><div><h2>Put ' + chosen.length + ' in carts</h2><div class="is-sub">Poppy picked each store. Change any before you tap.</div></div><button class="x-btn" data-act="close-x" aria-label="Close">✕</button></div>';
    CART_STORES.concat(['']).forEach((code) => {
      const g = rows.filter((r) => (sh.picks[r.id] || '') === code);
      if (!g.length) return;
      h += '<div class="push-group"><div class="card-head ' + (code ? 'head-' + storeOf(code).cls : '') + '">' + (code ? esc(storeOf(code).name.toUpperCase()) : 'NOT NOW · GOES TO LATER') + ' · ' + g.length + '</div>' +
        g.map((r) => {
          const p = pickCart(r);
          const note = code && code === p.store ? (p.guess ? 'best guess' : '') : code ? 'you picked' : '';
          return '<div class="push-row"><span class="row-name">' + esc(r.name) + (note ? ' <span class="note">' + note + '</span>' : '') + '</span>' +
            '<select class="select push-sel" data-input="push-pick" data-id="' + r.id + '" aria-label="Cart for ' + esc(r.name) + '">' +
            CART_STORES.map((k) => '<option value="' + k + '"' + (k === code ? ' selected' : '') + '>' + esc(sName(k)) + '</option>').join('') +
            '<option value=""' + (code ? '' : ' selected') + '>Not now (Later)</option></select></div>';
        }).join('') + '</div>';
    });
    h += '<div class="sheet-actions"><button class="btn btn-primary" data-act="push-go"' + (rows.length ? '' : ' disabled') + '>' + (chosen.length ? 'Put them in' : 'Move to Later') + '</button></div>' +
      '<p class="note">Claude adds them on the cart computer (it has to be on with Chrome open). Each item says “In … cart” once Claude sees it there.</p>';
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
        const ck = canCook() && x[0] === 'dinner' && t ? cookShort(rows[x[0]]) : '';
        return '<span class="dt-line' + (t ? '' : ' none') + '"><span class="dt-k">' + x[1] + '</span><span class="dt-v">' + esc(t || '—') + (ck ? '<small class="dt-cook">🧑‍🍳 ' + esc(ck) + '</small>' : '') + '</span></span>';
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

  // Picker options for breakfast / lunch / snack (api 30): the meals, then "Something we buy": items in the
  // Snacks aisle on the snack row, plus whatever item is planned there now, and a search for anything else.
  function slotOptions(meals, slot, p) {
    const m = p && mealById(p.meal_id || '');
    let html = mealOptions(meals, slot, m ? m.id : '');
    if (!canPlanItems() || slot === 'dinner') return html;
    const cur = planItem(p);
    const pool = D().items.filter((i) => i.status !== 'Drop' && (slot === 'snack' && i.group === 'Snacks' || (cur && i.id === cur.id)))
      .sort((a, b) => String(a.name).localeCompare(b.name));
    html += '<optgroup label="Something we buy">' + pool.map((i) => '<option value="i:' + i.id + '"' + (cur && cur.id === i.id ? ' selected' : '') + '>' + esc(i.name) + '</option>').join('') +
      '<option value="find">🔎 Something else we buy…</option></optgroup>';
    return html;
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
        const pi = planItem(p);
        const t = planText(p);
        const open = m ? '<button class="btn btn-plain slot-open" data-act="open-meal" data-id="' + m.id + '" aria-label="Open ' + esc(m.name) + '">↗</button>'
          : pi ? '<button class="btn btn-plain slot-open" data-act="open-item" data-id="' + pi.id + '" aria-label="Open ' + esc(pi.name) + '">↗</button>' : '<span class="slot-open"></span>';
        const cb = x[0] === 'dinner' ? cookBlock(sh.day, 'dinner', p) : '';
        if (readOnly) {
          return '<div class="slot-row"><div class="slot-label">' + x[1] + '</div>' +
            '<div class="slot-pick' + (t ? ' set' : '') + '"><span>' + esc(t || '—') + '</span></div>' + open + '</div>' + cb;
        }
        return '<div class="slot-row"><div class="slot-label">' + x[1] + '</div>' +
          '<div class="slot-pick' + (t ? ' set' : '') + '"><span>' + esc(t || '+ Pick ' + x[1].toLowerCase()) + '</span>' +
          '<label class="sr" for="slot-' + x[0] + '">' + x[1] + '</label><select id="slot-' + x[0] + '" data-input="slot-plan" data-day="' + sh.day + '" data-slot="' + x[0] + '">' +
          slotOptions(meals, x[0], p) + '</select></div>' + open + '</div>' + cb +
          (sh.find === x[0] ? slotFind(sh, x[0]) : '');
      }).join('') +
      '<p class="note">' + (readOnly ? 'Want something? Tap a meal in Our meals and Ask for it. A parent picks the day.' : 'Picking a meal replaces what was there. Leftovers come over from Hearth as they are.') + '</p>';
  }

  // "Something else we buy…" on a day-sheet row: search the catalog and plan the item itself.
  function slotFind(sh, slot) {
    const q = String(sh.fq || '').trim();
    const found = q ? findItems(q, D().items.filter((i) => i.status !== 'Drop')) : { all: false };
    const hits = found.all ? searchItems(q, 6) : [];
    return '<div class="slot-find"><label class="sr" for="slot-fq">Find something we buy</label>' +
      '<input id="slot-fq" class="field" style="width:100%" data-input="draft" data-field="fq" value="' + esc(sh.fq || '') + '" placeholder="Search what we buy, e.g. trail mix" autocomplete="off">' +
      (q ? '<div class="suggest suggest-inline">' + (hits.length ? '' : '<div class="s-none">Nothing we buy matches “' + esc(q) + '”. Add it in Shop first.</div>') +
        hits.map((h) => '<button type="button" data-act="slot-item" data-slot="' + slot + '" data-id="' + h.id + '"><span class="s-name">' + esc(h.name) + '</span><span class="s-meta">' + esc(storeOf(h.store).name) + '</span></button>').join('') +
        '<button type="button" class="s-close" data-act="slot-find-close">Close</button></div>'
        : '<button type="button" class="link-btn" data-act="slot-find-close">Cancel</button>') + '</div>';
  }
  function planSlotItem(day, slot, itemId) {
    const wk = addDays(day, -DAYS.indexOf(dayName(day)));
    act('planSet', { date: day, day: dayName(day), week_of: wk, meal_id: '', item_id: itemId, slot: slot, note: '' }, () => {
      D().plan = D().plan.filter((p) => !(planDate(p) === day && slotOf(p) === slot));
      D().plan.push({ date: day, week_of: wk, day: dayName(day), meal_id: '', item_id: itemId, slot: slot });
    });
  }

  // Text for Hearth Helper: one block per day, Breakfast / Lunch / Snack / Dinner. Since Nov 7 (owner: "Hearth can
  // take notes and who's assigned") each meal can carry a Cooking: line (Plan cook → Hearth's assignee) and a
  // Note: line (time, serves, an early-start heads-up from the recipe card, who asked for it, the plan note).
  // No recipes: those live on the recipe cards.
  const hearthMins = (n) => (n < 60 ? n + ' min' : Math.floor(n / 60) + ' hr' + (n % 60 ? ' ' + (n % 60) + ' min' : ''));
  function hearthNote(p, slot) {
    const m = mealById(p.meal_id || '');
    const bits = [];
    if (m && !isLeftover(p)) {
      const r = recipeOf(m.id);
      if (r && r.minutes) bits.push(hearthMins(Number(r.minutes)) + (slot === 'dinner' && r.serves ? ' · serves ' + r.serves : ''));
      if (r && r.early) bits.push('Heads-up, ' + r.early.charAt(0).toLowerCase() + r.early.slice(1)); // "Heads-up, night before: …"
    }
    const asked = String(p.asked_by || '').split(';').map((x) => x.trim()).filter(String);
    if (asked.length) bits.push(nameList(asked) + ' asked for it');
    const note = String(p.note || '').trim();
    if (note && planText(p) !== note && !/^leftover/i.test(note)) bits.push(note);
    return bits.join(' · ');
  }
  function hearthText(days) {
    const out = [];
    let cooks = false, notes = false;
    days.forEach((d) => {
      const rows = planDay(d);
      const lines = SLOTS.map((x) => {
        const p = rows[x[0]];
        const t = planText(p);
        if (!t) return '';
        const ck = canCook() ? cookShort(p).replace(' & ', ', ') : '';
        const nt = hearthNote(p, x[0]);
        if (ck) cooks = true;
        if (nt) notes = true;
        return x[1] + ': ' + t + (ck ? '\n  Cooking: ' + ck : '') + (nt ? '\n  Note: ' + nt : '');
      }).filter(String);
      if (lines.length) out.push(dayName(d) + ' ' + fmtLong(d) + '\n' + lines.join('\n'));
    });
    if (!out.length) return '';
    const first = days[0]; const last = days[days.length - 1];
    return 'Please update our Hearth Meal Plan for ' + fmtLong(first) + ' – ' + fmtLong(last) + ', ' + first.slice(0, 4) + '.\n' +
      'Use these exact meal names (emoji included) in the Breakfast, Lunch, Snack and Dinner rows. ' +
      (cooks ? 'Assign each meal to the people on its "Cooking:" line (they\'re in our family on Hearth); a meal without one is for the whole family. ' : 'Each meal is for the whole family. ') +
      (notes ? 'Put the text after "Note:" in that meal\'s notes, word for word. ' : '') +
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

  // 🧊 On hand from deliveries (Nov 2): Wildgrain / Bleu Box items we still have, for planning around.
  // An item counts once a delivery logged it (Stock) and nobody has said it's gone since.
  function viewOnHand() {
    const stock = D().stock || {};
    const have = D().items.filter((i) => isDelivery(i.store) && i.status !== 'Drop' && stock[i.id] &&
      ['out', 'waste', '0'].indexOf(String(stock[i.id].level).toLowerCase()) < 0);
    if (!have.length) return '';
    const closed = isClosed('onhand');
    const srcs = Object.keys(STORES).filter((k) => isDelivery(k) && have.some((i) => i.store === k));
    let h = '<section class="card acc"><button class="card-head acc-head" data-act="fold" data-key="onhand" aria-expanded="' + !closed + '">' +
      '<span>🧊 ON HAND FROM DELIVERIES</span><span class="head-btns"><span class="sub">' + have.length + '</span>' + chev(closed) + '</span></button>';
    if (closed) return h + '<button class="peek" data-act="fold" data-key="onhand">' + esc(have.map((i) => i.name).join(', ')) + '</button></section>';
    srcs.forEach((k) => {
      h += '<div class="onhand-src"><span class="store-dot ' + storeOf(k).cls + '"></span>' + esc(storeOf(k).name) + '</div>';
      have.filter((i) => i.store === k).forEach((i) => {
        h += '<div class="row"><button class="row-main" data-act="open-item" data-id="' + i.id + '"><span class="row-name">' + esc(i.name) + '</span><span class="row-meta">' +
          esc(levelText(stock[i.id].level)) + ' · ' + esc(daysAgo(stock[i.id].at)) + '</span></button></div>';
      });
    });
    return h + '</section>';
  }

  function viewMeals() {
    const plan = planByDate();
    const meals = D().meals.slice().sort((a, b) => String(a.name).localeCompare(b.name));
    const w = planWeeks();
    const planned = (days) => days.filter((d) => (canSlots() ? SLOTS.some((x) => planText(planDay(d)[x[0]])) : mealById(plan[d] || '')));
    // → Hearth sits on Next week (owner, Nov 7): you fill next week during this week, then send it.
    const canHearth = canSlots() && amParent();
    const hearthBtn = (week) => '<button class="btn btn-outline btn-sm" data-act="open-hearth" data-v="' + week + '">→ Hearth</button>';
    let html = viewMealRequests();
    html += viewHeroMeals(meals);
    html += '<section class="card"><div class="card-head"><span>THIS WEEK</span><span class="head-btns"><span class="sub">' + planned(w.thisWeek).length + ' of ' + w.thisWeek.length + (canSlots() ? ' days' : ' dinners') + '</span>' + (canHearth && !w.nextWeek.length ? hearthBtn('this') : '') + '</span></div>' +
      weekStrip('this', w.thisWeek, plan, meals) + weekCostLine('this', w.thisWeek) + '</section>';

    if (w.nextWeek.length) {
      const closed = isClosed('w:next');
      const pn = planned(w.nextWeek);
      // → Hearth right after the dates, open or folded (owner, Nov 7). Two fold buttons around it, since a button
      // can't sit inside the fold button.
      const fold = (cls, inner) => '<button class="wk-fold' + cls + '" data-act="fold" data-key="w:next" aria-expanded="' + !closed + '">' + inner + '</button>';
      html += '<section class="card acc"><div class="card-head wk-head">' +
        fold('', 'NEXT WEEK · ' + md(w.nextSun) + '–' + md(addDays(w.nextSun, 6))) + (canHearth ? hearthBtn('next') : '') +
        fold(' rest', '<span class="sub">' + pn.length + ' planned</span>' + chev(closed)) + '</div>';
      html += closed
        ? '<button class="peek" data-act="fold" data-key="w:next">' + (pn.length ? esc(pn.map((d) => dayName(d) + ' ' + (mealById(plan[d] || '') ? mealById(plan[d]).name : SLOTS.map((x) => planText(planDay(d)[x[0]])).filter(String)[0])).join(', ')) : 'Nothing planned yet. Tap to plan.') + '</button>'
        : weekStrip('next', w.nextWeek, plan, meals) + weekCostLine('next', w.nextWeek);
      html += '</section>';
    }

    html += viewOnHand();
    // Meal ideas section removed Nov 4 (owner: it clogs the tab). Meals that came from an idea carry a 💡 tag instead.

    html += viewOurMeals(meals);
    html += '<p class="hint">Tap a meal to put it on a day, see its ingredients or edit it.' + (canSlots() ? ' Tap a day for breakfast, lunch and snack.' : '') + '' + (canIdeas() ? ' Found a good one online? Tap 💡 at the top → Meal idea and paste it; Poppy adds it to Our meals.' : '') + '</p>';
    return html;
  }

 // Featured meals (Nov 4, owner: "fun ways to feature and bring attention to certain meals"). Meals column
  // `feature` = "<badge> | <tagline>", e.g. "👨‍🍳 Dad's Signature | The chips stay in." Blank = not featured.
  // Set in the Sheet for now. Featured meals get a hero card on top of Meals and a 🌟 in the list.
  function featureOf(m) {
    const f = String((m && m.feature) || '').trim();
    if (!f) return null;
    const parts = f.split('|');
    return { badge: parts[0].trim(), line: parts.slice(1).join('|').trim() };
  }
  function viewHeroMeals(meals) {
    return meals.filter(featureOf).map((m) => {
      const f = featureOf(m);
      return '<button class="hero-meal" data-act="open-meal" data-id="' + m.id + '">' +
        '<span class="hero-spark" aria-hidden="true">✨</span>' +
        '<span class="hero-badge">' + esc(f.badge) + '</span>' +
        '<span class="hero-name">' + esc(m.name) + '</span>' +
        (f.line ? '<span class="hero-line">' + esc(f.line) + '</span>' : '') +
        (mealTags(m).length ? '<span class="tags">' + mealTags(m).join('') + '</span>' : '') +
        '<span class="hero-go">' + (amParent() ? 'Put it on a night →' : 'Want this? →') + '</span></button>';
    }).join('');
  }

  // Our meals (Nov 4, owner: 45 meals now): a search box (meal name or any ingredient) and a Filter button
  // that opens Kind + Sort, like Shop's. No pill rows spilling onto two lines. While searching, results are one
  // flat list (best match first); otherwise Favorites shows the rating sections.
  const MEAL_SORTS = [['top', 'Favorites'], ['stale', 'Not lately'], ['cost', 'Cheapest'], ['az', 'A–Z']];
  const KIND_LABEL = { breakfast: 'Breakfasts', lunch: 'Lunches', snack: 'Snacks', dinner: 'Dinners' };
  function mealFiltersOn() {
    const on = [];
    if (S.mealKind && S.mealKind !== 'all') on.push(KIND_LABEL[S.mealKind] || S.mealKind);
    if ((S.mealSort || 'top') !== 'top') on.push('Sorted ' + (MEAL_SORTS.find((p) => p[0] === S.mealSort) || [])[1]);
    return on.filter(Boolean);
  }
  const normQ = (t) => String(t || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9 ]+/g, ' ');
  // 2 = a word of the meal's name starts with every typed word, 1 = every word found in name or ingredients, 0 = no.
  function mealMatch(m, q) {
    const words = normQ(q).split(/\s+/).filter(String);
    if (!words.length) return 1;
    const name = normQ(m.name + ' ' + String(m.old_names || '').replace(/;/g, ' ')); // old names still find it (api 47)
    const ings = mealItems(m).map((id) => itemById(id)).filter(Boolean).map((i) => normQ([i.name, i.brand_size, i.aliases].join(' '))).join(' ');
    const hay = name + ' ' + ings;
    if (!words.every((w) => hay.indexOf(w) >= 0)) return 0;
    const nameWords = name.split(/\s+/);
    return words.every((w) => nameWords.some((x) => x.indexOf(w) === 0)) ? 2 : 1;
  }
  function viewOurMeals(meals) {
    const kinds = canSlots() ? SLOTS.filter((x) => meals.some((m) => kindOf(m) === x[0])) : [];
    if (S.mealKind && S.mealKind !== 'all' && !kinds.some((x) => x[0] === S.mealKind)) S.mealKind = 'all';
    const kind = S.mealKind || 'all';
    const sort = S.mealSort || 'top';
    const q = String(S.mealQuery || '').trim();
    let shown = kinds.length > 1 && kind !== 'all' ? meals.filter((m) => kindOf(m) === kind) : meals;
    let sorted = sortMeals(shown);
    if (q) {
      const score = {}; sorted.forEach((m) => (score[m.id] = mealMatch(m, q)));
      sorted = sorted.filter((m) => score[m.id]).sort((a, b) => score[b.id] - score[a.id]); // stable: keeps the sort inside
    }
    const on = mealFiltersOn();
    const open = !!S.mealFiltersOpen;
    let h = '<section class="card"><div class="card-head"><span>OUR MEALS · ' + meals.length + '</span><span class="head-btns">' +
      // New meals come in through the header's 💡 → Meal idea (Nov 7, owner: the Our meals button went unused);
      // + New stays only for backends without meal ideas.
      (canIdeas() ? '' : '<button class="btn btn-outline" data-act="new-meal">+ New</button>') + '</span></div>';
    h += '<div class="meal-tools"><div class="shop-search"><form class="addbar" data-form="meal-q" autocomplete="off"><label class="sr" for="meal-q">Search meals</label>' +
      '<input id="meal-q" class="field" type="search" data-input="meal-q" placeholder="Meal or ingredient…" value="' + esc(S.mealQuery) + '" enterkeyhint="search">' +
      (S.mealQuery ? '<button type="button" class="search-x" data-act="meal-clear-q" aria-label="Clear the search">✕</button>' : '') + '</form>' +
      (canStats() || kinds.length > 1 ? '<button type="button" class="filter-btn' + (open ? ' open' : '') + (on.length ? ' active' : '') + '" data-act="meal-filters" aria-expanded="' + open + '" aria-controls="meal-filters">' +
        '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M4.5 8h7M7 12h2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>' +
        '<span>Filter</span>' + (on.length ? '<span class="filter-n">' + on.length + '</span>' : '') + '</button>' : '') + '</div>';
    if (open) {
      const seg = (act, cur, v, label) => '<button type="button" class="' + (cur === v ? 'on' : '') + '" data-act="' + act + '" data-v="' + v + '" aria-pressed="' + (cur === v) + '">' + label + '</button>';
      h += '<div class="filter-panel" id="meal-filters">' +
        (kinds.length > 1 ? '<div class="fp-label">Kind</div><div class="seg seg-fit">' + seg('meal-kind', kind, 'all', 'All') +
          ['dinner', 'breakfast', 'lunch', 'snack'].filter((k) => kinds.some((x) => x[0] === k)).map((k) => seg('meal-kind', kind, k, slotLabel(k))).join('') + '</div>' : '') +
        (canStats() ? '<div class="fp-label">Sort</div><div class="seg">' + MEAL_SORTS.map((p) => seg('meal-sort', sort, p[0], p[1])).join('') + '</div>' : '') +
        '<div class="fp-foot">' + (on.length ? '<button type="button" class="link-btn" data-act="meal-filters-clear">Clear filters</button>' : '<span></span>') +
        '<button type="button" class="btn btn-primary small" data-act="meal-filters">Done</button></div></div>';
    } else if (on.length) {
      h += '<div class="filter-sum"><span>' + esc(on.join(' · ')) + '</span><button type="button" class="link-btn" data-act="meal-filters-clear">Clear</button></div>';
    }
    h += '</div>';
    if (q) h += '<div class="meal-tier-note found">' + (sorted.length ? sorted.length + (sorted.length === 1 ? ' meal' : ' meals') + ' with “' + esc(q) + '”' : 'No meals with “' + esc(q) + '”' + (kind !== 'all' ? ' in ' + esc(KIND_LABEL[kind]) : '')) + '</div>';
    h += (sorted.length ? (!q && sort === 'top' && canStats() ? mealSections(sorted) : sorted.map(mealRow).join(''))
      : (q ? '' : '<div class="empty">No meals yet.</div>')) + '</section>';
    return h;
  }

  // Kind shows as a small tag; no 🥣 / 🥪 / 🍎 icons, the meal's own emoji does the talking (owner, Nov 7).
  function mealRow(m) {
    const showKind = canSlots() && kindOf(m) !== 'dinner';
    const tags = (showKind ? ['<span class="stat-tag kind">' + esc(slotLabel(kindOf(m))) + '</span>'] : []).concat(mealTags(m));
    return '<div class="row"><button class="row-main" data-act="open-meal" data-id="' + m.id + '"><span class="row-name">' + (featureOf(m) ? '<span class="hero-star" title="' + esc(featureOf(m).badge) + '">🌟</span>' : '') + esc(m.name) + '</span>' +
      '<span class="row-meta">' + mealItems(m).map((id) => itemById(id)).filter(Boolean).map((i) => esc(i.name)).join(', ') + '</span>' +
      (tags.length ? '<span class="tags">' + tags.join('') + '</span>' : '') + '</button></div>';
  }

  // Favorites view (owner, Nov 4: "not all meals are created equal"): the list in sections by the family's rating,
  // best first. Every section starts folded with a peek (owner, Nov 7).
  const MEAL_TIERS = [
    ['fav', '⭐ FAMILY FAVORITES', 'Rated 3.5+ by 2 or more of us', false],
    ['good', '👍 WE LIKE THESE', '', false],
    ['new', '🆕 NOT RATED YET', 'Vote on these in the Inbox, or after we make them', true],
    ['meh', '😐 NOT LOVED', 'Rated under 2.5', true],
  ];
  function mealTier(m) {
    const st = statOf(m.id) || {};
    const n = Object.keys(st.voters || {}).length;
    if (!n) return 'new';
    if (n >= 2 && st.score >= 3.5) return 'fav';
    return st.score >= 2.5 ? 'good' : 'meh';
  }
  function mealSections(sorted) {
    return MEAL_TIERS.map((t) => {
      const rows = sorted.filter((m) => mealTier(m) === t[0]);
      if (!rows.length) return '';
      const key = 'mt:' + t[0];
      const closed = isClosed(key);
      return '<div class="meal-tier"><button class="meal-tier-head" data-act="fold" data-key="' + key + '" aria-expanded="' + !closed + '"><span>' + t[1] + ' · ' + rows.length + '</span>' + chev(closed) + '</button>' +
        (t[2] && !closed ? '<p class="meal-tier-note">' + esc(t[2]) + '</p>' : '') +
        (closed ? '<button class="peek" data-act="fold" data-key="' + key + '">' + esc(rows.slice(0, 5).map((m) => m.name).join(', ')) + (rows.length > 5 ? '…' : '') + '</button>' : rows.map(mealRow).join('')) + '</div>';
    }).join('');
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
      tags.push('<span class="stat-tag' + (fav ? ' fav' : st.score && st.score < 2.5 ? ' meh' : '') + '" title="' + esc(voters.map((w) => w + ' ' + st.voters[w]).join(', ')) + '">' + (fav ? 'Favorite · ' : '') + '★ ' + Number(st.score).toFixed(1) + ' · ' + counts + '</span>');
      if (st.matchups) tags.push('<span class="stat-tag" title="Head-to-head cards in the Inbox">Won ' + (st.wins || 0) + ' of ' + st.matchups + ' head-to-heads</span>');
    }
    if (st.next) tags.push('<span class="stat-tag next">' + (st.next === D().today ? (kindOf(m) === 'dinner' ? 'Tonight' : 'Today') : 'Next ' + esc(shortDay(st.next))) + '</span>');
    if (st.made) tags.push('<span class="stat-tag">Made ' + st.made + '× · last ' + esc(md(st.last)) + '</span>');
    if (costKnown(st)) tags.push('<span class="stat-tag" title="Latest receipt prices of ' + st.priced + ' of ' + st.linked + ' ingredients">' + tierOf(st.cost) + ' · ~$' + Math.round(st.cost) + (st.priced < st.linked ? '+' : '') + '</span>');
    if (fromIdea(m.id)) tags.push('<span class="stat-tag idea">💡 From an idea</span>');
    if (!voters.length && !st.made && !st.next) tags.push('<span class="stat-tag new">New</span>');
    return tags;
  }

  const winRate = (st) => (st.matchups ? (st.wins || 0) / st.matchups : 0.5);
  // A meal made from a 💡 Meal idea (Meal Ideas meal_id, e.g. "m43;m44").
  const fromIdea = (id) => (D().ideas || []).some((x) => String(x.meal_id || '').split(';').map((v) => v.trim()).indexOf(id) >= 0);
  function sortMeals(meals) {
    const k = S.mealSort || 'az';
    const st = (m) => statOf(m.id) || {};
    const by = {
      az: () => 0,
      top: (a, b) => (st(b).score || 0) - (st(a).score || 0) || winRate(st(b)) - winRate(st(a)) ||
        Object.keys(st(b).voters || {}).length - Object.keys(st(a).voters || {}).length || String(st(b).last || '').localeCompare(String(st(a).last || '')),
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

  // "+ Add an ingredient" on the meal card: search what we buy (every word must match), tap to add; or add it as a new item.
  function mealCardIngAdd(sh, ids) {
    const q = String(sh.iq || '').trim();
    const found = q ? findItems(q, D().items.filter((i) => i.status !== 'Drop')) : { all: false, hits: [] };
    const hits = (found.all ? searchItems(q, 6) : []).filter((i) => ids.indexOf(i.id) < 0);
    const exact = q && D().items.some((i) => String(i.name).toLowerCase() === q.toLowerCase());
    return '<div class="ing-add"><label class="sr" for="mc-iq">Add an ingredient</label>' +
      '<input id="mc-iq" class="field" type="search" data-input="draft" data-field="iq" value="' + esc(sh.iq || '') + '" placeholder="＋ Add an ingredient…" autocomplete="off" enterkeyhint="search">' +
      (q ? '<div class="suggest suggest-inline">' +
        (hits.length ? '' : '<div class="s-none">Nothing we buy matches “' + esc(q) + '”.</div>') +
        hits.map((h) => '<button type="button" data-act="mc-ing-add" data-id="' + h.id + '"><span class="s-name">' + esc(h.name) + '</span><span class="s-meta">' + esc([h.brand_size, storeOf(h.store).name].filter(String).join(' · ')) + '</span></button>').join('') +
        (exact ? '' : '<button type="button" class="s-new" data-act="mc-ing-new"' + (sh.creating ? ' disabled' : '') + '><span class="add-btn" aria-hidden="true">+</span><span class="s-name">' + (sh.creating ? 'Adding “' + esc(q) + '”…' : 'Add “' + esc(q) + '” as a new item') + '</span></button>') +
        '<button type="button" class="s-close" data-act="mc-ing-clear">Close</button></div>' : '') + '</div>';
  }
  function saveMealIngredients(m, ids, msg, undo) {
    act('mealSave', { id: m.id, name: m.name, item_ids: ids, kind: kindOf(m) }, () => { m.item_ids = ids.join(';'); }, msg, undo);
  }

  // The meal card: plan it on a night, its ingredients, its stats, edit.
  // Who voted what (Nov 4, owner): one row per person on the meal card, latest vote from vote / rate cards.
  const VOTE_LABEL = { '😍': 'Love it', '🙂': 'Like it', '😐': "It's OK", '👎': 'Not for me' };
  // Vote right on the card (Nov 4, owner, api 52): your own row is a button; tap it, pick an emoji, it saves.
  const canMealVote = () => Number(D().api || 0) >= 52;
  function mealVotesBlock(m, sh) {
    if (!canStats()) return '';
    const st = statOf(m.id) || { voters: {} };
    const voters = st.voters || {};
    const lower = (x) => String(x).toLowerCase();
    const fam = (D().settings.parents || []).concat(D().settings.kids || []);
    const names = fam.concat(Object.keys(voters).filter((w) => fam.map(lower).indexOf(lower(w)) < 0 && w !== '?'));
    const voteOf = (n) => voters[Object.keys(voters).find((w) => lower(w) === lower(n))];
    const n = names.filter(voteOf).length;
    const isMe = (p) => canMealVote() && lower(p) === lower(S.me);
    return '<div class="is-block"><div class="is-label">Family votes' + (n ? ' · ★ ' + Number(st.score).toFixed(1) : '') + '</div>' +
      '<ul class="vote-list">' + names.map((p) => {
        const v = voteOf(p);
        if (isMe(p)) {
          if (sh && sh.voting) return '<li class="vote-me picking"><span class="vote-who">' + esc(p) + ' <small>(you)</small></span><span class="vote-pick">' +
            Object.keys(VOTE_LABEL).map((e) => '<button type="button" data-act="mc-vote" data-v="' + e + '" class="' + (v === e ? 'on' : '') + '" aria-label="' + esc(VOTE_LABEL[e]) + '"><span class="vote-emoji">' + e + '</span><small>' + esc(VOTE_LABEL[e]) + '</small></button>').join('') +
            '</span></li>';
          return '<li class="vote-me"><span class="vote-who">' + esc(p) + ' <small>(you)</small></span><button type="button" class="vote-mine" data-act="mc-vote-open">' +
            (v ? '<span class="vote-emoji">' + v + '</span> ' + esc(VOTE_LABEL[v] || '') + ' <span class="vote-change">Change</span>' : '<span class="vote-add">＋ Add my vote</span>') + '</button></li>';
        }
        return '<li class="' + (v ? '' : 'none') + '"><span class="vote-who">' + esc(p) + '</span><span class="vote-what">' + (v ? '<span class="vote-emoji">' + v + '</span> ' + esc(VOTE_LABEL[v] || '') : 'No vote yet') + '</span></li>';
      }).join('') + '</ul>' +
      (st.matchups ? '<p class="note">Won ' + (st.wins || 0) + ' of ' + st.matchups + ' head-to-heads.</p>' : '') +
      (!n && !canMealVote() ? '<p class="note">Votes come from the Inbox dinner votes and How was it? cards.</p>' : '') + '</div>';
  }

  // Printable recipe cards (Nov 4, owner): recipes/index.json lists every meal with a PDF in recipes/ (built by
  // recipes/build.js from recipes/src/mNN.json). Loaded once, the first time a meal card opens.
  function recipeOf(id) {
    if (!S.recipes && !S.recipesLoading) {
      S.recipesLoading = true;
      fetch('recipes/index.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).then((j) => { S.recipes = j || { recipes: {} }; render(); })
        .catch(() => { S.recipesLoading = false; });
    }
    return S.recipes && S.recipes.recipes && S.recipes.recipes[id];
  }
  function recipeButton(m) {
    const r = recipeOf(m.id);
    if (!r) return '';
    return '<button type="button" class="btn btn-outline btn-block recipe-btn" data-act="open-recipe" data-id="' + esc(m.id) + '">🖨 Recipe card<small>' +
      esc([r.minutes ? r.minutes + ' min' : '', r.serves ? 'serves ' + r.serves : ''].filter(String).join(' · ')) + ' · see it, print it</small></button>';
  }
  // The recipe sheet (Nov 4, owner: opening the PDF in the home-screen app left no Share and no way back): page
  // pictures inside Poppy, Print or share hands the PDF file to the phone's share sheet (Print is in there), ✕ goes back.
  const recipeUrl = (r) => r.pdf + '?v=' + encodeURIComponent((S.recipes && S.recipes.built) || '');
  function prefetchRecipe(id) {
    const r = recipeOf(id); S.recipeFiles = S.recipeFiles || {};
    if (!r || S.recipeFiles[id]) return;
    S.recipeFiles[id] = 'loading';
    fetch(recipeUrl(r)).then((x) => (x.ok ? x.blob() : null)).then((b) => {
      const name = String(r.name).replace(/^\P{L}+/u, '').replace(/[^\w&' -]+/g, '').trim() || id;
      S.recipeFiles[id] = b ? new File([b], name + ' recipe card.pdf', { type: 'application/pdf' }) : null;
      render();
    }).catch(() => { S.recipeFiles[id] = null; });
  }
  function viewRecipeSheet(sh) {
    const m = mealById(sh.id); const r = recipeOf(sh.id);
    if (!m || !r) return '<p class="note">That recipe card isn’t here.</p>';
    const f = S.recipeFiles && S.recipeFiles[sh.id];
    const v = encodeURIComponent((S.recipes && S.recipes.built) || '');
    return '<div class="is-head"><div><h2>' + esc(m.name) + '</h2><p class="note">Recipe card · one page</p></div><button class="x-btn" data-act="recipe-close" aria-label="Back to the meal">✕</button></div>' +
      '<div class="recipe-bar"><button class="btn btn-primary" data-act="recipe-share"' + (f === 'loading' ? ' disabled' : '') + '>' + (f === 'loading' ? 'Getting the card…' : '🖨 Print or share') + '</button>' +
      '<button class="btn btn-plain" data-act="recipe-close">‹ ' + (sh.from === 'inbox' ? 'Back to the Inbox' : 'Back to the meal') + '</button></div>' +
      '<p class="note recipe-tip">Print or share opens your phone’s share sheet: pick <b>Print</b>, or AirDrop / Messages.</p>' +
      (r.img || []).map((src, i) => '<img class="recipe-page" src="' + esc(src) + '?v=' + v + '" alt="' + (i ? 'Page ' + (i + 1) + ' of the recipe card' : 'The recipe card') + '" loading="lazy">').join('');
  }


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
    let h = '<div class="is-head"><div>' + (featureOf(m) ? '<div class="hero-badge in-card">' + esc(featureOf(m).badge) + '</div>' : '') + '<h2>' + esc(m.name) + '</h2>' + (featureOf(m) && featureOf(m).line ? '<p class="hero-line in-card">' + esc(featureOf(m).line) + '</p>' : '') + (mealTags(m).length ? '<div class="tags">' + mealTags(m).join('') + '</div>' : '') + '</div>' +
      '<button class="x-btn" data-act="close-x" aria-label="Close">✕</button></div>';
    h += recipeButton(m);
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

    h += mealCookBlock(m, slot);
    h += mealVotesBlock(m, sh);

    const ids = mealItems(m).filter((id) => itemById(id));
    const need = ids.filter((id) => !listRowFor(id));
    // Parents edit ingredients right here (Nov 4, owner): ✕ takes one off, the box below adds one (or a new item).
    // Each change saves at once; no trip through Edit meal.
    const canEditIng = amParent();
    h += '<div class="is-block"><div class="is-label">Ingredients</div>' + (ids.length
      ? (meatQty(m) > 1 && ids.some(isMeat) ? '<div class="meat-more">🍗 Making more: ' + meatQty(m) + ' of each meat go on the List</div>' : '') +
        '<ul class="is-notes ing-list">' + ids.map((id) => '<li><span>' + esc(itemById(id).name) + (meatQty(m) > 1 && isMeat(id) ? ' <b>×' + meatQty(m) + '</b>' : '') + (listRowFor(id) ? ' <span class="tag tag-listed">On list</span>' : '') + '</span>' +
          (canEditIng ? '<button type="button" class="ing-x" data-act="mc-ing-remove" data-id="' + id + '" aria-label="Take ' + esc(itemById(id).name) + ' off this meal">✕</button>' : '') + '</li>').join('') + '</ul>'
      : '<p class="note">' + (canEditIng ? 'No ingredients yet. Add them below.' : 'No ingredients linked yet.') + '</p>') +
      (canEditIng ? mealCardIngAdd(sh, ids) : '') +
      (ids.length && !isKid(S.me) ? (need.length ? '<button class="btn btn-outline btn-block" data-act="meal-add-all" data-id="' + m.id + '">Add ' + need.length + ' to the List</button>' : '<p class="note">Everything is on the List already.</p>') : '') + '</div>';
    if (m.notes) h += '<div class="is-block"><div class="is-label">Notes</div><p class="is-fact">' + esc(m.notes) + '</p></div>';
    if (!kidAsks) h += '<div class="is-actions"><button class="btn btn-plain" data-act="edit-meal" data-id="' + m.id + '">Edit meal</button></div>';
    return h;
  }

  // On the meal card: each upcoming day it's planned, who planned it and who's cooking (api 60).
  function mealCookBlock(m, slot) {
    if (!canCook() || slot !== 'dinner') return '';
    const days = D().plan.filter((p) => p.meal_id === m.id && slotOf(p) === 'dinner' && !isLeftover(p) && planDate(p) >= D().today)
      .sort((a, b) => planDate(a).localeCompare(planDate(b))).slice(0, 3);
    if (!days.length) return '';
    return '<div class="is-block"><div class="is-label">Coming up</div>' + days.map((p) => {
      const d = planDate(p);
      return '<div class="cook-day"><b>' + esc(d === D().today ? 'Tonight' : dayName(d) + ' ' + md(d)) + '</b>' + cookBlock(d, 'dinner', p) + '</div>';
    }).join('') + '</div>';
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

  function planMeal(date, mealId, askedBy) {
    const slot = canSlots() ? kindOf(mealById(mealId)) : 'dinner';
    const before = planByDate(slot)[date] || '';
    const to = before === mealId ? '' : mealId;
    const wk = addDays(date, -DAYS.indexOf(dayName(date)));
    const m = mealById(mealId); const prev = before && before !== mealId ? mealById(before) : null;
    const msg = to ? m.name + ' on ' + (date === D().today ? 'tonight' : shortDay(date)) + (prev ? ' (instead of ' + prev.name + ')' : '') : 'Took ' + m.name + ' off ' + shortDay(date);
    const send = (meal) => act('planSet', Object.assign({ date: date, day: dayName(date), week_of: wk, meal_id: meal, slot: slot, note: '' }, askedBy && meal === to ? { asked_by: askedBy } : {}), () => {
      D().plan = D().plan.filter((p) => !(planDate(p) === date && slotOf(p) === slot));
      if (meal) D().plan.push({ date: date, week_of: wk, day: dayName(date), meal_id: meal, slot: slot, planned_by: S.me, planned_at: D().today, asked_by: meal === to ? askedBy || '' : '' });
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
      if (isDelivery(item.store)) return '<div class="ing-row"><span class="row-name">' + esc(item.name) + '</span><span class="tag tag-have">🧊 ' + esc(storeOf(item.store).name) + '</span></div>';
      const need = picks[id] !== false;
      if (need) toAdd++;
      return '<div class="ing-row"><span class="row-name">' + esc(item.name) + '</span><button class="tag ' + (need ? 'tag-need' : 'tag-have') + '" data-act="ing" data-day="' + day + '" data-id="' + id + '">' +
        (need ? 'Need' : 'Have it') + '</button></div>';
    }).join('');
    return '<div class="ing">' + rows + (isKid(S.me) ? '' : toAdd ? '<button class="btn btn-primary btn-block" data-act="add-meal" data-day="' + day + '" data-id="' + meal.id + '">Add ' + toAdd + ' to the List</button>'
      : '<div class="note">Everything for ' + esc(meal.name) + ' is covered.</div>') + '</div>';
  }

  /* ---------- ask ---------- */
  // Questions for the current person. Review rows have no audience column yet,
  // so today every open question goes to the parents. Per-person questions come next.
  // "Later" snoozes a card until a time the person picks (In 2 hours / After school / Tonight / Tomorrow; Nov 2).
  // Snoozes live on this phone, per person ({person: {review_id: untilMs}}), so one parent's Later doesn't hide a shared
  // card from the other. Until then the card is out of the deck, the badge and the section chips; then it's back at the
  // end of its section (later_at still saved through reviewLater, so 3 Laters retire it in the morning check).
  function snoozeMap() { try { return JSON.parse(store.get('ff_snooze') || '{}') || {}; } catch (e) { return {}; } }
  function mySnoozes() { return snoozeMap()[String(S.me).toLowerCase()] || {}; }
  function setSnooze(id, until) {
    const all = snoozeMap(), me = String(S.me).toLowerCase(), now = Date.now();
    const mine = all[me] || {};
    Object.keys(mine).forEach((k) => { if (mine[k] <= now) delete mine[k]; });
    mine[id] = until; all[me] = mine;
    store.set('ff_snooze', JSON.stringify(all));
  }
  function snoozed(r) { const u = mySnoozes()[r.id]; return !!u && u > Date.now(); }
  // Choices that are still ahead today, then Tomorrow (6 am).
  function snoozeChoices() {
    const now = new Date(), at = (h) => { const d = new Date(now); d.setHours(h, 0, 0, 0); return d.getTime(); };
    const out = [{ label: 'In 2 hours', sub: new Date(now.getTime() + 2 * 3600e3).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), until: now.getTime() + 2 * 3600e3 }];
    if (now.getHours() < 16) { const d = new Date(now); d.setHours(16, 30, 0, 0); out.push({ label: 'After school', sub: '4:30 pm', until: d.getTime() }); }
    if (now.getHours() < 17) out.push({ label: 'Tonight', sub: '6 pm', until: at(18) });
    const t = new Date(now); t.setDate(t.getDate() + 1); t.setHours(6, 0, 0, 0);
    out.push({ label: 'Tomorrow', sub: 'morning', until: t.getTime() });
    return out;
  }
  function viewSnoozePicker(r) {
    return '<div class="pass-pick"><div class="pass-title">Bring it back…</div><div class="pass-people snooze-pick">' +
      snoozeChoices().map((c) => '<button type="button" class="pass-person" data-act="ask-snooze" data-id="' + r.id + '" data-until="' + c.until + '">' +
        '<b>' + esc(c.label) + '</b><span class="note">' + esc(c.sub) + '</span></button>').join('') +
      '</div><button type="button" class="btn btn-plain" data-act="ask-later" data-id="' + r.id + '">Cancel</button></div>';
  }
  function nextBack() {
    const m = mySnoozes(), now = Date.now(), ids = myQuestions(true).map((q) => q.id);
    const t = ids.map((id) => m[id]).filter((u) => u && u > now).sort((a, b) => a - b)[0];
    return t ? new Date(t) : null;
  }
  function myQuestions(withSnoozed) {
    const school = atSchool();
    return myQuestionsAll().filter((r) => (withSnoozed || !snoozed(r)) && !(school && homeOnly(r)));
  }
  /* School hours (Nov 4, a kid's feedback via owner): on a school day (Mon–Fri) the girls are out from 7:30 am to
     4:30 pm, so cards that mean "go look at home" (🔎 Missions, which for kids includes "Did we get the …? Go look")
     wait for home: out of the deck, the badge and the chips, with a 🏠 note saying how many and when they open.
     Nothing expires or changes on the backend. "I'm home today" (snow day, sick day, holiday) opens them for the
     rest of the day on that phone. Parents aren't affected. App only. */
  const SCHOOL = { days: [1, 2, 3, 4, 5], from: 7 * 60 + 30, to: 16 * 60 + 30, opens: '4:30' };
  const homeKey = () => 'ff_home_' + String(S.me).toLowerCase();
  function atSchool() {
    if (!S.me || !isKid(S.me)) return false;
    const now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
    if (SCHOOL.days.indexOf(now.getDay()) < 0 || mins < SCHOOL.from || mins >= SCHOOL.to) return false;
    return store.get(homeKey()) !== now.toDateString();
  }
  const homeOnly = (r) => sectionOf(r) === 'mission';
  function homeWaiting() { return atSchool() ? myQuestionsAll().filter((r) => !snoozed(r) && homeOnly(r)) : []; }
  function viewHomeWaiting() {
    const n = homeWaiting().length;
    if (!n) return '';
    return '<section class="card home-wait"><div class="home-wait-txt"><b>🏠 ' + n + (n === 1 ? ' mission waits' : ' missions wait') + ' for home</b>' +
      '<span class="note">They open at ' + SCHOOL.opens + ', after school. Until then, everything here works from anywhere.</span></div>' +
      '<button type="button" class="btn btn-plain" data-act="im-home">I’m home</button></section>';
  }
  // Meal votes follow the meal (Nov 3, the owner's idea): a vote card on a meal that's planned from today on waits
  // until the morning after we eat it, then asks "You had <meal> yesterday. How was it?". App only.
  function voteMealId(r) {
    if (!r || r.type !== 'vote') return '';
    const d = String(r.detail || '');
    const id = (d.match(/\((m\d{2,})\)/) || [])[1];
    if (id) return id;
    const n = ((d.match(/about (.+?)\?/) || [])[1] || '').toLowerCase();
    const m = n && (D().meals || []).find((x) => String(x.name).toLowerCase() === n || String(x.old_names || '').split(';').some((o) => o.trim().toLowerCase() === n));
    return m ? m.id : '';
  }
  // 'after' = had it in the last 2 days, 'held' = planned from today on, 'new' = never had, 'had' = had before.
  function voteTiming(r) {
    const id = voteMealId(r);
    const st = id && (D().mealStats || {})[id];
    if (!st) return '';
    const today = D().today;
    if (st.last && st.last >= addDays(today, -2)) return 'after';
    if (st.next && st.next >= today) return 'held';
    return st.made ? 'had' : 'new';
  }
  const voteHeld = (r) => voteTiming(r) === 'held';
  function heldVotes() { return myQuestionsAll(true).filter(voteHeld); }
  function myQuestionsAll(withHeld) {
    const review = D().review || [];
    return review.filter((r) => {
      if (r.type === 'meal_request') return false; // shown on the Meals tab instead
      if (!withHeld && voteHeld(r)) return false; // waits for the morning after the meal
      if (r.type === 'have_check') { // a kid's "we have it": gone once the row left the List some other way
        const m = String(r.detail).match(/\((L\d{4,})\)/);
        if (m && !D().list.some((x) => x.id === m[1])) return false;
      }
      if (r.type === 'settle') { // "Did we get it?": gone once the row is settled some other way (receipt, In store)
        const m = String(r.detail).match(/\((L\d{4,})\)/);
        if (m && !D().list.some((x) => x.id === m[1])) return false;
      }
      if (r.type === 'bestprice') { // gone once the row left the List or is in a cart already
        const m = String(r.detail).match(/\((L\d{4,})\)/);
        const x = m && D().list.find((y) => y.id === m[1]);
        if (m && (!x || x.status !== 'needed' || x.cart_want)) return false;
      }
      if (r.type === 'same_kind') { // api 62: gone once fewer than two of its rows are still on the List
        const ids = (String(r.detail).match(/\(L\d{4,}\)/g) || []).map((x) => x.slice(1, -1));
        if (ids.length && ids.filter((id) => D().list.concat(D().held || []).some((x) => x.id === id)).length < 2) return false;
      }
      if (r.type === 'settle_meal') { // gone once no List row is tied to that meal anymore
        const m = String(r.detail).match(/\(meal (m\d+)\)/);
        if (m && !D().list.concat(D().held || []).some((x) => x.meal_id === m[1])) return false;
      }
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
  const isTypeOpt = (o) => /\(type[^)]*\)|type it|^other$/i.test(o); // "Other (type it)", "Fix some (type which)"…
  const isSkipOpt = (o) => /^don.?t care$/i.test(o);
  const cleanOpt = (o) => o.replace(/\s*\(type[^)]*\)/i, '');

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

  /* Inbox sections (Nov 1, owner): the deck is grouped, most important first.
     Kids:    Due soon -> How was it? -> Missions -> Quick questions
     Parents: (Approvals list above the deck) -> Decisions -> Due soon -> How was it? -> Missions -> Quick questions
     A Review `section` column wins when it exists; otherwise the section comes from the card's type and text. */
  const SECTIONS = {
    due: { icon: '⏰', label: 'Due soon' },
    decision: { icon: '⚖', label: 'Decisions' },
    rate: { icon: '🍽', label: 'How was it?' },
    mission: { icon: '🔎', label: 'Missions' },
    settle: { icon: '🧾', label: 'Did we get it?' },
    question: { icon: '💬', label: 'Quick questions' },
    helped: { icon: '🧑‍🍳', label: 'Kitchen help' },
  };
  const sectionOrder = () => amParent() ? ['decision', 'due', 'settle', 'helped', 'rate', 'mission', 'question'] : ['due', 'settle', 'rate', 'mission', 'question'];
  function sectionOf(r) {
    const sec = String(r.section || '').toLowerCase();
    if (SECTIONS[sec]) return sec;
    const t = String(r.type || '').toLowerCase(), d = String(r.detail || '');
    if (t === 'helped') return 'helped';
    if (t === 'prize') return 'due'; // api 59: the winner's dessert pick sits on top
    if (t === 'have_check') return 'decision';
    // For the kids, "Did we get it?" is a mission: go look at home (api 21: their "It's here" goes to a parent).
    if (t === 'settle' && !amParent() && Number(D().api || 0) >= 21) return 'mission';
    if (t === 'settle' || t === 'settle_order' || t === 'settle_meal') return 'settle';
    if (t === 'task' || r.due_at || /^school lunches for next week/i.test(d) || /\bdue (by )?(mon|tues|wednes|thurs|fri|satur|sun)day\b/i.test(d)) return 'due';
    if (t === 'rate' || t === 'still' || (t === 'vote' && voteTiming(r) === 'after')) return 'rate'; // api 35: a vote right after the meal
    if (t === 'check' || t === 'mission') return 'mission';
    if (amParent() && (['clarify', 'swap', 'miss', 'unknown_code', 'waste', 'storebrand', 'try', 'bestprice', 'voice', 'tidy', 'subbed', 'which', 'same_kind', 'kind', 'recipe_check'].indexOf(t) >= 0 ||
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

  /* Inbox points (api 13). Mirrors cardPoints() in Code.gs; the backend is the one that counts. */
  const canPoints = () => Number(D().api || 0) >= 13 && D().points;
  // The scoring rules. The backend sends them from api 14 (state.points.rules); these are the same numbers for api 13.
  const DEFAULT_RULES = [
    { key: 'task', icon: '⏰', label: 'Due soon, answered on time', pts: 5, to: 'you' },
    { key: 'task_late', icon: '⏰', label: 'Due soon, answered after it was due', pts: 2, to: 'you' },
    { key: 'check', icon: '🔎', label: 'Mission (go check something)', pts: 3, to: 'you' },
    { key: 'settle', icon: '🧾', label: 'Did we get it? (settling the List)', pts: 3, to: 'you' },
    { key: 'rate', icon: '🍽', label: 'How was it?', pts: 2, to: 'you' },
    { key: 'still', icon: '🍽', label: 'Still eating it?', pts: 2, to: 'you' },
    { key: 'other', icon: '💬', label: 'Any other card: questions, dinner votes, decisions', pts: 1, to: 'you' },
    { key: 'helped_cooked', icon: '🧑‍🍳', label: 'Kitchen help: Cooked it', pts: 10, to: 'kid', group: 'kitchen' },
    { key: 'helped_helped', icon: '🧑‍🍳', label: 'Kitchen help: Helped', pts: 5, to: 'kid', group: 'kitchen' },
  ];
  const ruleGroup = (x) => x.group || (x.to === 'kid' ? 'kitchen' : 'inbox');
  // " · +1" on a toast for points earned outside the Inbox (api 16: List adds, meal asks, handling kids' requests).
  const ptsTag = (k) => (Number(D().api || 0) >= 16 && !preStart() && rulePts(k) ? ' · +' + boostPts(rulePts(k), S.me) : '');
  const pointRules = () => (D().points && D().points.rules) || DEFAULT_RULES;
  const rulePts = (k) => { const x = pointRules().find((y) => y.key === k); return x ? Number(x.pts) || 0 : 0; };
  // Quick cards (💬 questions, votes, decisions) count up to points.quickCap a day each (api 36).
  const quickCapped = () => { const P = D().points || {}; return !!P.quickCap && ((P.quickToday || {})[S.me] || 0) >= P.quickCap; };
  // Missions count up to points.missionCap a day each (api 57).
  const missionCapped = () => { const P = D().points || {}; return !!P.missionCap && ((P.missionToday || {})[S.me] || 0) >= P.missionCap; };
  const isQuick = (r) => { const t = String(r.type || '').toLowerCase(); return !['meal_request', 'have_check', 'helped', 'rate', 'still'].includes(t) && ['due', 'mission', 'settle'].indexOf(sectionOf(r)) < 0; };
  // Catch-up bonus (api 58): below the week's top score → 1.5× (at least +1). The backend does the real count.
  const behindNow = (who) => { const P = D().points || {}; return !!P.catchup && !!(P.behind || {})[who]; };
  const boostPts = (p, who) => { const P = D().points || {}; return p > 0 && behindNow(who) ? Math.max(p + 1, Math.floor(p * P.catchup)) : p; };
  function cardPoints(r, answer) {
    const base = basePoints(r, answer);
    return boostPts(base, r.type === 'helped' ? String(r.points_to || '') : S.me);
  }
  function basePoints(r, answer) {
    const a = String(answer || '').trim().toLowerCase();
    const t = String(r.type || '').toLowerCase();
    if (a === 'skip') return 0;
    if (t === 'meal_request') return /^cancel/.test(a) ? 0 : rulePts('approve');
    if (t === 'have_check') return rulePts('approve');
    if (t === 'helped') return answer === undefined ? rulePts('helped_cooked') : /^cooked/.test(a) ? rulePts('helped_cooked') : /^helped/.test(a) ? rulePts('helped_helped') : 0;
    const sec = sectionOf(r);
    if (t === 'prize') return rulePts('other');
    if (sec === 'due') return rulePts(r.due_at && new Date() > new Date(String(r.due_at)) ? 'task_late' : 'task');
    if (sec === 'mission') return missionCapped() ? 0 : rulePts('check');
    if (sec === 'settle') return rulePts('settle') || 3;
    if (t === 'rate' || t === 'still') return rulePts(t);
    return quickCapped() ? 0 : rulePts('other');
  }
  // Scoring starts on Settings points_start (api 18). Before that day the scoreboard says so and nothing shows points.
  const preStart = () => { const st = D().points && D().points.start; return !!(st && D().today && D().today < st); };
  function pointsStartLine() {
    const st = D().points && D().points.start;
    return st ? 'Scoring started ' + fmtDate(st) + '; everyone began at 0 and nothing before that day counts.' : 'Points started Nov 1, 2026; answers before that have none.';
  }
  function viewScoreboard() {
    if (!canPoints()) return '';
    if (preStart()) {
      return '<section class="card score"><div class="score-me"><div class="ring" style="--p:0"><b>0</b><span>/' + (D().points.goal || 10) + '</span></div>' +
        '<div><b>🏁 Scoring starts ' + (addDays(D().today, 1) === D().points.start ? 'tomorrow' : fmtDate(D().points.start)) + '</b><span class="note">Everyone starts at 0. Read the rules now so you’re ready.</span></div></div>' +
        '<div class="score-links"><button type="button" class="link-btn" data-act="points-open" data-tab="rules">ⓘ How points work</button></div></section>';
    }
    const P = D().points, me = S.me;
    const mine = P.today[me] || 0, goal = P.goal || 10, streak = P.streak[me] || 0;
    const pct = Math.min(100, Math.round(100 * mine / goal));
    const people = Object.keys(P.week || {}).sort((a, b) => (P.week[b] || 0) - (P.week[a] || 0));
    const winners = String(P.lastWeekWinner || '').split(' + ');
    return '<section class="card score"><div class="score-me">' +
      '<div class="ring" style="--p:' + pct + '"><b>' + mine + '</b><span>/' + goal + '</span></div>' +
      '<div><b>' + (mine >= goal ? '🎉 Daily goal done!' : (goal - mine) + (goal - mine === 1 ? ' point' : ' points') + ' to today’s goal') + '</b>' +
      '<span class="note">' + (streak ? '🔥 ' + streak + '-day streak' : 'Hit ' + goal + ' today to start a streak') + '</span></div></div>' +
      '<div class="board">' + people.map((p, i) => '<div class="board-p' + (p === me ? ' me' : '') + '"><span class="board-n">' + (winners.indexOf(p) >= 0 ? '👑 ' : '') + esc(p) + '</span><b>' + (P.week[p] || 0) + '</b>' +
        ((P.streak[p] || 0) ? '<span class="board-s">🔥' + P.streak[p] + '</span>' : '') + '</div>').join('') + '</div>' +
      '<div class="note board-foot">This week’s points (Mon–Sun)' + (P.lastWeekWinner ? ' · 👑 last week: ' + esc(P.lastWeekWinner) : '') + '</div>' + (P.prize ? '<div class="note board-foot">🏆 Prize: ' + esc(P.prize) + '</div>' : '') + catchupLine() + raceLine() +
      '<div class="score-links"><button type="button" class="link-btn" data-act="points-open" data-tab="rules">ⓘ How points work</button>' +
      '<button type="button" class="link-btn" data-act="points-open" data-tab="history">📜 Points history</button></div></section>';
  }

  /* How points work + Points history (one sheet, two tabs). History needs api 14 (pointsLog). */
  function viewPointsSheet(sh) {
    const head = '<div class="is-head"><div><h2>' + (sh.tab === 'history' ? '📜 Points history' : 'ⓘ How points work') + '</h2></div><button class="x-btn" data-act="close-x" aria-label="Close">✕</button></div>' +
      '<div class="seg"><button type="button" data-act="points-tab" data-tab="rules" class="' + (sh.tab === 'rules' ? 'on' : '') + '">How it works</button>' +
      '<button type="button" data-act="points-tab" data-tab="history" class="' + (sh.tab === 'history' ? 'on' : '') + '">History</button></div>';
    return head + '<div class="pts-body">' + (sh.tab === 'history' ? viewPointsHistory(sh) : viewPointsRules()) + '</div>';
  }
  function viewPointsRules() {
    const P = D().points || {}, goal = P.goal || 10;
    const row = (x) => '<div class="pr-row"><span class="pr-what">' + x.icon + ' ' + esc(x.label) + (x.cap ? '<span class="pr-cap">up to ' + x.cap + ' a day</span>' : '') + '</span><b class="pr-pts">+' + x.pts + '</b></div>';
    const rules = pointRules();
    const family = rules.filter((x) => ruleGroup(x) === 'family');
    return '<h3 class="pr-h">📥 Inbox cards</h3>' +
      '<p class="note">Answer a card in your Inbox and you get its points. Every card shows what it’s worth in its top corner.</p>' +
      '<div class="pr-table">' + rules.filter((x) => ruleGroup(x) === 'inbox').map(row).join('') + '</div>' +
      (family.length ? '<h3 class="pr-h">🛒 Helping plan and shop</h3>' +
        '<p class="note">Poppy works best when everyone pitches in on what we eat and buy, so these count too.</p>' +
        '<div class="pr-table">' + family.map(row).join('') + '</div>' +
        '<ul class="pr-list"><li>A kid’s add is a request: it earns its point when a parent approves it. A skipped request earns nothing.</li>' +
        '<li>Adding something that’s already on the List counts if you weren’t on it yet (you show up as “asked by … + you”).</li>' +
        '<li>Approve and Skip both count for the parent: saying no is a decision too (that includes answering a kid’s “we have it”).</li></ul>' : '') +
      ((D().points || {}).catchup ? '<h3 class="pr-h">⚡ Catch-up bonus</h3><p class="note">Not in first place this week? Everything you score pays <b>' + D().points.catchup + '×</b> (always at least +1 extra): a +1 card pays +2, a +3 mission +4, Due soon +7, Cooked it +15. It switches off the moment you’re in first (or tied for first) and back on if someone passes you. Monday everyone starts at 0, so nobody has it until someone scores. Every point always counts; nothing stops paying.</p>' : '') +
      viewRaceRules() +
      '<h3 class="pr-h">🧑‍🍳 Kitchen help</h3>' +
      '<p class="note">The day after a planned dinner, a parent gets a card for each kid: “Did <i>kid</i> help cook <i>dinner</i>?” The points go to the <b>kid</b>, not to the parent who answers.</p>' +
      '<div class="pr-table">' + rules.filter((x) => ruleGroup(x) === 'kitchen').map(row).join('') + '<div class="pr-row"><span class="pr-what">🧑‍🍳 Kitchen help: Not this time</span><b class="pr-pts zero">0</b></div></div>' +
      '<h3 class="pr-h">What earns nothing</h3>' +
      '<ul class="pr-list"><li><b>Don’t care</b>, <b>Pass ↗</b> and <b>Later</b>: 0 (a Later card still pays when you answer it).</li>' +
      (P.quickCap ? '<li>💬 Quick cards past the first ' + P.quickCap + ' in a day. Keep answering them (they still teach Poppy), they just don’t add to the leaderboard.</li>' : '') +
      (P.missionCap ? '<li>🔎 Missions past the first ' + P.missionCap + ' in a day. Still worth doing (they keep the List honest), they just don’t add points. So take your time and really go look.</li>' : '') +
      (P.quickCap ? '<li>Did we get it?, How was it?, Due soon, Kitchen help and helping plan and shop have no such limit.</li>' : '') +
      (family.length ? '<li>Adds past the daily limit, a kid’s request a parent skips, and adding a whole meal’s ingredients at once.</li><li>Cancelling your own meal request.</li>'
        : '<li>Asking for a meal, approving the kids’ requests, adding to the List (coming with the next server update).</li>') +
      '<li>Kitchen help cards nobody answers close after 3 days with no points.</li></ul>' +
      '<h3 class="pr-h">Good to know</h3>' +
      '<ul class="pr-list"><li>Typing your own answer (“Something else? Type it”) counts the same as tapping one.</li>' +
      '<li>Each card pays once, to whoever answered it. A card someone passed to you is yours to score.</li>' +
      '<li>Due soon cards pay ' + rulePts('task') + ' until their deadline, then ' + rulePts('task_late') + '.</li>' +
      (Number(D().api || 0) >= 21 ? '<li>🔎 Missions are how the List gets checked: Poppy picks what to look for. When a kid says we have something (on a mission or on the List), a parent gets “Take it off the List?” and nothing comes off until they say yes. Tapping items on the List yourself earns no points.</li>' : '') +
      '<li>The “+5” on your phone is a preview; Poppy’s server does the real count, so the numbers can shift a little on the next refresh.</li></ul>' +
      '<h3 class="pr-h">🎯 Daily goal</h3>' +
      '<p class="note">' + goal + ' points in one day (midnight to midnight). The ring on top of the Inbox fills as you go.</p>' +
      '<h3 class="pr-h">🔥 Streaks</h3>' +
      '<p class="note">Days in a row you hit the daily goal. Today joins your streak once you reach ' + goal + '. Not there yet today? Your streak is safe until midnight. Miss a whole day and it starts over.</p>' +
      '<h3 class="pr-h">🏆 Leaderboard and 👑</h3>' +
      '<p class="note">The leaderboard adds up points from Monday to Sunday and starts over every Monday. Whoever had the most points last week wears the 👑 all this week; a tie crowns everyone tied. ' + ((D().points || {}).prize ? '🏆 The prize: <b>' + esc(D().points.prize) + '</b>. On the first open of the week the winner gets a card to make their pick, and it goes straight on the List.' : 'Any prize is up to Mom and Dad.') + '</p>' +
      '<h3 class="pr-h">📜 The record</h3>' +
      '<p class="note">Everything that scores is saved with the time, who got the points, how many, and why. See it in <button type="button" class="link-btn inline" data-act="points-tab" data-tab="history">History</button>. ' + pointsStartLine() + '</p>';
  }
  /* The girls' race (api 32): kids get more scoring cards, and whoever is behind this week gets extra missions. */
  function viewRaceRules() {
    const X = (D().points || {}).extra;
    if (!X) return '';
    const m = X.missions;
    return '<h3 class="pr-h">⚡ Kids get more chances</h3>' +
      '<p class="note">The leaderboard is a race, and the kids get more ways to score than Mom and Dad. Same points per card for everyone; the kids just get more cards.</p>' +
      '<ul class="pr-list"><li><b>🔎 Missions every day:</b> whoever is <b>behind</b> this week gets <b>' + m.behind + '</b>, the leader gets ' + m.lead + ', and when you’re tied you each get ' + m.tied + '. Extra ones say “⚡ Catch-up mission!”. Parents don’t get missions. On school days (Mon–Fri, 7:30 to 4:30) missions wait for home; tap “I’m home” if you’re home early.</li>' +
      '<li><b>🧾 Did we get it?:</b> each kid gets up to ' + X.settle + ' a day, and whoever is behind gets first pick.</li>' +
      '<li><b>💬 Questions:</b> kids’ decks are kept fuller (' + X.qa + ' cards) than the parents’.</li>' +
      '<li>“Behind” is checked once a day, when the day’s cards are made, using this week’s points (Mon–Sun). Pass your sister and the extra missions switch to her the next day.</li></ul>';
  }
  function catchupLine() {
    const P = D().points || {};
    if (!P.catchup) return '';
    return behindNow(S.me) ? '<div class="note board-foot">⚡ Catch-up bonus is on for you: every card pays ' + P.catchup + '× until you’re in first.</div>' : '';
  }
  function raceLine() {
    const P = D().points || {};
    if (!P.extra || !isKid(S.me)) return '';
    const kids = D().settings.kids.filter((k) => P.week && k in P.week);
    if (kids.length < 2) return '';
    const top = Math.max.apply(null, kids.map((k) => P.week[k] || 0));
    const mine = P.week[S.me] || 0;
    if (kids.every((k) => (P.week[k] || 0) === top)) return '<div class="note board-foot">⚡ Tied! You each get ' + P.extra.missions.tied + ' missions tomorrow.</div>';
    return mine < top ? '<div class="note board-foot">⚡ You’re ' + (top - mine) + ' behind: ' + P.extra.missions.behind + ' missions for you tomorrow. Catch up!</div>'
      : '<div class="note board-foot">⚡ You’re in the lead! Whoever is behind gets extra missions, so keep going.</div>';
  }
  function viewPointsHistory(sh) {
    if (Number(D().api || 0) < 14) return '<p class="note">History shows once the latest server update is live.</p>';
    if (!sh.log) return '<p class="note">Loading the record…</p>';
    if (sh.log.failed) return '<p class="note">Couldn’t load the history.</p><button class="btn btn-plain btn-block" data-act="points-reload">Try again</button>';
    const L = sh.log, who = sh.who || '';
    const names = D().settings.parents.concat(D().settings.kids).filter((p) => L.weeks.some((w) => w.totals[p]) || p === S.me);
    const pills = '<div class="pill-scroll">' + [['', 'Everyone']].concat(names.map((p) => [p, p])).map((x) =>
      '<button type="button" class="pill small' + (who === x[0] ? ' on' : '') + '" data-act="points-who" data-v="' + esc(x[0]) + '">' + esc(x[1]) + '</button>').join('') + '</div>';
    const weekLabel = (mon) => mon === (D().points || {}).weekStart ? 'This week' : 'Week of ' + fmtDate(mon);
    const weeks = L.weeks.slice(0, 8).map((w) => {
      const ppl = Object.keys(w.totals).filter((p) => !who || p === who).sort((a, b) => w.totals[b] - w.totals[a]);
      if (!ppl.length) return '';
      const live = w.weekStart === (D().points || {}).weekStart;
      return '<div class="ph-week"><div class="ph-wk">' + weekLabel(w.weekStart) + '</div>' + ppl.map((p) =>
        '<div class="ph-wrow"><span>' + (!live && w.winners.indexOf(p) >= 0 ? '👑 ' : '') + esc(p) + '</span><span class="note">' +
        (w.goalDays[p] ? '🎯 ' + w.goalDays[p] + (w.goalDays[p] === 1 ? ' goal day' : ' goal days') : '') + '</span><b>' + w.totals[p] + '</b></div>').join('') + '</div>';
    }).join('');
    const rows = L.entries.filter((e) => !who || e.to === who);
    let day = '', list = '';
    rows.slice(0, 200).forEach((e) => {
      const d = e.at.slice(0, 10);
      if (d !== day) { day = d; list += '<div class="ph-day">' + (d === D().today ? 'Today' : fmtDate(d)) + '</div>'; }
      const t = e.at.slice(11, 16);
      const hh = Number(t.slice(0, 2)), time = t ? ((hh % 12) || 12) + ':' + t.slice(3) + (hh < 12 ? ' am' : ' pm') : '';
      const forOther = e.by && e.by !== e.to;
      list += '<div class="ph-row"><b class="ph-pts' + (e.capped ? ' zero' : '') + '">+' + e.pts + '</b><div class="ph-body"><div><b>' + esc(e.to) + '</b> · ' + esc(e.label) + (e.bonus ? ' <span class="note">· ⚡ +' + e.bonus + ' catch-up</span>' : '') + (e.capped ? ' <span class="note">· past the day’s ' + (e.capWhy === 'check' ? (L.missionCap || '') + ' missions' : (L.quickCap || '') + ' quick cards') + '</span>' : '') + '</div>' +
        '<div class="note">' + esc(e.q) + (e.answer ? ' → <i>' + esc(e.answer) + '</i>' : '') + '</div>' +
        '<div class="note ph-meta">' + time + (forOther ? ' · answered by ' + esc(e.by) : '') + '</div></div></div>';
    });
    return pills +
      (weeks ? '<h3 class="pr-h">Weekly totals</h3>' + weeks : '') +
      '<h3 class="pr-h">Every point</h3>' +
      (list || '<p class="note">No points yet' + (who ? ' for ' + esc(who) : '') + '. Answer a card in the Inbox to start.</p>') +
      (rows.length > 200 ? '<p class="note">Showing the latest 200.</p>' : '') +
      '<p class="note">The full record lives in the family Sheet: Inbox answers on the Review tab (answered_at, points, points_to, points_why), everything else on the Points tab.</p>';
  }
  function loadPointsLog() {
    const mine = S.sheet;
    if (!mine || mine.type !== 'points' || Number(D().api || 0) < 14) return;
    mine.log = null;
    api('pointsLog', {}).then((j) => { mine.log = j.result || { entries: [], weeks: [] }; if (S.sheet === mine) render(); })
      .catch(() => { mine.log = { failed: true }; if (S.sheet === mine) render(); });
  }
  // Count the points right away on this phone so the ring moves; the next state from the backend wins.
  function bumpPoints(r, value) {
    if (!canPoints() || preStart()) return '';
    const P = D().points;
    if (P.quickCap && isQuick(r) && String(value || '').trim().toLowerCase() !== 'skip') {
      P.quickToday = P.quickToday || {};
      const n = P.quickToday[S.me] || 0;
      P.quickToday[S.me] = n + 1;
      if (n >= P.quickCap) return '+0 · past today’s ' + P.quickCap + ' quick cards';
    }
    if (P.missionCap && sectionOf(r) === 'mission' && String(value || '').trim().toLowerCase() !== 'skip') {
      P.missionToday = P.missionToday || {};
      const n = P.missionToday[S.me] || 0;
      P.missionToday[S.me] = n + 1;
      if (n >= P.missionCap) return '+0 · past today’s ' + P.missionCap + ' missions';
    }
    const pts = cardPoints(r, value);
    if (!pts) return '';
    const to = r.type === 'helped' ? String(r.points_to || '') : S.me;
    const before = P.today[to] || 0;
    P.today[to] = before + pts; P.week[to] = (P.week[to] || 0) + pts;
    if (to !== S.me) return '+' + pts + ' for ' + to;
    if (before < P.goal && before + pts >= P.goal) { P.streak[to] = (P.streak[to] || 0) + 1; return '🎉 Daily goal! +' + pts; }
    return '+' + pts + ' points' + (behindNow(S.me) ? ' · ⚡ catch-up' : '');
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
    const top = viewScoreboard() + viewApprovals() + viewHomeWaiting();
    if (!deck.length) {
      const napping = myQuestions(true).length, nb = nextBack();
      const when = nb ? (nb.toDateString() === new Date().toDateString() ? 'at ' + nb.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'tomorrow') : '';
      return top + '<div class="ask-done"><div class="ask-done-mark">✓</div><b>All caught up</b><span class="note">' +
        (napping ? napping + (napping === 1 ? ' card' : ' cards') + ' put off; the next one is back ' + when + '. ' : '') +
        (heldVotes().length ? heldVotes().length + (heldVotes().length === 1 ? ' meal vote waits' : ' meal votes wait') + ' until the morning after that meal. ' : '') + 'Lunch picks, How was it?, missions and questions show up here.</span></div>' +
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

    // Missions (api 15): the level buttons above, plus "count them" for things you can count (eggs, yogurts).
    const isMission = r.type === 'check';
    if (isMission) {
      control = control.replace('class="pick-list"', 'class="pick-list mission-levels"') +
        '<form class="ask-text mission-count" data-form="ask-count" data-id="' + r.id + '"><label for="ask-count">Or count them</label>' +
        '<input id="ask-count" class="field" type="number" inputmode="numeric" min="0" max="999" placeholder="#" data-input="ask-draft" value="' + esc(S.askDraft || '') + '">' +
        '<button class="btn btn-primary" type="submit">Save</button></form>';
    }

    // api 61 (Nov 6, owner): plans change on the fly. Cards about a meal we just had get "Not what we had": it marks
    // that night as not made and clears the rest of that night's cards for everyone.
    const aboutLastNight = Number(D().api || 0) >= 61 && /\(m\d{2,}\)/.test(String(r.detail || '')) &&
      (r.type === 'rate' || r.type === 'helped' || (r.type === 'vote' && voteTiming(r) === 'after'));
    // Nov 7 (owner): a new recipe card goes to a parent to check. The card opens it right here; ✕ comes back to the Inbox.
    const cardMeal = r.type === 'recipe_check' ? (String(r.detail || '').match(/\((m\d{2,})\)/) || [])[1] : '';
    if (cardMeal && recipeOf(cardMeal)) control = '<button type="button" class="btn btn-outline btn-block recipe-btn" data-act="open-recipe" data-from="inbox" data-id="' + esc(cardMeal) + '">🖨 See the recipe card<small>' + esc((mealById(cardMeal) || {}).name || '') + '</small></button>' + control;
    if (aboutLastNight) control += '<button type="button" class="link-btn not-had" data-act="ask-nothad" data-id="' + r.id + '">🔄 Not what we had</button>';

    const textBox = '<form class="ask-text" data-form="ask-text" data-id="' + r.id + '"><label class="sr" for="ask-in">Answer</label>' +
      // A multi-line box: the phone's return key adds a line instead of sending a half-typed answer (a kid's
      // 💡 idea, Nov 6). Only Save sends.
      '<textarea id="ask-in" class="field" data-input="ask-draft" rows="2" enterkeyhint="enter" placeholder="' + (kind === 'text' ? 'Type an answer…' : 'Type your answer…') + '">' + esc(S.askDraft || '') + '</textarea>' +
      '<button class="btn btn-primary" type="submit">Save</button></form>';

    const sec = SECTIONS[sectionOf(r)];
    let html = top + viewSectionChips() + '<div class="ask-progress"><span>' + pos + ' of ' + total + '</span><div class="bar"><i style="width:' + Math.round(100 * (pos - 1) / total) + '%"></i></div></div>';
    html += '<section class="qcard" data-swipe="' + (kind === 'yesno' ? 'yesno' : 'later') + '" data-id="' + r.id + '">' +
      (r.passed_by && String(r.passed_by).toLowerCase() !== String(S.me).toLowerCase() ? '<div class="passed-note">' + esc(r.passed_by) + ' passed this to you</div>' : '') +
      '<div class="qcard-sec"><span>' + sec.icon + ' ' + esc(sec.label) + '</span>' + (canPoints() && !preStart() ? '<span class="qcard-pts">' + (r.type === 'helped' ? 'up to +10 for ' + esc(r.points_to || 'them') : ((isQuick(r) && quickCapped()) || (sectionOf(r) === 'mission' && missionCapped()) ? '+0 today' : '+' + cardPoints(r) + (behindNow(r.type === 'helped' ? String(r.points_to || '') : S.me) && cardPoints(r) ? ' ⚡' : ''))) + '</span>' : '') + '</div>' +
      voteTagHtml(r) +
      '<div class="qcard-q">' + esc(voteQuestion(r, sp.q).replace(/\s*\((i\d{3,}|m\d{2,}|x\d{3,}|r\d{3,}|L\d{4,}|order \w+|meal m\d+|\d{4}-\d\d-\d\d)\)/g, '')) + '</div>' + control + (isMission ? '' : typing ? textBox :
        (kind !== 'text' ? '<button type="button" class="link-btn" data-act="ask-type" data-id="' + r.id + '">Something else? Type it</button>' : '')) +
      (S.askPassing === r.id ? viewPassPicker(r) : S.askSnoozing === r.id ? viewSnoozePicker(r) :
      '<div class="qcard-foot"><button type="button" class="btn btn-plain" data-act="review-skip" data-id="' + r.id + '">Don’t care</button>' +
      (canPass() ? '<button type="button" class="btn btn-plain" data-act="ask-pass" data-id="' + r.id + '">Pass ↗</button>' : '') +
      '<button type="button" class="btn btn-plain" data-act="ask-later" data-id="' + r.id + '">Later →</button>' + '</div>') + '</section>';
    if (deck.length > 1) html += '<div class="deck-edge"></div>';
    const isSettle = r.type === 'settle' || r.type === 'settle_order' || r.type === 'settle_meal';
    html += '<p class="hint">' + (isSettle ? (r.type === 'settle_meal' ? 'Take them off clears them from the List; Keep them leaves them as regular items. ' : r.type === 'settle_order' ? 'Yes takes the whole cart off the List. Some of it asks about each thing. ' : isKid(S.me) ? 'Go look where it lives (fridge, pantry, bathroom). It’s here takes it off the List. ' : 'Got it or Don’t need it takes it off the List; Still need it keeps it there. ') : '') + (isMission ? 'Go take a look, then tap what you found. A little or Out puts it on the List' + (isKid(S.me) ? ' for a parent to OK' : '') + '. ' : '') + (kind === 'yesno' ? 'Swipe the card right for yes, left for no. ' : '') + 'Answers teach Poppy what the family likes. A parent makes the final call.</p>';
    return html;
  }

  // What a vote card says: right after the meal it asks how it was; otherwise a line says whether we've had it.
  function voteMealName(r) { const m = mealById(voteMealId(r)); return m ? m.name : ''; }
  function voteQuestion(r, q) {
    if (voteTiming(r) !== 'after' || !voteMealName(r)) return q;
    const st = (D().mealStats || {})[voteMealId(r)];
    const when = st.last === addDays(D().today, -1) ? 'yesterday' : st.last === D().today ? 'today' : 'on ' + dayName(st.last);
    return 'You had ' + voteMealName(r) + ' ' + when + '. How was it?';
  }
  function voteTagHtml(r) {
    const t = voteTiming(r);
    if (!t) return '';
    const st = (D().mealStats || {})[voteMealId(r)] || {};
    const txt = t === 'after' ? '🍽 Right after the meal' : t === 'new' ? '🆕 Haven’t tried it yet · would you want it?' : t === 'had' ? '🍽 Last had ' + (st.last ? shortDay(st.last) : 'a while ago') : '';
    return txt ? '<div class="vote-tag">' + esc(txt) + '</div>' : '';
  }

  function resetAskCard() { S.askTyping = null; S.askDraft = ''; S.askSel = ''; S.askPassing = null; S.askSnoozing = null; }

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
      const card = D().review.find((r) => r.id === id);
      const won = card ? bumpPoints(card, value) : '';
      act('reviewAnswer', { id: id, answer: value + ' (' + S.me + ')' }, () => { D().review = D().review.filter((r) => r.id !== id); }, won || toastMsg || 'Got it');
    });
  }

  /* ---------- cart jobs (api 12) ---------- */
  const canJobs = () => Number(D().api || 0) >= 12;
  const JOB_OPEN = ['queued', 'running', 'waiting'];
  const jobs = () => (D().cartJobs || []).filter((j) => j.kind !== 'signin' && j.kind !== 'all');
  // Sign-in checks and "Laptop's on: update everything" runs (kind all, api 50): store ALL, shown only in the top card.
  const signinJobs = () => (D().cartJobs || []).filter((j) => j.kind === 'signin' || j.kind === 'all');
  // Stores ready (api 42): is each store signed in on the cart computer? From Settings via the cart runner.
  function signinState() {
    const st = D().settings || {};
    const ok = st.stores_ok || {};
    const checked = String(st.stores_checked || '');
    const open = signinJobs().find((j) => JOB_OPEN.indexOf(j.status) >= 0);
    const fresh = checked && (Date.now() - new Date(checked.replace(' ', 'T')).getTime()) < 2 * 86400000;
    const out = CART_STORES.filter((k) => ok[k] === 'out');
    return { ok: ok, checked: checked, open: open, fresh: fresh, out: fresh ? out : [] };
  }
  // On the List, for parents: a store is signed out on the cart computer (tap → Carts, where Check sign-ins is).
  function viewSigninWarn() {
    if (Number(D().api || 0) < 42 || !amParent() || !canCarts()) return '';
    const si = signinState();
    if (!si.out.length || si.open) return '';
    return '<button class="job-banner warn" data-act="cart-open" data-store="">' + esc('⚠ ' + si.out.map((k) => storeOf(k).name).join(', ') + ' signed out on the home computer. Sign in there, then tap Laptop’s on on the Carts screen.') + '</button>';
  }
  function viewSignins() {
    if (Number(D().api || 0) < 42) return '';
    const s = signinState();
    const dots = CART_STORES.map((k) => '<span class="sdot ' + (s.fresh && s.ok[k] ? s.ok[k] : 'unk') + '">' + esc(storeOf(k).name) + '</span>').join('');
    let text;
    if (s.open && s.open.status === 'running') text = '🔄 Checking sign-ins now; the carts are next…';
    else if (s.open) text = '⏳ Checking all stores: waiting for the home computer';
    else if (!s.checked) text = 'Store sign-ins haven’t been checked yet';
    else if (s.out.length) text = '⚠ Signed out: ' + s.out.map((k) => storeOf(k).name).join(', ') + '. Sign in on the home computer, then check again.';
    else text = (s.fresh ? '✓ All signed in' : 'Last checked') + ' · ' + fmtWhen(s.checked);
    return '<section class="card signins"><div class="signin-dots">' + dots + '</div><div class="signin-text">' + esc(text) + '</div>' +
      (amParent() ? '<button class="btn btn-outline btn-sm" data-act="cart-job" data-kind="signin" data-store="ALL"' + (s.open ? ' disabled' : '') + '>↻ Check all stores</button><p class="note">Checks each store’s sign-in and re-reads every cart and total, a few minutes apart.</p>' : '') + '</section>';
  }
  // One stamp everywhere (Mike, Nov 5): "Nov 5, 9:45 am"; a date with no time reads "Nov 5".
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtWhen(iso) {
    const s = String(iso || '');
    // "2026-11-02T08:37:00", the older "2026-11-02 8:37:00" (space, one-digit hour) and a bare "2026-11-02" all read.
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
    if (!m) return '';
    const day = MON[Number(m[2]) - 1] + ' ' + Number(m[3]);
    if (m[4] == null) return day;
    let h = Number(m[4]);
    const ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return day + ', ' + h + ':' + m[5] + ' ' + ap;
  }
  const daysSince = (iso) => Math.round((new Date(D().today + 'T12:00:00') - new Date(String(iso).slice(0, 10) + 'T12:00:00')) / 86400000);
  // Latest job for a store + kind (newest first from the backend).
  const latestJob = (store, kind) => jobs().find((j) => j.store === store && j.kind === kind);
  function jobLine(j) {
    const st = storeOf(j.store).name;
    const what = j.kind === 'check' ? 'check the ' + st + ' cart' : (canCarts() ? 'update' : 'build') + ' the ' + st + ' cart';
    if (j.status === 'queued') return { cls: 'wait', text: 'Waiting for Claude to ' + what + ' · ' + j.by + ' ' + fmtWhen(j.at) + '. It runs when the cart computer is on with Chrome open.' };
    if (j.status === 'waiting') return { cls: 'wait', text: 'Still waiting to ' + what + (j.result ? ': ' + j.result : '') + '. Claude tries again when the cart computer is on.' };
    if (j.status === 'running') return { cls: 'run', text: 'Claude is working on it now (' + what + ')…' };
    if (j.status === 'done') return { cls: 'done', text: (j.kind === 'check' ? 'Cart checked ' : canCarts() ? 'Cart updated ' : 'Cart built ') + fmtWhen(j.finished_at || j.at) + (j.result ? ': ' + j.result : '') };
    if (j.status === 'failed') return { cls: 'fail', text: 'Couldn’t ' + what + (j.result ? ': ' + j.result : '') };
    if (j.status === 'cancelled') return { cls: 'off', text: 'Cancelled ' + fmtWhen(j.finished_at || j.at) };
    return { cls: 'off', text: j.status };
  }
  function jobRow(j) {
    const l = jobLine(j);
    const cancel = amParent() && (j.status === 'queued' || j.status === 'waiting') ? '<button class="btn btn-plain btn-sm" data-act="job-cancel" data-id="' + esc(j.id) + '">Cancel</button>' : '';
    return '<div class="job job-' + l.cls + '"><span>' + esc(l.text) + '</span>' + cancel + '</div>';
  }
  // A one-line heads-up on the List while a job is open, or for 12 hours after a build finishes.
  function viewJobBanner() {
    if (!canJobs()) return '';
    const now = Date.now();
    const recent = (j) => j.status === 'done' && j.kind === 'build' && j.finished_at && now - new Date(String(j.finished_at)).getTime() < 12 * 3600000;
    const shown = jobs().filter((j) => JOB_OPEN.indexOf(j.status) >= 0 || recent(j));
    if (!shown.length) return '';
    return shown.map((j) => {
      const st = storeOf(j.store).name;
      let text;
      if (j.status === 'running') text = '🛒 Claude is ' + (j.kind === 'check' ? 'checking' : canCarts() ? 'updating' : 'filling') + ' the ' + st + ' cart now';
      else if (j.status === 'done') text = '🛒 ' + st + ' cart is ready' + (j.result ? ': ' + j.result : '') + '. Review it and check out on the ' + st + ' site or app.';
      else text = '🛒 ' + st + ' cart ' + (j.kind === 'check' ? 'check' : canCarts() ? 'update' : 'build') + ' is waiting for Claude';
      return '<button class="job-banner' + (j.status === 'done' ? ' done' : '') + '" data-act="' + (canCarts() ? 'cart-open' : 'tab') + '" data-store="' + j.store + '" data-tab="' + (isAdmin() ? 'admin' : 'list') + '">' + esc(text) + '</button>';
    }).join('');
  }

  /* ---------- order ---------- */
  // Before Build the cart (api 23): List rows headed to this store that another store sells for 10%+ and $0.50+
  // less. Nothing moves on its own: a parent taps Get at <store> (the row's store changes) or keeps them.
  function cheaperNote(code) {
    const rows = D().list.filter((r) => r.status === 'needed' && (r.store || 'Either') === code).map((r) => ({ r: r, c: rowCheaper(r) })).filter((x) => x.c);
    if (!rows.length) return '';
    const save = rows.reduce((t, x) => t + x.c.save * (Number(x.r.qty) || 1), 0);
    const to = {};
    rows.forEach((x) => (to[x.c.store] = (to[x.c.store] || 0) + 1));
    const where = Object.keys(to).map((k) => storeOf(k).name).join(' or ');
    const key = 'cheaper-' + code;
    const open = S.cheaperOpen === key;
    return '<div class="cheaper"><button class="cheaper-head" data-act="cheaper-fold" data-key="' + key + '">' + rows.length + (rows.length === 1 ? ' item is' : ' items are') + ' cheaper at ' + esc(where) +
      ' (about $' + Math.round(save) + ' less) ' + chev(!open) + '</button>' + (open ? rows.map((x) =>
        '<div class="cheaper-row"><span>' + esc(x.r.name) + ' <span class="note">' + Math.round(x.c.pct * 100) + '% less</span></span>' +
        '<button class="btn btn-plain" data-act="price-move" data-id="' + x.r.id + '" data-store="' + x.c.store + '">Get at ' + esc(storeOf(x.c.store).short || storeOf(x.c.store).name) + '</button></div>').join('') +
        '<p class="note">Moving an item only changes which cart it goes in. Keep the rest here as they are.</p>' : '') + '</div>';
  }

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
      const head = '<div class="store-title"><b class="head-' + st.cls + '">' + st.name + '</b><span class="note">' + count(code) + (count(code) === 1 ? ' item' : ' items') + (day ? ' · usually ' + esc(day) : '') + (inCart ? ' · ' + inCart + ' in the online cart' : '') + '</span></div>';
      if (canJobs()) {
        const b = latestJob(code, 'build');
        const c = latestJob(code, 'check');
        const busy = (j) => j && JOB_OPEN.indexOf(j.status) >= 0;
        const lines = [b, c].filter((j) => j && j.status !== 'cancelled' && (busy(j) || daysSince(String(j.finished_at || j.at).slice(0, 10)) <= 3)).map(jobRow).join('');
        html += '<section class="card store-card">' + head + lines + (amParent() ? cheaperNote(code) : '') +
          (amParent() ? '<div class="job-btns"><button class="btn ' + (code === 'GE' ? 'btn-primary' : 'btn-outline') + '" data-act="cart-job" data-kind="build" data-store="' + code + '"' + (n && !busy(b) ? '' : ' disabled') + '>Build the cart</button>' +
            '<button class="btn btn-outline" data-act="cart-job" data-kind="check" data-store="' + code + '"' + (busy(c) ? ' disabled' : '') + '>Check the cart</button></div>' : '') +
          '</section>';
        return;
      }
      html += '<section class="card store-card">' + head +
        (amParent() ? '<button class="btn ' + (code === 'GE' ? 'btn-primary' : 'btn-outline') + ' btn-block" data-act="request-order" data-store="' + code + '"' + (n ? '' : ' disabled') + '>Ask Claude to build the ' + st.name + ' cart</button>' : '') +
        '</section>';
    });
    if (requested && !canJobs()) {
      html += '<section class="card store-card"><div class="note"><b>Cart requested:</b> ' + esc(requested) + '. Claude fills the cart on the home computer, then any swaps show up in Ask.</div>' +
        (amParent() ? '<button class="btn btn-plain" data-act="clear-order">Clear</button>' : '') + '</section>';
    }
    html += '<p class="hint">' + (canJobs() ? '<b>Build</b> fills the store’s online cart from the List. <b>Check</b> reads what’s in the cart (even things added on the store’s site) and tags those List rows “In cart”. Claude does both on the home computer, so it needs to be on with Chrome open; jobs wait until it is. ' : '') + 'Carts are filled for you to review. A person always taps checkout.</p>';
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
    if (sh.type === 'weekcost') inner = viewWeekCostSheet(sh);
    if (sh.type === 'points') inner = viewPointsSheet(sh);
    if (sh.type === 'pushall') inner = viewPushSheet(sh);
    if (sh.type === 'mealgaps') inner = viewMealGaps();
    if (sh.type === 'samekind') inner = viewSameKind(sh);
    if (sh.type === 'misshave') inner = viewMissHave(sh);
    if (sh.type === 'staples') inner = viewStaplesSheet();
    if (sh.type === 'me') inner = viewMeSheet();
    if (sh.type === 'feedback') {
      inner = '<h2>💡 Idea for Poppy</h2><p class="note">Something confusing, missing, or a great idea? Say it any way you like. Every one gets read.</p>' +
        '<label class="sr" for="fb-text">Your idea or feedback</label><textarea id="fb-text" class="field idea-text" data-input="draft" data-field="text" rows="6" placeholder="e.g. I wish I could see what’s for lunch tomorrow on the List">' + esc(sh.text || '') + '</textarea>' +
        '<div class="sheet-actions"><button class="btn btn-primary" data-act="save-feedback"' + (String(sh.text || '').trim() ? '' : ' disabled') + '>Send</button></div>' +
        (canIdeas() ? '<button class="link-btn" data-act="feedback-to-meal">Got a meal idea instead? Share it here →</button>' : '');
    }

    if (sh.type === 'recipe') inner = viewRecipeSheet(sh);

    if (sh.type === 'meal') {
      // Only items that match every word (no "closest" guesses: Trail Mix used to offer Muffin mix),
      // then always a way out: add it as a new item, or close the list.
      const q = String(sh.q || '').trim();
      const found = q ? findItems(q, D().items.filter((i) => i.status !== 'Drop')) : { all: false, hits: [] };
      const hits = (found.all ? searchItems(q, 5) : []).filter((i) => sh.item_ids.indexOf(i.id) < 0);
      const exact = q && D().items.some((i) => String(i.name).toLowerCase() === q.toLowerCase());
      inner = '<h2>' + (sh.id ? 'Edit meal' : 'New meal') + '</h2>' +
        '<div><label for="sh-mname">Name</label><input id="sh-mname" class="field" style="width:100%" data-input="draft" data-field="name" value="' + esc(sh.name) + '" placeholder="e.g. Taco night"></div>' +
        (canSlots() ? '<div><label>Usually for</label>' + seg('kind', SLOTS.map((x) => [x[0], x[1]]), sh.kind || 'dinner') + '</div>' : '') +
        (canMeatQty() && sh.id ? '<div><label>Meat to buy (each kind)</label>' + seg('meat_qty', [['1', '1'], ['2', '2 · make more'], ['3', '3']], sh.meat_qty || '1') +
          '<p class="note">How many of each meat go on the List when you add this meal’s ingredients.</p></div>' : '') +
        '<div><label>Ingredients</label><div class="ing-edit">' + (sh.item_ids.length ? sh.item_ids.map((id) => {
          const it = itemById(id);
          return it ? '<button type="button" data-act="ing-remove" data-id="' + id + '" aria-label="Remove ' + esc(it.name) + '">' + esc(it.name) + ' ✕</button>' : '';
        }).join('') : '<span class="note">None yet.</span>') + '</div></div>' +
        '<div style="position:relative"><label for="sh-mq">Add an ingredient</label><input id="sh-mq" class="field" style="width:100%" data-input="draft" data-field="q" value="' + esc(sh.q || '') + '" placeholder="Search staples…" autocomplete="off">' +
        (q ? '<div class="suggest suggest-inline">' +
          (hits.length ? '' : '<div class="s-none">Nothing we buy matches “' + esc(q) + '”.</div>') +
          hits.map((h) => '<button type="button" data-act="ing-add" data-id="' + h.id + '"><span class="s-name">' + esc(h.name) + '</span><span class="s-meta">' + esc(storeOf(h.store).name) + '</span></button>').join('') +
          (exact ? '' : '<button type="button" class="s-new" data-act="ing-new"' + (sh.creating ? ' disabled' : '') + '><span class="add-btn" aria-hidden="true">+</span><span class="s-name">' + (sh.creating ? 'Adding “' + esc(q) + '”…' : 'Add “' + esc(q) + '” as a new item') + '</span></button>') +
          '<button type="button" class="s-close" data-act="ing-clear">Close</button>' +
          '</div>' : '') + '</div>' +
        '<div class="sheet-actions"><button class="btn btn-primary" data-act="save-meal"' + (String(sh.name).trim() ? '' : ' disabled') + '>Save</button></div>';
    }

    const hasX = ['item', 'mealcard', 'recipe', 'ideaview', 'day', 'hearth', 'points', 'pushall', 'me'].indexOf(sh.type) >= 0;
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
    'ask-nothad': (el) => answerQuestion(el.dataset.id, 'Not what we had', 'left', 'Got it. Poppy won’t count that meal, and the other cards about it are cleared'),
    'ask-pick': (el) => answerQuestion(el.dataset.id, el.dataset.v, el.dataset.v === 'Yes' || /^yes/i.test(el.dataset.v) ? 'right' : 'left'),
    'ask-type': (el) => { S.askTyping = el.dataset.id; render(); const f = document.getElementById('ask-in'); if (f) f.focus(); },
    'ask-sel-save': (el) => { if (S.askSel) answerQuestion(el.dataset.id, S.askSel); },
    'ask-pass': (el) => { S.askSnoozing = null; S.askPassing = S.askPassing === el.dataset.id ? null : el.dataset.id; render(); },
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
    'im-home': () => { store.set(homeKey(), new Date().toDateString()); S.askSection = ''; showToast('🏠 Welcome home! Missions are open'); render(); },
    'ask-later': (el) => { const id = el.dataset.id; S.askPassing = null; S.askSnoozing = S.askSnoozing === id ? null : id; render(); },
    'ask-snooze': (el) => {
      const id = el.dataset.id, until = Number(el.dataset.until);
      setSnooze(id, until);
      S.askLater = (S.askLater || []).filter((x) => x !== id).concat([id]);
      const d = new Date(until);
      const msg = 'Back ' + (d.toDateString() === new Date().toDateString() ? 'at ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'tomorrow');
      flyCard('left', () => {
        resetAskCard();
        // api 10 saves it (later_count / later_at), so the morning check can retire a card put off 3 times.
        if (Number(D().api || 0) >= 10) {
          act('reviewLater', { id: id }, () => {
            const q = D().review.find((x) => x.id === id);
            if (q) { q.later_count = (Number(q.later_count) || 0) + 1; q.later_at = new Date().toISOString(); }
          }, msg);
        } else { showToast(msg); render(); }
      });
    },
    'review-skip': (el) => answerQuestion(el.dataset.id, 'skip', 'up', 'Skipped'),
    undo: () => { const u = S.toast && S.toast.undo; S.toast = null; if (u) u(); else render(); },

    'cheaper-fold': (el) => { S.cheaperOpen = S.cheaperOpen === el.dataset.key ? '' : el.dataset.key; render(); },
    'price-move': (el) => { const r = rowById(el.dataset.id); const to = el.dataset.store; if (r && to) act('update', { id: r.id, fields: { store: to } }, () => (r.store = to), r.name + ' will go in the ' + storeOf(to).name + ' cart'); },
    approve: (el) => { const r = rowById(el.dataset.id); if (r) act('update', { id: r.id, fields: { status: 'needed' } }, () => (r.status = 'needed'), 'Approved ' + r.name + ptsTag('approve')); },
    skip: (el) => { const r = rowById(el.dataset.id); if (r) setStatus(r, 'skipped', 'Skipped ' + r.name + (r.status === 'requested' ? ptsTag('approve') : '')); },
    restore: (el) => { const r = rowById(el.dataset.id); if (r) restore(r); },
    'toggle-day': (el) => { S.openDay = S.openDay === el.dataset.day ? null : el.dataset.day; render(); },
    ing: (el) => { const p = S.mealPick[el.dataset.day] || (S.mealPick[el.dataset.day] = {}); p[el.dataset.id] = p[el.dataset.id] === false; render(); },
    'add-meal': (el) => {
      if (isKid(S.me)) return; // only parents add a meal's ingredients
      const meal = mealById(el.dataset.id);
      const picks = S.mealPick[el.dataset.day] || {};
      const ids = mealItems(meal).filter((id) => itemById(id) && !isDelivery(itemById(id).store) && !listRowFor(id) && picks[id] !== false);
      if (!ids.length) return;
      const status = isKid(S.me) ? 'requested' : 'needed';
      S.openDay = null;
      act('addMeal', { meal_id: meal.id, item_ids: ids }, () => {
        ids.forEach((id) => { const it = itemById(id); D().list.push({ id: tmpId(), item_id: id, name: it.name, store: it.store, qty: 1, added_by: S.me, status: status, meal_id: meal.id }); });
      }, 'Added ' + ids.length + ' for ' + meal.name);
    },
    'cook-toggle': (el) => {
      const date = el.dataset.day; const slot = el.dataset.slot || 'dinner'; const name = el.dataset.name;
      const p = planDay(date)[slot]; if (!p) return;
      const on = cooksOf(p).map((x) => x.toLowerCase()).indexOf(name.toLowerCase()) < 0;
      const fam = (D().settings.parents || []).concat(D().settings.kids || []).map((x) => x.toLowerCase());
      const mine = name.toLowerCase() === String(S.me).toLowerCase();
      const m = mealById(p.meal_id || '');
      act('planCook', { date: date, slot: slot, name: name, on: on }, () => {
        const c = cooksOf(p).filter((x) => x.toLowerCase() !== name.toLowerCase());
        if (on) c.push(name);
        c.sort((a, b) => fam.indexOf(a.toLowerCase()) - fam.indexOf(b.toLowerCase()));
        p.cook = c.join('; ');
      }, on ? (mine ? 'You’re cooking ' : name + ' is cooking ') + (m ? m.name : 'dinner') + ' ' + (date === D().today ? 'tonight' : shortDay(date))
        : (mine ? 'You’re off ' : name + ' is off ') + (m ? m.name : 'dinner'));
    },
    'open-meal': (el) => { if (mealById(el.dataset.id)) { S.sheet = { type: 'mealcard', id: el.dataset.id, req: el.dataset.req || '' }; render(); } },
    'plan-meal': (el) => {
      const sh = S.sheet; if (!sh || sh.type !== 'mealcard') return;
      const rq = sh.req ? mealRequests().find((x) => x.r.id === sh.req) : null;
      planMeal(el.dataset.day, sh.id, rq ? rq.who : '');
      // Planning it from a kid's request answers the request.
      if (sh.req) { const id = sh.req; sh.req = ''; act('reviewAnswer', { id: id, answer: 'Yes, ' + shortDay(el.dataset.day) + ' (' + S.me + ')' }, () => { D().review = D().review.filter((r) => r.id !== id); }); }
    },
    'ask-meal-seg': (el) => { S.sheet.ask[el.dataset.field] = el.dataset.v; render(); },
    'ask-meal': () => {
      const sh = S.sheet; const m = mealById(sh.id); if (!m) return;
      const a = sh.ask;
      act('mealRequest', { meal_id: m.id, slot: a.slot, when: a.when }, () => {
        D().review.push({ id: tmpId(), type: 'meal_request', status: 'open', audience: 'parents', asked_by: S.me, detail: S.me + ' wants ' + m.name + ' for ' + a.slot + ', ' + a.when + '. (' + m.id + ') Options: Plan it; Not now' });
      }, 'Asked for ' + m.name + ptsTag('meal_ask'));
    },
    'req-no': (el) => { const id = el.dataset.id; act('reviewAnswer', { id: id, answer: 'Not now (' + S.me + ')' }, () => { D().review = D().review.filter((r) => r.id !== id); }, 'Said not now' + ptsTag('approve')); },
    'req-cancel': (el) => { const id = el.dataset.id; act('reviewAnswer', { id: id, answer: 'Cancelled (' + S.me + ')' }, () => { D().review = D().review.filter((r) => r.id !== id); }, 'Cancelled'); },
    'open-feedback': () => { S.sheet = { type: 'feedback', text: '' }; render(); const f = document.getElementById('fb-text'); if (f) f.focus(); },
    'save-feedback': () => {
      const text = String((S.sheet && S.sheet.text) || '').trim(); if (!text) return;
      S.sheet = null;
      act('feedback', { text: text, tab: S.tab }, null, 'Thanks! Sent.');
    },
    'feedback-to-meal': () => { S.sheet = { type: 'idea', text: (S.sheet && S.sheet.text) || '' }; render(); },
    'meal-add-all': (el) => {
      if (isKid(S.me)) return; // only parents add a meal's ingredients
      const meal = mealById(el.dataset.id);
      const ids = mealItems(meal).filter((id) => itemById(id) && !isDelivery(itemById(id).store) && !listRowFor(id));
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
    'edit-meal': (el) => { const m = mealById(el.dataset.id); if (m) { S.sheet = { type: 'meal', id: m.id, name: m.name, item_ids: mealItems(m), q: '', kind: kindOf(m), meat_qty: String(meatQty(m)) }; render(); } },
    'meal-kind': (el) => { S.mealKind = el.dataset.v; render(); },
    'meal-filters': () => { S.mealFiltersOpen = !S.mealFiltersOpen; render(); },
    'meal-filters-clear': () => { S.mealKind = 'all'; S.mealSort = 'top'; render(); },
    'meal-clear-q': () => { S.mealQuery = ''; render(); const f = document.getElementById('meal-q'); if (f) f.focus(); },
    'open-day': (el) => { S.sheet = { type: 'day', day: el.dataset.day }; render(); },
    'points-open': (el) => { S.sheet = { type: 'points', tab: el.dataset.tab || 'rules', who: '' }; if (S.sheet.tab === 'history') loadPointsLog(); render(); },
    'points-tab': (el) => { const sh = S.sheet; if (!sh || sh.type !== 'points') return; sh.tab = el.dataset.tab; if (sh.tab === 'history' && !sh.log) loadPointsLog(); render(); const b = document.querySelector('.sheet'); if (b) b.scrollTop = 0; },
    'points-who': (el) => { if (S.sheet && S.sheet.type === 'points') { S.sheet.who = el.dataset.v; render(); } },
    'points-reload': () => { loadPointsLog(); render(); },
    'open-hearth': (el) => { S.sheet = { type: 'hearth', week: (el && el.dataset.v) || 'next' }; render(); },
    'hearth-week': (el) => { S.sheet.week = el.dataset.v; render(); },
    'open-weekcost': (el) => { S.sheet = { type: 'weekcost', week: el.dataset.v || 'this' }; render(); },
    'weekcost-week': (el) => { S.sheet.week = el.dataset.v; render(); },
    'weekcost-swap': (el) => { if (amParent()) planMeal(el.dataset.date, el.dataset.to); },
    'hearth-copy': async () => {
      const text = hearthText(hearthDays(S.sheet.week));
      try { await navigator.clipboard.writeText(text); showToast('Copied. Paste it to Hearth Helper.'); }
      catch (e) { const f = document.getElementById('hearth-text'); if (f) { f.focus(); f.select(); } showToast('Select all and copy'); }
    },
    'hearth-share': async () => {
      try { await navigator.share({ text: hearthText(hearthDays(S.sheet.week)) }); } catch (e) { /* cancelled */ }
    },
    'ing-add': (el) => { S.sheet.item_ids.push(el.dataset.id); S.sheet.q = ''; render(); const f = document.getElementById('sh-mq'); if (f) f.focus(); },
    'slot-item': (el) => { const sh = S.sheet; sh.find = null; sh.fq = ''; planSlotItem(sh.day, el.dataset.slot, el.dataset.id); },
    'slot-find-close': () => { S.sheet.find = null; S.sheet.fq = ''; render(); },
    'ing-clear': () => { S.sheet.q = ''; render(); },
    // Meal card ingredients (parents): add / take off / new item, saved right away.
    'mc-ing-add': (el) => {
      const m = mealById(S.sheet.id); const it = itemById(el.dataset.id); if (!m || !it) return;
      const ids = mealItems(m).filter((x) => x !== it.id).concat([it.id]);
      S.sheet.iq = ''; saveMealIngredients(m, ids, 'Added ' + it.name);
      const f = document.getElementById('mc-iq'); if (f) f.focus();
    },
    'mc-ing-remove': (el) => {
      const m = mealById(S.sheet.id); const it = itemById(el.dataset.id); if (!m) return;
      const before = mealItems(m);
      saveMealIngredients(m, before.filter((x) => x !== el.dataset.id), 'Took ' + (it ? it.name : 'it') + ' off', () => saveMealIngredients(m, before, 'Put back'));
    },
    'mc-ing-clear': () => { S.sheet.iq = ''; render(); },
    'open-recipe': (el) => { const id = el.dataset.id; if (!recipeOf(id)) return; S.sheet = { type: 'recipe', id: id, from: el.dataset.from || '' }; prefetchRecipe(id); render(); },
    'recipe-close': () => { const sh = S.sheet || {}; const id = sh.id; S.sheet = sh.from !== 'inbox' && id && mealById(id) ? { type: 'mealcard', id: id } : null; render(); },
    'recipe-share': async () => {
      const id = S.sheet && S.sheet.id; const r = recipeOf(id); if (!r) return;
      const f = S.recipeFiles && S.recipeFiles[id];
      if (f && f !== 'loading' && navigator.canShare && navigator.canShare({ files: [f] })) {
        try { await navigator.share({ files: [f], title: f.name }); } catch (e) { if (e && e.name !== 'AbortError') showToast('Couldn’t open the share sheet. Try again.'); }
        return;
      }
      // No file sharing (a computer): open the PDF in a new tab, where the browser can print it.
      window.open(recipeUrl(r), '_blank', 'noopener');
    },
    'mc-vote-open': () => { if (S.sheet) { S.sheet.voting = true; render(); } },
    'mc-vote': (el) => {
      const sh = S.sheet; const m = sh && mealById(sh.id); const v = el.dataset.v; if (!m || !VOTE_LABEL[v]) return;
      sh.voting = false;
      act('mealVote', { meal_id: m.id, vote: v }, () => {
        const ms = D().mealStats || (D().mealStats = {});
        const st = ms[m.id] || (ms[m.id] = { voters: {}, votes: {}, score: 0 });
        st.voters = st.voters || {};
        Object.keys(st.voters).forEach((w) => { if (w.toLowerCase() === String(S.me).toLowerCase()) delete st.voters[w]; });
        st.voters[S.me] = v;
        const sc = { '😍': 4, '🙂': 3, '😐': 2, '👎': 1 }; const vs = Object.keys(st.voters).map((w) => sc[st.voters[w]] || 0).filter(Boolean);
        st.score = vs.length ? Math.round(vs.reduce((a, b) => a + b, 0) / vs.length * 10) / 10 : 0;
      }, 'Saved your vote: ' + v + ' ' + VOTE_LABEL[v]);
    },
    'mc-ing-new': async () => {
      const sh = S.sheet; const name = String(sh.iq || '').trim(); const m = mealById(sh.id);
      if (!name || !m || sh.creating) return;
      sh.creating = true; render();
      try {
        const j = await api('itemSave', { fields: { name: name, store: 'Either' } });
        const id = j && j.result && j.result.id;
        if (id) { sh.iq = ''; const mm = mealById(m.id) || m; saveMealIngredients(mm, mealItems(mm).filter((x) => x !== id).concat([id]), 'Added ' + name + ' (new item)'); }
      } catch (e) { handleError(e); }
      sh.creating = false; render();
    },
    // A new catalog item straight from the meal editor (itemSave without an id creates one).
    'ing-new': async () => {
      const sh = S.sheet; const name = String(sh.q || '').trim();
      if (!name || sh.creating) return;
      sh.creating = true; render();
      try {
        const j = await api('itemSave', { fields: { name: name, store: 'Either' } });
        const id = j && j.result && j.result.id;
        if (id && S.sheet === sh) { if (sh.item_ids.indexOf(id) < 0) sh.item_ids.push(id); sh.q = ''; }
        showToast('Added ' + name + ' to our items');
      } catch (e) { handleError(e); }
      sh.creating = false; render();
    },
    'ing-remove': (el) => { S.sheet.item_ids = S.sheet.item_ids.filter((id) => id !== el.dataset.id); render(); },
    'save-meal': () => {
      const sh = S.sheet;
      if (!String(sh.name).trim()) return;
      S.sheet = null;
      const body = { id: sh.id, name: sh.name.trim(), item_ids: sh.item_ids, kind: sh.kind || 'dinner' };
      if (canMeatQty() && sh.id && sh.meat_qty) body.meat_qty = Number(sh.meat_qty);
      act('mealSave', body, () => {
        const m = mealById(sh.id);
        if (m) { m.name = sh.name.trim(); m.item_ids = sh.item_ids.join(';'); m.kind = sh.kind || 'dinner'; if (body.meat_qty) m.meat_qty = body.meat_qty > 1 ? body.meat_qty : ''; }
        else D().meals.push({ id: tmpId(), name: sh.name.trim(), item_ids: sh.item_ids.join(';'), kind: sh.kind || 'dinner' });
      }, 'Saved ' + sh.name.trim());
    },

    'request-order': (el) => {
      const code = el.dataset.store;
      act('requestOrder', { store: storeOf(code).name }, () => { D().settings.order_requested = storeOf(code).name + ' requested by ' + S.me; }, 'Cart requested');
    },
    'clear-order': () => act('requestOrder', { store: '' }, () => { D().settings.order_requested = ''; }),
    'cart-job': (el) => {
      const code = el.dataset.store;
      const kind = el.dataset.kind;
      act('cartJob', { store: code, kind: kind }, () => {
        if (!latestJob(code, kind) || JOB_OPEN.indexOf(latestJob(code, kind).status) < 0) {
          D().cartJobs = [{ id: tmpId(), at: new Date().toISOString().slice(0, 19), by: S.me, store: code, kind: kind, status: 'queued' }].concat(jobs());
        }
        if ((kind === 'signin' || kind === 'all') && Number(D().api || 0) >= 49) CART_STORES.forEach((k) => {
          if (!openJobs(k).some((j) => j.kind === 'check')) D().cartJobs = [{ id: tmpId(), at: new Date().toISOString().slice(0, 19), by: S.me, store: k, kind: 'check', status: 'queued' }].concat(D().cartJobs || []);
        });
      }, kind === 'all' ? 'Got it. The laptop starts within a minute when it’s on' : kind === 'signin' ? 'Updating all 4 carts' : kind === 'check' ? 'Cart check queued' : 'Cart build queued');
    },
    'open-me': () => { S.sheet = { type: 'me' }; render(); },
    'cart-open': (el) => { S.cartOpen = el.dataset.store || ''; S.tab = 'carts'; store.set('ff_tab', 'carts'); S.sheet = null; render(); window.scrollTo(0, 0); },
    'cart-jump': () => { const box = document.getElementById('cart-failed'); if (box && box.scrollIntoView) { box.scrollIntoView({ block: 'start', behavior: 'smooth' }); box.classList.add('flash'); setTimeout(() => box.classList.remove('flash'), 1600); } },
    'cart-back': () => { S.cartOpen = ''; render(); window.scrollTo(0, 0); },
    'cart-pick': (el) => { if (S.sheet) { S.sheet.cartPick = el.dataset.store; S.sheet.move = false; render(); } },
    'cart-put': (el) => {
      const r = sheetRow(); const code = el.dataset.store; if (!r || !code) return;
      const c = cartState(r);
      const msg = (c.kind === 'leaving' || (c.kind === 'moving' && c.from === code)) ? 'Keeping ' + r.name + ' in the ' + storeOf(code).name + ' cart'
        : c.kind === 'in' ? r.name + ' moves to the ' + storeOf(code).name + ' cart' : '⏳ ' + r.name + ' is going in the ' + storeOf(code).name + ' cart';
      S.sheet = null;
      pushRows([{ r: r, store: code }], msg);
    },
    'cart-remove': () => {
      const r = sheetRow(); if (!r) return;
      const c = cartState(r);
      S.sheet = null;
      act('cartRemove', { ids: [r.id] }, () => {
        if (c.kind === 'in') { r.cart_want = 'out'; queueLocal(c.store); } else { r.cart_want = ''; r.cart_note = ''; }
      }, c.kind === 'in' ? '⏳ ' + r.name + ' is coming out of the ' + storeOf(c.store).name + ' cart. It stays on the List.' : 'Won’t add ' + r.name);
    },
    'push-all': () => openPushSheet(D().list.filter((r) => r.status !== 'requested' && kindOk(r) && needsCart(r))),
    'push-store': (el) => openPushSheet(D().list.filter((r) => needsCart(r) && pickCart(r).store === el.dataset.store)),
    'push-go': () => {
      const sh = S.sheet; if (!sh || sh.type !== 'pushall') return;
      const rows = sh.ids.map((id) => D().list.find((r) => r.id === id)).filter((r) => r && needsCart(r));
      const pairs = rows.filter((r) => sh.picks[r.id]).map((r) => ({ r: r, store: sh.picks[r.id] }));
      const later = rows.filter((r) => !sh.picks[r.id]);
      S.sheet = null;
      // Not now = we need it, just not this order: it goes to Later (no date), so it stops counting as "needs a cart".
      later.forEach((r) => act('listHold', { id: r.id, level: '', until: LATER_NO_DATE }, () => {
        D().list = D().list.filter((x) => x !== r);
        (D().held = D().held || []).push(Object.assign({}, r, { hold_until: LATER_NO_DATE }));
      }));
      pushRows(pairs, (pairs.length ? '⏳ Going in: ' + pushSummary(pairs) : '') + (later.length ? (pairs.length ? ' · ' : '') + later.length + ' to Later' : ''));
      if (!pairs.length) { showToast(later.length + ' moved to Later'); render(); }
    },
    'job-cancel': (el) => {
      act('cartJobCancel', { id: el.dataset.id }, () => {
        const j = jobs().find((x) => x.id === el.dataset.id);
        if (j) j.status = 'cancelled';
      }, 'Cancelled');
    },

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
      const lb = byLb(r.item_id);
      const step = lb ? 0.5 : 1;
      const q = Math.max(step, (Number(r.qty) || 1) + Number(el.dataset.d) * step);
      if (q === (Number(r.qty) || 1)) return;
      // api 34: a parent changing how many of a carted row → the runner changes that cart line too.
      const st = cartStore(r);
      const sync = Number(D().api || 0) >= 34 && !isKid(S.me) && r.status === 'carted' && CART_STORES.indexOf(st) >= 0 && (!r.cart_want || r.cart_want === st);
      act('update', { id: r.id, fields: { qty: q } }, () => { r.qty = q; if (sync) { r.cart_want = st; r.cart_note = ''; queueLocal(st); } },
        sync ? '⏳ ' + r.name + ': ' + (lb ? lbText(q) : q) + ' in the ' + storeOf(st).name + ' cart, updating' : undefined);
    },
    'have-level': (el) => {
      const v = el.dataset.v;
      if (v === 'count') { S.sheet.level = 'count'; render(); return; }
      haveDone(v);
    },
    'have-count': (el) => { S.sheet.count = Math.max(1, Math.min(999, S.sheet.count + Number(el.dataset.d))); render(); },
    'have-count-save': () => haveDone(String(S.sheet.count)),
    'meal-gaps': () => { S.sheet = { type: 'mealgaps' }; render(); },
    'staples': () => { S.sheet = { type: 'staples' }; render(); },
    'staples-send': (el) => {
      if (isKid(S.me)) return;
      let items = []; try { items = JSON.parse(el.dataset.items || '[]'); } catch (e) { items = []; }
      if (!items.length) return;
      const kids = D().settings.kids || [];
      act('missionsAsk', { items: items, kind: 'staples' }, () => {
        items.forEach((x, i) => (D().review = D().review || []).push({ id: tmpId(), type: 'check', status: 'open', audience: kids[i % kids.length], detail: '(' + x.id + ')' }));
      }, '🧺 Sent ' + items.length + ' staples checks to the girls');
    },
    'sk-use': () => {
      const sh = S.sheet; if (!sh || sh.type !== 'samekind') return;
      const it = itemById(sh.item_id), row = D().list.concat(D().held || []).find((r) => r.id === sh.row_id);
      S.sheet = null;
      if (!it || !row) { render(); return; }
      // The backend sees the same-kind row and adds us to it with a note, instead of a new row.
      act('add', { item_id: it.id, qty: 1, meal_id: sh.meal_id || '' }, () => { if (!iWant(row)) row.wanted_by = wantedBy(row).concat([S.me]).join(';'); });
    },
    'sk-anyway': () => {
      const sh = S.sheet; if (!sh || sh.type !== 'samekind') return;
      const it = itemById(sh.item_id);
      S.sheet = null;
      if (it) addItem(it, Object.assign({ _anyway: true }, sh.meal_id ? { meal_id: sh.meal_id } : {})); else render();
    },
    'row-later': () => { if (S.sheet) S.sheet.laterOpen = true; render(); },
    'row-hold': (el) => { const r = sheetRow(); S.sheet = null; if (r) holdRow(r, '', el.dataset.until || ''); else render(); },
    'miss-add': (el) => {
      if (isKid(S.me)) return; // only parents add a meal's ingredients
      const meal = mealById(el.dataset.meal);
      const ids = String(el.dataset.ids || '').split(',').filter((id) => itemById(id) && !isDelivery(itemById(id).store) && !listRowFor(id));
      if (!meal && ids.length === 1) { addItem(itemById(ids[0])); return; } // a planned item, not a meal
      if (!meal || !ids.length) return;
      const status = isKid(S.me) ? 'requested' : 'needed';
      act('addMeal', { meal_id: meal.id, item_ids: ids }, () => {
        ids.forEach((id) => { const it = itemById(id); D().list.push({ id: tmpId(), item_id: id, name: it.name, store: it.store, qty: 1, added_by: S.me, wanted_by: S.me, status: status, meal_id: meal.id }); });
      }, (status === 'requested' ? 'Asked for ' : 'Added ') + ids.length + ' for ' + meal.name);
    },
    'miss-have': (el) => {
      const ids = String(el.dataset.ids || '').split(',').filter((id) => itemById(id));
      if (!ids.length) return;
      const have = {}, pantry = {};
      ids.forEach((id) => { have[id] = true; pantry[id] = isPantry(id); });
      S.sheet = { type: 'misshave', meal_id: el.dataset.meal || '', name: el.dataset.name || '', ids: ids, have: have, pantry: pantry };
      render();
    },
    'miss-send': (el) => {
      if (isKid(S.me)) return;
      let items = []; try { items = JSON.parse(el.dataset.items || '[]'); } catch (e) { items = []; }
      if (!items.length) return;
      const kids = D().settings.kids || [];
      act('missionsAsk', { items: items }, () => {
        // Show them as out for checking right away; the next state brings the real cards.
        items.forEach((x, i) => (D().review = D().review || []).push({ id: tmpId(), type: 'check', status: 'open', audience: kids[i % kids.length], detail: '(' + x.id + ')' }));
      }, '🔎 Sent ' + items.length + ' missions to the girls');
    },
    'mh-toggle': (el) => { const sh = S.sheet; if (sh && sh.type === 'misshave') { sh.have[el.dataset.id] = !sh.have[el.dataset.id]; render(); } },
    'mh-pantry': (el) => { const sh = S.sheet; if (sh && sh.type === 'misshave') { sh.pantry[el.dataset.id] = !sh.pantry[el.dataset.id]; render(); } },
    'mh-save': () => {
      const sh = S.sheet;
      if (!sh || sh.type !== 'misshave' || isKid(S.me)) return;
      S.sheet = null;
      const haveIds = sh.ids.filter((id) => sh.have[id]);
      const needIds = sh.ids.filter((id) => !sh.have[id] && !listRowFor(id) && !isDelivery(itemById(id).store));
      const meal = mealById(sh.meal_id);
      const msg = [haveIds.length ? 'have ' + haveIds.length : '', needIds.length ? 'added ' + needIds.length : ''].filter(String).join(' · ');
      const calls = [];
      if (canPantry()) sh.ids.forEach((id) => {
        const it = itemById(id), want = sh.pantry[id] ? 'Y' : '';
        if (it && (isPantry(id) ? 'Y' : '') !== want) calls.push(() => act('itemSave', { id: id, fields: { pantry: want } }, () => { it.pantry = want; }, ''));
      });
      haveIds.forEach((id) => calls.push(() => act('stockLog', { item_id: id, level: 'some' }, () => {
        (D().stock = D().stock || {})[id] = { level: 'some', at: D().today, who: S.me };
      }, '')));
      if (needIds.length) {
        if (meal) calls.push(() => act('addMeal', { meal_id: meal.id, item_ids: needIds }, () => {
          needIds.forEach((id) => { const it = itemById(id); D().list.push({ id: tmpId(), item_id: id, name: it.name, store: it.store, qty: 1, added_by: S.me, wanted_by: S.me, status: 'needed', meal_id: meal.id }); });
        }, ''));
        else needIds.forEach((id) => calls.push(() => addItem(itemById(id))));
      }
      if (!calls.length) { render(); return; }
      calls.forEach((c) => c());
      showToast('Got it: ' + (msg || 'saved'));
    },
    'row-bought': () => { const r = sheetRow(); S.sheet = null; if (r) setStatus(r, 'bought', 'Bought ' + r.name); else render(); },
    'row-remove': () => { const r = sheetRow(); S.sheet = null; if (r) setStatus(r, 'skipped', 'Took ' + r.name + ' off'); else render(); },
    'toggle-details': () => { S.sheet.details = !S.sheet.details; render(); },
    'is-fold': (el) => {
      const k = el.dataset.k;
      const o = S.sheet.open || (S.sheet.open = {});
      o[k] = !o[k]; render();
      const acc = o[k] && document.querySelector('.is-acc-head[data-k="' + k + '"]');
      if (acc && acc.parentNode.scrollIntoView) acc.parentNode.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    'opt-use': (el) => {
      const sh = S.sheet;
      const p = sh && sh.info && sh.info.products && sh.info.products[Number(el.dataset.i)];
      if (!p) return;
      act('productPick', { item_id: sh.item_id, store: p.store, product: p.name }, () => {
        sh.info.products.forEach((x) => { if (x.store === p.store) x.current = x === p; });
        const pr = (D().products = D().products || {})[sh.item_id] = (D().products || {})[sh.item_id] || {};
        pr[p.store] = Object.assign({}, pr[p.store] || {}, { name: p.name, size: p.size, price: p.price, unit_price: p.unit_price, unit: p.unit, price_at: p.price_at, pack: p.pack, match: 'exact' });
      }, 'Next ' + storeOf(p.store).name + ' cart gets: ' + p.name);
    },
    'is-edit': () => {
      const o = S.sheet.open || (S.sheet.open = {});
      o.details = true; render();
      // Land on the Aisle picker (what's usually wrong on a new item), with Store we use just above it in view.
      const f = document.getElementById('d-aisle');
      const box = f && f.parentNode;
      if (box && box.scrollIntoView) { box.scrollIntoView({ block: 'center', behavior: 'smooth' }); box.classList.add('flash'); setTimeout(() => box.classList.remove('flash'), 1600); }
    },
    'is-move': () => { S.sheet.move = !S.sheet.move; render(); },
    'is-note': () => { S.sheet.noteOpen = true; render(); const f = document.querySelector('[data-input="row-note"]'); if (f) f.focus(); },
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
    'list-kind': (el) => { S.listKind = el.dataset.v || 'all'; render(); },
    'use-soon': (el) => {
      const id = el.dataset.id, what = el.dataset.what;
      const x = (D().useSoon || []).find((y) => y.item_id === id);
      if (!x) return;
      const msg = { used: 'Used up: ' + x.name, tossed: 'Tossed: ' + x.name + '. Thanks for saying so', good: x.name + ': we’ll ask again in 2 days' }[what];
      act('useSoon', { item_id: id, what: what }, () => { D().useSoon = (D().useSoon || []).filter((y) => y !== x); }, msg);
    },
    'fold-all': () => {
      const keys = groupsIn(D().list.filter((r) => r.status !== 'requested' && kindOk(r))).map((g) => 'a:' + g);
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
    'shop-hide-listed': (el) => { S.shopHideListed = !S.shopHideListed; render(); },
    'shop-store': (el) => { S.shopStore = el.dataset.v; render(); },
    'shop-sort': (el) => { S.shopSort = el.dataset.v; render(); },
    'shop-filters': () => { S.shopFiltersOpen = !S.shopFiltersOpen; render(); },
    'shop-filters-clear': () => { S.shopFilter = 'all'; S.shopStore = 'all'; S.shopSort = 'most'; S.shopHideListed = false; render(); window.scrollTo(0, 0); },
    'shop-clear-q': () => { S.query = ''; render(); const f = document.getElementById('add'); if (f) f.focus(); },
    'store-start': () => { S.instore = store.get('ff_instore_last') || 'GE'; store.set('ff_instore', S.instore); S.tab = 'list'; render(); window.scrollTo(0, 0); },
    'store-pick': (el) => { S.instore = el.dataset.v; store.set('ff_instore', S.instore); store.set('ff_instore_last', S.instore); render(); },
    'store-done': () => {
      const n = D().recent.filter((r) => boughtToday(r) && inStore(r)).length;
      store.set('ff_instore_last', S.instore); S.instore = ''; store.del('ff_instore');
      showToast(n ? n + ' bought' : 'Back home'); render(); window.scrollTo(0, 0);
    },
    'store-check': (el) => {
      const r = D().list.find((x) => x.id === el.dataset.id);
      if (!r) return;
      const note = (r.note ? r.note + '; ' : '') + 'in the cart in store (' + S.me + ')';
      act('update', Object.assign({ id: r.id, fields: { status: 'bought', note: note } }, r.status === 'carted' && canCarts() ? { cart_out: true } : {}), () => {
        D().list = D().list.filter((x) => x !== r);
        D().recent.push(Object.assign({}, r, { status: 'bought', note: note, updated_at: nowIso() }));
      }, '🛒 ' + r.name + ' is in the cart');
    },
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
      act('stockLog', { item_id: sh.item_id, level: level, list_id: r.id }, () => {
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
    if (kind === 'meal-q') { S.mealQuery = el.value; render(); return; }
    if (kind === 'ask-draft') { S.askDraft = el.value; if (el.tagName === 'TEXTAREA') { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px'; } }
    if (kind === 'd' && S.sheet && S.sheet.d) S.sheet.d[el.dataset.field] = el.value;
    if (kind === 'draft' && S.sheet) {
      S.sheet[el.dataset.field] = el.value;
      // Only the meal search and name-gated Save buttons need a redraw while typing.
      if (el.dataset.field === 'q' || el.dataset.field === 'name' || el.dataset.field === 'fq' || el.dataset.field === 'iq') render();
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
      if (mealId === 'find') { S.sheet.find = slot; S.sheet.fq = ''; render(); const f = document.getElementById('slot-fq'); if (f) f.focus(); return; }
      if (mealId.indexOf('i:') === 0) { S.sheet.find = null; planSlotItem(day, slot, mealId.slice(2)); return; }
      const wk = addDays(day, -DAYS.indexOf(dayName(day)));
      act('planSet', { date: day, day: dayName(day), week_of: wk, meal_id: mealId, slot: slot, note: '' }, () => {
        D().plan = D().plan.filter((p) => !(planDate(p) === day && slotOf(p) === slot));
        if (mealId) D().plan.push({ date: day, week_of: wk, day: dayName(day), meal_id: mealId, slot: slot });
      });
    }
    if (el.dataset && el.dataset.input === 'ask-sel') { S.askSel = el.value; render(); }
    if (el.dataset && el.dataset.input === 'push-pick' && S.sheet && S.sheet.picks) { S.sheet.picks[el.dataset.id] = el.value; render(); }
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
    if (form.dataset.form === 'meal-q') { if (document.activeElement) document.activeElement.blur(); return; }
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
    if (form.dataset.form === 'ask-count') {
      const n = String(S.askDraft || '').trim();
      if (!/^\d{1,3}$/.test(n)) return;
      const f = document.getElementById('ask-count'); if (f) f.blur();
      answerQuestion(form.dataset.id, n);
      return;
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
    if (!card || ev.target.closest('button, input, textarea, select, a, label, form')) return;
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
      } else if (d.dx < 0) { handlers['ask-later']({ dataset: { id: id } }); return; }
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
  window.addEventListener('online', () => refresh());
  // Swipe right from the left edge = back to All carts (a store's cart screen), like an iPhone app.
  let edgeX = -1, edgeY = 0;
  document.addEventListener('touchstart', (ev) => { const t = ev.touches[0]; edgeX = S.cartOpen && t.clientX < 30 ? t.clientX : -1; edgeY = t.clientY; }, { passive: true });
  document.addEventListener('touchend', (ev) => {
    if (edgeX < 0 || !S.cartOpen) return;
    const t = ev.changedTouches[0];
    if (t.clientX - edgeX > 80 && Math.abs(t.clientY - edgeY) < 60) { S.cartOpen = ''; render(); window.scrollTo(0, 0); }
    edgeX = -1;
  }, { passive: true });
  setInterval(() => {
    // Don't redraw under someone mid-edit.
    if (document.hidden || S.sheet || S.query || S.mealQuery) return;
    if (Date.now() - stripTouched < 3000) return; // mid-swipe through a week strip
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA')) return;
    if (String(S.askDraft || '').trim()) return; // a half-typed Inbox answer stays put
    refresh();
  }, POLL_MS);

  if (S.pass && apiUrl()) firstLoad(); else render();
})();
