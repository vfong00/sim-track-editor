import { describe, expect, it } from 'vitest';
import { paceGapRace } from './racing-helpers';

/** Lap on which the faster car (index 1) takes the lead and holds it for 5 s; -1 = never. */
function leadLap(seed: number): number {
  const r = paceGapRace(0.06, seed);
  let since = -1;
  while (!r.finished) {
    r.step();
    const ahead = r.cars[1].st.dist > r.cars[0].st.dist;
    if (!ahead) since = -1;
    else if (since < 0) since = r.t;
    if (since >= 0 && r.t - since > 5) return r.cars[1].crossings + 1;
  }
  return -1;
}

describe('Phase 4: pace gap', () => {
  it.each([1, 2, 3, 4, 5, 6])('a 6%%-pace-faster car gets through within a few laps (seed %d)', (seed) => {
    const lap = leadLap(seed);
    expect(lap).toBeGreaterThan(0);
    expect(lap).toBeLessThanOrEqual(4);
  });
});
