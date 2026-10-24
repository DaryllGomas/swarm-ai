// Swarm's own OAuth server (src/oauth-core.js, src/oauth.js). Each test is an attack or a failure the old KV-based library allowed
// (Codex review 4, findings 2, 3 and 6; review 5, finding 8), plus the rules of the MCP authorization spec. Nothing here depends on the
// clock or the day of the week: expiry is tested by moving the stored deadline, and races by pausing a request after a real D1 read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { BODY, SOURCE, addTask, newUser, nextIp, resetDb, rpc } from './helpers.js';
import { ORIGIN, OVER, REDIRECT, authorizeUrl, codeOf, connect, decide, exchange, mcp, mcpTool, o, openConsent, pkce, registerClient } from './oauth-helpers.js';
import { accessFixture } from './access-helpers.js';
import { gate, wrapDb } from './fault.js';
import { setupProjects, voter } from './voter.js';
import { SCOPE_FOR_TOOL } from '../src/oauth-scopes.js';
import { ACCESS_TTL_MS, CODE_TTL_MS, MAX_CLIENTS, MAX_CLIENTS_PER_NETWORK_PER_DAY, REFRESH_TTL_MS, RETRY_GRACE_MS, purgeOAuth, validRedirectUri } from '../src/oauth-core.js';

beforeEach(async () => { await resetDb(); await setupProjects(); });
afterEach(() => vi.unstubAllGlobals());

const one = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const all = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then((r) => r.results);
const count = async (table) => (await one(`SELECT COUNT(*) AS n FROM ${table}`)).n;

const form = (params) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': nextIp() }, body: new URLSearchParams(params) });
const refreshWith = async (c, refresh, over) => { const res = await o('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: c.client.client_id }), over); return { res, data: await res.json() }; };
const revokeToken = async (client, token, over) => { const res = await o('/oauth/revoke', form({ token, client_id: client.client_id }), over); return { res, data: await res.json() }; };
const grantOf = () => one('SELECT * FROM oauth_grants ORDER BY created DESC LIMIT 1');
const alive = async (token) => (await mcpTool(token, 'my_work')).res.status === 200;

describe('discovery', () => {
  it('serves authorization server metadata with the same endpoints as before, plus revocation', async () => {
    const m = await (await o('/.well-known/oauth-authorization-server')).json();
    expect(m).toMatchObject({
      issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/authorize`, token_endpoint: `${ORIGIN}/oauth/token`, registration_endpoint: `${ORIGIN}/oauth/register`,
      revocation_endpoint: `${ORIGIN}/oauth/revoke`, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], response_types_supported: ['code'],
    });
    expect(m.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(m.scopes_supported).toEqual(['read', 'work', 'submit']);
  });

  it('serves protected resource metadata at both well-known paths, and 404s others', async () => {
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const m = await (await o(p)).json();
      expect(m).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN], bearer_methods_supported: ['header'] });
    }
    expect((await o('/.well-known/oauth-protected-resource/other')).status).toBe(404);
  });

  it('answers CORS preflight and sends CORS headers on the endpoints browsers-based clients use', async () => {
    const pre = await o('/oauth/token', { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect((await o('/oauth/register', { method: 'GET' })).status).toBe(405);
    expect((await o('/.well-known/oauth-authorization-server')).headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('with OAUTH off nothing is served, and bearer tokens that are not keys are not read', async () => {
    const off = { ...OVER, OAUTH: 'off' };
    for (const p of ['/oauth/register', '/oauth/token', '/oauth/revoke']) expect((await o(p, { method: 'POST' }, off)).status).not.toBe(200);
    expect((await o('/.well-known/oauth-authorization-server', {}, off)).status).not.toBe(200);
    expect((await o('/authorize', {}, off)).status).toBe(503);
  });
});

describe('dynamic client registration', () => {
  it('registers a public client with the fields RFC 7591 returns, and no secret', async () => {
    const { res, data } = await registerClient({ client_name: 'Claude' });
    expect(res.status).toBe(201);
    expect(data).toMatchObject({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    expect(data.client_id).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(data.client_secret).toBeUndefined();
    expect(await one('SELECT name FROM oauth_clients WHERE id = ?1', data.client_id)).toEqual({ name: 'Claude' });
  });

  it('accepts https and loopback http (127.0.0.1 and localhost, any port)', async () => {
    for (const uri of ['https://client.example/cb', 'https://client.example:8443/a/b?x=1', 'http://127.0.0.1/cb', 'http://127.0.0.1:53682/callback', 'http://localhost:33418/callback']) expect(validRedirectUri(uri), uri).toBe(true);
    expect((await registerClient({ redirect_uris: ['http://127.0.0.1:1/cb', 'http://localhost:2/cb', 'https://a.example/cb'] })).res.status).toBe(201);
  });

  it('refuses every other redirect URI, strictly', async () => {
    const bad = ['http://client.example/cb', 'http://localhost.evil.example/cb', 'http://127.0.0.1.evil.example/cb', 'http://[::1]:5/cb', 'http://0.0.0.0/cb', 'http://127.0.0.2/cb', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd',
      'ftp://client.example/cb', 'com.example.app:/cb', 'https://client.example/cb#frag', 'https://user:pw@client.example/cb', 'https://client.example\\@evil.example/', 'https://client.example/ cb', 'https://client.example/cb\n', 'https://', 'not a url', '', 'https://clïent.example/cb', `https://client.example/${'a'.repeat(600)}`];
    for (const uri of bad) {
      const { res, data } = await registerClient({ redirect_uris: [uri] });
      expect(res.status, JSON.stringify(uri)).toBe(400);
      expect(data.error).toBe('invalid_redirect_uri');
    }
    for (const uris of [[], 'https://client.example/cb', null, [1], [REDIRECT, REDIRECT], Array.from({ length: 6 }, (_, i) => `https://c${i}.example/cb`), [REDIRECT, 'http://evil.example/cb']]) {
      expect((await registerClient({ redirect_uris: uris })).res.status, JSON.stringify(uris)).toBe(400);
    }
    expect(await count('oauth_clients')).toBe(0);
  });

  it('is for public clients only: any other authentication method, grant or response type is refused', async () => {
    for (const extra of [{ token_endpoint_auth_method: 'client_secret_basic' }, { token_endpoint_auth_method: 'client_secret_post' }, { token_endpoint_auth_method: 'private_key_jwt' },
      { grant_types: ['client_credentials'] }, { grant_types: ['refresh_token'] }, { grant_types: ['authorization_code', 'implicit'] }, { response_types: ['token'] }, { grant_types: [] }, { client_name: { a: 1 } }]) {
      const { res, data } = await registerClient(extra);
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(data.error).toBe('invalid_client_metadata');
    }
  });

  it('limits the size of a registration, and plain-texts the name', async () => {
    const big = await o('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() }, body: JSON.stringify({ redirect_uris: [REDIRECT], padding: 'x'.repeat(5000) }) });
    expect(big.status).toBe(413);
    expect((await o('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() }, body: 'not json' })).status).toBe(400);
    expect((await o('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() }, body: '[1]' })).status).toBe(400);
    const { data } = await registerClient({ client_name: `<b>${'N'.repeat(300)}</b>\u0000` });
    expect(data.client_name).not.toMatch(/[<>\u0000]/);
    expect(data.client_name.length).toBeLessThanOrEqual(80);
    expect((await registerClient({ client_name: '' })).data.client_name).toBe('An AI app');
  });

  it(`stops a network at ${MAX_CLIENTS_PER_NETWORK_PER_DAY} clients in a rolling day, and does not stop another network`, async () => {
    const ip = '203.0.113.50';
    const reg = () => o('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) });
    for (let i = 0; i < MAX_CLIENTS_PER_NETWORK_PER_DAY; i++) expect((await reg()).status).toBe(201);
    const refused = await reg();
    expect(refused.status).toBe(429);
    expect((await refused.json()).error).toBe('temporarily_unavailable');
    expect((await registerClient()).res.status).toBe(201); // a different network
    expect(await count('oauth_clients')).toBe(MAX_CLIENTS_PER_NETWORK_PER_DAY + 1);
  });

  it(`stops at ${MAX_CLIENTS} clients in total`, async () => {
    await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
      INSERT INTO oauth_clients (id, name, redirect_uris, created) SELECT 'filler' || i, 'x', '[]', ?2 FROM n`).bind(MAX_CLIENTS, Date.now()).run();
    const { res } = await registerClient();
    expect(res.status).toBe(429);
    expect(await count('oauth_clients')).toBe(MAX_CLIENTS);
  });
});

describe('rate limits: every endpoint, before any write', () => {
  const refuse = { limit: async () => ({ success: false }) };
  it('registration, token and revocation answer 429 and write nothing', async () => {
    for (const path of ['/oauth/register', '/oauth/token', '/oauth/revoke']) {
      const res = await o(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) }, { LIMITER: refuse });
      expect(res.status, path).toBe(429);
    }
    expect(await count('oauth_clients')).toBe(0);
  });

  it('GET /authorize is limited before it writes a consent transaction, and so is the decision', async () => {
    const { data: client } = await registerClient();
    const { challenge } = await pkce();
    const res = await o(authorizeUrl(client, { challenge }), { headers: { 'CF-Connecting-IP': nextIp() } }, { LIMITER: refuse });
    expect(res.status).toBe(429);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await count('oauth_consents')).toBe(0);
    const consent = await openConsent(client, { challenge });
    const over = await o('/authorize', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-Swarm': '1', Cookie: consent.cookie, 'CF-Connecting-IP': nextIp() }, body: JSON.stringify({ consent: consent.data.consent, decision: 'deny' }) }, { LIMITER: refuse });
    expect(over.status).toBe(429);
    expect((await one('SELECT used FROM oauth_consents')).used).toBe(0);
  });
});

describe('authorization request', () => {
  const asks = async (opts, client) => {
    const c = client ?? (await registerClient()).data;
    const { challenge } = await pkce();
    return { c, res: await o(authorizeUrl(c, { challenge, ...opts }), { redirect: 'manual', headers: { 'CF-Connecting-IP': nextIp() } }) };
  };
  const errorOf = (res) => { const to = new URL(res.headers.get('Location')); return { to, error: to.searchParams.get('error') }; };

  it('refuses a missing code_challenge, the plain method, a missing method and a malformed challenge, back at the client with the state', async () => {
    const { data: client } = await registerClient();
    for (const q of [{ challenge: null }, { challenge: 'a'.repeat(43), method: 'plain' }, { challenge: 'a'.repeat(43), method: 'S512' }, { challenge: 'short' }, { challenge: 'a'.repeat(43), method: '' }]) {
      const res = await o(authorizeUrl(client, { challenge: q.challenge === null ? undefined : q.challenge, method: q.method ?? 'S256' }), { redirect: 'manual' });
      expect(res.status, JSON.stringify(q)).toBe(302);
      const { to, error } = errorOf(res);
      expect(to.origin + to.pathname).toBe(REDIRECT);
      expect(error).toBe('invalid_request');
      expect(to.searchParams.get('state')).toBe('st4te');
    }
    expect(await count('oauth_consents')).toBe(0);
  });

  it('a request with no code_challenge_method at all is refused (plain is the RFC default, and not allowed here)', async () => {
    const { data: client } = await registerClient();
    const { challenge } = await pkce();
    const url = authorizeUrl(client, { challenge }).replace('&code_challenge_method=S256', '');
    expect(url).not.toContain('code_challenge_method');
    const res = await o(url, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(errorOf(res).error).toBe('invalid_request');
  });

  it('needs the redirect URI to match a registered one exactly, and never redirects to anything else', async () => {
    const { data: client } = await registerClient({ redirect_uris: [REDIRECT, 'http://127.0.0.1:5000/cb'] });
    const { challenge } = await pkce();
    for (const uri of ['https://client.example/callback/', 'https://client.example/callbac', 'https://CLIENT.example/callback/x', 'https://client.example/callback?x=1', 'https://client.example:444/callback', 'http://client.example/callback',
      'https://client.example.evil.example/callback', 'https://evil.example/callback', 'http://127.0.0.1:5001/cb', 'http://127.0.0.1:5000/cb/', 'http://localhost:5000/cb', '']) {
      const res = await o(authorizeUrl(client, { challenge, redirect: uri }), { redirect: 'manual' });
      expect(res.status, uri).toBe(400);
      expect(res.headers.get('Location'), uri).toBeNull();
    }
    expect(await count('oauth_consents')).toBe(0);
    expect((await o(authorizeUrl(client, { challenge, redirect: 'http://127.0.0.1:5000/cb' }), { redirect: 'manual' })).status).toBe(200); // exact, including the port
  });

  it('a missing redirect_uri is allowed only when exactly one is registered', async () => {
    const { challenge } = await pkce();
    const strip = (client) => authorizeUrl(client, { challenge }).replace(/&redirect_uri=[^&]*/, '');
    const { data: single } = await registerClient();
    expect((await o(strip(single), { redirect: 'manual' })).status).toBe(200);
    const { data: two } = await registerClient({ redirect_uris: [REDIRECT, 'https://client.example/other'] });
    expect((await o(strip(two), { redirect: 'manual' })).status).toBe(400);
  });

  it('refuses another response_type, a foreign resource, a repeated resource and an over-long state', async () => {
    const { data: client } = await registerClient();
    const { challenge } = await pkce();
    const base = authorizeUrl(client, { challenge });
    for (const [url, error] of [[base.replace('response_type=code', 'response_type=token'), 'unsupported_response_type'], [authorizeUrl(client, { challenge, resource: 'https://other.example/mcp' }), 'invalid_target'],
      [`${base}&resource=${encodeURIComponent(`${ORIGIN}/mcp`)}`, 'invalid_target'], [authorizeUrl(client, { challenge, state: 's'.repeat(600) }), 'invalid_request']]) {
      const res = await o(url, { redirect: 'manual' });
      expect(res.status, url).toBe(302);
      expect(errorOf(res).error).toBe(error);
    }
    expect(await count('oauth_consents')).toBe(0);
  });

  it('writes one transaction per valid request, stores only hashes, and keeps one browser secret across tabs', async () => {
    const { data: client } = await registerClient();
    const { challenge } = await pkce();
    const a = await openConsent(client, { challenge });
    const b = await openConsent(client, { challenge });
    expect(await count('oauth_consents')).toBe(2);
    expect(a.cookie).toMatch(/^__Host-oauth-consent=[A-Za-z0-9_-]{43}$/);
    const attrs = a.res.headers.getSetCookie()[0];
    expect(attrs).toMatch(/HttpOnly/); expect(attrs).toMatch(/Secure/); expect(attrs).toMatch(/SameSite=Strict/); expect(attrs).toMatch(/Path=\//); expect(attrs).not.toMatch(/Domain/);
    expect(a.data.consent).not.toBe(b.data.consent);
    // A second tab in the same browser reuses the cookie, so the first tab still works.
    const again = await o(authorizeUrl(client, { challenge }), { headers: { Cookie: a.cookie, 'CF-Connecting-IP': nextIp() } });
    expect(again.headers.getSetCookie()[0].split(';')[0]).toBe(a.cookie);
    const rows = JSON.stringify(await all('SELECT * FROM oauth_consents'));
    expect(rows).not.toContain(a.data.consent); expect(rows).not.toContain(a.cookie.split('=')[1]);
  });
});

describe('the consent transaction (CSRF)', () => {
  const approve = { decision: 'approve', mode: 'handle', scope: ['read', 'work'] };
  async function page(opts) {
    const { data: client } = await registerClient(opts?.clientBody);
    const { challenge, verifier } = await pkce();
    return { client, verifier, consent: await openConsent(client, { challenge, ...opts }) };
  }

  it('is single use even when two approvals race: one winner, one grant, one code', async () => {
    const { consent } = await page();
    const [x, y] = await Promise.all([decide(consent, approve), decide(consent, approve)]);
    expect([x.res.status, y.res.status].sort()).toEqual([200, 400]);
    expect(await count('oauth_grants')).toBe(1);
    expect(await count('oauth_codes')).toBe(1);
    expect(await count('contributors')).toBe(1);
  });

  it('needs the browser it was opened in, the exact handle, an unexpired page and an existing client', async () => {
    const { consent } = await page();
    expect((await decide({ ...consent, cookie: '' }, approve)).res.status).toBe(400);
    expect((await decide({ ...consent, cookie: '__Host-oauth-consent=' + 'a'.repeat(43) }, approve)).res.status).toBe(400);
    expect((await decide({ ...consent, data: { consent: 'swh_' + 'a'.repeat(43) } }, approve)).res.status).toBe(400);
    expect((await decide({ ...consent, data: { consent: 'x' } }, approve)).res.status).toBe(400);
    await env.DB.prepare('UPDATE oauth_consents SET expires = ?1').bind(Date.now() - 1).run();
    expect((await decide(consent, approve)).res.status).toBe(400);
    expect(await count('oauth_grants')).toBe(0);
    const fresh = await page();
    await env.DB.prepare('DELETE FROM oauth_clients').run();
    expect((await decide(fresh.consent, approve)).res.status).toBe(400);
  });

  it('uses the stored request, not the form: a redirect_uri, client or challenge in the body changes nothing', async () => {
    const { client, consent, verifier } = await page();
    const d = await decide(consent, { ...approve, redirect_uri: 'https://evil.example/steal', client: 'x', client_id: 'y', code_challenge: 'z'.repeat(43), state: 'forged' });
    const to = new URL(d.data.redirect_to);
    expect(to.origin + to.pathname).toBe(REDIRECT);
    expect(to.searchParams.get('state')).toBe('st4te');
    expect((await exchange(client, codeOf(d.data.redirect_to), verifier)).res.status).toBe(200);
  });

  it('the grant never exceeds what the app asked for or what the person ticked', async () => {
    const asked = await page({ scope: 'read' });
    const d = await decide(asked.consent, { decision: 'approve', mode: 'handle', scope: ['read', 'work', 'submit'] });
    expect((await grantOf()).scope).toBe('read');
    const t = await exchange(asked.client, codeOf(d.data.redirect_to), asked.verifier);
    expect(t.data.scope).toBe('read');
    expect((await mcpTool(t.data.access_token, 'next_task')).res.status).toBe(403);
    const ticked = await connect({ scope: 'read work submit', grant: ['read', 'submit'] });
    expect(ticked.tokenRes.data.scope).toBe('read submit');
  });

  it('a deny spends the page, creates no contributor and no grant, and goes back with access_denied', async () => {
    const { consent } = await page();
    const d = await decide(consent, { decision: 'deny' });
    expect(new URL(d.data.redirect_to).searchParams.get('error')).toBe('access_denied');
    expect((await decide(consent, approve)).res.status).toBe(400);
    expect(await count('contributors')).toBe(0);
    expect(await count('oauth_grants')).toBe(0);
  });

  it('a refused approval (taken handle, no session) does not spend the page', async () => {
    await newUser({ handle: 'taken-handle' });
    const { consent } = await page();
    expect((await decide(consent, { ...approve, chosen_handle: 'taken-handle' })).res.status).toBe(409);
    expect((await decide(consent, { ...approve, mode: 'passkey' })).res.status).toBe(401);
    expect((await one('SELECT used FROM oauth_consents')).used).toBe(0);
    expect((await decide(consent, approve)).res.status).toBe(200);
  });
});

describe('authorization codes', () => {
  async function authorized(grant = ['read', 'work', 'submit']) {
    const { data: client } = await registerClient();
    const { challenge, verifier } = await pkce();
    const consent = await openConsent(client, { challenge });
    const d = await decide(consent, { decision: 'approve', mode: 'handle', scope: grant });
    return { client, verifier, code: codeOf(d.data.redirect_to) };
  }

  it('is random, stored only as a hash, and lives 60 seconds', async () => {
    const a = await authorized(), b = await authorized();
    expect(a.code).toMatch(/^swc_[A-Za-z0-9_-]{43}$/);
    expect(a.code).not.toBe(b.code);
    const rows = await all('SELECT * FROM oauth_codes');
    expect(JSON.stringify(rows)).not.toContain(a.code);
    expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
    const g = await one('SELECT created FROM oauth_grants ORDER BY created LIMIT 1');
    expect(rows[0].expires - g.created).toBe(CODE_TTL_MS);
    expect(CODE_TTL_MS).toBe(60000);
  });

  it('expires: a code past its deadline is refused and nothing is issued', async () => {
    const a = await authorized();
    await env.DB.prepare('UPDATE oauth_codes SET expires = ?1').bind(Date.now() - 1).run();
    const r = await exchange(a.client, a.code, a.verifier);
    expect(r.res.status).toBe(400);
    expect(r.data.error).toBe('invalid_grant');
    expect(await count('oauth_tokens')).toBe(0);
  });

  it('PKCE: a missing, malformed or wrong verifier is refused without spending the code; the right one then works once', async () => {
    const a = await authorized();
    for (const verifier of [undefined, '', 'short', 'a'.repeat(129), '!'.repeat(50), (await pkce()).verifier, a.verifier + 'x']) {
      const res = await o('/oauth/token', form({ grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, client_id: a.client.client_id, ...(verifier === undefined ? {} : { code_verifier: verifier }) }));
      expect(res.status, String(verifier)).toBe(400);
      expect((await res.json()).error).toBe('invalid_grant');
    }
    expect((await one('SELECT used FROM oauth_codes')).used).toBe(0);
    expect((await exchange(a.client, a.code, a.verifier)).res.status).toBe(200);
  });

  it('the redirect_uri at the token endpoint must match the request, and a code is for one client', async () => {
    const { data: client } = await registerClient({ redirect_uris: [REDIRECT, 'https://client.example/other'] });
    const { data: stranger } = await registerClient();
    const { challenge, verifier } = await pkce();
    const consent = await openConsent(client, { challenge });
    const code = codeOf((await decide(consent, { decision: 'approve', mode: 'handle', scope: ['read'] })).data.redirect_to);
    expect((await exchange(client, code, verifier, { redirect: 'https://client.example/other' })).res.status).toBe(400);
    const missing = await o('/oauth/token', form({ grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: verifier }));
    expect(missing.status).toBe(400);
    expect((await exchange(stranger, code, verifier)).res.status).toBe(400);
    expect((await one('SELECT revoked_at FROM oauth_grants')).revoked_at).toBeNull(); // another client cannot cancel the connection by presenting the code
    const wrongResource = await o('/oauth/token', form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: 'https://other.example/mcp' }));
    expect((await wrongResource.json()).error).toBe('invalid_target');
    expect((await exchange(client, code, verifier)).res.status).toBe(200);
  });

  it('a code used a second time revokes the whole grant: the first access token and refresh token die', async () => {
    const a = await authorized();
    const first = await exchange(a.client, a.code, a.verifier);
    expect(first.res.status).toBe(200);
    expect(await alive(first.data.access_token)).toBe(true);
    const second = await exchange(a.client, a.code, a.verifier);
    expect(second.res.status).toBe(400);
    expect(second.data.error).toBe('invalid_grant');
    expect((await grantOf()).revoked_reason).toBe('code_reuse');
    expect(await alive(first.data.access_token)).toBe(false);
    expect((await refreshWith({ client: a.client }, first.data.refresh_token)).res.status).toBe(400);
    expect(await count('oauth_tokens')).toBe(2); // the second use issued nothing
  });

  it('two exchanges that both read the code as unused: exactly one wins, and the grant is then revoked', async () => {
    const a = await authorized();
    const g = gate();
    const db = wrapDb(env.DB, { afterRead: async (sql) => { if (/FROM oauth_codes c JOIN oauth_grants/.test(sql)) await g.hit(); } });
    const parked = exchange(a.client, a.code, a.verifier, { over: { DB: db } });
    await g.reached;
    const winner = await exchange(a.client, a.code, a.verifier);
    g.open();
    const loser = await parked;
    expect(winner.res.status).toBe(200);
    expect(loser.res.status).toBe(400);
    expect(loser.data.error).toBe('invalid_grant');
    expect(await count('oauth_tokens')).toBe(2); // one access token and one refresh token, from the winner only
    expect((await grantOf()).revoked_reason).toBe('code_reuse');
    expect(await alive(winner.data.access_token)).toBe(false);
  });

  it('two plain parallel exchanges: exactly one 200', async () => {
    const a = await authorized();
    const out = await Promise.all([exchange(a.client, a.code, a.verifier), exchange(a.client, a.code, a.verifier), exchange(a.client, a.code, a.verifier)]);
    expect(out.filter((r) => r.res.status === 200)).toHaveLength(1);
    expect(await count('oauth_tokens')).toBe(2);
  });

  it('a grant revoked, or a contributor removed, before the exchange yields nothing', async () => {
    const a = await authorized();
    await env.DB.prepare("UPDATE oauth_grants SET revoked_at = ?1, revoked_reason = 'revoked'").bind(Date.now()).run();
    expect((await exchange(a.client, a.code, a.verifier)).res.status).toBe(400);
    const b = await authorized();
    await env.DB.prepare('UPDATE contributors SET removed = 1').run();
    expect((await exchange(b.client, b.code, b.verifier)).res.status).toBe(400);
    expect(await count('oauth_tokens')).toBe(0);
  });
});

describe('access tokens', () => {
  it('are opaque, random, hashed in storage, and last one hour', async () => {
    const c = await connect({ chosen_handle: 'token-shape' });
    const t = c.tokenRes.data;
    expect(t).toMatchObject({ token_type: 'bearer', expires_in: 3600, scope: 'read work submit' });
    expect(t.access_token).toMatch(/^swa_[A-Za-z0-9_-]{43}$/);
    expect(t.refresh_token).toMatch(/^swr_[A-Za-z0-9_-]{43}$/);
    expect(c.tokenRes.res.headers.get('Cache-Control')).toBe('no-store');
    expect(c.tokenRes.res.headers.get('Pragma')).toBe('no-cache');
    const rows = await all('SELECT * FROM oauth_tokens');
    expect(rows).toHaveLength(2);
    const access = rows.find((r) => r.kind === 'access');
    expect(access.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(access.expires - access.created).toBe(ACCESS_TTL_MS);
    expect(rows.find((r) => r.kind === 'refresh').expires - access.created).toBe(REFRESH_TTL_MS);
    expect(new Set(rows.map((r) => r.family)).size).toBe(1);
  });

  it('no raw secret is in the database anywhere: not a code, token, consent handle or browser cookie', async () => {
    const { data: client } = await registerClient();
    const { challenge, verifier } = await pkce();
    const consent = await openConsent(client, { challenge });
    const d = await decide(consent, { decision: 'approve', mode: 'handle', scope: ['read', 'work', 'submit'] });
    const code = codeOf(d.data.redirect_to);
    const t = (await exchange(client, code, verifier)).data;
    const next = (await refreshWith({ client }, t.refresh_token)).data; // creates a stored retry blob as well
    const dump = JSON.stringify(await Promise.all(['oauth_clients', 'oauth_consents', 'oauth_grants', 'oauth_codes', 'oauth_tokens'].map((x) => all(`SELECT * FROM ${x}`))));
    for (const secret of [code, t.access_token, t.refresh_token, next.access_token, next.refresh_token, consent.data.consent, consent.cookie.split('=')[1], verifier]) expect(dump).not.toContain(secret);
    for (const secret of [t.access_token, t.refresh_token, next.access_token, next.refresh_token]) expect(dump).not.toContain(secret.slice(4)); // not even without the prefix
    expect(env.OAUTH_KV && (await env.OAUTH_KV.list()).keys).toEqual([]);
  });

  it('are refused after expiry, with the 401 challenge; a refresh token still gets a new one', async () => {
    const c = await connect({ chosen_handle: 'will-expire' });
    expect(await alive(c.token)).toBe(true);
    await env.DB.prepare("UPDATE oauth_tokens SET expires = ?1 WHERE kind = 'access'").bind(Date.now() - 1).run();
    const r = await mcp(c.token, 'tools/call', { name: 'my_work', arguments: {} });
    expect(r.res.status).toBe(401);
    expect(r.res.headers.get('WWW-Authenticate')).toBe(`Bearer realm="OAuth", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`);
    expect((await mcp(c.token, 'tools/list', {})).res.status).toBe(401); // every method, public tools included
    const fresh = await refreshWith(c, c.refresh);
    expect(fresh.res.status).toBe(200);
    expect(await alive(fresh.data.access_token)).toBe(true);
  });

  it('unknown, malformed, wrong-kind and wrong-audience tokens are all the same 401', async () => {
    const c = await connect({ chosen_handle: 'audience' });
    for (const bad of ['swa_' + 'A'.repeat(43), 'not-a-token', 'swa_short', c.refresh, 'swc_' + 'A'.repeat(43), 'x'.repeat(5000)]) {
      const r = await mcp(bad, 'tools/call', { name: 'my_work', arguments: {} });
      expect(r.res.status, bad.slice(0, 12)).toBe(401);
      expect(r.res.headers.get('WWW-Authenticate')).toMatch(/error="invalid_token"/);
    }
    // Same database, but this server is now a different origin: the token was made for another audience.
    const elsewhere = await mcp(c.token, 'tools/call', { name: 'my_work', arguments: {} }, { RP_ORIGIN: 'https://other.example' });
    expect(elsewhere.res.status).toBe(401);
    await env.DB.prepare("UPDATE oauth_grants SET resource = 'https://other.example/mcp'").run();
    expect((await mcp(c.token, 'tools/call', { name: 'my_work', arguments: {} })).res.status).toBe(401);
  });

  it('an access token is no use at the refresh endpoint, and a refresh token no use at /mcp', async () => {
    const c = await connect();
    expect((await refreshWith(c, c.token)).res.status).toBe(400);
    expect((await mcp(c.refresh, 'tools/list', {})).res.status).toBe(401);
  });
});

describe('refresh tokens: rotation and reuse detection', () => {
  it('rotates on every use: a chain of refreshes each yields new tokens for the same contributor', async () => {
    const c = await connect({ chosen_handle: 'chain-ai' });
    let refresh = c.refresh; const seen = new Set([c.refresh, c.token]);
    for (let i = 0; i < 4; i++) {
      const r = await refreshWith(c, refresh);
      expect(r.res.status, `rotation ${i}`).toBe(200);
      expect(r.data).toMatchObject({ token_type: 'bearer', expires_in: 3600, scope: 'read work submit' });
      expect(seen.has(r.data.refresh_token) || seen.has(r.data.access_token)).toBe(false);
      seen.add(r.data.refresh_token); seen.add(r.data.access_token);
      expect((await mcpTool(r.data.access_token, 'my_work')).data.handle).toBe('chain-ai');
      refresh = r.data.refresh_token;
    }
    const refreshRows = await all("SELECT rotated_at, successor FROM oauth_tokens WHERE kind = 'refresh' ORDER BY created, rotated_at");
    expect(refreshRows.filter((r) => r.rotated_at === null)).toHaveLength(1); // one live refresh token in the family, always
    expect(new Set((await all('SELECT family FROM oauth_tokens')).map((r) => r.family)).size).toBe(1);
  });

  it('a rotated token replayed after the grace window revokes the family and the grant, and returns invalid_grant', async () => {
    const c = await connect({ chosen_handle: 'replayed' });
    const r1 = await refreshWith(c, c.refresh);
    expect(r1.res.status).toBe(200);
    await env.DB.prepare('UPDATE oauth_tokens SET rotated_at = rotated_at - ?1 WHERE rotated_at IS NOT NULL').bind(RETRY_GRACE_MS + 1000).run();
    const replay = await refreshWith(c, c.refresh);
    expect(replay.res.status).toBe(400);
    expect(replay.data.error).toBe('invalid_grant');
    expect((await grantOf()).revoked_reason).toBe('refresh_reuse');
    expect((await refreshWith(c, r1.data.refresh_token)).res.status).toBe(400); // the legitimate replacement is dead too
    expect(await alive(r1.data.access_token)).toBe(false);
    expect(await alive(c.token)).toBe(false);
    expect(await all('SELECT 1 FROM oauth_tokens WHERE revoked_at IS NULL')).toEqual([]);
  });

  it('an old token replayed once its replacement has itself been used is theft even inside the window', async () => {
    const c = await connect();
    const r1 = await refreshWith(c, c.refresh);
    const r2 = await refreshWith(c, r1.data.refresh_token); // the client moved on: the response arrived
    expect(r2.res.status).toBe(200);
    const replay = await refreshWith(c, c.refresh);         // someone presents the very first token
    expect(replay.res.status).toBe(400);
    expect(await alive(r2.data.access_token)).toBe(false);
    expect((await refreshWith(c, r2.data.refresh_token)).res.status).toBe(400);
  });

  it('grace window: a retry within 30 seconds of a lost response returns the SAME tokens and creates no second branch', async () => {
    const c = await connect({ chosen_handle: 'lost-response' });
    const r1 = await refreshWith(c, c.refresh);
    const before = await count('oauth_tokens');
    const retry = await refreshWith(c, c.refresh);
    expect(retry.res.status).toBe(200);
    expect(retry.data.access_token).toBe(r1.data.access_token);
    expect(retry.data.refresh_token).toBe(r1.data.refresh_token);
    expect(retry.data.expires_in).toBeLessThanOrEqual(3600);
    expect(retry.data.expires_in).toBeGreaterThan(3590);
    expect((await refreshWith(c, c.refresh)).data.refresh_token).toBe(r1.data.refresh_token); // and again
    expect(await count('oauth_tokens')).toBe(before);   // nothing was minted: still one successor
    expect(await all("SELECT 1 FROM oauth_tokens WHERE kind = 'refresh' AND rotated_at IS NULL")).toHaveLength(1);
    // The replacement is the one live token: it continues the chain, and then the retry is no longer possible.
    const r2 = await refreshWith(c, r1.data.refresh_token);
    expect(r2.res.status).toBe(200);
    expect((await refreshWith(c, c.refresh)).res.status).toBe(400);
  });

  it('grace window: the stored replacement is encrypted, is deleted when the next rotation happens, and cannot be opened without the old token', async () => {
    const c = await connect();
    const r1 = await refreshWith(c, c.refresh);
    const stored = await one("SELECT retry_blob FROM oauth_tokens WHERE retry_blob IS NOT NULL");
    expect(stored.retry_blob).toBeTruthy();
    for (const s of [r1.data.access_token, r1.data.refresh_token, r1.data.access_token.slice(4), r1.data.refresh_token.slice(4)]) expect(stored.retry_blob).not.toContain(s);
    expect(stored.retry_blob.length).toBeGreaterThan(60);
    // Tampering with the blob or the hash it is bound to cannot produce tokens: it fails closed as a replay.
    await env.DB.prepare('UPDATE oauth_tokens SET retry_blob = ?1 WHERE retry_blob IS NOT NULL').bind(stored.retry_blob.slice(0, -4) + 'AAAA').run();
    expect((await refreshWith(c, c.refresh)).res.status).toBe(400);
    const c2 = await connect();
    const a = await refreshWith(c2, c2.refresh);
    await refreshWith(c2, a.data.refresh_token);
    expect(await count('oauth_tokens WHERE retry_blob IS NOT NULL')).toBe(1); // only the newest rotation keeps one
    await purgeOAuth(env, Date.now() + RETRY_GRACE_MS + 5000);
    expect(await count('oauth_tokens WHERE retry_blob IS NOT NULL')).toBe(0);
  });

  it('two parallel refreshes with one token both succeed with identical tokens and leave exactly one live replacement', async () => {
    const c = await connect();
    const [x, y] = await Promise.all([refreshWith(c, c.refresh), refreshWith(c, c.refresh)]);
    expect([x.res.status, y.res.status]).toEqual([200, 200]);
    expect(x.data.refresh_token).toBe(y.data.refresh_token);
    expect(x.data.access_token).toBe(y.data.access_token);
    expect(await all("SELECT 1 FROM oauth_tokens WHERE kind = 'refresh' AND rotated_at IS NULL")).toHaveLength(1);
    expect(await count('oauth_tokens')).toBe(4);
  });

  it('two refreshes that both read the token as unrotated: one rotates, the other gets the same result', async () => {
    const c = await connect();
    const g = gate();
    const db = wrapDb(env.DB, { afterRead: async (sql) => { if (/SELECT t\.kind/.test(sql)) await g.hit(); } });
    const parked = refreshWith(c, c.refresh, { DB: db });
    await g.reached;
    const first = await refreshWith(c, c.refresh);
    g.open();
    const second = await parked;
    expect([first.res.status, second.res.status]).toEqual([200, 200]);
    expect(second.data.refresh_token).toBe(first.data.refresh_token);
    expect(await count('oauth_tokens')).toBe(4);
  });

  it('a refresh token belongs to one client, and expires', async () => {
    const c = await connect();
    const { data: stranger } = await registerClient();
    expect((await refreshWith({ client: stranger }, c.refresh)).res.status).toBe(400);
    expect((await grantOf()).revoked_at).toBeNull(); // a stranger cannot cancel the connection
    await env.DB.prepare("UPDATE oauth_tokens SET expires = ?1 WHERE kind = 'refresh'").bind(Date.now() - 1).run();
    const r = await refreshWith(c, c.refresh);
    expect(r.res.status).toBe(400);
    expect(r.data.error).toBe('invalid_grant');
    expect((await refreshWith({ client: { client_id: 'unknown-client-id' } }, c.refresh)).res.status).toBe(401);
  });

  it('never widens the scope: a wider scope is refused, and omitting scope returns the grant's scope (narrowing: Codex review 8, finding 2)', async () => {
    const c = await connect({ grant: ['read', 'work'] });
    const wider = await o('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.client.client_id, scope: 'read work submit' }));
    expect((await wider.json()).error).toBe('invalid_scope');
    const same = await refreshWith(c, c.refresh);
    expect(same.data.scope).toBe('read work');
    expect((await mcpTool(same.data.access_token, 'submit_work', { task_id: 1, body: BODY, sources: [SOURCE] })).res.status).toBe(403);
  });

  it('refuses repeated or missing parameters, other content types and unknown grant types', async () => {
    const c = await connect();
    const bad = [
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() }, body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.client.client_id }) },
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': nextIp() }, body: `grant_type=refresh_token&refresh_token=${c.refresh}&refresh_token=${c.refresh}&client_id=${c.client.client_id}` },
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': nextIp() }, body: 'x='.padEnd(9000, 'a') },
    ];
    for (const init of bad) expect((await o('/oauth/token', init)).status).toBe(400);
    expect((await (await o('/oauth/token', form({ grant_type: 'password', client_id: c.client.client_id }))).json()).error).toBe('unsupported_grant_type');
    expect((await (await o('/oauth/token', form({ grant_type: 'refresh_token', client_id: c.client.client_id }))).json()).error).toBe('invalid_grant');
    expect((await o('/oauth/token', { method: 'GET' })).status).toBe(405);
    expect((await refreshWith(c, c.refresh)).res.status).toBe(200); // none of that touched the connection
  });
});

describe('revocation', () => {
  it('revoking the access token revokes the grant: the refresh token and the access token both die', async () => {
    const c = await connect();
    const r = await revokeToken(c.client, c.token);
    expect(r.res.status).toBe(200);
    expect((await grantOf()).revoked_reason).toBe('revoked');
    expect(await alive(c.token)).toBe(false);
    expect((await refreshWith(c, c.refresh)).res.status).toBe(400);
  });

  it('revoking the refresh token does the same, including a later access token use: 401', async () => {
    const c = await connect();
    expect(await alive(c.token)).toBe(true);
    expect((await revokeToken(c.client, c.refresh)).res.status).toBe(200);
    const r = await mcp(c.token, 'tools/call', { name: 'my_work', arguments: {} });
    expect(r.res.status).toBe(401);
    expect(r.res.headers.get('WWW-Authenticate')).toMatch(/invalid_token/);
    expect((await refreshWith(c, c.refresh)).res.status).toBe(400);
  });

  it('revoking an old rotated token also revokes the grant (it belongs to the same grant)', async () => {
    const c = await connect();
    const r1 = await refreshWith(c, c.refresh);
    await revokeToken(c.client, c.refresh);
    expect(await alive(r1.data.access_token)).toBe(false);
  });

  it('answers 200 for unknown tokens, and a client cannot revoke another client\'s token', async () => {
    const c = await connect();
    const { data: stranger } = await registerClient();
    expect((await revokeToken(stranger, c.token)).res.status).toBe(200);
    expect((await revokeToken(c.client, 'swa_' + 'A'.repeat(43))).res.status).toBe(200);
    expect((await revokeToken(c.client, 'garbage')).res.status).toBe(200);
    expect(await alive(c.token)).toBe(true);
    expect((await o('/oauth/revoke', form({ token: c.token, client_id: 'unknown-client-id' }))).status).toBe(401);
    expect((await o('/oauth/revoke', form({ client_id: c.client.client_id }))).status).toBe(400);
    expect((await o('/oauth/revoke', form({ token: c.token }))).status).toBe(401);
    expect(await alive(c.token)).toBe(true);
  });

  it('is authoritative: a refresh that started BEFORE the revocation fails after it (the in-flight race of review 4, finding 2)', async () => {
    const c = await connect({ chosen_handle: 'race-victim' });
    const g = gate();
    const db = wrapDb(env.DB, { afterRead: async (sql) => { if (/SELECT t\.kind/.test(sql)) await g.hit(); } });
    const inFlight = refreshWith(c, c.refresh, { DB: db });   // has read a valid, unrevoked refresh token ...
    await g.reached;
    expect((await revokeToken(c.client, c.refresh)).res.status).toBe(200); // ... when the person disconnects
    expect(await alive(c.token)).toBe(false);
    g.open();
    const late = await inFlight;
    expect(late.res.status).toBe(400);
    expect(late.data.error).toBe('invalid_grant');
    expect(await count('oauth_tokens')).toBe(2);               // the late refresh minted nothing
    expect((await grantOf()).revoked_at).toBeGreaterThan(0);
    expect(await all('SELECT 1 FROM oauth_tokens WHERE revoked_at IS NULL')).toEqual([]);
    expect((await refreshWith(c, c.refresh)).res.status).toBe(400);
  });

  it('the same race with a code exchange: revoked between the read and the write, no tokens', async () => {
    const { data: client } = await registerClient();
    const { challenge, verifier } = await pkce();
    const consent = await openConsent(client, { challenge });
    const code = codeOf((await decide(consent, { decision: 'approve', mode: 'handle', scope: ['read'] })).data.redirect_to);
    const g = gate();
    const db = wrapDb(env.DB, { afterRead: async (sql) => { if (/FROM oauth_codes c JOIN oauth_grants/.test(sql)) await g.hit(); } });
    const inFlight = exchange(client, code, verifier, { over: { DB: db } });
    await g.reached;
    await env.DB.prepare("UPDATE oauth_grants SET revoked_at = ?1, revoked_reason = 'revoked'").bind(Date.now()).run();
    g.open();
    expect((await inFlight).res.status).toBe(400);
    expect(await count('oauth_tokens')).toBe(0);
  });

  it('a request already past the token check is stopped at the contributor lookup when the grant is revoked in between', async () => {
    const c = await connect({ chosen_handle: 'mid-request' });
    const g = gate();
    const db = wrapDb(env.DB, { afterRead: async (sql) => { if (/FROM oauth_tokens t JOIN oauth_grants g ON g\.id = t\.grant_id JOIN contributors c/.test(sql)) await g.hit(); } });
    const inFlight = rpc('tools/call', { name: 'my_work', arguments: {} }, { headers: { Authorization: `Bearer ${c.token}` }, over: { ...OVER, DB: db } });
    await g.reached;
    await revokeToken(c.client, c.token);
    g.open();
    const r = await inFlight;
    expect(r.res.status).toBe(401);
    expect(r.body.error.message).toMatch(/revoked/);
  });
});

describe('the MCP endpoint', () => {
  it('maps a token to the contributor, with the scopes of its grant', async () => {
    const c = await connect({ chosen_handle: 'mapped', grant: ['read', 'work'] });
    expect((await mcpTool(c.token, 'my_work')).data.handle).toBe('mapped');
    const g = await grantOf();
    expect(g).toMatchObject({ scope: 'read work', resource: `${ORIGIN}/mcp` });
    expect((await one('SELECT handle FROM contributors WHERE id = ?1', g.contributor)).handle).toBe('mapped');
  });

  it('scope is enforced per tool: every tool against every grant', async () => {
    await addTask({ units: 3 });
    const args = { my_work: {}, my_week: {}, submission_status: { id: 1 }, next_task: {}, claim_task: { id: 1 }, release_task: { id: 1 }, link_account: { code: 'SWARM-AAAA-BBBB' }, set_credit: { credit: 'anonymous' }, remove_handle: {}, submit_work: { task_id: 1, body: BODY, sources: [SOURCE] } };
    expect(Object.keys(args).sort()).toEqual(Object.keys(SCOPE_FOR_TOOL).sort());
    for (const grant of [['read'], ['read', 'work'], ['read', 'submit'], ['read', 'work', 'submit']]) {
      const c = await connect({ grant });
      for (const [tool, scope] of Object.entries(SCOPE_FOR_TOOL)) {
        const r = await mcpTool(c.token, tool, args[tool]);
        if (grant.includes(scope)) expect(r.res.status, `${tool} with ${grant}`).toBe(200);
        else {
          expect(r.res.status, `${tool} with ${grant}`).toBe(403);
          expect(r.res.headers.get('WWW-Authenticate')).toMatch(new RegExp(`error="insufficient_scope", scope="read ${scope}"`));
        }
      }
    }
  });

  it('a missing or wrong credential on a tool that needs one is the challenge that starts sign-in', async () => {
    const { res } = await rpc('tools/call', { name: 'next_task', arguments: {} }, { over: OVER });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(`Bearer realm="OAuth", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="read"`);
    expect((await rpc('tools/call', { name: 'list_projects', arguments: {} }, { over: OVER })).res.status).toBe(200);
  });

  it('contributor keys (swk_) work exactly as before, for every tool class, with OAuth on, and are never read as OAuth tokens', async () => {
    await addTask({ units: 3 });
    const u = await newUser();
    const got = await u.call('next_task');
    expect(got.isError, got.text).toBe(false);
    expect((await u.call('submit_work', { task_id: got.data.task.id, body: BODY, sources: [SOURCE] })).isError).toBe(false);
    expect((await u.call('my_work')).data.handle).toBe(u.handle);
    expect((await u.call('my_week')).isError).toBe(false);
    const wrong = await rpc('tools/call', { name: 'my_work', arguments: {} }, { headers: { Authorization: 'Bearer swk_' + 'a'.repeat(30) }, over: OVER });
    expect(wrong.res.status).toBe(200); // a wrong KEY is a tool error, not a 401
    expect(wrong.body.result.isError).toBe(true);
    const viaArg = await rpc('tools/call', { name: 'my_work', arguments: { contributor_key: u.key } }, { over: OVER });
    expect(viaArg.body.result.structuredContent.handle).toBe(u.handle);
    // A key still works while an OAuth connection of someone else is revoked, and with OAuth off.
    const c = await connect(); await revokeToken(c.client, c.token);
    expect((await u.call('my_work')).isError).toBe(false);
    expect((await u.call('my_work', {}, { over: { OAUTH: 'off' } })).isError).toBe(false);
  });

  it('with OAuth off a bearer token is never looked up', async () => {
    const c = await connect();
    const r = await rpc('tools/call', { name: 'my_work', arguments: {} }, { headers: { Authorization: `Bearer ${c.token}` }, over: { ...OVER, OAUTH: 'off' } });
    expect(r.res.status).toBe(200);
    expect(r.body.result.isError).toBe(true);
  });

  it('an operator revoking the contributor revokes all of its grants in the same transaction: 401, and no refresh', async () => {
    const f = await accessFixture();
    const c = await connect({ chosen_handle: 'to-be-revoked' });
    const second = await connect({ mode: 'handle', chosen_handle: 'untouched' });
    const id = (await one("SELECT id FROM contributors WHERE handle = 'to-be-revoked'")).id;
    expect(await alive(c.token)).toBe(true);
    expect((await f.post('revoke', { contributor_id: id })).status).toBe(200);
    expect((await mcp(c.token, 'tools/call', { name: 'my_work', arguments: {} })).res.status).toBe(401);
    expect((await refreshWith(c, c.refresh)).res.status).toBe(400);
    expect(await all("SELECT revoked_reason FROM oauth_grants WHERE contributor = ?1", id)).toEqual([{ revoked_reason: 'operator_revoked' }]);
    expect(await alive(second.token)).toBe(true);
  });

  it('every grant of the contributor is revoked, not just the latest', async () => {
    const f = await accessFixture();
    const v = await voter();
    const a = await connect({ mode: 'passkey', cookie: v.cookie });
    const b = await connect({ mode: 'passkey', cookie: v.cookie }); // same account, same contributor, a second app
    const id = (await one('SELECT contributor FROM oauth_grants LIMIT 1')).contributor;
    expect(await count('oauth_grants')).toBe(2);
    await f.post('revoke', { contributor_id: id });
    expect(await alive(a.token)).toBe(false);
    expect(await alive(b.token)).toBe(false);
    expect(await all('SELECT 1 FROM oauth_grants WHERE revoked_at IS NULL')).toEqual([]);
  });

  it('a failed operator audit write rolls the grant revocation back with the rest', async () => {
    const f = await accessFixture();
    const c = await connect();
    const id = (await one('SELECT contributor FROM oauth_grants')).contributor;
    const db = wrapDb(env.DB, { failBatchAt: 1 });
    expect((await f.post('revoke', { contributor_id: id }, { DB: db })).status).toBe(500);
    expect(await alive(c.token)).toBe(true);
  });

  it('deleting the account revokes the grants at the same commit (the review 5 finding 8 probe)', async () => {
    const v = await voter({ allocations: null });
    const c = await connect({ mode: 'passkey', cookie: v.cookie });
    expect(await alive(c.token)).toBe(true);
    const { deleteAccount } = await import('../src/privacy.js');
    expect((await deleteAccount(env, v.id)).deleted).toBe(true);
    expect(await alive(c.token)).toBe(false);
    expect((await refreshWith(c, c.refresh)).res.status).toBe(400);
    expect((await grantOf()).revoked_reason).toBe('account_deleted');
  });
});

describe('ownership (Codex review 4, finding 1) still holds with the new server', () => {
  it('owner_account is authoritative: a passkey sign-in reuses only a contributor the account OWNS, whatever the steering link says', async () => {
    const victim = await voter(), attacker = await voter();
    const v = await connect({ mode: 'passkey', cookie: victim.cookie, chosen_handle: 'victim-owned', grant: ['read', 'work'] });
    await env.DB.prepare('DELETE FROM account_links').run();
    await env.DB.prepare("INSERT INTO account_links (account, contributor, linked_at, via) SELECT ?1, id, ?2, 'code' FROM contributors WHERE handle = 'victim-owned'").bind(attacker.id, Date.now()).run();
    const a = await connect({ mode: 'passkey', cookie: attacker.cookie, chosen_handle: 'attacker-own' });
    expect((await mcpTool(a.token, 'my_work')).data.handle).toBe('attacker-own');
    expect((await one("SELECT owner_account FROM contributors WHERE handle = 'victim-owned'")).owner_account).toBe(victim.id);
    expect((await mcpTool(v.token, 'my_work')).data.handle).toBe('victim-owned');
    expect(v.tokenRes.data.scope).toBe('read work'); // and the victim's connection never gained submit
  });

  it('a second connection for the same account never gets more than its own consent grants', async () => {
    const v = await voter();
    const limited = await connect({ mode: 'passkey', cookie: v.cookie, grant: ['read'] });
    const full = await connect({ mode: 'passkey', cookie: v.cookie, grant: ['read', 'work', 'submit'] });
    expect(limited.tokenRes.data.scope).toBe('read');
    expect((await mcpTool(limited.token, 'next_task')).res.status).toBe(403); // the later, wider grant did not widen the earlier one
    expect(full.tokenRes.data.scope).toBe('read work submit');
    const refreshed = await refreshWith(limited, limited.refresh);
    expect(refreshed.data.scope).toBe('read');
  });
});

describe('upkeep', () => {
  it('deletes what can no longer matter, and keeps live, recently revoked and recently issued state', async () => {
    const live = await connect({ chosen_handle: 'keeper' });
    const revoked = await connect({ chosen_handle: 'gone-old' });
    await revokeToken(revoked.client, revoked.token);
    const fresh = await connect({ chosen_handle: 'gone-new' });
    await revokeToken(fresh.client, fresh.token);
    const unfinished = await registerClient();
    const { challenge } = await pkce();
    const consent = await openConsent(unfinished.data, { challenge });
    await decide(consent, { decision: 'approve', mode: 'handle', scope: ['read'] }); // approved, never exchanged: a live code
    const week = 7 * 86400000;
    await env.DB.prepare("UPDATE oauth_grants SET revoked_at = ?1 WHERE id = (SELECT id FROM oauth_grants WHERE contributor = (SELECT id FROM contributors WHERE handle = 'gone-old'))").bind(Date.now() - week - 1000).run();
    await purgeOAuth(env);
    expect((await all('SELECT contributor FROM oauth_grants')).length).toBe(3); // keeper, gone-new, unfinished
    expect(await alive(live.token)).toBe(true);
    // A day later the never-exchanged grant is dead weight too; a refresh token that outlived its deadline takes its grant with it.
    await purgeOAuth(env, Date.now() + 2 * 86400000);
    expect(await count('oauth_grants')).toBe(2);
    await purgeOAuth(env, Date.now() + REFRESH_TTL_MS + 9 * 86400000);
    expect(await count('oauth_grants')).toBe(0);
    expect(await count('oauth_tokens')).toBe(0);
    expect(await count('oauth_codes')).toBe(0);
    expect(await count('oauth_consents')).toBe(0);
    expect(await count('oauth_clients')).toBe(0); // clients with no grants go after a week
  });

  it('the hourly job clears the client network hash with the other network hashes', async () => {
    await registerClient();
    expect((await one('SELECT network FROM oauth_clients')).network).toBeTruthy();
    const { forgetNetworks } = await import('../src/privacy.js');
    await forgetNetworks(env, Date.now() + 3 * 86400000);
    expect((await one('SELECT network FROM oauth_clients')).network).toBeNull();
  });
});

describe('the code', () => {
  it('no longer uses the library or the KV namespace', async () => {
    const files = import.meta.glob('../src/*.js', { query: '?raw', import: 'default', eager: true });
    for (const [name, text] of Object.entries(files)) {
      expect(text, name).not.toMatch(/workers-oauth-provider/);
      expect(text, name).not.toMatch(/OAUTH_KV|OAUTH_PROVIDER/);
    }
    const pkg = JSON.parse((await import('../package.json?raw')).default);
    expect(JSON.stringify(pkg)).not.toMatch(/oauth-provider/);
  });
});

// ---------------------------------------------------------------- Codex review 8 (own OAuth server)

describe('Codex review 8, finding 1: account deletion or suspension during consent', () => {
  const approve = (consent, v, over) => o('/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-Swarm': '1', 'CF-Connecting-IP': nextIp(), Cookie: [consent.cookie, v.cookie].join('; ') },
    body: JSON.stringify({ consent: consent.data.consent, decision: 'approve', mode: 'passkey', scope: ['read', 'work', 'submit'], chosen_handle: 'after-delete' }),
  }, over);
  const start = async () => {
    const { data: client } = await registerClient();
    const { challenge } = await pkce();
    return openConsent(client, { challenge });
  };
  const nothingIssued = async () => {
    expect(await count('oauth_grants')).toBe(0);
    expect(await count('oauth_codes')).toBe(0);
    expect(await count('oauth_tokens')).toBe(0);
    expect(await count('contributors WHERE removed = 0')).toBe(0);
  };
  const race = async (v, parkOn, whileParked, { existing = false } = {}) => {
    const consent = await start();
    const g = gate();
    const db = wrapDb(env.DB, {
      afterRead: async (sql, method, r) => { if (/owner_account = \?1 ORDER BY/.test(sql) && (existing ? !!r : !r)) await g.hit(); },
      beforeRun: async (sql) => { if (parkOn?.test(sql)) await g.hit(); },
    });
    const parked = approve(consent, v, { DB: db });
    await g.reached;
    await whileParked();
    g.open();
    return parked;
  };

  it('deleted before the first contributor is created: nothing is created or issued', async () => {
    const { deleteAccount } = await import('../src/privacy.js');
    const v = await voter({ allocations: null });
    const res = await race(v, null, async () => { expect((await deleteAccount(env, v.id)).deleted).toBe(true); });
    expect(res.status).toBeGreaterThanOrEqual(400);
    await nothingIssued();
  });

  it('deleted between creating the contributor and the grant: no grant, no code', async () => {
    const { deleteAccount } = await import('../src/privacy.js');
    const v = await voter({ allocations: null });
    const consent = await start();
    const g = gate();
    const db = wrapDb(env.DB, { beforeRun: async (sql) => { if (/INSERT INTO events/.test(sql)) await g.hit(); } });
    const parked = approve(consent, v, { DB: db });
    await g.reached; // the contributor row exists now
    expect((await deleteAccount(env, v.id)).deleted).toBe(true);
    g.open();
    expect((await parked).status).toBeGreaterThanOrEqual(400);
    await nothingIssued();
  });

  it('suspended before the first contributor is created: nothing is created or issued', async () => {
    const v = await voter({ allocations: null });
    const res = await race(v, null, async () => { await env.DB.prepare('UPDATE accounts SET suspended = 1 WHERE id = ?1').bind(v.id).run(); });
    expect(res.status).toBeGreaterThanOrEqual(400);
    await nothingIssued();
  });

  it('an existing contributor: deleted or suspended while the consent is open, no grant is issued', async () => {
    const { deleteAccount } = await import('../src/privacy.js');
    const first = await voter({ allocations: null });
    await connect({ mode: 'passkey', cookie: first.cookie, chosen_handle: 'already-owned' });
    for (const t of ['oauth_tokens', 'oauth_codes', 'oauth_grants']) await env.DB.prepare(`DELETE FROM ${t}`).run();
    const res = await race(first, null, async () => { expect((await deleteAccount(env, first.id)).deleted).toBe(true); }, { existing: true });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await count('oauth_grants')).toBe(0);
    expect(await count('oauth_codes')).toBe(0);

    const second = await voter({ allocations: null });
    await connect({ mode: 'passkey', cookie: second.cookie, chosen_handle: 'second-owned' });
    const before = await count('oauth_grants');
    const res2 = await race(second, null, async () => { await env.DB.prepare('UPDATE accounts SET suspended = 1 WHERE id = ?1').bind(second.id).run(); }, { existing: true });
    expect(res2.status).toBeGreaterThanOrEqual(400);
    expect(await count('oauth_grants')).toBe(before);
  });
});

describe('Codex review 8, finding 2: refresh downscoping', () => {
  const refreshScope = async (c, refresh, extra = {}) => {
    const res = await o('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: c.client.client_id, ...extra }));
    return { res, data: await res.json() };
  };

  it('a refresh asking for read gets a token with exactly read, enforced at MCP; the grant stays the ceiling', async () => {
    const c = await connect();
    const r = await refreshScope(c, c.refresh, { scope: 'read' });
    expect(r.res.status).toBe(200);
    expect(r.data.scope).toBe('read');
    expect((await mcpTool(r.data.access_token, 'my_work')).res.status).toBe(200);
    expect((await mcpTool(r.data.access_token, 'next_task')).res.status).toBe(403);
    expect((await mcpTool(r.data.access_token, 'submit_work', { task_id: 1, body: BODY, sources: [SOURCE] })).res.status).toBe(403);
    expect((await mcpTool(r.data.access_token, 'link_account', { code: 'SWARM-ABCD-2345' })).res.status).toBe(403); // ownership-changing
    const full = await refreshScope(c, r.data.refresh_token); // the next refresh may ask for the whole grant again
    expect(full.data.scope).toBe('read work submit');
    expect((await mcpTool(full.data.access_token, 'next_task')).res.status).not.toBe(403);
    const sub = await refreshScope(c, full.data.refresh_token, { scope: 'work read' });
    expect(sub.data.scope).toBe('read work'); // in the grant's order
  });

  it('more than the grant, nothing, or an unknown name fails with invalid_scope', async () => {
    const c = await connect({ grant: ['read', 'work'] });
    for (const scope of ['read work submit', 'submit', 'read bogus', '', ' ']) {
      const r = await refreshScope(c, c.refresh, { scope });
      expect(r.data.error, JSON.stringify(scope)).toBe('invalid_scope');
    }
    expect((await refreshScope(c, c.refresh, { scope: 'read' })).res.status).toBe(200); // none of that spent the token
  });

  it('a retry returns the cached pair only for the same scope, and its response and token carry that scope', async () => {
    const c = await connect();
    const r1 = await refreshScope(c, c.refresh, { scope: 'read' });
    const same = await refreshScope(c, c.refresh, { scope: 'read' });
    expect(same.res.status).toBe(200);
    expect(same.data.access_token).toBe(r1.data.access_token);
    expect(same.data.scope).toBe('read');
    for (const extra of [{}, { scope: 'read work' }]) {
      const wider = await refreshScope(c, c.refresh, extra);
      expect(wider.data.error).toBe('invalid_scope');
      expect(wider.data.access_token).toBeUndefined();
    }
    expect((await grantOf()).revoked_at).toBeNull(); // a wrong-scope retry is refused, not treated as theft
    expect((await mcpTool(r1.data.access_token, 'next_task')).res.status).toBe(403);
  });
});

describe('Codex review 8, finding 3: refresh and resource', () => {
  it('a foreign resource is invalid_target, before anything rotates, on a fresh refresh and on a retry', async () => {
    const c = await connect();
    const bad = await o('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.client.client_id, resource: 'https://other.example/mcp' }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('invalid_target');
    expect(await count('oauth_tokens WHERE rotated_at IS NOT NULL')).toBe(0);
    const ok = await o('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.client.client_id, resource: `${ORIGIN}/mcp` }));
    expect(ok.status).toBe(200);
    const retry = await o('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.client.client_id, resource: 'https://other.example/mcp' }));
    expect((await retry.json()).error).toBe('invalid_target');
    expect((await grantOf()).revoked_at).toBeNull();
    expect((await refreshWith(c, c.refresh)).res.status).toBe(200); // the same-pair retry still works without resource
  });
});

describe('Codex review 8, finding 4: unknown authorization scope', () => {
  it('is invalid_scope back at the client, never the full default; absent scope still offers everything', async () => {
    const { data: client } = await registerClient();
    const { challenge } = await pkce();
    for (const scope of ['totally-unknown', 'read bogus', '', '   ']) {
      const res = await o(authorizeUrl(client, { challenge, scope }), { redirect: 'manual', headers: { 'CF-Connecting-IP': nextIp() } });
      expect(res.status, JSON.stringify(scope)).toBe(302);
      const to = new URL(res.headers.get('Location'));
      expect(to.searchParams.get('error')).toBe('invalid_scope');
      expect(to.searchParams.get('state')).toBe('st4te');
    }
    expect(await count('oauth_consents')).toBe(0);
    const none = await openConsent(client, { challenge, scope: null });
    expect(none.data.scopes.every((s) => s.requested)).toBe(true);
    const some = await openConsent(client, { challenge, scope: 'read work' });
    expect(some.data.scopes.filter((s) => s.requested).map((s) => s.id)).toEqual(['read', 'work']);
  });
});
