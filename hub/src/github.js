// The GitHub connector (Phase 2). Read-only: Swarm never needs write access to anyone's repository.
//   * Issues labelled `swarm` on a registered public repo become tasks (same screening, same bounded fetch as Town Hall).
//   * A code task is handed in as a pull-request link; Swarm checks it against the GitHub API.
//   * A merged pull request is accepted, one closed without merging is rejected, through the one transactional review step.
//   * An optional signed webhook only makes that happen sooner. Polling is the source of truth.
// Everything GitHub says about an issue is untrusted text: it goes through screen.js and is only ever served as task data.
import { eventStmt, addTasksBulk, reviewSubmission } from './core.js';
import { clean, json, readJsonResult } from './lib.js';
import { makeScreen, sanitize } from './screen.js';
import { fetchJson, freeSyncLock, takeSyncLock, wrap } from './sync.js';

const API = 'https://api.github.com';
const REPO_RE = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
const PR_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,39})\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,8})$/;
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
export const DEFAULT_UNITS = 3;
export const SIZE_LABEL = /^swarm:(1|3|8)$/;
const MAX_ISSUES = 100; // one page; a full page means the list may be cut off, so nothing is closed on the strength of it
const MAX_PR_CHECKS = 20; // pull requests looked at per project per sync
const MAX_PROJECTS = 10;
const MAX_BACKOFF_MS = 2 * 60 * 60 * 1000;
const MIN_BACKOFF_MS = 60 * 1000;
const DEFAULT_BACKOFF_MS = 15 * 60 * 1000;
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const DELIVERY_KEEP_MS = 3 * 24 * 60 * 60 * 1000;

export const ISSUE_OUTPUT_FORMAT = (repo, n) =>
  `A pull request on ${repo} that resolves #${n}, opened from your own GitHub account, plus a short summary. Submit the PR URL as your first source.`;

class RateLimited extends Error {}
export class PrError extends Error {} // a pull-request submission that cannot be accepted; the message is shown to the contributor

// ---------------------------------------------------------------- the API

const meta = (env, k) => env.DB.prepare('SELECT v FROM meta WHERE k = ?1').bind(k).first().then((r) => r?.v ?? null);
const setMeta = (env, k, v) => env.DB.prepare('INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT (k) DO UPDATE SET v = ?2').bind(k, String(v)).run();

// When a refusal is a rate limit, the time to wait until (ms since the epoch); otherwise null.
export function rateLimitUntil(err, now = Date.now()) {
  if (!err || (err.status !== 403 && err.status !== 429)) return null;
  const r = err.rate || {};
  const limited = err.status === 429 || r.remaining === '0' || (r.retryAfter !== null && r.retryAfter !== undefined);
  if (!limited) return null;
  const reset = Number(r.reset) * 1000;
  const retry = Number(r.retryAfter) * 1000;
  let until = Number.isFinite(reset) && reset > now ? reset : Number.isFinite(retry) && retry > 0 ? now + retry : now + DEFAULT_BACKOFF_MS;
  until = Math.min(Math.max(until, now + MIN_BACKOFF_MS), now + MAX_BACKOFF_MS); // a wrong header can neither disable nor hammer us
  return until;
}

// One GET against the fixed GitHub API host. `path` is built from validated pieces only. A rate limit pauses every GitHub
// call (meta `github_backoff_until`) and surfaces as RateLimited.
async function gh(env, path) {
  const until = Number((await meta(env, 'github_backoff_until')) || 0);
  if (until > Date.now()) throw new RateLimited(`GitHub rate limit: paused until ${new Date(until).toISOString()}`);
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  try {
    return await fetchJson(`${API}${path}`, { headers });
  } catch (err) {
    const wait = rateLimitUntil(err);
    if (wait) {
      await setMeta(env, 'github_backoff_until', wait);
      throw new RateLimited(`GitHub rate limit: paused until ${new Date(wait).toISOString()}`);
    }
    throw err;
  }
}

const safeLogin = (v) => (typeof v === 'string' && LOGIN_RE.test(v) ? v : null);

// ---------------------------------------------------------------- projects

// Look the repository up by name, and make sure it is still the repository the project was registered for. The numeric id
// is the identity: a name can be renamed, or given to a different repository later. A rename is followed (and audited); a
// different repository under the same name is refused and nothing is synced from it.
async function resolveProject(env, p) {
  const r = await gh(env, `/repos/${p.repo}`);
  if (!Number.isInteger(r?.id) || typeof r.full_name !== 'string' || !REPO_RE.test(r.full_name)) throw new Error(`GitHub sent an unexpected answer for ${p.repo}`);
  if (r.private === true) throw new Error(`${p.repo} is not a public repository`);
  if (p.repo_id === null || p.repo_id === undefined) {
    await env.DB.batch([
      env.DB.prepare('UPDATE projects SET repo_id = ?2 WHERE id = ?1 AND repo_id IS NULL').bind(p.id, r.id),
      eventStmt(env, { type: 'project_repo_resolved', actor: 'sync', detail: { project: p.id, repo: r.full_name, repo_id: r.id } }),
    ]);
  } else if (r.id !== p.repo_id) {
    throw new Error(`${p.repo} is now a different repository (id ${r.id}, registered as ${p.repo_id}); nothing was synced from it`);
  }
  if (r.full_name !== p.repo) {
    await env.DB.batch([
      env.DB.prepare("UPDATE projects SET repo = ?2, url = CASE WHEN url = ?3 THEN ?4 ELSE url END WHERE id = ?1").bind(p.id, r.full_name, `https://github.com/${p.repo}`, `https://github.com/${r.full_name}`),
      eventStmt(env, { type: 'project_repo_renamed', actor: 'sync', detail: { project: p.id, from: p.repo, to: r.full_name, repo_id: r.id } }),
    ]);
  }
  return { ...p, repo: r.full_name, repo_id: r.id };
}

// ---------------------------------------------------------------- issues

export function sizeOf(labels) {
  const sizes = new Set();
  for (const l of labels || []) {
    const m = SIZE_LABEL.exec(String(typeof l === 'string' ? l : l?.name ?? '').toLowerCase());
    if (m) sizes.add(Number(m[1]));
  }
  return sizes.size === 1 ? [...sizes][0] : DEFAULT_UNITS; // no size label, or conflicting ones, means the default
}

const hasLabel = (labels, name) => (labels || []).some((l) => String(typeof l === 'string' ? l : l?.name ?? '').toLowerCase() === name);

function issueTask(project, issue) {
  const n = issue.number;
  const sc = makeScreen();
  const title = sc.t(issue.title, 120);
  const text = issue.body ? sc.t(issue.body, 3000) : '(the issue has no description)';
  const brief = `${wrap(`Repository: ${project.repo}\nIssue #${n}: ${title}\nWhat the issue asks for: ${text}`)}Your job: resolve this issue with a pull request on ${project.repo}. Read AGENTS.md and CONTRIBUTING.md in that repository first and follow them. Open the pull request from your owner's own GitHub account and say that an AI wrote it. The issue page: https://github.com/${project.repo}/issues/${n}`;
  return {
    project: project.id, kind: 'github_issue',
    title: `${project.repo.split('/')[1]} #${n}: ${sanitize(issue.title, 100)}`,
    brief, output_format: ISSUE_OUTPUT_FORMAT(project.repo, n), units: sizeOf(issue.labels),
    source_key: `gh:${project.repo_id}:${n}`,
    status: sc.held ? 'held' : 'ready', held_reason: sc.held ? sc.reason : null,
  };
}

async function syncIssues(env, project, out) {
  const list = await gh(env, `/repos/${project.repo}/issues?labels=swarm&state=open&per_page=${MAX_ISSUES}`);
  if (!Array.isArray(list)) throw new Error(`GitHub sent an unexpected issue list for ${project.repo}`);
  const issues = list.filter((i) => i && Number.isInteger(i.number) && i.number > 0 && !i.pull_request && typeof i.title === 'string' && i.title && hasLabel(i.labels, 'swarm'));
  const tasks = issues.map((i) => issueTask(project, i));
  out.created += await addTasksBulk(env, tasks);

  // A size label that changed after the task was created never changes its units: units are the budget the work was routed
  // against. The disagreement is written once to the audit log for the maintainer to revise on purpose.
  const stmts = [];
  const existing = await env.DB.prepare('SELECT id, units, source_key FROM tasks WHERE project = ?1 AND source_key LIKE ?2').bind(project.id, `gh:${project.repo_id}:%`).all();
  const byKey = new Map(existing.results.map((t) => [t.source_key, t]));
  for (const t of tasks) {
    const row = byKey.get(t.source_key);
    if (!row || row.units === t.units) continue;
    const detail = JSON.stringify({ units: row.units, label_units: t.units, note: 'The size label changed after the task was created. Units are unchanged; revise them on purpose if the new size is right.' });
    stmts.push(env.DB.prepare(
      `INSERT INTO events (ts, type, task, actor, detail) SELECT ?2, 'task_size_label_changed', ?1, 'sync', ?3
       WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.type = 'task_size_label_changed' AND e.task = ?1 AND e.detail = ?3)`
    ).bind(row.id, Date.now(), detail));
  }
  if (stmts.length) await env.DB.batch(stmts);

  // An issue that is closed (or no longer labelled `swarm`) closes its ready or held task. A claimed task finishes normally,
  // and a held task keeps its held_reason when it is closed, so its text stays withheld for good. A full page may be cut off,
  // so nothing is closed then.
  if (list.length < MAX_ISSUES) {
    const open = new Set(issues.map((i) => i.number));
    const { results } = await env.DB.prepare("SELECT id, source_key FROM tasks WHERE project = ?1 AND status IN ('ready','held') AND source_key LIKE ?2").bind(project.id, `gh:${project.repo_id}:%`).all();
    for (const t of results) {
      const n = Number(t.source_key.split(':')[2]);
      if (open.has(n)) continue;
      const res = await env.DB.batch([
        env.DB.prepare("UPDATE tasks SET status = 'closed' WHERE id = ?1 AND status IN ('ready','held')").bind(t.id),
        env.DB.prepare(
          `INSERT INTO events (ts, type, task, actor, detail) SELECT ?2, 'task_closed', id, 'sync', ?3 FROM tasks
           WHERE id = ?1 AND status = 'closed' AND NOT EXISTS (SELECT 1 FROM events e WHERE e.type = 'task_closed' AND e.task = ?1)`
        ).bind(t.id, Date.now(), JSON.stringify({ reason: 'issue closed, or no longer labelled swarm, on GitHub' })),
      ]);
      if (res[0].meta.changes) out.closed++;
    }
  }
  out.issues += issues.length;
  out.held += tasks.filter((t) => t.status === 'held').length;
}

// ---------------------------------------------------------------- pull requests

const isMerged = (pr) => pr.merged === true || (typeof pr.merged_at === 'string' && pr.merged_at !== '');

// Does this pull request's title or body name the task's issue? `#N`, or `owner/repo#N` for this repository. A reference to
// another repository's issue, or to a different number, does not count. This is a HINT for the reviewer: a title and body are
// editable by their author, so it is never proof that the pull request resolves the issue, and nothing acts on it.
export function mentionsIssue(pr, repo, issueNumber) {
  if (!Number.isInteger(issueNumber)) return null;
  const text = `${typeof pr?.title === 'string' ? pr.title : ''}\n${typeof pr?.body === 'string' ? pr.body : ''}`.slice(0, 70000);
  for (const m of text.matchAll(/(?<![\w.-])(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d{1,9})(?!\d)/g)) {
    if (Number(m[2]) !== issueNumber) continue;
    if (!m[1] || m[1].toLowerCase() === String(repo).toLowerCase()) return true;
  }
  return false;
}

// Pending pull-request submissions of this project. Closed without a merge is rejected: that only removes the submitter's own
// pending submission (the task returns to the pool), and the submitter chose to hand that pull request in. A MERGE is NOT
// acceptance: the merge only shows that somebody merged some pull request, not that it resolves this task's issue or that the
// submitter wrote it. A merged pull request is recorded (pr_state = 'merged' and a `pr_merged` event) and the submission stays
// pending, flagged "merged, needs reviewer confirmation" in the review queue; a person accepts it through the normal review.
// The state is read from the GitHub API, never from a webhook payload.
async function checkPrs(env, project, out, { number = null } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.task, s.pr_number, s.pr_state FROM submissions s JOIN tasks t ON t.id = s.task
     WHERE t.project = ?1 AND s.status = 'pending' AND s.pr_number IS NOT NULL AND s.pr_repo_id = ?2 AND (?3 IS NULL OR s.pr_number = ?3)
       AND COALESCE(s.pr_state, '') != 'merged'
     ORDER BY s.created, s.id LIMIT ${MAX_PR_CHECKS}`
  ).bind(project.id, project.repo_id, number).all();
  for (const s of results) {
    try {
      const pr = await gh(env, `/repos/${project.repo}/pulls/${s.pr_number}`);
      if (!pr || pr.number !== s.pr_number || pr.base?.repo?.id !== project.repo_id) throw new Error(`pull request #${s.pr_number} is not on ${project.repo} any more`);
      const merged = isMerged(pr);
      const state = merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
      if (state === 'open') {
        if (s.pr_state !== 'open') await env.DB.prepare('UPDATE submissions SET pr_state = ?2 WHERE id = ?1').bind(s.id, 'open').run();
        continue;
      }
      if (merged) {
        // Record only. The state change and its event are one batch, and only the first caller writes the event.
        const login = safeLogin(pr.merged_by?.login);
        const res = await env.DB.batch([
          env.DB.prepare("UPDATE submissions SET pr_state = 'merged' WHERE id = ?1 AND status = 'pending' AND COALESCE(pr_state, '') != 'merged'").bind(s.id),
          env.DB.prepare(
            `INSERT INTO events (ts, type, task, contributor, submission, actor, detail)
             SELECT ?2, 'pr_merged', task, contributor, id, 'github', ?3 FROM submissions WHERE id = ?1 AND pr_state = 'merged' AND changes() > 0`
          ).bind(s.id, Date.now(), JSON.stringify({ repo: project.repo, pr_number: s.pr_number, merged_by: login, note: 'Merged on GitHub. Not accepted: a reviewer must confirm it resolves the task.' })),
        ]);
        if (res[0].meta.changes) out.merged++;
        continue;
      }
      const r = await reviewSubmission(env, { id: s.id, task: s.task, verdict: 'rejected', reviewedBy: 'GitHub: PR closed', note: 'PR closed without merge' });
      await env.DB.prepare('UPDATE submissions SET pr_state = ?2 WHERE id = ?1').bind(s.id, state).run();
      if (r.ok) out.rejected++;
    } catch (err) {
      if (err instanceof RateLimited) throw err;
      out.errors.push(`PR #${s.pr_number}: ${String(err.message).slice(0, 150)}`);
    }
  }
}

// ---------------------------------------------------------------- the sync

// Sync every active GitHub project (or one: projectId, or repoId from a webhook). The caller holds the sync lock. It never
// throws: failures are returned and recorded in meta (`github_last_error`), so the Town Hall sync is never affected.
export async function syncGithub(env, { projectId = null, repoId = null, issues = true, prs = true, prNumber = null } = {}) {
  const out = { projects: 0, issues: 0, created: 0, closed: 0, held: 0, merged: 0, rejected: 0, errors: [] };
  try {
    const until = Number((await meta(env, 'github_backoff_until')) || 0);
    if (until > Date.now()) return { ...out, skipped: 'rate-limited', until: new Date(until).toISOString() };
    const { results } = await env.DB.prepare(
      `SELECT id, repo, repo_id FROM projects WHERE kind = 'github' AND active = 1 AND repo IS NOT NULL
         AND (?1 IS NULL OR id = ?1) AND (?2 IS NULL OR repo_id = ?2) ORDER BY id LIMIT ${MAX_PROJECTS}`
    ).bind(projectId, repoId).all();
    for (const row of results) {
      try {
        const project = await resolveProject(env, row);
        out.projects++;
        if (issues) await syncIssues(env, project, out);
        if (prs) await checkPrs(env, project, out, { number: prNumber });
      } catch (err) {
        if (err instanceof RateLimited) throw err;
        out.errors.push(`${row.repo}: ${String(err.message).slice(0, 200)}`);
      }
    }
    if (out.errors.length) await setMeta(env, 'github_last_error', `${new Date().toISOString()} ${out.errors.join(' | ').slice(0, 400)}`);
    else await env.DB.prepare("DELETE FROM meta WHERE k = 'github_last_error'").run();
    await setMeta(env, 'github_last_sync', Date.now());
  } catch (err) {
    out.errors.push(String(err.message).slice(0, 200));
    if (!(err instanceof RateLimited)) console.error('github sync failed', err);
    await setMeta(env, 'github_last_error', `${new Date().toISOString()} ${out.errors.join(' | ').slice(0, 400)}`).catch(() => {});
  }
  return out;
}

// A sync of one repository, started by a webhook. It takes the sync lock; if a sync is already running it does nothing,
// because that sync (or the next hourly one) will see the change.
async function syncOne(env, opts) {
  if (!(await takeSyncLock(env))) return { skipped: true };
  try { return await syncGithub(env, opts); } finally { await freeSyncLock(env); }
}

// ---------------------------------------------------------------- submitting a pull request

// For a task on a GitHub project, `sources[0]` must be a pull request on that project's repository, still open and not yet
// used for another submission. Returns null for any other task. The repository is checked by its numeric id (the fetched
// pull request's base repository), never by name alone: a name can be renamed, or reused by a different repository.
export async function checkPrSubmission(env, taskId, sources) {
  const task = await env.DB.prepare(
    "SELECT p.id AS project, p.repo, p.repo_id, t.source_key FROM tasks t JOIN projects p ON p.id = t.project WHERE t.id = ?1 AND p.kind = 'github'"
  ).bind(taskId).first();
  if (!task) return null;
  const m = PR_URL_RE.exec(String(sources[0] ?? ''));
  if (!m) throw new PrError(`This task is a code task on ${task.repo}. Your first source must be your pull request, in the form https://github.com/OWNER/REPO/pull/NUMBER.`);
  if (task.repo_id === null || task.repo_id === undefined) throw new PrError(`${task.repo} has not been verified yet. Try again after the next sync (within the hour).`);
  const number = Number(m[3]);
  let pr;
  try {
    pr = await gh(env, `/repos/${m[1]}/${m[2]}/pulls/${number}`);
  } catch (err) {
    if (err.status === 404) throw new PrError('GitHub has no public pull request at that link. Check the link and that the repository is public.');
    throw new PrError('GitHub could not be reached to check your pull request. Your claim is kept; try again in a few minutes.');
  }
  if (!pr || pr.number !== number || pr.base?.repo?.id !== task.repo_id) throw new PrError(`That pull request is not on ${task.repo}. Open it against ${task.repo} and submit its link.`);
  if (isMerged(pr)) throw new PrError('That pull request is already merged, so it cannot be handed in for credit. Open your own pull request.');
  if (pr.state !== 'open') throw new PrError('That pull request is closed. Reopen it or open a new one.');
  const author = safeLogin(pr.user?.login);
  if (!author) throw new PrError('GitHub did not name the pull request author. Try again later.');
  const used = await env.DB.prepare("SELECT 1 FROM submissions WHERE pr_repo_id = ?1 AND pr_number = ?2 AND status IN ('pending','accepted')").bind(task.repo_id, number).first();
  if (used) throw new PrError('That pull request has already been handed in for a task.');
  // A hint for the reviewer only: whether the title or body names this task's issue.
  const issue = Number(String(task.source_key ?? '').split(':')[2]);
  const hint = mentionsIssue(pr, task.repo, issue);
  return { pr_number: number, pr_author: author, pr_state: 'open', pr_repo_id: task.repo_id, pr_mentions_issue: hint === null ? null : hint ? 1 : 0 };
}

// ---------------------------------------------------------------- admin: register and activate

const MAX_ADMIN_BODY = 4 * 1024;

export async function adminRegisterGithub(req, env) {
  const { body, tooLarge } = await readJsonResult(req, MAX_ADMIN_BODY);
  if (tooLarge) return json({ error: 'Request too large.' }, 413);
  if (!body) return json({ error: 'Send a small JSON object: {repo, reviewer, summary}.' }, 400);
  const repo = typeof body.repo === 'string' ? body.repo.trim() : '';
  const reviewer = typeof body.reviewer === 'string' ? clean(body.reviewer, 80) : '';
  const summary = typeof body.summary === 'string' ? clean(body.summary, 300) : '';
  if (!REPO_RE.test(repo)) return json({ error: 'repo must look like owner/name.' }, 400);
  if (!reviewer) return json({ error: 'reviewer is required: the person accountable for reviewing the work.' }, 400);
  if (!summary) return json({ error: 'summary is required.' }, 400);
  let r;
  try {
    r = await gh(env, `/repos/${repo}`);
  } catch (err) {
    if (err.status === 404) return json({ error: 'GitHub has no public repository with that name.' }, 404);
    return json({ error: 'GitHub could not be reached, or refused the request. Try again shortly.', detail: String(err.message).slice(0, 120) }, 502);
  }
  if (!Number.isInteger(r?.id) || typeof r.full_name !== 'string' || !REPO_RE.test(r.full_name)) return json({ error: 'GitHub sent an unexpected answer.' }, 502);
  if (r.private === true) return json({ error: 'Only public repositories can be registered.' }, 400);
  const [owner, name] = r.full_name.split('/');
  const slugOf = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  let id = slugOf(name);
  const taken = async (x) => !SLUG_RE.test(x) || !!(await env.DB.prepare('SELECT 1 FROM projects WHERE id = ?1').bind(x).first());
  if (await taken(id)) id = slugOf(`${owner}-${name}`);
  if (await taken(id)) return json({ error: 'A project with that id already exists.' }, 409);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO projects (id, name, kind, summary, url, reviewer, sponsored, active, max_pending, repo, repo_id)
         VALUES (?1, ?2, 'github', ?3, ?4, ?5, 0, 0, 10, ?6, ?7)`
      ).bind(id, clean(r.full_name.split('/')[1], 60), summary, `https://github.com/${r.full_name}`, reviewer, r.full_name, r.id),
      eventStmt(env, { type: 'project_registered', actor: 'admin', detail: { project: id, repo: r.full_name, repo_id: r.id, active: false } }),
    ]);
  } catch (err) {
    if (/UNIQUE/i.test(String(err.message))) return json({ error: 'That repository is already registered.' }, 409);
    throw err;
  }
  return json({ ok: true, project: { id, repo: r.full_name, repo_id: r.id, active: false }, note: 'A candidate: inactive and not routed. Activate it with POST /api/admin/projects/:id/activate. It has no allocation share until one is set.' }, 201);
}

export async function adminActivateProject(env, ctx, id) {
  const p = await env.DB.prepare('SELECT id, kind, repo, repo_id, active FROM projects WHERE id = ?1').bind(id).first();
  if (!p) return json({ error: 'not found' }, 404);
  if (p.kind !== 'github' || !p.repo_id) return json({ error: 'Only a registered GitHub project can be activated here.' }, 400);
  if (p.active) return json({ ok: true, id, active: true, already: true });
  await env.DB.batch([
    env.DB.prepare('UPDATE projects SET active = 1 WHERE id = ?1 AND active = 0').bind(id),
    eventStmt(env, { type: 'project_activated', actor: 'admin', detail: { project: id, repo: p.repo } }),
  ]);
  ctx?.waitUntil(syncOne(env, { projectId: id }));
  return json({ ok: true, id, active: true, note: 'Issues labelled swarm are pulled in now. The project has no allocation share until one is set, so next_task will not route to it; claim_task still works.' });
}

// ---------------------------------------------------------------- the webhook

async function readBytes(req, max) {
  const declared = Number(req.headers.get('Content-Length') || 0);
  if (declared > max) return null;
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return bytes;
}

// `sha256=<64 hex>` to bytes, or null.
function sigBytes(header) {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header || '');
  return m ? Uint8Array.from(m[1].match(/../g).map((h) => parseInt(h, 16))) : null;
}

// crypto.subtle.verify compares the HMAC in constant time.
async function validSignature(secret, header, bytes) {
  const sig = sigBytes(header);
  if (!sig) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, sig, bytes);
}

// POST /api/github/webhook. 404 until GITHUB_WEBHOOK_SECRET is set. The signature is checked over the raw body before
// anything is read from it. The payload only says which repository to look at; what happened is read from the GitHub API.
export async function handleGithubWebhook(req, env, ctx) {
  if (!env.GITHUB_WEBHOOK_SECRET) return json({ error: 'not found' }, 404);
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405, { Allow: 'POST' });
  const bytes = await readBytes(req, MAX_WEBHOOK_BYTES);
  if (!bytes) return json({ error: 'Request too large.' }, 413);
  if (!(await validSignature(env.GITHUB_WEBHOOK_SECRET, req.headers.get('X-Hub-Signature-256'), bytes))) return json({ error: 'Bad signature.' }, 401);

  const delivery = req.headers.get('X-GitHub-Delivery') || '';
  if (!/^[A-Za-z0-9-]{8,64}$/.test(delivery)) return json({ error: 'Missing delivery id.' }, 400);
  const now = Date.now();
  const fresh = await env.DB.prepare('INSERT OR IGNORE INTO github_deliveries (id, ts) VALUES (?1, ?2)').bind(delivery, now).run();
  if (!fresh.meta.changes) return json({ ok: true, duplicate: true });
  await env.DB.prepare('DELETE FROM github_deliveries WHERE ts < ?1').bind(now - DELIVERY_KEEP_MS).run();

  const event = req.headers.get('X-GitHub-Event') || '';
  if (event === 'ping') return json({ ok: true, pong: true });
  if (event !== 'issues' && event !== 'pull_request') return json({ ok: true, ignored: event.slice(0, 40) });
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { return json({ error: 'Not JSON.' }, 400); }
  const repoId = payload?.repository?.id;
  if (!Number.isInteger(repoId)) return json({ error: 'No repository in the payload.' }, 400);
  // By id; a project whose id is not resolved yet (the first sync has not run) is matched by name.
  const fullName = typeof payload.repository.full_name === 'string' ? payload.repository.full_name : '';
  const known = await env.DB.prepare(
    "SELECT id FROM projects WHERE kind = 'github' AND active = 1 AND (repo_id = ?1 OR (repo_id IS NULL AND lower(repo) = lower(?2)))"
  ).bind(repoId, fullName).first();
  if (!known) return json({ ok: true, ignored: 'repository not registered' });
  const number = Number.isInteger(payload.pull_request?.number) ? payload.pull_request.number : Number.isInteger(payload.number) ? payload.number : null;
  const work = event === 'issues' ? syncOne(env, { projectId: known.id, prs: false }) : syncOne(env, { projectId: known.id, issues: false, prNumber: number });
  ctx.waitUntil(work.catch((err) => console.error('webhook sync failed', String(err?.message || err).slice(0, 200))));
  return json({ ok: true, queued: event }, 202);
}
