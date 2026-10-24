// Migration 0013 (Codex review 7, R7-4): weekly people counts written before 0012 counted contributor ids, not owning accounts. Run on a populated database.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { coarseCount } from '../src/privacy.js';

const db = () => env.MIG_DB;
const all = (sql, ...b) => db().prepare(sql).bind(...b).all().then((r) => r.results);
const run = (sql, ...b) => db().prepare(sql).bind(...b).run();
async function wipe() {
  const { results } = await db().prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND type IN ('table','view')").all();
  await db().batch([db().prepare('PRAGMA defer_foreign_keys = on'), ...results.map((r) => db().prepare(`DROP ${r.type} IF EXISTS "${r.name}"`))]);
}
const upTo = (re) => env.TEST_MIGRATIONS.filter((m) => re.test(m.name));
const NOW = Date.now(), FAR = NOW + 10 * 365 * 86400000;
const stat = (week, n) => run("INSERT INTO weekly_project_stats(week, project, claimed_units, accepted_units, tasks_created, tasks_accepted, tasks_rejected, contributors, reviews) VALUES (?1, 'town-hall', 9, 3, 1, 1, 0, ?2, 1)", week, n);
const rolled = (week, at) => run('INSERT INTO rollup_weeks(week, ran_at) VALUES (?1, ?2)', week, at);
let task = 0;
const claimBy = (contributor, week) => { task++; return db().batch([
  db().prepare("INSERT INTO tasks (id, project, kind, title, brief, output_format, units, status, source_key, created) VALUES (?1, 'town-hall', 'k', 'T', 'b', 'f', 3, 'submitted', ?2, ?3)").bind(task, `k${task}`, NOW),
  db().prepare("INSERT INTO claims (task, contributor, routed, week, claimed_at, expires_at, outcome) VALUES (?1, ?2, 0, ?3, ?4, ?4, 'submitted')").bind(task, contributor, week, NOW)]); };

beforeEach(async () => {
  task = 0;
  await wipe();
  await applyD1Migrations(db(), upTo(/^(000[1-9]|001[0-2])/));
  await run("INSERT INTO accounts (id, created, suspended, network) VALUES ('acct', ?1, 0, 'n')", NOW);
  // Five contributors owned by ONE account, plus six unowned ones.
  for (let i = 1; i <= 5; i++) await run("INSERT INTO contributors (id, handle, key_hash, created, owner_account) VALUES (?1, ?2, ?2, ?3, 'acct')", i, `owned-${i}`, NOW);
  for (let i = 6; i <= 11; i++) await run('INSERT INTO contributors (id, handle, key_hash, created) VALUES (?1, ?2, ?2, ?3)', i, `solo-${i}`, NOW);
});

describe('migration 0013: legacy people counts', () => {
  it('recomputes a pre-0012 count by owning account where the claims survive, suppresses one that cannot be rebuilt, and leaves newer rollups alone', async () => {
    for (let c = 1; c <= 5; c++) await claimBy(c, '2026-10-05'); // five contributors, one account -> one person
    for (let c = 6; c <= 11; c++) await claimBy(c, '2026-10-12'); // six unowned contributors -> six people (kept)
    await stat('2026-10-05', 5); await stat('2026-10-12', 6); await stat('2026-09-28', 8); await stat('2026-10-19', 7);
    await rolled('2026-10-05', 1); await rolled('2026-10-12', 1); await rolled('2026-09-28', 1); // old rollups
    await rolled('2026-10-19', FAR); // written by the current code, after 0012
    await applyD1Migrations(db(), upTo(/^0013/));
    const n = Object.fromEntries((await all('SELECT week, contributors FROM weekly_project_stats')).map((r) => [r.week, r.contributors]));
    expect(n['2026-10-05']).toBe(1); // was 5; one owning account
    expect(coarseCount(n['2026-10-05'])).toBe('fewer than 5');
    expect(n['2026-10-12']).toBe(6); // unchanged: six real people
    expect(n['2026-09-28']).toBe(0); // old count, claims gone: suppressed
    expect(n['2026-10-19']).toBe(7); // current-code rollup: untouched even without claims
    expect((await all('PRAGMA foreign_key_check'))).toEqual([]);
  });

  it('never raises a count, and ignores removed contributors and the stand-in', async () => {
    await run("UPDATE contributors SET removed = 1 WHERE id = 6"); await run("UPDATE contributors SET handle = 'former contributor' WHERE id = 7");
    for (let c = 6; c <= 8; c++) await claimBy(c, '2026-10-12');
    await stat('2026-10-12', 2); await rolled('2026-10-12', 1);
    await applyD1Migrations(db(), upTo(/^0013/));
    expect((await all('SELECT contributors FROM weekly_project_stats'))[0].contributors).toBe(1);
  });
});
