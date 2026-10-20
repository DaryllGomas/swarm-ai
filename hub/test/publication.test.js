import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { ADMIN, BODY, SOURCE, addTask, newUser, resetDb, review, send } from './helpers.js';
import { wrapDb } from './fault.js';
import { UNTRUSTED } from '../src/sync.js';

beforeEach(resetDb);
const mark = (body, over) => send('/api/admin/published', { method: 'POST', headers: { ...ADMIN(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, over);
async function accepted({ accept = true } = {}) {
  const u = await newUser(), task = await addTask();
  await env.DB.prepare('UPDATE tasks SET source_key = ?2 WHERE id = ?1').bind(task, `townhall:housing:fix`).run();
  await u.call('claim_task', { id: task });
  const s = await u.call('submit_work', { task_id: task, body: BODY, sources: [SOURCE] });
  if (accept) await review(s.data.submission_id, 'accept', 'Verified');
  return { id: s.data.submission_id, task, u };
}

describe('accepted to published lifecycle', () => {
  it('only the bearer admin can fetch accepted Town Hall research or mark it published', async () => {
    const { id } = await accepted();
    for (const path of [`/api/admin/submission?id=${id}`, '/api/admin/published']) expect((await send(path)).status).toBe(404);
    const r = await (await send(`/api/admin/submission?id=${id}`, { headers: ADMIN() })).json();
    expect(r.notice).toBe(UNTRUSTED); expect(r.submission.id).toBe(id); expect(r.submission.sources).toEqual([SOURCE]); expect(r.submission.body).toBe(BODY.trim());
    expect(JSON.stringify(r)).not.toContain('key_hash');
  });
  it('records publication once with a public link, preserves acceptance, and exposes it on receipts', async () => {
    const { id } = await accepted(), url = 'https://townhall.bigpicsolutions.com/solutions/housing';
    const results = await Promise.all([mark({ submission_id: id, url }), mark({ submission_id: id, url })]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const s = await env.DB.prepare('SELECT status,published_url,published_at FROM submissions WHERE id = ?1').bind(id).first();
    expect(s).toMatchObject({ status: 'accepted', published_url: url }); expect(s.published_at).toBeGreaterThan(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'submission_published' AND submission = ?1").bind(id).first()).n).toBe(1);
    expect((await mark({ submission_id: id, url: url + '/different' })).status).toBe(409);
    const r = (await (await send('/api/receipts')).json()).receipts[0];
    expect(r.publication).toMatchObject({ status: 'published', url });
  });
  it('refuses pending work, non-research tasks, missing IDs and invalid URLs', async () => {
    const p = await accepted({ accept: false });
    expect((await mark({ submission_id: p.id, url: SOURCE })).status).toBe(409);
    expect((await send(`/api/admin/submission?id=${p.id}`, { headers: ADMIN() })).status).toBe(404);
    await review(p.id, 'accept'); await env.DB.prepare("UPDATE tasks SET kind = 'recheck_sources' WHERE id = ?1").bind(p.task).run();
    expect((await send(`/api/admin/submission?id=${p.id}`, { headers: ADMIN() })).status).toBe(404);
    expect((await mark({ submission_id: 999999, url: SOURCE })).status).toBe(404);
    for (const id of ['bad', '-1', '1.2']) expect((await send(`/api/admin/submission?id=${id}`, { headers: ADMIN() })).status).toBe(400);
    for (const body of [{}, { submission_id: '1', url: SOURCE }, ...['http://public.example/', 'javascript:alert(1)', 'https://localhost/', 'https://127.0.0.1/', 'https://user:pass@public.example/', 'https://public.example/' + 'a'.repeat(300)].map((url) => ({ submission_id: p.id, url }))]) expect((await mark(body)).status).toBe(400);
    expect((await mark({ submission_id: p.id, url: 'x'.repeat(5000) })).status).toBe(413);
    expect((await send('/api/admin/published', { method: 'POST', headers: ADMIN(), body: '{' })).status).toBe(400);
  });
  it('a failed publication event rolls back the receipt update', async () => {
    const { id } = await accepted();
    expect((await mark({ submission_id: id, url: SOURCE }, { DB: wrapDb(env.DB, { failBatchAt: 1 }) })).status).toBe(500);
    expect((await env.DB.prepare('SELECT published_url FROM submissions WHERE id = ?1').bind(id).first()).published_url).toBeNull();
  });
});
