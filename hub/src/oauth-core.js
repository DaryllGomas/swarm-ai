// Swarm's own OAuth 2.1 server for MCP (the subset the MCP authorization spec needs): discovery, dynamic client registration for
// public clients, authorization codes with PKCE (S256 only), rotating refresh tokens with reuse detection, revocation, and the check
// every MCP request makes. The /authorize page itself is in oauth.js.
//
// All state is in D1 (migration 0014) and every state change is ONE conditional statement or ONE batch (a D1 batch is a transaction):
//   - a code is spent with `UPDATE ... WHERE used = 0`, and the tokens are inserted only `WHERE consumer = <this request's marker>`,
//     so two requests with the same code cannot both get tokens;
//   - a refresh token is rotated with `UPDATE ... WHERE rotated_at IS NULL AND <grant is not revoked>`, and the replacement tokens are
//     inserted only for the request whose marker (the new token's hash) is in `successor`;
//   - revocation is `oauth_grants.revoked_at`, and a token is only valid while its grant is (checked in the same SQL that issues it
//     and in the same SQL that resolves it), so a request that started before a revoke can never produce a usable token after it.
// Secrets are never stored: codes and tokens are kept as salted SHA-256 hashes (they are 256-bit random values, so no slow hash is needed).
import { workSuspended } from './suspension.js';
import { privateJson, rpOrigin } from './accounts.js';
import { b64url } from './identity.js';
import { SCOPES, resourceUrl } from './oauth-scopes.js';
import { SECURITY_HEADERS, capHashes, clean, readJsonResult, sameSecret, sha256, underRateLimit, ipHashFor } from './lib.js';

export const ACCESS_TTL_MS = 3600 * 1000;           // access token: 1 hour
export const REFRESH_TTL_MS = 30 * 86400 * 1000;    // refresh token: 30 days, renewed by every rotation
export const CODE_TTL_MS = 60 * 1000;               // authorization code: 60 seconds
export const CONSENT_TTL_MS = 10 * 60 * 1000;       // the consent page: 10 minutes
export const RETRY_GRACE_MS = 30 * 1000;            // a lost refresh response may be retried for 30 seconds
export const MAX_CLIENTS = 5000;                    // registered clients in total
export const MAX_CLIENTS_PER_NETWORK_PER_DAY = 10;  // per network, over a rolling 24 hours
export const MAX_LIVE_CONSENTS = 5000;              // open consent pages in total
export const MAX_REGISTRATION_BYTES = 4096;
export const MAX_REDIRECT_URIS = 5;
export const MAX_REDIRECT_URI_CHARS = 512;
const MAX_FORM_BYTES = 8192;

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version', 'Access-Control-Max-Age': '86400' };
const enc = (s) => new TextEncoder().encode(s);

// ---------------------------------------------------------------- tokens and hashing

export const random = (prefix, bytes = 32) => `${prefix}${b64url(crypto.getRandomValues(new Uint8Array(bytes)))}`;
// 32 random bytes in base64url is 43 characters; the shapes are checked before any database work.
export const SHAPE = { code: /^swc_[A-Za-z0-9_-]{43}$/, access: /^swa_[A-Za-z0-9_-]{43}$/, refresh: /^swr_[A-Za-z0-9_-]{43}$/, handle: /^swh_[A-Za-z0-9_-]{43}$/, browser: /^[A-Za-z0-9_-]{43}$/ };
export const secretHash = (env, kind, value) => sha256(`${env.HASH_SALT}|oauth-${kind}|${value}`);

const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// The replacement tokens of a rotation, kept for 30 seconds in case the client never got the response. AES-GCM with a key derived
// from HASH_SALT AND the raw old refresh token: the database alone (even with the salt) cannot decrypt it; only a request that
// presents the old token can. Nothing but the old token's hash is bound in as associated data.
async function retryKey(env, oldRaw) {
  const mac = await crypto.subtle.importKey('raw', enc(String(env.HASH_SALT)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const k = await crypto.subtle.sign('HMAC', mac, enc(`oauth-retry|${oldRaw}`));
  return crypto.subtle.importKey('raw', k, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(env, oldRaw, oldHash, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc(oldHash) }, await retryKey(env, oldRaw), enc(JSON.stringify(payload))));
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
  return b64url(out);
}
async function open(env, oldRaw, oldHash, blob) {
  try {
    const bytes = unb64(blob);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc(oldHash) }, await retryKey(env, oldRaw), bytes.slice(12));
    const p = JSON.parse(new TextDecoder().decode(pt));
    return SHAPE.access.test(p.a) && SHAPE.refresh.test(p.r) && typeof p.s === 'string' ? p : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- responses

const oauthJson = (body, status = 200, extra = {}) => privateJson(body, status, { ...CORS, Pragma: 'no-cache', ...extra });
const oauthError = (error, description, status = 400, extra = {}) => oauthJson({ error, error_description: description }, status, extra);
const invalidGrant = (why = 'That grant is not valid. Start the connection again.') => oauthError('invalid_grant', why);

// ---------------------------------------------------------------- discovery

export function authorizationServerMetadata(env) {
  const o = rpOrigin(env);
  return {
    issuer: o,
    authorization_endpoint: `${o}/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    revocation_endpoint: `${o}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SCOPES,
    client_id_metadata_document_supported: false,
  };
}

export function protectedResourceMetadata(env) {
  return { resource: resourceUrl(env), authorization_servers: [rpOrigin(env)], scopes_supported: ['read'], resource_name: 'Swarm AI', bearer_methods_supported: ['header'] };
}

// ---------------------------------------------------------------- registration (RFC 7591), public clients only

const LOOPBACK = new Set(['127.0.0.1', 'localhost']);

// A redirect URI Swarm will register: printable ASCII, https, or http on 127.0.0.1 / localhost (any port); no userinfo, no fragment.
export function validRedirectUri(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_REDIRECT_URI_CHARS || !/^[\x21-\x7e]+$/.test(s) || s.includes('\\')) return false;
  let u;
  try { u = new URL(s); } catch { return false; }
  if (u.username || u.password || u.hash || s.includes('#') || !u.hostname) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && LOOPBACK.has(u.hostname);
}

export async function registerClient(req, env) {
  const { body, tooLarge } = await readJsonResult(req, MAX_REGISTRATION_BYTES);
  if (tooLarge) return oauthError('invalid_client_metadata', `Registration is limited to ${MAX_REGISTRATION_BYTES} bytes.`, 413);
  if (!body) return oauthError('invalid_client_metadata', 'Send a JSON object.');
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > MAX_REDIRECT_URIS) return oauthError('invalid_redirect_uri', `Send 1 to ${MAX_REDIRECT_URIS} redirect URIs.`);
  if (!uris.every(validRedirectUri) || new Set(uris).size !== uris.length) return oauthError('invalid_redirect_uri', 'Redirect URIs must be https, or http on 127.0.0.1 or localhost, with no credentials or fragment.');
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') return oauthError('invalid_client_metadata', 'Only public clients are supported (token_endpoint_auth_method "none").');
  const oneOf = (v, allowed, dflt) => (v === undefined ? dflt : Array.isArray(v) && v.length > 0 && v.every((x) => allowed.includes(x)) ? v : null);
  const grants = oneOf(body.grant_types, ['authorization_code', 'refresh_token'], ['authorization_code', 'refresh_token']);
  const responses = oneOf(body.response_types, ['code'], ['code']);
  if (!grants || !grants.includes('authorization_code') || !responses) return oauthError('invalid_client_metadata', 'Supported: grant_types authorization_code and refresh_token, response_types code.');
  if (body.client_name !== undefined && typeof body.client_name !== 'string') return oauthError('invalid_client_metadata', 'client_name must be text.');
  const name = clean(body.client_name || '', 80) || 'An AI app';

  const id = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const now = Date.now();
  const net = await capHashes(env, req);
  // Both caps are inside the INSERT, so parallel registrations cannot all pass one stale count.
  const res = await env.DB.prepare(
    `INSERT INTO oauth_clients (id, name, redirect_uris, created, network)
     SELECT ?1, ?2, ?3, ?4, ?5
     WHERE (SELECT COUNT(*) FROM oauth_clients) < ?6
       AND (SELECT COUNT(*) FROM oauth_clients WHERE network IN (?5, ?7) AND created > ?8) < ?9`
  ).bind(id, name, JSON.stringify(uris), now, net.today, MAX_CLIENTS, net.yesterday, now - 86400000, MAX_CLIENTS_PER_NETWORK_PER_DAY).run();
  if (!res.meta.changes) return oauthError('temporarily_unavailable', 'Too many apps have been registered, from this network today or in total. Try again later.', 429);
  return oauthJson({
    client_id: id, client_id_issued_at: Math.floor(now / 1000), client_name: name, redirect_uris: uris,
    grant_types: grants, response_types: responses, token_endpoint_auth_method: 'none',
  }, 201);
}

export async function getClient(env, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
  const row = await env.DB.prepare('SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ?1').bind(id).first();
  return row ? { id: row.id, name: row.name, redirect_uris: JSON.parse(row.redirect_uris) } : null;
}

// ---------------------------------------------------------------- the token endpoint

async function readForm(req) {
  if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers.get('Content-Type') || '')) return null;
  if (Number(req.headers.get('Content-Length') || 0) > MAX_FORM_BYTES) return null;
  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FORM_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  const params = new URLSearchParams(new TextDecoder().decode(bytes));
  const out = {};
  for (const k of new Set(params.keys())) {
    const all = params.getAll(k);
    if (all.length > 1) return null; // RFC 6749: a parameter must not repeat
    out[k] = all[0];
  }
  return out;
}

// Revoke a grant and everything issued under it, in one batch. Safe to repeat; the first reason wins.
export function revokeGrantStmts(env, grantId, reason, now = Date.now()) {
  return [
    env.DB.prepare('UPDATE oauth_grants SET revoked_at = ?2, revoked_reason = ?3 WHERE id = ?1 AND revoked_at IS NULL').bind(grantId, now, reason),
    env.DB.prepare('UPDATE oauth_tokens SET revoked_at = ?2, retry_blob = NULL WHERE grant_id = ?1 AND revoked_at IS NULL').bind(grantId, now),
  ];
}
const revokeGrant = (env, grantId, reason, now) => env.DB.batch(revokeGrantStmts(env, grantId, reason, now));

// The grant is live: not revoked, and its contributor not removed. Used inside the statements that issue tokens.
const GRANT_LIVE = `EXISTS (SELECT 1 FROM oauth_grants g JOIN contributors c ON c.id = g.contributor WHERE g.id = %GRANT% AND g.revoked_at IS NULL AND c.removed = 0 AND NOT ${workSuspended('c.id')})`;
const grantLive = (col) => GRANT_LIVE.replace('%GRANT%', col);

const tokenBody = (access, refresh, scope, expiresIn) => ({ access_token: access, token_type: 'bearer', expires_in: Math.max(1, Math.floor(expiresIn / 1000)), refresh_token: refresh, scope });

export async function tokenEndpoint(req, env, now = Date.now()) {
  const p = await readForm(req);
  if (!p) return oauthError('invalid_request', 'Send an application/x-www-form-urlencoded body (maximum 8 KiB) with no repeated parameters.');
  const client = await getClient(env, p.client_id);
  if (!client) return oauthError('invalid_client', 'Unknown client. Register again.', 401);
  if (p.grant_type === 'authorization_code') return codeGrant(env, client, p, now);
  if (p.grant_type === 'refresh_token') return refreshGrant(env, client, p, now);
  return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
}

async function codeGrant(env, client, p, now) {
  if (!SHAPE.code.test(p.code || '')) return invalidGrant();
  const codeHash = await secretHash(env, 'code', p.code);
  const row = await env.DB.prepare(
    `SELECT c.grant_id, c.redirect_uri, c.challenge, c.expires, c.used, g.client, g.scope, g.resource, g.revoked_at
     FROM oauth_codes c JOIN oauth_grants g ON g.id = c.grant_id WHERE c.hash = ?1`
  ).bind(codeHash).first();
  if (!row || row.client !== client.id) return invalidGrant();
  // A code presented a second time means it may have been copied: take the whole grant (and anything issued from it) away.
  if (row.used) { await revokeGrant(env, row.grant_id, 'code_reuse', now); return invalidGrant('That code was already used. The connection was cancelled; start it again.'); }
  if (row.revoked_at || row.expires <= now) return invalidGrant();
  if (p.redirect_uri !== row.redirect_uri) return invalidGrant('redirect_uri does not match the authorization request.');
  // PKCE (S256 only): a wrong verifier does not spend the code, but it cannot be guessed (43 to 128 characters of entropy).
  if (typeof p.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(p.code_verifier)) return invalidGrant('code_verifier is missing or malformed.');
  const digest = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc(p.code_verifier))));
  if (!(await sameSecret(digest, row.challenge))) return invalidGrant('code_verifier does not match.');
  if (p.resource !== undefined && p.resource !== row.resource) return oauthError('invalid_target', 'resource does not match the authorization request.');

  const marker = random('', 24), access = random('swa_'), refresh = random('swr_');
  const [accessHash, refreshHash, family] = [await secretHash(env, 'token', access), await secretHash(env, 'token', refresh), random('', 18)];
  const res = await env.DB.batch([
    // One winner: only the request that flips used 0 -> 1 writes its marker, and only that request's tokens are inserted below.
    env.DB.prepare(`UPDATE oauth_codes SET used = 1, consumer = ?2 WHERE hash = ?1 AND used = 0 AND expires > ?3 AND ${grantLive('oauth_codes.grant_id')}`).bind(codeHash, marker, now),
    env.DB.prepare(`INSERT INTO oauth_tokens (hash, grant_id, family, kind, created, expires) SELECT ?2, grant_id, ?3, 'refresh', ?4, ?5 FROM oauth_codes WHERE hash = ?1 AND consumer = ?6`)
      .bind(codeHash, refreshHash, family, now, now + REFRESH_TTL_MS, marker),
    env.DB.prepare(`INSERT INTO oauth_tokens (hash, grant_id, family, kind, created, expires, scope) SELECT ?2, grant_id, ?3, 'access', ?4, ?5, ?7 FROM oauth_codes WHERE hash = ?1 AND consumer = ?6`)
      .bind(codeHash, accessHash, family, now, now + ACCESS_TTL_MS, marker, row.scope),
  ]);
  if (res[0].meta.changes !== 1) {
    // Lost the race, or the code expired or the grant was revoked in between. If somebody else spent it, this is a second use.
    const again = await env.DB.prepare('SELECT used FROM oauth_codes WHERE hash = ?1').bind(codeHash).first();
    if (again?.used) await revokeGrant(env, row.grant_id, 'code_reuse', now);
    return invalidGrant();
  }
  return oauthJson(tokenBody(access, refresh, row.scope, ACCESS_TTL_MS));
}

async function refreshGrant(env, client, p, now) {
  if (!SHAPE.refresh.test(p.refresh_token || '')) return invalidGrant();
  const oldHash = await secretHash(env, 'token', p.refresh_token);
  const row = await readRefresh(env, oldHash);
  if (!row || row.client !== client.id || row.kind !== 'refresh') return invalidGrant();
  if (row.revoked_at || row.grant_revoked) return invalidGrant();
  // RFC 8707: a resource this server does not serve is refused outright, before anything is rotated or replayed.
  if (p.resource !== undefined && p.resource !== row.resource) return oauthError('invalid_target', 'resource does not match this connection.');
  // RFC 6749 section 6: the scope of a refreshed access token is the request, which can only be a subset of the grant. Omitted means the
  // whole grant. The grant stays the ceiling for later refreshes; only this access token (and a retry of it) is narrowed.
  const granted = row.scope.split(' ');
  let scope = row.scope;
  if (p.scope !== undefined) {
    const asked = p.scope.split(/\s+/).filter(Boolean);
    if (asked.length === 0 || asked.some((s) => !granted.includes(s))) return oauthError('invalid_scope', 'That is more than this connection was allowed.');
    scope = granted.filter((s) => asked.includes(s)).join(' ');
  }
  if (row.rotated_at !== null) return replayed(env, row, p.refresh_token, oldHash, now, scope);
  if (row.expires <= now) return invalidGrant();

  const access = random('swa_'), refresh = random('swr_');
  const [accessHash, refreshHash] = [await secretHash(env, 'token', access), await secretHash(env, 'token', refresh)];
  const blob = await seal(env, p.refresh_token, oldHash, { a: access, r: refresh, s: scope });
  const res = await env.DB.batch([
    // The rotation. Wins only if the token is still unrotated and unrevoked AND its grant is live right now, inside this statement:
    // a revoke that landed after the read above makes this match nothing, so the refresh fails.
    env.DB.prepare(
      `UPDATE oauth_tokens SET rotated_at = ?2, successor = ?3, retry_blob = ?4
       WHERE hash = ?1 AND kind = 'refresh' AND rotated_at IS NULL AND revoked_at IS NULL AND expires > ?2
         AND ${grantLive('oauth_tokens.grant_id')}
         AND EXISTS (SELECT 1 FROM oauth_grants g WHERE g.id = oauth_tokens.grant_id AND g.client = ?5)`
    ).bind(oldHash, now, refreshHash, blob, client.id),
    // Only the request that won the rotation owns this successor hash, so only it inserts tokens.
    env.DB.prepare(`INSERT INTO oauth_tokens (hash, grant_id, family, kind, created, expires) SELECT ?2, grant_id, family, 'refresh', ?3, ?4 FROM oauth_tokens WHERE hash = ?1 AND successor = ?2`)
      .bind(oldHash, refreshHash, now, now + REFRESH_TTL_MS),
    env.DB.prepare(`INSERT INTO oauth_tokens (hash, grant_id, family, kind, created, expires, scope) SELECT ?2, grant_id, family, 'access', ?3, ?4, ?6 FROM oauth_tokens WHERE hash = ?1 AND successor = ?5`)
      .bind(oldHash, accessHash, now, now + ACCESS_TTL_MS, refreshHash, scope),
    // The token before this one can no longer be retried: drop its stored replacement.
    env.DB.prepare('UPDATE oauth_tokens SET retry_blob = NULL WHERE successor = ?1 AND retry_blob IS NOT NULL AND EXISTS (SELECT 1 FROM oauth_tokens WHERE hash = ?1 AND successor = ?2)').bind(oldHash, refreshHash),
  ]);
  if (res[0].meta.changes !== 1) {
    // Lost to a concurrent rotation, a revoke, or expiry. Look again to tell which.
    const now2 = await readRefresh(env, oldHash);
    if (now2 && !now2.revoked_at && !now2.grant_revoked && now2.rotated_at !== null) return replayed(env, now2, p.refresh_token, oldHash, now, scope);
    return invalidGrant();
  }
  return oauthJson(tokenBody(access, refresh, scope, ACCESS_TTL_MS));
}

const readRefresh = (env, hash) => env.DB.prepare(
  `SELECT t.kind, t.grant_id, t.family, t.expires, t.rotated_at, t.successor, t.retry_blob, t.revoked_at, g.client, g.scope, g.resource, g.revoked_at AS grant_revoked
   FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.hash = ?1`
).bind(hash).first();

// A refresh token that was already rotated came back. Two possibilities:
//  (a) the client lost our response and is retrying: only within 30 seconds of the rotation, and only while the replacement has not been
//      used itself. Then it gets the SAME replacement tokens again (decrypted from the stored blob), never a second pair, so no branch exists;
//  (b) anything else is a copied token being replayed: the whole family and the grant are revoked, and the caller gets invalid_grant.
async function replayed(env, row, raw, oldHash, now, scope) {
  if (row.retry_blob && row.successor && now - row.rotated_at <= RETRY_GRACE_MS) {
    const next = await env.DB.prepare(
      `SELECT t.rotated_at, t.revoked_at, g.revoked_at AS grant_revoked FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.hash = ?1`
    ).bind(row.successor).first();
    if (next && next.rotated_at === null && !next.revoked_at && !next.grant_revoked) {
      const same = await open(env, raw, oldHash, row.retry_blob);
      if (same) {
        // The cached pair is only for the request it was made for: a retry asking for a different scope never gets it (nor is it a theft).
        if (same.s !== scope) return oauthError('invalid_scope', 'A retry must ask for the same scope as the refresh it repeats.');
        return oauthJson(tokenBody(same.a, same.r, same.s, row.rotated_at + ACCESS_TTL_MS - now));
      }
    }
  }
  await env.DB.batch([
    ...revokeGrantStmts(env, row.grant_id, 'refresh_reuse', now),
    env.DB.prepare('UPDATE oauth_tokens SET revoked_at = ?2, retry_blob = NULL WHERE family = ?1 AND revoked_at IS NULL').bind(row.family, now),
  ]);
  return invalidGrant('That refresh token was already used. The connection was cancelled; connect again.');
}

// ---------------------------------------------------------------- revocation (RFC 7009)

export async function revokeEndpoint(req, env, now = Date.now()) {
  const p = await readForm(req);
  if (!p || typeof p.token !== 'string' || !p.token) return oauthError('invalid_request', 'Send token (and client_id) as a form body.');
  const client = await getClient(env, p.client_id);
  if (!client) return oauthError('invalid_client', 'Unknown client.', 401);
  if (p.token.length <= 80 && (SHAPE.access.test(p.token) || SHAPE.refresh.test(p.token))) {
    const h = await secretHash(env, 'token', p.token);
    // Revoking any token of a grant revokes the grant, and with it every token under it. Only the client it was issued to may do so.
    const row = await env.DB.prepare('SELECT t.grant_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.hash = ?1 AND g.client = ?2').bind(h, client.id).first();
    if (row) await revokeGrant(env, row.grant_id, 'revoked', now);
  }
  return oauthJson({}, 200); // an unknown or foreign token is the same answer, so it reveals nothing
}

// ---------------------------------------------------------------- the check every MCP request makes

// Resolve a bearer access token to { contributor, scope, grant, client }, or null. One statement: the token must be unexpired and
// unrevoked, its grant unrevoked and made for THIS resource, and its contributor still active.
export async function resolveAccessToken(env, raw, now = Date.now()) {
  if (typeof raw !== 'string' || !SHAPE.access.test(raw)) return null;
  const row = await env.DB.prepare(
    `SELECT g.id AS grant_id, g.contributor, COALESCE(t.scope, g.scope) AS scope, g.client, ${workSuspended('c.id')} AS work_suspended
     FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN contributors c ON c.id = g.contributor
     WHERE t.hash = ?1 AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires > ?2
       AND g.revoked_at IS NULL AND g.resource = ?3 AND c.removed = 0`
  ).bind(await secretHash(env, 'token', raw), now, resourceUrl(env)).first();
  return row ? { contributor: row.contributor, scope: row.scope.split(' '), grant: row.grant_id, client: row.client, work_suspended: !!row.work_suspended } : null;
}

// ---------------------------------------------------------------- upkeep (hourly)

// Delete what can no longer matter. Revoked grants stay a week (so a replayed token still answers invalid_grant, not "unknown").
export async function purgeOAuth(env, now = Date.now()) {
  const dead = `SELECT id FROM oauth_grants WHERE (revoked_at IS NOT NULL AND revoked_at < ?1)
      OR (created < ?3 AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = oauth_grants.id AND t.expires > ?2)
          AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.grant_id = oauth_grants.id AND c.expires > ?2))`;
  const bind = (s) => env.DB.prepare(s).bind(now - 7 * 86400000, now - 3600000, now - 86400000);
  const res = await env.DB.batch([
    env.DB.prepare('UPDATE oauth_tokens SET retry_blob = NULL WHERE retry_blob IS NOT NULL AND rotated_at < ?1').bind(now - RETRY_GRACE_MS),
    env.DB.prepare('DELETE FROM oauth_consents WHERE expires < ?1').bind(now - 3600000),
    env.DB.prepare('DELETE FROM oauth_tokens WHERE expires < ?1 AND revoked_at IS NULL AND rotated_at IS NULL').bind(now - 86400000),
    bind(`DELETE FROM oauth_tokens WHERE grant_id IN (${dead})`),
    bind(`DELETE FROM oauth_codes WHERE grant_id IN (${dead})`),
    bind(`DELETE FROM oauth_grants WHERE id IN (${dead})`),
    env.DB.prepare('DELETE FROM oauth_clients WHERE created < ?1 AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client = oauth_clients.id)').bind(now - 7 * 86400000),
  ]);
  return { grants: res[5].meta.changes, clients: res[6].meta.changes };
}

// ---------------------------------------------------------------- routing

// Handles discovery, registration, token and revocation. Every POST is rate limited per network before anything is written.
export async function handleOAuth(req, env) {
  const path = new URL(req.url).pathname;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, ...SECURITY_HEADERS } });
  const get = req.method === 'GET' || req.method === 'HEAD';
  const doc = (body) => (get ? oauthJson(body, 200, { 'Cache-Control': 'public, max-age=300' }) : oauthError('invalid_request', 'Use GET.', 405, { Allow: 'GET, HEAD, OPTIONS' }));
  if (path === '/.well-known/oauth-authorization-server') return doc(authorizationServerMetadata(env));
  if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') return doc(protectedResourceMetadata(env));
  const post = { '/oauth/register': registerClient, '/oauth/token': tokenEndpoint, '/oauth/revoke': revokeEndpoint }[path];
  if (!post) return oauthError('not_found', 'Not found.', 404);
  if (req.method !== 'POST') return oauthError('invalid_request', 'Use POST.', 405, { Allow: 'POST, OPTIONS' });
  if (!env.HASH_SALT) return oauthError('server_error', 'Server is not configured.', 500);
  if (!(await underRateLimit(env, await ipHashFor(env, req)))) return oauthError('temporarily_unavailable', 'Slow down.', 429);
  return post(req, env);
}
