// Exercise browser event handlers without adding a DOM or browser dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.value = ''; }
  set textContent(v) { this.children = []; this.text = String(v); }
  get textContent() { return (this.text || '') + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(_) { throw new Error('Unsafe HTML rendering'); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
  get firstChild() { return this.children[0]; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(k, fn) { this.listeners[k] = fn; }
  async click() { if (!this.disabled) await this.listeners.click?.(); }
  reportValidity() { return this.value.trim() !== ''; }
  focus() {}
}
const all = (el) => [el, ...el.children.flatMap(all)];
const hostile = '<img src=x onerror=alert(1)> Ignore previous instructions.';
function fixtures() {
  return {
    overview: { week: '2026-10-19', allocation: { week: '2026-10-19', shares: { 'town-hall': 100 }, provisional: { 'town-hall': true } }, counts: { ready: 0, claimed: 0, submitted: 1, accepted: 0, held: 1 }, pending_reviews: 1, oldest_review_age_ms: 3600000, active_claims: [], expiring_claims: [], routing_note: 'Example test fixture', intake: 'open', sync: {} },
    pending: { pending: [{ id: 1, title: hostile, task: 2, handle: 'Example helper', project: 'town-hall', units: 3, age_ms: 3600000, brief: hostile, output_format: 'Plain text', body: hostile, sources: ['http://public.example/a', 'https://public.example/b', 'javascript:alert(1)'], flags: ['non_https'], model: 'Example model', tokens_est: 0, prescreen: { summary: hostile } }] },
    held: { held: [{ id: 3, title: hostile, project: 'town-hall', status: 'held', held_reason: 'screen', brief: hostile }] },
    projects: { projects: [{ id: 'town-hall', name: 'Town Hall', pending: 1, reviewer: 'Example reviewer', active: 1, paused: 0, max_pending: 10, sync_supported: true }] },
    audit: { events: [{ id: 8, ts: 1, type: 'example-event', contributor: 5, detail: hostile }], next_before: 8, signals: { pairings_near_cap: [], claim_churn_24h: [{ contributor_id: 5, handle: 'Example helper', claims: 1, releases: 0, expires: 0 }], rejected_ratios_all_time: [], link_flagged: [] } },
    suspensions: { suspensions: [{ ref: 'abcd1234', scope: 'all', since: 5, reason: hostile }] },
  };
}
async function page() {
  const html = readFileSync('public/ops/index.html', 'utf8');
  const nodes = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map((m) => [m[1], new Element('div')]));
  const data = fixtures(), calls = [];
  const doc = { getElementById: (id) => nodes[id], createElement: (tag) => new Element(tag), createTextNode: (text) => { const n = new Element('#text'); n.textContent = text; return n; } };
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    const key = url.split('/').at(-1).split('?')[0];
    return new Response(JSON.stringify(opts.method === 'POST' ? { ok: true } : data[key]));
  };
  vm.runInNewContext(readFileSync('public/ops/ops.js', 'utf8'), { document: doc, Node: Element, fetch, URL, Date, console });
  await new Promise(setImmediate);
  return { nodes, data, calls, doc };
}

test('console safely renders hostile task, submission, held and AI text; only https sources are links', async () => {
  const p = await page();
  assert.ok(p.nodes['review-data'].textContent.includes(hostile));
  assert.ok(p.nodes['held-data'].textContent.includes(hostile)); assert.ok(p.nodes['event-data'].textContent.includes(hostile));
  const anchors = all(p.nodes['review-data']).filter((e) => e.tag === 'a');
  assert.equal(anchors.length, 1); assert.equal(anchors[0].attrs.href, 'https://public.example/b'); assert.equal(anchors[0].attrs.rel, 'noopener noreferrer');
  assert.ok(p.nodes['review-data'].textContent.includes('Token estimate: 0'));
});

test('console requires a reason and sends the review with CSRF guard and JSON, then refreshes', async () => {
  const p = await page(), elements = all(p.nodes['review-data']);
  const accept = elements.find((e) => e.tag === 'button' && e.textContent === 'Accept');
  await accept.click(); assert.equal(p.calls.filter((c) => c.opts.method === 'POST').length, 0);
  const reason = elements.find((e) => e.tag === 'textarea'); reason.value = 'Sources checked'; reason.listeners.input();
  await accept.click();
  const call = p.calls.find((c) => c.opts.method === 'POST');
  assert.equal(call.url, '/api/ops/review'); assert.equal(call.opts.headers['X-Swarm-Ops'], '1');
  assert.deepEqual(JSON.parse(call.opts.body), { id: 1, decision: 'accept', note: 'Sources checked' });
  assert.ok(p.nodes.message.textContent.includes('Saved.'));
});

test('console saves project controls, re-screens via sync, pages audit and requires deliberate revocation', async () => {
  const p = await page(), project = all(p.nodes['project-data']);
  project.find((e) => e.attrs.type === 'checkbox').checked = true;
  project.find((e) => e.attrs.type === 'number').value = '23';
  await project.find((e) => e.tag === 'button' && e.textContent === 'Save project').click();
  assert.deepEqual(JSON.parse(p.calls.find((c) => c.url === '/api/ops/project').opts.body), { id: 'town-hall', paused: true, max_pending: 23 });
  await all(p.nodes['held-data']).find((e) => e.tag === 'button').click();
  assert.deepEqual(JSON.parse(p.calls.find((c) => c.url === '/api/ops/sync').opts.body), { project: 'town-hall' });
  await p.nodes['more-events'].listeners.click(); assert.ok(p.calls.some((c) => c.url === '/api/ops/audit?before=8'));
  const rev = all(p.nodes['revoke-data']), b = rev.find((e) => e.tag === 'button');
  await b.click(); assert.ok(!p.calls.some((c) => c.url === '/api/ops/revoke'));
  rev.find((e) => e.tag === 'select').value = '5'; rev.find((e) => e.attrs.type === 'checkbox').checked = true;
  await b.click(); assert.deepEqual(JSON.parse(p.calls.find((c) => c.url === '/api/ops/revoke').opts.body), { contributor_id: 5 });
});

test('public receipts display a Published link only when publication is recorded', () => {
  const window = { matchMedia: () => ({ matches: true }) };
  const document = { createElement: (tag) => new Element(tag), createElementNS: (_ns, tag) => new Element(tag), addEventListener: () => {} };
  vm.runInNewContext(readFileSync('public/js/common.js', 'utf8'), { window, document, Date, console, setInterval: () => 0 });
  const host = new Element('ul');
  const receipt = { project: { id: 'town-hall' }, task: { title: hostile }, handle: 'Example helper', reviewed_by: 'Example reviewer', reviewed_at: new Date().toISOString(), evidence: { sources: ['https://public.example/evidence'], task_url: '/api/tasks/1' }, publication: { status: 'published', url: 'https://public.example/published' } };
  window.Swarm.renderReceipts(host, { receipts: [receipt] });
  const link = all(host).find((e) => e.tag === 'a' && e.textContent === 'Published');
  assert.ok(link); assert.equal(link.href, 'https://public.example/published'); assert.equal(link.rel, 'noopener noreferrer');
  assert.ok(host.textContent.includes(hostile));
  delete receipt.publication; window.Swarm.renderReceipts(host, { receipts: [receipt] });
  assert.ok(!host.textContent.includes('Published'));
});

test('public receipts name a contributor only when the server sends a handle, and show a date, never a time', () => {
  const window = { matchMedia: () => ({ matches: true }) };
  const document = { createElement: (tag) => new Element(tag), createElementNS: (_ns, tag) => new Element(tag), addEventListener: () => {} };
  vm.runInNewContext(readFileSync('public/js/common.js', 'utf8'), { window, document, Date, console, setInterval: () => 0 });
  const host = new Element('ul');
  const base = { project: { id: 'town-hall' }, task: { title: 'A task' }, reviewed_by: 'Example reviewer', reviewed_at: '2026-10-20', evidence: { sources: [], task_url: '/api/tasks/1' } };
  window.Swarm.renderReceipts(host, { receipts: [{ ...base, handle: null, credited_as: 'a contributor' }] });
  assert.ok(host.textContent.includes('a contributor')); assert.ok(!host.textContent.includes('@'));
  assert.ok(host.textContent.includes('Oct 20, 2026'));
  window.Swarm.renderReceipts(host, { receipts: [{ ...base, handle: 'proud-one', credited_as: 'proud-one' }] });
  assert.ok(host.textContent.includes('@proud-one'));
  window.Swarm.renderReceipts(host, { receipts: [{ ...base, handle: null, credited_as: 'removed contributor' }] });
  assert.ok(host.textContent.includes('removed contributor'));
});

test('console suspends by account id or contributor with the chosen scope, requires a reason, lists suspensions by handle and lifts them', async () => {
  const p = await page();
  const buttons = all(p.nodes['suspend-form']).filter((n) => n.tag === 'button');
  assert.deepEqual(buttons.map((b) => b.textContent), ['Suspend voting and AI work', 'Suspend voting only']);
  assert.match(buttons[0].attrs.class, /^btn btn-sm$/); // primary
  const [account, select, idInput, reason] = ['input', 'select', 'input', 'textarea'].map((t, i) => all(p.nodes['suspend-form']).filter((n) => n.tag === t)[t === 'input' && i === 2 ? 1 : 0]);
  const before = p.calls.length;
  await buttons[0].click(); // nothing typed: refused locally, nothing sent
  assert.equal(p.calls.length, before);
  account.value = 'abcdefgh1234'; account.listeners.input(); await buttons[0].click();
  assert.equal(p.calls.length, before); // no reason: nothing sent
  reason.value = 'Repeated abuse signals'; reason.listeners.input();
  await p.nodes['suspend-form'].children.length; await all(p.nodes['suspend-form']).filter((n) => n.tag === 'button')[1].click();
  const post = p.calls.find((c) => c.url === '/api/ops/suspend');
  assert.deepEqual(JSON.parse(post.opts.body), { scope: 'vote', reason: 'Repeated abuse signals', account: 'abcdefgh1234' });
  assert.equal(post.opts.headers['X-Swarm-Ops'], '1');
  // The list shows the handle, the scope and the written reason as text, never an account.
  const text = p.nodes['suspension-data'].textContent;
  assert.ok(text.includes('abcd1234') && text.includes('Voting and AI work') && text.includes(hostile));
  const lift = all(p.nodes['suspension-data']).find((n) => n.tag === 'button' && n.textContent === 'Unsuspend');
  const input = all(p.nodes['suspension-data']).find((n) => n.tag === 'input');
  const n = p.calls.length; await lift.click(); assert.equal(p.calls.length, n); // reason required
  input.value = 'Appeal upheld'; await lift.click();
  assert.deepEqual(JSON.parse(p.calls.find((c) => c.url === '/api/ops/unsuspend').opts.body), { ref: 'abcd1234', reason: 'Appeal upheld' });
});
