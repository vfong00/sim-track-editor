import { describe, expect, it } from 'vitest';
import { identicalField, Race } from '../src/core';
import { lanes7, passesAfterLap1, track7 } from './racing-helpers';

// 16 seeds: identical cars pass rarely (5 passes in 16 races since the speed rating widened),
// so 4 seeds can show none at all.
const SEEDS = Array.from({ length: 16 }, (_, k) => k + 1);

describe('Phase 4: overtaking frequency', () => {
  it('identical cars and drivers: overtakes happen but stay rare', { timeout: 60000 }, () => {
    // 10 cars x laps 2..6 = 50 car-laps per race. "Rare": at most one pass per 5 car-laps.
    const passes = SEEDS.map((seed) =>
      passesAfterLap1(new Race({ track: track7, lanes: lanes7, entrants: identicalField(10), laps: 6, seed }).run()),
    );
    expect(passes.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    for (const p of passes) expect(p).toBeLessThanOrEqual(10);
  });
});
