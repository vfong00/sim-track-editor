import type { Controls } from '../race/car';
import { CAR_RADIUS, clamp, type LanePlans, type LaneSet } from '../race/lanes';
import type { CarModel } from '../physics/model';
import type { CarState } from '../race/car';

/** Another car as seen from one car: path distance ahead (negative = behind) and lateral gap. */
export interface Near {
  j: number;
  /** o.s − me.s, wrapped to [−L/2, L/2). */
  gap: number;
  /** o.d − me.d. */
  dd: number;
  d: number;
  v: number;
}

/** Lateral clearance two cars keep when side by side (centre to centre). */
export const SIDE_GAP = 2 * CAR_RADIUS + 0.4;
/** Longitudinal distance within which a car counts as alongside. */
export const ALONGSIDE = 2 * CAR_RADIUS + 2;

export interface DriverView {
  st: CarState;
  d: number;
  model: CarModel;
  plans: LanePlans;
  lanes: LaneSet;
  dt: number;
}

export interface TrafficDecision {
  ctl: Controls;
  /** Index of the car this one is queued behind (same lane, within the follow window), or -1. */
  following: number;
}

/**
 * Phase 3 traffic rules, which the Phase 4 race craft builds on:
 *  - lateral: aim for `wantDelta` (racing line = 0) but keep SIDE_GAP from any car alongside,
 *    staying on the side you are already on;
 *  - longitudinal: never close on a car ahead in your lane faster than you could brake to its
 *    speed before reaching it (the same-lane gap rule: you can't drive through a car).
 */
export function trafficControls(me: DriverView, near: Near[], wantDelta: number, vPlan: number, brakeGain = 0.97): TrafficDecision {
  const { st, lanes } = me;
  const lineD = lanes.lineD(st.s);
  let lo = -Infinity, hi = Infinity;
  for (const o of near) {
    if (Math.abs(o.gap) >= ALONGSIDE || Math.abs(o.dd) < 1.2) continue;
    if (o.dd > 0) hi = Math.min(hi, o.d - SIDE_GAP - lineD);
    else lo = Math.max(lo, o.d + SIDE_GAP - lineD);
  }
  let deltaTarget = lo > hi ? st.delta : clamp(wantDelta, lo, hi);
  deltaTarget = clamp(deltaTarget, -lanes.lim - lineD, lanes.lim - lineD);
  const targetD = lineD + deltaTarget;

  let vTarget = vPlan;
  let following = -1;
  const look = 25 + st.v * 2.5;
  // Both cars' real straight-line braking (same model as the integrator); the follower only
  // counts on a share of its own so it keeps a margin for reaction.
  const b = brakeGain * me.model.maxBrake(st.v, 0);
  for (const o of near) {
    if (o.gap <= 0 || o.gap > look) continue;
    const overlap = Math.min(Math.abs(o.d - me.d), Math.abs(o.d - targetD)) < 2 * CAR_RADIUS + 0.2;
    if (!overlap) continue;
    const bo = me.model.maxBrake(o.v, 0);
    const room = o.gap - 2 * CAR_RADIUS - 1.0 - 0.03 * st.v;
    const vAllowed = room > 0 ? Math.sqrt(o.v * o.v * (b / bo) + 2 * b * room) : Math.max(0, o.v - 2 + room);
    if (vAllowed < vTarget) {
      vTarget = vAllowed;
      following = o.j;
    }
  }
  return { ctl: { vTarget, deltaTarget }, following };
}
