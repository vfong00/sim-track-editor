import { describe, expect, it } from 'vitest';
import { makeRng } from '../src/core';

describe('rng', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = makeRng(5), b = makeRng(5), c = makeRng(6);
    const sa = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(sa);
    expect(Array.from({ length: 20 }, () => c.next())).not.toEqual(sa);
  });
  it('stays in [0,1) with a sane mean', () => {
    const r = makeRng(1);
    let sum = 0;
    for (let i = 0; i < 10000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(sum / 10000).toBeCloseTo(0.5, 1);
  });
});
