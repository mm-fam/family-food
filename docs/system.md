# Family Food system reference

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
- `Either` = buy wherever the next order is.

## Architecture
```
phones (GitHub Pages, PWA)  --POST-->  Apps Script web app  -->  Google Sheet "Family Food (app data)"
                                                                       ^
                       Claude (Sheets/Gmail connectors, Chrome) -------+  receipts, carts, review
```
| Piece | Where |
|---|---|
| App | `mm-fam/family-food` (public repo), served at https://mm-fam.github.io/family-food/. Plain HTML/JS/CSS, no build: `index.html`, `app.js`, `styles.css`, `manifest.webmanifest`, `icons/`. |
| Config | `config.js` holds `API_URL` (the Apps Script `/exec` URL). Not a secret. |
| Backend | `apps-script/Code.gs` in the repo; the live copy is pasted into the Sheet's Apps Script. Deployed as Web app, Execute as Me, access Anyone. |
| Passcode | Script Property `FAMILY_PASSCODE`. Checked on every request. Never put it in the repo or in project docs. |
| Data | Google Sheet "Family Food (app data)" in Mike's Drive |

### App behavior
- Four tabs: **List, Staples, Meals, Order.** First launch asks passcode + "Who's this?" (stored on the device).
- Polls state every 20 s. Every write returns fresh state.
- Kids (names in Settings.kids) add as `requested`; parents approve.
- "Ask Claude to build the cart" only sets `Settings.order_requested`. Nothing is automatic yet.

### Backend API (`action` in POST body, plus `pass`)
`ping`, `state`, `add`, `update`, `addMeal`, `planSet`, `mealSave`, `itemSave`, `reviewAnswer`, `requestOrder`. Writes run under a script lock. GET works too for a quick browser check: `/exec?action=ping&pass=...`.

**"Probably due"** (computed in `getState`): item not Drop, has `avg_days` and `last_bought`, not already on the list, and days since last buy ≥ `avg_days − 2`. Top 12 by how overdue.

**Nightly trigger** (`nightly`, ~3 am, installed by `setup()`): moves bought/skipped List rows older than 14 days to **List Archive**.

## Sheet tabs
- **Items:** id | name | store (GE/WF/Either) | group | brand_size | ok_swap (Y/N/blank=ask) | status (Always/Sometimes/Drop) | aliases (receipt text, `;` separated) | notes | orders | first_bought | last_bought | avg_days. **J:M are formulas over Receipts; never type into them.** New rows need the formulas copied down.
- **List:** id | item_id | name | store | qty | note | added_by | added_at | status | updated_at | meal_id. Status flow: `requested → needed → carted → bought | skipped`.
- **List Archive:** same columns; written only by `nightly`.
- **Meals:** id | name | item_ids (`;` separated) | notes. The 5 seeded dinners (Taco night, Pizza night, Chili, Meatloaf, Steak & fries) were Claude's guesses; Mom may replace them.
- **Plan:** week_of (Sunday) | day | meal_id
- **Receipts:** date | store | order_ref | raw | item_id | qty | price | match. One row per receipt line. Append-only.
- **Review:** id | created | type | detail | status (open/answered) | answer. Questions to Mom/Mike, answered in the app.
- **Settings:** parents, kids, ge_order_day, wf_order_day, order_requested

Groups used by the app: Produce, Dairy, Cheese & deli, Meat, Bakery, Breakfast, Snacks, Pantry, Frozen, Other.

## Claude's jobs (details in runbooks)
1. **Receipt ingest:** new GE/WF receipts → Receipts rows → match by aliases → active List rows to `bought` → unknowns to Review.
2. **Cart building:** when `order_requested` is set, fill that store's cart in Chrome from List rows, respect ok_swap, report swaps/misses to Review, set rows `carted`. Never check out.
3. **Catalog upkeep:** new items get next free id + J:M formulas; fold answered Review rows back into Items.

## Baseline data (Oct 2026)
Seeded from 3 orders (1 GE, 2 WF): 91 items, 107 receipt lines. Open GE codes asked in Review: "MD BLACK", "PEP 3 PK", "PROTEIN & PROBIOTC".

## Status
- **Oct 31 2026:** MVP live and verified end to end in Chrome (wrong-passcode test only; no data written). Mike is testing privately. **No emails or outreach to the family yet.**
- Not yet done: Mom's UI feedback, Gmail auto-forward from Mom, daily receipt task, cart building.
