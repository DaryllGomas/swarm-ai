import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { weekOf, weekStartMs, networkOf } from '../src/lib.js';
import { weekStats } from '../src/core.js';
import { screenLink, screenSources } from '../src/links.js';

describe('week boundary (Monday 00:00 UTC)', () => {
  it('Sunday 23:59:59.999 is still the old week, Monday 00:00:00 starts the new one', () => {
    expect(weekOf(Date.parse('2026-10-18T23:59:59.999Z'))).toBe('2026-10-12');
    expect(weekOf(Date.parse('2026-10-19T00:00:00.000Z'))).toBe('2026-10-19');
    expect(weekOf(Date.parse('2026-10-25T23:59:59.999Z'))).toBe('2026-10-19');
    expect(weekOf(Date.parse('2026-10-26T00:00:00.000Z'))).toBe('2026-10-26');
    expect(new Date(weekStartMs(Date.parse('2026-10-22T13:00:00Z'))).toISOString()).toBe('2026-10-19T00:00:00.000Z');
  });

  it('year boundaries and the week stats agree', async () => {
    expect(weekOf(Date.parse('2027-01-01T12:00:00Z'))).toBe('2026-12-28');
    const before = await weekStats(env, Date.parse('2026-10-18T23:59:59.999Z'));
    const after = await weekStats(env, Date.parse('2026-10-19T00:00:00.000Z'));
    expect(before.week).toBe('2026-10-12');
    expect(after.week).toBe('2026-10-19');
    expect(after.week_start).toBe('2026-10-19T00:00:00.000Z');
  });
});

describe('networkOf', () => {
  it('IPv4 as is, IPv6 by its /64', () => {
    expect(networkOf('203.0.113.9')).toBe('203.0.113.9');
    expect(networkOf('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(networkOf('2001:db8:1:2::1')).toBe(networkOf('2001:db8:1:2:ffff::9'));
  });
});

describe('link screening', () => {
  it('flags without throwing', () => {
    expect(screenLink('http://example.org/').flags).toEqual(['non_https:example.org']);
    expect(screenLink('https://8.8.8.8/').flags).toEqual(['ip_literal:8.8.8.8']);
    expect(screenLink('https://[2001:db8::1]/').flags[0]).toMatch(/^ip_literal:/);
    for (const host of ['bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly']) expect(screenLink(`https://${host}/x`).flags).toEqual([`shortener:${host}`]);
    expect(screenLink('https://xn--80ak6aa92e.com/').flags[0]).toMatch(/^punycode:/);
    expect(screenLink('https://www.cdc.gov/a?b=1#c').flags).toEqual([]);
  });

  it('counts more than 20 unique sources as many_sources', () => {
    const list = (n) => Array.from({ length: n }, (_, i) => `https://example.org/${i}`);
    expect(screenSources(list(20)).flags).toEqual([]);
    expect(screenSources(list(21)).flags).toEqual(['many_sources:21']);
    expect(screenSources([...list(5), ...list(5)]).sources).toHaveLength(5);
  });

  it('rejects links that can never be public pages', () => {
    for (const bad of ['javascript:alert(1)', 'https://localhost/', 'https://192.168.1.1/', 'https://127.0.0.1/', 'https://[::1]/', 'https://host.internal/', 'https://u:p@example.org/', 'https://intranet/', 'x'.repeat(301)]) {
      expect(() => screenLink(bad), bad).toThrow();
    }
  });
});

describe('task splitting is planned, not built (review finding 6)', () => {
  it('there is no child-task helper to misuse: the only way a task is created is the screened root-task sync', async () => {
    const core = await import('../src/core.js');
    expect(core.addTask).toBeUndefined();
    expect(Object.keys(core)).toContain('addTasksBulk');
  });

  it('synced tasks are all roots', async () => {
    const { addTasksBulk } = await import('../src/core.js');
    await addTasksBulk(env, [{ project: 'town-hall', kind: 'research_fix', title: 'Root', brief: 'b', output_format: 'f', units: 3, source_key: 'test:root:1' }]);
    const t = await env.DB.prepare("SELECT parent FROM tasks WHERE source_key = 'test:root:1'").first();
    expect(t.parent).toBeNull();
    await env.DB.prepare("DELETE FROM tasks WHERE source_key = 'test:root:1'").run(); // leave the shared test database as found
  });
});
