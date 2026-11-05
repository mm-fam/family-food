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
  points: 'Points',
};

// Points (api 16): points earned outside the Inbox (adding to the List, asking for a meal, handling a kid's
// request). Append-only ledger, created on first use. Inbox points stay on their Review rows.
const POINTS_HEAD = ['at', 'to', 'pts', 'why', 'ref', 'by', 'note'];

// Cart Jobs (api 12): a parent taps "Build the cart" / "Check the cart" on a phone; the job waits here until
// Claude's cart runner (a scheduled task on the owner's computer, which has Chrome signed in to the stores)
// picks it up and writes back status + result. Created on first use.
const JOBS_HEAD = ['id', 'at', 'by', 'store', 'kind', 'status', 'started_at', 'finished_at', 'result', 'notes', 'subtotal', 'lines'];
const JOB_STORES = ['GE', 'WF', 'TGT', 'AMZ'];
// Deliveries (Nov 2): food that arrives on its own (Wildgrain box every 30 days, Bleu Box ready meals).
// Items with these as store are never put on the List, never probably due, never in a cart.
const DELIVERY_SOURCES = { WG: 'Wildgrain', BB: 'Bleu Box' };
const isDeliveryItem = (it) => !!(it && DELIVERY_SOURCES[String(it.store || '')]);
const STORE_NAMES = { GE: 'Giant Eagle', WF: 'Whole Foods', TGT: 'Target', AMZ: 'Amazon' };
const JOB_KINDS = ['build', 'check', 'signin', 'all']; // signin / all = store 'ALL' (api 42 / 50)
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
// Head-to-head meal cards (api 39, owner Nov 4): "Which do you like more: A or B?" for two meals of the same kind.
const PICK_PER_DAY = 1;        // per person per day
const PICK_EXPIRE_DAYS = 3;    // unanswered ones close
const PICK_REASK_DAYS = 60;    // the same pair isn't asked of the same person again for this long
// Inbox points (api 13). Every answered card earns points for whoever answered it; a "Did <kid> help with
// dinner?" card (type helped) earns points for the kid it's about (Review points_to). Skips earn nothing.
const POINTS = { task: 5, task_late: 2, check: 3, settle: 3, rate: 2, still: 2, helped_cooked: 10, helped_helped: 5, other: 1 };
const POINTS_GOAL = 10; // daily goal; Settings points_goal overrides
// Quick cards (rule `other`: questions, dinner votes, decisions) count toward the leaderboard only up to this many
// a day per person (api 36, owner Nov 3: whoever gets the most cards shouldn't run away with it). Settings quick_cap
// overrides; 0 = no limit. Applied when points are counted, so Review keeps each card's face value.
const QUICK_CAP = 0; // api 58: off by default (owner: points that stop counting send the wrong message)
function quickCap() {
  const v = settingsMap().quick_cap;
  return v === '' || v === undefined || v === null || isNaN(Number(v)) ? QUICK_CAP : Math.max(0, Number(v));
}
// Missions (rule `check`) count toward the leaderboard only up to this many a day per person (api 57, owner Nov 5:
// ten missions in four minutes shouldn't decide the week). Settings mission_cap overrides; 0 = no limit. Counted
// like the quick-card limit: when points are added up, so Review keeps face values.
const MISSION_CAP = 0; // api 58: off by default, like QUICK_CAP
// Catch-up bonus (api 58, owner Nov 5): anyone not in first place this week when they score gets CATCHUP × the points
// (at least +1), worked out in time order when points are counted. Settings catchup overrides; 1 or 0 = off.
const CATCHUP = 1.5;
function catchup() {
  const v = Number(settingsMap().catchup);
  const m = settingsMap().catchup === undefined || settingsMap().catchup === '' || isNaN(v) ? CATCHUP : v;
  return m > 1 ? m : 0;
}
function boosted(pts, m) { return m && pts > 0 ? Math.max(pts + 1, Math.floor(pts * m)) : pts; }
function missionCap() {
  const v = settingsMap().mission_cap;
  return v === '' || v === undefined || v === null || isNaN(Number(v)) ? MISSION_CAP : Math.max(0, Number(v));
}
// POINT_RULES as the app shows them, with the live daily limits on `other` and `check`.
function pointRulesOut() {
  const caps = { other: quickCap(), check: missionCap() };
  return POINT_RULES.map((x) => (caps[x.key] ? Object.assign({}, x, { cap: caps[x.key] }) : x));
}
// The scoring rules as the family reads them (Inbox → How points work). One line per way to score, in the
// order shown; `key` is what Review points_why stores. Keep in step with POINTS and cardPoints().
const POINT_RULES = [
  { key: 'task', icon: '⏰', label: 'Due soon, answered on time', pts: POINTS.task, to: 'you' },
  { key: 'task_late', icon: '⏰', label: 'Due soon, answered after it was due', pts: POINTS.task_late, to: 'you' },
  { key: 'check', icon: '🔎', label: 'Mission (go check something)', pts: POINTS.check, to: 'you' },
  { key: 'settle', icon: '🧾', label: 'Did we get it? (settling the List)', pts: POINTS.settle, to: 'you' },
  { key: 'rate', icon: '🍽', label: 'How was it?', pts: POINTS.rate, to: 'you' },
  { key: 'still', icon: '🍽', label: 'Still eating it?', pts: POINTS.still, to: 'you' },
  { key: 'other', icon: '💬', label: 'Any other card: questions, dinner votes, decisions', pts: POINTS.other, to: 'you' },
  { key: 'list_add', icon: '🛒', label: 'Adding something to the List (kids: once a parent approves it)', pts: 1, to: 'you', group: 'family', cap: 5 },
  { key: 'meal_ask', icon: '🙋', label: 'Asking for a meal', pts: 2, to: 'you', group: 'family', cap: 2 },
  { key: 'approve', icon: '✅', label: 'Handling a kid’s request: Approve or Skip, Plan it or Not now', pts: 1, to: 'you', group: 'family' },
  { key: 'helped_cooked', icon: '🧑‍🍳', label: 'Kitchen help: Cooked it', pts: POINTS.helped_cooked, to: 'kid', group: 'kitchen' },
  { key: 'helped_helped', icon: '🧑‍🍳', label: 'Kitchen help: Helped', pts: POINTS.helped_helped, to: 'kid', group: 'kitchen' },
];
POINT_RULES.forEach((x) => (x.group = x.group || 'inbox'));
const POINTS_LOG_DAYS = 120; // pointsLog sends answers from this many days back
const HELPED_OPTIONS = 'Cooked it; Helped; Not this time';
const HELPED_EXPIRE_DAYS = 3;
// Missions (Inbox step 3): "go check how much X we have" cards for the kids, every day.
const MISSIONS_PER_KID = 3;      // fallback when there's only one kid
// The girls' race (owner, Nov 2): kids get more scoring cards than parents, and whoever is behind this week
// (Mon–Sun points, counted when the day's cards are made) gets extra missions so the lead keeps changing.
// Parents never get catch-up help. Shown on Inbox → How points work (state.points.race).
const KID_MISSIONS = { lead: 3, tied: 4, behind: 5 };
const MISSION_EXPIRE_DAYS = 2;     // a check goes stale fast; unanswered ones close
const MISSION_RECHECK_DAYS = 3;    // skip items someone already looked at this recently
const MISSION_PLAN_DAYS = 3;       // ingredients for meals planned today + the next 2 days
const MISSION_OPTIONS = 'Plenty; Some; A little; Out';
const MISSION_LEVEL = { plenty: 'plenty', some: 'some', 'a little': 'low', low: 'low', out: 'out', none: 'out' };
const NON_FOOD = ['Personal care', 'Household', 'Paper & cleaning', 'Other'];
// Settling the List without a receipt (api 17, owner Nov 1): daily "Did we get it?" cards.
// Kids go look (It's here / Not here); parents decide (Got it / Still need it / Don't need it).
// After a cart was built, one "Did the <store> order come?" card to the parents settles the whole cart.
const SETTLE_STALE_DAYS = 7;       // a needed row untouched this long gets asked about
const SETTLE_CART_DAYS = 2;        // carted rows this long after the cart was filled: did the order come?
const SETTLE_REASK_DAYS = 5;       // don't ask about the same row (or store order) again sooner
const SETTLE_EXPIRE_DAYS = 3;      // unanswered settle cards close
const SETTLE_PER_KID = 3;        // was 2 (Nov 2: more scoring cards for the girls)
const SETTLE_PARENTS = 4;          // per day, shared by both parents
const SETTLE_KID_OPTIONS = "It's here; Not here";
const SETTLE_PARENT_OPTIONS = "Got it; Still need it; Don't need it";
const SETTLE_ORDER_OPTIONS = 'Yes, all of it; Some of it; Not yet';
// Use soon (api 22, inventory-design step 3): perishables with Items shelf_days (from a parent's answers) show at the
// top of the List from the day before they go bad. Bought = the newest of the last receipt and a List row marked
// bought; a Stock sighting with `expires` (Still good, or a printed date) after that moves the date.
const USE_SOON_AHEAD = 1;   // show from this many days before the last good day
const USE_SOON_DROP = 3;    // stop showing this many days after it (assume it's gone)
const USE_SOON_SNOOZE = 3;  // "Still good" → look again in 2 days (expires = today + 3, shown from the day before)
const USE_SOON_ACTS = { used: 'out', tossed: 'waste', good: 'some' };
// Waste learning: an item tossed this many times in WASTE_DAYS gets one parents' card (type waste).
const WASTE_TIMES = 2;
const WASTE_DAYS = 60;
const WASTE_REASK_DAYS = 90;
const WASTE_OPTIONS = 'Buy fewer; Buy less often; It’s fine';
const SETTLE_MEAL_OPTIONS = 'Take them off; Keep them';
const SETTLE_MEAL_GRACE_DAYS = 2;  // a meal counts as planned if it's on the plan from 2 days ago through the next 14 days

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
// 13 = Inbox points: reviewAnswer stamps Review answered_at + points + points_to; state.points = today / this week
//      per person, streaks, daily goal, last week's winner; daily "Did <kid> help with dinner?" cards (type helped,
//      audience parents) whose answer gives that kid points.
// 14 = points rules + history: reviewAnswer also stamps Review points_why (which rule scored it);
//      state.points.rules = the scoring rules; pointsLog {} (read-only) = every scored answer + weekly totals.
// 12 = cart jobs: cartJob {store, kind: build|check} queues a job in the Cart Jobs tab for Claude's cart runner,
//      cartJobCancel {id} cancels a queued one; state.cartJobs = recent jobs with status + result.
// 15 = Inbox missions: daily "go check" cards (type check) for the kids from probably-due items and the next
//      3 days' meal ingredients; answering one logs a Stock sighting and, if low or out, puts it on the List
//      (a kid's answer as requested, a parent's as needed).
// 16 = points for helping plan and shop (Points tab ledger): adding to the List (1; kids when a parent approves;
//      up to 5 a day), asking for a meal (2, up to 2 a day), a parent handling a kid's List or meal request (1).
// 17 = settling the List: daily "Did we get it?" cards (type settle, a List id in the text) for stale needed rows,
//      rows someone saw at home, and carted rows; one "Did the <store> order come?" card (type settle_order) per
//      filled cart. Answers set the List row bought / have / skipped or keep it; 3 points.
// 18 = points_start (Settings, yyyy-mm-dd): nothing scored before that day counts anywhere (scoreboard, streaks,
//      leaderboard, 👑, History); state.points.start. Set to 2026-11-02 so everyone starts even.
// 19 = meals that left the plan: List rows still tied to a meal that isn't planned anymore get one parents' card
//      per meal ("<meal> isn't on the plan anymore… Take them off / Keep them", type settle_meal).
// 20 = reconciling the List scores (rule reconcile, 2 points, up to 5 a day): a parent's "We have plenty / some"
//      on a List row scores right away; a kid's becomes a parents' card (type have_check, "Take it off the List?")
//      and the row stays until a parent says yes, then the kid scores. "A little" / a count (stockLog with list_id)
//      and Next week with a level score too. Handling a have_check card scores the parent `approve`.
// 21 = reconciling is missions only (owner): no points for List taps (api 20's reconcile rule is gone). A kid's
//      Plenty / Some on the List, and a kid's "It's here" on a Did we get it? card, both go to the parents as a
//      have_check card ("Take it off the List?"); nothing a kid says takes a row off by itself. The mission or
//      Did we get it? card still pays its points when answered; the parent gets 1 for answering the have_check.
// 22 = use soon: Items shelf_days (parents can edit it in Details); state.useSoon = perishables near their last
//      good day; useSoon {item_id, what: used|tossed|good} logs Stock (out / waste / some + expires);
//      a daily parents' card (type waste) for anything tossed 2+ times in 60 days.
// 23 = prices: state.products rows also carry price, unit_price, unit, price_at (Products columns Claude fills from
//      store sites); each store can carry `sb` = the cheapest priced store-brand row (Products store_brand = Y).
//      The app compares unit prices across stores (item screen, List tag, before Build the cart). Each row also
//      carries `match`: only exact / likely rows are compared (alt = a different product, e.g. organic vs not).
// 24 = cartJobsOpen: light read of open cart jobs for the cart watcher on the owner's PC (polls every minute).
// 25 = carts by line (Nov 2): List cart_want / cart_by / cart_note. cartPush {rows: [{id, store}]} puts List
//      rows in a store's online cart (or moves them there from another cart); cartRemove {ids} takes them out (or
//      cancels a push that hasn't run). Each queues that store's build job; the cart runner does the line-level
//      adds and removes. A carted row taken off the List (Take off, We have it, Don't need it) comes out of the
//      cart too. Parents only; kids see carts read-only.
// 26 = cart totals: Cart Jobs subtotal + lines (the store's own cart subtotal and line count, written by the cart runner
//      when it finishes a job) ride along in state.cartJobs, so the Carts screen shows $ per cart and in total.
// 27 = state.settings.runner_seen: when the cart runner on the owner's computer last started a run (it writes Settings
//      runner_seen first thing, every run), so the app can say plainly whether the cart helper is alive.
// 28 = buying rhythm from every purchase (Nov 2): state.items carry last_bought / avg_days / orders worked out from
//      Receipts (emailed receipts + Giant Eagle's own order history, read weekly by the cart runner) AND List rows
//      someone marked bought (In store, Did we get it?, Bought it), so "Probably due", "Not lately" and Use soon
//      don't wait for receipts. The Items J:M formulas are untouched (receipts only). state.freshness = newest
//      Receipts date per store.
// 29 = ideas and alternatives (Nov 2, owner): a 💡 idea (feedback) emails the owner right away (MailApp, owner only;
//      Settings idea_alerts = off stops it, alert_email overrides the address); Items open_to_try (Y = "we'd try
//      something else": parents set it in Details) tells the cart runner's price pass to look up alternatives and
//      the morning check to offer them as parents' `try` cards.
// 30 = a Plan slot can hold a catalog item instead of a meal (snacks we just buy).
// 31 = deliveries (Nov 2, owner): Items store WG (Wildgrain) / BB (Bleu Box) = food that arrives on its own. addToList
//      skips them (a mission's out, meal ingredients); Probably due skips them; the app shows them as 🧊 on hand.
// 36 = quick-card limit (Nov 3, owner): rule `other` (questions, votes, decisions, 1 point) counts only the first
//      quick_cap (Settings; default 8, 0 = off) per person per day, applied when points are counted (scoredEvents),
//      so it covers this week too and Review keeps face values. state.points.quickCap / quickToday; pointsLog
//      entries past the cap come back with pts 0 and capped: true.
// 34 = cart qty (Nov 2, owner): a parent changing the qty of a carted List row sets cart_want = that same cart and
//      queues its build job; the cart runner changes that line's qty in the store cart (no new line).
// 37 = (withdrawn) kids' adds for planned meals skipped approval; replaced the same day by 38.
// 38 = only parents add a meal's ingredients (Nov 4, owner): addMeal from a kid is refused.
// 39 = meal head-to-heads (Nov 4, owner): daily `pick` cards ("Which do you like more: A or B? (mNN) (mNN)"), one
//      per person; mealStats gains wins / matchups from them (the rating stays the vote average).
// 40 = best price (Nov 4, owner): Items best_price = Y ("any store, best price"). When such an item is on the List
//      and another store sells the same product cheaper (fresh, like items, 10%+ and $0.50+), the parents get one
//      ⚖ `bestprice` card with every store's price; the answer puts the row in that store's cart (cartPush).
// 41 = voice adds (Nov 4, owner): voiceAdd {by, text} for the "Add to Poppy" Siri Shortcut. Splits a spoken phrase
//      ("milk, eggs and two avocados") into parts, matches each to the catalog (name, aliases, store product names;
//      what we buy now wins ties), adds it like the app's + (kids' adds are requests), and returns `say`, one
//      sentence Siri reads back. No match → added as a new item, noted "by Siri" so a parent can tidy the name.
// 42 = stores ready (Nov 4, owner): cartJob {store: 'ALL', kind: 'signin'} asks the cart runner to confirm every store is
//      signed in on the cart computer (it also does it on its first run each day from 6 am). The runner writes Settings
//      `stores_ok` ("GE=ok;WF=ok;TGT=out;AMZ=ok") + `stores_checked`; state.settings.stores_ok / stores_checked carry them.
// 43 = voice adds ask instead of guessing (Nov 4, owner: "don't turn sugar into brown sugar"): voiceAdd only adds an
//      exact name/alias match or the only item whose whole name was said; anything else is a `voice` card in the
//      speaker's Inbox (up to 3 likely items, New item, Something else, Never mind). The answer adds it and teaches
//      Poppy: the spoken words become an alias, so next time it's sure.
// 44 = hardening (Nov 4, owner): text written to the Sheet that starts with = + - @ is stored as plain text (no
//      formula injection); every write needs a `by` that is a parent, a kid or the cart runner.
// 45 = catalog quality (Nov 4, owner): Items `sold_by` (lb = by the pound: List qty in pounds, ½ lb steps; blank = each)
//      and `itemSave` fields.spoken = the words the family says for an item (lowercase aliases, used by Shop search
//      and Siri; ALL-CAPS receipt codes are kept).
// 46 = substitutions (Nov 4, owner): what the store may send when something is out. Items ok_swap is the rule
//      (Y = let the store pick / best available, N = don't substitute, blank = store default + ask after). Products
//      `backup` (1, 2, … at the end of the tab) marks our pick of substitute at that store, lowest first; the cart
//      runner sets each line's substitution choice from these. state.products[item][store].backup = {name, size}.
//      `subbed` cards (parents; the runner writes them when an order came with a substitution, plus an alt Products
//      row noted `sent as substitute rNNN`): That's fine → ok_swap Y; Don't substitute → ok_swap N; Make it the
//      backup → that Products row gets backup 1 (others move down).
// 47 = meal old names (Nov 4, owner: catchy emoji meal names): Meals `old_names` (`;` separated, at the end of the
//      tab) = names a meal had before. Old vote / rate cards matched by name (no (mNN)) still count after a rename;
//      mealSave keeps the previous name there when a parent renames a meal. The app's meal search reads it too.
// 48 = cart helper heartbeat (Nov 4, owner): the cart watcher's every-minute cartJobsOpen call (with chrome=1/0)
//      records Script Property watcher_seen / watcher_chrome; state.settings.watcher_seen / watcher_chrome let the
//      Carts screen say truthfully whether the home computer is on and ready (runner_seen only moves when Claude runs).
// 49 = Check all stores (Nov 4, owner: "when I hit the check button… all the as-of stamps would be the same"): a
//      parent's signin job also queues a cart `check` for each of the four stores (skipping any already open), so one
//      tap re-reads every cart and its total; a signed-out store's check fails and shows red with the reason.
// 50 = "Laptop's on: update everything" (Nov 4, owner: "the laptop's open… free to do it… keep it awake for the next
//      30 minutes"): cartJob {store: 'ALL', kind: 'all'} queues one `all` job plus a cart `check` per store. The runner
//      then does, within ~30 min: waiting cart changes, sign-ins, every cart re-read, order history for all stores and
//      the price pass, even if the daily passes already ran today.
// 51 = store options (Nov 4, owner: "a better way of understanding what options we have at these stores"): Products
//      match `option` = a real product the cart runner saw at that store for an item (size, count, price), not bought
//      yet; never "what we buy" until someone picks it. The runner looks up 3–4 options for new items (and List items
//      with no exact product) and sets Settings `options_new`; the next state call turns them into one `which` card
//      per item + store ("Which … at Target?", to the parent who added it, else the parents). The answer, or
//      productPick {item_id, store, product} from the item screen, makes that product `exact` (other exact / likely
//      rows there become `alt`). itemInfo returns `products`: every store product we know for the item.
// 52 = vote from the meal card (Nov 4, owner: "whoever the user is logged in… should be able to update my own or add
//      one… right there in that list"): mealVote {meal_id, vote: 😍/🙂/😐/👎} appends a closed Review `vote` row
//      answered "<emoji> <label> (<name>)" with the meal id, so mealStats' latest-answer-per-person picks it up. No
//      points (it isn't a card). Any open vote / rate card for that person and meal closes (outcome "voted on the meal card").
// 53 = mini fridge tag (Nov 4, owner: "all of these items get like a little mini fridge tag… when they're on our list or
//      we're shopping for them"): Items `mini_fridge` (Y / blank, added at the end on first use); itemSave accepts it
//      (parents only). The app shows 🥤 Mini fridge on List, request, In store, in-the-cart, Shop rows and the item screen.
// 54 = pantry staples (Nov 4, owner: Missing for meals flagged garlic, soy sauce, ketchup… after recipes linked them):
//      Items `pantry` (Y / blank, added at the end on first use); itemSave accepts it (parents only). The app's Missing
//      for meals assumes a pantry item is on hand unless its latest sighting in 14 days is low / out, today's meals
//      drop off once their slot has passed, and Have opens a sheet (have / need per item, 🫙 Always have). Missions
//      skip pantry items for meal checks.
// 55 = Missing for meals → the girls' missions (Nov 5, owner: "these are great mission items for the girls to check"):
//      missionsAsk {items: [{id, why}]} (parents only) makes one 🔎 mission card per item that isn't on the List and
//      isn't already on an open mission, split between the kids (in turn, whoever is behind this week first since api 57). Same card and answer
//      as the daily missions (Plenty / Some / A little / Out; low / out puts it on the List as a request).
// 56 = Cart Jobs stamps keep their time: readTab reads a date-time cell on Cart Jobs as yyyy-MM-ddTHH:mm:ss, not just the day
//      (Nov 5: the GE card said "today" instead of a time). The app shows every stamp as "Nov 5, 9:45 am".
// 57 = mission fairness (Nov 5, owner): missions (rule check) count only the first mission_cap (Settings; default 6,
//      0 = off) per person per day, like the quick-card limit; state.points.missionCap / missionToday; pointsLog
//      capped entries carry capWhy. missionsAsk deals cards out in turn, whoever is behind this week first.
// 58 = catch-up bonus (Nov 5, owner: "I don't like the fact that items stop counting"): the daily limits are off by
//      default (QUICK_CAP / MISSION_CAP 0; Settings quick_cap / mission_cap still work). Instead anyone below the
//      week's top score when they score gets 1.5× (at least +1; Settings catchup, 1 or 0 = off), worked out in time
//      order in scoredEvents. state.points.catchup / behind; pointsLog entries carry bonus.
const API_VERSION = 58;
const WRITE_ACTIONS = ['add', 'update', 'addMeal', 'planSet', 'mealSave', 'itemSave', 'reviewAnswer', 'reviewPass', 'reviewLater',
  'listHave', 'listHold', 'requestOrder', 'cartJob', 'cartJobCancel', 'cartPush', 'cartRemove', 'stockLog', 'mealIdea',
  'mealRequest', 'useSoon', 'feedback', 'voiceAdd', 'productPick', 'mealVote', 'missionsAsk'];
const BEST_MIN_PCT = 0.10, BEST_MIN_SAVE = 0.50, BEST_FRESH_DAYS = 30;
const MEAT_QTY_MAX = 3; // api 35: Meals meat_qty, 1-3 of each meat per meal
const RHYTHM_DAYS = 365; // buying rhythm (avg_days) uses purchases from the last year
const SAME_TRIP_DAYS = 2; // buys this close together are one purchase (a receipt and the List tap for the same order)
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
    cartJob: () => withLock(() => addCartJob(Object.assign({}, req, { _system: false }))),
    cartJobCancel: () => withLock(() => cancelCartJob(req)),
    cartJobsOpen: () => openCartJobs(req),
    cartPush: () => withLock(() => cartPush(req)),
    cartRemove: () => withLock(() => cartRemove(req)),
    itemInfo: () => itemInfo(req),
    pointsLog: () => pointsLog(req),
    stockLog: () => withLock(() => stockLogAction(req)),
    mealIdea: () => withLock(() => addMealIdea(req)),
    mealRequest: () => withLock(() => addMealRequest(req)),
    useSoon: () => withLock(() => useSoonAction(req)),
    feedback: () => withLock(() => addFeedback(req)),
    voiceAdd: () => withLock(() => voiceAdd(req)),
    productPick: () => withLock(() => productPick(req)),
    mealVote: () => withLock(() => mealVote(req)),
    missionsAsk: () => withLock(() => missionsAsk(req)),
  };
  const fn = actions[req.action];
  if (!fn) return reply({ ok: false, error: 'unknown_action' });
  // Hardening (api 44): every write must come from someone in Settings parents/kids (or the cart runner), so a
  // typo'd or made-up name can't write rows, and the kid checks inside each action (isKid) can't be skipped by
  // leaving the name off. Reads stay open to anyone with the passcode.
  if (WRITE_ACTIONS.indexOf(req.action) >= 0) {
    const who = String(req.by || '').trim().toLowerCase();
    const known = people().map((p) => p.toLowerCase()).concat(['cart runner']);
    if (known.indexOf(who) < 0) return reply({ ok: false, error: 'Unknown person: pick who you are again (tap your name)' });
  }
  try {
    const out = fn();
    // Every write returns fresh state so the app never has to guess.
    // Reads that don't change anything skip the full state.
    const state = req.action === 'state' || req.action === 'ping' ? out : (req.action === 'itemInfo' || req.action === 'pointsLog' || req.action === 'cartJobsOpen' || req.action === 'voiceAdd') ? undefined : getState();
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

// Speed (Nov 2, api 33): one Spreadsheet handle and one Sheet lookup per tab per request, and inside
// getState each tab is read from the Sheet only once (Review, Settings, Receipts and Plan used to be
// read 2-5 times per state). The read cache keeps raw values and builds fresh objects every time, so
// callers can still change the rows they get. Any write helper drops the cache.
let SS_ = null;
const TAB_ = {};
let READ_CACHE_ = null; // tab name -> raw values, only while getState is building state
function ss() { return SS_ || (SS_ = SpreadsheetApp.getActive()); }
// The tab, or null if it doesn't exist (only found tabs are remembered, so a tab made later is seen).
function tab(name) {
  if (TAB_[name]) return TAB_[name];
  const sh = ss().getSheetByName(name);
  if (sh) TAB_[name] = sh;
  return sh;
}
function sheet(name) {
  const sh = tab(name);
  if (!sh) throw new Error('Missing tab: ' + name);
  return sh;
}
function dropReadCache() { if (READ_CACHE_) READ_CACHE_ = {}; }

// Milliseconds per step of the last getState (returned as state.timing so slow spots are easy to find).
let TIMING_ = null;
function timed(label, fn) {
  const t = Date.now();
  const out = fn();
  if (TIMING_) TIMING_[label] = (TIMING_[label] || 0) + (Date.now() - t);
  return out;
}

// Reads a tab into objects keyed by its header row. Each object knows its row number.
function readTab(name) {
  let raw = READ_CACHE_ && READ_CACHE_[name];
  if (!raw) {
    raw = timed('read ' + name, () => sheet(name).getDataRange().getValues());
    if (READ_CACHE_) READ_CACHE_[name] = raw;
  }
  const values = raw.slice(1);
  const head = raw[0].map(String);
  const keepTime = name === TABS.jobs;
  return values
    .map((row, i) => {
      const o = { _row: i + 2 };
      // Cart Jobs stamps keep their time (Nov 5: a GE check typed as "2026-11-05 9:45:00" became a date cell and read back as just the day).
      head.forEach((h, j) => (o[h] = row[j] instanceof Date ? (keepTime ? isoStamp(row[j]) : isoDate(row[j])) : row[j]));
      return o;
    })
    .filter((o) => String(o[head[0]] || '') !== '');
}

function headers(name) {
  const sh = sheet(name);
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}

// Hardening (api 44): text that starts with = + - @ would turn into a live Sheet formula (a typed note "=IMPORTXML(…)"
// could pull data out). Every value written through appendObj / setFields is stored as plain text instead.
// Values that already start with ' (dates written as text) and non-strings pass through. Real formulas are only
// ever written with setFormulasR1C1 (Items J:M), never through these helpers.
function safeCell(v) {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v;
}

function appendObj(name, obj) {
  dropReadCache();
  const head = headers(name);
  sheet(name).appendRow(head.map((h) => (obj[h] === undefined ? '' : safeCell(obj[h]))));
}

function setFields(name, rowNum, fields) {
  dropReadCache();
  const head = headers(name);
  const sh = sheet(name);
  Object.keys(fields).forEach((k) => {
    const col = head.indexOf(k);
    if (col >= 0) sh.getRange(rowNum, col + 1).setValue(safeCell(fields[k]));
  });
}

// Adds a header at the end of a tab if it isn't there yet (new columns always go at the end).
function ensureColumn(name, col) {
  const head = headers(name);
  if (head.indexOf(col) >= 0) return;
  dropReadCache();
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

// Sheets hand back thousands of date cells per state; the time zone lookup and formatting are
// service calls, so both are remembered for the request.
let TZ_ = null;
const ISO_ = {};
function scriptTz() { return TZ_ || (TZ_ = Session.getScriptTimeZone()); }
function isoDate(d) {
  const k = d.getTime();
  return ISO_[k] || (ISO_[k] = Utilities.formatDate(d, scriptTz(), 'yyyy-MM-dd'));
}

// A Sheet date-time cell as yyyy-MM-ddTHH:mm:ss (just yyyy-MM-dd when it has no time).
function isoStamp(d) {
  const t = Utilities.formatDate(d, scriptTz(), 'HH:mm:ss');
  return Utilities.formatDate(d, scriptTz(), 'yyyy-MM-dd') + (t === '00:00:00' ? '' : 'T' + t);
}

function nowStamp() {
  return Utilities.formatDate(new Date(), scriptTz(), "yyyy-MM-dd'T'HH:mm:ss");
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
  const t0 = Date.now();
  TIMING_ = {};
  try {
    timed('dailyCards', dailyCards); // may write (first open of the day), so it runs before the read cache
    timed('whichCards', whichCards); // api 51: only does anything when the runner set Settings options_new
    READ_CACHE_ = {};
    const st = buildState();
    TIMING_.total = Date.now() - t0;
    st.timing = TIMING_;
    return st;
  } finally {
    READ_CACHE_ = null;
    TIMING_ = null;
  }
}

function buildState() {
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
  const stockRows = tab(TABS.stock) ? readTab(TABS.stock) : [];
  if (stockRows.length) {
    stockRows.forEach((s) => {
      if (s.item_id) stockLatest[s.item_id] = { level: String(s.level), at: String(s.at).slice(0, 10), who: s.who || '' };
      const lvl = String(s.level).toLowerCase();
      const fresh = s.at && daysBetween(String(s.at).slice(0, 10), today) <= 7;
      if (s.item_id && fresh && (lvl === 'plenty' || lvl === 'some' || Number(lvl) > 0)) stocked[s.item_id] = true;
    });
  }

  // Buying rhythm from every purchase we know of (api 28): overrides the receipt-only Items formulas in state.
  const buys = buyHistory(items, list, today);
  items.forEach((it) => {
    const b = buys.byItem[it.id];
    if (!b) return;
    it.last_bought = b.last;
    it.orders = b.orders;
    if (b.avg) it.avg_days = b.avg;
  });

  // "Probably due": we have a buying rhythm for it, it's about that time, and it isn't listed.
  const due = items
    .filter((it) => it.status !== 'Drop' && !isDeliveryItem(it) && it.avg_days && it.last_bought && !onList[it.id] && !stocked[it.id])
    .map((it) => ({ id: it.id, since: daysBetween(it.last_bought, today), every: Number(it.avg_days) }))
    // Due from 2 days before the usual gap until twice the gap (at least a week past it); after that it's
    // something we've stopped buying, and Shop's "Not lately" filter is where it shows.
    .filter((d) => d.since >= d.every - 2 && d.since <= Math.max(2 * d.every, d.every + 7))
    .sort((a, b) => b.since / b.every - a.since / a.every)
    .slice(0, 12);

  const settings = settingsMap();
  // Recently finished rows so the app can show "cleared by receipt" and allow undo.
  const recent = list
    .filter((r) => DONE.indexOf(r.status) >= 0 && r.updated_at && daysBetween(String(r.updated_at).slice(0, 10), today) <= 7)
    .slice(-80); // a week back: In store's cart (bought today) and Shop's "why it left the List" line

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
    freshness: buys.freshness,
    useSoon: useSoonList(today, items, list, stockRows, onList),
    stock: stockLatest,
    products: productsMap(),
    cartJobs: recentCartJobs(today),
    points: pointsSummary(today),
    settings: {
      parents: String(settings.parents || '').split(',').map((s) => s.trim()).filter(String),
      kids: String(settings.kids || '').split(',').map((s) => s.trim()).filter(String),
      ge_order_day: settings.ge_order_day || '',
      wf_order_day: settings.wf_order_day || '',
      order_requested: settings.order_requested || '',
      admins: String(settings.admins || '').split(',').map((s) => s.trim()).filter(String),
      runner_seen: settings.runner_seen instanceof Date ? Utilities.formatDate(settings.runner_seen, scriptTz(), "yyyy-MM-dd'T'HH:mm:ss") : String(settings.runner_seen || ''),
      stores_ok: storesOk(settings.stores_ok),
      watcher_seen: scriptProp('watcher_seen'),
      watcher_chrome: scriptProp('watcher_chrome'),
      stores_checked: settings.stores_checked instanceof Date ? Utilities.formatDate(settings.stores_checked, scriptTz(), "yyyy-MM-dd'T'HH:mm:ss") : String(settings.stores_checked || ''),
    },
  };
}

// Every purchase per item: Receipts rows (any store) plus List / List Archive rows set `bought`. Dates closer than
// SAME_TRIP_DAYS count as one purchase. Returns { byItem: {id: {last, orders, avg}}, freshness: {GE: 'yyyy-mm-dd', ...} }.
// avg = average gap between purchases in the last RHYTHM_DAYS (needs 2+ purchases in that window).
function buyHistory(items, list, today) {
  const dates = {};
  const add = (id, d) => { if (id && /^\d{4}-\d\d-\d\d$/.test(d) && d <= today) (dates[id] = dates[id] || {})[d] = true; };
  const freshness = {};
  const rs = tab(TABS.receipts) ? readTab(TABS.receipts) : [];
  rs.forEach((r) => {
    const d = String(r.date || '').slice(0, 10);
    add(r.item_id, d);
    const st = String(r.store || '');
    if (st && /^\d{4}-\d\d-\d\d$/.test(d) && (!freshness[st] || d > freshness[st])) freshness[st] = d;
  });
  const arch = tab('List Archive') ? readTab('List Archive') : [];
  list.concat(arch).forEach((r) => { if (r.status === 'bought' && r.updated_at) add(r.item_id, dayOf(r.updated_at)); });
  const byItem = {};
  Object.keys(dates).forEach((id) => {
    const ds = Object.keys(dates[id]).sort();
    const trips = [];
    ds.forEach((d) => { if (!trips.length || daysBetween(trips[trips.length - 1], d) > SAME_TRIP_DAYS) trips.push(d); else trips[trips.length - 1] = d; });
    const recent = trips.filter((d) => daysBetween(d, today) <= RHYTHM_DAYS);
    const avg = recent.length >= 2 ? Math.round(daysBetween(recent[0], recent[recent.length - 1]) / (recent.length - 1)) : '';
    byItem[id] = { last: trips[trips.length - 1], orders: trips.length, avg: avg };
  });
  return { byItem: byItem, freshness: freshness };
}

function stripRow(o) {
  const c = Object.assign({}, o);
  delete c._row;
  return c;
}

// Products tab (Claude writes it): the exact product per item per store. For each item + store, keep the
// best row: exact before likely before alt, then the newest last_bought. Store-brand rows (store_brand = Y)
// are options, never "what we buy" unless a parent made them exact; the cheapest priced one per store rides
// along as `sb`. Returns { item_id: { GE: { name, size, aisle, price, unit_price, unit, price_at, sb? } } }.
// Missing tab = {}.
function productsMap() {
  if (!tab(TABS.products)) return {};
  const rank = { exact: 0, likely: 1, alt: 2 };
  const best = {};
  const sb = {};
  const bk = {}; // api 46: our picked substitutes per item|store
  const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? '' : Number(v));
  const day = (v) => (v instanceof Date ? isoDate(v) : String(v || '').slice(0, 10));
  const pick = (p) => ({
    name: String(p.product || ''), size: String(p.size || ''), aisle: String(p.aisle || ''),
    price: num(p.price), unit_price: num(p.unit_price), unit: String(p.unit || ''), price_at: day(p.price_at),
    match: String(p.match || ''), last_bought: day(p.last_bought), sale: /\bsale\b/i.test(String(p.notes || '')) ? 'Y' : '', // api 40 // Nov 4: item screen History when there are no receipts yet
    pack: String(p.pack || ''), // api 35: Products pack ("8 ct"), blank = read from the name
  });
  readTab(TABS.products).forEach((p) => {
    if (!p.item_id || !p.store) return;
    if (String(p.match) === 'option') return; // api 51: seen at the store, not picked yet
    const k = p.item_id + '|' + p.store;
    if (Number(p.backup) > 0) (bk[k] = bk[k] || []).push(p);
    const r = rank[String(p.match)] === undefined ? 3 : rank[String(p.match)];
    const storeBrand = /^y/i.test(String(p.store_brand || ''));
    if (storeBrand && r !== 0) {
      if (num(p.unit_price) !== '') (sb[k] = sb[k] || []).push(p);
      return;
    }
    const b = best[k];
    const newer = String(p.last_bought || '') > String((b && b.last_bought) || '');
    if (!b || r < b._r || (r === b._r && newer)) best[k] = Object.assign({ _r: r }, p);
  });
  const out = {};
  Object.keys(best).forEach((k) => {
    const p = best[k];
    out[p.item_id] = out[p.item_id] || {};
    const o = pick(p);
    // Cheapest store-brand option in the same unit as what we buy (other units can't be compared).
    const opts = (sb[k] || []).filter((x) => String(x.unit || '') === o.unit).sort((a, b) => Number(a.unit_price) - Number(b.unit_price));
    if (opts.length) o.sb = pick(opts[0]);
    out[p.item_id][p.store] = o;
  });
  Object.keys(bk).forEach((k) => {
    const b = bk[k].sort((x, y) => Number(x.backup) - Number(y.backup))[0];
    out[b.item_id] = out[b.item_id] || {};
    out[b.item_id][b.store] = out[b.item_id][b.store] || pick(b);
    out[b.item_id][b.store].backup = { name: String(b.product || ''), size: String(b.size || '') };
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

/* ---------------------------------------------------------------- voice adds (api 41) */

const VOICE_NUMS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, couple: 2 };
const VOICE_FILLER = /^(please |ok |okay |hey )*(add |get |buy |grab |order |put |we need |we're out of |we are out of |were out of |out of |need |i need |i want |can we get |could we get |more |some |another |extra )+/;

// Store names say what a product lacks ("No Sugar Added", "Sugar Free", "50% Less Sugar"); those words don't count.
function voiceDescribe(s) {
  return String(s || '').toLowerCase()
    .replace(/\b(no|zero|less|lower|low in|reduced|without)\s+(added\s+)?[a-z]+(\s+added)?/g, ' ')
    .replace(/\b[a-z]+[- ]free\b/g, ' ');
}
function voiceWords(s) {
  return String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(String);
}
// Plural-tolerant word match: "avocados" ~ "avocado", "berries" ~ "berry".
function voiceStem(w) {
  if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (w.length > 3 && /(ches|shes|oes|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
  return w;
}

// One spoken part → {qty, words}. "two dozen eggs" → 2 + "dozen eggs" is rare; we take the first number only.
function voicePart(raw) {
  let t = String(raw || '').toLowerCase().replace(/[’']/g, "'").trim();
  t = t.replace(/\b(to|on|onto|in|into) (the )?(poppy|list|grocery list|shopping list)( list)?\b.*$/, '').trim();
  let prev;
  do { prev = t; t = t.replace(VOICE_FILLER, '').trim(); } while (t !== prev);
  let qty = 1;
  const m = t.match(/^(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|couple)( of)?\s+(.+)$/);
  if (m) {
    qty = /^\d+$/.test(m[1]) ? Number(m[1]) : VOICE_NUMS[m[1]];
    t = m[3];
  }
  // "a dozen eggs" is one carton; packs, bags and boxes are the unit we already buy.
  t = t.replace(/^(of |the |some |more |dozen |dozens of |pack of |packs of |bag of |bags of |box of |boxes of |carton of |cartons of |bottle of |bottles of |jar of |jars of )+/, '').trim();
  return { qty: Math.max(1, Math.min(qty || 1, 24)), text: t, words: voiceWords(t).map(voiceStem) };
}

// Catalog candidates for a spoken part, best first: [{item, total, score, own}]. score 100 = exact name, 95 = exact
// alias, 75 = every spoken word is in the name, 70 = in an alias, 60 = in a store product name. own = every word
// of the item's own name was said ("salted butter" for Salted butter). Ties go to what we bought lately.
function voiceCandidates(items, productsByItem, part) {
  if (!part.words.length) return [];
  const want = part.words.join(' ');
  const today = Date.now();
  const out = [];
  items.forEach((it) => {
    if (!it.id || !String(it.name || '').trim()) return;
    const drop = /^drop/i.test(String(it.status || ''));
    // ALL-CAPS aliases are receipt codes ("BUSH CHILI BEANS MAC"), not words people say.
    const names = [String(it.name)].concat(String(it.aliases || '').split(/[;,]/).filter((a) => /[a-z]/.test(a))).map((s) => voiceWords(voiceDescribe(s)).map(voiceStem)).filter((w) => w.length);
    const prods = (productsByItem[it.id] || []).map((s) => voiceWords(voiceDescribe(s)).map(voiceStem));
    let score = 0, extra = 99;
    names.forEach((w, i) => { if (w.join(' ') === want) { score = Math.max(score, i === 0 ? 100 : 95); extra = 0; } });
    if (!score) {
      // Spoken words are whole words, so match whole (stemmed) words, not prefixes ("mac" isn't "machine").
      const covers = (w) => part.words.every((q) => w.indexOf(q) >= 0);
      names.forEach((w, i) => { if (covers(w)) { score = Math.max(score, i === 0 ? 75 : 70); extra = Math.min(extra, w.length - part.words.length); } });
      if (!score) prods.forEach((w) => { if (covers(w)) { score = Math.max(score, 60); extra = Math.min(extra, w.length - part.words.length); } });
    }
    if (!score) return;
    if (drop) { if (score < 95) return; score -= 10; }
    const own = names.length && names[0].every((x) => part.words.indexOf(x) >= 0);
    const lb = it.last_bought ? new Date(it.last_bought).getTime() : 0;
    const days = lb ? (today - lb) / 864e5 : 9999;
    const fresh = days <= 60 ? 4 : days <= 180 ? 2 : 0;
    out.push({ item: it, total: score + fresh - Math.min(extra, 6), score: score, own: own });
  });
  return out.sort((x, y) => y.total - x.total);
}
// Sure enough to add without asking (owner, Nov 4: "don't turn sugar into brown sugar"): an exact name or alias,
// or the only item whose whole name was said. Anything else is a question in the speaker's Inbox, and the answer
// teaches Poppy (the spoken words become an alias).
function voiceSure(cands) {
  if (!cands.length) return null;
  if (cands[0].score >= 95) return cands[0];
  const own = cands.filter((c) => c.own);
  return own.length === 1 ? own[0] : null;
}
function voiceMatch(items, productsByItem, part) {
  const c = voiceCandidates(items, productsByItem, part);
  return c.length ? c[0] : null;
}

function voiceJoin(list) {
  if (list.length <= 1) return list.join('');
  return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

function voiceAdd(req) {
  const by = String(req.by || '').trim();
  const st = settingsMap();
  const people = String(st.parents || '').split(',').concat(String(st.kids || '').split(',')).map((s) => s.trim()).filter(String);
  const who = people.find((p) => p.toLowerCase() === by.toLowerCase());
  if (!who) throw new Error('Unknown name "' + by + '". Set "by" in the shortcut to one of: ' + people.join(', '));
  const text = String(req.text || '').trim();
  if (!text) return { say: 'I didn’t catch anything to add.', added: [] };

  let items = readTab(TABS.items);
  const productsByItem = {};
  readTab(TABS.products).forEach((r) => { if (r.item_id) (productsByItem[r.item_id] = productsByItem[r.item_id] || []).push(r.product); });
  // Split on commas and the like first; split a chunk on "and" only when the whole chunk isn't one thing we buy
  // and every piece is ("mac and cheese", "salt and vinegar chips" stay one thing).
  const parts = [];
  text.split(/\s*(?:,|;|&|\bplus\b|\band then\b|\band also\b|\balso\b)\s*/i).forEach((chunk) => {
    const whole = voicePart(chunk);
    if (!whole.words.length) return;
    if (!/\band\b/i.test(chunk) || voiceSure(voiceCandidates(items, productsByItem, whole))) { parts.push(whole); return; }
    const pieces = chunk.split(/\s*\band\b\s*/i).map(voicePart).filter((x) => x.words.length);
    if (pieces.every((x) => voiceCandidates(items, productsByItem, x).length)) pieces.forEach((x) => parts.push(x));
    else parts.push(whole);
  });

  const added = [], already = [], asked = [], unknown = [];
  const review = readTab(TABS.review);
  let n = nextIdNum(review);
  parts.forEach((p) => {
    const cands = voiceCandidates(items, productsByItem, p);
    const sure = voiceSure(cands);
    if (sure) {
      const res = addToList({ by: who, item_id: sure.item.id, qty: p.qty, note: 'by Siri' });
      const label = (p.qty > 1 ? p.qty + ' ' : '') + String(sure.item.name);
      if (res.merged) already.push(label); else added.push(label);
      return;
    }
    // Not sure: one card to the speaker. Nothing goes on the List until they pick.
    const top = cands.slice(0, 3);
    const nice = p.text.charAt(0).toUpperCase() + p.text.slice(1);
    const opts = top.map((c) => String(c.item.name).replace(/;/g, ',')).concat(['New item: ' + nice, 'Something else (type it)', 'Never mind']);
    ensureColumn(TABS.review, 'asked_by');
    appendObj(TABS.review, {
      id: 'r' + String(n++).padStart(3, '0'), created: nowStamp(), type: 'voice', status: 'open', answer: '', audience: who, asked_by: who,
      detail: '🎙 Siri heard “' + p.text + '”' + (p.qty > 1 ? ' (×' + p.qty + ')' : '') + '. ' +
        (top.length ? 'Which is it?' : 'Poppy doesn’t know it yet. Add it as a new item?') + ' ' + top.map((c) => '(' + c.item.id + ')').join(' ') + ' Options: ' + opts.join('; '),
    });
    (top.length ? asked : unknown).push(p.text);
  });

  const kid = isKid(who);
  const bits = [];
  if (added.length) bits.push((kid ? 'Asked for ' : 'Added ') + voiceJoin(added) + (kid ? '. A parent will OK it.' : ' to the list.'));
  if (already.length) bits.push(voiceJoin(already) + (already.length > 1 ? ' were' : ' was') + ' already on the list.');
  if (asked.length) bits.push('Which ' + voiceJoin(asked) + '? I put a question in your Inbox.');
  if (unknown.length) bits.push(voiceJoin(unknown) + (unknown.length > 1 ? ' are' : ' is') + ' new to Poppy. Check your Inbox to add ' + (unknown.length > 1 ? 'them' : 'it') + '.');
  return { say: bits.join(' ') || 'Nothing to add.', added: added, already: already, asked: asked, unknown: unknown };
}

// A `voice` card's answer (api 43): a listed item → on the List and the spoken words become one of its aliases,
// so next time Siri adds it without asking; "New item: X" or a typed name → that item (new if Poppy doesn't know
// it); Never mind / Don't care → nothing.
function voiceAnswer(r, answer, who) {
  const a = String(answer).replace(/\s*\([^()]*\)\s*$/, '').trim();
  const al = a.toLowerCase();
  if (!a || al === 'skip' || /^never mind|^don.?t care/.test(al)) return null;
  const d = String(r.detail || '');
  const heard = (d.match(/“([^”]+)”/) || [])[1] || '';
  const qty = Number((d.match(/\(×(\d+)\)/) || [])[1]) || 1;
  const by = String(r.asked_by || who || '').trim() || who;
  const ids = (d.split(/Options:/)[0].match(/\((i\d{3,})\)/g) || []).map((x) => x.slice(1, -1));
  const items = readTab(TABS.items);
  let it = null, name = a;
  if (/^new item:/i.test(a)) name = a.replace(/^new item:\s*/i, '');
  else it = items.find((x) => ids.indexOf(x.id) >= 0 && String(x.name).replace(/;/g, ',').toLowerCase() === al) || findItemByName(items, a);
  if (!it && !/^new item:/i.test(a)) {
    const c = voiceSure(voiceCandidates(items, {}, voicePart(a)));
    if (c) it = c.item;
  }
  const res = it ? addToList({ by: by, item_id: it.id, qty: qty, note: 'by Siri' }) : addToList({ by: by, name: name, qty: qty, note: 'by Siri (new item)' });
  // Teach: what was said becomes an alias of the item picked (or of the new item, if its name differs).
  const itemId = it ? it.id : ((readTab(TABS.list).find((x) => x.id === res.id) || {}).item_id || '');
  if (heard && itemId) {
    const row = readTab(TABS.items).find((x) => x.id === itemId);
    if (row && String(row.name).toLowerCase() !== heard.toLowerCase()) {
      const al2 = String(row.aliases || '').split(';').map((x) => x.trim()).filter(String);
      if (al2.map((x) => x.toLowerCase()).indexOf(heard.toLowerCase()) < 0) setFields(TABS.items, row._row, { aliases: al2.concat([heard]).join(';') });
    }
  }
  return { list: res.id, item: itemId, alias: heard };
}

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
  // Delivery items (Wildgrain, Bleu Box) have nothing to buy: a mission's "out" or a meal's ingredients skip them.
  if (isDeliveryItem(item)) return { id: '', merged: false, delivery: DELIVERY_SOURCES[item.store] };

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
    // so the family can see "owner + parent" and decide whether that means one or two.
    const wanted = wantedList(existing);
    const f = { updated_at: nowStamp() };
    const already = wanted.map((w) => w.toLowerCase()).indexOf(String(req.by).toLowerCase()) >= 0;
    if (!already) f.wanted_by = wanted.concat([req.by]).join(';');
    if (req.bump === true) f.qty = (Number(existing.qty) || 1) + qty;
    // api 35: a meal set to "make more" needs at least that many, even when the row was already on the List.
    else if (req.min_qty && (Number(existing.qty) || 1) < req.min_qty) {
      f.qty = req.min_qty;
      Object.assign(f, cartQtyFields(existing, f.qty, req.by));
    }
    setFields(TABS.list, existing._row, f);
    if (!already && !req._noPoints && !isKid(req.by)) awardPoints(req.by, 'list_add', existing.id, req.by, 'Added ' + existing.name + ' to the List');
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
  // Parents score when they add; a kid's add is a request and scores when a parent approves it.
  if (!req._noPoints && !isKid(req.by)) awardPoints(req.by, 'list_add', id, req.by, 'Added ' + item.name + ' to the List');
  if (!isKid(req.by) && /^y/i.test(String(item.best_price || ''))) { try { addBestPriceCards(id); } catch (e) { /* a card can wait for tomorrow */ } }
  return { id: id, merged: false };
}

// Everyone who asked for a List row: wanted_by (owner;parent), falling back to added_by for older rows.
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
  // A carted row taken off the List (or grabbed in the store) comes out of the online cart too.
  if (row.status === 'carted' && (f.status === 'skipped' || f.status === 'have' || (f.status === 'bought' && req.cart_out))) Object.assign(f, cartOutFields(row, req.by));
  // api 34: a parent changing how many of a carted row → that cart line's qty gets changed too.
  else if (f.qty !== undefined) Object.assign(f, cartQtyFields(row, f.qty, req.by));
  setFields(TABS.list, row._row, f);
  // A parent handling a kid's request: the parent scores for deciding; the kid scores once it's approved.
  if (row.status === 'requested' && f.status && f.status !== 'requested' && !isKid(req.by)) {
    awardPoints(req.by, 'approve', row.id, req.by, (f.status === 'needed' ? 'Approved ' : 'Skipped ') + row.name);
    if (f.status === 'needed' && !/^Mission:/.test(String(row.note || ''))) wantedList(row).filter(isKid).forEach((k) => awardPoints(k, 'list_add', row.id, req.by, 'Added ' + row.name + ' to the List (approved)'));
  }
  return { id: row.id };
}

function addMealToList(req) {
  if (isKid(req.by)) throw new Error('Ask a parent to add what a meal needs'); // api 38
  const meal = readTab(TABS.meals).find((m) => m.id === req.meal_id);
  if (!meal) throw new Error('Meal not found');
  const ids = req.item_ids && req.item_ids.length ? req.item_ids : String(meal.item_ids).split(';').filter(String);
  // api 35 (make more): Meals meat_qty (blank = 1) = how many of each Meat-group ingredient go on the List.
  const meatQty = mealMeatQty(meal);
  const meat = {};
  if (meatQty > 1) readTab(TABS.items).forEach((it) => { if (String(it.group) === 'Meat') meat[it.id] = true; });
  ids.forEach((itemId) => {
    const o = { item_id: itemId, by: req.by, meal_id: meal.id, bump: false, _noPoints: true };
    if (meat[itemId]) { o.qty = meatQty; o.min_qty = meatQty; }
    addToList(o);
  });
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
  // api 30: a slot can hold a catalog item instead of a meal (a snack that's just something we buy,
  // like trail mix). Meals are things with 2+ ingredients and a recipe. One or the other, never both.
  const itemId = req.meal_id ? '' : String(req.item_id || '');
  if (itemId) {
    if (!readTab(TABS.items).some((it) => it.id === itemId)) throw new Error('Item not found');
    ensureColumn(TABS.plan, 'item_id');
  }
  const keep = req.meal_id || itemId || (note !== null ? note : existing && existing.note);
  const what = { meal_id: req.meal_id || '' };
  if (itemId || headers(TABS.plan).indexOf('item_id') >= 0) what.item_id = itemId;
  if (existing) {
    if (!keep) sheet(TABS.plan).deleteRow(existing._row);
    else setFields(TABS.plan, existing._row, Object.assign(fields, what));
  } else if (keep) {
    appendObj(TABS.plan, Object.assign(fields, what));
  }
  return { date: date, day: fields.day, slot: slot };
}

// Blank = 1 (the default), so the column stays empty for most meals.
function meatQtyField(v) {
  const n = parseInt(v, 10);
  return n >= 2 && n <= MEAT_QTY_MAX ? n : '';
}
function mealMeatQty(meal) {
  const n = parseInt(meal && meal.meat_qty, 10);
  return n >= 1 && n <= MEAT_QTY_MAX ? n : 1;
}

function saveMeal(req) {
  if (isKid(req.by)) throw new Error('Only parents can edit meals');
  const meals = readTab(TABS.meals);
  const ids = (req.item_ids || []).join(';');
  const existing = req.id ? meals.find((m) => m.id === req.id) : null;
  if (existing) {
    const f = { name: req.name || existing.name, item_ids: ids, notes: req.notes || existing.notes };
    if (req.kind && headers(TABS.meals).indexOf('kind') >= 0) f.kind = String(req.kind).toLowerCase();
    if (req.meat_qty !== undefined) { f.meat_qty = meatQtyField(req.meat_qty); ensureColumn(TABS.meals, 'meat_qty'); }
    // A rename keeps the old name (api 47), so name-only vote cards and searches still find the meal.
    const was = String(existing.name || '').trim();
    if (req.name && was && String(req.name).trim() !== was) {
      const olds = String(existing.old_names || '').split(';').map((x) => x.trim()).filter(String);
      if (olds.map((x) => x.toLowerCase()).indexOf(was.toLowerCase()) < 0) olds.push(was);
      ensureColumn(TABS.meals, 'old_names');
      f.old_names = olds.join('; ');
    }
    setFields(TABS.meals, existing._row, f);
    return { id: existing.id };
  }
  const id = nextId(meals, 'id', 'm', 2);
  const row = { id: id, name: req.name, item_ids: ids, notes: req.notes || '' };
  if (headers(TABS.meals).indexOf('kind') >= 0) row.kind = SLOTS.indexOf(String(req.kind || '').toLowerCase()) >= 0 ? String(req.kind).toLowerCase() : 'dinner';
  if (req.meat_qty !== undefined) { row.meat_qty = meatQtyField(req.meat_qty); ensureColumn(TABS.meals, 'meat_qty'); }
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
  const allowed = ['name', 'store', 'group', 'brand_size', 'ok_swap', 'status', 'notes', 'store_only', 'shelf_days', 'open_to_try', 'best_price', 'sold_by', 'mini_fridge', 'pantry'];
  const f = {};
  allowed.forEach((k) => req.fields && req.fields[k] !== undefined && (f[k] = req.fields[k]));
  // api 45: sold by the pound (List qty in lb, ½ lb steps) or each (blank).
  if (f.sold_by !== undefined) { f.sold_by = /^lb/i.test(String(f.sold_by)) ? 'lb' : ''; ensureColumn(TABS.items, 'sold_by'); }
  // api 45: "words we say" (search + Siri). Receipt codes (ALL CAPS aliases) are kept as they are.
  if (req.fields && req.fields.spoken !== undefined) {
    const codes = String(item.aliases || '').split(';').map((x) => x.trim()).filter((x) => x && !/[a-z]/.test(x));
    const said = String(req.fields.spoken || '').split(/[;,]/).map((x) => x.trim().toLowerCase()).filter(String);
    f.aliases = codes.concat(said.filter((x, i) => said.indexOf(x) === i)).join(';');
  }
  if (f.best_price !== undefined) { f.best_price = /^y/i.test(String(f.best_price)) ? 'Y' : ''; ensureColumn(TABS.items, 'best_price'); }
  // api 53: goes in the mini fridges (Y / blank). The app shows a 🥤 Mini fridge tag on the item everywhere.
  if (f.mini_fridge !== undefined) { f.mini_fridge = /^y/i.test(String(f.mini_fridge)) ? 'Y' : ''; ensureColumn(TABS.items, 'mini_fridge'); }
  // api 54: pantry staple (Y / blank): assumed on hand for Missing for meals and meal missions.
  if (f.pantry !== undefined) { f.pantry = /^y/i.test(String(f.pantry)) ? 'Y' : ''; ensureColumn(TABS.items, 'pantry'); }
  if (f.store_only !== undefined) { f.store_only = /^y/i.test(String(f.store_only)) ? 'Y' : ''; ensureColumn(TABS.items, 'store_only'); }
  if (f.open_to_try !== undefined) { f.open_to_try = /^y/i.test(String(f.open_to_try)) ? 'Y' : ''; ensureColumn(TABS.items, 'open_to_try'); }
  if (f.shelf_days !== undefined) {
    const n = parseInt(f.shelf_days, 10);
    f.shelf_days = n > 0 && n <= 365 ? n : '';
    ensureColumn(TABS.items, 'shelf_days');
  }
  setFields(TABS.items, item._row, f);
  return { id: item.id };
}

// Where the kids stand this week, and how many missions each gets today. All tied (e.g. Monday morning)
// → everyone gets the tied number; otherwise the leader(s) get the lead number and everyone behind gets more.
function kidRace(today, kids) {
  const week = (pointsSummary(today).week) || {};
  const pts = {}; kids.forEach((k) => (pts[k] = week[k] || 0));
  const top = kids.length ? Math.max.apply(null, kids.map((k) => pts[k])) : 0;
  const tied = kids.length < 2 || kids.every((k) => pts[k] === top);
  const out = { week: pts, leader: [], behind: [], tied: tied, missions: {} };
  kids.forEach((k) => {
    if (kids.length < 2) { out.missions[k] = MISSIONS_PER_KID; return; }
    if (tied) { out.missions[k] = KID_MISSIONS.tied; return; }
    if (pts[k] === top) { out.leader.push(k); out.missions[k] = KID_MISSIONS.lead; } else { out.behind.push(k); out.missions[k] = KID_MISSIONS.behind; }
  });
  return out;
}

// Today's missions: things worth a look right now, split between the kids so each gets different ones.
// Ingredients of meals planned in the next MISSION_PLAN_DAYS first, then the most overdue "probably due"
// items. Skips anything on the List, sighted in the last MISSION_RECHECK_DAYS, or already on an open check.
function makeMissions(today, kids, review, plan, mealOf) {
  if (!kids.length) return [];
  const items = readTab(TABS.items).filter((i) => i.status !== 'Drop');
  const byId = {}; items.forEach((i) => (byId[i.id] = i));
  const onList = {};
  readTab(TABS.list).forEach((r) => { if (r.item_id && ACTIVE.indexOf(r.status) >= 0) onList[r.item_id] = true; });
  const seen = {};
  if (tab(TABS.stock)) {
    readTab(TABS.stock).forEach((x) => {
      if (x.item_id && x.at && daysBetween(String(x.at).slice(0, 10), today) < MISSION_RECHECK_DAYS) seen[x.item_id] = true;
    });
  }
  review.forEach((r) => {
    if (r.type === 'check' && r.status === 'open') { const m = String(r.detail).match(/\((i\d{3,})\)/); if (m) seen[m[1]] = true; }
  });
  const ok = (id) => byId[id] && !onList[id] && !seen[id];
  const picks = [];
  const take = (id, why) => { if (ok(id) && picks.every((p) => p.id !== id)) picks.push({ id: id, why: why }); };
  plan.filter((p) => { const d = planDate(p); return d && d >= today && daysBetween(today, d) < MISSION_PLAN_DAYS && !isLeftover(p) && (mealOf[p.meal_id] || (p.item_id && byId[p.item_id])); })
    .sort((a, b) => (planDate(a) < planDate(b) ? -1 : 1))
    .forEach((p) => {
      if (mealOf[p.meal_id]) String(mealOf[p.meal_id].item_ids || '').split(/[;,\s]+/).filter(String)
        .filter((id) => !(byId[id] && /^y/i.test(String(byId[id].pantry || '')))) // api 54: pantry staples aren't checked for meals
        .forEach((id) => take(id, mealOf[p.meal_id].name));
      else take(p.item_id, byId[p.item_id].name); // a planned item (api 30)
    });
  items.filter((i) => i.avg_days && i.last_bought)
    .map((i) => ({ id: i.id, r: daysBetween(String(i.last_bought).slice(0, 10), today) / Number(i.avg_days), late: daysBetween(String(i.last_bought).slice(0, 10), today) >= Number(i.avg_days) - 2 }))
    .filter((x) => x.late).sort((a, b) => b.r - a.r).forEach((x) => take(x.id, ''));
  // Each kid's share comes from the race (leader 3, tied 4, behind 5); whoever is behind picks first,
  // so the meal-ingredient checks go to her. Her extra ones are marked as catch-up missions.
  const race = kidRace(today, kids);
  const order = kids.slice().sort((a, b) => (race.week[a] || 0) - (race.week[b] || 0));
  const left = {}; order.forEach((k) => (left[k] = race.missions[k]));
  const out = [];
  const given = {};
  let i = 0;
  while (i < picks.length && order.some((k) => left[k] > 0)) {
    order.forEach((kid) => {
      if (i >= picks.length || left[kid] <= 0) return;
      const p = picks[i++];
      left[kid]--;
      given[kid] = (given[kid] || 0) + 1;
      const extra = race.behind.indexOf(kid) >= 0 && given[kid] > KID_MISSIONS.lead;
      out.push({ type: 'check', audience: kid,
        detail: (extra ? '⚡ Catch-up mission! ' : '') + 'Go check the ' + byId[p.id].name + ': how much do we have?' + (p.why ? ' It\'s for ' + p.why + '.' : '') + ' (' + p.id + ') Options: ' + MISSION_OPTIONS });
    });
  }
  return out;
}

// A mission answer ("Some", "A little", "6", …) becomes a Stock sighting; low or out also puts the item
// on the List (a kid's answer as a request a parent approves, a parent's as needed).
function missionAnswer(r, answer, who) {
  const id = (String(r.detail).match(/\((i\d{3,})\)/) || [])[1];
  const a = String(answer).replace(/\s*\([^()]*\)\s*$/, '').trim().toLowerCase();
  if (!id || !a || a === 'skip') return null;
  const level = /^\d{1,3}$/.test(a) ? a : MISSION_LEVEL[a];
  if (!level) return null;
  logStock({ item_id: id, level: level, who: who, source: 'mission' });
  if (level === 'low' || level === 'out' || level === '0') {
    const res = addToList({ item_id: id, by: who, _noPoints: true, note: 'Mission: ' + (level === 'low' ? 'a little left' : 'out') });
    return { level: level, list: res.id };
  }
  return { level: level };
}

// A parent answers a kid's "we have it" (have_check): Yes takes the row off (status have).
function haveCheckAnswer(r, answer, who) {
  const listId = (String(r.detail).match(/\((L\d{4,})\)/) || [])[1];
  const a = String(answer).replace(/\s*\([^()]*\)\s*$/, '').trim().toLowerCase();
  if (!listId || !/^yes/.test(a)) return null;
  const row = readTab(TABS.list).find((x) => x.id === listId);
  const level = (String(r.detail).match(/we have (plenty|some|a little|\d{1,3}) of/) || [])[1] || 'some';
  const lv = level === 'a little' ? 'low' : level;
  if (row && ACTIVE.indexOf(row.status) >= 0) listHave({ id: listId, level: lv, by: String(r.asked_by || who), _approved: true });
  return { list: listId };
}

/* ---------------------------------------------------------------- settling the List (api 17) */

const LIST_ID_RE = /\((L\d{4,})\)/;
const rowStamp = (r, k) => stampOf(r[k]).slice(0, 10);
// When a List row was last touched: updated_at, else added_at.
const rowTouched = (r) => rowStamp(r, 'updated_at') || rowStamp(r, 'added_at');

// Which List rows need a human to say what happened, picked once a day:
//  1. a filled cart a couple of days old → one "Did the <store> order come?" card to the parents (3+ rows), else per row;
//  2. rows someone saw at home (a Plenty / Some / count sighting after the row was added): it was probably bought;
//  3. needed rows nobody has touched in SETTLE_STALE_DAYS.
// Kids get the go-look ones (food and household they can see at home); parents get the rest.
// Never a held row, a kid's unapproved request, or a row (or store order) asked about in SETTLE_REASK_DAYS.
function makeSettle(today, kids, review) {
  const list = readTab(TABS.list).filter((r) => (r.status === 'needed' || r.status === 'carted') && !(String(r.hold_until || '') > today));
  if (!list.length) return [];
  const asked = {};
  review.forEach((r) => {
    if ((r.type !== 'settle' && r.type !== 'settle_order') || !r.created) return;
    if (r.status !== 'open' && daysBetween(String(r.created).slice(0, 10), today) >= SETTLE_REASK_DAYS) return;
    const m = String(r.detail).match(LIST_ID_RE); if (m) asked[m[1]] = true;
    const o = String(r.detail).match(/\(order (\w+)\)/); if (o) asked['order ' + o[1]] = true;
  });
  const seen = {};
  if (tab(TABS.stock)) {
    readTab(TABS.stock).forEach((x) => {
      const lv = String(x.level || '').toLowerCase();
      if (x.item_id && x.at && (lv === 'plenty' || lv === 'some' || (/^\d+$/.test(lv) && Number(lv) > 0))) {
        const d = stampOf(x.at).slice(0, 10) || String(x.at).slice(0, 10);
        if (!seen[x.item_id] || d > seen[x.item_id]) seen[x.item_id] = d;
      }
    });
  }
  const out = [];
  const used = {};
  const since = (iso) => { const d = new Date(iso + 'T12:00:00'); return isNaN(d) ? '' : DAY_NAMES[d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate(); };

  // 1. Filled carts.
  const carted = list.filter((r) => r.status === 'carted' && rowStamp(r, 'cart_at') && daysBetween(rowStamp(r, 'cart_at'), today) >= SETTLE_CART_DAYS);
  const byStore = {};
  carted.forEach((r) => { const st = String(r.cart || r.store || ''); (byStore[st] = byStore[st] || []).push(r); });
  const parentRows = [];
  Object.keys(byStore).forEach((st) => {
    const rows = byStore[st];
    if (rows.length >= 3) {
      rows.forEach((r) => (used[r.id] = true));
      if (asked['order ' + st]) return;
      const name = STORE_NAMES[st] || st;
      const when = rows.map((r) => rowStamp(r, 'cart_at')).sort()[0];
      out.push({ type: 'settle_order', audience: 'parents',
        detail: 'Did the ' + name + ' order come? ' + rows.length + ' things went in the cart ' + since(when) + ': ' +
          rows.slice(0, 6).map((r) => r.name).join(', ') + (rows.length > 6 ? ', …' : '') + '. (order ' + st + ') Options: ' + SETTLE_ORDER_OPTIONS });
    } else rows.forEach((r) => { if (!asked[r.id]) { used[r.id] = true; parentRows.push({ r: r, why: 'cart' }); } });
  });

  // 2 + 3. Seen at home, then stale.
  const kidRows = [];
  list.forEach((r) => {
    if (used[r.id] || asked[r.id]) return;
    const added = rowStamp(r, 'added_at') || rowTouched(r);
    const sawIt = r.item_id && seen[r.item_id] && added && seen[r.item_id] >= added && r.status === 'needed';
    const stale = r.status === 'needed' && rowTouched(r) && daysBetween(rowTouched(r), today) >= SETTLE_STALE_DAYS;
    if (!sawIt && !stale) return;
    const x = { r: r, why: sawIt ? 'seen' : 'stale', added: added };
    if (kids.length) kidRows.push(x); else parentRows.push(x);
  });
  // Seen-at-home first, oldest first.
  const order = (a, b) => (a.why !== b.why ? (a.why === 'seen' ? -1 : 1) : (a.added < b.added ? -1 : 1));
  kidRows.sort(order);
  const raceWeek = kids.length ? pointsSummary(today).week || {} : {};
  // Kids take up to SETTLE_PER_KID each, the rest go to the parents.
  const kidOrder = kids.slice().sort((a, b) => (raceWeek[a] || 0) - (raceWeek[b] || 0)); // whoever is behind goes first
  kidRows.forEach((x, i) => {
    const kid = kidOrder[i % kidOrder.length];
    if (i < SETTLE_PER_KID * kids.length) {
      out.push({ type: 'settle', audience: kid,
        detail: 'Did we get the ' + x.r.name + '? It\'s been on the List since ' + since(x.added) + '. Go look and tell us. (' + x.r.id + ')' + (x.r.item_id ? ' (' + x.r.item_id + ')' : '') + ' Options: ' + SETTLE_KID_OPTIONS });
    } else parentRows.push(x);
  });
  parentRows.sort(order).slice(0, SETTLE_PARENTS).forEach((x) => {
    const why = x.why === 'cart' ? 'It went in the ' + (STORE_NAMES[String(x.r.cart || x.r.store)] || 'store') + ' cart ' + since(rowStamp(x.r, 'cart_at')) + '.'
      : x.why === 'seen' ? 'Someone saw some at home since it was added.' : 'It\'s been on the List since ' + since(x.added) + '.';
    out.push({ type: 'settle', audience: 'parents',
      detail: 'Did we get the ' + x.r.name + '? ' + why + ' (' + x.r.id + ')' + (x.r.item_id ? ' (' + x.r.item_id + ')' : '') + ' Options: ' + SETTLE_PARENT_OPTIONS });
  });
  return out;
}

// Meals that left the plan (Hearth week replaced them, a parent changed the day): List rows still tied to a
// meal that isn't planned from SETTLE_MEAL_GRACE_DAYS ago through the next PLAN_DAYS get one parents' card per
// meal. Rows added in the last couple of days are left alone (someone may be about to plan it).
function mealPlannedSet(today, plan) {
  const from = addDays(today, -SETTLE_MEAL_GRACE_DAYS), to = addDays(today, PLAN_DAYS);
  const planned = {};
  plan.forEach((p) => { const d = planDate(p); if (d && d >= from && d <= to && p.meal_id) planned[p.meal_id] = true; });
  return planned;
}
function makeMealSettle(today, review, plan, mealOf) {
  const planned = mealPlannedSet(today, plan);
  const asked = {};
  review.forEach((r) => {
    if (r.type !== 'settle_meal') return;
    if (r.status !== 'open' && r.created && daysBetween(String(r.created).slice(0, 10), today) >= SETTLE_REASK_DAYS) return;
    const m = String(r.detail).match(/\(meal (m\d+)\)/); if (m) asked[m[1]] = true;
  });
  const by = {};
  readTab(TABS.list).forEach((r) => {
    if (r.status !== 'needed' || !r.meal_id || planned[r.meal_id] || asked[r.meal_id]) return;
    const added = rowStamp(r, 'added_at');
    if (added && daysBetween(added, today) < SETTLE_MEAL_GRACE_DAYS) return;
    (by[r.meal_id] = by[r.meal_id] || []).push(r);
  });
  return Object.keys(by).map((id) => {
    const rows = by[id], name = mealOf[id] ? mealOf[id].name : 'A meal';
    return { type: 'settle_meal', audience: 'parents',
      detail: rows.length === 1
        ? name + ' isn\'t on the plan anymore, but the List still has ' + rows[0].name + ' for it. Take it off, or keep it as a regular item? (meal ' + id + ') Options: Take it off; Keep it'
        : name + ' isn\'t on the plan anymore, but ' + rows.length + ' things for it are still on the List: ' + rows.slice(0, 8).map((r) => r.name).join(', ') + (rows.length > 8 ? ', …' : '') +
          '. Take them off, or keep them as regular items? (meal ' + id + ') Options: ' + SETTLE_MEAL_OPTIONS };
  });
}

// "<meal> isn't on the plan anymore" → Take them off: those needed rows → skipped. Keep them: the rows stay
// as regular items (meal_id cleared). Rows in a store cart only lose the meal link.
function settleMealAnswer(r, answer, who) {
  const id = (String(r.detail).match(/\(meal (m\d+)\)/) || [])[1];
  const a = String(answer).replace(/\s*\([^()]*\)\s*$/, '').trim().toLowerCase();
  if (!id || !a || a === 'skip') return null;
  const off = /^take/.test(a), keep = /^keep/.test(a);
  if (!off && !keep) return null;
  const stamp = nowStamp();
  let n = 0;
  readTab(TABS.list).filter((x) => x.meal_id === id && ACTIVE.indexOf(x.status) >= 0 && x.status !== 'requested').forEach((x) => {
    if (off && x.status === 'needed') setFields(TABS.list, x._row, { status: 'skipped', hold_until: '', meal_id: '', updated_at: stamp, note: listNote(x, 'meal came off the plan (' + who + ')') });
    else setFields(TABS.list, x._row, { meal_id: '', updated_at: stamp });
    n++;
  });
  return { meal: id, rows: n, off: off };
}

// One "Did we get it?" answer → the List row.
//  It's here / Got it → done (bought if it was in a cart or a parent says got it, else have) + a Stock sighting;
//  Not here / Still need it → stays on the List (touched, so it isn't asked again for a week); Not here logs "out";
//  Don't need it → skipped. A row that's already done (receipt, In store) is left alone.
function settleAnswer(r, answer, who) {
  const id = (String(r.detail).match(LIST_ID_RE) || [])[1];
  const a = String(answer).replace(/\s*\([^()]*\)\s*$/, '').trim().toLowerCase();
  if (!id || !a || a === 'skip') return null;
  const row = readTab(TABS.list).find((x) => x.id === id);
  if (!row || ACTIVE.indexOf(row.status) < 0) return { list: id, status: row ? row.status : '', already: true };
  const stamp = nowStamp();
  const note = (t) => listNote(row, t + ' (' + who + ')');
  let f;
  if (/^it'?s here/.test(a) && isKid(who) && row.status !== 'carted') {
    // A kid saw it at home: a parent confirms before it comes off the List (api 21).
    const res = listHave({ id: row.id, level: 'some', by: who, _source: 'settle' });
    setFields(TABS.list, row._row, { updated_at: stamp });
    return { list: id, status: row.status, pending: res.pending };
  }
  if (/^(it'?s here|got it|yes)/.test(a)) {
    const status = row.status === 'carted' || /^got it/.test(a) ? 'bought' : 'have';
    f = { status: status, hold_until: '', updated_at: stamp, note: note(status === 'bought' ? 'got it' : 'it\'s here') };
    if (row.item_id) logStock({ item_id: row.item_id, level: 'some', who: who, source: 'settle', list_id: row.id });
  } else if (/^don'?t need/.test(a)) {
    f = { status: 'skipped', hold_until: '', updated_at: stamp, note: note('didn\'t need it') };
    if (row.status === 'carted') Object.assign(f, cartOutFields(row, who));
  } else if (/^(not here|still need|no)/.test(a)) {
    f = { updated_at: stamp };
    if (/^not here/.test(a) && row.item_id) logStock({ item_id: row.item_id, level: 'out', who: who, source: 'settle', list_id: row.id });
  } else return null; // typed text: the morning check reads it
  setFields(TABS.list, row._row, f);
  return { list: id, status: f.status || row.status };
}

// "Did the <store> order come?" → Yes: every carted row for that store (filled before the card) is bought.
// Some of it: one "Did we get the …?" card per row to the parents. Not yet: nothing (asked again in a few days).
function settleOrderAnswer(r, answer, who) {
  const st = (String(r.detail).match(/\(order (\w+)\)/) || [])[1];
  const a = String(answer).replace(/\s*\([^()]*\)\s*$/, '').trim().toLowerCase();
  if (!st || !a || a === 'skip') return null;
  const created = stampOf(r.created).slice(0, 10) || String(r.created).slice(0, 10);
  const rows = readTab(TABS.list).filter((x) => x.status === 'carted' && String(x.cart || x.store) === st && (!created || rowStamp(x, 'cart_at') <= created));
  if (/^yes/.test(a)) {
    const stamp = nowStamp();
    rows.forEach((x) => setFields(TABS.list, x._row, { status: 'bought', hold_until: '', updated_at: stamp, note: listNote(x, 'order came (' + who + ')') }));
    return { store: st, bought: rows.length };
  }
  if (/^some/.test(a)) {
    const review = readTab(TABS.review);
    let n = nextIdNum(review);
    rows.forEach((x) => {
      appendObj(TABS.review, { id: 'r' + String(n++).padStart(3, '0'), created: nowStamp(), status: 'open', answer: '', type: 'settle', audience: 'parents',
        detail: 'Did we get the ' + x.name + ' in the ' + (STORE_NAMES[st] || st) + ' order? (' + x.id + ')' + (x.item_id ? ' (' + x.item_id + ')' : '') + ' Options: ' + SETTLE_PARENT_OPTIONS });
    });
    return { store: st, asked: rows.length };
  }
  return { store: st };
}

function answerReview(req) {
  const r = readTab(TABS.review).find((x) => x.id === req.id);
  if (!r) throw new Error('Review item not found');
  const answer = String(req.answer || '');
  const who = (answer.match(/\(([^()]+)\)\s*$/) || [])[1] || String(req.by || '');
  const why = pointsWhy(r, answer);
  const pts = why ? ruleByKey(why).pts : 0;
  ['answered_at', 'points', 'points_to', 'points_why'].forEach((c) => ensureColumn(TABS.review, c));
  setFields(TABS.review, r._row, {
    answer: answer, status: 'answered', answered_at: "'" + nowStamp(),
    points: pts, points_to: r.type === 'helped' ? String(r.points_to || '') : who, points_why: why,
  });
  const mission = r.type === 'check' ? missionAnswer(r, answer, who) : null;
  if (r.type === 'have_check') haveCheckAnswer(r, answer, who);
  const settled = r.type === 'settle' ? settleAnswer(r, answer, who) : r.type === 'settle_order' ? settleOrderAnswer(r, answer, who) : r.type === 'settle_meal' ? settleMealAnswer(r, answer, who) : null;
  const best = r.type === 'bestprice' ? bestPriceAnswer(r, answer, who) : null;
  const voice = r.type === 'voice' ? voiceAnswer(r, answer, who) : null;
  const subbed = r.type === 'subbed' ? subbedAnswer(r, answer, who) : null;
  const which = r.type === 'which' ? whichAnswer(r, answer, who) : null;
  return { id: r.id, points: pts, why: why, mission: mission, settled: settled, best: best, voice: voice, subbed: subbed, which: which };
}

// api 51: store options. Every Products row we know for one item, for the item screen's "Options at the store":
// [{store, name, size, price, unit_price, unit, pack, match, price_at, current}], current = what we buy there now.
function itemProducts(id) {
  if (!tab(TABS.products)) return [];
  const cur = productsMap()[id] || {};
  const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? '' : Number(v));
  const day = (v) => (v instanceof Date ? isoDate(v) : String(v || '').slice(0, 10));
  const seen = {};
  return readTab(TABS.products).filter((p) => p.item_id === id && p.store && p.product).map((p) => ({
    store: String(p.store), name: String(p.product), size: String(p.size || ''), price: num(p.price), unit_price: num(p.unit_price),
    unit: String(p.unit || ''), pack: String(p.pack || ''), match: String(p.match || ''), price_at: day(p.price_at),
    current: !!(cur[p.store] && cur[p.store].name === String(p.product)),
  })).filter((p) => { const k = p.store + '|' + p.name; if (seen[k]) return false; seen[k] = true; return true; });
}

// A product name as a card choice: no ";" (it splits options), no trailing "(…)" (answers end with "(Name)").
function optionName(s) { return String(s || '').replace(/;/g, ',').replace(/[()]/g, '').replace(/\s+/g, ' ').trim(); }
function optionLabel(p, isCurrent) {
  const name = optionName(p.product);
  const size = String(p.size || '').trim();
  const price = Number(p.price) > 0 ? '$' + Number(p.price).toFixed(2) : '';
  const up = Number(p.unit_price) > 0 && p.unit ? (p.unit === 'ct' ? '$' + Number(p.unit_price).toFixed(2) + ' each' : '$' + Number(p.unit_price).toFixed(2) + '/' + p.unit) : '';
  const bits = [name];
  if (size && name.toLowerCase().indexOf(size.toLowerCase().replace(/\s+/g, '')) < 0 && name.toLowerCase().indexOf(size.toLowerCase()) < 0) bits.push(optionName(size));
  const pack = String(p.pack || '').trim();
  if (pack && (name + ' ' + size).toLowerCase().replace(/\s+/g, '').indexOf(pack.toLowerCase().replace(/\s+/g, '')) < 0) bits.push(optionName(pack));
  if (price) bits.push(price + (up ? ', ' + up : ''));
  if (isCurrent) bits.push('what we buy now');
  return bits.join(' · ');
}

// Make a store product what we buy for an item at that store: it becomes `exact`, other exact / likely rows
// there become `alt` (noted), and any open `which` card for that item + store closes.
function pickProduct(id, store, prow, who, why) {
  const prods = readTab(TABS.products);
  prods.filter((p) => p.item_id === id && p.store === store && p._row !== prow._row && (p.match === 'exact' || p.match === 'likely'))
    .forEach((p) => setFields(TABS.products, p._row, { match: 'alt', notes: (String(p.notes || '') + '; was ' + p.match + ' until ' + isoDate(new Date())).replace(/^; /, '') }));
  setFields(TABS.products, prow._row, { match: 'exact', notes: (String(prow.notes || '') + '; picked (' + who + ', ' + isoDate(new Date()) + ')').replace(/^; /, '') });
  if (why !== 'card') {
    readTab(TABS.review).filter((r) => r.type === 'which' && r.status === 'open' && String(r.detail).indexOf('(' + id + ')') >= 0 && String(r.detail).indexOf(' at ' + STORE_NAMES[store] + '?') >= 0)
      .forEach((r) => { ensureColumn(TABS.review, 'outcome'); setFields(TABS.review, r._row, { status: 'closed', outcome: 'picked on the item screen (' + who + ')' }); });
  }
  return { item: id, store: store, product: String(prow.product) };
}

// productPick {item_id, store, product}: a parent taps "Use this" under Options at the store.
function productPick(req) {
  if (isKid(req.by)) throw new Error('Ask a parent to pick');
  const id = String(req.item_id || ''), store = String(req.store || ''), name = String(req.product || '');
  if (!id || JOB_STORES.indexOf(store) < 0 || !name) throw new Error('Missing item, store or product');
  if (!tab(TABS.products)) throw new Error('No store products yet');
  const prow = readTab(TABS.products).find((p) => p.item_id === id && p.store === store && String(p.product) === name);
  if (!prow) throw new Error('That product isn’t saved for this item any more');
  return pickProduct(id, store, prow, String(req.by), 'screen');
}

// The person to ask "Which one?": the parent who put it on the List (or added the item), else both parents.
function whichAudience(item, list) {
  const parents = people().filter((p) => !isKid(p));
  const isParent = (n) => parents.map((x) => x.toLowerCase()).indexOf(String(n || '').toLowerCase()) >= 0;
  const rows = list.filter((r) => r.item_id === item.id && r.added_by).sort((a, b) => (String(a.added_at) < String(b.added_at) ? 1 : -1));
  const adder = (rows[0] && rows[0].added_by) || (String(item.notes || '').match(/Added in app by (\w+)/) || [])[1];
  const found = adder && parents.find((p) => p.toLowerCase() === String(adder).toLowerCase());
  return isParent(adder) && found ? found : 'parents';
}

// api 51: one "Which … at <store>?" card per item + store that has `option` rows and hasn't been asked. Runs on any
// state call, but only after the cart runner set Settings options_new (so polling costs one small read).
const WHICH_PER_RUN = 3, WHICH_MAX_CHOICES = 5;
function whichCards() {
  const st = settingsMap();
  if (!String(st.options_new || '').trim()) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    if (!String(settingsMap().options_new || '').trim() || !tab(TABS.products)) return;
    const review = readTab(TABS.review);
    const items = readTab(TABS.items);
    const list = readTab(TABS.list);
    const prods = readTab(TABS.products);
    const cur = productsMap();
    const asked = (id, store) => review.some((r) => r.type === 'which' && String(r.detail).indexOf('(' + id + ')') >= 0 && String(r.detail).indexOf(' at ' + STORE_NAMES[store] + '?') >= 0);
    const groups = {};
    prods.forEach((p) => { if (String(p.match) === 'option' && p.item_id && JOB_STORES.indexOf(p.store) >= 0) (groups[p.item_id + '|' + p.store] = groups[p.item_id + '|' + p.store] || []).push(p); });
    let n = nextIdNum(review), made = 0, left = 0;
    Object.keys(groups).forEach((k) => {
      const id = k.split('|')[0], store = k.split('|')[1];
      const it = items.find((x) => x.id === id);
      if (!it || it.status === 'Drop' || asked(id, store)) return;
      if (made >= WHICH_PER_RUN) { left++; return; }
      const now = cur[id] && cur[id][store] && prods.find((p) => p.item_id === id && p.store === store && String(p.product) === cur[id][store].name);
      const seen = {};
      const choices = (now ? [now] : []).concat(groups[k]).filter((p) => { const x = optionName(p.product).toLowerCase(); if (seen[x]) return false; seen[x] = true; return true; }).slice(0, WHICH_MAX_CHOICES);
      if (choices.length < 2) return;
      ensureColumn(TABS.review, 'audience');
      appendObj(TABS.review, { id: 'r' + String(n++).padStart(3, '0'), created: nowStamp(), status: 'open', answer: '', type: 'which', audience: whichAudience(it, list),
        detail: '🔎 Which ' + it.name + ' at ' + STORE_NAMES[store] + '? (' + id + ') Options: ' + choices.map((p) => optionLabel(p, p === now)).join('; ') + '; None of these' });
      review.push({ type: 'which', detail: '(' + id + ') at ' + STORE_NAMES[store] + '?' });
      made++;
    });
    if (!left) setSetting('options_new', '');
  } finally {
    lock.releaseLock();
  }
}

// "Which … at <store>?" answered: that product becomes what we buy there. "None of these" → nothing changes; the
// morning check reads the card and asks what to look for instead.
function whichAnswer(r, answer, who) {
  if (isKid(who)) return null;
  const id = (String(r.detail).match(/\((i\d{3,})\)/) || [])[1];
  const store = JOB_STORES.find((k) => String(r.detail).indexOf(' at ' + STORE_NAMES[k] + '?') >= 0);
  const a = String(answer).replace(/\s*\([^()]*\)\s*$/, '').trim();
  if (!id || !store || !a || /^skip$/i.test(a)) return null;
  if (/^none of these/i.test(a)) return { item: id, store: store, none: true };
  if (!tab(TABS.products)) return null;
  const rows = readTab(TABS.products).filter((p) => p.item_id === id && p.store === store && optionName(p.product))
    .filter((p) => a.toLowerCase().indexOf(optionName(p.product).toLowerCase()) === 0)
    .sort((x, y) => optionName(y.product).length - optionName(x.product).length);
  if (!rows.length) return { item: id, store: store, found: false };
  return pickProduct(id, store, rows[0], who, 'card');
}

// api 46: "The store sent X instead of Y. Next time?" → the item's substitution rule. A parent's answer only.
function subbedAnswer(r, answer, who) {
  if (isKid(who)) return null;
  const id = (String(r.detail).match(/\((i\d{3,})\)/) || [])[1];
  const a = String(answer).replace(/\s*\([^()]*\)\s*$/, '').trim().toLowerCase();
  if (!id || !a || a === 'skip') return null;
  const it = readTab(TABS.items).find((x) => x.id === id);
  if (!it) return null;
  if (/^that'?s fine|^fine|^ok/.test(a)) { setFields(TABS.items, it._row, { ok_swap: 'Y' }); return { item: id, ok_swap: 'Y' }; }
  if (/^don'?t sub|^no sub|^never/.test(a)) { setFields(TABS.items, it._row, { ok_swap: 'N' }); return { item: id, ok_swap: 'N' }; }
  if (/backup/.test(a)) {
    if (!tab(TABS.products)) return null;
    ensureColumn(TABS.products, 'backup');
    const prods = readTab(TABS.products);
    const sent = prods.find((p) => p.item_id === id && new RegExp('sent as substitute ' + r.id + '\\b').test(String(p.notes || '')));
    if (!sent) return { item: id, backup: false };
    prods.filter((p) => p.item_id === id && p.store === sent.store && Number(p.backup) > 0 && p._row !== sent._row)
      .forEach((p) => setFields(TABS.products, p._row, { backup: Number(p.backup) + 1 }));
    setFields(TABS.products, sent._row, { backup: 1, notes: String(sent.notes || '') + '; backup (' + who + ')' });
    return { item: id, store: sent.store, backup: true };
  }
  return null;
}

// Which rule (POINT_RULES key) a card scores under when answered, or '' for no points: "skip" (Don't care),
// meal requests, and Kitchen help "Not this time". Due soon matches the app's section rule (type task, a due_at,
// "due <day>" in the text, or the school-lunch card).
function pointsWhy(r, answer) {
  const a = String(answer).replace(/\s*\([^()]*\)\s*$/, '').trim().toLowerCase();
  const t = String(r.type || '').toLowerCase();
  const d = String(r.detail || '');
  if (!a || a === 'skip') return '';
  if (t === 'meal_request') return /^cancel/.test(a) ? '' : 'approve';
  if (t === 'have_check') return 'approve'; // a parent's Plan it / Not now; a kid cancelling scores nothing
  if (t === 'helped') return /^cooked/.test(a) ? 'helped_cooked' : /^helped/.test(a) ? 'helped_helped' : '';
  if (t === 'task' || r.due_at || /^school lunches for next week/i.test(d) || /\bdue (by )?(mon|tues|wednes|thurs|fri|satur|sun)day\b/i.test(d)) {
    const due = stampOf(r.due_at);
    return due && nowStamp() > due ? 'task_late' : 'task';
  }
  if (t === 'check' || t === 'mission') return 'check';
  if (t === 'settle' || t === 'settle_order' || t === 'settle_meal') return 'settle';
  if (t === 'rate') return 'rate';
  if (t === 'still') return 'still';
  return 'other';
}
function cardPoints(r, answer) { const k = pointsWhy(r, answer); return k ? ruleByKey(k).pts : 0; }
function ruleByKey(k) { return POINT_RULES.find((x) => x.key === k) || { key: k, label: k, pts: 0 }; }
// A Sheet cell that may hold a Date or text, as "yyyy-MM-ddTHH:mm:ss" text.
function stampOf(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, scriptTz(), "yyyy-MM-dd'T'HH:mm:ss");
  return String(v);
}

// Ledger: award `why` points to `to` (a family member), once per ref, within the rule's daily cap.
function awardPoints(to, why, ref, by, note) {
  const rule = ruleByKey(why);
  const name = people().find((p) => p.toLowerCase() === String(to || '').trim().toLowerCase());
  if (!name || !rule.pts) return 0;
  let sh = tab(TABS.points);
  if (!sh) { sh = SpreadsheetApp.getActive().insertSheet(TABS.points); sh.appendRow(POINTS_HEAD); sh.setFrozenRows(1); }
  const rows = readTab(TABS.points);
  if (ref && rows.some((r) => String(r.to) === name && String(r.why) === why && String(r.ref) === String(ref))) return 0;
  const today = isoDate(new Date());
  if (rule.cap && rows.filter((r) => String(r.to) === name && String(r.why) === why && stampOf(r.at).slice(0, 10) === today).length >= rule.cap) return 0;
  appendObj(TABS.points, { at: "'" + nowStamp(), to: name, pts: rule.pts, why: why, ref: ref || '', by: by || '', note: String(note || '').slice(0, 120) });
  return rule.pts;
}
function ledgerRows() {
  return tab(TABS.points) ? readTab(TABS.points) : [];
}
// Every scored event: answered Inbox cards (Review) plus the Points ledger.
// The first day that counts (Settings points_start, yyyy-mm-dd); blank = everything counts.
function pointsStart() {
  const v = settingsMap().points_start;
  return v ? stampOf(v).slice(0, 10) : '';
}
function scoredEvents() {
  const out = [];
  const start = pointsStart();
  readTab(TABS.review).forEach((r) => {
    const pts = Number(r.points) || 0, at = stampOf(r.answered_at);
    if (pts && r.points_to && at) out.push({ src: 'review', r: r, at: at, to: String(r.points_to), pts: pts });
  });
  ledgerRows().forEach((r) => {
    const pts = Number(r.pts) || 0, at = stampOf(r.at);
    if (pts && r.to && at) out.push({ src: 'ledger', r: r, at: at, to: String(r.to), pts: pts });
  });
  const kept = start ? out.filter((e) => e.at.slice(0, 10) >= start) : out;
  // Daily limits (quick cards api 36, missions api 57): in time order, each person's cards of that rule past the
  // cap that day count 0 (capped).
  const caps = { other: quickCap(), check: missionCap() };
  const seen = {};
  kept.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).forEach((e) => {
    if (e.src !== 'review') return;
    const why = quickWhy(e.r), cap = caps[why];
    if (!cap) return;
    const k = why + '|' + e.to.trim().toLowerCase() + '|' + e.at.slice(0, 10);
    seen[k] = (seen[k] || 0) + 1;
    if (seen[k] > cap) { e.pts = 0; e.capped = true; e.capWhy = why; }
  });
  // Catch-up bonus (api 58): in time order, per Mon–Sun week, whoever is below the week's top score at that moment
  // gets the boosted points (e.bonus = the extra). Ties at the top (e.g. Monday morning) get no bonus.
  const m = catchup();
  if (m) {
    const weeks = {};
    kept.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).forEach((e) => {
      if (!(e.pts > 0)) return;
      const day = e.at.slice(0, 10), dow = new Date(day + 'T12:00:00').getDay();
      const wk = addDays(day, -((dow + 6) % 7));
      const tot = (weeks[wk] = weeks[wk] || {});
      const who = e.to.trim().toLowerCase();
      const top = Math.max.apply(null, Object.keys(tot).map((k) => tot[k]).concat([0]));
      if ((tot[who] || 0) < top) { const b = boosted(e.pts, m); e.bonus = b - e.pts; e.pts = b; }
      tot[who] = (tot[who] || 0) + e.pts;
    });
  }
  return kept;
}
// The rule a scored Review row came under (rows from before api 14 have no points_why: worked out from the card).
function quickWhy(r) {
  return String(r.points_why || '') || pointsWhy(Object.assign({}, r, { due_at: '' }), r.answer) || 'other';
}
// How many quick cards each person has had counted today, for the phone's "+1 / +0" preview.
function quickToday(today, why) {
  const n = {};
  scoredEvents().forEach((e) => {
    if (e.src !== 'review' || e.at.slice(0, 10) !== today || quickWhy(e.r) !== (why || 'other')) return;
    n[e.to] = (n[e.to] || 0) + 1;
  });
  return n;
}

// Points history (Inbox → Points history): every scored answer from the last POINTS_LOG_DAYS days, newest first,
// with who got the points, who answered, how many, why, and the card; plus each week's totals and winner.
// Rows answered before api 14 have no points_why, so the reason is worked out from the card (marked guessed).
function pointsLog(req) {
  const everyone = people();
  const nameOf = (x) => everyone.find((p) => p.toLowerCase() === String(x || '').trim().toLowerCase()) || '';
  const since = addDays(isoDate(new Date()), -POINTS_LOG_DAYS);
  const entries = [];
  const weeks = {}; // monday -> { name: pts }
  const goalDays = {}; // name -> { day: pts }
  scoredEvents().forEach((e) => {
    const r = e.r, pts = e.pts, at = e.at;
    const to = nameOf(e.to);
    if (!to) return;
    const day = at.slice(0, 10);
    const dow = new Date(day + 'T12:00:00').getDay();
    const mon = addDays(day, -((dow + 6) % 7));
    weeks[mon] = weeks[mon] || {};
    weeks[mon][to] = (weeks[mon][to] || 0) + pts;
    goalDays[to] = goalDays[to] || {};
    goalDays[to][day] = (goalDays[to][day] || 0) + pts;
    if (day < since) return;
    if (e.src === 'ledger') {
      entries.push({ id: String(r.ref || ''), at: at, to: to, by: String(r.by || ''), pts: pts, why: String(r.why), label: ruleByKey(String(r.why)).label, guessed: false, bonus: e.bonus || 0, q: String(r.note || ''), answer: '' });
      return;
    }
    let why = String(r.points_why || '');
    const guessed = !why;
    if (guessed) {
      why = pointsWhy(Object.assign({}, r, { due_at: '' }), r.answer) || 'other';
      if (why === 'task' && pts === POINTS.task_late) why = 'task_late';
    }
    const answer = String(r.answer || '');
    entries.push({
      id: r.id, at: at, to: to, by: (answer.match(/\(([^()]+)\)\s*$/) || [])[1] || '', pts: pts,
      why: why, label: ruleByKey(why).label, guessed: guessed, capped: !!e.capped, capWhy: e.capWhy || '', bonus: e.bonus || 0,
      q: String(r.detail || '').replace(/\s*Options:[\s\S]*$/, '').replace(/\s*\((i|m|x|r|f|c)\d{2,}\)|\s*\(\d{4}-\d\d-\d\d\)/g, '').trim(),
      answer: answer.replace(/\s*\([^()]*\)\s*$/, '').trim(),
    });
  });
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const goal = Number(settingsMap().points_goal) || POINTS_GOAL;
  const weekList = Object.keys(weeks).sort().reverse().map((mon) => {
    const totals = weeks[mon];
    const best = Math.max.apply(null, Object.keys(totals).map((p) => totals[p]).concat([0]));
    const end = addDays(mon, 6);
    const goals = {};
    Object.keys(goalDays).forEach((p) => {
      goals[p] = Object.keys(goalDays[p]).filter((d) => d >= mon && d <= end && goalDays[p][d] >= goal).length;
    });
    return { weekStart: mon, totals: totals, goalDays: goals, winners: best ? Object.keys(totals).filter((p) => totals[p] === best) : [] };
  });
  return { goal: goal, rules: pointRulesOut(), quickCap: quickCap(), missionCap: missionCap(), days: POINTS_LOG_DAYS, entries: entries.slice(0, 400), weeks: weekList };
}

// The Inbox scoreboard: points today and this week (Mon–Sun) per person, streaks (days in a row at the
// daily goal; today counts once reached, and an unfinished today doesn't break it), last week's winner.
function pointsSummary(today) {
  const goal = Number(settingsMap().points_goal) || POINTS_GOAL;
  const everyone = people();
  const byDay = {}; // name -> { day: pts }
  everyone.forEach((p) => (byDay[p] = {}));
  scoredEvents().forEach((e) => {
    const pts = e.pts;
    const key = everyone.find((p) => p.toLowerCase() === e.to.trim().toLowerCase());
    if (!key) return;
    const d = e.at.slice(0, 10);
    byDay[key][d] = (byDay[key][d] || 0) + pts;
  });
  const dow = new Date(today + 'T12:00:00').getDay();
  const monday = addDays(today, -((dow + 6) % 7));
  const lastMonday = addDays(monday, -7);
  const sum = (m, a, b) => Object.keys(m).reduce((t, d) => t + (d >= a && d <= b ? m[d] : 0), 0);
  const out = { goal: goal, today: {}, week: {}, streak: {}, weekStart: monday, lastWeekWinner: '', rules: pointRulesOut(), start: pointsStart(), quickCap: quickCap(), quickToday: {}, missionCap: missionCap(), missionToday: {}, catchup: catchup(), behind: {} };
  let best = 0;
  everyone.forEach((p) => {
    const m = byDay[p];
    out.today[p] = m[today] || 0;
    out.week[p] = sum(m, monday, today);
    let streak = 0;
    let d = (m[today] || 0) >= goal ? today : addDays(today, -1);
    while ((m[d] || 0) >= goal) { streak++; d = addDays(d, -1); }
    out.streak[p] = streak;
    const lw = sum(m, lastMonday, addDays(monday, -1));
    if (lw > best) { best = lw; out.lastWeekWinner = p; } else if (lw && lw === best) out.lastWeekWinner += ' + ' + p;
  });
  if (out.quickCap) {
    const q = quickToday(today);
    everyone.forEach((p) => { const k = Object.keys(q).find((x) => x.trim().toLowerCase() === p.toLowerCase()); out.quickToday[p] = k ? q[k] : 0; });
  }
  if (out.catchup) {
    const top = Math.max.apply(null, everyone.map((p) => out.week[p] || 0).concat([0]));
    everyone.forEach((p) => (out.behind[p] = (out.week[p] || 0) < top));
  }
  if (out.missionCap) {
    const q = quickToday(today, 'check');
    everyone.forEach((p) => { const k = Object.keys(q).find((x) => x.trim().toLowerCase() === p.toLowerCase()); out.missionToday[p] = k ? q[k] : 0; });
  }
  out.extra = { missions: KID_MISSIONS, settle: SETTLE_PER_KID, qa: '18–22' };
  return out;
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
  let sh = tab(TABS.ideas);
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

// Vote from the meal card (api 52): anyone, kids too, for themselves only.
const VOTE_WORDS = { '😍': 'Love it', '🙂': 'Like it', '😐': "It's OK", '👎': 'Not for me' };
function mealVote(req) {
  const who = people().find((p) => p.toLowerCase() === String(req.by || '').trim().toLowerCase());
  if (!who) throw new Error('Pick who you are first');
  const vote = String(req.vote || '').trim();
  if (!VOTE_SCORE[vote]) throw new Error('Pick 😍, 🙂, 😐 or 👎');
  const meal = readTab(TABS.meals).find((m) => String(m.id) === String(req.meal_id));
  if (!meal) throw new Error('That meal is gone');
  ['answered_at', 'points', 'points_to', 'outcome'].forEach((c) => ensureColumn(TABS.review, c));
  const review = readTab(TABS.review);
  review.filter((r) => (r.type === 'vote' || r.type === 'rate') && r.status === 'open' && String(r.audience).toLowerCase() === who.toLowerCase() &&
    String(r.detail).indexOf('(' + meal.id + ')') >= 0).forEach((r) => setFields(TABS.review, r._row, { status: 'closed', outcome: 'voted on the meal card' }));
  const id = 'r' + String(nextIdNum(review)).padStart(3, '0');
  appendObj(TABS.review, {
    id: id, created: nowStamp(), type: 'vote', status: 'closed', audience: who, asked_by: who, outcome: 'meal card vote',
    detail: 'Meal card vote: how do you feel about ' + meal.name + '? (' + meal.id + ')',
    answer: vote + ' ' + VOTE_WORDS[vote] + ' (' + who + ')', answered_at: nowStamp(), points: 0,
  });
  return { id: id };
}

// api 55: a parent sends Missing for meals to the girls. One mission card per item, same wording and answers as the
// daily missions, so missionAnswer handles them. Skips items on the List or already on an open mission.
const MISSIONS_ASK_MAX = 40;
function missionsAsk(req) {
  const who = people().find((p) => p.toLowerCase() === String(req.by || '').trim().toLowerCase());
  if (!who) throw new Error('Pick who you are first');
  if (isKid(who)) throw new Error('Ask a parent to send missions');
  const kids = String(settingsMap().kids || '').split(',').map((x) => x.trim()).filter(String);
  if (!kids.length) throw new Error('No kids set up in Settings');
  const byId = {}; readTab(TABS.items).forEach((i) => (byId[i.id] = i));
  const onList = {}; readTab(TABS.list).forEach((r) => { if (r.item_id && ACTIVE.indexOf(r.status) >= 0) onList[r.item_id] = true; });
  const review = readTab(TABS.review);
  const open = {};
  review.forEach((r) => {
    if (r.type !== 'check' || r.status !== 'open') return;
    const m = String(r.detail).match(/\((i\d{3,})\)/); if (m) open[m[1]] = true;
  });
  // api 57: deal the cards out in turn, whoever is behind this week first (so they get the odd one). Before, the kid
  // with fewer open missions got more, so the kid who answered fastest kept getting the most (Nov 5: 24 vs 13).
  const week = kidRace(isoDate(new Date()), kids).week;
  const order = kids.slice().sort((a, b) => (week[a] || 0) - (week[b] || 0));
  let turn = 0;
  let n = nextIdNum(review);
  const sent = [];
  (req.items || []).slice(0, MISSIONS_ASK_MAX).forEach((x) => {
    const id = String((x && x.id) || x || '');
    const it = byId[id];
    if (!it || it.status === 'Drop' || onList[id] || open[id] || sent.some((s) => s.id === id)) return;
    const kid = order[turn++ % order.length];
    const why = String((x && x.why) || '').replace(/[()]/g, '').slice(0, 80);
    appendObj(TABS.review, { id: 'r' + String(n++).padStart(3, '0'), created: nowStamp(), type: 'check', status: 'open', answer: '', audience: kid, asked_by: who,
      detail: '🍽 For the meal plan: go check the ' + it.name + ': how much do we have?' + (why ? ' It\'s for ' + why + '.' : '') + ' (' + id + ') Options: ' + MISSION_OPTIONS });
    sent.push({ id: id, to: kid });
  });
  return { sent: sent.length, to: kids.map((k) => ({ kid: k, n: sent.filter((s) => s.to === k).length })) };
}

// Ideas still being worked on, plus ones finished in the last 14 days (so people see what happened).
function recentIdeas(today) {
  if (!tab(TABS.ideas)) return [];
  return readTab(TABS.ideas)
    .filter((x) => x.status === 'new' || x.status === 'asked' || daysBetween(String(x.at).slice(0, 10), today) <= 14)
    .slice(-10)
    .map((x) => ({ id: x.id, at: String(x.at).slice(0, 10), who: x.who, text: String(x.text).slice(0, 160), status: x.status, meal_id: x.meal_id, notes: x.notes }));
}

// Per meal: family votes, how often it's been on the plan, next planned date, rough cost.
// Everything is computed from Review, Plan (+ Plan Archive) and Receipts; nothing is typed.
function mealStats(meals, today) {
  const out = {};
  meals.forEach((m) => (out[m.id] = { votes: {}, voters: {}, score: 0, made: 0, last: '', next: '', cost: 0, priced: 0, linked: 0, wins: 0, matchups: 0 }));

  // Votes: "Dinner vote: how do you feel about <name>? (mNN)". Latest answer per person wins.
  const byName = {};
  meals.forEach((m) => (byName[String(m.name).toLowerCase()] = m.id));
  meals.forEach((m) => String(m.old_names || '').split(';').map((x) => x.trim().toLowerCase()).filter(String).forEach((n) => { if (!byName[n]) byName[n] = m.id; }));
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

  // Head-to-heads (api 39): latest answer per person per pair; "Same" counts as a matchup for both, a win for neither.
  const picks = {};
  const mealById = {}; meals.forEach((m) => (mealById[m.id] = m));
  readTab(TABS.review).forEach((r) => {
    if (String(r.type) !== 'pick' || !r.answer) return;
    const p = parsePick(r, mealById);
    if (!p) return;
    picks[p.who + '|' + p.pair.slice().sort().join('|')] = p;
  });
  Object.keys(picks).forEach((k) => {
    const p = picks[k];
    p.pair.forEach((id) => out[id].matchups++);
    if (p.winner) out[p.winner].wins++;
  });

  // Plan history: dates before today count as made; the first date from today on is "next".
  let plan = readTab(TABS.plan);
  if (tab('Plan Archive')) plan = plan.concat(readTab('Plan Archive'));
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

// A pick card's answer: { pair: [mA, mB], winner: mA / mB / '', who }, or null if it isn't one we can read.
function parsePick(r, mealsById) {
  const d = String(r.detail || '');
  const ids = (d.match(/\((m\d{2,})\)/g) || []).map((x) => x.slice(1, -1));
  if (ids.length < 2 || !mealsById[ids[0]] || !mealsById[ids[1]]) return null;
  const pair = ids.slice(0, 2);
  const a = String(r.answer).trim();
  const who = (a.match(/\(([^)]+)\)\s*$/) || [])[1] || r.audience || '?';
  const said = a.replace(/\s*\([^()]*\)\s*$/, '').trim().toLowerCase();
  if (!said || said === 'skip') return null;
  // Option text is the meal name as the card showed it (between "more: " and " or " / "?").
  const names = (d.match(/more: (.+?) or (.+?)\? \(m/) || []).slice(1).map((x) => x.toLowerCase());
  let winner = '';
  pair.forEach((id, i) => { if (said === names[i] || said === String(mealsById[id].name || '').toLowerCase()) winner = id; });
  if (!winner && !/^same|^both|^tie|^can't|^no idea/.test(said)) return null;
  return { pair: pair, winner: winner, who: who };
}

// One head-to-head card per person a day: two meals of the same kind (breakfast, lunch, snack or dinner) that this
// person has an opinion on. Ties in their own votes first (that's where a pick tells us most), then meals the family
// rates close together, then meals we've made. Never a pair asked of them in the last PICK_REASK_DAYS, never while
// they still have one open.
function makePicks(today, everyone, review, meals) {
  const out = [];
  const stats = mealStats(meals, today);
  const kindOf = (m) => (SLOTS.indexOf(String(m.kind || '').toLowerCase()) >= 0 ? String(m.kind).toLowerCase() : 'dinner');
  const known = meals.filter((m) => stats[m.id] && (stats[m.id].made > 0 || Object.keys(stats[m.id].voters).length));
  const dayNum = Math.floor(new Date(today + 'T12:00:00').getTime() / 86400000);
  everyone.forEach((who, k) => {
    const mine = review.filter((r) => r.type === 'pick' && String(r.audience) === who);
    if (mine.some((r) => r.status === 'open')) return;
    const asked = {};
    mine.forEach((r) => {
      if (r.created && daysBetween(String(r.created).slice(0, 10), today) > PICK_REASK_DAYS) return;
      const ids = (String(r.detail).match(/\((m\d{2,})\)/g) || []).map((x) => x.slice(1, -1)).slice(0, 2).sort();
      if (ids.length === 2) asked[ids.join('|')] = true;
    });
    const pairs = [];
    for (let i = 0; i < known.length; i++) {
      for (let j = i + 1; j < known.length; j++) {
        const a = known[i], b = known[j];
        if (kindOf(a) !== kindOf(b) || asked[[a.id, b.id].sort().join('|')]) continue;
        const va = stats[a.id].voters[who], vb = stats[b.id].voters[who];
        const sa = stats[a.id].score, sb = stats[b.id].score;
        let rank = 3;
        if (va && vb && va === vb && VOTE_SCORE[va] >= 3) rank = 0;       // both loved / both liked: which more?
        else if (va && vb && va === vb) rank = 1;
        else if (sa && sb && Math.abs(sa - sb) <= 0.5) rank = 2;
        if (rank === 3 && !(stats[a.id].made && stats[b.id].made)) continue;
        pairs.push({ a: a, b: b, rank: rank, spin: (i * 31 + j * 17 + dayNum * 7 + k * 13) % 97 });
      }
    }
    pairs.sort((x, y) => x.rank - y.rank || x.spin - y.spin);
    pairs.slice(0, PICK_PER_DAY).forEach((p) => {
      const label = { breakfast: 'breakfast', lunch: 'lunch', snack: 'snack', dinner: 'dinner' }[kindOf(p.a)];
      const clean = (n) => String(n).replace(/[;?]/g, '').trim();
      out.push({ type: 'pick', audience: who, detail: '🥊 Head-to-head! Which ' + label + ' do you like more: ' + clean(p.a.name) + ' or ' + clean(p.b.name) + '? (' + p.a.id + ') (' + p.b.id + ') Options: ' + clean(p.a.name) + '; ' + clean(p.b.name) + '; Same' });
    });
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
  awardPoints(req.by, 'meal_ask', id, req.by, 'Asked for ' + meal.name);
  return { id: id };
}

function addFeedback(req) {
  const text = String(req.text || '').trim().slice(0, IDEA_MAX);
  if (!text) throw new Error('Type something first');
  let sh = tab(TABS.feedback);
  if (!sh) { sh = SpreadsheetApp.getActive().insertSheet(TABS.feedback); sh.appendRow(FEEDBACK_HEAD); sh.setFrozenRows(1); }
  const id = nextId(readTab(TABS.feedback), 'id', 'f', 3);
  appendObj(TABS.feedback, { id: id, at: nowStamp(), who: req.by || '', tab: req.tab || '', text: text, status: 'new', notes: '' });
  const sent = ideaAlert(id, req.by, req.tab, text);
  if (sent !== true) {
    const row = readTab(TABS.feedback).find((r) => r.id === id);
    if (row && sent) setFields(TABS.feedback, row._row, { notes: 'alert not sent: ' + sent });
  }
  return { id: id };
}

// api 29: a new 💡 idea reaches the owner (owner) in minutes, not at the next morning check. Email to the owner only,
// never to anyone else in the family. Returns true when sent, '' when turned off, or the error text.
// Nov 3 (api 35): the parameter used to be called `tab`, which hid the tab() helper, so every alert since api 29
// failed with "tab is not a function". Keep it as tabName.
function ideaAlert(id, who, tabName, text) {
  try {
    const st = settingsMap();
    if (/^(off|no|n)$/i.test(String(st.idea_alerts || '').trim())) return '';
    const to = String(st.alert_email || '').trim() || Session.getEffectiveUser().getEmail();
    if (!to) return 'no address';
    const where = tabName ? ' (' + tabName + ' tab)' : '';
    MailApp.sendEmail({
      to: to,
      subject: '💡 Poppy idea from ' + (who || 'someone') + where,
      body: text + '\n\n— ' + (who || 'Someone') + where + ', ' + nowStamp().replace('T', ' ') + ' · ' + id +
        '\n\nOpen a Poppy chat with Claude to react to it. Sheet: ' + SpreadsheetApp.getActive().getUrl() + '#gid=' + tab(TABS.feedback).getSheetId(),
      name: 'Poppy 2.0',
    });
    return true;
  } catch (err) {
    return String(err && err.message ? err.message : err).slice(0, 120);
  }
}

// Run once from the Apps Script editor (function dropdown → authorizeAlerts → Run) to approve email sending and get
// a test email. Until that's approved, ideas are still saved; the App Feedback row notes say the alert wasn't sent.
function authorizeAlerts() {
  Logger.log('Emails left today: ' + MailApp.getRemainingDailyQuota());
  Logger.log(ideaAlert('test', 'Poppy', '', 'Test: idea alerts are on. New 💡 ideas from the app will land here.'));
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

    ensureColumn(TABS.review, 'points_to');
    const kids = String(st.kids || '').split(',').map((x) => x.trim()).filter(String);
    // Close stale, unanswered "How was it?" and "Did <kid> help?" cards.
    review.forEach((r) => {
      const age = r.created ? daysBetween(String(r.created).slice(0, 10), today) : 0;
      if (r.status === 'open' && ((r.type === 'rate' && age > RATE_EXPIRE_DAYS) || (r.type === 'helped' && age > HELPED_EXPIRE_DAYS) ||
        (r.type === 'check' && age > MISSION_EXPIRE_DAYS) || (r.type === 'pick' && age > PICK_EXPIRE_DAYS) || ((r.type === 'settle' || r.type === 'settle_order' || r.type === 'settle_meal') && age > SETTLE_EXPIRE_DAYS))) {
        setFields(TABS.review, r._row, { status: 'closed' });
      }
    });

    // How was it?
    const meals = readTab(TABS.meals);
    const mealOf = {}; meals.forEach((m) => (mealOf[m.id] = m));
    let plan = readTab(TABS.plan);
    if (tab('Plan Archive')) plan = plan.concat(readTab('Plan Archive'));
    const madeBefore = (id, d) => plan.filter((p) => p.meal_id === id && !isLeftover(p) && planDate(p) && planDate(p) < d).length;
    const from = st.cards_through ? addDays(String(st.cards_through).slice(0, 10), 1) : addDays(today, -1);
    const start = from < addDays(today, -RATE_BACK_DAYS) ? addDays(today, -RATE_BACK_DAYS) : from;
    // Dinners first, then breakfast; at most RATE_PER_DAY cards per person per day so the deck stays fun.
    for (let d = start; d < today; d = addDays(d, 1)) {
      const when = d === addDays(today, -1) ? 'yesterday' : 'on ' + DAY_NAMES[new Date(d + 'T12:00:00').getDay()];
      const rows = plan.filter((p) => planDate(p) === d && p.meal_id && mealOf[p.meal_id] && !isLeftover(p) && RATE_SLOTS.indexOf(planSlot(p)) >= 0)
        .filter((p) => madeBefore(p.meal_id, d) <= RATE_NEW_TIMES) // only meals still new to us
        .sort((a, b) => RATE_SLOTS.indexOf(planSlot(a)) - RATE_SLOTS.indexOf(planSlot(b)));
      // Did <kid> help with dinner? One card per kid for each planned (non-leftover) dinner, to the parents.
      // The answer records what they did and gives the kid points (cooked 10, helped 5).
      plan.filter((p) => planDate(p) === d && planSlot(p) === 'dinner' && p.meal_id && mealOf[p.meal_id] && !isLeftover(p)).slice(0, 1).forEach((p) => {
        kids.forEach((kid) => {
          const asked = review.some((r) => r.type === 'helped' && String(r.points_to) === kid && String(r.detail).indexOf('(' + d + ')') >= 0);
          if (asked) return;
          add({ type: 'helped', audience: 'parents', points_to: kid, detail: 'Did ' + kid + ' help cook ' + mealOf[p.meal_id].name + ' ' + when + '? (' + p.meal_id + ') (' + d + ') Options: ' + HELPED_OPTIONS });
          review.push({ type: 'helped', status: 'open', points_to: kid, detail: '(' + d + ')' });
        });
      });
      everyone.forEach((who) => {
        let given = 0;
        rows.forEach((p) => {
          if (given >= RATE_PER_DAY) return;
          // api 35: a person with an open vote card on this meal gets that card after the meal instead (the app holds
          // votes until the morning after), so no How was it? on top of it.
          const open = review.some((r) => (r.type === 'rate' || r.type === 'vote') && r.status === 'open' && String(r.audience) === who && String(r.detail).indexOf('(' + p.meal_id + ')') >= 0);
          if (open) return;
          const slot = planSlot(p);
          add({ type: 'rate', audience: who, detail: 'How was ' + mealOf[p.meal_id].name + ' ' + when + (slot === 'dinner' ? '' : ' (' + slot + ')') + '? (' + p.meal_id + ') Options: ' + RATE_OPTIONS });
          review.push({ type: 'rate', status: 'open', audience: who, detail: '(' + p.meal_id + ')' });
          given++;
        });
      });
    }

    // Missions: a few "go check" cards per kid, every day (see makeMissions).
    makeMissions(today, kids, review, plan, mealOf).forEach((m) => add(m));

    // Did we get it? Settle List rows that no receipt will close (see makeSettle).
    makeSettle(today, kids, review).forEach((m) => add(m));
    makeMealSettle(today, review, plan, mealOf).forEach((m) => add(m));

    // Best price: best_price items on the List that another store sells cheaper (prices arrive from the price pass).
    makeBestPrice(review).forEach((m) => add(m));

    // Head-to-heads: which of two meals of the same kind do you like more (see makePicks).
    makePicks(today, everyone, review, meals).forEach((m) => add(m));

    // Waste learning: tossed the same thing twice lately → ask the parents to buy less (see makeWaste).
    makeWaste(today, review).forEach((m) => add(m));

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
  let sh = tab(TABS.stock);
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
const HAVE_TEXT = { plenty: 'plenty', some: 'some', low: 'a little' };
function listHave(req) {
  const row = readTab(TABS.list).find((r) => r.id === req.id);
  if (!row) throw new Error('List row not found');
  const level = cleanLevel(req.level) || 'some';
  // A kid's "we have it" asks a parent first: the sighting is logged, the row stays until a parent agrees.
  if (isKid(req.by) && !req._approved) {
    logStock({ item_id: row.item_id, level: level, expires: req.expires, who: req.by, source: req._source || 'list', list_id: row.id });
    const review = readTab(TABS.review);
    const open = review.find((r) => r.type === 'have_check' && r.status === 'open' && String(r.detail).indexOf('(' + row.id + ')') >= 0);
    if (open) return { id: row.id, level: level, pending: open.id, already: true };
    ensureColumn(TABS.review, 'asked_by');
    const id = nextId(review, 'id', 'r', 3);
    appendObj(TABS.review, {
      id: id, created: nowStamp(), type: 'have_check', status: 'open', audience: 'parents', asked_by: req.by,
      detail: req.by + ' says we have ' + (HAVE_TEXT[level] || level) + ' of ' + row.name + ' at home. Take it off the List? (' + row.id + ') Options: Yes, take it off; No, keep it',
    });
    return { id: row.id, level: level, pending: id };
  }
  setFields(TABS.list, row._row, Object.assign({ status: 'have', hold_until: '', note: listNote(row, 'had ' + level + ' (' + (req.by || '?') + ')'), updated_at: nowStamp() },
    row.status === 'carted' ? cartOutFields(row, req.by) : {}));
  if (!req._approved) logStock({ item_id: row.item_id, level: level, expires: req.expires, who: req.by, source: 'list', list_id: row.id }); // a kid's was logged when they said it
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
  const stock = tab(TABS.stock)
    ? readTab(TABS.stock).filter((s) => s.item_id === id).slice(-4).reverse()
      .map((s) => ({ at: String(s.at).slice(0, 10), level: String(s.level), who: s.who || '' }))
    : [];
  const tag = '(' + id + ')';
  const answers = readTab(TABS.review)
    .filter((r) => String(r.detail).indexOf(tag) >= 0 && String(r.answer || '').trim() && String(r.answer).indexOf('skip') !== 0)
    .slice(-5).reverse()
    .map((r) => ({ q: String(r.detail).replace(/\s*Options:[\s\S]*$/, '').replace(/\s*\(i\d{3,}\)/g, ''), answer: String(r.answer) }));
  return { item_id: id, purchases: purchases, stock: stock, answers: answers, products: itemProducts(id) };
}

// "We have some" from the item screen when it isn't on the List: just log the sighting.
function stockLogAction(req) {
  const level = cleanLevel(req.level);
  if (!req.item_id || !level) throw new Error('Missing item or amount');
  logStock({ item_id: req.item_id, level: level, who: req.by, source: req.list_id ? 'list' : 'shop', list_id: req.list_id || '' });
  return { item_id: req.item_id, level: level };
}

function requestOrder(req) {
  const s = readTab(TABS.settings).find((r) => r.key === 'order_requested');
  const value = req.store ? req.store + ' requested by ' + req.by + ' at ' + nowStamp() : '';
  if (s) setFields(TABS.settings, s._row, { value: value });
  else appendObj(TABS.settings, { key: 'order_requested', value: value });
  return { order_requested: value };
}

/* ---------------------------------------------------------------- use soon (api 22) */

const dayOf = (v) => stampOf(v).slice(0, 10);

// Perishables near their last good day, for the strip at the top of the List.
// [{ item_id, name, group, bought, use_by, left }] sorted soonest first; `left` < 0 = past it.
function useSoonList(today, items, list, stockRows, onList) {
  const boughtOn = {}; // item_id -> newest List "bought" day
  list.forEach((r) => {
    if (r.status === 'bought' && r.item_id && r.updated_at) {
      const d = dayOf(r.updated_at);
      if (!boughtOn[r.item_id] || d > boughtOn[r.item_id]) boughtOn[r.item_id] = d;
    }
  });
  const byItem = {};
  stockRows.forEach((s) => { if (s.item_id) (byItem[s.item_id] = byItem[s.item_id] || []).push(s); });
  const out = [];
  items.forEach((it) => {
    const shelf = parseInt(it.shelf_days, 10);
    if (!(shelf > 0) || it.status === 'Drop' || onList[it.id]) return;
    let bought = it.last_bought ? dayOf(it.last_bought) : '';
    if (boughtOn[it.id] && boughtOn[it.id] > bought) bought = boughtOn[it.id];
    if (!bought) return;
    let useBy = addDays(bought, shelf);
    let gone = false;
    (byItem[it.id] || []).forEach((s) => {
      const at = dayOf(s.at), lvl = String(s.level).toLowerCase(), mine = String(s.source) === 'usesoon';
      // Used up / tossed after we bought it (a use-soon tap on the buying day counts too).
      if ((lvl === 'out' || lvl === 'waste') && (at > bought || (mine && at >= bought))) gone = true;
      const exp = s.expires ? dayOf(s.expires) : '';
      if (exp && at >= bought && /^\d{4}-\d\d-\d\d$/.test(exp)) useBy = exp; // Still good / a printed date: the newest wins
    });
    if (gone) return;
    const left = daysBetween(today, useBy);
    if (left > USE_SOON_AHEAD || left < -USE_SOON_DROP) return;
    out.push({ item_id: it.id, name: it.name, group: it.group || '', bought: bought, use_by: useBy, left: left });
  });
  return out.sort((a, b) => a.left - b.left || (a.name < b.name ? -1 : 1));
}

// Used it / Tossed it / Still good on the Use soon strip.
function useSoonAction(req) {
  const level = USE_SOON_ACTS[String(req.what || '')];
  const it = readTab(TABS.items).find((i) => i.id === req.item_id);
  if (!level || !it) throw new Error('Missing item or answer');
  const today = isoDate(new Date());
  const expires = req.what === 'good' ? addDays(today, Number(req.days) > 0 ? Number(req.days) : USE_SOON_SNOOZE) : '';
  logStock({ item_id: it.id, level: level, expires: expires, who: req.by, source: 'usesoon' });
  return { item_id: it.id, what: req.what, expires: expires };
}

// Parents' card for anything tossed WASTE_TIMES+ times in WASTE_DAYS, once per WASTE_REASK_DAYS per item.
function makeWaste(today, review) {
  if (!tab(TABS.stock)) return [];
  const count = {};
  readTab(TABS.stock).forEach((s) => {
    if (String(s.level).toLowerCase() === 'waste' && s.item_id && daysBetween(dayOf(s.at), today) <= WASTE_DAYS) count[s.item_id] = (count[s.item_id] || 0) + 1;
  });
  const asked = {};
  review.forEach((r) => {
    if (r.type !== 'waste' || !r.created || daysBetween(dayOf(r.created), today) > WASTE_REASK_DAYS) return;
    const m = String(r.detail).match(/\((i\d{3,})\)/); if (m) asked[m[1]] = true;
  });
  const items = {};
  readTab(TABS.items).forEach((i) => (items[i.id] = i));
  return Object.keys(count).filter((id) => count[id] >= WASTE_TIMES && !asked[id] && items[id]).slice(0, 2).map((id) => {
    review.push({ type: 'waste', status: 'open', created: today, detail: '(' + id + ')' });
    return { type: 'waste', audience: 'parents', detail: 'We’ve tossed ' + items[id].name + ' ' + count[id] + ' times lately. Buy less? (' + id + ') Options: ' + WASTE_OPTIONS };
  });
}

/* ---------------------------------------------------------------- cart jobs (api 12) */

function jobsSheet() {
  let sh = tab(TABS.jobs);
  if (!sh) { sh = SpreadsheetApp.getActive().insertSheet(TABS.jobs); sh.appendRow(JOBS_HEAD); sh.setFrozenRows(1); }
  return sh;
}

// Parents only. One open job per store + kind: asking again returns the one already waiting.
function addCartJob(req) {
  if (!req._system && isKid(req.by)) throw new Error('Ask a parent to do this');
  const store = String(req.store || '').toUpperCase();
  const kind = String(req.kind || 'build').toLowerCase();
  const allStores = kind === 'signin' || kind === 'all';
  if (allStores ? store !== 'ALL' : JOB_STORES.indexOf(store) < 0) throw new Error('Unknown store');
  if (JOB_KINDS.indexOf(kind) < 0) throw new Error('Unknown job');
  jobsSheet();
  const rows = readTab(TABS.jobs);
  // A line-level change (_system) made while that store's job is already running may come after the runner read the
  // List, so it gets a fresh queued job instead of riding on the running one (api 34).
  const open = rows.find((r) => r.store === store && r.kind === kind && JOB_OPEN.indexOf(String(r.status)) >= 0 &&
    !(req._system && String(r.status) === 'running'));
  if (open) return { id: open.id, already: true };
  const id = nextId(rows, 'id', 'c', 3);
  appendObj(TABS.jobs, { id: id, at: nowStamp(), by: req.by || '', store: store, kind: kind, status: 'queued' });
  // api 49: Check all stores = the sign-in check plus a fresh read of every cart.
  const checks = [];
  if (allStores && !req._system) {
    JOB_STORES.forEach((st) => {
      const r = addCartJob({ by: req.by, store: st, kind: 'check', _system: true });
      if (r && r.id) checks.push(r.id);
    });
  }
  return checks.length ? { id: id, checks: checks } : { id: id };
}

function cancelCartJob(req) {
  if (isKid(req.by)) throw new Error('Ask a parent to do this');
  if (!tab(TABS.jobs)) throw new Error('No such job');
  const row = readTab(TABS.jobs).find((r) => r.id === req.id);
  if (!row) throw new Error('No such job');
  if (String(row.status) === 'running') throw new Error('Claude is already working on it');
  if (JOB_OPEN.indexOf(String(row.status)) < 0) return { id: row.id, status: row.status };
  setFields(TABS.jobs, row._row, { status: 'cancelled', finished_at: nowStamp(), notes: 'Cancelled by ' + (req.by || 'someone') });
  return { id: row.id, status: 'cancelled' };
}

/* ---------------------------------------------------------------- carts by line (api 25) */
// List rows carry the cart they should be in: cart_want = a store code (put it there, or move it there from
// another cart) or 'out' (take it out of the cart it's in). The cart runner does it, then clears cart_want and
// sets status / cart / cart_at, or leaves a reason in cart_note when it couldn't. cart_by = who asked.
const CART_COLS = ['cart', 'cart_at', 'cart_want', 'cart_by', 'cart_note'];
function ensureCartCols() { CART_COLS.forEach((c) => ensureColumn(TABS.list, c)); }

// Fields that send a carted row's line out of its store cart, and queue that store's job.
function cartOutFields(row, by) {
  const st = String(row.cart || '');
  if (JOB_STORES.indexOf(st) < 0) return {};
  ensureCartCols();
  addCartJob({ store: st, kind: 'build', by: by || 'Poppy', _system: true });
  return { cart_want: 'out', cart_by: by || '', cart_note: '' };
}

// api 34: a carted row's qty changed (by a parent). cart_want = the cart it's already in means "set that line's
// qty to the row's qty"; queue that store's build. Skips rows on their way out or moving (that job handles them).
function cartQtyFields(row, qty, by) {
  const st = String(row.cart || '');
  if (row.status !== 'carted' || isKid(by) || JOB_STORES.indexOf(st) < 0) return {};
  if (!(Number(qty) >= 1) || Number(qty) === (Number(row.qty) || 1)) return {};
  if (row.cart_want && String(row.cart_want) !== st) return {};
  ensureCartCols();
  addCartJob({ store: st, kind: 'build', by: by || 'Poppy', _system: true });
  return { cart_want: st, cart_by: by || '', cart_note: '' };
}

// ---------- Best price (api 40, Nov 4, owner) ----------
// "Any store, best price" items (Items best_price = Y): owner decides case by case, once he can see every store's
// price side by side. Compared only like items (not `alt`), priced in the last BEST_FRESH_DAYS, in the same unit
// as the usual store's product. One parents' ⚖ card per List row, never re-asked for that row.
function bestPriceFor(row, item, prods) {
  const base = row.store && row.store !== 'Either' ? row.store : item.store;
  const today = isoDate(new Date());
  const ok = (p) => p && p.match !== 'alt' && Number(p.unit_price) > 0 && p.unit && p.price_at && daysBetween(p.price_at, today) <= BEST_FRESH_DAYS;
  const b = ok(prods[base]) ? Object.assign({ store: base }, prods[base]) : null;
  if (!b) return null;
  const all = JOB_STORES.filter((k) => ok(prods[k]) && prods[k].unit === b.unit).map((k) => Object.assign({ store: k }, prods[k]))
    .sort((x, y) => Number(x.unit_price) - Number(y.unit_price));
  const c = all[0];
  if (!c || c.store === base) return null;
  const amount = Number(b.price) > 0 ? Number(b.price) / Number(b.unit_price) : 1;
  const qty = Number(row.qty) || 1;
  const save = (Number(b.unit_price) - Number(c.unit_price)) * amount * qty;
  const pct = (Number(b.unit_price) - Number(c.unit_price)) / Number(b.unit_price);
  if (pct < BEST_MIN_PCT || save < BEST_MIN_SAVE) return null;
  return { base: base, all: all, save: save, qty: qty };
}
function bestPriceCard(row, item, prods) {
  const x = bestPriceFor(row, item, prods);
  if (!x) return null;
  const sizeDiffers = x.all.some((p) => String(p.size) !== String(x.all[0].size));
  const line = x.all.map((p) => STORE_NAMES[p.store] + ' $' + Number(p.price).toFixed(2) + (sizeDiffers && p.size ? ' (' + p.size + ')' : '') +
    (p.store === x.base ? ' (usual)' : '') + (p.sale ? ' on sale' : '')).join(' · ');
  return { type: 'bestprice', audience: 'parents',
    detail: '💲 ' + row.name + (x.qty > 1 ? ' ×' + x.qty : '') + ' is cheaper at ' + STORE_NAMES[x.all[0].store] + ': ' + line +
      '. About $' + x.save.toFixed(2) + ' less' + (x.qty > 1 ? ' for ' + x.qty : '') + '. Which cart? (' + row.id + ') (' + item.id + ') Options: ' +
      x.all.map((p) => STORE_NAMES[p.store] + ' cart').join('; ') };
}
// Rows already asked about (any status): one card per List row.
function bestAsked(review) {
  const asked = {};
  review.forEach((r) => { if (r.type === 'bestprice') { const m = String(r.detail).match(LIST_ID_RE); if (m) asked[m[1]] = true; } });
  return asked;
}
function makeBestPrice(review, onlyId) {
  const items = readTab(TABS.items);
  if (!items.length || !('best_price' in items[0])) return [];
  const best = {};
  items.forEach((i) => { if (/^y/i.test(String(i.best_price || ''))) best[i.id] = i; });
  if (!Object.keys(best).length) return [];
  const asked = bestAsked(review);
  const prods = productsMap();
  const today = isoDate(new Date());
  return readTab(TABS.list).filter((r) => (onlyId ? r.id === onlyId : true) && r.status === 'needed' && best[r.item_id] && !asked[r.id] &&
    !(r.hold_until && String(r.hold_until).slice(0, 10) > today) && !r.cart_want)
    .map((r) => bestPriceCard(r, best[r.item_id], prods[r.item_id] || {})).filter(Boolean);
}
function addBestPriceCards(rowId) {
  const review = readTab(TABS.review);
  const cards = makeBestPrice(review, rowId);
  let n = nextIdNum(review);
  cards.forEach((o) => appendObj(TABS.review, Object.assign({ id: 'r' + String(n++).padStart(3, '0'), created: nowStamp(), status: 'open', answer: '' }, o)));
}
// "<Store> cart" → the row moves to that store and goes into its cart (cart job queued). The usual store's cart
// when the row isn't carted yet puts it there too. A row no longer on the List is left alone.
function bestPriceAnswer(r, answer, who) {
  const id = (String(r.detail).match(LIST_ID_RE) || [])[1];
  const a = String(answer).replace(/\s*\([^()]*\)\s*$/, '').trim().toLowerCase();
  if (!id || !a || a === 'skip') return null;
  const st = JOB_STORES.find((k) => a.indexOf(STORE_NAMES[k].toLowerCase()) === 0);
  if (!st) return null;
  const row = readTab(TABS.list).find((x) => x.id === id);
  if (!row || (row.status !== 'needed' && row.status !== 'carted')) return { list: id, already: true };
  if (String(row.store) !== st) setFields(TABS.list, row._row, { store: st, updated_at: nowStamp() });
  let pushed = 0;
  try { pushed = cartPush({ rows: [{ id: id, store: st }], by: who }).done; } catch (e) { /* the row still moved stores */ }
  return { list: id, store: st, pushed: pushed };
}

// {rows: [{id, store}]}: put each row in that store's cart. Returns { done: n, stores: {GE: n}, skipped: [ids] }.
function cartPush(req) {
  if (isKid(req.by)) throw new Error('Ask a parent to do this');
  const want = (req.rows || []).filter((x) => x && x.id);
  if (!want.length) throw new Error('Nothing to put in a cart');
  ensureCartCols();
  const list = readTab(TABS.list);
  const today = isoDate(new Date());
  const stores = {};
  const skipped = [];
  const stamp = nowStamp();
  want.forEach((x) => {
    const st = String(x.store || '').toUpperCase();
    const row = list.find((r) => r.id === x.id);
    if (!row || JOB_STORES.indexOf(st) < 0 || (row.status !== 'needed' && row.status !== 'carted') || String(row.hold_until || '').slice(0, 10) > today) { skipped.push(x.id); return; }
    if (row.status === 'carted' && String(row.cart) === st) {
      // Already in that cart: this cancels a pending removal or move, if any (a pending qty change stays).
      if (row.cart_want && String(row.cart_want) !== st) setFields(TABS.list, row._row, { cart_want: '', cart_note: '', updated_at: stamp });
      return;
    }
    setFields(TABS.list, row._row, { cart_want: st, cart_by: req.by || '', cart_note: '', updated_at: stamp });
    stores[st] = (stores[st] || 0) + 1;
  });
  Object.keys(stores).forEach((st) => addCartJob({ store: st, kind: 'build', by: req.by, _system: true }));
  return { done: Object.keys(stores).reduce((t, k) => t + stores[k], 0), stores: stores, skipped: skipped };
}

// {ids}: take rows out of their cart (they stay on the List as needed), or cancel a push that hasn't run yet.
function cartRemove(req) {
  if (isKid(req.by)) throw new Error('Ask a parent to do this');
  ensureCartCols();
  const ids = (req.ids || (req.id ? [req.id] : [])).map(String);
  const list = readTab(TABS.list);
  const stamp = nowStamp();
  let out = 0, cancelled = 0;
  ids.forEach((id) => {
    const row = list.find((r) => r.id === id);
    if (!row) return;
    if (row.status === 'carted') {
      const f = cartOutFields(row, req.by);
      if (f.cart_want) { setFields(TABS.list, row._row, Object.assign(f, { updated_at: stamp })); out++; }
    } else if (row.cart_want || row.cart_note) {
      setFields(TABS.list, row._row, { cart_want: '', cart_note: '', updated_at: stamp });
      cancelled++;
    }
  });
  return { out: out, cancelled: cancelled };
}

// api 24: what the cart watcher asks every minute. Read-only and small; no full state.
function scriptProp(k) { try { return String(PropertiesService.getScriptProperties().getProperty(k) || ''); } catch (e) { return ''; } }

// Settings stores_ok "GE=ok;WF=out" → {GE: 'ok', WF: 'out'} (api 42).
function storesOk(v) {
  const out = {};
  String(v || '').split(/[;,]/).forEach((p) => {
    const m = p.trim().match(/^([A-Za-z]+)\s*=\s*([a-z]+)/);
    if (m && JOB_STORES.indexOf(m[1].toUpperCase()) >= 0) out[m[1].toUpperCase()] = m[2] === 'ok' ? 'ok' : 'out';
  });
  return out;
}

function openCartJobs(req) {
  // Heartbeat: the watcher calls this every minute while the home computer is on (no Sheet write; a Script Property).
  try {
    PropertiesService.getScriptProperties().setProperties({ watcher_seen: nowStamp(), watcher_chrome: req && String(req.chrome) === '0' ? '0' : '1' });
  } catch (e) { /* a heartbeat can be skipped */ }
  if (!tab(TABS.jobs)) return { jobs: [] };
  const jobs = readTab(TABS.jobs)
    .filter((r) => JOB_OPEN.indexOf(String(r.status)) >= 0)
    .map((r) => ({ id: r.id, at: String(r.at), store: r.store, kind: r.kind, status: String(r.status), started_at: String(r.started_at || '') }));
  return { jobs: jobs };
}

function recentCartJobs(today) {
  if (!tab(TABS.jobs)) return [];
  return readTab(TABS.jobs)
    .filter((r) => JOB_OPEN.indexOf(String(r.status)) >= 0 || daysBetween(String(r.at).slice(0, 10), today) <= JOB_SHOW_DAYS)
    .map((r) => ({ id: r.id, at: String(r.at), by: r.by, store: r.store, kind: r.kind, status: String(r.status),
      started_at: String(r.started_at || ''), finished_at: String(r.finished_at || ''), result: String(r.result || ''),
      subtotal: r.subtotal === '' || r.subtotal == null || isNaN(Number(r.subtotal)) ? '' : Number(r.subtotal), lines: r.lines === '' || r.lines == null ? '' : Number(r.lines) }))
    .reverse()
    .slice(0, 24);
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
    let archive = tab('List Archive');
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
  let archive = tab('Plan Archive');
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
