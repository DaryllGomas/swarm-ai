import { describe, it, expect } from 'vitest';
import { LinkError, screenLink, screenSources } from '../src/links.js';

const rejects = (url) => expect(() => screenLink(url), url).toThrow(LinkError);

describe('screenLink: hosts that can never be a public page', () => {
  it('rejects localhost and local-only names, with or without a trailing dot, in any case', () => {
    for (const host of ['localhost', 'LOCALHOST', 'localhost.', 'localhost..', 'Localhost.', 'app.localhost', 'app.localhost.', 'a.b.localhost',
      'printer.local', 'printer.local.', 'NAS.LOCAL', 'db.internal', 'db.internal.', 'api.corp.internal', 'router.home.arpa', 'router.home.arpa.', 'home.arpa',
      'intranet', 'intranet.']) {
      for (const scheme of ['https', 'http']) {
        rejects(`${scheme}://${host}/`);
        rejects(`${scheme}://${host}:8080/path?q=1`);
      }
    }
  });

  it('rejects private, loopback, link-local, CGNAT and reserved IPv4, with or without a trailing dot', () => {
    for (const ip of ['0.0.0.0', '127.0.0.1', '127.1.2.3', '10.0.0.5', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '100.127.255.255', '224.0.0.1', '255.255.255.255', '192.0.0.1', '198.18.0.1', '198.19.255.255']) {
      rejects(`https://${ip}/`);
      rejects(`https://${ip}./`);
      rejects(`http://${ip}:3000/x`);
    }
  });

  it('rejects IPv4 written as decimal, octal, hex or short forms', () => {
    for (const host of ['2130706433', '0x7f000001', '0x7f.1', '0x7f.0.0.1', '0177.0.0.1', '0177.1', '017700000001', '127.1', '127.0.1', '3232235777', '0xc0a80101', '0300.0250.0.1',
      '2130706433.', '0x7f.1.', '167772165', '0xa000005', '2852039166', '0xA9FEA9FE', '10.1']) {
      rejects(`http://${host}/`);
      rejects(`https://${host}/x`);
    }
  });

  it('rejects IPv6 loopback, unspecified, link-local, unique-local and IPv4-mapped addresses', () => {
    for (const host of ['[::1]', '[::]', '[0:0:0:0:0:0:0:1]', '[fe80::1]', '[FE80::1]', '[febf::1]', '[fc00::1]', '[fd12:3456:789a::1]',
      '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:10.0.0.1]', '[::ffff:192.168.1.1]', '[::ffff:8.8.8.8]', '[0:0:0:0:0:ffff:7f00:1]', '[64:ff9b::7f00:1]', '[::127.0.0.1]', '[fec0::1]']) {
      rejects(`https://${host}/`);
      rejects(`http://${host}:8080/`);
    }
  });

  it('still rejects the old cases', () => {
    for (const bad of ['javascript:alert(1)', 'ftp://example.org/x', 'https://user:pw@example.org/', 'not a url', 'https://', 'https://foo/', 'https:///x']) rejects(bad);
  });
});

describe('screenLink: public pages still pass', () => {
  it('accepts ordinary public links, including a trailing dot on a real domain', () => {
    for (const url of ['https://www.consumerfinance.gov/ask-cfpb/', 'https://example.org/a?b=1#c', 'http://example.org/', 'https://example.org./page', 'https://EXAMPLE.org/', 'https://sub.domain.example.co.uk/x',
      'https://93.184.216.34/page', 'https://8.8.8.8/', 'https://1.1.1.1./', 'https://172.15.0.1/', 'https://172.32.0.1/', 'https://100.63.255.255/', 'https://100.128.0.1/', 'https://169.253.1.1/',
      'https://[2606:4700:4700::1111]/', 'https://[2001:4860:4860::8888]/', 'https://localhost.example.org/', 'https://notlocalhost.com/', 'https://internal.example.org/', 'https://myhome.arpa.example.org/', 'https://local.example.com/']) {
      expect(() => screenLink(url), url).not.toThrow();
    }
  });

  it('keeps the flags for suspicious but allowed links', () => {
    expect(screenLink('http://example.org/').flags).toContain('non_https:example.org');
    expect(screenLink('https://93.184.216.34/p').flags).toContain('ip_literal:93.184.216.34');
    expect(screenLink('https://bit.ly/abc').flags).toContain('shortener:bit.ly');
    expect(screenLink('https://bit.ly./abc').flags).toContain('shortener:bit.ly');
    expect(screenLink('https://xn--pple-43d.com/x').flags).toContain('punycode:xn--pple-43d.com');
  });

  it('a list with one bad link is refused as a whole', () => {
    expect(() => screenSources(['https://example.org/', 'https://localhost./'])).toThrow(LinkError);
  });
});
