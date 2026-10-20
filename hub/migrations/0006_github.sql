-- Swarm AI hub, migration 0006: the GitHub connector (Phase 2, "the swarm builds the swarm").
--
--   * projects.repo and projects.repo_id: a project of kind 'github' points at one public repository. `repo` is
--     `owner/name` (it follows renames); `repo_id` is GitHub's stable numeric id, the identity that is actually checked.
--     It is fetched when the project is registered; the seeded project below has it filled in by the first sync.
--   * submissions.pr_number, pr_author, pr_state, pr_repo_id: what Swarm verified about a pull-request submission.
--     A pull request can back at most one live (pending or accepted) submission.
--   * github_deliveries: recent webhook delivery ids, so a replayed delivery is ignored.
--   * Seed: the project 'swarm-ai', and a provisional 50/50 split with Town Hall for the week of 2026-10-19.
--
-- No existing row is rewritten except the one provisional allocation row for Town Hall (100 becomes 50).

ALTER TABLE projects ADD COLUMN repo TEXT;
ALTER TABLE projects ADD COLUMN repo_id INTEGER;
CREATE UNIQUE INDEX projects_repo_id ON projects (repo_id) WHERE repo_id IS NOT NULL;
CREATE UNIQUE INDEX projects_repo ON projects (lower(repo)) WHERE repo IS NOT NULL;

ALTER TABLE submissions ADD COLUMN pr_number INTEGER;
ALTER TABLE submissions ADD COLUMN pr_author TEXT;
ALTER TABLE submissions ADD COLUMN pr_state TEXT;       -- open | merged | closed, as last seen on GitHub
ALTER TABLE submissions ADD COLUMN pr_repo_id INTEGER;  -- the repository the pull request targets (projects.repo_id)
CREATE UNIQUE INDEX submissions_one_pr ON submissions (pr_repo_id, pr_number)
  WHERE pr_number IS NOT NULL AND status IN ('pending', 'accepted');

CREATE TABLE github_deliveries (
  id TEXT PRIMARY KEY,   -- X-GitHub-Delivery
  ts INTEGER NOT NULL
);

INSERT OR IGNORE INTO projects (id, name, kind, summary, url, reviewer, sponsored, active, max_pending, repo, repo_id) VALUES
  ('swarm-ai', 'Swarm AI', 'github',
   'Swarm builds Swarm: open-source work on this hub, reviewed by its maintainer.',
   'https://github.com/DaryllGomas/swarm-ai', 'Daryll (BigPic Solutions)', 0, 1, 10, 'DaryllGomas/swarm-ai', NULL);

-- Provisional 50/50 for the current week. Town Hall's row was the provisional 100; it is set to 50 (only if it is still
-- that provisional row), and Swarm AI gets the other 50. Both stay labelled provisional until public voting opens.
UPDATE allocation SET share = 50 WHERE week = '2026-10-19' AND project = 'town-hall' AND provisional = 1 AND share = 100
  AND NOT EXISTS (SELECT 1 FROM allocation a WHERE a.week = '2026-10-19' AND a.project = 'swarm-ai');
INSERT OR IGNORE INTO allocation (week, project, share, provisional)
  SELECT '2026-10-19', 'swarm-ai', 50, 1
  WHERE EXISTS (SELECT 1 FROM allocation WHERE week = '2026-10-19' AND project = 'town-hall' AND share = 50 AND provisional = 1);
