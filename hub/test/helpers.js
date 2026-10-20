// Shared test helpers: call the Worker directly (so env vars like INTAKE can be overridden per call), speak MCP to it,
// and reset the local D1 database between tests.
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/worker.js';

export const ADMIN = () => ({ Authorization: `Bearer ${env.ADMIN_TOKEN}` });

// env with the rate limiter off (it is per-network and would trip in a busy test) and any overrides on top.
export function makeEnv(over = {}) {
  const e = Object.create(env);
  // defineProperty, not assignment: env may be a proxy whose set trap would write through to the shared env.
  for (const [k, v] of Object.entries({ LIMITER: undefined, AI: undefined, ...over })) Object.defineProperty(e, k, { value: v, enumerable: true });
  // The OAuth provider stores its helpers here on the env it is given; keep that write on this copy.
  Object.defineProperty(e, 'OAUTH_PROVIDER', { value: undefined, enumerable: true, writable: true });
  return e;
}

export async function send(path, init = {}, over = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://swarm.test${path}`, init), makeEnv(over), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

let ipCounter = 0;
export const nextIp = () => `198.51.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

let rpcId = 0;
export async function rpc(method, params, { headers = {}, ip = '203.0.113.9', over } = {}) {
  const res = await send('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  }, over);
  return { res, body: await res.json() };
}

// Call one tool. Returns { isError, text, data } where data is the structured result (or null on an error).
export async function tool(name, args = {}, opts = {}) {
  const { body } = await rpc('tools/call', { name, arguments: args }, opts);
  if (body.error) return { rpcError: body.error, isError: true, text: body.error.message, data: null };
  const r = body.result;
  return { isError: !!r.isError, text: r.content[0].text, data: r.structuredContent ?? null };
}

// A paired contributor: calls go out with their key in the Authorization header and from their own network.
export async function newUser({ handle, ip = nextIp(), over } = {}) {
  const r = await tool('pair', handle ? { handle } : {}, { ip, over });
  if (r.isError) throw new Error(`pair failed: ${r.text}`);
  const user = { handle: r.data.handle, key: r.data.contributor_key, ip };
  user.call = (name, args = {}, o = {}) => tool(name, args, { ip: user.ip, headers: { Authorization: `Bearer ${user.key}` }, ...o });
  return user;
}

export async function resetDb() {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM account_links'),
    env.DB.prepare('DELETE FROM link_codes'),
    env.DB.prepare('DELETE FROM link_attempts'),
    env.DB.prepare('DELETE FROM submissions'),
    env.DB.prepare('DELETE FROM claims'),
    env.DB.prepare('DELETE FROM tasks'),
    env.DB.prepare('DELETE FROM contributors'),
    env.DB.prepare('DELETE FROM meta'),
    // pretend the Town Hall sync just ran, so no test goes to the network
    env.DB.prepare("INSERT INTO meta (k, v) VALUES ('last_sync', ?1)").bind(String(Date.now())),
  ]);
}

let taskCounter = 0;
export async function addTask({ units = 3, status = 'ready', project = 'town-hall', title, held_reason = null } = {}) {
  const n = ++taskCounter;
  const res = await env.DB.prepare(
    `INSERT INTO tasks (project, kind, title, brief, output_format, units, status, held_reason, source_key, created)
     VALUES (?1, 'research_fix', ?2, ?3, 'Plain text.', ?4, ?5, ?6, ?7, ?8)`
  ).bind(project, title ?? `Test task ${n}`, `Test brief ${n}`, units, status, held_reason, `test:${n}:${Date.now()}`, Date.now() + n).run();
  return res.meta.last_row_id;
}

export const BODY = 'A researched write-up that is long enough to pass the minimum length check, with a goal, steps and the people who can make it happen. '.repeat(2);
export const SOURCE = 'https://www.consumerfinance.gov/ask-cfpb/';

// Post a review decision to the admin API.
export const review = (id, decision, note, over) => send('/api/admin/review', { method: 'POST', headers: { ...ADMIN(), 'Content-Type': 'application/json' }, body: JSON.stringify({ id, decision, ...(note === undefined ? {} : { note }) }) }, over);
