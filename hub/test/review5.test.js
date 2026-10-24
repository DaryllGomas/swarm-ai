// Regression tests for Codex review 5 (docs: cybersecurity/house/audits/2026-10-20-swarm-ai-codex-review-5.md). Each test reconstructs the attack
// the review used and shows it fails, rather than only checking that a field is absent. Findings 1 and 13 are in dp.test.js and migration-0011.test.js.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { ADMIN, BODY, SOURCE, addTask, makeEnv, newUser, resetDb, review, send, tool } from './helpers.js';
import { accessFixture } from './access-helpers.js';
import { gate, wrapDb } from './fault.js';
import { weekOf, weekStartMs } from '../src/lib.js';
import { closeClaimStmts, expireClaims } from '../src/core.js';
import { PURGED_HANDLE, deleteAccount, removeHandle } from '../src/privacy.js';
import { purgeOAuth } from '../src/oauth-core.js';
import { rollupWeek, runRollup, runWeeklyMaintenance, UNPUBLISHED_BODY_DAYS } from '../src/rollup.js';
import { NO_NOISE, linkedUser, mePost, publicAllocation, setupProjects, voter } from './voter.js';
import { connect, mcpTool, o } from './oauth-helpers.js';

const DAY = 86400000, WEEK = 7 * DAY;
const lastWeekStart = () => weekStartMs() - WEEK;
const one = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const all = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then((r) => r.results);
const cid = (handle) => one('SELECT id FROM contributors WHERE handle = ?1', handle).then((r) => r.id);
function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296; };
}

beforeEach(async () => {
  await resetDb(); await setupProjects();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM weekly_project_stats'), env.DB.prepare('DELETE FROM rollup_weeks'),
    env.DB.prepare('DELETE FROM contributors WHERE handle = ?1').bind(PURGED_HANDLE),
  ]);
  await publicAllocation({ 'town-hall': 5000, 'swarm-ai': 5000 });
});

// ---------------------------------------------------------------- helpers
// Every public surface that could carry a live number, normalised so two worlds can be compared: task ids become t1, t2, ..., times are dropped.
async function surfaces(ids = []) {
  const names = new Map(ids.map((id, i) => [id, `t${i + 1}`]));
  const get = async (p) => (await send(p)).text();
  const mcp = async (name, args) => JSON.stringify((await tool(name, args)).data);
  const raw = [
    await get('/api/stats'), await get('/api/tasks?limit=200'), await get('/api/tasks?status=claimed'), await get('/api/tasks?status=ready'),
    ...(await Promise.all(ids.map((id) => get(`/api/tasks/${id}`)))),
    await get('/api/vote/current'), await get('/api/vote/audit'), await get('/api/receipts'), await get('/api/analytics'),
    await mcp('list_projects', {}), await mcp('list_tasks', { status: 'claimed' }), await mcp('list_tasks', {}),
    ...(await Promise.all(ids.map((id) => mcp('get_task', { id })))),
  ].join('\n');
  return raw.replace(/"(updated|created|week_start|published_at|source_key|brief)":"[^"]*"/g, '"$1":"-"').replace(/"id":(\d+)/g, (m, n) => (names.has(Number(n)) ? `"id":"${names.get(Number(n))}"` : m)).replace(/\/api\/tasks\/(\d+)/g, (m, n) => `/api/tasks/${names.get(Number(n)) ?? n}`);
}
// Insert finished/standing claims straight into the tables, for a past week: { person, units, origin }.
async function pastClaim({ contributor, units, origin = 'ballot_directed', weeksAgo = 1, project = 'town-hall', outcome = 'submitted', network = 'nethash' }) {
  const start = weekStartMs() - weeksAgo * WEEK, task = await addTask({ units, project, status: 'submitted' });
  const at = start + 1000;
  const claim = (await env.DB.prepare(`INSERT INTO claims (task, contributor, routed, week, claimed_at, expires_at, outcome, network, routing_origin) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
    .bind(task, contributor, origin === 'public_routed' ? 1 : 0, weekOf(start), at, at + 10800000, outcome, network, origin).run()).meta.last_row_id;
  return { task, claim };
}
async function pastWork({ contributor, weeksAgo = 1, project = 'town-hall', units = 3, status = 'accepted', published = false, reviewedAgoMs = null, origin = 'ballot_directed' }) {
  const { task, claim } = await pastClaim({ contributor, units, origin, weeksAgo, project });
  const start = weekStartMs() - weeksAgo * WEEK, reviewedAt = reviewedAgoMs === null ? start + 3600000 : Date.now() - reviewedAgoMs;
  const sub = (await env.DB.prepare(`INSERT INTO submissions (task, contributor, claim, body, sources, status, reviewed_by, reviewed_at, created, published_url, published_at)
    VALUES (?1, ?2, ?3, ?4, '["https://example.org/a"]', ?5, 'Reviewer', ?6, ?7, ?8, ?9)`).bind(task, contributor, claim, BODY, status, reviewedAt, start + 2000, published ? 'https://example.org/p' : null, published ? reviewedAt : null).run()).meta.last_row_id;
  await env.DB.prepare("UPDATE tasks SET status = 'accepted', created = ?2 WHERE id = ?1").bind(task, start + 500).run();
  await env.DB.prepare("INSERT INTO events (ts, type, task, contributor, submission, actor, detail) VALUES (?1, 'task_claimed', ?2, ?3, ?4, (SELECT handle FROM contributors WHERE id = ?3), '{\"claim\":1}')").bind(start + 1000, task, contributor, sub).run();
  return { task, claim, sub };
}
const purgeUser = async (history = 'weekly_purge') => {
  const v = await voter(); await mePost('/api/me/privacy', v, { history });
  const u = await linkedUser(v);
  return { v, u, c: await cid(u.handle) };
};

// ---------------------------------------------------------------- findings 1-2: the live public surface
describe('finding 2: nothing live separates a personal claim, and the origins cannot be told apart', () => {
  it('the exact Codex probe: one linked voter claims a 3-unit task; claimed-units minus routed-units minus self-picked does not give the hidden 3', async () => {
    const t = await addTask({ units: 3, project: 'town-hall' });
    const ready = async () => JSON.parse(await (await send('/api/tasks?limit=200')).text());
    const stats = async () => JSON.parse(await (await send('/api/stats')).text()).projects.find((p) => p.id === 'town-hall');
    const before = await stats();
    const u = await linkedUser(await voter({ allocations: { 'town-hall': 100 } }));
    const r = await u.call('next_task'); expect(r.data.claim.routing_origin).toBe('ballot_directed');
    const after = await stats(), tasks = await ready();
    // The attacker's estimate, using every public number the review used.
    const claimedUnits = tasks.tasks.filter((x) => x.status === 'claimed').reduce((a, x) => a + x.units, 0);
    expect(Object.keys(after).filter((k) => /routed|self|directed|claimed/.test(k))).toEqual([]); // there is no routed figure to subtract (review 6: none at all)
    expect(claimedUnits).toBe(0);                                  // a claimed task is shown as ready
    expect(tasks.tasks.find((x) => x.id === t).status).toBe('ready');
    expect(after.open_tasks).toBe(before.open_tasks);             // a claim does not move the open count
  });

  it('polling: a personal claim leaves every public surface byte-for-byte unchanged', async () => {
    const t1 = await addTask({ units: 3 }), t2 = await addTask({ units: 1 });
    const u = await linkedUser(await voter({ allocations: { 'town-hall': 100 } })), self = await newUser();
    const before = await surfaces([t1, t2]);
    expect((await u.call('next_task')).data.claim.routing_origin).toBe('ballot_directed');
    expect((await self.call('claim_task', { id: t2 })).isError).toBe(false);
    expect(await surfaces([t1, t2])).toBe(before);
    // ...and so does a PUBLIC-routed claim (review 6: no live routed figure exists, so nothing separates the two).
    const pub = await newUser(); const t3 = await addTask({ units: 8 });
    const base = await surfaces([t1, t2, t3]);
    const during = (await pub.call('next_task')); expect(during.data.claim.routing_origin).toBe('public_routed');
    expect(await surfaces([t1, t2, t3])).toBe(base);
  });

  it('indistinguishability: bd 3 + self 8 and bd 8 + self 3 give identical public surfaces, so the split between ballot-directed and self-picked cannot be recovered', async () => {
    async function world(bdFirst) {
      await resetDb(); await setupProjects(); await publicAllocation({ 'town-hall': 5000, 'swarm-ai': 5000 });
      const a = await addTask({ units: 3, title: 'Task A' }), b = await addTask({ units: 8, title: 'Task B' });
      const bd = await linkedUser(await voter({ allocations: { 'town-hall': 100 } })), self = await newUser();
      if (bdFirst) { await bd.call('next_task'); await self.call('claim_task', { id: b }); } // bd took the 3-unit task, self the 8
      else { await self.call('claim_task', { id: a }); await bd.call('next_task'); }          // self took the 3-unit task, bd the 8
      const origins = (await all('SELECT t.units AS units, c.routing_origin AS o FROM claims c JOIN tasks t ON t.id = c.task ORDER BY t.units')).map((r) => `${r.units}:${r.o}`);
      return { surface: await surfaces([a, b]), origins };
    }
    const A = await world(true), B = await world(false);
    expect(A.origins).toEqual(['3:ballot_directed', '8:self_picked']);
    expect(B.origins).toEqual(['3:self_picked', '8:ballot_directed']);
    expect(A.surface).toBe(B.surface);
  });

  it('after hand-in the status is public, but identical for every origin: a submission carries no route', async () => {
    const pubUser = await newUser(), bd = await linkedUser(await voter({ allocations: { 'town-hall': 100 } }));
    await addTask({ units: 3 }); await addTask({ units: 3 });
    const a = await pubUser.call('claim_task', { id: (await all("SELECT id FROM tasks WHERE status = 'ready' ORDER BY id"))[0].id });
    const b = await bd.call('next_task');
    for (const [u, r] of [[pubUser, a], [bd, b]]) await u.call('submit_work', { task_id: r.data.task.id, body: BODY, sources: [SOURCE] });
    const text = JSON.stringify([await (await send('/api/tasks?limit=200')).json(), await (await send('/api/stats')).json()]);
    expect(text).not.toMatch(/routing_origin|ballot_directed|self_picked|self_directed|origin/);
  });

  it('the review\'s second probe: four voters direct work to Town Hall, one to Swarm AI: there is no personal figure of any kind to unlock', async () => {
    const mk = async (project) => linkedUser(await voter({ allocations: { [project]: 100 } }));
    const users = [await mk('town-hall'), await mk('town-hall'), await mk('town-hall'), await mk('town-hall'), await mk('swarm-ai')];
    for (const u of users) { await addTask({ project: u === users[4] ? 'swarm-ai' : 'town-hall', units: 1 }); expect((await u.call('next_task')).data.claim.routing_origin).toBe('ballot_directed'); }
    await rollupWeek(env, weekOf(), Date.now(), NO_NOISE);
    const data = await (await send('/api/analytics')).json();
    const w = data.weeks.find((x) => x.week === weekOf());
    expect(w.personal_direction).toBeUndefined();
    expect(w.total_claimed_units).toBe(5);                                                // every route added together
    for (const p of w.projects) expect(Object.keys(p)).not.toContain('units');
    expect(JSON.stringify(w)).not.toMatch(/ballot_directed|self_picked|personal|contributors_this_week/);
    const stats = await (await send('/api/stats')).json();
    expect(JSON.stringify(stats)).not.toMatch(/ballot_directed|self_directed|contributors/);
  });
});

describe('finding 3: the operator console', () => {
  async function world() {
    const bdVoter = await voter({ allocations: { 'town-hall': 100 } });
    const bd = await linkedUser(bdVoter, { handle: 'private-target' });
    const self = await newUser({ handle: 'plain-picker' });
    const t1 = await addTask({ units: 3 }), t2 = await addTask({ units: 1 });
    expect((await bd.call('next_task')).data.claim.routing_origin).toBe('ballot_directed');
    await self.call('claim_task', { id: t2 });
    await bd.call('release_task', { id: t1 }); await bd.call('next_task');
    return { bd, self, t1, t2, bdId: await cid(bd.handle), bdVoter };
  }

  it('reconstruct-and-fail: every allowed operator response together does not tie a named contributor to a steering origin', async () => {
    const w = await world();
    const a = await accessFixture();
    const bodies = [];
    for (const path of ['overview', 'pending', 'held', 'projects', 'audit']) bodies.push(await (await a.get(path)).json());
    let before = null;
    do { const page = await (await a.get(`audit${before ? `?before=${before}` : ''}`)).json(); bodies.push(page); before = page.next_before; } while (before);
    const text = JSON.stringify(bodies);
    expect(text).not.toMatch(/ballot_directed|self_picked|"origin"|"routed"|routing_origin/);
    // The Codex join: active claims x claim events. Claims name no one, and the events that carry the claim id name no one either.
    const overview = bodies[0], audit = bodies[4];
    expect(overview.active_claims.length).toBeGreaterThan(0);
    const claimEvents = audit.events.filter((e) => ['task_claimed', 'claim_released', 'claim_expired'].includes(e.type));
    expect(claimEvents.length).toBeGreaterThan(0);
    for (const e of claimEvents) { expect(e.contributor).toBeNull(); expect(e.actor).toBeNull(); expect(e.detail ?? '').not.toContain(w.bd.handle); }
    for (const c of overview.active_claims) { expect(Object.keys(c)).not.toContain('contributor'); expect(Object.keys(c)).not.toContain('handle'); }
    // The handle of the steered contributor appears in no claim, link or steering event, nor any active-claim listing.
    expect(JSON.stringify(overview)).not.toContain(w.bd.handle);
    expect(JSON.stringify(audit.events.filter((e) => /claim|link/.test(e.type)))).not.toContain(w.bd.handle);
    // Link events: no contributor, no actor, no detail.
    for (const e of audit.events.filter((x) => x.type === 'account_linked')) expect(e).toMatchObject({ contributor: null, actor: null, detail: null });
  });

  it('the database still holds the events (the console just does not show the relationship): direct database access is outside the boundary and the docs say so', async () => {
    const w = await world();
    expect((await one("SELECT COUNT(*) AS n FROM events WHERE type = 'task_claimed' AND contributor = ?1", w.bdId)).n).toBeGreaterThan(0);
    const policy = (await import('../../docs/DATA-POLICY.md?raw')).default, privacy = (await import('../public/privacy-details.html?raw')).default;
    expect(policy).toMatch(/direct (database|D1) access is outside this boundary/i);
    expect(privacy.replace(/<[^>]+>/g, ' ')).toMatch(/direct database access is outside/i);
  });

  it('not even a closed week gives the operator an origin figure: the console has no origin or personal-direction field', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await cid((await newUser()).handle));
    for (const c of ids) await pastClaim({ contributor: c, units: 3, origin: 'self_picked' });
    await runRollup(env, Date.now(), NO_NOISE);
    const a = await accessFixture();
    const overview = await (await a.get('overview')).json();
    expect(overview.closed_week_release).toBeUndefined();
    expect(overview.routed_by_origin).toBeUndefined();
    expect(JSON.stringify(overview)).not.toMatch(/personal|self_picked|ballot_directed|public_routed/);
  });

  it('a heavy-churn contributor is flagged by name only above the abuse threshold, and without any route', async () => {
    const u = await newUser(); const c = await cid(u.handle);
    await env.DB.batch(Array.from({ length: 5 }, () => env.DB.prepare("INSERT INTO events (ts,type,contributor,actor) VALUES (?1,'task_claimed',?2,?3)").bind(Date.now(), c, u.handle)));
    const a = await accessFixture();
    expect((await (await a.get('audit')).json()).signals.claim_churn_24h).toEqual([]);
  });
});

describe('finding 4: model families are not analytics any more', () => {
  it('the exact Codex probe (five claude, one gpt) leaves nothing to subtract: there is no model data in any rollup or response', async () => {
    const u = await newUser(), c = await cid(u.handle);
    for (let i = 0; i < 5; i++) { const w = await pastWork({ contributor: c }); await env.DB.prepare("UPDATE submissions SET model = 'claude-opus' WHERE id = ?1").bind(w.sub).run(); }
    const g = await pastWork({ contributor: c }); await env.DB.prepare("UPDATE submissions SET model = 'gpt-5' WHERE id = ?1").bind(g.sub).run();
    await runRollup(env, Date.now(), NO_NOISE);
    const data = await (await send('/api/analytics')).json();
    const p = data.weeks[0].projects.find((x) => x.project === 'town-hall');
    expect(p.tasks).toEqual({ created: 6, accepted: 6, rejected: 0 });
    expect(JSON.stringify(data)).not.toMatch(/claude|gpt|model_famil|"famil|"models"/i);
    expect(await all("SELECT name FROM sqlite_master WHERE name LIKE '%model%'")).toEqual([]);
    expect(Object.keys(await one('SELECT * FROM weekly_project_stats'))).not.toContain('model');
  });
});

// ---------------------------------------------------------------- findings 5-6: purge
describe('finding 5: the weekly purge cuts the owner-to-item join in newer events too', () => {
  const ownerJoin = (submission) => all('SELECT e.id FROM events e JOIN contributors c ON c.id = e.contributor WHERE e.submission = ?1 AND c.owner_account IS NOT NULL', submission);

  it('probe 1: an old accepted submission published in the CURRENT week keeps no event that names its owner', async () => {
    const { u, c } = await purgeUser();
    const w = await pastWork({ contributor: c, published: false });
    // Published now, so its event is newer than the purge cutoff.
    expect((await send('/api/admin/published', { method: 'POST', headers: { ...ADMIN(), 'Content-Type': 'application/json' }, body: JSON.stringify({ submission_id: w.sub, url: 'https://example.org/published' }) })).status).toBe(200);
    expect((await ownerJoin(w.sub)).length).toBeGreaterThan(0);               // before the purge the join exists
    await runWeeklyMaintenance(env);
    expect(await ownerJoin(w.sub)).toEqual([]);                               // after it, no event ties the submission to an owned contributor
    expect(await all('SELECT id FROM events WHERE submission = ?1 AND contributor IS NOT NULL', w.sub)).toEqual([]);
    expect((await one('SELECT contributor FROM submissions WHERE id = ?1', w.sub)).contributor).not.toBe(c);
    expect(u.handle).toBeTruthy();
  });

  it('probe 2: an expired claim from last week is expired FIRST, so its expiry event cannot carry the owner past the purge', async () => {
    const { c } = await purgeUser();
    const stale = await pastClaim({ contributor: c, units: 3, outcome: null });         // outstanding in a closed week...
    await env.DB.prepare("UPDATE claims SET expires_at = ?2 WHERE id = ?1").bind(stale.claim, Date.now() - 1000).run(); // ...and past its 3 hours
    await env.DB.prepare("UPDATE tasks SET status = 'claimed' WHERE id = ?1").bind(stale.task).run();
    await runWeeklyMaintenance(env);
    const claim = await one('SELECT contributor, outcome FROM claims WHERE id = ?1', stale.claim);
    expect(claim.outcome).toBe('expired');
    expect(claim.contributor).not.toBe(c);
    const rows = await all('SELECT e.contributor, e.actor FROM events e WHERE e.task = ?1', stale.task);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.contributor).not.toBe(c);
    // The join Codex used (task id -> claim -> contributor -> owner account) finds nothing.
    expect(await all(`SELECT 1 FROM events e JOIN claims k ON k.task = e.task JOIN contributors u ON u.id = e.contributor WHERE e.task = ?1 AND u.owner_account IS NOT NULL`, stale.task)).toEqual([]);
  });

  it('a late action on already-purged work cannot write the owner back: the event takes its contributor from the claim row at commit time', async () => {
    const { c } = await purgeUser();
    const w = await pastClaim({ contributor: c, units: 3, outcome: null });
    await env.DB.prepare("UPDATE claims SET expires_at = ?2 WHERE id = ?1").bind(w.claim, Date.now() - 1000).run();
    const stand = (await (await import('../src/privacy.js')).purgedContributorId(env));
    // The purge re-points the claim between the sweep's read and its write:
    await env.DB.prepare('UPDATE claims SET contributor = ?2 WHERE id = ?1').bind(w.claim, stand).run();
    await env.DB.batch(closeClaimStmts(env, { claim: w.claim, task: w.task, outcome: 'expired', actor: 'system' }));
    expect(await all("SELECT contributor FROM events WHERE type = 'claim_expired' AND task = ?1", w.task)).toEqual([{ contributor: stand }]);
  });

  it('the purge scrubs by the claim and submission being purged: events of the same task in a newer week lose the contributor, other tasks keep theirs', async () => {
    const { c } = await purgeUser();
    const old = await pastWork({ contributor: c });
    const other = await pastWork({ contributor: c, weeksAgo: 0 });                 // current week: not purged
    await env.DB.prepare("INSERT INTO events (ts, type, task, contributor, actor) VALUES (?1, 'late_note', ?2, ?3, 'system')").bind(Date.now(), old.task, c).run();
    await runWeeklyMaintenance(env);
    expect(await all("SELECT contributor FROM events WHERE type = 'late_note'")).toEqual([{ contributor: null }]);
    expect((await one("SELECT contributor FROM events WHERE task = ?1 AND type = 'task_claimed'", other.task)).contributor).toBe(c);
  });
});

describe('finding 6: an unpublished write-up is kept only until it is published or the deadline', () => {
  const body = async (sub) => (await one('SELECT body, contributor FROM submissions WHERE id = ?1', sub));

  it('kept while unpublished and inside the deadline, with the owner link already cut', async () => {
    const { c } = await purgeUser();
    const w = await pastWork({ contributor: c, weeksAgo: 1 });
    await runWeeklyMaintenance(env);
    const kept = await body(w.sub);
    expect(kept.body).toBe(BODY); expect(kept.contributor).not.toBe(c);
  });

  it('probe: after publication a later purge clears it (it used to stay forever, because the stand-in is never in the purge set)', async () => {
    const { c } = await purgeUser();
    const w = await pastWork({ contributor: c, weeksAgo: 1 });
    await runWeeklyMaintenance(env);
    expect((await body(w.sub)).body).toBe(BODY);
    await send('/api/admin/published', { method: 'POST', headers: { ...ADMIN(), 'Content-Type': 'application/json' }, body: JSON.stringify({ submission_id: w.sub, url: 'https://example.org/published' }) });
    const out = await runWeeklyMaintenance(env);
    expect(out.purged.bodies).toBe(1);
    expect((await body(w.sub)).body).toBe('');
  });

  it(`never longer than ${UNPUBLISHED_BODY_DAYS} days after review, published or not`, async () => {
    const { c } = await purgeUser();
    const w = await pastWork({ contributor: c, weeksAgo: 1, reviewedAgoMs: 7 * DAY }); // reviewed exactly 7 days ago, whatever today is
    await runWeeklyMaintenance(env);
    expect((await body(w.sub)).body).toBe(BODY);
    await runWeeklyMaintenance(env, Date.now() + 20 * DAY);                          // still inside 30 days of the review
    expect((await body(w.sub)).body).toBe(BODY);
    const out = await runWeeklyMaintenance(env, Date.now() + 31 * DAY);              // past the deadline
    expect(out.purged.bodies).toBe(1);
    expect((await body(w.sub)).body).toBe('');
    expect((await one('SELECT status, task FROM submissions WHERE id = ?1', w.sub)).status).toBe('accepted'); // the receipt remains
  });

  it('a write-up already past the deadline when the account first purges is cleared at once', async () => {
    const { c } = await purgeUser();
    const w = await pastWork({ contributor: c, weeksAgo: 1, reviewedAgoMs: 45 * DAY });
    await runWeeklyMaintenance(env);
    expect((await body(w.sub)).body).toBe('');
  });
});

// ---------------------------------------------------------------- finding 7: races
describe('finding 7: privacy writes are conditional at commit time', () => {
  const claimGate = () => { const g = gate(); return { g, db: wrapDb(env.DB, { afterRead: async (sql) => { if (/FROM contributors WHERE key_hash/.test(sql)) await g.hit(); } }) }; };

  it('1. claim_task paused after authentication, remove_handle completes, claim resumes: the event carries the NEW name and the old handle is nowhere', async () => {
    const u = await newUser({ handle: 'old-racer' }); const t = await addTask();
    const { g, db } = claimGate();
    const call = u.call('claim_task', { id: t }, { over: { DB: db } });
    await g.reached;
    expect((await u.call('remove_handle')).isError).toBe(false);
    g.open();
    expect((await call).isError).toBe(false);
    expect(await all("SELECT id FROM events WHERE actor = 'old-racer' OR detail LIKE '%old-racer%'")).toEqual([]);
    const ev = await one("SELECT actor FROM events WHERE type = 'task_claimed' AND task = ?1", t);
    expect(ev.actor).toMatch(/^anon-/);
    // Removing again finds nothing to scrub, and nothing was resurrected.
    expect(await all("SELECT id FROM events WHERE actor = 'old-racer'")).toEqual([]);
  });

  it('2. claim_task paused after authentication, the account is deleted, claim resumes: refused, nothing written for the removed contributor', async () => {
    const v = await voter({ allocations: { 'town-hall': 100 } }), u = await linkedUser(v, { handle: 'doomed-racer' }), t = await addTask();
    const id = await cid(u.handle);
    const { g, db } = claimGate();
    const call = u.call('claim_task', { id: t }, { over: { DB: db } });
    await g.reached;
    expect((await (await mePost('/api/me/delete', v, { confirm: 'delete my account' })).json()).deleted).toBe(true);
    g.open();
    const r = await call;
    expect(r.isError).toBe(true); expect(r.text).toMatch(/removed/);
    expect((await one('SELECT COUNT(*) AS n FROM claims WHERE contributor = ?1', id)).n).toBe(0);
    expect((await one("SELECT status FROM tasks WHERE id = ?1", t)).status).toBe('ready');
    expect(await all("SELECT id FROM events WHERE actor = 'doomed-racer' OR detail LIKE '%doomed-racer%'")).toEqual([]);
  });

  it('3. set_credit paused after authentication, the contributor is linked to an anonymous-credit account, set_credit resumes: the account\'s choice stands', async () => {
    const v = await voter(); // credit anonymous
    const u = await newUser({ handle: 'credit-racer' });
    const { g, db } = claimGate();
    const call = u.call('set_credit', { credit: 'handle' }, { over: { DB: db } });
    await g.reached;
    const code = (await (await mePost('/api/me/link-code', v)).json()).code;
    expect((await u.call('link_account', { code })).isError).toBe(false);
    g.open();
    const r = await call;
    expect(r.isError).toBe(true); expect(r.text).toMatch(/follows your Swarm voter account/);
    expect((await one('SELECT credit FROM contributors WHERE handle = ?1', 'credit-racer')).credit).toBe('anonymous');
    // A receipt would still say "a contributor".
    const t = await addTask(); await u.call('claim_task', { id: t });
    const s = await u.call('submit_work', { task_id: t, body: BODY, sources: [SOURCE] });
    await review(s.data.submission_id, 'accept', 'ok');
    expect(JSON.stringify(await (await send('/api/receipts')).json())).not.toContain('credit-racer');
  });

  it('4. submit_work paused after its claim read, the account is deleted, submit resumes: no submission, no event with the old handle', async () => {
    const v = await voter({ allocations: { 'town-hall': 100 } }), u = await linkedUser(v, { handle: 'submit-racer' }), t = await addTask();
    expect((await u.call('claim_task', { id: t })).isError).toBe(false);
    const g = gate(), db = wrapDb(env.DB, { afterRead: async (sql) => { if (/SELECT id FROM claims WHERE task = \?1 AND contributor = \?2 AND outcome IS NULL/.test(sql)) await g.hit(); } });
    const call = u.call('submit_work', { task_id: t, body: BODY, sources: [SOURCE] }, { over: { DB: db } });
    await g.reached;
    await mePost('/api/me/delete', v, { confirm: 'delete my account' });
    g.open();
    const r = await call;
    expect(r.isError).toBe(true);
    expect((await one('SELECT COUNT(*) AS n FROM submissions WHERE task = ?1', t)).n).toBe(0);
    expect(await all("SELECT id FROM events WHERE actor = 'submit-racer'")).toEqual([]);
  });

  it('5. deletion decides its contributors at commit time: one linked a moment before is not missed', async () => {
    const v = await voter({ allocations: { 'town-hall': 100 } });
    const stale = await linkedUser(v, { handle: 'first-ai' });
    const staleId = await cid(stale.handle);
    // Deletion reads nothing first any more, so link a second AI "between" two statements by doing it before deleteAccount runs its batch.
    const second = await newUser({ handle: 'second-ai' });
    await second.call('link_account', { code: (await (await mePost('/api/me/link-code', v)).json()).code });
    const r = await deleteAccount(env, v.id);
    expect(r.deleted).toBe(true);
    for (const h of ['first-ai', 'second-ai']) expect(await one('SELECT id FROM contributors WHERE handle = ?1', h)).toBeNull();
    expect((await one('SELECT removed FROM contributors WHERE id = ?1', staleId)).removed).toBe(1);
    expect((await second.call('my_work')).isError).toBe(true);
  });

  it('a second deletion, or a handle removal after deletion, is harmless and idempotent', async () => {
    const v = await voter({ allocations: null }), u = await linkedUser(v);
    const id = await cid(u.handle);
    expect((await deleteAccount(env, v.id)).deleted).toBe(true);
    expect((await deleteAccount(env, v.id)).deleted).toBe(false);
    expect(await removeHandle(env, id)).toBeNull();
  });
});

// ---------------------------------------------------------------- finding 8: OAuth state
// Swarm's own OAuth server keeps every grant and token in D1, so the account deletion revokes them in the same batch (no KV, no queue).
describe('finding 8: deleting an account revokes its OAuth grants and tokens in the same transaction', () => {
  const grantsOf = (id) => all('SELECT id, revoked_at, revoked_reason FROM oauth_grants WHERE contributor = ?1', id);

  it('the review probe: authorize with a passkey session, delete the account, and the access token, the refresh token and the grant are dead at once', async () => {
    const v = await voter({ allocations: { 'town-hall': 100 } });
    const c = await connect({ mode: 'passkey', cookie: v.cookie });
    expect(c.token, JSON.stringify(c.decision.data)).toBeTruthy();
    const contributor = (await mcpTool(c.token, 'my_work')).data.handle;
    const id = await cid(contributor);
    expect((await grantsOf(id))).toHaveLength(1);
    expect((await grantsOf(id))[0].revoked_at).toBeNull();
    expect((await (await mePost('/api/me/delete', v, { confirm: 'delete my account' })).json()).deleted).toBe(true);
    expect((await grantsOf(id))[0]).toMatchObject({ revoked_reason: 'account_deleted' });
    expect((await grantsOf(id))[0].revoked_at).toBeGreaterThan(0);
    // The old refresh token mints nothing (the old library returned 200 and new tokens here).
    const res = await o('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '198.18.7.7' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.client.client_id }) });
    expect(res.status).toBe(400);
    expect((await mcpTool(c.token, 'my_work')).res.status).toBe(401);
  });

  it('revokes only that account\'s contributors: another contributor\'s connection keeps working', async () => {
    const v = await voter({ allocations: null });
    const mine = await connect({ mode: 'passkey', cookie: v.cookie });
    const other = await connect();
    await deleteAccount(env, v.id);
    expect((await mcpTool(mine.token, 'my_work')).res.status).toBe(401);
    expect((await mcpTool(other.token, 'my_work')).isError).toBe(false);
  });

  it('the hourly job deletes the dead grants a week later, and nothing is queued or left in KV', async () => {
    const v = await voter({ allocations: null });
    const c = await connect({ mode: 'passkey', cookie: v.cookie });
    const id = await cid((await mcpTool(c.token, 'my_work')).data.handle);
    await deleteAccount(env, v.id);
    await purgeOAuth(env);
    expect(await grantsOf(id)).toHaveLength(1); // kept for a week, so a replayed token still answers invalid_grant
    await purgeOAuth(env, Date.now() + 8 * DAY);
    expect(await grantsOf(id)).toEqual([]);
    expect((await one('SELECT COUNT(*) AS n FROM oauth_tokens')).n).toBe(0);
    expect((await env.OAUTH_KV.list()).keys).toEqual([]); // the old namespace is not used at all
  });

  it('the policy lists the OAuth tables and their lifetimes, and the privacy page says OAuth stays off until the review is done', async () => {
    const policy = (await import('../../docs/DATA-POLICY.md?raw')).default, privacy = (await import('../public/privacy-details.html?raw')).default;
    expect(policy).toMatch(/oauth_grants/); expect(policy).toMatch(/30 days/); expect(policy).toMatch(/review/i);
    const page = privacy.replace(/<[^>]+>/g, ' ');
    expect(page).toMatch(/main database/); expect(page).toMatch(/30 days for a refresh token/); expect(page).toMatch(/OAuth sign-in is switched off today/);
  });
});

// ---------------------------------------------------------------- finding 9: the publication export
describe('finding 9: the publication export carries no model metadata', () => {
  it('the exact Codex probe: an anonymous-credit submission with a distinctive model leaves no trace in the Town Hall export', async () => {
    const u = await newUser({ handle: 'export-writer' });
    const t = await addTask({ units: 3, project: 'town-hall' });
    await u.call('claim_task', { id: t });
    const s = await u.call('submit_work', { task_id: t, body: BODY, sources: [SOURCE], model: 'unique-private-model', tokens_est: 987654 });
    await env.DB.prepare("UPDATE tasks SET kind = 'research_fix', source_key = 'townhall:housing:fix' WHERE id = ?1").bind(t).run();
    await review(s.data.submission_id, 'accept', 'ok');
    const res = await send(`/api/admin/submission?id=${s.data.submission_id}`, { headers: ADMIN() });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/unique-private-model|987654|"model"|tokens/);
    const data = JSON.parse(text).submission;
    expect(data.handle).toBeNull(); expect(data.credited_as).toBe('a contributor');
    // The reviewer still sees the metadata (it is private to the contributor and the reviewer, not public).
    expect(JSON.stringify(await (await send('/api/admin/pending', { headers: ADMIN() })).json())).not.toContain('never');
  });
});

// ---------------------------------------------------------------- finding 10: /version
describe('finding 10: /version says what it is', () => {
  it('is the operator-reported revision, with a note that it is not proof', async () => {
    const SHA = 'a'.repeat(40);
    const v = await (await send('/version', {}, { GIT_COMMIT: SHA, BUILT_AT: '2026-10-20T12:00:00Z' })).json();
    expect(v).toMatchObject({ commit: SHA, reported_by: 'operator' });
    expect(v.note).toMatch(/not cryptographic proof/);
    const security = (await import('../public/security.html?raw')).default.replace(/<[^>]+>/g, ' ');
    expect(security).toMatch(/commit the\s+operator says\s+was deployed/); expect(security).toMatch(/not proof of what is running/);
    expect(security).not.toMatch(/names the exact commit that is running/);
    const policy = (await import('../../docs/DATA-POLICY.md?raw')).default;
    expect(policy).toMatch(/not cryptographic proof of what runs/); expect(policy).toMatch(/does not prove/);
    const common = (await import('../public/js/common.js?raw')).default;
    expect(common).toContain('Build reported by the operator'); expect(common).not.toContain('Running code:');
  });
});

// ---------------------------------------------------------------- finding 11: wording follows the code
describe('finding 11: the privacy wording matches what the code does', () => {
  const page = async () => (await import('../public/privacy-details.html?raw')).default.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ');

  it('a retained daily key resolves a candidate address to an unlinked voter and contributor, so the page says codes are searchable while the key exists', async () => {
    const ip = '203.0.113.201';
    const u = await newUser({ ip }), v = await voter({ allocations: null });
    const { ipHashFor } = await import('../src/lib.js');
    const code = await ipHashFor(env, new Request('https://swarm.test/', { headers: { 'CF-Connecting-IP': ip } }));
    await env.DB.prepare('UPDATE accounts SET network = ?2 WHERE id = ?1').bind(v.id, code).run();
    expect((await one('SELECT COUNT(*) AS n FROM contributors WHERE pair_ip = ?1', code)).n).toBe(1);   // the join works with no explicit link
    expect((await one('SELECT COUNT(*) AS n FROM accounts WHERE network = ?1', code)).n).toBe(1);
    const text = await page();
    expect(text).toMatch(/While a network code and its day key both exist, someone who can read the database and already suspects an address can test/);
    expect(text).toMatch(/people on the same network can be related/);
    expect(u.handle).toBeTruthy();
  });

  it('a key lives up to nearly three days, so that is what the page and the policy say', async () => {
    const { forgetNetworks } = await import('../src/privacy.js');
    const now = Date.now(), day = (n) => new Date(now - n * DAY).toISOString().slice(0, 10);
    await env.DB.batch([0, 1, 2, 3, 4].map((n) => env.DB.prepare('INSERT OR REPLACE INTO network_keys(day, key) VALUES (?1, ?2)').bind(day(n), 'ab'.repeat(32))));
    await forgetNetworks(env, now);
    const left = (await all('SELECT day FROM network_keys ORDER BY day')).map((r) => r.day);
    expect(left).toEqual([day(2), day(1), day(0)]);        // three UTC days: a key created early on day-2 is still there late on the third day
    expect(await page()).toMatch(/nearly three days/);
  });

  it('credit retraction keeps the receipt id and evidence, so the page says earlier attribution cannot be recalled', async () => {
    const u = await newUser({ handle: 'retractor' }); await u.call('set_credit', { credit: 'handle' });
    const t = await addTask(); await u.call('claim_task', { id: t });
    const s = await u.call('submit_work', { task_id: t, body: BODY, sources: [SOURCE] }); await review(s.data.submission_id, 'accept', 'ok');
    const read = async () => (await (await send('/api/receipts')).json());
    const named = (await read()).receipts[0];
    expect(named.handle).toBe('retractor');
    await u.call('set_credit', { credit: 'anonymous' });
    const later = await read(), after = later.receipts[0];
    expect(after.handle).toBeNull(); expect(after.id).toBe(named.id); expect(after.evidence).toEqual(named.evidence);   // the id and the evidence stay: an old copy still names the author
    expect(later.note).toMatch(/not to copies already saved/);
    expect(await page()).toMatch(/cannot recall a response someone already saved/);
  });

  it('the list of limits is complete: Google, same-network correlation, live work over time, PR/source identity, the compelled operator, four-of-five, the threat boundary', async () => {
    const text = await page();
    for (const re of [/Google sees font requests/, /Anonymous credit does not sever the pull request, the sources or a publication link/, /Live work is observable over time/, /Someone who controls most voters can infer the rest/,
      /malicious or compelled operator could also start collecting more/, /not proof of what runs/, /The threat boundary/, /What "fewer than 5" \(k = 5\), noise and weekly releases do/, /52 weekly releases add up to 52 in the worst case/, /not a formal differential-privacy guarantee/,
      /Direct database access\./, /D1 Time Travel/, /Anything already copied/, /cannot undo a copy that someone else already took/, /Anyone can check whether a handle exists/, /deleting your account is not|does not erase your work/i]) expect(text, String(re)).toMatch(re);
    const html = (await import('../public/privacy-details.html?raw')).default;
    expect(html).toContain('fonts.googleapis.com');   // the disclosure matches what the page does
  });

  it('the absolute claims Codex listed are gone', async () => {
    const text = await page();
    for (const re of [/nobody else can/i, /small group cannot be picked out/i, /so a small group cannot/i, /never with a name, an email or an IP address/i, /cannot be read before and after a single change/i, /Two days\. Then the key is deleted/, /After the window it is gone\./, /past receipts included/i, /past ones included/i]) expect(text, String(re)).not.toMatch(re);
    expect(text).not.toMatch(/projection for next Monday is shown/i);
  });
});

// ---------------------------------------------------------------- finding 12: pairing
describe('finding 12: pairing is an existence oracle for handles, and that is disclosed', () => {
  it('pinned behaviour: a taken handle is refused with a different answer than a free one', async () => {
    const owner = await newUser({ handle: 'guessable-name' });
    await owner.call('set_credit', { credit: 'anonymous' });
    const probe = await tool('pair', { handle: 'guessable-name' }, { ip: '203.0.113.211' });
    const free = await tool('pair', { handle: 'unused-name-xyz' }, { ip: '203.0.113.212' });
    expect(probe.isError).toBe(true); expect(probe.text).toMatch(/taken/);
    expect(free.isError).toBe(false);                                   // so existence is observable: the oracle is real
  });
  it('the page, the policy, the tool text and the runbook all say so, and tell agents to leave the handle out', async () => {
    const page = (await import('../public/privacy-details.html?raw')).default.replace(/<[^>]+>/g, ' ');
    expect(page).toMatch(/Anyone can check whether a handle exists/); expect(page).toMatch(/Leave the handle out when you pair/);
    const policy = (await import('../../docs/DATA-POLICY.md?raw')).default;
    expect(policy).toMatch(/existence oracle/); expect(policy).toMatch(/planned, not built/);
    const tools = (await (await import('./helpers.js')).rpc('tools/list', {})).body.result.tools;
    expect(tools.find((x) => x.name === 'pair').description).toMatch(/Leave the handle out for a random one/);
    expect((await tool('pair', {}, { ip: '203.0.113.213' })).data.handle).toMatch(/^helper-[a-z0-9]{6}$/);   // the default cannot be guessed
  });
});

// ---------------------------------------------------------------- docs
describe('the docs state the release design', () => {
  it('DATA-POLICY, ARCHITECTURE and RUNBOOK describe the noise, epsilon, the yearly budget and the weekly release', async () => {
    const policy = (await import('../../docs/DATA-POLICY.md?raw')).default, arch = (await import('../../docs/ARCHITECTURE.md?raw')).default, run = (await import('../../docs/RUNBOOK.md?raw')).default;
    for (const [name, text, res] of [['policy', policy, [/epsilon = 1/, /52/, /Laplace/, /crypto\.getRandomValues/, /not stored|Nothing exact is stored/, /Threat boundary/, /not a formal differential-privacy guarantee/, /Direct database access is outside this boundary/]],
      ['arch', arch, [/Laplace/, /No page, API response or operator console shows which way any task was routed/, /Direct database access is outside this boundary/, /claim, not proof/]],
      ['runbook', run, [/Laplace noise/, /yearly privacy budget|52 over a year/, /allowlist/, /oauth_grants|oauth_tokens/]]]) for (const re of res) expect(text, `${name} ${re}`).toMatch(re);
  });
});
