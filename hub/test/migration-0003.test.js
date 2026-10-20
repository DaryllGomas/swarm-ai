// Migration 0003 against a database that already has rows, including rows the new constraints forbid.
// A scratch database (MIG_DB) is built up to migration 0002 (the schema the live database has), filled with the kind of
// damage the pre-0003 code could produce, then migration 0003 is applied on top. The main test database is untouched.
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
     VALUES (?1, 'town-hall', 'research_fix', ?2, 'brief', 'fmt', ?3, ?4, ?5, ?6, ?7)`
  ).bind(id, `Task ${id}`, extra.units ?? 3, status, extra.held_reason ?? null, `k:${id}`, NOW + id);
const C = (id, task, contributor, outcome = null, expires = NOW + 3600000) =>
  db().prepare(
    `INSERT INTO claims (id, task, contributor, routed, week, claimed_at, expires_at, released, outcome, network)
     VALUES (?1, ?2, ?3, 1, '2026-10-19', ?4, ?5, ?6, ?7, 'net')`
  ).bind(id, task, contributor, NOW - 1000 * id, expires, outcome === 'released' ? 1 : 0, outcome);
const S = (id, task, contributor, claim, status) =>
  db().prepare(
    `INSERT INTO submissions (id, task, contributor, claim, body, sources, status, created, reviewed_by, reviewed_at)
     VALUES (?1, ?2, ?3, ?4, 'body', '[]', ?5, ?6, ?7, ?8)`
  ).bind(id, task, contributor, claim, status, NOW - 5000 + id, status === 'pending' ? null : 'Daryll', status === 'pending' ? null : NOW);

let migrations;
beforeEach(async () => {
  migrations = env.TEST_MIGRATIONS;
  await wipe();
  await applyD1Migrations(db(), migrations.filter((m) => !m.name.startsWith('0003')));
});

// The damage: every row below is something the older code could write.
async function seedDamage() {
  const ins = [];
  for (let i = 1; i <= 5; i++) ins.push(db().prepare('INSERT INTO contributors (id, handle, key_hash, created) VALUES (?1, ?2, ?2, ?3)').bind(i, `user-${i}`, NOW));
  await db().batch(ins);
  await db().batch([
    T(1, 'submitted'),                       // two pending submissions by two contributors (finding 1)
    T(2, 'accepted'), T(3, 'accepted'),      // two accepted (the "6 units for a 3-unit task" case), and one more pending on 3
    T(4, 'claimed'),                         // two outstanding claims
    T(5, 'ready'),                           // a stale release reopened it, and a claim is outstanding on it
    T(6, 'claimed'),                         // claimed, nobody holds it, nothing handed in
    T(7, 'claimed'),                         // a pending submission, but the task never moved to submitted (finding 2)
    T(8, 'ready'),                           // fine, untouched
    T(9, 'closed'),                          // closed with two outstanding claims: claims repaired, status kept
    T(10, 'submitted'),                      // a rejected submission and a legitimate pending one (a re-claim after a rejection): untouched
    T(11, 'ready'),                          // outstanding claim AND a pending submission by someone else
    T(12, 'closed', { held_reason: 'ignore_instructions' }),
  ]);
  await db().batch([
    C(1, 1, 1, 'submitted'), C(2, 1, 2, 'submitted'),
    C(3, 2, 1, 'submitted'), C(4, 2, 2, 'submitted'), C(5, 3, 3, 'submitted'),
    C(6, 4, 1), C(7, 4, 2),
    C(8, 5, 3),
    C(9, 7, 4, 'submitted'),
    C(10, 9, 1), C(11, 9, 2),
    C(12, 10, 1, 'submitted'), C(13, 10, 2, 'submitted'),
    C(14, 11, 1, 'submitted'), C(15, 11, 3),
  ]);
  await db().batch([
    S(1, 1, 1, 1, 'pending'), S(2, 1, 2, 2, 'pending'),
    S(3, 2, 1, 3, 'accepted'), S(4, 2, 2, 4, 'accepted'),
    S(5, 3, 3, 5, 'accepted'), S(6, 3, 1, 3, 'pending'),
    S(7, 7, 4, 9, 'pending'),
    S(8, 10, 1, 12, 'rejected'), S(9, 10, 2, 13, 'pending'),
    S(10, 11, 1, 14, 'pending'),
  ]);
}

describe('migration 0003 on a database that already has rows', () => {
  it('without the repair, the unique indexes would not even build (the rows really are violating)', async () => {
    await seedDamage();
    await expect(db().prepare('CREATE UNIQUE INDEX x ON claims (task) WHERE outcome IS NULL').run()).rejects.toThrow(/UNIQUE/i);
    await expect(db().prepare("CREATE UNIQUE INDEX y ON submissions (task) WHERE status IN ('pending','accepted')").run()).rejects.toThrow(/UNIQUE/i);
  });

  it('repairs the violations, deletes nothing, writes an event for each change, and then enforces both rules', async () => {
    await seedDamage();
    const before = {
      claims: (await one('SELECT COUNT(*) AS n FROM claims')).n,
      subs: (await one('SELECT COUNT(*) AS n FROM submissions')).n,
      tasks: (await one('SELECT COUNT(*) AS n FROM tasks')).n,
    };
    await db().batch([db().prepare("INSERT INTO events (ts, type, task, actor) VALUES (1, 'old_event', 1, 'x')")]);

    await applyD1Migrations(db(), migrations); // 0003 on top

    // Nothing deleted.
    expect((await one('SELECT COUNT(*) AS n FROM claims')).n).toBe(before.claims);
    expect((await one('SELECT COUNT(*) AS n FROM submissions')).n).toBe(before.subs);
    expect((await one('SELECT COUNT(*) AS n FROM tasks')).n).toBe(before.tasks);
    expect((await one("SELECT COUNT(*) AS n FROM events WHERE type = 'old_event'")).n).toBe(1);

    // Submissions: one live (pending or accepted) per task. Earliest accepted wins, else earliest pending.
    const subs = Object.fromEntries((await all('SELECT id, status, reviewed_by, review_note FROM submissions')).map((r) => [r.id, r]));
    expect(subs[1].status).toBe('pending');     // task 1: earliest pending kept
    expect(subs[2].status).toBe('rejected');
    expect(subs[2].reviewed_by).toBe('system');
    expect(subs[2].review_note).toMatch(/Superseded/);
    expect(subs[3].status).toBe('accepted');    // task 2: earliest accepted kept
    expect(subs[4].status).toBe('rejected');
    expect(subs[5].status).toBe('accepted');    // task 3: the accepted one beats the pending one
    expect(subs[6].status).toBe('rejected');
    expect(subs[7].status).toBe('pending');
    expect(subs[8].status).toBe('rejected');    // a real rejection is left as it was...
    expect(subs[8].reviewed_by).toBe('Daryll');
    expect(subs[9].status).toBe('pending');     // ...and so is the legitimate pending one
    expect(subs[10].status).toBe('pending');
    expect((await all("SELECT task, COUNT(*) AS n FROM submissions WHERE status IN ('pending','accepted') GROUP BY task HAVING n > 1")).length).toBe(0);
    // Accepted units are counted once per task now: tasks 2 and 3 are one result each.
    expect((await one("SELECT COUNT(*) AS n FROM submissions WHERE status = 'accepted'")).n).toBe(2);

    // Claims: one outstanding per task. Where a task already has work handed in, no claim stays outstanding.
    const claims = Object.fromEntries((await all('SELECT id, outcome, released FROM claims')).map((r) => [r.id, r]));
    expect(claims[6].outcome).toBe('released');     // task 4: older of two
    expect(claims[7].outcome).toBeNull();           // task 4: newest kept
    expect(claims[8].outcome).toBeNull();           // task 5: single outstanding claim kept
    expect(claims[10].outcome).toBe('released');    // task 9 (closed): older of two
    expect(claims[11].outcome).toBeNull();
    expect(claims[15].outcome).toBe('released');    // task 11: the work was already handed in
    expect(claims[15].released).toBe(1);
    expect(claims[1].outcome).toBe('submitted');    // submitted claims are history and stay as they are
    expect((await all('SELECT task, COUNT(*) AS n FROM claims WHERE outcome IS NULL GROUP BY task HAVING n > 1')).length).toBe(0);

    // Task status follows the evidence; closed/held tasks are never touched.
    const tasks = Object.fromEntries((await all('SELECT id, status, held_reason FROM tasks')).map((r) => [r.id, r]));
    expect(tasks[1].status).toBe('submitted');
    expect(tasks[2].status).toBe('accepted');
    expect(tasks[3].status).toBe('accepted');
    expect(tasks[4].status).toBe('claimed');
    expect(tasks[5].status).toBe('claimed');   // was ready with an outstanding claim
    expect(tasks[6].status).toBe('ready');     // was claimed with no holder and no work
    expect(tasks[7].status).toBe('submitted'); // pending submission, task never moved
    expect(tasks[8].status).toBe('ready');
    expect(tasks[9].status).toBe('closed');
    expect(tasks[10].status).toBe('submitted');
    expect(tasks[11].status).toBe('submitted');
    expect(tasks[12].status).toBe('closed');
    expect(tasks[12].held_reason).toBe('ignore_instructions');

    // An event for every repaired row, and the old event is still there.
    const ev = async (type) => (await one('SELECT COUNT(*) AS n FROM events WHERE type = ?1', type)).n;
    expect(await ev('submission_superseded')).toBe(3); // submissions 2, 4 and 6
    expect(await ev('claim_repaired')).toBe(3);        // claims 15, 6 and 10
    expect(await ev('task_repaired')).toBe(4);         // tasks 5, 6, 7 and 11
    expect(await ev('old_event')).toBe(1);
    const repaired = await all("SELECT task, detail FROM events WHERE type = 'task_repaired' ORDER BY task");
    expect(repaired.map((e) => e.task)).toEqual([5, 6, 7, 11]);
    expect(JSON.parse(repaired[0].detail)).toMatchObject({ from: 'ready', to: 'claimed' });

    // Both rules are enforced now.
    await expect(db().prepare("INSERT INTO claims (task, contributor, routed, week, claimed_at, expires_at) VALUES (4, 5, 0, 'w', 1, 2)").run()).rejects.toThrow(/UNIQUE/i);
    await expect(db().prepare("INSERT INTO submissions (task, contributor, claim, body, sources, status, created) VALUES (2, 5, 1, 'b', '[]', 'pending', 1)").run()).rejects.toThrow(/UNIQUE/i);
  });

  it('enforces both rules afterwards, and an empty database upgrades cleanly', async () => {
    await applyD1Migrations(db(), migrations);
    const names = (await all("SELECT name FROM sqlite_master WHERE type = 'index'")).map((r) => r.name);
    expect(names).toContain('claims_one_outstanding');
    expect(names).toContain('submissions_one_live');
    const cols = (await all("SELECT name FROM pragma_table_info('claims')")).map((r) => r.name);
    expect(cols).toContain('op');
    expect((await all("SELECT name FROM pragma_table_info('submissions')")).map((r) => r.name)).toContain('op');
  });
});
