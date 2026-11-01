# Poppy 2.0 runbooks

Step-by-step procedures. Read `family-food-system.md` first for the schema.

---

## 1. Receipt ingest

**When:** daily scheduled task (once set up), or when Mike says "receipts came in".

**Find the emails (Gmail).** Run these in parallel; one broad query misses things.
- Giant Eagle itemized: subject `"Your Digital Receipt from"`. Senders seen: `receipts@info.gianteagle.com`, `curbside@info.gianteagle.com`. Order *confirmation* emails usually have only an estimated total. Skip those and wait for the digital receipt.
- Whole Foods: come from **Amazon**, not Whole Foods. Search Amazon order/receipt emails mentioning Whole Foods.
- Forwards from Mom: `from:<Mom's address> newer_than:2d (Fwd OR receipt OR order)`.
- Target: order emails from `orders@oe.target.com` / `orders@oe1.target.com` (Drive Up and shipped). In-store and app receipts don't email; a parent can share the Target app receipt (PDF/screenshot). order_ref = `TGT <receipt barcode number>`.
- Dedupe on `order_ref`: if Receipts already has that order_ref, skip the whole email.

**Write it.**
1. Append one Receipts row per line: date (order date, ISO), store (GE/WF), order_ref, raw (exact receipt text), qty, price.
2. Match `raw` against Items.aliases (case-insensitive, exact token match first, then close match). Set `item_id` and `match` = `alias` / `fuzzy` / `none`.
3. On a fuzzy match you're confident in, append the raw text to that item's aliases.
4. No match: if obviously a new product, create the Item (next free id, store, group, brand_size, status `Sometimes`, J:M formulas copied down) and set `match=new`. If unclear, leave item_id blank and file Review: type `unknown_code`, detail `"<raw>" on <store> <date>. What is it?`.
5. For each matched item, set active List rows (`needed`/`carted`) with that item_id and same store (or Either, for GE/WF only) to `bought`, `updated_at` now.
6. Process answered Review rows: apply the answer (rename, alias, merge, drop), back-fill item_id on the matching Receipts rows, set Review status to `closed`.

7. **New food items** from a receipt (match `new`, not Personal care / Household / Paper & cleaning): add up to 3 per receipt as "How was it?" cards, one per person: `We got <name>. How was it? (iNNN) Options: 😍; 🙂; 😐; 👎` (type `rate`, audience = that person, status `open`). Answers show on the item screen under What we know.

**Report:** "<store> <date>: N lines, N matched, N new items, N questions, N list items cleared." Nothing else unless something broke.

---

## 2. Cart building

**When:** `Settings.order_requested` is set (e.g. `GE` or `WF`) or Mom/Mike asks. Start with one store and get it reliable before doing both.

1. Load the Chrome tools; check Mike's tabs; open a new tab. Confirm the store site is signed in. If not, stop and ask. Never enter credentials.
2. Rows to fill: List rows with status `needed`, store = that store, plus `Either` for GE/WF (never for Target). Skip `requested` (unapproved).
3. For each row: search by the Item's brand_size/name; prefer the exact past product (Amazon "Buy it again" / Giant Eagle past purchases are good shortcuts). Target: choose Drive Up. Set qty.
4. Out of stock or not found:
   - ok_swap `Y` → pick the closest equivalent, note it.
   - ok_swap `N` → skip.
   - blank → skip and ask.
   Each swap/miss → a Review row (type `swap` or `miss`).
5. Set filled rows to `carted`. Clear `order_requested`.
6. Hand off: cart total, then a short list of swaps, misses and guesses. **Stop there. Never check out.**

---

## 3. Changing the app (front end)

1. Work in a clone of `mm-fam/family-food`. No build step; open `index.html` locally with a mock backend or test against a copy of the Sheet.
2. Test on a phone-sized viewport (390×844) with Playwright: unlock, add, kid request → approve, check off, meal add.
3. Commit with a clear message. Push when Mike says go. GitHub Pages redeploys in ~1 minute.
4. Phones cache the PWA. If a change doesn't show, pull to refresh or reopen from the home screen.

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

1. Add columns at the **end** of a tab, never in the middle (the backend reads by header name, but formulas and Mike's eyes rely on order).
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
1. **App Feedback** rows with status `new`: quote each (who, tab, text) in the report to the owner, then set `seen`. Don't change the app from them without the owner's go-ahead.
2. **Still eating? = No** (answered `still` rows): add one card to the parents: `<who> isn't eating <item> anymore. Stop buying it? (iNNN) Options: Yes; No, others eat it` (type `preference`, audience `parents`), then close the `still` row. A parent's Yes to "Stop buying it?": append "Parent says stop (<date>)" to the item's notes and report it to the owner; a parent sets Drop in the app (item screen → Details → How often → Stop buying). Never change Items from a kid's answer alone.
3. **How was it?** (`rate`) answers need nothing: they count as votes in meal tags (they're read like `vote` rows; never edit their answers).
4. **Meal requests** (`meal_request`) are handled by parents in the app. Report any open longer than 3 days.

## 11. Q&A loop: account, follow up, recycle, refill (daily, api 10)

**When:** the daily morning check, step B (replaces the old "fold in clear cases" step). Runs in this order. Question ideas come from `docs/question-bank.md`. People: the parents and kids in Settings. "Deck" = a person's open Review rows (audience = their name; for parents also `parents` and `all`; blank = parents). `meal_request` rows never count.

**B1. Account for every answered row.** Nothing stays `answered` past one morning, except `vote` and `rate` rows (the app reads them for meal tags: never edit, close or write `outcome` on them) and `meal_request` rows (parents handle them in the app). For every other answered row, apply it, set status `closed`, and write where it went in **`outcome`** (short: `Items i005 notes`, `Profile`, `Meals m41`, `Follow-up r140`, `skip`, `No signal`).

| Answer | Where it goes |
|---|---|
| `skip (<name>)` / "Don't care" | Nothing. outcome `skip`. Not re-asked for 90 days. |
| Profile (habits, favorites, spice, won't-eats, toppings) | One **Profile** row: person, topic, answer (their words, trimmed), review_id, at. |
| Household or schedule facts (who orders, order days, how many nights we cook, what goes to waste) | Profile row with topic `household: <topic>`. Schedule answers also feed the schedule design (live session). |
| Item preference from a parent (`(iNNN)`) | Items: `ok_swap` for swap questions (conditional answers → notes + a follow-up, not Y/N); store/group only when the answer says it plainly; everything else appended to notes as `<answer> (<name>, <date>)`. Never set Drop. |
| Item preference from a kid | Append `<Name>: <answer>` to that item's notes. Nothing else changes. |
| Shelf life | Item notes `Shelf life: <answer> (<name>)` until Items has `shelf_days`. |
| A dinner someone wishes we made | Already in Meals → append "<Name> wishes we made it more often (<date>)" to its notes. New → a parent's wish becomes a Meals row per §8 step 3 (+ vote cards, §8 step 5); a kid's wish becomes the parents' "Add it to Our meals?" card (§8 step 4). |
| An item request inside an answer ("can we add coffee beans") | A follow-up card to the same person for the missing detail (brand, size, store). A parent's clear answer later → new Item per §1 step 4 (status Sometimes). |
| Unclear or misspelled free text | A follow-up card to the same person that offers the likely readings as options. Never write a guess as fact. |
| "Idk" / no real answer | outcome `No signal`. Not re-asked for 90 days. |
| Still eating? | Per §10. |

**B2. Follow-ups.** Up to 3 per person per day, from answers in the last day: the next useful question an answer opens up (a favorite → which product; a "No" on finishing something → a smaller size; a conditional swap → which swaps). End the detail with `(rNNN)` of the answer it follows (the app hides it) and also any `(iNNN)` / `(mNN)` it's about. Write `Follow-up rNNN` in the source row's outcome.

**B3. Recycle.** `later_count` / `later_at` are written by the app when someone taps **Later** (api 10); the app keeps cards put off with Later at the back of the deck, oldest Later first.
- `later_count` ≥ 3 → status `closed`, outcome `Later ×3, retired`. If a parent decision is waiting on it (clarify, swap, receipt code, stop buying), pass it once to the other parent instead (audience = the other parent, passed_by `Poppy`, clear `later_count` / `later_at`).
- Open cards created more than 21 days ago → `closed`, outcome `expired`, except `vote` cards (votes keep).
- Someone who hasn't answered anything in 7 days (or ever, once their deck is full) gets **no new cards**. Their deck waits as it is.

**B4. Refill.** Target **12–15 open cards** per person. For anyone below 12 who answered something in the last 7 days, add up to **8 new cards per person per day** (follow-ups count) to reach 15. Order of preference:
1. Follow-ups from B2.
2. Data-driven: vote cards for meals that person hasn't voted on (dinners first), cut-off meal names and unlinked ingredients (to the parent who plans meals), receipt clarifies, shelf life for perishables with none yet, "Still eating?" No → parents.
3. The question bank (`docs/question-bank.md`), mixed so it never reads like a form.

Rules: one Review row per person (one row = one answer); next free `rNNN`; `created` = today; type `clarify` / `preference` / `profile` / `vote`; quick picks as `Options: …` per the card guide (Yes/No when a yes answers it; 1–3 word labels; likely answer first). Never send a person the same question twice unless 90+ days old and the topic can change (seasonal, favorites). Kids get kid-sized cards: votes, favorites, their own lunch and snack items; nothing that changes what's bought.

**Report** (one line): `Q&A: N folded, N follow-ups, refilled <name> +N, …; <name> untouched N days; N retired.`
