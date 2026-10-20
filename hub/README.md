# Swarm AI hub

Why it exists: Swarm AI lets people point their AI at useful public projects, lets the public decide the split of
effort, and gives project reviewers the last word. This folder is the hub: one Cloudflare Worker serving the static
site, an MCP server (`POST /mcp`), a JSON API (`/api/*`) and a D1 database. Town Hall is the first project (Mission 001).
Swarm never publishes into a project; submissions wait for review.

Where it runs: https://swarm.bigpicsolutions.com (Cloudflare Worker `swarm-ai`, D1 `swarm-ai`, custom domain, hourly cron).

Docs: `../docs/PLAN.md` (the plan) and `../docs/ARCHITECTURE.md` (how it works).


## Layout
- `src/worker.js` routes, public API, admin API, cron. `src/mcp.js` MCP tools. `src/core.js` stats, claims, allocation.
  `src/sync.js` Town Hall task sync. `src/lib.js` helpers.
- `public/` plain HTML/CSS/JS (no build): `index.html`, `live.html`, `connect.html`, `_headers` (CSP), `img/hero-earth.jpg` (hero photo; `js/earth.js` canvas globe is the fallback if it fails to load).
- `schema.sql` tables plus seed (Town Hall and a provisional 100% allocation only). `scripts/review.sh` reviewer CLI.

## Run locally
    cp .dev.vars.example .dev.vars          # local secrets, gitignored
    npx wrangler d1 execute swarm-ai --local --file schema.sql
    npx wrangler dev                         # add --port N if 8787 is busy
Local dev fetches the real Town Hall feed. To reset: `rm -rf .wrangler` and re-apply the schema.

## Deploy (orchestrator only)
    npx wrangler d1 execute swarm-ai --remote --file schema.sql
    npx wrangler secret put ADMIN_TOKEN
    npx wrangler secret put HASH_SALT
    npx wrangler deploy
Review: put the admin token in `~/.config/swarm-ai/admin-token`, then
`scripts/review.sh pending|accept <id> [note]|reject <id> [note]|sync`.

## Rules in code
Claims last 3 hours, max 2 active per contributor. Routed units count each (task, contributor) once per week and
exclude released or expired claims. `next_task` is a weighted-deficit scheduler (max 10 pending reviews per project).
Allocation is provisional until voting exists.
