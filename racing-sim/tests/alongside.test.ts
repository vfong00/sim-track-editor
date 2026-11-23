import { describe, expect, it } from 'vitest';
import { CAR_PRESETS, CarModel, generateTrack, HIT_LEN, HIT_W, LanePlans, LaneSet, newCarState, trafficControls, type Near } from '../src/core';

/**
 * Two cars side by side are not a queue. Out of T6 at Yas (F1 constructors, seed 1, 6:31) a car
 * level with another, 2.1 m apart, was treated by the gap rule as following one 0.7–1.2 m ahead
 * and braked at −40 m/s² to tuck in behind it.
 */
describe('cars alongside', () => {
  const lanes = new LaneSet(generateTrack({ seed: 7, width: 14 }));
  const model = new CarModel({ id: 'f1', ...CAR_PRESETS.f1 });
  const plans = new LanePlans(lanes, model);
  // A straight stretch, on the racing line, at 45 m/s.
  let s = 0;
  for (let i = 0; i < lanes.track.n; i++) if (Math.abs(lanes.track.curvature[i]) < 1e-4) { s = i * lanes.track.ds; break; }
  const st = newCarState(s, 0, 45);
  const me = { st, d: lanes.lineD(s), model, plans, lanes, dt: 1 / 60 };
  const beside = (gap: number, dd: number, v = 45): Near => ({ j: 1, gap, dd, d: me.d + dd, v });

  it('a car alongside, not touching, does not slow me', () => {
    for (const gap of [0.3, 0.7, 1.2, HIT_LEN - 0.1]) {
      const tc = trafficControls(me, [beside(gap, HIT_W + 0.1)], 0, 45);
      expect(tc.ctl.vTarget, `gap ${gap}`).toBe(45);
      expect(tc.following).toBe(-1);
    }
  });

  it('a car in line ahead still does', () => {
    expect(trafficControls(me, [beside(HIT_LEN + 2, 0.3, 30)], 0, 45).ctl.vTarget).toBeLessThan(45);
  });

});
