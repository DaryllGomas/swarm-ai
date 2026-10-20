// Test helpers for Phase 4: a voter account with a session and a ballot, the /api/me calls, and a linked contributor.
import { env } from 'cloudflare:workers';
import { sha256, weekOf, weekStartMs } from '../src/lib.js';
import { random } from '../src/webauthn.js';
import { send, newUser, nextIp } from './helpers.js';
import { post, ORIGIN } from './passkeys.js';

export { ORIGIN };
export const week = () => weekOf();

export async function voter({ allocations = { 'town-hall': 80, 'swarm-ai': 20 }, suspended = 0 } = {}) {
  const id = random(), sid = random();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO accounts(id,created,suspended,network) VALUES (?1,?2,?3,?4)').bind(id, weekStartMs() - 1, suspended, random()),
    env.DB.prepare('INSERT INTO sessions(hash,account,expires) VALUES (?1,?2,?3)').bind(await sha256(`${env.HASH_SALT}|session|${sid}`), id, Date.now() + 86400000),
  ]);
  const v = { id, cookie: `swarm_sid=${sid}` };
  if (allocations) await saveBallot(v, allocations);
  return v;
}
export const saveBallot = (v, allocations) => env.DB.prepare(
  `INSERT INTO ballot_versions(account,version,allocations,created) SELECT ?1,COALESCE(MAX(version),0)+1,?2,?3 FROM ballot_versions WHERE account = ?1`
).bind(v.id, JSON.stringify(allocations), Date.now()).run();

export const meGet = (v) => send('/api/me', { headers: v ? { Cookie: v.cookie } : {} });
export const mePost = (path, v, body = {}, args = {}) => post(path, body, { cookie: v?.cookie, ...args });
export async function newCode(v) {
  const res = await mePost('/api/me/link-code', v);
  if (res.status !== 200) throw new Error(`link-code failed: ${res.status}`);
  return (await res.json()).code;
}
// A contributor linked to a voter account through the link code, the way a person and their AI do it.
export async function linkedUser(v, opts) {
  const user = await newUser(opts);
  const r = await user.call('link_account', { code: await newCode(v) });
  if (r.isError) throw new Error(`link_account failed: ${r.text}`);
  return user;
}
export { newUser, nextIp };

export async function publicAllocation(shares) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM allocation WHERE week = ?1').bind(week()),
    ...Object.entries(shares).map(([project, share]) => env.DB.prepare('INSERT INTO allocation(week,project,share,provisional) VALUES (?1,?2,?3,0)').bind(week(), project, share)),
  ]);
}
export async function setupProjects() {
  await env.DB.batch([
    env.DB.prepare('UPDATE projects SET active = 1, paused = 0, max_pending = 200'),
    env.DB.prepare("UPDATE projects SET kind = 'research' WHERE id = 'swarm-ai'"),
  ]);
}
