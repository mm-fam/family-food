# Poppy ⇄ Hearth: meal plan sync

_Nov 1 2026. Built: meal slots (backend api 8) and the **→ Hearth** button. the meal planner's Hearth week Nov 1–7 loaded._

## The idea
The family's Hearth display shows a weekly **Meal Plan** grid: Breakfast · Lunch · Snack · Dinner for each day. the meal planner has been building it by hand. Shopping has to cover all four rows (kid lunches, after-school snacks, breakfasts), not just dinners.

- **During the transition, Hearth is the gold source.** When the meal planner builds or changes a week in Hearth, the admin sends a screenshot and Claude loads it into Poppy (steps below).
- **Where we're heading: plan in Poppy, push to Hearth.** Poppy holds the meals, their ingredients and the plan; one button produces the message for Hearth Helper, so the Hearth grid is filled automatically instead of by hand.
- Hearth has **no API**. Its AI assistant, **Hearth Helper**, takes text, notes and photos (in the Hearth Companion app or by SMS) and turns a weekly meal list into the Meal Plan "for your approval". the admin already uses the same paste-a-block pattern for calendar events after the family meeting.

## In Poppy (api 8)
- **Plan** rows have a `slot` (breakfast / lunch / snack / dinner; blank = dinner) and a `note`. One meal per date + slot.
- **Leftovers:** a row whose note starts with "Leftover" (e.g. Wed lunch = Tue's sheet-pan chicken, note `Leftovers`). It shows as "Leftover <meal>", adds no ingredients and doesn't count as "made". A note with no meal (Mon "Leftover wraps") shows the note as is.
- **Meals** have a `kind` (the slot it's usually for). The library has kind pills (All · Dinners · Breakfasts · Lunches · Snacks), a small icon on non-dinners, and the Edit meal sheet has "Usually for".
- **Meals tab:** each day tile shows dinner big, with 🥣 breakfast / 🥪 lunch / 🍎 snack lines under it. Tapping the day (or those lines) opens a **day sheet** with all four slots; each slot has a picker (that kind's meals first, the rest under "Other meals") and ↗ to open the meal card. A meal card plans into the meal's own slot ("Put it on a day · Breakfast").
- **Shop:** "For dinners" is now **For meals**: ingredients of everything planned in the 14 days, leftovers skipped.

## The → Hearth button (parents only)
Meals tab → THIS WEEK → **→ Hearth** → pick This week / Next week → **Copy** (or Share…) → in the Hearth app open **Hearth Helper**, paste, send, and check its preview before approving.

The message it builds:
```
Please update our Hearth Meal Plan for Nov 8 – Nov 14, 2026.
Use these exact meal names in the Breakfast, Lunch, Snack and Dinner rows, for the whole family. Replace whatever is already in those spots. Leave any spot I don't list as it is. Meal plan only: no calendar events or reminders.

Sun Nov 8
Breakfast: Greek Yogurt Parfaits
Lunch: …
Snack: …
Dinner: …
```
"This week" starts today, so earlier days in Hearth are left alone. Empty slots are left out.

**Not yet proven:** how well Hearth Helper follows "replace" and the slot names. the admin tries it with next week first; adjust the wording in `hearthText()` (app.js) if it misfiles anything.

## Runbook: load a Hearth week into Poppy (Claude)
**When:** the admin shares a screenshot of the Hearth Meal Plan (or says the meal planner changed the week).
1. Read every cell: day × Breakfast / Lunch / Snack / Dinner. Names cut off with "…" stay cut off (never complete them by guessing); ask the admin for the full names if he's there.
2. Match each name to Meals (same dish = same meal; Hearth's spelling wins on new meals). New dish → new Meals row (next `mNN`), `kind` = the row it sits in, `item_ids` = only catalog items the name clearly names (Nounos vs other yogurt, which apples etc. stay unlinked), notes "From the meal planner's Hearth week <dates>" + "Not in the catalog yet: …". Never create Items for it.
3. "Leftover …" cells: Plan row with the source meal's id and note `Leftovers` when it's clear which meal; otherwise no meal and the cell text as the note.
4. Write Plan rows (week_of, day, meal_id, date, slot, note); dates as text `yyyy-mm-dd`. Hearth wins over what Poppy had for that date + slot (overwrite). Back up first if more than ~20 rows change.
5. Report: "Hearth week <dates>: N meals planned, N new meals, N cut-off names to confirm."

## the meal planner's week, Nov 1–7 (loaded Nov 1)
25 new meals **m16–m40** (7 breakfasts, 4 lunches, 7 snacks, 7 dinners) and 28 Plan rows. Hearth replaced Poppy's dinners for the week (Taco night, Buffalo sliders, Pizza night, sausage sheet pan came off; Hearth had Buffalo chicken wraps, Turkey & black bean cottage cheese bake, Sheet pan chicken & sweet potato, Egg roll in a bowl, Cottage cheese & spinach bake, Black bean & sweet potato quesadillas(?), Chicken & chickpea curry).
- **Cut-off names to confirm** (as Hearth showed them): m18 Scrambled Egg & Cottage Cheese…, m23 High-Protein Chicken & Black B…, m24 Buffalo Chicken & White Bean Sala…, m25 Southwest Black Bean & Egg Salad…, m28 Cottage Cheese with Cucumbers &…, m29 Cottage Cheese Dip with Peppers…, m35 Turkey & Black Bean Cottage Che…, m36 Sheet Pan Chicken, Sweet P…, m38 Cottage Cheese & Spinach Baked…, m39 Black Bean & Sweet Potato Q…. Rename in the app (Edit meal) or the Sheet; vote cards match on `(mNN)`, so renaming is safe.
- **Missing from the catalog** and used a lot: cottage cheese (6 meals), sweet potatoes, chickpeas, white beans, cucumbers. They link up as receipts show them or when the meal planner edits the meal.
- **No vote cards yet** for m16–m40: they go out once the names are confirmed (dinners first).

## Next
1. the admin tries **→ Hearth** with next week; tune the message.
2. the meal planner plans next week in Poppy's day sheets instead of Hearth (or keeps Hearth and the admin sends screenshots; both work).
3. Week-plan ingredients → the List by run (Phase 2 "Plan my week": Sunday GE vs Wednesday WF), using all four slots.
4. Tie to the family meeting: the meeting's meal talk lands as Plan rows, then one → Hearth paste alongside the calendar block.
