-- Swarm AI hub, migration 0003: the lifecycle constraints.
--
--   * at most ONE outstanding claim (outcome IS NULL) per task;
--   * at most ONE live submission (pending or accepted) per task, so one task can never have two accepted results;
--   * claims.op and submissions.op: a random id the Worker stamps on a row when it wins a transition. The later
--     statements of the same transaction (task status, event) run only if their own row carries their op, so a stale or
--     repeated request cannot change a task that a newer claim or submission now owns.
--
-- Rows written by the older code can already break the two rules: a stale release or expiry reopened a task that
-- someone else then claimed, and two contributors could both hand work in. A unique index cannot be created over
-- violating rows, so this file first repairs them, and writes an event for every row it touches, so the audit trail shows
-- what changed. The repair keeps the history that was already counted as real and never deletes a row:
--
--   1. Submissions. Where a task has more than one pending-or-accepted submission, keep one: the earliest accepted one
--      (it already has a public receipt), otherwise the earliest pending one. Each other one becomes 'rejected', reviewed
--      by 'system', with a review note saying why. (The status CHECK has no other value, and a 'system' rejection does not
--      count toward a task's two-rejection limit.) An accepted duplicate stops counting as accepted work: one task is one
--      result, and the units are credited once.
--   2. Claims on a task that already has a live submission are closed as 'released': the work was handed in.
--   3. Where a task still has more than one outstanding claim, keep the newest and close the others as 'released'.
--      (An outstanding claim that has run past its 3 hours is still outstanding; the Worker expires it on the next request.)
--   4. Task status follows the evidence: accepted if it has an accepted submission, submitted if it has a pending one, claimed
--      if someone holds an outstanding claim, and ready again if it says 'claimed' but nobody holds it and no work was
--      handed in. Closed, rejected, held and withheld tasks are never touched.
--
-- Each repair writes its event before changing the row, using the same condition. 'op' values written here start with
-- 'migration-0003' so they cannot be mistaken for a request.

ALTER TABLE claims ADD COLUMN op TEXT;
ALTER TABLE submissions ADD COLUMN op TEXT;

-- 1. More than one live submission for a task.
INSERT INTO events (ts, type, task, contributor, submission, actor, detail)
  SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'submission_superseded', s.task, s.contributor, s.id, 'system',
         json_object('reason', 'migration 0003: another submission for this task was kept', 'was', s.status)
  FROM submissions s
  WHERE s.status IN ('pending', 'accepted')
    AND s.id != (SELECT k.id FROM submissions k WHERE k.task = s.task AND k.status IN ('pending', 'accepted')
                 ORDER BY (k.status = 'accepted') DESC, k.id ASC LIMIT 1);
UPDATE submissions
  SET status = 'rejected', reviewed_by = 'system', reviewed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
      review_note = 'Superseded: another submission for this task was kept (migration 0003).', op = 'migration-0003'
  WHERE status IN ('pending', 'accepted')
    AND id != (SELECT k.id FROM submissions k WHERE k.task = submissions.task AND k.status IN ('pending', 'accepted')
               ORDER BY (k.status = 'accepted') DESC, k.id ASC LIMIT 1);

-- 2. An outstanding claim on a task whose work was already handed in.
INSERT INTO events (ts, type, task, contributor, actor, detail)
  SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'claim_repaired', c.task, c.contributor, 'system',
         json_object('claim', c.id, 'reason', 'migration 0003: the task already has a submission')
  FROM claims c
  WHERE c.outcome IS NULL
    AND EXISTS (SELECT 1 FROM submissions s WHERE s.task = c.task AND s.status IN ('pending', 'accepted'));
UPDATE claims SET released = 1, outcome = 'released', op = 'migration-0003'
  WHERE outcome IS NULL
    AND EXISTS (SELECT 1 FROM submissions s WHERE s.task = claims.task AND s.status IN ('pending', 'accepted'));

-- 3. More than one outstanding claim on a task: keep the newest.
INSERT INTO events (ts, type, task, contributor, actor, detail)
  SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'claim_repaired', c.task, c.contributor, 'system',
         json_object('claim', c.id, 'reason', 'migration 0003: the task had a newer outstanding claim')
  FROM claims c
  WHERE c.outcome IS NULL AND c.id != (SELECT MAX(k.id) FROM claims k WHERE k.task = c.task AND k.outcome IS NULL);
UPDATE claims SET released = 1, outcome = 'released', op = 'migration-0003'
  WHERE outcome IS NULL AND id != (SELECT MAX(k.id) FROM claims k WHERE k.task = claims.task AND k.outcome IS NULL);

-- 4. Task status follows the evidence (the order matters: accepted, then submitted, then claimed, then ready).
INSERT INTO events (ts, type, task, actor, detail)
  SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'task_repaired', t.id, 'system',
         json_object('from', t.status, 'to', 'accepted', 'reason', 'migration 0003: it has an accepted submission')
  FROM tasks t
  WHERE t.status IN ('ready', 'claimed', 'submitted') AND EXISTS (SELECT 1 FROM submissions s WHERE s.task = t.id AND s.status = 'accepted');
UPDATE tasks SET status = 'accepted'
  WHERE status IN ('ready', 'claimed', 'submitted') AND EXISTS (SELECT 1 FROM submissions s WHERE s.task = tasks.id AND s.status = 'accepted');

INSERT INTO events (ts, type, task, actor, detail)
  SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'task_repaired', t.id, 'system',
         json_object('from', t.status, 'to', 'submitted', 'reason', 'migration 0003: it has a pending submission')
  FROM tasks t
  WHERE t.status IN ('ready', 'claimed') AND EXISTS (SELECT 1 FROM submissions s WHERE s.task = t.id AND s.status = 'pending');
UPDATE tasks SET status = 'submitted'
  WHERE status IN ('ready', 'claimed') AND EXISTS (SELECT 1 FROM submissions s WHERE s.task = tasks.id AND s.status = 'pending');

INSERT INTO events (ts, type, task, actor, detail)
  SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'task_repaired', t.id, 'system',
         json_object('from', 'ready', 'to', 'claimed', 'reason', 'migration 0003: someone holds an outstanding claim')
  FROM tasks t
  WHERE t.status = 'ready' AND t.held_reason IS NULL AND EXISTS (SELECT 1 FROM claims c WHERE c.task = t.id AND c.outcome IS NULL);
UPDATE tasks SET status = 'claimed'
  WHERE status = 'ready' AND held_reason IS NULL AND EXISTS (SELECT 1 FROM claims c WHERE c.task = tasks.id AND c.outcome IS NULL);

INSERT INTO events (ts, type, task, actor, detail)
  SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'task_repaired', t.id, 'system',
         json_object('from', 'claimed', 'to', 'ready', 'reason', 'migration 0003: nobody holds it and no work was handed in')
  FROM tasks t
  WHERE t.status = 'claimed'
    AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.task = t.id AND c.outcome IS NULL)
    AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.task = t.id AND s.status IN ('pending', 'accepted'));
UPDATE tasks SET status = 'ready'
  WHERE status = 'claimed'
    AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.task = tasks.id AND c.outcome IS NULL)
    AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.task = tasks.id AND s.status IN ('pending', 'accepted'));

-- The constraints, now that no row breaks them.
CREATE UNIQUE INDEX claims_one_outstanding ON claims (task) WHERE outcome IS NULL;
CREATE UNIQUE INDEX submissions_one_live ON submissions (task) WHERE status IN ('pending', 'accepted');
