# Family Food roadmap

_Keep this current: move items between sections and date them. Don't let it become a diary._

## Now: finish the loop (Phase 1)
1. **Mike's private test.** Run the 10-minute test (unlock, List, kid request + approve, meals, Order tab). Log anything odd here.
2. **Mom's review.** Show her the app (or the wireframe). Capture her feedback below before changing UI.
3. **Answer the 3 open Review questions** (GE codes MD BLACK, PEP 3 PK, PROTEIN & PROBIOTC) and set order days in Settings.
4. **Receipt auto-forward.** Mom adds a Gmail filter forwarding Giant Eagle digital receipts and Amazon/Whole Foods order emails to Mike. Only after Mike OKs contacting her.
5. **Daily receipt task.** Scheduled task runs runbook §1 each morning, reports only when something needs attention.
6. **Cart building, one store.** Run runbook §2 on Giant Eagle for 2–3 weeks, then add Whole Foods.
7. **Family rollout.** Girls get the link + passcode on their devices.

## Next: make it think ahead (Phase 2)
- **Draft list the day before order day:** scheduled task adds due staples + planned meal ingredients as `needed` (or `suggested` for a lighter touch) so Mom only reviews.
- **Meal library from real life:** replace guessed dinners with what the family actually cooks; tag weeknight/weekend and who likes it.
- **Weekly plan tied to the Hearth family meeting:** turn "taco Tuesday, pizza Friday" from the meeting into Plan rows.
- **Store-split rule:** capture Mom's actual logic (price vs quality vs habit) so new items default to the right store.
- **Swap preferences:** fill ok_swap for every Always item.

## Later: ideas backlog (unprioritized)
- Spend view by week/store from Receipts (budget target if the family wants one).
- myPerks / rewards tracking for Giant Eagle.
- Aisle ordering per store for faster in-store trips.
- "We're out" voice/Siri shortcut that posts to the backend.
- Recipe links on meals; leftover nights.
- Pantry "do we have X?" check only for items that matter this week (never full inventory counts).
- Price alerts on staples.
- Costco / other-store items as a third store.

## Mom's feedback
_(not yet captured)_

## Test notes
_(Mike's findings from private testing go here)_

## Decision log
| Date | Decision |
|---|---|
| Oct 2026 | Build baseline from order history, not a pantry walk. No exact pantry counts. |
| Oct 2026 | Custom phone app (GitHub Pages) over a spreadsheet UI; no Claude accounts needed for family. |
| Oct 2026 | Backend = Google Sheet + Apps Script web app, guarded by one family passcode. |
| Oct 2026 | Kids' adds are requests needing parent approval. |
| Oct 2026 | Claude fills carts but never checks out; a person always places the order. |
| Oct 2026 | "Probably due" is a suggestion only; never auto-added. |
| Oct 31 2026 | MVP live. Private testing; no family outreach until Mike says. |
