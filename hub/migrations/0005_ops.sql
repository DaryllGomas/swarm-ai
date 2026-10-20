-- Operator annotations and publication never change the accepted/rejected lifecycle.
ALTER TABLE projects ADD COLUMN paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1));
ALTER TABLE submissions ADD COLUMN prescreen TEXT CHECK (prescreen IS NULL OR json_valid(prescreen));
ALTER TABLE submissions ADD COLUMN published_url TEXT;
ALTER TABLE submissions ADD COLUMN published_at INTEGER;
CREATE INDEX claims_recent ON claims (claimed_at, contributor);
CREATE INDEX events_recent ON events (ts, id);
