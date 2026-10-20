-- Swarm AI hub, migration 0002 (Phase 0 hardening).
--   tasks.status gains 'held' (task text that failed the injection screen; never served) and tasks.held_reason;
--   claims.network stores the daily network hash so one network cannot squat every task;
--   submissions.flags stores the link pre-screen flags (JSON array) for the reviewer.
-- SQLite cannot change a CHECK constraint, so tasks is rebuilt. Foreign keys are checked at commit.

PRAGMA defer_foreign_keys = on;

-- Park the rows, drop and recreate tasks, put the rows back. With foreign keys deferred, re-inserting the parent rows
-- clears the violations the DROP raised, so the commit succeeds. (Renaming a new table over the old one does not.)
CREATE TABLE tasks_bak AS SELECT * FROM tasks;
DROP TABLE tasks;
CREATE TABLE tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project       TEXT NOT NULL REFERENCES projects (id),
  parent        INTEGER REFERENCES tasks (id),     -- children share the parent's unit budget
  kind          TEXT NOT NULL,                     -- research_fix | recheck_sources | answer_objection
  title         TEXT NOT NULL,
  brief         TEXT NOT NULL,
  output_format TEXT NOT NULL,
  units         INTEGER NOT NULL CHECK (units IN (1, 3, 8)),
  status        TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','claimed','submitted','accepted','rejected','closed','held')),
  source_key    TEXT UNIQUE,                       -- idempotent sync key
  created       INTEGER NOT NULL,
  held_reason   TEXT                               -- why the screen held it; NULL unless status = 'held'
);
INSERT INTO tasks (id, project, parent, kind, title, brief, output_format, units, status, source_key, created)
  SELECT id, project, parent, kind, title, brief, output_format, units, status, source_key, created FROM tasks_bak ORDER BY id;
DROP TABLE tasks_bak;
CREATE INDEX tasks_project_status ON tasks (project, status, created);
CREATE INDEX tasks_parent ON tasks (parent);

ALTER TABLE claims ADD COLUMN network TEXT;          -- daily-rotating network hash at claim time, only to cap squatting
CREATE INDEX claims_network ON claims (network, outcome, expires_at);

ALTER TABLE submissions ADD COLUMN flags TEXT NOT NULL DEFAULT '[]';   -- link pre-screen flags; never blocks a submission
