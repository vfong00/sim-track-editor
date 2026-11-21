import { type CarModel, type Effects, NO_EFFECTS } from '../physics/model';
import { clamp, type LaneSet, offShare, RUNOFF_DRAG, RUNOFF_GRIP } from './lanes';

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
  /** Grip limit this tick (traffic, run-off), m/s². */
  mu: number;
  /** Sideways speed into the barrier if the car hit it this tick (m/s), else 0. */
  wall: number;
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
  /** No driver input: the car is spinning or crashing, its tires sliding (Phase 5). */
  free?: boolean;
  /** A run-wide mistake: the driver doesn't hold the road edge (Phase 5). */
  runWide?: boolean;
}

/** Sliding friction as a share of grip (a spinning car's tires are dragged, not rolling). */
const SLIDE_FRICTION = 0.8;

export function newCarState(s: number, delta: number, v = 0, dist = s): CarState {
  return { s, dist, delta, vDelta: 0, v, aLong: 0, aLat: 0, usage: 0, slide: 0, mu: 0, wall: 0 };
}

/**
 * Advance one car by dt using the shared physics model (rule 1). Cornering load is the lane
 * curvature times v² plus the driver's own sideways acceleration; whatever grip is left caps
 * driving and braking. Asking for more cornering than the grip allows makes the car slide wide.
 */
export function stepCar(st: CarState, ctl: Controls, model: CarModel, lanes: LaneSet, dt: number, edgeWall = false): void {
  const f0 = ctl.effects ?? NO_EFFECTS;
  // Run-off: less grip and extra rolling drag by how much of the car is off the road.
  const lineD0 = lanes.lineD(st.s);
  const off = offShare(lanes.track, lineD0 + st.delta);
  const f = off > 0 ? { grip: f0.grip * (1 - off * (1 - RUNOFF_GRIP)), drag: f0.drag } : f0;
  // Gravel drag grows with speed: it stops a fast car but lets a crawling one drive out.
  const roll = off * RUNOFF_DRAG * Math.min(1, st.v / 15);
  const mu = model.gripLimit(f);
  st.mu = mu;
  const kappa = lanes.kappa(st.s, st.delta);
  const v0 = st.v;

  // a: what the driver (or the slide) asks of the tires; loss: scrub and rolling drag on top.
  let a: number, aSide: number, loss = 0;
  if (ctl.free) {
    // Spinning: friction slows the car along its direction of travel, which keeps going
    // straight while the road curves away (the unmet cornering −κv² pushes it sideways).
    const dec = SLIDE_FRICTION * mu + roll + model.cd * f.drag * v0 * v0; // all of it is loss, none driven
    a = -Math.min(dec, v0 / dt);
    const vAl = Math.sqrt(Math.max(0, v0 * v0 - st.vDelta * st.vDelta));
    aSide = -kappa * vAl * vAl + (v0 > 1e-6 ? (a * st.vDelta) / v0 : -st.vDelta / dt);
    st.slide = 0;
  } else {
    const aCorner = v0 * v0 * kappa;
    const look = Math.max(v0 * dt, 1e-3);
    const aWant = (ctl.vTarget * ctl.vTarget - v0 * v0) / (2 * look);
    // Sideways: steer toward the target offset with some of the grip left over from cornering.
    const spare = Math.sqrt(Math.max(0, mu * mu - aCorner * aCorner));
    const vdMax = Math.min(ctl.lateralSpeed ?? 3, 0.5 + 0.08 * v0);
    const vdWant = clamp((ctl.deltaTarget - st.delta) * 1.5, -vdMax, vdMax);
    const adMax = 0.4 * spare;
    aSide = clamp((vdWant - st.vDelta) / dt, -adMax, adMax);

    // Over the limit: the tires can only deliver mu; the excess pushes the car to the outside.
    const need = Math.abs(aCorner);
    st.slide = need > mu ? need - mu : 0;
    if (st.slide > 0) aSide -= Math.sign(kappa) * st.slide;

    const aLat = Math.min(Math.abs(aCorner + aSide), mu);
    const aMax = model.maxDrive(v0, aLat, f);
    const bMax = model.maxBrake(v0, aLat, f);
    a = clamp(aWant, -bMax, aMax);
    // A sliding car scrubs speed (the tires are dragged sideways).
    loss = 0.5 * st.slide + roll;
  }

  st.v = Math.max(0, v0 + (a - loss) * dt);
  st.vDelta += aSide * dt;
  // Sideways speed can't exceed the car's speed, except that a car at a standstill can shuffle
  // out at walking pace (turning out from behind a stopped car, nose to its gearbox).
  const vdCap = Math.max(st.v, v0, ctl.free ? 0 : 0.5);
  if (Math.abs(st.vDelta) > vdCap) st.vDelta = Math.sign(st.vDelta) * vdCap;
  const vm = (v0 + st.v) / 2;
  const vAlong = Math.sqrt(Math.max(0, vm * vm - st.vDelta * st.vDelta));
  const adv = (vAlong * dt) / lanes.stretch(st.s, st.delta);
  st.s += adv;
  st.dist += adv;
  if (st.s >= lanes.track.length) st.s -= lanes.track.length;
  st.delta += st.vDelta * dt;

  const lineD = lanes.lineD(st.s);
  // In the run-off the car runs parallel to the road edge, not to the racing line (whose lanes
  // are clamped to the road): it keeps its lateral position d apart from its own sideways speed.
  if (off > 0) st.delta -= lineD - lineD0;
  // On the road, a driven car within its grip follows the road edge (the lanes hug it, and the
  // driver steers along it). Only a slide, a spin, a push in contact or running wide in a
  // mistake takes it past the edge.
  // With `edgeWall` (incidents off) the road edge is a wall for everyone, as before Phase 5.
  if (edgeWall || (off === 0 && !ctl.free && !ctl.runWide && st.slide === 0)) {
    const elo = -lanes.lim - lineD, ehi = lanes.lim - lineD;
    if (st.delta < elo) { st.delta = elo; if (st.vDelta < 0) st.vDelta = 0; }
    if (st.delta > ehi) { st.delta = ehi; if (st.vDelta > 0) st.vDelta = 0; }
  }
  // The barrier at the far side of the run-off.
  st.wall = 0;
  const lo = -lanes.wall - lineD, hi = lanes.wall - lineD;
  if (st.delta < lo || st.delta > hi) {
    st.wall = Math.abs(st.vDelta);
    st.delta = clamp(st.delta, lo, hi);
    st.vDelta = -0.2 * st.vDelta;
    st.v = Math.hypot(Math.sqrt(Math.max(0, st.v * st.v - st.wall * st.wall)), st.vDelta);
  }

  st.aLong = a;
  st.aLat = ctl.free ? 0 : v0 * v0 * kappa + aSide;
  const tire = a + model.cd * f.drag * v0 * v0; // longitudinal tire force per unit mass
  st.usage = Math.hypot(Math.min(Math.abs(st.aLat), mu), tire >= 0 ? tire : tire / model.spec.brake) / mu;
}
