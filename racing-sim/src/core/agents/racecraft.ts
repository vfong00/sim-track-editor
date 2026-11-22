import type { CarState, Controls } from '../race/car';
import { CAR_WIDTH, clamp, HIT_LEN, HIT_W, type LanePlans, type LaneSet, offShare, RUNOFF_GRIP } from '../race/lanes';
import { type CarModel, dirtyEffects, type PhysicsParams } from '../physics/model';
import type { Rng } from '../rng';
import type { Corner } from '../track/corners';
import { ALONGSIDE, avoidSlowCar, type Near, SIDE_GAP, trafficControls } from './controller';
import type { DriverSpec } from './driver';

/** Range (m) of the wake behind a car… */
export const WAKE_RANGE = 40;
/** …or this many seconds behind at speed, whichever is further. */
export const WAKE_TIME = 1.0;
/** Lateral window (m) of the wake. */
export const WAKE_WIDTH = 2.4;
/**
 * A full tow adds this to the chance of going for a pass at each look. (Letting attacks start
 * from further back, as a time gap, was tried: F1 DNFs doubled with no more passes, because
 * moves from 0.3–0.5 s back mostly end in contact.)
 */
export const TOW_URGE = 0.4;
/** An attacker going for the inside heads for the inside edge from this far before the apex (m). */
export const DIVE_FROM = 150;
/** Dirty air reaches this far behind a car (m). */
export const DIRTY_RANGE = 30;

export type Mode = 'line' | 'attack' | 'defend';

export interface Mistake {
  kind: 'lockup' | 'wide';
  until: number;
  corner: number;
}

/** A driver's memory between ticks. */
export interface Craft {
  mode: Mode;
  /** Car being attacked or defended against. */
  other: number;
  /** Lateral side (+1 left, −1 right) of the attack or defence. */
  side: number;
  /** Corner index the current move is aimed at (defend once per corner). */
  corner: number;
  defendedCorner: number;
  /** Next time (s) the driver reconsiders attacking (decisions aren't made every tick). */
  nextThink: number;
  mistake: Mistake | null;
}

export const newCraft = (): Craft => ({ mode: 'line', other: -1, side: 0, corner: -1, defendedCorner: -1, nextThink: 0, mistake: null });

export interface CraftContext {
  t: number;
  dt: number;
  lanes: LaneSet;
  corners: Corner[];
  nextCorner: Int32Array;
  physics: PhysicsParams;
  /** Safety car (Phase 6): no attacking or defending. */
  neutral?: boolean;
}

export interface CraftCar {
  idx: number;
  st: CarState;
  d: number;
  model: CarModel;
  plans: LanePlans;
  driver: DriverSpec;
  craft: Craft;
  rng: Rng;
}

export interface CraftDecision {
  ctl: Controls;
  following: number;
  /** A mistake that started this tick, for the event feed. */
  mistake: Mistake | null;
}

/** Path distance (m) from s to sample `apex`, going forward. */
function distTo(lanes: LaneSet, s: number, apex: number): number {
  const L = lanes.track.length;
  return (((apex * lanes.track.ds - s) % L) + L) % L;
}

/**
 * Slipstream and dirty air from the car in front (rule 6: trains and battles come from these):
 *  - slipstream cuts drag by up to `physics.slipstream`, fading with distance, on straights only;
 *  - dirty air cuts downforce by up to `physics.dirtyAir` (and mechanical grip by DIRTY_MECH of
 *    that), fading with distance: winged cars feel it far more than road cars.
 * `tow` and `dirty` are how deep in each the car is (0 = clean air, 1 = the fullest).
 */
export function wakeEffects(me: CraftCar, near: Near[], ctx: CraftContext): { grip: number; aero: number; drag: number; tow: number; dirty: number; source: number } {
  // The tow reaches WAKE_RANGE metres, or WAKE_TIME seconds back at speed (a car half a second
  // behind on a fast straight is 40 m back and still well in it).
  const range = Math.max(WAKE_RANGE, me.st.v * WAKE_TIME);
  let best: Near | null = null;
  for (const o of near) {
    if (o.gap <= HIT_LEN || o.gap > range || Math.abs(o.dd) > WAKE_WIDTH || o.v < 10) continue;
    if (!best || o.gap < best.gap) best = o;
  }
  if (!best) return { grip: 1, aero: 1, drag: 1, tow: 0, dirty: 0, source: -1 };
  const straight = Math.abs(ctx.lanes.kappa(me.st.s, me.st.delta)) < 1 / 300;
  const tow = straight ? 1 - best.gap / range : 0;
  const dirty = ctx.physics.dirtyAir > 0 && best.gap < DIRTY_RANGE ? 1 - best.gap / DIRTY_RANGE : 0;
  // The downforce loss fades toward the edge of the wake: a hard edge made a winged car tucking
  // back in behind lose a sixth of its grip in one tick, mid-corner, and spin. (The small
  // mechanical part keeps the hard edge it was tuned with.) Drivers plan for the full depth.
  const side = clamp((WAKE_WIDTH - Math.abs(best.dd)) / (WAKE_WIDTH / 2), 0, 1);
  return { ...dirtyEffects(ctx.physics.dirtyAir, dirty, side * dirty), drag: 1 - ctx.physics.slipstream * tow, tow: ctx.physics.slipstream > 0 ? tow : 0, dirty, source: best.j };
}

/**
 * Phase 4 driver: follow the racing line → pull out to an open side when close behind a slower
 * car → brake later (bravery) → defend the inside once (racecraft) → hold the inside at the apex.
 * The traffic rules (gap and side spacing) still apply on top, so passes come from rules,
 * not scripts.
 */
export function raceCraft(me: CraftCar, near: Near[], cars: CraftCar[], ctx: CraftContext): CraftDecision {
  const { st, craft: cr, driver: drv, plans } = me;
  const { lanes, dt } = ctx;
  const lineD = lanes.lineD(st.s);
  const lim = lanes.lim;
  const i = Math.min(Math.floor(st.s / lanes.track.ds), lanes.track.n - 1);
  const ci = ctx.nextCorner[i];
  const corner = ci >= 0 ? ctx.corners[ci] : null;
  const toCorner = corner ? distTo(lanes, st.s, corner.apex) : Infinity;
  const wake = wakeEffects(me, near, ctx);
  const effects = { grip: wake.grip, aero: wake.aero, drag: wake.drag };

  // Target speed: braking envelope, scaled for dirty air (corner speed ∝ √grip).
  const ahead = st.s + (st.v * dt) / lanes.stretch(st.s, st.delta);
  // How deep in the tow and in dirty air (0 = clean, 1 = full): plan braking for it.
  const depth = { tow: wake.tow, dirty: wake.dirty };
  let vEnv = plans.envelope(ahead, st.delta, depth.tow, depth.dirty);
  // In the run-off: corner speed ∝ √grip, and the driver's only aim is to get back on the road.
  const off = offShare(lanes.track, me.d);
  if (off > 0) vEnv *= Math.sqrt(1 - off * (1 - RUNOFF_GRIP));
  let wantDelta = 0;
  let started: Mistake | null = null;
  const view = { st, d: me.d, model: me.model, plans, lanes, dt, effects };

  // --- Mistakes in progress override everything else.
  if (cr.mistake && ctx.t >= cr.mistake.until) cr.mistake = null;
  if (!cr.mistake) {
    // Chance per second grows with how hard the driver is pushing and how far over the limit.
    // Base rate: an average driver (consistency 0.85) slips about once every 20–25 laps.
    // Beyond the limit (sliding: braking too late, dirty air, a lunge) the rate climbs steeply.
    const excess = st.slide / me.model.gripLimit(undefined, st.v);
    const rate = (1 - drv.consistency) * (0.004 + 4 * excess);
    if (me.rng.next() < rate * dt && st.v > 15) {
      const braking = st.aLong < -3 && toCorner < 200;
      const cornering = Math.abs(st.aLat) > 0.5 * me.model.gripLimit(undefined, st.v);
      if (braking || cornering) {
        cr.mistake = { kind: braking ? 'lockup' : 'wide', until: ctx.t + (braking ? 0.9 : 1.6), corner: ci };
        started = cr.mistake;
        cr.mode = 'line';
      }
    }
  }
  if (cr.mistake) {
    const m = cr.mistake;
    const bMax = me.model.maxBrake(st.v, 0, effects);
    // Lock-up: only ~45% braking, so the car overshoots and runs wide. Wide: off line, slow.
    const outward = corner ? -corner.dir : 0;
    const ctl: Controls = m.kind === 'lockup'
      ? { vTarget: Math.max(0, st.v - 0.45 * bMax * dt), deltaTarget: st.delta, effects }
      : { vTarget: vEnv * 0.88, deltaTarget: clamp(lineD + outward * lim, -lim, lim) - lineD, effects };
    const tc = trafficControls(view, near, avoidSlowCar(view, near, ctl.deltaTarget).delta, ctl.vTarget, 0.95);
    // Running wide goes past the edge by how sloppy the driver is (Phase 5): a consistent one
    // just uses the kerb, an error-prone one drops wheels on the grass. Only if the traffic
    // rules left the outside edge free (nobody out there).
    if (m.kind === 'wide' && outward !== 0 && Math.abs(lineD + tc.ctl.deltaTarget - outward * lim) < 0.05) {
      const over = 2 * CAR_WIDTH * (1 - drv.consistency);
      return { ctl: { ...tc.ctl, deltaTarget: outward * (lim + over) - lineD, runWide: true, effects }, following: tc.following, mistake: started };
    }
    return { ctl: { ...tc.ctl, effects }, following: tc.following, mistake: started };
  }

  // --- A slow or stopped car ahead: steer round it, no racing until past.
  const avoid = avoidSlowCar(view, near, 0);
  if (avoid.hazard >= 0 || off > 0.5 || ctx.neutral) cr.mode = 'line';

  // --- Who is directly in front (roughly in line) and who is close behind.
  let front: Near | null = null, behind: Near | null = null;
  for (const o of near) {
    if (o.gap > HIT_LEN - 0.5 && o.gap < 60 && Math.abs(o.dd) < HIT_W + 1 && (!front || o.gap < front.gap)) front = o;
    if (o.gap < -HIT_LEN + 0.5 && o.gap > -25 && (!behind || o.gap > behind.gap)) behind = o;
  }
  // Cars alongside, by side (+1 = on my left).
  let leftBusy = false, rightBusy = false, anyAlongside = false, allOutside = true;
  for (const o of near) {
    if (Math.abs(o.gap) >= ALONGSIDE || Math.abs(o.dd) < 1.2) continue;
    anyAlongside = true;
    if (o.dd > 0) leftBusy = true;
    else rightBusy = true;
    if (corner && Math.sign(-o.dd) !== corner.dir) allOutside = false;
  }

  // --- Attack: decide (a few times a second) whether to have a go at the car in front.
  if (cr.mode === 'line' && !ctx.neutral && avoid.hazard < 0 && off === 0 && front && ctx.t >= cr.nextThink) {
    cr.nextThink = ctx.t + 0.5;
    const target = cars[front.j];
    const faster = target.plans.lapTime - plans.lapTime; // s per lap the attacker is quicker
    const closing = st.v - front.v;
    const close = front.gap < 14 + 6 * drv.aggression;
    // A reason to go: a pace advantage, a run on the car (closing speed) or a deep tow.
    // Aggression alone only rarely starts a move on an equal car.
    const want = drv.aggression * 0.15 + Math.max(0, faster) * 0.8 + (closing > 1 ? 0.3 : 0) + TOW_URGE * depth.tow;
    if (close && toCorner > 60 && me.rng.next() < want) {
      // Prefer the inside of the next corner, else the other side, if there's room.
      const inside = corner ? corner.dir : 1;
      for (const side of [inside, -inside]) {
        // The inside is open if the leader isn't covering it (the racing line approaches from
        // the outside, so usually it is); the outside needs room beside the leader now.
        const open = corner && side === corner.dir ? side * lim - side * target.d >= SIDE_GAP : Math.abs(target.d + side * (SIDE_GAP + 0.3)) <= lim;
        if (!open) continue;
        if (side > 0 ? leftBusy : rightBusy) continue;
        cr.mode = 'attack';
        cr.other = front.j;
        cr.side = side;
        cr.corner = ci;
        break;
      }
    }
  }

  let brave = 1;
  if (cr.mode === 'attack') {
    let o: Near | undefined;
    for (const x of near) if (x.j === cr.other) o = x;
    const passed = !o || o.gap < -ALONGSIDE;
    const dropped = o && o.gap > 35;
    const beatenAtApex = o && toCorner < 8 && corner && ci === cr.corner && o.gap > HIT_LEN;
    if (passed || dropped || beatenAtApex || ci !== cr.corner && o && o.gap > ALONGSIDE) {
      cr.mode = 'line';
    } else if (o) {
      // The leader's line swings across the road; if our side runs out of room, use the other.
      const room = (side: number) => side * (side * lim - o.d) >= SIDE_GAP;
      const busy = (side: number) => (side > 0 ? leftBusy : rightBusy) && Math.sign(o.dd) !== side;
      // Only while still well back: once close, hold the side so the leader's turn-in meets a car
      // alongside (the side-spacing rule then leaves room) instead of chasing the attacker out wide.
      const committed = o.gap < ALONGSIDE + 6;
      if (!committed && !room(cr.side) && room(-cr.side) && !busy(-cr.side)) cr.side = -cr.side;
      // Into the corner on the inside: dive for the inside edge (the leader's line sweeps across
      // from the outside, so sitting a car's width off the leader would be squeezed onto the same
      // edge behind it). Elsewhere, sit a car's width off the leader.
      const dive = corner && ci === cr.corner && cr.side === corner.dir && toCorner < DIVE_FROM && room(cr.side);
      wantDelta = (dive ? cr.side * lim : clamp(o.d + cr.side * (SIDE_GAP + 0.3), -lim, lim)) - lineD;
      // Brave: brake later while fighting for the corner (not a higher cornering speed). The
      // planned braking leaves a margin (BRAKE_USE ≈ 3% of speed); an average driver uses about
      // two thirds of it, the bravest a little more than all of it (and may overshoot).
      if (Math.abs(o.gap) < 12) brave = 1 + 0.04 * drv.bravery;
    }
  }

  // --- Defend: one move to the inside of the next corner when someone is close behind.
  if (cr.mode === 'line' && !ctx.neutral && avoid.hazard < 0 && off === 0 && behind && corner && cr.defendedCorner !== ci && toCorner < 220 && toCorner > 40) {
    const threat = cars[behind.j];
    const attacking = threat.craft.mode === 'attack' && threat.craft.other === me.idx;
    if ((attacking || behind.v > st.v + 1.5) && behind.gap > -15 && me.rng.next() < drv.racecraft * 0.6) {
      cr.mode = 'defend';
      cr.side = corner.dir;
      cr.corner = ci;
      cr.other = behind.j;
    }
    cr.defendedCorner = ci; // the decision (either way) is made once per corner
  }
  if (cr.mode === 'defend') {
    if (ci !== cr.corner) cr.mode = 'line';
    else wantDelta = clamp(cr.side * (lim - 1), -lim, lim) - lineD;
  }

  // --- Side by side into a corner: whoever is on the inside keeps the inside line.
  if (cr.mode === 'line' && corner && toCorner < 150 && anyAlongside && allOutside) wantDelta = st.delta;
  if (avoid.hazard >= 0) wantDelta = avoidSlowCar(view, near, wantDelta).delta;

  // Only in the braking zone (the envelope asks to slow down) and before the turn-in: the car
  // brakes later and less, but never speeds up from it, and corner speed is unchanged.
  wantDelta = feasibleDelta(me, wantDelta, depth, ahead);
  const braveNow = brave > 1 && vEnv < st.v && toCorner > 30;
  if (braveNow) vEnv = Math.min(st.v, vEnv * brave);
  const tc = trafficControls(view, near, wantDelta, vEnv);
  // Moving across the road: respect the speed of the lane we're heading for too, so a car isn't
  // carried onto a tighter line faster than it can take it.
  let vLane = plans.envelope(ahead, tc.ctl.deltaTarget, depth.tow, depth.dirty);
  if (braveNow) vLane = Math.min(st.v, vLane * brave);
  const ctl = { ...tc.ctl, vTarget: Math.min(tc.ctl.vTarget, vLane), effects };
  return { ctl, following: tc.following, mistake: started };
}

/**
 * A driver doesn't steer onto a lane it can't take at its current speed: at the cornering limit
 * there is no grip left to slow down, so tightening the line mid-corner would only slide. Moves
 * the wanted offset back toward the current one until the lane's braking envelope (just ahead
 * and a little further on) allows the current speed.
 */
function feasibleDelta(me: CraftCar, want: number, depth: { tow: number; dirty: number }, ahead: number): number {
  const { st, plans } = me;
  const ok = (delta: number) =>
    plans.envelope(ahead, delta, depth.tow, depth.dirty) >= st.v * 0.995 &&
    plans.envelope(ahead + st.v * 0.5, delta, depth.tow, depth.dirty) >= st.v * 0.995;
  if (ok(want)) return want;
  for (let f = 0.75; f > 0; f -= 0.25) {
    const d = st.delta + (want - st.delta) * f;
    if (ok(d)) return d;
  }
  return st.delta;
}
