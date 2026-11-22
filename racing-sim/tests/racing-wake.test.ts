import { describe, expect, it } from 'vitest';
import type { PhysicsParams } from '../src/core';
import { mean, paceGapRace } from './racing-helpers';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const GAPS = [0.03, 0.045, 0.06];
/**
 * Seconds a faster car spends stuck within 1 s behind a slower one, averaged over seeds and summed
 * over a spread of pace gaps: at a small gap the wake decides whether it ever gets by, at a large
 * one only how quickly. A single gap can sit where one effect barely matters.
 *
 * Incidents are off here (Phase 5): these checks measure the wake rules themselves. With
 * incidents on, a faster car that attacks more also overshoots and spins more, which mixes a
 * second effect into the stuck time; Phase 5's own checks cover incidents.
 */
const stuck = (physics: Partial<PhysicsParams>) =>
  GAPS.reduce((sum, gap) => sum + mean(SEEDS.map((seed) => paceGapRace(gap, seed, physics, 6, false).run().stats().stuckTime)), 0);

describe('Phase 4: slipstream and dirty air', () => {
  const base = stuck({});

  // Held again since attackers tuck into the tow and commit to one move (it had stopped
  // holding when the attack itself, off line and out of the tow, was what held a car up).
  it('dirty air holds a faster car up: removing it cuts stuck time by at least 30%', () => {
    expect(stuck({ dirtyAir: 0 })).toBeLessThanOrEqual(0.7 * base);
  });

  it('slipstream helps a faster car by: removing it raises stuck time by at least 30%', () => {
    expect(stuck({ slipstream: 0 })).toBeGreaterThanOrEqual(1.3 * base);
  });
});
