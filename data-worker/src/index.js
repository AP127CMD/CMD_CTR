import { upstreamFor, isAllowedKey, contentTypeFor, wantsFresh, parseRange } from './lib.js';

const CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=240';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
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
  const isHead = request.method === 'HEAD';
  const fresh = wantsFresh(request.headers.get('Cache-Control'));
  const rangeSpec = parseRange(request.headers.get('Range'));
  const cache = edgeCache();

  // Edge cache: plain (non-range, non-fresh) GET/HEAD only.
  if (cache && !fresh && !rangeSpec) {
    const hit = await cache.match(new Request(upstream, { method: 'GET' }));
    if (hit) {
      return isHead ? new Response(null, { status: hit.status, headers: hit.headers }) : hit;
    }
  }

  // Always fetch the FULL object from raw.github — never forward a Range. GitHub's
  // Fastly edge has been observed handing Cloudflare a stale Content-Range total
  // for a Range request even on a cache-busted URL; slicing here guarantees the
  // 206 we return is internally consistent. A ~240 KB fetch is trivial for a proxy.
  const url = fresh ? `${upstream}?_=${Date.now()}` : upstream;
  const upReqHeaders = { 'User-Agent': 'ap127-data-worker' };
  const inm = request.headers.get('If-None-Match');
  if (inm && !rangeSpec) upReqHeaders['If-None-Match'] = inm;
  if (fresh) upReqHeaders['Cache-Control'] = 'no-cache';

  const up = await fetch(url, {
    headers: upReqHeaders,
    ...(fresh ? { cache: 'no-store' } : {}),
  });

  if (up.status === 304) {
    return new Response(null, {
      status: 304,
      headers: { ...CORS, ETag: inm, 'Cache-Control': CACHE_CONTROL },
    });
  }
  if (up.status !== 200) {
    return new Response(`upstream ${up.status}`, { status: 502, headers: CORS });
  }

  const etag = up.headers.get('ETag');
  const baseHeaders = {
    ...CORS,
    'Content-Type': contentTypeFor(key),
    'Cache-Control': CACHE_CONTROL,
    'Accept-Ranges': 'bytes',
    ...(etag ? { ETag: etag } : {}),
  };

  if (rangeSpec) {
    const full = new Uint8Array(await up.arrayBuffer());
    const start = Math.min(rangeSpec.offset, full.length);
    const end =
      rangeSpec.length == null
        ? full.length
        : Math.min(start + rangeSpec.length, full.length);
    const slice = full.subarray(start, end);
    return new Response(isHead ? null : slice, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end - 1}/${full.length}`,
      },
    });
  }

  const res = new Response(isHead ? null : up.body, { status: 200, headers: baseHeaders });
  if (cache && !fresh && ctx && ctx.waitUntil) {
    // Cache under a stable key (the bare upstream URL) so a later plain GET hits
    // regardless of the request's own headers/query.
    ctx.waitUntil(cache.put(new Request(upstream, { method: 'GET' }), res.clone()));
  }
  return res;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }
    const key = keyFromPath(new URL(request.url).pathname);
    if (!isAllowedKey(key)) {
      return new Response('Not found', { status: 404, headers: CORS });
    }
    return handleGet(key, request, ctx);
  },
};
