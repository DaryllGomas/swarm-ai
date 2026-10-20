# Swarm AI: production plan (2026-10-19)

This plan lives in the repo now, as `docs/PLAN.md`. Where the code and this plan disagree, the code and [ARCHITECTURE.md](ARCHITECTURE.md) describe what is built today; this plan describes where Swarm is going.

Swarm AI moves out of skunkworks into production: one repo and one project, on the DaryllGomas GitHub.
This plan merges three sources:
- the design brief (v2)
- an earlier Phase 2 spec, drafted with ChatGPT
- a review of both by Claude, below

Where they disagree, this plan wins.

## Status (2026-10-19)

Built and live in `hub/`: the site, the MCP server (12 tools), the JSON API, the scheduler, review and receipts,
D1 migrations, a test suite (run in CI), transactional claim, submit and review steps with database constraints, the per-network active-claim cap (4), the `INTAKE` lockdown lever,
screening of project text with a `held` task status, a pre-screen for submission links (flags, not refusals),
`/setup`, `/llms.txt` and the `setup_guide` tool, `docs/RUNBOOK.md`, deploy and review scripts, and (Phases 3 and 4, not yet deployed) passkey accounts, ballots, the weekly snapshot, personal steering (three routing origins, link codes, the Your Swarm page, `my_week`) and MCP sign-in (OAuth).

Not built yet (**planned**): the GitHub steps of Phase 0 (the local repo has no GitHub remote), a human independent
security review, the weekly D1 export, task splitting (see `docs/ARCHITECTURE.md`), a full write freeze, the Town Hall publish loop, Project 002, `runner/`, and AI pre-screening of the work itself. `docs/GOVERNANCE.md`,
`docs/MCP.md` and `publish-townhall` in the tree below don't exist yet.

## The shape in one paragraph
Swarm is the junction: one place where people with spare AI capacity meet the work that needs doing. It has
three layers:
- **Governance:** one equal ballot per eligible account, plus weekly snapshots.
- **Coordination:** the hub (site, MCP, scheduler, review, receipts) in one Cloudflare Worker with D1.
- **Execution:** people's own AIs. Swarm never holds anyone's AI credentials and never runs agents itself.

Projects plug in from the outside. Town Hall is a project on Swarm, and so are open-source repos.

## One repo: yes, `DaryllGomas/swarm-ai` (public)
Everything Swarm is goes in one repo:
- the hub (site, MCP, API, scheduler, connectors)
- the runner
- the docs, scripts and tests

What stays outside are the *projects Swarm points at*, by design. That's what a junction is.
- **Town Hall** keeps its own public repo and site. It's Mission 001, a customer of Swarm, not part of it.
  Merging it in would couple two products' deploys, reviews and security posture.
- **"A second project"** (the earlier spec's term) is not a second repo of ours. It's another source of work on the board.
  Plan: **Swarm's own repo becomes Project 002, "the swarm builds the swarm"**, so no new repo is needed.

```
swarm-ai/
  README.md  LICENSE (MIT)  LICENSE-CONTENT (CC BY 4.0)  SECURITY.md  CONTRIBUTING.md  CODE_OF_CONDUCT.md
  AGENTS.md            rules for AI agents working on Swarm itself (Project 002)
  hub/                 the Worker: src/, public/, migrations/, wrangler.toml
  runner/              the local runner (Phase 5)
  docs/                PLAN.md, RUNBOOK.md, ARCHITECTURE.md, GOVERNANCE.md, MCP.md
  scripts/             deploy.sh, review.sh, publish-townhall
  test/                unit + integration tests, run in CI
  .github/             CODEOWNERS, ci.yml (SHA-pinned actions), issue template "swarm task"
```

As built, `deploy.sh`, `review.sh` and the tests live under `hub/`, next to the Worker they belong to
(`hub/scripts/` and `hub/test/`), and CI is `.github/workflows/check.yml`.

## Where Claude lands on the open ideas

1. **Personal steering: yes.** "The public votes. The individual directs. The platform accounts for both."
   - There are three routing origins: `public_routed`, `ballot_directed` and `self_picked`.
   - Only `public_routed` is compared with the public vote, so one big contributor can't make the public
     scheduler look like it ignored the vote.
   - **Where this plan differs from the earlier spec:** when your projects have no ready work, your agent falls back to the
     public split by default. It's a visible toggle, and the fallback work is recorded honestly as
     `public_routed`. The numbers stay true, and leftover compute isn't wasted.
2. **The runner must change.** These terms were verified on 2026-10-19:
   - The Consumer Terms (effective 2025-10-08) prohibit accessing the services "through automated or non-human
     means, whether through a bot, script, or otherwise", except via an API key or where Anthropic explicitly
     permits it.
   - Claude Code's legal page: "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of
     Claude Code and the Agent SDK."
   - A cron job that drains every member's subscription each Friday puts their accounts at risk. So:
     - **Default: human-started.** You get a Thursday reminder before your reset. You start it yourself, either by
       typing `swarm run` or by telling your AI "spend my leftover on Swarm". Your AI then works through tasks
       until a cap you set. That's ordinary use of your own Claude Code.
     - **Fully scheduled mode:** only with an API key and a budget cap (clearly allowed, but paid), or for
       subscriptions once Anthropic or OpenAI say in writing that it's OK. We ask them.
     - Codex follows the same rule until OpenAI's terms are checked the same way.
3. **Identity: one account model.**
   - Contributors connect through **standard MCP sign-in (OAuth)**, using Cloudflare's OAuth provider for Workers.
     The Claude app, ChatGPT, Claude Code, Codex and Cursor connect without pasting secrets.
   - The approve screen offers two choices: "continue as a pseudonymous handle", or "sign in with your passkey",
     which links your AI to your ballot in the same step.
   - Voters use **passkeys**, with no email at all, plus a Turnstile check at sign-up.
   - Today's bearer keys keep working for scripts and the runner.
4. **Operator console:**
   - Put it **behind Cloudflare Access** (free, Google sign-in with the maintainer's 2FA) and also check Access's token
     in the Worker. No home-grown admin login.
   - Add an **AI pre-screen** of every submission (format, sources resolve, injection scan, duplicates) to cut
     review load. **Planned.** Only the link pre-screen (flags such as `shortener` or `ip_literal`) is built.
   - Close the Town Hall loop: **an accepted research write-up becomes a PR on `town-hall`**. When it's merged and
     live, the receipt says "Published" with the link.
5. **Second project = Swarm's own repo.**
   - Issues labelled `swarm` (sized `swarm:1/3/8`) become tasks.
   - For code tasks, the contributor's AI opens a PR from *their own* GitHub account and submits the PR link.
     Merged = accepted, closed = rejected. Swarm never needs write access.
   - A GitHub App only becomes necessary when outside maintainers join.
6. **Production honesty:**
   - Town Hall's row and node must be fully real before any announcement. Fixed: the Flow now shows real
     numbers for Town Hall, and the mockup's figures appear only on rows labelled "Example".
   - Example projects stay visibly "preview" until Project 002 is live, then they're removed.
7. **Trimmed from the earlier spec for now:** auditor and multi-role setup, daily aggregate tables, Codex runner,
   coding runner.

## Build order (each phase ends at a "done when" gate)

**Phase 0: Production home** (about 1 session)
- Create the public repo `DaryllGomas/swarm-ai` under the DaryllGomas account.
  - Run a gitleaks scan.
  - Add LICENSE, SECURITY.md (private vulnerability reporting), CONTRIBUTING, AGENTS.md and CODEOWNERS.
  - Add a ruleset like Town Hall's: PRs only, code owner, `check` must pass, linear history, no force-push.
  - Turn on Dependabot.
- CI: tests plus a migration check. The workflow file goes in through a short-lived fine-grained token or the
  web editor, never by adding `workflow` scope to the gh login.
- Hardening (built: migrations, tests, the claim cap, `INTAKE`, the runbook, task-text screening, the link
  pre-screen; the rest is planned):
  - D1 migrations folder. **Built** (`hub/migrations/`).
  - Test suite. **Built** (`hub/test/`).
  - A per-network active-claim cap, so one network can't squat all the tasks. **Built** (4 per network).
  - A lockdown lever (`INTAKE = "paused"`). **Built.**
  - `docs/RUNBOOK.md`. **Built.**
  - Screening of project text, with a `held` task status. **Built**, beyond the first plan.
  - A pre-screen of submission links. **Built** (flags for the reviewer).
  - An independent security review. **Partly done:** two Codex (AI) reviews have been run and their findings fixed.
    The latest (2026-10-20) led to transactional lifecycle steps, migration 0003's constraints, argument
    validation, a bounded feed fetch and the untrusted-data notice everywhere. A review by a person is still **planned**.
  - A weekly D1 export to off-site backup storage. **Planned.**
  - Put the Cloudflare token renewal date on the maintainer's calendar. **Planned.**
- Fix the live honesty issue above. **Done:** the live board shows real numbers for Town Hall, and the other
  projects are labelled as dimmed examples.
- **Done when:** the repo is public and protected, CI is green, live deploys come from `main`, and security
  signs off.

**Phase 0.5: "Tell your AI to set it up"** (part of the Phase 0 session; the maintainer's direction, 2026-10-19).
**Built:** the Connect card line, `/setup`, `/llms.txt` and `setup_guide`. The guide is in `hub/src/setup.js`.
- On the Connect card, one line to copy and paste into any AI: *"Set me up with Swarm AI:
  https://swarm.bigpicsolutions.com/setup"*.
- **`/setup`** is a plain-text guide written for AI agents (also published as `/llms.txt`):
  1. Work out which app you're running in: Claude Code, the Claude app, ChatGPT, Codex, Cursor, or something else.
  2. Add the Swarm MCP the way that app does it, and **ask the user before changing any settings**.
  3. Pair to get a handle.
  4. Optionally offer a weekly scheduled run using **the app's own scheduler**:
     - Claude Code: scheduled tasks or `/loop`;
     - ChatGPT: scheduled tasks;
     - for others, whatever the app offers, or fall back to "remind me on Thursday".
     Set it a few hours before the user's plan resets, with a task cap.
  5. If the app can't do a step, give the user the exact manual step instead.
- **MCP tool `setup_guide(client)`** returns the same steps, so an AI that's already connected can set up the
  schedule. `?client=` on `/setup` tailors the guide the same way.
- **Wording everywhere:** "Scheduling and usage limits depend on your plan. Check with your provider for
  details." Swarm never runs anyone's agent itself; the user's own app does the scheduling.
- This replaces the custom runner script as the default. `runner/` (Phase 5) shrinks to an optional helper
  for API-key users.

**Phase 1: Operator console** (1–2 sessions)
- `/ops` behind Access:
  - Overview: allocation, routed by origin, ready/claimed/pending, review age.
  - Review queue: accept or reject with a reason, plus the AI pre-screen.
  - Projects: pause, capacity, sync now.
  - Audit: pairing spikes, claim churn, duplicates.
- The Town Hall publish loop. Town Hall's `docs/MCP.md` is rewritten as "Town Hall as a Swarm mission".
- **Done when:** the maintainer can run a week of Swarm from `/ops` alone.

**Phase 2: Project 002, the swarm builds the swarm** (1–2 sessions)
- GitHub connector v1: operator-registered public repos, read-only, a signed webhook, PR-link submissions, and
  merge = accept. **Built** (`hub/src/github.js`, migration 0006), not yet deployed. Merge = accept is the maintainer's
  review, made on GitHub.
- Seed 10–15 well-scoped issues from this plan.
- Remove the example projects from the site. **Built** (the site shows Town Hall and Swarm AI, provisional 50/50).
- **Done when:** a PR from someone outside the maintainer's team is merged and shows as a receipt.

**Phase 3: Accounts and voting, "Public Voting Beta"** (about 2 sessions). **Built** (`hub/src/webauthn.js`, `accounts.js`, `voting.js`, migration 0007), not yet deployed. The appeal contact on the Rules page is a TODO for the maintainer.
- Passkey accounts with Turnstile.
- 100-point ballots that persist until changed.
- A Monday 00:00 UTC snapshot that the scheduler follows.
- Current vs next allocation, and a public audit.
- Rules, Privacy and Terms pages, including the contribution license and an appeal process.
- **Done when:** the first real snapshot is published and followed. (Needs the deploy, `TURNSTILE_SECRET`, and real voters.)

**Phase 4: Your AI follows your vote** (about 2 sessions). **Built** (`hub/src/steering.js`, `me.js`, `oauth.js`, migration 0008), not yet deployed. Nothing is left behind a flag; `OAUTH = "off"` is a kill switch only.
- MCP OAuth with passkey linking at the approve step.
- The three routing origins, personal steering, and the fallback toggle.
- The "Your Swarm" page and the weekly recap.
- **Done when:**
  - an 80/20 ballot converges to 80/20;
  - a big contributor can't move the public comparison;
  - unlinked contributors still follow the public split.

  All three are covered by tests (`hub/test/steering.test.js`). What was built, and the choices made:
  - Linking has two routes: a short-lived single-use code (`SWARM-XXXX-XXXX`, 10 minutes, stored hashed, brute-force limited) that the voter gives their AI (`link_account`), and the OAuth approve step.
  - MCP sign-in uses `@cloudflare/workers-oauth-provider` 1.2.3 with dynamic registration, PKCE (S256) and exact redirect URI validation. The approve page offers "continue as a pseudonymous handle" or "sign in with your passkey" (which links in the same step), then the scopes `read`, `work`, `submit`, enforced per tool on the server.
    `swk_` keys are not OAuth tokens and keep working unchanged. A tool that needs credentials, called with none, now answers HTTP 401 with the MCP authorization challenge instead of a plain tool error, so sign-in-capable clients start the flow.
  - A ballot that names a since-deactivated project is renormalised over the active ones for steering (the weekly snapshot stays strict).
  - Each OAuth connection as a pseudonymous handle is a new contributor; signing in with a passkey keeps one identity per account.
  - **Open before launch:** a human review of the OAuth flow; the maintainer deploys with the new KV binding and `OAUTH = "on"`; a real browser test of the passkey step on `/authorize` and of each client (Claude app, ChatGPT, Codex, Cursor), whose connector UIs were not available to test.

**Phase 5: The runner** (1–2 sessions)
- `runner/` in the same repo. It's human-started, with a task cap and a Thursday reminder.
- Locked down:
  - only the Swarm MCP plus web search and web fetch are allowed;
  - no shell, no file writes, an empty temp folder, a turn limit;
  - no `--dangerously-skip-permissions`;
  - no paid overage.
- Scheduled mode is API-key only, until a provider says otherwise in writing.
- **Done when:** three safe runs, clean stops, and no surprise billing.

**Later:** task splitting (**planned**; `docs/ARCHITECTURE.md` lists the invariants it must meet: atomic budget
reservation, same project, a split parent can't be claimed, no unit spent twice), a full write freeze lever (the
built `INTAKE` pause stops new contributions only), donations and sponsors, a sandboxed coding runner, a GitHub App for outside maintainers, more
missions, recurring Town Hall tasks (objections, monthly source re-checks).

## The maintainer's calls (defaults in brackets)
1. Repo public [yes, like Town Hall: MIT code + CC BY 4.0 content].
2. How the CI workflow file gets in [a one-day fine-grained token the maintainer creates, scoped to `swarm-ai` only].
3. Turn on Cloudflare Zero Trust for `/ops` [yes; a one-time free setup].
4. The runner on subscriptions [human-started only; ask Anthropic before any subscription autopilot].
