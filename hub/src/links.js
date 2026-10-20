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

// ---- host checks. Everything below works on the host with its trailing dot(s) removed and lowercased, so
// "localhost." and "LOCALHOST" are the same as "localhost".

const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa']; // the name itself and anything under it

// An IPv4 host in any notation the URL standard accepts: dotted decimal, but also one to four parts that may be
// decimal, octal (leading 0) or hex (0x), the last part filling the remaining bytes ("2130706433", "0x7f.1", "0177.1").
// Returns the four bytes, or null when the text is not a valid IPv4 address.
function parseIpv4(host) {
  const parts = host.split('.');
  if (parts.length > 4 || parts.some((p) => p === '')) return null;
  const nums = [];
  for (const p of parts) {
    let n;
    if (/^0x[0-9a-f]*$/.test(p)) n = p.length === 2 ? 0 : parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^\d+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  const last = nums.pop();
  if (nums.some((n) => n > 255) || last >= 256 ** (4 - nums.length)) return null;
  let value = last;
  nums.forEach((n, i) => { value += n * 256 ** (3 - i); });
  return [Math.floor(value / 16777216) % 256, Math.floor(value / 65536) % 256, Math.floor(value / 256) % 256, value % 256];
}

// A host whose last label is a number is an IPv4 address to the URL standard, and is never looked up as a name.
const ENDS_IN_NUMBER = /(?:^|\.)(?:\d+|0x[0-9a-f]*)$/;

function reservedIpv4([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||        // carrier-grade NAT
    (a === 169 && b === 254) ||                  // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||        // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19));       // benchmarking
}

// IPv6 as eight 16-bit groups (an embedded IPv4 tail counts as two), or null when it does not parse.
function parseIpv6(host) {
  let h = host;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (v4) {
    const bytes = parseIpv4(v4[1]);
    if (!bytes) return null;
    h = `${h.slice(0, -v4[1].length)}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const toGroups = (x) => (x === '' ? [] : x.split(':'));
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return null;
  const groups = [...head, ...Array(halves.length === 2 ? 8 - head.length - tail.length : 0).fill('0'), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function reservedIpv6(host) {
  const g = parseIpv6(host);
  if (!g) return true; // cannot read it, so do not trust it
  const zeroTo = (n) => g.slice(0, n).every((x) => x === 0);
  return zeroTo(6) ||                                          // ::, ::1 and IPv4-compatible ::a.b.c.d
    (zeroTo(5) && g[5] === 0xffff) ||                          // IPv4-mapped ::ffff:a.b.c.d
    (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) || // NAT64
    (g[0] & 0xfe00) === 0xfc00 ||                              // unique-local fc00::/7
    (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || // link-local fe80::/10, site-local fec0::/10
    (g[0] & 0xff00) === 0xff00 ||                              // multicast
    g[0] === 0x2002 || (g[0] === 0x2001 && g[1] === 0); // 6to4 and Teredo tunnels
}

// One source link: { href, flags } or a LinkError for something that is not a usable public link.
export function screenLink(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_URL_CHARS) throw new LinkError(`Each source must be a link of at most ${MAX_URL_CHARS} characters.`);
  let url;
  try { url = new URL(raw.trim()); } catch { throw new LinkError(`Not a valid link: ${raw.slice(0, 60).replace(/[^\x20-\x7e]/g, '?')}`); }
  const shown = raw.slice(0, 60).replace(/[^\x20-\x7e]/g, '?');
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) throw new LinkError(`Sources must be plain web links without a login in them: ${shown}`);
  const notPublic = new LinkError(`That source is not a public website: ${shown}`);

  // Trailing dots and case never change which machine a name means, so they are removed before every check.
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host || host.includes('..')) throw notPublic;

  const v6 = host.startsWith('[');
  let ip = null; // dotted IPv4 once the address is known to be one, in whatever notation it came
  if (v6) {
    if (reservedIpv6(host.slice(1, -1))) throw notPublic;
  } else if (ENDS_IN_NUMBER.test(host)) {
    const bytes = parseIpv4(host);
    if (!bytes || reservedIpv4(bytes)) throw notPublic;
    ip = bytes.join('.');
  } else if (!host.includes('.') || LOCAL_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) {
    throw notPublic;
  }

  const flags = [];
  if (url.protocol === 'http:') flags.push(`non_https:${ip ?? host}`);
  if (ip || v6) flags.push(`ip_literal:${ip ?? host}`);
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
