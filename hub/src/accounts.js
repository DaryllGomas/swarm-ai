import { ipHashFor, json, readJson, sha256, underRateLimit } from './lib.js';
import { assertion, b64, clientData, random, registration, unb64 } from './webauthn.js';
export const rpOrigin = (env) => env.RP_ORIGIN || 'https://swarm.bigpicsolutions.com';
const rpId = (env) => env.RP_ID || 'swarm.bigpicsolutions.com';
const SESSION_TTL = 30 * 86400000;
export function cookie(req, name) {
  return (req.headers.get('Cookie') || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='))?.slice(name.length + 1) || '';
}
const cookieValue = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
const sidHash = (env, sid) => sha256(`${env.HASH_SALT}|session|${sid}`);
const browserHash = (env, sid) => sha256(`${env.HASH_SALT}|ceremony|${sid}`);
export const privateJson = (body, status = 200, headers = {}) => json(body, status, { 'Cache-Control': 'no-store', ...headers });
export async function writeGuard(req, env) {
  if (req.headers.get('Origin') !== rpOrigin(env) || req.headers.get('X-Swarm') !== '1') return privateJson({ error: 'Origin and X-Swarm: 1 required.' }, 403);
  if (!await underRateLimit(env, await ipHashFor(env, req))) return privateJson({ error: 'Slow down.' }, 429);
  return null;
}
export async function session(req, env) {
  const sid = cookie(req, 'swarm_sid');
  if (!/^[A-Za-z0-9_-]{43}$/.test(sid)) return null;
  return env.DB.prepare(`SELECT a.id, a.created FROM sessions s JOIN accounts a ON a.id = s.account
    WHERE s.hash = ?1 AND s.expires > ?2 AND a.suspended = 0`).bind(await sidHash(env, sid), Date.now()).first();
}
async function turnstile(env, token) {
  if (typeof token !== 'string' || !token.length || token.length > 2048) return false;
  // Only an explicitly injected test binding can replace siteverify. Missing production secrets fail closed.
  const result = env.TURNSTILE_SECRET ? await (await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token }), signal: AbortSignal.timeout(10000),
  })).json() : await env.TURNSTILE_TEST?.verify(token);
  return result?.success === true && result.hostname === new URL(rpOrigin(env)).hostname && result.action === 'register';
}
export async function handleAccount(req, env, path) {
  const method = req.method;
  if (path === '/api/account/me' && method === 'GET') {
    const a = await session(req, env);
    const ballot = a && await env.DB.prepare('SELECT 1 AS n FROM ballot_versions WHERE account = ?1 LIMIT 1').bind(a.id).first();
    return privateJson({ signed_in: !!a, account_id_short: a ? a.id.slice(0, 8) : null, has_ballot: !!ballot });
  }
  if (method !== 'POST') return privateJson({ error: 'Use POST.' }, 405);
  const guard = await writeGuard(req, env); if (guard) return guard;
  if (path === '/api/account/logout') {
    await env.DB.prepare('DELETE FROM sessions WHERE hash = ?1').bind(await sidHash(env, cookie(req, 'swarm_sid'))).run();
    return privateJson({ signed_in: false }, 200, { 'Set-Cookie': cookieValue('swarm_sid', '', 0) });
  }
  const route = path.match(/^\/api\/account\/(register|login)\/(options|verify)$/);
  if (!route) return privateJson({ error: 'not found' }, 404);
  const [, kind, step] = route;
  const body = await readJson(req, 24576);
  if (!body) return privateJson({ error: 'Expected a JSON object (maximum 24 KiB).' }, 400);
  if (step === 'options') {
    if (kind === 'register' && !await turnstile(env, body.turnstile_token)) return privateJson({ error: 'Human check failed or unavailable.' }, 403);
    const challenge = random(), browser = random(), account = kind === 'register' ? random() : null;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM account_challenges WHERE expires <= ?1').bind(Date.now()),
      env.DB.prepare('INSERT INTO account_challenges (challenge, kind, account, browser_hash, expires) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(challenge, kind, account, await browserHash(env, browser), Date.now() + 300000),
    ]);
    const options = kind === 'register' ? {
      challenge, rp: { id: rpId(env), name: 'Swarm AI' },
      user: { id: account, name: `voter-${account.slice(0, 8)}`, displayName: `Swarm voter ${account.slice(0, 8)}` },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none', timeout: 300000,
    } : { challenge, rpId: rpId(env), userVerification: 'required', timeout: 300000 };
    return privateJson(options, 200, { 'Set-Cookie': cookieValue('swarm_ceremony', browser, 300) });
  }
  try {
    if (body.type !== 'public-key' || body.rawId !== body.id || !body.response || typeof body.response !== 'object') throw new Error('Invalid credential');
    unb64(body.id, 1023);
    const cd = clientData(body.response.clientDataJSON, kind, rpOrigin(env));
    // DELETE RETURNING is the one-use gate, including concurrent replays. Wrong browser cannot burn a challenge.
    const c = await env.DB.prepare(`DELETE FROM account_challenges WHERE challenge = ?1 AND kind = ?2
      AND expires > ?3 AND browser_hash = ?4 RETURNING account`).bind(cd.challenge, kind, Date.now(), await browserHash(env, cookie(req, 'swarm_ceremony'))).first();
    if (!c) throw new Error('Challenge expired or used');
    const now = Date.now(), sid = random(), hash = await sidHash(env, sid);
    let account;
    if (kind === 'register') {
      const { jwk, count } = await registration(body.response.attestationObject, body.id, rpId(env));
      const transports = body.response.transports ?? [];
      if (!Array.isArray(transports) || transports.length > 8 || transports.some((t) => !['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card'].includes(t))) throw new Error('Invalid transports');
      const [today, yesterday] = await Promise.all([ipHashFor(env, req), ipHashFor(env, req, 1)]);
      // Like pairing: a rolling 24h window counts both network-day hashes, atomically with insertion.
      const res = await env.DB.batch([
        env.DB.prepare(`INSERT INTO accounts(id, created, network) SELECT ?1, ?2, ?3
          WHERE (SELECT COUNT(*) FROM accounts WHERE network IN (?3, ?4) AND created > ?5) < 3`)
          .bind(c.account, now, today, yesterday, now - 86400000),
        env.DB.prepare(`INSERT INTO credentials(id, account, public_key, sign_count, transports)
          SELECT ?1, id, ?3, ?4, ?5 FROM accounts WHERE id = ?2`).bind(body.id, c.account, JSON.stringify(jwk), count, JSON.stringify(transports)),
        env.DB.prepare('INSERT INTO sessions(hash, account, expires) SELECT ?1, id, ?3 FROM accounts WHERE id = ?2').bind(hash, c.account, now + SESSION_TTL),
      ]);
      if (!res[0].meta.changes) return privateJson({ error: 'This network has reached the account limit. Try tomorrow.' }, 429);
      account = c.account;
    } else {
      const credential = await env.DB.prepare(`SELECT c.* FROM credentials c JOIN accounts a ON a.id = c.account
        WHERE c.id = ?1 AND a.suspended = 0`).bind(body.id).first();
      if (!credential) throw new Error('Unknown credential');
      if (body.response.userHandle && b64(unb64(body.response.userHandle, 64)) !== credential.account) throw new Error('Wrong user handle');
      const count = await assertion(body.response, cd.bytes, credential, rpId(env));
      // Counter compare-and-swap also closes parallel assertions using distinct challenges with the same counter.
      const op = random();
      const res = await env.DB.batch([
        env.DB.prepare(`UPDATE credentials SET sign_count = ?2, transports = transports WHERE id = ?1 AND sign_count = ?3
          AND EXISTS (SELECT 1 FROM accounts WHERE id = credentials.account AND suspended = 0) RETURNING account`)
          .bind(body.id, count, credential.sign_count),
        // changes() refers to the immediately preceding UPDATE. The temporary marker gates session rotation.
        env.DB.prepare(`INSERT INTO sessions(hash, account, expires) SELECT ?1, ?2, ?3 WHERE changes() > 0`).bind(op, credential.account, now + SESSION_TTL),
        env.DB.prepare(`DELETE FROM sessions WHERE account = ?1 AND hash != ?2 AND EXISTS (SELECT 1 FROM sessions WHERE hash = ?2)`).bind(credential.account, op),
        env.DB.prepare('UPDATE sessions SET hash = ?1 WHERE hash = ?2').bind(hash, op),
      ]);
      if (!res[0].meta.changes) throw new Error('Credential changed');
      account = credential.account;
    }
    return privateJson({ signed_in: true, account_id_short: account.slice(0, 8) }, 200, { 'Set-Cookie': cookieValue('swarm_sid', sid, SESSION_TTL / 1000) });
  } catch {
    return privateJson({ error: 'Passkey verification failed. Start again.' }, 400);
  }
}
