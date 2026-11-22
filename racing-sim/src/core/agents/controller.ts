import type { Controls } from '../race/car';
import { clamp, HIT_LEN, HIT_W, type LanePlans, type LaneSet } from '../race/lanes';
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
export const SIDE_GAP = HIT_W + 0.6;
/** Longitudinal distance within which a car counts as alongside. */
export const ALONGSIDE = HIT_LEN + 2;

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
  // Aim within the road, but side spacing wins: a car squeezed onto the grass stays there until
  // there's room to come back (steering back into a car alongside would only lean on it).
  const onRoad = clamp(wantDelta, -lanes.lim - lineD, lanes.lim - lineD);
  let deltaTarget = lo > hi ? st.delta : clamp(onRoad, lo, hi);
  deltaTarget = clamp(deltaTarget, -lanes.wall - lineD, lanes.wall - lineD);
  const targetD = lineD + deltaTarget;

  let vTarget = vPlan;
  let following = -1;
  const look = 25 + st.v * 2.5;
  // Both cars' real straight-line braking (same model as the integrator); the follower only
  // counts on a share of its own so it keeps a margin for reaction.
  const b = brakeGain * me.model.maxBrake(st.v, 0);
  // A car far slower than me (spun, stopped, crawling back on): seen from further away, and I
  // plan to stop for it with the braking I really have, which mid-corner is what the cornering
  // leaves over (Phase 5: hitting one is no longer just a bump).
  const slow = Math.max(6, 0.5 * st.v);
  const aCorner = Math.abs(st.v * st.v * lanes.kappa(st.s, st.delta));
  const bHaz = brakeGain * me.model.maxBrake(st.v, Math.min(aCorner, 0.95 * me.model.gripLimit(undefined, st.v)));
  for (const o of near) {
    const hazard = o.v < slow;
    if (o.gap <= 0 || o.gap > (hazard ? 40 + 4 * st.v : look)) continue;
    // A hazard is judged where I'll be when I reach it (my lane and my target lane at its s): the
    // racing line can sweep across the road on the way, so a wreck beside the line further on
    // is in my path even when it's far to the side of me now.
    let dist = Math.min(Math.abs(o.d - me.d), Math.abs(o.d - targetD));
    if (hazard) {
      const at = st.s + o.gap;
      dist = Math.min(dist, Math.abs(o.d - lanes.dOf(at, st.delta)), Math.abs(o.d - lanes.dOf(at, deltaTarget)));
    }
    const overlap = dist < HIT_W + 0.2;
    if (!overlap) continue;
    const bo = me.model.maxBrake(o.v, 0);
    const room = o.gap - HIT_LEN - 1.0 - 0.03 * st.v;
    const bb = hazard ? bHaz : b;
    let vAllowed = room > 0 ? Math.sqrt(o.v * o.v * (bb / bo) + 2 * bb * room) : Math.max(0, o.v - 2 + room);
    // Stopped behind a car that isn't moving, but heading for a clear line beside it: creep
    // forward so the car can turn out; while still in line with it, only as far as the room left.
    if (Math.abs(o.d - targetD) >= HIT_W + 0.2 && o.gap > HIT_LEN) {
      const inLine = Math.abs(o.d - me.d) < HIT_W + 0.2;
      const creep = inLine ? Math.min(1, Math.sqrt(Math.max(0, 2 * (o.gap - HIT_LEN - 0.2)))) : 3;
      vAllowed = Math.max(vAllowed, Math.min(creep, o.v + 3));
    }
    if (vAllowed < vTarget) {
      vTarget = vAllowed;
      following = o.j;
    }
  }
  return { ctl: { vTarget, deltaTarget }, following };
}

/**
 * A car ahead that is much slower than me (spun, stopped, crawling back from the run-off, or
 * retired on the road) is something to steer round, not to queue behind: pick the side of it
 * with room, nearest where I wanted to be. Returns the wanted offset (unchanged if there is no
 * such car or no room either side, in which case the gap rule brakes behind it). Rule 6: the
 * same side-spacing and gap rules then do the rest.
 */
export function avoidSlowCar(me: DriverView, near: Near[], wantDelta: number): { delta: number; hazard: number } {
  const { st, lanes } = me;
  const lim = lanes.lim;
  const look = 30 + st.v * 3;
  let haz: Near | null = null;
  for (const o of near) {
    if (o.gap <= -HIT_LEN || o.gap > look) continue;
    if (o.v > Math.max(6, 0.5 * st.v)) continue;
    // In my way now, or where my lane (or the one I want) will be when I get there.
    const at = st.s + Math.max(0, o.gap);
    const dd = Math.min(Math.abs(o.dd), Math.abs(o.d - lanes.dOf(at, st.delta)), Math.abs(o.d - lanes.dOf(at, wantDelta)));
    if (dd > SIDE_GAP + 1) continue;
    if (!haz || o.gap < haz.gap) haz = o;
  }
  if (!haz) return { delta: wantDelta, hazard: -1 };
  // Offsets are relative to the racing line at the hazard (where the clearance matters).
  const lineAt = lanes.lineD(st.s + Math.max(0, haz.gap));
  const want = lineAt + wantDelta;
  let best = NaN;
  for (const side of [1, -1]) {
    const d = haz.d + side * (SIDE_GAP + 0.4);
    if (Math.abs(d) > lim) continue;
    // Another slow car (or a car alongside) blocking that side?
    const blocked = near.some((o) => o !== haz && o.gap > -ALONGSIDE && o.gap < haz!.gap + 15 &&
      Math.abs(o.d - d) < HIT_W + 0.3 && (o.v < Math.max(6, 0.5 * st.v) || Math.abs(o.gap) < ALONGSIDE));
    if (blocked) continue;
    if (Number.isNaN(best) || Math.abs(d - want) < Math.abs(best - want)) best = d;
  }
  if (Number.isNaN(best)) return { delta: wantDelta, hazard: haz.j };
  return { delta: best - lineAt, hazard: haz.j };
}
