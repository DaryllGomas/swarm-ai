// MCP authorization: the /authorize consent page and its decision. The OAuth server itself (registration, codes, tokens, revocation,
// the per-request token check) is in oauth-core.js. Swarm's own code, on D1, replaced the Cloudflare OAuth provider library.
//
// The consent page is a single-use TRANSACTION stored in D1 (oauth_consents): GET /authorize validates the request and writes it, the page
// carries its handle in a JSON data block, the browser carries a second secret in a __Host- cookie, and the decision (a JSON POST) must
// present both, from the exact Origin, with X-Swarm: 1. The transaction is spent by one conditional UPDATE, so it has one winner.
// The access token's grant names { contributor }; its scopes are read, work and submit, enforced per tool in mcp.js.
//
// Existing bearer `swk_` keys are not OAuth tokens: mcp.js never sends them here.
import { workSuspended } from './suspension.js';
import { privateJson, session, writeGuard } from './accounts.js';
import { IdentityError, MAX_PAIRS_PER_NETWORK_PER_DAY, checkHandle, createContributor } from './identity.js';
import { CONSENT_TTL_MS, CODE_TTL_MS, MAX_LIVE_CONSENTS, SHAPE, getClient, random, secretHash, supersedeStmts } from './oauth-core.js';
import { SCOPES, SCOPE_TEXT, oauthEnabled, resourceUrl } from './oauth-scopes.js';
import { SECURITY_HEADERS, capHashes, ipHashFor, readJson, underRateLimit } from './lib.js';
import { syncCredit } from './privacy.js';
import { linkDirect, ownedContributor } from './steering.js';

export { oauthEnabled } from './oauth-scopes.js';

const CSP = "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; upgrade-insecure-requests";
const PAGE_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', ...SECURITY_HEADERS };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// JSON for a data block: nothing in it can close the script element or start a comment.
const dataBlock = (o) => JSON.stringify(o).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const FONTS = 'https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=JetBrains+Mono:wght@400;500&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,600;1,6..72,400&display=swap';

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

const COOKIE = '__Host-oauth-consent';
const cookieOf = (req) => {
  const v = (req.headers.get('Cookie') || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || '';
  return SHAPE.browser.test(v) ? v : '';
};
const setCookie = (secret) => `${COOKIE}=${secret}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${CONSENT_TTL_MS / 1000}`;
const browserHash = (env, secret) => secretHash(env, 'browser', secret);

// Send the browser back to the app with an OAuth error (only called once the client and redirect URI are known to match).
function backToApp(redirectUri, params) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return u.toString();
}

// GET /authorize and POST /authorize.
export async function handleAuthorize(req, env) {
  if (!oauthEnabled(env)) return errorPage('Sign-in for AI apps is not available right now.', 503);
  if (!env.HASH_SALT) return errorPage('Sign-in for AI apps is not available right now.', 503);
  if (req.method === 'GET') return showConsent(req, env);
  if (req.method === 'POST') return decide(req, env);
  return new Response('Use GET or POST.\n', { status: 405, headers: { Allow: 'GET, POST', 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function showConsent(req, env) {
  // The network limit comes first, before anything is read or written (Codex review 4, finding 6).
  if (!(await underRateLimit(env, await ipHashFor(env, req)))) return errorPage('Too many requests from this network. Wait a minute and try again.', 429);
  const q = new URL(req.url).searchParams;
  const client = await getClient(env, q.get('client_id'));
  if (!client) return errorPage('This app is not registered with Swarm.');
  // The redirect URI must be one of the registered ones, character for character. Until it is, nothing is ever sent to it.
  const given = q.get('redirect_uri');
  const redirect = given === null ? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null) : given;
  if (!redirect || !client.redirect_uris.includes(redirect)) return errorPage('This app asked to return to an address it did not register.');
  const state = q.get('state');
  const fail = (error, description) => new Response(null, { status: 302, headers: { Location: backToApp(redirect, { error, error_description: description, state }), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  if (state !== null && state.length > 512) return fail('invalid_request', 'state is too long.');
  if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
  const challenge = q.get('code_challenge');
  if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail('invalid_request', 'PKCE is required: send a code_challenge (S256).');
  if (q.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'PKCE code_challenge_method must be S256.');
  const resources = q.getAll('resource');
  if (resources.length > 1 || (resources.length === 1 && resources[0] !== resourceUrl(env))) return fail('invalid_target', 'resource must be this server\'s MCP endpoint.');
  // An absent scope offers everything; a scope that is present must name only supported scopes. It is never filtered down to
  // nothing and then widened to the default (Codex review 8, finding 4).
  const rawScope = q.get('scope');
  const asked = rawScope === null ? [] : [...new Set(rawScope.split(/\s+/).filter(Boolean))];
  if (rawScope !== null && (asked.length === 0 || asked.some((s) => !SCOPES.includes(s)))) return fail('invalid_scope', 'scope must name only: read, work, submit.');

  const handle = random('swh_'), secret = cookieOf(req) || random('', 32), now = Date.now();
  // One conditional INSERT: an open-page cap, so consent pages cannot be used to fill the database.
  const res = await env.DB.prepare(
    `INSERT INTO oauth_consents (hash, browser_hash, client, redirect_uri, state, scope, challenge, resource, expires)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE (SELECT COUNT(*) FROM oauth_consents WHERE expires > ?10) < ${MAX_LIVE_CONSENTS}`
  ).bind(await secretHash(env, 'consent', handle), await browserHash(env, secret), client.id, redirect, state, asked.join(' '), challenge, resourceUrl(env), now + CONSENT_TTL_MS, now).run();
  if (!res.meta.changes) return errorPage('Swarm is busy. Try again in a few minutes.', 503);

  let host = ''; let loopback = false;
  try { const u = new URL(redirect); host = u.host; loopback = u.protocol === 'http:'; } catch { /* validated at registration */ }
  const data = {
    consent: handle,
    expires_in_ms: CONSENT_TTL_MS,
    client: { name: client.name, domain: null, redirect_host: host, loopback },
    scopes: SCOPES.map((id) => ({ id, text: SCOPE_TEXT[id], requested: asked.length === 0 || asked.includes(id), required: id === 'read' })),
  };
  return new Response(consentPage(data), { headers: { ...PAGE_HEADERS, 'Set-Cookie': setCookie(secret) } });
}

// The page's JSON POST. Same guards as every other write: exact Origin, X-Swarm: 1, rate limit. Everything that can be refused is refused
// BEFORE the transaction is spent, so a refusal leaves the page usable; the spend itself is one conditional UPDATE.
async function decide(req, env) {
  const guard = await writeGuard(req, env); if (guard) return guard;
  const body = await readJson(req, 4096);
  if (!body || typeof body.consent !== 'string' || !SHAPE.handle.test(body.consent)) return privateJson({ error: 'Expected a JSON object.' }, 400);
  const secret = cookieOf(req);
  const consentHash = await secretHash(env, 'consent', body.consent);
  const now = Date.now();
  const txn = secret && await env.DB.prepare(
    `SELECT t.client, t.redirect_uri, t.state, t.scope FROM oauth_consents t JOIN oauth_clients c ON c.id = t.client
     WHERE t.hash = ?1 AND t.browser_hash = ?2 AND t.used = 0 AND t.expires > ?3`
  ).bind(consentHash, await browserHash(env, secret), now).first();
  if (!txn) return privateJson({ error: 'This page expired, was already used, or was opened in another browser. Start the connection again.' }, 400);
  const spend = async () => (await env.DB.prepare(
    'UPDATE oauth_consents SET used = 1, consumer = ?4 WHERE hash = ?1 AND browser_hash = ?2 AND used = 0 AND expires > ?3'
  ).bind(consentHash, await browserHash(env, secret), Date.now(), marker).run()).meta.changes === 1;
  const marker = random('', 18);
  const respond = (redirectTo) => privateJson({ redirect_to: redirectTo });

  if (body.decision === 'deny') {
    if (!(await spend())) return privateJson({ error: 'This page was already used. Start the connection again.' }, 400);
    return respond(backToApp(txn.redirect_uri, { error: 'access_denied', state: txn.state }));
  }
  if (body.decision !== 'approve') return privateJson({ error: 'Choose Allow or Deny.' }, 400);

  const scope = Array.isArray(body.scope) ? [...new Set(body.scope)] : [];
  if (!scope.includes('read') || scope.length > SCOPES.length || scope.some((s) => !SCOPES.includes(s))) return privateJson({ error: 'Choose scopes from read, work and submit. Read is always included.' }, 400);
  if (body.mode !== 'handle' && body.mode !== 'passkey') return privateJson({ error: 'Choose how to connect.' }, 400);
  // The person can only narrow what the app asked for. An app that asked for nothing specific is offered all three.
  const askedScopes = txn.scope ? txn.scope.split(' ') : SCOPES;
  const granted = SCOPES.filter((s) => scope.includes(s) && (s === 'read' || askedScopes.includes(s)));

  // Decide who this connection is for BEFORE spending the transaction, so a refusal leaves the page usable.
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
  // which a link code can move, is not proof of ownership. owner_account is authoritative (Codex review 4, finding 1).
  let contributor = account ? await ownedContributor(env, account.id) : null;
  if (!contributor) {
    // Refuse what is certain to fail before the transaction is spent; createContributor below enforces the same rules atomically.
    if (chosen && await env.DB.prepare('SELECT 1 AS n FROM contributors WHERE handle = ?1').bind(chosen).first()) return privateJson({ error: 'That handle is taken. Pick another.' }, 409);
    const net = await capHashes(env, req);
    const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM contributors WHERE pair_ip IN (?1, ?2, ?4, ?5) AND created >= ?3').bind(net.today, net.yesterday, Date.now() - 86400000, net.legacyToday, net.legacyYesterday).first();
    if (recent.n >= MAX_PAIRS_PER_NETWORK_PER_DAY) return privateJson({ error: 'Too many pairings from this network today. Try again tomorrow.' }, 409);
  }

  if (!(await spend())) return privateJson({ error: 'This page was already used. Start the connection again.' }, 400);
  if (!contributor) {
    try { contributor = await createContributor(env, req, ipHash, chosen, account?.id ?? null); } catch (err) {
      if (err instanceof IdentityError) return privateJson({ error: err.message }, 409);
      throw err;
    }
    if (account) {
      // A failed link means the account is gone or suspended: stop, rather than finishing the connection for nobody.
      if (!(await linkDirect(env, account.id, contributor.id, 'oauth'))) return privateJson({ error: 'Your account is no longer available. Start the connection again.' }, 409);
      await syncCredit(env, account.id);
    }
  }
  // The grant and its code are created from the STORED transaction (client, redirect URI, challenge), never from the form, and only
  // for the request that spent it.
  const grantId = random('', 18), code = random('swc_'), t = Date.now();
  const res = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO oauth_grants (id, client, contributor, scope, resource, created)
       SELECT ?1, client, ?2, ?3, resource, ?4 FROM oauth_consents WHERE hash = ?5 AND consumer = ?6
         AND EXISTS (SELECT 1 FROM contributors c WHERE c.id = ?2 AND c.removed = 0)
         AND NOT ${workSuspended('?2')}
         AND (?7 IS NULL OR (EXISTS (SELECT 1 FROM accounts a WHERE a.id = ?7 AND a.suspended = 0)
                             AND EXISTS (SELECT 1 FROM contributors c WHERE c.id = ?2 AND c.owner_account = ?7)))`
    ).bind(grantId, contributor.id, granted.join(' '), t, consentHash, marker, account?.id ?? null),
    env.DB.prepare(
      `INSERT INTO oauth_codes (hash, grant_id, redirect_uri, challenge, expires)
       SELECT ?1, ?2, redirect_uri, challenge, ?3 FROM oauth_consents WHERE hash = ?4 AND consumer = ?5
         AND EXISTS (SELECT 1 FROM oauth_grants WHERE id = ?2)`
    ).bind(await secretHash(env, 'code', code), grantId, t + CODE_TTL_MS, consentHash, marker),
    // Same app, same contributor: the older live grants (and their tokens) are cancelled in this batch.
    ...supersedeStmts(env, grantId, t),
  ]);
  // Both statements ran in one transaction, so a refusal (the account or contributor went away mid-consent) leaves nothing behind.
  if (res[0].meta.changes !== 1 || res[1].meta.changes !== 1) return privateJson({ error: 'Could not finish the connection. Your account may have changed; start it again.' }, 409);
  return respond(backToApp(txn.redirect_uri, { code, state: txn.state }));
}
