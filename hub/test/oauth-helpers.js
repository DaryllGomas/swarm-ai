// A small OAuth 2.1 + PKCE client for the tests: register, authorize (consent page and decision), exchange, and call /mcp.
import { b64url } from '../src/identity.js';
import { sha256 } from '../src/lib.js';
import { nextIp, rpc, send } from './helpers.js';

export const ORIGIN = 'https://swarm.test';
export const OVER = { RP_ORIGIN: ORIGIN, RP_ID: 'swarm.test' };
export const REDIRECT = 'https://client.example/callback';
export const o = (path, init = {}, over = {}) => send(path, init, { ...OVER, ...over });

export async function registerClient(body = {}, over = {}) {
  const res = await o('/oauth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
    body: JSON.stringify({ client_name: 'Test AI App', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...body }),
  }, over);
  return { res, data: await res.json().catch(() => null) };
}

export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

export function authorizeUrl(client, { challenge, scope = 'read work submit', state = 'st4te', redirect = REDIRECT, resource = `${ORIGIN}/mcp`, method = 'S256' } = {}) {
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, state, resource });
  if (scope !== null) q.set('scope', scope);
  if (challenge) { q.set('code_challenge', challenge); q.set('code_challenge_method', method); }
  return `/authorize?${q}`;
}

export const cookiesOf = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

// GET /authorize: returns the page, the data block it carries, and the cookies the browser would keep.
export async function openConsent(client, opts = {}) {
  const res = await o(authorizeUrl(client, opts), { headers: { 'CF-Connecting-IP': nextIp() } });
  const html = res.status === 200 ? await res.text() : '';
  const m = html.match(/<script id="auth-data" type="application\/json">(.*?)<\/script>/s);
  return { res, html, data: m ? JSON.parse(m[1]) : null, cookie: cookiesOf(res) };
}

export async function decide(consent, body, { cookie = '', headers = {}, ip = nextIp() } = {}) {
  const res = await o('/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-Swarm': '1', 'CF-Connecting-IP': ip, Cookie: [consent.cookie, cookie].filter(Boolean).join('; '), ...headers },
    body: JSON.stringify({ consent: consent.data?.consent, ...body }),
  });
  return { res, data: await res.json().catch(() => null) };
}

export async function exchange(client, code, verifier, { redirect = REDIRECT, over } = {}) {
  const res = await o('/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': nextIp() },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource: `${ORIGIN}/mcp` }),
  }, over);
  return { res, data: await res.json().catch(() => null) };
}

export const codeOf = (redirectTo) => new URL(redirectTo).searchParams.get('code');

// The whole dance for a pseudonymous handle: returns the client, tokens and the page data.
export async function connect({ scope = 'read work submit', grant = ['read', 'work', 'submit'], chosen_handle, mode = 'handle', cookie = '', clientBody, over } = {}) {
  const { data: client } = await registerClient(clientBody, over);
  const { verifier, challenge } = await pkce();
  const consent = await openConsent(client, { challenge, scope });
  const d = await decide(consent, { decision: 'approve', mode, scope: grant, ...(chosen_handle ? { chosen_handle } : {}) }, { cookie });
  const tok = d.data?.redirect_to ? await exchange(client, codeOf(d.data.redirect_to), verifier) : null;
  return { client, consent, decision: d, token: tok?.data?.access_token, refresh: tok?.data?.refresh_token, tokenRes: tok, verifier };
}

// MCP call with an OAuth access token.
export const mcp = (token, method, params, over) => rpc(method, params, { headers: { Authorization: `Bearer ${token}` }, over: { ...OVER, ...over } });
export const mcpTool = async (token, name, args = {}) => {
  const { res, body } = await mcp(token, 'tools/call', { name, arguments: args });
  return { res, body, isError: !!(body.result?.isError || body.error), data: body.result?.structuredContent ?? null, text: body.result?.content?.[0]?.text ?? body.error?.message };
};
export { sha256 };
