-- k-anonymity of 5 for the weekly vote (docs/DATA-POLICY.md).
-- 1. A weekly snapshot built from fewer than 5 eligible ballots would publish those voters' ballots. From now on publishSnapshot records those
--    weeks as 'fallback'. This migration does the same for snapshots already published: the week becomes a fallback (voter_count 0, no count kept)
--    and its allocation becomes the carried-forward split of the last week that had at least 5 ballots, marked provisional. When no earlier
--    eligible week exists (the small snapshot replaced the very first seed), the week gets an explicit provisional seed: an equal split across
--    the active projects. The small snapshot's own allocation is never reused as a fallback (that is the ballot being protected).
DELETE FROM allocation WHERE week IN (SELECT week FROM vote_snapshots WHERE source = 'ballots' AND voter_count < 5);
INSERT INTO allocation(week, project, share, provisional)
  SELECT w.week, a.project, a.share, 1 FROM (SELECT week FROM vote_snapshots WHERE source = 'ballots' AND voter_count < 5) w JOIN allocation a
    ON a.week = (SELECT MAX(a2.week) FROM allocation a2 WHERE a2.week < w.week AND a2.week NOT IN (SELECT week FROM vote_snapshots WHERE source = 'ballots' AND voter_count < 5));
INSERT INTO allocation(week, project, share, provisional)
  SELECT w.week, p.id, 10000 / p.n + CASE WHEN p.rank <= 10000 % p.n THEN 1 ELSE 0 END, 1
  FROM (SELECT week FROM vote_snapshots WHERE source = 'ballots' AND voter_count < 5) w
  CROSS JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rank, COUNT(*) OVER () AS n FROM projects WHERE active = 1) p
  WHERE NOT EXISTS (SELECT 1 FROM allocation a WHERE a.week = w.week);
UPDATE vote_snapshots SET source = 'fallback', voter_count = 0 WHERE source = 'ballots' AND voter_count < 5;
-- 2. Ballot-directed units per project reveal the ballot of the voter whose AI did the work. The rollup now records how many people (voters)
--    stood behind the week's ballot-directed work; the public analytics show those units only from 5 people. NULL (weeks rolled up before this
--    migration) is treated as too few.
ALTER TABLE weekly_project_stats ADD COLUMN ballot_directed_people INTEGER;
