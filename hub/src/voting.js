import { currentAllocation } from './core.js';
import { readJson, weekOf, weekStartMs } from './lib.js';
import { privateJson, session, writeGuard } from './accounts.js';
import { random } from './webauthn.js';
import { K_MIN, coarseCount } from './privacy.js';
import { utcDay } from './lib.js';

export const FALLBACK_REASON = 'fewer than 5 eligible ballots';
export const NO_PROJECTION_REASON = 'fewer than 5 ballots';

// The latest ballot strictly before the cutoff. Each complete valid ballot has equal weight.
// If a project was deactivated, the ballot must be saved again before it counts: never silently reweight a voter.
const ELIGIBLE = `WITH latest AS (
  SELECT b.* FROM ballot_versions b JOIN accounts a ON a.id = b.account
  WHERE a.created < ?1 AND a.suspended = 0 AND b.created < ?2
    AND b.id = (SELECT b2.id FROM ballot_versions b2 WHERE b2.account = b.account AND b2.created < ?2 ORDER BY b2.version DESC LIMIT 1)
), valid AS (
  SELECT * FROM latest b WHERE
    (SELECT COALESCE(SUM(CAST(j.value AS INTEGER)),0) FROM json_each(b.allocations) j JOIN projects p ON p.id = j.key AND p.active = 1) = 100
    AND NOT EXISTS (SELECT 1 FROM json_each(b.allocations) j LEFT JOIN projects p ON p.id = j.key WHERE p.id IS NULL OR p.active != 1)
)`;
const SHARES = `, totals AS (
  SELECT p.id AS project, COALESCE(SUM(CAST(j.value AS INTEGER)),0) AS points
  FROM projects p LEFT JOIN valid b ON 1=1 LEFT JOIN json_each(b.allocations) j ON j.key = p.id
  WHERE p.active = 1 GROUP BY p.id
), divided AS (
  SELECT project, (points * 10000) / ((SELECT COUNT(*) FROM valid) * 100) AS base,
    (points * 10000) % ((SELECT COUNT(*) FROM valid) * 100) AS remainder FROM totals
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY remainder DESC, project) AS rank,
    10000 - SUM(base) OVER () AS leftover FROM divided
) SELECT project, base + CASE WHEN rank <= leftover THEN 1 ELSE 0 END AS share FROM ranked`;
export async function publishSnapshot(env, now = Date.now()) {
  const start = weekStartMs(now), week = weekOf(now), op = random();
  const res = await env.DB.batch([
    env.DB.prepare(`${ELIGIBLE} INSERT INTO vote_snapshots(week, voter_count, published_at, source, op)
      SELECT ?3, CASE WHEN COUNT(*) >= ?6 THEN COUNT(*) ELSE 0 END, ?4, CASE WHEN COUNT(*) >= ?6 THEN 'ballots' ELSE 'fallback' END, ?5 FROM valid WHERE true
      ON CONFLICT(week) DO NOTHING`).bind(start, start, week, now, op, K_MIN),
    // Replace the provisional seed for this week only when this request won the snapshot insert.
    env.DB.prepare('DELETE FROM allocation WHERE week = ?1 AND EXISTS (SELECT 1 FROM vote_snapshots WHERE week = ?1 AND op = ?2 AND source = \'ballots\')').bind(week, op),
    env.DB.prepare(`INSERT INTO allocation(week, project, share, provisional)
      SELECT ?3, project, share, 0 FROM (${ELIGIBLE}${SHARES})
      WHERE EXISTS (SELECT 1 FROM vote_snapshots WHERE week = ?3 AND op = ?4 AND source = 'ballots')`)
      .bind(start, start, week, op),
    // The fallback carries the last known split, including a same-week provisional seed.
    env.DB.prepare(`INSERT INTO allocation(week, project, share, provisional)
      SELECT ?1, project, share, 1 FROM allocation WHERE week = (SELECT MAX(week) FROM allocation WHERE week <= ?1)
      AND EXISTS (SELECT 1 FROM vote_snapshots WHERE week = ?1 AND op = ?2 AND source = 'fallback')
      ON CONFLICT(week, project) DO UPDATE SET provisional = 1`).bind(week, op),
  ]);
  return { published: !!res[0].meta.changes, week };
}
// The projection for next Monday. Two privacy rules (docs/DATA-POLICY.md):
//   - shown only from at least K_MIN (5) eligible ballots; below that nothing is revealed, because with one voter the shares ARE the ballot;
//   - coarsened in time: computed from the ballots saved before the start of the current UTC day, and stored for the day, so one ballot change
//     (or a deleted account) cannot be seen by reading it before and after.
export async function projection(env, now = Date.now()) {
  const day = utcDay(now), key = `projection:${day}`;
  const have = await env.DB.prepare('SELECT v FROM meta WHERE k = ?1').bind(key).first();
  if (have) return JSON.parse(have.v);
  const asOf = Date.parse(`${day}T00:00:00Z`), start = weekStartMs(now) + 7 * 86400000, week = weekOf(start);
  const [count, shares] = await env.DB.batch([
    env.DB.prepare(`${ELIGIBLE} SELECT COUNT(*) AS n FROM valid`).bind(start, asOf),
    env.DB.prepare(`${ELIGIBLE}${SHARES}`).bind(start, asOf),
  ]);
  const n = count.results[0].n;
  const out = n < K_MIN
    ? { week, projected: false, reason: NO_PROJECTION_REASON, voter_count: coarseCount(n) }
    : { week, projected: true, source: 'ballots', provisional: false, voter_count: coarseCount(n), as_of: `${day}T00:00:00.000Z`,
        shares: Object.fromEntries(shares.results.map((r) => [r.project, r.share])), unit: 'basis_points' };
  await env.DB.prepare('INSERT OR IGNORE INTO meta(k, v) VALUES (?1, ?2)').bind(key, JSON.stringify(out)).run();
  const row = await env.DB.prepare('SELECT v FROM meta WHERE k = ?1').bind(key).first();
  return JSON.parse(row.v);
}
export async function handleVoting(req, env, path) {
  if (path === '/api/ballot') {
    if (!['GET', 'PUT'].includes(req.method)) return privateJson({ error: 'Use GET or PUT.' }, 405);
    if (req.method === 'PUT') { const guard = await writeGuard(req, env); if (guard) return guard; }
    const a = await session(req, env); if (!a) return privateJson({ error: 'Sign in first.' }, 401);
    if (req.method === 'PUT') {
      const b = await readJson(req, 8192), allocations = b?.allocations;
      if (!allocations || typeof allocations !== 'object' || Array.isArray(allocations) || !Object.keys(allocations).length || Object.values(allocations).some((v) => !Number.isInteger(v) || v < 0 || v > 100) || Object.values(allocations).reduce((a, v) => a + v, 0) !== 100) return privateJson({ error: 'Allocate exactly 100 integer points (0–100 per active project).' }, 400);
      // Validation, account eligibility, and next version all happen in this single write.
      const r = await env.DB.prepare(`INSERT INTO ballot_versions(account, version, allocations, created)
        SELECT ?1, COALESCE((SELECT MAX(version) FROM ballot_versions WHERE account = ?1),0)+1, ?2, ?3
        WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ?1 AND suspended = 0)
        AND NOT EXISTS (SELECT 1 FROM json_each(?2) j LEFT JOIN projects p ON p.id = j.key WHERE p.id IS NULL OR p.active != 1)
        RETURNING version`).bind(a.id, JSON.stringify(allocations), Date.now()).first();
      if (!r) return privateJson({ error: 'Only active projects can receive points. Refresh and try again.' }, 400);
      return privateJson({ allocations, version: r.version });
    }
    const b = await env.DB.prepare('SELECT allocations, version FROM ballot_versions WHERE account = ?1 ORDER BY version DESC LIMIT 1').bind(a.id).first();
    return privateJson({ allocations: b ? JSON.parse(b.allocations) : {}, version: b?.version || 0 });
  }
  if (req.method !== 'GET') return privateJson({ error: 'Use GET.' }, 405);
  if (path === '/api/vote/config') {
    const projects = await env.DB.prepare('SELECT id, name FROM projects WHERE active = 1 ORDER BY name').all();
    return privateJson({ site_key: env.TURNSTILE_SITE_KEY || '', projects: projects.results });
  }
  if (path === '/api/vote/current') {
    const a = await currentAllocation(env);
    const snapshot = await env.DB.prepare('SELECT week, voter_count, published_at, source FROM vote_snapshots WHERE week = ?1').bind(a.week).first();
    return privateJson({ week: a.week, projected: false, source: snapshot?.source || 'fallback', voter_count: snapshot?.source === 'ballots' ? coarseCount(snapshot.voter_count) : 'fewer than 5',
      reason: snapshot?.source === 'ballots' ? undefined : FALLBACK_REASON,
      published_at: snapshot?.published_at || null, provisional: !snapshot || snapshot.source === 'fallback',
      shares: Object.fromEntries(Object.entries(a.shares).map(([k, v]) => [k, Math.round(v * 100)])), unit: 'basis_points' });
  }
  if (path === '/api/vote/next') return privateJson(await projection(env));
  if (path === '/api/vote/audit') {
    const now = Date.now(), start = weekStartMs(now), firstDay = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - 29 * 86400000;
    const [eligible, daily, history] = await env.DB.batch([
      env.DB.prepare('SELECT COUNT(*) AS n FROM accounts WHERE created < ?1 AND suspended = 0').bind(start),
      env.DB.prepare(`SELECT strftime('%Y-%m-%d', created / 1000, 'unixepoch') AS day, COUNT(DISTINCT account) AS ballots
        FROM ballot_versions WHERE created >= ?1 AND created <= ?2 GROUP BY day ORDER BY day`).bind(firstDay, now),
      env.DB.prepare('SELECT week, voter_count, published_at, source FROM vote_snapshots ORDER BY week DESC LIMIT 104'),
    ]);
    const days = new Map(daily.results.map((r) => [r.day, r.ballots]));
    // A count of people for a group smaller than 5 is not published (k-anonymity): it shows "<5" (per day) or "fewer than 5".
    return privateJson({ eligible_voter_count: coarseCount(eligible.results[0].n), ballots_per_day: Array.from({ length: 30 }, (_, i) => {
      const day = new Date(firstDay + i * 86400000).toISOString().slice(0,10); return { day, ballots: coarseCount(days.get(day) || 0, '<5') };
    }), snapshot_history: history.results.map((h) => ({ ...h, voter_count: h.source === 'ballots' ? coarseCount(h.voter_count) : 'fewer than 5', reason: h.source === 'ballots' ? undefined : FALLBACK_REASON })), note: 'Daily counts are distinct accounts saving a ballot; edits on the same day count once. Counts are published only as "fewer than 5" (or "<5" per day) or as a coarse bucket (5-9, 10-24, 25-49, 50-99, then steps of 50), so two published counts can never be subtracted to reveal a small group. A week with fewer than 5 eligible ballots publishes the carried-forward fallback, not a result. No voter identities are public.' });
  }
  return privateJson({ error: 'not found' }, 404);
}
