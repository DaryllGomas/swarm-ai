// Phase 4: "Your AI follows your vote". The link between a voter account and a contributor, the link codes that make it,
// the ballot that steers a linked contributor, and the weekly summary shown on /me and returned by the my_week tool.
//
// Honesty rules kept here:
//   - only public_routed claims are compared with the public allocation; ballot_directed and self_picked are reported apart;
//   - pending work is never counted as accepted; token figures are self-reported estimates and say so.
import { ORIGINS } from './core.js';
import { sha256, weekOf, weekStartMs, iso } from './lib.js';
import { UNTRUSTED } from './sync.js';

export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_LINK_FAILURES_PER_CONTRIBUTOR_PER_HOUR = 5;
export const MAX_LINK_FAILURES_PER_NETWORK_PER_HOUR = 20;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no I, O, 0 or 1: 32^8 codes, and 256 is a multiple of 32 so no bias
const CODE_SHAPE = /^SWARM-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

const codeHash = (env, code) => sha256(`${env.HASH_SALT}|linkcode|${code}`);

export function newLinkCode() {
  const pick = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `SWARM-${pick(4)}-${pick(4)}`;
}
export const normalizeCode = (code) => String(code ?? '').toUpperCase().replace(/\s+/g, '');

// ---------------------------------------------------------------- the link

export const linkOfAccount = (env, account) => env.DB.prepare(
  `SELECT l.contributor AS id, c.handle, l.linked_at, l.via FROM account_links l JOIN contributors c ON c.id = l.contributor WHERE l.account = ?1`
).bind(account).first();

export const linkOfContributor = (env, contributor) => env.DB.prepare(
  `SELECT l.account, a.fallback FROM account_links l JOIN accounts a ON a.id = l.account WHERE l.contributor = ?1 AND a.suspended = 0`
).bind(contributor).first();

// A new code for this account. Any earlier unused code of the account stops working. Returns the code (shown once) and its expiry.
export async function createLinkCode(env, account, now = Date.now()) {
  const code = newLinkCode();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM link_codes WHERE account = ?1 OR expires <= ?2').bind(account, now),
    env.DB.prepare('INSERT INTO link_codes (hash, account, created, expires) SELECT ?1, id, ?3, ?4 FROM accounts WHERE id = ?2 AND suspended = 0')
      .bind(await codeHash(env, code), account, now, now + LINK_CODE_TTL_MS),
  ]);
  return { code, expires_at: iso(now + LINK_CODE_TTL_MS) };
}

// Ownership is not the steering link. A contributor is OWNED by the account that created it (OAuth passkey mode) or by the first
// account it was linked to (contributors.owner_account, set once, never changed). The steering link (account_links) is what a
// voter may move; ownership is what OAuth passkey mode trusts. A link may make an unowned contributor owned, or relink a
// contributor to its own owner, and never takes a contributor from a different owner.
const ownerOk = (contributorParam, accountExpr) =>
  `NOT EXISTS (SELECT 1 FROM contributors o WHERE o.id = ${contributorParam} AND o.owner_account IS NOT NULL AND o.owner_account != ${accountExpr})`;

// The contributor an account owns, preferring the one its steering link points at. Used by OAuth passkey mode.
export const ownedContributor = (env, account) => env.DB.prepare(
  `SELECT c.id, c.handle FROM contributors c LEFT JOIN account_links l ON l.contributor = c.id AND l.account = ?1
   WHERE c.owner_account = ?1 ORDER BY (l.account IS NOT NULL) DESC, c.id LIMIT 1`
).bind(account).first();

// Redeem a code for a contributor. The attempt is RESERVED first, atomically: one conditional INSERT checks both budgets (this
// contributor's, and this network's today and yesterday, since the network hash rotates daily) and writes the attempt row in the
// same statement, so parallel guesses cannot all pass one stale count. A successful redemption gives its reservation back.
// Then one atomic batch: the code is found, the old link of the account and of the contributor are replaced (each replaced link
// writes an `account_unlinked` event), ownership is set if the contributor had none, the new link and its `account_linked`
// event are written, and the code is deleted. Two concurrent redemptions of one code cannot both succeed, and a contributor
// owned by another account is refused.
// Returns { ok: true } or { ok: false, reason: 'rate' | 'invalid' | 'owned' }.
export async function redeemLinkCode(env, contributor, networkHash, rawCode, now = Date.now(), prevNetworkHash = null) {
  const me = `c:${contributor}`, net = `n:${networkHash}`, prevNet = `n:${prevNetworkHash ?? networkHash}`;
  const [mineRes, netRes] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO link_attempts (who, ts) SELECT ?1, ?3
       WHERE (SELECT COUNT(*) FROM link_attempts WHERE who = ?1 AND ts > ?4) < ${MAX_LINK_FAILURES_PER_CONTRIBUTOR_PER_HOUR}
         AND (SELECT COUNT(*) FROM link_attempts WHERE who IN (?2, ?5) AND ts > ?4) < ${MAX_LINK_FAILURES_PER_NETWORK_PER_HOUR}`
    ).bind(me, net, now, now - 3600000, prevNet),
    env.DB.prepare('INSERT INTO link_attempts (who, ts) SELECT ?1, ?2 WHERE changes() > 0').bind(net, now),
  ]);
  if (!mineRes.meta.changes) return { ok: false, reason: 'rate' };
  const reserved = [mineRes.meta.last_row_id, netRes.meta.last_row_id];

  const code = normalizeCode(rawCode);
  const hash = CODE_SHAPE.test(code) ? await codeHash(env, code) : null;
  let linked = false;
  if (hash) {
    const valid = `EXISTS (SELECT 1 FROM link_codes k JOIN accounts a ON a.id = k.account WHERE k.hash = ?1 AND k.expires > ?2 AND a.suspended = 0 AND ${ownerOk('?3', 'k.account')})`;
    const codeAccount = '(SELECT account FROM link_codes WHERE hash = ?1)';
    const res = await env.DB.batch([
      // A link that is about to be replaced is recorded first (unless it is the very same pair).
      env.DB.prepare(
        `INSERT INTO events (ts, type, contributor, actor, detail)
         SELECT ?2, 'account_unlinked', l.contributor, 'system', json_object('account', substr(l.account, 1, 8), 'reason', 'replaced')
         FROM account_links l WHERE ${valid} AND (l.account = ${codeAccount} OR l.contributor = ?3) AND NOT (l.account = ${codeAccount} AND l.contributor = ?3)`
      ).bind(hash, now, contributor),
      env.DB.prepare(`DELETE FROM account_links WHERE ${valid} AND (account = ${codeAccount} OR contributor = ?3)`).bind(hash, now, contributor),
      env.DB.prepare(`UPDATE contributors SET owner_account = ${codeAccount} WHERE id = ?3 AND owner_account IS NULL AND ${valid}`).bind(hash, now, contributor),
      env.DB.prepare(
        `INSERT INTO account_links (account, contributor, linked_at, via)
         SELECT k.account, ?3, ?2, 'code' FROM link_codes k JOIN accounts a ON a.id = k.account
         WHERE k.hash = ?1 AND k.expires > ?2 AND a.suspended = 0 AND ${ownerOk('?3', 'k.account')}`
      ).bind(hash, now, contributor),
      env.DB.prepare(
        `INSERT INTO events (ts, type, contributor, actor, detail)
         SELECT ?2, 'account_linked', ?3, 'system', json_object('account', substr(account, 1, 8), 'via', 'code')
         FROM account_links WHERE contributor = ?3 AND linked_at = ?2 AND via = 'code'`
      ).bind(hash, now, contributor),
      env.DB.prepare("DELETE FROM link_codes WHERE hash = ?1 AND EXISTS (SELECT 1 FROM account_links WHERE contributor = ?3 AND linked_at = ?2 AND via = 'code')").bind(hash, now, contributor),
    ]);
    linked = res[3].meta.changes > 0;
  }
  if (linked) {
    await env.DB.prepare('DELETE FROM link_attempts WHERE id IN (?1, ?2)').bind(...reserved).run(); // a success is not a failure
    return { ok: true };
  }
  if (hash) {
    const owned = await env.DB.prepare(
      'SELECT 1 AS n FROM link_codes k JOIN contributors o ON o.id = ?3 WHERE k.hash = ?1 AND k.expires > ?2 AND o.owner_account IS NOT NULL AND o.owner_account != k.account'
    ).bind(hash, now, contributor).first();
    if (owned) return { ok: false, reason: 'owned' };
  }
  return { ok: false, reason: 'invalid' };
}

// Link a contributor to an account directly (the OAuth sign-in step, where the voter just proved their passkey).
// Replaces any earlier link of either side, with events, unless the contributor is owned by a different account.
// Returns true when the link now exists.
export async function linkDirect(env, account, contributor, via = 'oauth', now = Date.now()) {
  const ok = `EXISTS (SELECT 1 FROM accounts WHERE id = ?1 AND suspended = 0) AND ${ownerOk('?2', '?1')}`;
  const res = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events (ts, type, contributor, actor, detail)
       SELECT ?3, 'account_unlinked', l.contributor, 'system', json_object('account', substr(l.account, 1, 8), 'reason', 'replaced')
       FROM account_links l WHERE ${ok} AND (l.account = ?1 OR l.contributor = ?2) AND NOT (l.account = ?1 AND l.contributor = ?2)`
    ).bind(account, contributor, now),
    env.DB.prepare(`DELETE FROM account_links WHERE ${ok} AND (account = ?1 OR contributor = ?2) AND NOT (account = ?1 AND contributor = ?2)`).bind(account, contributor),
    env.DB.prepare(`UPDATE contributors SET owner_account = ?1 WHERE id = ?2 AND owner_account IS NULL AND ${ok}`).bind(account, contributor),
    env.DB.prepare(`INSERT OR IGNORE INTO account_links (account, contributor, linked_at, via) SELECT id, ?2, ?3, ?4 FROM accounts WHERE id = ?1 AND suspended = 0 AND ${ownerOk('?2', '?1')}`).bind(account, contributor, now, via),
    env.DB.prepare(
      `INSERT INTO events (ts, type, contributor, actor, detail)
       SELECT ?3, 'account_linked', ?2, 'system', json_object('account', substr(?1, 1, 8), 'via', ?4) WHERE changes() > 0`
    ).bind(account, contributor, now, via),
  ]);
  return res[3].meta.changes > 0;
}

export async function unlinkAccount(env, account, now = Date.now()) {
  const res = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events (ts, type, contributor, actor, detail)
       SELECT ?2, 'account_unlinked', contributor, 'voter', json_object('account', substr(account, 1, 8), 'reason', 'unlinked')
       FROM account_links WHERE account = ?1`
    ).bind(account, now),
    env.DB.prepare('DELETE FROM account_links WHERE account = ?1').bind(account),
  ]);
  return res[1].meta.changes > 0;
}

// ---------------------------------------------------------------- the ballot that steers

// The account's latest ballot as fractions that sum to 1, over projects that are active and got points. A project that has
// since been deactivated is dropped and the rest are rescaled: steering only needs a direction, and the vote snapshot (which does
// stay strict) is separate. Returns null when there is no usable ballot.
export async function ballotShares(env, account) {
  const row = await env.DB.prepare('SELECT allocations, version FROM ballot_versions WHERE account = ?1 ORDER BY version DESC LIMIT 1').bind(account).first();
  if (!row) return null;
  const { results } = await env.DB.prepare('SELECT id FROM projects WHERE active = 1').all();
  const active = new Set(results.map((r) => r.id));
  const points = Object.entries(JSON.parse(row.allocations)).filter(([id, v]) => active.has(id) && Number.isInteger(v) && v > 0);
  const total = points.reduce((a, [, v]) => a + v, 0);
  if (!total) return null;
  return { version: row.version, shares: Object.fromEntries(points.map(([id, v]) => [id, v / total])) };
}

// What steers this contributor: { account, fallback, shares } when linked to a live account with a usable ballot, else null.
export async function steeringFor(env, contributor) {
  const link = await linkOfContributor(env, contributor);
  if (!link) return null;
  const ballot = await ballotShares(env, link.account);
  if (!ballot) return null;
  return { account: link.account, fallback: !!link.fallback, shares: ballot.shares, version: ballot.version };
}

// Weighted deficit: the project furthest below its target share of the units counted so far goes first. Ties go to the larger target,
// then the id. `eligible` is a list of { id }; `shares` maps id to a fraction; `units` maps id to units already counted.
export function pickByDeficit(eligible, shares, units) {
  const total = Object.values(units).reduce((a, b) => a + b, 0);
  return eligible.map((p) => {
    const target = shares[p.id] || 0;
    const actual = total ? (units[p.id] || 0) / total : 0;
    return { p, target, actual, deficit: target - actual };
  }).sort((a, b) => b.deficit - a.deficit || b.target - a.target || a.p.id.localeCompare(b.p.id));
}

// ---------------------------------------------------------------- the week

const emptyBucket = () => ({ tasks: 0, units: 0 });
const emptyOrigin = () => ({ claimed: emptyBucket(), in_progress: emptyBucket(), submitted: emptyBucket(), awaiting_review: emptyBucket(), accepted: emptyBucket(), rejected: emptyBucket() });
const bump = (b, units) => { b.tasks += 1; b.units += units; };

// "Your week in the Swarm" for one contributor: claims made this week by routing origin, what became of them, per-project effort,
// accepted receipts, and self-reported token estimates. Expired claims are swept by the caller first.
export async function weekSummary(env, contributor, now = Date.now()) {
  const week = weekOf(now);
  const [claims, receipts, names, tokens] = await Promise.all([
    env.DB.prepare(
      `SELECT c.routing_origin AS origin, t.project AS project, t.id AS task, t.units AS units, c.outcome AS outcome, s.status AS sub
       FROM claims c JOIN tasks t ON t.id = c.task LEFT JOIN submissions s ON s.claim = c.id
       WHERE c.contributor = ?1 AND c.week = ?2 AND t.held_reason IS NULL ORDER BY c.id`
    ).bind(contributor, week).all(),
    env.DB.prepare(
      `SELECT s.id, s.task, t.title, t.units, t.project, p.name AS project_name, s.reviewed_at, s.reviewed_by, s.model, s.tokens_est, s.published_url, c.routing_origin AS origin
       FROM submissions s JOIN tasks t ON t.id = s.task JOIN projects p ON p.id = t.project JOIN claims c ON c.id = s.claim
       WHERE s.contributor = ?1 AND s.status = 'accepted' AND t.held_reason IS NULL ORDER BY s.reviewed_at DESC, s.id DESC LIMIT 10`
    ).bind(contributor).all(),
    env.DB.prepare('SELECT id, name FROM projects').all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS submissions, SUM(CASE WHEN tokens_est IS NOT NULL THEN 1 ELSE 0 END) AS reporting, COALESCE(SUM(tokens_est), 0) AS total
       FROM submissions WHERE contributor = ?1 AND created >= ?2`
    ).bind(contributor, weekStartMs(now)).first(),
  ]);
  const name = Object.fromEntries(names.results.map((r) => [r.id, r.name]));
  const byOrigin = Object.fromEntries(ORIGINS.map((o) => [o, emptyOrigin()]));
  const lost = Object.fromEntries(ORIGINS.map((o) => [o, emptyBucket()]));
  const projects = {};
  // One task by one contributor counts once per origin however often it was claimed and released: the standing claim wins.
  const seen = new Set();
  const standing = claims.results.filter((r) => r.outcome === null || r.outcome === 'submitted');
  for (const r of claims.results.filter((x) => x.outcome === 'released' || x.outcome === 'expired')) {
    if (standing.some((s) => s.task === r.task && s.origin === r.origin)) continue;
    const k = `lost:${r.origin}:${r.task}`;
    if (!seen.has(k)) { seen.add(k); bump(lost[r.origin], r.units); }
  }
  for (const r of standing) {
    const k = `${r.origin}:${r.task}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const o = byOrigin[r.origin];
    bump(o.claimed, r.units);
    const p = (projects[r.project] ??= { project: r.project, name: name[r.project] ?? r.project, units: Object.fromEntries(ORIGINS.map((x) => [x, 0])), accepted_units: 0 });
    p.units[r.origin] += r.units;
    if (r.outcome === null) bump(o.in_progress, r.units);
    else {
      bump(o.submitted, r.units);
      if (r.sub === 'pending') bump(o.awaiting_review, r.units);
      else if (r.sub === 'accepted') { bump(o.accepted, r.units); p.accepted_units += r.units; }
      else if (r.sub === 'rejected') bump(o.rejected, r.units);
    }
  }
  const directedTotal = Object.values(projects).reduce((a, p) => a + p.units.ballot_directed, 0);
  for (const p of Object.values(projects)) p.ballot_directed_share_pct = directedTotal ? Math.round((1000 * p.units.ballot_directed) / directedTotal) / 10 : 0;
  return {
    week,
    week_start: iso(weekStartMs(now)),
    by_origin: byOrigin,
    released_or_expired: lost,
    per_project: Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)),
    receipts: receipts.results.map((r) => ({
      id: r.id,
      task: { id: r.task, title: r.title, units: r.units },
      project: { id: r.project, name: r.project_name },
      routing_origin: r.origin,
      reviewed_by: r.reviewed_by,
      reviewed_at: iso(r.reviewed_at),
      evidence_url: `/api/tasks/${r.task}`,
      publication_url: r.published_url,
      self_reported: { model: r.model, tokens_est: r.tokens_est },
    })),
    self_reported_tokens_est: {
      total: tokens.total, submissions_reporting: tokens.reporting ?? 0, submissions_this_week: tokens.submissions,
      note: 'Estimates your AI reported itself when handing work in. They are not measured, are never used for routing or credit, and are not compute.',
    },
    notes: [
      'Claimed counts claims made this week that are still standing (in progress or handed in). Units, not compute.',
      'Awaiting review is part of submitted. Only work a reviewer accepted is shown as accepted; pending work is never shown as accepted.',
      'Only public-routed work is compared with the public vote. Ballot-directed work is yours, shown separately.',
    ],
    notice: UNTRUSTED,
  };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// A few plain sentences for an AI to tell the user, built only from the numbers above.
export function recapLines(summary) {
  const lines = [];
  const sumOf = (k, f) => ORIGINS.reduce((a, o) => a + summary.by_origin[o][k][f], 0);
  lines.push(`This week (from ${summary.week}) your AI claimed ${plural(sumOf('claimed', 'tasks'), 'task', 'tasks')} (${sumOf('claimed', 'units')} units): ${ORIGINS.map((o) => `${summary.by_origin[o].claimed.units} ${o.replace('_', '-')}`).join(', ')}.`);
  lines.push(`${plural(sumOf('submitted', 'tasks'), 'task was', 'tasks were')} handed in, ${sumOf('awaiting_review', 'tasks')} awaiting review (not accepted yet) and ${sumOf('accepted', 'tasks')} accepted by a reviewer.`);
  return lines;
}
