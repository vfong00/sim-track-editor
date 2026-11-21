import { describe, expect, it } from 'vitest';
import {
  CarModel, centerlinePath, DT, G, generateTrack, LanePlans, LaneSet, newCarState, racingLine,
  simulateLap, solveSpeedProfile, STANDARD_CAR, stepCar, Track, type PathLike,
} from '../src/core';
import { circle, stadium } from './helpers';

const model = new CarModel(STANDARD_CAR);
const noDrag = new CarModel(STANDARD_CAR, { drag: false });

const straightPath = (len: number): PathLike => ({
  n: len + 1, segLen: new Float64Array(len + 1).fill(1), kappa: new Float64Array(len + 1), closed: false,
});

/** Distance at which an increasing (or decreasing) node array first crosses `x`, interpolated. */
function crossing(v: Float64Array, x: number, from = 0, rising = true): number {
  for (let i = from; i < v.length - 1; i++) {
    const a = v[i], b = v[i + 1];
    if (rising ? a < x && b >= x : a >= x && b < x) return i + (x - a) / (b - a);
  }
  return NaN;
}

describe('friction circle model', () => {
  it('drive equals drag at top speed, and grip is shared between cornering and braking', () => {
    expect(model.maxDrive(STANDARD_CAR.topSpeed, 0)).toBeCloseTo(0, 9);
    expect(model.maxBrake(10, model.mu)).toBeCloseTo(model.cd * 100, 9);
    expect(model.maxBrake(0, 0.6 * model.mu)).toBeCloseTo(0.8 * model.mu, 9);
  });
});

describe('constant-radius circle', () => {
  it.each([30, 80, 200])('speed on radius %d m equals sqrt(grip·g·r)', (r) => {
    const t = Track.fromPolyline(circle(r, 8000), 14);
    const exact = Math.sqrt(STANDARD_CAR.grip * G * r);
    // Without drag this is exactly the textbook sqrt(mu·r).
    for (const v of solveSpeedProfile(centerlinePath(t), noDrag).v) expect(Math.abs(v / exact - 1)).toBeLessThan(0.002);
    // With drag the tires must also push against c·v², so v⁴(1/r² + c²) = mu²: a bit slower.
    const withDrag = Math.sqrt(model.mu / Math.hypot(1 / r, model.cd));
    expect(withDrag).toBeLessThan(exact);
    for (const v of solveSpeedProfile(centerlinePath(t), model).v) expect(Math.abs(v / withDrag - 1)).toBeLessThan(0.002);
    // ...and the time-stepped car holds that speed round the circle without exceeding grip.
    const lanes = new LaneSet(t, centerlinePath(t));
    const plans = new LanePlans(lanes, noDrag);
    const lap = simulateLap(lanes, plans, noDrag);
    expect(Math.abs(lap.lapTime / ((2 * Math.PI * r) / exact) - 1)).toBeLessThan(0.003);
    expect(lap.maxUsage).toBeLessThan(1.005);
  });
});

describe('straight-line distances match the formulas', () => {
  const A = Math.min(STANDARD_CAR.accel, model.mu); // tire-limited launch
  const B = STANDARD_CAR.brake * model.mu;
  const c = model.cd;
  const accelDist = (v0: number, v1: number) => Math.log((A - c * v0 * v0) / (A - c * v1 * v1)) / (2 * c);
  const brakeDist = (v1: number, v0: number) => Math.log((B + c * v1 * v1) / (B + c * v0 * v0)) / (2 * c);

  it('solver: acceleration and braking distances', () => {
    const p = straightPath(4000);
    const acc = solveSpeedProfile(p, model, { v0: 0 });
    for (const v1 of [30, 50, 70]) expect(crossing(acc.v, v1) / accelDist(0, v1)).toBeCloseTo(1, 2);
    const nd = solveSpeedProfile(p, noDrag, { v0: 0 });
    expect(crossing(nd.v, 50) / (2500 / (2 * A))).toBeCloseTo(1, 2);

    const brk = solveSpeedProfile(p, model, { v0: 75, vEnd: 20 });
    const start = crossing(brk.v, 75, 1000, false);
    expect((4000 - start) / brakeDist(75, 20)).toBeCloseTo(1, 2);
    const nb = solveSpeedProfile(p, noDrag, { v0: 75, vEnd: 20 });
    expect((4000 - crossing(nb.v, 75, 1000, false)) / ((75 * 75 - 400) / (2 * B))).toBeCloseTo(1, 2);
  });

  it('time-stepped car: acceleration and braking distances', () => {
    const t = stadium(3000, 150);
    const lanes = new LaneSet(t, centerlinePath(t));
    for (const m of [model, noDrag]) {
      const cc = m.cd;
      const st = newCarState(0, 0, 0, 0);
      let at50 = NaN;
      while (st.v < 70) {
        const s0 = st.dist, v0 = st.v;
        stepCar(st, { vTarget: 1e3, deltaTarget: 0 }, m, lanes, DT);
        if (v0 < 50 && st.v >= 50) at50 = s0 + ((st.dist - s0) * (50 - v0)) / (st.v - v0);
      }
      const expectAcc = cc > 0 ? Math.log(A / (A - cc * 2500)) / (2 * cc) : 2500 / (2 * A);
      expect(Math.abs(at50 / expectAcc - 1)).toBeLessThan(0.01);

      const from = st.dist, v1 = st.v;
      while (st.v > 20) stepCar(st, { vTarget: 0, deltaTarget: 0 }, m, lanes, DT);
      const expectBrk = cc > 0 ? Math.log((B + cc * v1 * v1) / (B + cc * st.v * st.v)) / (2 * cc) : (v1 * v1 - st.v * st.v) / (2 * B);
      expect(Math.abs((st.dist - from) / expectBrk - 1)).toBeLessThan(0.01);
      expect(st.dist).toBeLessThan(3000); // all of it on the straight
    }
  });
});

describe('one lap', () => {
  it('solver lap time and time-stepped lap time agree within 1%', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const t = generateTrack({ seed });
      const lanes = new LaneSet(t);
      const plans = new LanePlans(lanes, model);
      const lap = simulateLap(lanes, plans, model);
      expect(Math.abs(lap.lapTime / plans.lapTime - 1), `seed ${seed}`).toBeLessThan(0.01);
      expect(lap.maxUsage, `seed ${seed} grip`).toBeLessThan(1.01);
    }
  });

  it('racing line is faster than the centerline on every generated track, and stays on the road', () => {
    for (let seed = 0; seed < 100; seed++) {
      const t = generateTrack({ seed });
      const line = racingLine(t);
      for (const d of line.d) expect(Math.abs(d)).toBeLessThanOrEqual(t.width / 2);
      const lineTime = solveSpeedProfile(line, model).lapTime;
      const centerTime = solveSpeedProfile(centerlinePath(t), model).lapTime;
      expect(lineTime, `seed ${seed}`).toBeLessThan(centerTime);
    }
  }, 60_000);
});
