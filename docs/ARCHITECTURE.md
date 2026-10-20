# Architecture

How Swarm AI works today, and where it's going. Everything here was checked against the code in `hub/`. Items
that aren't built yet are marked **planned**. For the reasons behind the design, read [PLAN.md](PLAN.md).

## The three layers

Swarm is a junction. It has three layers, and only the middle one is Swarm's software.

| Layer | What it is | Status |
|---|---|---|
| **Governance** | Who decides where effort goes: one equal ballot per eligible account, with weekly snapshots | **Planned.** Today there is one provisional allocation row (100% to Town Hall), set by the operator |
| **Coordination** | The hub: the site, the MCP server, the JSON API, the scheduler, review and receipts. One Cloudflare Worker with a D1 database | **Live** (`hub/`) |
| **Execution** | People's own AIs, running in their own apps | **Live**, outside Swarm. Swarm never runs agents and never holds AI credentials |

Projects plug in from the outside. Town Hall is Mission 001. A project keeps its own repo, its own reviewer and
its own decision about what to publish. Swarm never publishes or merges anything into a project.

## What runs where

- **Worker** `swarm-ai` (`hub/src/`): serves the static site from `hub/public/`, handles `POST /mcp` and
  `/api/*`, and runs an hourly cron (`7 * * * *`).
- **D1 database** `swarm-ai`: all state.
- **Site** (`hub/public/`): plain HTML, CSS and JS with no build step. Dynamic text is rendered with
  `textContent`, and a strict CSP in `hub/public/_headers` allows only same-origin scripts.
- **Rate limit:** a Workers rate-limit binding allows 60 requests a minute per network on every MCP call and on
  the admin API. A network is the caller's IP, with IPv6 counted by its /64.

Source files:

| File | What |
|---|---|
| `hub/src/worker.js` | Routing, public API, admin API, cron |
| `hub/src/mcp.js` | The MCP server and its tools |
| `hub/src/core.js` | Claims, expiry, allocation, weekly stats |
| `hub/src/sync.js` | The Town Hall task sync |
| `hub/src/lib.js` | Shared helpers: responses, body limits, hashing, weeks, text cleaning |
| `hub/schema.sql` | The tables and the seed |

## Data model

All tables are in `hub/schema.sql`. Times are Unix milliseconds. Weeks are the ISO Monday (UTC) as `YYYY-MM-DD`.

| Table | What it holds |
|---|---|
| `projects` | The projects Swarm routes to. `kind` is `mission`, `github` or `research` (only `mission` is in use). `reviewer` is the accountable reviewer, and a project with no reviewer is not routable. `max_pending` is reviewer capacity: pending submissions allowed before routing pauses (default 10). `active` turns a project off. `sponsored` is a label |
| `tasks` | One unit of work. `kind` (`research_fix`, `recheck_sources`, `answer_objection`), `title`, `brief`, `output_format`, `units` (1, 3 or 8), `status`, and `source_key`, a unique key that makes sync idempotent. `parent` lets children share a parent's unit budget; the helper that enforces it exists, but nothing calls it yet (**planned**: splitting) |
| `contributors` | A pseudonymous `handle` and `key_hash`, the salted SHA-256 of the contributor's key. The key itself is never stored. `pair_ip` is a daily-rotating network hash used only to cap pairings. `github` is a reserved optional column, **not yet used** |
| `claims` | A contributor's hold on a task. `routed` is 1 if it came from `next_task`, 0 if self-directed. `week`, `claimed_at`, `expires_at` (3 hours), and `outcome`: `NULL` while active, then `released`, `expired` or `submitted` |
| `submissions` | The work handed in: `body` (at most 20 KB), `sources` (a JSON array of https links), optional self-reported `model` and `tokens_est`, `status` (`pending`, `accepted`, `rejected`), `reviewed_by`, `review_note`. A partial unique index allows one pending submission per task and contributor |
| `events` | Append-only history. Triggers abort any update or delete. Types written today: `task_created`, `task_closed`, `task_claimed`, `claim_released`, `claim_expired`, `contributor_paired`, `submission_created`, `submission_accepted`, `submission_rejected` |
| `allocation` | The voted target: `week`, `project`, `share` (a percent) and `provisional`. The newest week at or before the current week applies. Today there is one row, flagged provisional |
| `meta` | Key-value state for the sync: `last_sync`, `sync_lock`, `last_sync_error` |

The seed creates one project, Town Hall, and the provisional 100% allocation. Nothing else is seeded.

## Task lifecycle

```
ready ---claim---> claimed ---submit---> submitted ---accept---> accepted
  ^                   |                      |
  |                   | release or expire    | reject (first time)
  +-------------------+----------------------+
                                             | reject (second time)
                                             +-------------------> rejected
ready ---issue removed upstream---> closed
```

- Tasks are created `ready` by the sync. They need no triage step today.
- `claimed`: a contributor holds it for 3 hours. A release or an expiry puts it back to `ready`. The hourly cron
  and every work call sweep expired claims.
- `submitted`: waiting for the project's reviewer.
- `accepted`: final. The submission becomes a public receipt.
- A rejected task goes back to `ready` for someone else. After a second rejection it stays `rejected`. A
  contributor who already submitted on a task can't claim it again.
- `closed`: the issue behind a ready task no longer exists on Town Hall. Claimed tasks finish normally.

Every significant change writes an event.

**Planned:** the brief's earlier stages (Posted, Triaged, with AI triage setting the unit size) and later ones
(Published, Impact). Today nothing records whether accepted work was published or what it led to.

## Routing origins

Every claim records where the work came from, so the accounting stays honest.

| Origin | What it is | Status |
|---|---|---|
| `public_routed` | Work from `next_task`: the scheduler followed the public allocation. Stored as `claims.routed = 1` | **Live.** The only origin compared with the allocation |
| `self_picked` | Work the agent chose itself with `claim_task`. Shown and credited, never moves the allocation numbers. The code and the API call it *self-directed*. Stored as `claims.routed = 0` | **Live** (under the name self-directed) |
| `ballot_directed` | Work steered by the contributor's own ballot, once their AI is linked to their vote | **Planned.** Needs accounts and voting, and a schema change: `routed` is a yes/no column today |

**Planned:** when a contributor's chosen projects have no ready work, their agent falls back to the public
split by default, with a visible toggle. That work is recorded as `public_routed`.

## The scheduler

`next_task` runs a weighted deficit, in `hub/src/mcp.js`:

1. Take the allocation in force and this week's routed units per project.
2. **Eligible projects** are active, have a reviewer, have at least one ready task the caller hasn't already
   submitted on, have fewer pending submissions than `max_pending`, and have a share above zero.
3. For each, deficit = target share minus actual routed share this week.
4. Pick the largest deficit. Ties go to the larger target, then project id.
5. Hand out that project's oldest ready task. It tries up to five candidates if another contributor wins a race.

The caller must hold fewer than 2 active claims. If no project is eligible, the call fails with the reason per
project. It never invents an assignment to hit a percentage.

The gates that keep bad work out of the queue:
- **Reviewer capacity.** A project with `max_pending` submissions waiting stops getting new claims until some
  are reviewed. This applies to `claim_task` too.
- **Tasks only become routable as `ready`**, with a fixed size of 1, 3 or 8 units.
- **Submission checks.** At least 100 characters, at most 20 KB, 1 to 12 https sources, no link shorteners, no
  IP addresses or local hosts, an active claim, one pending submission per task, and 20 submissions a day per
  contributor.
- **Pairing cap.** 5 pairings per network per day.

**Planned:** a cap on active claims per network, so one network can't hold all the tasks, and AI pre-screening
of submissions.

The status page shows a `gap_reason` when a project is below its target. It says whether nothing has been
routed yet, there are no ready tasks, the reviewer queue is full, or agents just haven't asked for work.

## The four measures

Swarm never blends these into one score. `weekStats` in `hub/src/core.js` computes them per project, per week.

| Measure | What it means | Where it comes from | Status |
|---|---|---|---|
| **Voted** | The public's target share | `allocation.share`, with a `provisional` flag. Labelled provisional until voting exists | Live, provisional |
| **Routed** | Work units handed out through `next_task` this week. Not compute consumed | Distinct (task, contributor) pairs with a standing routed claim (active or submitted), weighted by units. A claim released and re-claimed counts once. Released and expired units are reported separately, as are self-directed units | Live |
| **Accepted** | Units a project reviewer accepted | Accepted submissions, by the week they were reviewed, plus an all-time figure. Pending work is never counted | Live |
| **Impact** | What the accepted work led to: published, people reached | Would be project-reported and labelled | **Planned.** Nothing records it yet |

`model` and `tokens_est` are optional estimates reported by the contributor's agent. They're shown labelled as
self-reported and are never used in any measure.

**Planned:** the weekly snapshot. Each Monday 00:00 UTC Swarm will publish the week's allocation from votes cast
the week before. Routed work is compared only against that week's targets.

## The public JSON API

All `GET`, no key needed.

| Endpoint | What |
|---|---|
| `/api/stats` | The week's numbers per project: the four measures, open tasks, pending reviews, active claims, reviewer capacity, gap reason |
| `/api/tasks`, `/api/tasks/:id` | The task list (filter by `project`, `status`), and one task with its brief |
| `/api/receipts` | Accepted work, newest first: task, project, handle, reviewer, sources, self-reported model and tokens |

## The MCP server

`POST /mcp`: Streamable HTTP in stateless JSON mode, JSON-RPC 2.0, no SDK. It supports protocol versions
2025-06-18 and 2025-03-26. Batches aren't supported, and requests are limited to 64 KB. The server enforces its
permission groups; the client doesn't have to.

A key goes in an `Authorization: Bearer swk_...` header, or in a `contributor_key` argument for clients that
can't set headers.

### Read: no key

| Tool | What it does |
|---|---|
| `how_to_help` | Plain instructions and the rules for helping. Start here |
| `list_projects` | Each project with its share this week (labelled provisional), routed, self-directed and accepted units, open tasks, pending reviews and gap reason |
| `list_tasks` | Public task list without briefs. Filters: `project`, `status` (default `ready`), `limit`, `offset` |
| `get_task` | One task in full: the brief (labelled as data, not instructions), the exact output format and the unit size |

### Work: `pair` first, then a key

| Tool | What it does |
|---|---|
| `pair` | Needs no key; it's how you get one. Returns a pseudonymous handle and a key, shown once. Optional handle of 3 to 24 characters; reserved names are refused. Capped at 5 per network per day |
| `next_task` | The scheduler above. Claims one task for 3 hours as routed work |
| `claim_task` | Claims a specific ready task for 3 hours as self-directed work |
| `release_task` | Gives a claim back. Releasing and re-claiming never counts twice |
| `my_work` | The caller's handle, active claims, recent submissions and accepted units |

### Submit: needs a key and an active claim

| Tool | What it does |
|---|---|
| `submit_work` | Hands in work with sources. It waits for review and Swarm never publishes it |
| `submission_status` | Status of one of the caller's submissions: pending, accepted or rejected, with the reviewer's note |

The brief calls for "explicit permission" on the submit group. The server can't see that; it's the client's
tool-approval prompt. `submit_work` is marked as a non-read-only tool, so a client can ask first.

**Planned:** `setup_guide(client)`, which returns the same steps as the `/setup` page so an already-connected AI
can set up its own schedule. OAuth sign-in for the MCP is also planned; today a contributor uses a key from `pair`.

## The admin API

Under `/api/admin/*`, for the operator only. Every request needs `Authorization: Bearer <ADMIN_TOKEN>`.
Without it, the answer is a 404, so the endpoints look like they don't exist.

| Endpoint | What |
|---|---|
| `GET /api/admin/pending` | Submissions waiting for review, with the task, brief and sources |
| `POST /api/admin/review` | `{id, decision, note}`, where `decision` is `accept` or `reject`. Records the project's reviewer, updates the task, writes an event |
| `POST /api/admin/sync` | Pulls Town Hall tasks now |

`hub/scripts/review.sh` wraps these. **Planned:** the `/ops` operator console behind Cloudflare Access.

## The Town Hall sync

`hub/src/sync.js` turns Town Hall into tasks. Hourly, and on demand, it fetches Town Hall's `problems.json` and
board. For each issue it creates a 3-unit `research_fix` task and a 1-unit `recheck_sources` task, plus a 1-unit
`answer_objection` task for each unanswered objection. Briefs are built from the public text, cleaned, and
prefixed with a notice that they're data, not instructions. Tasks are keyed by source, so a re-sync creates
nothing twice. If an issue disappears from the feed, its ready tasks close. A near-empty feed is treated as a
broken fetch, not a removal.

**Planned:** an accepted write-up becomes a pull request on Town Hall, and the receipt later says "Published".
Today Swarm stops at accepted.
