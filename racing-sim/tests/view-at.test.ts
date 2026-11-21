import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadScenario, Race, type Scenario } from '../src/core';
import { RaceAt } from '../src/view/at';

/**
 * Rewinding (the timeline) needs the viewer to show the race as it stood at any time, read from
 * the logs of a race computed further ahead (rule 4). Check it against a second, identical race
 * stopped at that time, whose live state is the truth.
 */
describe('viewer state at a time, from the logs', () => {
  const scn = JSON.parse(readFileSync(new URL('../scenarios/rookie-rocket-rain.json', import.meta.url).pathname, 'utf8')) as Scenario;
  const opts = () => loadScenario(scn).options;
  const full = new Race(opts()).run();

  it('the full race had grip changes and damage to check against', () => {
    expect(full.gripLog.length).toBeGreaterThan(1);
    expect(full.damageLog.length).toBeGreaterThan(0);
  });

  it.each([30, 150, 210, 260, 'end'] as const)('matches a race stopped at %s s', (at) => {
    const live = new Race(opts());
    const until = at === 'end' ? full.t : at;
    while (live.t < until - 1e-9 && !live.finished) live.step();
    const v = new RaceAt(full, live.t);
    expect(v.k).toBe(live.tick);
    expect(v.leaderLap).toBe(Math.min(live.laps, live.leaderLap));
    expect(v.leaderFinished).toBe(live.leaderFinished);
    expect(v.gripLevel).toBe(live.physics.gripLevel);
    live.cars.forEach((c, i) => {
      expect(v.crossings(i), c.entrant.driver.name).toBe(c.crossings);
      expect(v.lapTimes(i)).toEqual(c.lapTimes);
      if (c.crossings >= 0) expect(v.lastCross(i)).toBe(c.lastCross);
      expect(v.finished(i)).toBe(c.finished);
      expect(v.mode(i)).toBe(c.craft.mode);
      expect(v.damage(i)).toBe(c.damageLevel);
      expect(v.plans(i).lapTime).toBe(c.plans.lapTime);
      expect(v.out(i)).toBe(c.dnf && c.status !== 'run');
    });
    // Gaps: the logged gap is the gap at the last checkpoint passed, within a checkpoint of the live one.
    const order = live.order().filter((i) => !live.cars[i].dnf);
    for (let p = 1; p < order.length; p++) {
      const g = v.gap(order[p], order[0]), g0 = live.gapTo(order[p], order[0]);
      if (Number.isFinite(g0)) expect(Math.abs(g - g0)).toBeLessThan(0.5);
    }
  });
});
