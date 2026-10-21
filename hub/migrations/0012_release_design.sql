-- Codex review 5: release design, deletion and purge repairs.
--   1. The weekly vote is released once a week with noise, so the daily projection caches go, and the stored voter count becomes
--      the lower edge of its coarse bucket (the database no longer keeps an exact count).
--   2. The weekly rollup keeps only what is published: one claimed-units total per project and week (all routes added together, so it
--      cannot isolate personal steering), no per-origin units, no claimed or submitted counts, no people counts behind them, no accepted
--      split by origin, no model families, and no personal-direction release. Weeks rolled up before this migration have their origin
--      columns added into the single total and then dropped; the splits cannot be recomputed from the rollup.
--   3. OAuth grants and tokens of a deleted account live outside D1 (OAUTH_KV); oauth_purge queues their deletion.
--   4. Old account-link events could carry an account id prefix next to a contributor id; their detail is scrubbed.
DELETE FROM meta WHERE k LIKE 'projection:%';

-- Snapshots that exist now were published before the split was noised, and the ones with 5 or more ballots are exact. They keep their
-- allocation (it was public already) but are marked noised = 0, so the API says they are exact and attaches no noise description. Only
-- snapshots published by the new code carry noised = 1. (The unsafe ones, below 5 ballots and the fallbacks descended from them, were
-- already replaced by 0011.)
ALTER TABLE vote_snapshots ADD COLUMN noised INTEGER NOT NULL DEFAULT 0;

UPDATE vote_snapshots SET voter_count = CASE
  WHEN source != 'ballots' OR voter_count < 5 THEN 0
  WHEN voter_count <= 9 THEN 5 WHEN voter_count <= 24 THEN 10 WHEN voter_count <= 49 THEN 25 WHEN voter_count <= 99 THEN 50
  ELSE (voter_count / 50) * 50 END;

ALTER TABLE weekly_project_stats RENAME TO weekly_project_stats_bak;
CREATE TABLE weekly_project_stats (
  week           TEXT NOT NULL,
  project        TEXT NOT NULL REFERENCES projects (id),
  claimed_units  INTEGER NOT NULL,          -- units of standing claims made this week, ALL routes added together (never split by who or how it was routed)
  accepted_units INTEGER NOT NULL,          -- units a reviewer accepted this week, all origins together
  tasks_created  INTEGER NOT NULL,
  tasks_accepted INTEGER NOT NULL,
  tasks_rejected INTEGER NOT NULL,
  contributors   INTEGER NOT NULL,          -- distinct contributors with a standing claim this week: a count of people, published only as a coarse range
  reviews        INTEGER NOT NULL,
  review_p50_ms  INTEGER,
  review_p90_ms  INTEGER,
  PRIMARY KEY (week, project)
);
INSERT INTO weekly_project_stats (week, project, claimed_units, accepted_units, tasks_created, tasks_accepted, tasks_rejected, contributors, reviews, review_p50_ms, review_p90_ms)
  SELECT week, project, routed_units + ballot_directed_units + self_picked_units, accepted_routed_units + accepted_ballot_directed_units + accepted_self_picked_units, tasks_created, tasks_accepted, tasks_rejected, contributors, reviews, review_p50_ms, review_p90_ms
  FROM weekly_project_stats_bak;
DROP TABLE weekly_project_stats_bak;
DROP TABLE weekly_model_stats;

CREATE TABLE oauth_purge (
  contributor INTEGER PRIMARY KEY,          -- a removed contributor whose OAuth grants and tokens (OAUTH_KV, userId "c<id>") are to be deleted
  created     INTEGER NOT NULL
);

UPDATE events SET detail = NULL WHERE type IN ('account_linked', 'account_unlinked');
