import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, send, ADMIN } from './helpers.js';
import { accessFixture } from './access-helpers.js';

beforeEach(resetDb);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Access JWT verification fails closed', () => {
  it('validates a generated RSA signature and accepts array and string audiences', async () => {
    const a = await accessFixture();
    expect((await a.get('overview')).status).toBe(200);
    const jwt = await a.token({ aud: a.config.ACCESS_AUD, email: 'OWNER@example.com' });
    expect((await send('/api/ops/projects', { headers: { 'Cf-Access-Jwt-Assertion': jwt } }, a.config)).status).toBe(200);
  });
  for (const [name, changes] of [
    ['wrong aud', { aud: ['other'] }], ['wrong iss', { iss: 'https://evil.example' }],
    ['expired', { exp: 1 }], ['email not allowed', { email: 'visitor@example.com' }],
    ['future nbf', { nbf: 9999999999 }], ['missing exp', { exp: undefined }],
    ['string exp', { exp: '9999999999' }], ['invalid nbf', { nbf: '0' }], ['no email', { email: undefined }],
  ]) {
    it(`returns only the unknown-route 404 for ${name}`, async () => {
      const a = await accessFixture();
      const res = await send('/api/ops/overview', { headers: { 'Cf-Access-Jwt-Assertion': await a.token(changes) } }, a.config);
      expect(res.status).toBe(404); expect(await res.json()).toEqual({ error: 'not found' });
    });
  }
  it('rejects a bad signature, tampered payload, unknown kid, and wrong algorithm', async () => {
    const a = await accessFixture();
    const parts = a.jwt.split('.');
    for (const jwt of [parts.slice(0, 2).join('.') + '.' + 'A'.repeat(parts[2].length), a.jwt.replace(parts[1], parts[0]), await a.token({}, { kid: 'missing' }), await a.token({}, { alg: 'HS256' }), 'not-a.jwt', 'a.b.c']) {
      expect((await send('/api/ops/overview', { headers: { 'Cf-Access-Jwt-Assertion': jwt } }, a.config)).status).toBe(404);
    }
  });
  for (const name of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'OPS_EMAILS']) {
    it(`refuses unset ${name} even with a signed token`, async () => {
      const a = await accessFixture();
      for (const value of [undefined, '', '   ']) expect((await a.get('overview', { [name]: value })).status).toBe(404);
      expect(a.fetcher).not.toHaveBeenCalled();
    });
  }
  it('no header or bearer admin token never unlocks ops assets or APIs', async () => {
    const a = await accessFixture();
    for (const path of ['/ops', '/ops/', '/ops/index.html', '/ops/ops.js', '/ops/ops.css', '/ops/anything', '/ops-extra', '/api/ops', '/api/ops/overview', '/api/ops/review']) {
      const res = await send(path, { headers: ADMIN() }, a.config);
      expect(res.status, path).toBe(404); expect(await res.json()).toEqual({ error: 'not found' });
    }
    expect(a.fetcher).not.toHaveBeenCalled();
  });
  it('checks JWT before calling ASSETS, and private assets are never cached', async () => {
    const a = await accessFixture();
    const fetch = vi.fn(async () => new Response('private asset'));
    const over = { ...a.config, ASSETS: { fetch } };
    expect((await send('/ops/ops.js', {}, over)).status).toBe(404); expect(fetch).not.toHaveBeenCalled();
    for (const path of ['/ops', '/ops/', '/ops/index.html', '/ops/ops.js', '/ops/ops.css']) {
      const r = await send(path, { headers: a.headers }, over);
      expect(r.status).toBe(200); expect(r.headers.get('Cache-Control')).toBe('private, no-store');
    }
    expect(fetch).toHaveBeenCalledTimes(5);
    expect((await send('/ops/unknown.js', { headers: a.headers }, over)).status).toBe(404);
  });
  it('accepts a small clock skew but refuses older expiries', async () => {
    const a = await accessFixture(), now = Date.now() / 1000;
    for (const [exp, status] of [[now - 10, 200], [now - 60, 404]]) expect((await send('/api/ops/projects', { headers: { 'Cf-Access-Jwt-Assertion': await a.token({ exp, nbf: now + 10 }) } }, a.config)).status).toBe(status);
  });
  it('caches keys at most one hour and refuses expired cached keys on fetch failure', async () => {
    const a = await accessFixture(), now = Date.now();
    expect((await a.get('projects')).status).toBe(200);
    expect((await a.get('projects')).status).toBe(200); expect(a.fetcher).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, 'now').mockReturnValue(now + 3600001);
    const jwt = await a.token();
    a.fetcher.mockRejectedValue(new Error('offline'));
    expect((await send('/api/ops/projects', { headers: { 'Cf-Access-Jwt-Assertion': jwt } }, a.config)).status).toBe(404);
    expect(a.fetcher).toHaveBeenCalledTimes(2);
  });
  it('fails closed for unavailable or invalid JWKS and never fetches a token-selected URL', async () => {
    for (const reply of [() => new Response('{}'), () => new Response('no', { status: 503 }), () => new Response(JSON.stringify({ keys: [] }))]) {
      const a = await accessFixture(); a.fetcher.mockImplementation(reply);
      expect((await a.get('projects')).status).toBe(404);
    }
    const a = await accessFixture();
    expect((await a.get('projects', { ACCESS_TEAM_DOMAIN: 'evil.example/path' })).status).toBe(404);
    expect(a.fetcher).not.toHaveBeenCalled();
  });
});
