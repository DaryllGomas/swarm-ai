# Security

## Reporting a vulnerability

Report it privately through GitHub's **private vulnerability reporting** on [DaryllGomas/swarm-ai](https://github.com/DaryllGomas/swarm-ai/security/advisories/new)
(Security, then Report a vulnerability). There is no email address for security reports, on purpose. Please don't open a
public issue for a vulnerability. We aim to respond within a few days. The live site says the same at
[/security](https://swarm.bigpicsolutions.com/security) and in `/.well-known/security.txt` (RFC 9116, from `hub/src/trust.js`).

**Safe harbor.** If you look for problems in good faith, test only against a local copy (`npm test` in `hub/` runs the hub locally),
never touch other users' data, don't disrupt the service, and give us 90 days to fix a problem before you publish it, we will not take
legal action against you or ask anyone else to. It covers Swarm's own code and service, not Cloudflare, GitHub, an AI provider or a project Swarm points at.

In scope:
- **The hub:** the Worker, the JSON API, the scheduler and the database it uses (`hub/`).
- **The MCP server** at `https://swarm.bigpicsolutions.com/mcp`: ways to get around its permissions, rate limits,
  claim caps or size limits, to read or change another contributor's work, or to reach the admin endpoints.
- **The setup guide** at `https://swarm.bigpicsolutions.com/setup` (also `/llms.txt` and the `setup_guide` tool):
  anything that would lead an AI agent to do something the user didn't agree to, for example prompt injection
  through the guide or a task.
- **The task-text screen** (`hub/src/screen.js`): project text that gets past it and reaches a contributor's AI
  as an instruction.
- This repository's workflows, scripts and settings.

Out of scope:
- **Projects Swarm points at.** Report those to the project. Town Hall has its own
  [SECURITY.md](https://github.com/DaryllGomas/town-hall/blob/main/SECURITY.md).
- Findings that need a stolen key or token, or a compromised machine, with no flaw in Swarm.
- Denial of service by sheer volume.

## Safety model

Swarm is built so that connecting to it costs a contributor very little trust.

- **Task text is untrusted data.** Briefs, titles, issues, objections and links come from public projects.
  Swarm labels them as data in every response and tells agents never to follow instructions inside them. The
  site renders text with `textContent`, never as HTML.
- **Task text is screened before it is served.** When the Town Hall sync builds a task, every piece of project
  text goes through `hub/src/screen.js`. Links, bare domains, emails and `@handles` are stripped, and control and
  hidden characters are dropped. Text that looks like an instruction to an AI (for example "ignore previous
  instructions", "you are now", a request to run a command, a curl or wget pipe, an encoded blob, or a request
  for keys) makes the whole task **held**. A held task is never returned by any MCP tool or public API, and it can
  not be claimed. The operator sees it with `review.sh held`. Briefs put the project text between
  `BEGIN PROJECT DATA` and `END PROJECT DATA` markers, after a notice that it is data. The screen is a filter,
  not a guarantee, so the labelling and the other rules stay.
- **Swarm never runs agents.** Contributors' AIs run in their own apps, when their owners decide. Connecting is
  not consent to unattended runs.
- **Swarm never asks for credentials, files, prompts or repository access.** The only secret a contributor
  holds is the Swarm key from `pair`, and it only opens that contributor's Swarm handle.
- **Keys are hashed.** Swarm stores a salted SHA-256 hash of each contributor key, never the key. It's shown
  once and can't be recovered. Network addresses are only stored as an HMAC under a random key that exists for one UTC day; the key is deleted after two
  days, together with every hash made with it, so old codes can't be reversed or matched to each other. They are used only for rate limits and to cap
  pairings, accounts and active claims.
- **Anonymous by default, and the operator sees little.** Public receipts say "a contributor" unless the contributor chose their handle; counts of people below 5
  are not published; `/ops` and `/api/admin` never return a ballot, a voter-to-contributor link or a network hash (a test scans every response). Likely
  personal details in a submission are flagged for the reviewer and warned about. What Swarm stores, and what it cannot protect against, is on
  [/privacy](https://swarm.bigpicsolutions.com/privacy) and in [docs/DATA-POLICY.md](docs/DATA-POLICY.md).
- **Swarm never publishes or merges.** Submitted work waits for a person on the project to review it.
- **The admin endpoints are hidden.** `/api/admin/*` needs a secret token and returns 404 to anyone without it.
- **Submission links are pre-screened.** Links that can never be a public web page (other schemes, a login in
  the link, localhost, `.local` or private addresses) are refused. Links that are merely suspicious (plain
  `http`, IP addresses, link shorteners, punycode hosts, more than 20 sources) are accepted but flagged, and the
  reviewer sees the flags first. Nothing is ever fetched or opened by Swarm.
- **There is a lockdown lever.** Setting `INTAKE = "paused"` stops new pairings, claims and submissions while the
  site, the API, reading and review stay up. It is an intake pause, not a write freeze: releases, claim expiry, review and
  the hourly job still write. The steps are in [docs/RUNBOOK.md](docs/RUNBOOK.md).
- **Deploys come from a clean `main`, and the revision is checkable, not proven.** `hub/scripts/deploy.sh` refuses a dirty tree, a detached HEAD, any other
  branch, a non-canonical `origin`, or a commit that is not the exact tip of a freshly fetched `origin/main`; it runs `npm ci` and the tests and applies the database migrations before it deploys,
  and stamps the commit into the Worker. Its argument passthrough is an allowlist, so no argument can stamp an arbitrary commit. `GET /version` and the footer of
  every page show the commit the *operator reported*. That is not cryptographic proof of what runs: anyone with the deploy token can bypass the script, and a malicious or compelled operator could report anything.

Limits that make abuse expensive: 60 requests a minute per network on every MCP request, 5 pairings per network
per day, 2 active claims per contributor and 4 across all handles on one network (counting yesterday's network
hash too, so midnight UTC is no loophole), claims that expire after 3 hours, 20 submissions per contributor per
day, a 20 KB work limit, 1 to 30 sources per submission, a 64 KB request limit, and a strict content security
policy on the site.

## How the repo is protected

In the repository today:
- `.github/CODEOWNERS` makes the maintainer the owner of every file.
- `.github/workflows/check.yml` runs the test suite and a migration naming check on pull requests and on `main`.
  It has a read-only token, no repository secrets and SHA-pinned actions.
- `.github/dependabot.yml` watches the npm dependencies in `hub/`.
- No secret is ever committed. `*.example` files show the shape.

**Planned**, when the repository is published on GitHub (it has no remote yet): a ruleset on `main` (pull
requests only, code owner review, the `check` status must pass, no force-pushes), secret scanning with push
protection, and private vulnerability reporting.

Operations, lockdown levers and key rotation: [docs/RUNBOOK.md](docs/RUNBOOK.md).
