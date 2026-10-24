// The consent page script (public/js/authorize.js) and the Connected apps list (public/js/me.js), run against a tiny fake DOM with a
// fake clock and a fake interval timer, so nothing depends on the real date or on waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; this.style = {}; this.focused = 0; this.scrolled = 0; }
  set textContent(v) { this.children = []; this.text = String(v); }
  get textContent() { return (this.text || '') + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(_) { throw new Error('Unsafe HTML rendering'); }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); }
  focus() { this.focused++; }
  scrollIntoView() { this.scrolled++; }
  async click() { if (!this.disabled) for (const fn of this.listeners.click || []) await fn(); }
}
const walk = (el) => [el, ...el.children.flatMap(walk)];
const flush = () => new Promise(setImmediate);

function authorizePage({ scopes, expires_in_ms = 600000, respond }) {
  const data = { consent: 'swh_x', client: { name: 'Claude', domain: null, redirect_host: 'claude.ai', loopback: false }, expires_in_ms, scopes };
  const nodes = { 'auth-data': Object.assign(new Element('script'), { text: JSON.stringify(data) }), 'auth-root': new Element('div'), 'auth-message': new Element('p'), 'auth-title': new Element('h1') };
  let now = 1_000_000, timer = null, cleared = false; const posts = [], navigated = [];
  class FakeDate extends Date { static now() { return now; } }
  const ctx = {
    document: { getElementById: (id) => nodes[id], createElement: (t) => new Element(t), createTextNode: (t) => Object.assign(new Element('#text'), { text: t }) },
    Date: FakeDate, setInterval: (fn) => { timer = fn; return 1; }, clearInterval: () => { cleared = true; timer = null; },
    fetch: async (url, opts = {}) => {
      if (opts.method === 'POST' && url === '/authorize') { posts.push(JSON.parse(opts.body)); const r = respond ? respond() : { ok: true, body: { redirect_to: 'https://claude.ai/cb?code=c' } }; return { ok: r.ok, json: async () => r.body }; }
      return { ok: true, json: async () => ({ signed_in: false }) };
    },
    window: { location: { assign: (u) => navigated.push(u) } }, btoa, atob, Uint8Array, JSON, Math, Number, String, console,
  };
  vm.runInNewContext(readFileSync('public/js/authorize.js', 'utf8'), ctx);
  const els = walk(nodes['auth-root']);
  const byText = (t) => els.find((e) => e.tag === 'button' && e.textContent === t);
  return {
    nodes, posts, navigated, els, allow: byText('Allow'), deny: byText('Deny'),
    advance: (ms) => { now += ms; timer?.(); },
    elapse: (ms) => { now += ms; },
    cleared: () => cleared,
    problem: els.find((e) => e.attrs.role === 'alert'),
    announce: els.find((e) => e.attrs['aria-live'] === 'polite'),
    clock: els.find((e) => e.className.includes('expiry')),
    boxes: els.filter((e) => e.tag === 'input' && e.type === 'checkbox'),
    text: () => els.map((e) => e.textContent).join('\n'),
  };
}
const SCOPES = [{ id: 'read', text: 'r', requested: true, required: true }, { id: 'work', text: 'w', requested: false, required: false }, { id: 'submit', text: 's', requested: false, required: false }];

test('scopes the app did not ask for are disabled, unticked, and say why; the requested one is ticked', async () => {
  const p = authorizePage({ scopes: SCOPES });
  const [read, work, submit] = p.boxes;
  assert.deepEqual([read.checked, read.disabled], [true, true]);
  for (const b of [work, submit]) assert.deepEqual([b.checked, b.disabled], [false, true]);
  const notes = p.els.filter((e) => e.className === 'unasked');
  assert.equal(notes.length, 2);
  for (const n of notes) assert.equal(n.textContent, "Your app didn't ask for this yet. If it needs it later, it will ask and you'll see this page again.");
});

test('a requested optional scope stays tickable and is sent when ticked', async () => {
  const p = authorizePage({ scopes: [SCOPES[0], { id: 'work', text: 'w', requested: true, required: false }, SCOPES[2]] });
  const [, work, submit] = p.boxes;
  assert.deepEqual([work.checked, work.disabled, submit.checked, submit.disabled], [true, false, false, true]);
  await p.allow.click(); await flush();
  assert.deepEqual(p.posts[0].scope, ['read', 'work']);
  assert.equal(p.navigated.length, 1);
});

test('the expiry note is always visible next to the buttons and counts down; announcements only at 1 minute and at expiry', () => {
  const p = authorizePage({ scopes: SCOPES });
  assert.match(p.clock.textContent, /This page expires in 10:00\. If it does, start the connection again from your app\./);
  p.advance(60_000);
  assert.match(p.clock.textContent, /expires in 9:00/);
  assert.equal(p.announce.textContent, '');          // no chatter while counting down
  p.advance(8 * 60_000);
  assert.match(p.clock.textContent, /expires in 1:00/);
  assert.equal(p.announce.textContent, 'This page expires in 1 minute.');
  p.advance(30_000); p.advance(20_000);
  assert.equal(p.announce.textContent, 'This page expires in 1 minute.'); // not repeated
  assert.equal(p.allow.disabled, false);
});

test('at expiry Allow and Deny are disabled and the person is told, beside the buttons, to go back and connect again', () => {
  const p = authorizePage({ scopes: SCOPES });
  p.advance(600_000);
  assert.equal(p.allow.disabled, true);
  assert.equal(p.deny.disabled, true);
  const gone = 'This page has expired. Go back to your AI app and click Connect again.';
  assert.equal(p.problem.textContent, gone);
  assert.equal(p.problem.hidden, false);
  assert.equal(p.clock.textContent, gone + 'This page has expired.');
  assert.equal(p.announce.textContent, 'This page has expired.');
  assert.ok(p.problem.focused >= 1 && p.problem.scrolled >= 1, 'focus moved and scrolled to the message');
  assert.equal(p.nodes['auth-message'].textContent, ''); // not in the far-away message at the top
  assert.ok(p.cleared());
});

test('a click after the deadline (a held-back background timer) is stopped on the page, and sends nothing', async () => {
  const p = authorizePage({ scopes: SCOPES });
  p.elapse(601_000);                   // the timer never fired
  await p.allow.click();
  assert.equal(p.posts.length, 0);
  assert.equal(p.allow.disabled, true);
  assert.match(p.problem.textContent, /click Connect again/);
});

test('a server error is shown beside the buttons, focused and scrolled into view, and the page stays usable', async () => {
  const p = authorizePage({ scopes: SCOPES, respond: () => ({ ok: false, body: { error: 'That handle is taken. Pick another.' } }) });
  await p.allow.click(); await flush();
  assert.equal(p.problem.textContent, 'That handle is taken. Pick another.');
  assert.equal(p.problem.hidden, false);
  assert.ok(p.problem.focused >= 1 && p.problem.scrolled >= 1);
  assert.equal(p.nodes['auth-message'].textContent, '');
  assert.equal(p.allow.disabled, false);
  assert.equal(p.deny.disabled, false);
});

test('a server "expired" answer leaves a message beside the buttons; a retry clears the old error first', async () => {
  let n = 0;
  const p = authorizePage({ scopes: SCOPES, respond: () => (n++ === 0 ? { ok: false, body: { error: 'This page expired, was already used, or was opened in another browser. Start the connection again.' } } : { ok: true, body: { redirect_to: 'https://claude.ai/cb?code=c' } }) });
  await p.allow.click(); await flush();
  assert.match(p.problem.textContent, /expired/);
  await p.allow.click(); await flush();
  assert.equal(p.problem.hidden, true);
  assert.equal(p.navigated.length, 1);
});

test('a hostile redirect address is refused beside the buttons', async () => {
  const p = authorizePage({ scopes: SCOPES, respond: () => ({ ok: true, body: { redirect_to: 'javascript:alert(1)' } }) });
  await p.allow.click(); await flush();
  assert.equal(p.navigated.length, 0);
  assert.match(p.problem.textContent, /will not open/);
});

test('me.js: Connected apps renders as text, Disconnect posts the grant id, then shows the new list', async () => {
  const ids = new Map(); const get = (id) => { if (!ids.has(id)) ids.set(id, new Element('div')); return ids.get(id); };
  const hostile = '<img src=x onerror=alert(1)>';
  let list = [{ id: 'g'.repeat(24), name: hostile, verified: false, handle: 'my-ai', scopes: ['read', 'work'], connected_at: '2026-01-02T00:00:00.000Z' }];
  const calls = [];
  const S = { el: (t, c, x) => { const e = new Element(t); if (c) e.className = c; if (x != null) e.text = String(x); return e; }, clear: (e) => { e.children = []; e.text = ''; }, fmtDate: (d) => d.slice(0, 10), n0: String, privacyChoices: () => ({ root: new Element('div'), set() {} }), copyText() {} };
  const ctx = {
    window: { Swarm: S, confirm: () => true, PublicKeyCredential: undefined, location: { search: '' } }, document: { getElementById: get }, navigator: {}, URLSearchParams, btoa, atob, Uint8Array, JSON, Math, Date, Number, String, clearInterval() {}, setInterval() {},
    fetch: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', headers: opts.headers, body: opts.body });
      if (url === '/api/me/apps/disconnect') { list = []; return { ok: true, json: async () => ({ disconnected: true, apps: [] }) }; }
      if (url === '/api/me/apps') return { ok: true, json: async () => ({ apps: list, note: 'Disconnecting in your AI app may not tell Swarm. Disconnect here to be sure.' }) };
      if (url === '/api/me') return { ok: true, json: async () => ({ signed_in: true, account_id_short: 'abcd1234', privacy: {}, linked: null, week: null, ballot: null, fallback: false, fallback_note: '' }) };
      return { ok: true, json: async () => ({}) };
    },
  };
  vm.runInNewContext(readFileSync('public/js/me.js', 'utf8'), ctx);
  await flush(); await flush();
  const body = get('apps-body');
  const text = walk(body).map((e) => e.textContent).join('|');
  assert.ok(text.includes(hostile), 'shown as plain text');
  assert.match(text, /Unverified/);
  assert.match(text, /May: read, work/);
  assert.match(text, /connected 2026-01-02/);
  const button = walk(body).find((e) => e.tag === 'button');
  assert.equal(button.textContent, 'Disconnect');
  await button.click(); await flush();
  const post = calls.find((c) => c.url === '/api/me/apps/disconnect');
  assert.equal(post.method, 'POST');
  assert.equal(post.headers['X-Swarm'], '1');
  assert.deepEqual(JSON.parse(post.body), { grant: 'g'.repeat(24) });
  assert.match(walk(get('apps-body')).map((e) => e.textContent).join('|'), /No apps are connected/);
  assert.match(get('me-message').textContent, /is disconnected/);
});
