// Finding 7: the upstream feed is read as a stream with a byte cap and a deadline. A fake streaming upstream stands in for
// Town Hall: no network is used.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { resetDb } from './helpers.js';
import { FETCH_TIMEOUT_MS, MAX_FEED_BYTES, fetchJson, syncTasks } from '../src/sync.js';

const MiB = 1024 * 1024;
const KiB = 1024;

// A response whose body is `chunks` produced one per pull; records how many were pulled and whether the reader cancelled.
function streaming(chunks, { headers = {}, status = 200 } = {}) {
  const seen = { pulled: 0, cancelled: false };
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) return controller.close();
      seen.pulled++;
      controller.enqueue(chunks[i++]);
    },
    cancel() { seen.cancelled = true; },
  }, { highWaterMark: 0 });
  return { res: new Response(body, { status, headers }), seen };
}

const enc = new TextEncoder();
const padJson = (bytes) => { // a valid JSON document of exactly `bytes` bytes
  const head = '{"pad":"', tail = '"}';
  return enc.encode(head + 'x'.repeat(bytes - head.length - tail.length) + tail);
};

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

describe('fetchJson: a hard cap on the bytes read', () => {
  it('stops reading and cancels the stream above 2 MiB, with no Content-Length (40 chunks of 64 KiB)', async () => {
    const chunks = Array.from({ length: 40 }, () => new Uint8Array(64 * KiB).fill(32)); // 2.5 MiB of spaces
    const { res, seen } = streaming(chunks);
    vi.stubGlobal('fetch', async () => res);
    await expect(fetchJson('https://upstream.test/feed.json')).rejects.toThrow(/too large/);
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled).toBeLessThanOrEqual(34); // 32 chunks make 2 MiB; it stops at the first one over, not at 40
  });

  it('ignores a false Content-Length that claims the body is small', async () => {
    const chunks = Array.from({ length: 40 }, () => new Uint8Array(64 * KiB).fill(32));
    const { res, seen } = streaming(chunks, { headers: { 'Content-Length': '120' } });
    vi.stubGlobal('fetch', async () => res);
    await expect(fetchJson('https://upstream.test/feed.json')).rejects.toThrow(/too large/);
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled).toBeLessThanOrEqual(34);
  });

  it('refuses an honest oversize Content-Length without reading the body', async () => {
    const { res, seen } = streaming([padJson(100)], { headers: { 'Content-Length': String(3 * MiB) } });
    vi.stubGlobal('fetch', async () => res);
    await expect(fetchJson('https://upstream.test/feed.json')).rejects.toThrow(/too large/);
    expect(seen.pulled).toBe(0);
    expect(seen.cancelled).toBe(true);
  });

  it('counts encoded bytes, not characters: a multibyte body under 2 MiB of characters is still over the cap', async () => {
    const text = JSON.stringify({ pad: '€'.repeat(800 * KiB) }); // 800 Ki characters, about 2.4 MiB encoded (3 bytes each)
    expect(text.length).toBeLessThan(MAX_FEED_BYTES); // the old check (string length) would have let this through
    const bytes = enc.encode(text);
    expect(bytes.length).toBeGreaterThan(MAX_FEED_BYTES);
    const { res, seen } = streaming([bytes.slice(0, 1000 * KiB), bytes.slice(1000 * KiB, 2000 * KiB), bytes.slice(2000 * KiB)]);
    vi.stubGlobal('fetch', async () => res);
    await expect(fetchJson('https://upstream.test/feed.json')).rejects.toThrow(/too large/);
    expect(seen.cancelled).toBe(true);
  });

  it('parses a body exactly at the cap, split at arbitrary byte boundaries (even inside a multibyte character)', async () => {
    const exact = padJson(MAX_FEED_BYTES);
    const { res } = streaming([exact.slice(0, 1000), exact.slice(1000, 700000), exact.slice(700000)]);
    vi.stubGlobal('fetch', async () => res);
    expect((await fetchJson('https://upstream.test/feed.json')).pad.length).toBeGreaterThan(MiB);

    const euro = enc.encode(JSON.stringify({ s: '€uro' }));
    const split = streaming([euro.slice(0, 7), euro.slice(7)]); // cuts the first 3-byte character in two
    vi.stubGlobal('fetch', async () => split.res);
    expect(await fetchJson('https://upstream.test/feed.json')).toEqual({ s: '€uro' });

    const one = padJson(MAX_FEED_BYTES + 1);
    vi.stubGlobal('fetch', async () => streaming([one]).res);
    await expect(fetchJson('https://upstream.test/feed.json')).rejects.toThrow(/too large/);
  });

  it('refuses a non-200 answer and cancels its body', async () => {
    const { res, seen } = streaming([padJson(100)], { status: 503 });
    vi.stubGlobal('fetch', async () => res);
    await expect(fetchJson('https://upstream.test/feed.json')).rejects.toThrow(/answered 503/);
    expect(seen.cancelled).toBe(true);
  });
});

describe('fetchJson: a deadline', () => {
  it('passes an AbortSignal to fetch, with a 10 second deadline by default', async () => {
    expect(FETCH_TIMEOUT_MS).toBe(10000);
    let given;
    vi.stubGlobal('fetch', async (_url, init) => { given = init.signal; return streaming([padJson(100)]).res; });
    await fetchJson('https://upstream.test/feed.json');
    expect(given).toBeInstanceOf(AbortSignal);
    expect(given.aborted).toBe(false);
  });

  it('gives up on a fetch that never answers', async () => {
    vi.stubGlobal('fetch', (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
    const t0 = Date.now();
    await expect(fetchJson('https://upstream.test/feed.json', { timeoutMs: 40 })).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('gives up on a body that starts and then stalls, and cancels it', async () => {
    const seen = { cancelled: false };
    const body = new ReadableStream({ start(c) { c.enqueue(enc.encode('{"a":')); }, pull() { return new Promise(() => {}); }, cancel() { seen.cancelled = true; } }, { highWaterMark: 0 });
    vi.stubGlobal('fetch', async () => new Response(body));
    const t0 = Date.now();
    await expect(fetchJson('https://upstream.test/feed.json', { timeoutMs: 40 })).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(seen.cancelled).toBe(true);
  });
});

describe('syncTasks uses the bounded fetch', () => {
  it('an oversized feed is refused as a sync error, creates no tasks and releases the lock', async () => {
    const chunks = () => Array.from({ length: 40 }, () => new Uint8Array(64 * KiB).fill(32));
    const first = streaming(chunks());
    vi.stubGlobal('fetch', async () => first.res);
    const r = await syncTasks(env, { force: true });
    expect(r.error).toBe(true);
    expect(first.seen.cancelled).toBe(true);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks').first()).n).toBe(0);
    expect((await env.DB.prepare("SELECT v FROM meta WHERE k = 'last_sync_error'").first()).v).toMatch(/too large/);
    expect((await env.DB.prepare("SELECT v FROM meta WHERE k = 'sync_lock'").first()).v).toBe('0');
  });
});
