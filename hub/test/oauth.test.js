// MCP authorization: discovery, dynamic registration, PKCE, the consent page, token-to-contributor mapping, scopes per tool,
// the origin and CSRF checks on /authorize, and that contributor keys and public tools keep working unchanged.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { BODY, SOURCE, addTask, newUser, resetDb, rpc, send } from './helpers.js';
import { ORIGIN, OVER, REDIRECT, authorizeUrl, codeOf, connect, decide, exchange, mcp, mcpTool, o, openConsent, pkce, registerClient } from './oauth-helpers.js';
import { setupProjects, voter } from './voter.js';
import { SCOPE_FOR_TOOL } from '../src/oauth-scopes.js';

beforeEach(async () => {
  await resetDb();
  await setupProjects();
});

describe('discovery', () => {
  it('publishes authorization server metadata with S256 PKCE, registration and the three scopes', async () => {
    const res = await o('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const m = await res.json();
    expect(m.issuer).toBe(ORIGIN);
    expect(m.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
    expect(m.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(m.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.scopes_supported).toEqual(['read', 'work', 'submit']);
    expect(m.grant_types_supported).toContain('authorization_code');
    expect(m.client_id_metadata_document_supported).toBeFalsy();
  });

  it('publishes protected resource metadata for /mcp', async () => {
    const res = await o('/.well-known/oauth-protected-resource/mcp');
    expect(res.status).toBe(200);
    const m = await res.json();
    expect(m.resource).toBe(`${ORIGIN}/mcp`);
    expect(m.authorization_servers).toEqual([ORIGIN]);
    expect(m.scopes_supported).toEqual(['read']);
    expect(m.bearer_methods_supported).toEqual(['header']);
  });

  it('answers a tool that needs credentials, with none, with a 401 that points at the metadata; public tools stay open', async () => {
    const { res, body } = await rpc('tools/call', { name: 'next_task', arguments: {} }, { over: OVER });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(`Bearer realm="OAuth", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="read"`);
    expect(res.headers.get('Access-Control-Expose-Headers')).toMatch(/WWW-Authenticate/);
    expect(body.error.message).toMatch(/needs a contributor key/);
    const open = await rpc('tools/call', { name: 'list_projects', arguments: {} }, { over: OVER });
    expect(open.res.status).toBe(200);
    expect((await rpc('tools/list', {}, { over: OVER })).res.status).toBe(200);
  });

  it('a wrong OAuth token is a 401 from the provider; a wrong contributor key is still a tool error', async () => {
    const bad = await mcp('not-a-real-token', 'tools/call', { name: 'my_work', arguments: {} });
    expect(bad.res.status).toBe(401);
    expect(bad.res.headers.get('WWW-Authenticate')).toMatch(/invalid_token/);
    const key = await rpc('tools/call', { name: 'my_work', arguments: {} }, { headers: { Authorization: 'Bearer swk_' + 'a'.repeat(30) }, over: OVER });
    expect(key.res.status).toBe(200);
    expect(key.body.result.isError).toBe(true);
    expect(key.body.result.content[0].text).toMatch(/not recognized/);
  });

  it('with OAUTH off the endpoints are not served and a missing key is the old tool message', async () => {
    const off = { ...OVER, OAUTH: 'off' };
    expect((await o('/authorize', {}, off)).status).toBe(503);
    expect((await o('/.well-known/oauth-authorization-server', {}, off)).status).not.toBe(200);
    const { res, body } = await rpc('tools/call', { name: 'next_task', arguments: {} }, { over: off });
    expect(res.status).toBe(200);
    expect(body.result.isError).toBe(true);
  });
});

describe('dynamic client registration', () => {
  it('registers a public client and returns a client id', async () => {
    const { res, data } = await registerClient({ client_name: 'Claude' });
    expect(res.status).toBe(201);
    expect(data.client_id).toBeTruthy();
    expect(data.client_name).toBe('Claude');
    expect(data.redirect_uris).toEqual([REDIRECT]);
    expect(data.client_secret).toBeUndefined();
  });

  it('accepts loopback http redirects (Claude Code, Codex) on any port', async () => {
    const { res } = await registerClient({ redirect_uris: ['http://127.0.0.1:53682/callback', 'http://localhost:33418/callback'] });
    expect(res.status).toBe(201);
  });

  it('refuses redirect URIs that are not https or loopback http, and dangerous schemes', async () => {
    for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'data:text/html,x', 'https://client.example/cb#frag', 'ftp://client.example/cb', 'https://user:pw@client.example/cb', 'not a url']) {
      const { res } = await registerClient({ redirect_uris: [uri] });
      expect(res.status, uri).toBe(400);
    }
    expect((await registerClient({ redirect_uris: [] })).res.status).toBe(400);
  });

  it('is rate limited per network like the other writes', async () => {
    const limiter = { limit: async () => ({ success: false }) };
    const res = await o('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.77' }, body: '{}' }, { LIMITER: limiter });
    expect(res.status).toBe(429);
  });
});

describe('the consent page', () => {
  it('shows the client name and where tokens go, in a data block, with a strict CSP and no framing', async () => {
    const { data: client } = await registerClient({ client_name: 'Claude', redirect_uris: ['https://claude.example/cb'] });
    const { challenge } = await pkce();
    const page = await openConsent(client, { challenge, redirect: 'https://claude.example/cb' });
    expect(page.res.status).toBe(200);
    expect(page.data.client).toMatchObject({ name: 'Claude', redirect_host: 'claude.example', loopback: false });
    expect(page.data.scopes.map((s) => s.id)).toEqual(['read', 'work', 'submit']);
    expect(page.data.scopes.find((s) => s.id === 'read').required).toBe(true);
    const csp = page.res.headers.get('Content-Security-Policy');
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(page.res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(page.res.headers.get('Cache-Control')).toBe('no-store');
    expect(page.cookie).toMatch(/__Host-oauth-consent/);
    expect(page.html).not.toMatch(/<script>[^<]/); // no inline script besides the JSON data block
    expect(page.html).toContain('/js/authorize.js');
  });

  it('cannot be turned into markup by a hostile client name', async () => {
    const name = '</script><img src=x onerror=alert(1)>"\'&';
    const { data: client } = await registerClient({ client_name: name });
    const { challenge } = await pkce();
    const page = await openConsent(client, { challenge });
    expect(page.data.client.name).toBe(name); // the data survives intact as JSON
    expect(page.html).not.toContain('<img');
    expect(page.html.match(/<\/script>/g)).toHaveLength(2); // the data block and the page script, nothing injected
    expect(page.html).not.toContain(name);
  });

  it('marks a loopback redirect so the page can warn', async () => {
    const { data: client } = await registerClient({ redirect_uris: ['http://127.0.0.1:5555/cb'] });
    const { challenge } = await pkce();
    const page = await openConsent(client, { challenge, redirect: 'http://127.0.0.1:5555/cb' });
    expect(page.data.client.loopback).toBe(true);
  });

  it('refuses an unregistered redirect URI on the page, never redirecting there', async () => {
    const { data: client } = await registerClient();
    const { challenge } = await pkce();
    const res = await o(authorizeUrl(client, { challenge, redirect: 'https://evil.example/steal' }));
    expect(res.status).toBe(400);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('refuses an unknown client on the page', async () => {
    const { challenge } = await pkce();
    const res = await o(authorizeUrl({ client_id: 'nope' }, { challenge }));
    expect(res.status).toBe(400);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('requires PKCE: a request without a challenge, or with the plain method, goes back to the client as an error', async () => {
    const { data: client } = await registerClient();
    for (const opts of [{}, { challenge: 'abc', method: 'plain' }]) {
      const res = await o(authorizeUrl(client, opts), { redirect: 'manual' });
      expect([302, 400], JSON.stringify(opts)).toContain(res.status);
      if (res.status === 302) {
        const to = new URL(res.headers.get('Location'));
        expect(to.origin + to.pathname).toBe(REDIRECT);
        expect(to.searchParams.get('error')).toBe('invalid_request');
        expect(to.searchParams.get('state')).toBe('st4te');
      }
    }
  });

  it('refuses a resource that is not this server', async () => {
    const { data: client } = await registerClient();
    const { challenge } = await pkce();
    const res = await o(authorizeUrl(client, { challenge, resource: 'https://other.example/mcp' }), { redirect: 'manual' });
    expect(res.status === 400 || (res.status === 302 && new URL(res.headers.get('Location')).searchParams.get('error') === 'invalid_target')).toBe(true);
  });
});

describe('the authorize decision: origin and CSRF checks', () => {
  async function page() {
    const { data: client } = await registerClient();
    const { challenge, verifier } = await pkce();
    return { client, verifier, consent: await openConsent(client, { challenge }) };
  }
  const approve = { decision: 'approve', mode: 'handle', scope: ['read', 'work'] };

  it('needs the exact Origin and X-Swarm: 1, and writes nothing without them', async () => {
    const { consent } = await page();
    const before = (await env.DB.prepare('SELECT COUNT(*) AS n FROM contributors').first()).n;
    for (const headers of [{ Origin: 'https://evil.example' }, { Origin: '' }, { Origin: ORIGIN + '.evil.example' }, { 'X-Swarm': '' }, { 'X-Swarm': '2' }]) {
      const r = await decide(consent, approve, { headers });
      expect(r.res.status, JSON.stringify(headers)).toBe(403);
      expect(r.data.redirect_to).toBeUndefined();
    }
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM contributors').first()).n).toBe(before);
    // The page is still good: the refused attempts did not spend it.
    expect((await decide(consent, approve)).res.status).toBe(200);
  });

  it('is bound to the browser that opened the page: another browser, a wrong handle, or a replay is refused', async () => {
    const { consent } = await page();
    const otherBrowser = { ...consent, cookie: '' };
    expect((await decide(otherBrowser, approve)).res.status).toBe(400);
    expect((await decide({ ...consent, data: { consent: 'wrong' } }, approve)).res.status).toBe(400);
    const first = await decide(consent, approve);
    expect(first.res.status).toBe(200);
    expect((await decide(consent, approve)).res.status).toBe(400); // single use
  });

  it('rejects malformed bodies, scopes outside read/work/submit, a missing read scope and an unknown mode', async () => {
    const { consent } = await page();
    for (const body of [
      { decision: 'maybe', mode: 'handle', scope: ['read'] },
      { decision: 'approve', mode: 'handle', scope: ['work'] },
      { decision: 'approve', mode: 'handle', scope: ['read', 'admin'] },
      { decision: 'approve', mode: 'handle', scope: 'read' },
      { decision: 'approve', mode: 'email', scope: ['read'] },
      { decision: 'approve', scope: ['read'] },
      { decision: 'approve', mode: 'handle', scope: ['read'], chosen_handle: 'x' },
      { decision: 'approve', mode: 'handle', scope: ['read'], chosen_handle: 'swarm-admin' },
    ]) expect((await decide(consent, body)).res.status, JSON.stringify(body)).toBe(400);
    expect((await decide(consent, approve)).res.status).toBe(200); // still usable after all of that
  });

  it('GET and POST only', async () => {
    expect((await o('/authorize', { method: 'PUT' })).status).toBe(405);
    expect((await o('/authorize', { method: 'DELETE' })).status).toBe(405);
  });

  it('a deny goes back to the client with access_denied and creates nothing', async () => {
    const { consent } = await page();
    const before = (await env.DB.prepare('SELECT COUNT(*) AS n FROM contributors').first()).n;
    const r = await decide(consent, { decision: 'deny' });
    expect(r.res.status).toBe(200);
    const to = new URL(r.data.redirect_to);
    expect(to.searchParams.get('error')).toBe('access_denied');
    expect(to.searchParams.get('state')).toBe('st4te');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM contributors').first()).n).toBe(before);
  });
});

describe('pseudonymous handle: authorization code, PKCE and the token', () => {
  it('runs the whole flow and maps the access token to the new contributor', async () => {
    const c = await connect({ chosen_handle: 'oauth-friend' });
    expect(c.decision.res.status).toBe(200);
    const to = new URL(c.decision.data.redirect_to);
    expect(to.origin + to.pathname).toBe(REDIRECT);
    expect(to.searchParams.get('state')).toBe('st4te');
    expect(c.tokenRes.res.status).toBe(200);
    expect(c.tokenRes.data.token_type).toBe('bearer');
    expect(c.token).toBeTruthy();
    expect(c.refresh).toBeTruthy();
    const r = await mcpTool(c.token, 'my_work');
    expect(r.isError, r.text).toBe(false);
    expect(r.data.handle).toBe('oauth-friend');
    // A contributor with no account: no link, no usable key.
    const row = await env.DB.prepare("SELECT id, key_hash FROM contributors WHERE handle = 'oauth-friend'").first();
    expect(await env.DB.prepare('SELECT 1 FROM account_links WHERE contributor = ?1').bind(row.id).first()).toBeNull();
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates a handle when none is chosen, and each connection is its own contributor', async () => {
    const a = await connect(), b = await connect();
    const ha = (await mcpTool(a.token, 'my_work')).data.handle, hb = (await mcpTool(b.token, 'my_work')).data.handle;
    expect(ha).toMatch(/^helper-/);
    expect(ha).not.toBe(hb);
  });

  it('refuses a taken handle before the page is spent, and the pairing cap per network', async () => {
    await newUser({ handle: 'already-here' });
    const { data: client } = await registerClient();
    const { challenge } = await pkce();
    const consent = await openConsent(client, { challenge });
    const dup = await decide(consent, { decision: 'approve', mode: 'handle', scope: ['read'], chosen_handle: 'already-here' });
    expect(dup.res.status).toBe(409);
    expect(dup.data.error).toMatch(/taken/);
    expect((await decide(consent, { decision: 'approve', mode: 'handle', scope: ['read'], chosen_handle: 'fresh-one' })).res.status).toBe(200); // same page, now fine
    const ip = '198.18.0.9';
    for (let i = 0; i < 5; i++) await env.DB.prepare("INSERT INTO contributors (handle, key_hash, created, pair_ip) VALUES (?1, ?2, ?3, ?4)").bind(`cap-${i}`, `kh${i}`, Date.now(), await (await import('../src/lib.js')).ipHashFor(env, new Request('https://swarm.test/', { headers: { 'CF-Connecting-IP': ip } }))).run();
    const capped = await openConsent(client, { challenge });
    const r = await decide(capped, { decision: 'approve', mode: 'handle', scope: ['read'] }, { ip });
    expect(r.res.status).toBe(409);
    expect(r.data.error).toMatch(/Too many pairings/);
  });

  it('PKCE: a wrong code_verifier fails, the right one works once, and the code cannot be replayed', async () => {
    const { data: client } = await registerClient();
    const { challenge, verifier } = await pkce();
    const consent = await openConsent(client, { challenge });
    const d = await decide(consent, { decision: 'approve', mode: 'handle', scope: ['read'] });
    const code = codeOf(d.data.redirect_to);
    const wrong = await exchange(client, code, (await pkce()).verifier);
    expect(wrong.res.status).toBe(400);
    expect(wrong.data.error).toBe('invalid_grant');
    const good = await exchange(client, code, verifier);
    expect(good.res.status).toBe(200);
    expect((await exchange(client, code, verifier)).res.status).toBe(400); // the code is single use
  });

  it('a code cannot be exchanged for a different redirect URI or client', async () => {
    const { data: client } = await registerClient({ redirect_uris: [REDIRECT, 'https://client.example/other'] });
    const { data: other } = await registerClient();
    const { challenge, verifier } = await pkce();
    const consent = await openConsent(client, { challenge });
    const code = codeOf((await decide(consent, { decision: 'approve', mode: 'handle', scope: ['read'] })).data.redirect_to);
    expect((await exchange(client, code, verifier, { redirect: 'https://client.example/other' })).res.status).toBe(400);
    expect((await exchange(other, code, verifier)).res.status).toBe(400);
  });

  it('an operator revoking the contributor stops its OAuth connection too', async () => {
    const c = await connect({ chosen_handle: 'to-be-revoked' });
    expect((await mcpTool(c.token, 'my_work')).isError).toBe(false);
    const row = await env.DB.prepare("SELECT id FROM contributors WHERE handle = 'to-be-revoked'").first();
    await env.DB.prepare("INSERT INTO events (ts, type, contributor, actor) VALUES (?1, 'contributor_revoked', ?2, 'owner@example.com')").bind(Date.now(), row.id).run();
    const r = await mcpTool(c.token, 'my_work');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/revoked by an operator/);
    expect((await mcpTool(c.token, 'next_task')).isError).toBe(true);
  });

  it('a refresh token gets a new access token for the same contributor', async () => {
    const c = await connect({ chosen_handle: 'refresher' });
    const res = await o('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '198.18.1.1' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.client.client_id }) });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.access_token).not.toBe(c.token);
    expect((await mcpTool(data.access_token, 'my_work')).data.handle).toBe('refresher');
  });
});

describe('scopes are enforced on the server, per tool', () => {
  it('every tool that needs a key maps to a scope, and the public tools to none', () => {
    expect(Object.keys(SCOPE_FOR_TOOL).sort()).toEqual(['claim_task', 'link_account', 'my_week', 'my_work', 'next_task', 'release_task', 'remove_handle', 'set_credit', 'submission_status', 'submit_work'].sort());
    expect(Object.values(SCOPE_FOR_TOOL).every((s) => ['read', 'work', 'submit'].includes(s))).toBe(true);
  });

  it('a read-only grant can read but not work or submit', async () => {
    const c = await connect({ grant: ['read'] });
    expect((await mcpTool(c.token, 'my_work')).isError).toBe(false);
    expect((await mcpTool(c.token, 'my_week')).isError).toBe(false);
    expect((await mcpTool(c.token, 'submission_status', { id: 1 })).res.status).toBe(200); // read scope reaches the tool (it answers not found)
    for (const [name, args, scope] of [['next_task', {}, 'work'], ['claim_task', { id: 1 }, 'work'], ['release_task', { id: 1 }, 'work'], ['link_account', { code: 'SWARM-AAAA-BBBB' }, 'work'], ['submit_work', { task_id: 1, body: BODY, sources: [SOURCE] }, 'submit']]) {
      const r = await mcpTool(c.token, name, args);
      expect(r.res.status, name).toBe(403);
      expect(r.res.headers.get('WWW-Authenticate'), name).toBe(`Bearer realm="OAuth", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", scope="read ${scope}"`);
      expect(r.text, name).toMatch(new RegExp(`"${scope}" scope`));
    }
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM claims').first()).n).toBe(0);
  });

  it('work without submit can claim and release but not hand in; submit works with the right scopes', async () => {
    await addTask({ units: 3 });
    const c = await connect({ grant: ['read', 'work'] });
    const got = await mcpTool(c.token, 'next_task');
    expect(got.isError, got.text).toBe(false);
    expect(got.data.claim.routing_origin).toBe('public_routed');
    const no = await mcpTool(c.token, 'submit_work', { task_id: got.data.task.id, body: BODY, sources: [SOURCE] });
    expect(no.res.status).toBe(403);
    expect((await mcpTool(c.token, 'release_task', { id: got.data.task.id })).isError).toBe(false);

    const full = await connect({ grant: ['read', 'work', 'submit'] });
    const t = await mcpTool(full.token, 'next_task');
    const sub = await mcpTool(full.token, 'submit_work', { task_id: t.data.task.id, body: BODY, sources: [SOURCE] });
    expect(sub.isError, sub.text).toBe(false);
    expect(sub.data.status).toBe('pending');
  });

  it('the grant narrows to what the person ticked, not what the client asked for', async () => {
    const c = await connect({ scope: 'read work submit', grant: ['read'] });
    expect(c.tokenRes.data.scope).toBe('read');
  });

  it('public tools need no scope at all', async () => {
    const c = await connect({ grant: ['read'] });
    for (const name of ['how_to_help', 'list_projects', 'list_tasks']) expect((await mcpTool(c.token, name)).isError, name).toBe(false);
  });

  it('a contributor key still works for every tool, with no scopes involved', async () => {
    await addTask({ units: 3 });
    const u = await newUser();
    const got = await u.call('next_task');
    expect(got.isError, got.text).toBe(false);
    expect((await u.call('submit_work', { task_id: got.data.task.id, body: BODY, sources: [SOURCE] })).isError).toBe(false);
    expect((await u.call('my_week')).isError).toBe(false);
    const viaArg = await rpc('tools/call', { name: 'my_work', arguments: { contributor_key: u.key } }, { over: OVER });
    expect(viaArg.body, JSON.stringify(viaArg.body)).toHaveProperty('result.structuredContent.handle', u.handle);
  });
});

describe('sign in with your passkey', () => {
  it('needs a signed-in session, and does not spend the page when there is none', async () => {
    const { data: client } = await registerClient();
    const { challenge } = await pkce();
    const consent = await openConsent(client, { challenge });
    const r = await decide(consent, { decision: 'approve', mode: 'passkey', scope: ['read'] });
    expect(r.res.status).toBe(401);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM contributors').first()).n).toBe(0);
    const v = await voter();
    expect((await decide(consent, { decision: 'approve', mode: 'passkey', scope: ['read'] }, { cookie: v.cookie })).res.status).toBe(200);
  });

  it('creates a contributor, links it to the account, and steers by the ballot', async () => {
    const v = await voter({ allocations: { 'swarm-ai': 100 } });
    await addTask({ project: 'town-hall' }); await addTask({ project: 'swarm-ai' });
    const c = await connect({ mode: 'passkey', cookie: v.cookie, chosen_handle: 'signed-in-ai' });
    expect(c.decision.res.status).toBe(200);
    const link = await env.DB.prepare('SELECT l.account, l.via, c.handle FROM account_links l JOIN contributors c ON c.id = l.contributor').first();
    expect(link).toEqual({ account: v.id, via: 'oauth', handle: 'signed-in-ai' });
    const r = await mcpTool(c.token, 'next_task');
    expect(r.isError, r.text).toBe(false);
    expect(r.data.task.project).toBe('swarm-ai');
    expect(r.data.claim.routing_origin).toBe('ballot_directed');
    const ev = await env.DB.prepare("SELECT detail FROM events WHERE type = 'account_linked' ORDER BY id DESC LIMIT 1").first();
    expect(JSON.parse(ev.detail)).toEqual({ via: 'oauth' });
  });

  it('reuses the account\'s contributor when it already has one: one identity per account', async () => {
    const v = await voter();
    const first = await connect({ mode: 'passkey', cookie: v.cookie, chosen_handle: 'one-identity' });
    const second = await connect({ mode: 'passkey', cookie: v.cookie, chosen_handle: 'ignored-name' });
    expect((await mcpTool(first.token, 'my_work')).data.handle).toBe('one-identity');
    expect((await mcpTool(second.token, 'my_work')).data.handle).toBe('one-identity');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM account_links').first()).n).toBe(1);
    expect(await env.DB.prepare("SELECT 1 FROM contributors WHERE handle = 'ignored-name'").first()).toBeNull();
  });

  it('a suspended account cannot sign in', async () => {
    const v = await voter({ suspended: 1 });
    const { data: client } = await registerClient();
    const { challenge } = await pkce();
    const consent = await openConsent(client, { challenge });
    expect((await decide(consent, { decision: 'approve', mode: 'passkey', scope: ['read'] }, { cookie: v.cookie })).res.status).toBe(401);
  });
});
