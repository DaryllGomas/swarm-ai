// Forward-secure network hashing (migration 0010): daily HMAC keys in D1, deleted after two days, with the hashes they made.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { ipHashFor, legacyIpHashFor, networkKey, resetNetworkKeyCache, sha256, utcDay } from '../src/lib.js';
import { forgetNetworks } from '../src/privacy.js';
import worker from '../src/worker.js';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { addTask, makeEnv, newUser, nextIp, resetDb, tool } from './helpers.js';

const reqFor = (ip) => new Request('https://swarm.test/', { headers: { 'CF-Connecting-IP': ip } });
const DAY = 86400000;
const daysAgo = (n) => utcDay(Date.now() - n * DAY);
const keys = () => env.DB.prepare('SELECT day, key FROM network_keys ORDER BY day').all().then((r) => r.results);

beforeEach(async () => {
  await resetDb();
  await env.DB.prepare('DELETE FROM network_keys').run();
  resetNetworkKeyCache();
});

describe('the day key', () => {
  it('is 32 random bytes, created on first use, and the network hash is an HMAC of the network under it', async () => {
    expect(await keys()).toHaveLength(0);
    const h = await ipHashFor(env, reqFor('203.0.113.7'));
    const [row] = await keys();
    expect(row.day).toBe(utcDay());
    expect(row.key).toMatch(/^[0-9a-f]{64}$/);
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(row.key.match(/../g), (x) => parseInt(x, 16)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('203.0.113.7'));
    expect(h).toBe([...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join(''));
    // The long-lived salt plays no part in it.
    expect(h).not.toBe(await legacyIpHashFor(env, reqFor('203.0.113.7')));
  });

  it('gives one network one hash per day, and different networks different hashes', async () => {
    const a = await ipHashFor(env, reqFor('203.0.113.7')), b = await ipHashFor(env, reqFor('203.0.113.8'));
    expect(await ipHashFor(env, reqFor('203.0.113.7'))).toBe(a);
    expect(a).not.toBe(b);
    // An IPv6 address counts by its /64.
    expect(await ipHashFor(env, reqFor('2001:db8:1:2::1'))).toBe(await ipHashFor(env, reqFor('2001:db8:1:2:ffff::9')));
  });

  it('rotates: yesterday has its own key, and a hash made under it differs from today\'s', async () => {
    const today = await ipHashFor(env, reqFor('203.0.113.7'));
    const yesterday = await ipHashFor(env, reqFor('203.0.113.7'), 1);
    expect(yesterday).not.toBe(today);
    expect((await keys()).map((k) => k.day)).toEqual([daysAgo(1), daysAgo(0)]);
    const [y, t] = await keys();
    expect(y.key).not.toBe(t.key);
  });

  it('a race on first use yields one key: INSERT OR IGNORE, then SELECT', async () => {
    const day = daysAgo(0);
    const hashes = await Promise.all(Array.from({ length: 20 }, () => {
      resetNetworkKeyCache(); // every caller really goes to the database
      return ipHashFor(env, reqFor('203.0.113.7'));
    }));
    expect(new Set(hashes).size).toBe(1);
    expect(await keys()).toHaveLength(1);
    expect((await keys())[0].day).toBe(day);
    // Even a second cold start finds the same key.
    resetNetworkKeyCache();
    expect(await ipHashFor(env, reqFor('203.0.113.7'))).toBe(hashes[0]);
  });

  it('networkKey returns a usable non-extractable key', async () => {
    const k = await networkKey(env, daysAgo(0));
    expect(k.extractable).toBe(false);
    expect(k.algorithm.name).toBe('HMAC');
  });
});

describe('the caps still work', () => {
  it('4 active claims per network across handles, counting yesterday\'s hash too', async () => {
    const ip = nextIp();
    const users = [await newUser({ ip }), await newUser({ ip }), await newUser({ ip })];
    const tasks = [];
    for (let i = 0; i < 6; i++) tasks.push(await addTask());
    for (let i = 0; i < 4; i++) expect((await users[i % 2].call('claim_task', { id: tasks[i] })).isError).toBe(false);
    expect((await users[2].call('claim_task', { id: tasks[4] })).isError).toBe(true);
    // Another network is not affected.
    const other = await newUser();
    expect((await other.call('claim_task', { id: tasks[4] })).isError).toBe(false);
    // The claims carry today's HMAC hash, not the old salted one.
    const h = await ipHashFor(env, reqFor(ip));
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM claims WHERE network = ?1').bind(h).first()).n).toBe(4);
  });

  it('claims made yesterday (under yesterday\'s key) still count against the cap', async () => {
    const ip = nextIp();
    const y = await ipHashFor(env, reqFor(ip), 1);
    const u = await newUser({ ip });
    const id = (await env.DB.prepare('SELECT id FROM contributors WHERE handle = ?1').bind(u.handle).first()).id;
    for (let i = 0; i < 4; i++) {
      const t = await addTask({ status: 'claimed' });
      await env.DB.prepare('INSERT INTO claims (task, contributor, routed, week, claimed_at, expires_at, network, routing_origin) VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, ?7)')
        .bind(t, id, '2026-10-19', Date.now() - 600000, Date.now() + 3600000, y, 'self_picked').run();
    }
    const task = await addTask();
    const r = await (await newUser({ ip })).call('claim_task', { id: task });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/network/);
  });

  it('rows written before the switch (the salted hash) are still counted until the job erases them', async () => {
    const ip = nextIp();
    const legacy = await legacyIpHashFor(env, reqFor(ip));
    const u = await newUser({ ip });
    const id = (await env.DB.prepare('SELECT id FROM contributors WHERE handle = ?1').bind(u.handle).first()).id;
    for (let i = 0; i < 4; i++) {
      const t = await addTask({ status: 'claimed' });
      await env.DB.prepare('INSERT INTO claims (task, contributor, routed, week, claimed_at, expires_at, network, routing_origin) VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, ?7)')
        .bind(t, id, '2026-10-19', Date.now() - 600000, Date.now() + 3600000, legacy, 'self_picked').run();
    }
    const r = await (await newUser({ ip })).call('claim_task', { id: await addTask() });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/network/);
  });

  it('pairings are capped at 5 per network per day with the new hash, and old pair_ip rows count too', async () => {
    const ip = nextIp();
    const legacy = await legacyIpHashFor(env, reqFor(ip));
    for (let i = 0; i < 3; i++) await env.DB.prepare('INSERT INTO contributors (handle, key_hash, created, pair_ip) VALUES (?1, ?2, ?3, ?4)').bind(`old-${i}-x`, await sha256(`k${i}`), Date.now(), legacy).run();
    await newUser({ ip }); await newUser({ ip });
    const sixth = await tool('pair', {}, { ip });
    expect(sixth.isError).toBe(true);
    expect(sixth.text).toMatch(/Too many pairings/);
  });
});

describe('forgetting', () => {
  async function rowsFrom(daysBack) {
    const t = Date.now() - daysBack * DAY;
    const hash = await ipHashFor(env, reqFor('198.18.0.1'), daysBack);
    await env.DB.prepare('INSERT INTO contributors (handle, key_hash, created, pair_ip) VALUES (?1, ?2, ?3, ?4)').bind(`c-${daysBack}-${Math.random().toString(36).slice(2, 8)}`, await sha256(`k${daysBack}${Math.random()}`), t, hash).run();
    const cid = (await env.DB.prepare('SELECT id FROM contributors ORDER BY id DESC LIMIT 1').first()).id;
    const task = await addTask({ status: 'accepted' });
    await env.DB.prepare('INSERT INTO claims (task, contributor, routed, week, claimed_at, expires_at, outcome, network, routing_origin) VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, ?7, ?8)')
      .bind(task, cid, '2026-10-12', t, t + 10800000, 'submitted', hash, 'self_picked').run();
    await env.DB.prepare('INSERT INTO accounts (id, created, suspended, network) VALUES (?1, ?2, 0, ?3)').bind(`acct-${daysBack}-${cid}`, t, hash).run();
    return { hash, cid };
  }

  it('deletes keys older than two days and nulls the hashes of rows older than two days, keeping newer ones', async () => {
    const fresh = await rowsFrom(0), recent = await rowsFrom(1), old = await rowsFrom(3), older = await rowsFrom(5);
    expect((await keys()).map((k) => k.day)).toEqual([daysAgo(5), daysAgo(3), daysAgo(1), daysAgo(0)]);
    const out = await forgetNetworks(env);
    expect(out.keys).toBe(2);
    expect((await keys()).map((k) => k.day)).toEqual([daysAgo(1), daysAgo(0)]);
    const net = (id) => env.DB.prepare('SELECT network FROM claims WHERE contributor = ?1').bind(id).first().then((r) => r.network);
    const pip = (id) => env.DB.prepare('SELECT pair_ip FROM contributors WHERE id = ?1').bind(id).first().then((r) => r.pair_ip);
    const acct = (id, d) => env.DB.prepare('SELECT network FROM accounts WHERE id = ?1').bind(`acct-${d}-${id}`).first().then((r) => r.network);
    expect(await net(fresh.cid)).toBe(fresh.hash);
    expect(await net(recent.cid)).toBe(recent.hash);
    expect(await net(old.cid)).toBeNull();
    expect(await net(older.cid)).toBeNull();
    expect(await pip(fresh.cid)).toBe(fresh.hash);
    expect(await pip(old.cid)).toBeNull();
    expect(await pip(older.cid)).toBeNull();
    expect(await acct(fresh.cid, 0)).toBe(fresh.hash);
    expect(await acct(old.cid, 3)).toBeNull();
    expect(await acct(older.cid, 5)).toBeNull();
  });

  it('an erased day cannot be recomputed: a new key for that day gives a different hash', async () => {
    const old = await rowsFrom(3);
    await forgetNetworks(env);
    resetNetworkKeyCache();
    expect(await ipHashFor(env, reqFor('198.18.0.1'), 3)).not.toBe(old.hash); // the old key is gone; asking again makes a fresh, unrelated one
  });

  it('erases legacy (salted) hashes too, and link attempts older than two days', async () => {
    const legacy = await legacyIpHashFor(env, reqFor('198.18.0.9'), 3);
    await env.DB.prepare('INSERT INTO contributors (handle, key_hash, created, pair_ip) VALUES (?1, ?2, ?3, ?4)').bind('legacy-one', await sha256('legacy'), Date.now() - 3 * DAY, legacy).run();
    await env.DB.prepare('INSERT INTO link_attempts (who, ts) VALUES (?1, ?2), (?3, ?4)').bind(`n:${legacy}`, Date.now() - 3 * DAY, 'n:fresh', Date.now()).run();
    await forgetNetworks(env);
    expect((await env.DB.prepare("SELECT pair_ip FROM contributors WHERE handle = 'legacy-one'").first()).pair_ip).toBeNull();
    expect((await env.DB.prepare('SELECT who FROM link_attempts').all()).results).toEqual([{ who: 'n:fresh' }]);
  });

  it('is part of the hourly job, and runs first', async () => {
    const old = await rowsFrom(4);
    const ctx = createExecutionContext();
    await worker.scheduled({}, makeEnv({ INTAKE: 'paused' }), ctx);
    await waitOnExecutionContext(ctx);
    expect((await env.DB.prepare('SELECT network FROM claims WHERE contributor = ?1').bind(old.cid).first()).network).toBeNull();
    expect((await keys()).map((k) => k.day)).not.toContain(daysAgo(4));
  });

  it('is idempotent', async () => {
    await rowsFrom(3);
    await forgetNetworks(env);
    expect(await forgetNetworks(env)).toEqual({ claims: 0, contributors: 0, accounts: 0, keys: 0 });
  });
});
