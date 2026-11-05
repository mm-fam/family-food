# CLAUDE.md

Guide for Claude working on Poppy 2.0. Read `docs/system.md` before changing anything.

## Docs
- `docs/system.md`: architecture, Sheet schema, API actions, status
- `docs/runbooks.md`: receipt ingest, cart building, deploying app/backend, schema-change checklist, troubleshooting
- `docs/roadmap.md`: phases, backlog, decision log

The claude.ai Project for this app holds fuller versions of these docs, with names and links. This repo is **public**, so it never contains family members' names, email addresses, the Sheet URL, or the passcode.

## Layout
- `index.html`, `app.js`, `styles.css`, `manifest.webmanifest`, `icons/`: the phone app. Plain JS, no build, no dependencies.
- `config.js`: `API_URL` for the Apps Script web app (not a secret).
- `apps-script/Code.gs`: backend. Pushing a change to `main` deploys it to the Sheet's Apps Script (deploy job in `.github/workflows/checks.yml`).

## Working alongside other sessions (guardrails, Nov 4)
The owner often has several Claude chats open on Poppy at once. Only **one session changes code at a time**:
1. **Before the first code change:** read Settings `dev_lock` in the Sheet (Google Sheets connector). If it names another session and is less than 2 hours old, don't change code: tell the owner what that session is doing and ask before going on. Otherwise set `dev_lock` = "<this session's link> | <what you're changing> | <now yyyy-MM-ddTHH:mm>" (add the row if missing).
2. **Right before every push:** `git fetch` and rebase onto `origin/main`; take the next free `API_VERSION` and add its `// N = …` note (a smoke test fails on a duplicate).
3. **Tests:** `node --test tests/*.test.js` must pass before pushing. The **Checks** workflow runs them on every push and only deploys the backend after they pass. Add a test when you add a backend action.
4. **After pushing:** watch the run (`gh run watch`) and fix any red run yourself. Every failed run emails the owner, so keep them rare: don't push known-failing code, and don't press Re-run on an unchanged failure (Google hiccups are already retried inside the run).
5. **When done:** clear `dev_lock` (blank value).
Sessions that only plan, answer questions or edit the Sheet's data don't take the lock.

## Rules
- Never check out, enter payment, or change store account settings when building carts.
- Don't type into Items columns J:M (formulas). Receipts is append-only.
- New Sheet columns go at the end of a tab. Follow the schema checklist in `docs/runbooks.md`.
- Backend deploys happen on push: the **Checks** workflow's deploy job publishes Code.gs as a new version of the existing deployment (runbook §4). Bump `API_VERSION` when the app depends on the change. Manual fallback: Manage deployments → edit → **New version**. Never "New deployment" unless `config.js` is updated too.
- The workspace can't reach script.google.com; test the backend through Chrome.
- Test app changes on a 390×844 viewport with Playwright before pushing. Backend changes: `node --test tests/*.test.js` (in-memory Sheet stand-in in `tests/gas-shim.js`, sample household in `tests/fixture.js`).
- When behavior changes, update the matching doc in `docs/` and the decision log in the same commit.
