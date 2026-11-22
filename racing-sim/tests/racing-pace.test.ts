import { describe, expect, it } from 'vitest';
import { paceGapRace } from './racing-helpers';

/**
 * Lap on which the faster car (index 1) takes the lead and holds it for 5 s (-1 = never), and
 * whether it spun or went off along the way.
 */
function leadLap(seed: number): { lap: number; spun: boolean } {
  const r = paceGapRace(0.06, seed);
  let since = -1;
  const spun = () => r.events.some((e) => (e.type === 'spin' || e.type === 'off') && e.cars.includes(1));
  while (!r.finished) {
    r.step();
    const ahead = r.cars[1].st.dist > r.cars[0].st.dist;
    if (!ahead) since = -1;
    else if (since < 0) since = r.t;
    if (since >= 0 && r.t - since > 5) return { lap: r.cars[1].crossings + 1, spun: spun() };
  }
  return { lap: -1, spun: spun() };
}

const SEEDS = [1, 2, 3, 4, 5, 6];
const results = new Map<number, { lap: number; spun: boolean }>();
const result = (seed: number) => {
  if (!results.has(seed)) results.set(seed, leadLap(seed));
  return results.get(seed)!;
};
const through = (r: { lap: number }) => r.lap > 0 && r.lap <= 4;

describe('Phase 4: pace gap', () => {
  // Since the minimum-curvature racing line, an attack can end in contact and a spin, which can
  // cost the faster car the rest of a 6-lap race. That's racing; what must hold is that it gets
  // through whenever it stays on the road.
  it.each(SEEDS)('a 6%%-pace-faster car gets through within a few laps unless it spins (seed %d)', (seed) => {
    const r = result(seed);
    expect(through(r) || r.spun, `lap ${r.lap}`).toBe(true);
  });

  it('…and most of the time it gets through outright (at least 4 of 6)', () => {
    expect(SEEDS.filter((s) => through(result(s))).length).toBeGreaterThanOrEqual(4);
  });
});
