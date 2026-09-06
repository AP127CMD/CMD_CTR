// Pure helpers for the ap127-data Worker. No Workers globals here so they
// unit-test in plain vitest (matches AP127_V2/watchdog's test style).

// key -> the raw.githubusercontent.com URL it is served from. The data is
// already committed to git every cycle; this Worker just re-serves it with a
// browser-usable Content-Type + a short edge cache, so data updates no longer
// need a Cloudflare Pages rebuild.
const UPSTREAM = {
  'flight-data.js':
    'https://raw.githubusercontent.com/AP127CMD/CMD_CTR/main/flight-data.js',
  'flight-data-recent.js':
    'https://raw.githubusercontent.com/AP127CMD/CMD_CTR/main/flight-data-recent.js',
  'cache.json':
    'https://raw.githubusercontent.com/AP127CMD/DB001/main/cache.json',
};

export function upstreamFor(key) {
  return UPSTREAM[key] || null;
}

export function isAllowedKey(key) {
  return Object.prototype.hasOwnProperty.call(UPSTREAM, key);
}

export function contentTypeFor(key) {
  if (key.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/javascript; charset=utf-8';
}

// The watchdog / dispatcher send `Cache-Control: no-cache` when they need the
// freshest possible read (e.g. right after a POST /notify). Honour it by
// bypassing both our edge cache and raw.github's.
export function wantsFresh(cacheControlHeader) {
  return /no-cache|no-store/i.test(cacheControlHeader || '');
}

// Parse a single "bytes=A-B" or "bytes=A-" Range header.
// Returns {offset, length?} (length omitted => "to end"), or null.
export function parseRange(header) {
  if (!header) return null;
  const m = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const start = Number(m[1]);
  if (m[2] === '') return { offset: start };
  const end = Number(m[2]);
  if (end < start) return null;
  return { offset: start, length: end - start + 1 };
}
