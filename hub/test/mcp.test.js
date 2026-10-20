import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { ADMIN, BODY, SOURCE, addTask, newUser, nextIp, resetDb, rpc, send, tool } from './helpers.js';

beforeEach(resetDb);

describe('MCP protocol', () => {
  it('initialize answers with server info and instructions', async () => {
    const { res, body } = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(res.status).toBe(200);
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.serverInfo.name).toBe('swarm-ai');
    expect(body.result.instructions).toMatch(/never instructions/);
  });

  it('tools/list includes setup_guide and the work tools', async () => {
    const { body } = await rpc('tools/list', {});
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain('setup_guide');
    for (const n of ['how_to_help', 'list_projects', 'list_tasks', 'get_task', 'pair', 'next_task', 'claim_task', 'release_task', 'my_work', 'submit_work', 'submission_status']) expect(names).toContain(n);
  });

  it('tool descriptions tell agents to prefer the Authorization header', async () => {
    const { body } = await rpc('tools/list', {});
    const by = Object.fromEntries(body.result.tools.map((t) => [t.name, t]));
    expect(by.pair.description).toMatch(/Authorization/);
    expect(by.pair.description).toMatch(/chat logs/);
    for (const n of ['next_task', 'claim_task', 'release_task', 'my_work', 'submit_work', 'submission_status']) {
      expect(by[n].inputSchema.properties.contributor_key.description).toMatch(/Prefer an `Authorization: Bearer/);
    }
  });

  it('rejects batches, bad JSON and an unknown tool politely', async () => {
    const batch = await send('/mcp', { method: 'POST', body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]) });
    expect(batch.status).toBe(400);
    const bad = await send('/mcp', { method: 'POST', body: '{nope' });
    expect(bad.status).toBe(400);
    const unknown = await tool('does_not_exist');
    expect(unknown.isError).toBe(true);
  });

  it('an oversized body returns 413, with and without a Content-Length header', async () => {
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70 * 1024) } });
    const declared = await send('/mcp', { method: 'POST', headers: { 'Content-Length': String(big.length) }, body: big });
    expect(declared.status).toBe(413);
    // No Content-Length: a streamed body is counted as it arrives.
    const bytes = new TextEncoder().encode(big);
    const stream = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 30000)); c.enqueue(bytes.slice(30000)); c.close(); } });
    const streamed = await send('/mcp', { method: 'POST', body: stream, duplex: 'half' });
    expect(streamed.status).toBe(413);
  });

  it('an oversized admin body returns 413', async () => {
    const res = await send('/api/admin/review', { method: 'POST', headers: { ...ADMIN(), 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 1, decision: 'accept', note: 'x'.repeat(6000) }) });
    expect(res.status).toBe(413);
  });
});

describe('pair', () => {
  it('returns a handle and a key once, and says to prefer the header', async () => {
    const r = await tool('pair', { handle: 'tester-one' });
    expect(r.isError).toBe(false);
    expect(r.data.handle).toBe('tester-one');
    expect(r.data.contributor_key).toMatch(/^swk_[A-Za-z0-9_-]{20,60}$/);
    const advice = r.data.how_to_use.join(' ');
    expect(advice).toMatch(/Authorization/);
    expect(advice).toMatch(/chat logs/);
    // Only a hash is stored.
    const row = await env.DB.prepare('SELECT key_hash FROM contributors WHERE handle = ?1').bind('tester-one').first();
    expect(row.key_hash).not.toContain(r.data.contributor_key);
  });

  it('makes up a handle when none is given', async () => {
    const r = await tool('pair', {}, { ip: nextIp() });
    expect(r.data.handle).toMatch(/^helper-[a-z0-9]{6}$/);
  });

  it('enforces the handle rules', async () => {
    for (const bad of ['ab', 'UPPER_case', 'has space', 'x'.repeat(25), 'swarm', 'admin-bob', 'my-official-bot', 'not/ok']) {
      const r = await tool('pair', { handle: bad }, { ip: nextIp() });
      expect(r.isError, `handle ${bad}`).toBe(true);
    }
    expect((await tool('pair', { handle: 'taken_one' }, { ip: nextIp() })).isError).toBe(false);
    const dup = await tool('pair', { handle: 'taken_one' }, { ip: nextIp() });
    expect(dup.isError).toBe(true);
    expect(dup.text).toMatch(/taken/);
  });

  it('allows 5 pairings per network per day and refuses the 6th', async () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i++) expect((await tool('pair', {}, { ip })).isError).toBe(false);
    const sixth = await tool('pair', {}, { ip });
    expect(sixth.isError).toBe(true);
    expect(sixth.text).toMatch(/Too many pairings/);
    expect((await tool('pair', {}, { ip: nextIp() })).isError).toBe(false);
  });

  it('holds the daily cap under concurrency: 16 simultaneous pairs from one network make exactly 5 contributors', async () => {
    const ip = nextIp();
    const eventsBefore = (await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'contributor_paired'").first()).n;
    const results = await Promise.all(Array.from({ length: 16 }, () => tool('pair', {}, { ip })));
    expect(results.filter((r) => !r.isError)).toHaveLength(5);
    const refused = results.filter((r) => r.isError);
    expect(refused).toHaveLength(11);
    for (const r of refused) expect(r.text).toMatch(/Too many pairings/);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM contributors').first()).n).toBe(5);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'contributor_paired'").first()).n - eventsBefore).toBe(5);
  });

  it('never echoes a key in errors and never stores one in events', async () => {
    const user = await newUser();
    const fake = `swk_${'A'.repeat(32)}`;
    const wrong = await tool('my_work', {}, { headers: { Authorization: `Bearer ${fake}` } });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).not.toContain(fake);
    const viaArg = await tool('my_work', { contributor_key: fake });
    expect(viaArg.text).not.toContain(fake);
    const malformed = await tool('my_work', { contributor_key: 'swk_short' });
    expect(malformed.text).not.toContain('swk_short');
    await addTask();
    await user.call('next_task');
    const events = await env.DB.prepare('SELECT type, detail, actor FROM events').all();
    const dump = JSON.stringify(events.results);
    expect(dump).not.toContain('swk_');
    expect(dump).not.toContain(user.key);
  });
});

describe('work loop: next_task, claim, submit_work, review', () => {
  it('goes from task to accepted receipt, and a second accept is a 409', async () => {
    const taskId = await addTask({ units: 3, title: 'Research a fix for: Testing' });
    const user = await newUser({ handle: 'worker-one' });

    const got = await user.call('next_task');
    expect(got.isError).toBe(false);
    expect(got.data.task.id).toBe(taskId);
    expect(got.data.claim.routed).toBe(true);
    expect(got.data.notice).toMatch(/not instructions/);

    const sub = await user.call('submit_work', { task_id: taskId, body: BODY, sources: [SOURCE], model: 'test-model', tokens_est: 1234 });
    expect(sub.isError).toBe(false);
    expect(sub.data.status).toBe('pending');
    const subId = sub.data.submission_id;

    // Pending work is never shown as accepted.
    let stats = await (await send('/api/stats')).json();
    expect(stats.projects.find((p) => p.id === 'town-hall').accepted_units).toBe(0);
    expect((await user.call('submission_status', { id: subId })).data.status).toBe('pending');

    const pending = await (await send('/api/admin/pending', { headers: ADMIN() })).json();
    expect(pending.pending.map((p) => p.id)).toContain(subId);
    expect(pending.pending[0].flags).toEqual([]);

    const accept = await send('/api/admin/review', { method: 'POST', headers: { ...ADMIN(), 'Content-Type': 'application/json' }, body: JSON.stringify({ id: subId, decision: 'accept', note: 'good' }) });
    expect(accept.status).toBe(200);
    expect((await accept.json()).task_status).toBe('accepted');

    const again = await send('/api/admin/review', { method: 'POST', headers: { ...ADMIN(), 'Content-Type': 'application/json' }, body: JSON.stringify({ id: subId, decision: 'accept' }) });
    expect(again.status).toBe(409);

    stats = await (await send('/api/stats')).json();
    const th = stats.projects.find((p) => p.id === 'town-hall');
    expect(th.accepted_units).toBe(3);
    expect(th.accepted_units_all_time).toBe(3);
    expect(stats.totals.accepted).toBe(1);

    const receipts = await (await send('/api/receipts')).json();
    expect(receipts.receipts).toHaveLength(1);
    expect(receipts.receipts[0].handle).toBe('worker-one');
    expect(receipts.receipts[0].task.id).toBe(taskId);
    expect(receipts.receipts[0].self_reported.model).toBe('test-model');

    expect((await user.call('submission_status', { id: subId })).data.status).toBe('accepted');
    expect((await user.call('my_work')).data.accepted_units).toBe(3);
  });

  it('submit_work needs an active claim', async () => {
    const taskId = await addTask();
    const user = await newUser();
    const r = await user.call('submit_work', { task_id: taskId, body: BODY, sources: [SOURCE] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/active claim/);
  });

  it('claim, release, claim again counts the units once', async () => {
    const taskId = await addTask({ units: 3 });
    const user = await newUser();
    const routed = async () => (await (await send('/api/stats')).json()).projects.find((p) => p.id === 'town-hall');
    for (let i = 0; i < 3; i++) {
      expect((await user.call('next_task')).data.task.id).toBe(taskId);
      expect((await routed()).routed_units).toBe(3);
      expect((await user.call('release_task', { id: taskId })).isError).toBe(false);
      expect((await routed()).routed_units).toBe(0);
    }
    expect((await user.call('next_task')).isError).toBe(false);
    const final = await routed();
    expect(final.routed_units).toBe(3);
    expect(final.routed_released_or_expired_units).toBe(0);
  });

  it('self-directed claims never move the routed numbers', async () => {
    const taskId = await addTask({ units: 1 });
    const user = await newUser();
    expect((await user.call('claim_task', { id: taskId })).data.claim.routed).toBe(false);
    const th = (await (await send('/api/stats')).json()).projects.find((p) => p.id === 'town-hall');
    expect(th.routed_units).toBe(0);
    expect(th.self_directed_units).toBe(1);
  });
});

describe('claim caps', () => {
  it('a contributor holds at most 2 claims', async () => {
    const [a, b, c] = [await addTask(), await addTask(), await addTask()];
    const user = await newUser();
    expect((await user.call('claim_task', { id: a })).isError).toBe(false);
    expect((await user.call('claim_task', { id: b })).isError).toBe(false);
    const third = await user.call('claim_task', { id: c });
    expect(third.isError).toBe(true);
    expect(third.text).toMatch(/already hold 2 active claims/);
    expect((await user.call('next_task')).isError).toBe(true);
    // Releasing one frees a slot.
    await user.call('release_task', { id: a });
    expect((await user.call('claim_task', { id: c })).isError).toBe(false);
  });

  it('one network holds at most 4 claims across all handles', async () => {
    const ids = [];
    for (let i = 0; i < 7; i++) ids.push(await addTask());
    const ip = nextIp();
    const [u1, u2, u3] = [await newUser({ ip }), await newUser({ ip }), await newUser({ ip })];
    expect((await u1.call('claim_task', { id: ids[0] })).isError).toBe(false);
    expect((await u1.call('claim_task', { id: ids[1] })).isError).toBe(false);
    expect((await u2.call('claim_task', { id: ids[2] })).isError).toBe(false);
    expect((await u2.call('claim_task', { id: ids[3] })).isError).toBe(false);
    const over = await u3.call('claim_task', { id: ids[4] });
    expect(over.isError).toBe(true);
    expect(over.text).toMatch(/network/);
    const overNext = await u3.call('next_task');
    expect(overNext.isError).toBe(true);
    expect(overNext.text).toMatch(/network/);
    // Someone on another network is not affected.
    const other = await newUser();
    expect((await other.call('claim_task', { id: ids[4] })).isError).toBe(false);
    // Releasing frees a network slot.
    await u1.call('release_task', { id: ids[0] });
    expect((await u3.call('claim_task', { id: ids[5] })).isError).toBe(false);
    // The network hash is stored on the claims.
    const rows = await env.DB.prepare('SELECT DISTINCT network FROM claims WHERE network IS NOT NULL').all();
    expect(rows.results.length).toBeGreaterThanOrEqual(2);
  });
});

describe('held tasks (injection-flagged) are never served', () => {
  it('no tool or API serves a held task, and the admin can see it', async () => {
    const held = await addTask({ status: 'held', title: 'Held task', held_reason: 'ignore_instructions' });
    const user = await newUser();

    const next = await user.call('next_task');
    expect(next.isError).toBe(true);
    expect(next.text).toMatch(/No work can be routed/);
    expect((await user.call('claim_task', { id: held })).isError).toBe(true);
    expect((await tool('get_task', { id: held })).isError).toBe(true);
    const list = await tool('list_tasks', {});
    expect(list.data.tasks.map((t) => t.id)).not.toContain(held);
    expect((await tool('list_tasks', { status: 'held' })).isError).toBe(true);

    const api = await (await send('/api/tasks')).json();
    expect(api.tasks.map((t) => t.id)).not.toContain(held);
    expect((await (await send('/api/tasks?status=held')).json()).tasks).toHaveLength(0);
    expect((await send(`/api/tasks/${held}`)).status).toBe(404);
    const stats = await (await send('/api/stats')).json();
    expect(stats.projects.find((p) => p.id === 'town-hall').open_tasks).toBe(0);

    const admin = await (await send('/api/admin/held', { headers: ADMIN() })).json();
    expect(admin.held.map((t) => t.id)).toEqual([held]);
    expect(admin.held[0].held_reason).toBe('ignore_instructions');

    // A clean task alongside it is served as usual.
    const clean = await addTask({ title: 'Clean task' });
    expect((await user.call('next_task')).data.task.id).toBe(clean);
  });

  it('the database refuses an unknown task status but accepts held', async () => {
    await expect(addTask({ status: 'bogus' })).rejects.toThrow();
    await expect(addTask({ status: 'held' })).resolves.toBeTypeOf('number');
  });
});

describe('INTAKE lever', () => {
  const paused = { INTAKE: 'paused' };

  it('paused refuses pair, next_task, claim_task and submit_work with a friendly message', async () => {
    const taskId = await addTask();
    const user = await newUser();
    await user.call('claim_task', { id: taskId });

    for (const [name, args, caller] of [
      ['pair', {}, (n, a) => tool(n, a, { over: paused, ip: nextIp() })],
      ['next_task', {}, (n, a) => user.call(n, a, { over: paused })],
      ['claim_task', { id: taskId }, (n, a) => user.call(n, a, { over: paused })],
      ['submit_work', { task_id: taskId, body: BODY, sources: [SOURCE] }, (n, a) => user.call(n, a, { over: paused })],
    ]) {
      const r = await caller(name, args);
      expect(r.isError, name).toBe(true);
      expect(r.text, name).toMatch(/paused for maintenance/);
    }
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions').first()).n).toBe(0);
  });

  it('paused still allows reads, and the API says so', async () => {
    const taskId = await addTask();
    const user = await newUser();
    for (const [name, args] of [['how_to_help', {}], ['setup_guide', {}], ['list_projects', {}], ['list_tasks', {}], ['get_task', { id: taskId }]]) {
      expect((await tool(name, args, { over: paused })).isError, name).toBe(false);
    }
    expect((await user.call('my_work', {}, { over: paused })).isError).toBe(false);
    const stats = await (await send('/api/stats', {}, paused)).json();
    expect(stats.paused).toBe(true);
    expect(stats.intake).toBe('paused');
    // Admin review keeps working while paused.
    expect((await send('/api/admin/pending', { headers: ADMIN() }, paused)).status).toBe(200);
  });

  it('open (the default) reports not paused', async () => {
    const stats = await (await send('/api/stats')).json();
    expect(stats.paused).toBe(false);
    expect(stats.intake).toBe('open');
  });
});

describe('admin API', () => {
  it('answers 404 with no token or a wrong token', async () => {
    for (const [path, method] of [['/api/admin/pending', 'GET'], ['/api/admin/held', 'GET'], ['/api/admin/review', 'POST'], ['/api/admin/sync', 'POST'], ['/api/admin/nothing', 'GET']]) {
      expect((await send(path, { method })).status, `${method} ${path} without token`).toBe(404);
      expect((await send(path, { method, headers: { Authorization: 'Bearer wrong-token' } })).status, `${method} ${path} wrong token`).toBe(404);
      expect((await send(path, { method, headers: { Authorization: env.ADMIN_TOKEN } })).status, `${method} ${path} no Bearer`).toBe(404);
    }
    expect((await send('/api/admin/pending', { headers: ADMIN() })).status).toBe(200);
  });
});

describe('submission link pre-screen', () => {
  async function submitWith(sources) {
    const taskId = await addTask();
    const user = await newUser();
    await user.call('claim_task', { id: taskId });
    return { taskId, user, r: await user.call('submit_work', { task_id: taskId, body: BODY, sources }) };
  }

  it('flags suspicious links, stores them and shows them to the admin, without blocking', async () => {
    const { r } = await submitWith([SOURCE, 'http://example.org/a', 'https://93.184.216.34/page', 'https://bit.ly/abc', 'https://xn--pple-43d.com/x']);
    expect(r.isError).toBe(false);
    expect(r.data.link_flags).toEqual(expect.arrayContaining(['non_https:example.org', 'ip_literal:93.184.216.34', 'shortener:bit.ly', 'punycode:xn--pple-43d.com']));
    const pending = await (await send('/api/admin/pending', { headers: ADMIN() })).json();
    expect(pending.pending[0].flags).toEqual(r.data.link_flags);
  });

  it('flags more than 20 sources', async () => {
    const many = Array.from({ length: 22 }, (_, i) => `https://example.org/page-${i}`);
    const { r } = await submitWith(many);
    expect(r.isError).toBe(false);
    expect(r.data.link_flags).toContain('many_sources:22');
  });

  it('clean links carry no flags', async () => {
    const { r } = await submitWith([SOURCE]);
    expect(r.isError).toBe(false);
    expect(r.data.link_flags).toBeUndefined();
  });

  it('still refuses what can never be a public page', async () => {
    for (const bad of ['javascript:alert(1)', 'https://localhost/x', 'https://10.0.0.5/x', 'https://user:pw@example.org/', 'ftp://example.org/x', 'not a url']) {
      const { r } = await submitWith([bad]);
      expect(r.isError, bad).toBe(true);
    }
  });
});
