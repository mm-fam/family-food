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
| Nov 1 2026 | Backend deploys are automated: a GitHub Action (clasp) pushes Code.gs to Apps Script and publishes a new version of the existing deployment whenever Code.gs changes on main, then checks a public `version` action. Manual paste/deploy is the fallback only. |
| Nov 1 2026 | Round 3 (owner feedback): the List no longer shows dinners (they live on Meals; meal tags on rows stay). List and Shop start fully folded every launch (stores and aisles, with name peeks; a Shop search opens what it matches). Tapping a meal opens a **meal card** with day chips for this week and next to plan it in one tap. **Meal ideas**: anyone pastes a recipe/link/idea in the app; Claude turns it into a Meals row (kids' ideas need a parent's yes) and adds vote cards. Meals show **stat tags** (votes, next/last made, cost tier) computed by the backend (api 7), with sort pills. |
| Nov 1 2026 | Round 4 (owner feedback): bottom tabs spread evenly (4 columns); List tab gets an item-count badge; Ask renamed **Q&A** on screen; selected store pills fill with the store color (fixes white-on-white in dark mode) and button text can't be selected on long-press; Recently done removed from the List (history is on the item screen); both parents are admins (Settings.admins). App only, no backend change. |
| Nov 1 2026 | Round 5 (Mike): the Meals plan is two horizontal **week strips** (this week on top; next week below, folded until tapped) instead of a 14-row list, so Our meals sits near the top. App only. |
| Nov 1 2026 | The plan covers **breakfast, lunch, snack and dinner** (Plan `slot` + `note`, Meals `kind`; leftovers are notes). The family's Hearth display is the meal-plan source of truth during the transition (screenshots loaded by Claude); the goal is planning in Poppy and pushing to Hearth with the **→ Hearth** button (a paste-ready Hearth Helper message; Hearth has no API). Backend api 8. |
| Nov 1 2026 | Family demo round (owner, partner, a kid): **List is one list by aisle**, not by store; only store-only items (Items `store_only`) say so, and In store shows everything except items only another store carries. Day tiles list breakfast → lunch → snack → dinner at equal size. Search matches every word across name, brand, aisle and aliases (closest matches when none match all). A row leaving the List stays crossed out with Undo; "A little" keeps it on the List. + New removed (💡 Meal idea covers it). Kids ask for meals (a parent picks the day) and can't change the plan. 💡 in the header for app feedback (App Feedback tab). Automatic Q&A cards: "How was it?" after new meals, weekly "Still eating?". Stale state reads no longer flash old data. Home-screen install tip. Backend api 9. |
| Nov 1 2026 | **Q&A loop** (daily, morning check step B, runbook §11): every answer gets an outcome (Items, Meals, new Profile tab, follow-up card, skip); decks kept at 12–15 cards, max 8 new per person per day, from follow-ups first, then data, then `docs/question-bank.md`; **Later is saved** (Review `later_count` / `later_at`, action `reviewLater`) so put-off cards come back at the back of the deck and retire after 3 Laters; cards older than 21 days expire (votes keep); nobody gets new cards after 7 days without an answer. Backend api 10. |
| Nov 1 2026 | **Exact store products** live in a new **Products** tab (item × store × product, match exact/likely/alt, sku, aisle), seeded from the Giant Eagle purchase history; past purchases also became ~150 new catalog items so they're in Shop. **Cart building uses the owner's Chrome session** (signed in by a person) and adds products from the store's past purchases. List rows carry `cart` + `cart_at`; the app shows **🛒 In GE cart**; the **cart check** syncs a store's online cart to the List (read-only on the store side). In-store mode walks the store in aisle order when Products has aisles. **Amazon (AMZ)** added as the fourth store in the app. Backend api 11. |
| Nov 1 2026 | **Ordering is on demand** (no fixed order days; a parent hits "it's <store> time"); school lunches come from the main grocery store and are due Friday; **Q&A decks are personal** (per-person briefs and change signals in the morning check). |
| Nov 1 2026 | **Q&A becomes the Inbox**: the family's daily to-do, grouped into sections most important first (Due soon, How was it?, Missions, Quick questions; parents also Approvals and Decisions). Built in 3 steps: (1) rename + sections, (2) points with a family leaderboard and streaks, (3) missions (2–3 "go check" cards a day, every day). Step 1 is app only. |
| Nov 1 2026 | **Cart jobs:** parents start a cart **build** or **check** from the phone (⚙ → store); the job waits in a new **Cart Jobs** tab until Claude's **cart runner**, a scheduled task on the owner's computer (where Chrome is signed in), runs it hourly 8 am–9 pm and writes back status + a one-line result. Fridays from 6 pm it also checks the Giant Eagle cart before the Saturday order. The app shows the status and a List heads-up. Backend api 12. |
| Nov 1 2026 | **Inbox step 2: points** (backend api 13). The backend counts points from Review (`answered_at`, `points`, `points_to`, added on first use): Due soon 5 (2 late), Mission 3, How was it? / Still eating? 2, others 1, skips 0. Daily goal 10 (Settings `points_goal`), streaks, family leaderboard Mon–Sun, last week's winner. **Kitchen help:** a daily parents' card per kid after each planned dinner ("Did <kid> help cook …?" Cooked it 10 / Helped 5 / Not this time 0); the answer is the record of what they did. |
| Nov 1 2026 | **Points rules and history in the app** (backend api 14): the Inbox scoreboard links to *How points work* (every rule, generated from the backend's `POINT_RULES` so the screen can't drift from the scoring) and *Points history* (`pointsLog`: weekly totals, winners, and every scored answer with its reason). Review gains `points_why`, so each answer's reason is stored at the moment it scores. Due soon now scores the same way the app sorts it ("due <day>" in the text counts too). |
| Nov 1 2026 | **Inbox step 3: missions** (backend api 15). The backend makes up to 3 "go check" cards per kid each day (meal ingredients for the next 3 days, then overdue usuals; skips what's on the List or was seen in 3 days), different for each kid. Answers are Stock sightings right away; A little / Out puts the item on the List (kids as requests). 3 points each; unanswered ones close after 2 days. |
| Nov 1 2026 | **Helping plan and shop earns points** (backend api 16): adding to the List 1 (kids when a parent approves; up to 5 a day), asking for a meal 2 (up to 2 a day), a parent handling a kid's List or meal request 1 (Approve and Skip both count). The goal is participation in what the family eats and buys; daily caps and approval keep it from being gamed. Recorded in a new append-only **Points** tab. |
| Nov 1 2026 | **Scoring starts Mon Nov 2** (backend api 18): everyone starts at 0, since the rules weren't settled on Nov 1. Settings `points_start` = 2026-11-02; nothing before it counts, including last week's 👑. A one-off backfill of Nov 1 points was removed. |
