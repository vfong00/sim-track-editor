import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DRIFT, FRAME_STRIDE, loadScenario, Race, type Scenario, STATUS } from '../src/core';
import { brakeAt, PUFF_LIFE, puffsAt, SPARK_LIFE, skidMarksAt, sparksAt } from '../src/view/effects';

const scn = JSON.parse(readFileSync(new URL('./fixtures/scenarios/equal-field.json', import.meta.url).pathname, 'utf8')) as Scenario;

describe('effects from the logs', () => {
  // A seed whose race has a contact and a lock-up (the fixture's own seed doesn't have both).
  // Any change to the driving changes the races: re-pick it then (phase B moved it from 4 to 6).
  const race = new Race(loadScenario({ ...scn, seed: 6, race: { ...scn.race, incidentRate: 2 } }).options).run();
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

  it('a sliding car is drawn at a drift angle, nose into the turn, within DRIFT.max', () => {
    let seen = 0;
    const xy = (k: number, i: number) => race.track.toXY(race.frames[k][i * FRAME_STRIDE], race.frames[k][i * FRAME_STRIDE + 1]);
    for (let k = 20; k < race.frames.length - 20; k++) {
      for (let i = 0; i < race.cars.length; i++) {
        const o = i * FRAME_STRIDE, f = race.frames[k];
        if (f[o + 4] !== STATUS.run || Math.abs(f[o + 3]) < 0.05) continue;
        expect(Math.abs(f[o + 3])).toBeLessThanOrEqual(DRIFT.max + 1e-6);
        const a = xy(k - 10, i), b = xy(k, i), c = xy(k + 10, i);
        let turn = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x);
        turn -= 2 * Math.PI * Math.round(turn / (2 * Math.PI));
        // A path this close to straight (half a degree over the window: a car held on the road
        // edge between two bends) has no turn direction to check against.
        if (Math.abs(turn) < 0.01) continue;
        expect(Math.sign(turn)).toBe(Math.sign(f[o + 3]));
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(10);
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
