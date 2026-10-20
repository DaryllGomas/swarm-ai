import { describe, it, expect, vi, afterEach } from 'vitest';
import headers from '../public/_headers?raw';
import { cookieOf, options, passkey, post, register, cbor } from './passkeys.js';
import { b64, derToRaw, decodeCBOR, digest, join, random, registration, unb64 } from '../src/webauthn.js';
afterEach(() => vi.restoreAllMocks());
const rp = () => digest(new TextEncoder().encode('swarm.bigpicsolutions.com'));
// Build authenticator data for a registration, to drive registration() directly.
async function regData({ flags = 69, id = new Uint8Array(32).fill(7), cose, tail = new Uint8Array(0) }) {
  const bytes = join(await rp(), new Uint8Array([flags]), new Uint8Array(4), new Uint8Array(16), new Uint8Array([0, id.length]), id, cbor(cose), tail);
  return { bytes, id: b64(id), encoded: b64(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', bytes]]))) };
}
const reg = async (o) => { const d = await regData(o); return registration(d.encoded, d.id, 'swarm.bigpicsolutions.com'); };
const goodEc = async () => new Map((await passkey()).cose);

describe('COSE key parsing', () => {
  it('accepts the ES256 and RS256 shapes', async () => {
    expect((await reg({ cose: await goodEc() })).jwk.alg).toBe('ES256');
    expect((await reg({ cose: (await passkey('RS256')).cose })).jwk.alg).toBe('RS256');
  });
  it('rejects other curves, algorithms, key types, extra fields and invalid points', async () => {
    const ec = await goodEc();
    const variants = [
      (m) => m.set(-1, 2), (m) => m.set(-1, 8), (m) => m.set(3, -35), (m) => m.set(3, -8), (m) => m.set(1, 1), (m) => m.set(1, 3),
      (m) => m.set(4, [1]), (m) => m.delete(-3), (m) => m.set(-2, new Uint8Array(31)), (m) => m.set(-3, new Uint8Array(33)),
      (m) => { m.set(-2, new Uint8Array(32).fill(1)); m.set(-3, new Uint8Array(32).fill(2)); }, // not on the curve
    ];
    for (const edit of variants) { const m = new Map(ec); edit(m); await expect(reg({ cose: m })).rejects.toThrow(); }
  });
  it('rejects weak or malformed RSA keys', async () => {
    const rsa = (await passkey('RS256')).cose;
    const small = new Uint8Array(128).fill(0xff), odd = new Uint8Array(256).fill(0xff), lead = new Uint8Array(256).fill(1);
    for (const edit of [(m) => m.set(-1, small), (m) => m.set(-1, lead), (m) => m.set(-2, new Uint8Array([1])), (m) => m.set(-2, new Uint8Array([2])), (m) => m.set(-2, new Uint8Array([0, 1, 0, 1])), (m) => m.set(3, -7), (m) => m.set(-1, odd).set(-2, new Uint8Array([1, 0, 1, 0, 1]))]) {
      const m = new Map(rsa); edit(m); await expect(reg({ cose: m })).rejects.toThrow();
    }
  });
  it('rejects trailing bytes, bad flags and a credential id that differs from the ceremony', async () => {
    const cose = await goodEc();
    await expect(reg({ cose, tail: new Uint8Array([0]) })).rejects.toThrow();
    for (const flags of [65, 68, 69 | 2, 69 | 32, 69 | 16, 5]) await expect(reg({ cose, flags })).rejects.toThrow(); // no UV, no UP, RFU bits, BS without BE, no AT
    expect((await reg({ cose, flags: 69 | 8 | 16 })).jwk.kty).toBe('EC');
    const d = await regData({ cose });
    await expect(registration(d.encoded, random(), 'swarm.bigpicsolutions.com')).rejects.toThrow();
  });
});
describe('ES256 DER to raw', () => {
  it('handles high-bit and short integers', () => {
    const r = new Uint8Array(32).fill(0xff), s = new Uint8Array(32); s[31] = 5;
    const der = new Uint8Array([48, 3 + 33 + 3 - 1 + 1, 2, 33, 0, ...r, 2, 1, 5]);
    der[1] = der.length - 2;
    const raw = derToRaw(der);
    expect([...raw.slice(0, 32)]).toEqual([...r]); expect([...raw.slice(32)]).toEqual([...s]);
  });
  it('rejects long-form lengths, negatives, empty and oversized integers', () => {
    for (const b of [[48, 129, 6, 2, 1, 1, 2, 1, 1], [48, 6, 2, 1, 255, 2, 1, 1], [48, 6, 2, 0, 2, 1, 1], [48, 4, 2, 1, 1, 2, 1], [48, 7, 2, 2, 1, 1, 2, 1, 1, 0], new Uint8Array(80).fill(48)]) expect(() => derToRaw(new Uint8Array(b))).toThrow();
  });
});
describe('ceremony hardening', () => {
  it('sets strict flags on the ceremony cookie and never reuses a challenge across kinds', async () => {
    const k = await passkey(); await register(k);
    const reg1 = await options('register'), login = await options('login');
    for (const o of [reg1, login]) for (const f of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=300']) expect(o.res.headers.get('Set-Cookie')).toContain(f);
    expect(reg1.data.challenge).not.toBe(login.data.challenge);
    // A login assertion signed over a registration challenge is refused, and the registration challenge is not consumed by login.
    const w = await k.wire({ challenge: reg1.data.challenge }, 'login');
    expect((await post('/api/account/login/verify', w, { cookie: reg1.cookie })).status).toBe(400);
  });
  it('rejects registration data with a credential id other than the one the browser reports', async () => {
    const k = await passkey(), o = await options('register'), w = await k.wire(o.data, 'register');
    w.id = w.rawId = random();
    expect((await post('/api/account/register/verify', w, { cookie: o.cookie })).status).toBe(400);
  });
  it('rejects a raw (non-DER) ES256 signature, AT set at login, and a counter overflow of a different credential', async () => {
    const k = await passkey(); await register(k);
    const o = await options('login'), w = await k.wire(o.data, 'login');
    w.response.signature = b64(new Uint8Array(64).fill(1));
    expect((await post('/api/account/login/verify', w, { cookie: o.cookie })).status).toBe(400);
    const o2 = await options('login'), w2 = await k.wire(o2.data, 'login', { flags: 69 });
    expect((await post('/api/account/login/verify', w2, { cookie: o2.cookie })).status).toBe(400);
  });
  it('fails closed when siteverify is unreachable or returns garbage', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    expect((await post('/api/account/register/options', { turnstile_token: 'human' }, { over: { TURNSTILE_SECRET: 's' } })).status).toBe(403);
    vi.restoreAllMocks(); vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>', { status: 502 }));
    expect((await post('/api/account/register/options', { turnstile_token: 'human' }, { over: { TURNSTILE_SECRET: 's' } })).status).toBe(403);
  });
  it('mints a fresh 32-byte session id for every login and stores only its hash', async () => {
    const k = await passkey(), r = await register(k);
    const sid = r.cookie.split('=')[1]; expect(unb64(sid)).toHaveLength(32);
    const { env } = await import('cloudflare:workers');
    const rows = (await env.DB.prepare('SELECT hash FROM sessions').all()).results;
    expect(rows.some((x) => x.hash === sid)).toBe(false);
  });
});
describe('CBOR decoder', () => {
  it('rejects nonminimal integers, deep nesting, oversize maps and truncated input', () => {
    for (const b of [[0x18, 5], [0x19, 0, 5], [0x58, 1], [0xa1, 1], [0xff], [0x5f], [0xf9, 0, 0], [0xf7]]) expect(() => decodeCBOR(new Uint8Array(b))).toThrow();
    expect(() => decodeCBOR(new Uint8Array([...Array(20).fill(0x81), 0]))).toThrow();
    expect(decodeCBOR(new Uint8Array([0x38, 0x63])).value).toBe(-100);
  });
});
describe('CSP', () => {
  it('allows Turnstile only on the vote page; everything else keeps the strict policy', () => {
    const global = headers.slice(0, headers.indexOf('\n/vote'));
    expect(global).toContain("script-src 'self';");
    expect(global).not.toContain('challenges.cloudflare.com');
    const voteBlocks = headers.slice(headers.indexOf('\n/vote'));
    for (const csp of voteBlocks.match(/Content-Security-Policy: .*/g).filter((l) => !l.startsWith('! '))) {
      expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com;"); expect(csp).toContain('frame-src https://challenges.cloudflare.com;');
      expect(csp).toContain("default-src 'self'"); expect(csp).toContain("object-src 'none'"); expect(csp).toContain("frame-ancestors 'none'"); expect(csp).not.toContain('unsafe');
    }
    expect((headers.match(/challenges\.cloudflare\.com/g) || []).length).toBe(4);
    expect(headers.match(/^\/\S+$/gm)).toEqual(['/*', '/vote', '/vote.html']);
  });
});
