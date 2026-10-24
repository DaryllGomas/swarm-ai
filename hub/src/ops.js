import { verifyAccess } from './access.js';
import { adminHeld, adminPending, adminReview } from './admin.js';
import { currentAllocation, expireClaims } from './core.js';
import { ipHashFor, json, readJsonResult, sha256, underRateLimit, weekOf } from './lib.js';
import { syncTasks, UNTRUSTED } from './sync.js';

// A contributor appears in the churn list only above this many claim events in 24 hours (abuse signal, not a log of who claimed what).
const CHURN_MIN = 10;
const notFound = () => json({ error: 'not found' }, 404);

export async function handleOps(req, env, url) {
  const who = await verifyAccess(req, env);
  if (!who) return notFound();
  if (url.pathname.startsWith('/ops')) {
    if (!['GET', 'HEAD'].includes(req.method)) return notFound();
    if (!['/ops', '/ops/', '/ops/index.html', '/ops/ops.js', '/ops/ops.css'].includes(url.pathname)) return notFound();
    const asset = await env.ASSETS.fetch(req);
    const headers = new Headers(asset.headers);
    headers.set('Cache-Control', 'private, no-store');
    return new Response(asset.body, { status: asset.status, headers });
  }
  if (!(await underRateLimit(env, await ipHashFor(env, req)))) return json({ error: 'Slow down.' }, 429);
  const path = url.pathname;
  if (req.method === 'GET') {
    if (path === '/api/ops/overview') return overview(env);
    if (path === '/api/ops/pending') return adminPending(env);
    if (path === '/api/ops/held') return adminHeld(env);
    if (path === '/api/ops/projects') return projects(env);
    if (path === '/api/ops/audit') return audit(env, url);
    if (path === '/api/ops/suspensions') return suspensions(env);
    return notFound();
  }
  if (req.method !== 'POST' || !['/api/ops/review', '/api/ops/project', '/api/ops/sync', '/api/ops/revoke', '/api/ops/suspend', '/api/ops/unsuspend'].includes(path)) return notFound();
  const allowed = ['https://swarm.bigpicsolutions.com', ...(env.OPS_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)];
  if (req.headers.get('X-Swarm-Ops') !== '1' || !allowed.includes(req.headers.get('Origin'))) return notFound();
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('Content-Type') || '')) return json({ error: 'Send JSON.' }, 400);
  if (path === '/api/ops/review') return adminReview(req, env, { requiredReason: true, idempotent: true, actor: who.email });
  const { body, tooLarge } = await readJsonResult(req, 4096);
  if (tooLarge) return json({ error: 'Request too large.' }, 413);
  if (!body) return json({ error: 'Send a small JSON object.' }, 400);
  if (path === '/api/ops/project') return updateProject(env, body, who);
  if (path === '/api/ops/revoke') return revoke(env, body, who);
  if (path === '/api/ops/suspend') return suspend(env, body, who);
  if (path === '/api/ops/unsuspend') return unsuspend(env, body, who);
  // Only Town Hall has a connector today. Never pretend another project was synced.
  if (body.project !== 'town-hall') return json({ error: 'No sync connector for that project.' }, 400);
  return json(await syncTasks(env, { force: true }));
}

// The operator console shows work, never how it was routed. Public routing, a ballot's steering and a self-pick look the same here: there is
// no origin figure at all (live or weekly), active claims carry no contributor, and events about claims and links carry no contributor,
// handle or origin. The database still holds the origin for the scheduler, and direct database access is outside this boundary
// (docs/DATA-POLICY.md).
async function overview(env) {
  await expireClaims(env);
  const now = Date.now();
  const [allocation, counts, pending, claims, meta] = await Promise.all([
    currentAllocation(env),
    env.DB.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all(),
    env.DB.prepare("SELECT COUNT(*) AS n, MIN(created) AS oldest FROM submissions WHERE status = 'pending'").first(),
    env.DB.prepare(`SELECT c.id, c.task, t.project, c.expires_at,
      CASE WHEN c.expires_at <= ?2 THEN 1 ELSE 0 END AS expiring
      FROM claims c JOIN tasks t ON t.id = c.task
      WHERE c.outcome IS NULL AND c.expires_at > ?1 ORDER BY c.expires_at, c.id`).bind(now, now + 3600000).all(),
    env.DB.prepare("SELECT k, v FROM meta WHERE k IN ('last_sync', 'last_sync_error')").all(),
  ]);
  return json({ week: weekOf(now), allocation,
    routing_note: 'No routing figures are shown: units handed out are published once a week for the closed week, every route added together (/api/analytics). This console does not show how any task was routed either.',
    counts: { ready: 0, claimed: 0, submitted: 0, accepted: 0, held: 0, ...Object.fromEntries(counts.results.map((r) => [r.status, r.n])) },
    pending_reviews: pending.n, oldest_review_age_ms: pending.oldest === null ? null : Math.max(0, now - pending.oldest),
    active_claims: claims.results, expiring_claims: claims.results.filter((c) => c.expiring),
    expiring_within_ms: 3600000, intake: env.INTAKE === 'paused' ? 'paused' : 'open', sync: Object.fromEntries(meta.results.map((r) => [r.k, r.v])) });
}

async function projects(env) {
  const { results } = await env.DB.prepare(`SELECT p.id, p.name, p.active, p.paused, p.max_pending, p.reviewer,
    (SELECT COUNT(*) FROM submissions s JOIN tasks t ON t.id = s.task WHERE t.project = p.id AND s.status = 'pending') AS pending
    FROM projects p ORDER BY p.name, p.id`).all();
  return json({ projects: results.map((p) => ({ ...p, sync_supported: p.id === 'town-hall' })) });
}

async function updateProject(env, body, who) {
  if (typeof body.id !== 'string' || typeof body.paused !== 'boolean' || !Number.isInteger(body.max_pending) || body.max_pending < 1 || body.max_pending > 100) return json({ error: 'Send id, paused (boolean), and max_pending (1–100).' }, 400);
  const op = crypto.randomUUID();
  // A unique event marker is inserted first only for a real project. The update and audit commit together.
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO events (ts, type, actor, detail) SELECT ?1, 'project_updated', ?2,
      json_object('project', id, 'paused', json(?4), 'max_pending', ?5, 'op', ?6) FROM projects WHERE id = ?3`).bind(Date.now(), who.email, body.id, JSON.stringify(body.paused), body.max_pending, op),
    env.DB.prepare('UPDATE projects SET paused = ?2, max_pending = ?3 WHERE id = ?1').bind(body.id, Number(body.paused), body.max_pending),
  ]);
  if (!result[1].meta.changes) return notFound();
  return json({ ok: true });
}

async function revoke(env, body, who) {
  if (!Number.isSafeInteger(body.contributor_id) || body.contributor_id < 1) return json({ error: 'Send contributor_id.' }, 400);
  // A random salted digest has no corresponding issued contributor key. Never expose it, even to the console.
  const hash = await sha256(`${env.HASH_SALT}|revoked|${crypto.randomUUID()}`);
  const result = await env.DB.batch([
    env.DB.prepare('UPDATE contributors SET key_hash = ?2 WHERE id = ?1').bind(body.contributor_id, hash),
    env.DB.prepare(`INSERT INTO events (ts, type, contributor, actor) SELECT ?3, 'contributor_revoked', id, ?4
      FROM contributors WHERE id = ?1 AND key_hash = ?2`).bind(body.contributor_id, hash, Date.now(), who.email),
    // The contributor's OAuth connections die in the same transaction: every token is only as good as its grant.
    env.DB.prepare("UPDATE oauth_grants SET revoked_at = ?2, revoked_reason = 'operator_revoked' WHERE contributor = ?1 AND revoked_at IS NULL").bind(body.contributor_id, Date.now()),
  ]);
  return result[0].meta.changes ? json({ ok: true }) : notFound();
}

// ---- suspension (docs/RUNBOOK.md). The operator names an account by the short id the voter or an abuse signal gave (the first 8+
// characters of the account id), or by a contributor row ("suspend this contributor's owner"). The console never shows an account,
// and never shows which contributor an account is linked to. What it does show is a suspension handle: 8 random hex characters
// made for the suspension, unrelated to the account id. Lifting a suspension names that handle. The contributor route answers the
// same whether or not the contributor has an account, so the answer does not reveal an owner. Events carry the scope, the written
// reason and the handle: no account, no contributor.
const SCOPES = new Set(['vote', 'all']);
const REASON_MIN = 5, REASON_MAX = 300;
const reasonOf = (body) => (typeof body.reason === 'string' && body.reason.trim().length >= REASON_MIN && body.reason.trim().length <= REASON_MAX ? body.reason.trim() : null);
const REASON_ERROR = { error: `Send a written reason of ${REASON_MIN} to ${REASON_MAX} characters. Do not put names, emails or other personal details in it.` };

async function suspend(env, body, who) {
  if (!SCOPES.has(body.scope)) return json({ error: 'Send scope: "all" (voting and AI work) or "vote" (voting only).' }, 400);
  const reason = reasonOf(body);
  if (!reason) return json(REASON_ERROR, 400);
  const byContributor = body.contributor_id !== undefined;
  let matchOn, binds;
  if (byContributor) {
    if (!Number.isSafeInteger(body.contributor_id) || body.contributor_id < 1) return json({ error: 'Send contributor_id.' }, 400);
    if (!(await env.DB.prepare('SELECT 1 AS n FROM contributors WHERE id = ?1').bind(body.contributor_id).first())) return notFound();
    matchOn = (p) => `(a.id = (SELECT owner_account FROM contributors WHERE id = ${p}) OR EXISTS (SELECT 1 FROM account_links l WHERE l.account = a.id AND l.contributor = ${p}))`;
    binds = [body.contributor_id];
  } else {
    if (typeof body.account !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.account)) return json({ error: 'Send account (the short id, at least 8 characters) or contributor_id.' }, 400);
    // Exactly one account must start with it: a short id that fits two accounts, or none, changes nothing.
    matchOn = (p) => `substr(a.id, 1, length(${p})) = ${p} AND (SELECT COUNT(*) FROM accounts WHERE substr(id, 1, length(${p})) = ${p}) = 1`;
    binds = [body.account];
  }
  const ref = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
  const now = Date.now(), op = crypto.randomUUID();
  const res = await env.DB.batch([
    // Changes only an account not already suspended with this scope. A suspension keeps its handle when its scope is changed.
    env.DB.prepare(`UPDATE accounts AS a SET suspended = 1, suspend_scope = ?1, suspend_ref = COALESCE(suspend_ref, ?2), suspended_at = COALESCE(suspended_at, ?3)
      WHERE ${matchOn('?4')} AND (a.suspended = 0 OR a.suspend_scope IS NOT ?1)`).bind(body.scope, ref, now, ...binds),
    env.DB.prepare(`INSERT INTO events (ts, type, actor, detail) SELECT ?1, 'account_suspended', ?2, json_object('scope', ?3, 'reason', ?4, 'ref', suspend_ref, 'op', ?5)
      FROM accounts a WHERE a.suspended = 1 AND a.suspend_scope = ?3 AND changes() > 0 AND ${matchOn('?6')}`).bind(now, who.email, body.scope, reason, op, ...binds),
  ]);
  const changed = res[0].meta.changes > 0;
  // By contributor: the same answer in every case. By account: the handle, and 404 when no single account matched.
  if (byContributor) return json({ ok: true, note: 'Recorded. If this contributor has an account, it is listed under Suspensions.' });
  // The handle in force: a suspension whose scope was raised keeps the handle it already had.
  const now_ = await env.DB.prepare(`SELECT suspend_ref FROM accounts a WHERE a.suspended = 1 AND a.suspend_scope = ?1 AND ${matchOn('?2')}`).bind(body.scope, ...binds).first();
  if (!now_) return notFound();
  return json(changed ? { ok: true, ref: now_.suspend_ref } : { ok: true, ref: now_.suspend_ref, unchanged: true });
}

async function unsuspend(env, body, who) {
  if (typeof body.ref !== 'string' || !/^[0-9a-f]{8}$/.test(body.ref)) return json({ error: 'Send ref (the 8-character suspension handle from the Suspensions list).' }, 400);
  const reason = reasonOf(body);
  if (!reason) return json(REASON_ERROR, 400);
  const now = Date.now(), op = crypto.randomUUID();
  const res = await env.DB.batch([
    // The event is written first, from the row that is about to change, and only for a suspension that exists.
    env.DB.prepare(`INSERT INTO events (ts, type, actor, detail) SELECT ?1, 'account_unsuspended', ?2, json_object('scope', suspend_scope, 'reason', ?3, 'ref', suspend_ref, 'op', ?5)
      FROM accounts WHERE suspend_ref = ?4 AND suspended = 1`).bind(now, who.email, reason, body.ref, op),
    // Only the flags change. No ballot, contributor, claim, submission or token is touched, so everything comes back.
    env.DB.prepare(`UPDATE accounts SET suspended = 0, suspend_scope = NULL, suspend_ref = NULL, suspended_at = NULL WHERE suspend_ref = ?1 AND suspended = 1`).bind(body.ref),
  ]);
  return res[1].meta.changes ? json({ ok: true }) : notFound();
}

// The suspensions in force: handle, scope, when and the operator's written reason. No account, no contributor.
async function suspensions(env) {
  const { results } = await env.DB.prepare(`SELECT a.suspend_ref AS ref, a.suspend_scope AS scope, a.suspended_at AS since,
      (SELECT json_extract(e.detail, '$.reason') FROM events e WHERE e.type = 'account_suspended' AND json_extract(e.detail, '$.ref') = a.suspend_ref ORDER BY e.id DESC LIMIT 1) AS reason
    FROM accounts a WHERE a.suspended = 1 ORDER BY a.suspend_ref`).all();
  return json({ suspensions: results.map((r) => ({ ref: r.ref, scope: r.scope ?? 'vote', since: r.since || null, reason: r.reason ?? null })) });
}

async function audit(env, url) {
  const raw = url.searchParams.get('before');
  const before = raw === null ? Number.MAX_SAFE_INTEGER : Number(raw);
  if (!Number.isSafeInteger(before) || before < 1) return json({ error: 'Invalid cursor.' }, 400);
  const since = Date.now() - 86400000;
  const [events, pairings, churn, rejected, flagged] = await Promise.all([
    env.DB.prepare('SELECT id, ts, type, task, contributor, submission, actor, detail FROM events WHERE id < ?1 ORDER BY id DESC LIMIT 51').bind(before).all(),
    // Only the COUNT per network is returned. The network hash itself never leaves the database, not even to the operator console.
    env.DB.prepare(`SELECT COUNT(*) AS pairings FROM contributors
      WHERE created >= ?1 AND pair_ip IS NOT NULL AND pair_ip != '' GROUP BY pair_ip HAVING COUNT(*) >= 4 ORDER BY pairings DESC`).bind(since).all(),
    // Count lifecycle events, not the claim's final outcome: a claim and release both count.
    env.DB.prepare(`SELECT c.id AS contributor_id, c.handle,
      SUM(CASE WHEN e.type = 'task_claimed' THEN 1 ELSE 0 END) AS claims,
      SUM(CASE WHEN e.type = 'claim_released' THEN 1 ELSE 0 END) AS releases,
      SUM(CASE WHEN e.type = 'claim_expired' THEN 1 ELSE 0 END) AS expires
      FROM events e JOIN contributors c ON c.id = e.contributor
      WHERE e.ts >= ?1 AND e.type IN ('task_claimed','claim_released','claim_expired') GROUP BY c.id
      HAVING claims + releases + expires >= ${CHURN_MIN} ORDER BY claims + releases + expires DESC`).bind(since).all(),
    env.DB.prepare(`SELECT c.id AS contributor_id, c.handle, COUNT(*) AS reviewed,
      SUM(s.status = 'rejected') AS rejected, 1.0 * SUM(s.status = 'rejected') / COUNT(*) AS rejected_ratio
      FROM submissions s JOIN contributors c ON c.id = s.contributor
      WHERE s.status IN ('accepted','rejected') AND COALESCE(s.reviewed_by,'') != 'system' GROUP BY c.id ORDER BY rejected_ratio DESC`).all(),
    env.DB.prepare(`SELECT s.id, s.contributor AS contributor_id, c.handle, s.task, s.flags, s.status
      FROM submissions s JOIN contributors c ON c.id = s.contributor WHERE json_array_length(s.flags) > 0 ORDER BY s.id DESC LIMIT 100`).all(),
  ]);
  const page = events.results.slice(0, 50).map(auditView);
  return json({ notice: UNTRUSTED, events: page, next_before: events.results.length > 50 ? page.at(-1).id : null,
    signals: { window_start: since, pairings_near_cap: pairings.results, claim_churn_24h: churn.results,
      rejected_ratios_all_time: rejected.results, link_flagged: flagged.results.map((r) => ({ ...r, flags: JSON.parse(r.flags) })) } });
}

// Events about claims, links and steering say WHAT happened to a task, never WHO or by which route. Contributor, handle and detail are
// removed from them on the way out (the claim id stays, so a claim and its release can be paired). Anything else is shown as before, minus
// an account key that very old link events carried.
const WORK_EVENTS = new Set(['task_claimed', 'claim_released', 'claim_expired', 'account_linked', 'account_unlinked']);
export function auditView(e) {
  if (WORK_EVENTS.has(e.type)) {
    let claim;
    try { claim = JSON.parse(e.detail ?? 'null')?.claim; } catch { /* not JSON */ }
    return { id: e.id, ts: e.ts, type: e.type, task: e.task, contributor: null, submission: e.submission, actor: null, detail: Number.isInteger(claim) ? JSON.stringify({ claim }) : null };
  }
  return { ...e, detail: e.detail == null ? null : withoutAccount(e.detail) };
}

// Events written before migration 0010 carried a short account id next to a contributor id. Any such key is dropped on the way out.
function withoutAccount(detail) {
  try {
    const d = JSON.parse(detail);
    if (d && typeof d === 'object' && !Array.isArray(d)) { delete d.account; return JSON.stringify(d); }
  } catch { /* not JSON: shown as it is */ }
  return detail;
}
