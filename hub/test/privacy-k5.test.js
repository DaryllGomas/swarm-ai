// k-anonymity of 5 for the weekly vote: with fewer than 5 eligible ballots nothing public may reveal them (docs/DATA-POLICY.md).
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { projection, publishSnapshot } from '../src/voting.js';
import { coarseCount } from '../src/privacy.js';
import { rollupWeek } from '../src/rollup.js';
import { weekStats } from '../src/core.js';
import { weekOf, weekStartMs } from '../src/lib.js';
import { resetDb, send } from './helpers.js';
import { linkedUser, publicAllocation, saveBallot, setupProjects, voter } from './voter.js';

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
  const [current, next, audit, stats, analytics] = await Promise.all(['/api/vote/current', '/api/vote/next', '/api/vote/audit', '/api/stats', '/api/analytics'].map(get));
  return { current, next, audit, stats, analytics };
}
const stat = (v, id) => v.stats.projects.find((p) => p.id === id);

describe('a weekly snapshot needs 5 eligible ballots', () => {
  for (const n of [1, 4]) {
    it(`${n} voter(s): fallback, nothing about the ballots is public`, async () => {
      await crowd(n);
      await publishSnapshot(env);
      expect(await env.DB.prepare('SELECT source, voter_count FROM vote_snapshots').first()).toEqual({ source: 'fallback', voter_count: 0 });
      const rows = (await env.DB.prepare('SELECT project, share, provisional FROM allocation WHERE week = ?1 ORDER BY project').bind(weekOf()).all()).results;
      expect(rows).toEqual([{ project: 'swarm-ai', share: 5000, provisional: 1 }, { project: 'town-hall', share: 5000, provisional: 1 }]);
      const v = await publicView();
      expect(v.current).toMatchObject({ source: 'fallback', provisional: true, voter_count: 'fewer than 5', reason: 'fewer than 5 eligible ballots', shares: { 'town-hall': 5000, 'swarm-ai': 5000 } });
      expect(v.next).toEqual({ week: weekOf(weekStartMs() + 7 * DAY), projected: false, reason: 'fewer than 5 ballots', voter_count: 'fewer than 5' });
      expect(v.audit.snapshot_history[0]).toMatchObject({ source: 'fallback', voter_count: 'fewer than 5' });
      expect(stat(v, 'town-hall').allocation).toEqual({ share: 50, provisional: true });
      expect(v.stats.allocation_note).toMatch(/Provisional/);
      expect(JSON.stringify(v)).not.toMatch(/9000|"share":90|"town-hall":90/);
    });
  }
  it('5 voters: the result is published', async () => {
    await crowd(5);
    await publishSnapshot(env);
    expect(await env.DB.prepare('SELECT source, voter_count FROM vote_snapshots').first()).toEqual({ source: 'ballots', voter_count: 5 });
    const v = await publicView();
    expect(v.current).toMatchObject({ source: 'ballots', provisional: false, voter_count: '5-9', shares: { 'town-hall': 9000, 'swarm-ai': 1000 } });
    expect(stat(v, 'town-hall').allocation).toEqual({ share: 90, provisional: false });
  });
  it('coarsening: a voter is not revealed by the count either (0 looks like 1-4)', async () => {
    expect(coarseCount(0)).toBe('fewer than 5'); expect(coarseCount(4)).toBe('fewer than 5');
  });
});

describe('the projection', () => {
  const thursday = weekStartMs() + 3 * DAY + 3600000; // 01:00 UTC on a Thursday of this week
  it('is hidden below 5 ballots and shown from 5', async () => {
    await crowd(4);
    const hidden = await projection(env, thursday);
    expect(hidden.projected).toBe(false); expect(hidden.shares).toBeUndefined(); expect(hidden.reason).toBe('fewer than 5 ballots');
    await env.DB.prepare('DELETE FROM meta WHERE k LIKE ?1').bind('projection:%').run();
    await crowd(1);
    expect(await projection(env, thursday)).toMatchObject({ projected: true, voter_count: '5-9', shares: { 'town-hall': 9000, 'swarm-ai': 1000 } });
  });
  it('does not change when ballots or accounts change during the UTC day, only the next day', async () => {
    const vs = await crowd(5);
    const first = await projection(env, thursday);
    expect(first.projected).toBe(true);
    await env.DB.prepare('INSERT INTO ballot_versions(account, version, allocations, created) VALUES (?1, 99, ?2, ?3)').bind(vs[0].id, JSON.stringify({ 'swarm-ai': 100 }), thursday + 1800000).run();
    await env.DB.prepare('UPDATE accounts SET suspended = 1 WHERE id = ?1').bind(vs[1].id).run();
    expect(await projection(env, thursday + 3 * 3600000)).toEqual(first);
    expect(await projection(env, thursday + 20 * 3600000)).toEqual(first);
    // The next day is computed from the state at its start: the suspended voter is gone, so only 4 are left and it is hidden.
    expect((await projection(env, thursday + DAY)).projected).toBe(false);
  });
  it('counts only ballots saved before the start of the current day', async () => {
    await crowd(4);
    const late = await voter({ allocations: null });
    await env.DB.prepare('INSERT INTO ballot_versions(account, version, allocations, created) VALUES (?1, 1, ?2, ?3)').bind(late.id, JSON.stringify({ 'swarm-ai': 100 }), thursday - 1800000 + DAY).run();
    expect((await projection(env, thursday)).projected).toBe(false); // the fifth ballot is from later that day
    expect((await projection(env, thursday + 2 * DAY)).projected).toBe(true);
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
  it('the audit shows "<5" for an empty day as well as for 1-4, and no exact count in the whole payload', async () => {
    await crowd(6);
    const audit = await (await send('/api/vote/audit')).json();
    expect(audit.eligible_voter_count).toBe('5-9');
    for (const d of audit.ballots_per_day) expect(d.ballots).toMatch(/^(<5|\d+-\d+|\d+\+)$/);
    expect(JSON.stringify(audit)).not.toMatch(/"(ballots|voter_count|eligible_voter_count)":\d/);
  });
  it('ballot-directed units (they follow one voter\'s ballot) are hidden until 5 people stand behind them', async () => {
    const mk = async (alloc) => linkedUser(await voter({ allocations: alloc }));
    const { addTask, BODY, SOURCE } = await import('./helpers.js');
    const work = async (u) => { await addTask({ project: 'town-hall', units: 1 }); const r = await u.call('next_task'); expect(r.data.claim.routing_origin).toBe('ballot_directed'); await u.call('submit_work', { task_id: r.data.task.id, body: BODY, sources: [SOURCE] }); };
    const users = [];
    for (let i = 0; i < 4; i++) { users.push(await mk({ 'town-hall': 100 })); await work(users[i]); }
    let s = await weekStats(env);
    expect(s.routing_origins.units.ballot_directed).toBeNull();
    expect(s.projects.every((p) => p.ballot_directed_units === null)).toBe(true);
    await rollupWeek(env, weekOf());
    let a = await (await send('/api/analytics')).json();
    expect(a.weeks[0].projects.every((p) => p.units.ballot_directed === null && p.accepted_units.ballot_directed === null)).toBe(true);
    users.push(await mk({ 'town-hall': 100 })); await work(users[4]);
    s = await weekStats(env);
    expect(s.routing_origins.units.ballot_directed).toBe(5);
    expect(s.projects.find((p) => p.id === 'town-hall').ballot_directed_units).toBe(5);
    await env.DB.batch([env.DB.prepare('DELETE FROM weekly_project_stats'), env.DB.prepare('DELETE FROM rollup_weeks')]);
    await rollupWeek(env, weekOf());
    a = await (await send('/api/analytics')).json();
    expect(a.weeks[0].projects.find((p) => p.project === 'town-hall').units.ballot_directed).toBe(5);
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
