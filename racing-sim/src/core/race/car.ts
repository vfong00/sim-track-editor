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
  /**
   * Sideways speed, m/s: the rate of change of delta, relative to the racing line (which itself
   * moves across the road), except in a spin, where it is the speed across the road
   * (`acrossRoad`; see `toFrame`). In the run-off it moves the car across the road too (see
   * driveInLane), but isn't converted on the way off and back: the incident rates are tuned to
   * that, and converting there doubled the contacts at Monza.
   */
  vDelta: number;
  /** vDelta is across the road (spinning) rather than relative to the racing line. */
  acrossRoad: boolean;
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
  /** Surface grip share under the tyres this tick (1 = clean asphalt; kerbs less). */
  surface: number;
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
  /**
   * Car alongside whose side spacing leaves no room on the road: the driver gives way over the
   * edge instead of holding it (-1 / absent = not squeezed).
   */
  squeezedBy?: number;
}

/** Sideways deceleration (m/s²) of a car easing onto the road edge it holds (see driveInLane). */
export const EDGE_STOP = 15;

/** Sliding friction as a share of grip (a spinning car's tires are dragged, not rolling). */
const SLIDE_FRICTION = 0.8;

export function newCarState(s: number, delta: number, v = 0, dist = s): CarState {
  return { s, dist, delta, vDelta: 0, acrossRoad: false, v, aLong: 0, aLat: 0, usage: 0, slide: 0, mu: 0, wall: 0, surface: 1 };
}

/**
 * The part of a car's sideways speed across the road that comes from following the racing line
 * as it moves across: its slope times the car's speed along the road.
 */
function lineDrift(st: CarState, lanes: LaneSet, vSide: number): number {
  return lanes.lineSlope(st.s) * alongRoad(st, lanes, vSide);
}

/** The car's speed along the centerline (m/s), given its sideways speed. */
function alongRoad(st: CarState, lanes: LaneSet, vSide: number): number {
  return Math.sqrt(Math.max(0, st.v * st.v - vSide * vSide)) / lanes.stretch(st.s, st.delta);
}

/**
 * The car's sideways speed relative to the racing line (m/s), whichever frame vDelta is in,
 * converted with the line's slope `slope` (default: where the car is). Contacts work in this
 * frame: two driven cars on one lane at different speeds move apart along the lane, not across
 * it, though their speeds across the road differ by the line's slope times the difference.
 */
export function lineSideSpeed(st: CarState, lanes: LaneSet, slope = lanes.lineSlope(st.s)): number {
  return st.acrossRoad ? st.vDelta - slope * alongRoad(st, lanes, st.vDelta) : st.vDelta;
}

/**
 * Put vDelta in the frame this tick moves in, keeping the car's motion on the map. Without it a
 * car that began to spin turned on the spot by the racing line's slope (up to ~0.1 rad, more in
 * a chicane): a driven car's heading is its lane's, and a spinning one goes straight across the
 * road. The drift-angle check caught it (a sliding car's nose pointed out of the turn).
 */
export function toFrame(st: CarState, lanes: LaneSet, acrossRoad: boolean): void {
  if (st.acrossRoad === acrossRoad) return;
  // Line → road adds the line's drift; road → line takes it off (worked from the road-frame speed).
  const drift = lineDrift(st, lanes, st.vDelta);
  st.vDelta = clamp(st.vDelta + (acrossRoad ? drift : -drift), -st.v, st.v);
  st.acrossRoad = acrossRoad;
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
  toFrame(st, lanes, !!ctl.free);
  // The surface under the tyres on the road (kerbs), and the share of the car in the run-off.
  st.surface = lanes.surface.carGrip(st.s, lineD0 + st.delta);
  const grip = st.surface * (1 - off * (1 - RUNOFF_GRIP));
  const f = grip !== 1 ? { ...f0, grip: f0.grip * grip } : f0;
  // Gravel drag grows with speed: it stops a fast car but lets a crawling one drive out.
  const roll = off * RUNOFF_DRAG * Math.min(1, st.v / 15);
  const mu = model.gripLimit(f, st.v);
  st.mu = mu;
  const kappa = lanes.kappa(st.s, st.delta);
  const v0 = st.v;

  // a: what the driver (or the slide) asks of the tires; loss: scrub and rolling drag on top.
  let a: number, aSide: number, loss = 0;
  if (ctl.free) {
    // Spinning: friction slows the car along its direction of travel, which keeps going
    // straight while the road curves away (moved on the map below, not in the lanes).
    const dec = SLIDE_FRICTION * mu + roll + model.cd * f.drag * v0 * v0; // all of it is loss, none driven
    a = -Math.min(dec, v0 / dt);
    aSide = 0;
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
  if (ctl.free) {
    slideStraight(st, v0, lanes, dt, lineD0);
  } else {
    driveInLane(st, v0, aSide, lanes, dt, lineD0, off, ctl, edgeWall);
  }
  // The barrier at the far side of the run-off.
  st.wall = 0;
  const lineD = lanes.lineD(st.s);
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

/** A driven car: along its lane at speed v, steering sideways with aSide. */
function driveInLane(st: CarState, v0: number, aSide: number, lanes: LaneSet, dt: number, lineD0: number, off: number, ctl: Controls, edgeWall: boolean): void {
  const delta0 = st.delta;
  st.vDelta += aSide * dt;
  // Sideways speed can't exceed the car's speed, except that a car at a standstill can shuffle
  // out at walking pace (turning out from behind a stopped car, nose to its gearbox).
  const vdCap = Math.max(st.v, v0, 0.5);
  if (Math.abs(st.vDelta) > vdCap) st.vDelta = Math.sign(st.vDelta) * vdCap;
  const vm = (v0 + st.v) / 2;
  const vAlong = Math.sqrt(Math.max(0, vm * vm - st.vDelta * st.vDelta));
  const adv = (vAlong * dt) / lanes.stretch(st.s, st.delta);
  st.s += adv;
  st.dist += adv;
  if (st.s >= lanes.track.length) st.s -= lanes.track.length;
  st.delta += st.vDelta * dt;

  const lineD = lanes.lineD(st.s);
  // A car that holds the road edge comes onto it smoothly. It sits at the racing line plus its
  // offset, and holding that offset while the line runs out toward the edge stopped it dead
  // there: its motion kinked by the line's slope (up to ~0.1 rad). So when holding its offset
  // would take it past the edge within the distance it needs to stop going across, it comes
  // across no faster than it could still stop at EDGE_STOP in the gap left. This limits where
  // it is, not its speed: like the edge itself, it costs no steering and stores no sideways
  // speed relative to the line (cancelling the line's drift with sideways speed threw the car
  // back across the road, into the car beside it, once the line stopped running out to the
  // edge). (A car on the racing line is never held: the line stays LINE_MARGIN inside the road.)
  if (holdsEdge(ctl, off, edgeWall) && st.slide === 0) {
    const d0 = lineD0 + delta0, moved = lineD + st.delta - d0;
    const side = moved > 0 ? 1 : -1;
    const uMax = Math.sqrt(2 * EDGE_STOP * Math.max(0, lanes.lim - side * d0));
    if (side * moved > uMax * dt && runsOff(lanes, st.s, st.delta, side, (Math.abs(moved) / dt) * (Math.abs(moved) / dt / EDGE_STOP + 0.5))) {
      st.delta = d0 + side * uMax * dt - lineD;
      if (st.vDelta * side > 0) st.vDelta = 0;
    }
  }
  // In the run-off the car runs parallel to the road edge, not to the racing line (whose lanes
  // are clamped to the road): it keeps its lateral position d apart from its own sideways speed.
  if (off > 0) st.delta -= lineD - lineD0;
  // On the road, a driven car within its grip follows the road edge (the lanes hug it, and the
  // driver steers along it). Only a slide, a spin, a push in contact, running wide in a mistake
  // or being squeezed by a car alongside (giving way rather than leaning on it) takes it past
  // the edge.
  // With `edgeWall` (incidents off) the road edge is a wall for everyone, as before Phase 5.
  // Held there, it keeps no speed toward the edge relative to the racing line: following its
  // lane is what its cornering load pays for, so it costs no steering. (Holding its speed across
  // the road at zero instead left it carrying the line's drift: when the line stopped running
  // out to the edge, that threw the car back across the road into the car beside it.)
  if (edgeWall || (holdsEdge(ctl, off, false) && st.slide === 0)) {
    const elo = -lanes.lim - lineD, ehi = lanes.lim - lineD;
    if (st.delta < elo) { st.delta = elo; if (st.vDelta < 0) st.vDelta = 0; }
    if (st.delta > ehi) { st.delta = ehi; if (st.vDelta > 0) st.vDelta = 0; }
  }
}

/** Holding offset δ from s for `ahead` metres, does the car pass the road edge on `side`? */
function runsOff(lanes: LaneSet, s: number, delta: number, side: number, ahead: number): boolean {
  const step = lanes.track.ds;
  for (let x = 0; x <= Math.min(ahead, 100); x += step) if (side * (lanes.lineD(s + x) + delta) > lanes.lim) return true;
  return false;
}

/** A driven car that keeps to the road at its edge (see driveInLane); slides aside. */
function holdsEdge(ctl: Controls, off: number, edgeWall: boolean): boolean {
  return edgeWall || (off === 0 && !ctl.free && !ctl.runWide && !((ctl.squeezedBy ?? -1) >= 0));
}

/**
 * A spinning or crashing car: no steering, so it goes straight on the map while the road curves
 * away beneath it. Moved in x, y and put back in the track frame, not along the lanes: they
 * bend with the racing line and bunch up at the road edges, so a "straight" move in the lanes
 * followed the bend and kept a spinning car on the road. In this state vDelta is the car's
 * sideways speed across the road and the rest of v runs along it (what the contacts work in).
 */
function slideStraight(st: CarState, v0: number, lanes: LaneSet, dt: number, lineD0: number): void {
  const track = lanes.track;
  const d0 = lineD0 + st.delta;
  const n0 = track.normalAt(st.s);
  // Tangent is the left normal turned back a quarter (as in Track.toFrame).
  const along = Math.sqrt(Math.max(0, v0 * v0 - st.vDelta * st.vDelta));
  let wx = along * n0.y + st.vDelta * n0.x, wy = -along * n0.x + st.vDelta * n0.y;
  const w = Math.hypot(wx, wy);
  if (w < 1e-9) { st.vDelta = 0; return; }
  wx /= w; wy /= w;
  const vm = (v0 + st.v) / 2;
  const p = track.toXY(st.s, d0);
  const q = track.toFrame(p.x + wx * vm * dt, p.y + wy * vm * dt, st.s, 10);
  let ds = q.s - st.s;
  if (ds > track.length / 2) ds -= track.length;
  else if (ds < -track.length / 2) ds += track.length;
  st.s = q.s;
  st.dist += ds;
  st.delta = q.d - lanes.lineD(q.s);
  // The same velocity in the new frame. Going backwards along the road can't be held in (v,
  // vDelta), so that part is dropped (a car spun round in a hairpin stops a little sooner).
  const n1 = track.normalAt(q.s);
  const u = Math.max(0, st.v * (wx * n1.y - wy * n1.x));
  st.vDelta = st.v * (wx * n1.x + wy * n1.y);
  st.v = Math.hypot(u, st.vDelta);
}
