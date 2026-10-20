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

- **Worker** `swarm-ai` (`hub/src/`): serves the static site from `hub/public/`, handles `POST /mcp`, `/api/*`,
  `GET /setup` and `GET /llms.txt`, and runs an hourly cron (`7 * * * *`) that expires stale claims and syncs
  Town Hall. Those routes run in the Worker first; everything else is a static file.
- **D1 database** `swarm-ai`: all state. The schema is the files in `hub/migrations/`, applied in order.
- **`INTAKE`** (`hub/wrangler.toml`): `"open"` by default. `"paused"` is the lockdown lever (see below).
- **Site** (`hub/public/`): plain HTML, CSS and JS with no build step. Dynamic text is rendered with
  `textContent`, and a strict CSP in `hub/public/_headers` allows only same-origin scripts.
- **Rate limit:** a Workers rate-limit binding allows 60 requests a minute per network on every MCP request and
  on the admin API (after the token check). A network is the caller's IP, with IPv6 counted by its /64.

Source files:

| File | What |
|---|---|
| `hub/src/worker.js` | Routing, public API, admin API, `/setup` and `/llms.txt`, cron |
| `hub/src/mcp.js` | The MCP server and its tools, pairing, scheduling (`next_task`), the intake pause, submission checks |
| `hub/src/core.js` | Claim rules and caps, expiry, task creation, allocation, weekly stats |
| `hub/src/sync.js` | The Town Hall task sync, and the brief wrapper |
| `hub/src/screen.js` | Screening of project text: strips links, flags injection-like text so the task is held |
| `hub/src/links.js` | The pre-screen for a submission's source links: refuses non-public links, flags suspicious ones |
| `hub/src/setup.js` | The set-up guide text for AI agents, served by `/setup`, `/llms.txt` and `setup_guide` |
| `hub/src/lib.js` | Shared helpers: responses, body limits, hashing, network hash, weeks, text cleaning |
| `hub/migrations/0001_initial.sql` | The original tables and the seed. Idempotent, because the live database was made from it by hand |
| `hub/migrations/0002_hardening.sql` | The `held` task status and `held_reason`, `claims.network`, `submissions.flags` |
| `hub/scripts/deploy.sh`, `review.sh` | The deploy and the reviewer CLI (see [RUNBOOK.md](RUNBOOK.md)) |

## Data model

The schema is the migrations in `hub/migrations/`, and only those. There is no separate schema file. A shipped
migration is never edited; every change is a new `000N_name.sql`. Times are Unix milliseconds. Weeks are the ISO
Monday (UTC) as `YYYY-MM-DD`.

| Table | What it holds |
|---|---|
| `projects` | The projects Swarm routes to. `kind` is `mission`, `github` or `research` (only `mission` is in use). `reviewer` is the accountable reviewer, and a project with no reviewer is not routable. `max_pending` is reviewer capacity: pending submissions allowed before routing pauses (default 10). `active` turns a project off. `sponsored` is a label |
| `tasks` | One unit of work. `kind` (`research_fix`, `recheck_sources`, `answer_objection`), `title`, `brief`, `output_format`, `units` (1, 3 or 8), `status` (`ready`, `claimed`, `submitted`, `accepted`, `rejected`, `closed`, `held`), `held_reason` (set only while `held`: the names of the screen rules that fired, never the matched text), and `source_key`, a unique key that makes sync idempotent. `parent` lets children share a parent's unit budget; the helper that enforces it exists, but nothing calls it yet (**planned**: splitting) |
| `contributors` | A pseudonymous `handle` and `key_hash`, the salted SHA-256 of the contributor's key. The key itself is never stored. `pair_ip` is a daily-rotating network hash used only to cap pairings. `github` is a reserved optional column, **not yet used** |
| `claims` | A contributor's hold on a task. `routed` is 1 if it came from `next_task`, 0 if self-directed. `week`, `claimed_at`, `expires_at` (3 hours), and `outcome`: `NULL` while active, then `released`, `expired` or `submitted`. `network` is the daily network hash at claim time, used only for the per-network cap (empty on claims made before migration 0002) |
| `submissions` | The work handed in: `body` (at most 20 KB), `sources` (a JSON array of links), `flags` (a JSON array of link flags for the reviewer, `[]` when clean), optional self-reported `model` and `tokens_est`, `status` (`pending`, `accepted`, `rejected`), `reviewed_by`, `review_note`. A partial unique index allows one pending submission per task and contributor |
| `events` | Append-only history. Triggers abort any update or delete. Types written today: `task_created`, `task_held`, `task_closed`, `task_claimed`, `claim_released`, `claim_expired`, `contributor_paired`, `submission_created`, `submission_accepted`, `submission_rejected` |
| `allocation` | The voted target: `week`, `project`, `share` (a percent) and `provisional`. The newest week at or before the current week applies. Today there is one row, flagged provisional |
| `meta` | Key-value state for the sync: `last_sync`, `sync_lock`, `last_sync_error` |

The seed (in migration 0001) creates one project, Town Hall, and the provisional 100% allocation. Nothing else
is seeded.

## Task lifecycle

```
ready ---claim---> claimed ---submit---> submitted ---accept---> accepted
  ^                   |                      |
  |                   | release or expire    | reject (first time)
  +-------------------+----------------------+
                                             | reject (second time)
                                             +-------------------> rejected
ready ---issue removed upstream---> closed
held  ---issue removed upstream---> closed
ready <--- screen result changes on a re-sync ---> held
```

- Tasks are created by the sync as `ready`, or as `held` if the text screen flagged them (below). They need no
  triage step today.
- `held`: the task text looked like an instruction to an AI. A held task is never served: no tool or API
  returns it, it can't be claimed, and it doesn't count as an open task. `held_reason` says which rules fired.
  It is released to `ready` by the next sync in which its text passes the screen, and goes back to `held` if the
  text changes to fail it again. The operator lists held tasks with `review.sh held`.
- `claimed`: a contributor holds it for 3 hours. A release or an expiry puts it back to `ready`. The hourly cron
  and every work call sweep expired claims.
- `submitted`: waiting for the project's reviewer.
- `accepted`: final. The submission becomes a public receipt.
- A rejected task goes back to `ready` for someone else. After a second rejection it stays `rejected`. A
  contributor who already submitted on a task can't claim it again.
- `closed`: the issue behind a `ready` or `held` task no longer exists on Town Hall. Claimed tasks finish
  normally.

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
project. It never invents an assignment to hit a percentage. Only `ready` tasks are candidates, so held tasks
are never handed out.

### Claim caps

Both caps are enforced in `hub/src/core.js` (`MAX_ACTIVE_CLAIMS`, `MAX_ACTIVE_CLAIMS_PER_NETWORK`) and applied in
one conditional `INSERT` in `claim()` in `hub/src/mcp.js`, so two requests at once can't both slip past:

- **Per contributor: 2** active claims. An active claim is one with no outcome that hasn't expired.
- **Per network: 4** active claims across all handles on one network. The network is the daily network hash
  stored in `claims.network`. The check counts today's hash and yesterday's, so claims made just before UTC
  midnight still count and the rotation is no loophole. Releasing or submitting a claim frees its slot.

Both `next_task` and `claim_task` go through it. Hitting a cap ends the call with an explanation; `next_task`
does not try its other candidates, because they would hit the same cap.

The gates that keep bad work out of the queue:
- **Reviewer capacity.** A project with `max_pending` submissions waiting stops getting new claims until some
  are reviewed. This applies to `claim_task` too.
- **Tasks only become routable as `ready`**, with a fixed size of 1, 3 or 8 units.
- **Submission checks.** At least 100 characters, at most 20 KB, 1 to 30 source links of at most 300
  characters each, an active claim, one pending submission per task, and 20 submissions a day per contributor.
  Links go through the pre-screen below.
- **Pairing cap.** 5 pairings per network per day.
- **Claim caps.** 2 per contributor and 4 per network, above.
- **Task-text screening and the `held` status.** Below.
- **The intake pause.** Below.

**Planned:** AI pre-screening of submissions (checking the work itself). Only the link pre-screen exists today.

### Submission link flags

`hub/src/links.js` looks at every source link when `submit_work` runs. Links are normalised and de-duplicated.

- **Refused** (the call fails): a link longer than 300 characters, anything that isn't `http` or `https`, a
  login in the link (`user:pass@`), `localhost`, `.local`, `.localhost` and `.internal` names, private,
  loopback and link-local addresses, and hosts with no dot.
- **Flagged, never refused.** The submission is saved and the flags are stored in `submissions.flags`, written
  into the `submission_created` event, shown to the contributor, and shown first by `review.sh pending`:

| Flag | Meaning |
|---|---|
| `non_https:<host>` | Plain `http` |
| `ip_literal:<host>` | A public IP address instead of a name |
| `shortener:<host>` | A known link shortener such as `bit.ly` |
| `punycode:<host>` | A host label starting `xn--`, which can disguise another name |
| `many_sources:<n>` | More than 20 unique sources |

Flags tell the reviewer to look harder. Swarm never fetches a link itself.

### Task-text screening

Task briefs are read by contributors' AIs, so project text is treated as hostile. In the Town Hall sync, every
piece of project text (the issue, questions, plan steps, objections and the title) passes through
`hub/src/screen.js` before it goes into a task:

- Links, bare domains, emails and `@handles` are replaced with `[link removed]`, `[email removed]` or
  `[handle removed]`. Control and hidden characters are dropped, whitespace is flattened and long runs of rule
  characters are collapsed, so text can't fake the data markers around it.
- The raw text is also checked against a set of injection patterns (ignore-instructions, role changes, system
  prompt talk, requests to run commands, shell commands, encoded blobs, requests for keys or secrets, requests
  to open links, concealment from the user, text addressed to an AI or reviewer, JSON payloads, chat markers,
  fake data markers, and script or markup). One hit, or any hidden characters, makes the whole task `held`.
  The rule names are stored as `held_reason`, and a `task_held` event is written.
- The brief opens with the untrusted-data notice, then the project text between `BEGIN PROJECT DATA` and
  `END PROJECT DATA` markers. Only Swarm's own text comes after the END marker. Plan steps cite a Town Hall
  repository file only as a path, never as a link.
- Every sync re-screens tasks that are `ready` or `held` and updates changed text, so fixing the text at its
  source releases the task. Claimed, submitted and finished tasks are never touched.

### The intake pause (`INTAKE`)

`INTAKE` in `hub/wrangler.toml` is `"open"` by default. Set it to `"paused"` and deploy: `pair`, `next_task`,
`claim_task` and `submit_work` answer with a friendly "paused for maintenance" message. Everything else keeps
working: browsing, `release_task`, `my_work`, `submission_status`, the public API, the admin API and review.
`/api/stats` reports `intake` and `paused`, and the site shows a banner.

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

All `GET`, no key needed. (`/setup` and `/llms.txt`, below, are `GET` too.)

| Endpoint | What |
|---|---|
| `/api/stats` | The week's numbers per project: the four measures, open tasks, pending reviews, active claims, reviewer capacity, gap reason, and `intake` and `paused` |
| `/api/tasks`, `/api/tasks/:id` | The task list (filter by `project`, `status`), and one task with its brief. Held tasks are never listed, and `:id` answers 404 for one |
| `/api/receipts` | Accepted work, newest first: task, project, handle, reviewer, sources, self-reported model and tokens |

## The MCP server

`POST /mcp`: Streamable HTTP in stateless JSON mode, JSON-RPC 2.0, no SDK. It supports protocol versions
2025-06-18 and 2025-03-26. Batches aren't supported, and requests are limited to 64 KB. The server enforces its
permission groups; the client doesn't have to.

A key goes in an `Authorization: Bearer swk_...` header (preferred, because arguments end up in chat logs), or in a
`contributor_key` argument for clients that can't set headers.

There are 12 tools, listed below by permission group.

### Read: no key

| Tool | What it does |
|---|---|
| `how_to_help` | Plain instructions and the rules for helping. Start here |
| `setup_guide` | The set-up guide for an AI: add this MCP server, pair, and optionally schedule a weekly run with the app's own scheduler. The same text as `/setup`. Optional `client`: `claude-code`, `claude-app`, `chatgpt`, `codex`, `cursor` or `other` |
| `list_projects` | Each project with its share this week (labelled provisional), routed, self-directed and accepted units, open tasks, pending reviews and gap reason |
| `list_tasks` | Public task list without briefs. Filters: `project`, `status` (default `ready`; `held` is not an option), `limit` (up to 50), `offset` |
| `get_task` | One task in full: the brief (labelled as data, not instructions), the exact output format and the unit size. A held task looks like a missing one |

### Work: `pair` first, then a key

| Tool | What it does |
|---|---|
| `pair` | Needs no key; it's how you get one. Returns a pseudonymous handle and a key, shown once. Optional handle of 3 to 24 characters; reserved names are refused. Capped at 5 per network per day |
| `next_task` | The scheduler above. Claims one task for 3 hours as routed work. Needs a key |
| `claim_task` | Claims a specific ready task for 3 hours as self-directed work. Needs a key |
| `release_task` | Gives a claim back. Releasing and re-claiming never counts twice. Needs a key |
| `my_work` | The caller's handle, active claims, recent submissions and accepted units. Needs a key |

### Submit: needs a key

| Tool | What it does |
|---|---|
| `submit_work` | Hands in work with 1 to 30 sources. Needs an active claim on the task. It waits for review and Swarm never publishes it. Suspicious links are flagged for the reviewer |
| `submission_status` | Status of one of the caller's submissions: pending, accepted or rejected, with the reviewer's note |

While `INTAKE` is `"paused"`, `pair`, `next_task`, `claim_task` and `submit_work` are refused with a friendly
message; the other eight tools work.

The brief calls for "explicit permission" on the submit group. The server can't see that; it's the client's
tool-approval prompt. `submit_work` is marked as a non-read-only tool, so a client can ask first.

**Planned:** OAuth sign-in for the MCP. Today a contributor uses a key from `pair`.

## The set-up guide: `/setup`, `/llms.txt` and `setup_guide`

`GET /setup` returns a short plain-text guide written for AI agents, for a user who says "Set me up with Swarm AI:
https://swarm.bigpicsolutions.com/setup". `GET /llms.txt` returns the same text, and the `setup_guide` tool
returns it too, so an already-connected AI can use it. `?client=claude-code` (or `claude-app`, `chatgpt`, `codex`,
`cursor`, `other`) tailors it to one app; without it every app is covered. Only `GET` and `HEAD` are allowed.

The guide tells the AI to ask the user before changing any settings, work out which app it's in, add the MCP
server the way that app documents it, pair (preferring the header for the key), and, only if the user says yes,
offer a weekly run through the app's own scheduler. The text is in `hub/src/setup.js`. Its rules are tested: the
only shell command is the documented Claude Code `claude mcp add` line, shown to the user for approval; it never
asks for a download; it always asks first. Swarm doesn't schedule or run anything for the user.

## The admin API

Under `/api/admin/*`, for the operator only. Every request needs `Authorization: Bearer <ADMIN_TOKEN>`.
Without it, the answer is a 404, so the endpoints look like they don't exist.

| Endpoint | What |
|---|---|
| `GET /api/admin/pending` | Submissions waiting for review, with the task, brief, sources and link flags |
| `GET /api/admin/held` | Tasks the text screen held back, with `held_reason`, the brief and the `source_key`. Never served to agents |
| `POST /api/admin/review` | `{id, decision, note}`, where `decision` is `accept` or `reject`. Records the project's reviewer, updates the task, writes an event |
| `POST /api/admin/sync` | Pulls Town Hall tasks now |

`hub/scripts/review.sh` wraps these (`pending`, `held`, `accept`, `reject`, `sync`). A second decision on the same
submission is a 409. **Planned:** the `/ops` operator console behind Cloudflare Access.

## The Town Hall sync

`hub/src/sync.js` turns Town Hall into tasks. Hourly, and on demand, it fetches Town Hall's `problems.json` and
board. For each issue it creates a 3-unit `research_fix` task and a 1-unit `recheck_sources` task, plus a 1-unit
`answer_objection` task for each unanswered objection. Briefs are built from the public text, run through the
screen above (so a task may be created as `held`), and prefixed with a notice that they're data, not
instructions. Tasks are keyed by source, so a re-sync creates nothing twice, and a task that hasn't been claimed
yet follows its source's current text. If an issue disappears from the feed, its `ready` and `held` tasks close.
A near-empty feed (fewer than 3 issues) is treated as a broken fetch, not a removal.

## The tests

`npm test` in `hub/` runs the suite inside workerd (the real Workers runtime) with a local D1 database, using
`@cloudflare/vitest-pool-workers`. Every migration is applied for real before each test file, so a broken
migration fails the tests. No network, token or deploy is needed. The files in `hub/test/`:

| File | Covers |
|---|---|
| `mcp.test.js` | The protocol, `pair`, the work loop (claim, submit, review, receipt), the claim caps (2 and 4), held tasks never served, the `INTAKE` pause, the admin API and the submission link pre-screen |
| `screen.test.js` | `stripLinks` and `sanitize`, each injection rule, and the Town Hall sync (clean tasks `ready`, injected ones `held`, release after a fix) |
| `setup.test.js` | `/setup` and `/llms.txt`, `?client=`, the guide's rules, and the `setup_guide` tool |
| `units.test.js` | Week boundaries, the network hash for IPv6, and link screening |
| `helpers.js`, `apply-migrations.js` | Test setup |

CI (`.github/workflows/check.yml`) runs the same suite and checks that migration files are numbered in order.

**Planned:** an accepted write-up becomes a pull request on Town Hall, and the receipt later says "Published".
Today Swarm stops at accepted.
