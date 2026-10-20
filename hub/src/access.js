// Only the configured team's fixed JWKS endpoint is fetched. JWT fields never choose a URL or algorithm.
import { fetchJson } from './sync.js';

const TTL_MS = 60 * 60 * 1000;
const SKEW_SECONDS = 30;
let cached = null; // one team per isolate; no stale keys after TTL, including when fetch fails

function decode(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('invalid encoding');
  return Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}
const parse = (part) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(part)));

export async function verifyAccess(req, env) {
  try {
    const team = env.ACCESS_TEAM_DOMAIN?.trim();
    const aud = env.ACCESS_AUD?.trim();
    const emails = (env.OPS_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!team || !aud || !emails.length || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)) return null;
    const token = req.headers.get('Cf-Access-Jwt-Assertion');
    if (!token || token.length > 16384) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = parse(parts[0]), payload = parse(parts[1]);
    const now = Date.now() / 1000;
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined) return null;
    if (payload.iss !== `https://${team}` || !(payload.aud === aud || (Array.isArray(payload.aud) && payload.aud.includes(aud)))) return null;
    if (!Number.isFinite(payload.exp) || payload.exp <= now - SKEW_SECONDS) return null;
    if (payload.nbf !== undefined && (!Number.isFinite(payload.nbf) || payload.nbf > now + SKEW_SECONDS)) return null;
    if (typeof payload.email !== 'string' || !emails.includes(payload.email.toLowerCase())) return null;
    if (!cached || cached.team !== team || cached.until <= Date.now()) {
      const started = Date.now();
      const jwks = await fetchJson(`https://${team}/cdn-cgi/access/certs`, { maxBytes: 64 * 1024 });
      if (!Array.isArray(jwks.keys) || jwks.keys.length > 32) return null;
      cached = { team, until: started + TTL_MS, keys: jwks.keys };
    }
    const jwk = cached.keys.find((k) => k.kid === header.kid && k.kty === 'RSA' && (!k.alg || k.alg === 'RS256') && (!k.use || k.use === 'sig'));
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) return null;
    return { email: payload.email.toLowerCase() };
  } catch { return null; } // Missing config, bad tokens and unavailable certs all look exactly like an unknown route.
}
