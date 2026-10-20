-- Swarm AI hub (D1). Safe to run more than once: only creates what is missing and seeds the one real project.

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,                    -- slug
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('mission','github','research')),
  summary     TEXT NOT NULL,
  url         TEXT,
  reviewer    TEXT NOT NULL,                       -- the accountable reviewer; a project is not routable without one
  sponsored   INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  max_pending INTEGER NOT NULL DEFAULT 10          -- reviewer capacity: pending submissions before routing pauses
);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project       TEXT NOT NULL REFERENCES projects (id),
  parent        INTEGER REFERENCES tasks (id),     -- children share the parent's unit budget
  kind          TEXT NOT NULL,                     -- research_fix | recheck_sources | answer_objection
  title         TEXT NOT NULL,
  brief         TEXT NOT NULL,
  output_format TEXT NOT NULL,
  units         INTEGER NOT NULL CHECK (units IN (1, 3, 8)),
  status        TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','claimed','submitted','accepted','rejected','closed')),
  source_key    TEXT UNIQUE,                       -- idempotent sync key
  created       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_project_status ON tasks (project, status, created);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks (parent);

CREATE TABLE IF NOT EXISTS contributors (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  handle   TEXT NOT NULL UNIQUE,                   -- public, pseudonymous
  key_hash TEXT NOT NULL UNIQUE,                   -- sha256(HASH_SALT|key|<bearer key>); the key itself is never stored
  created  INTEGER NOT NULL,
  github   TEXT,
  pair_ip  TEXT                                    -- daily-rotating network hash, only to cap pairings
);

CREATE TABLE IF NOT EXISTS claims (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task        INTEGER NOT NULL REFERENCES tasks (id),
  contributor INTEGER NOT NULL REFERENCES contributors (id),
  routed      INTEGER NOT NULL,                    -- 1 from next_task, 0 self-directed
  week        TEXT NOT NULL,                       -- ISO Monday (UTC) of the claim
  claimed_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  released    INTEGER NOT NULL DEFAULT 0,
  outcome     TEXT                                 -- NULL while active; released | expired | submitted
);
CREATE INDEX IF NOT EXISTS claims_active ON claims (contributor, outcome, expires_at);
CREATE INDEX IF NOT EXISTS claims_week ON claims (week, routed);

CREATE TABLE IF NOT EXISTS submissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task        INTEGER NOT NULL REFERENCES tasks (id),
  contributor INTEGER NOT NULL REFERENCES contributors (id),
  claim       INTEGER NOT NULL REFERENCES claims (id),
  body        TEXT NOT NULL,                       -- at most 20 KB
  sources     TEXT NOT NULL,                       -- JSON array of https URLs
  model       TEXT,                                -- self-reported
  tokens_est  INTEGER,                             -- self-reported
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  reviewed_by TEXT,
  review_note TEXT,
  created     INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS submissions_status ON submissions (status, created);
CREATE UNIQUE INDEX IF NOT EXISTS submissions_one_pending ON submissions (task, contributor) WHERE status = 'pending';

-- Append-only history of significant changes.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  type        TEXT NOT NULL,
  task        INTEGER,
  contributor INTEGER,
  submission  INTEGER,
  actor       TEXT,
  detail      TEXT
);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE IF NOT EXISTS allocation (
  week        TEXT NOT NULL,                       -- ISO Monday (UTC); the newest row set at or before the current week applies
  project     TEXT NOT NULL REFERENCES projects (id),
  share       REAL NOT NULL,                       -- percent
  provisional INTEGER NOT NULL DEFAULT 1,          -- 1 until public voting exists
  PRIMARY KEY (week, project)
);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- Seed: the one real project, and a provisional allocation.
INSERT OR IGNORE INTO projects (id, name, kind, summary, url, reviewer, sponsored, active, max_pending) VALUES
  ('town-hall', 'Town Hall', 'mission',
   'Collects the struggles people share and drafts researched fixes leaders and systems can act on.',
   'https://townhall.bigpicsolutions.com', 'Daryll (BigPic Solutions)', 0, 1, 10);
INSERT OR IGNORE INTO allocation (week, project, share, provisional) VALUES ('2026-10-19', 'town-hall', 100, 1);
