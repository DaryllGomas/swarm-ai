// Migration 0004 against a database that already has rows, including the legacy states migration 0003 left in place
// (review 3, issue A). A scratch database (MIG_DB) is built up to migration 0002 (the schema the live database has),
// filled with what the older, non-atomic code could write, then 0003 and 0004 are applied. The main test database is untouched.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';

const db = () => env.MIG_DB;
const all = (sql, ...b) => db().prepare(sql).bind(...b).all().then((r) => r.results);
const one = (sql, ...b) => db().prepare(sql).bind(...b).first();

async function wipe() {
  const { results } = await db().prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND type IN ('table','view')").all();
  await db().batch([db().prepare('PRAGMA defer_foreign_keys = on'), ...results.map((r) => db().prepare(`DROP ${r.type} IF EXISTS "${r.name}"`))]);
}

const NOW = Date.now();
const T = (id, status, extra = {}) =>
  db().prepare(
    `INSERT INTO tasks (id, project, kind, title, brief, output_format, units, status, held_reason, source_key, created)
     VALUES (?1, 'town-hall', 'research_fix', ?2, 'brief', 'fmt', 3, ?3, ?4, ?5, ?6)`
  ).bind(id, `Task ${id}`, status, extra.held_reason ?? null, `k:${id}`, NOW + id);
const C = (id, task, contributor, outcome = null) =>
  db().prepare(
    `INSERT INTO claims (id, task, contributor, routed, week, claimed_at, expires_at, released, outcome, network)
     VALUES (?1, ?2, ?3, 1, '2026-10-19', ?4, ?5, ?6, ?7, 'net')`
  ).bind(id, task, contributor, NOW - 1000 * id, NOW + 3600000, outcome === 'released' ? 1 : 0, outcome);
const S = (id, task, contributor, claim, status, reviewedBy = 'Daryll') =>
  db().prepare(
    `INSERT INTO submissions (id, task, contributor, claim, body, sources, status, created, reviewed_by, reviewed_at)
     VALUES (?1, ?2, ?3, ?4, 'body', '[]', ?5, ?6, ?7, ?8)`
  ).bind(id, task, contributor, claim, status, NOW - 5000 + id, status === 'pending' ? null : reviewedBy, status === 'pending' ? null : NOW);

let migrations;
const before0004 = () => migrations.filter((m) => !m.name.startsWith('0004'));
beforeEach(async () => {
  migrations = env.TEST_MIGRATIONS;
  await wipe();
  await applyD1Migrations(db(), migrations.filter((m) => /^000[12]/.test(m.name)));
  await db().batch(Array.from({ length: 6 }, (_, i) => db().prepare('INSERT INTO contributors (id, handle, key_hash, created) VALUES (?1, ?2, ?2, ?3)').bind(i + 1, `user-${i + 1}`, NOW)));
});

// Legacy states migration 0003 keeps, plus controls the repair must leave alone.
async function seedLegacy() {
  await db().batch([
    T(1, 'submitted'),                              // old review rejected the one submission, then failed: stuck, 1 rejection -> ready
    T(2, 'submitted'),                              // two reviewer rejections -> rejected
    T(3, 'submitted'),                              // two 'system' rejections only (superseded duplicates) -> ready: they do not count
    T(4, 'submitted'),                              // a rejected and a pending submission: a re-claim after a rejection, untouched
    T(5, 'closed'),                                 // closed, outstanding claim: claim closed, task stays closed
    T(6, 'accepted'),                               // accepted with no submission row, outstanding claim: claim closed, stays accepted
    T(7, 'rejected'),                               // rejected, outstanding claim
    T(8, 'held'),                                   // held, outstanding claim
    T(9, 'closed', { held_reason: 'ignore_instructions' }), // closed while withheld, outstanding claim
    T(10, 'claimed'),                               // a healthy claim: untouched
    T(11, 'ready'),                                 // untouched
    T(12, 'submitted'),                             // stuck with 2 rejections AND an outstanding claim: rejected, claim closed
    T(13, 'submitted'),                             // stuck with 1 rejection AND an outstanding claim: back to claimed, claim kept
  ]);
  await db().batch([
    C(1, 1, 1, 'submitted'), C(2, 2, 1, 'submitted'), C(3, 2, 2, 'submitted'),
    C(4, 3, 1, 'submitted'), C(5, 3, 2, 'submitted'),
    C(6, 4, 1, 'submitted'), C(7, 4, 2, 'submitted'),
    C(8, 5, 3), C(9, 6, 3), C(10, 7, 3), C(11, 8, 3), C(12, 9, 3),
    C(13, 10, 4),
    C(14, 12, 1, 'submitted'), C(15, 12, 2, 'submitted'), C(16, 12, 5),
    C(17, 13, 1, 'submitted'), C(18, 13, 6),
  ]);
  await db().batch([
    S(1, 1, 1, 1, 'rejected'),
    S(2, 2, 1, 2, 'rejected'), S(3, 2, 2, 3, 'rejected'),
    S(4, 3, 1, 4, 'rejected', 'system'), S(5, 3, 2, 5, 'rejected', 'system'),
    S(6, 4, 1, 6, 'rejected'), S(7, 4, 2, 7, 'pending'),
    S(8, 12, 1, 14, 'rejected'), S(9, 12, 2, 15, 'rejected'),
    S(10, 13, 1, 17, 'rejected'),
  ]);
}

const tasks = async () => Object.fromEntries((await all('SELECT id, status, held_reason FROM tasks')).map((r) => [r.id, r]));
const claims = async () => Object.fromEntries((await all('SELECT id, outcome, released, op FROM claims')).map((r) => [r.id, r]));
const ev = async (type) => (await one('SELECT COUNT(*) AS n FROM events WHERE type = ?1', type)).n;

describe('migration 0004 repairs the legacy states that 0003 leaves', () => {
  it('the legacy states really do survive migration 0003', async () => {
    await seedLegacy();
    await applyD1Migrations(db(), before0004());
    const t = await tasks();
    expect(t[1].status).toBe('submitted');
    expect((await one("SELECT COUNT(*) AS n FROM submissions WHERE task = 1 AND status IN ('pending','accepted')")).n).toBe(0);
    expect((await claims())[8].outcome).toBeNull();     // closed task, claim still outstanding
    expect((await claims())[11].outcome).toBeNull();    // held task, claim still outstanding
    expect(await ev('task_repaired')).toBe(0);
  });

  it('moves stuck submitted tasks to ready or rejected by the review rule, closes dead claims, and writes events', async () => {
    await seedLegacy();
    await applyD1Migrations(db(), before0004());
    const counts = {
      claims: (await one('SELECT COUNT(*) AS n FROM claims')).n,
      subs: (await one('SELECT COUNT(*) AS n FROM submissions')).n,
      tasks: (await one('SELECT COUNT(*) AS n FROM tasks')).n,
    };
    const eventsBefore = await ev('task_repaired');

    await applyD1Migrations(db(), migrations); // 0004 on top

    // Nothing deleted.
    expect((await one('SELECT COUNT(*) AS n FROM claims')).n).toBe(counts.claims);
    expect((await one('SELECT COUNT(*) AS n FROM submissions')).n).toBe(counts.subs);
    expect((await one('SELECT COUNT(*) AS n FROM tasks')).n).toBe(counts.tasks);

    const t = await tasks();
    expect(t[1].status).toBe('ready');       // one reviewer rejection
    expect(t[2].status).toBe('rejected');    // two reviewer rejections
    expect(t[3].status).toBe('ready');       // 'system' rejections do not count
    expect(t[4].status).toBe('submitted');   // has a pending submission: legitimate, untouched
    expect(t[5].status).toBe('closed');      // closed stays closed ...
    expect(t[6].status).toBe('accepted');
    expect(t[7].status).toBe('rejected');
    expect(t[8].status).toBe('held');
    expect(t[9].status).toBe('closed');
    expect(t[9].held_reason).toBe('ignore_instructions');
    expect(t[10].status).toBe('claimed');
    expect(t[11].status).toBe('ready');
    expect(t[12].status).toBe('rejected');
    expect(t[13].status).toBe('claimed');    // not ready: someone still holds it

    // ... and its outstanding claim is closed. Healthy claims are not.
    const c = await claims();
    for (const id of [8, 9, 10, 11, 12, 16]) {
      expect(c[id].outcome, `claim ${id}`).toBe('released');
      expect(c[id].released).toBe(1);
      expect(c[id].op).toBe('migration-0004');
    }
    expect(c[13].outcome).toBeNull();        // task 10: healthy
    expect(c[18].outcome).toBeNull();        // task 13: now 'claimed', and its holder keeps it
    expect(c[1].outcome).toBe('submitted');  // history stays

    // The result is coherent: no outstanding claim on anything but a claimed task; no submitted task with nothing to review.
    expect((await all("SELECT c.id FROM claims c JOIN tasks t ON t.id = c.task WHERE c.outcome IS NULL AND t.status != 'claimed'")).length).toBe(0);
    expect((await all("SELECT id FROM tasks t WHERE status = 'submitted' AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.task = t.id AND s.status = 'pending')")).length).toBe(0);
    expect((await all("SELECT id FROM tasks t WHERE status = 'claimed' AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.task = t.id AND c.outcome IS NULL)")).length).toBe(0);

    // One event per repair.
    expect(await ev('task_repaired') - eventsBefore).toBe(5);  // tasks 1, 2, 3, 12, 13
    expect(await ev('claim_repaired')).toBe(6);                // claims 8, 9, 10, 11, 12, 16
    const repaired = await all("SELECT task, detail FROM events WHERE type = 'task_repaired' ORDER BY task");
    expect(repaired.map((e) => e.task)).toEqual([1, 2, 3, 12, 13]);
    expect(JSON.parse(repaired[0].detail)).toMatchObject({ from: 'submitted', to: 'ready' });
    expect(JSON.parse(repaired[1].detail)).toMatchObject({ from: 'submitted', to: 'rejected' });
    expect(JSON.parse(repaired[4].detail)).toMatchObject({ from: 'submitted', to: 'claimed' });
    const claimEvents = await all("SELECT task, detail FROM events WHERE type = 'claim_repaired' ORDER BY task");
    expect(claimEvents.map((e) => e.task)).toEqual([5, 6, 7, 8, 9, 12]);
    expect(JSON.parse(claimEvents[0].detail).reason).toMatch(/closed/);
  });

  it('is idempotent: running 0004 again changes nothing and writes no further events', async () => {
    await seedLegacy();
    await applyD1Migrations(db(), migrations);
    const snapshot = async () => JSON.stringify([await all('SELECT * FROM tasks ORDER BY id'), await all('SELECT * FROM claims ORDER BY id'), await all('SELECT * FROM submissions ORDER BY id'), await all('SELECT * FROM events ORDER BY id')]);
    const first = await snapshot();
    const m4 = migrations.find((m) => m.name.startsWith('0004'));
    await db().batch(m4.queries.map((q) => db().prepare(q)));
    expect(await snapshot()).toBe(first);
  });

  it('a database without the legacy states is not touched', async () => {
    await db().batch([T(1, 'ready'), T(2, 'claimed'), T(3, 'accepted'), C(1, 2, 1), C(2, 3, 1, 'submitted'), S(1, 3, 1, 2, 'accepted')]);
    await applyD1Migrations(db(), before0004());
    const events = (await one('SELECT COUNT(*) AS n FROM events')).n;
    await applyD1Migrations(db(), migrations);
    expect((await one('SELECT COUNT(*) AS n FROM events')).n).toBe(events);
    expect(Object.values(await tasks()).map((t) => t.status)).toEqual(['ready', 'claimed', 'accepted']);
    expect((await claims())[1].outcome).toBeNull();
  });
});
