// Migration 0006 against a database that already has rows: nothing existing is lost, the seed and the 50/50 split appear.
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

beforeEach(async () => {
  await wipe();
  await applyD1Migrations(db(), upTo(/^000[1-4]/));
});

async function populate() {
  await db().batch([
    db().prepare("INSERT INTO contributors (id, handle, key_hash, created) VALUES (1, 'old-user', 'h', ?1)").bind(NOW),
    db().prepare("INSERT INTO tasks (id, project, kind, title, brief, output_format, units, status, source_key, created) VALUES (1, 'town-hall', 'research_fix', 'T', 'b', 'f', 3, 'submitted', 'townhall:a:fix', ?1)").bind(NOW),
    db().prepare("INSERT INTO claims (id, task, contributor, routed, week, claimed_at, expires_at, outcome) VALUES (1, 1, 1, 1, '2026-10-19', ?1, ?2, 'submitted')").bind(NOW, NOW + 1000),
    db().prepare("INSERT INTO submissions (id, task, contributor, claim, body, sources, status, created) VALUES (1, 1, 1, 1, 'body', '[]', 'pending', ?1)").bind(NOW),
  ]);
}

describe('migration 0006', () => {
  it('keeps every existing row, adds the new columns as NULL, and seeds Swarm AI with a provisional 50/50', async () => {
    await populate();
    await applyD1Migrations(db(), upTo(/^0006/));
    expect(await one('SELECT status, pr_number, pr_author, pr_state, pr_repo_id FROM submissions WHERE id = 1')).toEqual({ status: 'pending', pr_number: null, pr_author: null, pr_state: null, pr_repo_id: null });
    expect((await one('SELECT COUNT(*) AS n FROM tasks')).n).toBe(1);
    expect(await one("SELECT repo, repo_id FROM projects WHERE id = 'town-hall'")).toEqual({ repo: null, repo_id: null });
    expect(await one("SELECT name, kind, repo, repo_id, active, reviewer, summary FROM projects WHERE id = 'swarm-ai'")).toEqual({
      name: 'Swarm AI', kind: 'github', repo: 'DaryllGomas/swarm-ai', repo_id: null, active: 1, reviewer: 'Daryll (BigPic Solutions)',
      summary: 'Swarm builds Swarm: open-source work on this hub, reviewed by its maintainer.',
    });
    expect(await all("SELECT project, share, provisional FROM allocation WHERE week = '2026-10-19' ORDER BY project")).toEqual([
      { project: 'swarm-ai', share: 50, provisional: 1 }, { project: 'town-hall', share: 50, provisional: 1 },
    ]);
  });

  it('leaves a non-provisional or already-changed allocation alone', async () => {
    await db().prepare("UPDATE allocation SET share = 70, provisional = 0 WHERE project = 'town-hall'").run();
    await applyD1Migrations(db(), upTo(/^0006/));
    expect(await all("SELECT project, share FROM allocation WHERE week = '2026-10-19'")).toEqual([{ project: 'town-hall', share: 70 }]);
  });

  it('one pull request can back one live submission, and a rejected one can be used again', async () => {
    await db().prepare("INSERT INTO contributors (id, handle, key_hash, created) VALUES (1, 'u', 'h', ?1)").bind(NOW).run();
    await db().batch([2, 3, 4].flatMap((id) => [
      db().prepare("INSERT INTO tasks (id, project, kind, title, brief, output_format, units, status, source_key, created) VALUES (?1, 'town-hall', 'k', 'T', 'b', 'f', 3, 'submitted', ?2, ?3)").bind(id, `k${id}`, NOW),
      db().prepare("INSERT INTO claims (id, task, contributor, routed, week, claimed_at, expires_at, outcome) VALUES (?1, ?1, 1, 1, '2026-10-19', ?2, ?2, 'submitted')").bind(id, NOW),
    ]));
    await applyD1Migrations(db(), upTo(/^0006/));
    const ins = (id, task, status) => db().prepare(
      "INSERT INTO submissions (id, task, contributor, claim, body, sources, status, created, pr_number, pr_repo_id) VALUES (?1, ?2, 1, ?2, 'b', '[]', ?3, ?4, 5, 77)"
    ).bind(id, task, status, NOW);
    await ins(10, 2, 'pending').run();
    await expect(ins(11, 3, 'pending').run()).rejects.toThrow(/UNIQUE/);
    await db().prepare("UPDATE submissions SET status = 'rejected' WHERE id = 10").run();
    await ins(12, 3, 'pending').run();
  });

  it('a repository can be registered once, whatever its case', async () => {
    await applyD1Migrations(db(), upTo(/^0006/));
    await expect(db().prepare("INSERT INTO projects (id, name, kind, summary, reviewer, repo, repo_id) VALUES ('x', 'X', 'github', 's', 'r', 'daryllgomas/SWARM-AI', 5)").run()).rejects.toThrow(/UNIQUE/);
  });
});
