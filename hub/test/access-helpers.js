import { vi } from 'vitest';
import { send } from './helpers.js';

let pair;
const bytes = (s) => new TextEncoder().encode(s);
const b64 = (s) => btoa(typeof s === 'string' ? s : String.fromCharCode(...new Uint8Array(s))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

// Real signatures; only the certs HTTP response is stubbed. Unique team names keep caches isolated between tests.
export async function accessFixture(otherFetch) {
  pair ??= await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const team = `test-${crypto.randomUUID()}.cloudflareaccess.com`;
  const config = { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-ops-audience', OPS_EMAILS: 'owner@example.com' };
  const key = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const fetcher = vi.fn(async (url) => {
    if (String(url) === `https://${team}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [key] }));
    if (otherFetch) return otherFetch(url);
    throw new Error('unexpected fetch');
  });
  vi.stubGlobal('fetch', fetcher);
  async function token(over = {}, header = {}) {
    const now = Math.floor(Date.now() / 1000);
    const input = [b64(JSON.stringify({ alg: 'RS256', kid: 'test-key', ...header })), b64(JSON.stringify({ iss: `https://${team}`, aud: [config.ACCESS_AUD], email: 'owner@example.com', exp: now + 3600, nbf: now - 5, ...over }))].join('.');
    return `${input}.${b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, bytes(input)))}`;
  }
  const jwt = await token();
  const headers = { 'Cf-Access-Jwt-Assertion': jwt };
  const get = (path, over = {}) => send(`/api/ops/${path}`, { headers }, { ...config, ...over });
  const post = (path, body, over = {}, customHeaders = {}) => send(`/api/ops/${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Origin': 'https://swarm.bigpicsolutions.com', 'X-Swarm-Ops': '1', ...customHeaders }, body: JSON.stringify(body) }, { ...config, ...over });
  return { config, key, jwt, token, headers, get, post, fetcher };
}
