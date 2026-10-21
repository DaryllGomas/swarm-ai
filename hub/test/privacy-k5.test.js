// k-anonymity of 5 for the weekly vote: with fewer than 5 eligible ballots nothing public may reveal them (docs/DATA-POLICY.md).
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { publishSnapshot } from '../src/voting.js';
import { coarseCount } from '../src/privacy.js';
import { rollupWeek } from '../src/rollup.js';
import { weekStats } from '../src/core.js';
import { weekOf, weekStartMs } from '../src/lib.js';
import { resetDb, send } from './helpers.js';
import { NO_NOISE, linkedUser, publicAllocation, saveBallot, setupProjects, voter } from './voter.js';
const publish = (e = env, now = Date.now()) => publishSnapshot(e, now, NO_NOISE);

const DAY = 86400000;
const SEED = { 'town-hall': 5000, 'swarm-ai': 5000 };
// n voters whose ballots were saved before this week's Monday, so they count in this week's snapshot.
const crowd = async (n, allocations = { 'town-hall': 90, 'swarm-ai': 10 }) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = await voter({ allocations: null });
    await env.DB.prepare('INSERT INTO ballot_versions(account, version, allocations, created) VALUES (?1, 1, ?2, ?3)').bind(v.id, JSON.stringify(allocations), weekStartMs() - 1).run();
    out.push(v);
  }
  return out;
};
beforeEach(async () => {
  await resetDb(); await setupProjects();
  await env.DB.batch([env.DB.prepare('UPDATE accounts SET suspended = 1'), env.DB.prepare('DELETE FROM vote_snapshots'), env.DB.prepare('DELETE FROM weekly_project_stats'), env.DB.prepare('DELETE FROM rollup_weeks')]);
  await publicAllocation(SEED);
});
// Every public place that could carry the shares of a snapshot.
async function publicView() {
  const get = async (p) => (await send(p)).json();
  const [current, audit, stats, analytics] = await Promise.all(['/api/vote/current', '/api/vote/audit', '/api/stats', '/api/analytics'].map(get));
  return { current, audit, stats, analytics };
}
const stat = (v, id) => v.stats.projects.find((p) => p.id === id);

describe('a weekly snapshot needs 5 eligible ballots', () => {
  for (const n of [1, 4]) {
    it(`${n} voter(s): fallback, nothing about the ballots is public`, async () => {
      await crowd(n);
      await publish();
      expect(await env.DB.prepare('SELECT source, voter_count FROM vote_snapshots').first()).toEqual({ source: 'fallback', voter_count: 0 });
      const rows = (await env.DB.prepare('SELECT project, share, provisional FROM allocation WHERE week = ?1 ORDER BY project').bind(weekOf()).all()).results;
      expect(rows).toEqual([{ project: 'swarm-ai', share: 5000, provisional: 1 }, { project: 'town-hall', share: 5000, provisional: 1 }]);
      const v = await publicView();
      expect(v.current).toMatchObject({ source: 'fallback', provisional: true, voter_count: 'not published', shares: { 'town-hall': 5000, 'swarm-ai': 5000 } });
      expect((await send('/api/vote/next')).status).toBe(404);
      expect(v.audit.snapshot_history[0]).toMatchObject({ source: 'fallback', voter_count: 'not published' });
      expect(v.current.reason).toMatch(/previous split is carried forward/);
      expect(stat(v, 'town-hall').allocation).toEqual({ share: 50, provisional: true });
      expect(v.stats.allocation_note).toMatch(/Provisional/);
      expect(JSON.stringify(v)).not.toMatch(/9000|"share":90|"town-hall":90/);
    });
  }
  it('5 voters: the result is published', async () => {
    await crowd(5);
    await publish();
    expect(await env.DB.prepare('SELECT source, voter_count FROM vote_snapshots').first()).toEqual({ source: 'ballots', voter_count: 5 });
    const v = await publicView();
    expect(v.current).toMatchObject({ source: 'ballots', provisional: false, voter_count: '5-9', shares: { 'town-hall': 9000, 'swarm-ai': 1000 } });
    expect(stat(v, 'town-hall').allocation).toEqual({ share: 90, provisional: false });
  });
  it('coarsening: a voter is not revealed by the count either (0 looks like 1-4)', async () => {
    expect(coarseCount(0)).toBe('fewer than 5'); expect(coarseCount(4)).toBe('fewer than 5');
  });
});

describe('differencing', () => {
  it('daily counts and totals are coarse buckets: no published number or difference is 1 to 4', () => {
    const lows = new Map();
    for (let n = 0; n <= 400; n++) {
      const c = coarseCount(n);
      if (n < 5) expect(c).toBe('fewer than 5');
      else lows.set(c, parseInt(c, 10));
    }
    const edges = [...lows.values()].sort((a, b) => a - b);
    for (let i = 1; i < edges.length; i++) expect(edges[i] - edges[i - 1]).toBeGreaterThanOrEqual(5);
    expect(coarseCount(5)).toBe('5-9'); expect(coarseCount(9)).toBe('5-9'); expect(coarseCount(10)).toBe('10-24'); expect(coarseCount(100)).toBe('100+');
  });
  it('the audit has weekly snapshot counts only, as coarse ranges, and no exact count anywhere in the payload', async () => {
    await crowd(6);
    await publish();
    const audit = await (await send('/api/vote/audit')).json();
    expect(audit.snapshot_history[0].voter_count).toBe('5-9');
    expect(audit.ballots_per_day).toBeUndefined(); expect(audit.eligible_voter_count).toBeUndefined();
    expect(JSON.stringify(audit)).not.toMatch(/"(ballots|voter_count|eligible_voter_count)":\d/);
    expect((await env.DB.prepare('SELECT voter_count FROM vote_snapshots').first()).voter_count).toBe(5); // the database keeps the bucket edge, not 6
  });
  it('there is no personal-direction release any more: five people steering their own work leave only the all-routes total', async () => {
    const mk = async (alloc) => linkedUser(await voter({ allocations: alloc }));
    const { addTask, BODY, SOURCE } = await import('./helpers.js');
    const work = async (u) => { await addTask({ project: 'town-hall', units: 1 }); const r = await u.call('next_task'); expect(r.data.claim.routing_origin).toBe('ballot_directed'); await u.call('submit_work', { task_id: r.data.task.id, body: BODY, sources: [SOURCE] }); };
    for (let i = 0; i < 5; i++) await work(await mk({ 'town-hall': 100 }));
    const s = await weekStats(env);
    expect(JSON.stringify(s)).not.toMatch(/ballot_directed|self_directed|self_picked|personal|routed_units|routed_share/);
    await rollupWeek(env, weekOf(), Date.now(), NO_NOISE);
    const a = await (await send('/api/analytics')).json();
    expect(JSON.stringify(a.weeks)).not.toMatch(/personal|ballot_directed|self_picked|tasks_claimed|public_routed/);
    expect(a.weeks[0].total_claimed_units).toBe(5); // every route added together
    expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'weekly_release'").first()).toBeNull();
  });
});

describe('the signed-in view still shows the voter their own ballot', () => {
  it('/api/ballot and /api/me return it', async () => {
    const v = await voter({ allocations: { 'town-hall': 33, 'swarm-ai': 67 } });
    expect((await (await send('/api/ballot', { headers: { Cookie: v.cookie } })).json()).allocations).toEqual({ 'town-hall': 33, 'swarm-ai': 67 });
    const me = await (await send('/api/me', { headers: { Cookie: v.cookie } })).json();
    expect(JSON.stringify(me.ballot)).toContain('67');
  });
});
