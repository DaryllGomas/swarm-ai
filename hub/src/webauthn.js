// Minimal WebAuthn verification. No attestation trust is claimed: only fmt=none is accepted.
export const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function unb64(s, max = 16384) {
  if (typeof s !== 'string' || !s.length || s.length > max * 4 / 3 + 4 || !/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('Invalid base64url');
  const a = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  if (a.length > max || b64(a) !== s) throw new Error('Invalid base64url');
  return a;
}
export const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
export const digest = async (a) => new Uint8Array(await crypto.subtle.digest('SHA-256', a));
export function join(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out;
}
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Definite-length CBOR only, bounded depth/size, unique primitive map keys, no tags/floats.
export function decodeCBOR(bytes, start = 0) {
  let at = start, nodes = 0;
  function read(depth) {
    if (depth > 8 || ++nodes > 256 || at >= bytes.length) throw new Error('Malformed CBOR');
    const head = bytes[at++], major = head >> 5, ai = head & 31;
    if (major === 7 && [20, 21, 22].includes(ai)) return ai === 22 ? null : ai === 21;
    let n = ai;
    if (ai >= 24) {
      const size = ({24: 1, 25: 2, 26: 4})[ai];
      if (!size || at + size > bytes.length) throw new Error('Malformed CBOR');
      n = 0; for (let i = 0; i < size; i++) n = n * 256 + bytes[at++];
      if (n < ({1: 24, 2: 256, 4: 65536})[size]) throw new Error('Nonminimal CBOR');
    }
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 2 || major === 3) {
      if (n > 16384 || at + n > bytes.length) throw new Error('Malformed CBOR');
      const v = bytes.slice(at, at += n);
      return major === 2 ? v : new TextDecoder('utf-8', { fatal: true }).decode(v);
    }
    if ((major !== 4 && major !== 5) || n > 64) throw new Error('Unsupported CBOR');
    if (major === 4) return Array.from({ length: n }, () => read(depth + 1));
    const map = new Map();
    for (let i = 0; i < n; i++) {
      const k = read(depth + 1);
      if (!['string', 'number'].includes(typeof k) || map.has(k)) throw new Error('Invalid CBOR key');
      map.set(k, read(depth + 1));
    }
    return map;
  }
  const value = read(0); return { value, end: at };
}
function exactMap(v, keys) {
  if (!(v instanceof Map) || v.size !== keys.length || keys.some((k) => !v.has(k))) throw new Error('Unexpected CBOR map');
}
export function clientData(encoded, kind, origin) {
  const bytes = unb64(encoded, 4096);
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (data.type !== `webauthn.${kind === 'register' ? 'create' : 'get'}` || data.origin !== origin || (data.crossOrigin !== undefined && data.crossOrigin !== false) || data.topOrigin !== undefined) throw new Error('Invalid client data');
  unb64(data.challenge, 32);
  return { bytes, challenge: data.challenge };
}
async function authData(bytes, rpId, registration) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 37) throw new Error('Invalid authenticator data');
  if (!equal(bytes.slice(0, 32), await digest(new TextEncoder().encode(rpId)))) throw new Error('Wrong RP');
  const flags = bytes[32];
  if ((flags & 5) !== 5 || (flags & 0x22) || ((flags & 16) && !(flags & 8)) || !!(flags & 64) !== registration) throw new Error('Invalid authenticator flags');
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(33);
  return { count, extensions: !!(flags & 128) };
}
function extensions(bytes, at, hasExtensions) {
  if (hasExtensions) {
    const d = decodeCBOR(bytes, at);
    if (!(d.value instanceof Map)) throw new Error('Invalid extensions');
    at = d.end;
  }
  if (at !== bytes.length) throw new Error('Trailing authenticator data');
}
export async function registration(encoded, credentialId, rpId) {
  const bytes = unb64(encoded), d = decodeCBOR(bytes);
  if (d.end !== bytes.length) throw new Error('Trailing CBOR');
  exactMap(d.value, ['fmt', 'attStmt', 'authData']);
  if (d.value.get('fmt') !== 'none') throw new Error('Only none attestation is supported');
  exactMap(d.value.get('attStmt'), []);
  const auth = d.value.get('authData'), { count, extensions: ed } = await authData(auth, rpId, true);
  if (auth.length < 55) throw new Error('Missing credential');
  const len = (auth[53] << 8) | auth[54];
  if (!len || len > 1023 || 55 + len >= auth.length || !equal(auth.slice(55, 55 + len), unb64(credentialId, 1023))) throw new Error('Invalid credential id');
  const key = decodeCBOR(auth, 55 + len), m = key.value;
  let jwk;
  if (m instanceof Map && m.get(1) === 2 && m.get(3) === -7) {
    exactMap(m, [1, 3, -1, -2, -3]);
    if (m.get(-1) !== 1 || !(m.get(-2) instanceof Uint8Array) || m.get(-2).length !== 32 || !(m.get(-3) instanceof Uint8Array) || m.get(-3).length !== 32) throw new Error('Invalid EC key');
    jwk = { kty: 'EC', crv: 'P-256', x: b64(m.get(-2)), y: b64(m.get(-3)), alg: 'ES256', ext: true };
  } else {
    exactMap(m, [1, 3, -1, -2]);
    const n = m.get(-1), e = m.get(-2);
    if (m.get(1) !== 3 || m.get(3) !== -257 || !(n instanceof Uint8Array) || n.length < 256 || n.length > 512 || n[0] < 128 || !(e instanceof Uint8Array) || e.length > 4 || !e.length || e[0] === 0) throw new Error('Invalid RSA key');
    let exponent = 0; for (const b of e) exponent = exponent * 256 + b;
    if (exponent < 3 || exponent % 2 !== 1) throw new Error('Invalid RSA exponent');
    jwk = { kty: 'RSA', n: b64(n), e: b64(e), alg: 'RS256', ext: true };
  }
  extensions(auth, key.end, ed);
  await importKey(jwk); // Reject invalid curve points/key material at registration.
  return { jwk, count };
}
const algorithm = (jwk) => jwk.kty === 'EC' ? { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
const importKey = (jwk) => crypto.subtle.importKey('jwk', jwk, algorithm(jwk), false, ['verify']);
export function derToRaw(der) {
  let at = 0;
  if (der[at++] !== 48 || der[at++] !== der.length - 2 || der.length > 72) throw new Error('Invalid DER sequence');
  const out = new Uint8Array(64);
  for (let i = 0; i < 2; i++) {
    if (der[at++] !== 2) throw new Error('Invalid DER integer');
    let len = der[at++];
    if (!len || len > 33 || at + len > der.length || (der[at] & 128)) throw new Error('Invalid DER integer');
    if (der[at] === 0 && len > 1) {
      if (!(der[at + 1] & 128)) throw new Error('Nonminimal DER');
      at++; len--;
    }
    if (len > 32) throw new Error('Oversized DER integer');
    out.set(der.slice(at, at + len), i * 32 + 32 - len); at += len;
  }
  if (at !== der.length) throw new Error('Trailing DER');
  return out;
}
export async function assertion(response, client, credential, rpId) {
  const auth = unb64(response.authenticatorData), { count, extensions: ed } = await authData(auth, rpId, false);
  extensions(auth, 37, ed);
  if (!(count === 0 && credential.sign_count === 0) && count <= credential.sign_count) throw new Error('Counter did not advance');
  const jwk = JSON.parse(credential.public_key), sig = unb64(response.signature, 1024);
  if (!await crypto.subtle.verify(algorithm(jwk), await importKey(jwk), jwk.kty === 'EC' ? derToRaw(sig) : sig, join(auth, await digest(client)))) throw new Error('Invalid signature');
  return count;
}
