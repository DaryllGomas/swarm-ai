// Swarm AI hub: static site (public/ via ASSETS) + MCP at /mcp + JSON API at /api/* + D1.
// Swarm never publishes into a project; submissions wait for a person to review them.
import { handleAccount } from './accounts.js';
import { handleMe } from './me.js';
import { handleAuthorize, oauthEnabled, providerFor } from './oauth.js';
import { handleVoting, publishSnapshot } from './voting.js';
import { expireClaims, weekStats } from './core.js';
import { adminActivateProject, adminRegisterGithub, handleGithubWebhook } from './github.js';
import { handleMcp } from './mcp.js';
import { UNTRUSTED, syncIfStale, syncTasks } from './sync.js';
import { SECURITY_HEADERS, clean, ipHashFor, isAdmin, iso, isoDay, json, underRateLimit } from './lib.js';
import { adminHeld, adminPending, adminReview, adminSubmission, adminPublished } from './admin.js';
import { handleOps } from './ops.js';
import { creditedAs, forgetNetworks, publicHandle } from './privacy.js';
import { analytics, runWeeklyMaintenance } from './rollup.js';
import { securityTxt, transparencyJson, transparencyPage, versionInfo } from './trust.js';
import { normalizeClient, setupGuide } from './setup.js';

// Requests the OAuth provider owns: discovery metadata, registration, the token endpoint, /authorize (through its default
// handler) and /mcp when it carries an OAuth access token. A request with no Authorization header, or a Swarm contributor key
// (swk_...), never goes through the provider, so public tools and existing keys work exactly as before.
function isOAuthRoute(req, url) {
  const p = url.pathname;
  if (p === '/authorize' || p.startsWith('/oauth/') || p.startsWith('/.well-known/oauth-')) return true;
  if (p === '/mcp' || p.startsWith('/mcp/')) return /^Bearer\s+(?!swk_)\S/i.test(req.headers.get('Authorization') || '');
  return false;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (oauthEnabled(env) && isOAuthRoute(req, url)) {
      try {
        // Registration and token calls are open to the internet: one burst limit per network, like every other write.
        // GET /authorize writes a consent transaction to KV, so it is limited too, before anything is written.
        const limited = (url.pathname.startsWith('/oauth/') && req.method === 'POST') || (url.pathname === '/authorize' && req.method === 'GET');
        if (limited && !(await underRateLimit(env, await ipHashFor(env, req)))) return json({ error: 'Slow down.' }, 429, { 'Cache-Control': 'no-store' });
        return await providerFor(env, (r, e, c) => handleMcp(r, e, c), (r, e, c) => app(r, e, c)).fetch(req, env, ctx);
      } catch (err) {
        console.error(err);
        return json({ error: 'Something went wrong. Try again in a moment.' }, 500);
      }
    }
    return app(req, env, ctx);
  },

  // Hourly: free up expired claims and pull fresh tasks from Town Hall.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      // First, and on its own: forgetting must not wait on, or be skipped by, anything else the job does.
      try { await forgetNetworks(env); } catch (err) { console.error('forgetNetworks failed:', String(err?.message || err).slice(0, 300)); }
      await publishSnapshot(env);
      try { await runWeeklyMaintenance(env); } catch (err) { console.error('weekly maintenance failed:', String(err?.message || err).slice(0, 300)); }
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE expires <= ?1').bind(now),
        env.DB.prepare('DELETE FROM account_challenges WHERE expires <= ?1').bind(now),
        env.DB.prepare('DELETE FROM link_codes WHERE expires <= ?1').bind(now),
        env.DB.prepare('DELETE FROM link_attempts WHERE ts <= ?1').bind(now - 86400000),
      ]);
      await expireClaims(env);
      await syncTasks(env, { force: true });
    })());
  },
};

// Everything the Worker serves itself; anything else is a static file from the site.
async function app(req, env, ctx) {
  const url = new URL(req.url);
  try {
    if (url.pathname.startsWith('/ops') || url.pathname === '/api/ops' || url.pathname.startsWith('/api/ops/')) return await handleOps(req, env, url);
    if (url.pathname === '/mcp') return await handleMcp(req, env, ctx);
    if (url.pathname === '/authorize') return await handleAuthorize(req, env);
    if (url.pathname === '/setup' || url.pathname === '/llms.txt') return setupText(req, url);
    if (url.pathname === '/version') return plain(req, () => json(versionInfo(env), 200, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }));
    if (url.pathname === '/.well-known/security.txt') return plain(req, () => new Response(securityTxt(), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*', ...SECURITY_HEADERS } }));
    if (url.pathname === '/transparency' || url.pathname === '/transparency.html') return await transparencyPage(req, env, url);
    if (url.pathname.startsWith('/api/')) return await api(req, env, ctx, url);
  } catch (err) {
    console.error(err);
    return json({ error: 'Something went wrong. Try again in a moment.' }, 500);
  }
  return env.ASSETS.fetch(req);
}

// GET and HEAD only, for the few small public routes the Worker answers itself.
function plain(req, make) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'Use GET.' }, 405, { Allow: 'GET, HEAD' });
  const res = make();
  return req.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
}

// The plain-text set-up guide for AI agents. /llms.txt is the same text; ?client=claude-code (and friends) tailors it.
function setupText(req, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Use GET.\n', { status: 405, headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' } });
  const client = normalizeClient(url.searchParams.get('client'));
  return new Response(req.method === 'HEAD' ? null : setupGuide(client), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*', ...SECURITY_HEADERS },
  });
}

async function api(req, env, ctx, url) {
  const path = url.pathname;
  if (path.startsWith('/api/account/')) return handleAccount(req, env, path);
  if (path === '/api/me' || path.startsWith('/api/me/')) return handleMe(req, env, path);
  if (path === '/api/ballot' || path.startsWith('/api/vote/')) return handleVoting(req, env, path);
  if (path === '/api/github/webhook') return handleGithubWebhook(req, env, ctx); // 404 until GITHUB_WEBHOOK_SECRET is set
  if (path.startsWith('/api/admin/')) {
    if (!(await isAdmin(req, env))) return json({ error: 'not found' }, 404);
    if (!(await underRateLimit(env, await ipHashFor(env, req)))) return json({ error: 'Slow down.' }, 429);
    if (path === '/api/admin/submission' && req.method === 'GET') return adminSubmission(env, url);
    if (path === '/api/admin/published' && req.method === 'POST') return adminPublished(req, env);
    if (path === '/api/admin/pending' && req.method === 'GET') return adminPending(env);
    if (path === '/api/admin/held' && req.method === 'GET') return adminHeld(env);
    if (path === '/api/admin/review' && req.method === 'POST') return adminReview(req, env);
    if (path === '/api/admin/sync' && req.method === 'POST') return json(await syncTasks(env, { force: true }));
    if (path === '/api/admin/projects/github' && req.method === 'POST') return adminRegisterGithub(req, env);
    const act = path.match(/^\/api\/admin\/projects\/([a-z0-9][a-z0-9-]{0,59})\/activate$/);
    if (act && req.method === 'POST') return adminActivateProject(env, ctx, act[1]);
    return json({ error: 'not found' }, 404);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'Use GET.' }, 405, { Allow: 'GET, HEAD' });
  if (!env.DB) return json({ error: 'not configured' }, 500);

  if (path === '/api/stats') {
    await syncIfStale(env, ctx);
    await expireClaims(env);
    const paused = env.INTAKE === 'paused';
    return json({ ...(await weekStats(env)), intake: paused ? 'paused' : 'open', paused, paused_note: paused ? 'Swarm is paused for maintenance. New pairings, claims and submissions are off; everything else still works.' : null }, 200, { 'Cache-Control': 'public, max-age=30' });
  }
  if (path === '/api/receipts') return receipts(env, url);
  if (path === '/api/analytics') return analytics(env, url);
  if (path === '/api/transparency') return json(transparencyJson(), 200, { 'Cache-Control': 'public, max-age=300' });
  if (path === '/api/tasks') return tasks(env, ctx, url);
  const m = path.match(/^\/api\/tasks\/(\d{1,9})$/);
  if (m) return oneTask(env, Number(m[1]));
  return json({ error: 'not found' }, 404);
}

// ---------------------------------------------------------------- public

async function receipts(env, url) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '10', 10) || 10, 1), 50);
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.task, t.title, t.units, t.kind, t.project, p.name AS project_name, p.repo, c.handle, c.credit, c.removed, s.reviewed_by, s.reviewed_at,
            s.sources, s.pr_number, s.pr_author, s.published_url, s.published_at
     FROM submissions s JOIN tasks t ON t.id = s.task JOIN projects p ON p.id = t.project JOIN contributors c ON c.id = s.contributor
     WHERE s.status = 'accepted' ORDER BY s.reviewed_at DESC, s.id DESC LIMIT ?1`
  ).bind(limit).all();
  return json({
    updated: new Date().toISOString(),
    note: 'Accepted means a project reviewer accepted it. A contributor is named only if they chose to be credited by their handle. Dates are the UTC day; no times, models or token figures are published. A pull request\'s author is public on GitHub itself.',
    notice: UNTRUSTED,
    receipts: results.map((r) => ({
      id: r.id,
      task: { id: r.task, title: r.title, kind: r.kind, units: r.units },
      project: { id: r.project, name: r.project_name },
      // Computed at read time: "a contributor" unless this contributor chose to be credited by their handle (so switching to
      // anonymous also hides the handle on past receipts), and "removed contributor" once their account was deleted.
      credited_as: creditedAs(r),
      handle: publicHandle(r),
      reviewed_by: r.reviewed_by,
      reviewed_at: isoDay(r.reviewed_at),
      publication: r.published_url ? { status: 'published', url: r.published_url, published_at: isoDay(r.published_at) } : null,
      evidence: { task_url: `/api/tasks/${r.task}`, sources: JSON.parse(r.sources) },
      // A merged pull request: the link is always shown. GitHub itself shows who wrote it, and we cannot change that; Swarm repeats the
      // login only for a contributor who chose handle credit.
      ...(r.pr_number ? { github: { repo: r.repo, pr_number: r.pr_number, pr_author: publicHandle(r) ? r.pr_author : null, pr_url: `https://github.com/${r.repo}/pull/${r.pr_number}` } } : {}),
    })),
  }, 200, { 'Cache-Control': 'public, max-age=30' });
}

async function tasks(env, ctx, url) {
  await syncIfStale(env, ctx);
  await expireClaims(env);
  const project = clean(url.searchParams.get('project') || '', 60) || null;
  const status = url.searchParams.get('status') || null;
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 200);
  const { results } = await env.DB.prepare(
    `SELECT id, project, parent, kind, title, units, status, created FROM tasks
     WHERE status != 'held' AND held_reason IS NULL AND (?1 IS NULL OR project = ?1) AND (?2 IS NULL OR status = ?2) ORDER BY created, id LIMIT ?3`
  ).bind(project, status, limit).all();
  return json({ updated: new Date().toISOString(), notice: UNTRUSTED, tasks: results.map((t) => ({ ...t, created: iso(t.created) })) });
}

async function oneTask(env, id) {
  // Held tasks, and tasks closed while held (they keep their held_reason), are never served.
  const t = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?1 AND status != 'held' AND held_reason IS NULL").bind(id).first();
  if (!t) return json({ error: 'not available' }, 404);
  const { held_reason: _unused, ...pub } = t;
  // A closed task is history: title and status only, no brief.
  if (t.status === 'closed') { delete pub.brief; delete pub.output_format; }
  return json({ ...pub, created: iso(t.created), notice: UNTRUSTED, ...(t.status === 'closed' ? { note: 'This task is closed.' } : {}) });
}
