// The footer names the running commit and links it on GitHub; the privacy choices widget returns what was chosen. Run common.js against a tiny fake DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this.checked = false; }
  set textContent(v) { this.children = []; this.text = String(v); }
  get textContent() { return (this.text || '') + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(_) { throw new Error('Unsafe HTML rendering'); }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(k, fn) { this.listeners[k] = fn; }
}
const plain = (v) => JSON.parse(JSON.stringify(v)); // values built inside the vm context are not reference-equal to ours
const all = (el) => [el, ...el.children.flatMap(all)];
const text = (s) => { const e = new Element('#text'); e.text = s; return e; };

function load({ fetchImpl } = {}) {
  const note = new Element('p');
  const handlers = [];
  const document = {
    createElement: (t) => new Element(t), createElementNS: (_n, t) => new Element(t), createTextNode: text,
    querySelector: (sel) => (sel === '.foot-note' ? note : null), querySelectorAll: () => [], getElementById: () => null,
    addEventListener: (ev, fn) => { if (ev === 'DOMContentLoaded') handlers.push(fn); },
  };
  const window = { matchMedia: () => ({ matches: true }) };
  vm.runInNewContext(readFileSync('public/js/common.js', 'utf8'), { window, document, Date, console, setInterval: () => 0, fetch: fetchImpl });
  return { window, note, start: () => Promise.all(handlers.map((h) => h())) };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

test('the footer links the running commit on GitHub, as a text link with rel noopener', async () => {
  const sha = 'c0ffee'.repeat(6) + 'abcd';
  const { note, start } = load({ fetchImpl: async (url) => { assert.equal(url, '/version'); return { ok: true, json: async () => ({ commit: sha, built_at: '2026-10-20T00:00:00Z' }) }; } });
  await start(); await settle();
  const link = all(note).find((e) => e.tag === 'a');
  assert.ok(link, 'a link was added');
  assert.equal(link.href, `https://github.com/DaryllGomas/swarm-ai/commit/${sha}`);
  assert.equal(link.textContent, sha.slice(0, 7));
  assert.equal(link.rel, 'noopener noreferrer');
  assert.match(note.textContent, /Running code: /);
});

test('the footer adds no link for a commit that is not a full hash, and says so when it is not recorded', async () => {
  for (const bad of ['main', '<script>alert(1)</script>', 'abc', null]) {
    const { note, start } = load({ fetchImpl: async () => ({ ok: true, json: async () => ({ commit: bad, built_at: null }) }) });
    await start(); await settle();
    assert.equal(all(note).filter((e) => e.tag === 'a').length, 0, String(bad));
    assert.match(note.textContent, /not recorded for this build/);
    assert.ok(!note.textContent.includes('<script>'));
  }
});

test('the footer stays quiet when /version cannot be fetched', async () => {
  const { note, start } = load({ fetchImpl: async () => { throw new Error('offline'); } });
  await start(); await settle();
  assert.equal(note.children.length, 0);
});

test('privacy choices default to the private values, return what was picked, and link to /privacy', () => {
  const { window } = load({ fetchImpl: async () => ({ ok: false }) });
  const w = window.Swarm.privacyChoices('t', {});
  assert.deepEqual(plain(w.get()), { credit: 'anonymous', history: 'private', research: 'aggregate' });
  const radios = all(w.root).filter((e) => e.tag === 'input');
  assert.equal(radios.length, 6);
  radios.find((r) => r.value === 'handle').checked = true; radios.find((r) => r.value === 'anonymous').checked = false;
  radios.find((r) => r.value === 'weekly_purge').checked = true; radios.find((r) => r.value === 'private').checked = false;
  assert.deepEqual(plain(w.get()), { credit: 'handle', history: 'weekly_purge', research: 'aggregate' });
  w.set({ credit: 'anonymous', history: 'private', research: 'share_pseudonymous' });
  assert.deepEqual(plain(w.get()), { credit: 'anonymous', history: 'private', research: 'share_pseudonymous' });
  assert.ok(all(w.root).some((e) => e.tag === 'a' && e.href === '/privacy'));
  // Each option shows its one-sentence explanation.
  for (const c of window.Swarm.PRIVACY_CHOICES) for (const o of c.options) assert.ok(w.root.textContent.includes(o.text), o.value);
});

test('privacy choices start from the current values', () => {
  const { window } = load({ fetchImpl: async () => ({ ok: false }) });
  const w = window.Swarm.privacyChoices('t', { credit: 'handle', history: 'weekly_purge', research: 'share_pseudonymous' });
  assert.deepEqual(plain(w.get()), { credit: 'handle', history: 'weekly_purge', research: 'share_pseudonymous' });
});
