import type { CarState, Controls } from '../race/car';
import { CAR_RADIUS, clamp, type LanePlans, type LaneSet } from '../race/lanes';
import type { CarModel, PhysicsParams } from '../physics/model';
import type { Rng } from '../rng';
import type { Corner } from '../track/corners';
import { ALONGSIDE, type Near, SIDE_GAP, trafficControls } from './controller';
import type { DriverSpec } from './driver';

/** Range (m) and lateral window (m) of the wake behind a car. */
export const WAKE_RANGE = 40;
export const WAKE_WIDTH = 2.4;
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
 *  - dirty air cuts grip by up to `physics.dirtyAir`, fading with distance.
 */
export function wakeEffects(me: CraftCar, near: Near[], ctx: CraftContext): { grip: number; drag: number; source: number } {
  let best: Near | null = null;
  for (const o of near) {
    if (o.gap <= 2 * CAR_RADIUS || o.gap > WAKE_RANGE || Math.abs(o.dd) > WAKE_WIDTH) continue;
    if (!best || o.gap < best.gap) best = o;
  }
  if (!best) return { grip: 1, drag: 1, source: -1 };
  const straight = Math.abs(ctx.lanes.kappa(me.st.s, me.st.delta)) < 1 / 300;
  const slip = straight ? ctx.physics.slipstream * (1 - best.gap / WAKE_RANGE) : 0;
  const dirty = best.gap < DIRTY_RANGE ? ctx.physics.dirtyAir * (1 - best.gap / DIRTY_RANGE) : 0;
  return { grip: 1 - dirty, drag: 1 - slip, source: best.j };
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
  const effects = { grip: wake.grip, drag: wake.drag };

  // Target speed: braking envelope, scaled for dirty air (corner speed ∝ √grip).
  const ahead = st.s + (st.v * dt) / lanes.stretch(st.s, st.delta);
  let vEnv = plans.envelope(ahead, st.delta) * Math.sqrt(wake.grip);
  let wantDelta = 0;
  let started: Mistake | null = null;

  // --- Mistakes in progress override everything else.
  if (cr.mistake && ctx.t >= cr.mistake.until) cr.mistake = null;
  if (!cr.mistake) {
    // Chance per second grows with how hard the driver is pushing and how far over the limit.
    // Base rate: an average driver (consistency 0.85) slips about once every 20–25 laps.
    // Beyond the limit (sliding: braking too late, dirty air, a lunge) the rate climbs steeply.
    const excess = st.slide / me.model.mu;
    const rate = (1 - drv.consistency) * (0.004 + 4 * excess);
    if (me.rng.next() < rate * dt && st.v > 15) {
      const braking = st.aLong < -3 && toCorner < 200;
      const cornering = Math.abs(st.aLat) > 0.5 * me.model.mu;
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
    const tc = trafficControls({ st, d: me.d, model: me.model, plans, lanes, dt }, near, ctl.deltaTarget, ctl.vTarget, 0.95);
    return { ctl: { ...tc.ctl, effects }, following: tc.following, mistake: started };
  }

  // --- Who is directly in front (roughly in line) and who is close behind.
  let front: Near | null = null, behind: Near | null = null;
  for (const o of near) {
    if (o.gap > 2 * CAR_RADIUS - 0.5 && o.gap < 60 && Math.abs(o.dd) < 3.5 && (!front || o.gap < front.gap)) front = o;
    if (o.gap < -2 * CAR_RADIUS + 0.5 && o.gap > -25 && (!behind || o.gap > behind.gap)) behind = o;
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
  if (cr.mode === 'line' && front && ctx.t >= cr.nextThink) {
    cr.nextThink = ctx.t + 0.5;
    const target = cars[front.j];
    const faster = target.plans.lapTime - plans.lapTime; // s per lap the attacker is quicker
    const closing = st.v - front.v;
    const close = front.gap < 14 + 6 * drv.aggression;
    const want = drv.aggression * 0.6 + Math.max(0, faster) * 0.8 + (closing > 1 ? 0.3 : 0);
    if (close && toCorner > 60 && me.rng.next() < want) {
      // Prefer the inside of the next corner, else the other side, if there's room.
      const inside = corner ? corner.dir : 1;
      for (const side of [inside, -inside]) {
        const d = target.d + side * (SIDE_GAP + 0.3);
        if (Math.abs(d) > lim) continue;
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
    const beatenAtApex = o && toCorner < 8 && corner && ci === cr.corner && o.gap > 2 * CAR_RADIUS;
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
      wantDelta = clamp(o.d + cr.side * (SIDE_GAP + 0.3), -lim, lim) - lineD;
      // Brave: carry more speed into the braking zone while fighting for the corner.
      if (Math.abs(o.gap) < 12) brave = 1 + 0.05 * drv.bravery;
    }
  }

  // --- Defend: one move to the inside of the next corner when someone is close behind.
  if (cr.mode === 'line' && behind && corner && cr.defendedCorner !== ci && toCorner < 220 && toCorner > 40) {
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

  vEnv *= brave;
  const tc = trafficControls({ st, d: me.d, model: me.model, plans, lanes, dt }, near, wantDelta, vEnv);
  return { ctl: { ...tc.ctl, effects }, following: tc.following, mistake: started };
}
