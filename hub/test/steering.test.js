// Phase 4: routing origins, ballot steering, fallback, and the public comparison staying honest.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { weekStats } from '../src/core.js';
import { pickByDeficit } from '../src/steering.js';
import { BODY, SOURCE, addTask, newUser, resetDb, send } from './helpers.js';
import { linkedUser, mePost, publicAllocation, saveBallot, setupProjects, voter } from './voter.js';

beforeEach(async () => {
  await resetDb();
  await setupProjects();
  await publicAllocation({ 'town-hall': 5000, 'swarm-ai': 5000 });
});

const origins = async () => (await env.DB.prepare('SELECT routing_origin AS o, routed FROM claims ORDER BY id').all()).results;
const stats = async () => Object.fromEntries((await weekStats(env)).projects.map((p) => [p.id, p]));
async function fill(project, n, units = 1) { for (let i = 0; i < n; i++) await addTask({ project, units }); }
// One full cycle: ask for work, hand it in. Returns the claimed task.
async function cycle(user) {
  const r = await user.call('next_task');
  expect(r.isError, r.text).toBe(false);
  const s = await user.call('submit_work', { task_id: r.data.task.id, body: BODY, sources: [SOURCE] });
  expect(s.isError, s.text).toBe(false);
  return r.data;
}

describe('routing origins on claims', () => {
  it('next_task by the public split is public_routed, claim_task is self_picked, and routed stays consistent', async () => {
    await fill('town-hall', 3);
    const u = await newUser();
    const a = await u.call('next_task');
    expect(a.data.claim.routing_origin).toBe('public_routed');
    expect(a.data.counted_as).toMatch(/public-routed/);
    const t = await addTask({ project: 'town-hall' });
    const b = await u.call('claim_task', { id: t });
    expect(b.data.claim.routing_origin).toBe('self_picked');
    expect(b.data.counted_as).toMatch(/self-picked/);
    expect(await origins()).toEqual([{ o: 'public_routed', routed: 1 }, { o: 'self_picked', routed: 0 }]);
    const claimed = await env.DB.prepare("SELECT detail FROM events WHERE type = 'task_claimed' ORDER BY id").all();
    expect(claimed.results.map((r) => JSON.parse(r.detail).origin)).toEqual(['public_routed', 'self_picked']);
  });

  it('my_work lists each active claim with its routing origin', async () => {
    await fill('town-hall', 2);
    const u = await newUser();
    await u.call('next_task');
    expect((await u.call('my_work')).data.active_claims[0].routing_origin).toBe('public_routed');
  });
});

describe('steering by a ballot', () => {
  it('an 80/20 ballot converges to 80/20 over many claims, all recorded ballot_directed', async () => {
    await fill('town-hall', 30); await fill('swarm-ai', 30);
    const v = await voter({ allocations: { 'town-hall': 80, 'swarm-ai': 20 } });
    const u = await linkedUser(v);
    const picked = [];
    for (let i = 0; i < 20; i++) picked.push((await cycle(u)).task.project);
    const th = picked.filter((p) => p === 'town-hall').length;
    expect(th).toBe(16);
    expect(picked.length - th).toBe(4);
    const rows = await origins();
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.o === 'ballot_directed' && r.routed === 0)).toBe(true);
  });

  it('the weighted deficit itself converges on 80/20, 70/30 and 55/45 over hundreds of picks, with mixed unit sizes', () => {
    for (const [a, b] of [[0.8, 0.2], [0.7, 0.3], [0.55, 0.45]]) {
      const shares = { a, b }, units = { a: 0, b: 0 };
      let seed = 7;
      for (let i = 0; i < 600; i++) {
        seed = (seed * 48271) % 2147483647;
        const size = [1, 3, 8][seed % 3];
        const top = pickByDeficit([{ id: 'a' }, { id: 'b' }], shares, units)[0];
        units[top.p.id] += size;
      }
      expect(Math.abs(units.a / (units.a + units.b) - a)).toBeLessThan(0.02);
    }
  });

  it('the first claim goes to the ballot favourite and the answer says why', async () => {
    await fill('town-hall', 2); await fill('swarm-ai', 2);
    const u = await linkedUser(await voter({ allocations: { 'town-hall': 10, 'swarm-ai': 90 } }));
    const r = await u.call('next_task');
    expect(r.data.task.project).toBe('swarm-ai');
    expect(r.data.why).toMatch(/Your ballot steers this/);
    expect(r.data.counted_as).toMatch(/never moves the public allocation/);
  });

  it('counts only this contributor\'s own ballot-directed units, not other contributors\'', async () => {
    await fill('town-hall', 10); await fill('swarm-ai', 10);
    const a = await linkedUser(await voter({ allocations: { 'town-hall': 100 } }));
    const b = await linkedUser(await voter({ allocations: { 'town-hall': 60, 'swarm-ai': 40 } }));
    for (let i = 0; i < 4; i++) await cycle(a); // four Town Hall units directed by a's ballot
    // Counted over everyone's units Town Hall would already be at 100% and b would be sent to Swarm AI; counted over b's own, b starts fresh.
    expect((await b.call('next_task')).data.task.project).toBe('town-hall');
  });

  it('a ballot that names an inactive project is rescaled over the active ones', async () => {
    await fill('town-hall', 3);
    await env.DB.prepare("UPDATE projects SET active = 0 WHERE id = 'swarm-ai'").run();
    const u = await linkedUser(await voter({ allocations: { 'town-hall': 20, 'swarm-ai': 80 } }));
    const r = await u.call('next_task');
    expect(r.data.task.project).toBe('town-hall');
    expect(r.data.claim.routing_origin).toBe('ballot_directed');
  });
});

describe('fallback', () => {
  it('falls back to the public split when none of the ballot\'s projects has work, and records public_routed', async () => {
    await fill('town-hall', 3); // swarm-ai (the whole ballot) has nothing
    const v = await voter({ allocations: { 'swarm-ai': 100 } });
    const u = await linkedUser(v);
    const r = await u.call('next_task');
    expect(r.isError, r.text).toBe(false);
    expect(r.data.task.project).toBe('town-hall');
    expect(r.data.claim.routing_origin).toBe('public_routed');
    expect(r.data.steering.fell_back_to_public).toBe(true);
    expect(r.data.steering.note).toMatch(/recorded as public-routed/);
    expect((await stats())['town-hall'].routed_units).toBe(1); // honest: the public comparison sees it
    expect((await stats())['town-hall'].ballot_directed_units).toBe(0);
  });

  it('with fallback off, says there is no eligible work in your projects and routes nothing', async () => {
    await fill('town-hall', 3);
    const v = await voter({ allocations: { 'swarm-ai': 100 } });
    const u = await linkedUser(v);
    expect((await (await mePost('/api/me/fallback', v, { enabled: false })).json()).fallback).toBe(false);
    const r = await u.call('next_task');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/No eligible work in your projects/);
    expect(r.text).toMatch(/swarm-ai|Swarm AI: no ready tasks/i);
    expect(await origins()).toEqual([]);
    // Switching it back on restores the fallback.
    await mePost('/api/me/fallback', v, { enabled: true });
    expect((await u.call('next_task')).data.claim.routing_origin).toBe('public_routed');
  });

  it('a paused ballot project or a full reviewer queue also counts as no eligible work', async () => {
    await fill('town-hall', 2); await fill('swarm-ai', 2);
    const v = await voter({ allocations: { 'swarm-ai': 100 } });
    const u = await linkedUser(v);
    await env.DB.prepare("UPDATE projects SET paused = 1 WHERE id = 'swarm-ai'").run();
    await mePost('/api/me/fallback', v, { enabled: false });
    const r = await u.call('next_task');
    expect(r.text).toMatch(/swarm-ai|Swarm AI: paused by operator/i);
    expect(r.isError).toBe(true);
  });

  it('a ballot with work again goes back to ballot-directed after a fallback', async () => {
    await fill('town-hall', 3);
    const u = await linkedUser(await voter({ allocations: { 'swarm-ai': 100 } }));
    expect((await u.call('next_task')).data.claim.routing_origin).toBe('public_routed');
    await fill('swarm-ai', 2);
    const r = await u.call('next_task');
    expect(r.data.task.project).toBe('swarm-ai');
    expect(r.data.claim.routing_origin).toBe('ballot_directed');
  });
});

describe('the public comparison stays honest', () => {
  it('a big ballot-directed contributor never moves the public routed numbers', async () => {
    await fill('town-hall', 30); await fill('swarm-ai', 30);
    // Two unlinked contributors take public work first.
    const p1 = await newUser(), p2 = await newUser();
    for (const p of [p1, p2]) { await cycle(p); await cycle(p); }
    const before = await stats();
    const big = await linkedUser(await voter({ allocations: { 'town-hall': 100 } }));
    for (let i = 0; i < 18; i++) await cycle(big);
    const after = await stats();
    for (const id of ['town-hall', 'swarm-ai']) {
      expect(after[id].routed_units, id).toBe(before[id].routed_units);
      expect(after[id].routed_share, id).toBe(before[id].routed_share);
    }
    expect(after['town-hall'].ballot_directed_units).toBe(18);
    expect(after['swarm-ai'].ballot_directed_units).toBe(0);
    expect(after['town-hall'].self_directed_units).toBe(0);
    const s = await (await send('/api/stats')).json();
    expect(s.routing_origins.units.ballot_directed).toBe(18);
    expect(s.routing_origins.units.public_routed).toBe(before['town-hall'].routed_units + before['swarm-ai'].routed_units);
    expect(s.routing_origins.units.self_picked).toBe(0);
  });

  it('unlinked contributors, and linked ones with no ballot, follow the public split', async () => {
    await publicAllocation({ 'town-hall': 7000, 'swarm-ai': 3000 });
    await fill('town-hall', 40); await fill('swarm-ai', 40);
    const users = [await newUser(), await newUser(), await linkedUser(await voter({ allocations: null }))];
    const picked = [];
    for (let i = 0; i < 30; i++) picked.push((await cycle(users[i % 3])).task.project);
    const th = picked.filter((p) => p === 'town-hall').length;
    expect(Math.abs(th / picked.length - 0.7)).toBeLessThan(0.05);
    expect((await origins()).every((r) => r.o === 'public_routed')).toBe(true);
  });

  it('a suspended account stops steering: its contributor follows the public split', async () => {
    await fill('town-hall', 3); await fill('swarm-ai', 3);
    const v = await voter({ allocations: { 'swarm-ai': 100 } });
    const u = await linkedUser(v);
    await env.DB.prepare('UPDATE accounts SET suspended = 1 WHERE id = ?1').bind(v.id).run();
    expect((await u.call('next_task')).data.claim.routing_origin).toBe('public_routed');
  });

  it('self-picked and ballot-directed units are shown apart in /api/stats and never added to routed', async () => {
    await fill('town-hall', 6);
    const u = await linkedUser(await voter({ allocations: { 'town-hall': 100 } }));
    await u.call('next_task');
    const t = await addTask({ project: 'town-hall', units: 3 });
    await u.call('claim_task', { id: t });
    const th = (await (await send('/api/stats')).json()).projects.find((p) => p.id === 'town-hall');
    expect(th.routed_units).toBe(0);
    expect(th.ballot_directed_units).toBe(1);
    expect(th.self_directed_units).toBe(3);
  });

  it('a ballot saved later changes the steering without relinking', async () => {
    await fill('town-hall', 4); await fill('swarm-ai', 4);
    const v = await voter({ allocations: { 'town-hall': 100 } });
    const u = await linkedUser(v);
    expect((await u.call('next_task')).data.task.project).toBe('town-hall');
    await saveBallot(v, { 'swarm-ai': 100 });
    expect((await u.call('next_task')).data.task.project).toBe('swarm-ai');
  });
});
