// Privacy and trust (migration 0010). The line: learn about the work, never about the people.
//   - the three privacy choices on a voter account (and the credit choice mirrored on contributors);
//   - how a contributor is shown on public pages (credit), and the k-anonymity rule for counts of people;
//   - the network-hash housekeeping the hourly job does (forward secrecy);
//   - the right to leave: delete an account, remove a handle.
import { NETWORK_KEY_KEEP_DAYS, resetNetworkKeyCache, sha256, utcDay } from './lib.js';

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const randomId = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => ALPHABET[b % ALPHABET.length]).join('');

export const CREDIT = ['anonymous', 'handle'];
export const HISTORY = ['private', 'weekly_purge'];
export const RESEARCH = ['aggregate', 'share_pseudonymous'];
export const DEFAULT_CHOICES = { credit: 'anonymous', history: 'private', research: 'aggregate' };

// One plain sentence per choice value, shown in the UI beside the choice and returned by the API.
export const CHOICE_TEXT = {
  credit: {
    anonymous: 'Your accepted work shows as "a contributor" on receipts, and your handle is not shown there.',
    handle: 'Your handle is shown on your receipts, and switching back to anonymous hides it on receipts read from then on (copies someone already saved keep it).',
  },
  history: {
    private: 'Your own claims and submissions stay visible only to you on Your Swarm.',
    weekly_purge: 'Each week, after the totals are counted, your per-item detail is deleted and only anonymous totals remain.',
  },
  research: {
    aggregate: 'Your work counts only in anonymous totals.',
    share_pseudonymous: 'Your contribution history goes into an open research dataset under a random research ID, never your handle or account.',
  },
};

const SETS = { credit: CREDIT, history: HISTORY, research: RESEARCH };

// Read the three choices from a request body. Every key is optional; an unknown value is an error. Returns { choices } or { error }.
export function parseChoices(body) {
  const choices = {};
  for (const [k, allowed] of Object.entries(SETS)) {
    if (body?.[k] === undefined) continue;
    if (typeof body[k] !== 'string' || !allowed.includes(body[k])) return { error: `${k} must be one of: ${allowed.join(', ')}.` };
    choices[k] = body[k];
  }
  return { choices };
}

export const newResearchId = () => `r-${randomId(16)}`;

// ---------------------------------------------------------------- how a contributor is shown

export const REMOVED_LABEL = 'removed contributor';
export const ANONYMOUS_LABEL = 'a contributor';
// The contributor row that purged work is re-pointed at. It is not a person: it shows as "a contributor" and is never counted.
export const PURGED_HANDLE = 'former contributor';

// The name a public page may show for a contributor row ({ handle, credit, removed }).
export function creditedAs(c) {
  if (c.removed) return REMOVED_LABEL;
  return c.credit === 'handle' ? c.handle : ANONYMOUS_LABEL;
}
// The handle itself, only when the contributor chose to be credited by it.
export const publicHandle = (c) => (!c.removed && c.credit === 'handle' ? c.handle : null);

// SQL that excludes the stand-ins from any count of people.
export const REAL_CONTRIBUTOR = `(removed = 0 AND handle != '${PURGED_HANDLE}')`;

// ---------------------------------------------------------------- k-anonymity

export const K_MIN = 5;
// A public count of PEOPLE for a group smaller than K_MIN is not published. Zero is published as zero: an empty group has nobody in it.
// Counts of work (units, tasks) are not about people and are never passed through this.
export function kCount(n, label = 'fewer than 5') {
  return n === 0 || n >= K_MIN ? n : label;
}

// A public count of VOTERS or BALLOTS. Stricter than kCount: zero is hidden too (0 versus "fewer than 5" would show that someone voted), and 5 or
// more is published only as a coarse bucket, so subtracting two published counts (day against week, week against week, accounts against ballots)
// can never give a number from 1 to 4. The lower edges of the buckets are at least 5 apart.
export function coarseCount(n, label = 'fewer than 5') {
  if (n < K_MIN) return label;
  for (const [lo, hi] of [[5, 9], [10, 24], [25, 49], [50, 99]]) if (n <= hi) return `${lo}-${hi}`;
  return `${Math.floor(n / 50) * 50}+`;
}

// The lower edge of the coarse bucket a count falls in (0 below K_MIN). Counts that are kept in the database are kept as this, never exact.
export function bucketFloor(n) {
  if (n < K_MIN) return 0;
  for (const [lo, hi] of [[5, 9], [10, 24], [25, 49], [50, 99]]) if (n <= hi) return lo;
  return Math.floor(n / 50) * 50;
}

// ---------------------------------------------------------------- the account's choices

// Save choices on an account (any subset) and mirror the credit choice onto the contributors it owns. Returns the choices now in force.
export async function saveChoices(env, account, choices) {
  const research = choices.research ?? null;
  await env.DB.batch([
    env.DB.prepare('UPDATE accounts SET credit = COALESCE(?2, credit), history = COALESCE(?3, history), research = COALESCE(?4, research) WHERE id = ?1 AND suspended = 0')
      .bind(account, choices.credit ?? null, choices.history ?? null, research),
    // A research ID exists only while sharing is on; turning it off drops it, and turning it on again makes a new, unrelated one.
    env.DB.prepare("UPDATE accounts SET research_id = CASE WHEN research = 'share_pseudonymous' THEN COALESCE(research_id, ?2) ELSE NULL END WHERE id = ?1 AND suspended = 0")
      .bind(account, newResearchId()),
    mirrorCreditStmt(env, account),
  ]);
  return choicesOf(env, account);
}

// Linked contributors follow their account's credit choice.
export const mirrorCreditStmt = (env, account) => env.DB.prepare(
  `UPDATE contributors SET credit = (SELECT credit FROM accounts WHERE id = ?1)
   WHERE removed = 0 AND (owner_account = ?1 OR id IN (SELECT contributor FROM account_links WHERE account = ?1))
     AND EXISTS (SELECT 1 FROM accounts WHERE id = ?1)`
).bind(account);
export const syncCredit = (env, account) => mirrorCreditStmt(env, account).run();

export async function choicesOf(env, account) {
  const a = await env.DB.prepare('SELECT credit, history, research, research_id FROM accounts WHERE id = ?1').bind(account).first();
  if (!a) return null;
  return { credit: a.credit, history: a.history, research: a.research, research_id: a.research === 'share_pseudonymous' ? a.research_id : null };
}

// ---------------------------------------------------------------- forward secrecy: the hourly job's part

// Delete day keys older than two days, and erase the network hashes made with them (and every network hash older than two days),
// in one transaction, so no hash outlives its key. After this, those codes cannot be reversed by anyone, the operator included, and
// the old rows cannot even be matched to each other.
export async function forgetNetworks(env, now = Date.now()) {
  const cutoff = now - NETWORK_KEY_KEEP_DAYS * 86400000;
  const oldestDay = utcDay(cutoff); // a key survives until its whole day is past the cutoff; the rows it made are erased as soon as they are
  const res = await env.DB.batch([
    env.DB.prepare('UPDATE claims SET network = NULL WHERE network IS NOT NULL AND claimed_at < ?1').bind(cutoff),
    env.DB.prepare('UPDATE contributors SET pair_ip = NULL WHERE pair_ip IS NOT NULL AND created < ?1').bind(cutoff),
    env.DB.prepare('UPDATE accounts SET network = NULL WHERE network IS NOT NULL AND created < ?1').bind(cutoff),
    // Link attempts keep a network hash for an hour of budget; they are deleted well before two days (see the hourly job), and here regardless.
    env.DB.prepare('DELETE FROM link_attempts WHERE ts < ?1').bind(cutoff),
    env.DB.prepare('DELETE FROM network_keys WHERE day < ?1').bind(oldestDay),
  ]);
  resetNetworkKeyCache();
  return { claims: res[0].meta.changes, contributors: res[1].meta.changes, accounts: res[2].meta.changes, keys: res[4].meta.changes };
}

// ---------------------------------------------------------------- the right to leave

const tombstone = (prefix) => `${prefix}-${randomId(8)}`;
const randomKeyHash = (env) => sha256(`${env.HASH_SALT}|removed|${crypto.randomUUID()}`);

// The stand-in contributor that purged work is re-pointed at. Created on first use. Returns its id.
export async function purgedContributorId(env) {
  await env.DB.prepare('INSERT OR IGNORE INTO contributors (handle, key_hash, created, credit, removed) VALUES (?1, ?2, ?3, ?4, 0)')
    .bind(PURGED_HANDLE, await randomKeyHash(env), Date.now(), 'anonymous').run();
  return (await env.DB.prepare('SELECT id FROM contributors WHERE handle = ?1').bind(PURGED_HANDLE).first()).id;
}

// The contributors an account owns or is linked to.
export async function contributorsOfAccount(env, account) {
  const { results } = await env.DB.prepare(
    'SELECT id FROM contributors WHERE owner_account = ?1 OR id IN (SELECT contributor FROM account_links WHERE account = ?1)'
  ).bind(account).all();
  return results.map((r) => r.id);
}

// Delete a voter account. One transaction, and every statement picks its contributors by the account's ownership and link AT COMMIT
// TIME, not from a list read earlier: a contributor linked or created a moment before cannot be missed, and a request that races the
// deletion finds the contributor already removed (the claim and submission inserts check that). Gone: the account, its passkeys,
// sessions, link codes, the link to its AI and ballot ownership. The ballot versions stay (they are part of the audit trail) under
// random ids that point at nobody. Past snapshots are immutable records of totals and are not touched. The contributors it owned become
// "removed contributor": their handle becomes a random tombstone, their key stops working, their claims lose their network code, and
// their accepted work stays credited to the project. Events are scrubbed of the handle, and the deletion is recorded with no detail.
// Their OAuth grants and tokens (outside D1, in OAUTH_KV) are queued in oauth_purge and deleted right after, and again by the hourly
// job. NOT erased: the content of their submissions and any pull request author name (see docs/DATA-POLICY.md).
const OWNED = '(owner_account = ?1 OR id IN (SELECT contributor FROM account_links WHERE account = ?1))';
export async function deleteAccount(env, account, now = Date.now()) {
  const res = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO oauth_purge (contributor, created) SELECT id, ?2 FROM contributors WHERE ${OWNED}`).bind(account, now),
    env.DB.prepare(
      `UPDATE events SET detail = NULL, actor = CASE WHEN actor = (SELECT handle FROM contributors WHERE id = events.contributor) THEN NULL ELSE actor END
       WHERE contributor IN (SELECT id FROM contributors WHERE ${OWNED}) AND type != 'contributor_revoked'`
    ).bind(account),
    env.DB.prepare(`UPDATE claims SET network = NULL WHERE contributor IN (SELECT id FROM contributors WHERE ${OWNED})`).bind(account),
    env.DB.prepare(
      `UPDATE contributors SET removed = 1, owner_account = NULL, credit = 'anonymous', handle = 'removed-' || lower(hex(randomblob(4))),
         key_hash = lower(hex(randomblob(32))), pair_ip = NULL, github = NULL
       WHERE ${OWNED}`
    ).bind(account),
    env.DB.prepare("UPDATE ballot_versions SET account = 'gone:' || lower(hex(randomblob(16))) WHERE account = ?1").bind(account),
    env.DB.prepare('DELETE FROM account_links WHERE account = ?1').bind(account),
    env.DB.prepare('DELETE FROM link_codes WHERE account = ?1').bind(account),
    env.DB.prepare('DELETE FROM sessions WHERE account = ?1').bind(account),
    env.DB.prepare('DELETE FROM credentials WHERE account = ?1').bind(account),
    env.DB.prepare('DELETE FROM account_challenges WHERE account = ?1').bind(account),
    env.DB.prepare('DELETE FROM accounts WHERE id = ?1').bind(account),
    env.DB.prepare("INSERT INTO events (ts, type, actor) SELECT ?1, 'account_deleted', 'system' WHERE changes() > 0").bind(now), // only if the DELETE above removed an account
  ]);
  const deleted = res.at(-2).meta.changes > 0;
  if (deleted) { try { await purgeOAuthState(env, now); } catch (err) { console.error('oauth purge failed:', String(err?.message || err).slice(0, 200)); } }
  return { deleted, contributors: res[3].meta.changes };
}

// ---------------------------------------------------------------- OAuth state outside D1

// Delete every key under a KV prefix. Returns true when the prefix is empty afterwards.
async function deletePrefix(kv, prefix) {
  let cursor;
  for (let page = 0; page < 100; page++) {
    const listed = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
    await Promise.all(listed.keys.map((k) => kv.delete(k.name)));
    if (listed.list_complete) return true;
    cursor = listed.cursor;
  }
  return false;
}

// OAuth grants and tokens of removed contributors. The OAuth library keeps them in OAUTH_KV as grant:<userId>:<grantId> and
// token:<userId>:<grantId>:<id> (userId is "c" + the contributor id); a grant is what lets a refresh token mint new access tokens.
// The authoritative marker is the contributor row (removed = 1: every MCP call refuses it) and the oauth_purge row. This deletes the
// KV records and is safe to repeat. The queue row stays for a day after a successful pass and the hourly job runs it again, so a
// token refresh that raced the deletion is swept up too. Without an OAUTH_KV binding nothing can be done and the rows stay queued.
export async function purgeOAuthState(env, now = Date.now()) {
  if (!env.OAUTH_KV) return { purged: 0, pending: 0 };
  const { results } = await env.DB.prepare('SELECT contributor, created FROM oauth_purge ORDER BY created LIMIT 200').all();
  let purged = 0, pending = 0;
  for (const r of results) {
    let ok = false;
    try { ok = (await deletePrefix(env.OAUTH_KV, `grant:c${r.contributor}:`)) && (await deletePrefix(env.OAUTH_KV, `token:c${r.contributor}:`)); } catch { ok = false; }
    if (!ok) { pending++; continue; }
    purged++;
    if (r.created < now - 86400000) await env.DB.prepare('DELETE FROM oauth_purge WHERE contributor = ?1').bind(r.contributor).run();
  }
  return { purged, pending };
}

// Replace a contributor's handle with a random tombstone. The contributor keeps working with the same key; it is just no longer
// named. Past events lose the handle too, and the change is recorded with no detail. Returns the new handle.
export async function removeHandle(env, contributor) {
  const handle = tombstone('anon');
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE events SET actor = NULL WHERE contributor = ?1 AND actor = (SELECT handle FROM contributors WHERE id = ?1 AND removed = 0)`
    ).bind(contributor),
    env.DB.prepare("UPDATE contributors SET handle = ?2, credit = 'anonymous', github = NULL WHERE id = ?1 AND removed = 0").bind(contributor, handle),
    env.DB.prepare("INSERT INTO events (ts, type, actor, detail) SELECT ?1, 'handle_removed', 'system', NULL WHERE changes() > 0").bind(Date.now()),
  ]);
  return res[1].meta.changes ? handle : null;
}
