// "Your Swarm": the signed-in voter's own page data. GET /api/me, and the writes POST /api/me/link-code, /unlink and /fallback.
// Every write needs the exact Origin and X-Swarm: 1 (writeGuard) and a session cookie. Nothing here is public: it is the
// voter's own ballot, link and week.
import { expireClaims } from './core.js';
import { cookieValue, privateJson, session, writeGuard } from './accounts.js';
import { readJson } from './lib.js';
import { CHOICE_TEXT, choicesOf, contributorsOfAccount, deleteAccount, parseChoices, removeHandle, saveChoices } from './privacy.js';
import { ballotShares, createLinkCode, linkOfAccount, unlinkAccount, weekSummary } from './steering.js';

export async function handleMe(req, env, path) {
  if (path === '/api/me') {
    if (req.method !== 'GET') return privateJson({ error: 'Use GET.' }, 405);
    return meView(req, env);
  }
  if (!['/api/me/link-code', '/api/me/unlink', '/api/me/fallback', '/api/me/privacy', '/api/me/delete', '/api/me/remove-handle'].includes(path)) return privateJson({ error: 'not found' }, 404);
  if (req.method !== 'POST') return privateJson({ error: 'Use POST.' }, 405);
  const guard = await writeGuard(req, env); if (guard) return guard;
  const a = await session(req, env);
  if (!a) return privateJson({ error: 'Sign in first.' }, 401);

  if (path === '/api/me/link-code') {
    const made = await createLinkCode(env, a.id);
    return privateJson({ ...made, note: 'Tell your AI: "Link my Swarm account with code ' + made.code + '". It works once and expires in 10 minutes. Creating a new code cancels this one.' });
  }
  if (path === '/api/me/unlink') {
    const was = await unlinkAccount(env, a.id);
    return privateJson({ linked: false, was_linked: was });
  }
  if (path === '/api/me/privacy') {
    const b = await readJson(req, 512);
    const parsed = b ? parseChoices(b) : { error: 'Send {"credit": ..., "history": ..., "research": ...} (any of them).' };
    if (parsed.error) return privateJson({ error: parsed.error }, 400);
    if (!Object.keys(parsed.choices).length) return privateJson({ error: 'Send at least one of credit, history, research.' }, 400);
    return privateJson({ privacy: await privacyView(env, await saveChoices(env, a.id, parsed.choices)) });
  }
  if (path === '/api/me/remove-handle') {
    // Every contributor of this account gets a random tombstone for a handle. Nothing else about the account changes.
    const ids = await contributorsOfAccount(env, a.id);
    let removed = 0;
    for (const id of ids) if (await removeHandle(env, id)) removed++;
    return privateJson({ removed, note: removed ? 'Your handle is gone. Your AI keeps working under a random name, and past events no longer carry the old handle.' : 'You have no linked AI with a handle.' });
  }
  if (path === '/api/me/delete') {
    const b = await readJson(req, 512);
    if (b?.confirm !== 'delete my account') return privateJson({ error: 'Send {"confirm": "delete my account"} to confirm. This cannot be undone.' }, 400);
    const r = await deleteAccount(env, a.id);
    return privateJson({ deleted: r.deleted, note: 'Your account, passkeys and sessions are gone. Your accepted work stays credited to its project as "removed contributor". Your ballots are anonymised; past weekly totals are unchanged.' }, 200, { 'Set-Cookie': cookieValue('swarm_sid', '', 0) });
  }
  const body = await readJson(req, 512);
  if (!body || typeof body.enabled !== 'boolean') return privateJson({ error: 'Send {"enabled": true} or {"enabled": false}.' }, 400);
  await env.DB.prepare('UPDATE accounts SET fallback = ?2 WHERE id = ?1 AND suspended = 0').bind(a.id, body.enabled ? 1 : 0).run();
  return privateJson({ fallback: body.enabled });
}

async function meView(req, env) {
  const a = await session(req, env);
  if (!a) return privateJson({ signed_in: false });
  await expireClaims(env);
  const [acct, link, ballot, projects, choices] = await Promise.all([
    env.DB.prepare('SELECT fallback FROM accounts WHERE id = ?1').bind(a.id).first(),
    linkOfAccount(env, a.id),
    ballotShares(env, a.id),
    env.DB.prepare('SELECT id, name FROM projects WHERE active = 1 ORDER BY name').all(),
    choicesOf(env, a.id),
  ]);
  const raw = await env.DB.prepare('SELECT allocations, version FROM ballot_versions WHERE account = ?1 ORDER BY version DESC LIMIT 1').bind(a.id).first();
  const names = Object.fromEntries(projects.results.map((p) => [p.id, p.name]));
  return privateJson({
    signed_in: true,
    account_id_short: a.id.slice(0, 8),
    fallback: !!acct.fallback,
    privacy: await privacyView(env, choices),
    fallback_note: 'When none of your ballot\'s projects has eligible work, your AI takes work from the public allocation instead, and that work is recorded as public-routed. Turn this off and your AI gets "no eligible work" instead.',
    ballot: raw ? {
      version: raw.version,
      points: Object.entries(JSON.parse(raw.allocations)).map(([id, points]) => ({ project: id, name: names[id] ?? id, points, active: id in names })),
      steers: !!ballot,
    } : null,
    linked: link ? { handle: link.handle, linked_at: new Date(link.linked_at).toISOString(), via: link.via } : null,
    week: link ? await weekSummary(env, link.id) : null,
  });
}

// The three choices with the sentence that explains each value, for the page.
async function privacyView(env, choices) {
  return {
    ...choices,
    explain: Object.fromEntries(Object.keys(CHOICE_TEXT).map((k) => [k, CHOICE_TEXT[k][choices[k]]])),
    values: Object.fromEntries(Object.entries(CHOICE_TEXT).map(([k, v]) => [k, Object.entries(v).map(([value, text]) => ({ value, text }))])),
    policy: '/privacy',
  };
}
