// Data rules shared by the MCP server, the public API and the admin API.
import { weekOf, weekStartMs } from './lib.js';

export const CLAIM_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours
export const MAX_ACTIVE_CLAIMS = 2;
export const UNITS = [1, 3, 8];
export const PROVISIONAL_NOTE = 'Provisional — public voting opens soon';

export function eventStmt(env, e) {
  return env.DB.prepare(
    'INSERT INTO events (ts, type, task, contributor, submission, actor, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
  ).bind(Date.now(), e.type, e.task ?? null, e.contributor ?? null, e.submission ?? null, e.actor ?? null, e.detail ? JSON.stringify(e.detail) : null);
}

// Create a task. A child's units come out of its parent's budget: the children together may never exceed it.
export async function addTask(env, t) {
  if (!UNITS.includes(t.units)) throw new Error('units must be 1, 3 or 8');
  if (t.parent) {
    const parent = await env.DB.prepare('SELECT units FROM tasks WHERE id = ?1').bind(t.parent).first();
    if (!parent) throw new Error('parent task not found');
    const used = await env.DB.prepare("SELECT COALESCE(SUM(units), 0) AS n FROM tasks WHERE parent = ?1 AND status != 'closed'").bind(t.parent).first();
    if (used.n + t.units > parent.units) throw new Error(`children would use ${used.n + t.units} units; the parent's budget is ${parent.units}`);
  }
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO tasks (project, parent, kind, title, brief, output_format, units, status, source_key, created)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'ready', ?8, ?9)`
  ).bind(t.project, t.parent ?? null, t.kind, t.title, t.brief, t.output_format, t.units, t.source_key ?? null, Date.now()).run();
  if (res.meta.changes) {
    await eventStmt(env, { type: 'task_created', task: res.meta.last_row_id, actor: 'sync', detail: { source_key: t.source_key, units: t.units } }).run();
    return res.meta.last_row_id;
  }
  return null;
}

// Many root tasks in one D1 call (sync). Idempotent on source_key; the creation event is written once per task.
export async function addTasksBulk(env, tasks) {
  const stmts = [];
  const now = Date.now();
  for (const t of tasks) {
    if (!UNITS.includes(t.units)) throw new Error('units must be 1, 3 or 8');
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO tasks (project, parent, kind, title, brief, output_format, units, status, source_key, created)
       VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, 'ready', ?7, ?8)`
    ).bind(t.project, t.kind, t.title, t.brief, t.output_format, t.units, t.source_key, now));
    stmts.push(env.DB.prepare(
      `INSERT INTO events (ts, type, task, actor, detail)
       SELECT ?2, 'task_created', id, 'sync', ?3 FROM tasks
       WHERE source_key = ?1 AND NOT EXISTS (SELECT 1 FROM events e WHERE e.type = 'task_created' AND e.task = tasks.id)`
    ).bind(t.source_key, now, JSON.stringify({ source_key: t.source_key, units: t.units })));
  }
  let created = 0;
  for (let i = 0; i < stmts.length; i += 80) {
    const res = await env.DB.batch(stmts.slice(i, i + 80));
    for (let j = 0; j < res.length; j += 2) created += res[j].meta.changes;
  }
  return created;
}

// Claims that ran past their 3 hours go back to the pool. Cheap enough to run before any work call and hourly in cron.
export async function expireClaims(env) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    'SELECT id, task, contributor FROM claims WHERE outcome IS NULL AND expires_at <= ?1'
  ).bind(now).all();
  if (!results.length) return 0;
  const stmts = [];
  for (const c of results) {
    stmts.push(env.DB.prepare("UPDATE claims SET outcome = 'expired' WHERE id = ?1 AND outcome IS NULL").bind(c.id));
    stmts.push(env.DB.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?1 AND status = 'claimed'").bind(c.task));
    stmts.push(eventStmt(env, { type: 'claim_expired', task: c.task, contributor: c.contributor, actor: 'system', detail: { claim: c.id } }));
  }
  await env.DB.batch(stmts);
  return results.length;
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
    env.DB.prepare('SELECT id, name, kind, summary, url, reviewer, sponsored, active, max_pending FROM projects WHERE active = 1 ORDER BY name').all(),
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
      if (!totalRouted) gap = 'No work has been routed yet this week. Nothing is invented to hit a percentage; units are counted when an agent asks for work.';
      else if (openTasks === 0) gap = 'There are no ready tasks right now, so nothing more can be routed here.';
      else if (pend >= p.max_pending) gap = `The reviewer has ${pend} submissions waiting (the limit is ${p.max_pending}), so routing here is paused until some are reviewed.`;
      else gap = 'Work here is waiting for agents to ask for it. Routing follows requests; it never forces assignments.';
    }
    return {
      id: p.id, name: p.name, kind: p.kind, summary: p.summary, url: p.url, reviewer: p.reviewer, sponsored: !!p.sponsored,
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
