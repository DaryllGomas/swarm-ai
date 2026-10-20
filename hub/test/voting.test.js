import { beforeEach, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { publishSnapshot, projection } from '../src/voting.js';
import { currentAllocation, weekStats } from '../src/core.js';
import { weekOf, weekStartMs, sha256 } from '../src/lib.js';
import { random } from '../src/webauthn.js';
import { makeEnv, send, resetDb, newUser, addTask, BODY, SOURCE } from './helpers.js';
import { post } from './passkeys.js';
import { wrapDb } from './fault.js';
const start=()=>weekStartMs(), week=()=>weekOf();
beforeEach(async()=>{
  await resetDb();
  await env.DB.batch([
    env.DB.prepare('UPDATE accounts SET suspended = 1'),env.DB.prepare('DELETE FROM vote_snapshots'),env.DB.prepare('DELETE FROM allocation'),
    env.DB.prepare("INSERT INTO allocation(week,project,share,provisional) VALUES (?1,'town-hall',5000,1),(?1,'swarm-ai',5000,1)").bind(week()),
    env.DB.prepare('UPDATE projects SET active = 1, paused = 0, max_pending = 100'),
  ]);
});
async function voter({created=start()-1, suspended=0, allocations={'town-hall':70,'swarm-ai':30}, saved=start()-1}={}) {
  const id=random(),sid=random();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO accounts(id,created,suspended,network) VALUES (?1,?2,?3,?4)').bind(id,created,suspended,random()),
    env.DB.prepare('INSERT INTO sessions(hash,account,expires) VALUES (?1,?2,?3)').bind(await sha256(`${env.HASH_SALT}|session|${sid}`),id,Date.now()+86400000),
  ]);
  if(allocations) await version(id,allocations,saved);
  return {id,cookie:`swarm_sid=${sid}`};
}
const crowd=async(n,o={})=>{const out=[];for(let i=0;i<n;i++)out.push(await voter(o));return out;};
const version=(id,a,created)=>env.DB.prepare(`INSERT INTO ballot_versions(account,version,allocations,created) SELECT ?1,COALESCE(MAX(version),0)+1,?2,?3 FROM ballot_versions WHERE account = ?1`).bind(id,JSON.stringify(a),created).run();
const shares=async(w=week())=>(await env.DB.prepare('SELECT project,share,provisional FROM allocation WHERE week = ?1 ORDER BY project').bind(w).all()).results;
it('ballots require sign-in, exactly 100 integer points and active known projects',async()=>{
  expect((await send('/api/ballot')).status).toBe(401);
  const v=await voter({allocations:null});
  for(const a of [{},{'town-hall':99},{'town-hall':101,'swarm-ai':-1},{'town-hall':99.5,'swarm-ai':0.5},{'town-hall':'100'},{unknown:100},[100]]) expect((await post('/api/ballot',{allocations:a},{cookie:v.cookie,method:'PUT'})).status).toBe(400);
  await env.DB.prepare("UPDATE projects SET active = 0 WHERE id = 'swarm-ai'").run();
  expect((await post('/api/ballot',{allocations:{'swarm-ai':100}},{cookie:v.cookie,method:'PUT'})).status).toBe(400);
  expect((await post('/api/ballot',{allocations:{'town-hall':100}},{cookie:v.cookie,method:'PUT'})).status).toBe(200);
});
it('versions append atomically, persist and cannot be rewritten or deleted',async()=>{
  const v=await voter({allocations:null});
  expect(await(await send('/api/ballot',{headers:{Cookie:v.cookie}})).json()).toEqual({allocations:{},version:0});
  const writes=await Promise.all([70,60,80].map(p=>post('/api/ballot',{allocations:{'town-hall':p,'swarm-ai':100-p}},{cookie:v.cookie,method:'PUT'})));
  expect(writes.map(r=>r.status)).toEqual([200,200,200]);
  const versions=await Promise.all(writes.map(r=>r.json()));expect(versions.map(x=>x.version).sort()).toEqual([1,2,3]);
  const last=versions.find(x=>x.version===3);expect(await(await send('/api/ballot',{headers:{Cookie:v.cookie}})).json()).toEqual(last);
  expect((await(await send('/api/account/me',{headers:{Cookie:v.cookie}})).json()).has_ballot).toBe(true);
  await expect(env.DB.prepare('UPDATE ballot_versions SET version = 9 WHERE account = ?1').bind(v.id).run()).rejects.toThrow(/append-only/);
  await expect(env.DB.prepare('DELETE FROM ballot_versions WHERE account = ?1').bind(v.id).run()).rejects.toThrow(/append-only/);
});
it('ballot writes enforce exact Origin, X-Swarm and rate limit; methods and malformed input fail',async()=>{
  const v=await voter();
  for(const headers of [{Origin:'https://evil.test'},{'X-Swarm':'0'}]) expect((await post('/api/ballot',{allocations:{'town-hall':100}},{cookie:v.cookie,method:'PUT',headers})).status).toBe(403);
  expect((await post('/api/ballot',{}, {cookie:v.cookie,method:'PUT',over:{LIMITER:{limit:async()=>({success:false})}}})).status).toBe(429);
  expect((await post('/api/ballot',{}, {cookie:v.cookie})).status).toBe(405);
  expect((await post('/api/ballot',{allocations:null}, {cookie:v.cookie,method:'PUT'})).status).toBe(400);
});
it('publishes a real 70/30 snapshot in basis points and keeps percent interfaces',async()=>{
  await crowd(5);expect(await publishSnapshot(env)).toMatchObject({published:true});
  expect(await shares()).toEqual([{project:'swarm-ai',share:3000,provisional:0},{project:'town-hall',share:7000,provisional:0}]);
  expect((await currentAllocation(env)).shares).toEqual({'swarm-ai':30,'town-hall':70});
  expect((await weekStats(env)).projects.find(p=>p.id==='town-hall').allocation.share).toBe(70);
  const current=await(await send('/api/vote/current')).json();expect(current).toMatchObject({source:'ballots',provisional:false,voter_count:'5-9',unit:'basis_points',projected:false});
});
it('largest remainders sum to 10000 and break ties by project id',async()=>{
  await env.DB.prepare("INSERT INTO projects(id,name,kind,summary,reviewer) VALUES ('third','Third','research','test','reviewer')").run();
  for(const id of ['swarm-ai','town-hall','third','swarm-ai','town-hall','third']) await voter({allocations:{[id]:100}});
  await publishSnapshot(env);
  const s=await shares();expect(s.reduce((n,r)=>n+r.share,0)).toBe(10000);expect(s.map(r=>r.share)).toEqual([3334,3333,3333]);
  await env.DB.prepare("UPDATE projects SET active = 0 WHERE id = 'third'").run();
});
it('snapshot is idempotent under concurrency and ignores later ballot edits',async()=>{
  const [v]=await crowd(5);const results=await Promise.all(Array.from({length:5},()=>publishSnapshot(env)));
  expect(results.filter(r=>r.published)).toHaveLength(1);
  await version(v.id,{'swarm-ai':100},Date.now());expect((await publishSnapshot(env)).published).toBe(false);
  expect((await shares()).find(r=>r.project==='town-hall').share).toBe(7000);
});
it('zero ballots carries forward a provisional fallback and records no democratic result',async()=>{
  await env.DB.prepare("UPDATE allocation SET share = CASE project WHEN 'town-hall' THEN 7000 ELSE 3000 END, provisional = 0").run();
  await publishSnapshot(env);
  expect((await shares()).every(r=>r.provisional===1)).toBe(true);
  expect(await env.DB.prepare('SELECT source,voter_count FROM vote_snapshots WHERE week = ?1').bind(week()).first()).toEqual({source:'fallback',voter_count:0});
  expect(await projection(env)).toEqual({week:weekOf(start()+7*86400000),projected:false,reason:'fewer than 5 ballots',voter_count:'fewer than 5'});
});
it('eligibility excludes accounts created at/after cutoff, suspended accounts and late edits; uses earlier versions',async()=>{
  const [v]=await crowd(5);await version(v.id,{'swarm-ai':100},start());
  await voter({created:start()});await voter({created:start()+1});await voter({suspended:1});await voter({saved:start()});
  await publishSnapshot(env,start()+3600000);
  expect((await shares()).find(r=>r.project==='town-hall').share).toBe(7000);
  expect((await env.DB.prepare('SELECT voter_count FROM vote_snapshots WHERE week = ?1').bind(week()).first()).voter_count).toBe(5);
});
it('Monday UTC and year boundaries produce separate snapshots and persistent ballots',async()=>{
  await crowd(5,{created:Date.parse('2026-01-01Z'),saved:Date.parse('2026-01-01Z')});
  for(const [time,w] of [['2026-12-27T23:59:59.999Z','2026-12-21'],['2026-12-28T00:00:00Z','2026-12-28'],['2027-01-04T00:00:00Z','2027-01-04']]) {
    expect(await publishSnapshot(env,Date.parse(time))).toEqual({published:true,week:w});expect((await shares(w)).reduce((n,r)=>n+r.share,0)).toBe(10000);
  }
});
it('deactivated projects invalidate old ballots until saved again',async()=>{
  await crowd(5);await env.DB.prepare("UPDATE projects SET active = 0 WHERE id = 'swarm-ai'").run();
  await publishSnapshot(env);expect((await env.DB.prepare('SELECT source FROM vote_snapshots WHERE week = ?1').bind(week()).first()).source).toBe('fallback');
});
it('snapshot transaction rolls back completely if any allocation write fails',async()=>{
  await crowd(5);const db=wrapDb(env.DB,{failBatchAt:2});
  await expect(publishSnapshot(makeEnv({DB:db}))).rejects.toThrow();
  expect(await env.DB.prepare('SELECT * FROM vote_snapshots WHERE week = ?1').bind(week()).first()).toBeNull();
  expect((await shares()).every(r=>r.provisional===1)).toBe(true);expect((await publishSnapshot(env)).published).toBe(true);
});
it('audit returns aggregates only, counts daily voters once, fills 30 days and lists snapshot history',async()=>{
  const v=await voter();await version(v.id,{'swarm-ai':100},Date.now()-1);await version(v.id,{'town-hall':100},Date.now());
  await publishSnapshot(env);const a=await(await send('/api/vote/audit')).json();
  expect(a.eligible_voter_count).toBe('fewer than 5');expect(a.ballots_per_day).toHaveLength(30);expect(a.ballots_per_day.at(-1).ballots).toBe('<5');expect(a.snapshot_history).toHaveLength(1);
  const text=JSON.stringify(a);expect(text).not.toContain(v.id);expect(text).not.toContain('allocations');expect(text).not.toContain('network');
  expect((await send('/api/vote/config')).status).toBe(200);expect((await send('/api/vote/missing')).status).toBe(404);expect((await post('/api/vote/current')).status).toBe(405);
});
it('the real weighted-deficit scheduler converges to snapshot 70/30 in routed units',async()=>{
  await crowd(5);await publishSnapshot(env);
  await env.DB.prepare("UPDATE projects SET kind = 'research' WHERE id = 'swarm-ai'").run();
  for(const project of ['town-hall','swarm-ai']) for(let i=0;i<55;i++) await addTask({project,units:i%3===0?3:1});
  const users=await Promise.all(Array.from({length:5},()=>newUser()));
  for(let i=0;i<60;i++) {
    const u=users[i%users.length],r=await u.call('next_task');expect(r.isError,r.text).toBe(false);
    const sub=await u.call('submit_work',{task_id:r.data.task.id,body:BODY,sources:[SOURCE]});expect(sub.isError,sub.text).toBe(false);
  }
  const s=await weekStats(env),by=Object.fromEntries(s.projects.map(p=>[p.id,p.routed_units]));
  const total=by['town-hall']+by['swarm-ai'];expect(total).toBeGreaterThan(60);expect(Math.abs(by['town-hall']/total-0.7)).toBeLessThan(0.04);
});
