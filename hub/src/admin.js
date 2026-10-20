import { PROVISIONAL_NOTE, newOp } from './core.js';
import { UNTRUSTED } from './sync.js';
import { screenSources } from './links.js';
import { clean, iso, json, readJsonResult } from './lib.js';

const MAX_ADMIN_BODY_BYTES = 4 * 1024;

// ---------------------------------------------------------------- admin

export async function adminPending(env) {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.task, t.title, t.kind, t.units, t.brief, t.output_format, t.project, c.handle, s.body, s.sources, s.flags, s.model, s.tokens_est, s.prescreen, s.created
     FROM submissions s JOIN tasks t ON t.id = s.task JOIN contributors c ON c.id = s.contributor
     WHERE s.status = 'pending' AND t.status != 'held' AND t.held_reason IS NULL ORDER BY s.created`
  ).all();
  return json({ notice: UNTRUSTED, pending: results.map((r) => ({ ...r, sources: JSON.parse(r.sources), flags: JSON.parse(r.flags || '[]'), prescreen: r.prescreen ? JSON.parse(r.prescreen) : null, age_ms: Math.max(0, Date.now() - r.created), created: iso(r.created) })) });
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
  const now = Date.now();
  const op = newOp();
  // One transaction: the submission, the task and the event commit together or not at all. The first UPDATE is the only
  // thing that can change who wins: it applies to a pending submission whose task is waiting for review ('submitted'), and
  // a task gets at most one accepted result. The task change and the event run only if it applied (they find this request's
  // op on the submission), so a stale or repeated review cannot touch a task that has moved on.
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE submissions SET status = ?2, reviewed_by = ?3, review_note = ?4, reviewed_at = ?5, op = ?6
       WHERE id = ?1 AND status = 'pending'
         AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = submissions.task AND t.status = 'submitted')
         AND (?2 != 'accepted' OR NOT EXISTS (SELECT 1 FROM submissions a WHERE a.task = submissions.task AND a.status = 'accepted'))`
    ).bind(id, verdict, s.reviewer, note, now, op),
    // A rejected piece of work puts the task back in the pool, up to two rejections by a reviewer; after that it stays rejected.
    env.DB.prepare(
      `UPDATE tasks SET status = CASE
           WHEN ?3 = 'accepted' THEN 'accepted'
           WHEN (SELECT COUNT(*) FROM submissions WHERE task = ?1 AND status = 'rejected' AND COALESCE(reviewed_by, '') != 'system') >= 2 THEN 'rejected'
           ELSE 'ready' END
       WHERE id = ?1 AND status = 'submitted' AND EXISTS (SELECT 1 FROM submissions WHERE id = ?2 AND op = ?4 AND status = ?3)`
    ).bind(s.task, id, verdict, op),
    env.DB.prepare(
      `INSERT INTO events (ts, type, task, contributor, submission, actor, detail)
       SELECT ?3, ?4, task, contributor, id, ?5, json_object('note', ?6) FROM submissions WHERE id = ?1 AND op = ?2`
    ).bind(id, op, now, accept ? 'submission_accepted' : 'submission_rejected', actor || s.reviewer, note),
  ]);
  if (!res[0].meta.changes) {
    // Not reviewed by this request: someone else got there first, or the task is not in a state that can be reviewed.
    const now2 = await env.DB.prepare('SELECT s.status, t.status AS task_status FROM submissions s JOIN tasks t ON t.id = s.task WHERE s.id = ?1').bind(id).first();
    if (now2.status !== 'pending') return repeatedReview(now2.status, body.decision, id, idempotent);
    return json({ error: `the task is ${now2.task_status}, not waiting for review, or it already has an accepted result` }, 409);
  }
  const task = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?1').bind(s.task).first();
  return json({ ok: true, id, decision: accept ? 'accepted' : 'rejected', reviewed_by: s.reviewer, task_status: task.status, receipt: accept ? `/api/receipts` : null, allocation_note: PROVISIONAL_NOTE });
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
    t.title, t.source_key, c.handle FROM submissions s JOIN tasks t ON t.id = s.task
    JOIN contributors c ON c.id = s.contributor WHERE s.id = ?1 AND s.status = 'accepted'
    AND t.project = 'town-hall' AND t.kind = 'research_fix' AND t.held_reason IS NULL`).bind(id).first();
  if (!submission) return json({ error: 'not found' }, 404);
  return json({ notice: UNTRUSTED, submission: { ...submission, sources: JSON.parse(submission.sources) } });
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
