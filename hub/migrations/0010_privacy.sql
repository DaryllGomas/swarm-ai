-- Privacy and trust. Learn about the work, never about the people.
--   1. Daily network keys (forward-secure network hashing); network hashes become nullable so the hourly job can erase them.
--   2. The three privacy choices on accounts, and the credit choice mirrored on contributors.
--   3. What the right to leave needs: ballots and events may be anonymised or scrubbed (and nothing else), and an account
--      deletion may release the contributor it owned.
--   4. The weekly rollup tables: per-project aggregates that stay forever.
-- Existing rows keep working: contributors are credited anonymously until their owner chooses otherwise, accounts get the
-- private defaults, and rows written with the old network hash are still counted by the caps until the job erases them.

PRAGMA defer_foreign_keys = on;

-- ------------------------------------------------------------------ 1. daily network keys
CREATE TABLE network_keys (
  day TEXT PRIMARY KEY CHECK (length(day) = 10),   -- UTC day, YYYY-MM-DD
  key TEXT NOT NULL                                -- 32 random bytes, hex. HMAC-SHA256(key, network) is that day's network hash.
);

-- accounts: network is now nullable (erased after two days); the three choices are new columns.
CREATE TABLE accounts_bak AS SELECT * FROM accounts;
DROP TABLE accounts;
CREATE TABLE accounts (
  id          TEXT PRIMARY KEY,
  created     INTEGER NOT NULL,
  suspended   INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0,1)),
  network     TEXT,                                -- network hash of the day it was made; NULL once that day's key is two days old
  fallback    INTEGER NOT NULL DEFAULT 1 CHECK (fallback IN (0,1)),
  credit      TEXT NOT NULL DEFAULT 'anonymous' CHECK (credit IN ('anonymous','handle')),
  history     TEXT NOT NULL DEFAULT 'private' CHECK (history IN ('private','weekly_purge')),
  research    TEXT NOT NULL DEFAULT 'aggregate' CHECK (research IN ('aggregate','share_pseudonymous')),
  research_id TEXT                                 -- random id for the open research dataset; only while research = share_pseudonymous
);
INSERT INTO accounts (id, created, suspended, network, fallback) SELECT id, created, suspended, network, fallback FROM accounts_bak ORDER BY rowid;
DROP TABLE accounts_bak;
CREATE INDEX accounts_network_created ON accounts (network, created);
CREATE UNIQUE INDEX accounts_research_id ON accounts (research_id) WHERE research_id IS NOT NULL;

-- ------------------------------------------------------------------ 2. contributors
ALTER TABLE contributors ADD COLUMN credit TEXT NOT NULL DEFAULT 'anonymous' CHECK (credit IN ('anonymous','handle'));
ALTER TABLE contributors ADD COLUMN removed INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0,1));  -- 1: shown as "removed contributor"

-- Ownership still never changes, except that deleting the owning account releases the contributor (removed = 1 in the same update).
DROP TRIGGER contributors_owner_fixed;
CREATE TRIGGER contributors_owner_fixed BEFORE UPDATE OF owner_account ON contributors
WHEN OLD.owner_account IS NOT NULL AND NEW.owner_account IS NOT OLD.owner_account AND NOT (NEW.owner_account IS NULL AND NEW.removed = 1)
BEGIN
  SELECT RAISE(ABORT, 'contributors.owner_account cannot be changed once set');
END;

-- ------------------------------------------------------------------ 3. the right to leave
-- Ballots stay append-only, with one exception: when an account is deleted its ballot versions are re-labelled with a random
-- 'gone:' id so nothing links them to anyone. Nothing else about a ballot may change. (The old foreign key to accounts goes, since
-- the account no longer exists.) Past snapshots (vote_snapshots, allocation) are untouched.
CREATE TABLE ballot_versions_bak AS SELECT * FROM ballot_versions;
DROP TABLE ballot_versions;
CREATE TABLE ballot_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL,                           -- a voter account id, or 'gone:<random>' once that account was deleted
  version INTEGER NOT NULL,
  allocations TEXT NOT NULL CHECK (json_valid(allocations)),
  created INTEGER NOT NULL,
  UNIQUE(account, version)
);
INSERT INTO ballot_versions (id, account, version, allocations, created) SELECT id, account, version, allocations, created FROM ballot_versions_bak ORDER BY id;
DROP TABLE ballot_versions_bak;
CREATE INDEX ballot_versions_cutoff ON ballot_versions (account, created, id);
CREATE TRIGGER ballot_versions_no_delete BEFORE DELETE ON ballot_versions BEGIN SELECT RAISE(ABORT, 'ballots are append-only'); END;
CREATE TRIGGER ballot_versions_no_update BEFORE UPDATE ON ballot_versions
WHEN NOT (NEW.id = OLD.id AND NEW.version = OLD.version AND NEW.allocations = OLD.allocations AND NEW.created = OLD.created
          AND NEW.account LIKE 'gone:%' AND OLD.account NOT LIKE 'gone:%')
BEGIN SELECT RAISE(ABORT, 'ballots are append-only'); END;

-- Events stay append-only. They may only be scrubbed: contributor, actor and detail can be set to NULL, nothing else changes.
DROP TRIGGER events_no_update;
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
WHEN NOT (NEW.id = OLD.id AND NEW.ts = OLD.ts AND NEW.type = OLD.type AND NEW.task IS OLD.task AND NEW.submission IS OLD.submission
          AND (NEW.contributor IS OLD.contributor OR NEW.contributor IS NULL)
          AND (NEW.actor IS OLD.actor OR NEW.actor IS NULL)
          AND (NEW.detail IS OLD.detail OR NEW.detail IS NULL))
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

-- ------------------------------------------------------------------ 4. the weekly rollup (kept forever)
CREATE TABLE rollup_weeks (
  week   TEXT PRIMARY KEY,                         -- ISO Monday (UTC) of a closed week that has been rolled up
  ran_at INTEGER NOT NULL
);
CREATE TABLE weekly_project_stats (
  week                  TEXT NOT NULL,
  project               TEXT NOT NULL REFERENCES projects (id),
  routed_units          INTEGER NOT NULL,          -- units of standing claims made this week, by routing origin (never added together)
  ballot_directed_units INTEGER NOT NULL,
  self_picked_units     INTEGER NOT NULL,
  accepted_routed_units          INTEGER NOT NULL, -- units a reviewer accepted this week, by the origin of the claim behind them
  accepted_ballot_directed_units INTEGER NOT NULL,
  accepted_self_picked_units     INTEGER NOT NULL,
  tasks_created         INTEGER NOT NULL,
  tasks_claimed         INTEGER NOT NULL,
  tasks_submitted       INTEGER NOT NULL,
  tasks_accepted        INTEGER NOT NULL,
  tasks_rejected        INTEGER NOT NULL,
  contributors          INTEGER NOT NULL,          -- distinct contributors with a standing claim this week: a count of people, so it is shown with the k-anonymity rule
  reviews               INTEGER NOT NULL,
  review_p50_ms         INTEGER,                   -- time from submission to review, for reviews made this week
  review_p90_ms         INTEGER,
  PRIMARY KEY (week, project)
);
CREATE TABLE weekly_model_stats (
  week        TEXT NOT NULL,
  project     TEXT NOT NULL REFERENCES projects (id),
  family      TEXT NOT NULL,                       -- claude | gpt | gemini | llama | mistral | qwen | deepseek | grok | other | unreported
  submissions INTEGER NOT NULL,                    -- submissions handed in this week that reported this family (self-reported)
  PRIMARY KEY (week, project, family)
);
