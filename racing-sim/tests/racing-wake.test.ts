import { describe, expect, it } from 'vitest';
import type { PhysicsParams } from '../src/core';
import { paceGapRace } from './racing-helpers';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const GAPS = [0.03, 0.045, 0.06];
/** A race where the faster car spends more than this (s) stuck within 1 s behind the slower one. */
const HELD_UP = 30;
/**
 * Races (of SEEDS × GAPS) in which the faster car is held up. Counted per race, not summed time:
 * a race is either clean or stuck for 150–285 s (the faster car gets by, or it never does), so a
 * summed time was decided by a few races. At a small gap the wake decides whether it ever gets
 * by, at a large one only how quickly.
 *
 * Incidents are off here (Phase 5): these checks measure the wake rules themselves. With
 * incidents on, a faster car that attacks more also overshoots and spins more, which mixes a
 * second effect into the stuck time; Phase 5's own checks cover incidents.
 */
const heldUp = (physics: Partial<PhysicsParams>) =>
  GAPS.reduce((sum, gap) => sum + SEEDS.filter((seed) => paceGapRace(gap, seed, physics, 6, false).run().stats().stuckTime > HELD_UP).length, 0);

describe('Phase 4: slipstream and dirty air [slow]', () => {
  const base = heldUp({});
  const noDirty = heldUp({ dirtyAir: 0 });
  const noTow = heldUp({ slipstream: 0 });

  it('slipstream helps a faster car by: without it, at least 30% more races are held up', () => {
    console.log(`held-up races of ${SEEDS.length * GAPS.length}: as raced ${base}, no dirty air ${noDirty}, no slipstream ${noTow}`);
    expect(noTow).toBeGreaterThanOrEqual(1.3 * base);
  });

  // Failed at the end of phase A (5 held-up races with dirty air, 6 without: passing got much
  // easier). Holds again since phase B (10 with, 5 without), counted in races. Phase E (tyres)
  // re-tunes dirty air, with following in it costing tyre life as well as grip.
  it('dirty air holds a faster car up: without it, at least 30% fewer races are held up', () => {
    expect(noDirty).toBeLessThanOrEqual(0.7 * base);
  });
});
