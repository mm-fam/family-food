# Poppy 2.0 system reference

The app is named **Poppy 2.0** (the family's name for its earlier AI project). The repo and URL keep the `family-food` name so existing home-screen links keep working.

_Last updated: Oct 31 2026 (v1 MVP)_

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
| App | `mm-fam/family-food` (public repo), served at https://mm-fam.github.io/family-food/. Plain HTML/JS/CSS, no build: `index.html`, `app.js`, `styles.css`, `manifest.webmanifest`, `icons/` (Poppy 2.0 logo: 180 apple-touch, 192, 512, 512 maskable). |
| Config | `config.js` holds `API_URL` (the Apps Script `/exec` URL). Not a secret. |
| Backend | `apps-script/Code.gs` in the repo; the live copy is pasted into the Sheet's Apps Script. Deployed as Web app, Execute as Me, access Anyone. |
| Passcode | Script Property `FAMILY_PASSCODE`. Checked on every request. Never put it in the repo or in project docs. |
| Data | Google Sheet "Poppy 2.0 (app data)" in Mike's Drive |

### App behavior
- Three tabs: **Need, Meals, Ask.** First launch asks passcode + "Who's this?" (stored on the device).
- **Need** = one list of what we need, grouped by store, with this week's dinners on top, "Probably due" (parents) and "Browse what we buy" (the old Staples chips). At home nothing is checked off: tapping an item opens it (how many, Bought it, We have it, Next week, Take off). Each row shows who asked (`wanted_by`, e.g. "Mike + Joni", highlighted when 2+).
- **Shop mode** (🛒 Shop, everyone incl. kids): pick a store (GE / WF / Target / All); rows by aisle (Items.group) with checkboxes. A check sets the row `bought` right away; rows bought today stay crossed out, so people shopping together see the same checks. Tap again = back to `needed`. Done leaves Shop mode.
- **Admin screen** (gear, only Settings.admins, else the first parent): the old Order tab (counts per store, "Ask Claude to build the cart").
- **Ask tab:** a deck of cards, one question at a time, with progress. The control comes from the question's `Options:` text: `Yes; No` → big Yes/No buttons, swipe right = yes, left = no; 2–4 options → big tap buttons; 5+ → dropdown; short emoji-only options → emoji row; no options → text box. `Other (type it)` opens a text box; `Don't care` = skip. Every card has "Something else? Type it", "Don't care", and "Later" (moves it to the back; swipe left on non-yes/no cards). Item ids like (i108) are hidden on screen. Blank/absent `audience` = parents; kids see "All caught up" until per-person questions exist. Answers are saved as `<answer> (<name>)`.
- Polls state every 20 s. Every write returns fresh state.
- Kids (names in Settings.kids) add as `requested`; parents approve.
- "Ask Claude to build the cart" (admin screen) only sets `Settings.order_requested`.

### Backend API (`action` in POST body, plus `pass`)
`ping`, `state`, `add`, `update`, `addMeal`, `planSet`, `mealSave`, `itemSave`, `reviewAnswer`, `reviewPass`, `listHave`, `listHold`, `requestOrder`. `state` includes `api` (backend version; 2 = reviewPass + Review audience; 3 = listHave/listHold + Stock; 4 = List `wanted_by`, Settings.admins). `add` on an item already on the list adds the asker to `wanted_by` instead of bumping qty and `held` (rows moved to next week). The app hides features whose backend isn't deployed yet. Writes run under a script lock. GET works too for a quick browser check: `/exec?action=ping&pass=...`.

**"Probably due"** (computed in `getState`): item not Drop, has `avg_days` and `last_bought`, not already on the list, and days since last buy ≥ `avg_days − 2`. Top 12 by how overdue.

**Nightly trigger** (`nightly`, ~3 am, installed by `setup()`): moves bought/skipped List rows older than 14 days to **List Archive**.

## Sheet tabs
- **Items:** id | name | store (GE/WF/TGT/Either) | group | brand_size | ok_swap (Y/N/blank=ask) | status (Always/Sometimes/Drop) | aliases (receipt text, `;` separated) | notes | orders | first_bought | last_bought | avg_days. **J:M are formulas over Receipts; never type into them.** New rows need the formulas copied down.
- **List:** id | item_id | name | store | qty | note | added_by | added_at | status | updated_at | meal_id | hold_until | wanted_by (`;`-separated names of everyone who asked; blank = added_by). Status flow: `requested → needed → carted → bought | skipped | have`. `have` = we already had it, nothing bought (item sheet: "We have it"). `hold_until` set = "Next week": the row stays `needed` but is hidden until that date; re-adding the item brings it back now.
- **Stock:** at | item_id | level (plenty/some/low or a count) | expires | who | source | list_id. Append-only log of "we have it" sightings. A plenty/some/count sighting in the last 7 days holds the item out of "probably due". Design: light inventory, never counting sessions.
- **List Archive:** same columns; written only by `nightly`.
- **Meals:** id | name | item_ids (`;` separated) | notes. The 5 seeded dinners (Taco night, Pizza night, Chili, Meatloaf, Steak & fries) were Claude's guesses; Mom may replace them.
- **Plan:** week_of (Sunday) | day | meal_id
- **Receipts:** date | store | order_ref | raw | item_id | qty | price | match. One row per receipt line. Append-only.
- **Review:** id | created | type | detail | status (open/answered/closed) | answer | audience | passed_by. `audience` = who sees it in Ask (a name, `parents` or `all`; blank = parents). **Pass ↗** on a card sets audience to another family member and `passed_by` to the passer; their card shows "<name> passed this to you". Options go at the end of `detail` as `Options: A; B; C` until an options column exists.
- **Settings:** parents, kids, ge_order_day, wf_order_day, order_requested, admins

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
