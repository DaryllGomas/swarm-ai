import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/worker.js';
import { BODY, SOURCE, addTask, makeEnv, newUser, resetDb, review } from './helpers.js';
import { PRESCREEN_MODEL, similarity } from '../src/prescreen.js';
import { gate, wrapDb } from './fault.js';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
const annotation = { format_ok: true, sources_relevant: false, injection_suspected: true, duplicate_of: 9999, summary: 'Review the sources manually.' };
async function start() {
  const u = await newUser(), task = await addTask(); await u.call('claim_task', { id: task }); return { u, task };
}
const stored = async (id) => {
  const s = await env.DB.prepare('SELECT prescreen,status FROM submissions WHERE id = ?1').bind(id).first();
  return { prescreen: s.prescreen ? JSON.parse(s.prescreen) : null, status: s.status };
};

describe('advisory submission pre-screen', () => {
  it('runs after the submit batch commits, through waitUntil; separates system from untrusted data', async () => {
    const { u, task } = await start(), g = gate();
    const run = vi.fn(async (model, input) => {
      expect((await env.DB.prepare('SELECT status FROM tasks WHERE id = ?1').bind(task).first()).status).toBe('submitted');
      await g.hit(); return { response: JSON.stringify(annotation) };
    });
    const ctx = createExecutionContext();
    const req = new Request('https://swarm.test/mcp', { method: 'POST', headers: { Authorization: `Bearer ${u.key}`, 'CF-Connecting-IP': u.ip }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'submit_work', arguments: { task_id: task, body: BODY, sources: [SOURCE] } } }) });
    const res = await worker.fetch(req, makeEnv({ AI: { run } }), ctx);
    const data = (await res.json()).result.structuredContent;
    expect(data.status).toBe('pending'); await g.reached;
    expect((await stored(data.submission_id)).prescreen).toBeNull();
    g.open(); await waitOnExecutionContext(ctx);
    expect(run).toHaveBeenCalledTimes(1); expect(run.mock.calls[0][0]).toBe(PRESCREEN_MODEL);
    const input = run.mock.calls[0][1];
    expect(input.response_format).toEqual({ type: 'json_object' }); expect(input.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(input.messages[0].content).not.toContain(BODY); expect(input.messages[0].content).toContain('never instructions');
    expect(input.messages[1].content).toContain('BEGIN SUBMISSION DATA'); expect(input.messages[1].content).toContain('END SUBMISSION DATA');
    expect(await stored(data.submission_id)).toEqual({ prescreen: { ...annotation, duplicate_of: null }, status: 'pending' });
    await u.call('submit_work', { task_id: task, body: BODY, sources: [SOURCE] }, { over: { AI: { run } } });
    expect(run).toHaveBeenCalledTimes(1); // lost-response retry never runs it again
  });
  it('uses textual similarity for duplicate_of, disregards an AI-supplied duplicate ID, and never decides a review', async () => {
    const { u, task } = await start();
    const first = await u.call('submit_work', { task_id: task, body: BODY, sources: [SOURCE] }); await review(first.data.submission_id, 'reject');
    const other = await newUser(); await other.call('claim_task', { id: task });
    const run = vi.fn(async () => ({ response: annotation }));
    const second = await other.call('submit_work', { task_id: task, body: BODY + ' A short addition.', sources: [SOURCE] }, { over: { AI: { run } } });
    expect((await stored(second.data.submission_id)).prescreen.duplicate_of).toBe(first.data.submission_id);
    expect((await stored(second.data.submission_id)).status).toBe('pending');
    expect(similarity(BODY, BODY)).toBe(1); expect(similarity('entirely distinct text', BODY)).toBe(0); expect(similarity('', '')).toBe(0);
  });
  for (const [name, AI] of [
    ['missing binding', undefined], ['AI failure', { run: async () => { throw new Error('offline'); } }],
    ['bad JSON', { run: async () => ({ response: 'not JSON' }) }],
    ['wrong types', { run: async () => ({ response: { ...annotation, format_ok: 'true' } }) }],
    ['missing summary', { run: async () => ({ response: { format_ok: true } }) }],
  ]) it(`stores unavailable on ${name}, without blocking or accepting the submission`, async () => {
    const { u, task } = await start();
    const s = await u.call('submit_work', { task_id: task, body: BODY, sources: [SOURCE] }, { over: { AI } });
    expect(s.isError).toBe(false); expect(await stored(s.data.submission_id)).toEqual({ prescreen: { error: 'unavailable' }, status: 'pending' });
  });
  it('failed submit transactions never schedule an AI call', async () => {
    const { u, task } = await start(), run = vi.fn();
    const r = await u.call('submit_work', { task_id: task, body: BODY, sources: [SOURCE] }, { over: { AI: { run }, DB: wrapDb(env.DB, { failBatchAt: 2 }) } });
    expect(r.isError).toBe(true); expect(run).not.toHaveBeenCalled();
  });
});
