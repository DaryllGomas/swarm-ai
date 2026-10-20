// A submission can only be created for a task that is 'claimed' by that exact claim and not withheld (review 3, issue A).
// Legacy rows can leave an outstanding claim on a closed, held or finished task; its owner must not be able to hand in
// work that no review could ever accept. The check is inside the submission INSERT, so it holds even when the task
// changes between the claim lookup and the write.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { BODY, SOURCE, addTask, newUser, resetDb, review } from './helpers.js';
import { gate, wrapDb } from './fault.js';

beforeEach(resetDb);

const n = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).first()).n;
const submit = (u, taskId, over) => u.call('submit_work', { task_id: taskId, body: BODY, sources: [SOURCE] }, over ? { over } : {});
const setTask = (id, status, heldReason = null) => env.DB.prepare('UPDATE tasks SET status = ?2, held_reason = ?3 WHERE id = ?1').bind(id, status, heldReason).run();

async function claimed() {
  const taskId = await addTask();
  const u = await newUser();
  expect((await u.call('claim_task', { id: taskId })).isError).toBe(false);
  return { taskId, u };
}

describe('submit_work needs a claimed, non-withheld task', () => {
  for (const status of ['closed', 'accepted', 'rejected', 'held', 'ready', 'submitted']) {
    it(`refuses, and writes nothing, when the task is ${status} but an outstanding claim exists`, async () => {
      const { taskId, u } = await claimed();
      await setTask(taskId, status, status === 'held' ? 'ignore_instructions' : null);
      const r = await submit(u, taskId);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/not open for work any more/);
      expect(r.text).not.toMatch(/ignore_instructions/);
      expect(await n('SELECT COUNT(*) AS n FROM submissions')).toBe(0);
      expect(await n('SELECT COUNT(*) AS n FROM events WHERE type = ?1', 'submission_created')).toBe(0);
      expect((await env.DB.prepare('SELECT status FROM tasks WHERE id = ?1').bind(taskId).first()).status).toBe(status);
      expect(await n('SELECT COUNT(*) AS n FROM claims WHERE task = ?1 AND outcome IS NULL', taskId)).toBe(1); // claim untouched
    });
  }

  it('refuses a claimed task that is withheld (held_reason set)', async () => {
    const { taskId, u } = await claimed();
    await setTask(taskId, 'claimed', 'ignore_instructions');
    const r = await submit(u, taskId);
    expect(r.isError).toBe(true);
    expect(await n('SELECT COUNT(*) AS n FROM submissions')).toBe(0);
  });

  it('the claim holder can still release a claim on a closed task, and that does not reopen the task', async () => {
    const { taskId, u } = await claimed();
    await setTask(taskId, 'closed');
    expect((await u.call('release_task', { id: taskId })).isError).toBe(false);
    expect((await env.DB.prepare('SELECT status FROM tasks WHERE id = ?1').bind(taskId).first()).status).toBe('closed');
    expect(await n('SELECT COUNT(*) AS n FROM claims WHERE task = ?1 AND outcome IS NULL', taskId)).toBe(0);
  });

  it('the task closing between the claim lookup and the write still creates no submission', async () => {
    const { taskId, u } = await claimed();
    const g = gate();
    const db = wrapDb(env.DB, { afterRead: async (sql) => { if (/FROM claims WHERE task = \?1 AND contributor = \?2 AND outcome IS NULL/.test(sql)) await g.hit(); } });
    const pending = submit(u, taskId, { DB: db });
    await g.reached;
    await setTask(taskId, 'closed');
    g.open();
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(await n('SELECT COUNT(*) AS n FROM submissions')).toBe(0);
    expect((await env.DB.prepare('SELECT status FROM tasks WHERE id = ?1').bind(taskId).first()).status).toBe('closed');
    expect(await n('SELECT COUNT(*) AS n FROM claims WHERE task = ?1 AND outcome IS NULL', taskId)).toBe(1);
  });

  it('a normal claimed task still submits and reviews end to end', async () => {
    const { taskId, u } = await claimed();
    const r = await submit(u, taskId);
    expect(r.isError).toBe(false);
    expect(r.data.status).toBe('pending');
    const res = await review(r.data.submission_id, 'accept');
    expect(res.status).toBe(200);
  });
});
