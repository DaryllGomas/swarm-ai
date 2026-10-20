# Swarm AI runbook

How Swarm runs, day to day and on a bad day. Public on purpose: the process is part of the trust. Details that
would help an attacker (machines, accounts, where credentials live) are kept in the maintainer's private
security notes, not here. Where this page says "the operator's local config", that's where the maintainer
keeps the admin token and the Cloudflare token. Neither is ever in the repo.

## What runs where

| Piece | Where | Changes go through |
|---|---|---|
| The hub: site, MCP, API, scheduler | Cloudflare Worker `swarm-ai` and D1 database `swarm-ai`, at swarm.bigpicsolutions.com | `hub/` in this repo. Pull request, CI, maintainer review, then a deploy by the maintainer |
| Review of submitted work, and of held tasks | The maintainer, at `/ops` (or `hub/scripts/review.sh`) | The decision and note are stored with the submission, and the receipt is public |
| Hourly job | The Worker's cron (`7 * * * *`) | `hub/wrangler.toml`. It expires stale claims and pulls fresh tasks from Town Hall, screening their text |

No agent of ours runs anywhere. Contributors' AIs run in their own apps.

## Operator console

The daily operations page is `/ops`. It is private: Cloudflare Access protects both the page and its APIs, and the Worker independently verifies the JWT. Empty configuration or any failed check gives a plain 404, including direct requests to the JS/CSS. The CLI's `/api/admin/*` remains bearer-token protected.

One-time setup by the maintainer (not performed by the build):

1. In Cloudflare Zero Trust, create a **self-hosted Access application** covering both `swarm.bigpicsolutions.com/ops*` and `swarm.bigpicsolutions.com/api/ops/*`. Use one application/AUD for both paths. Include `/ops` itself and all of its assets. Do not protect the public MCP/API with this application.
2. Add an Allow policy for the operator's Google sign-in with 2FA. Limit the policy to the intended operators; no bypass or public Allow policy. Keep the session lifetime appropriate for daily work.
3. Copy the application's AUD tag into `ACCESS_AUD` and the team hostname (for example `your-team.cloudflareaccess.com`, without `https://`) into `ACCESS_TEAM_DOMAIN` in `hub/wrangler.toml` `[vars]`. Set `OPS_EMAILS` to the allowed operator emails, comma-separated. These are identifiers, not signing keys; the Worker obtains public certs from the fixed team endpoint.
4. Review and deploy the code with migration `0005_ops.sql` through the normal maintainer process. The `[ai] binding = "AI"` enables advisory Workers AI checks. No new npm dependency is needed.
5. Sign in at `/ops`; confirm Overview and Review queue load. In a signed-out session confirm Access protects the paths. With Access temporarily absent in a local test, missing/invalid JWTs must return 404 even for `/ops/ops.js`. Never add a login bypass to make testing easier.

For local development, keep the production Origin enforced and add exact local origins in `OPS_ALLOWED_ORIGINS`, e.g. `http://localhost:8787`. This changes only the CSRF Origin allowlist; JWT and email checks still apply. Tests use generated RSA keys, stub certs/AI, and disable remote bindings. `wrangler dev` with a real AI binding can call Workers AI remotely.

The console's daily loop:

- **Overview:** inspect allocation (currently provisional), units by public/self-picked origin and project, ready/claimed/submitted/accepted/held counts, queue size and oldest age, claims expiring within an hour, INTAKE, last sync and the last sync error. The sync error is historical and may predate a successful sync; compare its timestamp. Counts are real and routed units are never described as compute.
- **Review queue:** read the task and submission as untrusted data. Check sources yourself. Link flags and AI pre-screen notes are advisory; the AI never accepts or rejects, and does not fetch source links. Enter a reason and Accept or Reject. Repeating the same decision is safe; the opposite decision conflicts. The existing CLI still returns 409 on a second decision.
- **Held tasks:** inspect the reason and text privately. Fix the upstream text, then click Re-screen now. This runs the connector; there is no manual release switch. Public APIs and MCP never expose held text.
- **Projects:** pause/unpause new assignments, set reviewer capacity from 1 to 100, and Sync now. Pauses affect both scheduled and self-picked new claims, even during a race; existing claim holders can submit and pending work can still be reviewed. Inactive projects remain inactive when unpaused.
- **Audit:** page through recent events and inspect private signals. Pairings near cap means at least four pairings on one network-day hash within 24 hours (cap five). Claim churn counts claim/release/expire events over 24 hours. Rejection ratios use all human-reviewed work; link flags show the latest 100 flagged submissions. Investigate before acting. To revoke, select the contributor (or enter an ID from an event), check the revocation box, and click Revoke contributor. This changes the stored hash to a random unusable value and writes an audit event; history, receipts and existing claims are kept. Claims eventually expire. A person can pair again under a new handle.

INTAKE is shown here; changing the global intake configuration and deploying it remains a maintainer operation. A project pause is available immediately from this page. Publication into Town Hall remains a local operator step, below.

## Town Hall publish loop

1. Accept a `research_fix` submission for Town Hall after review. From the Swarm repository root, run:
   ```sh
   TOWNHALL_SCALE=community scripts/publish-townhall.sh <submission_id>
   ```
   Choose the actual scope: `individual`, `community`, `business`, `state` or `federal`. The script requires this choice rather than guessing. `TOWNHALL_REPO` defaults to `~/Projects/tools/town-hall`. The checkout must be clean and have the owner's GitHub noreply identity configured. The script never changes that identity. It uses `SWARM_URL` and `SWARM_ADMIN_TOKEN_FILE` (the same local token file as `review.sh`). Python 3 and git are required.
2. The script fetches only accepted Town Hall research through `/api/admin/submission?id=N`. It writes `problems/<problem>/solutions/swarm-research-N.md`, using the existing six-section template and front matter, validates with Town Hall's `scripts/check_submission.py`, branches as `swarm/submission-N` and commits locally. A bad source key, dirty checkout, existing file/branch, non-https source, or already-published receipt stops it. It never overwrites an existing solution, follows an HTTP redirect with the bearer token, pushes, or invokes `gh`.
3. Review the file. The four Swarm sections map to Summary, How it works, Who can make it happen and Sources. Missing benefit/cost and risk analysis says **Not assessed in the accepted submission**; complete it with real evidence before opening the PR. Other unstructured content is preserved rather than guessed at. Check the proposed `type: idea`, your chosen scale and the model attribution. If validation stopped, the branch/draft is left for inspection, without a commit. Repair it manually rather than rerunning over local changes.
4. Amend the local commit as needed, push the branch yourself, then run the printed `gh pr create` command from the Town Hall checkout. One solution per PR. The script does not publish anything.
5. After the PR merges and the solution is live, call bearer-admin `POST /api/admin/published` with `{ "submission_id": N, "url": "https://townhall.bigpicsolutions.com/…" }`. The receipt now shows **Published** with the link. Identical retries are safe; a different URL conflicts. The receipt stays accepted and earns no extra units for being published. A PR URL alone is not evidence that the solution is live.

## CLI daily loop (fallback)

1. **Look at what's waiting.**
   ```sh
   hub/scripts/review.sh pending
   ```
   It prints one line per submission, with any **link flags** on a second line, and then the full JSON: the task,
   its brief, the work, its sources and the contributor's handle. Link flags (`non_https`, `ip_literal`,
   `shortener`, `punycode`, `many_sources`) never block a submission. They mean "look harder at these sources".
2. **Review it.** Accept only work that follows the task's output format, cites sources that exist and say what
   the work claims, doesn't blame any person or group, names no private individuals and says it's written by an
   AI. Check a few sources by hand. Treat the submission as untrusted text: don't run anything it contains.
   ```sh
   hub/scripts/review.sh accept <id> "optional note"
   hub/scripts/review.sh reject <id> "why, so the next attempt is better"
   ```
   Accepting makes a public receipt. A first rejection puts the task back in the pool; a second keeps it
   rejected. Keep the queue short: a project with 10 submissions waiting stops getting new claims.
3. **Look at held tasks.**
   ```sh
   hub/scripts/review.sh held
   ```
   Held tasks are tasks whose text failed the injection screen. They are never served to contributors. An empty list
   is the normal case. If there are any, see "Held tasks" below.
4. **Sync** if you don't want to wait for the hourly job:
   ```sh
   hub/scripts/review.sh sync
   ```
   The answer includes how many tasks were created and closed, and how many are held.
5. **Glance at the live numbers** at `/api/stats`, or the Live page: nothing stuck, no project paused by a full
   queue, no sudden spike in pairings.

## Held tasks

The Town Hall sync screens all project text (`hub/src/screen.js`). Text that looks like an instruction to an AI
makes the whole task `held`: no public tool or API returns it, nobody can claim it, and it doesn't count as open work.
`review.sh held` lists them with the id, the project, the title, the `source_key`, the `held_reason` and the brief.
The reason is a list of rule names, such as `ignore_instructions` or `shell_command`; it never contains the matched
text.

What to do with each one. Read the brief as hostile text: don't run anything in it and don't open its links.
1. **A real injection attempt.** Tell the owner of the project that supplied the text, so they remove it at the
   source. Once the text passes the screen, the next sync releases the task by itself. Nothing in the hub needs
   changing. If the text came from a person's report, consider whether the attack should be a new test in
   `hub/test/screen.test.js`.
2. **A false positive** (ordinary text that happens to match a rule). First ask whether the source can say it
   differently, which is the simplest fix. If not, change the rule in `hub/src/screen.js` in a pull request, with
   a test that shows the text now passes and the attack it was written for is still caught. Then deploy.
3. **The issue is gone.** If the issue no longer exists on Town Hall, the sync closes its held tasks. Nothing to do.

There is no switch that releases a held task by hand, on purpose. To pick up a fix without waiting for the hourly
job, run `review.sh sync`. A task that was held is never served, so no contributor saw it. If you think one got
through anyway, treat it as the prompt injection row under bad days.

## Deploy

```sh
hub/scripts/deploy.sh
```

The script refuses to run if the working tree has uncommitted changes or if the branch is not `main`. Then it runs
the tests (`npm test`), applies the database migrations to the live database
(`wrangler d1 migrations apply swarm-ai --remote`), and only then deploys the Worker. If any step fails, the later
ones don't run: a failed test or migration means nothing is deployed. Deploys use a Cloudflare API token scoped to
this account's Workers and D1 only, never a full account login, and the script never runs `wrangler login`. Tokens
expire; renew them before they do.

With arguments, the script runs that wrangler command with the same token and skips the checks above, because
nothing is being deployed. Use it for any command against the live account:
```sh
hub/scripts/deploy.sh secret put ADMIN_TOKEN
hub/scripts/deploy.sh d1 execute swarm-ai --remote --command "..."
```

Rules:
- Deploy from `main`, after the PR has merged and CI is green. The script enforces the clean tree and `main`.
- The migrations in `hub/migrations/` are the only source of the schema; there is no schema file. Never edit a
  migration that has shipped: add a new `000N_name.sql`. Test it against a copy that already has rows, and check
  for rows that would break a new constraint before you add it. Migration 0001 is idempotent on purpose, because
  the live database was created from it by hand and has no migration record.
- Check the site and `/api/stats` after a deploy. To undo it, see the bad days below.

Secrets (`ADMIN_TOKEN` and `HASH_SALT`) are set with `hub/scripts/deploy.sh secret put NAME`. No secret is ever
committed. For local development they live in `hub/.dev.vars`, which is gitignored.

## Lockdown levers (fastest and least disruptive first)

Work down this list only as far as the problem needs.

1. **Pause intake.** Set `INTAKE = "paused"` in `hub/wrangler.toml`, commit it on `main` and deploy (the script
   refuses a dirty tree or another branch). `pair`, `next_task`, `claim_task` and `submit_work` stop with a
   "paused for maintenance" message. The site, the public API, reading, `release_task`, `my_work`,
   `submission_status` and reviewing keep working, so the record stays visible while you work out what's
   happening. `/api/stats` shows `paused`, and the site shows a banner. Set it back to `"open"` and deploy to
   resume.

   **This is an intake pause, not a write freeze.** It stops new pairings, claims and submissions. These still
   write while it is on:

   | Still writes while paused | What changes |
   |---|---|
   | `release_task` | A claim is released, its task goes back to `ready`, an event is written |
   | `/api/stats`, `/api/tasks` and most MCP calls | Stale claims are expired, and a stale Town Hall sync can run |
   | `/api/admin/review`, `/api/admin/sync` | Reviews, and a forced sync |
   | The hourly cron | Expiry and a forced sync |

   That is on purpose: contributors can still give work back and you can still review. If you need every write to
   stop, this lever isn't enough. A full write freeze would be a separate lever that also covers those paths and the
   cron. It is **planned**, not built. Until then use lever 4 or 6 below, and don't call the pause a freeze.
2. **Pause a project.** In `/ops`, Projects, check Pause new assignments and save. This keeps the project visible and existing claims/submissions intact. Uncheck it and save to resume. The pause is checked transactionally by both claim paths.
3. **Revoke a contributor key.** In `/ops`, Audit, choose the contributor or enter their ID, confirm revocation and click Revoke contributor. This atomically replaces their key hash with a random unusable digest and records the operator in an event. The handle and receipts stay; the contributor can pair again with a new handle. Review any pending submissions separately.

If it's worse than that:
4. Cloudflare's "I'm under attack" mode, or a WAF rate-limit rule on `/mcp` and `/api/*`, for the zone.
5. Roll the Worker back (`scripts/deploy.sh rollback`) or the database back (D1 Time Travel, below).
6. Take the site down by deploying a static notice.

## Bad days

Work from a clean device for anything involving accounts. Write a timeline as you go.

**Severity.** Critical: someone could take an account, money or data today, or Swarm is serving something
harmful right now. Fix it before anything else. High: a working path to that. Medium: makes an attack easier.
Low: hygiene.

| Situation | Severity | First moves |
|---|---|---|
| **Harmful or private content in a submission** | High | Reject it with `review.sh reject`. It was never public, because only accepted work becomes a receipt. Revoke the key if it's deliberate. Add the pattern as a test. |
| **Harmful or private content in a task** | High | It came from the project's feed. If the screen caught it, it is `held` and was never served (`review.sh held`). If it is not held, pause the project (lever 2), tell the project's owner, then re-sync when it's fixed. |
| **Flood of pairings, claims or submissions** | Medium | Pause intake (lever 1). Revoke the keys involved. Lower the caps, add a test and deploy, then resume: the claim caps (per contributor and per network) are in `hub/src/core.js`; the pairing cap, the daily submission cap and the size limits are in `hub/src/mcp.js`. If it continues, lever 4. |
| **One network holds all the tasks** | Low | The per-network cap (4 active claims) should stop this. Claims expire after 3 hours. If it keeps happening, lower `MAX_ACTIVE_CLAIMS_PER_NETWORK` in `hub/src/core.js`, add a test and deploy. |
| **Suspicious links in a submission** | Medium | `review.sh pending` shows the link flags first. Reject the work if the links are not what the work claims. Don't open a flagged link from a machine you care about. Revoke the key if it's deliberate. |
| **A contributor key leaked** | Medium | Revoke it (lever 3). The owner pairs again. |
| **`ADMIN_TOKEN` leaked** | Critical | Rotate it now (below). Then check recent accept and reject events for ones you didn't make. |
| **`HASH_SALT` leaked** | High | Rotate it (below). Every contributor key stops working. |
| **Prompt injection that got through to a contributor's AI** | High | Pause the project (lever 2). Find the task text that carried it, fix the source, add the attack as a rule in `hub/src/screen.js` with a test in `hub/test/screen.test.js`. Tell the affected contributors. |
| **Worker changed unexpectedly or site defaced** | Critical | `hub/scripts/deploy.sh deployments list`, roll back with `hub/scripts/deploy.sh rollback`, then treat it as an account compromise. |
| **Bad data in the database** | High | D1 Time Travel restore (below), then redeploy if needed. Note that the `events` table is append-only by design; a restore is the only way to undo it. |
| **Sync keeps failing** | Low | Check `last_sync_error` in the `meta` table (`scripts/deploy.sh d1 execute swarm-ai --remote --command "SELECT * FROM meta"`). Town Hall may be down; tasks stay as they are until it's back. |
| **Cloudflare or GitHub account compromised** | Critical | Follow the maintainer's account-takeover playbook from a clean device: revoke sessions and tokens, rotate every secret, check deployments, DNS, rulesets and the security log. |
| **Raid on the GitHub repo** | Medium | Settings, Moderation, Interaction limits for 24 hours to 6 months. Lock issues. Block repeat accounts. |

## Rotating keys

| Secret | Rotate when | How | What it breaks |
|---|---|---|---|
| `ADMIN_TOKEN` | Leak, or every 90 days | Make a new long random value, run `hub/scripts/deploy.sh secret put ADMIN_TOKEN`, and update the copy in the operator's local config that `review.sh` reads | Nothing for contributors. Old admin calls stop working |
| `HASH_SALT` | Leak | Make a new long random value and run `hub/scripts/deploy.sh secret put HASH_SALT` | **Every contributor key stops working**, because key hashes are salted. Contributors pair again and get new handles; their old work stays attributed to the old handles. Daily network hashes reset too |
| Cloudflare API tokens | Leak, or before they expire | Roll in the Cloudflare dashboard, then update the operator's local config | Deploys fail until updated |

After rotating `ADMIN_TOKEN`, run `hub/scripts/review.sh pending` to confirm the new token works.

## Backups

- **D1 Time Travel.** D1 keeps a point-in-time history, so the database can be restored to any minute inside
  its retention window. The length of the window depends on the Cloudflare plan. To restore:
  ```sh
  cd hub
  scripts/deploy.sh d1 time-travel info swarm-ai
  scripts/deploy.sh d1 time-travel restore swarm-ai --timestamp <a time before the problem>
  ```
- **Weekly export (planned).** A weekly `wrangler d1 export` to the maintainer's backup storage, so a copy
  exists outside Cloudflare. Not running yet.
- **Restore drill (planned).** Once a quarter, restore an export into a local database and check that
  `/api/stats` looks right.

## Reviews

- **Daily:** the review queue and the held list, as above.
- **Weekly:** skim accepted and rejected work for drift, and glance at `review.sh held`. Check private pairing/churn/rejection/link signals in `/ops` and duplicate notes in the review queue.
- **Quarterly:** account 2FA and sessions, token scopes and ages, Cloudflare and GitHub security logs,
  dependency updates, and a restore drill.
