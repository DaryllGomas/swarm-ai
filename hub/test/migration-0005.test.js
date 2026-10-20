import { beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';

const db = env.MIG_DB;
beforeEach(async () => {
  const { results } = await db.prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND type IN ('table','view')").all();
  await db.batch([db.prepare('PRAGMA defer_foreign_keys = on'), ...results.map((r) => db.prepare(`DROP ${r.type} IF EXISTS "${r.name}"`))]);
  await applyD1Migrations(db, env.TEST_MIGRATIONS.filter((m) => /^000[1-4]/.test(m.name)));
});

it('migration 0005 preserves populated lifecycle rows, receipts, held text and the append-only audit', async () => {
  await db.batch([
    db.prepare("INSERT INTO contributors (id,handle,key_hash,created) VALUES (1,'test','hash',1)"),
    db.prepare("INSERT INTO tasks (id,project,kind,title,brief,output_format,units,status,source_key,created) VALUES (1,'town-hall','research_fix','Title','Brief','Text',3,'accepted','townhall:housing:fix',1)"),
    db.prepare("INSERT INTO tasks (id,project,kind,title,brief,output_format,units,status,held_reason,created) VALUES (2,'town-hall','research_fix','Held','Withheld','Text',3,'held','screen',1)"),
    db.prepare("INSERT INTO claims (id,task,contributor,routed,week,claimed_at,expires_at,outcome) VALUES (1,1,1,1,'2026-10-19',1,2,'submitted')"),
    db.prepare("INSERT INTO submissions (id,task,contributor,claim,body,sources,status,created,reviewed_at) VALUES (1,1,1,1,'Real body','[]','accepted',1,2)"),
    db.prepare("INSERT INTO events (ts,type,submission) VALUES (2,'submission_accepted',1)"),
  ]);
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(await db.prepare('SELECT body,status,prescreen,published_url,published_at FROM submissions WHERE id = 1').first()).toEqual({ body: 'Real body', status: 'accepted', prescreen: null, published_url: null, published_at: null });
  expect((await db.prepare("SELECT paused,max_pending FROM projects WHERE id = 'town-hall'").first())).toEqual({ paused: 0, max_pending: 10 });
  expect((await db.prepare('SELECT held_reason FROM tasks WHERE id = 2').first()).held_reason).toBe('screen');
  expect((await db.prepare('SELECT outcome FROM claims WHERE id = 1').first()).outcome).toBe('submitted');
  await expect(db.prepare("UPDATE events SET type = 'changed'").run()).rejects.toThrow(/append-only/);
  await expect(db.prepare("UPDATE projects SET paused = 2").run()).rejects.toThrow(/CHECK/);
  await expect(db.prepare("UPDATE submissions SET prescreen = 'invalid'").run()).rejects.toThrow(/CHECK/);
});
