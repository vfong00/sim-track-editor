import type { CarState, Controls } from '../race/car';
import { CAR_WIDTH, clamp, HIT_LEN, HIT_W, type LanePlans, type LaneSet, offShare, RUNOFF_GRIP } from '../race/lanes';
import { type CarModel, dirtyEffects, type PhysicsParams } from '../physics/model';
import type { Rng } from '../rng';
import type { Corner } from '../track/corners';
import { ALONGSIDE, avoidSlowCar, type GapRuleRelax, type Near, SIDE_GAP, trafficControls } from './controller';
import { type DriverSpec, raceSpread, RHYTHM_SHARE } from './driver';

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
/**
 * An attacker pulls out once its run would carry it alongside: within PULL_GAP metres nose to
 * tail plus PULL_TIME seconds of its closing speed…
 */
export const PULL_GAP = 3;
export const PULL_TIME = 1.0;
/** …or with braking for the corner PULL_LEAD s ahead, within DIVE_GAP metres (centre to centre). */
export const DIVE_GAP = 12;
export const PULL_LEAD = 2.0;
/** A committed attacker takes a lane whose braking envelope is within this share of its speed (the planned braking margin). */
export const COMMIT_SLACK = 0.985;
/** Sideways speed (m/s) of a committed pull-out: one decisive move, not a drift out of the tow. */
export const COMMIT_LATERAL = 5;
/**
 * Qualifying (push): each corner is driven a little over or under the limit, a speed factor drawn
 * per corner around 1 with this spread (base, plus per point of inconsistency). Over the limit the
 * car slides, and the mistake and spin odds (from how far over it is) do the rest.
 */
export const PUSH_SPREAD = 0.008;
export const PUSH_PER_INCONSISTENCY = 0.07;
/** Dirty air reaches this far behind a car (m). */
export const DIRTY_RANGE = 30;
/**
 * Clean-air lap time share by which a car counts as a different, slower class (multi-class
 * traffic). A much faster car doesn't wait in the tow for a braking zone: it pulls out and goes
 * by from up to CLASS_FROM metres back, and the slower car holds its line instead of defending.
 */
export const CLASS_GAP = 0.04;
export const CLASS_FROM = 30;

/** Whether car `fast` is a class quicker than car `slow` (CLASS_GAP or more over a clean-air lap). */
export const classQuicker = (fast: CraftCar, slow: CraftCar) =>
  slow.plans.lapTime - fast.plans.lapTime >= CLASS_GAP * slow.plans.lapTime;

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
  /** Attacking: pulled out to pass (else still tucked in behind, in the tow). */
  commit: boolean;
  /** Attacking a slower class: already switched sides once in this move. */
  swapped: boolean;
  /** Next time (s) the driver reconsiders attacking (decisions aren't made every tick). */
  nextThink: number;
  /**
   * The corner the push factor was drawn for, and the factor (speed vs the plan): qualifying's
   * swing at the limit, or a race's scatter around race pace.
   */
  pushCorner: number;
  push: number;
  /** Race: the lap the rhythm was drawn for, and the rhythm (shared by that lap's corners). */
  rhythmLap: number;
  rhythm: number;
  mistake: Mistake | null;
}

export const newCraft = (): Craft => ({ mode: 'line', other: -1, side: 0, corner: -1, defendedCorner: -1, commit: false, swapped: false, nextThink: 0, pushCorner: -1, push: 1, rhythmLap: -1, rhythm: 0, mistake: null });

export interface CraftContext {
  t: number;
  dt: number;
  lanes: LaneSet;
  corners: Corner[];
  nextCorner: Int32Array;
  physics: PhysicsParams;
  /** Safety car (Phase 6): no attacking or defending. */
  neutral?: boolean;
  /** Qualifying: at the limit, braking late (bravery) into every corner, not only in a fight. */
  push?: boolean;
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
  if (ctx.push) {
    // A fresh go at each corner: how close to (or past) the limit this one is driven.
    if (ci !== cr.pushCorner) {
      cr.pushCorner = ci;
      cr.push = 1 + me.rng.normal() * (PUSH_SPREAD + PUSH_PER_INCONSISTENCY * (1 - drv.consistency));
    }
    vEnv *= cr.push;
  } else if (!ctx.neutral) {
    // Racing: each corner a little quicker or slower than race pace, on top of the lap's rhythm.
    // The race margin is headroom for this, so only the odd corner goes over the limit.
    const sd = raceSpread(drv.consistency);
    const lap = Math.floor(st.dist / lanes.track.length);
    if (lap !== cr.rhythmLap) {
      cr.rhythmLap = lap;
      cr.rhythm = me.rng.normal() * RHYTHM_SHARE * sd;
    }
    if (ci !== cr.pushCorner) {
      cr.pushCorner = ci;
      cr.push = 1 + me.rng.normal() * sd;
    }
    vEnv *= cr.push + cr.rhythm;
  }
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

  // --- Blue flag: a class quicker car pulling out to pass me. I drop my own battle (attack or
  // defence) and give it the side it is going for, until it is by.
  let yieldTo: Near | null = null;
  if (!ctx.neutral && avoid.hazard < 0 && off === 0) {
    for (const o of near) {
      const t = cars[o.j].craft;
      if (o.gap > -CLASS_FROM && o.gap < ALONGSIDE && t.mode === 'attack' && t.commit && t.other === me.idx && classQuicker(cars[o.j], me) && (!yieldTo || o.gap > yieldTo.gap)) yieldTo = o;
    }
    if (yieldTo) cr.mode = 'line';
  }

  // --- Attack: decide (a few times a second) whether to have a go at the car in front.
  if (cr.mode === 'line' && !yieldTo && !ctx.neutral && avoid.hazard < 0 && off === 0 && front && ctx.t >= cr.nextThink) {
    cr.nextThink = ctx.t + 0.5;
    const target = cars[front.j];
    const faster = target.plans.lapTime - plans.lapTime; // s per lap the attacker is quicker
    const closing = st.v - front.v;
    // A class quicker: always go, from further back, and straight out of the tow.
    const lapping = classQuicker(me, target);
    const close = front.gap < (lapping ? CLASS_FROM : 14 + 6 * drv.aggression);
    // A reason to go: a pace advantage, a run on the car (closing speed) or a deep tow.
    // Aggression alone only rarely starts a move on an equal car.
    const want = lapping ? 1 : drv.aggression * 0.15 + Math.max(0, faster) * 0.8 + (closing > 1 ? 0.3 : 0) + TOW_URGE * depth.tow;
    // (Not into a corner: a class quicker car may go anywhere it has room, or on a twisty track
    // there's almost nowhere it can start.)
    if (close && (lapping || toCorner > 60) && me.rng.next() < want) {
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
        cr.commit = lapping;
        cr.swapped = false;
        break;
      }
    }
  }

  let brave = ctx.push ? 1 + 0.04 * drv.bravery : 1;
  const relax: GapRuleRelax = {};
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
      // Tucked in behind until the move can work: on the leader's line and in its tow, closing up
      // (the gap rule lets an attacker close tighter than a follower). Then one committed move
      // out: once the run would carry it alongside, or in the braking zone close enough to dive.
      if (!cr.commit) {
        const run = o.gap - HIT_LEN < PULL_GAP + PULL_TIME * Math.max(0, st.v - o.v);
        // Braking for the corner within PULL_LEAD s: pull out now, at the end of the straight,
        // while the inside line can still be taken at this speed (in the braking zone it can't,
        // and the attacker ended up braking in line with the leader).
        const brakingSoon = plans.envelope(ahead + st.v * PULL_LEAD, st.delta, depth.tow, depth.dirty) < st.v - 1;
        if (run || (brakingSoon && o.gap < DIVE_GAP)) {
          // The leader's line swings across the road; if our side has no room, use the other.
          if (!room(cr.side) && room(-cr.side) && !busy(-cr.side)) cr.side = -cr.side;
          cr.commit = true;
        }
      }
      // A class quicker car goes by wherever there's road: while not yet alongside, if the
      // slower car's line has closed our side (it often runs on the edge), take the other.
      // Once per move: the line swings across a narrow road, and flipping back and forth with it
      // never got the car out.
      if (cr.commit && !cr.swapped && o.gap > ALONGSIDE && !room(cr.side) && room(-cr.side) && !busy(-cr.side) && classQuicker(me, cars[cr.other])) {
        cr.side = -cr.side;
        cr.swapped = true;
      }
      if (!cr.commit) {
        // The leader's line, as an offset from the racing line where the leader is (its lateral
        // position now would be a different point of the corner here).
        wantDelta = o.d - lanes.lineD(st.s + o.gap);
        relax.tow = cr.other;
      } else {
        // Into the corner on the inside: dive for the inside edge (the leader's line sweeps
        // across from the outside, so sitting a car's width off the leader would be squeezed onto
        // the same edge behind it). Elsewhere, sit a car's width off the leader.
        const dive = corner && ci === cr.corner && cr.side === corner.dir && toCorner < DIVE_FROM && room(cr.side);
        wantDelta = (dive ? cr.side * lim : clamp(o.d + cr.side * (SIDE_GAP + 0.3), -lim, lim)) - lineD;
        relax.commit = cr.other;
        // Brave: brake later while fighting for the corner (not a higher cornering speed). The
        // planned braking leaves a margin (BRAKE_USE ≈ 3% of speed); an average driver uses about
        // two thirds of it, the bravest a little more than all of it (and may overshoot).
        if (Math.abs(o.gap) < 12) brave = 1 + 0.04 * drv.bravery;
      }
    }
  }

  // --- Defend: one move to the inside of the next corner when someone is close behind.
  if (cr.mode === 'line' && !yieldTo && !ctx.neutral && avoid.hazard < 0 && off === 0 && behind && corner && cr.defendedCorner !== ci && toCorner < 220 && toCorner > 40) {
    const threat = cars[behind.j];
    const attacking = threat.craft.mode === 'attack' && threat.craft.other === me.idx;
    // A class quicker car isn't a rival: hold the line and let it by.
    if (!classQuicker(threat, me) && (attacking || behind.v > st.v + 1.5) && behind.gap > -15 && me.rng.next() < drv.racecraft * 0.6) {
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

  if (yieldTo) {
    // My distance from the edge on its side must leave it a car's width and the spacing.
    const side = cars[yieldTo.j].craft.side;
    const edge = side * lim - side * (SIDE_GAP + 0.3);
    if (side * (edge - (lineD + wantDelta)) < 0) wantDelta = edge - lineD;
  }

  // --- The room rule: a car alongside on my inside, before the apex, with its front wheels about
  // level with my mirrors (its centre no more than ROOM_LEVEL behind mine), has earned the corner.
  // I give it room and tuck in behind (the gap rule, told to count it as a car ahead in my lane).
  const owed = owedRoom(near, corner, toCorner);
  // --- Side by side into a corner: whoever is on the inside keeps the inside line.
  if (cr.mode === 'line' && corner && toCorner < 150 && anyAlongside && allOutside) wantDelta = st.delta;
  if (avoid.hazard >= 0) wantDelta = avoidSlowCar(view, near, wantDelta).delta;

  // Only in the braking zone (the envelope asks to slow down) and before the turn-in: the car
  // brakes later and less, but never speeds up from it, and corner speed is unchanged.
  // A committed attacker takes a lane it can make by braking into the planned margin (late
  // braking): held to the planned envelope, it could never leave its line once braking.
  wantDelta = feasibleDelta(me, wantDelta, depth, ahead, cr.mode === 'attack' && cr.commit ? COMMIT_SLACK : 0.995);
  const braveNow = brave > 1 && vEnv < st.v && toCorner > 30;
  if (braveNow) vEnv = Math.min(st.v, vEnv * brave);
  if (cr.mode !== 'attack') cr.commit = false;
  const tc = trafficControls(view, near, wantDelta, vEnv, undefined, { ...(cr.mode === 'attack' ? relax : {}), ...(owed >= 0 ? { yieldTo: owed } : {}) });
  // Moving across the road: respect the speed of the lane we're heading for too, so a car isn't
  // carried onto a tighter line faster than it can take it.
  let vLane = plans.envelope(ahead, tc.ctl.deltaTarget, depth.tow, depth.dirty);
  if (braveNow) vLane = Math.min(st.v, vLane * brave);
  const ctl = { ...tc.ctl, vTarget: Math.min(tc.ctl.vTarget, vLane), effects, ...(cr.mode === 'attack' && cr.commit ? { lateralSpeed: COMMIT_LATERAL } : {}) };
  return { ctl, following: tc.following, mistake: started };
}

/** How far behind mine (m, centre to centre) a car on my inside can be and still have earned the corner: front wheels about level with my mirrors. */
export const ROOM_LEVEL = 1.0;
/** The room rule applies from this far before the apex (m) up to it. */
export const ROOM_FROM = 150;

/**
 * The car I owe room into this corner, or -1: alongside on my inside (not in line, within
 * ALONGSIDE), before the apex, its centre no more than ROOM_LEVEL behind mine. The nearest such.
 */
export function owedRoom(near: Near[], corner: Corner | null, toCorner: number): number {
  if (!corner || toCorner <= 0 || toCorner > ROOM_FROM) return -1;
  let best: Near | null = null;
  for (const o of near) {
    if (Math.abs(o.gap) >= ALONGSIDE || Math.abs(o.dd) < 1.2 || Math.sign(o.dd) !== corner.dir) continue;
    if (o.gap < -ROOM_LEVEL || o.v < 10) continue;
    if (!best || Math.abs(o.dd) < Math.abs(best.dd)) best = o;
  }
  return best ? best.j : -1;
}

/**
 * A driver doesn't steer onto a lane it can't take at its current speed: at the cornering limit
 * there is no grip left to slow down, so tightening the line mid-corner would only slide. Moves
 * the wanted offset back toward the current one until the lane's braking envelope (just ahead
 * and a little further on) allows the current speed.
 */
function feasibleDelta(me: CraftCar, want: number, depth: { tow: number; dirty: number }, ahead: number, slack = 0.995): number {
  const { st, plans } = me;
  const ok = (delta: number) =>
    plans.envelope(ahead, delta, depth.tow, depth.dirty) >= st.v * slack &&
    plans.envelope(ahead + st.v * 0.5, delta, depth.tow, depth.dirty) >= st.v * slack;
  if (ok(want)) return want;
  for (let f = 0.75; f > 0; f -= 0.25) {
    const d = st.delta + (want - st.delta) * f;
    if (ok(d)) return d;
  }
  return st.delta;
}
