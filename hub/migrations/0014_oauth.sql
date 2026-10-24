-- Swarm's own OAuth server for MCP sign-in (replaces @cloudflare/workers-oauth-provider and its OAUTH_KV state).
-- Every state change is a conditional UPDATE or INSERT ... SELECT inside one D1 batch, so a code has one winner, a refresh token is
-- rotated once, and a revoked grant can never be brought back by a request that started earlier. Secrets (codes, access tokens,
-- refresh tokens, consent handles) are stored only as salted hashes.
--
-- Numbered 0014 on purpose: 0013 belongs to another branch. Wrangler applies migrations in filename order and a gap is harmless.

CREATE TABLE oauth_clients (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,              -- as the app gave it; shown on the consent page as data, never as markup
  redirect_uris TEXT NOT NULL,              -- JSON array of exact URIs (https, or http on 127.0.0.1 / localhost)
  created       INTEGER NOT NULL,
  network       TEXT                        -- network hash of the registrant for the daily cap; nulled with the other network hashes
);
CREATE INDEX oauth_clients_network ON oauth_clients (network, created);

-- One consent page = one single-use transaction (the CSRF defence): bound to the browser that opened it by a cookie.
CREATE TABLE oauth_consents (
  hash         TEXT PRIMARY KEY,            -- hash of the handle in the page
  browser_hash TEXT NOT NULL,               -- hash of the secret in the __Host- cookie
  client       TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  state        TEXT,
  scope        TEXT NOT NULL,               -- what the app asked for (space separated); the person's choice can only narrow it
  challenge    TEXT NOT NULL,               -- PKCE S256 challenge
  resource     TEXT NOT NULL,
  expires      INTEGER NOT NULL,
  used         INTEGER NOT NULL DEFAULT 0,
  consumer     TEXT                         -- random marker of the request that spent it
);

-- A grant is what a person allowed: one app, one contributor, a scope. revoked_at is authoritative: every token is only as good as
-- its grant, and every token issue and every protected request checks it in the same statement or batch.
CREATE TABLE oauth_grants (
  id             TEXT PRIMARY KEY,
  client         TEXT NOT NULL REFERENCES oauth_clients (id),
  contributor    INTEGER NOT NULL,
  scope          TEXT NOT NULL,
  resource       TEXT NOT NULL,             -- the audience: https://<origin>/mcp
  created        INTEGER NOT NULL,
  revoked_at     INTEGER,
  revoked_reason TEXT                       -- revoked | code_reuse | refresh_reuse | operator_revoked | account_deleted
);
CREATE INDEX oauth_grants_contributor ON oauth_grants (contributor);

CREATE TABLE oauth_codes (
  hash         TEXT PRIMARY KEY,
  grant_id     TEXT NOT NULL REFERENCES oauth_grants (id),
  redirect_uri TEXT NOT NULL,
  challenge    TEXT NOT NULL,
  expires      INTEGER NOT NULL,            -- 60 seconds
  used         INTEGER NOT NULL DEFAULT 0,
  consumer     TEXT
);

-- Access and refresh tokens. family = the lineage that started at one code exchange; it belongs to the grant.
-- A refresh token that has been rotated keeps its row (rotated_at, successor) so that a replay is recognised as theft.
CREATE TABLE oauth_tokens (
  hash       TEXT PRIMARY KEY,
  grant_id   TEXT NOT NULL REFERENCES oauth_grants (id),
  family     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  created    INTEGER NOT NULL,
  expires    INTEGER NOT NULL,
  revoked_at INTEGER,
  rotated_at INTEGER,
  successor  TEXT,                          -- hash of the refresh token that replaced this one
  retry_blob TEXT                           -- the replacement tokens, encrypted with a key that needs this token; kept for 30 seconds
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens (grant_id);
CREATE INDEX oauth_tokens_family ON oauth_tokens (family);
CREATE INDEX oauth_tokens_successor ON oauth_tokens (successor);

-- The KV deletion queue is not needed any more: grants are rows here, revoked in the same batch as the account deletion.
DROP TABLE oauth_purge;
