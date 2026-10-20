// Race tests: controlled interleavings of requests, made deterministic by pausing one request AFTER a real database read
// (test/fault.js wraps env.DB) while a competing operation runs, then resuming it. Each test names the review finding it
// guards against (docs: the 2026-10-20 Codex security review). The Worker code is not modified to make this possible.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { BODY, SOURCE, addTask, makeEnv, newUser, resetDb, review, send, tool } from './helpers.js';
import { count, gate, rendezvous, wrapDb } from './fault.js';
import { expireClaims } from '../src/core.js';

beforeEach(resetDb);

const taskRow = (id) => env.DB.prepare('SELECT status FROM tasks WHERE id = ?1').bind(id).first();
const outstanding = (taskId) => count('SELECT COUNT(*) AS n FROM claims WHERE task = ?1 AND outcome IS NULL', taskId);
const eventCount = (type, taskId) => count('SELECT COUNT(*) AS n FROM events WHERE type = ?1 AND task = ?2', type, taskId);
const expire = (claimId) => env.DB.prepare('UPDATE claims SET expires_at = ?2 WHERE id = ?1').bind(claimId, Date.now() - 1000).run();
const claimOf = (taskId, userHandle) => env.DB.prepare(
  'SELECT c.* FROM claims c JOIN contributors u ON u.id = c.contributor WHERE c.task = ?1 AND u.handle = ?2 ORDER BY c.id DESC'
).bind(taskId, userHandle).first();

describe('finding 1: a stale release cannot reopen someone else\'s task', () => {
  it('release A paused after reading its claim, release again, B claims, A resumes: B keeps the task', async () => {
    const taskId = await addTask();
    const [a, b, c] = [await newUser(), await newUser(), await newUser()];
    expect((await a.call('claim_task', { id: taskId })).isError).toBe(false);

    // Release A reads A's active claim, then waits.
    const g = gate();
    const db = wrapDb(env.DB, { afterRead: async (sql) => { if (/FROM claims WHERE task = \?1 AND contributor = \?2 AND outcome IS NULL/.test(sql)) await g.hit(); } });
    const stale = a.call('release_task', { id: taskId }, { over: { DB: db } });
    await g.reached;

    // Meanwhile A's own second release completes, and B claims the task.
    expect((await a.call('release_task', { id: taskId })).isError).toBe(false);
    expect((await b.call('claim_task', { id: taskId })).isError).toBe(false);
    g.open();
    await stale;

    // B still owns the task: it is claimed, B's claim is outstanding, and C cannot take it.
    expect((await taskRow(taskId)).status).toBe('claimed');
    expect(await outstanding(taskId)).toBe(1);
    expect((await claimOf(taskId, b.handle)).outcome).toBeNull();
    const cTry = await c.call('claim_task', { id: taskId });
    expect(cTry.isError).toBe(true);
    expect(cTry.text).toMatch(/claimed, not ready/);
    // The stale release wrote nothing: one release event for A's claim, none for B.
    expect(await eventCount('claim_released', taskId)).toBe(1);
  });

  it('the stale release can no longer end in two accepted receipts for one task', async () => {
    const taskId = await addTask({ units: 3 });
    const [a, b, c] = [await newUser(), await newUser(), await newUser()];
    await a.call('claim_task', { id: taskId });
    const g = gate();
    const db = wrapDb(env.DB, { afterRead: async (sql) => { if (/FROM claims WHERE task = \?1 AND contributor = \?2 AND outcome IS NULL/.test(sql)) await g.hit(); } });
    const stale = a.call('release_task', { id: taskId }, { over: { DB: db } });
    await g.reached;
    await a.call('release_task', { id: taskId });
    await b.call('claim_task', { id: taskId });
    g.open();
    await stale;
    // C tries; B submits; the admin accepts. Only one submission can exist for the task.
    await c.call('claim_task', { id: taskId });
    const subB = await b.call('submit_work', { task_id: taskId, body: BODY, sources: [SOURCE] });
    expect(subB.isError).toBe(false);
    expect((await c.call('submit_work', { task_id: taskId, body: BODY, sources: [SOURCE] })).isError).toBe(true);
    expect((await review(subB.data.submission_id, 'accept')).status).toBe(200);
    const stats = await (await send('/api/stats')).json();
    expect(stats.projects.find((p) => p.id === 'town-hall').accepted_units_all_time).toBe(3);
    expect(stats.totals.accepted).toBe(1);
  });
});

describe('finding 1: overlapping expiry sweeps cannot reopen someone else\'s task', () => {
  it('sweep 1 selected the old claim, sweep 2 expired it, B claimed, sweep 1 resumes: B keeps the task', async () => {
    const taskId = await addTask();
    const [a, b] = [await newUser(), await newUser()];
    await a.call('claim_task', { id: taskId });
    await expire((await claimOf(taskId, a.handle)).id);

    const g = gate();
    const db = wrapDb(env.DB, { afterRead: async (sql) => { if (/FROM claims WHERE outcome IS NULL AND expires_at <= /.test(sql)) await g.hit(); } });
    const sweep1 = expireClaims(makeEnv({ DB: db }));
    await g.reached;

    expect(await expireClaims(env)).toBe(1); // sweep 2
    expect((await b.call('claim_task', { id: taskId })).isError).toBe(false);
    g.open();
    expect(await sweep1).toBe(0); // it won nothing

    expect((await taskRow(taskId)).status).toBe('claimed');
    expect((await claimOf(taskId, b.handle)).outcome).toBeNull();
    expect(await eventCount('claim_expired', taskId)).toBe(1);
  });

  it('a claim that expires after the request\'s sweep still does not block a new claim on the task', async () => {
    const taskId = await addTask();
    const [a, b] = [await newUser(), await newUser()];
    await a.call('claim_task', { id: taskId });
    const aClaim = await claimOf(taskId, a.handle);

    // B's request has already done its sweep (it found nothing expired) and is about to read the task.
    const g = gate();
    const db = wrapDb(env.DB, { afterRead: async (sql) => { if (/FROM claims WHERE outcome IS NULL AND expires_at <= /.test(sql)) await g.hit(); } });
    const bCall = b.call('claim_task', { id: taskId }, { over: { DB: db } });
    await g.reached;
    await expire(aClaim.id); // now A's claim has run out, and nobody has swept it
    g.open();
    const r = await bCall;
    expect(r.isError, r.text).toBe(false);
    expect((await env.DB.prepare('SELECT outcome FROM claims WHERE id = ?1').bind(aClaim.id).first()).outcome).toBe('expired');
    expect(await outstanding(taskId)).toBe(1);
    expect((await taskRow(taskId)).status).toBe('claimed');
  });
});

describe('finding 1: a stale claim cannot bypass the already-submitted rule', () => {
  it('claim paused after its precondition read; the same contributor claims, submits and is rejected; the stale claim is refused', async () => {
    const taskId = await addTask();
    const u = await newUser();

    const g = gate();
    const db = wrapDb(env.DB, { afterRead: async (sql) => { if (/FROM tasks t JOIN projects p/.test(sql)) await g.hit(); } });
    const stale = u.call('claim_task', { id: taskId }, { over: { DB: db } });
    await g.reached; // it saw: ready, nothing submitted by me

    expect((await u.call('claim_task', { id: taskId })).isError).toBe(false);
    const sub = await u.call('submit_work', { task_id: taskId, body: BODY, sources: [SOURCE] });
    expect(sub.isError).toBe(false);
    expect((await review(sub.data.submission_id, 'reject', 'try again')).status).toBe(200); // task is ready again, and u has handed in work on it

    g.open();
    const r = await stale;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/already handed in/);
    expect(await outstanding(taskId)).toBe(0);
    expect((await taskRow(taskId)).status).toBe('ready');
    // ...and the same contributor still cannot claim it afresh.
    expect((await u.call('claim_task', { id: taskId })).text).toMatch(/already handed in/);
  });

  it('two contributors claim the same ready task at once: exactly one wins, one claim is outstanding', async () => {
    const taskId = await addTask();
    const [a, b] = [await newUser(), await newUser()];
    const wait = rendezvous(2);
    const slow = () => wrapDb(env.DB, { afterRead: async (sql) => { if (/FROM tasks t JOIN projects p/.test(sql)) await wait(); } });
    const [ra, rb] = await Promise.all([
      a.call('claim_task', { id: taskId }, { over: { DB: slow() } }),
      b.call('claim_task', { id: taskId }, { over: { DB: slow() } }),
    ]);
    expect([ra, rb].filter((r) => !r.isError)).toHaveLength(1);
    expect([ra, rb].filter((r) => r.isError)[0].text).toMatch(/Someone else just claimed|claimed, not ready/);
    expect(await outstanding(taskId)).toBe(1);
    expect((await taskRow(taskId)).status).toBe('claimed');
    expect(await eventCount('task_claimed', taskId)).toBe(1);
  });
});

describe('finding 1: constraints and review rules', () => {
  async function fixture() {
    const taskId = await addTask();
    const [a, b] = [await newUser(), await newUser()];
    await a.call('claim_task', { id: taskId });
    const sub = await a.call('submit_work', { task_id: taskId, body: BODY, sources: [SOURCE] });
    const ids = await env.DB.prepare('SELECT id FROM contributors ORDER BY id').all();
    return { taskId, a, b, subId: sub.data.submission_id, aId: ids.results[0].id, bId: ids.results[1].id };
  }
  const rawClaim = (task, contributor) => env.DB.prepare(
    'INSERT INTO claims (task, contributor, routed, week, claimed_at, expires_at) VALUES (?1, ?2, 0, ?3, ?4, ?5)'
  ).bind(task, contributor, '2026-10-19', Date.now(), Date.now() + 1000);
  const rawSubmission = (task, contributor, claim, status) => env.DB.prepare(
    "INSERT INTO submissions (task, contributor, claim, body, sources, status, created) VALUES (?1, ?2, ?3, 'b', '[]', ?4, ?5)"
  ).bind(task, contributor, claim, status, Date.now());

  it('the database allows at most one outstanding claim per task', async () => {
    const taskId = await addTask();
    const u = await newUser();
    const { results } = await env.DB.prepare('SELECT id FROM contributors').all();
    await rawClaim(taskId, results[0].id).run();
    await expect(rawClaim(taskId, results[0].id).run()).rejects.toThrow(/UNIQUE/i);
    // A closed claim does not count.
    await env.DB.prepare("UPDATE claims SET outcome = 'released' WHERE task = ?1").bind(taskId).run();
    await expect(rawClaim(taskId, results[0].id).run()).resolves.toBeTruthy();
    expect(u.handle).toBeTruthy();
  });

  it('the database allows at most one pending-or-accepted submission per task, however many contributors', async () => {
    const { taskId, bId, aId, subId } = await fixture();
    const claim = (await env.DB.prepare('SELECT id FROM claims WHERE task = ?1').bind(taskId).first()).id;
    await expect(rawSubmission(taskId, bId, claim, 'pending').run()).rejects.toThrow(/UNIQUE/i);
    await expect(rawSubmission(taskId, bId, claim, 'accepted').run()).rejects.toThrow(/UNIQUE/i);
    // A rejected one is history and does not count; accept the live one and the rule still holds.
    await expect(rawSubmission(taskId, bId, claim, 'rejected').run()).resolves.toBeTruthy();
    expect((await review(subId, 'accept')).status).toBe(200);
    await expect(rawSubmission(taskId, aId, claim, 'pending').run()).rejects.toThrow(/UNIQUE/i);
    await expect(rawSubmission(taskId, bId, claim, 'accepted').run()).rejects.toThrow(/UNIQUE/i);
  });

  it('review refuses a pending submission whose task is not waiting for review', async () => {
    const { taskId, subId } = await fixture();
    await env.DB.prepare("UPDATE tasks SET status = 'claimed' WHERE id = ?1").bind(taskId).run();
    for (const decision of ['accept', 'reject']) {
      const res = await review(subId, decision);
      expect(res.status, decision).toBe(409);
      expect((await res.json()).error).toMatch(/not waiting for review/);
    }
    expect((await env.DB.prepare('SELECT status FROM submissions WHERE id = ?1').bind(subId).first()).status).toBe('pending');
    expect((await taskRow(taskId)).status).toBe('claimed');
    // Back in the right state, the review goes through.
    await env.DB.prepare("UPDATE tasks SET status = 'submitted' WHERE id = ?1").bind(taskId).run();
    expect((await review(subId, 'accept')).status).toBe(200);
  });

  it('accept and reject racing on one submission: exactly one wins and the task matches the winner', async () => {
    const { taskId, subId } = await fixture();
    const wait = rendezvous(2);
    const slow = () => wrapDb(env.DB, { afterRead: async (sql) => { if (/FROM submissions s JOIN tasks t ON t.id = s.task JOIN projects/.test(sql)) await wait(); } });
    const [x, y] = await Promise.all([review(subId, 'accept', undefined, { DB: slow() }), review(subId, 'reject', undefined, { DB: slow() })]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const sub = await env.DB.prepare('SELECT status FROM submissions WHERE id = ?1').bind(subId).first();
    expect((await taskRow(taskId)).status).toBe(sub.status === 'accepted' ? 'accepted' : 'ready');
    expect(await count("SELECT COUNT(*) AS n FROM events WHERE type IN ('submission_accepted','submission_rejected') AND submission = ?1", subId)).toBe(1);
  });
});

describe('finding 3: the daily submission cap holds under concurrency', () => {
  const DAY = 86400000;
  // A contributor with `recent` submissions in the last day and `old` ones from before that, plus two live claims.
  async function seeded(recent, old = 0) {
    const user = await newUser();
    const uid = (await env.DB.prepare('SELECT id FROM contributors WHERE handle = ?1').bind(user.handle).first()).id;
    const history = await addTask({ status: 'rejected' });
    const claim = (await env.DB.prepare(
      "INSERT INTO claims (task, contributor, routed, week, claimed_at, expires_at, outcome) VALUES (?1, ?2, 0, '2026-10-19', ?3, ?3, 'submitted')"
    ).bind(history, uid, Date.now() - 1000).run()).meta.last_row_id;
    const rows = [];
    for (let i = 0; i < recent + old; i++) {
      rows.push(env.DB.prepare("INSERT INTO submissions (task, contributor, claim, body, sources, status, created) VALUES (?1, ?2, ?3, 'b', '[]', 'rejected', ?4)")
        .bind(history, uid, claim, i < recent ? Date.now() - 3600000 : Date.now() - DAY - 3600000));
    }
    if (rows.length) await env.DB.batch(rows);
    const [t1, t2] = [await addTask(), await addTask()];
    expect((await user.call('claim_task', { id: t1 })).isError).toBe(false);
    expect((await user.call('claim_task', { id: t2 })).isError).toBe(false);
    return { user, uid, t1, t2 };
  }
  const inWindow = (uid) => count('SELECT COUNT(*) AS n FROM submissions WHERE contributor = ?1 AND created >= ?2', uid, Date.now() - DAY);
  const submitTo = (u, id, over) => u.call('submit_work', { task_id: id, body: BODY, sources: [SOURCE] }, over ? { over } : {});

  it('two submissions that both saw 19 in the window: exactly one gets in, and the other claim stays usable', async () => {
    const { user, uid, t1, t2 } = await seeded(19);
    const wait = rendezvous(2, 500);
    const slow = () => wrapDb(env.DB, { afterRead: async (sql) => { if (/COUNT\(\*\) AS n FROM submissions WHERE contributor = \?1 AND created >= /.test(sql)) await wait(); } });
    const [a, b] = await Promise.all([submitTo(user, t1, slow()), submitTo(user, t2, slow())]);
    expect([a, b].filter((r) => !r.isError)).toHaveLength(1);
    const refused = [a, b].find((r) => r.isError);
    expect(refused.text).toMatch(/Daily submission limit/);
    expect(await inWindow(uid)).toBe(20);

    // The refused submission consumed nothing: its claim is still live and its task still claimed.
    const lostTask = a.isError ? t1 : t2;
    expect(await outstanding(lostTask)).toBe(1);
    expect((await taskRow(lostTask)).status).toBe('claimed');
    expect(await eventCount('submission_created', lostTask)).toBe(0);

    // Once the window has room again (an old submission ages out), the same claim submits.
    await env.DB.prepare('UPDATE submissions SET created = ?2 WHERE id = (SELECT MIN(id) FROM submissions WHERE contributor = ?1)').bind(uid, Date.now() - DAY - 1000).run();
    expect((await submitTo(user, lostTask)).isError).toBe(false);
    expect(await inWindow(uid)).toBe(20);
  });

  it('the window is rolling: submissions older than a day do not count, and the 21st within a day is refused', async () => {
    const { user, uid, t1, t2 } = await seeded(19, 10);
    expect((await submitTo(user, t1)).isError).toBe(false); // the 20th in the window
    const over = await submitTo(user, t2);
    expect(over.isError).toBe(true);
    expect(over.text).toMatch(/Daily submission limit/);
    expect(await inWindow(uid)).toBe(20);
    expect(await outstanding(t2)).toBe(1);
  });

  it('other contributors are not affected by one contributor\'s cap', async () => {
    const { t1 } = await seeded(20);
    const other = await newUser();
    const t = await addTask();
    await other.call('claim_task', { id: t });
    expect((await submitTo(other, t)).isError).toBe(false);
    expect(t1).toBeTruthy();
  });
});
