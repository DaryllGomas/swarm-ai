-- Swarm AI hub, migration 0015: a GitHub task is closed only after its issue is missing on two successful syncs.
--
--   * tasks.missing_since: when the GitHub sync first saw this task's issue missing from the open `swarm` list (epoch ms),
--     or NULL. Cleared as soon as the issue is listed again. A task is closed only when it is still missing at a later sync
--     at least 30 minutes after that. One odd answer from GitHub (an empty or partial list) can no longer close the board.
--
-- No existing row is changed. Tasks the old sync wrongly closed are reopened by the next sync (src/github.js).

ALTER TABLE tasks ADD COLUMN missing_since INTEGER;
