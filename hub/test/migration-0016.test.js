// Migration 0016: suspend scope, run on a database that already has suspended and active accounts.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';

const db = () => env.MIG_DB;
const all = (sql, ...b) => db().prepare(sql).bind(...b).all().then((r) => r.results);
const run = (sql, ...b) => db().prepare(sql).bind(...b).run();
async function wipe() {
  const { results } = await db().prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND type IN ('table','view')").all();
  await db().batch([db().prepare('PRAGMA defer_foreign_keys = on'), ...results.map((r) => db().prepare(`DROP ${r.type} IF EXISTS "${r.name}"`))]);
}
const upTo = (re) => env.TEST_MIGRATIONS.filter((m) => re.test(m.name));

describe('migration 0016: suspend scope', () => {
  it('keeps today\'s behaviour for suspended accounts (scope vote, own handle), leaves the others alone and changes no other column', async () => {
    await wipe();
    await applyD1Migrations(db(), upTo(/^(000\d|001[0-5])/));
    for (const [id, s] of [['a1', 1], ['a2', 1], ['a3', 0]]) await run('INSERT INTO accounts (id, created, suspended, network) VALUES (?1, 1, ?2, ?1)', id, s);
    const before = await all('SELECT id, created, suspended, network, fallback, credit, history, research FROM accounts ORDER BY id');
    await applyD1Migrations(db(), upTo(/^0016/));
    expect(await all('SELECT id, created, suspended, network, fallback, credit, history, research FROM accounts ORDER BY id')).toEqual(before);
    const rows = await all('SELECT id, suspend_scope, suspend_ref FROM accounts ORDER BY id');
    expect(rows.map((r) => r.suspend_scope)).toEqual(['vote', 'vote', null]);
    expect(rows[0].suspend_ref).toMatch(/^[0-9a-f]{8}$/); expect(rows[1].suspend_ref).toMatch(/^[0-9a-f]{8}$/);
    expect(rows[0].suspend_ref).not.toBe(rows[1].suspend_ref); expect(rows[2].suspend_ref).toBeNull();
    await expect(run("UPDATE accounts SET suspend_scope = 'bogus' WHERE id = 'a3'")).rejects.toThrow();
    await expect(run("UPDATE accounts SET suspend_ref = ?1 WHERE id = 'a3'", rows[0].suspend_ref)).rejects.toThrow();
    expect(await all('PRAGMA foreign_key_check')).toEqual([]);
  });
});
