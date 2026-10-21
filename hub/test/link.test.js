// Linking a contributor to a voter account with a short-lived, single-use code (no email, no OAuth).
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { sha256 } from '../src/lib.js';
import { MAX_LINK_FAILURES_PER_CONTRIBUTOR_PER_HOUR, newLinkCode } from '../src/steering.js';
import { newUser, nextIp, resetDb, send } from './helpers.js';
import { newCode, mePost, voter } from './voter.js';

beforeEach(resetDb);

const links = async () => (await env.DB.prepare('SELECT account, contributor, via FROM account_links ORDER BY contributor').all()).results;
const eventTypes = async () => (await env.DB.prepare("SELECT type, contributor, detail FROM events WHERE type LIKE 'account_%' AND contributor IN (SELECT id FROM contributors) ORDER BY id").all()).results;

describe('link codes', () => {
  it('have the form SWARM-XXXX-XXXX, are random, and are stored only as a hash', async () => {
    expect(newLinkCode()).toMatch(/^SWARM-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(new Set(Array.from({ length: 50 }, newLinkCode)).size).toBe(50);
    const v = await voter();
    const res = await mePost('/api/me/link-code', v);
    const { code, expires_at: exp } = await res.json();
    expect(code).toMatch(/^SWARM-/);
    expect(new Date(exp).getTime() - Date.now()).toBeGreaterThan(9 * 60000);
    expect(new Date(exp).getTime() - Date.now()).toBeLessThanOrEqual(10 * 60000);
    const row = await env.DB.prepare('SELECT hash, account FROM link_codes').first();
    expect(row.account).toBe(v.id);
    expect(row.hash).toBe(await sha256(`${env.HASH_SALT}|linkcode|${code}`));
    expect(JSON.stringify(await env.DB.prepare('SELECT * FROM link_codes').all())).not.toContain(code);
  });

  it('link a contributor, once: the second use of the same code fails', async () => {
    const v = await voter();
    const a = await newUser(), b = await newUser();
    const code = await newCode(v);
    const ok = await a.call('link_account', { code });
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.data.linked).toBe(true);
    expect(ok.data.handle).toBe(a.handle);
    const again = await b.call('link_account', { code });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/not valid/);
    expect(await links()).toHaveLength(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM link_codes').first()).n).toBe(0);
    // The same contributor using it twice: also fails (the code is gone), and the link is untouched.
    expect((await a.call('link_account', { code })).isError).toBe(true);
    expect((await links())[0].contributor).toBeGreaterThan(0);
  });

  it('expire after ten minutes', async () => {
    const v = await voter();
    const u = await newUser();
    const code = await newCode(v);
    await env.DB.prepare('UPDATE link_codes SET expires = ?1').bind(Date.now() - 1).run();
    const r = await u.call('link_account', { code });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/expired|not valid/);
    expect(await links()).toEqual([]);
  });

  it('reject a wrong, malformed or empty-looking code without saying which part was wrong', async () => {
    const v = await voter();
    const u = await newUser();
    await newCode(v);
    for (const code of ['SWARM-AAAA-BBBB', 'swarm-zzzz-2222', 'SWARM-0000-1111', 'hello', 'SWARM-AB-CD', ' ']) {
      const r = await u.call('link_account', { code });
      expect(r.isError, code).toBe(true);
      if (code !== ' ') expect(r.text, code).toMatch(/not valid/);
      expect(r.text).not.toContain(v.id);
    }
    expect(await links()).toEqual([]);
  });

  it('accept the code in lower case and with spaces around it', async () => {
    const v = await voter();
    const u = await newUser();
    const code = await newCode(v);
    expect((await u.call('link_account', { code: ` ${code.toLowerCase()} ` })).isError).toBe(false);
  });

  it('are rate limited per contributor: after five wrong codes even the right one is refused for an hour', async () => {
    const v = await voter();
    const u = await newUser();
    const code = await newCode(v);
    for (let i = 0; i < MAX_LINK_FAILURES_PER_CONTRIBUTOR_PER_HOUR; i++) expect((await u.call('link_account', { code: `SWARM-AAAA-BBB${i + 2}` })).text).toMatch(/not valid/);
    const blocked = await u.call('link_account', { code });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/Too many wrong link codes/);
    expect(await links()).toEqual([]);
    // The block lifts when the failures are more than an hour old.
    await env.DB.prepare('UPDATE link_attempts SET ts = ts - 3700000').run();
    expect((await u.call('link_account', { code })).isError).toBe(false);
  });

  it('are rate limited per network too, across different contributors', async () => {
    const v = await voter();
    const ip = nextIp();
    const users = [];
    for (let i = 0; i < 5; i++) users.push(await newUser({ ip }));
    const code = await newCode(v);
    for (const u of users) for (let i = 0; i < 4; i++) expect((await u.call('link_account', { code: `SWARM-ZZZZ-ZZZ${i + 2}` })).text).toMatch(/not valid/);
    const r = await users[0].call('link_account', { code });
    expect(r.text).toMatch(/Too many wrong link codes/);
    // Another network is not affected.
    const other = await newUser();
    expect((await other.call('link_account', { code })).isError).toBe(false);
  });

  it('a successful redemption does not count as a failure', async () => {
    const v = await voter();
    const u = await newUser();
    await u.call('link_account', { code: await newCode(v) });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM link_attempts').first()).n).toBe(0);
  });

  it('a new code cancels the previous one', async () => {
    const v = await voter();
    const u = await newUser();
    const first = await newCode(v);
    const second = await newCode(v);
    expect((await u.call('link_account', { code: first })).isError).toBe(true);
    expect((await u.call('link_account', { code: second })).isError).toBe(false);
  });

  it('refuse a suspended account, and an account that was suspended after the code was made', async () => {
    const v = await voter();
    const u = await newUser();
    const code = await newCode(v);
    await env.DB.prepare('UPDATE accounts SET suspended = 1 WHERE id = ?1').bind(v.id).run();
    expect((await u.call('link_account', { code })).isError).toBe(true);
    expect(await links()).toEqual([]);
  });
});

describe('relinking', () => {
  it('replaces the old link of the account and writes events: one contributor per account', async () => {
    const v = await voter();
    const a = await newUser(), b = await newUser();
    await a.call('link_account', { code: await newCode(v) });
    await b.call('link_account', { code: await newCode(v) });
    const rows = await links();
    expect(rows).toHaveLength(1);
    expect(rows[0].account).toBe(v.id);
    const me = await (await send('/api/me', { headers: { Cookie: v.cookie } })).json();
    expect(me.linked.handle).toBe(b.handle);
    const ev = await eventTypes();
    expect(ev.map((e) => e.type)).toEqual(['account_linked', 'account_unlinked', 'account_linked']);
    expect(JSON.parse(ev[1].detail)).toEqual({ reason: 'replaced' });
    expect(ev[1].contributor).not.toBe(ev[2].contributor);
    // The replaced contributor is steered by nobody now.
    expect(JSON.stringify(ev)).not.toContain(v.id + '"'); // only the short id is ever written
  });

  it('finding 1: REFUSES to move a contributor owned by a different account (one account owns it for good)', async () => {
    const v1 = await voter(), v2 = await voter();
    const a = await newUser();
    expect((await a.call('link_account', { code: await newCode(v1) })).isError).toBe(false);
    const code2 = await newCode(v2);
    const r = await a.call('link_account', { code: code2 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/already belongs to a different Swarm account/);
    expect((await links()).map((x) => x.account)).toEqual([v1.id]);
    expect((await env.DB.prepare('SELECT owner_account FROM contributors WHERE handle = ?1').bind(a.handle).first()).owner_account).toBe(v1.id);
    expect((await (await send('/api/me', { headers: { Cookie: v2.cookie } })).json()).linked).toBeNull();
    expect((await eventTypes()).map((e) => e.type)).toEqual(['account_linked']);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM link_codes WHERE account = ?1').bind(v2.id).first()).n).toBe(1); // the refused code was not spent
  });

  it('an account may link another contributor of its own (it becomes the owner of both), replacing its steering link', async () => {
    const v = await voter();
    const a = await newUser(), b = await newUser();
    await a.call('link_account', { code: await newCode(v) });
    await b.call('link_account', { code: await newCode(v) });
    expect((await links()).map((x) => x.account)).toEqual([v.id]);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM contributors WHERE owner_account = ?1').bind(v.id).first()).n).toBe(2);
  });

  it('linking the same pair again leaves one link and no unlink event', async () => {
    const v = await voter();
    const a = await newUser();
    await a.call('link_account', { code: await newCode(v) });
    await a.call('link_account', { code: await newCode(v) });
    expect(await links()).toHaveLength(1);
    expect((await eventTypes()).map((e) => e.type)).not.toContain('account_unlinked');
  });
});

describe('link-code and unlink endpoints', () => {
  it('need a signed-in voter, the exact Origin and X-Swarm: 1', async () => {
    const v = await voter();
    expect((await mePost('/api/me/link-code', null)).status).toBe(401);
    expect((await mePost('/api/me/link-code', v, {}, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await mePost('/api/me/link-code', v, {}, { headers: { Origin: '' } })).status).toBe(403);
    expect((await mePost('/api/me/link-code', v, {}, { headers: { 'X-Swarm': '' } })).status).toBe(403);
    expect((await send('/api/me/link-code', { headers: { Cookie: v.cookie } })).status).toBe(405);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM link_codes').first()).n).toBe(0);
  });

  it('unlink removes the link, writes an event and stops steering', async () => {
    const v = await voter();
    const u = await newUser();
    await u.call('link_account', { code: await newCode(v) });
    const res = await mePost('/api/me/unlink', v);
    expect(await res.json()).toEqual({ linked: false, was_linked: true });
    expect(await links()).toEqual([]);
    expect((await eventTypes()).at(-1).type).toBe('account_unlinked');
    expect((await (await mePost('/api/me/unlink', v)).json()).was_linked).toBe(false);
    expect((await mePost('/api/me/unlink', v, {}, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('link_account needs the contributor\'s own key', async () => {
    const v = await voter();
    const r = await (await import('./helpers.js')).tool('link_account', { code: await newCode(v) });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/needs a contributor key/);
    expect(await links()).toEqual([]);
  });
});
