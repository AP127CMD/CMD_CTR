import { describe, it, expect } from 'vitest';
import { contentTypeFor, isAllowedKey, parseRange } from '../src/lib.js';

describe('isAllowedKey', () => {
  it('accepts the three data files', () => {
    expect(isAllowedKey('flight-data.js')).toBe(true);
    expect(isAllowedKey('flight-data-recent.js')).toBe(true);
    expect(isAllowedKey('cache.json')).toBe(true);
  });
  it('rejects anything else', () => {
    expect(isAllowedKey('secrets.env')).toBe(false);
    expect(isAllowedKey('../flight-data.js')).toBe(false);
    expect(isAllowedKey('')).toBe(false);
  });
});

describe('contentTypeFor', () => {
  it('maps .js and .json', () => {
    expect(contentTypeFor('flight-data.js')).toBe('application/javascript; charset=utf-8');
    expect(contentTypeFor('cache.json')).toBe('application/json; charset=utf-8');
  });
});

describe('parseRange', () => {
  it('parses a bounded range', () => {
    expect(parseRange('bytes=0-599')).toEqual({ offset: 0, length: 600 });
  });
  it('parses an open-ended range', () => {
    expect(parseRange('bytes=100-')).toEqual({ offset: 100 });
  });
  it('returns null for junk or missing', () => {
    expect(parseRange(null)).toBeNull();
    expect(parseRange('items=1-2')).toBeNull();
    expect(parseRange('bytes=5-2')).toBeNull();
  });
});
