import { describe, expect, it } from 'vitest';
import type { PhysicsParams } from '../src/core';
import { mean, paceGapRace } from './racing-helpers';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
/** Mean seconds the faster car spends stuck within 1 s behind the slower one. */
const stuck = (physics: Partial<PhysicsParams>) => mean(SEEDS.map((seed) => paceGapRace(0.06, seed, physics).run().stats().stuckTime));

describe('Phase 4: slipstream and dirty air', () => {
  const base = stuck({});

  it('dirty air holds a faster car up: removing it cuts stuck time by at least 30%', () => {
    expect(stuck({ dirtyAir: 0 })).toBeLessThanOrEqual(0.7 * base);
  });

  it('slipstream helps a faster car by: removing it raises stuck time by at least 30%', () => {
    expect(stuck({ slipstream: 0 })).toBeGreaterThanOrEqual(1.3 * base);
  });
});
