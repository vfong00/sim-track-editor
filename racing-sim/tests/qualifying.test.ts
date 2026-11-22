import { describe, expect, it } from 'vitest';
import { AVERAGE_DRIVER, identicalField, QUALI_LAPS, qualifyingResult, qualifyingRun, Race } from '../src/core';
import { lanes7, mean, track7 } from './racing-helpers';

const entrant = (consistency = AVERAGE_DRIVER.consistency) => identicalField(1, { ...AVERAGE_DRIVER, consistency })[0];

describe('qualifying session', () => {
  it('is deterministic per seed, and different seeds give different laps', () => {
    const a = qualifyingRun({ lanes: lanes7, entrant: entrant(), seed: 5 });
    const b = qualifyingRun({ lanes: lanes7, entrant: entrant(), seed: 5 });
    expect(a.cars[0].lapTimes).toEqual(b.cars[0].lapTimes);
    expect(a.frames.length).toBe(b.frames.length);
    const laps = new Set([1, 2, 3, 4, 5, 6].map((seed) => qualifyingResult(qualifyingRun({ lanes: lanes7, entrant: entrant(), seed })).best.toFixed(3)));
    expect(laps.size).toBeGreaterThan(3);
  });

  it(`starts at speed on a flying lap and times ${QUALI_LAPS} laps, the best one counting`, () => {
    const r = qualifyingRun({ lanes: lanes7, entrant: entrant(), seed: 1 });
    expect(r.frames[0][2]).toBeGreaterThan(10);
    const q = qualifyingResult(r);
    expect(q.laps).toHaveLength(QUALI_LAPS);
    expect(q.best).toBe(Math.min(...q.laps));
    expect(r.paceOf(r.cars[0].entrant)).toBe(AVERAGE_DRIVER.pace);
  });

  it('the push lap is about 1–3% quicker than the same driver racing alone', () => {
    const best = mean([1, 2, 3, 4].map((seed) => qualifyingResult(qualifyingRun({ lanes: lanes7, entrant: entrant(), seed })).best));
    const race = new Race({ track: track7, lanes: lanes7, entrants: [entrant()], laps: 4, seed: 1 }).run();
    const raceLap = mean(race.cars[0].lapTimes.slice(1));
    expect(raceLap / best - 1).toBeGreaterThan(0.008);
    expect(raceLap / best - 1).toBeLessThan(0.035);
  });

  it("an erratic driver's push laps scatter more than a steady one's", () => {
    const spread = (c: number) => {
      const xs = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((seed) => qualifyingRun({ lanes: lanes7, entrant: entrant(c), seed, incidents: false }).cars[0].lapTimes);
      const m = mean(xs);
      return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
    };
    expect(spread(0.95)).toBeLessThan(spread(0.72));
  });
});
