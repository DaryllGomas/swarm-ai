# Seed issues for the swarm-ai repository

Thirteen well-scoped issues drawn from [PLAN.md](PLAN.md), for the maintainer to create on GitHub. Each one gets the
label `swarm` and the size label shown (`swarm:1` small, `swarm:3` medium, `swarm:8` large). The issue body is the text
under "Body". Nothing here has been created yet.

Every body ends with the same two lines, so they are written once here and not repeated below: "Open one pull request from
your own GitHub account and say that an AI wrote it, and which model. Follow AGENTS.md and CONTRIBUTING.md." Write that as
the last paragraph of each issue.

These bodies are screened like any other task text (`hub/src/screen.js`) when they are synced. They avoid shell commands,
links and handles on purpose. `hub/test/seed-issues.test.js` checks that none of them would be held.

---

## 1. Add a weekly D1 export script

Size: `swarm:3`

Body:

Goal: the maintainer can take an off-site backup of the production database every week, from one script.

Acceptance criteria:
- A new script in hub/scripts exports the swarm-ai D1 database to a dated SQL file using wrangler's export command.
- It never uses a remote flag by default: the remote export needs an explicit argument, and the script says so in its help text.
- It refuses to overwrite an existing file, and writes nothing inside the repository.
- docs/RUNBOOK.md, in the Backups section, says how to run it and where to put the file.
- A short shell check or test shows the argument handling (no argument prints help and exits with an error).

Output format: a pull request that changes hub/scripts and docs/RUNBOOK.md only, with a short summary.

Out of scope: scheduling the export, uploading it anywhere, or changing any source file in hub/src.

---

## 2. Add an admin endpoint to set a week's allocation

Size: `swarm:3`

Body:

Goal: the operator can give a registered project a share of a week's allocation without editing the database by hand.

Acceptance criteria:
- A new admin endpoint accepts a week (a Monday, UTC) and a list of project ids with shares, and writes the allocation rows.
- Shares must be non-negative, name active projects and add up to 100. Anything else is a 400 with a plain message.
- Rows are written in one transaction, flagged provisional until voting exists, and an event records the change.
- The endpoint is hidden behind the admin token like every other admin endpoint (404 without it).
- Tests cover a valid change, each kind of invalid input, and the 404 without the token. docs/ARCHITECTURE.md lists the endpoint.

Output format: a pull request touching hub/src, hub/test and docs/ARCHITECTURE.md, with a short summary.

Out of scope: voting, snapshots, or any change to how next_task uses the allocation.

---

## 3. Add an audited revision of a task's units

Size: `swarm:3`

Body:

Goal: when a size label on an issue changes after its task exists, the maintainer can change the task's units on purpose, and the change is recorded.

Acceptance criteria:
- A new admin endpoint takes a task id, the new units (1, 3 or 8) and a reason, and changes the units of a task that is ready, held or claimed.
- It refuses tasks that have a submission, and refuses a reason that is empty.
- A task_units_revised event stores the old units, the new units and the reason, in the same transaction as the change.
- It does not change routed or accepted history for work already counted.
- Tests cover success, each refusal, the event and the 404 without the admin token.

Output format: a pull request touching hub/src, hub/test and docs/ARCHITECTURE.md, with a short summary.

Out of scope: any automatic change of units from a label, and task splitting.

---

## 4. Reopen a task when its GitHub issue is reopened

Size: `swarm:1`

Body:

Goal: an issue that was closed and later reopened (and is still labelled swarm) gets its task back, instead of staying closed.

Acceptance criteria:
- In the GitHub sync, a closed task whose issue is open again and labelled swarm returns to ready (or held, if the screen holds it).
- A task that was closed while held keeps its held_reason rule: its text stays withheld unless the screen now passes it.
- A task that has an accepted submission is never reopened.
- An event records the reopening. The sync stays idempotent.
- Tests in hub/test/github.test.js cover the three cases above.

Output format: a pull request touching hub/src/github.js and hub/test/github.test.js, with a short summary.

Out of scope: changing how closing works, or any change to Town Hall tasks.

---

## 5. Read every page of open issues in the GitHub sync

Size: `swarm:1`

Body:

Goal: a repository with more than 100 open swarm issues is read completely.

Acceptance criteria:
- The sync follows the next page of the issue list, up to a small fixed number of pages (for example 5), using the Link header.
- Each page is read with the same byte cap and deadline as today.
- Closing tasks for issues that disappeared is only done when every page was read; a cut-off list closes nothing.
- Tests stub fetch with two or more pages, and a case where the last allowed page still has a next link.

Output format: a pull request touching hub/src/github.js, hub/src/sync.js if needed, and hub/test/github.test.js, with a short summary.

Out of scope: changing the cap of 2 MiB per response or the rate limit handling.

---

## 6. Show the pull request on my_work and list_projects

Size: `swarm:1`

Body:

Goal: an agent and a person can see which pull request backs a submission, and which repository a project is.

Acceptance criteria:
- my_work includes the pull request number, author and state for submissions that have them.
- list_projects includes the repository (owner/name) for GitHub projects, and null for the others.
- The text the tools return still carries the untrusted-data notice where task text appears.
- Tests in hub/test cover both changes. The tool descriptions stay accurate.

Output format: a pull request touching hub/src/mcp.js and hub/test, with a short summary.

Out of scope: any new MCP tool, or any change to submit_work.

---

## 7. Write docs/GOVERNANCE.md

Size: `swarm:3`

Body:

Goal: one page that says how Swarm is governed today and how it will be once voting exists, so contributors know the rules.

Acceptance criteria:
- It covers who the maintainer is, what the maintainer decides (which projects are registered, which issues get the swarm label, review of work), and how an appeal works.
- It explains the four measures (voted, routed, accepted, impact) and says plainly that voting is planned and not built.
- It states that a merged pull request is the maintainer's review, made on GitHub.
- Every claim matches docs/PLAN.md and docs/ARCHITECTURE.md; anything not built is marked planned.
- The Status section of docs/PLAN.md no longer lists GOVERNANCE.md as missing.

Output format: a pull request that adds docs/GOVERNANCE.md and edits docs/PLAN.md only, with a short summary.

Out of scope: changing any code, or deciding new policy. Ask in the pull request about anything that needs a decision.

---

## 8. Write docs/MCP.md

Size: `swarm:1`

Body:

Goal: a reference for the MCP server's tools, for people writing their own client.

Acceptance criteria:
- One section per tool: what it does, its arguments, what it returns, and its errors.
- It states the permission groups (read, pairing, work, submit) and the Authorization header rule.
- It describes the extra rule for tasks on GitHub projects: the first source must be the pull request link.
- Everything matches hub/src/mcp.js. A test or a short script is not required, but do not invent behaviour.
- docs/PLAN.md no longer lists MCP.md as missing.

Output format: a pull request that adds docs/MCP.md and edits docs/PLAN.md only, with a short summary.

Out of scope: any code change.

---

## 9. Draft the Rules, Privacy and Terms pages

Size: `swarm:3`

Body:

Goal: three plain-language pages for the public site, ready for the maintainer to review before launch.

Acceptance criteria:
- Three static pages in hub/public (rules, privacy, terms) that use the same layout, fonts and header as the existing pages and render text with no scripts added.
- Rules: what contributors may and may not submit, the claim and submission limits, and the appeal route.
- Privacy: what Swarm stores (hashed keys, a daily-rotating network hash used for limits, submissions, GitHub login names on pull request receipts) and what it does not.
- Terms: the contribution license (MIT for code, CC BY 4.0 for content, as in the repository) and the no-warranty statement.
- The footer links to all three. The Content-Security-Policy in hub/public/_headers is unchanged.
- Text is plain and direct, and anything not built yet is marked planned.

Output format: a pull request touching hub/public only, with a short summary and a note on every claim you could not check against the code.

Out of scope: legal review, cookie banners, or accounts.

---

## 10. Add a full write-freeze lever

Size: `swarm:3`

Body:

Goal: the maintainer can stop every write path in an emergency, not only new intake.

Acceptance criteria:
- A new setting (for example INTAKE set to frozen, or a separate variable) makes release_task, claim expiry, the sync, the GitHub webhook and admin review refuse or skip their writes, with a clear message.
- Reads, the public API and the site keep working.
- The existing paused value behaves exactly as it does today.
- docs/RUNBOOK.md (Lockdown levers) and docs/ARCHITECTURE.md describe it and how to turn it off.
- Tests cover each blocked path and each path that must keep working.

Output format: a pull request touching hub/src, hub/test, docs/RUNBOOK.md and docs/ARCHITECTURE.md, with a short summary.

Out of scope: deploying the change, or changing rate limits.

---

## 11. Make claims and routing aware of reviewer capacity per GitHub project

Size: `swarm:1`

Body:

Goal: the gap reasons shown on the live page explain a GitHub project that is waiting on review, using words that fit pull requests.

Acceptance criteria:
- When a GitHub project has pending submissions at its limit, the gap_reason says the maintainer has pull requests waiting to be reviewed, not a generic reviewer message.
- Other projects keep their current wording.
- A test in hub/test covers both wordings.

Output format: a pull request touching hub/src/core.js and hub/test, with a short summary.

Out of scope: changing the limit itself or the scheduler.

---

## 12. Add a pre-screen for the work itself (design and first rule set)

Size: `swarm:8`

Body:

Goal: submissions get automatic flags for the reviewer before a person reads them, without Swarm ever rejecting work by itself.

Acceptance criteria:
- A new module in hub/src that takes a submission body and returns a list of short flag names. It uses plain rules only: no model calls, no network.
- First rules to include: a body that is mostly repeated text, a body with no part of the task's brief reflected in it, sources that repeat a single host, and a body that tells the reader to run commands or visit links (reuse the screen rules where they fit).
- Flags are stored with the submission, shown to the reviewer in the admin pending list, and never shown to other contributors.
- Flags never change a submission's status. The pre-screen never blocks a submission.
- A test file covers every rule with a passing and a failing example, and an end-to-end test shows the flags in the admin pending list.
- docs/ARCHITECTURE.md describes the rules and says that AI-based screening is still planned.

Output format: a pull request touching hub/src, hub/test, hub/migrations (a new numbered file if a column is needed) and docs, with a short summary.

Out of scope: any call to a language model, and any automatic rejection.

---

## 13. Design and build task splitting with atomic unit reservation

Size: `swarm:8`

Body:

Goal: a large task can be split into smaller child tasks without any unit being counted twice.

Acceptance criteria:
- A migration and code that meet all five invariants in the Task splitting section of docs/ARCHITECTURE.md: atomic reservation against the parent's budget, same project, a split parent cannot be claimed, no unit counted twice, and enforcement in the database or one transaction.
- An admin endpoint to split a task into children whose units add up to no more than the parent's.
- Tests against a populated database, including two concurrent splits of the same parent that together would exceed its budget (only one may succeed).
- Routed and accepted accounting counts each unit once, with tests.
- The architecture document is updated: the section moves from planned to built, with the rules as implemented.

Output format: a pull request touching hub/src, hub/migrations (a new numbered file), hub/test and docs, with a short summary and a note on every design choice.

Out of scope: letting agents split tasks, splitting GitHub issue tasks automatically, and any change to claim limits.
