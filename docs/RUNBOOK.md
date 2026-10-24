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
| Hourly job | The Worker's cron (`7 * * * *`) | `hub/wrangler.toml`. It expires stale claims, pulls fresh tasks from Town Hall and GitHub (screening their text) and checks open pull requests |
| GitHub connector | In the same Worker (`hub/src/github.js`), same hourly cron | Issues labelled `swarm` on registered public repos become tasks; merged pull requests wait for your confirmation (a merge is not auto-accept). Read-only |

No agent of ours runs anywhere. Contributors' AIs run in their own apps.

## Operator console

The daily operations page is `/ops`. It is private: Cloudflare Access protects both the page and its APIs, and the Worker independently verifies the JWT. Empty configuration or any failed check gives a plain 404, including direct requests to the JS/CSS. The CLI's `/api/admin/*` remains bearer-token protected.

One-time setup by the maintainer (not performed by the build):

1. In Cloudflare Zero Trust, create a **self-hosted Access application** covering both `swarm.bigpicsolutions.com/ops*` and `swarm.bigpicsolutions.com/api/ops/*`. Use one application/AUD for both paths. Include `/ops` itself and all of its assets. Do not protect the public MCP/API with this application.
2. Add an Allow policy for the operator's Google sign-in with 2FA. Limit the policy to the intended operators; no bypass or public Allow policy. Keep the session lifetime appropriate for daily work.
3. Copy the application's AUD tag into `ACCESS_AUD` and the team hostname (for example `your-team.cloudflareaccess.com`, without `https://`) into `ACCESS_TEAM_DOMAIN` in `hub/wrangler.toml` `[vars]`. Set the allowed operator emails as the Worker secret `OPS_EMAILS` (comma-separated) with `hub/scripts/deploy.sh secret put OPS_EMAILS`, never in `wrangler.toml`, so they stay out of the public repo. These are identifiers, not signing keys; the Worker obtains public certs from the fixed team endpoint.
4. Review and deploy the code with migration `0005_ops.sql` through the normal maintainer process. The `[ai] binding = "AI"` enables advisory Workers AI checks. No new npm dependency is needed.
5. Sign in at `/ops`; confirm Overview and Review queue load. In a signed-out session confirm Access protects the paths. With Access temporarily absent in a local test, missing/invalid JWTs must return 404 even for `/ops/ops.js`. Never add a login bypass to make testing easier.

For local development, keep the production Origin enforced and add exact local origins in `OPS_ALLOWED_ORIGINS`, e.g. `http://localhost:8787`. This changes only the CSRF Origin allowlist; JWT and email checks still apply. Tests use generated RSA keys, stub certs/AI, and disable remote bindings. `wrangler dev` with a real AI binding can call Workers AI remotely.

The console's daily loop:

- **Overview:** inspect allocation (currently provisional), ready/claimed/submitted/accepted/held counts, queue size and oldest age, claims expiring within an hour, INTAKE, last sync and the last sync error. There are no routed units and no origin figure here, by design (a number of units handed out, or how a task was routed, could be used to work out what people chose). The sync error is historical and may predate a successful sync; compare its timestamp.
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

## GitHub connector

Swarm AI itself is a project (`swarm-ai`, repo `DaryllGomas/swarm-ai`). The connector is read-only and needs no secret
to work.

- **Label an issue to make it a task.** Add the label `swarm`, and one size label: `swarm:1` (small), `swarm:3`
  (the default) or `swarm:8` (large). Only people with triage rights on the repository can label, so labelling is the
  approval. Create the labels once in the repository. The next sync (hourly, or `review.sh sync`) creates the task.
  Closing the issue, or removing `swarm`, closes the task (unless someone has claimed it).
- **Changing a size later does not change the task.** The task keeps its units; a `task_size_label_changed` event records
  the disagreement. Units are what work was routed against, so they change only on purpose.
- **A task shows up held?** The issue text tripped the screen. See "Held tasks": fix the issue text; the next sync releases it.
- **Reviewing a code task.** The contributor submits their pull request link. Review it on GitHub. **Merging it does not accept the
  submission.** The next sync (or the webhook) marks it "merged, needs reviewer confirmation" in `/ops` and in
  `GET /api/admin/pending`; you then accept or reject it there (or with `review.sh`) like any other submission. Check that
  the pull request really resolves the task's issue and that the submitter is the author or has the author's say: the
  queue shows the PR author and an issue-mention hint (does the title or body name the issue), and the hint is not proof.
  Close it without merging and the submission is rejected automatically as "PR closed without merge".
  Put `Fixes #N` in the pull request so the issue closes with the merge.
- **Optional `GITHUB_TOKEN`.** Without it, GitHub allows 60 requests an hour per IP, shared with every other Worker on the
  same address, so it can run dry. Create a fine-grained token with no permissions beyond read access to public
  repositories, then `wrangler secret put GITHUB_TOKEN`. It is only sent to api.github.com.
- **Optional webhook for speed.** Generate a long random string, `wrangler secret put GITHUB_WEBHOOK_SECRET`, then in the
  repository's settings add a webhook to `https://swarm.bigpicsolutions.com/api/github/webhook`, content type
  `application/json`, the same secret, and the events "Issues" and "Pull requests". Check "Recent deliveries" in GitHub:
  202 means queued, 401 a wrong secret, 404 no secret set. Remove the secret to turn it off. Polling still runs hourly.
- **Rate-limited or broken?** `github_last_error` and `github_backoff_until` in the `meta` table say what happened. A
  rate limit clears itself at the reset time; setting `GITHUB_TOKEN` helps.
- **Add another repository.** `POST /api/admin/projects/github` with `{"repo": "owner/name", "reviewer": "...", "summary":
  "..."}` (bearer admin token) registers a candidate (inactive). `POST /api/admin/projects/<id>/activate` turns it on. It
  gets no routed work until an `allocation` row gives it a share (in basis points, 10000 = 100%; no endpoint for that yet; ballots only count active projects); agents can still claim its
  tasks directly.
- **If the repository is renamed**, nothing breaks: the id is what is checked, and the stored name follows. If the old
  name is taken by a different repository, the sync refuses it and says so in `github_last_error`.

## Voting: snapshots, suspending an account, Turnstile

- **Snapshots.** The hourly cron publishes the week's snapshot at the first run after Monday 00:00 UTC. Check it:
  `wrangler d1 execute swarm-ai --remote --command "SELECT * FROM vote_snapshots ORDER BY week DESC LIMIT 3"`, or open `/api/vote/audit`.
  `source = 'ballots'` is a real result; `fallback` means no eligible ballots, so the last allocation was carried forward as provisional.
  A week publishes once and cannot be re-run. To correct a bad snapshot, delete that week's `vote_snapshots` and `allocation` rows
  in one `d1 execute` batch, and the next hourly run republishes it. Ballots themselves are append-only and cannot be edited.
- **Suspend an account.** Find the voter's short id (the first 8 characters shown on /vote) and run
  `UPDATE accounts SET suspended = 1 WHERE id LIKE '<short>%';` Their sessions stop working at once, they cannot sign in, and they no longer count in the next snapshot. `suspended = 0` restores them. Appeals go to the contact address on the Rules page (a TODO until the maintainer sets one).
- **Turnstile.** The site key is the public var `TURNSTILE_SITE_KEY`. Set the secret with `wrangler secret put TURNSTILE_SECRET`. Without it, or if Cloudflare is unreachable,
  registration is refused; existing voters can still sign in. Rotate by putting a new secret. The widget action must stay `register`.
- **Local dev.** Set `RP_ID = "localhost"` and `RP_ORIGIN = "http://localhost:8787"` in `.dev.vars`. The session cookie is `Secure`, which browsers accept on localhost.
- **Account abuse.** At most 3 accounts a day per network. Changing that is a code change.

## Phase 4: linked AIs, steering and MCP sign-in

- **Before the first deploy that includes Phase 4.** Migration 0008 is applied by `hub/scripts/deploy.sh` before the Worker. It backfills `claims.routing_origin` from `routed` (1 to `public_routed`, 0 to `self_picked`) and adds the link tables. Check:
  `wrangler d1 execute swarm-ai --remote --command "SELECT routing_origin, routed, COUNT(*) FROM claims GROUP BY 1, 2"` (there should be no `ballot_directed` row yet, and no row where `routed` and the origin disagree).
  No KV namespace is needed any more: MCP sign-in keeps its state in D1 (migration 0014). The `OAUTH_KV` binding stays in `wrangler.toml` unused; delete the three lines and then the namespace once the OAuth release is live. No new secret is needed.
- **Steering.** A linked contributor's `next_task` follows their voter's ballot. Nothing public and nothing in the console shows how any task was routed (public allocation, ballot or self-pick): `/api/stats` carries only the allocation, open tasks and accepted results. Once a week `/api/analytics` shows the closed week's claimed units with every route added together beside the allocation; that check is coarse by design. The scheduler still counts public-routed units internally.
  Fallback work is `public_routed` by design. The console cannot tell you what was routed how; the database can (`SELECT routing_origin, COUNT(*) FROM claims GROUP BY 1`). That is a direct database read, outside the console's boundary, and it shows which work was steered or picked per contributor (it holds `routing_origin` next to the contributor): do it only for abuse, and do not copy the result anywhere.
- **Unlink someone.** Their `/me` page does it. Operator: `DELETE FROM account_links WHERE account LIKE '<short>%';` then the contributor follows the public split at once. Events `account_linked` and `account_unlinked` carry no account id (older ones had it NULLed by migration 0012), and the console shows them with no contributor, actor or detail.
- **Suspending an account** also stops its steering (its linked contributor follows the public split) and its link codes.
- **Who owns a contributor.** `contributors.owner_account` (the account that created it by passkey sign-in, or first linked it). Unlinking does not change ownership, and `link_account` refuses a contributor owned by another account. Check: `SELECT handle, owner_account FROM contributors WHERE handle = '<handle>';`. Do not edit it casually: a trigger blocks changes, and passkey sign-in trusts it.
- **Link codes.** They last 10 minutes, work once and are stored hashed. A wrong code is counted in `link_attempts` (5 an hour per contributor, 20 an hour per network); the cron deletes entries after a day. To let someone retry now:
  `DELETE FROM link_attempts WHERE who = 'c:<contributor id>';`
- **MCP sign-in (OAuth).** State lives in the D1 tables `oauth_clients`, `oauth_consents`, `oauth_grants`, `oauth_codes` and `oauth_tokens` (migration 0014; only hashes of secrets). To switch it off quickly, set `OAUTH = "off"` in `hub/wrangler.toml` and deploy: `/authorize` answers 503, the OAuth endpoints and discovery documents stop, a call with an OAuth token is not read as one, and contributor keys and public tools carry on. Turning it off does not delete grants.
  To cut off one person, revoke their contributor in `/ops` (lever 3 below): that cancels every OAuth grant of the contributor in the same transaction (`revoked_reason = 'operator_revoked'`), so its access and refresh tokens fail at once. To cancel one connection by hand: `UPDATE oauth_grants SET revoked_at = <ms now>, revoked_reason = 'revoked' WHERE id = '<grant id>' AND revoked_at IS NULL;` (every token checks its grant on each call). To see connections: `SELECT id, client, contributor, scope, created, revoked_at, revoked_reason FROM oauth_grants ORDER BY created DESC LIMIT 20;` A grant revoked with `refresh_reuse` or `code_reuse` means a used refresh token or code came back, which is the signal for a copied token; the person is told to connect again.
  Dynamic registration is limited three ways: the per-network burst limiter, 10 new apps per network per rolling day, and 5000 apps in total (a stuck cap clears itself: apps with no grant are deleted a week after they register). The issuer and token audience come from `RP_ORIGIN`, so it must match the live origin exactly.
- **Local OAuth.** With `RP_ORIGIN=http://localhost:8787` the issuer and audience are `http://localhost:8787`. D1 is simulated locally.
- **Smoke test without Workers AI.** Copy `wrangler.toml` to a scratch folder with the `[ai]` block removed and absolute paths, apply migrations with `--persist-to <scratch>`, run `wrangler dev --persist-to <scratch>`, check `/me`, `/authorize`, the two `/.well-known/oauth-*` documents and MCP `tools/list`, then stop the server by its PID.

## Privacy and trust: what the hourly job does, and what you do

The privacy page promises things this runbook has to keep true. The code in `hub/src/privacy.js`, `rollup.js` and `trust.js` does the work; these are the checks and the human steps.

- **Hourly job order.** (1) `forgetNetworks`: delete `network_keys` whose whole day is older than two days and NULL every `claims.network`, `contributors.pair_ip`, `accounts.network` older than two days. (2) `purgeOAuth`: delete expired OAuth consent pages, expired tokens, codes, cancelled grants (after a week) and apps with no grant (after a week), and clear the 30-second retry copies. (3) the weekly snapshot (draws the noise once). (4) the weekly maintenance: expire claims, roll up closed weeks, then purge. (5) expire sessions, challenges, codes and old link attempts, (6) expire claims, (7) sync. Each of (1), (2) and (4) logs and carries on if it fails, so a failure never blocks the rest. Look in the Worker logs for `forgetNetworks failed`, `oauth purge failed` or `weekly maintenance failed`.
- **Key deletion check.** `scripts/deploy.sh d1 execute swarm-ai --remote --command "SELECT day FROM network_keys ORDER BY day"` should list at most three days (today, yesterday, and the day before). Anything older means the job is not running: investigate before anything else, because the privacy page says those codes are irreversible once their key is deleted. `SELECT COUNT(*) FROM claims WHERE network IS NOT NULL AND claimed_at < <now minus 2 days in ms>` should be 0.
- **Weekly rollup.** The first hourly run after Monday 00:00 UTC rolls up each closed week that is not in `rollup_weeks`, oldest first. Check: `SELECT * FROM rollup_weeks ORDER BY week DESC LIMIT 3`. It runs once per week and never rewrites a week; if a week's numbers are wrong, fix the cause, then `DELETE FROM weekly_project_stats / rollup_weeks WHERE week = '<monday>'` in one batch and the next run recomputes it (only possible while the underlying rows still exist; after a `weekly_purge` they do not for that account's items). **Do this only for a broken week:** the rollup draws no noise, but the week's figures were public once and a recomputed week can differ from them. If a week fails, the job stops at it, retries every hour, and the purge does not touch that week or later.
- **`weekly_purge`.** After each rollup the job deletes the per-item detail of those accounts from rolled-up weeks. It is idempotent. An accepted write-up that a `mission` project still has to publish keeps its body until it is published, and for at most 30 days after review; then the body is erased whether or not it was published (the link to the contributor is cut regardless). Publish within 30 days or the text is gone from the live database. Check what ran: `SELECT ts, detail FROM events WHERE type = 'history_purged' ORDER BY id DESC LIMIT 5` (counts only).
- **Delete-account requests.** The person does it themselves on `/me` (passkey session and a typed confirmation). If someone who lost their passkey asks, there is no way to prove an account is theirs, and none is offered: say so. Never delete an account by hand from SQL unless a court order requires it; if you must, use `deleteAccount` in `hub/src/privacy.js` through a one-off script rather than `DELETE`, because the order of statements matters (events scrubbed first, ballots re-labelled `gone:`, then the account). Record that it happened in the transparency report if the law allows.
- **Handle removal** is `remove_handle` (tool) or `/me`. Operators do not do it for people.
- **Deleting an account also ends its OAuth connections.** `deleteAccount` cancels every `oauth_grants` row of the contributors in the same transaction (`revoked_reason = 'account_deleted'`), so access and refresh tokens fail at that commit; the hourly job deletes the rows a week later. Check a deletion: `SELECT id, revoked_at, revoked_reason FROM oauth_grants WHERE contributor = <id>;` should show `account_deleted`. There is no KV state to check. **Before turning OAuth on:** Codex's review of this server, then a real browser test of the passkey step and of each client (PLAN.md).
- **The weekly vote and noise.** The Monday snapshot adds Laplace noise (epsilon 1, scale 100 points) to the point totals and publishes the noised split, then drops the exact tally. This is a practical protection for the split, **not a formal differential-privacy guarantee** for the release (the 5-ballot threshold, the count bucket and the fallback are not noised); say nothing stronger. Never add logging, a debug flag or a copy of the exact tally, and never re-run a published week. Repeated weekly releases: epsilon 1 each, up to 52 over a year under basic composition for a stable electorate, and no tighter figure is claimed (DATA-POLICY.md, "The weekly vote, noise and k-anonymity"). Smaller epsilon, a larger electorate or fewer releases is a maintainer's call, made in `hub/src/dp.js` with the tests. A week with no new result is either fewer than 5 eligible ballots or (rarely) unusable noise; the pages deliberately do not say which.
- **Pairing reveals whether a handle exists.** Known, disclosed, planned (DATA-POLICY.md, "Pairing and handles"). Agents are told to leave the handle out when they pair.
- **Transparency report: re-date it every month.** On the first working day of each month: (1) ask whether anything in `hub/src/trust.js` is still true: no legal requests received, nothing handed over, no gag orders; (2) if it is, change `TRANSPARENCY_AS_OF` in `hub/src/trust.js` to today's date (that constant is the only place the date lives; the page, `/api/transparency` and the test all read it), commit, open a pull request and deploy; (3) if a request has arrived and the law lets you say so, update `LEGAL_REQUESTS_RECEIVED`, `DATA_HANDED_OVER` and add a dated entry to `hub/public/transparency.html`; if a gag order stops you saying so, **do not re-date**: let the date lapse. The page shows an "overdue" warning on its own after 45 days, and says on the page that a lapse is meaningful. Put the re-dating on the maintainer's calendar as a monthly recurring event, and a second reminder for day 40.
- **Yearly: `security.txt`.** `SECURITY_TXT_EXPIRES` in `hub/src/trust.js` is a fixed date just under a year out. Renew it each year with the transparency re-dating nearest to it (the test `trust.test.js` checks its format).
- **Before launch: turn on GitHub private vulnerability reporting** for `DaryllGomas/swarm-ai` (Settings, Code security, Private vulnerability reporting). `/security` and `security.txt` both send researchers there, so they must not point at a switch that is off.
- **Remove the old-format network hash.** Two days after the deploy that includes migration 0010, no row carries the old `sha256(HASH_SALT|ip|day|network)` format any more. Delete `legacyIpHashFor` and the two `legacy*` values from `capHashes` in `hub/src/lib.js`, and the `?8 ?9`-style extras in the cap queries (`identity.js`, `accounts.js`, `oauth.js`, `mcp.js`), in a follow-up pull request.
- **Compelled disclosure.** If a lawful order arrives: tell a lawyer first, give only what the order covers, and record it for the transparency report. What exists to give is what `/privacy` lists; there are no names, emails or raw IP addresses in it, and network codes whose key is deleted are irreversible (apart from Cloudflare's own backup window and any copy taken earlier). Note that the order can also demand that you collect more from now on; the transparency date cannot prevent that.
- **Before the first deploy that includes migration 0010.** It rebuilds `accounts` and `ballot_versions` (with their data) inside the deploy's `migrations apply`. Take a Time Travel bookmark first (`scripts/deploy.sh d1 time-travel info swarm-ai`), run the deploy, then check: `SELECT COUNT(*) FROM accounts` and `SELECT COUNT(*) FROM ballot_versions` are unchanged, every account has `credit = 'anonymous'`, and `/version` shows the new commit. Existing contributors become anonymous on public receipts (the default): the handles on past receipts disappear until each owner chooses handle credit. That is intended.

- **Before the first deploy that includes migrations 0011 and 0012.** Neither has shipped. `deploy.sh` runs a read-only preflight before the migrations and prints `ballot_snapshots`, the number of weekly vote snapshots built from ballots on the live database. **Production is expected to print 0** (one voter, no snapshot built from ballots). If it prints more, stop and look: `SELECT week, source, voter_count FROM vote_snapshots ORDER BY week` and `SELECT * FROM allocation ORDER BY week`. 0011 replaces every snapshot built from fewer than 5 ballots, and every fallback descended from one (through any chain of fallbacks), with an equal provisional split and records those weeks as fallbacks; it never copies an unsafe split forward. A snapshot built from 5 or more ballots before the noise existed keeps its (already public) exact split, and 0012 marks it `noised = 0` so the API says it is exact; an earlier public exact result cannot be made private by adding noise later. 0012 also rebuilds `weekly_project_stats` with one `claimed_units` total (all routes added together) and without the per-origin, claim-count and people-behind-it columns (those raw figures are dropped and cannot be recomputed), drops `weekly_model_stats`, turns exact `vote_snapshots.voter_count` values into coarse-bucket edges, deletes the daily projection caches from `meta` and NULLs the detail of old link events. There is no `weekly_release` table. Take a Time Travel bookmark first, run the deploy, then check: `SELECT week, source, voter_count, noised FROM vote_snapshots ORDER BY week` (counts are 0, 5, 10, 25, 50, 100, ... only), every week in `allocation` has rows and sums to 10000, and `/api/analytics` and `/api/vote/audit` answer. The old exact data survives only in the Time Travel window and in any backup taken before; a restore brings it back.

## Deploy

```sh
hub/scripts/deploy.sh
```

The script refuses to run if the working tree has any change (untracked files included), if HEAD is detached or not `main`, if `origin` is not `github.com/DaryllGomas/swarm-ai`, if the commit is not **exactly the tip** of `origin/main` (it fetches first, so a stale local copy cannot fool it), or if `origin/main` was rewritten since the last fetch. It passes the commit to the Worker (`--var GIT_COMMIT:<sha>`, with `BUILT_AT`), and `GET /version` and every page footer report it as **the revision the operator reported**. That lets anyone compare the stated revision with the repository; it is not proof of what runs (anyone with the deploy token can bypass this script, and the value is a deploy-time variable). Then it runs `npm ci`,
the tests (`npm test`), re-checks that the tree and HEAD did not change, runs the read-only preflight on `vote_snapshots` (and stops if it cannot run), applies the database migrations to the live database
(`wrangler d1 migrations apply swarm-ai --remote`), and only then deploys the Worker. If any step fails, the later
ones don't run: a failed test or migration means nothing is deployed. Deploys use a Cloudflare API token scoped to
this account's Workers and D1 only, never a full account login, and the script never runs `wrangler login`. Tokens
expire; renew them before they do.

With arguments, the script runs only commands on a short allowlist (secrets, logs, `deployments list`, `versions list`, `d1 list|info|execute|time-travel|migrations list`, `kv namespace|key`) because they deploy no code. Anything else is refused: `deploy`, `versions upload|deploy`, `rollback`, `triggers deploy`, `d1 migrations apply`, and any argument containing `GIT_COMMIT` or `BUILT_AT` (there is no bypass that stamps an arbitrary commit). Use it for maintenance against the live account:
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
5. Roll forward, not back: revert the bad commit on `main` through a pull request and run the checked deploy again (there is no unchecked `rollback`), or restore the database (D1 Time Travel, below). If the site is actively harmful and you must roll the Worker back from the Cloudflare dashboard, do it, then say so on `/transparency` and expect `/version` to be stale until the next checked deploy.
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
| **Worker changed unexpectedly or site defaced** | Critical | `hub/scripts/deploy.sh deployments list`, redeploy the last good commit through the checked route (or roll back from the Cloudflare dashboard if you must, and note that `/version` will then be stale), then treat it as an account compromise. |
| **Bad data in the database** | High | D1 Time Travel restore (below), then redeploy if needed. Note that the `events` table is append-only by design; a restore is the only way to undo it. |
| **Sync keeps failing** | Low | Check `last_sync_error` in the `meta` table (`scripts/deploy.sh d1 execute swarm-ai --remote --command "SELECT * FROM meta"`). Town Hall may be down; tasks stay as they are until it's back. |
| **Cloudflare or GitHub account compromised** | Critical | Follow the maintainer's account-takeover playbook from a clean device: revoke sessions and tokens, rotate every secret, check deployments, DNS, rulesets and the security log. |
| **Raid on the GitHub repo** | Medium | Settings, Moderation, Interaction limits for 24 hours to 6 months. Lock issues. Block repeat accounts. |

## Rotating keys

| Secret | Rotate when | How | What it breaks |
|---|---|---|---|
| `ADMIN_TOKEN` | Leak, or every 90 days | Make a new long random value, run `hub/scripts/deploy.sh secret put ADMIN_TOKEN`, and update the copy in the operator's local config that `review.sh` reads | Nothing for contributors. Old admin calls stop working |
| `HASH_SALT` | Leak | Make a new long random value and run `hub/scripts/deploy.sh secret put HASH_SALT` | **Every contributor key stops working**, because key hashes are salted. Contributors pair again and get new handles; their old work stays attributed to the old handles. Sessions and link codes stop too. Network hashes are not affected: they use the random day keys in `network_keys`, not the salt |
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
  exists outside Cloudflare. Not running yet. **When it is built it must not keep what the privacy page says is erased:** export without
  the `network_keys` table and with the `network`, `pair_ip` columns blanked, or the forward secrecy is undone by the backup.
- **Time Travel and forward secrecy.** Time Travel is Cloudflare's own history of the database. Anything Swarm deletes (a network key, a
  deleted account) can be restored from it by whoever holds the Cloudflare account until the window passes (documented as up to 30 days,
  less on a free plan). The privacy page says this. After any restore, the hourly job re-erases old network keys and hashes within the hour,
  but **account deletions and handle removals made after the restore point are undone: redo them**, and tell the people who asked.
- **Restore drill (planned).** Once a quarter, restore an export into a local database and check that
  `/api/stats` looks right.

## Reviews

- **Daily:** the review queue and the held list, as above.
- **Weekly:** skim accepted and rejected work for drift, and glance at `review.sh held`. Check private pairing/churn/rejection/link signals in `/ops` and duplicate notes in the review queue.
- **Quarterly:** account 2FA and sessions, token scopes and ages, Cloudflare and GitHub security logs,
  dependency updates, and a restore drill.
