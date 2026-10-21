// The weekly vote is released with Laplace noise (src/dp.js). These tests check the statistics loosely, with seeded generators, and the part
// that matters most: that differencing two releases (the Codex review 5, finding 1 attack) recovers a lone ballot exactly WITHOUT noise and
// fails WITH it; that the noised split is the official allocation; and that no exact tally is ever stored.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { BALLOT_POINTS, EPSILON, NOISE_SCALE, laplace, largestRemainder, noisedAllocation, secureRng } from '../src/dp.js';
import { bucketFloor } from '../src/privacy.js';
import { publishSnapshot } from '../src/voting.js';
import { weekOf, weekStartMs } from '../src/lib.js';
import { resetDb, send } from './helpers.js';
import dpSource from '../src/dp.js?raw';
import { NO_NOISE, publicAllocation, setupProjects, voter } from './voter.js';

// A small seeded generator (mulberry32) returning numbers in (0, 1).
function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296; };
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('the noise', () => {
  it('is documented: epsilon 1 per weekly release, one ballot = 100 points, so the scale is 100 points', () => {
    expect(EPSILON).toBe(1); expect(BALLOT_POINTS).toBe(100); expect(NOISE_SCALE).toBe(100);
  });
  it('laplace draws have mean near 0 and mean absolute deviation near the scale (seeded, loose bounds)', () => {
    const rng = seeded(12345), xs = Array.from({ length: 40000 }, () => laplace(100, rng));
    expect(Math.abs(mean(xs))).toBeLessThan(5);                       // standard error is about 0.7
    expect(mean(xs.map(Math.abs))).toBeGreaterThan(95); expect(mean(xs.map(Math.abs))).toBeLessThan(105);
    expect(xs.filter((x) => x > 0).length / xs.length).toBeGreaterThan(0.48); expect(xs.filter((x) => x > 0).length / xs.length).toBeLessThan(0.52);
  });
  it('the production source is crypto.getRandomValues, in the open interval (0, 1)', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    const draws = Array.from({ length: 2000 }, () => secureRng());
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(draws.every((u) => u > 0 && u < 1)).toBe(true);
    expect(new Set(draws).size).toBeGreaterThan(1990);
    expect(Math.abs(mean(draws) - 0.5)).toBeLessThan(0.03);
    expect(laplace(100, () => 0.5)).toBeCloseTo(0, 10); // u = 0.5 is the zero of the distribution
  });
  it('largestRemainder sums to 10000, breaks ties by key, and refuses all zeros', () => {
    expect(largestRemainder({ a: 1, b: 1, c: 1 })).toEqual({ a: 3334, b: 3333, c: 3333 });
    expect(Object.values(largestRemainder({ a: 3.3, b: 6.7, c: 0 })).reduce((x, y) => x + y, 0)).toBe(10000);
    expect(largestRemainder({ a: 0, b: 0 })).toBeNull();
  });
  it('noisedAllocation: always 10000 basis points, never negative, and the mean follows the true split over many seeded releases', () => {
    // 20 ballots: 70% to a. The true tally is 1400 / 600 points.
    const rng = seeded(7), runs = Array.from({ length: 3000 }, () => noisedAllocation({ a: 1400, b: 600 }, { rng }));
    for (const r of runs) { expect(r.a + r.b).toBe(10000); expect(r.a).toBeGreaterThanOrEqual(0); expect(r.b).toBeGreaterThanOrEqual(0); }
    expect(Math.abs(mean(runs.map((r) => r.a)) - 7000)).toBeLessThan(150);
    // It is genuinely noisy: individual releases differ from the truth by hundreds of basis points.
    expect(mean(runs.map((r) => Math.abs(r.a - 7000)))).toBeGreaterThan(300);
    // With no noise it is the exact tally.
    expect(noisedAllocation({ a: 1400, b: 600 }, { rng: NO_NOISE })).toEqual({ a: 7000, b: 3000 });
    // Everything clamped to zero gives null (the caller publishes the fallback).
    expect(noisedAllocation({ a: 0, b: 0 }, { rng: () => 0.01 })).toBeNull();
  });
  it('a larger electorate is released more accurately (same noise, bigger signal)', () => {
    const err = (scale) => { const rng = seeded(99); return mean(Array.from({ length: 1500 }, () => Math.abs(noisedAllocation({ a: 70 * scale, b: 30 * scale }, { rng }).a - 7000))); };
    expect(err(1000)).toBeLessThan(err(10) / 5);
  });
});

describe('differencing two releases (review 5, finding 1)', () => {
  // The attacker knows 9 voters split 50/50 and that exactly one voter joined, then reads two published splits (and the coarse counts, which
  // are known to bracket 9 and 10) and works out the newcomer's points for town-hall: 10 * share2 - 9 * share1, in points.
  const attack = (s1, s2) => (s2 / 10000) * 1000 - (s1 / 10000) * 900;
  const before = { a: 450, b: 450 }, after = { a: 450 + 80, b: 450 + 20 }; // the newcomer gave a 80 and b 20

  it('WITHOUT noise the attack recovers the lone ballot exactly (this is why the old daily projection was broken)', () => {
    const s1 = noisedAllocation(before, { rng: NO_NOISE }), s2 = noisedAllocation(after, { rng: NO_NOISE });
    expect(Math.round(attack(s1.a, s2.a))).toBe(80);
  });

  it('WITH noise the estimate is wrong by far more than the ballot itself: it is almost never right, and its error is huge', () => {
    const rng = seeded(2026), errors = [];
    for (let i = 0; i < 4000; i++) errors.push(attack(noisedAllocation(before, { rng }).a, noisedAllocation(after, { rng }).a) - 80);
    const rmse = Math.sqrt(mean(errors.map((e) => e * e)));
    expect(rmse).toBeGreaterThan(100); // more than the whole ballot's 100 points
    expect(errors.filter((e) => Math.abs(e) <= 5).length / errors.length).toBeLessThan(0.1);
    // Averaging many independent releases WOULD erode the noise: stated in DATA-POLICY.md as the cost of publishing weekly all year.
  });

  it('an attacker with a different guess for the newcomer (say 20 points to a) cannot be told apart from the truth better than chance', () => {
    const rng = seeded(31), est = (after2) => attack(noisedAllocation(before, { rng }).a, noisedAllocation(after2, { rng }).a);
    const truthA = Array.from({ length: 2000 }, () => est({ a: 530, b: 470 })), altA = Array.from({ length: 2000 }, () => est({ a: 470, b: 530 }));
    // Likelihood-ratio test with the midpoint threshold: the accuracy stays well below certainty.
    const threshold = (mean(truthA) + mean(altA)) / 2;
    const accuracy = (truthA.filter((x) => x > threshold).length + altA.filter((x) => x <= threshold).length) / 4000;
    expect(accuracy).toBeLessThan(0.75);
  });
});

describe('publishSnapshot', () => {
  beforeEach(async () => {
    await resetDb(); await setupProjects();
    await env.DB.batch([env.DB.prepare('UPDATE accounts SET suspended = 1'), env.DB.prepare('DELETE FROM vote_snapshots'), env.DB.prepare('DELETE FROM weekly_project_stats'), env.DB.prepare('DELETE FROM rollup_weeks')]);
    await publicAllocation({ 'town-hall': 5000, 'swarm-ai': 5000 });
  });
  afterEach(() => vi.restoreAllMocks());
  const crowd = async (n, allocations = { 'town-hall': 90, 'swarm-ai': 10 }) => {
    for (let i = 0; i < n; i++) {
      const v = await voter({ allocations: null });
      await env.DB.prepare('INSERT INTO ballot_versions(account, version, allocations, created) VALUES (?1, 1, ?2, ?3)').bind(v.id, JSON.stringify(allocations), weekStartMs() - 1).run();
    }
  };
  const rows = async () => Object.fromEntries((await env.DB.prepare('SELECT project, share FROM allocation WHERE week = ?1').bind(weekOf()).all()).results.map((r) => [r.project, r.share]));

  it('publishes the NOISED split as the official allocation: the scheduler target and every public view show it, and none shows the exact 90/10', async () => {
    await crowd(7);
    // An injected generator that pulls town-hall's total down and swarm-ai's up.
    const draws = [0.1, 0.9]; let i = 0;
    await publishSnapshot(env, Date.now(), () => draws[i++ % 2]);
    const official = await rows();
    expect(official['town-hall'] + official['swarm-ai']).toBe(10000);
    expect(official['town-hall']).not.toBe(9000);
    const current = await (await send('/api/vote/current')).json();
    expect(current.shares).toEqual({ 'town-hall': official['town-hall'], 'swarm-ai': official['swarm-ai'] });
    const stats = await (await send('/api/stats')).json();
    expect(stats.projects.find((p) => p.id === 'town-hall').allocation.share).toBe(official['town-hall'] / 100); // what the scheduler compares against
    expect(current.noise).toMatchObject({ mechanism: 'laplace', epsilon: 1, sensitivity_points: 100 });
    expect(JSON.stringify([current, stats])).not.toMatch(/\b9000\b|"share":90\b/);
  });

  it('no exact tally persists anywhere in the database: no exact points, no exact shares, no exact count', async () => {
    const had = (await env.DB.prepare('SELECT COUNT(*) AS n FROM ballot_versions').first()).n;
    await crowd(7);
    const draws = [0.2, 0.8]; let i = 0;
    await publishSnapshot(env, Date.now(), () => draws[i++ % 2]);
    // Every row of every table, as text. The exact tally was 630 and 70 points (7 ballots of 90/10), shares 9000 and 1000, and 7 ballots.
    const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT IN ('ballot_versions')").all()).results;
    const dump = {};
    for (const t of tables) dump[t.name] = JSON.stringify((await env.DB.prepare(`SELECT * FROM ${t.name}`).all()).results);
    expect(dump.vote_snapshots).toContain('"voter_count":5');             // the bucket edge, not 7
    expect(dump.vote_snapshots).not.toMatch(/"voter_count":7\b/);
    expect(dump.allocation).not.toMatch(/"share":(9000|1000)\b/);
    expect(dump.meta ?? '').not.toMatch(/projection|tally|630/);
    for (const [name, text] of Object.entries(dump)) if (name !== 'accounts' && name !== 'sessions') expect(text, name).not.toMatch(/"points"|"tally"/);
    // The only place the individual ballots exist is the private ballot_versions table (unchanged).
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM ballot_versions').first()).n).toBe(had + 7);
  });

  it('draws the noise once: repeated publishing, and racing publishers, cannot be used to average it away', async () => {
    await crowd(8);
    const rng = seeded(4); let calls = 0; const counted = () => { calls++; return rng(); };
    const results = await Promise.all(Array.from({ length: 4 }, () => publishSnapshot(env, Date.now(), counted)));
    expect(results.filter((r) => r.published)).toHaveLength(1);
    const first = await rows();
    for (let k = 0; k < 5; k++) await publishSnapshot(env, Date.now(), seeded(100 + k)); // later calls publish nothing and draw nothing new
    expect(await rows()).toEqual(first);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM vote_snapshots').first()).n).toBe(1);
  });

  it('keeps the threshold: fewer than 5 eligible ballots publish the fallback and draw no noise at all', async () => {
    await crowd(4);
    let drawn = 0;
    await publishSnapshot(env, Date.now(), () => { drawn++; return 0.3; });
    expect(drawn).toBe(0);
    expect(await env.DB.prepare('SELECT source, voter_count FROM vote_snapshots').first()).toEqual({ source: 'fallback', voter_count: 0 });
    expect(await rows()).toEqual({ 'town-hall': 5000, 'swarm-ai': 5000 });
  });

  it('a degenerate noised result (everything clamped to zero) falls back instead of publishing nonsense', async () => {
    await crowd(5, { 'town-hall': 100 });
    await publishSnapshot(env, Date.now(), () => 0.0001); // every draw is a huge negative number
    expect(await env.DB.prepare('SELECT source FROM vote_snapshots').first()).toEqual({ source: 'fallback' });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM allocation WHERE week = ?1 AND provisional = 1').bind(weekOf()).first()).n).toBe(2);
  });

  it('review 6, E: a noisy fallback with FIVE eligible ballots is not reported as "fewer than 5", anywhere', async () => {
    await crowd(5, { 'town-hall': 100 });
    await publishSnapshot(env, Date.now(), () => 0.0001);          // five eligible voters; the noise happens to leave nothing usable
    const current = await (await send('/api/vote/current')).json(), audit = await (await send('/api/vote/audit')).json();
    for (const body of [current, audit.snapshot_history]) expect(JSON.stringify(body)).not.toMatch(/fewer than 5/);
    expect(current).toMatchObject({ source: 'fallback', provisional: true, voter_count: 'not published' });
    expect(current.reason).toMatch(/previous split is carried forward/);
    expect(current.noise).toBeUndefined();
    expect(audit.snapshot_history[0]).toMatchObject({ source: 'fallback', voter_count: 'not published' });
    // ...and the honest small-electorate case says the same generic thing (it does not become a fact about the electorate either).
    await resetDb(); await setupProjects(); await env.DB.batch([env.DB.prepare('UPDATE accounts SET suspended = 1'), env.DB.prepare('DELETE FROM vote_snapshots')]); await publicAllocation({ 'town-hall': 5000, 'swarm-ai': 5000 });
    await crowd(3);
    await publishSnapshot(env, Date.now(), () => 0.3);
    expect((await (await send('/api/vote/current')).json()).reason).toBe(current.reason);
  });

  it('review 6, A: a legacy exact snapshot (noised = 0) is served as exact, with no noise description; new snapshots are noised = 1', async () => {
    await env.DB.prepare("INSERT INTO vote_snapshots(week, voter_count, published_at, source, op, noised) VALUES (?1, 7, 1, 'ballots', 'legacy', 0)").bind(weekOf()).run();
    await env.DB.prepare('DELETE FROM allocation WHERE week = ?1').bind(weekOf()).run();
    await env.DB.batch([['town-hall', 9000], ['swarm-ai', 1000]].map(([p, sh]) => env.DB.prepare('INSERT INTO allocation(week, project, share, provisional) VALUES (?1, ?2, ?3, 0)').bind(weekOf(), p, sh)));
    const legacy = await (await send('/api/vote/current')).json();
    expect(legacy.noise).toBeUndefined();
    expect(legacy.legacy_exact.note).toMatch(/before random noise was added/);
    expect((await (await send('/api/vote/audit')).json()).snapshot_history[0].exact_legacy).toBe(true);
    await env.DB.batch([env.DB.prepare('DELETE FROM vote_snapshots'), env.DB.prepare('DELETE FROM allocation WHERE week = ?1').bind(weekOf())]);
    await crowd(6);
    await publishSnapshot(env, Date.now(), seeded(3));
    expect(await env.DB.prepare('SELECT noised FROM vote_snapshots').first()).toEqual({ noised: 1 });
    const fresh = await (await send('/api/vote/current')).json();
    expect(fresh.noise.guarantee).toBe('none_formal'); expect(fresh.noise.note).toMatch(/not a formal differential-privacy guarantee/); expect(fresh.legacy_exact).toBeUndefined();
  });

  it('bucketFloor is the lower edge of the coarse bucket', () => {
    expect([0, 4, 5, 9, 10, 24, 25, 49, 50, 99, 100, 149, 150, 399].map(bucketFloor)).toEqual([0, 0, 5, 5, 10, 10, 25, 25, 50, 50, 100, 100, 150, 350]);
  });
});

describe('review 6, F: the sampler can never return 0 or 1, so the noise is always finite', () => {
  const withWords = (hi, lo) => { const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation((a) => { a[0] = hi; a[1] = lo; return a; }); return () => spy.mockRestore(); };
  afterEach(() => vi.restoreAllMocks());

  it('both random words at the maximum (the review\'s endpoint) give a value below 1, and a finite Laplace draw', () => {
    const done = withWords(0xffffffff, 0xffffffff);
    const u = secureRng(); done();
    expect(u).toBeLessThan(1); expect(u).toBe(1 - 2 ** -53);
    expect(Number.isFinite(laplace(100, () => u))).toBe(true);
  });
  it('both words at zero give a value above 0, and a finite Laplace draw', () => {
    const done = withWords(0, 0);
    const u = secureRng(); done();
    expect(u).toBeGreaterThan(0); expect(u).toBe(2 ** -53);
    expect(Number.isFinite(laplace(100, () => u))).toBe(true);
  });
  it('every mapped value is exactly representable: neighbouring source words give distinct, strictly increasing values', () => {
    const at = (hi, lo) => { const done = withWords(hi, lo); const u = secureRng(); done(); return u; };
    const lows = [at(0, 0), at(0, 64), at(0, 128)], highs = [at(0xffffffff, 0xffffff40), at(0xffffffff, 0xffffff80), at(0xffffffff, 0xffffffc0)];
    expect(lows[0]).toBeLessThan(lows[1]); expect(lows[1]).toBeLessThan(lows[2]);
    expect(highs[0]).toBeLessThan(highs[1]); expect(highs[1]).toBeLessThan(highs[2]); expect(highs[2]).toBe(1 - 2 ** -53);
    for (const hi of [0, 1, 0x7fffffff, 0xfffffffe, 0xffffffff]) for (const lo of [0, 63, 64, 0x80000000, 0xffffffc0, 0xffffffff]) { const u = at(hi, lo); expect(u > 0 && u < 1, `${hi},${lo}`).toBe(true); }
  });
  it('laplace refuses 0, 1, NaN and infinities instead of returning an infinite or NaN draw', () => {
    for (const bad of [0, 1, -0.1, 1.5, NaN, Infinity, -Infinity, undefined]) expect(() => laplace(100, () => bad), String(bad)).toThrow(RangeError);
  });
  it('noisedAllocation and largestRemainder never return NaN: a non-finite weight is refused before anything is stored', () => {
    expect(() => largestRemainder({ a: Infinity, b: 1 })).toThrow(RangeError);
    expect(() => largestRemainder({ a: NaN, b: 1 })).toThrow(RangeError);
    expect(() => largestRemainder({ a: -1, b: 2 })).toThrow(RangeError);
    expect(() => noisedAllocation({ a: 10, b: 10 }, { rng: () => 1 })).toThrow(RangeError); // the review\'s forced endpoint
    const extremes = [2 ** -53, 1 - 2 ** -53];
    for (const u of extremes) { const r = noisedAllocation({ a: 450, b: 50 }, { rng: () => u }); if (r) { expect(Object.values(r).every(Number.isFinite)).toBe(true); expect(r.a + r.b).toBe(10000); } }
  });
  it('publishing with the forced endpoint stores nothing: the snapshot fails instead of writing NaN', async () => {
    await resetDb(); await setupProjects(); await env.DB.batch([env.DB.prepare('UPDATE accounts SET suspended = 1'), env.DB.prepare('DELETE FROM vote_snapshots')]); await publicAllocation({ 'town-hall': 5000, 'swarm-ai': 5000 });
    for (let i = 0; i < 5; i++) { const v = await voter({ allocations: null }); await env.DB.prepare('INSERT INTO ballot_versions(account, version, allocations, created) VALUES (?1, 1, ?2, ?3)').bind(v.id, JSON.stringify({ 'town-hall': 90, 'swarm-ai': 10 }), weekStartMs() - 1).run(); }
    await expect(publishSnapshot(env, Date.now(), () => 1)).rejects.toThrow(RangeError);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM vote_snapshots').first()).n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM allocation WHERE week = ?1 AND (share IS NULL OR share != share)").bind(weekOf()).first()).n).toBe(0);
  });
});

describe('review 6, D and G: no claim the mechanism cannot back', () => {
  it('dp.js makes no formal differential-privacy, "epsilon budget" or advanced-composition claim, and says what it is not', () => {
    expect(dpSource).not.toMatch(/advanced composition|sqrt\(ln|roughly 25|about 7\.2|epsilon-differentially private|budget/i);
    expect(dpSource).toMatch(/NOT: a formal differential-privacy guarantee/);
    expect(dpSource).toMatch(/basic composition/);
    expect(dpSource).not.toMatch(/PERSONAL_CAP/);
  });
});
