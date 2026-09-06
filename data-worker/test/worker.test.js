import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index.js';

const RECENT = 'window.FLIGHT_DATA = {"fetchedAt":"2026-09-06T00:00:00Z","x":123}';

// Records the last upstream fetch and returns a canned raw.github response.
let lastFetch;
function installFetch(handler) {
  lastFetch = null;
  globalThis.fetch = vi.fn(async (url, opts) => {
    lastFetch = { url: String(url), opts };
    return handler(String(url), opts || {});
  });
}

beforeEach(() => {
  // No edge cache in vitest — the Worker degrades to pass-through.
  globalThis.caches = undefined;
  installFetch((url) => {
    if (url.includes('flight-data-recent.js')) {
      return new Response(RECENT, { status: 200, headers: { ETag: '"up-recent"' } });
    }
    if (url.includes('flight-data.js')) {
      return new Response('window.FLIGHT_DATA = {}', { status: 200, headers: { ETag: '"up-full"' } });
    }
    if (url.includes('cache.json')) {
      return new Response('{"ap127":[]}', { status: 200, headers: { ETag: '"up-cache"' } });
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
  });

  it('serves cache.json from the DB001 repo with a JSON content-type', async () => {
    const res = await worker.fetch(req('GET', '/cache.json'), {}, {});
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(lastFetch.url).toContain('AP127CMD/DB001/main/cache.json');
  });

  it('Cache-Control: no-cache busts raw.github and forwards no-cache upstream', async () => {
    const res = await worker.fetch(
      req('GET', '/flight-data-recent.js', { headers: { 'Cache-Control': 'no-cache' } }),
      {}, {},
    );
    expect(res.status).toBe(200);
    expect(lastFetch.url).toMatch(/flight-data-recent\.js\?_=\d+$/);
    expect(lastFetch.opts.headers['Cache-Control']).toBe('no-cache');
  });

  it('forwards Range and returns 206 + Content-Range', async () => {
    installFetch(() =>
      new Response(RECENT.slice(0, 20), {
        status: 206,
        headers: { 'Content-Range': `bytes 0-19/${RECENT.length}`, ETag: '"up-recent"' },
      }),
    );
    const res = await worker.fetch(
      req('GET', '/flight-data-recent.js', { headers: { Range: 'bytes=0-19' } }),
      {}, {},
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-19/${RECENT.length}`);
    expect(lastFetch.opts.headers.Range).toBe('bytes=0-19');
    expect(await res.text()).toBe(RECENT.slice(0, 20));
  });

  it('passes through a 304 from upstream', async () => {
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
  it('a plain GET is stored, and a second identical GET is served from cache', async () => {
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
    expect(globalThis.fetch.mock.calls.length).toBe(before); // no new upstream hit
  });
});
