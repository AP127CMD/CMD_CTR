import { describe, it, expect } from 'vitest';
import { upstreamFor, isAllowedKey, contentTypeFor, wantsFresh, parseRange } from '../src/lib.js';

describe('isAllowedKey / upstreamFor', () => {
  it('accepts the three data files and maps them to raw.github', () => {
    expect(isAllowedKey('flight-data.js')).toBe(true);
    expect(upstreamFor('flight-data.js')).toBe(
      'https://raw.githubusercontent.com/AP127CMD/CMD_CTR/main/flight-data.js',
    );
    expect(upstreamFor('flight-data-recent.js')).toContain('CMD_CTR/main/flight-data-recent.js');
    expect(upstreamFor('cache.json')).toContain('DB001/main/cache.json');
  });
  it('rejects anything else', () => {
    expect(isAllowedKey('secrets.env')).toBe(false);
    expect(isAllowedKey('../flight-data.js')).toBe(false);
    expect(isAllowedKey('')).toBe(false);
    expect(upstreamFor('nope')).toBeNull();
  });
});

describe('contentTypeFor', () => {
  it('maps .js and .json', () => {
    expect(contentTypeFor('flight-data.js')).toBe('application/javascript; charset=utf-8');
    expect(contentTypeFor('cache.json')).toBe('application/json; charset=utf-8');
  });
});

describe('wantsFresh', () => {
  it('detects no-cache / no-store', () => {
    expect(wantsFresh('no-cache')).toBe(true);
    expect(wantsFresh('max-age=0, no-store')).toBe(true);
    expect(wantsFresh('max-age=60')).toBe(false);
    expect(wantsFresh(null)).toBe(false);
  });
});

describe('parseRange', () => {
  it('parses bounded and open-ended ranges', () => {
    expect(parseRange('bytes=0-599')).toEqual({ offset: 0, length: 600 });
    expect(parseRange('bytes=100-')).toEqual({ offset: 100 });
  });
  it('returns null for junk or missing', () => {
    expect(parseRange(null)).toBeNull();
    expect(parseRange('items=1-2')).toBeNull();
    expect(parseRange('bytes=5-2')).toBeNull();
  });
});
