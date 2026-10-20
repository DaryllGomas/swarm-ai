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

// Parsed JSON body, or null for anything malformed, oversized or not an object. Counts real bytes as they arrive.
export async function readJson(req, maxBytes, allowArray = false) {
  if (Number(req.headers.get('Content-Length') || 0) > maxBytes) return null;
  try {
    const reader = req.body?.getReader();
    if (!reader) return null;
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
    const b = JSON.parse(new TextDecoder().decode(bytes));
    if (!b || typeof b !== 'object') return null;
    return Array.isArray(b) && !allowArray ? null : b;
  } catch {
    return null;
  }
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

// sha256 of salt, day and network: rotates daily, used only for rate limits and pairing caps.
export async function ipHashFor(env, req) {
  const day = new Date().toISOString().slice(0, 10);
  return sha256(`${env.HASH_SALT}|ip|${day}|${networkOf(req.headers.get('CF-Connecting-IP') || '')}`);
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

export function byteLength(s) {
  return new TextEncoder().encode(s).length;
}
