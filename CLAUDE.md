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
- `apps-script/Code.gs`: backend. The live copy is pasted into the Sheet's Apps Script; editing the repo doesn't deploy it.

## Rules
- Never check out, enter payment, or change store account settings when building carts.
- Don't type into Items columns J:M (formulas). Receipts is append-only.
- New Sheet columns go at the end of a tab. Follow the schema checklist in `docs/runbooks.md`.
- Backend deploys: Manage deployments → edit → **New version** (keeps the URL). Never "New deployment" unless `config.js` is updated too.
- The workspace can't reach script.google.com; test the backend through Chrome.
- Test app changes on a 390×844 viewport with Playwright before pushing.
- When behavior changes, update the matching doc in `docs/` and the decision log in the same commit.
