// Regression tests for Codex review 6 (docs: cybersecurity/house/audits/2026-10-20-swarm-ai-codex-review-6.md). Each one attacks and has to fail.
// Findings A (populated upgrades) is in migration-0011.test.js, H (bulk secrets) and the preflight in deploy.node.js, F and G in dp.test.js.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { ADMIN, BODY, SOURCE, addTask, newUser, resetDb, review, send, tool } from './helpers.js';
import { accessFixture } from './access-helpers.js';
import { weekOf, weekStartMs } from '../src/lib.js';
import { rollupWeek, weekAggregates } from '../src/rollup.js';
import { NO_NOISE, linkedUser, publicAllocation, saveBallot, setupProjects, voter } from './voter.js';

const WEEK = 7 * 86400000;
const all = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then((r) => r.results);

beforeEach(async () => { await resetDb(); await setupProjects(); await publicAllocation({ 'town-hall': 5000, 'swarm-ai': 5000 }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// ---------------------------------------------------------------- B: two worlds that differ only in how one task was routed
// The same people do the same things at the same moments. The ONLY difference is whether Alice's AI got her task from the public allocation
// (public_routed), from her own ballot (ballot_directed) or by picking it (self_picked). Every public response, every operator response and
// every other contributor's view must be identical.
async function freshWorld() {
  startEvent = (await env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM events').first()).m;
  await resetDb(); await setupProjects(); await publicAllocation({ 'town-hall': 5000, 'swarm-ai': 5000 });
  await env.DB.batch([env.DB.prepare("DELETE FROM sqlite_sequence WHERE name IN ('tasks', 'claims', 'submissions', 'contributors')"),
    env.DB.prepare('DELETE FROM weekly_project_stats'), env.DB.prepare('DELETE FROM rollup_weeks')]);
}
let startEvent = 0; // events are append-only, so a later world still sees the earlier worlds' events: only this world's are compared
function normalise(text) {
  // Event ids keep growing across worlds (events are append-only), so number this world's events by position instead.
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j?.events)) { j.events = j.events.filter((e) => e.id > startEvent).map((e, i) => ({ ...e, id: i })); j.next_before = null; text = JSON.stringify(j); }
  } catch { /* not JSON */ }
  return text.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T').replace(/\b1\d{12}\b/g, 'N').replace(/"(age_ms|oldest_review_age_ms)":\d+/g, '"$1":0')
    .replace(/"(source_key|brief)":"[^"]*"/g, '"$1":"-"').replace(/test:\d+:\d+/g, 'test:-');
}
async function world(route) {
  await freshWorld();
  const v = await voter({ allocations: null });
  const alice = await linkedUser(v, { handle: 'alice-ai', ip: '203.0.113.70' }), bob = await newUser({ handle: 'bob-ai', ip: '203.0.113.71' }), eve = await newUser({ handle: 'eve-ai', ip: '203.0.113.72' });
  const A = await addTask({ units: 3, title: 'Task A' }), B = await addTask({ units: 1, title: 'Task B' }), C = await addTask({ units: 8, title: 'Task C' });
  if (route === 'ballot_directed') await saveBallot(v, { 'town-hall': 100 });
  const got = route === 'self_picked' ? await alice.call('claim_task', { id: A }) : await alice.call('next_task');
  expect(got.isError, got.text).toBe(false);
  expect(got.data.task.id).toBe(A);
  expect((await all('SELECT routing_origin AS o FROM claims WHERE task = ?1', A))[0].o).toBe(route);
  await alice.call('submit_work', { task_id: A, body: BODY, sources: [SOURCE] });
  // Alice's AI takes a second task the same way and HOLDS it while everything is read; Bob holds Task C through the public allocation.
  const got2 = route === 'self_picked' ? await alice.call('claim_task', { id: B }) : await alice.call('next_task');
  expect(got2.data.task.id).toBe(B);
  expect((await bob.call('next_task')).data.task.id).toBe(C);
  const refusal = (await eve.call('claim_task', { id: B })).text; // the mutation oracle: a task claimed by Alice, by whichever route
  const sub = (await all('SELECT id FROM submissions'))[0].id;
  await review(sub, 'accept', 'ok');
  await rollupWeek(env, weekOf(), Date.now(), NO_NOISE);
  const a = await accessFixture();
  const get = async (p) => normalise(await (await send(p)).text());
  const mcp = async (name, args, who) => normalise(JSON.stringify((await (who ? who.call(name, args) : tool(name, args))).data));
  const ops = [];
  for (const p of ['overview', 'pending', 'held', 'projects']) ops.push(normalise(await (await a.get(p)).text()));
  let before = null;
  do { const page = await (await a.get(`audit${before ? `?before=${before}` : ''}`)).json(); ops.push(normalise(JSON.stringify(page))); before = page.next_before; } while (before);
  vi.unstubAllGlobals();
  const admin = [];
  for (const p of ['pending', 'held']) admin.push(normalise(await (await send(`/api/admin/${p}`, { headers: ADMIN() })).text()));
  admin.push(normalise(await (await send(`/api/admin/submission?id=${sub}`, { headers: ADMIN() })).text()));
  return {
    refusal,
    public: [await get('/api/stats'), await get('/api/tasks?limit=200'), await get('/api/tasks?status=claimed'), await get('/api/tasks?status=ready'), await get('/api/tasks?status=submitted'),
      await get(`/api/tasks/${A}`), await get(`/api/tasks/${B}`), await get(`/api/tasks/${C}`), await get('/api/receipts'), await get('/api/analytics'), await get('/api/vote/current'), await get('/api/vote/audit'),
      await get('/api/transparency'), await mcp('list_projects', {}), await mcp('list_tasks', {}), await mcp('list_tasks', { status: 'claimed' }), await mcp('get_task', { id: A }), await mcp('get_task', { id: B })],
    others: [await mcp('my_work', {}, bob), await mcp('my_week', {}, bob), await mcp('my_work', {}, eve), await mcp('submission_status', { submission_id: sub }, bob)],
    ops, admin,
  };
}

describe('finding B: nothing public or operator-facing separates personal steering from public routing', () => {
  it('three worlds that differ ONLY in the routing origin of one task give identical public, operator, admin and other-contributor responses', async () => {
    const worlds = {};
    for (const route of ['public_routed', 'ballot_directed', 'self_picked']) worlds[route] = await world(route);
    const base = worlds.public_routed;
    // The attack: if any response carried the route, one of these would differ. They are non-trivial (they contain the task, its claim and its receipt).
    expect(base.public.join('\n')).toContain('Task A');
    expect(base.ops.join('\n')).toContain('task_claimed');
    expect(base.public.length).toBeGreaterThan(15); expect(base.ops.length).toBeGreaterThanOrEqual(5);
    for (const route of ['ballot_directed', 'self_picked']) {
      expect(worlds[route].refusal, `${route} refusal`).toBe(base.refusal);
      base.public.forEach((body, i) => expect(worlds[route].public[i], `${route} public[${i}]`).toBe(body));
      base.others.forEach((body, i) => expect(worlds[route].others[i], `${route} others[${i}]`).toBe(body));
      base.ops.forEach((body, i) => expect(worlds[route].ops[i], `${route} ops[${i}]`).toBe(body));
      base.admin.forEach((body, i) => expect(worlds[route].admin[i], `${route} admin[${i}]`).toBe(body));
    }
  });

  it('the comparison can fail: a world where one more task was claimed (or one unit was added) is detected, so identical is not vacuous', async () => {
    const base = await world('public_routed');
    await freshWorld();
    // Same as the base world but Alice also holds Task C: the open-task view and the operator's active claims must differ.
    const v = await voter({ allocations: null });
    const alice = await linkedUser(v, { handle: 'alice-ai', ip: '203.0.113.70' });
    await addTask({ units: 3, title: 'Task A' });
    await alice.call('next_task');
    const a = await accessFixture();
    const overview = normalise(await (await a.get('overview')).text());
    expect(overview).not.toBe(base.ops[0]);
  });

  it('the Codex joins fail one by one: no routed figure, no personal-only status transition, no refusal that differs, no origin in an operator event', async () => {
    const A = await addTask({ units: 3 });
    const v = await voter({ allocations: { 'town-hall': 100 } });
    const alice = await linkedUser(v, { handle: 'alice-ai', ip: '203.0.113.70' }), eve = await newUser({ ip: '203.0.113.72' });
    const stats = async () => (await (await send('/api/stats')).json()).projects.find((p) => p.id === 'town-hall');
    const before = JSON.stringify(await stats());
    await alice.call('next_task');
    // 1. Passive observer: public-routed units stay "zero" in both directions because there is no such number at all.
    expect(JSON.stringify(await stats())).toBe(before);
    expect(Object.keys(await stats()).filter((k) => /routed|claimed|self|directed/.test(k))).toEqual([]);
    expect((await (await send('/api/tasks/' + A)).json()).status).toBe('ready');
    // 2. Self-registered observer's mutation oracle: the refusal for a ballot-steered task reads exactly like the one for a public-routed task.
    const steered = (await eve.call('claim_task', { id: A })).text;
    await alice.call('release_task', { id: A });
    const bob = await newUser({ ip: '203.0.113.73' }); await bob.call('claim_task', { id: A });
    expect((await eve.call('claim_task', { id: A })).text).toBe(steered);
    // 3. Console-only operator: the overview before and after a lone claim carries no routing field, and the events carry no origin.
    const a = await accessFixture();
    const overview = await (await a.get('overview')).json();
    expect(Object.keys(overview).filter((k) => /routed|origin|closed_week|personal/.test(k))).toEqual([]);
    const audit = await (await a.get('audit')).json();
    expect(JSON.stringify(audit.events)).not.toMatch(/origin|routed|ballot_directed|self_picked|public_routed/);
    // The database itself still holds the origin (for the scheduler's deficit maths), and the docs say so.
    expect((await all('SELECT routing_origin AS o FROM claims ORDER BY id')).map((r) => r.o)).toContain('ballot_directed');
  });

  it('the claim event written to the audit log carries only the claim id, whatever the route', async () => {
    const t1 = await addTask(), t2 = await addTask();
    const v = await voter({ allocations: { 'town-hall': 100 } });
    const alice = await linkedUser(v, { handle: 'alice-ai' }), bob = await newUser();
    await alice.call('next_task'); await bob.call('claim_task', { id: t2 });
    const rows = await all("SELECT detail FROM events WHERE type = 'task_claimed' ORDER BY id DESC LIMIT 2");
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(Object.keys(JSON.parse(r.detail))).toEqual(['claim']);
    expect(t1).toBeTruthy();
  });

  it('next_task tells its own caller nothing about other people\'s routing (no public routed share in the explanation)', async () => {
    await addTask({ units: 3 }); await addTask({ units: 3 }); await addTask({ units: 3 });
    const u1 = await newUser(), u2 = await newUser();
    const first = await u1.call('next_task'), second = await u2.call('next_task');
    for (const r of [first, second]) { expect(r.data.why).not.toMatch(/routed so far|\d+(\.\d+)?%\s*(routed|so far)/); expect(r.data.why).toMatch(/target/); }
    expect(first.data.why).toBe(second.data.why); // the second caller cannot read the first caller's claim off the explanation
  });
});

// ---------------------------------------------------------------- C: the person is the owning account
async function pastClaim(contributor, { weeksAgo = 1, units = 1, project = 'town-hall' } = {}) {
  const start = weekStartMs() - weeksAgo * WEEK, task = await addTask({ units, project, status: 'submitted' }), at = start + 1000;
  await env.DB.prepare(`INSERT INTO claims (task, contributor, routed, week, claimed_at, expires_at, outcome, network, routing_origin) VALUES (?1, ?2, 0, ?3, ?4, ?5, 'submitted', 'nethash', 'self_picked')`)
    .bind(task, contributor, weekOf(start), at, at + 10800000).run();
}
describe('finding C: the 5-person gate counts accounts that own contributors, not current links', () => {
  const cid = async (u) => (await env.DB.prepare('SELECT id FROM contributors WHERE handle = ?1').bind(u.handle).first()).id;
  const people = async () => (await weekAggregates(env, weekOf(weekStartMs() - WEEK))).find((p) => p.project === 'town-hall')?.contributors;

  it('five contributors owned by ONE account are one person, however many of them are linked, relinked or unlinked', async () => {
    const v = await voter({ allocations: null });
    const ids = [];
    for (let i = 0; i < 5; i++) { const u = await newUser({ ip: `203.0.113.${100 + i}` }); ids.push(await cid(u)); await pastClaim(ids[i]); }
    await env.DB.batch(ids.map((id) => env.DB.prepare('UPDATE contributors SET owner_account = ?2 WHERE id = ?1').bind(id, v.id)));
    expect(await people()).toBe(1);
    // Only the last one is linked (the review's setup), then none, then another: the count is the same.
    await env.DB.prepare('INSERT INTO account_links(account, contributor, linked_at, via) VALUES (?1, ?2, ?3, \'code\')').bind(v.id, ids[4], Date.now()).run();
    expect(await people()).toBe(1);
    await env.DB.prepare('DELETE FROM account_links').run();
    expect(await people()).toBe(1);
    // Published through the real route: "fewer than 5", not "5-9".
    await rollupWeek(env, weekOf(weekStartMs() - WEEK), Date.now(), NO_NOISE);
    const w = (await (await send('/api/analytics')).json()).weeks[0];
    expect(w.projects.find((p) => p.project === 'town-hall').contributors).toBe('fewer than 5');
  });

  it('four accounts across five contributor ids are four people (no release); five accounts, or five unowned contributors, are five', async () => {
    const owners = [await voter({ allocations: null }), await voter({ allocations: null }), await voter({ allocations: null }), await voter({ allocations: null })];
    const ids = [];
    for (let i = 0; i < 5; i++) { const u = await newUser({ ip: `203.0.113.${120 + i}` }); ids.push(await cid(u)); await pastClaim(ids[i]); }
    await env.DB.batch(ids.map((id, i) => env.DB.prepare('UPDATE contributors SET owner_account = ?2 WHERE id = ?1').bind(id, owners[Math.min(i, 3)].id)));
    expect(await people()).toBe(4);
    await rollupWeek(env, weekOf(weekStartMs() - WEEK), Date.now(), NO_NOISE);
    expect((await (await send('/api/analytics')).json()).weeks[0].projects[0].contributors).toBe('fewer than 5');
    await env.DB.batch([env.DB.prepare('DELETE FROM weekly_project_stats'), env.DB.prepare('DELETE FROM rollup_weeks')]);
    // A fifth distinct account (a sixth contributor id): now five people.
    const fifth = await voter({ allocations: null }), extra = await cid(await newUser({ ip: '203.0.113.130' }));
    await pastClaim(extra);
    await env.DB.prepare('UPDATE contributors SET owner_account = ?2 WHERE id = ?1').bind(extra, fifth.id).run();
    expect(await people()).toBe(5);
    await rollupWeek(env, weekOf(weekStartMs() - WEEK), Date.now(), NO_NOISE);
    expect((await (await send('/api/analytics')).json()).weeks[0].projects[0].contributors).toBe('5-9');
  });

  it('unowned contributors are one person each, and a deleted account\'s contributor is not counted at all', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) { const u = await newUser({ ip: `203.0.113.${140 + i}` }); ids.push(await cid(u)); await pastClaim(ids[i]); }
    expect(await people()).toBe(5);
    await env.DB.prepare('UPDATE contributors SET removed = 1 WHERE id = ?1').bind(ids[0]).run();
    expect(await people()).toBe(4);
  });
});

// ---------------------------------------------------------------- the pages and docs say exactly what the code does
describe('review 6: pages and docs match the code', () => {
  const strip = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');
  const load = async () => ({
    privacy: strip((await import('../public/privacy.html?raw')).default), security: strip((await import('../public/security.html?raw')).default),
    transparency: strip((await import('../public/transparency.html?raw')).default), live: strip((await import('../public/live.html?raw')).default),
    policy: (await import('../../docs/DATA-POLICY.md?raw')).default, arch: (await import('../../docs/ARCHITECTURE.md?raw')).default, run: (await import('../../docs/RUNBOOK.md?raw')).default,
  });

  it('nothing claims formal differential privacy, an advanced-composition figure or an epsilon budget; the personal-direction release is gone from every page and doc', async () => {
    const docs = await load();
    for (const [name, text] of Object.entries(docs)) {
      expect(text, name).not.toMatch(/advanced composition at delta|roughly 25\b|about 7\.2|epsilon-differentially private|privacy budget (is|of)|personal-direction total in|personally directed work, with noise/i);
      expect(text, name).not.toMatch(/weekly_release[^.]*(Public record|written once)/);
    }
    expect(docs.privacy).toMatch(/not a formal differential-privacy guarantee across all releases/);
    expect(docs.policy).toMatch(/not a formal differential-privacy guarantee for the release as a whole/);
    expect(docs.run).toMatch(/not a formal differential-privacy guarantee/);
    expect(docs.arch).toMatch(/not a formal differential-privacy guarantee for the whole release/);
  });

  it('/privacy says the weekly check is coarser by design, and that the database holds the origin and the operator could read it', async () => {
    const { privacy, policy, transparency, run } = await load();
    expect(privacy).toMatch(/all routes added together/); expect(privacy).toMatch(/That check is coarser by design/);
    expect(privacy).toMatch(/The database itself holds how each claim was routed/); expect(privacy).toMatch(/The operator, with direct database access, could read it/);
    expect(policy).toMatch(/The database holds it next to the contributor, and the operator, with direct database access, could read it/);
    expect(transparency).toMatch(/how each was routed/); expect(run).toMatch(/holds `routing_origin` next to the contributor/);
    expect(privacy).not.toMatch(/Ballot-directed and self-picked work are not told apart, and nobody is named/);
  });

  it('the live page, the console page and the vote page show no routed figure', async () => {
    const { live } = await load();
    expect(live).not.toMatch(/Public-routed units, this week|Routed share, this week|Where the live numbers stand/i);
    for (const file of ['../public/js/live.js', '../public/js/home.js', '../public/js/common.js', '../public/ops/ops.js']) {
      const src = (await import(/* @vite-ignore */ file + '?raw')).default;
      expect(src, file).not.toMatch(/routed_units|routed_share|routed_by_origin|closed_week_release|gap_reason|personal_direction/);
    }
  });

  it('the maintenance allowlist in the docs and in the script agree: no secret bulk, and the preflight is described', async () => {
    const { policy, run, arch } = await load();
    const script = (await import('../scripts/deploy.sh?raw')).default;
    expect(script).not.toMatch(/"secret bulk/);
    expect(policy).toMatch(/`secret bulk` is not allowed/); expect(arch).toMatch(/`secret bulk` is not on it/);
    for (const text of [policy, run, arch]) expect(text).toMatch(/preflight/);
    expect(run).toMatch(/Production is expected to print 0/);
  });

  it('the API notes say what the code does: the vote notes make no formal claim, the analytics note says the check is coarse', async () => {
    const audit = await (await send('/api/vote/audit')).json(), analytics = await (await send('/api/analytics')).json();
    expect(JSON.stringify(audit)).toMatch(/not a formal differential-privacy guarantee/); expect(JSON.stringify(audit)).not.toMatch(/epsilon budget|advanced/i);
    expect(analytics.note).toMatch(/all routes added together/i); expect(analytics.note).toMatch(/coarse by design/);
  });
});
