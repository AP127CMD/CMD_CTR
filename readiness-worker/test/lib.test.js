import { describe, it, expect } from 'vitest';
import {
  keyMatches, roleFor, validatePlan, findApplyableMove, hourBucket,
  MAX_PLAN_BYTES, RESULT_STATES,
} from '../src/lib.js';

const env = { PI_KEY: 'pi-secret-123', WATCH_KEY: 'watch-secret-9' };
const req = (key) => new Request('https://x/plan', { headers: key ? { 'X-Key': key } : {} });

describe('keyMatches', () => {
  it('accepts the exact key', () => expect(keyMatches('abc', 'abc')).toBe(true));
  it('rejects a different key of equal length', () => expect(keyMatches('abd', 'abc')).toBe(false));
  it('rejects a prefix', () => expect(keyMatches('ab', 'abc')).toBe(false));
  it('rejects when the secret is unset or empty', () => {
    expect(keyMatches('', '')).toBe(false);
    expect(keyMatches('x', undefined)).toBe(false);
  });
  it('rejects a missing header', () => expect(keyMatches(null, 'abc')).toBe(false));
});

describe('roleFor', () => {
  it('maps the Pi key to pi', () => expect(roleFor(req('pi-secret-123'), env)).toBe('pi'));
  it('maps the watch key to watch', () => expect(roleFor(req('watch-secret-9'), env)).toBe('watch'));
  it('returns null for no or wrong key', () => {
    expect(roleFor(req(null), env)).toBe(null);
    expect(roleFor(req('nope'), env)).toBe(null);
  });
});

describe('validatePlan', () => {
  const ok = JSON.stringify({ v: 1, gen: '2026-10-03T22:15:00+07:00', moves: [] });
  it('accepts a minimal valid plan', () => expect(validatePlan(ok)).toBe(null));
  it('rejects non-JSON', () => expect(validatePlan('{nope')).toBe('bad_json'));
  it('rejects a wrong version or missing fields', () => {
    expect(validatePlan(JSON.stringify({ v: 2, gen: 'x', moves: [] }))).toBe('bad_shape');
    expect(validatePlan(JSON.stringify({ v: 1, moves: [] }))).toBe('bad_shape');
    expect(validatePlan(JSON.stringify({ v: 1, gen: 'x' }))).toBe('bad_shape');
    expect(validatePlan('null')).toBe('bad_shape');
  });
  it('rejects a body over the byte limit, counting UTF-8 bytes', () => {
    const big = JSON.stringify({ v: 1, gen: 'x', moves: [], pad: 'ก'.repeat(MAX_PLAN_BYTES / 3 + 10) });
    expect(validatePlan(big)).toBe('too_large');
  });
});

describe('findApplyableMove', () => {
  const plan = { moves: [{ id: 'm-a', ap: 1 }, { id: 'm-b', ap: 0 }] };
  it('finds an applyable move', () => expect(findApplyableMove(plan, 'm-a')).toEqual({ id: 'm-a', ap: 1 }));
  it('refuses an advice-only move', () => expect(findApplyableMove(plan, 'm-b')).toBe(null));
  it('refuses an unknown id or missing plan', () => {
    expect(findApplyableMove(plan, 'm-z')).toBe(null);
    expect(findApplyableMove(null, 'm-a')).toBe(null);
  });
});

describe('misc', () => {
  it('hourBucket groups by clock hour', () => {
    expect(hourBucket(3600000 * 5 + 1)).toBe(5);
    expect(hourBucket(3600000 * 6 - 1)).toBe(5);
  });
  it('RESULT_STATES is exactly ok/failed/dryrun', () => {
    expect([...RESULT_STATES].sort()).toEqual(['dryrun', 'failed', 'ok']);
  });
});
