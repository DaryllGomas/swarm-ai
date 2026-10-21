-- k-anonymity of 5 for the weekly vote (docs/DATA-POLICY.md).
-- 1. A weekly snapshot built from fewer than 5 eligible ballots would publish those voters' ballots. From now on publishSnapshot records those
--    weeks as 'fallback'. This migration repairs snapshots already published, SAFE ON POPULATED DATA (Codex reviews 5 and 6):
--      * every snapshot with source = 'ballots' built from fewer than 5 ballots is unsafe, and
--      * so is every FALLBACK week descended from one: a fallback copies the newest earlier allocation, so a fallback that follows an unsafe
--        week (directly, or through other fallbacks) carries that voter's exact split forward.
--    All of those weeks get an equal provisional split across the active projects and become fallbacks (voter_count 0, no count kept).
--    Nothing unsafe is ever copied: there is no "carry the last safe week" here, because the unsafe weeks are found first and replaced
--    together. A week that is a valid snapshot (5 or more ballots), a seed (an allocation with no snapshot) or a fallback that follows only
--    safe weeks is left alone and breaks the chain.
CREATE TABLE _unsafe_weeks (week TEXT PRIMARY KEY);
INSERT INTO _unsafe_weeks (week)
  WITH RECURSIVE weeks AS (SELECT week FROM allocation UNION SELECT week FROM vote_snapshots),
  ordered AS (SELECT week, ROW_NUMBER() OVER (ORDER BY week) AS n FROM weeks),
  unsafe (week, n) AS (
    SELECT o.week, o.n FROM ordered o JOIN vote_snapshots s ON s.week = o.week WHERE s.source = 'ballots' AND s.voter_count < 5
    UNION
    SELECT o.week, o.n FROM ordered o JOIN unsafe u ON o.n = u.n + 1 JOIN vote_snapshots s ON s.week = o.week WHERE s.source = 'fallback'
  )
  SELECT week FROM unsafe;
DELETE FROM allocation WHERE week IN (SELECT week FROM _unsafe_weeks);
INSERT INTO allocation(week, project, share, provisional)
  SELECT w.week, p.id, 10000 / p.n + CASE WHEN p.rank <= 10000 % p.n THEN 1 ELSE 0 END, 1
  FROM _unsafe_weeks w
  CROSS JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rank, COUNT(*) OVER () AS n FROM projects WHERE active = 1) p;
UPDATE vote_snapshots SET source = 'fallback', voter_count = 0 WHERE week IN (SELECT week FROM _unsafe_weeks);
DROP TABLE _unsafe_weeks;
-- 2. Ballot-directed units per project reveal the ballot of the voter whose AI did the work. The rollup now records how many people (voters)
--    stood behind the week's ballot-directed work; the public analytics show those units only from 5 people. NULL (weeks rolled up before this
--    migration) is treated as too few.
ALTER TABLE weekly_project_stats ADD COLUMN ballot_directed_people INTEGER;
