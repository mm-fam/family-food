# Poppy 2.0 roadmap

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
| Oct 31 2026 | Family logo is the app icon (full badge on cream background; maskable version for Android). |
| Oct 31 2026 | App renamed **Poppy 2.0** (app title, home-screen name, Sheet title, docs). Repo/URL stay `family-food` so links keep working. New logo to follow. |
| Oct 31 2026 | Poppy 2.0 logo (chef robot badge) is the app icon, replacing the placeholder. |
| Oct 31 2026 | Target added as third store (`TGT`): toiletries, paper, household; monthly Drive Up. `Either` means either grocery store only. |
| Oct 31 2026 | Questions moved to their own **Ask** tab (from the Order tab). Next: per-person questions (`audience`) so kids answer about their own things, quick-pick preferences, dinner voting. |
| Oct 31 2026 | Ask questions are per person (`audience`: parents / all / a name). Kids vote on dinners and answer about their own things; changes to what's bought still need a parent. |
| Oct 31 2026 | Ask is a one-at-a-time card deck. Card type comes from how the options are worded (Yes/No → swipe, 2–4 → tap, 5+ → dropdown, emoji → rating, none → text). |
| Oct 31 2026 | Ask cards can be passed to another family member (Review `audience` + `passed_by` columns, `reviewPass` action, backend api 2). |
| Oct 31 2026 | Ask decks are sized ~20–35 cards per person (one Review row per person per question), refilled below ~8 from a question bank (dinner votes, food profile, kid items, swap rules, schedule). Emoji cards only for true emoji options. |
| Oct 31 2026 | Light inventory, not counts: "Got it" on a List item splits into Bought it / We have it (Plenty / Some / A little / count, logged to an append-only Stock tab) / Next week (List `hold_until`, hidden 7 days). A fresh sighting holds the item out of "probably due". Expirations later come from per-item shelf life confirmed by a parent plus receipt date. Backend api 3. |
| Oct 31 2026 | App reshaped around one **Need** list: tabs Need / Meals / Ask; Staples folds into Need; Order moves to an admin screen. Checking off only happens in **Shop mode** (shared, by aisle, everyone incl. kids). Every ask is recorded by name in List `wanted_by` instead of a silent qty bump (backend api 4). |
| Oct 31 2026 | Second pass on opening night: Need is renamed **List** (what we need, store and aisle accordions, meal tags, 🛒 In store mode); a **Shop** tab comes back as the place to add things (search + smart filter pills); one **item screen** for both, with history (purchases, prices, at-home sightings, answered questions) and details folded away. Backend api 5 (`itemInfo`, `stockLog`, `state.stock`). |
| Nov 1 2026 | New Poppy 2.0 logo (robot rounded-square tile) replaces the chef badge: home-screen icons for iPhone and Android, plus the unlock and "Who's this?" screens. |
| Nov 1 2026 | Meal plan is by **date**, not week: Plan gets a `date` column, the Meals tab shows a rolling 14 days (today + 13), and `nightly` archives Plan rows older than 14 days to Plan Archive. Fixes dinners vanishing when the week rolled over on Sunday. Backend api 6. |
