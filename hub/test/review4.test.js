// Regressions for Codex's fourth security review (2026-10-20): contributor ownership versus the steering link (finding 1),
// atomic link-code attempt reservation (finding 5) and the network limit on GET /authorize (finding 6). Finding 4 (an unrelated
// merged pull request) is in github.test.js. Findings 2 and 3 are inside @cloudflare/workers-oauth-provider and are recorded as
// blockers for turning OAuth on in docs/PLAN.md.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { BODY, SOURCE, addTask, newUser, nextIp, resetDb } from './helpers.js';
import { connect, mcpTool, openConsent, pkce, registerClient, o, authorizeUrl } from './oauth-helpers.js';
import { newCode, setupProjects, voter } from './voter.js';
import { gate, rendezvous, wrapDb } from './fault.js';
import { ipHashFor } from '../src/lib.js';

beforeEach(async () => {
  await resetDb();
  await setupProjects();
});

const ownerOf = (handle) => env.DB.prepare('SELECT owner_account FROM contributors WHERE handle = ?1').bind(handle).first().then((r) => r?.owner_account ?? null);
const linkRows = () => env.DB.prepare('SELECT l.account, c.handle FROM account_links l JOIN contributors c ON c.id = l.contributor ORDER BY c.id').all().then((r) => r.results);

describe('finding 1: ownership is separate from the steering link', () => {
  it('the exact attack: a work-scoped grant cannot move the victim contributor to the attacker account and mint a submit grant', async () => {
    await addTask();
    const victim = await voter(), attacker = await voter();
    // The victim signs in with a passkey and gives a client read + work, expressly NOT submit.
    const c = await connect({ mode: 'passkey', cookie: victim.cookie, chosen_handle: 'victim-identity', grant: ['read', 'work'] });
    expect(await ownerOf('victim-identity')).toBe(victim.id);
    const got = await mcpTool(c.token, 'next_task');
    expect(got.isError, got.text).toBe(false);
    expect((await mcpTool(c.token, 'submit_work', { task_id: got.data.task.id, body: BODY, sources: [SOURCE] })).res.status).toBe(403);

    // The attacker makes a link code from their own account and redeems it with the victim's work-scoped token.
    const code = await newCode(attacker);
    const link = await mcpTool(c.token, 'link_account', { code });
    expect(link.isError).toBe(true);
    expect(link.text).toMatch(/already belongs to a different Swarm account/);
    expect(await linkRows()).toEqual([{ account: victim.id, handle: 'victim-identity' }]); // the victim's link is untouched
    expect(await ownerOf('victim-identity')).toBe(victim.id);

    // The attacker's own passkey authorization acts for the attacker's own contributor, never the victim's.
    const a = await connect({ mode: 'passkey', cookie: attacker.cookie, chosen_handle: 'attacker-ai' });
    expect((await mcpTool(a.token, 'my_work')).data.handle).toBe('attacker-ai');
    expect(await ownerOf('attacker-ai')).toBe(attacker.id);
    // The victim's task is still the victim's: the attacker's full grant cannot submit it.
    const mine = await mcpTool(a.token, 'submit_work', { task_id: got.data.task.id, body: BODY, sources: [SOURCE] });
    expect(mine.isError).toBe(true);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions').first()).n).toBe(0);
  });

  it('passkey sign-in only acts for a contributor the signed-in account OWNS, even when a steering link points elsewhere', async () => {
    const a = await voter(), b = await voter();
    const owned = await newUser();
    expect((await owned.call('link_account', { code: await newCode(a) })).isError).toBe(false);
    expect(await ownerOf(owned.handle)).toBe(a.id);
    // Force b's steering link onto a's contributor, the way the old code could (a direct write, bypassing the guarded paths).
    await env.DB.prepare('DELETE FROM account_links').run();
    await env.DB.prepare("INSERT INTO account_links (account, contributor, linked_at, via) SELECT ?1, id, ?3, 'code' FROM contributors WHERE handle = ?2").bind(b.id, owned.handle, Date.now()).run();
    const c = await connect({ mode: 'passkey', cookie: b.cookie, chosen_handle: 'b-identity' });
    expect((await mcpTool(c.token, 'my_work')).data.handle).toBe('b-identity'); // b got its own contributor, not a's
  });

  it('pseudonymous contributors: the first account to link one owns it; a second account is refused, and a limited connection cannot claim it', async () => {
    const first = await voter(), second = await voter();
    // A pseudonymous OAuth connection (handle mode) with work only: it must not be able to hand its contributor to an account.
    const limited = await connect({ mode: 'handle', chosen_handle: 'pseudo-ai', grant: ['read', 'work'] });
    expect(await ownerOf('pseudo-ai')).toBeNull();
    const refused = await mcpTool(limited.token, 'link_account', { code: await newCode(first) });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/every permission/);
    expect(await ownerOf('pseudo-ai')).toBeNull();
    // A full grant (nothing withheld) may link it: now the first account owns it.
    const full = await connect({ mode: 'handle', chosen_handle: 'pseudo-full', grant: ['read', 'work', 'submit'] });
    expect((await mcpTool(full.token, 'link_account', { code: await newCode(first) })).isError).toBe(false);
    expect(await ownerOf('pseudo-full')).toBe(first.id);
    const stolen = await mcpTool(full.token, 'link_account', { code: await newCode(second) });
    expect(stolen.isError).toBe(true);
    expect(stolen.text).toMatch(/already belongs to a different Swarm account/);
    expect(await ownerOf('pseudo-full')).toBe(first.id);
    // A contributor-key holder links an unowned contributor the usual way.
    const keyed = await newUser();
    expect((await keyed.call('link_account', { code: await newCode(second) })).isError).toBe(false);
    expect(await ownerOf(keyed.handle)).toBe(second.id);
  });

  it('relinking to the SAME owner is allowed and never widens a limited client\'s scopes', async () => {
    await addTask();
    const v = await voter();
    const c = await connect({ mode: 'passkey', cookie: v.cookie, chosen_handle: 'limited-ai', grant: ['read', 'work'] });
    const again = await mcpTool(c.token, 'link_account', { code: await newCode(v) }); // the owner's own code
    expect(again.isError, again.text).toBe(false);
    const got = await mcpTool(c.token, 'next_task');
    expect(got.isError, got.text).toBe(false);
    // Still read + work only, both for the existing token and for a refreshed or new one for the same account (scopes come from consent).
    expect((await mcpTool(c.token, 'submit_work', { task_id: got.data.task.id, body: BODY, sources: [SOURCE] })).res.status).toBe(403);
    expect(c.tokenRes.data.scope).toBe('read work');
    const next = await connect({ mode: 'passkey', cookie: v.cookie, grant: ['read'] });
    expect(next.tokenRes.data.scope).toBe('read');
    expect((await mcpTool(next.token, 'my_work')).data.handle).toBe('limited-ai');
    expect((await mcpTool(next.token, 'next_task')).res.status).toBe(403);
  });

  it('ownership cannot be changed once set, even by a direct write', async () => {
    const v = await voter(), w = await voter();
    const u = await newUser();
    await u.call('link_account', { code: await newCode(v) });
    await expect(env.DB.prepare('UPDATE contributors SET owner_account = ?1 WHERE handle = ?2').bind(w.id, u.handle).run()).rejects.toThrow(/cannot be changed/);
    await expect(env.DB.prepare('UPDATE contributors SET owner_account = NULL WHERE handle = ?1').bind(u.handle).run()).rejects.toThrow(/cannot be changed/);
    expect(await ownerOf(u.handle)).toBe(v.id);
  });

  it('two accounts racing to link one unowned contributor: exactly one becomes the owner', async () => {
    const [a, b] = [await voter(), await voter()];
    const u = await newUser();
    const [ca, cb] = [await newCode(a), await newCode(b)];
    // Both redeem after both have read the contributor as unowned.
    const g = gate();
    const db = wrapDb(env.DB, { beforeBatch: async (sqls) => { if (sqls.some((s) => /UPDATE contributors SET owner_account/.test(s))) await g.hit(); } });
    const first = u.call('link_account', { code: ca }, { over: { DB: db } });
    await g.reached;
    const second = await u.call('link_account', { code: cb });
    g.open();
    const firstRes = await first;
    expect([firstRes.isError, second.isError].filter((x) => !x)).toHaveLength(1);
    const owner = await ownerOf(u.handle);
    expect([a.id, b.id]).toContain(owner);
    expect((await linkRows()).map((r) => r.account)).toEqual([owner]);
  });
});

describe('finding 5: link-code attempts are reserved atomically', () => {
  const wrong = (i) => `SWARM-AAAA-BBB${(i % 8) + 2}`;

  it('12 parallel guesses from one contributor: exactly 5 invalid and 7 refused', async () => {
    const u = await newUser();
    // Every guess pauses after its first database round trip until all twelve have made it (the interleaving that bypassed the cap).
    const meet = rendezvous(12, 500);
    const db = wrapDb(env.DB, { afterBatch: async (sqls) => { if (sqls.some((s) => /link_attempts/.test(s))) await meet(); } });
    const out = await Promise.all(Array.from({ length: 12 }, (_, i) => u.call('link_account', { code: wrong(i) }, { over: { DB: db } })));
    const invalid = out.filter((r) => /not valid/.test(r.text)).length, refused = out.filter((r) => /Too many wrong link codes/.test(r.text)).length;
    expect({ invalid, refused }).toEqual({ invalid: 5, refused: 7 });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM link_attempts WHERE who LIKE 'c:%'").first()).n).toBe(5);
  });

  it('parallel guesses from many contributors on one network stop at the 20 network cap', async () => {
    const ip = nextIp();
    const users = [];
    for (let i = 0; i < 4; i++) users.push(await newUser({ ip }));
    const meet = rendezvous(28, 500);
    const db = wrapDb(env.DB, { afterBatch: async (sqls) => { if (sqls.some((s) => /link_attempts/.test(s))) await meet(); } });
    // 4 contributors x 7 guesses: the contributor cap allows 5 each (20 total); the network cap is also 20, so 8 are refused either way.
    const out = await Promise.all(users.flatMap((u, k) => Array.from({ length: 7 }, (_, i) => u.call('link_account', { code: wrong(k * 7 + i) }, { over: { DB: db } }))));
    expect(out.filter((r) => /not valid/.test(r.text))).toHaveLength(20);
    expect(out.filter((r) => /Too many wrong link codes/.test(r.text))).toHaveLength(8);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM link_attempts WHERE who LIKE 'n:%'").first()).n).toBe(20);
  });

  it('the network budget also counts YESTERDAY\'s network hash (a rolling hour across UTC midnight)', async () => {
    const ip = nextIp();
    const u = await newUser({ ip });
    const yesterday = await ipHashFor(env, { headers: new Headers({ 'CF-Connecting-IP': ip }) }, 1);
    const now = Date.now();
    await env.DB.batch(Array.from({ length: 20 }, () => env.DB.prepare('INSERT INTO link_attempts (who, ts) VALUES (?1, ?2)').bind(`n:${yesterday}`, now - 60000)));
    const r = await u.call('link_account', { code: 'SWARM-AAAA-BBBB' });
    expect(r.text).toMatch(/Too many wrong link codes/);
  });

  it('a correct code gives its reserved attempt back, even with other failures around it', async () => {
    const v = await voter();
    const u = await newUser();
    await u.call('link_account', { code: 'SWARM-AAAA-BBBB' });
    expect((await u.call('link_account', { code: await newCode(v) })).isError).toBe(false);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM link_attempts').first()).n).toBe(2); // the one failure (contributor + network rows)
  });
});

describe('finding 6: GET /authorize is network rate limited before any KV write', () => {
  const kvKeys = async () => (await env.OAUTH_KV.list()).keys.length;

  it('returns 429 and writes nothing when the limiter refuses', async () => {
    const { data: client } = await registerClient();
    const { challenge } = await pkce();
    const before = await kvKeys();
    const res = await o(authorizeUrl(client, { challenge }), { headers: { 'CF-Connecting-IP': nextIp() } }, { LIMITER: { limit: async () => ({ success: false }) } });
    expect(res.status).toBe(429);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await kvKeys()).toBe(before);
  });

  it('keys the limiter by network, and serves the page normally when under the limit', async () => {
    const { data: client } = await registerClient();
    const { challenge } = await pkce();
    const keys = [];
    const limiter = { limit: async ({ key }) => { keys.push(key); return { success: true }; } };
    const res = await o(authorizeUrl(client, { challenge }), { headers: { 'CF-Connecting-IP': '203.0.113.5' } }, { LIMITER: limiter });
    expect(res.status).toBe(200);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(await ipHashFor(env, { headers: new Headers({ 'CF-Connecting-IP': '203.0.113.5' }) }));
    const page = await openConsent(client, { challenge });
    expect(page.res.status).toBe(200);
  });
});
