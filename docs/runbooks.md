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

1. Edit `apps-script/Code.gs` in the repo; commit.
2. Mike pastes it into Extensions → Apps Script → Code.gs → Save.
3. **Deploy → Manage deployments → pencil → Version: New version → Deploy.** URL stays the same. (A *New deployment* changes the URL and breaks the app unless config.js is updated.)
4. If triggers changed, run `setup()` once.
5. Test through Chrome: `/exec?action=ping&pass=<wrong>` should return `wrong_passcode`; then have Mike open the app.

## 5. Schema change checklist (new tab or column)

1. Add columns at the **end** of a tab, never in the middle (the backend reads by header name, but formulas and Mike's eyes rely on order).
2. Update `Code.gs` (TABS, reads/writes), `app.js` if the app shows it, and `family-food-system.md`.
3. Back up first: File → Make a copy of the Sheet, named with the date.
4. Deploy backend (section 4) before pushing app changes that depend on it.
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
| Claude can't reach the backend | Expected from the workspace. Use Chrome. |
| Claude can't push | Claude GitHub app needs access to the `mm-fam` org (github.com/settings/installations). |

## 7. Backups and safety
- Google Sheets version history covers most mistakes (File → Version history).
- Before bulk edits (more than ~20 rows) or schema changes, make a dated copy.
- Rotate the passcode if a phone is lost: change the Script Property; everyone re-enters it.
