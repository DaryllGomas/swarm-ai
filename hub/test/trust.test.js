// Verifiable and accountable: /version, security.txt (RFC 9116), the transparency report, the footer on every page, the privacy page,
// the trust strip, and the promise that nothing blocks Tor or VPN users beyond the per-network caps.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { addTask, newUser, resetDb, send, tool } from './helpers.js';
import { SECURITY_TXT_EXPIRES, TRANSPARENCY_AS_OF, TRANSPARENCY_STALE_DAYS, fillTransparency, longDate, securityTxt, transparencyAgeDays, transparencyStatement, versionInfo } from '../src/trust.js';
import privacyHtml from '../public/privacy.html?raw';
import transparencyHtml from '../public/transparency.html?raw';
import securityHtml from '../public/security.html?raw';
import voteHtml from '../public/vote.html?raw';
import indexHtml from '../public/index.html?raw';
import commonJs from '../public/js/common.js?raw';
import voteJs from '../public/js/vote.js?raw';

const pages = import.meta.glob('../public/*.html', { query: '?raw', import: 'default', eager: true });
const sources = import.meta.glob('../src/*.js', { query: '?raw', import: 'default', eager: true });
const SHA = 'a'.repeat(40);

beforeEach(resetDb);

describe('GET /version', () => {
  it('returns the deployed commit and the build time', async () => {
    const res = await send('/version', {}, { GIT_COMMIT: SHA, BUILT_AT: '2026-10-20T12:34:56Z' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ commit: SHA, built_at: '2026-10-20T12:34:56.000Z' });
  });

  it('says null, not a guess, when nothing was injected, and ignores anything that is not a full commit hash', async () => {
    expect(await (await send('/version')).json()).toEqual({ commit: null, built_at: null });
    expect(versionInfo({ GIT_COMMIT: 'main', BUILT_AT: 'yesterday' })).toEqual({ commit: null, built_at: null });
    expect(versionInfo({ GIT_COMMIT: `${SHA}\n<script>` }).commit).toBeNull();
    expect(versionInfo({ GIT_COMMIT: 'A'.repeat(40) }).commit).toBeNull(); // lowercase hex only, as git prints it
  });

  it('answers HEAD, refuses writes, and is not behind the static site', async () => {
    expect((await send('/version', { method: 'HEAD' }, { GIT_COMMIT: SHA })).status).toBe(200);
    expect((await send('/version', { method: 'POST' })).status).toBe(405);
    expect((await send('/version', {}, { GIT_COMMIT: SHA })).headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('/.well-known/security.txt (RFC 9116)', () => {
  it('is plain text with Contact and Expires, in Field: value lines', async () => {
    const res = await send('/.well-known/security.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const text = await res.text();
    expect(text).toBe(securityTxt());
    expect(text.endsWith('\n')).toBe(true);
    const fields = text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => { const i = l.indexOf(': '); return [l.slice(0, i), l.slice(i + 2)]; });
    for (const [k, v] of fields) { expect(k, k).toMatch(/^[A-Z][A-Za-z-]+$/); expect(v.length, k).toBeGreaterThan(0); }
    const f = Object.fromEntries(fields);
    expect(f.Contact).toBe('https://github.com/DaryllGomas/swarm-ai/security/advisories/new');
    expect(f.Canonical).toBe('https://swarm.bigpicsolutions.com/.well-known/security.txt');
    expect(f.Policy).toBe('https://swarm.bigpicsolutions.com/security');
    expect(f['Preferred-Languages']).toBe('en');
    expect(fields.filter(([k]) => k === 'Expires')).toHaveLength(1); // exactly one Expires
    expect(fields.filter(([k]) => k === 'Contact')).toHaveLength(1);
  });

  it('has no personal email address, only a URI contact', async () => {
    const text = await (await send('/.well-known/security.txt')).text();
    expect(text).not.toMatch(/@/); expect(text).not.toMatch(/mailto:/i);
  });

  it('Expires is an ISO 8601 UTC time about a year after the report began (just under, as RFC 9116 asks)', () => {
    expect(SECURITY_TXT_EXPIRES).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const days = (Date.parse(SECURITY_TXT_EXPIRES) - Date.parse(`${TRANSPARENCY_AS_OF}T00:00:00Z`)) / 86400000;
    expect(days).toBeGreaterThan(360); expect(days).toBeLessThan(366);
  });

  it('answers HEAD and refuses writes', async () => {
    expect((await send('/.well-known/security.txt', { method: 'HEAD' })).status).toBe(200);
    expect((await send('/.well-known/security.txt', { method: 'POST' })).status).toBe(405);
  });
});

describe('/transparency', () => {
  it('is served with the dated statement filled in from the one constant', async () => {
    const res = await send('/transparency');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('Swarm AI has received no national security letters, gag orders or secret court orders.');
    expect(html).toContain(transparencyStatement());
    expect(html).toContain(`As of ${longDate(TRANSPARENCY_AS_OF)}, Swarm AI has received no national security letters`);
    expect(html).toContain(TRANSPARENCY_AS_OF);
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/); // every placeholder was filled
    expect(html).toMatch(/Legal requests received[\s\S]*0 as of/);
    expect(html).toMatch(/User data handed over<\/th><td>nothing/);
  });

  it('keeps the date in one place: the page file holds only placeholders', () => {
    expect(transparencyHtml).toContain('{{STATEMENT}}'); expect(transparencyHtml).toContain('{{AS_OF}}');
    expect(transparencyHtml).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(transparencyHtml).not.toMatch(/\b\d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) 20\d\d/);
  });

  it('explains that it is re-dated every month and that a lapse is meaningful', () => {
    expect(transparencyHtml).toMatch(/re-dated every month/i);
    expect(transparencyHtml).toMatch(/lapse/i);
    expect(transparencyHtml).toMatch(/gag order/i);
  });

  it('warns on its own once the date is overdue, and not before', () => {
    const asOf = '2026-10-20', at = (days) => Date.parse(`${asOf}T00:00:00Z`) + days * 86400000;
    expect(transparencyAgeDays(at(0), asOf)).toBe(0);
    expect(fillTransparency(transparencyHtml, at(10), asOf)).not.toContain('This statement is overdue');
    expect(fillTransparency(transparencyHtml, at(TRANSPARENCY_STALE_DAYS), asOf)).not.toContain('This statement is overdue');
    const late = fillTransparency(transparencyHtml, at(TRANSPARENCY_STALE_DAYS + 1), asOf);
    expect(late).toContain('This statement is overdue');
    expect(late).toContain('20 October 2026');
    expect(fillTransparency(transparencyHtml, at(0), asOf)).toContain('As of 20 October 2026, Swarm AI has received no national security letters');
  });

  it('/transparency.html redirects to /transparency; writes are refused; the JSON twin agrees', async () => {
    const r = await send('/transparency.html', { redirect: 'manual' });
    expect(r.status).toBe(308); expect(new URL(r.headers.get('Location')).pathname).toBe('/transparency');
    expect((await send('/transparency', { method: 'POST' })).status).toBe(405);
    const j = await (await send('/api/transparency')).json();
    expect(j).toMatchObject({ as_of: TRANSPARENCY_AS_OF, legal_requests_received: 0, data_handed_over: 'nothing', redated_monthly: true });
    expect(j.statement).toBe(transparencyStatement());
  });
});

describe('footers and pages', () => {
  const names = Object.keys(pages).filter((p) => !p.endsWith('/ops/index.html'));

  it('every public page has Privacy, Transparency, Security and Rules in its footer', () => {
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const name of names) {
      const html = pages[name];
      const foot = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
      expect(foot.length, name).toBeGreaterThan(50);
      for (const link of ['/privacy', '/transparency', '/security', '/rules']) expect(foot, `${name} footer has ${link}`).toContain(`<a href="${link}">`);
      expect(html, name).toContain('<p class="foot-note">');
    }
  });

  it('the new pages exist, are static, have no inline script or handler, and load only same-origin scripts', () => {
    for (const [name, html] of [['privacy', privacyHtml], ['transparency', transparencyHtml], ['security', securityHtml]]) {
      expect(html, name).not.toMatch(/<script(?![^>]*\bsrc=)/i);
      expect(html, name).not.toMatch(/\son[a-z]+=/i);
      for (const m of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) expect(m[1].startsWith('/js/'), `${name} ${m[1]}`).toBe(true);
      expect(html, name).not.toMatch(/innerHTML|eval\(|document\.write/);
      expect(html, name).toContain('class="wrap policy panel-card"'); // the same design system as Rules and Terms
    }
  });

  it('are served by the site', async () => {
    for (const path of ['/privacy', '/security', '/transparency']) {
      const res = await send(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('Content-Type'), path).toMatch(/text\/html/);
    }
  });

  it('render dynamic text with textContent only (common.js and vote.js)', () => {
    for (const [name, src] of [['common.js', commonJs], ['vote.js', voteJs]]) for (const banned of [/\.innerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /outerHTML/]) expect(src, `${name} ${banned}`).not.toMatch(banned);
  });

  it('the footer shows the running commit, linked to it on GitHub, only if it is a real commit hash', () => {
    expect(commonJs).toContain("/^[0-9a-f]{40}$/.test(v.commit)");
    expect(commonJs).toContain("'https://github.com/DaryllGomas/swarm-ai/commit/' + v.commit");
    expect(commonJs).toContain("getJson('/version')");
  });

  it('the home page has a trust strip near the connect card, linking to /privacy', () => {
    expect(indexHtml).toContain('<a href="/privacy">Anonymous by default · No names, emails or IPs stored · Your AI keys never touch Swarm · Open source</a>');
    expect(indexHtml.indexOf('trust-strip')).toBeLessThan(indexHtml.indexOf('id="connect"'));
    expect(indexHtml.indexOf('trust-strip')).toBeGreaterThan(indexHtml.indexOf('</section>')); // after the hero, right above the connect card
  });
});

describe('the privacy page', () => {
  const text = privacyHtml.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/\s+/g, ' ');

  it('is titled "Your anonymity is your choice" and describes the three tiers', () => {
    expect(privacyHtml).toMatch(/Your anonymity<br>is your choice/);
    for (const t of ['The public record', 'Running the system', 'Never collected']) expect(privacyHtml).toContain(t);
    expect(text).toMatch(/Names\. Email addresses\. Raw IP addresses\./);
  });

  it('has a table of what is stored, for how long and why', () => {
    expect(privacyHtml).toMatch(/<th scope="col">What<\/th><th scope="col">Tier<\/th><th scope="col">Kept for<\/th><th scope="col">Why<\/th>/);
    for (const row of ['Your handle', 'contributor key', 'Claims and submissions', 'event log', 'voter account', 'passkey', 'session', 'ballot versions', 'network code', 'research ID', 'Names, email addresses, raw IP addresses']) expect(text.toLowerCase(), row).toContain(row.toLowerCase());
    expect(text).toMatch(/Two days\. Then the key is deleted/);
  });

  it('explains the three choices with their defaults first, using the same sentences as the app', async () => {
    const { CHOICE_TEXT } = await import('../src/privacy.js');
    for (const group of Object.values(CHOICE_TEXT)) for (const sentence of Object.values(group)) expect(privacyHtml.replace(/&quot;/g, '"'), sentence).toContain(sentence.replace(/&/g, '&amp;'));
    for (const d of ['Anonymous (default)', 'Private (default)', 'Totals only (default)']) expect(privacyHtml).toContain(d);
    expect(text).toMatch(/No such dataset has been published yet/);
  });

  it('says plainly what Swarm cannot protect against', () => {
    expect(privacyHtml).toContain('What Swarm cannot protect against');
    expect(text).toMatch(/Cloudflare[^.]*sees traffic and IP addresses in transit[^.]*legally compelled/);
    expect(text).toMatch(/Your AI provider sees what your AI does/);
    expect(text).toMatch(/GitHub shows pull request authors/);
    expect(text).toMatch(/operator can be compelled to hand over what is stored/);
    expect(text).toMatch(/network codes older than two days are irreversible/);
    expect(text).toMatch(/Ballots are tied to a random voter number/);
    expect(text).toMatch(/never with a name, an email or an IP address/);
    expect(text).toMatch(/cannot make you invisible/);
  });

  it('says how to protect yourself, and that Tor and VPN users are not blocked', () => {
    for (const tip of [/Use a VPN or Tor/, /separate GitHub account for GitHub tasks/, /Keep anonymous credit/, /Never put personal details in submissions/, /separate browser profile/]) expect(text).toMatch(tip);
    expect(text).toMatch(/Nothing in Swarm blocks them beyond the same per-network limits/);
    expect(text).toMatch(/human check[^.]*extra challenge/);
  });

  it('links to /transparency and /security, and to the developer data policy', () => {
    expect(privacyHtml).toContain('href="/transparency"'); expect(privacyHtml).toContain('href="/security"');
    expect(privacyHtml).toContain('docs/DATA-POLICY.md');
  });

  it('does not overclaim: no "untraceable", "anonymous network" or guarantee words', () => {
    for (const word of [/untraceable/i, /unbreakable/i, /100% (anonymous|private|secure)/i, /completely anonymous/i, /guarantee[sd]? (your )?(anonymity|privacy)/i]) expect(text).not.toMatch(word);
  });

  it('the voter sign-up shows the choices and the Tor note, and the page links to the privacy page', () => {
    expect(voteHtml).toContain('id="signup-choices"');
    expect(voteHtml).toMatch(/Tor or some VPNs for an extra challenge/);
    expect(voteJs).toContain("S.privacyChoices('signup'");
    expect(voteJs).toContain('privacy: signupChoices.get()');
    expect(commonJs).toContain("a.href = '/privacy'");
  });
});

describe('the security page', () => {
  const text = securityHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  it('reports through GitHub private vulnerability reporting, with no personal email', () => {
    expect(securityHtml).toContain('https://github.com/DaryllGomas/swarm-ai/security/advisories/new');
    expect(text).toMatch(/private vulnerability reporting/);
    expect(securityHtml).not.toMatch(/mailto:/); expect(securityHtml).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    expect(text).toMatch(/no email address for security reports/);
    expect(securityHtml).toContain('/.well-known/security.txt');
  });
  it('has a safe harbor: no legal action, coordinated disclosure, local copies only, never other users\' data', () => {
    expect(text).toMatch(/will not take legal action/);
    expect(text).toMatch(/Coordinated disclosure[\s\S]*90 days/);
    expect(text).toMatch(/Test against local copies/);
    expect(text).toMatch(/Never touch other users' data/);
  });
  it('states its scope and a brief security model, including the four independent reviews', () => {
    expect(text).toMatch(/In scope/); expect(text).toMatch(/Out of scope/);
    expect(text).toMatch(/No custody of AI credentials/); expect(text).toMatch(/Hashed keys/);
    expect(text).toMatch(/Four independent code reviews by Codex/);
    expect(text).toMatch(/The four review reports exist/);
    expect(text).toMatch(/not a guarantee/);
  });
});

describe('Tor and VPN friendliness', () => {
  it('nothing in the code looks at who a caller is beyond its network: no country, ASN, threat score, user agent or proxy-header checks', () => {
    const banned = [/CF-IPCountry/i, /\.country\b/, /\bcf\.(asn|country|threat|botManagement|colo|city|region)/i, /request\.cf\b/, /\breq\.cf\b/, /threatScore|bot_?management|\bisTor\b|\btorExit|tor-exit|\btor_exit/i, /X-Forwarded-For/i, /\buser-?agent\b[^\n]*(block|deny|refuse|reject|ban)/i, /\bblocklist|denylist|blacklist/i];
    for (const [file, src] of Object.entries(sources)) for (const re of banned) expect(src, `${file} ${re}`).not.toMatch(re);
  });

  it('IPv6 callers, callers behind a shared exit, and callers with no address at all can pair and work', async () => {
    for (const ip of ['2001:db8:abcd:12::1', '2a0b:f4c2:2::1', '185.220.101.5']) {
      const u = await newUser({ ip });
      const t = await addTask();
      expect((await u.call('claim_task', { id: t })).isError, ip).toBe(false);
    }
    const nobody = await tool('pair', {}, { ip: '' });
    expect(nobody.isError).toBe(false);
  });

  it('a shared exit address is limited only by the per-network caps, and says so', async () => {
    const exit = '185.220.101.77';
    for (let i = 0; i < 5; i++) expect((await tool('pair', {}, { ip: exit })).isError).toBe(false);
    const sixth = await tool('pair', {}, { ip: exit });
    expect(sixth.isError).toBe(true); expect(sixth.text).toMatch(/Too many pairings from this network/);
    expect((await tool('pair', {}, { ip: '185.220.101.78' })).isError).toBe(false); // a different exit is unaffected
  });

  it('the account-creation human check is Turnstile, which can show Tor users a challenge; nothing else gates sign-up', async () => {
    expect(privacyHtml).toMatch(/Cloudflare, which may give people on Tor or some VPNs an extra challenge/);
    expect(env.TURNSTILE_SITE_KEY).toBeTruthy();
  });
});
