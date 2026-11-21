import { AVERAGE_DRIVER, generateTrack, identicalField, LaneSet, Race, type PhysicsParams } from '../src/core';

/** The default generated track (14 m road) used by the Phase 4 checks. */
export const track7 = generateTrack({ seed: 7 });
export const lanes7 = new LaneSet(track7);

/** Two identical cars; the second (starting behind) has a driver `gap` faster in pace. */
export function paceGapRace(gap: number, seed: number, physics?: Partial<PhysicsParams>, laps = 6): Race {
  const e = identicalField(2, { ...AVERAGE_DRIVER, pace: 1 - gap });
  e[1].driver = { ...e[1].driver, pace: 1 };
  return new Race({ track: track7, lanes: lanes7, entrants: e, laps, seed, physics });
}

/** Passes after the opening lap (lap-1 shuffles come from the start, not race craft). */
export const passesAfterLap1 = (r: Race) => r.events.filter((e) => e.type === 'pass' && e.lap >= 2).length;

export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
