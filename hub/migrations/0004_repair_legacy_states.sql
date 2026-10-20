-- Swarm AI hub, migration 0004: repair the legacy states that migration 0003 left behind.
--
-- Migration 0003 repaired what the unique indexes needed and made tasks match their claims and submissions, but it
-- deliberately left two kinds of rows the older, non-atomic code could have written. Both are incoherent with the
-- current transactions, so they are repaired here (0003 is shipped and is not edited):
--
--   1. A task still 'submitted' with no pending or accepted submission. The old review code rejected the submission and
--      then failed before it moved the task or wrote the event. Nothing can review it (there is nothing pending), and
--      nobody can claim it (it is not 'ready'). It moves the way the review code would have moved it: to 'rejected' when
--      it has 2 or more reviewer rejections (rejections by 'system' do not count, the same rule as /api/admin/review),
--      otherwise back to the pool. Back to the pool means 'ready', or 'claimed' if someone still holds an outstanding
--      claim on it (and it is not withheld), so a 'ready' task never carries an outstanding claim.
--   2. An outstanding claim on a task that is closed, accepted, rejected or held (status 'held', or any task with a
--      held_reason). Its owner could submit; the submission became pending and review then refused it. The claim is
--      closed as 'released'. The task is NOT reopened: its status is not touched.
--
-- Every repair writes its event first, with the same condition, in the style of migration 0003 ('task_repaired',
-- 'claim_repaired'), and nothing is deleted. The step order matters: step 2 also closes the claims of tasks that step 1
-- just rejected. The file is idempotent: each statement's condition stops matching once its repair has been made, so
-- running it again, or on a database that never had these states, changes nothing. 'op' values written here are
-- 'migration-0004'.

-- 1. A 'submitted' task with nothing to review.
INSERT INTO events (ts, type, task, actor, detail)
  SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'task_repaired', t.id, 'system',
         json_object('from', 'submitted',
                     'to', CASE
                       WHEN (SELECT COUNT(*) FROM submissions r WHERE r.task = t.id AND r.status = 'rejected' AND COALESCE(r.reviewed_by, '') != 'system') >= 2 THEN 'rejected'
                       WHEN t.held_reason IS NULL AND EXISTS (SELECT 1 FROM claims c WHERE c.task = t.id AND c.outcome IS NULL) THEN 'claimed'
                       ELSE 'ready' END,
                     'reason', 'migration 0004: it was waiting for review but has no pending or accepted submission')
  FROM tasks t
  WHERE t.status = 'submitted'
    AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.task = t.id AND s.status IN ('pending', 'accepted'));
UPDATE tasks SET status = CASE
    WHEN (SELECT COUNT(*) FROM submissions r WHERE r.task = tasks.id AND r.status = 'rejected' AND COALESCE(r.reviewed_by, '') != 'system') >= 2 THEN 'rejected'
    WHEN held_reason IS NULL AND EXISTS (SELECT 1 FROM claims c WHERE c.task = tasks.id AND c.outcome IS NULL) THEN 'claimed'
    ELSE 'ready' END
  WHERE status = 'submitted'
    AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.task = tasks.id AND s.status IN ('pending', 'accepted'));

-- 2. An outstanding claim on a task that can no longer take work. The claim is closed; the task stays as it is.
INSERT INTO events (ts, type, task, contributor, actor, detail)
  SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'claim_repaired', c.task, c.contributor, 'system',
         json_object('claim', c.id, 'reason', 'migration 0004: the task is ' || t.status || CASE WHEN t.held_reason IS NOT NULL THEN ' and withheld' ELSE '' END || ', so it cannot take work')
  FROM claims c JOIN tasks t ON t.id = c.task
  WHERE c.outcome IS NULL AND (t.status IN ('closed', 'accepted', 'rejected', 'held') OR t.held_reason IS NOT NULL);
UPDATE claims SET released = 1, outcome = 'released', op = 'migration-0004'
  WHERE outcome IS NULL
    AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = claims.task AND (t.status IN ('closed', 'accepted', 'rejected', 'held') OR t.held_reason IS NOT NULL));
