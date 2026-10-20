// MCP authorization (OAuth 2.1 with PKCE) for the Swarm MCP endpoint, on @cloudflare/workers-oauth-provider.
//
// What the library does: discovery metadata (RFC 8414 and RFC 9728), dynamic client registration (RFC 7591) with redirect URI
// validation, PKCE (S256, required for public clients), the token endpoint, refresh-token rotation, and token validation for /mcp.
// What this file adds: the /authorize page (a consent page, with the two sign-in choices) and the mapping from an access token to a
// contributor. The access token's props are { contributor: <id> }; its scopes are read, work and submit, enforced per tool in mcp.js.
//
// Existing bearer `swk_` keys are not OAuth tokens: worker.js sends them straight to the MCP handler, never through the provider.
import OAuthProvider, { AuthorizationError } from '@cloudflare/workers-oauth-provider';
import { privateJson, rpOrigin, session, writeGuard } from './accounts.js';
import { IdentityError, MAX_PAIRS_PER_NETWORK_PER_DAY, checkHandle, createContributor } from './identity.js';
import { SCOPES, SCOPE_TEXT } from './oauth-scopes.js';
import { SECURITY_HEADERS, ipHashFor, readJson } from './lib.js';
import { linkDirect, ownedContributor } from './steering.js';

export { oauthEnabled } from './oauth-scopes.js';

const providers = new Map();

// One provider per origin (the origin is the issuer and the token audience). `apiFetch` serves /mcp for requests that carry a
// valid OAuth access token; `appFetch` serves everything else the provider does not own (including /authorize).
export function providerFor(env, apiFetch, appFetch) {
  const origin = rpOrigin(env);
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider({
      apiRoute: '/mcp',
      apiHandler: { fetch: apiFetch },
      defaultHandler: { fetch: appFetch },
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: SCOPES,
      requiredScopes: ['read'],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: 'Swarm AI', bearer_methods_supported: ['header'] },
      // Public MCP clients (Claude, ChatGPT, Codex, Cursor) register themselves; PKCE is required for them, redirect URIs are
      // validated exactly (https, or http on loopback), and private-use schemes and Client ID Metadata Documents stay off.
      clientIdMetadataDocumentEnabled: false,
      onError: ({ code, status }) => { if (status >= 500) console.error('oauth error', code, status); },
    });
    providers.set(origin, p);
  }
  return p;
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; upgrade-insecure-requests";
const PAGE_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', ...SECURITY_HEADERS };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// JSON for a data block: nothing in it can close the script element or start a comment.
const dataBlock = (o) => JSON.stringify(o).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const FONTS = 'https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=JetBrains+Mono:wght@400;500&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,600;1,6..72,400&display=swap';

// Cookies add up; every other header the library sets replaces ours, so nothing is sent twice.
function copyHeaders(to, from) {
  for (const c of from.getSetCookie()) to.append('Set-Cookie', c);
  for (const [k, v] of from) if (k.toLowerCase() !== 'set-cookie') to.set(k, v);
}

function errorPage(message, status = 400) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Swarm AI: connection problem</title><link rel="stylesheet" href="/css/site.css"></head><body class="inner"><main class="wrap" style="padding-top:4rem"><div class="panel-card"><h1>This connection can't continue</h1><p>${esc(message)}</p><p>Go back to your AI app and start the connection again. Nothing was connected.</p></div></main></body></html>`;
  return new Response(body, { status, headers: PAGE_HEADERS });
}

function consentPage(data) {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Swarm AI: connect your AI</title>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="/css/site.css">
<link rel="stylesheet" href="/css/vote.css">
<link rel="stylesheet" href="/css/me.css">
</head>
<body class="inner">
<main id="main" class="wrap authorize" style="padding-top:3rem">
<p class="eyebrow">Swarm AI</p>
<h1 id="auth-title">Connect your AI</h1>
<p id="auth-message" role="status" aria-live="polite"></p>
<div id="auth-root"><noscript><p>This page needs JavaScript to ask for your choice. Nothing is connected without it.</p></noscript></div>
</main>
<script id="auth-data" type="application/json">${dataBlock(data)}</script>
<script src="/js/authorize.js"></script>
</body>
</html>`;
  return body;
}

// GET /authorize and POST /authorize. Reached through the provider's defaultHandler, so env.OAUTH_PROVIDER is set.
export async function handleAuthorize(req, env) {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth) return errorPage('Sign-in for AI apps is not available right now.', 503);
  try {
    if (req.method === 'GET') return await showConsent(req, env, oauth);
    if (req.method === 'POST') return await decide(req, env, oauth);
    return new Response('Use GET or POST.\n', { status: 405, headers: { Allow: 'GET, POST', 'Content-Type': 'text/plain; charset=utf-8' } });
  } catch (err) {
    // Errors about the request itself. Redirect back to the client only when the library says the client and redirect URI are validated.
    if (err instanceof AuthorizationError) {
      if (req.method === 'GET' && err.redirectTo) return Response.redirect(err.redirectTo, 302);
      return req.method === 'POST' ? privateJson({ error: err.description || 'That request is not valid. Start the connection again.' }, 400) : errorPage(err.description || 'That request is not valid.');
    }
    if (err && err.name === 'CimdFetchError') return errorPage('That app could not be verified.');
    throw err;
  }
}

async function showConsent(req, env, oauth) {
  const request = await oauth.parseAuthRequest(req);
  const details = await oauth.describeConsent(request); // before beginConsent: a failed lookup leaves nothing in KV
  const consent = await oauth.beginConsent(request);
  const asked = new Set(details.scope);
  const data = {
    consent: consent.handle,
    client: {
      name: details.clientName, domain: details.clientDomain ?? null, redirect_host: details.redirectHost, loopback: !!details.redirectIsLoopback,
    },
    scopes: SCOPES.map((id) => ({ id, text: SCOPE_TEXT[id], requested: asked.size === 0 || asked.has(id), required: id === 'read' })),
  };
  const headers = new Headers();
  copyHeaders(headers, consent.headers);
  for (const [k, v] of Object.entries(PAGE_HEADERS)) headers.set(k, v); // ours win: the page's CSP lets its own script run
  return new Response(consentPage(data), { headers });
}

// The page's JSON POST. Same guards as every other write: exact Origin, X-Swarm: 1, rate limit.
async function decide(req, env, oauth) {
  const guard = await writeGuard(req, env); if (guard) return guard;
  const body = await readJson(req, 4096);
  if (!body || typeof body.consent !== 'string' || body.consent.length > 200) return privateJson({ error: 'Expected a JSON object.' }, 400);
  const respond = (redirectTo, headers) => {
    const h = new Headers(); copyHeaders(h, headers);
    h.set('Content-Type', 'application/json; charset=utf-8'); h.set('Cache-Control', 'no-store');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
    return new Response(JSON.stringify({ redirect_to: redirectTo }), { status: 200, headers: h });
  };

  if (body.decision === 'deny') {
    const denied = await oauth.denyConsent(req, body.consent);
    return respond(denied.redirectTo, denied.headers);
  }
  if (body.decision !== 'approve') return privateJson({ error: 'Choose Allow or Deny.' }, 400);

  const scope = Array.isArray(body.scope) ? [...new Set(body.scope)] : [];
  if (!scope.includes('read') || scope.length > SCOPES.length || scope.some((s) => !SCOPES.includes(s))) return privateJson({ error: 'Choose scopes from read, work and submit. Read is always included.' }, 400);
  if (body.mode !== 'handle' && body.mode !== 'passkey') return privateJson({ error: 'Choose how to connect.' }, 400);

  // Decide who this connection is for BEFORE consuming the consent handle, so a refusal leaves the page usable.
  let account = null;
  if (body.mode === 'passkey') {
    account = await session(req, env);
    if (!account) return privateJson({ error: 'Sign in with your passkey first.' }, 401);
  }
  let chosen;
  if (body.chosen_handle !== undefined && body.chosen_handle !== null && body.chosen_handle !== '') {
    try { checkHandle(body.chosen_handle); } catch (err) { return privateJson({ error: err.message }, 400); }
    chosen = body.chosen_handle;
  }

  const ipHash = await ipHashFor(env, req);
  // Passkey mode acts only for a contributor this account OWNS (created here, or first linked to it): the steering link alone,
  // which a link code can move, is not proof of ownership.
  let contributor = account ? await ownedContributor(env, account.id) : null;
  if (!contributor) {
    // Refuse what is certain to fail before the consent handle is spent; createContributor below enforces the same rules atomically.
    if (chosen && await env.DB.prepare('SELECT 1 AS n FROM contributors WHERE handle = ?1').bind(chosen).first()) return privateJson({ error: 'That handle is taken. Pick another.' }, 409);
    const [today, yesterday] = [ipHash, await ipHashFor(env, req, 1)];
    const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM contributors WHERE pair_ip IN (?1, ?2) AND created >= ?3').bind(today, yesterday, Date.now() - 86400000).first();
    if (recent.n >= MAX_PAIRS_PER_NETWORK_PER_DAY) return privateJson({ error: 'Too many pairings from this network today. Try again tomorrow.' }, 409);
  }

  const approved = await oauth.approveConsent(req, body.consent, { scope });
  if (!contributor) {
    try { contributor = await createContributor(env, req, ipHash, chosen, account?.id ?? null); } catch (err) {
      if (err instanceof IdentityError) return privateJson({ error: err.message }, 409);
      throw err;
    }
    if (account) await linkDirect(env, account.id, contributor.id, 'oauth');
  }
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request, // from storage, not from the form
    userId: `c${contributor.id}`,
    metadata: {},
    scope: approved.request.scope,
    props: { contributor: contributor.id },
  });
  return respond(redirectTo, approved.headers);
}
