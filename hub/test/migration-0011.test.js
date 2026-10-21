// Migrations 0011 and 0012 against a database that already has rows (Codex reviews 5 and 6): a snapshot built from fewer than 5 ballots, AND every
// fallback descended from one, is replaced with an equal provisional split and recorded as a fallback. Nothing unsafe is ever copied forward.
// Then 0012 runs on top of the repaired data.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';

const db = () => env.MIG_DB;
const all = (sql, ...b) => db().prepare(sql).bind(...b).all().then((r) => r.results);
const run = (sql, ...b) => db().prepare(sql).bind(...b).run();
async function wipe() {
  const { results } = await db().prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND type IN ('table','view')").all();
  await db().batch([db().prepare('PRAGMA defer_foreign_keys = on'), ...results.map((r) => db().prepare(`DROP ${r.type} IF EXISTS "${r.name}"`))]);
}
const upTo = (re) => env.TEST_MIGRATIONS.filter((m) => re.test(m.name));
const snapshot = (week, count, source = 'ballots') => run('INSERT INTO vote_snapshots(week, voter_count, published_at, source, op) VALUES (?1, ?2, 1, ?3, ?4)', week, count, source, `op-${week}`);
const alloc = (week, shares, provisional = 0) => db().batch(Object.entries(shares).map(([p, s]) => db().prepare('INSERT INTO allocation(week, project, share, provisional) VALUES (?1, ?2, ?3, ?4)').bind(week, p, s, provisional)));
const shares = async (week) => Object.fromEntries((await all('SELECT project, share, provisional FROM allocation WHERE week = ?1 ORDER BY project', week)).map((r) => [r.project, [r.share, r.provisional]]));

beforeEach(async () => {
  await wipe();
  await applyD1Migrations(db(), upTo(/^(000[1-9]|0010)/));
  await run('DELETE FROM allocation'); await run('DELETE FROM vote_snapshots');
});
const upgrade = () => applyD1Migrations(db(), upTo(/^0011/));

describe('migration 0011 on a populated database', () => {
  it('first week: the one-voter snapshot replaced the same-week seed, so the fallback is an explicit equal-split seed, not the voter\'s 90/10', async () => {
    await snapshot('2026-10-19', 1); await alloc('2026-10-19', { 'town-hall': 9000, 'swarm-ai': 1000 });
    await upgrade();
    expect(await all('SELECT week, source, voter_count FROM vote_snapshots')).toEqual([{ week: '2026-10-19', source: 'fallback', voter_count: 0 }]);
    expect(await shares('2026-10-19')).toEqual({ 'swarm-ai': [5000, 1], 'town-hall': [5000, 1] });
    expect(JSON.stringify(await all('SELECT * FROM allocation'))).not.toMatch(/9000|1000/);
  });

  it('consecutive small weeks and the fallbacks after them all become the equal split; the valid week before them is untouched', async () => {
    await snapshot('2026-10-05', 7); await alloc('2026-10-05', { 'town-hall': 7000, 'swarm-ai': 3000 });
    await snapshot('2026-10-12', 2); await alloc('2026-10-12', { 'town-hall': 100, 'swarm-ai': 9900 });
    await snapshot('2026-10-19', 1); await alloc('2026-10-19', { 'town-hall': 9900, 'swarm-ai': 100 });
    await upgrade();
    expect(await shares('2026-10-05')).toEqual({ 'swarm-ai': [3000, 0], 'town-hall': [7000, 0] }); // the valid week is untouched
    for (const w of ['2026-10-12', '2026-10-19']) expect(await shares(w), w).toEqual({ 'swarm-ai': [5000, 1], 'town-hall': [5000, 1] });
    expect((await all('SELECT source, voter_count FROM vote_snapshots WHERE week = ?1', '2026-10-05'))[0]).toEqual({ source: 'ballots', voter_count: 7 });
    expect(JSON.stringify(await all('SELECT * FROM allocation WHERE week > ?1', '2026-10-05'))).not.toMatch(/"share":(100|9900)\b/);
  });

  it('review 6, A2: a one-voter result propagated through fallback weeks is replaced everywhere, and the repair does not copy it forward', async () => {
    await snapshot('2026-10-05', 1); await alloc('2026-10-05', { 'town-hall': 9000, 'swarm-ai': 1000 });
    await snapshot('2026-10-12', 0, 'fallback'); await alloc('2026-10-12', { 'town-hall': 9000, 'swarm-ai': 1000 }, 1); // carried forward from the lone voter
    await snapshot('2026-10-19', 2); await alloc('2026-10-19', { 'town-hall': 9000, 'swarm-ai': 1000 });
    await snapshot('2026-10-26', 0, 'fallback'); await alloc('2026-10-26', { 'town-hall': 9000, 'swarm-ai': 1000 }, 1);
    await upgrade();
    for (const w of ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']) expect(await shares(w), w).toEqual({ 'swarm-ai': [5000, 1], 'town-hall': [5000, 1] });
    expect(await all('SELECT week, source, voter_count FROM vote_snapshots ORDER BY week')).toEqual(['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'].map((week) => ({ week, source: 'fallback', voter_count: 0 })));
    expect(JSON.stringify(await all('SELECT * FROM allocation'))).not.toMatch(/9000|1000/);
    await applyD1Migrations(db(), upTo(/^0012/));
    expect(JSON.stringify(await all('SELECT * FROM allocation'))).not.toMatch(/9000|1000/); // and 0012 on top leaves it that way
    expect(await all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('a valid snapshot, a seed or a later valid week breaks the chain: fallbacks after them are not touched', async () => {
    await snapshot('2026-10-05', 1); await alloc('2026-10-05', { 'town-hall': 9000, 'swarm-ai': 1000 });
    await snapshot('2026-10-12', 0, 'fallback'); await alloc('2026-10-12', { 'town-hall': 9000, 'swarm-ai': 1000 }, 1);
    await snapshot('2026-10-19', 9); await alloc('2026-10-19', { 'town-hall': 6000, 'swarm-ai': 4000 });
    await snapshot('2026-10-26', 0, 'fallback'); await alloc('2026-10-26', { 'town-hall': 6000, 'swarm-ai': 4000 }, 1); // copies the VALID week
    await alloc('2026-11-02', { 'town-hall': 3000, 'swarm-ai': 7000 }, 1);                                                    // a seed with no snapshot
    await snapshot('2026-11-09', 0, 'fallback'); await alloc('2026-11-09', { 'town-hall': 3000, 'swarm-ai': 7000 }, 1);        // copies the seed
    await upgrade();
    for (const w of ['2026-10-05', '2026-10-12']) expect(await shares(w), w).toEqual({ 'swarm-ai': [5000, 1], 'town-hall': [5000, 1] });
    expect(await shares('2026-10-19')).toEqual({ 'swarm-ai': [4000, 0], 'town-hall': [6000, 0] });
    expect(await shares('2026-10-26')).toEqual({ 'swarm-ai': [4000, 1], 'town-hall': [6000, 1] });
    expect(await shares('2026-11-02')).toEqual({ 'swarm-ai': [7000, 1], 'town-hall': [3000, 1] });
    expect(await shares('2026-11-09')).toEqual({ 'swarm-ai': [7000, 1], 'town-hall': [3000, 1] });
  });

  it('review 6, A1: an eligible legacy snapshot keeps its (already public) split but is marked as exact, not noised', async () => {
    await snapshot('2026-10-19', 7); await alloc('2026-10-19', { 'town-hall': 9000, 'swarm-ai': 1000 });
    await upgrade(); await applyD1Migrations(db(), upTo(/^0012/));
    expect(await shares('2026-10-19')).toEqual({ 'swarm-ai': [1000, 0], 'town-hall': [9000, 0] });
    expect(await all('SELECT source, voter_count, noised FROM vote_snapshots')).toEqual([{ source: 'ballots', voter_count: 5, noised: 0 }]);
  });

  it('a small first week followed by a valid week: the small one is seeded, the valid one is untouched', async () => {
    await snapshot('2026-10-12', 3); await alloc('2026-10-12', { 'town-hall': 100, 'swarm-ai': 9900 });
    await snapshot('2026-10-19', 12); await alloc('2026-10-19', { 'town-hall': 6000, 'swarm-ai': 4000 });
    await upgrade();
    expect(await shares('2026-10-12')).toEqual({ 'swarm-ai': [5000, 1], 'town-hall': [5000, 1] });
    expect(await shares('2026-10-19')).toEqual({ 'swarm-ai': [4000, 0], 'town-hall': [6000, 0] });
  });

  it('a prior valid snapshot with a provisional seed week in between, and no small snapshots at all, change nothing', async () => {
    await snapshot('2026-10-12', 9); await alloc('2026-10-12', { 'town-hall': 5500, 'swarm-ai': 4500 });
    await snapshot('2026-10-19', 0, 'fallback'); await alloc('2026-10-19', { 'town-hall': 5500, 'swarm-ai': 4500 }, 1);
    const before = JSON.stringify(await all('SELECT * FROM allocation ORDER BY week, project'));
    await upgrade();
    expect(JSON.stringify(await all('SELECT * FROM allocation ORDER BY week, project'))).toBe(before);
  });

  it('every repaired week sums to 10000 basis points, with an odd number of projects too', async () => {
    await run("INSERT INTO projects(id, name, kind, summary, reviewer) VALUES ('third', 'Third', 'research', 't', 'r')");
    await snapshot('2026-10-19', 1); await alloc('2026-10-19', { 'town-hall': 10000 });
    await upgrade();
    const rows = await all('SELECT project, share FROM allocation WHERE week = ?1 ORDER BY project', '2026-10-19');
    expect(rows.reduce((n, r) => n + r.share, 0)).toBe(10000);
    expect(rows.map((r) => r.share).sort()).toEqual([3333, 3333, 3334]);
  });

  it('0012 on top: exact stored voter counts become bucket edges, the daily projection caches go, and weekly tables are rebuilt without raw origin splits', async () => {
    await snapshot('2026-10-05', 7); await snapshot('2026-10-12', 30); await snapshot('2026-10-19', 120);
    await run("INSERT INTO meta(k, v) VALUES ('projection:2026-10-20', '{}'), ('last_sync', '1')");
    await run("INSERT INTO weekly_project_stats(week, project, routed_units, ballot_directed_units, self_picked_units, accepted_routed_units, accepted_ballot_directed_units, accepted_self_picked_units, tasks_created, tasks_claimed, tasks_submitted, tasks_accepted, tasks_rejected, contributors, reviews) VALUES ('2026-10-12', 'town-hall', 4, 8, 3, 1, 2, 3, 4, 4, 4, 3, 1, 2, 4)");
    await run("INSERT INTO weekly_model_stats(week, project, family, submissions) VALUES ('2026-10-12', 'town-hall', 'claude', 1)");
    await run("INSERT INTO events(ts, type, contributor, actor, detail) VALUES (1, 'account_linked', NULL, 'system', '{\"account\":\"abcd1234\",\"via\":\"code\"}')");
    await upgrade();
    await applyD1Migrations(db(), upTo(/^0012/));
    expect(await all('SELECT week, voter_count FROM vote_snapshots ORDER BY week')).toEqual([{ week: '2026-10-05', voter_count: 5 }, { week: '2026-10-12', voter_count: 25 }, { week: '2026-10-19', voter_count: 100 }]);
    expect(await all("SELECT k FROM meta WHERE k LIKE 'projection:%'")).toEqual([]);
    expect(await all('SELECT * FROM weekly_project_stats')).toEqual([{ week: '2026-10-12', project: 'town-hall', claimed_units: 15, accepted_units: 6, tasks_created: 4, tasks_accepted: 3, tasks_rejected: 1, contributors: 2, reviews: 4, review_p50_ms: null, review_p90_ms: null }]);
    expect(await all("SELECT name FROM sqlite_master WHERE name IN ('weekly_model_stats', 'weekly_project_stats_bak')")).toEqual([]);
    expect((await all("SELECT detail FROM events WHERE type = 'account_linked'"))[0].detail).toBeNull();
    expect(await all("SELECT name FROM sqlite_master WHERE name IN ('weekly_release', 'oauth_purge', '_unsafe_weeks') ORDER BY name")).toEqual([{ name: 'oauth_purge' }]); // no personal-direction table, and the working table is gone
  });
});
