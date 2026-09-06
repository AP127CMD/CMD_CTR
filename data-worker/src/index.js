import { isAllowedKey, contentTypeFor, parseRange } from './lib.js';

const MAX_BYTES = 8 * 1024 * 1024;
const CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=240';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match, Range',
};

function keyFromPath(pathname) {
  return decodeURIComponent(pathname.replace(/^\/+/, ''));
}

async function handleGet(key, request, env, ctx) {
  const rangeSpec = parseRange(request.headers.get('Range'));
  // `caches` is absent under plain vitest/node — degrade to no edge cache.
  const cache =
    typeof caches !== 'undefined' && caches.default ? caches.default : null;

  // Only full requests use the edge cache; Range requests always hit R2.
  if (cache && !rangeSpec) {
    const hit = await cache.match(request);
    if (hit) return hit;
  }

  const obj = rangeSpec
    ? await env.R2.get(key, { range: rangeSpec })
    : await env.R2.get(key);
  if (!obj) return new Response('Not found', { status: 404, headers: CORS });

  const etag = obj.httpEtag;
  const inm = request.headers.get('If-None-Match');
  if (inm && inm === etag) {
    return new Response(null, {
      status: 304,
      headers: { ...CORS, ETag: etag, 'Cache-Control': CACHE_CONTROL },
    });
  }

  const headers = {
    ...CORS,
    'Content-Type': contentTypeFor(key),
    'Cache-Control': CACHE_CONTROL,
    'Accept-Ranges': 'bytes',
    ETag: etag,
  };

  if (rangeSpec) {
    // On a range get, R2ObjectBody.size is still the FULL object size.
    const total = obj.size;
    const start = rangeSpec.offset;
    const len = rangeSpec.length ?? total - start;
    headers['Content-Range'] = `bytes ${start}-${start + len - 1}/${total}`;
    return new Response(obj.body, { status: 206, headers });
  }

  const res = new Response(obj.body, { status: 200, headers });
  if (cache && ctx && ctx.waitUntil) ctx.waitUntil(cache.put(request, res.clone()));
  return res;
}

async function handlePut(key, request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.DATA_WRITE_TOKEN || auth !== `Bearer ${env.DATA_WRITE_TOKEN}`) {
    return new Response('Unauthorized', { status: 401, headers: CORS });
  }
  if (!isAllowedKey(key)) {
    return new Response('Bad key', { status: 400, headers: CORS });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BYTES) {
    return new Response('Too large', { status: 413, headers: CORS });
  }
  const put = await env.R2.put(key, bytes, {
    httpMetadata: { contentType: contentTypeFor(key) },
  });
  return new Response(
    JSON.stringify({ ok: true, key, size: bytes.length, etag: put.httpEtag }),
    { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
  );
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    const key = keyFromPath(new URL(request.url).pathname);
    if (request.method === 'GET') {
      if (!isAllowedKey(key)) {
        return new Response('Not found', { status: 404, headers: CORS });
      }
      return handleGet(key, request, env, ctx);
    }
    if (request.method === 'PUT') return handlePut(key, request, env);
    return new Response('Method not allowed', { status: 405, headers: CORS });
  },
};
