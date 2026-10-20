// "Your Swarm": the /api/me data, the fallback setting, and the my_week tool that returns the same summary.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { BODY, SOURCE, addTask, newUser, resetDb, review, send, tool } from './helpers.js';
import { linkedUser, mePost, meGet, newCode, publicAllocation, setupProjects, voter } from './voter.js';

beforeEach(async () => {
  await resetDb();
  await setupProjects();
  await publicAllocation({ 'town-hall': 5000, 'swarm-ai': 5000 });
});

async function work(user, { units = 3, project = 'town-hall', model, tokens_est, claimOnly = false, self = false } = {}) {
  const t = await addTask({ project, units });
  const claimed = self ? await user.call('claim_task', { id: t }) : await user.call('next_task');
  expect(claimed.isError, claimed.text).toBe(false);
  if (claimOnly) return { task: claimed.data.task.id };
  const s = await user.call('submit_work', { task_id: claimed.data.task.id, body: BODY, sources: [SOURCE], ...(model ? { model } : {}), ...(tokens_est !== undefined ? { tokens_est } : {}) });
  expect(s.isError, s.text).toBe(false);
  return { task: claimed.data.task.id, submission: s.data.submission_id };
}

describe('GET /api/me', () => {
  it('says signed out, with nothing else, when there is no session', async () => {
    expect(await (await meGet(null)).json()).toEqual({ signed_in: false });
    const res = await send('/api/me', { headers: { Cookie: 'swarm_sid=' + 'a'.repeat(43) } });
    expect(await res.json()).toEqual({ signed_in: false });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect((await send('/api/me', { method: 'POST' })).status).toBe(405);
    expect((await send('/api/me/nothing')).status).toBe(404);
  });

  it('shows the ballot, the fallback setting and no link for a voter with no linked AI', async () => {
    const v = await voter({ allocations: { 'town-hall': 70, 'swarm-ai': 30 } });
    const me = await (await meGet(v)).json();
    expect(me.signed_in).toBe(true);
    expect(me.account_id_short).toBe(v.id.slice(0, 8));
    expect(me.fallback).toBe(true);
    expect(me.linked).toBeNull();
    expect(me.week).toBeNull();
    expect(me.ballot.version).toBe(1);
    expect(me.ballot.steers).toBe(true);
    expect(me.ballot.points).toEqual(expect.arrayContaining([{ project: 'town-hall', name: 'Town Hall', points: 70, active: true }, { project: 'swarm-ai', name: 'Swarm AI', points: 30, active: true }]));
    expect(JSON.stringify(me)).not.toContain(v.id + '"');
  });

  it('has no ballot when none was saved', async () => {
    const v = await voter({ allocations: null });
    const me = await (await meGet(v)).json();
    expect(me.ballot).toBeNull();
  });

  it('splits claimed, submitted, awaiting review and accepted by routing origin, and never shows pending as accepted', async () => {
    await publicAllocation({ 'town-hall': 10000 });
    const v = await voter({ allocations: { 'town-hall': 100 } });
    const u = await linkedUser(v);
    const a = await work(u, { units: 3, model: 'a-model', tokens_est: 1200 });   // ballot-directed, will be accepted
    const b = await work(u, { units: 1, tokens_est: 300 });                       // ballot-directed, stays pending
    await work(u, { units: 8, self: true });                                      // self-picked, pending
    const held = await work(await newUser(), { units: 3 });                       // someone else's public-routed work
    expect(held.task).toBeGreaterThan(0);
    expect((await (await review(a.submission, 'accept', 'Good work.')).json()).ok).toBe(true);

    const me = await (await meGet(v)).json();
    const o = me.week.by_origin;
    expect(o.ballot_directed.claimed).toEqual({ tasks: 2, units: 4 });
    expect(o.ballot_directed.submitted).toEqual({ tasks: 2, units: 4 });
    expect(o.ballot_directed.accepted).toEqual({ tasks: 1, units: 3 });
    expect(o.ballot_directed.awaiting_review).toEqual({ tasks: 1, units: 1 });
    expect(o.ballot_directed.rejected).toEqual({ tasks: 0, units: 0 });
    expect(o.self_picked.claimed).toEqual({ tasks: 1, units: 8 });
    expect(o.self_picked.accepted).toEqual({ tasks: 0, units: 0 });
    expect(o.self_picked.awaiting_review).toEqual({ tasks: 1, units: 8 });
    expect(o.public_routed.claimed).toEqual({ tasks: 0, units: 0 }); // the other contributor's work is not mine
    expect(me.week.per_project).toHaveLength(1);
    expect(me.week.per_project[0]).toMatchObject({ project: 'town-hall', accepted_units: 3, units: { ballot_directed: 4, self_picked: 8, public_routed: 0 }, ballot_directed_share_pct: 100 });
    // Receipts: only what a reviewer accepted, with the self-reported fields labelled.
    expect(me.week.receipts).toHaveLength(1);
    expect(me.week.receipts[0]).toMatchObject({ id: a.submission, routing_origin: 'ballot_directed', evidence_url: `/api/tasks/${a.task}`, self_reported: { model: 'a-model', tokens_est: 1200 } });
    expect(JSON.stringify(me.week.receipts)).not.toContain(String(b.submission) + ',');
    // Token estimates are labelled as estimates.
    expect(me.week.self_reported_tokens_est).toMatchObject({ total: 1500, submissions_reporting: 2, submissions_this_week: 3 });
    expect(me.week.self_reported_tokens_est.note).toMatch(/Estimates your AI reported itself/);
    expect(me.week.notes.join(' ')).toMatch(/pending work is never shown as accepted/);
    expect(me.week.notice).toMatch(/data|untrusted/i);
    expect(me.linked.handle).toBe(u.handle);
  });

  it('counts a task once however often it was claimed and released, and reports released work apart', async () => {
    const v = await voter({ allocations: { 'town-hall': 100 } });
    const u = await linkedUser(v);
    const t = await addTask({ project: 'town-hall', units: 3 });
    for (let i = 0; i < 2; i++) { await u.call('next_task'); await u.call('release_task', { id: t }); }
    let me = await (await meGet(v)).json();
    expect(me.week.by_origin.ballot_directed.claimed).toEqual({ tasks: 0, units: 0 });
    expect(me.week.released_or_expired.ballot_directed).toEqual({ tasks: 1, units: 3 });
    await u.call('next_task');
    me = await (await meGet(v)).json();
    expect(me.week.by_origin.ballot_directed.claimed).toEqual({ tasks: 1, units: 3 });
    expect(me.week.by_origin.ballot_directed.in_progress).toEqual({ tasks: 1, units: 3 });
    expect(me.week.released_or_expired.ballot_directed).toEqual({ tasks: 0, units: 0 });
  });

  it('never shows another voter\'s link, ballot or week', async () => {
    const a = await voter({ allocations: { 'town-hall': 100 } }), b = await voter({ allocations: { 'swarm-ai': 100 } });
    const ua = await linkedUser(a);
    await work(ua);
    const meB = await (await meGet(b)).json();
    expect(meB.linked).toBeNull();
    expect(meB.week).toBeNull();
    expect(meB.ballot.points.find((p) => p.project === 'swarm-ai').points).toBe(100);
    expect(JSON.stringify(meB)).not.toContain(ua.handle);
  });

  it('keeps a ballot point for a project that is no longer active, marked inactive', async () => {
    const v = await voter({ allocations: { 'town-hall': 50, 'swarm-ai': 50 } });
    await env.DB.prepare("UPDATE projects SET active = 0 WHERE id = 'swarm-ai'").run();
    const me = await (await meGet(v)).json();
    expect(me.ballot.points.find((p) => p.project === 'swarm-ai')).toMatchObject({ points: 50, active: false });
    expect(me.ballot.steers).toBe(true);
  });
});

describe('POST /api/me/fallback', () => {
  it('stores the setting, defaults to on, and validates its input', async () => {
    const v = await voter();
    expect((await (await meGet(v)).json()).fallback).toBe(true);
    expect(await (await mePost('/api/me/fallback', v, { enabled: false })).json()).toEqual({ fallback: false });
    expect((await (await meGet(v)).json()).fallback).toBe(false);
    for (const bad of [{}, { enabled: 'no' }, { enabled: 0 }, { enabled: null }, []]) expect((await mePost('/api/me/fallback', v, bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await (await meGet(v)).json()).fallback).toBe(false);
  });

  it('needs a session, the exact Origin and X-Swarm: 1 (CSRF)', async () => {
    const v = await voter();
    expect((await mePost('/api/me/fallback', null, { enabled: false })).status).toBe(401);
    expect((await mePost('/api/me/fallback', v, { enabled: false }, { headers: { Origin: 'https://swarm.bigpicsolutions.com.evil.example' } })).status).toBe(403);
    expect((await mePost('/api/me/fallback', v, { enabled: false }, { headers: { Origin: '' } })).status).toBe(403);
    expect((await mePost('/api/me/fallback', v, { enabled: false }, { headers: { 'X-Swarm': '0' } })).status).toBe(403);
    expect((await send('/api/me/fallback', { method: 'PUT', headers: { Cookie: v.cookie } })).status).toBe(405);
    expect((await (await meGet(v)).json()).fallback).toBe(true);
  });
});

describe('my_week', () => {
  it('returns the same summary as /me, plus a recap an AI can tell the user', async () => {
    const v = await voter({ allocations: { 'town-hall': 100 } });
    const u = await linkedUser(v);
    const a = await work(u, { units: 3, tokens_est: 500 });
    await work(u, { units: 1 });
    await review(a.submission, 'accept', 'ok');
    const r = await u.call('my_week');
    expect(r.isError, r.text).toBe(false);
    const me = (await (await meGet(v)).json()).week;
    expect(r.data.week).toBe(me.week);
    expect(r.data.by_origin).toEqual(me.by_origin);
    expect(r.data.receipts).toEqual(me.receipts);
    expect(r.data.self_reported_tokens_est).toEqual(me.self_reported_tokens_est);
    expect(r.data.handle).toBe(u.handle);
    expect(r.data.steering).toMatchObject({ linked: true, fallback_to_public_when_no_work: true });
    expect(r.data.recap.join(' ')).toMatch(/2 tasks were handed in, 1 awaiting review \(not accepted yet\) and 1 accepted/);
    expect(r.data.note).toMatch(/no email/);
    expect(r.data.notice).toMatch(/data|untrusted/i); // task titles in receipts are public text
  });

  it('for an unlinked contributor, says how to link and has no steering', async () => {
    const u = await newUser();
    await work(u, { units: 3 });
    const r = await u.call('my_week');
    expect(r.data.steering.linked).toBe(false);
    expect(r.data.steering.how_to_link).toMatch(/Link my AI/);
    expect(r.data.by_origin.public_routed.claimed).toEqual({ tasks: 1, units: 3 });
    expect(r.data.by_origin.ballot_directed.claimed).toEqual({ tasks: 0, units: 0 });
  });

  it('needs a key and only ever reads the caller\'s own data', async () => {
    const a = await newUser(), b = await newUser();
    await work(a, { units: 8 });
    expect((await tool('my_week')).isError).toBe(true);
    expect((await b.call('my_week')).data.by_origin.public_routed.claimed).toEqual({ tasks: 0, units: 0 });
    expect((await b.call('my_week', { extra: 1 })).isError).toBe(true);
  });

  it('does not list a task that was held after the fact', async () => {
    const v = await voter({ allocations: { 'town-hall': 100 } });
    const u = await linkedUser(v);
    const w = await work(u);
    await env.DB.prepare("UPDATE tasks SET held_reason = 'screen' WHERE id = ?1").bind(w.task).run();
    const r = await u.call('my_week');
    expect(r.data.by_origin.ballot_directed.claimed.tasks).toBe(0);
  });
});
