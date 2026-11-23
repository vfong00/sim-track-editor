import { describe, expect, it } from 'vitest';
import { AVERAGE_DRIVER, identicalField, lanePlansFor, Race, racePace, raceMargin, STANDARD_CAR } from '../src/core';
import { lanes7, track7 } from './racing-helpers';

describe('race margin', () => {
  it('races under the limit, further under for an erratic driver and less for a brave one', () => {
    const m = (consistency: number, bravery = 0.5) => raceMargin({ consistency, bravery });
    expect(m(0.96)).toBeLessThan(m(0.85));
    expect(m(0.85)).toBeLessThan(m(0.7));
    // A brave driver leaves less room for the scatter.
    expect(m(0.85, 1)).toBeLessThan(m(0.85, 0));
    for (const c of [0.7, 0.85, 0.96]) expect(racePace({ pace: 1, consistency: c, bravery: 0.5 })).toBeLessThan(1);
  });

  // On the traced circuits with the presets a race lap is ~1% (steady) to ~2% (erratic) off the
  // limit; this generated track is twistier and the standard car has no downforce, so lap time
  // is more sensitive to grip here (~0.5% per 1%).
  it('a race lap is about 1–3% off the limit lap on the test track, closer for a steadier driver', () => {
    const lap = (pace: number) => lanePlansFor(lanes7, STANDARD_CAR, pace).plans.lapTime;
    const limit = lap(AVERAGE_DRIVER.pace);
    const off = (consistency: number) => lap(racePace({ ...AVERAGE_DRIVER, consistency })) / limit - 1;
    expect(off(0.96)).toBeGreaterThan(0.005);
    expect(off(0.7)).toBeLessThan(0.035);
    expect(off(0.96)).toBeLessThan(off(0.85));
    expect(off(0.85)).toBeLessThan(off(0.7));
  });

  it('cars in a race plan at race pace', () => {
    const r = new Race({ track: track7, lanes: lanes7, entrants: identicalField(2), laps: 1, seed: 1 });
    expect(r.paceOf(r.cars[0].entrant)).toBe(racePace(AVERAGE_DRIVER));
    expect(r.cars[0].plans.lapTime).toBe(lanePlansFor(lanes7, r.cars[0].entrant.car, racePace(AVERAGE_DRIVER)).plans.lapTime);
  });
});
