// Swarm AI hub: static site (public/ via ASSETS) + MCP at /mcp + JSON API at /api/* + D1.
// Swarm never publishes into a project; submissions wait for a person to review them.
import { handleAccount } from './accounts.js';
import { handleMe } from './me.js';
import { handleVoting, publishSnapshot } from './voting.js';
import { expireClaims, weekStats } from './core.js';
import { adminActivateProject, adminRegisterGithub, handleGithubWebhook } from './github.js';
import { handleMcp } from './mcp.js';
import { UNTRUSTED, syncIfStale, syncTasks } from './sync.js';
import { SECURITY_HEADERS, clean, ipHashFor, isAdmin, iso, json, underRateLimit } from './lib.js';
import { adminHeld, adminPending, adminReview, adminSubmission, adminPublished } from './admin.js';
import { handleOps } from './ops.js';
import { normalizeClient, setupGuide } from './setup.js';

export default {
  async fetch(req, env, ctx) {
    return app(req, env, ctx);
  },

  // Hourly: free up expired claims and pull fresh tasks from Town Hall.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      await publishSnapshot(env);
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
    if (url.pathname === '/setup' || url.pathname === '/llms.txt') return setupText(req, url);
    if (url.pathname.startsWith('/api/')) return await api(req, env, ctx, url);
  } catch (err) {
    console.error(err);
    return json({ error: 'Something went wrong. Try again in a moment.' }, 500);
  }
  return env.ASSETS.fetch(req);
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
  if (path === '/api/tasks') return tasks(env, ctx, url);
  const m = path.match(/^\/api\/tasks\/(\d{1,9})$/);
  if (m) return oneTask(env, Number(m[1]));
  return json({ error: 'not found' }, 404);
}

// ---------------------------------------------------------------- public

async function receipts(env, url) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '10', 10) || 10, 1), 50);
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.task, t.title, t.units, t.kind, t.project, p.name AS project_name, p.repo, c.handle, s.reviewed_by, s.reviewed_at,
            s.sources, s.model, s.tokens_est, s.pr_number, s.pr_author, s.published_url, s.published_at
     FROM submissions s JOIN tasks t ON t.id = s.task JOIN projects p ON p.id = t.project JOIN contributors c ON c.id = s.contributor
     WHERE s.status = 'accepted' ORDER BY s.reviewed_at DESC, s.id DESC LIMIT ?1`
  ).bind(limit).all();
  return json({
    updated: new Date().toISOString(),
    note: 'Accepted means a project reviewer accepted it. Model and token figures are self-reported by the contributor\'s agent.',
    notice: UNTRUSTED,
    receipts: results.map((r) => ({
      id: r.id,
      task: { id: r.task, title: r.title, kind: r.kind, units: r.units },
      project: { id: r.project, name: r.project_name },
      handle: r.handle,
      reviewed_by: r.reviewed_by,
      reviewed_at: iso(r.reviewed_at),
      publication: r.published_url ? { status: 'published', url: r.published_url, published_at: iso(r.published_at) } : null,
      self_reported: { model: r.model, tokens_est: r.tokens_est },
      evidence: { task_url: `/api/tasks/${r.task}`, sources: JSON.parse(r.sources) },
      // A merged pull request: credits the GitHub account that wrote it, beside the Swarm handle. The two need not match.
      ...(r.pr_number ? { github: { repo: r.repo, pr_number: r.pr_number, pr_author: r.pr_author, pr_url: `https://github.com/${r.repo}/pull/${r.pr_number}` } } : {}),
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
