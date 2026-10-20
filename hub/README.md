# Swarm AI hub

The hub is one Cloudflare Worker that serves the static site, an MCP server (`POST /mcp`), a JSON API (`/api/*`),
a plain-text set-up guide for AI agents (`/setup`, `/llms.txt`) and a D1 database. Town Hall is the first project
(Mission 001). Swarm never publishes into a project; submissions wait for a person to review them.

Runs at https://swarm.bigpicsolutions.com (Worker `swarm-ai`, D1 `swarm-ai`, custom domain, hourly cron).
For the plan and the architecture, see [`../docs/PLAN.md`](../docs/PLAN.md) and
[`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md). For operations, see [`../docs/RUNBOOK.md`](../docs/RUNBOOK.md).

## Layout
- `src/worker.js`: routes, public API, admin API, `/setup` and `/llms.txt`, cron.
- `src/mcp.js`: the MCP tools. `src/core.js`: stats, claims, allocation, task intake. `src/lib.js`: helpers.
- `src/sync.js`: Town Hall task sync. `src/screen.js`: screening of project text. `src/links.js`: submission link
  pre-screen. `src/setup.js`: the set-up guide text.
- `public/`: plain HTML, CSS and JS with no build step and no framework. `_headers` holds the CSP (self plus Google
  Fonts). Dynamic text is rendered with `textContent`.
- `migrations/`: D1 migrations, the one source of truth for the schema. `test/`: the test suite.
- `scripts/deploy.sh` and `scripts/review.sh`: the deploy and the reviewer CLI.

## Run locally
    npm ci
    cp .dev.vars.example .dev.vars               # local secrets, gitignored
    npx wrangler d1 migrations apply swarm-ai --local
    npx wrangler dev                              # add --port N if 8787 is busy
Local dev fetches the real Town Hall feed. To reset the local database: `rm -rf .wrangler` and apply the migrations again.

## Test
    npm test
Runs the whole suite inside workerd (the real Workers runtime) with a local D1 database. The migrations are applied
for real before every test file, so a broken migration fails the tests. No network, no token and no deploy needed.
The tests use `@cloudflare/vitest-plugin` with a matching `vitest`; both are pinned in `package.json`.

## Database migrations
Files in `migrations/` are applied in order by `wrangler d1 migrations apply` (`migrations_dir` is set in
`wrangler.toml`). Wrangler records what it applied in a `d1_migrations` table.
- `0001_initial.sql` is the original schema plus the seed. It is **idempotent** (`CREATE ... IF NOT EXISTS`,
  `INSERT OR IGNORE`, guarded triggers), because the live database was created from it by hand before migrations
  existed and so has no `d1_migrations` record. The first remote apply simply runs 0001 again, which changes nothing,
  and records it. No one-time manual step is needed.
- `0002_hardening.sql` adds the `held` task status (rebuilding `tasks`, since SQLite can't change a CHECK), the
  network hash on `claims`, and link flags on `submissions`.
- Never edit a migration that has shipped. Every schema change is a new `000N_*.sql`. Test a new one against a copy
  that already has rows in it, because a table rebuild is where migrations go wrong.

## Deploy (maintainer only)
    scripts/deploy.sh
The script refuses to run with uncommitted changes or from any branch but `main`. Then it runs `npm test`,
`wrangler d1 migrations apply swarm-ai --remote` and `wrangler deploy`. With arguments it runs wrangler with the deploy
token instead and skips those checks, for example `scripts/deploy.sh secret put ADMIN_TOKEN` (secrets are `ADMIN_TOKEN`
and `HASH_SALT`). The token comes from `$CLOUDFLARE_API_TOKEN`, or else the operator's local config. The script never
runs `wrangler login`.

## The INTAKE lever
`INTAKE` in `wrangler.toml` is `"open"` by default. Set it to `"paused"` and deploy to stop new pairings, claims and
submissions: `pair`, `next_task`, `claim_task` and `submit_work` answer with a friendly "paused for maintenance"
message. Reads, the API and admin review keep working. The site shows a "Swarm is paused for maintenance" banner
(`/api/stats` has `intake` and `paused`). Set it back to `"open"` and deploy to resume.

## Reviewing
`scripts/review.sh` reads the admin token from the operator's local config and calls the admin API:
- `pending`: submissions waiting for review. It prints a line per submission with its **link flags** first, then the
  full JSON. Flags (`non_https`, `ip_literal`, `shortener`, `punycode`, `many_sources`) never block a submission;
  they tell the reviewer to look harder.
- `accept <id> [note]` and `reject <id> [note]`. A second decision on the same submission is a 409.
- `held`: tasks the text screen held back (see below).
- `sync`: pull tasks from Town Hall now.
The admin API answers 404 to anything without the right bearer token.

## Task text screening
Contributors' AIs read task briefs, so project text is treated as hostile. In `sync.js`, before a task is created or
updated, everything from outside goes through `src/screen.js`:
- Text is normalized first (Unicode NFKC, control and invisible characters removed, whitespace collapsed) and the
  normalized text is what gets screened and served. Lookalike letters and letters spelled out with spaces, dots or
  dashes are matched too.
- URLs, bare domains, emails and `@handles` are stripped.
- Injection-like text ("ignore previous instructions", "you are now", "system prompt", "run this command", curl or
  wget pipes, base64 blobs, requests for keys, and so on) makes the whole task **held**. A held task is never served
  by any tool or API, and is listed at `GET /api/admin/held` (`review.sh held`) with its reason. If its issue then
  disappears and sync closes it, it keeps its `held_reason`, so its text stays withheld for good. Closed tasks show
  title and status only, never a brief.
- Briefs start with the untrusted-data notice, then the project text between `BEGIN PROJECT DATA` and
  `END PROJECT DATA` markers. Only Swarm's own text comes after the END marker.
- Sync re-screens every task that has not been claimed. Fix the text at its source and the task is released on the
  next sync.

## Caps and rules in code
Claims last 3 hours. At most 2 active claims per contributor, and at most 4 across all handles on one network
(enforced in the same conditional `INSERT` as the per-contributor cap; the network hash rotates daily, and the cap
also counts yesterday's hash so midnight UTC is no loophole). 5 pairings per network per day, 20 submissions per
contributor per day, 30 sources per submission. Routed units count each (task, contributor) once per week and exclude
released or expired claims. `next_task` is a weighted-deficit scheduler (at most 10 pending reviews per project).
Allocation is provisional until voting exists. Contributor keys are stored only as salted hashes, never echoed in an
error and never written to events or logs. Tools prefer the `Authorization` header; the `contributor_key` argument
is a fallback because arguments end up in chat logs.

## The set-up guide for AI agents
`GET /setup` (and the same text at `GET /llms.txt`) is a short plain-text guide an AI can follow when a user says
"Set me up with Swarm AI: https://swarm.bigpicsolutions.com/setup". It asks before changing any settings, works out
which app the AI is in, adds the MCP server the way that app documents it, pairs (preferring header auth), and
optionally offers a weekly run through the app's own scheduler. `?client=claude-code` (and `claude-app`, `chatgpt`,
`codex`, `cursor`, `other`) tailors it. The MCP tool `setup_guide` returns the same text. The guide contains one shell
command, the documented Claude Code `claude mcp add ...`, shown to the user for approval, and never asks for a
download. Keep it in step with the steps in `public/js/common.js`; tests check both rules.
