import { upstreamFor, isAllowedKey, contentTypeFor, wantsFresh, parseRange } from './lib.js';

const CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=240';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Cache-Control, If-None-Match, Range',
};

function keyFromPath(pathname) {
  return decodeURIComponent(pathname.replace(/^\/+/, ''));
}

function edgeCache() {
  return typeof caches !== 'undefined' && caches.default ? caches.default : null;
}

async function handleGet(key, request, ctx) {
  const upstream = upstreamFor(key);
  const fresh = wantsFresh(request.headers.get('Cache-Control'));
  const range = request.headers.get('Range');
  const rangeSpec = parseRange(range);
  const cache = edgeCache();

  // Serve from our edge cache only for plain (non-range, non-fresh) GETs.
  if (cache && !fresh && !rangeSpec) {
    const hit = await cache.match(request);
    if (hit) return hit;
  }

  // Bust raw.github's own ~5-min CDN cache when a fresh read was asked for.
  const url = fresh ? `${upstream}?_=${Date.now()}` : upstream;
  const upReqHeaders = { 'User-Agent': 'ap127-data-worker' };
  const inm = request.headers.get('If-None-Match');
  if (inm) upReqHeaders['If-None-Match'] = inm;
  if (range) upReqHeaders['Range'] = range;
  if (fresh) upReqHeaders['Cache-Control'] = 'no-cache';

  const up = await fetch(url, { headers: upReqHeaders });

  if (up.status === 304) {
    return new Response(null, {
      status: 304,
      headers: { ...CORS, ETag: inm, 'Cache-Control': CACHE_CONTROL },
    });
  }
  if (up.status !== 200 && up.status !== 206) {
    return new Response(`upstream ${up.status}`, { status: 502, headers: CORS });
  }

  const headers = {
    ...CORS,
    'Content-Type': contentTypeFor(key),
    'Cache-Control': CACHE_CONTROL,
    'Accept-Ranges': 'bytes',
  };
  const etag = up.headers.get('ETag');
  if (etag) headers['ETag'] = etag;

  if (up.status === 206) {
    const cr = up.headers.get('Content-Range');
    if (cr) headers['Content-Range'] = cr;
    return new Response(up.body, { status: 206, headers });
  }

  const res = new Response(up.body, { status: 200, headers });
  if (cache && !fresh && ctx && ctx.waitUntil) {
    ctx.waitUntil(cache.put(request, res.clone()));
  }
  return res;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }
    const key = keyFromPath(new URL(request.url).pathname);
    if (!isAllowedKey(key)) {
      return new Response('Not found', { status: 404, headers: CORS });
    }
    return handleGet(key, request, ctx);
  },
};
