// Migration 0010 against a database that already has rows (accounts, sessions, credentials, ballots, events, contributors):
// nothing is lost, the new defaults protect people, ballots and events can be anonymised or scrubbed and nothing else.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';

const db = () => env.MIG_DB;
const one = (sql, ...b) => db().prepare(sql).bind(...b).first();
const all = (sql, ...b) => db().prepare(sql).bind(...b).all().then((r) => r.results);
const run = (sql, ...b) => db().prepare(sql).bind(...b).run();
async function wipe() {
  const { results } = await db().prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND type IN ('table','view')").all();
  await db().batch([db().prepare('PRAGMA defer_foreign_keys = on'), ...results.map((r) => db().prepare(`DROP ${r.type} IF EXISTS "${r.name}"`))]);
}
const NOW = Date.now();
const upTo = (re) => env.TEST_MIGRATIONS.filter((m) => re.test(m.name));

beforeEach(async () => {
  await wipe();
  await applyD1Migrations(db(), upTo(/^000[1-9]/));
  await db().batch([
    db().prepare("INSERT INTO contributors (id, handle, key_hash, created, pair_ip, owner_account) VALUES (1, 'old-user', 'h1', ?1, 'oldhash', 'acct')").bind(NOW),
    db().prepare("INSERT INTO accounts (id, created, suspended, network, fallback) VALUES ('acct', ?1, 0, 'oldnet', 0), ('acct2', ?1, 1, 'oldnet2', 1)").bind(NOW),
    db().prepare("INSERT INTO credentials (id, account, public_key, sign_count, transports) VALUES ('cred', 'acct', '{}', 3, '[]')"),
    db().prepare("INSERT INTO sessions (hash, account, expires) VALUES ('sess', 'acct', ?1)").bind(NOW + 1000),
    db().prepare("INSERT INTO account_links (account, contributor, linked_at, via) VALUES ('acct', 1, ?1, 'code')").bind(NOW),
    db().prepare("INSERT INTO ballot_versions (account, version, allocations, created) VALUES ('acct', 1, '{\"town-hall\":100}', ?1), ('acct', 2, '{\"town-hall\":60,\"swarm-ai\":40}', ?1)").bind(NOW),
    db().prepare("INSERT INTO events (ts, type, contributor, actor, detail) VALUES (?1, 'task_claimed', 1, 'old-user', '{\"claim\":1}')").bind(NOW),
  ]);
  await applyD1Migrations(db(), upTo(/^0010/));
});

describe('migration 0010', () => {
  it('keeps every account, credential, session, link and ballot, and gives accounts the private defaults', async () => {
    expect(await all('SELECT id, suspended, network, fallback, credit, history, research, research_id FROM accounts ORDER BY id')).toEqual([
      { id: 'acct', suspended: 0, network: 'oldnet', fallback: 0, credit: 'anonymous', history: 'private', research: 'aggregate', research_id: null },
      { id: 'acct2', suspended: 1, network: 'oldnet2', fallback: 1, credit: 'anonymous', history: 'private', research: 'aggregate', research_id: null },
    ]);
    expect((await one('SELECT COUNT(*) AS n FROM credentials')).n).toBe(1);
    expect((await one('SELECT COUNT(*) AS n FROM sessions')).n).toBe(1);
    expect((await one('SELECT COUNT(*) AS n FROM account_links')).n).toBe(1);
    expect(await all('SELECT account, version FROM ballot_versions ORDER BY id')).toEqual([{ account: 'acct', version: 1 }, { account: 'acct', version: 2 }]);
    // Foreign keys still hold after the rebuild.
    await expect(run("INSERT INTO sessions (hash, account, expires) VALUES ('x', 'nobody', 1)")).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('existing contributors are credited anonymously and are not removed', async () => {
    expect(await one('SELECT credit, removed, owner_account FROM contributors WHERE id = 1')).toEqual({ credit: 'anonymous', removed: 0, owner_account: 'acct' });
    await expect(run("UPDATE contributors SET credit = 'everyone' WHERE id = 1")).rejects.toThrow(/CHECK/i);
  });

  it('network hashes may now be NULL, and the choice columns only take their values', async () => {
    await run('UPDATE accounts SET network = NULL WHERE id = ?1', 'acct');
    expect((await one("SELECT network FROM accounts WHERE id = 'acct'")).network).toBeNull();
    for (const [col, bad] of [['credit', 'public'], ['history', 'forever'], ['research', 'sell']]) await expect(run(`UPDATE accounts SET ${col} = ? WHERE id = 'acct'`, bad)).rejects.toThrow(/CHECK/i);
  });

  it('ballots stay append-only except that an account\'s ballots may be re-labelled gone:', async () => {
    await expect(run("DELETE FROM ballot_versions WHERE id = 1")).rejects.toThrow(/append-only/);
    await expect(run("UPDATE ballot_versions SET allocations = '{\"swarm-ai\":100}' WHERE id = 1")).rejects.toThrow(/append-only/);
    await expect(run("UPDATE ballot_versions SET account = 'someone-else' WHERE id = 1")).rejects.toThrow(/append-only/);
    await expect(run("UPDATE ballot_versions SET account = 'gone:abc', version = 9 WHERE id = 1")).rejects.toThrow(/append-only/);
    await run("UPDATE ballot_versions SET account = 'gone:' || id WHERE account = 'acct'");
    expect(await all('SELECT account, version, allocations FROM ballot_versions ORDER BY id')).toEqual([
      { account: 'gone:1', version: 1, allocations: '{"town-hall":100}' }, { account: 'gone:2', version: 2, allocations: '{"town-hall":60,"swarm-ai":40}' },
    ]);
    await expect(run("UPDATE ballot_versions SET account = 'gone:again' WHERE id = 1")).rejects.toThrow(/append-only/);
  });

  it('events stay append-only except that contributor, actor and detail may be scrubbed to NULL', async () => {
    await expect(run('DELETE FROM events')).rejects.toThrow(/append-only/);
    await expect(run("UPDATE events SET type = 'other'")).rejects.toThrow(/append-only/);
    await expect(run("UPDATE events SET detail = '{\"x\":1}'")).rejects.toThrow(/append-only/);
    await expect(run("UPDATE events SET actor = 'someone-else'")).rejects.toThrow(/append-only/);
    await run('UPDATE events SET detail = NULL, actor = NULL, contributor = NULL');
    expect(await one('SELECT type, contributor, actor, detail FROM events')).toEqual({ type: 'task_claimed', contributor: null, actor: null, detail: null });
  });

  it('ownership is still fixed, except that releasing a contributor (removed = 1) may clear it', async () => {
    await expect(run("UPDATE contributors SET owner_account = 'acct2' WHERE id = 1")).rejects.toThrow(/cannot be changed/);
    await expect(run('UPDATE contributors SET owner_account = NULL WHERE id = 1')).rejects.toThrow(/cannot be changed/);
    await run('UPDATE contributors SET owner_account = NULL, removed = 1 WHERE id = 1');
    expect(await one('SELECT owner_account, removed FROM contributors WHERE id = 1')).toEqual({ owner_account: null, removed: 1 });
  });

  it('creates the key and rollup tables', async () => {
    for (const t of ['network_keys', 'rollup_weeks', 'weekly_project_stats', 'weekly_model_stats']) expect((await one(`SELECT COUNT(*) AS n FROM ${t}`)).n).toBe(0);
    await run("INSERT INTO network_keys (day, key) VALUES ('2026-10-20', 'k')");
    await expect(run("INSERT INTO network_keys (day, key) VALUES ('2026-10-20', 'other')")).rejects.toThrow(/UNIQUE/i);
  });

  it('a research id is unique', async () => {
    await run("UPDATE accounts SET research_id = 'r-1' WHERE id = 'acct'");
    await expect(run("UPDATE accounts SET research_id = 'r-1' WHERE id = 'acct2'")).rejects.toThrow(/UNIQUE/i);
  });
});
