import type { Controls } from '../race/car';
import { clamp, HIT_LEN, HIT_W, type LanePlans, type LaneSet } from '../race/lanes';
import { type CarModel, type Effects, NO_EFFECTS } from '../physics/model';
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
/** Centre-to-centre distance at which a car alongside is leaning in and squeezes a car on the road edge over it. */
export const SQUEEZE = HIT_W + 0.25;
/** Longitudinal distance within which a car counts as alongside. */
export const ALONGSIDE = HIT_LEN + 2;

export interface DriverView {
  st: CarState;
  d: number;
  model: CarModel;
  plans: LanePlans;
  lanes: LaneSet;
  dt: number;
  /** Traffic effects on the car now (slipstream, dirty air); clean air if absent. */
  effects?: Effects;
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
/**
 * Race craft's say in the gap rule, for the car being attacked (entrant index, -1 = none):
 *  - `tow`: closing up in its slipstream to go by. No reaction margin and TOW_ROOM nose to tail,
 *    so the attacker can carry more speed than the leader into the pull-out (the slingshot);
 *  - `commit`: pulling out to pass it. Only where the car is counts, not where it's heading, so
 *    once out of line it brakes for its own line, not the leader's.
 */
export interface GapRuleRelax {
  tow?: number;
  commit?: number;
}
/** Nose-to-tail margin (m) an attacker keeps while closing up in the tow. */
export const TOW_ROOM = 1.5;

export function trafficControls(me: DriverView, near: Near[], wantDelta: number, vPlan: number, brakeGain = 0.97, relax: GapRuleRelax = {}): TrafficDecision {
  const { st, lanes } = me;
  const lineD = lanes.lineD(st.s);
  let lo = -Infinity, hi = Infinity, loBy = -1, hiBy = -1;
  for (const o of near) {
    if (Math.abs(o.gap) >= ALONGSIDE || Math.abs(o.dd) < 1.2) continue;
    // Only a car leaning in (closer than SQUEEZE) squeezes; within the spacing margin the
    // driver holds the edge and lets the other car make room.
    const by = Math.abs(o.dd) < SQUEEZE ? o.j : -1;
    if (o.dd > 0) { if (o.d - SIDE_GAP - lineD < hi) { hi = o.d - SIDE_GAP - lineD; hiBy = by; } }
    else if (o.d + SIDE_GAP - lineD > lo) { lo = o.d + SIDE_GAP - lineD; loBy = by; }
  }
  // Aim within the road, but side spacing wins: a car squeezed onto the grass stays there until
  // there's room to come back (steering back into a car alongside would only lean on it).
  const eLo = -lanes.lim - lineD, eHi = lanes.lim - lineD;
  const onRoad = clamp(wantDelta, eLo, eHi);
  let deltaTarget = lo > hi ? st.delta : clamp(onRoad, lo, hi);
  deltaTarget = clamp(deltaTarget, -lanes.wall - lineD, lanes.wall - lineD);
  // Squeezed: the spacing rule leaves no room on the road on that side.
  const squeezedBy = lo > hi ? -1 : hi < eLo - 1e-9 ? hiBy : lo > eHi + 1e-9 ? loBy : -1;
  const targetD = lineD + deltaTarget;

  let vTarget = vPlan;
  let following = -1;
  const look = 25 + st.v * 2.5;
  // Both cars' real straight-line braking (same model as the integrator); the follower only
  // counts on a share of its own so it keeps a margin for reaction.
  // With the grip the car has now (dirty air costs a winged car braking grip as well).
  const fx = me.effects ?? NO_EFFECTS;
  const b = brakeGain * me.model.maxBrake(st.v, 0, fx);
  // A car far slower than me (spun, stopped, crawling back on): seen from further away, and I
  // plan to stop for it with the braking I really have, which mid-corner is what the cornering
  // leaves over (Phase 5: hitting one is no longer just a bump).
  const slow = Math.max(6, 0.5 * st.v);
  const aCorner = Math.abs(st.v * st.v * lanes.kappa(st.s, st.delta));
  const bHaz = brakeGain * me.model.maxBrake(st.v, Math.min(aCorner, 0.95 * me.model.gripLimit(fx, st.v)), fx);
  for (const o of near) {
    const hazard = o.v < slow;
    if (o.gap <= 0 || o.gap > (hazard ? 40 + 4 * st.v : look)) continue;
    // A hazard is judged where I'll be when I reach it (my lane and my target lane at its s): the
    // racing line can sweep across the road on the way, so a wreck beside the line further on
    // is in my path even when it's far to the side of me now.
    const attacked = !hazard && (o.j === relax.tow || o.j === relax.commit);
    let dist = o.j === relax.commit && !hazard ? Math.abs(o.d - me.d) : Math.min(Math.abs(o.d - me.d), Math.abs(o.d - targetD));
    if (hazard) {
      const at = st.s + o.gap;
      dist = Math.min(dist, Math.abs(o.d - lanes.dOf(at, st.delta)), Math.abs(o.d - lanes.dOf(at, deltaTarget)));
    }
    const overlap = dist < HIT_W + 0.2;
    if (!overlap) continue;
    const bo = me.model.maxBrake(o.v, 0);
    const room = attacked ? o.gap - HIT_LEN - TOW_ROOM : o.gap - HIT_LEN - 1.0 - 0.03 * st.v;
    const bb = hazard ? bHaz : attacked ? b / brakeGain : b;
    // An attacker doesn't hold the tow's lower drag against its braking (that alone kept it
    // ~10 m back at speed, too far to pull out), but does count the grip dirty air costs it: a
    // winged car tucked in at 1.5 m into a 300 km/h braking zone otherwise ran into the leader.
    const ratio = attacked ? Math.min(1, me.model.maxBrake(st.v, 0, { ...fx, drag: 1 }) / bo) : bb / bo;
    let vAllowed = room > 0 ? Math.sqrt(o.v * o.v * ratio + 2 * bb * room) : Math.max(0, o.v - 2 + room);
    // Stopped behind a car that isn't moving, but heading for a clear line beside it: creep
    // forward so the car can turn out; while still in line with it, only as far as the room left.
    // Already clear of it sideways, the car can creep on even with the two partly alongside.
    const inLine = Math.abs(o.d - me.d) < HIT_W + 0.2;
    if (Math.abs(o.d - targetD) >= HIT_W + 0.2 && (o.gap > HIT_LEN || !inLine)) {
      const creep = inLine ? Math.min(1, Math.sqrt(Math.max(0, 2 * (o.gap - HIT_LEN - 0.2)))) : 3;
      vAllowed = Math.max(vAllowed, Math.min(creep, o.v + 3));
    }
    if (vAllowed < vTarget) {
      vTarget = vAllowed;
      following = o.j;
    }
  }
  return { ctl: squeezedBy >= 0 ? { vTarget, deltaTarget, squeezedBy } : { vTarget, deltaTarget }, following };
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
  // The nearest slow car ahead in my path, else the nearest one close beside it. In a pile-up
  // two wrecks can sit side by side: steering round the nearer one when it's the other that
  // blocks my lane would send me across behind the first. (One already alongside me isn't in my
  // path going forward, wherever my lane runs: the side spacing keeps me off it.)
  let haz: Near | null = null, hazIn: Near | null = null;
  for (const o of near) {
    if (o.gap <= -HIT_LEN || o.gap > look) continue;
    if (o.v > Math.max(6, 0.5 * st.v)) continue;
    // In my way now, or where my lane (or the one I want) will be when I get there.
    const at = st.s + Math.max(0, o.gap);
    const dd = Math.min(Math.abs(o.dd), Math.abs(o.d - lanes.dOf(at, st.delta)), Math.abs(o.d - lanes.dOf(at, wantDelta)));
    if (dd > SIDE_GAP + 1) continue;
    if (!haz || o.gap < haz.gap) haz = o;
    // In my path: for a car partly alongside, only where it is beside me now counts.
    const inPath = (o.gap >= HIT_LEN ? dd : Math.abs(o.dd)) < HIT_W + 0.2;
    if (o.gap > 0 && inPath && (!hazIn || o.gap < hazIn.gap)) hazIn = o;
  }
  haz = hazIn ?? haz;
  if (!haz) return { delta: wantDelta, hazard: -1 };
  // Offsets are relative to the racing line at the hazard (where the clearance matters).
  const lineAt = lanes.lineD(st.s + Math.max(0, haz.gap));
  const want = lineAt + wantDelta;
  let best = NaN;
  for (const side of [1, -1]) {
    const d = haz.d + side * (SIDE_GAP + 0.4);
    if (Math.abs(d) > lim) continue;
    // Another slow car (or a car alongside) blocking that side? A slow car only blocks it if it
    // reaches up beside or ahead of me: one wholly behind (another wreck I've already passed)
    // isn't in the way going forward.
    const blocked = near.some((o) => o !== haz && o.gap < haz!.gap + 15 && Math.abs(o.d - d) < HIT_W + 0.3 &&
      (o.v < Math.max(6, 0.5 * st.v) ? o.gap > -HIT_LEN : Math.abs(o.gap) < ALONGSIDE));
    if (blocked) continue;
    if (Number.isNaN(best) || Math.abs(d - want) < Math.abs(best - want)) best = d;
  }
  if (Number.isNaN(best)) return { delta: wantDelta, hazard: haz.j };
  return { delta: best - lineAt, hazard: haz.j };
}
