# Cart watcher (runs on the owner's Windows PC)

Tapping **Build the cart** / **Check the cart** in the app queues a Cart Jobs row. This watcher, run by Windows Task Scheduler every minute, asks the backend `cartJobsOpen` (no Claude, no cost). When a job is queued it starts Claude Code (`claude -p --chrome`) with `cart-runner-prompt.md`, which does every open job in this PC's Chrome. Every build ends with a reconcile pass so the List matches the real cart line for line.

- Needs: the PC awake, Chrome open with the Claude extension, stores signed in.
- Chrome closed → no Claude run; jobs wait and are retried every 15 minutes.
- Fridays from 6 pm it queues one Giant Eagle cart check.
- One run at a time (`runner.lock`); logs in `runner/logs/` (14 days).
- `poppy-runner.json` holds the API URL, passcode and Sheet ID. It is git-ignored; never commit it.

Setup steps live in the project's runbook §13.
