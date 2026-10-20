// Migration 0008 against a database that already has rows: claims are backfilled with a routing origin from the old routed flag,
// routed and routing_origin cannot disagree, and the new tables and the fallback default appear.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';

const db = () => env.MIG_DB;
const one = (sql, ...b) => db().prepare(sql).bind(...b).first();
const all = (sql, ...b) => db().prepare(sql).bind(...b).all().then((r) => r.results);
async function wipe() {
  const { results } = await db().prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND type IN ('table','view')").all();
  await db().batch([db().prepare('PRAGMA defer_foreign_keys = on'), ...results.map((r) => db().prepare(`DROP ${r.type} IF EXISTS "${r.name}"`))]);
}
const NOW = Date.now();
const upTo = (re) => env.TEST_MIGRATIONS.filter((m) => re.test(m.name));
const claim = (id, routed, extra = {}) => db().prepare(
  `INSERT INTO claims (id, task, contributor, routed, week, claimed_at, expires_at, outcome${extra.origin !== undefined ? ', routing_origin' : ''}) VALUES (?1, ?1, 1, ?2, '2026-10-19', ?3, ?3, 'submitted'${extra.origin !== undefined ? ', ?4' : ''})`
).bind(...[id, routed, NOW, ...(extra.origin !== undefined ? [extra.origin] : [])]);

beforeEach(async () => {
  await wipe();
  await applyD1Migrations(db(), upTo(/^000[1-7]/));
});

async function populate() {
  await db().batch([
    db().prepare("INSERT INTO contributors (id, handle, key_hash, created) VALUES (1, 'old-user', 'h', ?1)").bind(NOW),
    ...[1, 2, 3].map((id) => db().prepare("INSERT INTO tasks (id, project, kind, title, brief, output_format, units, status, source_key, created) VALUES (?1, 'town-hall', 'k', 'T', 'b', 'f', 3, 'submitted', ?2, ?3)").bind(id, `k${id}`, NOW)),
    claim(1, 1), claim(2, 0), claim(3, 0),
    db().prepare("INSERT INTO accounts (id, created, suspended, network) VALUES ('acct', ?1, 0, 'n')").bind(NOW),
  ]);
}

describe('migration 0008', () => {
  it('backfills routing_origin from routed (1 becomes public_routed, 0 becomes self_picked) and keeps every row', async () => {
    await populate();
    await applyD1Migrations(db(), upTo(/^0008/));
    expect(await all('SELECT id, routed, routing_origin FROM claims ORDER BY id')).toEqual([
      { id: 1, routed: 1, routing_origin: 'public_routed' }, { id: 2, routed: 0, routing_origin: 'self_picked' }, { id: 3, routed: 0, routing_origin: 'self_picked' },
    ]);
    expect((await one('SELECT COUNT(*) AS n FROM tasks')).n).toBe(3);
  });

  it('defaults every existing account to fallback on, and creates empty link tables', async () => {
    await populate();
    await applyD1Migrations(db(), upTo(/^0008/));
    expect((await one("SELECT fallback FROM accounts WHERE id = 'acct'")).fallback).toBe(1);
    for (const t of ['account_links', 'link_codes', 'link_attempts']) expect((await one(`SELECT COUNT(*) AS n FROM ${t}`)).n).toBe(0);
    await expect(db().prepare("UPDATE accounts SET fallback = 2 WHERE id = 'acct'").run()).rejects.toThrow(/CHECK/i);
  });

  it('fills the origin from routed when an insert leaves it out, and refuses a mismatch', async () => {
    await populate();
    await applyD1Migrations(db(), upTo(/^0008/));
    await db().batch([
      db().prepare("INSERT INTO tasks (id, project, kind, title, brief, output_format, units, status, source_key, created) VALUES (10, 'town-hall', 'k', 'T', 'b', 'f', 1, 'ready', 'k10', ?1)").bind(NOW),
      db().prepare("INSERT INTO tasks (id, project, kind, title, brief, output_format, units, status, source_key, created) VALUES (11, 'town-hall', 'k', 'T', 'b', 'f', 1, 'ready', 'k11', ?1)").bind(NOW),
    ]);
    const ins = (id, routed, origin) => db().prepare(
      `INSERT INTO claims (task, contributor, routed, week, claimed_at, expires_at${origin ? ', routing_origin' : ''}) VALUES (?1, 1, ?2, '2026-10-19', 1, 2${origin ? ', ?3' : ''})`
    ).bind(...[id, routed, ...(origin ? [origin] : [])]);
    await ins(10, 1).run();
    expect((await one('SELECT routing_origin FROM claims WHERE task = 10')).routing_origin).toBe('public_routed');
    await db().prepare('UPDATE claims SET outcome = ?1 WHERE task = 10').bind('released').run();
    await ins(11, 0, 'ballot_directed').run(); // ballot-directed work is not public-routed: routed = 0
    expect((await one('SELECT routed, routing_origin FROM claims WHERE task = 11'))).toEqual({ routed: 0, routing_origin: 'ballot_directed' });
    await db().prepare("UPDATE claims SET outcome = 'released' WHERE task = 11").run();
    await expect(ins(11, 1, 'ballot_directed').run()).rejects.toThrow(/routed must be 1/);
    await expect(ins(11, 0, 'public_routed').run()).rejects.toThrow(/routed must be 1/);
    await expect(ins(11, 0, 'bogus').run()).rejects.toThrow(/CHECK/i);
    await expect(db().prepare("UPDATE claims SET routed = 1 WHERE task = 11").run()).rejects.toThrow(/routed must be 1/);
    await expect(db().prepare("UPDATE claims SET routing_origin = 'public_routed' WHERE task = 11").run()).rejects.toThrow(/routed must be 1/);
  });

  it('one contributor per account and one account per contributor', async () => {
    await populate();
    await applyD1Migrations(db(), upTo(/^0008/));
    await db().batch([
      db().prepare("INSERT INTO contributors (id, handle, key_hash, created) VALUES (2, 'two', 'h2', ?1)").bind(NOW),
      db().prepare("INSERT INTO accounts (id, created, suspended, network) VALUES ('acct2', ?1, 0, 'n')").bind(NOW),
      db().prepare("INSERT INTO account_links (account, contributor, linked_at, via) VALUES ('acct', 1, ?1, 'code')").bind(NOW),
    ]);
    await expect(db().prepare("INSERT INTO account_links (account, contributor, linked_at, via) VALUES ('acct', 2, 1, 'code')").run()).rejects.toThrow(/UNIQUE/i);
    await expect(db().prepare("INSERT INTO account_links (account, contributor, linked_at, via) VALUES ('acct2', 1, 1, 'code')").run()).rejects.toThrow(/UNIQUE/i);
    await expect(db().prepare("INSERT INTO account_links (account, contributor, linked_at, via) VALUES ('acct2', 2, 1, 'email')").run()).rejects.toThrow(/CHECK/i);
  });
});
