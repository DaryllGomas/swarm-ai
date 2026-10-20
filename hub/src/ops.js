import { verifyAccess } from './access.js';
import { adminHeld, adminPending, adminReview } from './admin.js';
import { currentAllocation, expireClaims, STANDING, unitsByProject } from './core.js';
import { ipHashFor, json, readJsonResult, sha256, underRateLimit, weekOf } from './lib.js';
import { syncTasks, UNTRUSTED } from './sync.js';

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
    return notFound();
  }
  if (req.method !== 'POST' || !['/api/ops/review', '/api/ops/project', '/api/ops/sync', '/api/ops/revoke'].includes(path)) return notFound();
  const allowed = ['https://swarm.bigpicsolutions.com', ...(env.OPS_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)];
  if (req.headers.get('X-Swarm-Ops') !== '1' || !allowed.includes(req.headers.get('Origin'))) return notFound();
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('Content-Type') || '')) return json({ error: 'Send JSON.' }, 400);
  if (path === '/api/ops/review') return adminReview(req, env, { requiredReason: true, idempotent: true, actor: who.email });
  const { body, tooLarge } = await readJsonResult(req, 4096);
  if (tooLarge) return json({ error: 'Request too large.' }, 413);
  if (!body) return json({ error: 'Send a small JSON object.' }, 400);
  if (path === '/api/ops/project') return updateProject(env, body, who);
  if (path === '/api/ops/revoke') return revoke(env, body, who);
  // Only Town Hall has a connector today. Never pretend another project was synced.
  if (body.project !== 'town-hall') return json({ error: 'No sync connector for that project.' }, 400);
  return json(await syncTasks(env, { force: true }));
}

async function overview(env) {
  await expireClaims(env);
  const now = Date.now(), week = weekOf(now);
  const [allocation, routed, selfPicked, counts, pending, claims, meta] = await Promise.all([
    currentAllocation(env), unitsByProject(env, week, 1, STANDING), unitsByProject(env, week, 0, STANDING),
    env.DB.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all(),
    env.DB.prepare("SELECT COUNT(*) AS n, MIN(created) AS oldest FROM submissions WHERE status = 'pending'").first(),
    env.DB.prepare(`SELECT c.id, c.task, c.contributor, u.handle, t.project, c.expires_at,
      CASE WHEN c.expires_at <= ?2 THEN 1 ELSE 0 END AS expiring
      FROM claims c JOIN tasks t ON t.id = c.task JOIN contributors u ON u.id = c.contributor
      WHERE c.outcome IS NULL AND c.expires_at > ?1 ORDER BY c.expires_at, c.id`).bind(now, now + 3600000).all(),
    env.DB.prepare("SELECT k, v FROM meta WHERE k IN ('last_sync', 'last_sync_error')").all(),
  ]);
  return json({ week, allocation, routed_by_origin: { public_routed: routed, self_picked: selfPicked, ballot_directed: {} },
    routing_note: 'Units handed out, not compute. Ballot-directed routing is planned.',
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
  ]);
  return result[0].meta.changes ? json({ ok: true }) : notFound();
}

async function audit(env, url) {
  const raw = url.searchParams.get('before');
  const before = raw === null ? Number.MAX_SAFE_INTEGER : Number(raw);
  if (!Number.isSafeInteger(before) || before < 1) return json({ error: 'Invalid cursor.' }, 400);
  const since = Date.now() - 86400000;
  const [events, pairings, churn, rejected, flagged] = await Promise.all([
    env.DB.prepare('SELECT id, ts, type, task, contributor, submission, actor, detail FROM events WHERE id < ?1 ORDER BY id DESC LIMIT 51').bind(before).all(),
    env.DB.prepare(`SELECT pair_ip AS network_day, COUNT(*) AS pairings FROM contributors
      WHERE created >= ?1 AND pair_ip IS NOT NULL AND pair_ip != '' GROUP BY pair_ip HAVING COUNT(*) >= 4 ORDER BY pairings DESC`).bind(since).all(),
    // Count lifecycle events, not the claim's final outcome: a claim and release both count.
    env.DB.prepare(`SELECT c.id AS contributor_id, c.handle,
      SUM(CASE WHEN e.type = 'task_claimed' THEN 1 ELSE 0 END) AS claims,
      SUM(CASE WHEN e.type = 'claim_released' THEN 1 ELSE 0 END) AS releases,
      SUM(CASE WHEN e.type = 'claim_expired' THEN 1 ELSE 0 END) AS expires
      FROM events e JOIN contributors c ON c.id = e.contributor
      WHERE e.ts >= ?1 AND e.type IN ('task_claimed','claim_released','claim_expired') GROUP BY c.id ORDER BY claims + releases + expires DESC`).bind(since).all(),
    env.DB.prepare(`SELECT c.id AS contributor_id, c.handle, COUNT(*) AS reviewed,
      SUM(s.status = 'rejected') AS rejected, 1.0 * SUM(s.status = 'rejected') / COUNT(*) AS rejected_ratio
      FROM submissions s JOIN contributors c ON c.id = s.contributor
      WHERE s.status IN ('accepted','rejected') AND COALESCE(s.reviewed_by,'') != 'system' GROUP BY c.id ORDER BY rejected_ratio DESC`).all(),
    env.DB.prepare(`SELECT s.id, s.contributor AS contributor_id, c.handle, s.task, s.flags, s.status
      FROM submissions s JOIN contributors c ON c.id = s.contributor WHERE json_array_length(s.flags) > 0 ORDER BY s.id DESC LIMIT 100`).all(),
  ]);
  const page = events.results.slice(0, 50);
  return json({ notice: UNTRUSTED, events: page, next_before: events.results.length > 50 ? page.at(-1).id : null,
    signals: { window_start: since, pairings_near_cap: pairings.results, claim_churn_24h: churn.results,
      rejected_ratios_all_time: rejected.results, link_flagged: flagged.results.map((r) => ({ ...r, flags: JSON.parse(r.flags) })) } });
}
