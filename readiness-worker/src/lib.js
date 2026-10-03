// Pure helpers for the ap127-readiness Worker. No I/O here — index.js does that.
export const MAX_PLAN_BYTES = 16384;
export const APPLY_LIMIT_PER_HOUR = 10;
export const APPLY_TTL_S = 7 * 24 * 3600;
export const RESULT_STATES = new Set(['ok', 'failed', 'dryrun']);

// Constant-time compare so a wrong key can't be guessed byte-by-byte from timing.
export function keyMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function roleFor(request, env) {
  const key = request.headers.get('X-Key');
  if (keyMatches(key, env.PI_KEY)) return 'pi';
  if (keyMatches(key, env.WATCH_KEY)) return 'watch';
  return null;
}

export function validatePlan(text) {
  if (new TextEncoder().encode(text).length > MAX_PLAN_BYTES) return 'too_large';
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    return 'bad_json';
  }
  if (!plan || plan.v !== 1 || typeof plan.gen !== 'string' || !Array.isArray(plan.moves)) return 'bad_shape';
  return null;
}

// Only moves the Pi marked applyable (ap === 1) in the CURRENT plan may be applied —
// the watch can never ask for an arbitrary calendar write.
export function findApplyableMove(plan, id) {
  if (!plan || !Array.isArray(plan.moves)) return null;
  return plan.moves.find((m) => m && m.id === id && m.ap === 1) || null;
}

export function hourBucket(nowMs) {
  return Math.floor(nowMs / 3600000);
}
