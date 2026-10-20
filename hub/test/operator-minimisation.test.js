// The operator console (/ops) and the admin API must never expose an individual voter's ballot, any voter-to-contributor link,
// or any network hash: not in a field, not inside an event, not by accident. Every ops and admin response is scanned.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { ADMIN, BODY, SOURCE, addTask, newUser, resetDb, review, send } from './helpers.js';
import { accessFixture } from './access-helpers.js';
import { ipHashFor, legacyIpHashFor } from '../src/lib.js';
import { linkedUser, mePost, setupProjects, voter } from './voter.js';

beforeEach(async () => { await resetDb(); await setupProjects(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const FORBIDDEN_KEYS = new Set(['network', 'network_day', 'pair_ip', 'ip', 'ip_hash', 'ip_hashes', 'owner_account', 'account', 'account_id', 'account_id_short', 'accounts', 'allocations', 'ballot', 'ballots', 'ballot_versions', 'voter', 'voters', 'voter_id', 'session', 'sessions', 'research_id', 'credential', 'credentials', 'link', 'linked_account']);
function keysOf(value, path = '', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => keysOf(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push({ k, path: `${path}.${k}` }); keysOf(v, `${path}.${k}`, out); }
  return out;
}

// A world with everything sensitive in it: voters with ballots and sessions, linked AIs, network hashes, an old event that names an account.
async function world() {
  const reqFor = (ip) => new Request('https://swarm.test/', { headers: { 'CF-Connecting-IP': ip } });
  const secrets = [];
  const v = await voter({ allocations: { 'town-hall': 37, 'swarm-ai': 63 } });
  secrets.push(v.id, v.id.slice(0, 8), v.cookie.split('=')[1], '"swarm-ai":63', '"town-hall":37', 'swarm-ai\\":63');
  const linked = await linkedUser(v, { handle: 'linked-ai', ip: '203.0.113.50' });
  const plain = await newUser({ ip: '203.0.113.51' });
  // A claim, a submission, a held task: the ordinary state the console shows.
  const t = await addTask(); await linked.call('claim_task', { id: t });
  const s = await linked.call('submit_work', { task_id: t, body: BODY, sources: [SOURCE], model: 'm', tokens_est: 5 });
  const t2 = await addTask(); await plain.call('claim_task', { id: t2 });
  await addTask({ status: 'held', held_reason: 'screen' });
  // Network hashes in every column that has one, both formats.
  for (const ip of ['203.0.113.50', '203.0.113.51']) secrets.push(await ipHashFor(env, reqFor(ip)), await ipHashFor(env, reqFor(ip), 1), await legacyIpHashFor(env, reqFor(ip)));
  for (const r of (await env.DB.prepare('SELECT network FROM claims WHERE network IS NOT NULL').all()).results) secrets.push(r.network);
  for (const r of (await env.DB.prepare('SELECT pair_ip FROM contributors WHERE pair_ip IS NOT NULL').all()).results) secrets.push(r.pair_ip);
  for (const r of (await env.DB.prepare('SELECT network FROM accounts WHERE network IS NOT NULL').all()).results) secrets.push(r.network);
  // An old-format event that names the account next to a contributor: the link itself.
  const cid = (await env.DB.prepare('SELECT id FROM contributors WHERE handle = ?1').bind('linked-ai').first()).id;
  await env.DB.prepare("INSERT INTO events (ts, type, contributor, actor, detail) VALUES (?1, 'account_linked', ?2, 'system', ?3)").bind(Date.now(), cid, JSON.stringify({ account: v.id.slice(0, 8), via: 'code' })).run();
  // A real link code, hashed in the database.
  await mePost('/api/me/link-code', v);
  for (const r of (await env.DB.prepare('SELECT hash FROM sessions').all()).results) secrets.push(r.hash);
  return { v, linked, plain, submission: s.data.submission_id, task: t, secrets: [...new Set(secrets.filter((x) => x && x.length >= 6))], cid };
}

function assertClean(label, body, secrets) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  for (const s of secrets) expect(text, `${label} leaks ${s.slice(0, 12)}`).not.toContain(s);
  let parsed = body;
  if (typeof body === 'string') { try { parsed = JSON.parse(body); } catch { parsed = null; } }
  for (const { k, path } of keysOf(parsed)) expect(FORBIDDEN_KEYS.has(k), `${label}: forbidden field ${path}`).toBe(false);
  expect(text).not.toMatch(/"(?:network|pair_ip|owner_account|network_day)"/);
}

describe('/ops responses', () => {
  it('never contain a ballot, a voter-to-contributor link or a network hash, on any endpoint', async () => {
    const w = await world();
    const a = await accessFixture();
    const gets = ['overview', 'pending', 'held', 'projects', 'audit'];
    for (const path of gets) {
      const res = await a.get(path);
      expect(res.status, path).toBe(200);
      assertClean(`/api/ops/${path}`, await res.text(), w.secrets);
    }
    // The audit pages through every event, so the old event that named an account is covered too.
    let before = null, seen = 0;
    do {
      const res = await a.get(`audit${before ? `?before=${before}` : ''}`);
      const data = await res.json();
      assertClean('audit page', data, w.secrets);
      seen += data.events.length; before = data.next_before;
    } while (before);
    expect(seen).toBeGreaterThan(5);
    // The account_linked event is still listed (it is a fact about the contributor), without the account.
    const events = (await (await a.get('audit')).json()).events;
    const linkEvent = events.find((e) => e.type === 'account_linked' && e.contributor === w.cid && /code/.test(e.detail ?? ''));
    expect(linkEvent, 'the old link event is shown').toBeTruthy();
    expect(JSON.parse(linkEvent.detail)).toEqual({ via: 'code' });
    // Writes answer with nothing sensitive either.
    for (const [path, body] of [['project', { id: 'town-hall', paused: false, max_pending: 10 }], ['review', { id: w.submission, decision: 'accept', note: 'ok' }], ['revoke', { contributor_id: w.cid }]]) {
      const res = await a.post(path, body);
      assertClean(`POST /api/ops/${path}`, await res.text(), w.secrets);
    }
    assertClean('/ops page', await (await send('/ops', { headers: a.headers }, a.config)).text(), w.secrets);
  });

  it('the audit signal for pairings is a bare count: no network, hashed or not', async () => {
    const a = await accessFixture();
    for (let i = 0; i < 4; i++) await newUser({ ip: '203.0.113.88' });
    const data = await (await a.get('audit')).json();
    const near = data.signals.pairings_near_cap;
    expect(near.length).toBeGreaterThan(0);
    for (const row of near) expect(Object.keys(row)).toEqual(['pairings']);
  });

  it('new link events no longer carry an account id at all', async () => {
    const v = await voter();
    const u = await linkedUser(v);
    const c = (await env.DB.prepare('SELECT id FROM contributors WHERE handle = ?1').bind(u.handle).first()).id;
    const ev = await env.DB.prepare("SELECT detail FROM events WHERE type = 'account_linked' AND contributor = ?1").bind(c).first();
    expect(JSON.parse(ev.detail)).toEqual({ via: 'code' });
    await mePost('/api/me/unlink', v);
    const un = await env.DB.prepare("SELECT detail FROM events WHERE type = 'account_unlinked' AND contributor = ?1").bind(c).first();
    expect(JSON.parse(un.detail)).toEqual({ reason: 'unlinked' });
  });
});

describe('/api/admin responses', () => {
  it('never contain a ballot, a voter-to-contributor link or a network hash, on any endpoint', async () => {
    const w = await world();
    const H = { ...ADMIN(), 'Content-Type': 'application/json' };
    // Make it publishable for the Town Hall export.
    const t3 = await addTask({ project: 'town-hall' });
    await w.plain.call('claim_task', { id: t3 }).catch(() => {});
    const calls = [
      ['/api/admin/pending', { headers: H }],
      ['/api/admin/held', { headers: H }],
      ['/api/admin/submission?id=' + w.submission, { headers: H }],
      ['/api/admin/review', { method: 'POST', headers: H, body: JSON.stringify({ id: w.submission, decision: 'accept', note: 'fine' }) }],
      ['/api/admin/submission?id=' + w.submission, { headers: H }],
      ['/api/admin/published', { method: 'POST', headers: H, body: JSON.stringify({ submission_id: w.submission, url: 'https://example.org/published' }) }],
      ['/api/admin/pending', { headers: H }],
    ];
    for (const [path, init] of calls) {
      const res = await send(path, init);
      assertClean(`${init.method ?? 'GET'} ${path}`, await res.text(), w.secrets);
    }
  });

  it('is still hidden without the token', async () => {
    expect((await send('/api/admin/pending')).status).toBe(404);
    expect((await send('/api/admin/pending', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(404);
  });
});

describe('the scan itself', () => {
  it('would catch a leak: a response with an account id, a hash or a forbidden field fails', () => {
    expect(() => assertClean('x', { account: 'abc' }, [])).toThrow();
    expect(() => assertClean('x', { fine: 'v-abc12345def' }, ['abc12345'])).toThrow();
    expect(() => assertClean('x', [{ rows: [{ network: 'h' }] }], [])).toThrow();
    expect(() => assertClean('x', { counts: { ballot_directed: 3 } }, [])).not.toThrow();
  });
});
