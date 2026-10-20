// Verifiable and accountable: what code is running (/version), how to report a vulnerability (security.txt), and the transparency report.

export const SITE = 'https://swarm.bigpicsolutions.com';
export const REPO = 'DaryllGomas/swarm-ai';
export const REPO_URL = `https://github.com/${REPO}`;

// ---------------------------------------------------------------- the transparency statement
// THE DATE OF THE STATEMENT ON /transparency. This is the one place it is set. Re-date it every month (docs/RUNBOOK.md, "Monthly:
// re-date the transparency report") after checking that it is still true. If nobody re-dates it, the page says so once it is more than
// TRANSPARENCY_STALE_DAYS old: a lapse is meaningful.
export const TRANSPARENCY_AS_OF = '2026-10-20';
export const TRANSPARENCY_STALE_DAYS = 45;
// Legal requests received since the report began, and what was handed over. Change these only if it stops being true, and say so on the page.
export const LEGAL_REQUESTS_RECEIVED = 0;
export const DATA_HANDED_OVER = 'nothing';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function longDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
export const transparencyStatement = (asOf = TRANSPARENCY_AS_OF) =>
  `As of ${longDate(asOf)}, Swarm AI has received no national security letters, gag orders or secret court orders.`;

export function transparencyAgeDays(now = Date.now(), asOf = TRANSPARENCY_AS_OF) {
  return Math.floor((now - Date.parse(`${asOf}T00:00:00Z`)) / 86400000);
}

// The static page /transparency.html has these placeholders; the Worker fills them so the date lives only in this file and the page
// needs no script to show it (it is read in browsers that run no JavaScript, such as Tor Browser's safest mode).
export function fillTransparency(html, now = Date.now(), asOf = TRANSPARENCY_AS_OF) {
  const stale = transparencyAgeDays(now, asOf) > TRANSPARENCY_STALE_DAYS;
  return html
    .replaceAll('{{AS_OF}}', asOf)
    .replaceAll('{{AS_OF_LONG}}', longDate(asOf))
    .replaceAll('{{STATEMENT}}', transparencyStatement(asOf))
    .replaceAll('{{REQUESTS}}', String(LEGAL_REQUESTS_RECEIVED))
    .replaceAll('{{HANDED_OVER}}', DATA_HANDED_OVER)
    .replaceAll('{{STALE_NOTICE}}', stale
      ? `<p class="overdue">This statement is overdue. It was last dated ${longDate(asOf)}, more than ${TRANSPARENCY_STALE_DAYS} days ago, and it is meant to be re-dated every month. Treat a lapse like this as meaningful: do not assume the statement still holds.</p>`
      : '');
}

export async function transparencyPage(req, env, url, now = Date.now()) {
  if (url.pathname === '/transparency.html') return Response.redirect(`${url.origin}/transparency`, 308);
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Use GET.\n', { status: 405, headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' } });
  const asset = await env.ASSETS.fetch(new Request(`${url.origin}/transparency`, { headers: req.headers }));
  if (!asset.ok) return asset;
  const headers = new Headers(asset.headers);
  headers.delete('Content-Length'); headers.delete('ETag');
  headers.set('Cache-Control', 'public, max-age=300');
  return new Response(req.method === 'HEAD' ? null : fillTransparency(await asset.text(), now), { status: 200, headers });
}

export function transparencyJson(now = Date.now()) {
  return {
    as_of: TRANSPARENCY_AS_OF,
    statement: transparencyStatement(),
    legal_requests_received: LEGAL_REQUESTS_RECEIVED,
    data_handed_over: DATA_HANDED_OVER,
    redated_monthly: true,
    days_since_dated: transparencyAgeDays(now),
    overdue: transparencyAgeDays(now) > TRANSPARENCY_STALE_DAYS,
    page: `${SITE}/transparency`,
  };
}

// ---------------------------------------------------------------- /version
// The commit is injected at deploy time (hub/scripts/deploy.sh passes --var GIT_COMMIT:<sha> and --var BUILT_AT:<time>), so what runs
// can be compared with the open source code. Without them (local development) both are null: nothing is guessed.
export function versionInfo(env) {
  const commit = /^[0-9a-f]{40}$/.test(env.GIT_COMMIT || '') ? env.GIT_COMMIT : null;
  const built = env.BUILT_AT && !Number.isNaN(Date.parse(env.BUILT_AT)) ? new Date(env.BUILT_AT).toISOString() : null;
  return { commit, built_at: built };
}

// ---------------------------------------------------------------- security.txt (RFC 9116)
// Expires is a fixed date just under a year after it was written; renew it yearly (docs/RUNBOOK.md, "Yearly").
export const SECURITY_TXT_EXPIRES = '2027-10-19T23:59:59.000Z';
export function securityTxt() {
  return [
    '# Swarm AI: how to report a security problem. Policy and safe harbor: ' + `${SITE}/security`,
    `Contact: ${REPO_URL}/security/advisories/new`,
    `Expires: ${SECURITY_TXT_EXPIRES}`,
    'Preferred-Languages: en',
    `Canonical: ${SITE}/.well-known/security.txt`,
    `Policy: ${SITE}/security`,
    '',
  ].join('\n');
}
