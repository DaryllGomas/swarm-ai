// Contributor identities: the one place a contributor row is created (the MCP `pair` tool and the OAuth authorize step
// both use it), and the handle rules.
import { eventStmt } from './core.js';
import { capHashes, sha256 } from './lib.js';

export const MAX_PAIRS_PER_NETWORK_PER_DAY = 5;
const RESERVED_EXACT = new Set(['swarm', 'daryll', 'null', 'undefined', 'anonymous', 'reviewer', 'bot', 'me', 'you', 'everyone', 'nobody', 'unknown', 'deleted', 'api', 'mcp']);
const RESERVED_PART = /(admin|moderator|official|staff|support|bigpic|system|root|swarmai|swarm-ai|townhall|town-hall|anthropic|openai|claude-team)/;

export class IdentityError extends Error {}

export const keyHash = (env, key) => sha256(`${env.HASH_SALT}|key|${key}`);

export function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function randomId(n) {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => a[b % a.length]).join('');
}
export const newKey = () => `swk_${b64url(crypto.getRandomValues(new Uint8Array(24)))}`;

// Throws IdentityError with the text to show when the handle cannot be used.
export function checkHandle(handle) {
  if (typeof handle !== 'string' || !/^[a-z0-9_-]{3,24}$/.test(handle)) throw new IdentityError('A handle is 3 to 24 characters: lowercase letters, digits, underscore or hyphen.');
  if (RESERVED_EXACT.has(handle) || RESERVED_PART.test(handle)) throw new IdentityError('That handle is reserved. Pick another.');
}

// Create a contributor (a pseudonymous handle and a key hash). Returns { id, handle, key }; the raw key exists only here and in
// the caller's hands. The daily per-network pairing cap is checked inside the INSERT, so concurrent calls cannot all pass.
export async function createContributor(env, req, ipHash, handle, ownerAccount = null) {
  if (handle !== undefined) checkHandle(handle);
  const key = newKey();
  const hash = await keyHash(env, key);
  // The network hash rotates daily, so count yesterday's too: pairing just before and after UTC midnight shares one cap.
  // (And the pre-0010 format of both, for rows written before the switch to day keys.)
  const net = await capHashes(env, req);
  for (let attempt = 0; attempt < 5; attempt++) {
    const h = handle ?? `helper-${randomId(6)}`;
    try {
      const now = Date.now();
      const res = await env.DB.prepare(
        `INSERT INTO contributors (handle, key_hash, created, pair_ip, owner_account)
         SELECT ?1, ?2, ?3, ?4, ?7
         WHERE (SELECT COUNT(*) FROM contributors WHERE pair_ip IN (?4, ?6, ?8, ?9) AND created >= ?5) < ${MAX_PAIRS_PER_NETWORK_PER_DAY}`
      ).bind(h, hash, now, ipHash, now - 86400000, net.yesterday, ownerAccount, net.legacyToday, net.legacyYesterday).run();
      if (!res.meta.changes) throw new IdentityError('Too many pairings from this network today. Try again tomorrow.');
      await eventStmt(env, { type: 'contributor_paired', contributor: res.meta.last_row_id, actor: 'system' }).run();
      return { id: res.meta.last_row_id, handle: h, key };
    } catch (err) {
      if (err instanceof IdentityError) throw err;
      if (!/UNIQUE/i.test(String(err.message))) throw err;
      if (handle) throw new IdentityError('That handle is taken. Pick another.');
    }
  }
  throw new IdentityError('Could not create a handle. Try again.');
}
