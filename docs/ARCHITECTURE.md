# Architecture

How Swarm AI works today, and where it's going. Everything here was checked against the code in `hub/`. Items
that aren't built yet are marked **planned**. For the reasons behind the design, read [PLAN.md](PLAN.md).

## The three layers

Swarm is a junction. It has three layers, and only the middle one is Swarm's software.

| Layer | What it is | Status |
|---|---|---|
| **Governance** | Who decides where effort goes: one equal ballot per eligible account, with weekly snapshots | **Built** (Phase 3, not yet deployed): passkey voter accounts, 100-point ballots and a weekly snapshot. With no eligible ballot the previous allocation is carried forward and labelled provisional |
| **Coordination** | The hub: the site, the MCP server, the JSON API, the scheduler, review and receipts. One Cloudflare Worker with a D1 database | **Live** (`hub/`) |
| **Execution** | People's own AIs, running in their own apps | **Live**, outside Swarm. Swarm never runs agents and never holds AI credentials |

Projects plug in from the outside. Town Hall is Mission 001. A project keeps its own repo, its own reviewer and
its own decision about what to publish. Swarm never publishes or merges anything into a project.

## What runs where

- **Worker** `swarm-ai` (`hub/src/`): serves the static site from `hub/public/`, handles `POST /mcp`, `/api/*`,
  `GET /setup` and `GET /llms.txt`, and runs an hourly cron (`7 * * * *`) that expires stale claims and syncs
  Town Hall. Those routes and `/ops*` run in the Worker first. Private operator assets are fetched through `env.ASSETS` only after Access JWT verification; everything else is a static file.
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
| `hub/src/access.js` | Fail-closed Access RS256 verification with WebCrypto and a bounded, one-hour in-memory JWKS cache |
| `hub/src/ops.js` | Private console APIs, CSRF and Origin checks, project controls, audit queries and contributor revocation |
| `hub/src/admin.js` | Shared transactional review, private queue reads, accepted Town Hall export and publication recording |
| `hub/src/prescreen.js` | Background advisory Workers AI annotation and local textual duplicate detection |
| `hub/src/mcp.js` | The MCP server and its tools, pairing, scheduling (`next_task`), the intake pause, and the claim, release and submit transactions |
| `hub/src/validate.js` | The argument validator: enforces each MCP tool's `inputSchema` before anything else runs |
| `hub/src/core.js` | Claim and expiry transitions, caps, the bulk task insert used by the sync, allocation, weekly stats |
| `hub/src/sync.js` | The Town Hall task sync (bounded, streamed fetch), and the brief wrapper |
| `hub/src/screen.js` | Screening of project text: strips links, flags injection-like text so the task is held |
| `hub/src/github.js` | The GitHub connector: issue sync, pull-request checks, merge = accepted, the webhook, registering GitHub projects |
| `hub/src/links.js` | The pre-screen for a submission's source links: refuses non-public links, flags suspicious ones |
| `hub/src/webauthn.js` | Hand-written WebAuthn verification on WebCrypto: a strict CBOR decoder, the authenticator-data checks, COSE key parsing (ES256 and RS256 only) and ES256 DER-to-raw signature conversion. No dependency |
| `hub/src/accounts.js` | Passkey registration and login, sessions, the Turnstile check, the per-network account cap and the CSRF guard for account and ballot writes |
| `hub/src/voting.js` | Ballots (append-only versions), the weekly snapshot (largest remainder, idempotent, fallback), and `/api/vote/*` |
| `hub/src/setup.js` | The set-up guide text for AI agents, served by `/setup`, `/llms.txt` and `setup_guide` |
| `hub/src/lib.js` | Shared helpers: responses, body limits, hashing, network hash, weeks, text cleaning |
| `hub/migrations/0001_initial.sql` | The original tables and the seed. Idempotent, because the live database was made from it by hand |
| `hub/migrations/0002_hardening.sql` | The `held` task status and `held_reason`, `claims.network`, `submissions.flags` |
| `hub/migrations/0003_lifecycle_constraints.sql` | The one-outstanding-claim and one-live-submission unique indexes, the `op` columns, and the repair of rows that would break them |
| `hub/migrations/0006_github.sql` | `projects.repo` and `repo_id`, the pull-request columns on `submissions`, `github_deliveries`, the Swarm AI project and the provisional 50/50 |
| `hub/migrations/0004_repair_legacy_states.sql` | Repairs the legacy states 0003 left: `submitted` tasks with nothing to review, and outstanding claims on closed, finished or held tasks |
| `hub/migrations/0005_ops.sql` | Project pauses, submission pre-screen JSON and publication fields, audit query indexes |
| `hub/migrations/0007_voting.sql` | `accounts`, `credentials`, `account_challenges`, `sessions`, append-only `ballot_versions`, `vote_snapshots`; rebuilds `allocation` with `share` in basis points |
| `scripts/publish-townhall.sh`, `publish_townhall.py` | Local accepted-research bridge to a Town Hall solution branch and commit; never pushes |
| `hub/scripts/deploy.sh`, `review.sh` | The deploy and the reviewer CLI (see [RUNBOOK.md](RUNBOOK.md)) |

## Data model

The schema is the migrations in `hub/migrations/`, and only those. There is no separate schema file. A shipped
migration is never edited; every change is a new `000N_name.sql`. Times are Unix milliseconds. Weeks are the ISO
Monday (UTC) as `YYYY-MM-DD`.

| Table | What it holds |
|---|---|
| `projects` | The projects Swarm routes to. `kind` is `mission`, `github` or `research` (`mission` and `github` are in use). A `github` project has `repo` (`owner/name`, follows renames) and `repo_id` (GitHub's numeric id, the identity that is checked; filled in on registration, or by the first sync for the seeded project). `reviewer` is the accountable reviewer, and a project with no reviewer is not routable. `max_pending` is reviewer capacity: pending submissions allowed before routing pauses (default 10). `active` turns a project off. `paused` stops new assignments without hiding the project or discarding work; the console edits `max_pending` within 1–100. `sponsored` is a label |
| `tasks` | One unit of work. `kind` (`research_fix`, `recheck_sources`, `answer_objection`), `title`, `brief`, `output_format`, `units` (1, 3 or 8), `status` (`ready`, `claimed`, `submitted`, `accepted`, `rejected`, `closed`, `held`), `held_reason` (set only while `held`: the names of the screen rules that fired, never the matched text), and `source_key`, a unique key that makes sync idempotent. `kind` `github_issue` marks a task made from a GitHub issue. `parent` is reserved for task splitting, which is **planned**: nothing creates a child task, every task has `parent` NULL, and the code that did is removed (see "Task splitting (planned)") |
| `contributors` | A pseudonymous `handle` and `key_hash`, the salted SHA-256 of the contributor's key. The key itself is never stored. `pair_ip` is a daily-rotating network hash used only to cap pairings. `github` is a reserved optional column, **not yet used** |
| `claims` | A contributor's hold on a task. `routed` is 1 if it came from `next_task`, 0 if self-directed. `week`, `claimed_at`, `expires_at` (3 hours), and `outcome`: `NULL` while active, then `released`, `expired` or `submitted`. `network` is the daily network hash at claim time, used only for the per-network cap (empty on claims made before migration 0002). `op` is the id of the request that last changed the row (see "Transactions and constraints"). A partial unique index allows one outstanding claim (`outcome IS NULL`) per task |
| `submissions` | The work handed in: `body` (at most 20 KB), `sources` (a JSON array of links), `flags` (a JSON array of link flags for the reviewer, `[]` when clean), for pull-request submissions `pr_number`, `pr_author`, `pr_state` (`open`, `merged`, `closed`) and `pr_repo_id` (one live submission per pull request), optional self-reported `model` and `tokens_est`, `status` (`pending`, `accepted`, `rejected`), `reviewed_by`, `review_note`. `op` is as for claims. `prescreen` is nullable JSON from the advisory AI check. `published_url` and `published_at` record publication after acceptance, without changing `status`. Two partial unique indexes: one pending submission per task and contributor (migration 0001), and, since migration 0003, one pending-or-accepted submission per task, so a task can have only one accepted result |
| `events` | Append-only history. Triggers abort any update or delete. Types written today: `task_created`, `task_held`, `task_closed`, `task_claimed`, `claim_released`, `claim_expired`, `contributor_paired`, `submission_created`, `submission_accepted`, `submission_rejected`, `project_updated`, `contributor_revoked`, `submission_published`, and from the GitHub connector `project_registered`, `project_activated`, `project_repo_resolved`, `project_repo_renamed` and `task_size_label_changed`. Migration 0003 also wrote `claim_repaired`, `submission_superseded` and `task_repaired` for each row it fixed |
| `allocation` | The voted target: `week`, `project`, `share` (integer basis points, 0-10000, since migration 0007; older percent rows were multiplied by 100) and `provisional`. The newest week at or before the current week applies. `currentAllocation` still returns percent (`share / 100`), so stats, MCP and the scheduler are unchanged |
| `accounts` | A voter. Random internal `id`, `created`, `suspended`, and `network` (the daily network hash at registration, used only for the account cap). No email, no password. Separate from contributor handles |
| `credentials` | A passkey: credential `id`, the public key as a JWK, `sign_count` and `transports`. The private key never leaves the device |
| `account_challenges` | One-use WebAuthn challenges with a 5-minute expiry, bound to the browser by a hashed ceremony cookie |
| `sessions` | `hash` (SHA-256 of the 32-byte session id plus the salt), `account`, `expires` (30 days) |
| `ballot_versions` | Every saved ballot, append-only (triggers abort update and delete): `account`, `version`, `allocations` (JSON, project id to points, sum 100), `created` |
| `vote_snapshots` | One row per ISO week: `voter_count`, `published_at`, `source` (`ballots` or `fallback`). The primary key on `week` makes publishing happen once |
| `meta` | Key-value state for the sync: `last_sync`, `sync_lock`, `last_sync_error`, and for GitHub `github_last_sync`, `github_last_error`, `github_backoff_until` |
| `github_deliveries` | Recent webhook delivery ids (kept 3 days), so a replayed delivery is ignored |

The seed creates two projects: Town Hall (migration 0001) and Swarm AI (migration 0006, kind `github`, repo `DaryllGomas/swarm-ai`), with a provisional 50/50 allocation for the week of 2026-10-19. The seed is provisional until the first ballot snapshot is published. Nothing else is seeded.

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
- `held`: the task text looked like an instruction to an AI. A held task is never served: no public tool or API
  returns it, it can't be claimed, and it doesn't count as an open task. `held_reason` says which rules fired.
  It is released to `ready` by the next sync in which its text passes the screen, and goes back to `held` if the
  text changes to fail it again. The operator lists held tasks privately in `/ops` or with `review.sh held`. These two operator surfaces are the only exception to withholding the text.
- `claimed`: a contributor holds it for 3 hours. A release or an expiry puts it back to `ready`. The hourly cron
  and every work call sweep expired claims.
- `submitted`: waiting for the project's reviewer. A review is valid only for a pending submission whose task is `submitted`.
- `accepted`: final. The submission becomes a public receipt. A task has at most one accepted result.
- A rejected task goes back to `ready` for someone else. After a second rejection it stays `rejected`. A
  contributor who already submitted on a task can't claim it again.
- `closed`: the issue behind a `ready` or `held` task no longer exists on Town Hall. Claimed tasks finish
  normally.

Every significant change writes an event.

Accepted receipts can now be annotated as **Published**, with a public https link and a timestamp. Acceptance still counts once; publication adds no units. The local Town Hall bridge prepares a branch and commit, and the operator pushes and opens the PR. Only after merge and publication does the operator call `/api/admin/published`.

**Planned:** the brief's earlier stages (Posted, Triaged, with AI triage setting the unit size) and Impact. Publication is recorded, but impact is not measured.

## Transactions and constraints

Every change of a task's state is one `env.DB.batch([...])` call, and a D1 batch is a single transaction: it commits
whole or not at all. An error at any statement leaves nothing behind, so there is no half-made claim, submission or
review, and no write that compensates for another one.

The same transition made twice (a repeat, a stale request, two requests at once) is handled inside the batch:

- The **first statement** is the only one that can win. It is conditional on the state it expects and writes a random
  `op` id on the row it changes. The caller learns whether it won from that statement's `meta.changes`.
- Every **later statement** (the task's new status, the event) is conditional on the row carrying that same `op`. A
  request that lost finds the row already changed and so changes nothing. In particular a stale release or expiry
  can't reopen a task that someone else has since claimed, and a stale claim can't get past the already-submitted rule.

| Transition | One batch: statements | The first statement wins only if |
|---|---|---|
| Claim (`claim_task`, `next_task`) | insert the claim; task to `claimed`; `task_claimed` event | the task is `ready`, not held, in an active, unpaused project with a reviewer; this contributor has handed in nothing on it and nobody has a pending or accepted submission on it; no claim is outstanding on it; the reviewer queue has room; the contributor holds under 2 and the network under 4 active claims. First, `claim()` expires that task's own stale claims, so an expired claim never blocks a new one |
| Release, expiry | claim to `released` or `expired`; task to `ready`; event | the claim is still outstanding (live for a release, past its 3 hours for an expiry). Expiry transitions each claim on its own |
| Submit (`submit_work`) | insert the submission; claim to `submitted`; task to `submitted`; `submission_created` event | the claim is outstanding and unexpired; the task is `claimed` (by this claim) and not withheld, and has no pending or accepted submission; the contributor has under 20 submissions in the last 24 hours (a rolling window counted inside the insert). When any of these fails, nothing is written and the claim stays usable |
| Review (`/api/admin/review`) | submission to `accepted` or `rejected`; task to `accepted`, `ready`, or `rejected` after the second reviewer rejection; event | the submission is pending, its task is `submitted`, and, for an accept, the task has no accepted submission |

Database constraints back this up (migration 0003): at most one outstanding claim per task, and at most one pending or
accepted submission per task. Violating either is an error, not corrupt data. The migration first repaired the rows
the older code could have written, without deleting any: extra live submissions became `rejected` by `system` (an
accepted duplicate stops counting as accepted, so a task is credited once), extra outstanding claims were closed as
`released`, and task statuses were made to match the claims and submissions. Each change wrote an event. A
`system` rejection does not count toward the two-rejection limit.
Migration 0004 repairs what 0003 left: a `submitted` task with nothing to review goes to `ready` (or `rejected` after two
reviewer rejections, or `claimed` if someone still holds it), and an outstanding claim on a closed, accepted, rejected
or held task is closed as `released` without reopening the task; each repair wrote an event.

Retries are safe:
- `claim_task` for a task you already hold returns that claim.
- `release_task` for a claim you already released answers the same way (`already: true`).
- `submit_work` with the same text and sources as your pending or accepted submission on the task returns that
  submission (`already_received: true`), which is the answer to a call whose response was lost. Different text is refused.
- A review that failed changed nothing, so it can just be sent again. A review that succeeded and is sent again is a
  409 that names the state (`already accepted`).

Outside the lifecycle: `pair` writes the contributor and its event in two calls, and the Town Hall sync writes tasks
in chunks. Neither can corrupt a claim or a submission.

## Task splitting (planned)

**Not built.** `tasks.parent` exists in the schema, but nothing creates a child task, and the helper that once did is
removed because it was not safe (two concurrent creations could each take the parent's whole budget). Whoever builds
splitting must meet these invariants, enforced in the database or in one transaction and tested against populated
data with concurrent creation:

1. Child units are **reserved atomically** against the parent's remaining budget: the children of a parent never
   total more than the parent's units, even when created at the same moment.
2. A child belongs to **the same project** as its parent.
3. A parent that has been split can **no longer be claimed**.
4. A parent and its children **never both spend the same units**: define the accounting so routed and accepted
   units for the parent and its children count each unit once.
5. The rules above are a **migration constraint or a single transaction**, not a check followed by an insert.

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
2. **Eligible projects** are active and unpaused, have a reviewer, have at least one ready task the caller hasn't already
   submitted on, have fewer pending submissions than `max_pending`, and have a share above zero.
3. For each, deficit = target share minus actual routed share this week.
4. Pick the largest deficit. Ties go to the larger target, then project id.
5. Hand out that project's oldest ready task. It tries up to five candidates if another contributor wins a race.

The caller must hold fewer than 2 active claims. If no project is eligible, the call fails with the reason per
project. It never invents an assignment to hit a percentage. Only `ready` tasks are candidates, so held tasks
are never handed out.

### Claim caps

Both caps are enforced in `hub/src/core.js` (`MAX_ACTIVE_CLAIMS`, `MAX_ACTIVE_CLAIMS_PER_NETWORK`) and applied in
the conditional `INSERT` of the claim transaction in `claim()` in `hub/src/mcp.js`, so two requests at once can't both slip past:

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
  characters each, an active claim, one pending-or-accepted submission per task (a database constraint), and 20
  submissions in any rolling 24 hours per contributor (counted inside the submission insert).
  Links go through the pre-screen below.
- **Pairing cap.** 5 pairings per network per day.
- **Claim caps.** 2 per contributor and 4 per network, above.
- **Task-text screening and the `held` status.** Below.
- **The intake pause.** Below.

### Advisory AI pre-screen

After the submit transaction commits, `ctx.waitUntil` calls Workers AI model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. System instructions are separate from the user message; JSON-encoded task format, body and source URLs are enclosed by fresh data delimiters. Output is validated and only the expected fields are stored in `submissions.prescreen`: booleans `format_ok`, `sources_relevant`, `injection_suspected`, a short `summary`, and `duplicate_of`. The duplicate ID is computed locally with trigram Jaccard similarity (threshold 0.85) against up to 100 earlier submissions for the same task; model-supplied duplicate IDs are ignored.

These notes never accept or reject anything. Sources are not fetched: relevance is the model's assessment of the submitted text and citations, not a claim that a source resolves or supports the work. AI failure or invalid output stores `{"error":"unavailable"}`. A retry of an already-received submission does not launch another pre-screen. Old submissions remain unannotated. The reviewer can act while an annotation is pending.

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
`claim_task` and `submit_work` answer with a friendly "paused for maintenance" message (after the arguments are
validated, before authentication). `/api/stats` reports `intake` and `paused`, and the site shows a banner.

**It is an intake pause, not a write freeze.** It stops new contributions. It does not stop every write, by design:

| Still possible while paused | State it can change |
|---|---|
| `release_task` | A claim is released, the task goes back to `ready`, an event is written |
| `/api/stats`, `/api/tasks` and most MCP calls | Stale claims are expired, and the Town Hall sync can run |
| `POST /api/admin/review`, `POST /api/admin/sync` | Reviews, and a forced sync |
| The hourly cron | Expiry and a forced sync |

Browsing, `my_work`, `submission_status` and the public API keep working. A **full write freeze**, which would also
cover those paths and the cron, is a separate lever that is **planned**, not built. If all writes must stop today,
use the heavier levers in [RUNBOOK.md](RUNBOOK.md).

The status page shows a `gap_reason` when a project is below its target. It says whether nothing has been
routed yet, there are no ready tasks, the reviewer queue is full, or agents just haven't asked for work.

## The four measures

Swarm never blends these into one score. `weekStats` in `hub/src/core.js` computes them per project, per week.

| Measure | What it means | Where it comes from | Status |
|---|---|---|---|
| **Voted** | The public's target share | `allocation.share`, with a `provisional` flag. Labelled provisional when it is a carried-forward fallback | Live |
| **Routed** | Work units handed out through `next_task` this week. Not compute consumed | Distinct (task, contributor) pairs with a standing routed claim (active or submitted), weighted by units. A claim released and re-claimed counts once. Released and expired units are reported separately, as are self-directed units | Live |
| **Accepted** | Units a project reviewer accepted | Accepted submissions, by the week they were reviewed, plus an all-time figure. Pending work is never counted | Live |
| **Impact** | Outcomes of accepted work, such as people reached | Would be project-reported and labelled | **Planned.** Publication links are recorded separately; outcomes are not measured |

`model` and `tokens_est` are optional estimates reported by the contributor's agent. They're shown labelled as
self-reported and are never used in any measure.

## Accounts, ballots and the weekly snapshot

**Passkey accounts** (`webauthn.js`, `accounts.js`). Registration and login are discoverable-credential WebAuthn
ceremonies with `userVerification: required`, attestation `none` and algorithms ES256 and RS256 only.
- **Challenges** are 32 random bytes, stored with a 5-minute expiry and bound to the browser by a hashed `swarm_ceremony`
  cookie. A `DELETE ... RETURNING` consumes one atomically, so a concurrent replay loses. The kind (register or login) must match.
- **Verification** checks the client data type, challenge, exact origin (`RP_ORIGIN`, no cross-origin or top-origin), the
  rpIdHash (`RP_ID`), the UP and UV flags, reserved bits, and that the attested-credential flag matches the ceremony. The
  CBOR decoder is definite-length only, bounded in depth and size, with no tags, floats or duplicate keys. COSE keys must be exactly ES256 on P-256
  or RS256 (2048 bits or more); the key is imported into WebCrypto at registration, so invalid points fail then.
- **Login** takes the account from the stored credential, never from the client. A supplied `userHandle` must match it.
  The signature is checked over `authData || SHA-256(clientDataJSON)`; ES256 signatures are converted from strict DER to raw. The sign counter must increase (0 then 0 is allowed), and is
  updated by compare-and-swap so parallel assertions cannot both succeed.
- **Sessions:** `swarm_sid`, 32 random bytes, stored only as a salted hash, `HttpOnly; Secure; SameSite=Strict`, 30 days. A login deletes the account's
  other sessions (rotation). `POST /api/account/logout` deletes it.
- **Turnstile** guards registration only: siteverify with `TURNSTILE_SECRET`, checking success, hostname and action `register`. A missing secret or failed call refuses registration (fail closed).
- **Limits:** at most 3 accounts per network per rolling day (today's and yesterday's network hash), inserted atomically; plus the rate limiter.
- **CSRF:** every account and ballot write needs `Origin` equal to `RP_ORIGIN` and `X-Swarm: 1`. Cookies are SameSite=Strict.

**Ballots** (`voting.js`). `PUT /api/ballot` stores `{project_id: points}`: integers 0-100, exactly 100 in total, active projects only. Each save appends a version
(`MAX(version)+1` in the same statement as the insert). One ballot per account, equal weight; compute, sponsorship and
contributions never change it.

**The snapshot.** The hourly cron calls `publishSnapshot`. If no `vote_snapshots` row exists for the ISO week, one statement batch inserts it and the
allocation rows, so it publishes once per week (`ON CONFLICT DO NOTHING`, then writes gated on this request's `op`). Eligible: account created before the week
started, not suspended, with a ballot version saved before the week started whose projects are all still active and that still sums to 100. Shares are integer basis points by the largest remainder method (ties broken by project id), so they sum to exactly 10000.
With zero eligible ballots the previous allocation is carried forward with `provisional = 1` and the snapshot's source is `fallback`. Swarm never presents that as a democratic result.

`GET /api/vote/current` and `/api/vote/next` (a projection, labelled `projected`) return basis points. `GET /api/vote/audit` returns aggregates only: eligible voter
count, accounts saving a ballot per day for 30 days, and snapshot history. Routed work is compared only against that week's targets.

## The public JSON API

All `GET`, no key needed. (`/setup` and `/llms.txt`, below, are `GET` too.)

| Endpoint | What |
|---|---|
| `/api/stats` | The week's numbers per project: the four measures, open tasks, pending reviews, active claims, reviewer capacity, gap reason, and `intake` and `paused` |
| `/api/tasks`, `/api/tasks/:id` | The task list (filter by `project`, `status`), and one task with its brief. Held tasks are never listed, and `:id` answers 404 for one |
| `/api/receipts` | Accepted work, newest first: task, project, handle, reviewer, sources, self-reported model and tokens |

### The untrusted-data notice

Task text is written by the public. Every response that carries it has the same top-level `notice` field (the
`UNTRUSTED` text in `hub/src/sync.js`): `/api/tasks`, `/api/tasks/:id` (open and closed), `/api/receipts`,
`/api/admin/pending` and `/api/admin/held`, and the MCP tools `list_tasks`, `get_task`, `next_task`, `claim_task`,
`my_work` and `submission_status`. Briefs also open with the notice and put the project text between data markers.
The notice never replaces screening: held text is still never served publicly. A response's own accounting note lives in a
separate `note` field. `hub/test/notices.test.js` fails if one of these paths loses its notice.

## The MCP server

`POST /mcp`: Streamable HTTP in stateless JSON mode, JSON-RPC 2.0, no SDK. It supports protocol versions
2025-06-18 and 2025-03-26. Batches aren't supported, and requests are limited to 64 KB. The server enforces its
permission groups; the client doesn't have to.

A key goes in an `Authorization: Bearer swk_...` header (preferred, because arguments end up in chat logs), or in a
`contributor_key` argument for clients that can't set headers.

Every `tools/call` is checked against the tool's own `inputSchema` by `hub/src/validate.js` before anything else: before
the intake check, authentication, any database read and any sync. It checks required fields, exact JSON types
(`"50"` is not an integer), integer ranges, string and array limits, patterns, enums, unique items, and rejects unknown
properties. A missing field is "required"; an explicit `null` is a wrong type; `arguments` may be left out but not be
`null`. A failure is JSON-RPC `-32602` (`Invalid arguments for <tool>: ...`), and the message never repeats a value, since
one could be a key. The validator throws on a schema keyword it doesn't implement, and a test runs every tool's schema
through it.

There are 12 tools, listed below by permission group.

### Read: no key

| Tool | What it does |
|---|---|
| `how_to_help` | Plain instructions and the rules for helping. Start here |
| `setup_guide` | The set-up guide for an AI: add this MCP server, pair, and optionally schedule a weekly run with the app's own scheduler. The same text as `/setup`. Optional `client`, exactly one of `claude-code`, `claude-app`, `chatgpt`, `codex`, `cursor` or `other` (the REST `/setup?client=` is more forgiving) |
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
| `POST /api/admin/review` | `{id, decision, note}`, where `decision` is `accept` or `reject`. Records the project's reviewer, updates the task and writes an event, all in one transaction. `note` is a string or left out (anything else is a 400) |
| `POST /api/admin/sync` | Pulls Town Hall and GitHub tasks now, and checks open pull requests |
| `POST /api/admin/projects/github` | `{repo, reviewer, summary}`. Fetches the repository (it must be public), stores its numeric id and creates a **candidate** project with `active = 0`. 201, or 400, 404, 409 |
| `POST /api/admin/projects/:id/activate` | Makes a registered GitHub project active and starts a sync of it. It has no allocation share until a row is added to `allocation`, so `next_task` does not route to it; `claim_task` works |
| `GET /api/admin/submission?id=N` | Accepted Town Hall `research_fix` content for the local publisher, with the untrusted-data notice |
| `POST /api/admin/published` | `{submission_id, url}`; records a public https publication link on accepted work, with one transactional event; identical retries succeed, conflicting URLs return 409 |

`hub/scripts/review.sh` wraps these (`pending`, `held`, `accept`, `reject`, `sync`). A second decision on the same
submission is a 409, and so is a review of a submission whose task is not waiting for review. The private `/ops` console uses the same review transaction, requires a reason, and returns success for an identical decision retry. Opposite decisions still conflict.

## The Town Hall sync

`hub/src/sync.js` turns Town Hall into tasks. Hourly, and on demand, it fetches Town Hall's `problems.json` and
board. For each issue it creates a 3-unit `research_fix` task and a 1-unit `recheck_sources` task, plus a 1-unit
`answer_objection` task for each unanswered objection. Briefs are built from the public text, run through the
screen above (so a task may be created as `held`), and prefixed with a notice that they're data, not
instructions. Tasks are keyed by source, so a re-sync creates nothing twice, and a task that hasn't been claimed
yet follows its source's current text. If an issue disappears from the feed, its `ready` and `held` tasks close.
A near-empty feed (fewer than 3 issues) is treated as a broken fetch, not a removal.

The fetch is bounded. The response is read as a stream and its bytes are counted as they arrive; above 2 MiB the stream
is cancelled and the sync fails, whatever `Content-Length` said (or didn't). The whole fetch has a 10 second deadline,
and only fixed Town Hall URLs are ever fetched.

## The GitHub connector

`hub/src/github.js`. It is read-only: Swarm never needs write access to anyone's repository. It calls the REST API at
`api.github.com` with a `User-Agent` and `Accept: application/vnd.github+json`, and uses `GITHUB_TOKEN` as a bearer
token only if that secret is set (a read-only fine-grained token, for the rate limit; it works without). It reuses
`fetchJson` from `sync.js`, so the same 2 MiB streaming cap and 10 second deadline apply. It runs inside `syncTasks`:
the hourly cron, `POST /api/admin/sync` and the lazy sync all run Town Hall first and then GitHub, under the same sync
lock. A failure in one never stops the other.

**Issues become tasks.** For each active `github` project the sync first fetches `GET /repos/{repo}` and checks that
the numeric id is the registered one. A rename of the same repository is followed and audited
(`project_repo_renamed`); a different repository now holding the name is refused and nothing is synced from it. Then
`GET /repos/{owner}/{repo}/issues?labels=swarm&state=open&per_page=100`. Pull requests in that list are skipped. The task
is keyed `gh:{repo_id}:{issue number}`, has kind `github_issue`, and its output format is "A pull request on {repo} that
resolves #{n}, opened from your own GitHub account, plus a short summary. Submit the PR URL as your first source."
Title and body go through `screen.js` like Town Hall text (links, emails and handles stripped; injection-like text makes
the task `held`, never served). Units come from a label `swarm:1`, `swarm:3` or `swarm:8`; with none, or conflicting
ones, 3. Units are fixed when the task is created. If the label changes later the units do not, and a
`task_size_label_changed` event records the disagreement once, so units never rise without a deliberate, audited
revision (there is no revision endpoint yet: **planned**). An issue that is closed or loses the `swarm` label closes
its `ready` or `held` task (a held task keeps its `held_reason`); claimed and submitted tasks finish normally. Nothing
is closed when the page is full (100 issues), since the list may be cut off. A closed task is not reopened if the issue
is reopened. Only the first 100 issues are read (no paging yet).

**Pull-request submissions.** For a task on a `github` project, `submit_work` needs `sources[0]` to be exactly
`https://github.com/{owner}/{repo}/pull/{n}` (no query, fragment, trailing slash or extra path). Swarm fetches that pull
request and checks that its `base.repo.id` equals the project's `repo_id` (the name is not trusted: a renamed repository is
accepted under its new name, and a different repository under the old name is refused). It must be open and unmerged,
and must not already back another live submission. `pr_number`, the PR author's login, `pr_state` and `pr_repo_id` are
stored with the submission. The author need not match the Swarm handle; receipts show both. Swarm never fetches
any other submitted link.

**Merge = accepted.** Each sync looks at pending pull-request submissions (up to 20 per project) and reads each pull
request from the API. Merged: accepted with `reviewed_by = "GitHub merge by {login}"`. Closed without merge: rejected
with the note "PR closed without merge" (the task returns to the pool, and the usual two-rejection limit applies). Both
go through `reviewSubmission` in `core.js`, the same transaction the admin review endpoint uses, so a repeated check
or a race with a manual review changes nothing and each decision writes the usual `submission_accepted` or
`submission_rejected` event. This keeps the rule that a person reviews the work: the review is the maintainer's merge
or close, made on GitHub, and the maintainer owns the repository. Swarm only records it.

**Rate limits and errors.** A 429, or a 403 with `x-ratelimit-remaining: 0` or `Retry-After`, pauses every GitHub call
until the reset time (at least a minute, at most two hours; `meta.github_backoff_until`). Other errors are recorded in
`meta.github_last_error` and cleared by the next clean run. During a pause, submitting a pull request fails politely and
keeps the claim.

**Webhook (optional).** `POST /api/github/webhook` is a 404 until `GITHUB_WEBHOOK_SECRET` is set. The body (at most 1 MiB)
is checked against `X-Hub-Signature-256` (HMAC-SHA256, compared in constant time by `crypto.subtle.verify`) before
anything is read from it; a bad or missing signature is a 401. `X-GitHub-Delivery` is stored, and a repeated id is
ignored. `ping` is answered; `issues` and `pull_request` for a registered repository start a targeted sync in the
background (202). Anything else is ignored. The payload only says which repository to look at; what happened is read
from the API, so a forged-but-signed payload cannot make Swarm accept anything. Polling stays the source of truth.

**Trust.** Labelling an issue `swarm` needs triage rights on the repository, so the maintainers decide what becomes a
task. Issue text is still treated as untrusted data.

## The tests

`npm test` in `hub/` runs the suite inside workerd (the real Workers runtime) with a local D1 database, using
`@cloudflare/vitest-plugin`. Every migration is applied for real before each test file, so a broken
migration fails the tests. No network, token or deploy is needed. The files in `hub/test/`:

| File | Covers |
|---|---|
| `mcp.test.js` | The protocol, `pair`, the work loop (claim, submit, review, receipt), the claim caps (2 and 4), held tasks never served, the `INTAKE` pause, the admin API and the submission link pre-screen |
| `screen.test.js` | `stripLinks` and `sanitize`, each injection rule, and the Town Hall sync (clean tasks `ready`, injected ones `held`, release after a fix) |
| `setup.test.js` | `/setup` and `/llms.txt`, `?client=`, the guide's rules, and the `setup_guide` tool |
| `units.test.js` | Week boundaries, the network hash for IPv6, and link screening |
| `races.test.js` | Controlled interleavings: a request paused after a real read while a competing one runs (stale release, overlapping expiry sweeps, a stale claim past the submission rule, the daily cap, concurrent claims and reviews), and the two unique indexes |
| `failures.test.js` | An error injected at every statement of claim, submit, review and release: nothing persists, the retry completes; lost-response retries |
| `migration-0003.test.js` | Migration 0003 on a database that already has rows that break the new constraints |
| `validate.test.js` | The validator, and wrong-type, missing and unknown arguments for every MCP tool and the admin `note` |
| `notices.test.js` | The untrusted-data notice on every response that carries task text |
| `accounts.test.js`, `webauthn.test.js` | Passkeys with real generated ES256 and RS256 keys: happy paths, wrong challenge, origin and rpIdHash, missing UV or UP, replayed, expired and cross-kind challenges, counters, COSE and RSA key rejection, DER and CBOR edge cases, session cookie flags, rotation and logout, the Turnstile stub and failures, the three-per-network cap under concurrency, CSRF and the vote-only CSP |
| `voting.test.js` | Ballot validation and versioning, the snapshot (largest remainder, idempotency under concurrency, fallback, eligibility cutoff, week boundaries, rollback), the audit endpoint and the scheduler converging on a 70/30 snapshot |
| `github.test.js` | The connector with a stubbed GitHub: label sizing, skipped pull requests, screening and held issues, closing, idempotency, repository identity and renames, pull-request URL and id checks, merge and close, rate limits and errors, the webhook (valid, invalid, missing secret, replay), registration, the 50/50 allocation, and Town Hall still syncing |
| `migration-0006.test.js` | Migration 0006 on a database that already has rows |
| `sync-limits.test.js` | The feed fetch: the byte cap (no, false and honest `Content-Length`, a multibyte body), and the deadline |
| `helpers.js`, `fault.js`, `apply-migrations.js` | Test setup. `fault.js` wraps `env.DB` so a test can pause a request after a read, or make one statement fail |

CI (`.github/workflows/check.yml`) runs the same suite and checks that migration files are numbered in order.

The local `scripts/publish-townhall.sh` bridge writes an accepted research submission into Town Hall's six-section Markdown template, validates with Town Hall's checker, branches and commits locally, and prints a `gh pr create` command. It never pushes or calls `gh`. It preserves supplied analysis and marks missing sections as unassessed; it never invents costs or risks. `TOWNHALL_SCALE` is an operator choice, not guessed. The receipt shows Published only after the operator explicitly records its live URL.


## The private operator console

`/ops`, `/ops/*` and `/api/ops/*` require Cloudflare Access at the edge **and** a verified `Cf-Access-Jwt-Assertion` in the Worker. Empty `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` or `OPS_EMAILS` disables the whole console, including its JS and CSS. The Worker requires RS256, selects the RSA key by `kid` only from the configured team's certs endpoint, verifies the signature with WebCrypto, checks issuer, audience, numeric expiry and optional not-before (30 seconds skew), and allows only listed email claims. Certs are bounded to 64 KiB and cached for at most one hour. Expired cache entries cannot be used on fetch failure. No Access failure produces 401, 403 or diagnostic hints: it returns the same JSON 404 as an unknown API route. Bearer admin credentials cannot unlock ops.

The console keeps the existing CSP and uses text nodes for all dynamic content. Private assets and API responses are `no-store`. An allowed https source can be opened with `rel="noopener noreferrer"`; other strings remain text. The only place held text is shown is the authenticated held list (and the existing bearer-admin held list).

| Ops endpoint | Behavior |
|---|---|
| `GET /api/ops/overview` | Allocation in force this week, routed units split by public/self-picked origin and project, lifecycle counts, pending count/oldest age, active claims/expiry within one hour, INTAKE and sync state. Ballot-directed routing is labelled planned, with no invented assignments |
| `GET /api/ops/pending` | Pending submissions with task data, plain body, normalized sources, flags, self-reported model/tokens, age and AI annotations |
| `GET /api/ops/held` | Private withheld-task inspection and reasons; release still requires a clean sync |
| `GET /api/ops/projects` | All projects, their pause/capacity state and pending counts |
| `POST /api/ops/review` | `{id, decision, note}`; nonblank reason, shared transaction, idempotent same-decision retries |
| `POST /api/ops/project` | `{id, paused, max_pending}`; changes assignments/capacity and audits the operator email atomically |
| `POST /api/ops/sync` | `{project:"town-hall"}`; runs the existing connector, which also re-screens held text |
| `GET /api/ops/audit?before=N` | Newest 50 events with an exclusive ID cursor; private pairing, churn, rejection-ratio and link-flag aggregates |
| `POST /api/ops/revoke` | `{contributor_id}`; replaces the hash with a random unusable digest and writes an event in one transaction; receipts and claims remain |

Every ops mutation requires POST, `X-Swarm-Ops: 1`, JSON with a 4 KiB streaming size cap, and the exact production Origin. `OPS_ALLOWED_ORIGINS` adds exact local development origins, without wildcards. Ops APIs share the existing network rate limiter after authentication. Pairing signals show network-day hashes with at least four pairings in the last 24 hours (cap five); churn counts claim/release/expire events per contributor over 24 hours; rejection ratios cover all human-reviewed submissions (system repairs excluded); link flags show the latest 100 flagged submissions. These signals never appear on public APIs.

Tests additionally cover Access with generated RSA keys and stubbed certs fetches, ops queries and mutations, pause races, annotations, publication and a populated migration-0005 upgrade. Native Node tests exercise console event handlers and a local disposable Town Hall checkout; `npm test` runs both suites with no new dependencies. No real AI, source fetch, GitHub call, push or deploy runs in tests.

Reference: [Cloudflare Access token validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) and [Workers AI JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/).
