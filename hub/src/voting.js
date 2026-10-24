import { currentAllocation } from './core.js';
import { readJson, weekOf, weekStartMs } from './lib.js';
import { privateJson, session, writeGuard } from './accounts.js';
import { random } from './webauthn.js';
import { K_MIN, bucketFloor, coarseCount } from './privacy.js';
import { BALLOT_POINTS, EPSILON, noisedAllocation, secureRng } from './dp.js';

// Why a week shows the carried-forward split. Deliberately generic: it is usually a week with fewer than 5 eligible ballots, but the same
// outcome follows (rarely) when the added noise leaves no usable result, and a noisy failure is not an exact fact about the electorate.
export const FALLBACK_REASON = 'No new split was published this week, so the previous split is carried forward. This happens when too few ballots were eligible and, rarely, when the added noise left no usable result.';
export const NOT_PUBLISHED = 'not published';

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
// Exact points per active project. Read, noised and dropped by publishSnapshot; never stored and never served (docs/DATA-POLICY.md).
const TALLY = `SELECT p.id AS project, COALESCE(SUM(CAST(j.value AS INTEGER)),0) AS points
  FROM projects p LEFT JOIN valid b ON 1=1 LEFT JOIN json_each(b.allocations) j ON j.key = p.id
  WHERE p.active = 1 GROUP BY p.id`;
// The noise design, stated on the pages that publish the split.
export const NOISE = { mechanism: 'laplace', epsilon: EPSILON, sensitivity_points: BALLOT_POINTS, scale_points: BALLOT_POINTS / EPSILON, unit: 'basis_points',
  guarantee: 'none_formal',
  note: 'Random noise is added to the weekly split so that the noise obscures one ballot in it (Laplace noise with scale 100 points, one ballot = 100 points), and the result is rounded to 10000 basis points. This noised split is the official allocation and what the scheduler follows. This is not a formal differential-privacy guarantee across all releases: whether a result is published at all, and the coarse voter count, depend on the ballots without noise. On new releases the exact tally is not stored; the ballots themselves are.' };
export const LEGACY = { note: 'This split was published before random noise was added to the weekly split. It is the exact result of that week\'s ballots and carries no noise.' };
// The weekly snapshot. Once per week, from the ballots saved before Monday: with at least 5 eligible ballots the exact point totals are
// read, noised (src/dp.js) and dropped, and the noised split becomes the allocation; with fewer, or if the noise leaves no usable result, the provisional fallback (the previous
// split carried forward) is published and nothing about the ballots is. The count kept is the lower edge of its coarse bucket, never exact.
// `rng` returns a uniform number in (0, 1); the default is crypto.getRandomValues, tests pass a seeded one.
export async function publishSnapshot(env, now = Date.now(), rng = secureRng) {
  const start = weekStartMs(now), week = weekOf(now), op = random();
  const have = await env.DB.prepare('SELECT 1 AS n FROM vote_snapshots WHERE week = ?1').bind(week).first();
  if (have) return { published: false, week };
  const [count, tally] = await env.DB.batch([
    env.DB.prepare(`${ELIGIBLE} SELECT COUNT(*) AS n FROM valid`).bind(start, start),
    env.DB.prepare(`${ELIGIBLE} ${TALLY}`).bind(start, start),
  ]);
  const n = count.results[0].n;
  let shares = null;
  if (n >= K_MIN) shares = noisedAllocation(Object.fromEntries(tally.results.map((r) => [r.project, r.points])), { rng });
  const ballots = shares !== null;
  const kept = ballots ? Object.entries(shares) : [];
  const res = await env.DB.batch([
    env.DB.prepare(`INSERT INTO vote_snapshots(week, voter_count, published_at, source, op, noised) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(week) DO NOTHING`)
      .bind(week, ballots ? bucketFloor(n) : 0, now, ballots ? 'ballots' : 'fallback', op, ballots ? 1 : 0),
    // Replace the provisional seed for this week only when this request won the snapshot insert.
    env.DB.prepare('DELETE FROM allocation WHERE week = ?1 AND EXISTS (SELECT 1 FROM vote_snapshots WHERE week = ?1 AND op = ?2 AND source = \'ballots\')').bind(week, op),
    ...kept.map(([project, share]) => env.DB.prepare(`INSERT INTO allocation(week, project, share, provisional)
      SELECT ?1, ?2, ?3, 0 WHERE EXISTS (SELECT 1 FROM vote_snapshots WHERE week = ?1 AND op = ?4 AND source = 'ballots')`).bind(week, project, share, op)),
    // The fallback carries the last known split, including a same-week provisional seed.
    env.DB.prepare(`INSERT INTO allocation(week, project, share, provisional)
      SELECT ?1, project, share, 1 FROM allocation WHERE week = (SELECT MAX(week) FROM allocation WHERE week <= ?1)
      AND EXISTS (SELECT 1 FROM vote_snapshots WHERE week = ?1 AND op = ?2 AND source = 'fallback')
      ON CONFLICT(week, project) DO UPDATE SET provisional = 1`).bind(week, op),
  ]);
  return { published: !!res[0].meta.changes, week };
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
    const snapshot = await env.DB.prepare('SELECT week, voter_count, published_at, source, noised FROM vote_snapshots WHERE week = ?1').bind(a.week).first();
    const released = snapshot?.source === 'ballots';
    return privateJson({ week: a.week, projected: false, source: snapshot?.source || 'fallback', voter_count: released ? coarseCount(snapshot.voter_count) : NOT_PUBLISHED,
      reason: released ? undefined : FALLBACK_REASON,
      published_at: snapshot?.published_at || null, provisional: !snapshot || snapshot.source === 'fallback',
      shares: Object.fromEntries(Object.entries(a.shares).map(([k, v]) => [k, Math.round(v * 100)])), unit: 'basis_points',
      next_release: 'The next split is published on Monday (UTC). There is no projection of it: nothing is shown before then.',
      noise: released && snapshot.noised ? NOISE : undefined, legacy_exact: released && !snapshot.noised ? LEGACY : undefined });
  }
  if (path === '/api/vote/audit') {
    // Weekly figures only. No per-day count of ballots and no live count of eligible voters: a number that moves during the week is a signal anyone can poll.
    const history = await env.DB.prepare('SELECT week, voter_count, published_at, source, noised FROM vote_snapshots ORDER BY week DESC LIMIT 104').all();
    // A count of people for a group smaller than 5 is not published (k-anonymity): a week without a published result shows no count.
    return privateJson({ snapshot_history: history.results.map(({ noised, ...h }) => ({ ...h, voter_count: h.source === 'ballots' ? coarseCount(h.voter_count) : NOT_PUBLISHED, reason: h.source === 'ballots' ? undefined : FALLBACK_REASON, exact_legacy: h.source === 'ballots' && !noised ? true : undefined })),
      noise: NOISE, note: 'Published once a week, on Monday. A voter count is published only as a coarse bucket (5-9, 10-24, 25-49, 50-99, then steps of 50), and the database keeps only the bucket. The split itself carries random noise (see "noise"); this is not a formal differential-privacy guarantee. A week with no published result carries the previous split forward, which usually means fewer than 5 eligible ballots, and shows no count. There are no daily counts and no projection. No voter identities are public.' });
  }
  return privateJson({ error: 'not found' }, 404);
}
