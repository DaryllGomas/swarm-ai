// Pre-screen for a submission's source links. Hard rules reject what can never be a public web page (other schemes,
// credentials in the link, localhost and private addresses). Everything merely suspicious is FLAGGED for the reviewer
// and never blocks the submission: plain http, IP-literal hosts, link shorteners, punycode hosts, very long lists.

export class LinkError extends Error {}

export const MAX_URL_CHARS = 300;
export const MANY_SOURCES = 20; // more than this many sources is flagged

export const SHORTENERS = new Set([
  'bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly',
  'rebrand.ly', 'cutt.ly', 'shorturl.at', 'tiny.cc', 'rb.gy', 'lnkd.in', 's.id',
]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function privateIpv4(host) {
  const [a, b] = host.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function privateIpv6(host) {
  const h = host.slice(1, -1).toLowerCase();
  return h === '::' || h === '::1' || /^(?:fc|fd|fe[89ab])/.test(h) || h.startsWith('::ffff:');
}

// One source link: { href, flags } or a LinkError for something that is not a usable public link.
export function screenLink(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_URL_CHARS) throw new LinkError(`Each source must be a link of at most ${MAX_URL_CHARS} characters.`);
  let url;
  try { url = new URL(raw.trim()); } catch { throw new LinkError(`Not a valid link: ${raw.slice(0, 60).replace(/[^\x20-\x7e]/g, '?')}`); }
  const host = url.hostname.toLowerCase();
  const shown = raw.slice(0, 60).replace(/[^\x20-\x7e]/g, '?');
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) throw new LinkError(`Sources must be plain web links without a login in them: ${shown}`);
  const v6 = host.startsWith('[');
  const v4 = IPV4.test(host);
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') ||
      (v4 && privateIpv4(host)) || (v6 && privateIpv6(host)) || (!v4 && !v6 && !host.includes('.'))) {
    throw new LinkError(`That source is not a public website: ${shown}`);
  }
  const flags = [];
  if (url.protocol === 'http:') flags.push(`non_https:${host}`);
  if (v4 || v6) flags.push(`ip_literal:${host}`);
  if (SHORTENERS.has(host.replace(/^www\./, ''))) flags.push(`shortener:${host}`);
  if (host.split('.').some((label) => label.startsWith('xn--'))) flags.push(`punycode:${host}`);
  return { href: url.href, flags };
}

// A whole source list: normalized unique links plus the flags to show the reviewer.
export function screenSources(list) {
  const seen = new Map();
  for (const raw of list) {
    const { href, flags } = screenLink(raw);
    if (!seen.has(href)) seen.set(href, flags);
  }
  const flags = [...new Set([...seen.values()].flat())];
  if (seen.size > MANY_SOURCES) flags.push(`many_sources:${seen.size}`);
  return { sources: [...seen.keys()], flags };
}
