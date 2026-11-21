import { describe, expect, it } from 'vitest';
import type { PhysicsParams } from '../src/core';
import { mean, paceGapRace } from './racing-helpers';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const GAPS = [0.03, 0.045, 0.06];
/**
 * Seconds a faster car spends stuck within 1 s behind a slower one, averaged over seeds and summed
 * over a spread of pace gaps: at a small gap the wake decides whether it ever gets by, at a large
 * one only how quickly. A single gap can sit where one effect barely matters.
 */
const stuck = (physics: Partial<PhysicsParams>) =>
  GAPS.reduce((sum, gap) => sum + mean(SEEDS.map((seed) => paceGapRace(gap, seed, physics).run().stats().stuckTime)), 0);

describe('Phase 4: slipstream and dirty air', () => {
  const base = stuck({});

  it('dirty air holds a faster car up: removing it cuts stuck time by at least 30%', () => {
    expect(stuck({ dirtyAir: 0 })).toBeLessThanOrEqual(0.7 * base);
  });

  it('slipstream helps a faster car by: removing it raises stuck time by at least 30%', () => {
    expect(stuck({ slipstream: 0 })).toBeGreaterThanOrEqual(1.3 * base);
  });
});
