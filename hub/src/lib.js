// Shared helpers: responses, safe body reading, hashing, weeks, text cleaning.

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export function json(data, status = 200, extra = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(JSON.stringify(data), { status, headers });
}

// Read a JSON body. Returns { body, tooLarge }: body is null for anything malformed, oversized or not an object.
// Counts real bytes as they arrive, so a chunked body with no Content-Length cannot slip past the limit.
export async function readJsonResult(req, maxBytes, allowArray = false) {
  if (Number(req.headers.get('Content-Length') || 0) > maxBytes) return { body: null, tooLarge: true };
  try {
    const reader = req.body?.getReader();
    if (!reader) return { body: null, tooLarge: false };
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return { body: null, tooLarge: true }; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
    const b = JSON.parse(new TextDecoder().decode(bytes));
    if (!b || typeof b !== 'object') return { body: null, tooLarge: false };
    return { body: Array.isArray(b) && !allowArray ? null : b, tooLarge: false };
  } catch {
    return { body: null, tooLarge: false };
  }
}

// Parsed JSON body, or null for anything malformed, oversized or not an object.
export async function readJson(req, maxBytes, allowArray = false) {
  return (await readJsonResult(req, maxBytes, allowArray)).body;
}

export async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time comparison (hash both sides, compare the fixed-length digests).
export async function sameSecret(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function isAdmin(req, env) {
  return !!env.ADMIN_TOKEN && (await sameSecret(req.headers.get('Authorization') || '', `Bearer ${env.ADMIN_TOKEN}`));
}

// IPv4 as is; IPv6 by its /64, since anyone with a /64 has endless addresses inside it.
export function networkOf(ip) {
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return full.slice(0, 4).map((x) => (x || '0').toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

// ---------------------------------------------------------------- forward-secure network hashing
//
// A network (the caller's IPv4 address, or an IPv6 /64) is never stored. What is stored is HMAC-SHA256(day key, network): the
// day key is 32 random bytes, created on first use for each UTC day and kept in D1 (network_keys). The hourly job deletes keys
// older than a whole UTC day plus two days (so a key lives up to about three days) and sets the network hashes it made to NULL once
// the ROW is more than two days old (the hourly job adds up to an hour of delay). While a key exists, anyone who can read the database
// can compute the code of a candidate address and match it to rows (that is what the key is for). Once a day's key is gone from the live
// database, nobody can work out which network a stored code came from, or even tell that two old rows came from the same one. A copy
// of the key taken earlier (a database export, D1 Time Travel, memory) is outside this.
export const NETWORK_KEY_KEEP_DAYS = 2;
const KEY_CACHE_MS = 5 * 60 * 1000;
const keyCache = new Map(); // day -> { key: CryptoKey, at }. Isolate memory only; a non-extractable key.

export const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
export function resetNetworkKeyCache() { keyCache.clear(); }

const toHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));

// The HMAC key of one UTC day: created on first use. Two requests that race to create it both INSERT OR IGNORE, and then both
// SELECT, so every caller ends up with the one key that won.
export async function networkKey(env, day) {
  const hit = keyCache.get(day);
  if (hit && Date.now() - hit.at < KEY_CACHE_MS) return hit.key;
  await env.DB.prepare('INSERT OR IGNORE INTO network_keys (day, key) VALUES (?1, ?2)').bind(day, toHex(crypto.getRandomValues(new Uint8Array(32)))).run();
  const row = await env.DB.prepare('SELECT key FROM network_keys WHERE day = ?1').bind(day).first();
  const key = await crypto.subtle.importKey('raw', fromHex(row.key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const oldest = utcDay(Date.now() - NETWORK_KEY_KEEP_DAYS * 86400000);
  for (const d of keyCache.keys()) if (d < oldest) keyCache.delete(d); // a day that is past its keep window is forgotten, not kept in memory
  keyCache.set(day, { key, at: Date.now() });
  return key;
}

// The network hash of this request for today (daysAgo = 0) or yesterday (1): used for rate limits and the pairing, account and
// active-claim caps. daysAgo = 1 lets a cap still see claims made just before UTC midnight.
export async function ipHashFor(env, req, daysAgo = 0) {
  const day = utcDay(Date.now() - daysAgo * 86400000);
  const sig = await crypto.subtle.sign('HMAC', await networkKey(env, day), new TextEncoder().encode(networkOf(req.headers.get('CF-Connecting-IP') || '')));
  return toHex(sig);
}

// The hash this code used before day keys (sha256 of HASH_SALT, day and network). Rows written before migration 0010 carry it, so
// the caps also look for it; the hourly job nulls those rows two days after the switch, and this can then be deleted.
export function legacyIpHashFor(env, req, daysAgo = 0) {
  const day = utcDay(Date.now() - daysAgo * 86400000);
  return sha256(`${env.HASH_SALT}|ip|${day}|${networkOf(req.headers.get('CF-Connecting-IP') || '')}`);
}

// Everything a cap must count for this request's network: today's and yesterday's hash, and the same two in the old format.
export async function capHashes(env, req) {
  const [today, yesterday, legacyToday, legacyYesterday] = await Promise.all([ipHashFor(env, req), ipHashFor(env, req, 1), legacyIpHashFor(env, req), legacyIpHashFor(env, req, 1)]);
  return { today, yesterday, legacyToday, legacyYesterday };
}

// Burst limit per network (Cloudflare rate limiting binding); allows everything if the binding is missing (local dev).
export async function underRateLimit(env, key) {
  if (!env.LIMITER) return true;
  const { success } = await env.LIMITER.limit({ key });
  return success;
}

export function clean(v, max) {
  return String(v ?? '')
    .replace(/[\u0000-\u001f\u007f<>​-‏‪-‮⁠-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Monday 00:00 UTC of the ISO week containing `ms`.
export function weekStartMs(ms = Date.now()) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}
export const weekOf = (ms = Date.now()) => new Date(weekStartMs(ms)).toISOString().slice(0, 10);
export const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
// The UTC day only (YYYY-MM-DD): public pages show when something happened to the day, never the minute.
export const isoDay = (ms) => (ms == null ? null : new Date(ms).toISOString().slice(0, 10));

export function byteLength(s) {
  return new TextEncoder().encode(s).length;
}
