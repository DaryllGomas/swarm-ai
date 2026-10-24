-- Swarm AI hub, migration 0016: a voter account can be suspended from voting only, or from voting and its AI's work.
--
--   * accounts.suspend_scope: 'vote' or 'all' while accounts.suspended = 1, NULL otherwise. 'vote' is what suspension
--     always did (no sign-in, no ballot counted, no steering; the linked AI keeps working). 'all' also stops the AI work
--     of every contributor the account owns or is linked to: claim, next_task and submit_work. Read tools stay open.
--   * accounts.suspend_ref: a short random handle (8 hex characters) for the suspension, unrelated to the account id. The
--     operator console lists and lifts suspensions by this handle, so it never has to show an account id.
--   * accounts.suspended_at: when the suspension began (epoch ms).
--
-- Existing suspended accounts keep today's behaviour: they become scope 'vote'. No other row changes. Suspending and
-- lifting only flip these columns; no ballot, contributor, claim, submission or token is touched, so lifting restores
-- everything.

ALTER TABLE accounts ADD COLUMN suspend_scope TEXT CHECK (suspend_scope IN ('vote','all'));
ALTER TABLE accounts ADD COLUMN suspend_ref TEXT;
ALTER TABLE accounts ADD COLUMN suspended_at INTEGER;

UPDATE accounts SET suspend_scope = 'vote', suspend_ref = lower(hex(randomblob(4))), suspended_at = 0 WHERE suspended = 1;

CREATE UNIQUE INDEX accounts_suspend_ref ON accounts(suspend_ref) WHERE suspend_ref IS NOT NULL;
