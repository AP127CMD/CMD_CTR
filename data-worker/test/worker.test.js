import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index.js';

const RECENT = 'window.FLIGHT_DATA = {"fetchedAt":"2026-09-06T00:00:00Z","x":123,"pad":"' + 'y'.repeat(400) + '"}';
const FULL = 'window.FLIGHT_DATA = {}';
const CACHE = '{"ap127":[]}';

let lastFetch;
function installFetch(handler) {
  lastFetch = null;
  globalThis.fetch = vi.fn(async (url, opts) => {
    lastFetch = { url: String(url), opts: opts || {} };
    return handler(String(url), opts || {});
  });
}

beforeEach(() => {
  globalThis.caches = undefined;
  installFetch((url) => {
    if (url.includes('flight-data-recent.js')) {
      return new Response(RECENT, { status: 200, headers: { ETag: '"up-recent"' } });
    }
    if (url.includes('flight-data.js')) {
      return new Response(FULL, { status: 200, headers: { ETag: '"up-full"' } });
    }
    if (url.includes('cache.json')) {
      return new Response(CACHE, { status: 200, headers: { ETag: '"up-cache"' } });
    }
    return new Response('nope', { status: 404 });
  });
});
afterEach(() => vi.restoreAllMocks());

const req = (method, path, opts = {}) =>
  new Request(`https://ap127-data.example${path}`, { method, ...opts });

describe('GET', () => {
  it('404 for a key not in the allowlist (no upstream fetch)', async () => {
    const res = await worker.fetch(req('GET', '/evil.js'), {}, {});
    expect(res.status).toBe(404);
    expect(lastFetch).toBeNull();
  });

  it('proxies flight-data.js with a JS content-type and 60s cache', async () => {
    const res = await worker.fetch(req('GET', '/flight-data.js'), {}, {});
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=240');
    expect(res.headers.get('etag')).toBe('"up-full"');
    expect(lastFetch.url).toBe('https://raw.githubusercontent.com/AP127CMD/CMD_CTR/main/flight-data.js');
    expect(await res.text()).toBe(FULL);
  });

  it('serves cache.json from the DB001 repo with a JSON content-type', async () => {
    const res = await worker.fetch(req('GET', '/cache.json'), {}, {});
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(lastFetch.url).toContain('AP127CMD/DB001/main/cache.json');
  });

  it('Cache-Control: no-cache forwards no-cache + no-store, no query buster', async () => {
    const res = await worker.fetch(
      req('GET', '/flight-data-recent.js', { headers: { 'Cache-Control': 'no-cache' } }),
      {}, {},
    );
    expect(res.status).toBe(200);
    expect(lastFetch.url).toBe(
      'https://raw.githubusercontent.com/AP127CMD/CMD_CTR/main/flight-data-recent.js',
    );
    expect(lastFetch.opts.headers['Cache-Control']).toBe('no-cache');
    expect(lastFetch.opts.cache).toBe('no-store');
  });

  it('serves the last good copy from cache when upstream 404s', async () => {
    const store = new Map();
    globalThis.caches = {
      default: {
        async match(r) { return store.get(r.url) || undefined; },
        async put(r, resp) { store.set(r.url, resp); },
      },
    };
    const ctx = { waitUntil: (p) => p };
    // prime the cache with a good fetch
    await worker.fetch(req('GET', '/flight-data.js'), {}, ctx);
    await new Promise((r) => setTimeout(r, 0));
    // now upstream breaks
    installFetch(() => new Response('gone', { status: 404 }));
    const res = await worker.fetch(
      req('GET', '/flight-data.js', { headers: { 'Cache-Control': 'no-cache' } }),
      {}, ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FULL);
  });

  it('Range: slices locally with a correct Content-Range against the full length', async () => {
    const res = await worker.fetch(
      req('GET', '/flight-data-recent.js', { headers: { Range: 'bytes=0-19' } }),
      {}, {},
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-19/${RECENT.length}`);
    // never forwards a Range upstream
    expect(lastFetch.opts.headers.Range).toBeUndefined();
    expect(await res.text()).toBe(RECENT.slice(0, 20));
  });

  it('Range bytes=0-599 yields the fetchedAt field with the true total', async () => {
    const res = await worker.fetch(
      req('GET', '/flight-data-recent.js', { headers: { Range: 'bytes=0-599' } }),
      {}, {},
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-${RECENT.length - 1}/${RECENT.length}`);
    expect(await res.text()).toContain('"fetchedAt"');
  });

  it('passes through a 304 from upstream (non-range)', async () => {
    installFetch(() => new Response(null, { status: 304 }));
    const res = await worker.fetch(
      req('GET', '/flight-data-recent.js', { headers: { 'If-None-Match': '"up-recent"' } }),
      {}, {},
    );
    expect(res.status).toBe(304);
    expect(lastFetch.opts.headers['If-None-Match']).toBe('"up-recent"');
  });

  it('502 when upstream errors', async () => {
    installFetch(() => new Response('boom', { status: 500 }));
    const res = await worker.fetch(req('GET', '/flight-data.js'), {}, {});
    expect(res.status).toBe(502);
  });
});

describe('HEAD', () => {
  it('200, headers, empty body', async () => {
    const res = await worker.fetch(req('HEAD', '/flight-data.js'), {}, {});
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
    expect(await res.text()).toBe('');
  });
});

describe('other methods', () => {
  it('405 for PUT (no writes in the proxy design)', async () => {
    const res = await worker.fetch(req('PUT', '/flight-data.js', { body: 'x' }), {}, {});
    expect(res.status).toBe(405);
  });
  it('405 for DELETE', async () => {
    const res = await worker.fetch(req('DELETE', '/flight-data.js'), {}, {});
    expect(res.status).toBe(405);
  });
  it('204 for OPTIONS with CORS', async () => {
    const res = await worker.fetch(req('OPTIONS', '/flight-data.js'), {}, {});
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('edge cache', () => {
  it('a plain GET is stored under the upstream key; a second plain GET makes no new upstream fetch', async () => {
    const store = new Map();
    globalThis.caches = {
      default: {
        async match(r) { return store.get(r.url) || undefined; },
        async put(r, resp) { store.set(r.url, resp); },
      },
    };
    const ctx = { waitUntil: (p) => p };
    const first = await worker.fetch(req('GET', '/flight-data.js'), {}, ctx);
    expect(first.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    const before = globalThis.fetch.mock.calls.length;
    const second = await worker.fetch(req('GET', '/flight-data.js'), {}, ctx);
    expect(second.status).toBe(200);
    expect(globalThis.fetch.mock.calls.length).toBe(before);
  });
});
