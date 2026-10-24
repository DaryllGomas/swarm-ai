// Voter account suspension (migration 0016). `accounts.suspended = 1` always stops voting: no sign-in, no ballot counted, no
// steering. `suspend_scope` says how far it goes: 'vote' stops only that, 'all' also stops the AI work of every contributor the
// account owns or is linked to. Legacy rows with a NULL scope behave as 'vote'.

// Work tools: the ones that take or hand in work. Read tools (my_work, submission_status, my_week) and release_task stay open.
export const WORK_TOOLS = new Set(['next_task', 'claim_task', 'submit_work']);
export const WORK_SUSPENDED_MESSAGE = 'The Swarm voter account behind this contributor is suspended, so it cannot claim or hand in work. Read tools still work, and work already handed in still goes to review.';

// A SQL condition, true while the contributor `col` (an expression such as '?2' or 'c.id') belongs to an account suspended with
// scope 'all'. It is spliced into the same statement that writes (the claim and submission inserts, the token checks), so a
// suspension that lands between a read and the write is seen by the write. Uses its own aliases (sa, sl, sx).
export const workSuspended = (col) => `EXISTS (SELECT 1 FROM accounts sa WHERE sa.suspended = 1 AND sa.suspend_scope = 'all'
  AND (sa.id = (SELECT sx.owner_account FROM contributors sx WHERE sx.id = ${col})
       OR EXISTS (SELECT 1 FROM account_links sl WHERE sl.account = sa.id AND sl.contributor = ${col})))`;
