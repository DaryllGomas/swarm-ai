// The personal-details check: a deterministic flag on submit and in the pre-screen. It warns and flags; it never blocks, and it never keeps the value.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { BODY, SOURCE, addTask, newUser, resetDb, send, tool } from './helpers.js';
import { PII_FLAG_PREFIX, PII_KINDS, PII_WARNING, detectPersonalDetails, piiFlags } from '../src/pii.js';
import { setupGuide } from '../src/setup.js';

beforeEach(resetDb);

describe('detectPersonalDetails', () => {
  const kinds = (t) => detectPersonalDetails(t);

  it('finds email addresses', () => {
    for (const t of ['write to jane.doe+news@example.co.uk now', 'a@b.io', 'Contact: ALICE_01@Mail.Example.COM.']) expect(kinds(t), t).toEqual(['email']);
  });

  it('finds phone numbers in common shapes, but not bare digit runs, dates or version numbers', () => {
    for (const t of ['call (512) 555-0147 today', 'call 512-555-0147', 'call 512.555.0147', 'call 512 555 0147', 'call +1 512 555 0147', 'call +44 20 7946 0958', 'call 1-800-555-0199']) expect(kinds(t), t).toContain('phone');
    for (const t of ['the case 2024-10-20 was decided', 'in 2019 there were 1234567 filings', 'version 1.2.3.4', 'ID 5125550147 in the table', 'page 12-34-56', 'ratio 100.200.300']) expect(kinds(t), t).not.toContain('phone');
  });

  it('finds street addresses, PO boxes and city-state-zip lines', () => {
    for (const t of ['lives at 123 Main Street', 'at 42 Oak Ave. near', '10 N Elm Road', '7 Martin Luther King Jr Blvd', 'P.O. Box 4471', 'Austin, TX 78701', 'Springfield, IL 62704-1234']) expect(kinds(t), t).toContain('street_address');
    for (const t of ['there were 10 points on the road', '3 ways to do it', 'the 2 main streets are busy', 'in 1865 the war ended', 'page 5 of the report']) expect(kinds(t), t).not.toContain('street_address');
  });

  it('finds social-security-like numbers, and not impossible ones', () => {
    expect(kinds('SSN 123-45-6789')).toEqual(['ssn']);
    for (const t of ['000-12-3456', '666-12-3456', '900-12-3456', '123-00-6789', '123-45-0000', 'call 123-456-7890', 'ref 1123-45-67890']) expect(kinds(t), t).not.toContain('ssn');
  });

  it('finds payment card numbers that pass the Luhn check, with spaces or dashes, and not other long numbers', () => {
    for (const t of ['card 4111 1111 1111 1111', 'card 4111-1111-1111-1111', 'card 5500005555555559', 'amex 378282246310005']) expect(kinds(t), t).toContain('payment_card');
    for (const t of ['id 4111 1111 1111 1112', 'tracking 1234567890123456', 'zeros 0000000000000000', 'budget 1,000,000,000']) expect(kinds(t), t).not.toContain('payment_card');
  });

  it('finds a date of birth only when it is labelled as one', () => {
    for (const t of ['DOB: 04/12/1987', 'date of birth 1987-04-12', 'Born on April 12, 1987', 'birthday: 12 Apr 1987']) expect(kinds(t), t).toContain('date_of_birth');
    expect(kinds('The act was passed on 04/12/1987 by the senate')).toEqual([]);
  });

  it('reports several kinds at once, in a fixed order, and nothing for ordinary research text', () => {
    expect(kinds('SSN 123-45-6789, email a@b.io, phone 512-555-0147')).toEqual(['email', 'phone', 'ssn']);
    expect(kinds(BODY)).toEqual([]);
    expect(kinds('')).toEqual([]); expect(kinds(null)).toEqual([]); expect(kinds(undefined)).toEqual([]);
    expect(kinds('The Consumer Financial Protection Bureau reported 4.2 million complaints in 2023, up 18% from 2022. See https://www.consumerfinance.gov/data-research/consumer-complaints/')).toEqual([]);
  });

  it('returns only the kind, never the matched text, and the flags are prefixed kinds', () => {
    const found = detectPersonalDetails('mail jane@example.com');
    expect(JSON.stringify(found)).not.toContain('jane');
    expect(piiFlags(found)).toEqual([`${PII_FLAG_PREFIX}email`]);
    for (const k of PII_KINDS) expect(k).toMatch(/^[a-z_]+$/);
  });
});

describe('submit_work', () => {
  async function submit(body, over = {}) {
    const u = await newUser(), task = await addTask();
    await u.call('claim_task', { id: task });
    const r = await u.call('submit_work', { task_id: task, body, sources: [SOURCE] }, over);
    return { u, task, r };
  }
  const PII_BODY = `${BODY} Reach the tenant at jane.doe@example.com or 512-555-0147.`;

  it('accepts a body with personal details, warns the submitter and flags it for the reviewer', async () => {
    const { r } = await submit(PII_BODY);
    expect(r.isError, r.text).toBe(false);
    expect(r.data.status).toBe('pending');
    expect(r.data.personal_details.detected).toEqual(['email', 'phone']);
    expect(r.data.personal_details.warning).toBe(PII_WARNING);
    expect(r.data.personal_details.warning).toMatch(/Never include your user's/);
    expect(r.data.link_flags).toBeUndefined(); // these are not link flags
    const row = await env.DB.prepare('SELECT flags, body FROM submissions WHERE id = ?1').bind(r.data.submission_id).first();
    expect(JSON.parse(row.flags)).toEqual(['personal_details:email', 'personal_details:phone']);
    // The detected value is stored nowhere but the body the contributor wrote: not in flags, events, or the result.
    for (const where of [row.flags, r.text, JSON.stringify((await env.DB.prepare('SELECT detail FROM events WHERE submission = ?1').bind(r.data.submission_id).all()).results)]) {
      expect(where).not.toContain('jane.doe'); expect(where).not.toContain('555-0147');
    }
  });

  it('shows the flag to the reviewer in the admin queue and the ops audit', async () => {
    const { r } = await submit(PII_BODY);
    const pending = await (await send('/api/admin/pending', { headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` } })).json();
    expect(pending.pending.find((p) => p.id === r.data.submission_id).flags).toEqual(['personal_details:email', 'personal_details:phone']);
  });

  it('adds nothing for an ordinary submission, and keeps link flags separate from personal-detail flags', async () => {
    const { r } = await submit(BODY);
    expect(r.data.personal_details).toBeUndefined();
    const u = await newUser(), task = await addTask(); await u.call('claim_task', { id: task });
    const both = await u.call('submit_work', { task_id: task, body: PII_BODY, sources: ['http://example.org/a'] });
    expect(both.data.link_flags).toEqual(['non_https:example.org']);
    expect(both.data.personal_details.detected).toEqual(['email', 'phone']);
    expect(JSON.parse((await env.DB.prepare('SELECT flags FROM submissions WHERE id = ?1').bind(both.data.submission_id).first()).flags)).toEqual(['non_https:example.org', 'personal_details:email', 'personal_details:phone']);
  });

  it('a lost-response retry gets the same warning', async () => {
    const u = await newUser(), task = await addTask(); await u.call('claim_task', { id: task });
    await u.call('submit_work', { task_id: task, body: PII_BODY, sources: [SOURCE] });
    const again = await u.call('submit_work', { task_id: task, body: PII_BODY, sources: [SOURCE] });
    expect(again.data.already_received).toBe(true);
    expect(again.data.personal_details.detected).toEqual(['email', 'phone']);
  });
});

describe('the pre-screen', () => {
  it('records the kinds found even when the AI is unavailable, and adds nothing for clean text', async () => {
    const dirty = await newUser(), t1 = await addTask(); await dirty.call('claim_task', { id: t1 });
    const a = await dirty.call('submit_work', { task_id: t1, body: `${BODY} Mail jane@example.com.`, sources: [SOURCE] });
    const clean = await newUser(), t2 = await addTask(); await clean.call('claim_task', { id: t2 });
    const b = await clean.call('submit_work', { task_id: t2, body: BODY, sources: [SOURCE] });
    const get = async (id) => JSON.parse((await env.DB.prepare('SELECT prescreen FROM submissions WHERE id = ?1').bind(id).first()).prescreen);
    expect(await get(a.data.submission_id)).toEqual({ error: 'unavailable', personal_details: ['email'] });
    expect(await get(b.data.submission_id)).toEqual({ error: 'unavailable' });
  });

  it('records them next to an AI annotation too', async () => {
    const u = await newUser(), t = await addTask(); await u.call('claim_task', { id: t });
    const run = vi.fn(async () => ({ response: { format_ok: true, sources_relevant: true, injection_suspected: false, summary: 'Looks fine.' } }));
    const s = await u.call('submit_work', { task_id: t, body: `${BODY} SSN 123-45-6789.`, sources: [SOURCE] }, { over: { AI: { run } } });
    const p = JSON.parse((await env.DB.prepare('SELECT prescreen FROM submissions WHERE id = ?1').bind(s.data.submission_id).first()).prescreen);
    expect(p).toMatchObject({ format_ok: true, personal_details: ['ssn'] });
    expect(JSON.stringify(p)).not.toContain('123-45');
  });
});

describe('telling agents', () => {
  it('the /setup guide, /llms.txt and the setup_guide tool tell agents never to include personal information', async () => {
    const needle = /NEVER include your user's personal information/;
    expect(setupGuide()).toMatch(needle);
    expect(await (await send('/setup')).text()).toMatch(needle);
    expect(await (await send('/llms.txt')).text()).toMatch(needle);
    expect((await tool('setup_guide', {})).data.guide).toMatch(needle);
    expect((await tool('setup_guide', { client: 'codex' })).data.guide).toMatch(needle);
  });

  it('how_to_help, the MCP instructions and the submit_work description say it too', async () => {
    const help = await tool('how_to_help');
    expect(help.data.rules.join(' ')).toMatch(/Never put your user's personal information/);
    const list = await (await send('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json();
    expect(list.result.tools.find((t) => t.name === 'submit_work').description).toMatch(/personal information/);
    const init = await (await send('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) })).json();
    expect(init.result.instructions).toMatch(/personal information/);
  });
});
