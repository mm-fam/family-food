# Poppy 2.0 runbooks

Step-by-step procedures. Read `family-food-system.md` first for the schema.

---

## 1. Receipt ingest

> **Emailed receipts are retired (Nov 4, owner).** Every store's own order history is the source now, read daily by the cart runner on the owner's computer (§13 steps 10–12: Giant Eagle, Whole Foods + Amazon, Target). The morning check no longer searches Gmail for receipts; it only does the freshness line below. The email how-to is kept here in case a store's history can't be read. Steps 2–7 under **Write it** (matching, new items, List rows, How was it? cards) still apply to order-history lines.

**When:** only by hand now, if a store's order history can't be read.

**Find the emails (Gmail).** Run these in parallel; one broad query misses things.
- Giant Eagle itemized: subject `"Your Digital Receipt from"`. Senders seen: `receipts@info.gianteagle.com`, `curbside@info.gianteagle.com`. Order *confirmation* emails usually have only an estimated total. Skip those and wait for the digital receipt.
- Whole Foods: come from **Amazon**, not Whole Foods. Search Amazon order/receipt emails mentioning Whole Foods.
- Forwards from Mom: `from:<Mom's address> newer_than:2d (Fwd OR receipt OR order)`.
- Target: order emails from `orders@oe.target.com` / `orders@oe1.target.com` (Drive Up and shipped). In-store and app receipts don't email; a parent can share the Target app receipt (PDF/screenshot). order_ref = `TGT <receipt barcode number>`.
- Dedupe on `order_ref`: if Receipts already has that order_ref, skip the whole email.

**Giant Eagle's own order history is the main GE source (Nov 2).** The cart runner reads it every day (§13 step 10) and writes each completed order to Receipts as order_ref `GE <site order code>` (e.g. `GE FKQSWY2HGX`), match `GE site` / `GE site (no item yet)`. So for Giant Eagle emails: **skip a GE email receipt when Receipts already has GE rows on that date** (the site already logged that order), and the daily pass skips a date an email already logged. The last 12 months of GE orders were loaded Nov 2 (27 orders); older history (back to Feb 2022) can be read the same way if ever needed.

**Write it.**
1. Append one Receipts row per line: date (order date, ISO), store (GE/WF), order_ref, raw (exact receipt text), qty, price.
2. Match `raw` against Items.aliases (case-insensitive, exact token match first, then close match). Set `item_id` and `match` = `alias` / `fuzzy` / `none`.
3. On a fuzzy match you're confident in, append the raw text to that item's aliases.
4. No match: if obviously a new product, create the Item (next free id, store, group, brand_size, status `Sometimes`, J:M formulas copied down) and set `match=new`. If unclear, leave item_id blank and file Review: type `unknown_code`, detail `"<raw>" on <store> <date>. What is it?`.
5. For each matched item, set active List rows (`needed`/`carted`) with that item_id and same store (or Either, for GE/WF only) to `bought`, `updated_at` now.
6. Process answered Review rows: apply the answer (rename, alias, merge, drop), back-fill item_id on the matching Receipts rows, set Review status to `closed`.

7. **New food items** from a receipt (match `new`, not Personal care / Household / Paper & cleaning): add up to 3 per receipt as "How was it?" cards, one per person: `We got <name>. How was it? (iNNN) Options: 😍; 🙂; 😐; 👎` (type `rate`, audience = that person, status `open`). Answers show on the item screen under What we know.

**Report:** "<store> <date>: N lines, N matched, N new items, N questions, N list items cleared." Nothing else unless something broke.

**Freshness line (every morning check):** read the newest Receipts date per store (the app gets the same as `state.freshness`) and Settings `ge_orders_through`, `amz_orders_through`, `tgt_orders_through`. Add one report line only when something looks stale: a `*_orders_through` more than 2 days old ("🧾 Whole Foods / Amazon order history hasn't been read since Nov 3. Is the cart computer on?"), or a store whose newest purchase is more than 10 days old while a cart was built there. "Probably due", "Not lately" and Use soon all read these dates (plus List rows marked bought), so a stale source makes them wrong.

---

## 2. Cart building

**When:** `Settings.order_requested` is set (`GE`, `WF`, `TGT` or `AMZ`) or a parent asks. Start with one store and get it reliable before doing more.

**Line by line (api 25, Nov 2):** parents put single List rows in a cart, take them out or move them, from the item screen, "Put … in carts" on the List, or a store on the Carts screen. Each sets List `cart_want` and queues that store's `build` job. A build job for store X does exactly this, in this order:
- **Moves in:** rows with `cart_want` = X that are `carted` in another store Y → remove that line from Y's cart first.
- **Removes:** rows (any status) with `cart` = X and `cart_want` = `out` → remove the line from X's cart. Then: status `carted` → `needed`; a done row (taken off, We have it, grabbed in store) keeps its status. Clear `cart`, `cart_at`, `cart_want`. Remove only lines Poppy has a row for.
- **Qty changes (api 34):** rows `carted` with `cart` = X **and** `cart_want` = X (a parent changed how many on the item screen) → set that line's quantity in X's cart to the row's `qty` with the cart's own quantity control. Never add a second line or add on top. Line missing → add it as below. Done → `cart_at` = now, `cart_want` / `cart_note` cleared. Can't → `cart_want` cleared, `cart_note` = "X: couldn't change qty" (still `carted`).
- **Adds:** all other rows with status `needed` or `carted` and `cart_want` = X → add as in steps 3–4 below → `carted`, `cart` = X, `cart_at` = now, `cart_want` and `cart_note` cleared. Couldn't add (out of stock, no match, ok_swap not Y) → status `needed`, `cart_want` cleared, `cart_note` = "X: <short reason>" (e.g. "GE: out of stock"); the app shows ⚠ Not added.
- **No `cart_want` rows at all for X** (an older app's Build the cart): fill every row as in step 2.
- Then reconcile (§12) and set the result: "Added 4 · took out 1 · 18 in the cart, $142.10 · 1 not added".

**Needs:** the owner's computer awake, Chrome open with the Claude extension connected, and the store signed in (by a person; never by Claude). A session started from a phone works too: it drives that computer's Chrome. If Chrome can't be reached, stop and say so.

1. Load the Chrome tools; check the tabs; open a new tab. Confirm the store site is signed in. If not, stop and ask. **Never enter credentials.** Look at the cart first: if it holds items nobody from Poppy put there, ask before adding (it may be a live order).
2. Rows to fill: List rows with status `needed` whose **List row store** is that store (a parent can move a row to a cheaper store with **Get at <store>** on ⚙, api 23; the row's store wins over Items.store), plus `Either` for GE/WF (never for Target or Amazon), skipping items with `store_only = Y` for another store. Ask about borderline rows rather than guessing. Skip `requested` (unapproved) and held rows.
3. For each row, pick the product from **Products** (item_id + store). **A row whose note starts `Try:` (api 29) gets the product named there** (a parent said Try it next order), once; if it's out, use our usual product and say so in the result. Otherwise `exact` first, then `likely`, newest `last_bought` wins; `alt` only if those are out; never a `store_brand = Y` option row unless it's `exact`. Add it from the store's **past purchases** (GE: Reorder; Amazon/Whole Foods: Buy it again; Target: Buy it again); search by the exact product name only if it isn't listed. No Products row → search by the Item's brand_size/name and report it as a guess. Target: choose Drive Up. Set qty.
4. Out of stock or not found:
   - ok_swap `Y` → pick the closest equivalent, note it.
   - ok_swap `N` → skip.
   - blank → skip and ask.
   Each swap/miss → a Review row (type `swap` or `miss`). Leave the store's per-line substitution setting as it is.
5. Set filled rows to `carted`, `cart` = store code, `cart_at` = now. Clear `order_requested`. A product added that isn't in Products yet → add a Products row (`match` = `likely`, source `cart build <date>`).
6. Hand off: cart total (Giant Eagle has a $35 minimum), then a short list of swaps, misses and guesses. **Stop there. Never check out.**

**Refreshing Products from the store's purchase history** (monthly, or when the catalog grew): on Giant Eagle open Reorder and click Load More Results until everything shows (34 per page, slow: wait 3–4 s per click), then read name / size / "Purchased MM/DD" from the page text. javascript_tool output is cut at ~1,000 characters, so write a compact list into the page (`main.innerHTML = <pre>…`) and read it with get_page_text. For each product: add or update its Products row; a product that fits no catalog item becomes a new Item (family-level name, flavors and sizes share one item) with J:M formulas copied down. Ambiguous picks → `likely` + a Review card to a parent; never type a guess as `exact`.

**Other stores** (Nov 2): what each signed-in store gives when reading products in Chrome.
- **Whole Foods:** search `https://www.amazon.com/s?k=<words>&i=wholefoods`. Each result is a `[data-component-type="s-search-result"]` card with the ASIN in `data-asin`; the card text has the full name, size and price (the `h2` holds only the brand). `sku` = ASIN.
- **Target:** search `https://www.target.com/s?searchTerm=<words>`; results load late (scroll and wait ~3 s). The TCIN is the number in `/A-<number>` links. `sku` = TCIN.
- **Amazon:** Buy it again at `https://www.amazon.com/gp/buyagain` (product links carry `/dp/<ASIN>`).
- Don't put the page URL in javascript_tool output on Amazon: the extension blocks output with query-string data.
- **Carts, tested Nov 2 (add one line, see it, remove it; every cart left as it was):**
  - Whole Foods: **Add to cart** on the search card; a side cart opens on the right with the line, total and a 🗑 that removes it. Separate from the regular Amazon cart.
  - Amazon: Buy it again (`/gp/buyagain`) has **Add to cart** per product; the cart is `/gp/cart/view.html`, each line has **Delete**.
  - Target: product page `/p/-/A-<TCIN>`; wait ~6 s for it to finish loading (it shifts while loading, so clicks by coordinate can land on an ad), use element refs, pick **Pickup** (Upper St. Clair), then **Add to cart**. Cart at `/cart` (also loads slowly); each line has a **Remove … from cart** button. Cart price can be lower than the page price (a deal).
  - Giant Eagle: tested Nov 1 (§2 Test notes in the project roadmap): Reorder + cart page read cleanly.
- Rows from a search are `likely` with source `Chrome search <date>` or `price pass <date>`; a receipt or a parent's answer makes them `exact`.

**Prices** (api 23, Nov 2): Products `price` | `unit_price` | `unit` | `price_at` | `store_brand` (columns K:O).
- `price` = the shelf price the cart would charge today (a sale price gets "sale <date>" in notes). `unit_price` = price ÷ amount in `unit`, 4 decimals. `unit`: `oz` (weight; lb × 16), `fl oz` (liquids; gallon 128, half gallon 64, quart 32, pint 16, liter 33.8) or `ct` (eggs, cups in a multipack, bars, pouches). Same unit for one item at every store; amount unreadable → leave unit_price and unit blank (the app skips it). `price_at` = text `'yyyy-mm-dd`.
- `store_brand = Y` only on a store's own-brand **option** row (Giant Eagle / Market District; 365 by Whole Foods Market; Good & Gather, Market Pantry, up&up; Happy Belly, Amazon Basics, Presto!, Solimo), `match` = `alt`. The backend never treats it as what we buy unless a parent made it `exact`; the app shows it on the item screen as "Store brand at <store> … (N% less)".
- Who writes prices: every cart build and check (each product added or seen in the cart), and the **daily price pass** (§13). No weekly run (owner, Nov 2).
- The app compares only **like items**: `exact` / `likely` rows, never `alt` (a different product, e.g. organic vs regular, another brand), fresh prices (30 days), same unit. Keep one unit per item across stores (a 4.4 oz pack is `oz` everywhere, not `ct` at one store). A List tag, and the "cheaper at" note on ⚙ before Build the cart, show only when another store is **10%+ and $0.50+** cheaper for the same amount, never for store-only items or "either store" rows.

**Aisles and SKUs** (Giant Eagle): each product page (`/<store>/search/product/<UPC>`) shows "Aisle N <section>" for the selected store and the SKU (UPC). Write them to Products `aisle` and `sku`. Product links on search and Reorder pages carry the UPC.

---

## 3. Changing the app (front end)

1. Work in a clone of `mm-fam/family-food`. No build step; open `index.html` locally with a mock backend or test against a copy of the Sheet.
2. Test on a phone-sized viewport (390×844) with Playwright: unlock, add, kid request → approve, check off, meal add.
3. Commit with a clear message. Push when owner says go. GitHub Pages redeploys in ~1 minute.
4. **Bump the `?v=` tag** on `styles.css` and `app.js` in `index.html` (e.g. `?v=20261102c`, next letter for the same day) in every push that changes either file. GitHub Pages lets phones cache files for 10 minutes; a new tag makes the next load fetch them fresh (Nov 2: dark-mode fix didn't show on the owner's phone without it). index.html itself can still be up to 10 minutes stale; pull to refresh or reopen.

## 4. Changing the backend (Code.gs)

Deploys are automatic once the one-time setup below is done.

1. Edit `apps-script/Code.gs`; bump `API_VERSION` if the app needs the new behavior; commit.
2. Push to `main`. The **Deploy backend** GitHub Action (`.github/workflows/deploy-backend.yml`) pulls the live Apps Script project, replaces only `Code.gs` (manifest and other files untouched), pushes it, publishes a new version of the existing deployment (ID read from `config.js`, so the URL never changes), then checks `/exec?action=version` reports the new `API_VERSION`.
3. Push backend changes before (or with) app changes that depend on them; the app hides features the live `api` doesn't have.
4. If triggers changed, run `setup()` once by hand in the Apps Script editor.
5. If the Action fails: open Actions → Deploy backend → the failed run. "Missing secret" = setup not done; an auth error = the clasp login expired (redo setup step 3 and update `CLASPRC_JSON`); "no Code.gs" = the live project's file was renamed. Re-run with **Run workflow** once fixed.

**Manual fallback** (Action broken): paste `Code.gs` into Extensions → Apps Script → Code.gs → Save, then **Deploy → Manage deployments → pencil → Version: New version → Deploy**. Never "New deployment" (it changes the URL).

**One-time setup** (the repo owner, ~10 minutes):
1. https://script.google.com/home/usersettings → turn **Google Apps Script API** on.
2. Apps Script editor → Project Settings → copy the **Script ID**.
3. On a computer with Node: `npx @google/clasp@2.4.2 login`, approve in the browser, then copy the contents of `~/.clasprc.json`.
4. GitHub repo → Settings → Secrets and variables → Actions → New repository secret: `CLASPRC_JSON` (step 3) and `SCRIPT_ID` (step 2).
5. Actions → Deploy backend → Run workflow; it should end green with the live api version.

The `CLASPRC_JSON` login can manage the owner's Apps Script projects: keep it only in GitHub secrets, never in the repo or docs. Revoke it at https://myaccount.google.com/permissions ("clasp") if it ever leaks.

## 5. Schema change checklist (new tab or column)

1. Add columns at the **end** of a tab, never in the middle (the backend reads by header name, but formulas and the owner's eyes rely on order).
2. Update `Code.gs` (TABS, reads/writes), `app.js` if the app shows it, and `family-food-system.md`.
3. Back up first: File → Make a copy of the Sheet, named with the date.
4. Backend changes deploy on push (section 4); push them before or with app changes that depend on them.
5. Add a line to the roadmap decision log.

## 6. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| App says wrong passcode for everyone | Script Property changed or missing. Check Project Settings → Script Properties. |
| App loads but nothing saves | Backend error or stale deployment. Open Apps Script → Executions for the error. Redeploy as New version. |
| `passcode_not_set` | `FAMILY_PASSCODE` missing. |
| "Probably due" empty or odd | Items J:M formulas missing on new rows, or Receipts item_id not filled. |
| Items stats wrong | Someone typed over J:M. Re-copy formulas from a good row. |
| List getting long | Nightly trigger not installed. Run `setup()`. |
| Claude can't reach the backend | Expected from the workspace. Use Chrome, or the Deploy backend Action's version check. |
| Backend change didn't show up | Check Actions → Deploy backend. Red = see section 4, step 5. |
| Claude can't push | Claude GitHub app needs access to the `mm-fam` org (github.com/settings/installations). |

## 7. Backups and safety
- Google Sheets version history covers most mistakes (File → Version history).
- Before bulk edits (more than ~20 rows) or schema changes, make a dated copy.
- Rotate the passcode if a phone is lost: change the Script Property; everyone re-enters it.

## 8. Meal ideas → meals

**When:** the daily morning check, or when someone says an idea came in. Read Meal Ideas rows with status `new`.

1. Read the text (a recipe, a link, or just an idea). Pick a short meal name the family would say ("Tuscan chicken linguine").
2. If a meal with that name (or clearly the same dish) already exists, don't duplicate it: set the idea `done`, `meal_id` = that meal, notes "Already in Our meals".
3. **Idea from a parent:** add a Meals row (next free `mNN`): `item_ids` = only catalog items that clearly match an ingredient (prefer what the family already buys); `notes` = "From <who>'s idea <date>." + "Not in the catalog yet: …" for unmatched ingredients + the link if there was one. Never create Items from an idea; unmatched ingredients wait for receipts or a parent. Then set the idea `done` and `meal_id`.
4. **Idea from a kid:** add one Ask card to the parents: `<who> suggested <name>. Add it to Our meals? (xNNN) Options: Yes; No`. Set the idea `asked`. On Yes, do step 3; on No, set it `declined` with notes "A parent said not now".
5. For every new meal, add one dinner-vote card per family member: `Dinner vote: how do you feel about <name>? (mNN) Options: 😍; 🙂; 😐; 👎` (`type` vote, `audience` = the person). Votes feed the meal's tags.
6. Unreadable or not a dinner: set `declined` with a short reason in notes (it shows in the app).

**Report:** "Meal ideas: N added (names), N waiting for a parent."

## 9. Hearth meal plan

Design and the full steps: `docs/hearth.md`.

- **Hearth → Poppy** (a screenshot of the Hearth Meal Plan): read every day × Breakfast / Lunch / Snack / Dinner cell; match to Meals or add new ones (kind = the row; link only catalog items the name clearly names; never complete cut-off names or create Items); write Plan rows with slot (and note `Leftovers` for leftover cells). Hearth wins for that date + slot. Back up first above ~20 rows.
- **Poppy → Hearth:** Meals → THIS WEEK → **→ Hearth** → week → Copy → paste into Hearth Helper → approve its preview.

## 10. Family feedback and automatic cards (api 9)

**When:** the daily morning check.
1. **App Feedback** rows with status `new`: quote each (who, tab, text) in the report to the owner, then set `seen`. Don't change the app from them without the owner's go-ahead. (Since api 29 the backend also emails the owner the moment an idea arrives; a row whose notes say `alert not sent: …` means email isn't authorized yet: say so in the report.)
2. **Still eating? = No** (answered `still` rows): add one card to the parents: `<who> isn't eating <item> anymore. Stop buying it? (iNNN) Options: Yes; No, others eat it` (type `preference`, audience `parents`), then close the `still` row. A parent's Yes to "Stop buying it?": append "Parent says stop (<date>)" to the item's notes and report it to the owner; a parent sets Drop in the app (item screen → Details → How often → Stop buying). Never change Items from a kid's answer alone.
3. **How was it?** (`rate`) answers need nothing: they count as votes in meal tags (they're read like `vote` rows; never edit their answers).
4. **Meal requests** (`meal_request`) are handled by parents in the app. Report any open longer than 3 days.

## 11. Q&A loop: account, follow up, recycle, refill (daily, api 10)

**When:** the daily morning check, step B (replaces the old "fold in clear cases" step). Runs in this order. Question ideas come from `docs/question-bank.md`. People: the parents and kids in Settings. "Deck" = a person's open Review rows (audience = their name; for parents also `parents` and `all`; blank = parents). `meal_request` rows never count.

**B1. Account for every answered row.** Nothing stays `answered` past one morning, except `vote` and `rate` rows (the app reads them for meal tags: never edit, close or write `outcome` on them) and `meal_request` rows (parents handle them in the app). For every other answered row, apply it, set status `closed`, and write where it went in **`outcome`** (short: `Items i005 notes`, `Profile`, `Meals m41`, `Follow-up r140`, `skip`, `No signal`). **Missions (`check`) are already applied by the backend** (Stock row, and a List row when low or out): just close them with outcome `Stock`; never log Stock or add List rows for them again, and don't create `check` cards yourself (the backend makes them daily). **"Did we get it?" (`settle`, `settle_order`, api 17) are already applied by the backend** (the List row set bought / have / skipped or kept, a Stock sighting; a "Yes, all of it" order card marks that store's carted rows bought; "Some of it" makes one `settle` card per row): close them with outcome `List` (same for `settle_meal`, api 19: "<meal> isn't on the plan anymore" → rows skipped or their meal link cleared). A typed answer ("Something else") isn't applied: read it, change the List row by hand if it's clear, otherwise a follow-up card; outcome `List L00042` or `Follow-up rNNN`. Don't make `settle` cards yourself (the backend makes them daily). Kitchen help (`helped`) answers → Profile topic `kitchen help`, outcome `Kitchen help`. Never edit `answered_at`, `points`, `points_to` or `points_why`.

| Answer | Where it goes |
|---|---|
| `skip (<name>)` / "Don't care" | Nothing. outcome `skip`. Not re-asked for 90 days. |
| Profile (habits, favorites, spice, won't-eats, toppings) | One **Profile** row: person, topic, answer (their words, trimmed), review_id, at. |
| Household or schedule facts (who orders, order days, how many nights we cook, what goes to waste) | Profile row with topic `household: <topic>`. Schedule answers also feed the schedule design (live session). |
| Item preference from a parent (`(iNNN)`) | Items: `ok_swap` for swap questions (conditional answers → notes + a follow-up, not Y/N); store/group only when the answer says it plainly; everything else appended to notes as `<answer> (<name>, <date>)`. Never set Drop. |
| Item preference from a kid | Append `<Name>: <answer>` to that item's notes. Nothing else changes. |
| Shelf life | Items `shelf_days` = the upper end of the answer in days ("2–3 days" → 3, "About a week" → 7); also a notes line `Shelf life: <answer> (<name>)`. "Once opened" answers stay notes only (no open date to count from). "We freeze it right away" → leave `shelf_days` blank (frozen keeps), note only. A kid's answer → notes only, plus a card to a parent. |
| Tossed it (`waste`) | Buy fewer / Buy less often → append "Tossed often: <answer> (<name>, <date>)" to Items notes and report it to owner; It's fine → outcome `No signal`. Never change qty or status yourself. |
| A dinner someone wishes we made | Already in Meals → append "<Name> wishes we made it more often (<date>)" to its notes. New → a parent's wish becomes a Meals row per §8 step 3 (+ vote cards, §8 step 5); a kid's wish becomes the parents' "Add it to Our meals?" card (§8 step 4). |
| An item request inside an answer ("can we add coffee beans") | A follow-up card to the same person for the missing detail (brand, size, store). A parent's clear answer later → new Item per §1 step 4 (status Sometimes). |
| Unclear or misspelled free text | A follow-up card to the same person that offers the likely readings as options. Never write a guess as fact. |
| "Idk" / no real answer | outcome `No signal`. Not re-asked for 90 days. |
| Still eating? | Per §10. |
| Try instead (`try`, api 29) | **Try it next order** → add a List row for the item if none is active (status `needed`, added_by the parent, store = the alternative's store, note `Try: <product> (<store>)`), or add that note to the active row; append "Trying <product> at <store> (<name>, <date>)" to Items notes; outcome `List Lnnnnn`. Cart building (§2) buys the `Try:` product for that row instead of our usual one. A week after it's bought, one parents' card: `We tried <product> instead of <our product>. Keep it? (iNNN) Options: Switch to it; Back to ours; Keep both` (type `try`): Switch → its Products row `exact`, ours `alt`; Back to ours → its row notes `declined <date>`; Keep both → its row `likely`. **Not this one** → that Products row notes `declined <date>` (never offered again); outcome `Products iNNN`. **Stop suggesting** → Items `open_to_try` blank; outcome `Items iNNN`. |
| Meat to buy (make more, api 35) | "How much meat should go on the List next time? (mNN)" to Mom: **2 packs** / **3 packs** → set that meal's Meals `meat_qty` to 2 / 3 (add the column at the end of Meals if missing); **Keep it at 1** → leave `meat_qty` blank and append "Meat: keep at 1 (<name>, <date>)" to the meal's notes; outcome `Meals mNN`. |
| Store brand (`storebrand`) | **Switch to store brand** → that store's store-brand Products row becomes `exact` (keep `store_brand = Y`), the product we bought there becomes `alt`; append "Store brand OK at <store> (<name>, <date>)" to Items notes; outcome `Products iNNN`. **Keep ours** → append "Keep our brand at <store> (<name>, <date>)" to notes; outcome `Items iNNN notes`. Never change another store's rows. |

**B2. Follow-ups.** Up to 3 per person per day, from answers in the last day: the next useful question an answer opens up (a favorite → which product; a "No" on finishing something → a smaller size; a conditional swap → which swaps). End the detail with `(rNNN)` of the answer it follows (the app hides it) and also any `(iNNN)` / `(mNN)` it's about. Write `Follow-up rNNN` in the source row's outcome.

**B3. Recycle.** `later_count` / `later_at` are written by the app when someone taps **Later** (api 10); the person picks when it comes back (2 hours, after school, tonight, tomorrow; kept on their phone), then it sits at the back of its section, oldest Later first.
- `later_count` ≥ 3 → status `closed`, outcome `Later ×3, retired`. If a parent decision is waiting on it (clarify, swap, receipt code, stop buying), pass it once to the other parent instead (audience = the other parent, passed_by `Poppy`, clear `later_count` / `later_at`).
- Open cards created more than 21 days ago → `closed`, outcome `expired`, except `vote` cards (votes keep).
- Someone who hasn't answered anything in 7 days (or ever, once their deck is full) gets **no new cards**. Their deck waits as it is.

**B4. Refill.** Target **12–15 open cards** per parent and **18–22 per kid** (the girls get more chances to score; owner, Nov 2). For a parent below 12 who answered something in the last 7 days, add up to **8 new cards a day** (follow-ups count) to reach 15; for a kid below 18, up to **10 a day** to reach 22. Whoever is behind this week (Mon–Sun points, `state.points.week`) gets her refill first and the most fun cards (votes, favorites). Order of preference:
1. Follow-ups from B2.
2. Data-driven: vote cards for meals that person hasn't voted on (dinners first; api 35: the app holds a vote on a meal planned from today on until the morning after it's eaten, then asks "You had <meal> yesterday. How was it?", and the backend makes no How was it? card for someone with an open vote on that meal, so a vote on a planned meal is fine and never doubles up), cut-off meal names and unlinked ingredients (to the parent who plans meals), receipt clarifies, shelf life for perishables with none yet, "Still eating?" No → parents.
   **Store-brand cards** (api 23; owner, Nov 2: lean toward store brands, ask item by item): to the parents, up to 2 new a day. Pick items with a fresh (`price_at` within 30 days) `store_brand = Y` Products row whose `unit_price` is 10%+ below the product we buy at that store **and** $0.50+ less for the same amount; skip items with ok_swap `N`, items whose notes say "Keep our brand at <store>", and items asked in the last 180 days. Card: `Store brand: <store-brand product> is <pct>% less than our <our product> at <store> (<unit price> vs <unit price>). Switch? (iNNN) Options: Switch to store brand; Keep ours` (type `storebrand`, audience `parents`; lands in ⚖ Decisions).
   **Try-instead cards** (api 29): to the parents, up to 2 new a day, for items with `open_to_try = Y` that have `try option` Products rows not yet asked and not `declined`. One card per alternative, cheapest-per-unit first: `Try instead of our <our product>: <alternative> at <store>, $<price> (<unit price> vs <unit price> ours). (iNNN) Options: Try it next order; Not this one; Stop suggesting` (type `try`, audience `parents`; lands in ⚖ Decisions). Mark the Products row notes `asked rNNN`.
3. The question bank (`docs/question-bank.md`), mixed so it never reads like a form.

Rules: one Review row per person (one row = one answer); next free `rNNN`; `created` = today; type `clarify` / `preference` / `profile` / `vote`; quick picks as `Options: …` per the card guide (Yes/No when a yes answers it; 1–3 word labels; likely answer first). Never send a person the same question twice unless 90+ days old and the topic can change (seasonal, favorites). Kids get kid-sized cards: votes, favorites, their own lunch and snack items; nothing that changes what's bought.

**Report** (one line): `Q&A: N folded, N follow-ups, refilled <name> +N, …; <name> untouched N days; N retired.`

## 12. Cart check (sync the online cart to the List)

**When:** before an order goes in (e.g. the evening before Giant Eagle order day), after cart building, or when a parent asks "what's in the cart?". Same needs as §2 (owner's computer, Chrome, store signed in). **Read-only on the store side: never add, remove or change anything in the cart during a check.**

1. Open the store's cart page (Giant Eagle: `/cart`) and read it as text: product name, size, qty per line.
2. Match each line to Products (store + exact product name) → item_id. No match → add a Products row (`likely`) to the closest item, or a Review `clarify` card if none fits.
3. Sync the List:
   - A matched item with an active List row (`needed`) → `carted`, `cart` = store, `cart_at` = now (qty from the cart if it differs; note it).
   - A cart line with no List row → add one: status `carted`, `cart` = store, added_by `Cart`, note "Added on the store site".
   - Except: a cart line whose item has a List row with `cart_want` = `out` (or moving away) is waiting to come out; leave it for the build job, don't add a row.
   - And: a List row with `cart_want` = this same store is a qty change waiting for the build (api 34); keep the row's qty, don't copy the cart's.
   - A List row `carted` for that store whose item is no longer in the cart → back to `needed`, clear `cart` / `cart_at`.
4. Receipts still close the loop: when the order's receipt is ingested (§1), `carted` rows become `bought`.

**Report:** "<store> cart: N lines, N matched, N added to the List, N back to needed, $total."

**Heartbeat (api 27):** every cart-runner run first sets Settings `runner_seen` (text 'yyyy-MM-ddTHH:mm:ss). The Carts screen says "Cart helper checked in at …" (green) or "hasn't checked in since …" (red, after 75 minutes during 8 am–9 pm).

**Totals (api 26):** every finished build or check writes Cart Jobs `subtotal` (the cart's item total after sale savings, before tax, fees and tip, as the store's cart page shows it; 0 if empty) and `lines` (the store's item count). The app's Carts screen shows these as each cart's $ and the sum across carts, so they must match the site at that moment.

## 13. Cart runner: phones start cart jobs, the owner's computer runs them (api 12)

**Cart watcher (api 24, Nov 2): the build starts within a minute.** A Claude scheduled task that needs the owner's computer can only repeat hourly and has no "start now" link, so tapping Build the cart could wait up to an hour (and not at all after 9 pm). Instead, Windows Task Scheduler on the owner's PC runs `runner/run-hidden.vbs` → `runner/poppy-watch.ps1` every minute. It calls `cartJobsOpen` (read-only; no Claude, no cost). Only when a job is `queued` (or `waiting`, every 15 min, or a `running` job is stuck, or the day's price pass is due from 9 am) and Chrome is open does it start Claude Code: `claude -p --chrome` with `runner/cart-runner-prompt.md` (Sheet ID filled in from the local `runner/poppy-runner.json`, git-ignored). That run does **every** open job, then the price pass if due. **Every build ends with a reconcile pass** (re-read the cart, sync the List line for line, re-add or set back to needed anything missing), so what Poppy shows matches the real cart. Fridays from 6 pm the watcher queues the Giant Eagle check. One run at a time (`runner.lock`); logs in `runner/logs/`. The hourly scheduled task stays off once the watcher is proven.

Setup (once): install Claude Code on the PC and sign in with the family's Claude account; in a terminal run `claude --chrome` once and confirm it sees Chrome and the Google Sheets connector; clone the repo; copy `runner/poppy-runner.example.json` to `runner/poppy-runner.json` and fill it in; register the task: `schtasks /Create /TN "Poppy Cart Watcher" /SC MINUTE /MO 1 /TR "wscript.exe \"<repo>\runner\run-hidden.vbs\"" /F`.


**Why:** building or checking a cart needs Chrome signed in to the store (a person signs in; Claude never does), and that Chrome lives on the owner's desktop. Phones can't run it. So a parent queues the job on a phone and a scheduled Claude task on the owner's computer picks it up.

**Phone side:** ⚙ → a store → **Build the cart** or **Check the cart** → `cartJob` → a `queued` row in **Cart Jobs**. The app shows the status line and, on the List, a one-line heads-up.

**Runner:** scheduled task "Poppy Cart Runner", set to require the owner's computer (so it has Chrome), hourly from 8 am to 9 pm Eastern. Each run:
1. Read Cart Jobs. Also turn a non-blank Settings `order_requested` (older app) into a `build` job (by = whoever it names) and clear it. A job `running` for more than 2 hours → `failed`, result "Stopped partway; nothing was checked out".
2. **Friday rule:** on Fridays from 6 pm, if no Giant Eagle `check` job was queued or run today, add one (by `Cart runner`). The Saturday order then starts from an up-to-date cart.
3. Nothing `queued` or `waiting` → do the daily price pass if it's due (below), else stop. No push, no other work.
4. Take the oldest open job. Check Chrome (`tabs_context`). Not reachable → `waiting`, result "the owner's computer or Chrome was off" (count attempts in notes); after 12 hours of waiting → `failed`. Stop.
5. Set `running`, `started_at`. Open the store; if it isn't signed in → `failed`, result "<store> isn't signed in on the owner's computer". Stop.
6. `build` → §2; `check` → §12. One job per run, so a run never takes all afternoon.
7. Set `done`, `finished_at`, and a short `result`: build "18 items, $142.10, 2 swaps, 1 missing"; check "12 lines, 10 on the List, 2 added, $96.40". Push the same line to the owner.
8. Close the tabs it opened.
9. **Daily price pass** (api 23; the one daily price job, owner Nov 2): once a day, on the first run that reaches Chrome (Settings `prices_through` blank or before today), after any job: for each signed-in store, current prices for up to 40 items (List rows first, then Always, then Sometimes; oldest `price_at` first), plus the store's own-brand equivalent as a `store_brand = Y` row (§2 Prices). GE/WF also look up List grocery items with no row at that store yet (a confident same-product match → a new `likely` row; unsure → skipped). **Best-price items first** (api 40, owner Nov 4): every Item with `best_price = Y` is looked up at **all four stores** each day, the same product only (same brand, kind and size, e.g. Starbucks Espresso Roast whole bean 12 oz; a different size of it is OK when the unit price can be read), new rows `likely`, source `price pass <date>`; a sale price → price = the sale price and notes `sale <date>` (or `sale until <date>`). These don't count toward the 40. The backend then makes the parents' ⚖ `bestprice` card when one of them is on the List and another store clears 10% and $0.50. Read search pages in bulk. Never touch a cart. **Pack sizes** (api 35, owner Nov 3): while on a product page, if the product name doesn't say how many come in one package (no "8 Count", "8 Cups", "Pack of 12", "14 each"), write the count to Products `pack` as `<n> ct` (e.g. `8 ct`); leave it blank for things sold by weight or volume. Set Settings `prices_through` = today when done (about 25 minutes at most). Report line: "💲 Prices: GE 40, WF 22, Target 18, Amazon 6 (+5 store-brand options)".
   **Alternatives to try** (api 29, owner Nov 2: "suggest good alternatives… agnostic across the stores"): after the prices, for up to **5 items with Items `open_to_try = Y`** (a parent set it: "we'd try something else"; oldest last look first, Items notes `Alternatives looked <date>`), find **2–3 real alternatives** at the item's usual store and the other signed-in stores that carry that kind of thing: other brands of the same thing first (e.g. other peanut-butter snack cups), then a store brand. Same kind of product, similar size, a kid-safe swap; never a product whose Products row notes say `declined`. Write each as a Products row: `match` = `alt`, source `try <date>`, notes `try option`, with sku, size, price, unit_price (same unit as ours) and price_at. Then append `Alternatives looked <date>` to the item's notes. Never add one to a cart. Report line: "🔄 Alternatives: Jif To Go cups 3 (GE 2, Target 1)". Items with ok_swap `N` are skipped unless `open_to_try = Y` (the flag is the parent's explicit say-so).

10. **Daily Giant Eagle order history** (Nov 2; keeps "Probably due", "Not lately" and Use soon current without emailed receipts): once a day, on the first run that reaches Chrome (Settings `ge_orders_through` blank or before today), after any job, before the price pass. Read-only; never touch the cart.
   a. Open `gianteagle.com/account/orders` in a new tab (signed in → "Previous Orders" list). Hook `window.fetch` (keep requests to `core.shop.gianteagle.com` with body and headers), click **View More**, and take the captured `PaginatedOrders` request. Replay it (new `x-hl-request-id` each time; set the count variable to 50, the cursor variable to `pageInfo.endCursor`) until you reach orders older than the newest GE date in Receipts. Each node has `code`, `placedOn` and `fulfillments[0].status` / `timeSlot`.
   b. New orders = status Complete and not yet in Receipts: no row with order_ref `GE <code>`, and no GE row on that order's date (an emailed receipt already logged it). Cancelled or in-progress orders are skipped.
   c. For each new order, get its lines: click an order in the list (the app navigates in-page) to capture the `OrderQuery` request (variables `{code}`), then replay it per code. Lines are `order.fulfillments[].deliverables[].items[]`: `name`, `qty`, `price` (per unit), `product.sku`; if `substitutionProduct` is set, that is what came (use its name and sku). Skip qty 0. Date = `fulfillments[].fulfillmentDate` (else `placedOn`), yyyy-mm-dd. javascript_tool output is cut at ~1,000 characters: write `date|code|sku|qty|price|name` lines into the page (`main.innerHTML = <pre>…`) and read them with get_page_text.
   d. Append one Receipts row per line: date, `GE`, `GE <code>`, raw = the product name, item_id = the Products row whose `sku` matches (GE rows; `exact` before `likely`), else the Products row whose product name matches exactly, else blank; qty; price as `$0.00`; match `GE site`, or `GE site (no item yet)` when blank (see "Growing the catalog" below).
   **Growing the catalog (owner, Nov 2):** Shop shows *items* (a family like "Chobani yogurt cups"); Products holds the exact store products under each item. A `GE site (no item yet)` product bought **once** stays as is (one-offs don't clutter Shop). When the same product (same sku) shows up **a second time**, the morning check gives it a home: an obvious flavor/size/brand variant of an existing item → a Products row on that item (`likely` if bought in the last 12 months, else `alt`; source `GE order history <date>`; notes "Bought N×; last <date>"; sku as text) and back-fill `item_id` on its Receipts rows; a clearly new kind of thing → a new Item (status `Sometimes`, notes "From GE order history (<date>)", J:M formulas copied down, K:L formatted yyyy-mm-dd) plus its Products row; unsure → a clarify card to parent. Items whose newest buy is over a year old get a "Still buying …?" card to parent instead of being assumed current.
   e. Then, as receipt ingest step 5: List rows `carted` with `cart` = GE and `cart_at` before the order's date whose item is in the order → `bought`, updated_at now, note "Giant Eagle order <date>". Leave `needed` rows alone (Did we get it? cards settle those).
   f. Set Settings `ge_orders_through` = today as text 'yyyy-mm-dd (add the row if missing). Report line only when something was added: "🧾 Giant Eagle order Nov 8: 41 lines (38 matched), 12 List rows bought".
11. **Daily Whole Foods + Amazon order history** (Nov 4; replaces emailed receipts). Once a day, after step 10, when Settings `amz_orders_through` is blank or before today and Amazon is signed in. Read-only. WF and regular Amazon orders live in the same household Amazon account (the one the WF cart is in).
   a. **Which orders:** Your Orders for this year (`/your-orders/orders?timeFilter=year-YYYY&startIndex=N`), newest first, until orders are older than 7 days before the newest WF/AMZ Receipts date. **The order list is encrypted in the page ("Siege"):** fetch the page HTML, put its body in a hidden `div` in an orders tab, and `eval` the inline `SiegeClientSideDecryption.decrypt…` scripts; after ~1.2 s the `.order-card` text gives date, total, order number and status. (Iframes and new-tab navigation broke this loop.)
   b. **Skip** cancelled orders, orders already in Receipts (order_ref `WF <first 11 of order #>` / `AMZ <order #>`), and orders not yet delivered or picked up (they're read on a later day, so substitutions land correctly).
   c. **Whole Foods lines** (every line; WF is groceries): in-store (`Purchased at Whole Foods`): `/gp/your-account/order-details?orderID=…` → plain HTML lines `Name $total Qty: N @ $unit each` / `Qty: 0.4 lb @ $x/lb`. Delivery: `/gp/css/summary/print.html?orderID=…` in a same-origin iframe, `innerText` after "Items in your order", lines `name ⇥ qty ⇥ weight ⇥ $total`; a "Replacement for: …" line means the replacement is what came. Receipts row per line: date (delivery/purchase date), `WF`, `WF <first 11 of order #>`, raw = product name, item_id = WF Products row with that exact product name (`exact` before `likely`), else blank; qty (weight items: 1); price = unit price `$0.00`; match `WF site`, or `WF site (no item yet)`. Unmatched products follow step 10's **Growing the catalog** rule (a second purchase gets a home; one-offs stay as they are).
   d. **Regular Amazon lines: add-only rule.** The account also carries personal shopping (gifts, clothes, personal things). Take ONLY lines that match an existing Poppy item (an AMZ Products product name, or an Item name/alias the product clearly is). Skip everything else silently: no Receipts row, no new item, no Review card, no note. Matched → Receipts row (`AMZ`, `AMZ <order #>`, match `AMZ site`).
   e. As step 10 e: List rows `carted` at WF/AMZ (or WF `needed` rows for a WF order) whose item is in the order → `bought`, updated_at now, note "Whole Foods order <date>" / "Amazon order <date>" (a placed order already counts as bought; rows already `bought` are left alone).
   f. Set Settings `amz_orders_through` = today as text 'yyyy-mm-dd (add the row if missing). Report line only when something was added: "🧾 Whole Foods Nov 6: 18 lines (16 matched) · Amazon: 2 household lines".
   Writing many rows: one pipe-delimited string per row into a scratch tab, split with `=ARRAYFORMULA(SPLIT(A1:A,"|",TRUE,FALSE))`, copyPaste PASTE_VALUES into Receipts, delete the scratch tab, then format the date column yyyy-mm-dd. javascript_tool output is cut at ~1,000 characters: write lines into a `<pre>` and read them with get_page_text.
12. **Daily Target order history** (Nov 4). Once a day, after step 11, when Settings `tgt_orders_through` is blank or before today and Target is signed in. Read-only.
   a. Open `target.com/orders` (online orders: Drive Up, Pickup, shipped) and `target.com/orders?type=instore` (in-store receipts on the account). Hook `window.fetch` before the list loads to capture the order-history and order-details API requests the page makes (Target's own `api.target.com/...order...` calls) and replay them, or read the order detail pages as text. **First run:** write what worked (request names, fields) into this step so later runs are quicker.
   b. New orders = completed / picked up / delivered, not yet in Receipts (order_ref `TGT <order number>`; in-store: `TGT <receipt number>`).
   c. Lines: household, paper, cleaning, personal care and food lines → Receipts (`TGT`, order_ref, raw = product name, item_id = TGT Products row by TCIN or exact name, else blank, qty, unit price, match `TGT site` / `TGT site (no item yet)`; Growing the catalog rule as step 10). Skip clothing, toys, gifts, seasonal decor and electronics silently.
   d. List rows carted (or needed) at TGT whose item is in the order → `bought`, note "Target order <date>".
   e. Set Settings `tgt_orders_through` = today. Report line only when something was added: "🧾 Target Nov 5: 7 lines (6 matched)".

**Rules:** never check out, enter payment or change account settings; never sign in; never touch a cart that holds an order the family is in the middle of placing (ask in the push instead). Reports go only to the owner by push; the family sees the status in the app.


## Siri Shortcut: "Add to Poppy" (api 41)
One shortcut per phone, in the Shortcuts app. Siri asks "What do we need?" and reads back what was added.
1. Shortcuts → **+** → name it **Add to Poppy**.
2. **Ask for Input** (Text), prompt "What do we need?".
3. **URL Encode** the input, then **Get Contents of URL** with Method **GET**: `<API_URL>?action=voiceAdd&by=<person, exactly as in Settings>&pass=<family passcode>&text=<URL-encoded input>` (POST + JSON body failed from Shortcuts). First run: tap **Always Allow** for the Google addresses.
4. **Get Dictionary Value**: key `say` from *Contents of URL*.
5. **Speak Text**: *Dictionary Value*. (Unsure matches come back as "Which sugar? I put a question in your Inbox."; see `voiceAdd` in docs/system.md.)
Say "Hey Siri, Add to Poppy", then "milk, eggs and two avocados". An error comes back as `{ok:false, error}` and Siri says nothing; run the shortcut by hand to see it.


## Stores ready: sign-in check (api 42)
- **Owner's morning routine:** wake the cart computer and open Chrome. Within a minute the watcher starts the day's sign-in check (from 6 am). In the app, Carts shows four dots; red = signed out. Sign in on that site in the computer's Chrome, then tap **Check sign-ins**.
- Runner step 3b (`runner/cart-runner-prompt.md`): look-only visits to gianteagle.com, amazon.com (covers Whole Foods and Amazon) and target.com; never signs in. Writes Settings `stores_ok` + `stores_checked`; the job's result is "All 4 stores signed in" or "Signed out: …".


## Builder guardrails (Nov 4)
- One session changes code at a time: Settings `dev_lock` ("<session link> | <what> | <time>"); rules in `CLAUDE.md`.
- `node --test tests/*.test.js` runs the backend smoke tests: the real `apps-script/Code.gs` on an in-memory Sheet (`tests/gas-shim.js`) with a made-up household (`tests/fixture.js`). Deploy backend runs them first and stops on a failure (the live backend keeps the last good version); the Checks workflow runs them on every push.
- Add a test for each new backend action. Keep fixture names made up (the repo is public).


## 14. Catalog house style + weekly tidy (api 45, Nov 4)
**An item is what the family asks for; Products holds the exact store products under it.**
- **Name** the way the family would say it, specific enough to pick the right thing: brand + kind when we always buy one brand ("Starbucks Espresso Roast whole beans", "Fairlife whole milk"); the kind alone when we buy several brands side by side ("Lettuce", "Granola bars (assorted)"). Never just the store's category ("Coffee beans") when one product is what we buy. No receipt abbreviations.
- **Words we say** (lowercase aliases): what people type or tell Siri ("milk", "ribeye", "pb cups"). ALL-CAPS aliases are receipt codes; leave them. Siri's `voice` cards add these automatically when answered.
- **Brand / size**: the usual pack ("52 fl oz", "12 ct"). Facts only, from Products or a parent.
- **Aisle** (group): never `Other` once known. **Store**: where we usually get it; `Either` only for GE/WF groceries.
- **Sold by** (`sold_by`): `lb` when the store prices it by weight (deli counter, butcher / meat counter, loose produce priced per lb: Products size "by the lb" / "by weight"). The List qty is then pounds (½ lb steps) and the trip note carries the cut and thickness ("ribeye, 1½ in thick, 2 steaks"). "(avg.)" sizes (GE packs priced each) stay each.
- Meat comes from both Whole Foods and Giant Eagle (owner, Nov 4), so steaks and roasts are `Either` + `lb` items (e.g. Ribeye steak), with the cut and thickness in the List note.
- **Adding a new item** (app): a parent's "Add … as something new" opens the item with Details so brand/size, aisle, store, sold by and words we say get filled while it's fresh. Kids' adds are requests; the parent tidies on approval.
- **Cart builds** (§2): a `sold_by = lb` row's qty is pounds: pick the store's weight option closest to it (WF meat/deli counter: the lb quantity; GE deli: the ½ lb / 1 lb choice; GE meat sold in priced packs: the pack whose weight is closest to the pounds asked, never more than ~25% over without a note saying so) and put the note in the store's special-instructions box if it has one. Never guess a cut that isn't in the note.
**Weekly tidy (morning check, Sundays):** up to 5 cards to the owner, most-bought items first: (1) a vague name whose item has one product we actually buy → "Rename '<name>' to '<brand + kind>'? (iNNN) Options: Yes; Keep it; Something else (type it)"; (2) group `Other` → "Which aisle is <name>? (iNNN) Options: <groups>"; (3) meat, seafood or deli items with no `sold_by` and a by-weight product → "How is <name> sold? (iNNN) Options: By the pound; Each / package". Facts that need no question are filled directly: brand_size from the one exact Products row's size when blank. Answers are applied in B1 (rename → Items name; aisle → group; By the pound → sold_by `lb`).
