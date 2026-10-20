import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { send } from './helpers.js';
import { cookieOf, options, passkey, post, register } from './passkeys.js';
import { b64, decodeCBOR, derToRaw, random } from '../src/webauthn.js';
afterEach(()=>vi.restoreAllMocks());
for(const alg of ['ES256','RS256']) describe(alg+' passkeys',()=>{
  it('registers, signs in, rotates sessions and logs out',async()=>{
    const k=await passkey(alg),r=await register(k);expect(r.res.status).toBe(200);
    for(const flag of ['HttpOnly','Secure','SameSite=Strict','Max-Age=2592000']) expect(r.res.headers.get('Set-Cookie')).toContain(flag);
    expect(r.options.authenticatorSelection).toMatchObject({residentKey:'required',userVerification:'required'});
    expect(r.options.pubKeyCredParams.map(x=>x.alg)).toEqual([-7,-257]);
    const me=await(await send('/api/account/me',{headers:{Cookie:r.cookie}})).json();expect(me).toMatchObject({signed_in:true,has_ballot:false});expect(me.account_id_short).toHaveLength(8);
    const o=await options('login');expect(o.data.allowCredentials).toBeUndefined();
    const w=await k.wire(o.data,'login'),l=await post('/api/account/login/verify',w,{cookie:o.cookie});
    expect(l.status).toBe(200);expect(cookieOf(l)).not.toBe(r.cookie);
    expect((await(await send('/api/account/me',{headers:{Cookie:r.cookie}})).json()).signed_in).toBe(false);
    expect((await post('/api/account/login/verify',w,{cookie:o.cookie})).status).toBe(400);
    const logout=await post('/api/account/logout',{}, {cookie:cookieOf(l)});expect(logout.status).toBe(200);expect(logout.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect((await(await send('/api/account/me',{headers:{Cookie:cookieOf(l)}})).json()).signed_in).toBe(false);
  });
  it('rejects tampered signatures, unknown credentials and wrong user handles',async()=>{
    const k=await passkey(alg);await register(k);
    for(const bad of ['signature','unknown','handle']) {
      const o=await options('login'),w=await k.wire(o.data,'login',{count:2});
      if(bad==='signature') w.response.signature=b64(new Uint8Array(70));
      if(bad==='unknown') w.id=w.rawId=random();
      if(bad==='handle') w.response.userHandle=random();
      expect((await post('/api/account/login/verify',w,{cookie:o.cookie})).status).toBe(400);
    }
  });
});
for(const kind of ['register','login']) describe(kind+' rejection',()=>{
  for(const [label,over] of Object.entries({challenge:{challenge:random()},origin:{origin:'https://evil.test'},rpHash:{rp:'evil.test'},UV:{flags:kind==='register'?65:1},UP:{flags:kind==='register'?68:4},crossOrigin:{client:{crossOrigin:true}}})) it('rejects wrong '+label,async()=>{
    const k=await passkey();if(kind==='login') await register(k);
    const o=await options(kind),w=await k.wire(o.data,kind,over);expect((await post(`/api/account/${kind}/verify`,w,{cookie:o.cookie})).status).toBe(400);
  });
  it('rejects expired challenges and a different browser',async()=>{
    const k=await passkey();if(kind==='login') await register(k);
    const o=await options(kind),w=await k.wire(o.data,kind);expect((await post(`/api/account/${kind}/verify`,w)).status).toBe(400);
    await env.DB.prepare('UPDATE account_challenges SET expires = ?1 WHERE challenge = ?2').bind(Date.now()-1,o.data.challenge).run();
    expect((await post(`/api/account/${kind}/verify`,w,{cookie:o.cookie})).status).toBe(400);
  });
  it('consumes a challenge once under concurrent verification',async()=>{
    const k=await passkey();if(kind==='login') await register(k);
    const o=await options(kind),w=await k.wire(o.data,kind);
    const res=await Promise.all(Array.from({length:3},()=>post(`/api/account/${kind}/verify`,w,{cookie:o.cookie})));
    expect(res.map(r=>r.status).sort()).toEqual([200,400,400]);
  });
});
it('rejects nonadvancing counters; allows 0/0',async()=>{
  const k=await passkey();await register(k);
  for(const [count,status] of [[0,200],[0,200],[5,200],[4,400],[5,400],[0,400],[6,200]]) {
    const o=await options('login');expect((await post('/api/account/login/verify',await k.wire(o.data,'login',{count}),{cookie:o.cookie})).status).toBe(status);
  }
});
it('rejects malformed CBOR, duplicate keys, indefinite lengths, tags, floats and malformed DER',async()=>{
  const k=await passkey(),o=await options('register'),w=await k.wire(o.data,'register');w.response.attestationObject=b64(new Uint8Array([0xbf,0xff]));
  expect((await post('/api/account/register/verify',w,{cookie:o.cookie})).status).toBe(400);
  for(const bytes of [[0xa2,1,1,1,2],[0x5a,255,255],[0xc0,0],[0x9f],[0xfa,0,0,0,0]]) expect(()=>decodeCBOR(new Uint8Array(bytes))).toThrow();
  for(const bytes of [[48,6,2,1,128,2,1,1],[48,7,2,2,0,1,2,1,1],[48,1,0]]) expect(()=>derToRaw(new Uint8Array(bytes))).toThrow();
});
it('rejects unsupported COSE and duplicate credentials without creating another account',async()=>{
  const k=await passkey(),bad=new Map(k.cose);bad.set(3,-8);expect((await register(k,{cose:bad})).res.status).toBe(400);expect((await register(k)).res.status).toBe(200);
  const before=(await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts').first()).n;
  expect((await register(k)).res.status).toBe(400);expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts').first()).n).toBe(before);
});
it('Turnstile fails closed; injected stub validates success, hostname and action',async()=>{
  expect((await post('/api/account/register/options',{turnstile_token:'human'},{over:{TURNSTILE_TEST:undefined}})).status).toBe(403);
  expect((await post('/api/account/register/options',{turnstile_token:'bad'})).status).toBe(403);
  for(const result of [{success:true,hostname:'evil.test',action:'register'},{success:true,hostname:'swarm.bigpicsolutions.com',action:'login'}]) expect((await post('/api/account/register/options',{turnstile_token:'human'},{over:{TURNSTILE_TEST:{verify:async()=>result}}})).status).toBe(403);
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({success:true,hostname:'swarm.bigpicsolutions.com',action:'register'}));
  expect((await post('/api/account/register/options',{turnstile_token:'human'},{over:{TURNSTILE_SECRET:'test-secret'}})).status).toBe(200);
  expect(f.mock.calls[0][0]).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');expect(f.mock.calls[0][1].body.get('response')).toBe('human');
});
it('caps a network at three accounts under concurrency',async()=>{
  const keys=await Promise.all(Array.from({length:6},()=>passkey()));
  const replies=await Promise.all(keys.map(k=>register(k,{}, {ip:'192.0.2.200'})));expect(replies.map(r=>r.res.status).sort()).toEqual([200,200,200,429,429,429]);
});
it('requires CSRF protection on every account POST and applies the limiter',async()=>{
  for(const path of ['register/options','register/verify','login/options','login/verify','logout']) {
    for(const headers of [{Origin:'https://evil.test'},{'X-Swarm':'0'}]) expect((await post('/api/account/'+path,{}, {headers})).status).toBe(403);
    expect((await post('/api/account/'+path,{}, {over:{LIMITER:{limit:async()=>({success:false})}}})).status).toBe(429);
  }
  expect((await send('/api/account/register/options')).status).toBe(405);expect((await post('/api/account/missing')).status).toBe(404);
});
it('rejects oversized bodies, expired sessions and suspended login',async()=>{
  expect((await post('/api/account/register/verify',{x:'x'.repeat(25000)})).status).toBe(400);
  const k=await passkey(),r=await register(k);
  await env.DB.prepare('UPDATE sessions SET expires = ?1 WHERE account = (SELECT account FROM credentials WHERE id = ?2)').bind(Date.now()-1,k.id).run();
  expect((await(await send('/api/account/me',{headers:{Cookie:r.cookie}})).json()).signed_in).toBe(false);
  await env.DB.prepare('UPDATE accounts SET suspended = 1 WHERE id = (SELECT account FROM credentials WHERE id = ?1)').bind(k.id).run();
  const o=await options('login');expect((await post('/api/account/login/verify',await k.wire(o.data,'login'),{cookie:o.cookie})).status).toBe(400);
});
