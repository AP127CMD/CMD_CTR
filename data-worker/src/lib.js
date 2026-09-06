// Pure helpers for the ap127-data Worker. No Workers/R2 globals here so they
// unit-test in plain vitest (matches AP127_V2/watchdog's test style).

const ALLOWED = new Set(['flight-data.js', 'flight-data-recent.js', 'cache.json']);

export function isAllowedKey(key) {
  return ALLOWED.has(key);
}

export function contentTypeFor(key) {
  if (key.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/javascript; charset=utf-8';
}

// Parse a single "bytes=A-B" or "bytes=A-" Range header.
// Returns {offset, length?} (length omitted => "to end"), or null for
// a missing/unsupported/invalid header.
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
