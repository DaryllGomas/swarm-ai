// Retention. Individual detail is kept only as long as it is needed to run the system; aggregates are the public record.
//
//   1. The weekly rollup: once per CLOSED ISO week, per project, the aggregate numbers go into weekly_project_stats, and the one
//      people-derived figure (the personal-direction total) goes, already noised and k-protected, into weekly_release. They stay forever.
//      One marker row per week (rollup_weeks) makes it run once; every insert is INSERT OR IGNORE, so a repeat, or two overlapping
//      runs, change nothing. No per-origin split, no claimed count and no model family is kept (docs/DATA-POLICY.md).
//   2. After the rollup, accounts that chose history = weekly_purge lose their per-item detail from rolled-up weeks: the
//      contributor link on their claims and submissions, the submission bodies after review, and the detail of their events.
//      The work stays credited to the project (the claim, the submission, the units and the receipt all remain).
//   3. GET /api/analytics serves the aggregates, with the k-anonymity rule on every count of people.
import { weekOf, weekStartMs, json } from './lib.js';
import { PURGED_HANDLE, K_MIN, bucketFloor, coarseCount, purgedContributorId } from './privacy.js';
import { STANDING, expireClaims } from './core.js';
import { EPSILON, PERSONAL_CAP_UNITS, laplace, secureRng } from './dp.js';

const WEEK = 7 * 86400000;
const MAX_WEEKS_PER_RUN = 60;

// Nearest-rank percentile of a list of numbers (null for an empty list).
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

// The personal-direction release of one closed week: units of work that people steered themselves (their ballot or their own pick,
// added together, never split), from distinct people. Each person's contribution is capped at PERSONAL_CAP_UNITS, so one person moves
// the total by at most that much; Laplace noise of scale cap / epsilon is added; the result is rounded and kept at zero or more. Fewer than
// K_MIN distinct people: nothing (null). Per-project cells are NOT released, so there is no complementary cell to subtract from.
// The exact sum is computed here and dropped; only the noised figure is returned. `rng` is injectable for tests.
export async function personalDirection(env, week, rng = secureRng) {
  const { results } = await env.DB.prepare(
    `SELECT COALESCE(l.account, 'c:' || d.contributor) AS person, t.project AS project, SUM(t.units) AS units FROM (
        SELECT DISTINCT c.task AS task, c.contributor AS contributor FROM claims c
        WHERE c.week = ?1 AND c.routing_origin != 'public_routed' AND ${STANDING}) d
      JOIN tasks t ON t.id = d.task LEFT JOIN account_links l ON l.contributor = d.contributor GROUP BY person, t.project ORDER BY person, t.project`
  ).bind(week).all();
  const left = new Map();
  let total = 0;
  for (const r of results) {
    const remaining = left.has(r.person) ? left.get(r.person) : PERSONAL_CAP_UNITS;
    const take = Math.min(r.units, remaining);
    left.set(r.person, remaining - take);
    total += take;
  }
  const people = left.size;
  if (people < K_MIN) return { units: null, people: bucketFloor(people) };
  return { units: Math.max(0, Math.round(total + laplace(PERSONAL_CAP_UNITS / EPSILON, rng))), people: bucketFloor(people) };
}

// The aggregate numbers of one closed week, per project. Pure reads; nothing here names a person and no per-origin split is made.
export async function weekAggregates(env, week) {
  const start = Date.parse(`${week}T00:00:00Z`), end = start + WEEK;
  const [routed, people, created, accepted, acceptedUnits, rejected, reviews] = await Promise.all([
    env.DB.prepare(`SELECT t.project AS project, SUM(t.units) AS units FROM (
        SELECT DISTINCT c.task AS task, c.contributor AS contributor FROM claims c WHERE c.week = ?1 AND c.routing_origin = 'public_routed' AND ${STANDING}) d
      JOIN tasks t ON t.id = d.task GROUP BY t.project`).bind(week).all(),
    env.DB.prepare(`SELECT t.project AS project, COUNT(DISTINCT c.contributor) AS n FROM claims c JOIN tasks t ON t.id = c.task JOIN contributors u ON u.id = c.contributor
      WHERE c.week = ?1 AND ${STANDING} AND u.removed = 0 AND u.handle != ?2 GROUP BY t.project`).bind(week, PURGED_HANDLE).all(),
    env.DB.prepare('SELECT project, COUNT(*) AS n FROM tasks WHERE created >= ?1 AND created < ?2 GROUP BY project').bind(start, end).all(),
    env.DB.prepare("SELECT t.project AS project, COUNT(*) AS n FROM submissions s JOIN tasks t ON t.id = s.task WHERE s.status = 'accepted' AND s.reviewed_at >= ?1 AND s.reviewed_at < ?2 GROUP BY t.project").bind(start, end).all(),
    env.DB.prepare("SELECT t.project AS project, SUM(t.units) AS units FROM submissions s JOIN tasks t ON t.id = s.task WHERE s.status = 'accepted' AND s.reviewed_at >= ?1 AND s.reviewed_at < ?2 GROUP BY t.project").bind(start, end).all(),
    env.DB.prepare("SELECT t.project AS project, COUNT(*) AS n FROM submissions s JOIN tasks t ON t.id = s.task WHERE s.status = 'rejected' AND COALESCE(s.reviewed_by, '') != 'system' AND s.reviewed_at >= ?1 AND s.reviewed_at < ?2 GROUP BY t.project").bind(start, end).all(),
    env.DB.prepare(`SELECT t.project AS project, s.reviewed_at - s.created AS ms FROM submissions s JOIN tasks t ON t.id = s.task
      WHERE s.status IN ('accepted','rejected') AND COALESCE(s.reviewed_by, '') != 'system' AND s.reviewed_at >= ?1 AND s.reviewed_at < ?2`).bind(start, end).all(),
  ]);
  const projects = new Map();
  const row = (id) => {
    if (!projects.has(id)) projects.set(id, { project: id, routed_units: 0, accepted_units: 0, tasks_created: 0, tasks_accepted: 0, tasks_rejected: 0, contributors: 0, reviews: 0, review_p50_ms: null, review_p90_ms: null });
    return projects.get(id);
  };
  for (const r of routed.results) row(r.project).routed_units = r.units;
  for (const r of acceptedUnits.results) row(r.project).accepted_units = r.units;
  for (const [list, col] of [[people, 'contributors'], [created, 'tasks_created'], [accepted, 'tasks_accepted'], [rejected, 'tasks_rejected']]) {
    for (const r of list.results) row(r.project)[col] = r.n;
  }
  const times = new Map();
  for (const r of reviews.results) { (times.get(r.project) ?? times.set(r.project, []).get(r.project)).push(Math.max(0, r.ms)); }
  for (const [id, list] of times) { const p = row(id); p.reviews = list.length; p.review_p50_ms = percentile(list, 50); p.review_p90_ms = percentile(list, 90); }
  return [...projects.values()];
}

// Roll up one closed week. Safe to repeat: the noise is drawn once, because the week's rows are written once (INSERT OR IGNORE).
export async function rollupWeek(env, week, now = Date.now(), rng = secureRng) {
  const stats = await weekAggregates(env, week);
  const personal = await personalDirection(env, week, rng);
  const stmts = [];
  for (const p of stats) {
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO weekly_project_stats (week, project, routed_units, accepted_units, tasks_created, tasks_accepted, tasks_rejected, contributors, reviews, review_p50_ms, review_p90_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
    ).bind(week, p.project, p.routed_units, p.accepted_units, p.tasks_created, p.tasks_accepted, p.tasks_rejected, p.contributors, p.reviews, p.review_p50_ms, p.review_p90_ms));
  }
  stmts.push(env.DB.prepare('INSERT OR IGNORE INTO weekly_release (week, personal_direction_units, people_floor) VALUES (?1, ?2, ?3)').bind(week, personal.units, personal.people));
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
export async function runRollup(env, now = Date.now(), rng = secureRng) {
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
    try { const r = await rollupWeek(env, week, now, rng); if (r.newly) done.push(week); } catch (err) {
      console.error('rollup failed for', week, String(err?.message || err).slice(0, 200));
      through = ms; break; // never purge detail of a week that was not counted
    }
  }
  return { done, through };
}

// The contributors of accounts that chose history = weekly_purge (owned by, or linked to, such an account).
const PURGE_SET = `(SELECT c.id FROM contributors c JOIN accounts a ON a.id = c.owner_account WHERE a.history = 'weekly_purge' AND c.removed = 0
   UNION SELECT l.contributor FROM account_links l JOIN accounts a ON a.id = l.account WHERE a.history = 'weekly_purge')`;

// An accepted write-up that a mission project still has to publish keeps its body until it is published, but never longer than this after
// its review. After that the body is erased whether or not it was published (the receipt and any published copy are unaffected).
export const UNPUBLISHED_BODY_DAYS = 30;

// Delete the per-item detail of weekly_purge accounts from weeks before `before` (a rolled-up cutoff). The work stays credited to the project.
// Repeating it changes nothing. The event scrub runs FIRST and goes by the claim or submission being purged (its task and id), not only by
// the event's own time, so a newer event about old work (an expiry, a publication, a late review) cannot keep the owner-to-item edge.
export async function purgeHistory(env, before, now = Date.now()) {
  const any = await env.DB.prepare(`SELECT 1 AS n FROM contributors WHERE id IN ${PURGE_SET} LIMIT 1`).first();
  const stand = await purgedContributorId(env);
  const deadline = now - UNPUBLISHED_BODY_DAYS * 86400000;
  const none = { claims: 0, submissions: 0, events: 0, bodies: 0 };
  if (!any) {
    // Nothing to purge for owners; the deferred erasure below belongs to the stand-in, so it still runs.
    const res = await env.DB.batch([deferredBodies(env, stand, deadline)]);
    return { ...none, bodies: res[0].meta.changes };
  }
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE events SET detail = NULL, actor = CASE WHEN actor = (SELECT handle FROM contributors WHERE id = events.contributor) THEN NULL ELSE actor END, contributor = NULL
       WHERE contributor IN ${PURGE_SET} AND type != 'contributor_revoked' AND (ts < ?1
         OR task IN (SELECT task FROM claims WHERE contributor IN ${PURGE_SET} AND outcome IS NOT NULL AND claimed_at < ?1)
         OR submission IN (SELECT id FROM submissions WHERE contributor IN ${PURGE_SET} AND status != 'pending' AND created < ?1 AND reviewed_at < ?1))`
    ).bind(before),
    // Submission bodies after review. An accepted write-up that a mission project still has to publish keeps its body until it is
    // published or UNPUBLISHED_BODY_DAYS after its review, whichever is first; the link to the contributor is cut either way.
    env.DB.prepare(
      `UPDATE submissions SET body = ''
       WHERE contributor IN ${PURGE_SET} AND status != 'pending' AND created < ?1 AND reviewed_at < ?1
         AND NOT (status = 'accepted' AND published_url IS NULL AND reviewed_at >= ?2 AND EXISTS (SELECT 1 FROM tasks t JOIN projects p ON p.id = t.project WHERE t.id = submissions.task AND p.kind = 'mission'))`
    ).bind(before, deadline),
    // The self-reported figures, the pre-screen note, the PR author and the link to the contributor.
    env.DB.prepare(
      `UPDATE submissions SET model = NULL, tokens_est = NULL, prescreen = NULL, pr_author = NULL, contributor = ?1
       WHERE contributor IN ${PURGE_SET} AND status != 'pending' AND created < ?2 AND reviewed_at < ?2`
    ).bind(stand, before),
    env.DB.prepare(`UPDATE claims SET contributor = ?1 WHERE contributor IN ${PURGE_SET} AND outcome IS NOT NULL AND claimed_at < ?2`).bind(stand, before),
    deferredBodies(env, stand, deadline),
  ]);
  const out = { events: res[0].meta.changes, submissions: res[2].meta.changes, claims: res[3].meta.changes, bodies: res[4].meta.changes };
  if (out.submissions + out.claims + out.events + out.bodies) {
    await env.DB.prepare("INSERT INTO events (ts, type, actor, detail) VALUES (?1, 'history_purged', 'system', ?2)").bind(now, JSON.stringify(out)).run();
  }
  return out;
}

// The deferred erasure of a purged write-up: it belongs to the stand-in contributor, not to its former owner, so it does not depend on
// the owner's purge set. Cleared once it is published, or UNPUBLISHED_BODY_DAYS after its review.
const deferredBodies = (env, stand, deadline) => env.DB.prepare(
  `UPDATE submissions SET body = '' WHERE contributor = ?1 AND body != '' AND status = 'accepted' AND (published_url IS NOT NULL OR reviewed_at < ?2)`
).bind(stand, deadline);

// What the hourly job runs: free up expired claims (so they are counted and purged as the closed work they are), roll up closed weeks,
// then purge what the rollup has counted.
export async function runWeeklyMaintenance(env, now = Date.now(), rng = secureRng) {
  await expireClaims(env);
  const rolled = await runRollup(env, now, rng);
  const purged = await purgeHistory(env, rolled.through, now);
  return { rolled: rolled.done, purged };
}

// ---------------------------------------------------------------- public analytics

export async function analytics(env, url) {
  const weeks = Math.min(Math.max(parseInt(url.searchParams.get('weeks') || '12', 10) || 12, 1), 104);
  const [stats, released] = await Promise.all([
    env.DB.prepare('SELECT * FROM weekly_project_stats WHERE week IN (SELECT week FROM rollup_weeks ORDER BY week DESC LIMIT ?1) ORDER BY week DESC, project').bind(weeks).all(),
    env.DB.prepare('SELECT week, personal_direction_units, people_floor FROM weekly_release WHERE week IN (SELECT week FROM rollup_weeks ORDER BY week DESC LIMIT ?1) ORDER BY week DESC').bind(weeks).all(),
  ]);
  const release = new Map(released.results.map((r) => [r.week, r]));
  const byWeek = new Map(released.results.map((r) => [r.week, []]));
  for (const r of stats.results) {
    const entry = {
      project: r.project,
      units: { public_routed: r.routed_units },
      accepted_units: r.accepted_units,
      tasks: { created: r.tasks_created, accepted: r.tasks_accepted, rejected: r.tasks_rejected },
      contributors: coarseCount(r.contributors),
      review: { count: r.reviews, p50_ms: r.reviews >= K_MIN ? r.review_p50_ms : null, p90_ms: r.reviews >= K_MIN ? r.review_p90_ms : null },
    };
    (byWeek.get(r.week) ?? byWeek.set(r.week, []).get(r.week)).push(entry);
  }
  return json({
    updated: new Date().toISOString(),
    note: 'Weekly totals per project, published after each week closes and kept forever. Public-routed units are what the allocation is compared with. Work that people steered themselves (by their ballot or by picking a task) is released only as one total for the whole week, with random noise, and only when at least 5 different people stood behind it; there is no per-project or per-origin split, no count of claims and no breakdown by AI model. Counts of people are published as "fewer than 5" or a coarse range. Review times are shown from 5 reviews.',
    personal_direction_note: `Each person's contribution is capped at ${PERSONAL_CAP_UNITS} units, then Laplace noise (epsilon ${EPSILON} per week) is added to the total. It is an estimate, not a count. null means fewer than 5 people, so nothing is released.`,
    weeks: [...byWeek].map(([week, projects]) => ({
      week,
      personal_direction: { units: release.get(week)?.personal_direction_units ?? null, people: release.get(week) ? coarseCount(release.get(week).people_floor) : 'fewer than 5' },
      projects,
    })),
  }, 200, { 'Cache-Control': 'public, max-age=300' });
}
