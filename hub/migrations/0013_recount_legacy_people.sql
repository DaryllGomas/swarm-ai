-- Codex review 7, R7-4: weekly_project_stats.contributors rows written before migration 0012 counted distinct CONTRIBUTOR ids, so five
-- contributors owned by one account showed as five people. Fresh rollups count one person per owning account (or per unowned contributor).
--   * Only rows of weeks that were rolled up before migration 0012 was applied are touched (rows rolled up by the current code are right).
--   * Where the week's claims still exist, the count is recomputed the current way. Where the detail is gone (purged, or never kept), the
--     old count cannot be reconstructed, so it is suppressed: set to 0, which the API shows as "fewer than 5".
--   * A count is never raised, only lowered or kept.
-- This is the one place a past rollup is recomputed; it runs once, with the migration.
UPDATE weekly_project_stats SET contributors = MIN(contributors, COALESCE((
    SELECT COUNT(DISTINCT COALESCE('a' || u.owner_account, 'c' || c.contributor))
    FROM claims c JOIN tasks t ON t.id = c.task JOIN contributors u ON u.id = c.contributor
    WHERE c.week = weekly_project_stats.week AND t.project = weekly_project_stats.project
      AND (c.outcome IS NULL OR c.outcome = 'submitted') AND u.removed = 0 AND u.handle != 'former contributor'), 0))
WHERE COALESCE((SELECT r.ran_at FROM rollup_weeks r WHERE r.week = weekly_project_stats.week), 0)
    < COALESCE((SELECT CAST(strftime('%s', m.applied_at) AS INTEGER) * 1000 FROM d1_migrations m WHERE m.name = '0012_release_design.sql'), 0);
