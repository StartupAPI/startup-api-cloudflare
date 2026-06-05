import { describe, it, expect } from 'vitest';
import { md5, hmacMd5Hex, timingSafeEqual } from '../src/webhooks/md5hmac';

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const enc = (s: string) => new TextEncoder().encode(s);

describe('md5', () => {
  it('matches known vectors', () => {
    expect(hex(md5(enc('')))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(hex(md5(enc('abc')))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(hex(md5(enc('The quick brown fox jumps over the lazy dog')))).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });
});

describe('hmacMd5Hex', () => {
  it('matches known HMAC-MD5 vectors', () => {
    expect(hmacMd5Hex('', '')).toBe('74e6f7298a9c2d168935f58c001bad88');
    expect(hmacMd5Hex('key', 'The quick brown fox jumps over the lazy dog')).toBe('80070713463e7749b90c2dc24911e275');
  });
});

describe('timingSafeEqual', () => {
  it('returns true for equal strings and false otherwise', () => {
    expect(timingSafeEqual('abcd', 'abcd')).toBe(true);
    expect(timingSafeEqual('abcd', 'abce')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});
