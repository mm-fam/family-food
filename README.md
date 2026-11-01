# Poppy 2.0

The family's shared grocery list, staples, and weekly meal plan. A plain web page on GitHub Pages, backed by a Google Sheet.

```
phones (GitHub Pages)  ──POST──▶  Apps Script web app  ──▶  "Poppy 2.0 (app data)" Google Sheet
                                                                     ▲
                                        Claude (Google connector) ───┘  receipts, carts, review
```

- **App** (`index.html`, `app.js`, `styles.css`): Need (with Shop mode), Meals, Ask, plus an admin screen. No build step.
- **Backend** (`apps-script/Code.gs`): lives inside the Sheet. Checks the family passcode, reads and writes the tabs, works out "probably due".
- **Sheet tabs**: Items (catalog), List, Meals, Plan, Receipts, Review, Settings. Items stats (orders, last bought, average days between buys) are formulas over Receipts.

## Docs

- [docs/system.md](docs/system.md): how it's built, Sheet schema, API
- [docs/runbooks.md](docs/runbooks.md): receipts, carts, deploying, troubleshooting
- [docs/roadmap.md](docs/roadmap.md): what's next and decisions made
- [CLAUDE.md](CLAUDE.md): guide for Claude

## One-time setup

### 1. Backend (about 5 minutes)

1. Open the **Poppy 2.0 (app data)** sheet → **Extensions → Apps Script**.
2. Delete what's in `Code.gs`, paste in `apps-script/Code.gs` from this repo, and save.
3. **Project Settings** (gear icon) → **Script Properties** → **Add script property**: `FAMILY_PASSCODE` = the passcode the family will type. Save.
4. Back in the editor, pick `setup` in the function dropdown and click **Run**. Approve the permissions prompt (it's your own script). This adds the nightly cleanup job.
5. **Deploy → New deployment** → type **Web app** → Execute as **Me**, Who has access **Anyone** → **Deploy**. Copy the URL that ends in `/exec`.

### 2. App

1. Paste the `/exec` URL into `config.js`, commit, push.
2. Repo **Settings → General**: make the repo **Public** (Pages on a free org needs it; nothing secret lives here).
3. **Settings → Pages**: Source **Deploy from a branch**, branch `main`, folder `/ (root)`. The site appears at `https://mm-fam.github.io/family-food/`.

### 3. Phones

Open the link in Safari, tap **Share → Add to Home Screen**. First launch asks for the passcode and "Who's this?". Kids' adds arrive as requests a parent approves.

## Updating the backend later

Paste the new `Code.gs` over the old one, then **Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy**. The URL stays the same.

## Who does what

| Job | Done by |
|---|---|
| Adding, approving, checking off, meal planning | Family, in the app |
| "Probably due" and nightly cleanup | Apps Script, automatically |
| Matching receipts to items, clearing bought items, filing unknown codes in Review | Claude, from forwarded receipt emails |
| Filling store carts | Claude in Chrome on Mike's computer, when asked. A person always checks out. |
