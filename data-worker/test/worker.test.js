import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index.js';

// Minimal in-memory R2 stub covering the surface src/index.js uses.
class FakeR2 {
  constructor() {
    this.store = new Map();
  }
  async put(key, body) {
    const buf =
      typeof body === 'string'
        ? new TextEncoder().encode(body)
        : new Uint8Array(body);
    this.store.set(key, buf);
    return { httpEtag: `"etag-${key}-${buf.length}"` };
  }
  async get(key, opts) {
    const buf = this.store.get(key);
    if (!buf) return null;
    const etag = `"etag-${key}-${buf.length}"`;
    let slice = buf;
    if (opts && opts.range) {
      const { offset, length } = opts.range;
      slice = buf.slice(offset, length == null ? undefined : offset + length);
    }
    return {
      httpEtag: etag,
      size: buf.length, // full object size, even on a range get (matches R2)
      body: new Blob([slice]).stream(),
      writeHttpMetadata() {},
    };
  }
}

const TOKEN = 'test-write-token';
let env;
beforeEach(() => {
  env = { R2: new FakeR2(), DATA_WRITE_TOKEN: TOKEN };
});

const req = (method, path, opts = {}) =>
  new Request(`https://ap127-data.example${path}`, { method, ...opts });

const bearer = { Authorization: `Bearer ${TOKEN}` };

describe('PUT', () => {
  it('401 without a bearer token', async () => {
    const res = await worker.fetch(req('PUT', '/flight-data.js', { body: 'x' }), env);
    expect(res.status).toBe(401);
  });
  it('400 for a key not in the allowlist', async () => {
    const res = await worker.fetch(
      req('PUT', '/evil.js', { body: 'x', headers: bearer }),
      env,
    );
    expect(res.status).toBe(400);
  });
  it('413 for an oversize body', async () => {
    const big = 'a'.repeat(8 * 1024 * 1024 + 1);
    const res = await worker.fetch(
      req('PUT', '/flight-data.js', { body: big, headers: bearer }),
      env,
    );
    expect(res.status).toBe(413);
  });
  it('200 and round-trips to GET', async () => {
    const put = await worker.fetch(
      req('PUT', '/flight-data.js', {
        body: 'window.FLIGHT_DATA = {"fetchedAt":"2026-09-06T00:00:00Z"}',
        headers: bearer,
      }),
      env,
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ ok: true, key: 'flight-data.js' });

    const got = await worker.fetch(req('GET', '/flight-data.js'), env);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
    expect(got.headers.get('cache-control')).toBe(
      'public, max-age=60, stale-while-revalidate=240',
    );
    expect(await got.text()).toContain('fetchedAt');
  });
});

describe('GET', () => {
  beforeEach(async () => {
    await worker.fetch(
      req('PUT', '/flight-data-recent.js', {
        body: 'window.FLIGHT_DATA = {"fetchedAt":"2026-09-06T00:00:00Z","x":123}',
        headers: bearer,
      }),
      env,
    );
  });
  it('404 for an unknown key', async () => {
    const res = await worker.fetch(req('GET', '/nope.js'), env);
    expect(res.status).toBe(404);
  });
  it('404 when the key is allowed but absent from R2', async () => {
    const res = await worker.fetch(req('GET', '/cache.json'), env);
    expect(res.status).toBe(404);
  });
  it('304 when If-None-Match matches', async () => {
    const first = await worker.fetch(req('GET', '/flight-data-recent.js'), env);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const res = await worker.fetch(
      req('GET', '/flight-data-recent.js', { headers: { 'If-None-Match': etag } }),
      env,
    );
    expect(res.status).toBe(304);
  });
  it('206 with Content-Range for a byte range', async () => {
    const res = await worker.fetch(
      req('GET', '/flight-data-recent.js', { headers: { Range: 'bytes=0-18' } }),
      env,
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toMatch(/^bytes 0-18\/\d+$/);
    expect((await res.text()).length).toBe(19);
  });
  it('range 0-599 still yields the fetchedAt field', async () => {
    const res = await worker.fetch(
      req('GET', '/flight-data-recent.js', { headers: { Range: 'bytes=0-599' } }),
      env,
    );
    expect(res.status).toBe(206);
    expect(await res.text()).toContain('"fetchedAt"');
  });
});

describe('other methods', () => {
  it('405 for DELETE', async () => {
    const res = await worker.fetch(req('DELETE', '/flight-data.js'), env);
    expect(res.status).toBe(405);
  });
  it('204 for OPTIONS with CORS', async () => {
    const res = await worker.fetch(req('OPTIONS', '/flight-data.js'), env);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
