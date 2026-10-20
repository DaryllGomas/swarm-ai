import { b64, unb64, join, digest, random } from '../src/webauthn.js';
import { send, nextIp } from './helpers.js';
export const ORIGIN = 'https://swarm.bigpicsolutions.com';
export const STUB = { verify: async (token) => ({ success: token === 'human', hostname: 'swarm.bigpicsolutions.com', action: 'register' }) };
// Wire-format fixtures: independent encoder, real generated keys, real signed assertions.
export function cbor(v) {
  const head = (m,n) => n < 24 ? new Uint8Array([m*32+n]) : n < 256 ? new Uint8Array([m*32+24,n]) : new Uint8Array([m*32+25,n>>8,n&255]);
  if (typeof v === 'number') return head(v<0?1:0,v<0?-1-v:v);
  if (v instanceof Uint8Array) return join(head(2,v.length),v);
  if (typeof v === 'string') { const b=new TextEncoder().encode(v); return join(head(3,b.length),b); }
  if (v instanceof Map) return join(head(5,v.size),...[...v].flatMap(([k,x])=>[cbor(k),cbor(x)]));
  throw new Error('Unsupported fixture');
}
export function rawToDer(raw) {
  const ints=[raw.slice(0,32),raw.slice(32)].map(v=>{
    while(v.length>1 && v[0]===0) v=v.slice(1);
    if(v[0]&128) v=join(new Uint8Array([0]),v);
    return join(new Uint8Array([2,v.length]),v);
  }); const seq=join(...ints); return join(new Uint8Array([48,seq.length]),seq);
}
export async function passkey(alg='ES256') {
  const algo=alg==='ES256'?{name:'ECDSA',namedCurve:'P-256',hash:'SHA-256'}:{name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'};
  const keys=await crypto.subtle.generateKey(algo,true,['sign','verify']), jwk=await crypto.subtle.exportKey('jwk',keys.publicKey);
  const cose=alg==='ES256'?new Map([[1,2],[3,-7],[-1,1],[-2,unb64(jwk.x)],[-3,unb64(jwk.y)]]):new Map([[1,3],[3,-257],[-1,unb64(jwk.n)],[-2,unb64(jwk.e)]]);
  const id=random(),ip=nextIp();
  async function wire(options,kind,over={}) {
    const count=new Uint8Array(4); new DataView(count.buffer).setUint32(0,over.count??(kind==='register'?0:1));
    let auth=join(await digest(new TextEncoder().encode(over.rp||'swarm.bigpicsolutions.com')),new Uint8Array([over.flags??(kind==='register'?69:5)]),count);
    const cd=new TextEncoder().encode(JSON.stringify({type:kind==='register'?'webauthn.create':'webauthn.get',origin:over.origin||ORIGIN,challenge:over.challenge||options.challenge,crossOrigin:false,...over.client}));
    const response={clientDataJSON:b64(cd)};
    if(kind==='register') {
      const bytes=unb64(id); auth=join(auth,new Uint8Array(16),new Uint8Array([bytes.length>>8,bytes.length&255]),bytes,cbor(over.cose||cose));
      response.attestationObject=b64(cbor(new Map([['fmt','none'],['attStmt',new Map()],['authData',auth]]))); response.transports=['internal'];
    } else {
      let sig=new Uint8Array(await crypto.subtle.sign(algo,keys.privateKey,join(auth,await digest(cd))));
      if(alg==='ES256') sig=rawToDer(sig);
      response.authenticatorData=b64(auth);response.signature=b64(sig);
      if(over.userHandle) response.userHandle=over.userHandle;
    }
    return {id,rawId:id,type:'public-key',response};
  }
  return {id,ip,wire,cose};
}
export const cookieOf=r=>r.headers.get('Set-Cookie')?.split(';')[0];
export const post=(path,body={},args={})=>send(path,{method:args.method||'POST',headers:{'Content-Type':'application/json',Origin:ORIGIN,'X-Swarm':'1','CF-Connecting-IP':args.ip||nextIp(),...(args.cookie?{Cookie:args.cookie}:{}),...args.headers},body:JSON.stringify(body)},{TURNSTILE_TEST:STUB,...args.over});
export async function options(kind,args={}) {const res=await post(`/api/account/${kind}/options`,kind==='register'?{turnstile_token:'human'}:{},args);return {res,data:await res.json(),cookie:cookieOf(res)};}
export async function register(k,over={},args={}) {
  const o=await options('register',{ip:k.ip,...args}),body=await k.wire(o.data,'register',over);
  const res=await post('/api/account/register/verify',body,{ip:k.ip,cookie:o.cookie,...args});
  return {res,body,cookie:cookieOf(res),ceremony:o.cookie,options:o.data};
}
