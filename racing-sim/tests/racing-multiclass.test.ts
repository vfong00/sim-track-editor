import { describe, expect, it } from 'vitest';
import { AVERAGE_DRIVER, CAR_PRESETS, type Entrant, identicalField, Race } from '../src/core';
import { lanes7, mean, track7 } from './racing-helpers';

/** Four MX-5s gridded ahead of two LMPs (about 20% a lap quicker) on the default track. */
function classRace(seed: number): Race {
  const e: Entrant[] = identicalField(6, AVERAGE_DRIVER).map((x, i) => ({
    ...x, car: { ...CAR_PRESETS[i < 4 ? 'mx5' : 'lmp'], id: i < 4 ? 'mx5' : 'lmp' },
  }));
  return new Race({ track: track7, lanes: lanes7, entrants: e, laps: 3, seed });
}

const SEEDS = [1, 2, 3, 4, 5, 6];

describe('multi-class traffic', () => {
  const races = SEEDS.map((s) => classRace(s).run());
  it('a class quicker car goes by instead of sitting in the tow: under 26 car-s a race behind a slower class (about 32 without class handling)', () => {
    expect(mean(races.map((r) => r.stats().trafficTime))).toBeLessThan(26);
  });
  it('the LMPs finish ahead of every MX-5', () => {
    for (const r of races) {
      const order = r.order().filter((i) => !r.cars[i].dnf);
      const lmps = order.filter((i) => i >= 4).length;
      expect(order.slice(0, lmps).every((i) => i >= 4)).toBe(true);
    }
  });
});
