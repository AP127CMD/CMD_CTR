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

  const cacheKey = new Request(upstream, { method: 'GET' });

  // Edge cache: plain (non-range, non-fresh) GET/HEAD only.
  if (cache && !fresh && !rangeSpec) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      return isHead ? new Response(null, { status: hit.status, headers: hit.headers }) : hit;
    }
  }

  // Always fetch the FULL object from raw.github — never forward a Range, and never
  // append a cache-buster query (raw.github 404s intermittently on a forced origin
  // miss). `Cache-Control: no-cache` asks Fastly to revalidate; `cache: 'no-store'`
  // skips Cloudflare's own subrequest cache. Slicing for Range happens below, so
  // the 206 is always internally consistent. A ~240 KB fetch is trivial for a proxy.
  const upReqHeaders = { 'User-Agent': 'ap127-data-worker' };
  const inm = request.headers.get('If-None-Match');
  if (inm && !rangeSpec) upReqHeaders['If-None-Match'] = inm;
  if (fresh) upReqHeaders['Cache-Control'] = 'no-cache';

  let up;
  try {
    up = await fetch(upstream, {
      headers: upReqHeaders,
      ...(fresh ? { cache: 'no-store' } : {}),
    });
  } catch {
    up = null;
  }

  if (up && up.status === 304) {
    return new Response(null, {
      status: 304,
      headers: { ...CORS, ETag: inm, 'Cache-Control': CACHE_CONTROL },
    });
  }

  // Upstream unreachable or errored: serve the last good copy from the edge cache
  // if we have one (raw.github blips shouldn't take the data plane down), else 502.
  if (!up || up.status !== 200) {
    if (cache) {
      const stale = await cache.match(cacheKey);
      if (stale) {
        return isHead
          ? new Response(null, { status: stale.status, headers: stale.headers })
          : stale;
      }
    }
    return new Response(`upstream ${up ? up.status : 'unreachable'}`, { status: 502, headers: CORS });
  }

  const etag = up.headers.get('ETag');
  const baseHeaders = {
    ...CORS,
    'Content-Type': contentTypeFor(key),
    'Cache-Control': CACHE_CONTROL,
    'Accept-Ranges': 'bytes',
    ...(etag ? { ETag: etag } : {}),
  };

  // Buffer the full body once: needed to slice a Range, and to keep a fresh
  // copy in the edge cache as the stale-fallback for a later raw.github blip.
  const full = new Uint8Array(await up.arrayBuffer());

  if (cache && ctx && ctx.waitUntil) {
    const cached = new Response(full, { status: 200, headers: baseHeaders });
    ctx.waitUntil(cache.put(cacheKey, cached));
  }

  if (rangeSpec) {
    const start = Math.min(rangeSpec.offset, full.length);
    const end =
      rangeSpec.length == null
        ? full.length
        : Math.min(start + rangeSpec.length, full.length);
    return new Response(isHead ? null : full.subarray(start, end), {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end - 1}/${full.length}`,
      },
    });
  }

  return new Response(isHead ? null : full, { status: 200, headers: baseHeaders });
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
