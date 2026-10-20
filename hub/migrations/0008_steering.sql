-- Phase 4: "Your AI follows your vote". Routing origins, account links, link codes and the fallback setting.
--
--   * claims.routing_origin: public_routed | ballot_directed | self_picked. It is backfilled from the old routed flag
--     (1 -> public_routed, 0 -> self_picked). claims.routed stays and means exactly "public_routed", so every query that
--     compares routed work with the public allocation keeps working, and a ballot-directed claim has routed = 0.
--     The column is nullable only because SQLite cannot add NOT NULL without a default: a trigger fills it from routed
--     when an insert leaves it empty, and two more triggers refuse any row where routed and routing_origin disagree.
--   * accounts.fallback: 1 (default) lets next_task fall back to the public allocation when none of the voter's own
--     ballot projects has eligible work. 0 returns "no eligible work in your projects" instead.
--   * account_links: at most one contributor per voter account, and a contributor belongs to at most one account.
--   * link_codes: short-lived, single-use codes (stored hashed) that a signed-in voter gives to their AI.
--   * link_attempts: failed redemptions, the basis of the brute-force limit.

ALTER TABLE claims ADD COLUMN routing_origin TEXT CHECK (routing_origin IN ('public_routed','ballot_directed','self_picked'));
UPDATE claims SET routing_origin = CASE WHEN routed = 1 THEN 'public_routed' ELSE 'self_picked' END;
CREATE INDEX claims_origin_week ON claims (week, routing_origin, contributor);

CREATE TRIGGER claims_origin_fill AFTER INSERT ON claims WHEN NEW.routing_origin IS NULL
BEGIN
  UPDATE claims SET routing_origin = CASE WHEN NEW.routed = 1 THEN 'public_routed' ELSE 'self_picked' END WHERE id = NEW.id;
END;
CREATE TRIGGER claims_origin_consistent_insert BEFORE INSERT ON claims
WHEN NEW.routing_origin IS NOT NULL AND NEW.routed != (NEW.routing_origin = 'public_routed')
BEGIN
  SELECT RAISE(ABORT, 'claims.routed must be 1 exactly when routing_origin is public_routed');
END;
CREATE TRIGGER claims_origin_consistent_update BEFORE UPDATE OF routed, routing_origin ON claims
WHEN NEW.routing_origin IS NOT NULL AND NEW.routed != (NEW.routing_origin = 'public_routed')
BEGIN
  SELECT RAISE(ABORT, 'claims.routed must be 1 exactly when routing_origin is public_routed');
END;

ALTER TABLE accounts ADD COLUMN fallback INTEGER NOT NULL DEFAULT 1 CHECK (fallback IN (0,1));

CREATE TABLE account_links (
  account     TEXT PRIMARY KEY REFERENCES accounts (id),
  contributor INTEGER NOT NULL UNIQUE REFERENCES contributors (id),
  linked_at   INTEGER NOT NULL,
  via         TEXT NOT NULL CHECK (via IN ('code','oauth'))
);

CREATE TABLE link_codes (
  hash    TEXT PRIMARY KEY,                        -- sha256(HASH_SALT|linkcode|<code>); the code itself is never stored
  account TEXT NOT NULL REFERENCES accounts (id),
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX link_codes_account ON link_codes (account);
CREATE INDEX link_codes_expiry ON link_codes (expires);

CREATE TABLE link_attempts (
  id  INTEGER PRIMARY KEY AUTOINCREMENT,
  who TEXT NOT NULL,                               -- 'c:<contributor id>' or 'n:<daily network hash>'
  ts  INTEGER NOT NULL
);
CREATE INDEX link_attempts_who ON link_attempts (who, ts);

-- OAuth connections act as a contributor with no usable key, so the operator's revoke (which replaces the key hash and writes a
-- 'contributor_revoked' event) is enforced for them by looking that event up.
CREATE INDEX events_contributor_type ON events (contributor, type);
