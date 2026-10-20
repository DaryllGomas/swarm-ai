// Data rules shared by the MCP server, the public API and the admin API.
import { weekOf, weekStartMs } from './lib.js';

export const CLAIM_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours
export const MAX_ACTIVE_CLAIMS = 2; // per contributor
export const MAX_ACTIVE_CLAIMS_PER_NETWORK = 4; // across all handles on one network (anti-squatting)
export const UNITS = [1, 3, 8];
export const PROVISIONAL_NOTE = 'Provisional — public voting opens soon';

export function eventStmt(env, e) {
  return env.DB.prepare(
    'INSERT INTO events (ts, type, task, contributor, submission, actor, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
  ).bind(Date.now(), e.type, e.task ?? null, e.contributor ?? null, e.submission ?? null, e.actor ?? null, e.detail ? JSON.stringify(e.detail) : null);
}

// Many root tasks in one D1 call (sync). There is no child-task creation: task splitting is planned, not built (docs/ARCHITECTURE.md,
// "Task splitting (planned)"), and every task here is a root task with parent NULL.
// Idempotent on source_key; the creation event is written once per task.
// Each task arrives already screened: status is 'ready' or 'held' (injection-like text, never served), with held_reason.
// A task that already exists and has not been claimed yet follows its source: changed text is updated, and it moves
// between ready and held as the screen result changes. Claimed, submitted and finished tasks are never touched.
export async function addTasksBulk(env, tasks) {
  const PER_TASK = 4;
  const stmts = [];
  const now = Date.now();
  for (const t of tasks) {
    if (!UNITS.includes(t.units)) throw new Error('units must be 1, 3 or 8');
    const status = t.status === 'held' ? 'held' : 'ready';
    const reason = status === 'held' ? t.held_reason || 'screen' : null;
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO tasks (project, parent, kind, title, brief, output_format, units, status, held_reason, source_key, created)
       VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?9, ?10, ?7, ?8)`
    ).bind(t.project, t.kind, t.title, t.brief, t.output_format, t.units, t.source_key, now, status, reason));
    stmts.push(env.DB.prepare(
      `UPDATE tasks SET title = ?2, brief = ?3, output_format = ?4, status = ?5, held_reason = ?6
       WHERE source_key = ?1 AND status IN ('ready','held') AND (brief != ?3 OR title != ?2 OR output_format != ?4 OR status != ?5)`
    ).bind(t.source_key, t.title, t.brief, t.output_format, status, reason));
    stmts.push(env.DB.prepare(
      `INSERT INTO events (ts, type, task, actor, detail)
       SELECT ?2, 'task_created', id, 'sync', ?3 FROM tasks
       WHERE source_key = ?1 AND NOT EXISTS (SELECT 1 FROM events e WHERE e.type = 'task_created' AND e.task = tasks.id)`
    ).bind(t.source_key, now, JSON.stringify({ source_key: t.source_key, units: t.units })));
    stmts.push(env.DB.prepare(
      `INSERT INTO events (ts, type, task, actor, detail)
       SELECT ?2, 'task_held', id, 'sync', ?3 FROM tasks
       WHERE source_key = ?1 AND status = 'held' AND NOT EXISTS (SELECT 1 FROM events e WHERE e.type = 'task_held' AND e.task = tasks.id AND e.detail = ?3)`
    ).bind(t.source_key, now, JSON.stringify({ reason: reason ?? 'screen' })));
  }
  let created = 0;
  const chunk = PER_TASK * 20;
  for (let i = 0; i < stmts.length; i += chunk) {
    const res = await env.DB.batch(stmts.slice(i, i + chunk));
    for (let j = 0; j < res.length; j += PER_TASK) created += res[j].meta.changes;
  }
  return created;
}

// A fresh id for one request's transition. Statements that win a row stamp it there (claims.op, submissions.op), and the
// later statements of the same transaction run only when the row carries their own id.
export const newOp = () => crypto.randomUUID();

// Close ONE claim as 'released' or 'expired', and reopen its task, as one set of three statements for env.DB.batch.
// D1 batches are transactional. The task change and the event run only if THIS request won the transition of THIS claim
// (the claim now has this outcome and this op), so a stale or repeated request changes nothing: it can never reopen a task
// that a newer claim, submission or review now owns. res[0].meta.changes tells the caller whether it won.
//   outcome 'released': a live claim only (expires_at > now), 'expired': one that has run out (expires_at <= now).
export function closeClaimStmts(env, { claim, task, contributor, outcome, actor, now = Date.now(), op = newOp() }) {
  const expired = outcome === 'expired';
  return [
    env.DB.prepare(
      `UPDATE claims SET outcome = ?2, released = ?3, op = ?4
       WHERE id = ?1 AND outcome IS NULL AND ((?6 = 1 AND expires_at <= ?5) OR (?6 = 0 AND expires_at > ?5))`
    ).bind(claim, outcome, expired ? 0 : 1, op, now, expired ? 1 : 0),
    env.DB.prepare(
      `UPDATE tasks SET status = 'ready'
       WHERE id = ?2 AND status = 'claimed' AND EXISTS (SELECT 1 FROM claims WHERE id = ?1 AND outcome = ?3 AND op = ?4)`
    ).bind(claim, task, outcome, op),
    env.DB.prepare(
      `INSERT INTO events (ts, type, task, contributor, submission, actor, detail)
       SELECT ?5, ?6, ?2, ?7, NULL, ?8, json_object('claim', id) FROM claims WHERE id = ?1 AND outcome = ?3 AND op = ?4`
    ).bind(claim, task, outcome, op, now, `claim_${outcome}`, contributor, actor),
  ];
}

// Claims that ran past their 3 hours go back to the pool. Cheap enough to run before any work call and hourly in cron.
// Each claim is its own conditional transition (see closeClaimStmts), so two overlapping sweeps, or a sweep racing a release,
// change a task once, and never touch a task that has since been claimed by someone else.
// { task } limits the sweep to one task: claim() runs it so an expired claim never blocks a new claim on that task.
export async function expireClaims(env, { task = null } = {}) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    'SELECT id, task, contributor FROM claims WHERE outcome IS NULL AND expires_at <= ?1 AND (?2 IS NULL OR task = ?2)'
  ).bind(now, task).all();
  if (!results.length) return 0;
  const stmts = results.flatMap((c) => closeClaimStmts(env, { claim: c.id, task: c.task, contributor: c.contributor, outcome: 'expired', actor: 'system', now }));
  const res = await env.DB.batch(stmts);
  let won = 0;
  for (let i = 0; i < res.length; i += 3) won += res[i].meta.changes;
  return won;
}

// The allocation in force: the newest week at or before this one.
export async function currentAllocation(env, ms = Date.now()) {
  const wk = weekOf(ms);
  const row = await env.DB.prepare('SELECT MAX(week) AS w FROM allocation WHERE week <= ?1').bind(wk).first();
  if (!row?.w) return { week: wk, shares: {}, provisional: {} };
  const { results } = await env.DB.prepare('SELECT project, share, provisional FROM allocation WHERE week = ?1').bind(row.w).all();
  const shares = {}, provisional = {};
  for (const r of results) { shares[r.project] = r.share; provisional[r.project] = !!r.provisional; }
  return { week: row.w, shares, provisional };
}

// Units counted as "routed" this week: assignments through next_task that are still standing (active or handed in).
// One task by one contributor counts once, however often it was claimed and released. Released and expired are reported apart.
const DISTINCT_CLAIMS = `
  SELECT DISTINCT c.task AS task, c.contributor AS contributor FROM claims c
  WHERE c.week = ?1 AND c.routed = ?2 AND %FILTER%`;

export async function unitsByProject(env, week, routed, filter) {
  const sql = `SELECT t.project AS project, SUM(t.units) AS units FROM (${DISTINCT_CLAIMS.replace('%FILTER%', filter)}) d JOIN tasks t ON t.id = d.task GROUP BY t.project`;
  const { results } = await env.DB.prepare(sql).bind(week, routed).all();
  return Object.fromEntries(results.map((r) => [r.project, r.units]));
}
export const STANDING = "(c.outcome IS NULL OR c.outcome = 'submitted')";
// Released or expired claims, unless the same contributor later got that task standing in the same week (then it counts once, as standing).
export const LOST = `c.outcome IN ('released','expired') AND NOT EXISTS (
  SELECT 1 FROM claims c2 WHERE c2.task = c.task AND c2.contributor = c.contributor AND c2.week = c.week AND c2.routed = c.routed
  AND (c2.outcome IS NULL OR c2.outcome = 'submitted'))`;

export async function weekStats(env, now = Date.now()) {
  const week = weekOf(now);
  const start = weekStartMs(now);
  const end = start + 7 * 86400000;
  const [alloc, projects, routed, selfDirected, lost, accepted, acceptedAll, open, pending, active, totals] = await Promise.all([
    currentAllocation(env, now),
    env.DB.prepare('SELECT id, name, kind, summary, url, reviewer, sponsored, active, paused, max_pending FROM projects WHERE active = 1 ORDER BY name').all(),
    unitsByProject(env, week, 1, STANDING),
    unitsByProject(env, week, 0, STANDING),
    unitsByProject(env, week, 1, LOST),
    env.DB.prepare(`SELECT t.project AS project, SUM(t.units) AS units FROM submissions s JOIN tasks t ON t.id = s.task
                    WHERE s.status = 'accepted' AND s.reviewed_at >= ?1 AND s.reviewed_at < ?2 GROUP BY t.project`).bind(start, end).all(),
    env.DB.prepare(`SELECT t.project AS project, SUM(t.units) AS units FROM submissions s JOIN tasks t ON t.id = s.task
                    WHERE s.status = 'accepted' GROUP BY t.project`).all(),
    env.DB.prepare("SELECT project, COUNT(*) AS n FROM tasks WHERE status = 'ready' GROUP BY project").all(),
    env.DB.prepare("SELECT t.project AS project, COUNT(*) AS n FROM submissions s JOIN tasks t ON t.id = s.task WHERE s.status = 'pending' GROUP BY t.project").all(),
    env.DB.prepare("SELECT t.project AS project, COUNT(*) AS n FROM claims c JOIN tasks t ON t.id = c.task WHERE c.outcome IS NULL AND c.expires_at > ?1 GROUP BY t.project").bind(now).all(),
    env.DB.batch([
      env.DB.prepare('SELECT COUNT(*) AS n FROM contributors'),
      env.DB.prepare('SELECT COUNT(*) AS n FROM submissions'),
      env.DB.prepare("SELECT COUNT(*) AS n FROM submissions WHERE status = 'accepted'"),
    ]),
  ]);
  const by = (r) => Object.fromEntries(r.results.map((x) => [x.project, x.units ?? x.n]));
  const acc = by(accepted), accAll = by(acceptedAll), openBy = by(open), pendBy = by(pending), actBy = by(active);
  const totalRouted = Object.values(routed).reduce((a, b) => a + b, 0);

  const list = projects.results.map((p) => {
    const share = alloc.shares[p.id] ?? 0;
    const r = routed[p.id] || 0;
    const routedShare = totalRouted ? (100 * r) / totalRouted : 0;
    const openTasks = openBy[p.id] || 0;
    const pend = pendBy[p.id] || 0;
    let gap = null;
    if (share > 0 && routedShare + 0.5 < share) {
      if (p.paused) gap = 'New assignments are paused by the operator.';
      else if (!totalRouted) gap = 'No work has been routed yet this week. Nothing is invented to hit a percentage; units are counted when an agent asks for work.';
      else if (openTasks === 0) gap = 'There are no ready tasks right now, so nothing more can be routed here.';
      else if (pend >= p.max_pending) gap = `The reviewer has ${pend} submissions waiting (the limit is ${p.max_pending}), so routing here is paused until some are reviewed.`;
      else gap = 'Work here is waiting for agents to ask for it. Routing follows requests; it never forces assignments.';
    }
    return {
      id: p.id, name: p.name, kind: p.kind, summary: p.summary, url: p.url, reviewer: p.reviewer, sponsored: !!p.sponsored, paused: !!p.paused,
      allocation: { share, provisional: alloc.provisional[p.id] ?? true },
      routed_units: r,
      routed_share: Math.round(routedShare * 10) / 10,
      self_directed_units: selfDirected[p.id] || 0,
      routed_released_or_expired_units: lost[p.id] || 0,
      accepted_units: acc[p.id] || 0,
      accepted_units_all_time: accAll[p.id] || 0,
      open_tasks: openTasks,
      pending_reviews: pend,
      active_claims: actBy[p.id] || 0,
      reviewer_capacity: { max_pending: p.max_pending, paused: pend >= p.max_pending },
      gap_reason: gap,
    };
  });
  return {
    week, week_start: new Date(start).toISOString(), updated: new Date(now).toISOString(),
    allocation_week: alloc.week, allocation_note: list.some((p) => p.allocation.provisional) ? PROVISIONAL_NOTE : null,
    routed_note: 'Routed = acknowledged assignments weighted by work units; not compute consumed.',
    projects: list,
    totals: { contributors: totals[0].results[0].n, submissions: totals[1].results[0].n, accepted: totals[2].results[0].n },
  };
}
