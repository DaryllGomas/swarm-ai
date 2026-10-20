-- Swarm AI hub, migration 0009: fixes from Codex's fourth security review.
--
--   * contributors.owner_account: who OWNS a contributor, separate from the steering link (account_links), which a voter may
--     move. A contributor is owned by the account that created it (OAuth passkey mode) or by the first account it was linked
--     to. Once set it never changes (the trigger below refuses), so a link code from another account cannot take it over.
--     Existing links are backfilled: the account a contributor is linked to today becomes its owner.
--     Deliberately no foreign key: ownership must survive tests and tools that clear accounts, and nothing cascades from it.
--   * submissions.pr_mentions_issue: a HINT for the reviewer, set when a pull request is submitted: 1 when its title or body
--     names the task's issue (#N or owner/repo#N), 0 when it does not, NULL when unknown (not a pull-request submission).
--     It is never proof, and nothing accepts work because of it.

ALTER TABLE contributors ADD COLUMN owner_account TEXT;
CREATE INDEX contributors_owner ON contributors (owner_account) WHERE owner_account IS NOT NULL;
UPDATE contributors SET owner_account = (SELECT l.account FROM account_links l WHERE l.contributor = contributors.id)
  WHERE EXISTS (SELECT 1 FROM account_links l WHERE l.contributor = contributors.id);
CREATE TRIGGER contributors_owner_fixed BEFORE UPDATE OF owner_account ON contributors
WHEN OLD.owner_account IS NOT NULL AND NEW.owner_account IS NOT OLD.owner_account
BEGIN
  SELECT RAISE(ABORT, 'contributors.owner_account cannot be changed once set');
END;

ALTER TABLE submissions ADD COLUMN pr_mentions_issue INTEGER CHECK (pr_mentions_issue IN (0,1));
