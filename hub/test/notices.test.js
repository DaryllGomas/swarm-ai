// Finding 10: every response envelope that carries task text (titles, briefs, submission bodies, review notes) carries the
// same untrusted-data notice, in a top-level `notice` field. Each path below returns a task title; the test asserts the
// notice is there whenever the title is, so a new path that shows task text and forgets the notice fails here.
import { describe, it, expect, beforeEach } from 'vitest';
import { ADMIN, BODY, SOURCE, addTask, newUser, resetDb, review, send, tool } from './helpers.js';
import { UNTRUSTED } from '../src/sync.js';

beforeEach(resetDb);

const TITLE_OPEN = 'Notice test: an open task';
const TITLE_CLOSED = 'Notice test: a closed task';
const TITLE_HELD = 'Notice test: a held task';

async function world() {
  const open = await addTask({ title: TITLE_OPEN });
  const closed = await addTask({ title: TITLE_CLOSED, status: 'closed' });
  const held = await addTask({ title: TITLE_HELD, status: 'held', held_reason: 'ignore_instructions' });
  const worker = await newUser({ handle: 'notice-worker' });
  const claimed = await worker.call('claim_task', { id: open });
  const sub = await worker.call('submit_work', { task_id: open, body: BODY, sources: [SOURCE] });
  // a second task, reviewed and accepted, for the receipts
  const t2 = await addTask({ title: 'Notice test: an accepted task' });
  await worker.call('claim_task', { id: t2 });
  const sub2 = await worker.call('submit_work', { task_id: t2, body: BODY, sources: [SOURCE] });
  await review(sub2.data.submission_id, 'accept', 'looks right');
  return { open, closed, held, t2, worker, claimed, subId: sub.data.submission_id, sub2Id: sub2.data.submission_id };
}

describe('the untrusted-data notice is on every response that carries task text', () => {
  it('REST: /api/tasks, /api/tasks/:id (open and closed), /api/receipts', async () => {
    const w = await world();
    expect((await (await send('/api/tasks?status=ready')).json()).notice).toBe(UNTRUSTED);
    const all = await (await send('/api/tasks')).json();
    expect(all.notice).toBe(UNTRUSTED);
    expect(all.tasks.map((t) => t.title)).toContain(TITLE_CLOSED);
    const open = await (await send(`/api/tasks/${w.open}`)).json();
    expect(open.notice).toBe(UNTRUSTED);
    const closed = await (await send(`/api/tasks/${w.closed}`)).json();
    expect(closed.notice).toBe(UNTRUSTED);
    expect(closed.note).toBe('This task is closed.');
    expect(closed.brief).toBeUndefined();
    const receipts = await (await send('/api/receipts')).json();
    expect(receipts.receipts[0].task.title).toBe('Notice test: an accepted task');
    expect(receipts.notice).toBe(UNTRUSTED);
    expect(receipts.note).toMatch(/Accepted means/); // its own accounting note is still there
  });

  it('MCP: list_tasks, get_task (open and closed), next_task, claim_task, my_work, submission_status', async () => {
    const w = await world();
    for (const [name, args] of [['list_tasks', {}], ['list_tasks', { status: 'closed' }], ['get_task', { id: w.open }], ['get_task', { id: w.closed }]]) {
      const r = await tool(name, args);
      expect(r.isError, name).toBe(false);
      expect(r.data.notice, `${name} ${JSON.stringify(args)}`).toBe(UNTRUSTED);
    }
    const free = await addTask({ title: 'Notice test: a free task' });
    const other = await newUser();
    const claim = await other.call('claim_task', { id: free });
    expect(claim.data.notice).toBe(UNTRUSTED);
    await addTask({ title: 'Notice test: a task for next_task' });
    const next = await other.call('next_task');
    expect(next.isError, next.text).toBe(false);
    expect(next.data.notice).toBe(UNTRUSTED);
    const mine = await w.worker.call('my_work');
    expect(mine.data.submissions.map((s) => s.title)).toContain(TITLE_OPEN);
    expect(mine.data.notice).toBe(UNTRUSTED);
    expect(mine.data.note).toBe('Pending work is never shown as accepted.');
    const status = await w.worker.call('submission_status', { id: w.sub2Id });
    expect(status.data.title).toBe('Notice test: an accepted task');
    expect(status.data.notice).toBe(UNTRUSTED);
    expect(status.data.review_note).toBe('looks right');
  });

  it('admin: pending (task briefs and submission bodies) and held (withheld briefs)', async () => {
    await world();
    const pending = await (await send('/api/admin/pending', { headers: ADMIN() })).json();
    expect(pending.pending.length).toBeGreaterThan(0);
    expect(pending.notice).toBe(UNTRUSTED);
    const held = await (await send('/api/admin/held', { headers: ADMIN() })).json();
    expect(held.held.map((t) => t.title)).toContain(TITLE_HELD);
    expect(held.notice).toBe(UNTRUSTED);
  });

  it('text that is withheld stays withheld: held tasks still never appear', async () => {
    const w = await world();
    for (const text of [JSON.stringify(await (await send('/api/tasks')).json()), JSON.stringify((await tool('list_tasks', {})).data), (await tool('get_task', { id: w.held })).text]) {
      expect(text).not.toContain(TITLE_HELD);
    }
  });
});
