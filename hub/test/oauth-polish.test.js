// Fixes from the first live test of app sign-in: step-up leaves one live grant, the consent page says what it will do, and a voter can
// disconnect an app on /me. Nothing here depends on the clock or the day of the week.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { nextIp, resetDb, send } from './helpers.js';
import { CONSENT_TTL_MS } from '../src/oauth-core.js';
import { codeOf, connect, decide, exchange, mcpTool, o, openConsent, pkce, registerClient } from './oauth-helpers.js';
import { gate, wrapDb } from './fault.js';
import { mePost, setupProjects, voter } from './voter.js';
import { setupGuide } from '../src/setup.js';

beforeEach(async () => { await resetDb(); await setupProjects(); });

const one = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const all = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then((r) => r.results);
const form = (params) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': nextIp() }, body: new URLSearchParams(params) });
const refreshWith = async (client, refresh, over) => { const res = await o('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: client.client_id }), over); return { res, data: await res.json() }; };
const alive = async (token) => (await mcpTool(token, 'my_work')).res.status === 200;
const liveGrants = () => all('SELECT id, client, contributor, scope FROM oauth_grants WHERE revoked_at IS NULL');

// One consent for an EXISTING client (connect() registers a new one each time). Returns the tokens, or null if the exchange failed.
async function consentFor(client, { scope, grant, cookie, mode = 'passkey', chosen_handle }) {
  const { verifier, challenge } = await pkce();
  const consent = await openConsent(client, { challenge, scope });
  const d = await decide(consent, { decision: 'approve', mode, scope: grant, ...(chosen_handle ? { chosen_handle } : {}) }, { cookie });
  const tok = d.data?.redirect_to ? await exchange(client, codeOf(d.data.redirect_to), verifier) : null;
  return { decision: d, consent, verifier, tokenRes: tok, token: tok?.data?.access_token, refresh: tok?.data?.refresh_token };
}

describe('the consent page data', () => {
  it('says how long the page lives, and marks the scopes the app did not ask for', async () => {
    const { data: client } = await registerClient();
    const { challenge } = await pkce();
    const page = await openConsent(client, { challenge, scope: 'read' });
    expect(page.data.expires_in_ms).toBe(CONSENT_TTL_MS);
    expect(Object.fromEntries(page.data.scopes.map((s) => [s.id, s.requested]))).toEqual({ read: true, work: false, submit: false });
  });

  it('keeps the server rule: a scope the app did not ask for is not granted even if the form ticks it', async () => {
    const c = await connect({ scope: 'read', grant: ['read', 'work', 'submit'] });
    expect(c.tokenRes.data.scope).toBe('read');
    expect((await mcpTool(c.token, 'next_task')).res.status).toBe(403);
  });
});

describe('step-up consent replaces the older grant for the same app and contributor', () => {
  it('cancels the older grant and every token under it; the new grant is the only live one', async () => {
    const v = await voter();
    const { data: client } = await registerClient();
    const first = await consentFor(client, { scope: 'read', grant: ['read'], cookie: v.cookie });
    expect(await alive(first.token)).toBe(true);
    expect((await mcpTool(first.token, 'next_task')).res.status).toBe(403);
    const second = await consentFor(client, { scope: 'read work', grant: ['read', 'work'], cookie: v.cookie });
    expect(second.tokenRes.data.scope).toBe('read work');
    expect(await alive(first.token)).toBe(false);
    expect(await alive(second.token)).toBe(true);
    const live = await liveGrants();
    expect(live).toHaveLength(1);
    expect(live[0].scope).toBe('read work');
    const old = await one("SELECT * FROM oauth_grants WHERE scope = 'read'");
    expect(old.revoked_reason).toBe('superseded');
    expect(await all('SELECT 1 FROM oauth_tokens WHERE grant_id = ?1 AND revoked_at IS NULL', old.id)).toEqual([]);
    // the old refresh token fails, and that is not read as theft: the new grant keeps working and is not cancelled
    const stale = await refreshWith({ client_id: client.client_id }, first.refresh);
    expect(stale.res.status).toBe(400);
    expect(stale.data.error).toBe('invalid_grant');
    expect(await alive(second.token)).toBe(true);
    expect((await one("SELECT revoked_at FROM oauth_grants WHERE scope = 'read work'")).revoked_at).toBeNull();
    expect((await refreshWith({ client_id: client.client_id }, second.refresh)).res.status).toBe(200);
  });

  it('does not touch another app, or another contributor of the same app', async () => {
    const v = await voter(), w = await voter();
    const other = await connect({ mode: 'passkey', cookie: v.cookie, grant: ['read'] });       // v, another app
    const { data: client } = await registerClient();
    const mine = await consentFor(client, { scope: 'read', grant: ['read'], cookie: v.cookie });
    const theirs = await consentFor(client, { scope: 'read', grant: ['read'], cookie: w.cookie }); // same app, another person
    await consentFor(client, { scope: 'read work', grant: ['read', 'work'], cookie: v.cookie });
    expect(await alive(other.token)).toBe(true);
    expect(await alive(theirs.token)).toBe(true);
    expect(await alive(mine.token)).toBe(false);
    expect(await liveGrants()).toHaveLength(3);
  });

  it('a handle connection is a new contributor each time, so it is never superseded', async () => {
    const { data: client } = await registerClient();
    const a = await consentFor(client, { scope: 'read', grant: ['read'], mode: 'handle' });
    const b = await consentFor(client, { scope: 'read', grant: ['read'], mode: 'handle' });
    expect(await alive(a.token)).toBe(true);
    expect(await alive(b.token)).toBe(true);
  });

  it('a refused or denied consent cancels nothing', async () => {
    const v = await voter();
    const { data: client } = await registerClient();
    const first = await consentFor(client, { scope: 'read', grant: ['read'], cookie: v.cookie });
    const { challenge } = await pkce();
    const denied = await openConsent(client, { challenge, scope: 'read work' });
    expect((await decide(denied, { decision: 'deny' })).res.status).toBe(200);
    const noSession = await openConsent(client, { challenge, scope: 'read work' });
    expect((await decide(noSession, { decision: 'approve', mode: 'passkey', scope: ['read', 'work'] })).res.status).toBe(401);
    expect(await alive(first.token)).toBe(true);
    expect(await liveGrants()).toHaveLength(1);
  });

  it('a refresh that read the old token BEFORE the consent fails after it, and mints nothing live', async () => {
    const v = await voter();
    const { data: client } = await registerClient();
    const first = await consentFor(client, { scope: 'read', grant: ['read'], cookie: v.cookie });
    const g = gate();
    const db = wrapDb(env.DB, { afterRead: async (sql) => { if (/SELECT t\.kind/.test(sql)) await g.hit(); } });
    const inFlight = refreshWith({ client_id: client.client_id }, first.refresh, { DB: db });
    await g.reached;
    const second = await consentFor(client, { scope: 'read work', grant: ['read', 'work'], cookie: v.cookie });
    g.open();
    const late = await inFlight;
    expect(late.res.status).toBe(400);
    expect(await alive(first.token)).toBe(false);
    expect(await alive(second.token)).toBe(true);
    expect(await liveGrants()).toHaveLength(1);
    expect(await all("SELECT 1 FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE g.scope = 'read' AND t.revoked_at IS NULL")).toEqual([]);
  });

  it('a refresh that finished just before the consent has its new tokens cancelled too', async () => {
    const v = await voter();
    const { data: client } = await registerClient();
    const first = await consentFor(client, { scope: 'read', grant: ['read'], cookie: v.cookie });
    const rotated = await refreshWith({ client_id: client.client_id }, first.refresh);
    expect(rotated.res.status).toBe(200);
    await consentFor(client, { scope: 'read work', grant: ['read', 'work'], cookie: v.cookie });
    expect(await alive(rotated.data.access_token)).toBe(false);
    expect((await refreshWith({ client_id: client.client_id }, rotated.data.refresh_token)).res.status).toBe(400);
    expect(await liveGrants()).toHaveLength(1);
  });

  it('two consents for the same pair at once leave exactly one live grant', async () => {
    const v = await voter();
    const { data: client } = await registerClient();
    await consentFor(client, { scope: 'read', grant: ['read'], cookie: v.cookie }); // the account's contributor exists first
    const a = await pkce(), b = await pkce();
    const pa = await openConsent(client, { challenge: a.challenge, scope: 'read work' });
    const pb = await openConsent(client, { challenge: b.challenge, scope: 'read work' });
    const body = { decision: 'approve', mode: 'passkey', scope: ['read', 'work'] };
    const [x, y] = await Promise.all([decide(pa, body, { cookie: v.cookie }), decide(pb, body, { cookie: v.cookie })]);
    expect([x.res.status, y.res.status]).toEqual([200, 200]);
    expect(await liveGrants()).toHaveLength(1);
    expect(await all('SELECT 1 FROM contributors')).toHaveLength(1);
    // the survivor can be exchanged; the other grant's code can not
    const ex = await Promise.all([exchange(client, codeOf(x.data.redirect_to), a.verifier), exchange(client, codeOf(y.data.redirect_to), b.verifier)]);
    expect(ex.map((e) => e.res.status).sort()).toEqual([200, 400]);
    expect(await alive(ex.find((e) => e.res.status === 200).data.access_token)).toBe(true);
  });

  it('keeps reuse detection on the new grant: a replayed rotated refresh token still cancels it', async () => {
    const v = await voter();
    const { data: client } = await registerClient();
    await consentFor(client, { scope: 'read', grant: ['read'], cookie: v.cookie });
    const second = await consentFor(client, { scope: 'read work', grant: ['read', 'work'], cookie: v.cookie });
    const cid = { client_id: client.client_id };
    const r1 = await refreshWith(cid, second.refresh);
    expect(r1.res.status).toBe(200);
    // use the replacement, then replay the first token after its replacement was used: theft
    await refreshWith(cid, r1.data.refresh_token);
    expect((await refreshWith(cid, second.refresh)).res.status).toBe(400);
    expect(await liveGrants()).toEqual([]);
    expect((await one("SELECT revoked_reason FROM oauth_grants WHERE scope = 'read work'")).revoked_reason).toBe('refresh_reuse');
    expect((await one("SELECT revoked_reason FROM oauth_grants WHERE scope = 'read'")).revoked_reason).toBe('superseded');
  });
});

describe('Connected apps on /me', () => {
  const apps = (v) => send('/api/me/apps', { headers: v ? { Cookie: v.cookie } : {} });

  it('lists only this account\'s own live grants: name, unverified, scopes, date; no network data, no secrets', async () => {
    const v = await voter(), w = await voter();
    const mine = await connect({ mode: 'passkey', cookie: v.cookie, clientBody: { client_name: 'My Claude' }, grant: ['read', 'work'] });
    await connect({ mode: 'passkey', cookie: w.cookie, clientBody: { client_name: 'Their App' } });
    await connect({ mode: 'handle', clientBody: { client_name: 'No Account App' } });
    const r = await apps(v);
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toMatch(/no-store/);
    const body = await r.json();
    expect(body.signed_in).toBe(true);
    expect(body.note).toBe('Disconnecting in your AI app may not tell Swarm. Disconnect here to be sure.');
    expect(body.apps).toHaveLength(1);
    expect(body.apps[0]).toMatchObject({ name: 'My Claude', verified: false, scopes: ['read', 'work'] });
    expect(Object.keys(body.apps[0]).sort()).toEqual(['connected_at', 'handle', 'id', 'name', 'scopes', 'verified']);
    expect(new Date(body.apps[0].connected_at).getTime()).toBeGreaterThan(0);
    const text = JSON.stringify(body);
    expect(text).not.toContain(mine.token);
    expect(text).not.toContain(mine.refresh);
    expect(text).not.toMatch(/network|ip_hash|pair_ip/);
  });

  it('shows nothing signed out, and a grant superseded or revoked is gone from the list', async () => {
    expect(await (await apps(null)).json()).toEqual({ signed_in: false, apps: [] });
    const v = await voter();
    const { data: client } = await registerClient();
    await consentFor(client, { scope: 'read', grant: ['read'], cookie: v.cookie });
    await consentFor(client, { scope: 'read work', grant: ['read', 'work'], cookie: v.cookie });
    const body = await (await apps(v)).json();
    expect(body.apps.map((a) => a.scopes)).toEqual([['read', 'work']]);
  });

  it('also lists a contributor the account is linked to', async () => {
    const v = await voter();
    const c = await connect({ mode: 'handle', chosen_handle: 'linked-ai', grant: ['read', 'work'] });
    const id = (await one("SELECT id FROM contributors WHERE handle = 'linked-ai'")).id;
    await env.DB.prepare("INSERT INTO account_links (account, contributor, linked_at, via) VALUES (?1, ?2, ?3, 'code')").bind(v.id, id, Date.now()).run();
    const body = await (await apps(v)).json();
    expect(body.apps.map((a) => a.handle)).toEqual(['linked-ai']);
    expect(await alive(c.token)).toBe(true);
  });

  it('Disconnect cancels the grant and every token: access, refresh and a rotated refresh, at once', async () => {
    const v = await voter();
    const c = await connect({ mode: 'passkey', cookie: v.cookie });
    const rotated = await refreshWith(c.client, c.refresh);
    const list = (await (await apps(v)).json()).apps;
    const r = await mePost('/api/me/apps/disconnect', v, { grant: list[0].id });
    expect(r.status).toBe(200);
    expect((await r.json()).apps).toEqual([]);
    expect(await alive(rotated.data.access_token)).toBe(false);
    expect((await refreshWith(c.client, rotated.data.refresh_token)).res.status).toBe(400);
    expect(await all('SELECT 1 FROM oauth_tokens WHERE revoked_at IS NULL')).toEqual([]);
    expect((await one('SELECT revoked_reason FROM oauth_grants')).revoked_reason).toBe('revoked');
    expect((await mePost('/api/me/apps/disconnect', v, { grant: list[0].id })).status).toBe(404); // already gone
  });

  it('cannot disconnect somebody else\'s grant, an unknown one, or a malformed id; changes nothing', async () => {
    const v = await voter(), w = await voter();
    const theirs = await connect({ mode: 'passkey', cookie: w.cookie });
    const gid = (await one('SELECT id FROM oauth_grants')).id;
    expect((await mePost('/api/me/apps/disconnect', v, { grant: gid })).status).toBe(404);
    expect((await mePost('/api/me/apps/disconnect', v, { grant: 'a'.repeat(24) })).status).toBe(404);
    for (const bad of [{}, { grant: 5 }, { grant: 'short' }, { grant: "x' OR '1'='1" }, []]) expect((await mePost('/api/me/apps/disconnect', v, bad)).status, JSON.stringify(bad)).toBe(400);
    expect(await alive(theirs.token)).toBe(true);
    expect((await one('SELECT revoked_at FROM oauth_grants')).revoked_at).toBeNull();
  });

  it('has the same guards as the other /me writes: session, exact Origin, X-Swarm, POST only', async () => {
    const v = await voter();
    await connect({ mode: 'passkey', cookie: v.cookie });
    const gid = (await one('SELECT id FROM oauth_grants')).id;
    expect((await mePost('/api/me/apps/disconnect', null, { grant: gid })).status).toBe(401);
    expect((await mePost('/api/me/apps/disconnect', v, { grant: gid }, { headers: { Origin: 'https://swarm.bigpicsolutions.com.evil.example' } })).status).toBe(403);
    expect((await mePost('/api/me/apps/disconnect', v, { grant: gid }, { headers: { 'X-Swarm': '' } })).status).toBe(403);
    expect((await send('/api/me/apps/disconnect', { headers: { Cookie: v.cookie } })).status).toBe(405);
    expect((await mePost('/api/me/apps', v, {})).status).toBe(405);
    expect((await one('SELECT revoked_at FROM oauth_grants')).revoked_at).toBeNull();
  });
});

describe('connector instructions', () => {
  it('the guide at /setup and /llms.txt say Sign in now, Register automatically, the 10 minutes and the extra-access prompt', async () => {
    for (const path of ['/setup', '/llms.txt']) {
      const text = await (await send(path)).text();
      for (const phrase of ['Sign in now', 'Register automatically', '10 minutes', 'asks for more access']) expect(text, `${path} ${phrase}`).toContain(phrase);
    }
    expect(setupGuide('claude-app')).toContain('"Sign in now"');
  });
  it('the connect page says the same', async () => {
    const html = await (await send('/connect.html')).text();
    for (const phrase of ['Sign in now', 'Register automatically', '10 minutes']) expect(html).toContain(phrase);
  });
});
