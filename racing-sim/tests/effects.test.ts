import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadScenario, Race, type Scenario } from '../src/core';
import { brakeAt, PUFF_LIFE, puffsAt, SPARK_LIFE, skidMarksAt, sparksAt } from '../src/view/effects';

const scn = JSON.parse(readFileSync(new URL('./fixtures/scenarios/equal-field.json', import.meta.url).pathname, 'utf8')) as Scenario;

describe('effects from the logs', () => {
  const race = new Race(loadScenario({ ...scn, race: { ...scn.race, incidentRate: 2 } }).options).run();
  const first = (type: string) => race.events.find((e) => e.type === type);

  it('the race has the moments to test with', () => {
    expect(first('contact')).toBeDefined();
    expect(race.events.some((e) => e.type === 'mistake' && e.text.includes('locks up'))).toBe(true);
  });

  it('a lock-up smokes, leaves a mark that stays, and the smoke clears', () => {
    const e = race.events.find((x) => x.type === 'mistake' && x.text.includes('locks up'))!;
    const before = puffsAt(race, e.t - 0.2).length;
    expect(puffsAt(race, e.t + 0.3).length).toBeGreaterThan(before);
    const marks = skidMarksAt(race, e.t + 0.5);
    expect(marks.some((m) => m.t0 === e.t && m.pts.length > 3)).toBe(true);
    expect(skidMarksAt(race, race.t).some((m) => m.t0 === e.t)).toBe(true);
    expect(skidMarksAt(race, e.t - 0.01).some((m) => m.t0 === e.t)).toBe(false);
  });

  it('the same moment always shows the same smoke (scrubbing is stable)', () => {
    const e = race.events.find((x) => x.type === 'mistake')!;
    expect(puffsAt(race, e.t + 0.4)).toEqual(puffsAt(race, e.t + 0.4));
    for (const p of puffsAt(race, e.t + 0.4)) {
      expect(p.age).toBeGreaterThanOrEqual(0);
      expect(p.age * PUFF_LIFE).toBeLessThanOrEqual(PUFF_LIFE + 1e-9);
    }
  });

  it('contact throws sparks only for a moment', () => {
    const e = first('contact')!;
    expect(sparksAt(race, e.t + 0.1).length).toBeGreaterThan(0);
    // Just after it, none from it (unless another contact happens to be live then).
    const later = e.t + SPARK_LIFE + 0.05;
    if (!race.events.some((x) => x.type === 'contact' && x.t <= later && later - x.t <= SPARK_LIFE)) expect(sparksAt(race, later)).toEqual([]);
  });

  it('brake lights come on into corners, not while accelerating', () => {
    // Over a lap of the leader: on for part of it, off for most of it.
    const c = race.cars[0];
    const t0 = c.crossTimes[1], t1 = c.crossTimes[2];
    let on = 0, n = 0;
    for (let t = t0; t < t1; t += 0.1, n++) if (brakeAt(race, 0, t) > 0) on++;
    expect(on / n).toBeGreaterThan(0.05);
    expect(on / n).toBeLessThan(0.5);
    // Never before the start (cars still on the grid).
    expect(brakeAt(race, 0, 0.05)).toBe(0);
  });
});
