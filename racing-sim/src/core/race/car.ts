import { type CarModel, type Effects, NO_EFFECTS } from '../physics/model';
import { clamp, type LaneSet } from './lanes';

/** Kinematic state of one car in the track's (s, d) frame. */
export interface CarState {
  /** Centerline position in [0, length). */
  s: number;
  /** Total centerline distance covered since the start (race progress; negative on the grid). */
  dist: number;
  /** Sideways offset from the racing line (lane coordinate), m. */
  delta: number;
  /** Rate of change of delta, m/s. */
  vDelta: number;
  /** Speed along the path, m/s. */
  v: number;
  /** Last tick's longitudinal and lateral acceleration (m/s²) and friction-circle usage (1 = limit). */
  aLong: number;
  aLat: number;
  usage: number;
  /** How far the car was asked to corner beyond its grip (m/s², 0 when within the limit). */
  slide: number;
}

export interface Controls {
  /** Target speed one tick ahead (the driver's speed plan, already adjusted for traffic). */
  vTarget: number;
  /** Desired lateral offset from the racing line. */
  deltaTarget: number;
  /** Traffic effects on the car this tick. */
  effects?: Effects;
  /** Max lateral speed the driver uses to change lanes (m/s). */
  lateralSpeed?: number;
}

export function newCarState(s: number, delta: number, v = 0, dist = s): CarState {
  return { s, dist, delta, vDelta: 0, v, aLong: 0, aLat: 0, usage: 0, slide: 0 };
}

/**
 * Advance one car by dt using the shared physics model (rule 1). Cornering load is the lane
 * curvature times v² plus the driver's own sideways acceleration; whatever grip is left caps
 * driving and braking. Asking for more cornering than the grip allows makes the car slide wide.
 */
export function stepCar(st: CarState, ctl: Controls, model: CarModel, lanes: LaneSet, dt: number): void {
  const f = ctl.effects ?? NO_EFFECTS;
  const mu = model.gripLimit(f);
  const kappa = lanes.kappa(st.s, st.delta);
  const aCorner = st.v * st.v * kappa;

  // Sideways: steer toward the target offset with some of the grip left over from cornering.
  const spare = Math.sqrt(Math.max(0, mu * mu - aCorner * aCorner));
  const vdMax = Math.min(ctl.lateralSpeed ?? 3, 0.5 + 0.08 * st.v);
  const vdWant = clamp((ctl.deltaTarget - st.delta) * 1.5, -vdMax, vdMax);
  const adMax = 0.4 * spare;
  let aSide = clamp((vdWant - st.vDelta) / dt, -adMax, adMax);

  // Over the limit: the tires can only deliver mu; the excess pushes the car to the outside.
  const need = Math.abs(aCorner);
  st.slide = need > mu ? need - mu : 0;
  if (st.slide > 0) aSide -= Math.sign(kappa) * st.slide;

  const aLat = Math.min(Math.abs(aCorner + aSide), mu);
  const aMax = model.maxDrive(st.v, aLat, f);
  const bMax = model.maxBrake(st.v, aLat, f);
  const look = Math.max(st.v * dt, 1e-3);
  const a = clamp((ctl.vTarget * ctl.vTarget - st.v * st.v) / (2 * look), -bMax, aMax);

  const v0 = st.v;
  st.v = Math.max(0, v0 + a * dt);
  st.vDelta += aSide * dt;
  const vm = (v0 + st.v) / 2;
  const vAlong = Math.sqrt(Math.max(0, vm * vm - st.vDelta * st.vDelta));
  const adv = (vAlong * dt) / lanes.stretch(st.s, st.delta);
  st.s += adv;
  st.dist += adv;
  if (st.s >= lanes.track.length) st.s -= lanes.track.length;
  st.delta += st.vDelta * dt;

  // Stay on the road: offsets beyond the edge are clamped (and lose their sideways speed).
  const lineD = lanes.lineD(st.s);
  const lo = -lanes.lim - lineD, hi = lanes.lim - lineD;
  if (st.delta < lo) { st.delta = lo; if (st.vDelta < 0) st.vDelta = 0; }
  if (st.delta > hi) { st.delta = hi; if (st.vDelta > 0) st.vDelta = 0; }

  st.aLong = a;
  st.aLat = aCorner + aSide;
  const tire = a + model.cd * f.drag * v0 * v0; // longitudinal tire force per unit mass
  st.usage = Math.hypot(Math.min(Math.abs(st.aLat), mu), tire >= 0 ? tire : tire / model.spec.brake) / mu;
}
