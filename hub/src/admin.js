import { PROVISIONAL_NOTE, newOp, reviewSubmission } from './core.js';
import { UNTRUSTED } from './sync.js';
import { screenSources } from './links.js';
import { clean, iso, json, readJsonResult } from './lib.js';
import { creditedAs, publicHandle } from './privacy.js';

const MAX_ADMIN_BODY_BYTES = 4 * 1024;

// ---------------------------------------------------------------- admin

export async function adminPending(env) {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.task, t.title, t.kind, t.units, t.brief, t.output_format, t.project, c.handle, s.body, s.sources, s.flags, s.model, s.tokens_est, s.pr_number, s.pr_author, s.pr_state, s.pr_mentions_issue, s.prescreen, s.created
     FROM submissions s JOIN tasks t ON t.id = s.task JOIN contributors c ON c.id = s.contributor
     WHERE s.status = 'pending' AND t.status != 'held' AND t.held_reason IS NULL ORDER BY s.created`
  ).all();
  return json({ notice: UNTRUSTED, pending: results.map(({ pr_mentions_issue: mentions, ...r }) => ({ ...r, ...(r.pr_number ? { pr_mentions_issue: mentions === null ? null : mentions === 1, pr_needs_confirmation: r.pr_state === 'merged', pr_hint_note: 'Whether the pull request text names the issue is a hint only; it is not proof.' } : {}), sources: JSON.parse(r.sources), flags: JSON.parse(r.flags || '[]'), prescreen: r.prescreen ? JSON.parse(r.prescreen) : null, age_ms: Math.max(0, Date.now() - r.created), created: iso(r.created) })) });
}

// Tasks the text screen held back. They are never served to agents; this is where the operator sees them.
export async function adminHeld(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, project, kind, title, units, status, source_key, held_reason, brief, created FROM tasks WHERE held_reason IS NOT NULL ORDER BY created, id"
  ).all();
  return json({ notice: UNTRUSTED, held: results.map((r) => ({ ...r, created: iso(r.created) })), note: 'Fix the text at its source (the project); a held task is released on the next sync once its text passes the screen.' });
}

export async function adminReview(req, env, { requiredReason = false, idempotent = false, actor = null } = {}) {
  const { body, tooLarge } = await readJsonResult(req, MAX_ADMIN_BODY_BYTES);
  if (tooLarge) return json({ error: 'Request too large.' }, 413);
  if (!body) return json({ error: 'Send a small JSON object.' }, 400);
  const id = body.id;
  if (!Number.isInteger(id)) return json({ error: 'id must be a whole number' }, 400);
  if (body.decision !== 'accept' && body.decision !== 'reject') return json({ error: 'decision must be "accept" or "reject"' }, 400);
  if (body.note !== undefined && typeof body.note !== 'string') return json({ error: 'note must be a string (or left out)' }, 400);
  const note = clean(body.note, 500) || null;
  if (requiredReason && !note) return json({ error: 'A review reason is required.' }, 400);

  const s = await env.DB.prepare(
    `SELECT s.id, s.status, s.task, s.contributor, p.reviewer FROM submissions s JOIN tasks t ON t.id = s.task JOIN projects p ON p.id = t.project WHERE s.id = ?1`
  ).bind(id).first();
  if (!s) return json({ error: 'no such submission' }, 404);
  if (s.status !== 'pending') return repeatedReview(s.status, body.decision, id, idempotent);

  const accept = body.decision === 'accept';
  const verdict = accept ? 'accepted' : 'rejected';
  // Shared with the GitHub connector and the ops console: one transaction, one winner (see reviewSubmission in core.js).
  const r = await reviewSubmission(env, { id, task: s.task, verdict, reviewedBy: s.reviewer, actor: actor || s.reviewer, note });
  if (!r.ok) {
    // Not reviewed by this request: someone else got there first, or the task is not in a state that can be reviewed.
    if (r.status !== 'pending') return repeatedReview(r.status, body.decision, id, idempotent);
    return json({ error: `the task is ${r.taskStatus}, not waiting for review, or it already has an accepted result` }, 409);
  }
  return json({ ok: true, id, decision: verdict, reviewed_by: s.reviewer, task_status: r.taskStatus, receipt: accept ? `/api/receipts` : null, allocation_note: PROVISIONAL_NOTE });
}

function repeatedReview(status, decision, id, idempotent) {
  if (idempotent && status === (decision === 'accept' ? 'accepted' : 'rejected')) return json({ ok: true, id, decision: status, already: true });
  return json({ error: `already ${status}` }, 409);
}

// An accepted research receipt for the local Town Hall publisher; never returns contributor key hashes.
export async function adminSubmission(env, url) {
  const id = Number(url.searchParams.get('id'));
  if (!Number.isSafeInteger(id) || id < 1) return json({ error: 'id must be a positive whole number' }, 400);
  const submission = await env.DB.prepare(`SELECT s.id, s.body, s.sources, s.model, s.review_note, s.published_url,
    t.title, t.source_key, c.handle, c.credit, c.removed FROM submissions s JOIN tasks t ON t.id = s.task
    JOIN contributors c ON c.id = s.contributor WHERE s.id = ?1 AND s.status = 'accepted'
    AND t.project = 'town-hall' AND t.kind = 'research_fix' AND t.held_reason IS NULL`).bind(id).first();
  if (!submission) return json({ error: 'not found' }, 404);
  // The publisher may name the contributor on a public page, so it gets the handle only if the contributor chose handle credit.
  const { credit, removed, ...rest } = submission;
  return json({ notice: UNTRUSTED, submission: { ...rest, handle: publicHandle(submission), credited_as: creditedAs(submission), sources: JSON.parse(submission.sources) } });
}

export async function adminPublished(req, env) {
  const { body, tooLarge } = await readJsonResult(req, MAX_ADMIN_BODY_BYTES);
  if (tooLarge) return json({ error: 'Request too large.' }, 413);
  if (!body || !Number.isSafeInteger(body.submission_id) || body.submission_id < 1 || typeof body.url !== 'string') return json({ error: 'Send submission_id and a public https url.' }, 400);
  let url;
  try {
    url = screenSources([body.url]).sources[0];
    if (!url.startsWith('https://')) throw new Error('https required');
  } catch { return json({ error: 'Send a public https url.' }, 400); }
  const id = body.submission_id, op = newOp(), now = Date.now();
  const result = await env.DB.batch([
    env.DB.prepare("UPDATE submissions SET published_url = ?2, published_at = ?3, op = ?4 WHERE id = ?1 AND status = 'accepted' AND published_url IS NULL").bind(id, url, now, op),
    env.DB.prepare(`INSERT INTO events (ts, type, task, contributor, submission, actor, detail)
      SELECT ?3, 'submission_published', task, contributor, id, 'admin', json_object('url', ?4)
      FROM submissions WHERE id = ?1 AND op = ?2`).bind(id, op, now, url),
  ]);
  if (result[0].meta.changes) return json({ ok: true, submission_id: id, url });
  const s = await env.DB.prepare('SELECT status, published_url FROM submissions WHERE id = ?1').bind(id).first();
  if (!s) return json({ error: 'not found' }, 404);
  if (s.status === 'accepted' && s.published_url === url) return json({ ok: true, submission_id: id, url, already: true });
  return json({ error: s.published_url ? 'already published at another URL' : 'only accepted work can be published' }, 409);
}
