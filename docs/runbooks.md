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
