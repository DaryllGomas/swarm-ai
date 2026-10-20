// Retention and the right to leave: the weekly rollup (kept forever, idempotent), weekly_purge, deleting an account, removing a handle.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/worker.js';
import { weekOf, weekStartMs, sha256 } from '../src/lib.js';
import { PURGED_HANDLE, deleteAccount, removeHandle } from '../src/privacy.js';
import { percentile, purgeHistory, rollupWeek, runRollup, runWeeklyMaintenance, weekAggregates } from '../src/rollup.js';
import { publishSnapshot } from '../src/voting.js';
import { BODY, SOURCE, addTask, makeEnv, newUser, resetDb, send, tool } from './helpers.js';
import { linkedUser, mePost, meGet, publicAllocation, setupProjects, voter } from './voter.js';

const DAY = 86400000, WEEK = 7 * DAY;
const lastWeekStart = () => weekStartMs() - WEEK;
const one = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const all = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then((r) => r.results);
const cid = (handle) => one('SELECT id FROM contributors WHERE handle = ?1', handle).then((r) => r.id);

beforeEach(async () => {
  await resetDb();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM weekly_project_stats'), env.DB.prepare('DELETE FROM weekly_model_stats'), env.DB.prepare('DELETE FROM rollup_weeks'),
    env.DB.prepare("DELETE FROM contributors WHERE handle = ?1").bind(PURGED_HANDLE),
  ]);
  await setupProjects();
  await publicAllocation({ 'town-hall': 5000, 'swarm-ai': 5000 });
});

// A finished piece of work in a past week, written straight into the tables: a claim, and (unless pending is wanted) a reviewed submission.
async function pastWork({ contributor, weeksAgo = 1, project = 'town-hall', units = 3, origin = 'public_routed', model = null, tokens = null, status = 'accepted', reviewAfterMs = 3600000, createdOffset = 1000, published = false, body = BODY } = {}) {
  const start = weekStartMs() - weeksAgo * WEEK;
  const task = await addTask({ units, project, status: status === 'accepted' ? 'accepted' : 'submitted' });
  const claimedAt = start + createdOffset;
  const claim = (await env.DB.prepare(
    `INSERT INTO claims (task, contributor, routed, week, claimed_at, expires_at, outcome, network, routing_origin) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'submitted', 'nethash', ?7)`
  ).bind(task, contributor, origin === 'public_routed' ? 1 : 0, weekOf(start), claimedAt, claimedAt + 10800000, origin).run()).meta.last_row_id;
  const reviewedAt = status === 'pending' ? null : claimedAt + 600000 + reviewAfterMs;
  const sub = (await env.DB.prepare(
    `INSERT INTO submissions (task, contributor, claim, body, sources, model, tokens_est, status, reviewed_by, reviewed_at, created, published_url)
     VALUES (?1, ?2, ?3, ?4, '["https://example.org/a"]', ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
  ).bind(task, contributor, claim, body, model, tokens, status, status === 'pending' ? null : 'Daryll (BigPic Solutions)', reviewedAt, claimedAt + 600000, published ? 'https://example.org/published' : null).run()).meta.last_row_id;
  await env.DB.prepare('UPDATE tasks SET created = ?2 WHERE id = ?1').bind(task, start + 500).run();
  await env.DB.prepare("INSERT INTO events (ts, type, task, contributor, submission, actor, detail) VALUES (?1, 'task_claimed', ?2, ?3, ?4, (SELECT handle FROM contributors WHERE id = ?3), '{\"claim\":1}')").bind(claimedAt, task, contributor, sub).run();
  return { task, claim, sub };
}

describe('the weekly rollup', () => {
  it('writes per-project numbers by routing origin, task counts, review percentiles and model families, and a marker', async () => {
    const a = await newUser(), b = await newUser();
    const [ca, cb] = [await cid(a.handle), await cid(b.handle)];
    const week = weekOf(lastWeekStart());
    await pastWork({ contributor: ca, units: 3, origin: 'public_routed', model: 'claude-opus-4', reviewAfterMs: 1000 });
    await pastWork({ contributor: ca, units: 1, origin: 'public_routed', model: 'claude-sonnet', reviewAfterMs: 2000 });
    await pastWork({ contributor: cb, units: 8, origin: 'ballot_directed', model: 'gpt-5', reviewAfterMs: 3000 });
    await pastWork({ contributor: cb, units: 3, origin: 'self_picked', model: null, status: 'rejected', reviewAfterMs: 4000 });
    await pastWork({ contributor: cb, units: 1, origin: 'self_picked', project: 'swarm-ai', model: 'weird-model', reviewAfterMs: 5000 });

    const r = await rollupWeek(env, week);
    expect(r).toMatchObject({ week, projects: 2, newly: true });
    const th = await one('SELECT * FROM weekly_project_stats WHERE week = ?1 AND project = ?2', week, 'town-hall');
    expect(th).toMatchObject({
      routed_units: 4, ballot_directed_units: 8, self_picked_units: 3,
      accepted_routed_units: 4, accepted_ballot_directed_units: 8, accepted_self_picked_units: 0,
      tasks_created: 4, tasks_claimed: 4, tasks_submitted: 4, tasks_accepted: 3, tasks_rejected: 1,
      contributors: 2, reviews: 4,
    });
    expect(th.review_p50_ms).toBe(2000); // nearest rank of the four review times
    expect(th.review_p90_ms).toBe(4000);
    expect(await all('SELECT family, submissions FROM weekly_model_stats WHERE week = ?1 AND project = ?2 ORDER BY family', week, 'town-hall')).toEqual([
      { family: 'claude', submissions: 2 }, { family: 'gpt', submissions: 1 }, { family: 'unreported', submissions: 1 },
    ]);
    expect(await one('SELECT family, submissions FROM weekly_model_stats WHERE project = ?1', 'swarm-ai')).toEqual({ family: 'other', submissions: 1 });
    expect(await one('SELECT week FROM rollup_weeks')).toEqual({ week });
    // Only aggregates: no contributor, no model name, no handle anywhere in the rollup tables.
    const dump = JSON.stringify([await all('SELECT * FROM weekly_project_stats'), await all('SELECT * FROM weekly_model_stats')]);
    for (const secret of [a.handle, b.handle, 'claude-opus-4', 'gpt-5', 'weird-model']) expect(dump).not.toContain(secret);
  });

  it('is idempotent: running a week again, or two runs at once, changes nothing', async () => {
    const u = await newUser(); const c = await cid(u.handle);
    await pastWork({ contributor: c, model: 'claude-x' });
    const week = weekOf(lastWeekStart());
    await rollupWeek(env, week);
    const before = JSON.stringify([await all('SELECT * FROM weekly_project_stats'), await all('SELECT * FROM weekly_model_stats'), await all('SELECT week FROM rollup_weeks')]);
    expect((await rollupWeek(env, week)).newly).toBe(false);
    await Promise.all([rollupWeek(env, week), rollupWeek(env, week), runRollup(env)]);
    // New work arriving late in an already-rolled-up week does not rewrite its record either.
    await pastWork({ contributor: c, model: 'claude-late' });
    await rollupWeek(env, week);
    expect(JSON.stringify([await all('SELECT * FROM weekly_project_stats'), await all('SELECT * FROM weekly_model_stats'), await all('SELECT week FROM rollup_weeks')])).toBe(before);
    expect((await one('SELECT COUNT(*) AS n FROM weekly_project_stats')).n).toBe(1);
  });

  it('rolls up each closed week once, oldest first, never the current week', async () => {
    const u = await newUser(); const c = await cid(u.handle);
    await pastWork({ contributor: c, weeksAgo: 3 });
    await pastWork({ contributor: c, weeksAgo: 1 });
    const first = await runRollup(env);
    expect(first.done).toEqual([weekOf(weekStartMs() - 3 * WEEK), weekOf(weekStartMs() - 2 * WEEK), weekOf(weekStartMs() - WEEK)]);
    expect(first.through).toBe(weekStartMs());
    expect(weekOf(weekStartMs())).not.toBe(first.done.at(-1));
    expect((await one('SELECT COUNT(*) AS n FROM rollup_weeks')).n).toBe(3);
    expect(await runRollup(env)).toEqual({ done: [], through: weekStartMs() });
    // The empty middle week has a marker but no stats.
    expect((await one('SELECT COUNT(*) AS n FROM weekly_project_stats WHERE week = ?1', weekOf(weekStartMs() - 2 * WEEK))).n).toBe(0);
  });

  it('does nothing when there is no data, and the hourly job runs it', async () => {
    expect(await runRollup(env)).toEqual({ done: [], through: weekStartMs() });
    const u = await newUser(); await pastWork({ contributor: await cid(u.handle) });
    const ctx = createExecutionContext();
    await worker.scheduled({}, makeEnv(), ctx); await waitOnExecutionContext(ctx);
    expect((await one('SELECT COUNT(*) AS n FROM rollup_weeks')).n).toBe(1);
  });

  it('percentile uses nearest rank', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
  });

  it('weekAggregates for a week with nothing is empty', async () => {
    expect(await weekAggregates(env, weekOf(weekStartMs() - 30 * WEEK))).toEqual([]);
  });
});

describe('GET /api/analytics', () => {
  it('serves the rollups: work counts exact, counts of people and model families "fewer than 5" below 5, review times from 5 reviews', async () => {
    const users = [];
    for (let i = 0; i < 5; i++) users.push(await newUser());
    const week = weekOf(lastWeekStart());
    // town-hall: 5 contributors, 5 claude submissions; swarm-ai: 1 contributor, 1 gpt submission.
    for (const u of users) await pastWork({ contributor: await cid(u.handle), model: 'claude-x', units: 3 });
    await pastWork({ contributor: await cid(users[0].handle), project: 'swarm-ai', model: 'gpt-5', units: 1 });
    await runRollup(env);
    const data = await (await send('/api/analytics')).json();
    const w = data.weeks.find((x) => x.week === week);
    const th = w.projects.find((p) => p.project === 'town-hall'), sw = w.projects.find((p) => p.project === 'swarm-ai');
    expect(th.units.routed).toBe(15); expect(th.tasks.accepted).toBe(5);
    expect(th.contributors).toBe(5); expect(th.model_families).toEqual({ claude: 5 });
    expect(th.review.count).toBe(5); expect(th.review.p50_ms).toBeGreaterThan(0);
    expect(sw.units.routed).toBe(1); // work is exact
    expect(sw.contributors).toBe('fewer than 5');
    expect(sw.model_families).toEqual({ gpt: 'fewer than 5' });
    expect(sw.review.count).toBe(1); expect(sw.review.p50_ms).toBeNull();
    const text = JSON.stringify(data);
    for (const u of users) expect(text).not.toContain(u.handle);
    expect(text).not.toContain('claude-x');
    expect((await send('/api/analytics?weeks=1')).status).toBe(200);
  });
});

describe('weekly_purge', () => {
  async function purgedUser(history = 'weekly_purge') {
    const v = await voter();
    await mePost('/api/me/privacy', v, { history });
    const u = await linkedUser(v);
    return { v, u, c: await cid(u.handle) };
  }

  it('after the rollup, deletes the per-item detail of a weekly_purge account and keeps the work credited to the project', async () => {
    const { u, c } = await purgedUser();
    const w = await pastWork({ contributor: c, model: 'claude-x', tokens: 999, units: 3, origin: 'ballot_directed', published: true });
    const rejected = await pastWork({ contributor: c, status: 'rejected', units: 1 });
    const out = await runWeeklyMaintenance(env);
    expect(out.rolled).toEqual([weekOf(lastWeekStart())]);
    expect(out.purged).toMatchObject({ claims: 2, submissions: 2 });
    expect(out.purged.events).toBeGreaterThanOrEqual(2);

    const stand = (await one('SELECT id FROM contributors WHERE handle = ?1', PURGED_HANDLE)).id;
    for (const id of [w.claim, rejected.claim]) expect((await one('SELECT contributor, network FROM claims WHERE id = ?1', id)).contributor).toBe(stand);
    expect(await one('SELECT contributor, body, model, tokens_est, prescreen, status, reviewed_by, task FROM submissions WHERE id = ?1', w.sub)).toMatchObject({ contributor: stand, body: '', model: null, tokens_est: null, status: 'accepted', reviewed_by: 'Daryll (BigPic Solutions)', task: w.task });
    const ev = await all('SELECT contributor, actor, detail FROM events WHERE submission = ?1', w.sub);
    expect(ev).toEqual([{ contributor: null, actor: null, detail: null }]);
    // The work is still the project's: the task is accepted, the units are in the rollup, and the receipt still exists (anonymously).
    expect((await one('SELECT status FROM tasks WHERE id = ?1', w.task)).status).toBe('accepted');
    expect((await one('SELECT accepted_ballot_directed_units AS n FROM weekly_project_stats WHERE project = ?1', 'town-hall')).n).toBe(3);
    const receipts = (await (await send('/api/receipts?limit=50')).json()).receipts;
    expect(receipts.find((r) => r.id === w.sub)).toMatchObject({ credited_as: 'a contributor', handle: null, task: { id: w.task } });
    // The contributor does not get its old work back in my_work.
    expect((await u.call('my_work')).data.submissions).toEqual([]);
    // The stand-in is not counted as a person.
    const stats = await (await send('/api/stats')).json();
    expect(stats.totals.contributors).toBe('fewer than 5');
    expect((await one("SELECT COUNT(*) AS n FROM contributors WHERE handle = ?1", PURGED_HANDLE)).n).toBe(1);
  });

  it('leaves private accounts, contributors with no account, pending work and the current week alone', async () => {
    const priv = await purgedUser('private');
    const plain = await newUser(); const pc = await cid(plain.handle);
    const keep = await pastWork({ contributor: priv.c, model: 'claude-x' });
    const keep2 = await pastWork({ contributor: pc, model: 'claude-y' });
    const purge = await purgedUser();
    const pending = await pastWork({ contributor: purge.c, status: 'pending' });
    const current = await pastWork({ contributor: purge.c, weeksAgo: 0 });
    const out = await runWeeklyMaintenance(env);
    expect(out.purged.submissions).toBe(0);
    for (const s of [keep, keep2, pending, current]) expect((await one('SELECT body FROM submissions WHERE id = ?1', s.sub)).body).toBe(BODY);
    expect((await one('SELECT contributor FROM claims WHERE id = ?1', keep.claim)).contributor).toBe(priv.c);
    expect((await one('SELECT contributor FROM claims WHERE id = ?1', current.claim)).contributor).toBe(purge.c);
  });

  it('is idempotent, and switching to weekly_purge later purges older closed weeks at the next run', async () => {
    const { v, c } = await purgedUser('private');
    const w = await pastWork({ contributor: c, weeksAgo: 2, published: true });
    await runWeeklyMaintenance(env);
    expect((await one('SELECT body FROM submissions WHERE id = ?1', w.sub)).body).toBe(BODY);
    await mePost('/api/me/privacy', v, { history: 'weekly_purge' });
    const first = await runWeeklyMaintenance(env);
    expect(first.purged.submissions).toBe(1);
    expect(await runWeeklyMaintenance(env)).toEqual({ rolled: [], purged: { claims: 0, submissions: 0, events: 0 } });
  });

  it('never purges a week the rollup did not count', async () => {
    const { c } = await purgedUser();
    const w = await pastWork({ contributor: c, weeksAgo: 1 });
    expect(await purgeHistory(env, weekStartMs() - 2 * WEEK)).toEqual({ claims: 0, submissions: 0, events: 0 }); // cutoff before the work
    expect((await one('SELECT body FROM submissions WHERE id = ?1', w.sub)).body).toBe(BODY);
  });

  it('an accepted write-up a mission project still has to publish keeps its body until it is published', async () => {
    const { c } = await purgedUser();
    const unpublished = await pastWork({ contributor: c });
    const published = await pastWork({ contributor: c, published: true });
    await runWeeklyMaintenance(env);
    const kept = await one('SELECT body, contributor, model FROM submissions WHERE id = ?1', unpublished.sub);
    expect(kept.body).toBe(BODY);
    expect(kept.contributor).not.toBe(c); // the link to the person is cut even though the write-up waits to be published
    expect(kept.model).toBeNull();
    expect((await one('SELECT body FROM submissions WHERE id = ?1', published.sub)).body).toBe('');
  });

  it('a weekly_purge account that deletes itself or removes its handle still works with the stand-in', async () => {
    const { v, c } = await purgedUser();
    await pastWork({ contributor: c });
    await runWeeklyMaintenance(env);
    expect((await (await mePost('/api/me/delete', v, { confirm: 'delete my account' })).json()).deleted).toBe(true);
  });
});

describe('delete my account', () => {
  let leaverN = 0;
  async function leaver() {
    const v = await voter({ allocations: { 'town-hall': 100 } });
    await mePost('/api/me/privacy', v, { credit: 'handle' });
    const u = await linkedUser(v, { handle: leaverN++ ? `leaving-${leaverN}` : 'leaving-one' });
    const c = await cid(u.handle);
    const w = await pastWork({ contributor: c, weeksAgo: 0 });
    return { v, u, c, w };
  }

  it('needs the passkey session, the exact Origin and X-Swarm, and the typed confirmation', async () => {
    const { v } = await leaver();
    expect((await mePost('/api/me/delete', null, { confirm: 'delete my account' })).status).toBe(401);
    expect((await mePost('/api/me/delete', v, { confirm: 'delete my account' }, { headers: { Origin: 'https://evil.test' } })).status).toBe(403);
    for (const bad of [{}, { confirm: 'yes' }, { confirm: 'Delete my account' }, { confirm: true }]) expect((await mePost('/api/me/delete', v, bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await send('/api/me/delete')).status).toBe(405);
    expect((await one('SELECT id FROM accounts WHERE id = ?1', v.id))).toBeTruthy();
  });

  it('deletes the account, credentials, sessions, link codes and the link to the AI, and clears the cookie', async () => {
    const { v, c } = await leaver();
    await env.DB.prepare("INSERT INTO credentials (id, account, public_key, sign_count, transports) VALUES ('cred-del', ?1, '{}', 0, '[]')").bind(v.id).run();
    await mePost('/api/me/link-code', v);
    const res = await mePost('/api/me/delete', v, { confirm: 'delete my account' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect((await res.json()).deleted).toBe(true);
    for (const sql of ['SELECT id FROM accounts WHERE id = ?1', 'SELECT id FROM credentials WHERE account = ?1', 'SELECT hash FROM sessions WHERE account = ?1', 'SELECT hash FROM link_codes WHERE account = ?1', 'SELECT account FROM account_links WHERE account = ?1']) expect(await one(sql, v.id), sql).toBeNull();
    expect(await (await meGet(v)).json()).toEqual({ signed_in: false });
    expect(await one('SELECT owner_account FROM contributors WHERE id = ?1', c)).toEqual({ owner_account: null });
  });

  it('turns the contributor into "removed contributor": a random handle, a dead key, the work still the project\'s', async () => {
    const { v, u, c, w } = await leaver();
    expect((await (await send('/api/receipts?limit=50')).json()).receipts.find((r) => r.id === w.sub)).toMatchObject({ credited_as: u.handle });
    await mePost('/api/me/delete', v, { confirm: 'delete my account' });
    const row = await one('SELECT handle, removed, credit, key_hash, owner_account, pair_ip, github FROM contributors WHERE id = ?1', c);
    expect(row).toMatchObject({ removed: 1, credit: 'anonymous', owner_account: null, pair_ip: null });
    expect(row.handle).toMatch(/^removed-[a-z0-9]{8}$/);
    const receipt = (await (await send('/api/receipts?limit=50')).json()).receipts.find((r) => r.id === w.sub);
    expect(receipt).toMatchObject({ credited_as: 'removed contributor', handle: null });
    expect(JSON.stringify(await send('/api/receipts').then((r) => r.json()))).not.toContain(u.handle);
    expect((await u.call('my_work')).isError).toBe(true); // the key no longer opens anything
    expect((await one('SELECT status FROM tasks WHERE id = ?1', w.task)).status).toBe('accepted');
    expect((await one('SELECT status FROM submissions WHERE id = ?1', w.sub)).status).toBe('accepted');
    expect((await tool('pair', { handle: u.handle }, { ip: '203.0.113.99' })).isError).toBe(false); // the old handle is free again
  });

  it('anonymises the ballot versions and leaves past snapshots untouched', async () => {
    const { v } = await leaver();
    await env.DB.prepare('INSERT INTO ballot_versions(account, version, allocations, created) VALUES (?1, 2, ?2, ?3)').bind(v.id, JSON.stringify({ 'town-hall': 60, 'swarm-ai': 40 }), Date.now()).run();
    await env.DB.prepare('INSERT OR REPLACE INTO vote_snapshots(week, voter_count, published_at, source, op) VALUES (?1, 7, ?2, ?3, ?4)').bind('2026-09-28', 1, 'ballots', 'keep-op').run();
    await env.DB.prepare('INSERT OR REPLACE INTO allocation(week, project, share, provisional) VALUES (?1, ?2, 6000, 0)').bind('2026-09-28', 'town-hall').run();
    const snapshotsBefore = JSON.stringify(await all('SELECT * FROM vote_snapshots ORDER BY week'));
    const allocationBefore = JSON.stringify(await all("SELECT * FROM allocation WHERE week = '2026-09-28'"));
    const countBefore = (await one('SELECT COUNT(*) AS n FROM ballot_versions')).n;
    await mePost('/api/me/delete', v, { confirm: 'delete my account' });
    expect((await one('SELECT COUNT(*) AS n FROM ballot_versions WHERE account = ?1', v.id)).n).toBe(0);
    expect((await one('SELECT COUNT(*) AS n FROM ballot_versions')).n).toBe(countBefore); // still in the audit trail
    const gone = await all("SELECT account, version FROM ballot_versions WHERE account LIKE 'gone:%' ORDER BY id");
    expect(gone.length).toBeGreaterThanOrEqual(2);
    expect(new Set(gone.map((g) => g.account)).size).toBe(gone.length); // no two versions can be tied to the same voter
    expect(JSON.stringify(await all('SELECT * FROM vote_snapshots ORDER BY week'))).toBe(snapshotsBefore);
    expect(JSON.stringify(await all("SELECT * FROM allocation WHERE week = '2026-09-28'"))).toBe(allocationBefore);
    // A deleted account's ballot no longer counts toward a new snapshot.
    await env.DB.prepare('DELETE FROM vote_snapshots WHERE week = ?1').bind(weekOf()).run();
    await env.DB.prepare('UPDATE accounts SET suspended = 1').run();
    await publishSnapshot(env);
    expect((await one('SELECT voter_count FROM vote_snapshots WHERE week = ?1', weekOf())).voter_count).toBe(0);
  });

  it('scrubs the handle from events and records the deletion with no detail', async () => {
    const t0 = Date.now();
    const { v, u, c, w } = await leaver();
    await mePost('/api/me/delete', v, { confirm: 'delete my account' });
    const mine = await all('SELECT actor, detail FROM events WHERE contributor = ?1', c);
    expect(mine.length).toBeGreaterThan(0);
    const handle = (await one('SELECT handle FROM contributors WHERE id = ?1', c)).handle; // the tombstone
    const old = u.handle;
    for (const e of mine) { expect(e.detail).toBeNull(); expect(e.actor).not.toBe(old); }
    expect(await all('SELECT id FROM events WHERE actor = ?1 OR detail LIKE ?2', old, `%${old}%`)).toEqual([]);
    expect(handle).toMatch(/^removed-/);
    const ev = await all("SELECT contributor, task, submission, actor, detail FROM events WHERE type = 'account_deleted' AND ts >= ?1", t0);
    expect(ev).toEqual([{ contributor: null, task: null, submission: null, actor: 'system', detail: null }]);
    expect(w.sub).toBeTruthy();
  });

  it('leaves other accounts alone, and an account with no AI can be deleted too', async () => {
    const other = await voter();
    const solo = await voter({ allocations: null });
    const res = await mePost('/api/me/delete', solo, { confirm: 'delete my account' });
    expect((await res.json()).deleted).toBe(true);
    expect(await one('SELECT id FROM accounts WHERE id = ?1', other.id)).toBeTruthy();
    expect((await meGet(other).then((r) => r.json())).signed_in).toBe(true);
  });

  it('deleteAccount on an unknown account deletes nothing and records nothing', async () => {
    const before = (await one('SELECT COUNT(*) AS n FROM events')).n;
    expect((await deleteAccount(env, 'no-such-account')).deleted).toBe(false);
    expect((await one('SELECT COUNT(*) AS n FROM events')).n).toBe(before);
  });
});

describe('remove my handle', () => {
  it('replaces the handle with a random tombstone, keeps the key working, and sets credit to anonymous', async () => {
    const u = await newUser({ handle: 'old-name' });
    await u.call('set_credit', { credit: 'handle' });
    const r = await u.call('remove_handle');
    expect(r.isError, r.text).toBe(false);
    expect(r.data.handle).toMatch(/^anon-[a-z0-9]{8}$/);
    expect((await u.call('my_work')).data.handle).toBe(r.data.handle); // the same key, a new name
    expect(await one('SELECT credit FROM contributors WHERE handle = ?1', r.data.handle)).toEqual({ credit: 'anonymous' });
    expect(await one('SELECT id FROM contributors WHERE handle = ?1', 'old-name')).toBeNull();
    // A second removal gives yet another random name.
    expect((await u.call('remove_handle')).data.handle).not.toBe(r.data.handle);
  });

  it('removes the old handle from past receipts and events, and writes an event with no detail', async () => {
    const t0 = Date.now();
    const u = await newUser({ handle: 'fading-name' });
    await u.call('set_credit', { credit: 'handle' });
    const t = await addTask(); await u.call('claim_task', { id: t });
    const s = await u.call('submit_work', { task_id: t, body: BODY, sources: [SOURCE] });
    await env.DB.prepare("UPDATE submissions SET status = 'accepted', reviewed_by = 'Rev', reviewed_at = ?2 WHERE id = ?1").bind(s.data.submission_id, Date.now()).run();
    await env.DB.prepare("UPDATE tasks SET status = 'accepted' WHERE id = ?1").bind(t).run();
    expect(JSON.stringify(await (await send('/api/receipts')).json())).toContain('fading-name');
    await u.call('remove_handle');
    expect(JSON.stringify(await (await send('/api/receipts')).json())).not.toContain('fading-name');
    expect(await all('SELECT id FROM events WHERE actor = ?1 OR detail LIKE ?2', 'fading-name', '%fading-name%')).toEqual([]);
    const ev = await all("SELECT contributor, actor, detail FROM events WHERE type = 'handle_removed' AND ts >= ?1", t0);
    expect(ev).toEqual([{ contributor: null, actor: 'system', detail: null }]);
  });

  it('works from /me for a linked AI, and says so when there is none', async () => {
    const v = await voter();
    expect((await (await mePost('/api/me/remove-handle', v)).json()).removed).toBe(0);
    const u = await linkedUser(v, { handle: 'linked-name' });
    const r = await (await mePost('/api/me/remove-handle', v)).json();
    expect(r.removed).toBe(1);
    expect((await meGet(v).then((x) => x.json())).linked.handle).toMatch(/^anon-/);
    expect((await u.call('my_work')).isError).toBe(false);
    expect((await mePost('/api/me/remove-handle', null)).status).toBe(401);
  });

  it('needs a key, and a removed contributor cannot do it again', async () => {
    expect((await tool('remove_handle')).isError).toBe(true);
    const u = await newUser();
    const id = await cid(u.handle);
    expect(await removeHandle(env, id)).toMatch(/^anon-/);
    await env.DB.prepare('UPDATE contributors SET removed = 1, owner_account = NULL WHERE id = ?1').bind(id).run();
    expect(await removeHandle(env, id)).toBeNull();
  });
});
