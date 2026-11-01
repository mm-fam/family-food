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
- `apps-script/Code.gs`: backend. Pushing a change to `main` deploys it to the Sheet's Apps Script (`.github/workflows/deploy-backend.yml`).

## Rules
- Never check out, enter payment, or change store account settings when building carts.
- Don't type into Items columns J:M (formulas). Receipts is append-only.
- New Sheet columns go at the end of a tab. Follow the schema checklist in `docs/runbooks.md`.
- Backend deploys happen on push: the **Deploy backend** Action publishes Code.gs as a new version of the existing deployment (runbook §4). Bump `API_VERSION` when the app depends on the change. Manual fallback: Manage deployments → edit → **New version**. Never "New deployment" unless `config.js` is updated too.
- The workspace can't reach script.google.com; test the backend through Chrome.
- Test app changes on a 390×844 viewport with Playwright before pushing.
- When behavior changes, update the matching doc in `docs/` and the decision log in the same commit.
