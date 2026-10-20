-- Phase 3: voter identities stay separate from contributor handles.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  created INTEGER NOT NULL,
  suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0,1)),
  network TEXT NOT NULL
);
CREATE INDEX accounts_network_created ON accounts(network, created);
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL REFERENCES accounts(id),
  public_key TEXT NOT NULL,
  sign_count INTEGER NOT NULL CHECK (sign_count >= 0),
  transports TEXT NOT NULL
);
CREATE TABLE account_challenges (
  challenge TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('register','login')),
  account TEXT,
  browser_hash TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX account_challenges_expiry ON account_challenges(expires);
CREATE TABLE sessions (
  hash TEXT PRIMARY KEY,
  account TEXT NOT NULL REFERENCES accounts(id),
  expires INTEGER NOT NULL
);
CREATE INDEX sessions_account ON sessions(account);
CREATE TABLE ballot_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL REFERENCES accounts(id),
  version INTEGER NOT NULL,
  allocations TEXT NOT NULL CHECK (json_valid(allocations)),
  created INTEGER NOT NULL,
  UNIQUE(account, version)
);
CREATE INDEX ballot_versions_cutoff ON ballot_versions(account, created, id);
CREATE TRIGGER ballot_versions_no_update BEFORE UPDATE ON ballot_versions BEGIN SELECT RAISE(ABORT, 'ballots are append-only'); END;
CREATE TRIGGER ballot_versions_no_delete BEFORE DELETE ON ballot_versions BEGIN SELECT RAISE(ABORT, 'ballots are append-only'); END;
CREATE TABLE vote_snapshots (
  week TEXT PRIMARY KEY,
  voter_count INTEGER NOT NULL CHECK (voter_count >= 0),
  published_at INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('ballots','fallback')),
  op TEXT NOT NULL
);
-- Preserve historic allocations while changing their unit from percent to integer basis points.
ALTER TABLE allocation RENAME TO allocation_percent;
CREATE TABLE allocation (
  week TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  share INTEGER NOT NULL CHECK (typeof(share) = 'integer' AND share BETWEEN 0 AND 10000),
  provisional INTEGER NOT NULL DEFAULT 1 CHECK (provisional IN (0,1)),
  PRIMARY KEY(week, project)
);
INSERT INTO allocation SELECT week, project, CAST(round(share * 100) AS INTEGER), provisional FROM allocation_percent;
DROP TABLE allocation_percent;
