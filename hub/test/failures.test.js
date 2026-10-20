// Failure-at-boundary tests (review finding 2): an error injected into ANY statement of a lifecycle transition must leave
// nothing partial behind (no claim without its task change, no submission without its claim, no review without its event),
// and a retry must then finish the job or return the result that already completed.
// test/fault.js wraps env.DB: `failOn` makes a statement matching the pattern throw, `failBatchAt` aborts a batch at an index.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { BODY, SOURCE, addTask, newUser, resetDb, review } from './helpers.js';
import { InjectedFailure, count, gate, wrapDb } from './fault.js';

beforeEach(resetDb);

const taskStatus = async (id) => (await env.DB.prepare('SELECT status FROM tasks WHERE id = ?1').bind(id).first()).status;
const events = (type, taskId) => count('SELECT COUNT(*) AS n FROM events WHERE type = ?1 AND task = ?2', type, taskId);
const claimsOn = (taskId) => count('SELECT COUNT(*) AS n FROM claims WHERE task = ?1', taskId);
const outstanding = (taskId) => count('SELECT COUNT(*) AS n FROM claims WHERE task = ?1 AND outcome IS NULL', taskId);
const submissionsOn = (taskId) => count('SELECT COUNT(*) AS n FROM submissions WHERE task = ?1', taskId);
const submit = (u, taskId, over) => u.call('submit_work', { task_id: taskId, body: BODY, sources: [SOURCE] }, over ? { over } : {});

// Every statement a transition runs, by the SQL it contains.
const STATEMENTS = {
  claim: [/INSERT INTO claims/, /UPDATE tasks/, /INSERT INTO events/],
  submit: [/INSERT INTO submissions/, /UPDATE claims/, /UPDATE tasks/, /INSERT INTO events/],
  review: [/UPDATE submissions/, /UPDATE tasks/, /INSERT INTO events/],
};

describe('claim is one transaction', () => {
  const untouched = async (taskId) => {
    expect(await claimsOn(taskId)).toBe(0);
    expect(await taskStatus(taskId)).toBe('ready');
    expect(await events('task_claimed', taskId)).toBe(0);
  };

  for (const failOn of STATEMENTS.claim) {
    it(`a failure at ${failOn} leaves no claim, no task change, no event; the retry claims it`, async () => {
      const taskId = await addTask();
      const u = await newUser();
      const r = await u.call('claim_task', { id: taskId }, { over: { DB: wrapDb(env.DB, { failOn }) } });
      expect(r.isError).toBe(true);
      await untouched(taskId);
      expect((await u.call('claim_task', { id: taskId })).isError).toBe(false);
      expect(await outstanding(taskId)).toBe(1);
      expect(await taskStatus(taskId)).toBe('claimed');
      expect(await events('task_claimed', taskId)).toBe(1);
    });
  }

  for (const i of [0, 1, 2]) {
    it(`the claim is one batch: failing statement ${i} of it aborts all of it`, async () => {
      const taskId = await addTask();
      const u = await newUser();
      const r = await u.call('claim_task', { id: taskId }, { over: { DB: wrapDb(env.DB, { failBatchAt: i }) } });
      expect(r.isError).toBe(true);
      await untouched(taskId);
    });
  }

  it('next_task fails the same way and leaves the task in the pool', async () => {
    const taskId = await addTask();
    const u = await newUser();
    const r = await u.call('next_task', {}, { over: { DB: wrapDb(env.DB, { failOn: /INSERT INTO events/ }) } });
    expect(r.isError).toBe(true);
    await untouched(taskId);
    expect((await u.call('next_task')).isError).toBe(false);
  });

  it('repeating claim_task for a task you hold returns your claim: no second claim, no second event', async () => {
    const taskId = await addTask();
    const u = await newUser();
    const first = await u.call('claim_task', { id: taskId });
    const again = await u.call('claim_task', { id: taskId });
    expect(again.isError).toBe(false);
    expect(again.data.claim.id).toBe(first.data.claim.id);
    expect(again.data.claim.expires_at).toBe(first.data.claim.expires_at);
    expect(await claimsOn(taskId)).toBe(1);
    expect(await events('task_claimed', taskId)).toBe(1);
    // Someone else's claim is still refused.
    expect((await (await newUser()).call('claim_task', { id: taskId })).isError).toBe(true);
  });

  it('a claim that committed but whose response was lost is returned on retry (next_task keeps working too)', async () => {
    const taskId = await addTask();
    const u = await newUser();
    const lost = wrapDb(env.DB, { afterBatch: async () => { throw new InjectedFailure('response lost'); } });
    expect((await u.call('claim_task', { id: taskId }, { over: { DB: lost } })).isError).toBe(true);
    expect(await outstanding(taskId)).toBe(1); // it did commit, completely
    expect(await events('task_claimed', taskId)).toBe(1);
    const retry = await u.call('claim_task', { id: taskId });
    expect(retry.isError).toBe(false);
    expect(await claimsOn(taskId)).toBe(1);
  });
});

describe('submit_work is one transaction', () => {
  async function claimed() {
    const taskId = await addTask();
    const u = await newUser();
    await u.call('claim_task', { id: taskId });
    return { taskId, u };
  }
  const untouched = async (taskId) => {
    expect(await submissionsOn(taskId)).toBe(0);
    expect(await outstanding(taskId), 'the claim is still usable').toBe(1);
    expect(await taskStatus(taskId)).toBe('claimed');
    expect(await events('submission_created', taskId)).toBe(0);
  };
  const done = async (taskId, r) => {
    expect(r.isError, r.text).toBe(false);
    expect(await submissionsOn(taskId)).toBe(1);
    expect(await outstanding(taskId)).toBe(0);
    expect(await taskStatus(taskId)).toBe('submitted');
    expect(await events('submission_created', taskId)).toBe(1);
  };

  for (const failOn of STATEMENTS.submit) {
    it(`a failure at ${failOn} leaves nothing behind and the same claim can submit on retry`, async () => {
      const { taskId, u } = await claimed();
      const r = await submit(u, taskId, { DB: wrapDb(env.DB, { failOn }) });
      expect(r.isError).toBe(true);
      await untouched(taskId);
      await done(taskId, await submit(u, taskId));
    });
  }

  for (const i of [0, 1, 2, 3]) {
    it(`the submission is one batch: failing statement ${i} of it aborts all of it`, async () => {
      const { taskId, u } = await claimed();
      const r = await submit(u, taskId, { DB: wrapDb(env.DB, { failBatchAt: i }) });
      expect(r.isError).toBe(true);
      await untouched(taskId);
    });
  }

  it('a submission that committed but whose response was lost: the same submission is returned on retry', async () => {
    const { taskId, u } = await claimed();
    const lost = wrapDb(env.DB, { afterBatch: async () => { throw new InjectedFailure('response lost'); } });
    expect((await submit(u, taskId, { DB: lost })).isError).toBe(true);
    expect(await submissionsOn(taskId)).toBe(1); // it committed, completely
    const retry = await submit(u, taskId);
    expect(retry.isError, retry.text).toBe(false);
    expect(retry.data.status).toBe('pending');
    const row = await env.DB.prepare('SELECT id FROM submissions WHERE task = ?1').bind(taskId).first();
    expect(retry.data.submission_id).toBe(row.id);
    expect(await submissionsOn(taskId)).toBe(1);
    expect(await events('submission_created', taskId)).toBe(1);
    expect(await taskStatus(taskId)).toBe('submitted');
    // Different text for the same task is not a retry: it is refused.
    const other = await u.call('submit_work', { task_id: taskId, body: `${BODY} And something else entirely.`, sources: [SOURCE] });
    expect(other.isError).toBe(true);
    expect(await submissionsOn(taskId)).toBe(1);
  });

  it('two identical submissions at once make one submission and both get its id', async () => {
    const { taskId, u } = await claimed();
    const g = gate();
    const db = wrapDb(env.DB, { afterRead: async (sql) => { if (/FROM claims WHERE task = \?1 AND contributor = \?2 AND outcome IS NULL/.test(sql)) await g.hit(); } });
    const slow = submit(u, taskId, { DB: db }); // reads its claim, then waits
    await g.reached;
    const fast = await submit(u, taskId); // completes
    g.open();
    const late = await slow;
    expect(fast.isError, fast.text).toBe(false);
    expect(late.isError, late.text).toBe(false);
    expect(late.data.submission_id).toBe(fast.data.submission_id);
    expect(await submissionsOn(taskId)).toBe(1);
    expect(await events('submission_created', taskId)).toBe(1);
  });

  it('the old compensating write is gone: a failed insert does not touch a claim it did not win', async () => {
    // A submission refused by the unique index (someone else already has a live one) must leave the claim as it was.
    const { taskId, u } = await claimed();
    const other = await newUser();
    const otherClaim = await env.DB.prepare('INSERT INTO claims (task, contributor, routed, week, claimed_at, expires_at, outcome) VALUES (?1, ?2, 0, ?3, ?4, ?4, ?5)')
      .bind(taskId, (await env.DB.prepare('SELECT id FROM contributors WHERE handle = ?1').bind(other.handle).first()).id, '2026-10-19', Date.now(), 'submitted').run();
    await env.DB.prepare("INSERT INTO submissions (task, contributor, claim, body, sources, status, created) VALUES (?1, ?2, ?3, 'b', '[]', 'pending', ?4)")
      .bind(taskId, (await env.DB.prepare('SELECT id FROM contributors WHERE handle = ?1').bind(other.handle).first()).id, otherClaim.meta.last_row_id, Date.now()).run();
    const r = await submit(u, taskId);
    expect(r.isError).toBe(true);
    expect(await outstanding(taskId)).toBe(1); // u's claim is exactly as it was
    expect(await submissionsOn(taskId)).toBe(1);
  });
});

describe('review is one transaction', () => {
  async function pending(decision = 'accept') {
    const taskId = await addTask();
    const u = await newUser();
    await u.call('claim_task', { id: taskId });
    const sub = await submit(u, taskId);
    return { taskId, u, subId: sub.data.submission_id, decision };
  }
  const untouched = async (taskId, subId) => {
    expect((await env.DB.prepare('SELECT status, reviewed_by, reviewed_at FROM submissions WHERE id = ?1').bind(subId).first())).toMatchObject({ status: 'pending', reviewed_by: null, reviewed_at: null });
    expect(await taskStatus(taskId)).toBe('submitted');
    expect(await count("SELECT COUNT(*) AS n FROM events WHERE type IN ('submission_accepted','submission_rejected') AND submission = ?1", subId)).toBe(0);
  };

  for (const decision of ['accept', 'reject']) {
    for (const failOn of STATEMENTS.review) {
      it(`${decision}: a failure at ${failOn} leaves the submission pending, and the retry completes the review`, async () => {
        const { taskId, subId } = await pending();
        const res = await review(subId, decision, 'note', { DB: wrapDb(env.DB, { failOn }) });
        expect(res.status).toBeGreaterThanOrEqual(500);
        await untouched(taskId, subId);
        const retry = await review(subId, decision, 'note');
        expect(retry.status).toBe(200);
        const out = await retry.json();
        expect(out.task_status).toBe(decision === 'accept' ? 'accepted' : 'ready');
        expect(await taskStatus(taskId)).toBe(decision === 'accept' ? 'accepted' : 'ready');
        expect(await events(decision === 'accept' ? 'submission_accepted' : 'submission_rejected', taskId)).toBe(1);
      });
    }
  }

  for (const i of [0, 1, 2]) {
    it(`the review is one batch: failing statement ${i} of it aborts all of it`, async () => {
      const { taskId, subId } = await pending();
      const res = await review(subId, 'accept', undefined, { DB: wrapDb(env.DB, { failBatchAt: i }) });
      expect(res.status).toBeGreaterThanOrEqual(500);
      await untouched(taskId, subId);
    });
  }

  it('a review that committed but whose response was lost is reported as already done, with the state, not repaired again', async () => {
    const { taskId, subId } = await pending();
    const lost = wrapDb(env.DB, { afterBatch: async () => { throw new InjectedFailure('response lost'); } });
    expect((await review(subId, 'accept', 'ok', { DB: lost })).status).toBeGreaterThanOrEqual(500);
    expect(await taskStatus(taskId)).toBe('accepted'); // it committed, completely, including the event
    expect(await events('submission_accepted', taskId)).toBe(1);
    const retry = await review(subId, 'accept');
    expect(retry.status).toBe(409);
    expect((await retry.json()).error).toBe('already accepted');
    expect(await events('submission_accepted', taskId)).toBe(1);
  });

  it('the second rejection closes the task for good, in the same transaction', async () => {
    const taskId = await addTask();
    const [a, b] = [await newUser(), await newUser()];
    await a.call('claim_task', { id: taskId });
    const s1 = (await submit(a, taskId)).data.submission_id;
    expect((await review(s1, 'reject')).status).toBe(200);
    expect(await taskStatus(taskId)).toBe('ready');
    await b.call('claim_task', { id: taskId });
    const s2 = (await submit(b, taskId)).data.submission_id;
    const out = await (await review(s2, 'reject')).json();
    expect(out.task_status).toBe('rejected');
  });
});

describe('release and expiry fail whole or not at all', () => {
  it('a failure writing the release event leaves the claim and the task as they were; the retry releases', async () => {
    const taskId = await addTask();
    const u = await newUser();
    await u.call('claim_task', { id: taskId });
    const r = await u.call('release_task', { id: taskId }, { over: { DB: wrapDb(env.DB, { failOn: /INSERT INTO events/ }) } });
    expect(r.isError).toBe(true);
    expect(await outstanding(taskId)).toBe(1);
    expect(await taskStatus(taskId)).toBe('claimed');
    expect((await u.call('release_task', { id: taskId })).isError).toBe(false);
    expect(await taskStatus(taskId)).toBe('ready');
    expect(await events('claim_released', taskId)).toBe(1);
  });

  it('repeating a release that went through answers the same way and changes nothing', async () => {
    const taskId = await addTask();
    const u = await newUser();
    await u.call('claim_task', { id: taskId });
    expect((await u.call('release_task', { id: taskId })).data.released).toBe(taskId);
    const again = await u.call('release_task', { id: taskId });
    expect(again.isError).toBe(false);
    expect(again.data.released).toBe(taskId);
    expect(await events('claim_released', taskId)).toBe(1);
    // A task you never held is still an error.
    const other = await addTask();
    expect((await u.call('release_task', { id: other })).isError).toBe(true);
  });
});
