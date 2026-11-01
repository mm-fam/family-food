# Poppy 2.0 system reference

The app is named **Poppy 2.0** (the family's name for its earlier AI project). The repo and URL keep the `family-food` name so existing home-screen links keep working.

_Last updated: Nov 1 2026 (api 9: family-demo round)_

## Purpose
A shared phone app where anyone in the family adds what we need, picks dinners, and taps staples, with Claude behind it closing the loop from receipts and filling store carts. Design goal from day one: **it must never become a chore or go stale.** Automation (receipts, "probably due", draft lists) does the upkeep, not the family.

## People and roles
| Who | Role |
|---|---|
| Mom | Runs household food. Final say on menus, carts, what's bought. |
| Mike | Builder and admin. Owns the repo, Sheet, Apps Script deployment, Chrome sessions. |
| Kids | App users. Adds land as `requested`; a parent approves. |
| Claude | Operator: receipt ingest, cart building, catalog upkeep, Review questions, code changes. |

## Stores
- **Giant Eagle (GE):** kid lunches, snacks, everyday dinners. Curbside/delivery. myPerks rewards account.
- **Whole Foods (WF):** ordered through Amazon. Premium items, produce, specialty (Nounos yogurt, Creminelli salami, brie bites, pizza dough).
- **Target (TGT):** toiletries, personal care, paper and household. Drive Up / pickup about once a month (online orders also ship). Mostly non-food.
- `Either` = either grocery store (GE or WF), whichever order is next. Never Target; Target items are always tagged TGT.

## Architecture
```
phones (GitHub Pages, PWA)  --POST-->  Apps Script web app  -->  Google Sheet "Poppy 2.0 (app data)"
                                                                       ^
                       Claude (Sheets/Gmail connectors, Chrome) -------+  receipts, carts, review
```
| Piece | Where |
|---|---|
| App | `mm-fam/family-food` (public repo), served at https://mm-fam.github.io/family-food/. Plain HTML/JS/CSS, no build: `index.html`, `app.js`, `styles.css`, `manifest.webmanifest`, `icons/` (Poppy 2.0 logo, rounded-square robot tile: 180 apple-touch full-bleed for iPhone, 192 + 512 with transparent rounded corners, 512 maskable at 70% on a matching teal gradient for Android, `poppy-logo.png` 320 shown on the unlock and "Who's this?" screens). |
| Config | `config.js` holds `API_URL` (the Apps Script `/exec` URL). Not a secret. |
| Backend | `apps-script/Code.gs` in the repo; the live copy is in the Sheet's Apps Script. Deployed as Web app, Execute as Me, access Anyone. A push to `main` that changes Code.gs deploys it automatically (GitHub Action **Deploy backend**, clasp; runbook §4). `?action=version` (no passcode) returns the live `api`. |
| Passcode | Script Property `FAMILY_PASSCODE`. Checked on every request. Never put it in the repo or in project docs. |
| Data | Google Sheet "Poppy 2.0 (app data)" in Mike's Drive |

### App behavior
- Four tabs, evenly spaced: **List, Shop, Meals, Q&A** (Q&A is the Ask deck; its internal id stays `ask`). **List** shows a count of active items (green; orange when a parent has kids' requests waiting); **Q&A** shows open questions for you. First launch asks passcode + "Who's this?" (stored on the device). While the first state loads (after Unlock, and on every return visit) a loading screen shows the logo, a spinner and "Checking the passcode…" / "Getting the list…", adds a "server is waking up" line after 4 s, and offers **Try again** if the load fails (a wrong saved passcode goes back to the passcode form).
- **List** = what we need, as **one list by aisle** (Nov 1 family demo: timing matters more than the store; wherever we shop, we grab what we can). Kids' requests on top, then one accordion per aisle (Items.group) with a one-line peek when folded. Rows show a small store dot (where we usually get it), an **Only at <store>** tag when Items.store_only = Y, qty, note, a meal tag (🍽 meal name) and who asked (`wanted_by`; yellow when 2+). **Everything starts folded each time the app opens**; what you open stays open until the app is closed. A row that leaves the List (we have it, bought, taken off) stays in place crossed out for ~6 s with **Undo**. A dismissible **Put Poppy on your Home Screen** card shows when the app is opened in a browser instead of from the home screen. Next week is a folded card. No check-off at home: tapping a row opens the item screen.
- **🛒 In store** (List header; everyone incl. kids): pick a store (GE / WF / Target / All); rows by aisle with checkboxes. Every row shows except ones **only** another store carries; rows usually bought elsewhere say "usually <store>". A check sets the row `bought` at once; rows bought today stay crossed out, so people shopping together see the same checks. Tap again = back to `needed`. Done leaves the mode.
- **Shop** = where things get added. Search box (no match → "Add … as something new"), smart filter pills with counts (Probably due, For dinners = ingredients of dinners planned in the next 14 days, Usuals = Always or 2+ orders, Running low = low/out Stock sighting in 14 days, Bought lately, On the list; empty pills hide) and store pills. Rows by aisle with a + button (✓ when on the list), store dot, last bought, latest at-home sighting. Aisles are accordions that start folded (peek of names, Open all / Close all); typing a search opens every aisle it matches.
- **Item screen** (from List or Shop, same layout): name, store, aisle; status (on the list / asked by / meal tag) with qty stepper and a trip note, or a big Add button; one-tap "Have some at home?" Plenty / Some / A little / Count (on the List: Plenty / Some / a count close the row as `have`, **A little keeps it on the List** and only logs the sighting; off the List: just a Stock sighting via `stockLog`); quiet Next week / Bought it / Take off; **History** (orders, last bought, typical gap, last 6 purchases with store and price, at-home sightings) and **What we know** (Items notes + answered Ask questions that mention the item), loaded with `itemInfo`; folded **Details** (store we use, **can other stores get it?** (store_only, api 9), swap OK, how often, brand/size, aisle, notes; parents edit, kids read).
- **Meals tab:** dinner plan as two swipe-sideways **week strips** (about 2½ days visible on a phone): **This week** (today → Saturday) on top, **Next week** (Sun → Sat) below, folded until tapped. Each day tile: tap the meal name to pick a dinner (phone's own picker), **Ingredients** opens what's needed under that week's strip. Plan data is still the rolling 14 days; nights past next Saturday are planned from the meal card; **Meal ideas** (what people pasted and where each stands); **Our meals** library. Each meal row carries **stat tags**: family votes (emoji counts, "Favorite" when 2+ votes average ≥ 3.5), Tonight / Next <day>, Made N× · last <date>, cost tier + estimate ($ < $15, $$ < $30, $$$; shown when most ingredients have a receipt price, "+" when some are missing), New. Sort pills: A–Z, Favorites, Cheapest, Not lately. Tapping a meal opens the **meal card**: day chips for this week and next (tap = plan it, tap again = off; a night with another meal gets swapped, with Undo), ingredients with "Add N to the List", notes, Edit meal. **💡 Idea**: paste a recipe, link or idea; saved to Meal Ideas for Claude to turn into a meal (kids' ideas go to a parent first). Stats and ideas need backend api 7. **Meal slots (api 8):** each day tile also lists 🥣 breakfast / 🥪 lunch / 🍎 snack; tapping the day opens a **day sheet** with all four slots (picker per slot, ↗ to the meal card). Meals have a kind (kind pills in Our meals; "Usually for" in Edit meal); a meal card plans into its own slot. Leftover rows show as "Leftover <meal>". **Day tiles (Nov 1):** Today / day + date, then Breakfast, Lunch, Snack, Dinner top to bottom at the same size; tapping the tile opens the day sheet; "Dinner ingredients" opens under the strip. **+ New is gone** (💡 Meal idea covers new meals; + New shows only on backends without ideas). **Kids (api 9)** don't plan: the meal card shows **Want this?** (slot + This week / Next week / Anytime → **Ask for it**, action `mealRequest`), and the day sheet is read-only. Parents see **Meal requests** at the top of Meals with **Plan it** (opens the meal card; planning a day answers the request) and **Not now**. **→ Hearth** (parents): builds a paste-ready message for the Hearth display's AI assistant (Hearth Helper) with this or next week's Breakfast / Lunch / Snack / Dinner, Copy / Share. See `docs/hearth.md`.
- **💡 in the header** (everyone, api 9): "Idea for Poppy", free text about the app → `feedback` → App Feedback tab; the morning check reports new rows to the owner. It links to the meal-idea sheet for meal ideas.
- **Admin screen** (gear, only names in Settings.admins (comma-separated; both parents today), else the first parent): counts per store, "Ask Claude to build the cart".
- **Q&A tab** (was Ask): a deck of cards, one question at a time, with progress. The control comes from the question's `Options:` text: `Yes; No` → big Yes/No buttons, swipe right = yes, left = no; 2–4 options → big tap buttons; 5+ → dropdown; short emoji-only options → emoji row; no options → text box. `Other (type it)` opens a text box; `Don't care` = skip. Every card has "Something else? Type it", "Don't care", and "Later" (moves it to the back; swipe left on non-yes/no cards). Item, meal and idea ids like (i108), (m16), (x001) are hidden on screen. Blank/absent `audience` = parents; kids see "All caught up" until per-person questions exist. Answers are saved as `<answer> (<name>)`.
- Polls state every 20 s. Every write returns fresh state. A state read that started before or during a write is ignored, so an approved request no longer flashes back.
- Kids (names in Settings.kids) add as `requested`; parents approve.
- "Ask Claude to build the cart" (admin screen) only sets `Settings.order_requested`.

### Backend API (`action` in POST body, plus `pass`)
`ping`, `state`, `add`, `update`, `addMeal`, `planSet`, `mealSave`, `itemSave`, `reviewAnswer`, `reviewPass`, `listHave`, `listHold`, `requestOrder`, `itemInfo`, `stockLog`, `mealIdea`, `mealRequest`, `feedback`, plus `version` (no passcode; returns only `api`). `state` includes `api` (backend version; 2 = reviewPass + Review audience; 3 = listHave/listHold + Stock; 4 = List `wanted_by`, Settings.admins; 5 = `itemInfo` {item_id} → purchases/stock/answers (no state returned), `stockLog` {item_id, level}, `state.stock` = latest sighting per item; 6 = Plan by date: `state.plan` = rows dated today … today+13 (`planDays` 14), `planSet` {date, meal_id} (older apps' week_of + day still work); 7 = `mealIdea` {text} → Meal Ideas row, `state.ideas` (open ideas + ones finished in the last 14 days), `state.mealStats` per meal {voters, votes, score, made, last, next, cost, priced, linked} computed from Review votes, Plan + Plan Archive and Receipts; 8 = meal slots; **9** = Items `store_only` via `itemSave`, `mealRequest` {meal_id, slot, when} → Review `meal_request` row (audience parents, `asked_by`), `feedback` {text, tab} → App Feedback row, kids can't `planSet` / `mealSave`, daily automatic Q&A cards (below), `rate` cards count as votes in mealStats).

**Automatic Q&A cards (api 9)**, made in `getState` the first time anyone opens the app each day (Settings `cards_through`, no trigger needed): **How was it?** (type `rate`, one per person) the day after a dinner or breakfast that's still new to us (made ≤ 2 times before), max 2 per person per day, catching up at most 3 days; unanswered ones close after 5 days. **Still eating …?** (type `still`, Yes/No) weekly (Settings `still_through`): 2 per person from food items bought 2+ times, not asked to that person in 90 days. `add` on an item already on the list adds the asker to `wanted_by` instead of bumping qty and `held` (rows moved to next week). The app hides features whose backend isn't deployed yet. Writes run under a script lock. GET works too for a quick browser check: `/exec?action=ping&pass=...`.

**"Probably due"** (computed in `getState`): item not Drop, has `avg_days` and `last_bought`, not already on the list, and days since last buy ≥ `avg_days − 2`. Top 12 by how overdue.

**Nightly trigger** (`nightly`, ~3 am, installed by `setup()`): moves bought/skipped/have List rows older than 14 days to **List Archive**, and Plan rows dated more than 14 days ago to **Plan Archive** (no `setup()` rerun needed).

## Sheet tabs
- **Items:** id | name | store (GE/WF/TGT/Either) | group | brand_size | ok_swap (Y/N/blank=ask) | status (Always/Sometimes/Drop) | aliases (receipt text, `;` separated) | notes | orders | first_bought | last_bought | avg_days | **store_only** (`Y` = only that store carries it; added by the backend the first time someone sets it). **J:M are formulas over Receipts; never type into them.** New rows need the formulas copied down.
- **List:** id | item_id | name | store | qty | note | added_by | added_at | status | updated_at | meal_id | hold_until | wanted_by (`;`-separated names of everyone who asked; blank = added_by). Status flow: `requested → needed → carted → bought | skipped | have`. `have` = we already had it, nothing bought (item sheet: "We have it"). `hold_until` set = "Next week": the row stays `needed` but is hidden until that date; re-adding the item brings it back now.
- **Stock:** at | item_id | level (plenty/some/low or a count) | expires | who | source | list_id. Append-only log of "we have it" sightings. A plenty/some/count sighting in the last 7 days holds the item out of "probably due". Design: light inventory, never counting sessions.
- **List Archive / Plan Archive:** same columns as List / Plan; written only by `nightly`.
- **Meal Ideas** (created by the backend on first use): id (x001…) | at | who | text | status (`new` → `done`, or `asked` = a kid's idea waiting for a parent, or `declined`) | meal_id | notes. Claude processes `new` rows (runbook §8). Never delete rows.
- **Meals:** id | name | item_ids (`;` separated) | notes | **kind** (breakfast/lunch/snack/dinner; blank = dinner; api 8). Stats (votes, times made, cost) are computed by the backend, never typed. Dinner-vote cards should include the meal id: `Dinner vote: how do you feel about <name>? (mNN) Options: 😍; 🙂; 😐; 👎` (older cards are matched by name). The 5 seeded dinners (Taco night, Pizza night, Chili, Meatloaf, Steak & fries) were Claude's guesses; Mom may replace them.
- **Plan:** week_of (Sunday) | day | meal_id | date (`yyyy-mm-dd`, the real day) | **slot** (breakfast/lunch/snack/dinner; blank = dinner) | **note** (api 8). One meal per date + slot. A note starting "Leftover" = leftovers: no ingredients, not counted as made; a note with no meal is shown as is. Shop's **For meals** pill = ingredients of every non-leftover row in the 14 days. week_of/day are kept for reading the Sheet; rows without date fall back to week_of + day.
- **Receipts:** date | store | order_ref | raw | item_id | qty | price | match. One row per receipt line. Append-only.
- **Review:** id | created | type | detail | status (open/answered/closed) | answer | audience | passed_by | **asked_by** (api 9; who asked, for `meal_request` rows). Types: clarify / preference / vote / profile, plus **rate** (How was it?), **still** (Still eating?), **meal_request** (a kid's meal ask; shown on the Meals tab, not in Q&A). `audience` = who sees it in Ask (a name, `parents` or `all`; blank = parents). **Pass ↗** on a card sets audience to another family member and `passed_by` to the passer; their card shows "<name> passed this to you". Options go at the end of `detail` as `Options: A; B; C` until an options column exists.
- **Settings:** parents, kids, ge_order_day, wf_order_day, order_requested, admins, cards_through, still_through (the last two are written by the backend)
- **App Feedback** (api 9, created on first use): id (f001…) | at | who | tab | text | status (`new` → `seen`) | notes. Never delete rows.

Groups used by the app: Produce, Dairy, Cheese & deli, Meat, Bakery, Breakfast, Snacks, Pantry, Frozen, Personal care, Household, Paper & cleaning, Other.

## Claude's jobs (details in runbooks)
1. **Receipt ingest:** new GE/WF receipts → Receipts rows → match by aliases → active List rows to `bought` → unknowns to Review.
2. **Cart building:** when `order_requested` is set, fill that store's cart in Chrome from List rows, respect ok_swap, report swaps/misses to Review, set rows `carted`. Never check out.
3. **Catalog upkeep:** new items get next free id + J:M formulas; fold answered Review rows back into Items.

## Baseline data (Oct 2026)
Seeded from 3 orders (1 GE, 2 WF): 91 items, 107 receipt lines. Open GE codes asked in Review: "MD BLACK", "PEP 3 PK", "PROTEIN & PROBIOTC".

## Status
- **Oct 31 2026:** MVP live and verified end to end in Chrome (wrong-passcode test only; no data written). Mike is testing privately. **No emails or outreach to the family yet.**
- Not yet done: Mom's UI feedback, Gmail auto-forward from Mom, daily receipt task, cart building.
