import { describe, it, expect } from 'vitest';
import { deriveSessionVector, validateStateVector } from '../src/core/integrity.js';

describe('integrity / deriveSessionVector', () => {
  it('returns an object with bigint v and number k', () => {
    const sv = deriveSessionVector('11111111111111111111111111111111', 1);
    expect(typeof sv.v).toBe('bigint');
    expect(typeof sv.k).toBe('number');
  });

  it('is deterministic for the same inputs', () => {
    const a = deriveSessionVector('TestWallet123', 2);
    const b = deriveSessionVector('TestWallet123', 2);
    expect(a.v).toBe(b.v);
    expect(a.k).toBe(b.k);
  });

  it('produces different vectors for different channel counts', () => {
    const withChannels = deriveSessionVector('Abc123', 3);
    const without = deriveSessionVector('Abc123', 0);
    expect(withChannels.v).not.toBe(without.v);
  });

  it('v fits within u64 range', () => {
    const sv = deriveSessionVector('SomeWallet', 1);
    expect(sv.v).toBeGreaterThanOrEqual(0n);
    expect(sv.v).toBeLessThan(1n << 64n);
  });

  it('k fits within u8 range', () => {
    const sv = deriveSessionVector('SomeWallet', 1);
    expect(sv.k).toBeGreaterThanOrEqual(0);
    expect(sv.k).toBeLessThanOrEqual(255);
  });
});

describe('integrity / validateStateVector', () => {
  it('returns true for valid vectors', () => {
    const sv = deriveSessionVector('Wallet', 1);
    expect(validateStateVector(sv)).toBe(true);
  });
});
