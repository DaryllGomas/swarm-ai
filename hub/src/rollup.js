// Retention. Individual detail is kept only as long as it is needed to run the system; aggregates are the public record.
//
//   1. The weekly rollup: once per CLOSED ISO week, per project, the aggregate numbers go into weekly_project_stats and
//      weekly_model_stats and stay forever. One marker row per week (rollup_weeks) makes it run once; every insert is
//      INSERT OR IGNORE, so a repeat, or two overlapping runs, change nothing.
//   2. After the rollup, accounts that chose history = weekly_purge lose their per-item detail from rolled-up weeks: the
//      contributor link on their claims and submissions, the submission bodies after review, and the detail of their events.
//      The work stays credited to the project (the claim, the submission, the units and the receipt all remain).
//   3. GET /api/analytics serves the aggregates, with the k-anonymity rule on every count of people.
import { weekOf, weekStartMs, json } from './lib.js';
import { PURGED_HANDLE, K_MIN, MODEL_FAMILIES, kCount, modelFamily, purgedContributorId } from './privacy.js';
import { STANDING } from './core.js';

const WEEK = 7 * 86400000;
const ORIGIN_COL = { public_routed: 'routed_units', ballot_directed: 'ballot_directed_units', self_picked: 'self_picked_units' };
const ACCEPTED_COL = { public_routed: 'accepted_routed_units', ballot_directed: 'accepted_ballot_directed_units', self_picked: 'accepted_self_picked_units' };
const MAX_WEEKS_PER_RUN = 60;

// Nearest-rank percentile of a list of numbers (null for an empty list).
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

// How many people stood behind a week's ballot-directed work: distinct voter accounts (or, for an AI no longer linked, distinct contributors).
export const BALLOT_DIRECTED_PEOPLE = `SELECT COUNT(DISTINCT COALESCE(l.account, 'c:' || c.contributor)) AS n FROM claims c
  LEFT JOIN account_links l ON l.contributor = c.contributor WHERE c.week = ?1 AND c.routing_origin = 'ballot_directed' AND ${STANDING}`;

// The aggregate numbers of one closed week, per project. Pure reads; nothing here names a person.
export async function weekAggregates(env, week) {
  const start = Date.parse(`${week}T00:00:00Z`), end = start + WEEK;
  const [units, people, bdPeople, created, claimed, submitted, accepted, acceptedUnits, rejected, reviews, models] = await Promise.all([
    env.DB.prepare(`SELECT t.project AS project, d.origin AS origin, SUM(t.units) AS units FROM (
        SELECT DISTINCT c.task AS task, c.contributor AS contributor, c.routing_origin AS origin FROM claims c WHERE c.week = ?1 AND ${STANDING}) d
      JOIN tasks t ON t.id = d.task GROUP BY t.project, d.origin`).bind(week).all(),
    env.DB.prepare(`SELECT t.project AS project, COUNT(DISTINCT c.contributor) AS n FROM claims c JOIN tasks t ON t.id = c.task JOIN contributors u ON u.id = c.contributor
      WHERE c.week = ?1 AND ${STANDING} AND u.removed = 0 AND u.handle != ?2 GROUP BY t.project`).bind(week, PURGED_HANDLE).all(),
    env.DB.prepare(BALLOT_DIRECTED_PEOPLE).bind(week).first(),
    env.DB.prepare('SELECT project, COUNT(*) AS n FROM tasks WHERE created >= ?1 AND created < ?2 GROUP BY project').bind(start, end).all(),
    env.DB.prepare(`SELECT t.project AS project, COUNT(DISTINCT c.task) AS n FROM claims c JOIN tasks t ON t.id = c.task WHERE c.week = ?1 AND ${STANDING} GROUP BY t.project`).bind(week).all(),
    env.DB.prepare('SELECT t.project AS project, COUNT(*) AS n FROM submissions s JOIN tasks t ON t.id = s.task WHERE s.created >= ?1 AND s.created < ?2 GROUP BY t.project').bind(start, end).all(),
    env.DB.prepare("SELECT t.project AS project, COUNT(*) AS n FROM submissions s JOIN tasks t ON t.id = s.task WHERE s.status = 'accepted' AND s.reviewed_at >= ?1 AND s.reviewed_at < ?2 GROUP BY t.project").bind(start, end).all(),
    env.DB.prepare(`SELECT t.project AS project, c.routing_origin AS origin, SUM(t.units) AS units FROM submissions s JOIN tasks t ON t.id = s.task JOIN claims c ON c.id = s.claim
      WHERE s.status = 'accepted' AND s.reviewed_at >= ?1 AND s.reviewed_at < ?2 GROUP BY t.project, c.routing_origin`).bind(start, end).all(),
    env.DB.prepare("SELECT t.project AS project, COUNT(*) AS n FROM submissions s JOIN tasks t ON t.id = s.task WHERE s.status = 'rejected' AND COALESCE(s.reviewed_by, '') != 'system' AND s.reviewed_at >= ?1 AND s.reviewed_at < ?2 GROUP BY t.project").bind(start, end).all(),
    env.DB.prepare(`SELECT t.project AS project, s.reviewed_at - s.created AS ms FROM submissions s JOIN tasks t ON t.id = s.task
      WHERE s.status IN ('accepted','rejected') AND COALESCE(s.reviewed_by, '') != 'system' AND s.reviewed_at >= ?1 AND s.reviewed_at < ?2`).bind(start, end).all(),
    env.DB.prepare('SELECT t.project AS project, s.model AS model FROM submissions s JOIN tasks t ON t.id = s.task WHERE s.created >= ?1 AND s.created < ?2').bind(start, end).all(),
  ]);
  const projects = new Map();
  const row = (id) => {
    if (!projects.has(id)) projects.set(id, {
      project: id, routed_units: 0, ballot_directed_units: 0, self_picked_units: 0, accepted_routed_units: 0, accepted_ballot_directed_units: 0, accepted_self_picked_units: 0,
      tasks_created: 0, tasks_claimed: 0, tasks_submitted: 0, tasks_accepted: 0, tasks_rejected: 0, contributors: 0, reviews: 0, review_p50_ms: null, review_p90_ms: null, models: {}, ballot_directed_people: bdPeople?.n ?? 0,
    });
    return projects.get(id);
  };
  for (const r of units.results) row(r.project)[ORIGIN_COL[r.origin]] += r.units;
  for (const r of acceptedUnits.results) row(r.project)[ACCEPTED_COL[r.origin]] += r.units;
  for (const [list, col] of [[people, 'contributors'], [created, 'tasks_created'], [claimed, 'tasks_claimed'], [submitted, 'tasks_submitted'], [accepted, 'tasks_accepted'], [rejected, 'tasks_rejected']]) {
    for (const r of list.results) row(r.project)[col] = r.n;
  }
  const times = new Map();
  for (const r of reviews.results) { (times.get(r.project) ?? times.set(r.project, []).get(r.project)).push(Math.max(0, r.ms)); }
  for (const [id, list] of times) { const p = row(id); p.reviews = list.length; p.review_p50_ms = percentile(list, 50); p.review_p90_ms = percentile(list, 90); }
  for (const r of models.results) { const p = row(r.project), f = modelFamily(r.model); p.models[f] = (p.models[f] ?? 0) + 1; }
  return [...projects.values()];
}

// Roll up one closed week. Safe to repeat.
export async function rollupWeek(env, week, now = Date.now()) {
  const stats = await weekAggregates(env, week);
  const stmts = [];
  for (const p of stats) {
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO weekly_project_stats (week, project, routed_units, ballot_directed_units, self_picked_units,
         accepted_routed_units, accepted_ballot_directed_units, accepted_self_picked_units, ballot_directed_people,
         tasks_created, tasks_claimed, tasks_submitted, tasks_accepted, tasks_rejected, contributors, reviews, review_p50_ms, review_p90_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?18, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`
    ).bind(week, p.project, p.routed_units, p.ballot_directed_units, p.self_picked_units, p.accepted_routed_units, p.accepted_ballot_directed_units, p.accepted_self_picked_units,
      p.tasks_created, p.tasks_claimed, p.tasks_submitted, p.tasks_accepted, p.tasks_rejected, p.contributors, p.reviews, p.review_p50_ms, p.review_p90_ms, p.ballot_directed_people));
    for (const [family, n] of Object.entries(p.models)) {
      stmts.push(env.DB.prepare('INSERT OR IGNORE INTO weekly_model_stats (week, project, family, submissions) VALUES (?1, ?2, ?3, ?4)').bind(week, p.project, family, n));
    }
  }
  // The marker goes last: a week counts as rolled up only when everything before it was written.
  stmts.push(env.DB.prepare('INSERT OR IGNORE INTO rollup_weeks (week, ran_at) VALUES (?1, ?2)').bind(week, now));
  const res = await env.DB.batch(stmts);
  return { week, projects: stats.length, newly: res.at(-1).meta.changes > 0 };
}

// The Monday of the oldest week with any data, or null.
async function firstWeek(env) {
  const r = await env.DB.prepare(
    `SELECT MIN(m) AS m FROM (SELECT MIN(claimed_at) AS m FROM claims UNION ALL SELECT MIN(created) FROM submissions UNION ALL SELECT MIN(created) FROM tasks)`
  ).first();
  return r?.m == null ? null : weekStartMs(r.m);
}

// Roll up every closed week that has not been rolled up yet, oldest first. Returns the weeks done and the time before which every week
// is rolled up (the purge only touches detail older than that).
export async function runRollup(env, now = Date.now()) {
  const current = weekStartMs(now);
  const first = await firstWeek(env);
  const done = [];
  let through = current;
  if (first === null || first >= current) return { done, through };
  const { results } = await env.DB.prepare('SELECT week FROM rollup_weeks').all();
  const have = new Set(results.map((r) => r.week));
  let count = 0;
  for (let ms = first; ms < current; ms += WEEK) {
    const week = weekOf(ms);
    if (have.has(week)) continue;
    if (count++ >= MAX_WEEKS_PER_RUN) { through = ms; break; }
    try { const r = await rollupWeek(env, week, now); if (r.newly) done.push(week); } catch (err) {
      console.error('rollup failed for', week, String(err?.message || err).slice(0, 200));
      through = ms; break; // never purge detail of a week that was not counted
    }
  }
  return { done, through };
}

// The contributors of accounts that chose history = weekly_purge (owned by, or linked to, such an account).
const PURGE_SET = `(SELECT c.id FROM contributors c JOIN accounts a ON a.id = c.owner_account WHERE a.history = 'weekly_purge' AND c.removed = 0
   UNION SELECT l.contributor FROM account_links l JOIN accounts a ON a.id = l.account WHERE a.history = 'weekly_purge')`;

// Delete the per-item detail of weekly_purge accounts from weeks before `before` (a rolled-up cutoff). The work stays credited to the project.
// Repeating it changes nothing.
export async function purgeHistory(env, before, now = Date.now()) {
  const any = await env.DB.prepare(`SELECT 1 AS n FROM contributors WHERE id IN ${PURGE_SET} LIMIT 1`).first();
  if (!any) return { claims: 0, submissions: 0, events: 0 };
  const stand = await purgedContributorId(env);
  const res = await env.DB.batch([
    // Submission bodies after review. An accepted write-up that a mission project still has to publish keeps its body until it is
    // published, so accepted work is not lost; the link to the contributor is cut either way (next statement).
    env.DB.prepare(
      `UPDATE submissions SET body = ''
       WHERE contributor IN ${PURGE_SET} AND status != 'pending' AND created < ?1 AND reviewed_at < ?1
         AND NOT (status = 'accepted' AND published_url IS NULL AND EXISTS (SELECT 1 FROM tasks t JOIN projects p ON p.id = t.project WHERE t.id = submissions.task AND p.kind = 'mission'))`
    ).bind(before),
    // The self-reported figures, the pre-screen note, the PR author and the link to the contributor.
    env.DB.prepare(
      `UPDATE submissions SET model = NULL, tokens_est = NULL, prescreen = NULL, pr_author = NULL, contributor = ?1
       WHERE contributor IN ${PURGE_SET} AND status != 'pending' AND created < ?2 AND reviewed_at < ?2`
    ).bind(stand, before),
    env.DB.prepare(`UPDATE claims SET contributor = ?1 WHERE contributor IN ${PURGE_SET} AND outcome IS NOT NULL AND claimed_at < ?2`).bind(stand, before),
    env.DB.prepare(
      `UPDATE events SET detail = NULL, actor = CASE WHEN actor = (SELECT handle FROM contributors WHERE id = events.contributor) THEN NULL ELSE actor END, contributor = NULL
       WHERE contributor IN ${PURGE_SET} AND ts < ?1 AND type != 'contributor_revoked'`
    ).bind(before),
  ]);
  const out = { submissions: res[1].meta.changes, claims: res[2].meta.changes, events: res[3].meta.changes };
  if (out.submissions + out.claims + out.events) {
    await env.DB.prepare("INSERT INTO events (ts, type, actor, detail) VALUES (?1, 'history_purged', 'system', ?2)").bind(now, JSON.stringify(out)).run();
  }
  return out;
}

// What the hourly job runs: roll up closed weeks, then purge what the rollup has counted.
export async function runWeeklyMaintenance(env, now = Date.now()) {
  const rolled = await runRollup(env, now);
  const purged = await purgeHistory(env, rolled.through, now);
  return { rolled: rolled.done, purged };
}

// ---------------------------------------------------------------- public analytics

export async function analytics(env, url) {
  const weeks = Math.min(Math.max(parseInt(url.searchParams.get('weeks') || '12', 10) || 12, 1), 104);
  const [stats, models] = await Promise.all([
    env.DB.prepare('SELECT * FROM weekly_project_stats WHERE week IN (SELECT week FROM rollup_weeks ORDER BY week DESC LIMIT ?1) ORDER BY week DESC, project').bind(weeks).all(),
    env.DB.prepare('SELECT week, project, family, submissions FROM weekly_model_stats WHERE week IN (SELECT week FROM rollup_weeks ORDER BY week DESC LIMIT ?1) ORDER BY week DESC, project, family').bind(weeks).all(),
  ]);
  const fam = new Map();
  for (const m of models.results) { const k = `${m.week}|${m.project}`; (fam.get(k) ?? fam.set(k, {}).get(k))[m.family] = kCount(m.submissions); }
  const byWeek = new Map();
  for (const r of stats.results) {
    const bdShown = r.ballot_directed_people != null && r.ballot_directed_people >= K_MIN;
    const entry = {
      project: r.project,
      // Ballot-directed work follows a voter's own ballot, so per project it is shown only when at least 5 people stood behind that week's.
      units: { routed: r.routed_units, ballot_directed: bdShown ? r.ballot_directed_units : null, self_picked: r.self_picked_units },
      accepted_units: { routed: r.accepted_routed_units, ballot_directed: bdShown ? r.accepted_ballot_directed_units : null, self_picked: r.accepted_self_picked_units },
      tasks: { created: r.tasks_created, claimed: r.tasks_claimed, submitted: r.tasks_submitted, accepted: r.tasks_accepted, rejected: r.tasks_rejected },
      contributors: kCount(r.contributors),
      review: { count: r.reviews, p50_ms: r.reviews >= K_MIN ? r.review_p50_ms : null, p90_ms: r.reviews >= K_MIN ? r.review_p90_ms : null },
      model_families: fam.get(`${r.week}|${r.project}`) ?? {},
    };
    (byWeek.get(r.week) ?? byWeek.set(r.week, []).get(r.week)).push(entry);
  }
  return json({
    updated: new Date().toISOString(),
    note: 'Weekly totals per project, kept forever. Units and task counts are about work and are exact. Counts of people, and of work by model family, below 5 show as "fewer than 5". Ballot-directed units follow a voter own ballot and are published (null otherwise) only for weeks when at least 5 people stood behind them. The three routing origins are never added together. Review times are shown from 5 reviews. Model families come from what an agent reports about itself; only the family is kept.',
    families: MODEL_FAMILIES,
    weeks: [...byWeek].map(([week, projects]) => ({ week, projects })),
  }, 200, { 'Cache-Control': 'public, max-age=300' });
}

