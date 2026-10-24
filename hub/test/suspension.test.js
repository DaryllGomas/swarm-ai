// Voter suspension policy: scope 'all' stops the account's vote AND its AI's work; scope 'vote' stops only the vote. The operator
// acts without the console ever showing an account or which contributor it belongs to. Nothing here depends on the date or weekday.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { BODY, SOURCE, addTask, newUser, resetDb, review, send } from './helpers.js';
import { accessFixture } from './access-helpers.js';
import { gate, wrapDb } from './fault.js';
import { linkedUser, meGet, mePost, newCode, setupProjects, voter } from './voter.js';
import { connect, mcpTool, o, OVER, ORIGIN } from './oauth-helpers.js';
import { WORK_SUSPENDED_MESSAGE } from '../src/suspension.js';

let BASE = 0;
beforeEach(async () => { await resetDb(); await setupProjects(); await env.DB.prepare('UPDATE accounts SET suspended = 0, suspend_scope = NULL, suspend_ref = NULL, suspended_at = NULL').run(); BASE = (await one('SELECT COALESCE(MAX(id), 0) AS m FROM events')).m; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const signedIn = async (v) => (await (await meGet(v)).json()).signed_in;
const putBallot = (v) => send('/api/ballot', { method: 'PUT', headers: { Cookie: v.cookie, Origin: ORIGIN, 'X-Swarm': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ allocations: { 'town-hall': 50, 'swarm-ai': 50 } }) }, OVER);
const one = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const n = async (sql, ...b) => (await one(sql, ...b)).n;
const REASON = 'Repeated abuse signals, see appeal ticket';
const suspendRaw = (id, scope) => env.DB.prepare("UPDATE accounts SET suspended = 1, suspend_scope = ?2, suspend_ref = lower(hex(randomblob(4))), suspended_at = ?3 WHERE id = ?1").bind(id, scope, Date.now()).run();
const lift = (id) => env.DB.prepare('UPDATE accounts SET suspended = 0, suspend_scope = NULL, suspend_ref = NULL, suspended_at = NULL WHERE id = ?1').bind(id).run();
const cid = async (handle) => (await one('SELECT id FROM contributors WHERE handle = ?1', handle)).id;
const refresh = (c, token) => o('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '198.18.0.9' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: c.client.client_id }) }).then(async (r) => ({ status: r.status, data: await r.json() }));

describe('scope all: the AI of a suspended account cannot take or hand in work', () => {
  it('a swk_ key linked to the account: next_task, claim_task and submit_work refused; read tools, release and pending review stay', async () => {
    const v = await voter(), ai = await linkedUser(v, { handle: 'linked-ai' });
    const held = await addTask(), pendingTask = await addTask(), free = await addTask();
    await ai.call('claim_task', { id: held });
    await ai.call('claim_task', { id: pendingTask });
    const sub = await ai.call('submit_work', { task_id: pendingTask, body: BODY, sources: [SOURCE] });
    expect(sub.isError).toBe(false);
    await suspendRaw(v.id, 'all');
    for (const [tool, args] of [['next_task', {}], ['claim_task', { id: free }], ['submit_work', { task_id: held, body: BODY, sources: [SOURCE] }]]) {
      const r = await ai.call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(r.text, tool).toBe(WORK_SUSPENDED_MESSAGE);
    }
    expect(await n('SELECT COUNT(*) AS n FROM claims WHERE task = ?1', free)).toBe(0);
    expect(await n('SELECT COUNT(*) AS n FROM submissions WHERE task = ?1', held)).toBe(0);
    expect((await ai.call('my_work')).isError).toBe(false);
    expect((await ai.call('my_week')).isError).toBe(false);
    expect((await ai.call('submission_status', { id: sub.data.submission_id })).data.status).toBe('pending');
    expect((await ai.call('release_task', { id: held })).isError).toBe(false);
    // The pending submission stays for the reviewer, who can still accept it.
    expect((await review(sub.data.submission_id, 'accept', 'Checked the sources')).status).toBe(200);
    expect((await ai.call('submission_status', { id: sub.data.submission_id })).data.status).toBe('accepted');
    expect(await signedIn(v)).toBe(false); // and the account can no longer vote or sign in
  });

  it('a contributor the account owns through OAuth: the token reads but cannot claim or submit, and cannot be refreshed', async () => {
    const v = await voter({ allocations: null });
    const c = await connect({ mode: 'passkey', cookie: v.cookie, chosen_handle: 'oauth-owned' });
    expect(c.token).toBeTruthy();
    const task = await addTask(), other = await addTask();
    expect((await mcpTool(c.token, 'claim_task', { id: task })).isError).toBe(false);
    await suspendRaw(v.id, 'all');
    const claim = await mcpTool(c.token, 'claim_task', { id: other });
    expect(claim.isError).toBe(true); expect(claim.text).toBe(WORK_SUSPENDED_MESSAGE);
    expect((await mcpTool(c.token, 'next_task')).text).toBe(WORK_SUSPENDED_MESSAGE);
    expect((await mcpTool(c.token, 'submit_work', { task_id: task, body: BODY, sources: [SOURCE] })).text).toBe(WORK_SUSPENDED_MESSAGE);
    expect((await mcpTool(c.token, 'my_work')).isError).toBe(false); // read stays open
    expect(await n('SELECT COUNT(*) AS n FROM submissions')).toBe(0);
    const r = await refresh(c, c.refresh);
    expect(r.status).toBe(400); expect(r.data.error).toBe('invalid_grant');
    // Lifting it restores the same token and the same refresh token: nothing was revoked.
    await lift(v.id);
    expect((await mcpTool(c.token, 'submit_work', { task_id: task, body: BODY, sources: [SOURCE] })).isError).toBe(false);
    expect((await refresh(c, c.refresh)).status).toBe(200);
  });

  it('an OAuth contributor with no owner that is linked to the account is stopped too, and an unrelated contributor is not', async () => {
    const v = await voter({ allocations: null });
    const c = await connect({ mode: 'handle' });
    const code = await newCode(v);
    expect((await mcpTool(c.token, 'link_account', { code })).isError).toBe(false);
    const stranger = await newUser();
    await suspendRaw(v.id, 'all');
    const t = await addTask(), t2 = await addTask();
    expect((await mcpTool(c.token, 'claim_task', { id: t })).text).toBe(WORK_SUSPENDED_MESSAGE);
    expect((await stranger.call('claim_task', { id: t })).isError).toBe(false);
    expect((await stranger.call('next_task')).isError).toBe(t2 === 0);
  });

  it('a suspended account cannot finish an OAuth connection for its contributor', async () => {
    const v = await voter({ allocations: null });
    await connect({ mode: 'passkey', cookie: v.cookie, chosen_handle: 'would-reconnect' });
    await suspendRaw(v.id, 'all');
    const second = await connect({ mode: 'passkey', cookie: v.cookie, chosen_handle: 'would-reconnect' });
    expect(second.token).toBeFalsy();
  });

  it('unsuspend restores everything without changing data', async () => {
    const v = await voter(), ai = await linkedUser(v, { handle: 'linked-ai' });
    const a = await addTask(), b = await addTask();
    await ai.call('claim_task', { id: a });
    const snapshot = async () => JSON.stringify([
      (await env.DB.prepare('SELECT * FROM contributors ORDER BY id').all()).results, (await env.DB.prepare('SELECT * FROM claims ORDER BY id').all()).results,
      (await env.DB.prepare('SELECT * FROM submissions ORDER BY id').all()).results, (await env.DB.prepare('SELECT * FROM ballot_versions ORDER BY account, version').all()).results,
      (await env.DB.prepare('SELECT * FROM account_links').all()).results, (await env.DB.prepare('SELECT * FROM oauth_grants').all()).results,
    ]);
    const before = await snapshot();
    const ops = await accessFixture();
    const s = await (await ops.post('suspend', { scope: 'all', account: v.id.slice(0, 10), reason: REASON })).json();
    expect((await ai.call('claim_task', { id: b })).isError).toBe(true);
    expect(await snapshot()).toBe(before);
    expect((await ops.post('unsuspend', { ref: s.ref, reason: 'Appeal upheld' })).status).toBe(200);
    expect(await snapshot()).toBe(before);
    expect((await ai.call('claim_task', { id: b })).isError).toBe(false);
    expect((await ai.call('submit_work', { task_id: a, body: BODY, sources: [SOURCE] })).isError).toBe(false);
    expect(await signedIn(v)).toBe(true);
  });
});

describe('scope vote: today\'s behaviour', () => {
  it('the ballot stops counting and the account cannot sign in, but the linked AI keeps working', async () => {
    const v = await voter(), ai = await linkedUser(v, { handle: 'linked-ai' });
    await suspendRaw(v.id, 'vote');
    expect(await signedIn(v)).toBe(false);
    expect((await putBallot(v)).status).toBe(401);
    expect(await n('SELECT COUNT(*) AS n FROM accounts a WHERE a.suspended = 0 AND a.id = ?1', v.id)).toBe(0); // the snapshot's eligibility test (src/voting.js) excludes it
    const t = await addTask(), t2 = await addTask();
    expect((await ai.call('claim_task', { id: t })).isError).toBe(false);
    expect((await ai.call('next_task')).isError).toBe(false);
    expect((await ai.call('submit_work', { task_id: t, body: BODY, sources: [SOURCE] })).isError).toBe(false);
    expect(t2).toBeTruthy();
  });
  it('a legacy suspended row with no scope behaves as vote only', async () => {
    const v = await voter(), ai = await linkedUser(v, { handle: 'linked-ai' });
    await env.DB.prepare('UPDATE accounts SET suspended = 1 WHERE id = ?1').bind(v.id).run();
    const t = await addTask();
    expect((await ai.call('claim_task', { id: t })).isError).toBe(false);
    expect(await signedIn(v)).toBe(false);
  });
  it('the OAuth token of a vote-suspended account keeps working for work', async () => {
    const v = await voter({ allocations: null });
    const c = await connect({ mode: 'passkey', cookie: v.cookie, chosen_handle: 'oauth-vote' });
    await suspendRaw(v.id, 'vote');
    const t = await addTask();
    expect((await mcpTool(c.token, 'claim_task', { id: t })).isError).toBe(false);
    expect((await refresh(c, c.refresh)).status).toBe(200);
  });
});

describe('races: a suspension that lands between the read and the write', () => {
  // The key is read, then the suspension lands, then the write runs. The write must fail on its own.
  const afterAuth = (g, extra) => wrapDb(env.DB, { afterRead: async (sql) => { if (/FROM contributors WHERE key_hash = \?1/.test(sql)) { await g.hit(); } extra?.(sql); } });

  it('claim: suspended after authentication, before the claim insert: no claim, no task change, no event', async () => {
    const v = await voter(), ai = await linkedUser(v, { handle: 'racer' });
    const t = await addTask();
    const g = gate();
    const parked = ai.call('claim_task', { id: t }, { over: { DB: afterAuth(g) } });
    await g.reached;
    await suspendRaw(v.id, 'all');
    g.open();
    const r = await parked;
    expect(r.isError).toBe(true); expect(r.text).toBe(WORK_SUSPENDED_MESSAGE);
    expect(await n('SELECT COUNT(*) AS n FROM claims WHERE task = ?1', t)).toBe(0);
    expect((await one('SELECT status FROM tasks WHERE id = ?1', t)).status).toBe('ready');
    expect(await n("SELECT COUNT(*) AS n FROM events WHERE id > ?1 AND type = 'task_claimed'", BASE)).toBe(0);
  });

  it('next_task: suspended after authentication: nothing claimed', async () => {
    const v = await voter(), ai = await linkedUser(v, { handle: 'racer2' });
    await addTask();
    const g = gate();
    const parked = ai.call('next_task', {}, { over: { DB: afterAuth(g) } });
    await g.reached; await suspendRaw(v.id, 'all'); g.open();
    expect((await parked).isError).toBe(true);
    expect(await n('SELECT COUNT(*) AS n FROM claims')).toBe(0);
  });

  it('submit: suspended after authentication, before the submission insert: no submission, the claim stays', async () => {
    const v = await voter(), ai = await linkedUser(v, { handle: 'racer3' });
    const t = await addTask();
    await ai.call('claim_task', { id: t });
    const g = gate();
    const parked = ai.call('submit_work', { task_id: t, body: BODY, sources: [SOURCE] }, { over: { DB: afterAuth(g) } });
    await g.reached; await suspendRaw(v.id, 'all'); g.open();
    const r = await parked;
    expect(r.isError).toBe(true); expect(r.text).toBe(WORK_SUSPENDED_MESSAGE);
    expect(await n('SELECT COUNT(*) AS n FROM submissions')).toBe(0);
    expect((await one('SELECT outcome FROM claims WHERE task = ?1', t)).outcome).toBeNull();
    expect((await one('SELECT status FROM tasks WHERE id = ?1', t)).status).toBe('claimed');
  });

  it('OAuth: suspended after the token was resolved: the claim and the submission are both refused', async () => {
    const v = await voter({ allocations: null });
    const c = await connect({ mode: 'passkey', cookie: v.cookie, chosen_handle: 'oauth-racer' });
    const t = await addTask(), t2 = await addTask();
    await mcpTool(c.token, 'claim_task', { id: t });
    for (const [tool, args, check] of [
      ['claim_task', { id: t2 }, () => n('SELECT COUNT(*) AS n FROM claims WHERE task = ?1', t2)],
      ['submit_work', { task_id: t, body: BODY, sources: [SOURCE] }, () => n('SELECT COUNT(*) AS n FROM submissions')],
    ]) {
      await lift(v.id);
      const g = gate();
      const db = wrapDb(env.DB, { afterRead: async (sql) => { if (/FROM oauth_tokens t JOIN oauth_grants g/.test(sql)) await g.hit(); } });
      const { rpc } = await import('./helpers.js');
      const parked = rpc('tools/call', { name: tool, arguments: args }, { headers: { Authorization: `Bearer ${c.token}` }, over: { ...OVER, DB: db } });
      await g.reached; await suspendRaw(v.id, 'all'); g.open();
      const { body } = await parked;
      expect(body.result?.isError ?? !!body.error, tool).toBe(true);
      expect(await check(), tool).toBe(0);
    }
  });

  it('refresh: suspended after the refresh token was read: no new tokens', async () => {
    const v = await voter({ allocations: null });
    const c = await connect({ mode: 'passkey', cookie: v.cookie, chosen_handle: 'oauth-refresh-racer' });
    const before = await n('SELECT COUNT(*) AS n FROM oauth_tokens');
    const g = gate();
    const db = wrapDb(env.DB, { afterRead: async (sql) => { if (/FROM oauth_tokens/.test(sql)) await g.hit(); } });
    const parked = o('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '198.18.0.10' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.client.client_id }) }, { DB: db });
    await g.reached; await suspendRaw(v.id, 'all'); g.open();
    expect((await parked).status).toBe(400);
    expect(await n('SELECT COUNT(*) AS n FROM oauth_tokens')).toBe(before);
  });

  it('scope vote: the same race does not stop the work', async () => {
    const v = await voter(), ai = await linkedUser(v, { handle: 'racer4' });
    const t = await addTask();
    const g = gate();
    const parked = ai.call('claim_task', { id: t }, { over: { DB: afterAuth(g) } });
    await g.reached; await suspendRaw(v.id, 'vote'); g.open();
    expect((await parked).isError).toBe(false);
  });
});

describe('operator actions', () => {
  it('suspend by short account id: needs scope and a written reason, returns only a handle, writes a detail-free event', async () => {
    const a = await accessFixture(), v = await voter(), other = await voter();
    for (const body of [{ account: v.id.slice(0, 8), reason: REASON }, { scope: 'x', account: v.id.slice(0, 8), reason: REASON },
      { scope: 'all', account: v.id.slice(0, 8) }, { scope: 'all', account: v.id.slice(0, 8), reason: '  ' }, { scope: 'all', account: v.id.slice(0, 8), reason: 'x'.repeat(301) },
      { scope: 'all', reason: REASON }, { scope: 'all', account: 'short', reason: REASON }, { scope: 'all', contributor_id: 0, reason: REASON }]) expect((await a.post('suspend', body)).status).toBe(400);
    expect((await a.post('suspend', { scope: 'all', account: 'zzzzzzzzzz', reason: REASON })).status).toBe(404);
    const res = await a.post('suspend', { scope: 'all', account: v.id.slice(0, 8), reason: REASON });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ref).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(body)).not.toContain(v.id.slice(0, 6));
    expect(await one('SELECT suspended, suspend_scope FROM accounts WHERE id = ?1', v.id)).toEqual({ suspended: 1, suspend_scope: 'all' });
    expect((await one('SELECT suspended FROM accounts WHERE id = ?1', other.id)).suspended).toBe(0);
    const e = await one("SELECT * FROM events WHERE id > ?1 AND type = 'account_suspended'", BASE);
    expect(e).toMatchObject({ contributor: null, task: null, submission: null, actor: 'owner@example.com' });
    expect(JSON.parse(e.detail)).toEqual({ scope: 'all', reason: REASON, ref: body.ref, op: expect.any(String) });
    expect(JSON.stringify(e)).not.toContain(v.id.slice(0, 6));
    // Repeating the same suspension changes nothing and writes no second event.
    expect(await (await a.post('suspend', { scope: 'all', account: v.id.slice(0, 8), reason: REASON })).json()).toEqual({ ok: true, ref: body.ref, unchanged: true });
    expect(await n("SELECT COUNT(*) AS n FROM events WHERE id > ?1 AND type = 'account_suspended'", BASE)).toBe(1);
  });

  it('an account id prefix that fits two accounts changes nothing', async () => {
    const a = await accessFixture(), v = 1, w = 1;
    expect(v && w).toBeTruthy();
    await env.DB.batch(['AAAAAAAA1x', 'AAAAAAAA2x'].map((id) => env.DB.prepare('INSERT INTO accounts(id,created,suspended,network) VALUES (?1,?2,0,?1)').bind(id, Date.now())));
    expect((await a.post('suspend', { scope: 'vote', account: 'AAAAAAAA', reason: REASON })).status).toBe(404);
    expect(await n('SELECT COUNT(*) AS n FROM accounts WHERE suspended = 1')).toBe(0);
  });

  it('suspend by contributor row: same answer whether or not it has an account, and the owner is the one suspended', async () => {
    const a = await accessFixture(), v = await voter({ allocations: null });
    await connect({ mode: 'passkey', cookie: v.cookie, chosen_handle: 'owned-one' });
    const linked = await linkedUser(await voter(), { handle: 'linked-one' });
    const loner = await newUser({ handle: 'no-account' });
    const answers = [];
    for (const handle of ['owned-one', 'linked-one', 'no-account']) {
      const r = await a.post('suspend', { scope: 'vote', contributor_id: await cid(handle), reason: REASON });
      answers.push([r.status, await r.text()]);
    }
    expect(new Set(answers.map((x) => JSON.stringify(x))).size).toBe(1);
    expect(answers[0][0]).toBe(200);
    expect(await n('SELECT COUNT(*) AS n FROM accounts WHERE suspended = 1')).toBe(2);
    expect((await a.post('suspend', { scope: 'vote', contributor_id: 999999, reason: REASON })).status).toBe(404);
    expect(linked && loner).toBeTruthy();
  });

  it('scope can be raised from vote to all and keeps its handle; unsuspend by handle needs a reason and works once', async () => {
    const a = await accessFixture(), v = await voter();
    const first = await (await a.post('suspend', { scope: 'vote', account: v.id.slice(0, 8), reason: REASON })).json();
    const second = await (await a.post('suspend', { scope: 'all', account: v.id.slice(0, 8), reason: REASON })).json();
    expect(second.ref).toBe(first.ref);
    expect((await one('SELECT suspend_scope FROM accounts WHERE id = ?1', v.id)).suspend_scope).toBe('all');
    expect(await n("SELECT COUNT(*) AS n FROM events WHERE id > ?1 AND type = 'account_suspended'", BASE)).toBe(2);
    for (const body of [{ ref: first.ref }, { ref: first.ref, reason: ' ' }, { reason: 'ok ok ok' }, { ref: 'nothex', reason: 'ok ok ok' }]) expect((await a.post('unsuspend', body)).status).toBe(400);
    expect((await a.post('unsuspend', { ref: 'ffffffff', reason: 'Appeal upheld' })).status).toBe(404);
    expect((await a.post('unsuspend', { ref: first.ref, reason: 'Appeal upheld' })).status).toBe(200);
    expect(await one('SELECT suspended, suspend_scope, suspend_ref, suspended_at FROM accounts WHERE id = ?1', v.id)).toEqual({ suspended: 0, suspend_scope: null, suspend_ref: null, suspended_at: null });
    const e = await one("SELECT * FROM events WHERE id > ?1 AND type = 'account_unsuspended'", BASE);
    expect(JSON.parse(e.detail)).toMatchObject({ scope: 'all', reason: 'Appeal upheld', ref: first.ref });
    expect(e.contributor).toBeNull();
    expect((await a.post('unsuspend', { ref: first.ref, reason: 'Appeal upheld' })).status).toBe(404);
    expect(await signedIn(v)).toBe(true);
  });

  it('an audit failure rolls the suspension back', async () => {
    const a = await accessFixture(), v = await voter();
    const db = wrapDb(env.DB, { failBatchAt: 1 });
    expect((await a.post('suspend', { scope: 'all', account: v.id.slice(0, 8), reason: REASON }, { DB: db })).status).toBe(500);
    expect((await one('SELECT suspended FROM accounts WHERE id = ?1', v.id)).suspended).toBe(0);
  });

  it('is hidden without Access and enforces the Origin and CSRF header like every other write', async () => {
    const a = await accessFixture();
    for (const path of ['suspend', 'unsuspend']) {
      expect((await send(`/api/ops/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://swarm.bigpicsolutions.com', 'X-Swarm-Ops': '1' }, body: '{}' })).status).toBe(404);
      for (const headers of [{ Origin: '' }, { Origin: 'https://evil.example' }, { 'X-Swarm-Ops': '' }]) expect((await a.post(path, {}, {}, headers)).status).toBe(404);
      expect((await a.post(path, [], {})).status).toBe(400);
      expect((await a.post(path, { text: 'x'.repeat(5000) })).status).toBe(413);
    }
    expect((await send('/api/ops/suspensions')).status).toBe(404);
  });
});

describe('the operator view leaks no ballot, voter-to-contributor link or network hash', () => {
  const FORBIDDEN = ['network', 'pair_ip', 'owner_account', 'account', 'account_id', 'allocations', 'ballot', 'ballots', 'voter', 'voter_id', 'research_id', 'link', 'linked_account'];
  const keys = (x, out = []) => { if (Array.isArray(x)) x.forEach((i) => keys(i, out)); else if (x && typeof x === 'object') for (const [k, val] of Object.entries(x)) { out.push(k); keys(val, out); } return out; };

  it('every console response after suspending by account and by contributor', async () => {
    const a = await accessFixture();
    const v = await voter({ allocations: { 'town-hall': 37, 'swarm-ai': 63 } }), ai = await linkedUser(v, { handle: 'secretly-linked' });
    const owned = await voter({ allocations: null });
    await connect({ mode: 'passkey', cookie: owned.cookie, chosen_handle: 'secretly-owned' });
    const t = await addTask(); await ai.call('claim_task', { id: t });
    await ai.call('submit_work', { task_id: t, body: BODY, sources: [SOURCE] });
    const s1 = await a.post('suspend', { scope: 'all', account: v.id.slice(0, 8), reason: REASON });
    const s2 = await a.post('suspend', { scope: 'vote', contributor_id: await cid('secretly-owned'), reason: REASON });
    const responses = [s1, s2];
    for (const path of ['overview', 'pending', 'held', 'projects', 'audit', 'suspensions']) responses.push(await a.get(path));
    const list = await (await a.get('suspensions')).json();
    expect(list.suspensions).toHaveLength(2);
    for (const row of list.suspensions) expect(Object.keys(row).sort()).toEqual(['reason', 'ref', 'scope', 'since']);
    expect(list.suspensions.map((r) => r.scope).sort()).toEqual(['all', 'vote']);
    const secrets = [v.id, v.id.slice(0, 6), owned.id, owned.id.slice(0, 6), v.cookie.split('=')[1], '"swarm-ai":63', 'swarm-ai\\":63'];
    for (const r of responses) {
      const text = await r.text();
      for (const sec of secrets) expect(text, `${r.url} leaks ${sec.slice(0, 8)}`).not.toContain(sec);
      let parsed = null; try { parsed = JSON.parse(text); } catch { /* not json */ }
      for (const k of keys(parsed)) expect(FORBIDDEN.includes(k), `forbidden field ${k}`).toBe(false);
      expect(text).not.toMatch(/"(?:network|pair_ip|owner_account|network_day)"/);
    }
    // The suspension events never carry a contributor or a handle either.
    const events = (await (await a.get('audit')).json()).events.filter((e) => e.id > BASE && e.type === 'account_suspended');
    expect(events).toHaveLength(2);
    for (const e of events) { expect(e.contributor).toBeNull(); expect(e.detail).not.toMatch(/secretly/); }
    // The suspension handle is random: it is not a piece of either account's id.
    for (const row of list.suspensions) for (const id of [v.id, owned.id]) expect(id.includes(row.ref)).toBe(false);
  });
});
