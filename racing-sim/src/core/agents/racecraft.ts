import { exp } from '../fmath';
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
/** Sideways speed (m/s) a pull-out really gets on average, accelerating across (for its timing). */
export const PULL_LATERAL = 2;
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
  /**
   * Defending: the offset from the racing line held once braking began (NaN before). The one
   * defensive move is made before the braking zone; under braking the defender only follows its
   * line from where it is.
   */
  hold: number;
  /** Corner an attack was given up for (the door shut with no overlap): no new move into it. */
  gaveUp: number;
  /** Attacking (phase B): the plan for this move. */
  plan: AttackPlan;
  /** Defending (phase B): the cover chosen for this corner, and whether the move waits until just before braking. */
  cover: Cover;
  late: boolean;
  /** Defending: the move has been made (the side is set). */
  moved: boolean;
  /** Corner for which the "stay in the gap" draw was made when the door shut, and its outcome. */
  stayCorner: number;
  stay: boolean;
  /** What I've seen each rival do (by entrant index): reading the opponent. */
  memory: Map<number, Seen>;
}

/**
 * An attacker's plan (phase B): go for the inside, go round the outside, or show one side and
 * switch once before braking (the dummy).
 */
export type AttackPlan = 'inside' | 'outside' | 'dummy';
/**
 * A defender's cover (phase B): the inside, the side the attacker shows (`mirror`), or the
 * racing line, to protect the exit.
 */
export type Cover = 'inside' | 'mirror' | 'line';

/** A rival's choices as I've seen them: which side it covered when defending, which it took when attacking (relative to the corner). */
export interface Seen {
  cover: { inside: number; outside: number; line: number };
  attack: { inside: number; outside: number };
}
const newSeen = (): Seen => ({ cover: { inside: 0, outside: 0, line: 0 }, attack: { inside: 0, outside: 0 } });
const seenOf = (cr: Craft, j: number) => { let s = cr.memory.get(j); if (!s) cr.memory.set(j, (s = newSeen())); return s; };

export const newCraft = (): Craft => ({ mode: 'line', other: -1, side: 0, corner: -1, defendedCorner: -1, commit: false, swapped: false, nextThink: 0, pushCorner: -1, push: 1, rhythmLap: -1, rhythm: 0, mistake: null, hold: NaN, gaveUp: -1, plan: 'inside', cover: 'inside', late: false, moved: false, stayCorner: -1, stay: false, memory: new Map() });

/** A racecraft decision, for the log (variety per driver in `batch`). */
export interface CraftChoice {
  role: 'attack' | 'defend';
  /** The rival. */
  other: number;
  /** Attack: the plan (`inside`, `outside`, `dummy`), or `hold` (no room for another car into the corner), `stay` (kept a move going with the door shut). Defend: the cover, with `-late` for a late move. */
  kind: string;
  corner: number;
}

/**
 * Cars a corner has room for side by side: two into a slow corner or a chicane (whatever the
 * road width: the cars converge on one apex), else by width, at most three.
 */
export const SLOW_CORNER = 60;
export function cornerRoom(corner: Corner | null, lim: number): number {
  const byWidth = 1 + Math.floor((2 * lim) / (SIDE_GAP + 0.3));
  if (!corner || corner.radius < SLOW_CORNER) return Math.min(2, byWidth);
  return Math.min(3, byWidth);
}

/** Pick one key by weight with one uniform draw. */
function pick<K extends string>(w: Record<K, number>, u: number): K {
  const keys = Object.keys(w) as K[];
  const total = keys.reduce((a, k) => a + Math.max(0, w[k]), 0);
  let x = u * total;
  for (const k of keys) { x -= Math.max(0, w[k]); if (x <= 0) return k; }
  return keys[keys.length - 1];
}

/**
 * How strongly a driver plays against a rival's habit: 0 = ignores it, more = leans away from
 * what the rival does most. Scaled by racecraft (a high racecraft driver reads the opponent).
 */
export const READ_GAIN = 2.5;
/** A defender's late move waits until braking is this many seconds away. */
export const LATE_LEAD = 0.8;
/** Chance, times bravery × (1 − racecraft), that an attacker keeps a move going when the door shuts. */
export const STAY_RATE = 0.3;
/** The dummy switches sides when braking is within this many seconds. */
export const DUMMY_LEAD = 1.0;
/** Exit room: a car level beside me on the outside of the exit is owed EXIT_MARGIN (controller.ts) more side spacing, up to EXIT_LEN past the apex. */
export const EXIT_LEN = 80;
/** Rule 5: a battle within this distance ahead (m) makes a following car brake with this share of its braking and hold its place across the road. */
export const BATTLE_RANGE = 60;
export const BATTLE_BRAKE = 0.9;

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
  /** A racecraft decision made this tick, for the decision log. */
  choice?: CraftChoice;
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
  // Closing on the car in front, brake for the dirty air we'll be in a second from now, not the
  // air we're in: diving from 12 m back into a slow corner, the wake thickened under braking and
  // the envelope fell faster than the car could slow (GT3 at Laguna T3, lap 1: 14 km/h over the
  // corner speed, and a spin).
  if (wake.source >= 0 && ctx.physics.dirtyAir > 0) {
    const src = near.find((o) => o.j === wake.source);
    if (src) {
      const soon = src.gap - Math.max(0, st.v - src.v) * 1.0;
      depth.dirty = Math.max(depth.dirty, clamp(1 - Math.max(HIT_LEN, soon) / DIRTY_RANGE, 0, 1));
    }
  }
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
  // Over the plan's top speed with no braking ahead (the plan is flat for the next second): that's
  // speed carried from a tow, not a corner to slow for. Stay flat out and let drag take it off.
  // Braking down to the clean-air top speed was the attacker giving its tow up as it pulled out
  // (Monza, phase B: 103 → 95 m/s in half a second, beside the car it was passing; rule 1).
  if (st.v > vEnv && flatOut(me, st.delta, depth, ahead)) vEnv = st.v;
  // In the run-off: corner speed ∝ √grip, and the driver's only aim is to get back on the road.
  const off = offShare(lanes.track, me.d);
  if (off > 0) vEnv *= Math.sqrt(1 - off * (1 - RUNOFF_GRIP));
  // In the braking zone for the next corner: the plan asks to slow down.
  const braking = vEnv < st.v - 1;
  let wantDelta = 0;
  let started: Mistake | null = null;
  let choice: CraftChoice | undefined;
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

  // --- Room to fit: a side of car `tj` (gap tg ahead) is taken when another car is already in it,
  // beside the target or between us and it. Going alongside there makes three abreast where the
  // road has room for two (Monza T5, lap 1 at Silverstone T1: the diving car was squeezed off).
  const slotTaken = (tj: number, tg: number, td: number, side: number) => near.some((o) =>
    o.j !== tj && o.gap > -HIT_LEN && o.gap < tg + ALONGSIDE && side * (o.d - td) > 1.2 && side * (o.d - me.d) > -HIT_W);

  // --- Cars contesting the corner with car `t` (ahead of me): t, me, every car already beside
  // it or about to be (within ALONGSIDE of it nose to tail, off its line), and every car already
  // committed to passing it.
  const contesting = (t: Near) => 2 + near.filter((o) => o.j !== t.j && o.gap > 0 && Math.abs(o.gap - t.gap) < ALONGSIDE && Math.abs(o.d - t.d) > 1.2).length
    + cars.filter((c) => c.idx !== me.idx && c.craft.mode === 'attack' && c.craft.commit && c.craft.other === t.j && !near.some((o) => o.j === c.idx && o.gap > 0 && Math.abs(o.gap - t.gap) < ALONGSIDE)).length;

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
  if (cr.mode === 'line' && !yieldTo && !ctx.neutral && avoid.hazard < 0 && off === 0 && front && ctx.t >= cr.nextThink && ci !== cr.gaveUp) {
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
    // Room for another car into the corner (phase B): the target, me, every car already beside
    // it, and every car already committed to passing it. A slow corner or a chicane takes two
    // (Monza T4/T5, four cars into it: the third and fourth only made contact). A class quicker
    // car goes by anywhere.
    const full = !lapping && contesting(front) > cornerRoom(corner, lim);
    const go = close && (lapping || toCorner > 60) && me.rng.next() < want;
    if (go && full) {
      choice = { role: 'attack', other: front.j, kind: 'hold', corner: ci };
    } else if (go) {
      // The plan (phase B, a mixed strategy so the move can't be read): inside, outside, or the
      // dummy. A high racecraft driver leans against what this defender has covered before.
      const inside = corner ? corner.dir : 1;
      const seen = seenOf(cr, front.j).cover;
      const n = seen.inside + seen.outside + seen.line + 3;
      const lean = (share: number) => exp(-READ_GAIN * drv.racecraft * (share - 1 / 3));
      const plan = lapping ? 'inside' : pick<AttackPlan>({
        inside: (0.6 + 0.4 * drv.aggression) * lean((seen.inside + 1) / n),
        outside: (0.3 + 0.3 * (1 - drv.aggression)) * lean((seen.outside + 1) / n),
        dummy: 0.35 * drv.racecraft * lean((seen.inside + 1) / n),
      }, me.rng.next());
      // Outside first for the outside plan; the dummy shows the inside and switches.
      const first = plan === 'outside' ? -inside : inside;
      for (const side of [first, -first]) {
        // The inside is open if the leader isn't covering it (the racing line approaches from
        // the outside, so usually it is); the outside needs room beside the leader now. (The
        // inside check was `side·lim − side·d`, which for a right-hander is d − lim: never
        // open, so nobody started an inside move into a right-hander.)
        const open = corner && side === corner.dir ? side * (side * lim - target.d) >= SIDE_GAP : Math.abs(target.d + side * (SIDE_GAP + 0.3)) <= lim;
        if (!open) continue;
        if (side > 0 ? leftBusy : rightBusy) continue;
        if (slotTaken(front.j, front.gap, target.d, side)) continue;
        cr.mode = 'attack';
        cr.other = front.j;
        cr.side = side;
        cr.corner = ci;
        cr.commit = lapping;
        cr.swapped = false;
        cr.plan = side === first ? plan : side === inside ? 'inside' : 'outside';
        choice = { role: 'attack', other: front.j, kind: cr.plan, corner: ci };
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
      const busy = (side: number) => ((side > 0 ? leftBusy : rightBusy) && Math.sign(o.dd) !== side) || slotTaken(o.j, o.gap, o.d, side);
      // Tucked in behind until the move can work: on the leader's line and in its tow, closing up
      // (the gap rule lets an attacker close tighter than a follower). Then one committed move
      // out: once the run would carry it alongside, or in the braking zone close enough to dive.
      if (!cr.commit) {
        // Early enough to be clear sideways before reaching the leader's gearbox: from a deep tow
        // at Monza the run is 7–8 m/s, and moving across a car's width takes over a second (rule 1:
        // pulled out late, the attacker had to brake to the leader's speed beside it).
        const clearTime = (HIT_W + 0.2 - Math.min(HIT_W + 0.2, Math.abs(o.dd))) / PULL_LATERAL + 0.3;
        const run = o.gap - HIT_LEN < PULL_GAP + Math.max(PULL_TIME, clearTime) * Math.max(0, st.v - o.v);
        // Braking for the corner within PULL_LEAD s: pull out now, at the end of the straight,
        // while the inside line can still be taken at this speed (in the braking zone it can't,
        // and the attacker ended up braking in line with the leader).
        const brakingSoon = plans.envelope(ahead + st.v * PULL_LEAD, st.delta, depth.tow, depth.dirty) < st.v - 1;
        // No room for another car into the corner since the move began (a third car came
        // alongside): stay in the tow.
        const roomFor = classQuicker(me, cars[cr.other]) || ci !== cr.corner || contesting(o) <= cornerRoom(corner, lim);
        if (roomFor && (run || (brakingSoon && o.gap < DIVE_GAP))) {
          // The leader's line swings across the road; if our side has no room, use the other.
          if ((!room(cr.side) || busy(cr.side)) && room(-cr.side) && !busy(-cr.side)) cr.side = -cr.side;
          // No slot on either side: stay in the tow and wait.
          if (room(cr.side) && !busy(cr.side)) {
            cr.commit = true;
            // The defender sees which side the move went for (reading the opponent).
            if (corner) seenOf(cars[cr.other].craft, me.idx).attack[cr.side === corner.dir ? 'inside' : 'outside']++;
          }
        }
      }
      // Committed but not yet level, and the corner has filled up (a car came alongside the
      // target on the other side): back out, there's no room for three.
      if (cr.commit && corner && ci === cr.corner && toCorner < DIVE_FROM && o.gap > ROOM_LEVEL && !classQuicker(me, cars[cr.other]) && contesting(o) > cornerRoom(corner, lim)) {
        cr.mode = 'line';
        cr.gaveUp = ci;
        choice = { role: 'attack', other: cr.other, kind: 'hold', corner: ci };
      }
      // The dummy: shown one side, switch to the other once, just before braking, if it's open.
      if (cr.commit && cr.plan === 'dummy' && !cr.swapped && corner && ci === cr.corner && o.gap > HIT_LEN && !braking &&
        plans.envelope(ahead + st.v * DUMMY_LEAD, st.delta, depth.tow, depth.dirty) < st.v - 1 && room(-cr.side) && !busy(-cr.side)) {
        const mem = seenOf(cars[cr.other].craft, me.idx).attack;
        mem[cr.side === corner.dir ? 'inside' : 'outside']--;
        cr.side = -cr.side;
        cr.swapped = true;
        mem[cr.side === corner.dir ? 'inside' : 'outside']++;
      }
      // A class quicker car goes by wherever there's road: while not yet alongside, if the
      // slower car's line has closed our side (it often runs on the edge), take the other.
      // Once per move: the line swings across a narrow road, and flipping back and forth with it
      // never got the car out.
      if (cr.commit && !cr.swapped && o.gap > ALONGSIDE && !room(cr.side) && room(-cr.side) && !busy(-cr.side) && classQuicker(me, cars[cr.other])) {
        cr.side = -cr.side;
        cr.swapped = true;
      }
      // The door shut: the leader covered our side, or turned in across it, before we had any
      // overlap. We're only owed the side it didn't take: switch to it while there's still time
      // before braking, else give the move up and follow it through (the next straight, or a
      // better exit, is the chance now). Holding the dive put the attacker into its gearbox.
      if (cr.commit && ci === cr.corner && o.gap >= HIT_LEN && !room(cr.side) && !classQuicker(me, cars[cr.other])) {
        if (!braking && !cr.swapped && room(-cr.side) && !busy(-cr.side)) {
          cr.side = -cr.side;
          cr.swapped = true;
        } else {
          // Back out, mostly. A brave driver with little racecraft sometimes keeps the move going
          // into the gap that isn't there (once per corner, drawn when the door shuts).
          if (cr.stayCorner !== ci) {
            cr.stayCorner = ci;
            cr.stay = me.rng.next() < STAY_RATE * drv.bravery * (1 - drv.racecraft);
            if (cr.stay) choice = { role: 'attack', other: cr.other, kind: 'stay', corner: ci };
          }
          if (!cr.stay) {
            cr.mode = 'line';
            cr.gaveUp = ci;
          }
        }
      }
      if (cr.mode !== 'attack') {
        // Gave the move up: back to driving the line.
      } else if (!cr.commit) {
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
  if (cr.mode === 'line' && !yieldTo && !ctx.neutral && avoid.hazard < 0 && off === 0 && behind && corner && cr.defendedCorner !== ci && toCorner < 220 && toCorner > 40 && !braking) {
    const threat = cars[behind.j];
    const attacking = threat.craft.mode === 'attack' && threat.craft.other === me.idx;
    // A class quicker car isn't a rival: hold the line and let it by.
    if (!classQuicker(threat, me) && (attacking || behind.v > st.v + 1.5) && behind.gap > -15 && me.rng.next() < drv.racecraft * 0.6) {
      cr.mode = 'defend';
      cr.corner = ci;
      cr.other = behind.j;
      // The cover (phase B, a mixed strategy): the inside, the side the attacker shows, or the
      // line to protect the exit; early, or late (just before braking, still legal). A high
      // racecraft driver leans toward the side this attacker has gone for before.
      const seen = seenOf(cr, behind.j).attack;
      const pIn = (seen.inside + 1) / (seen.inside + seen.outside + 2);
      const lean = exp(READ_GAIN * drv.racecraft * (pIn - 0.5));
      cr.cover = pick<Cover>({ inside: (0.5 + 0.3 * drv.aggression) * lean, mirror: (0.25 + 0.35 * drv.racecraft) / lean, line: 0.25 }, me.rng.next());
      cr.late = cr.cover !== 'line' && me.rng.next() < 0.2 + 0.4 * drv.aggression * drv.racecraft;
      cr.moved = false;
      cr.side = 0;
      choice = { role: 'defend', other: behind.j, kind: cr.cover + (cr.late ? '-late' : ''), corner: ci };
    }
    cr.defendedCorner = ci; // the decision (either way) is made once per corner
  }
  if (cr.mode === 'defend') {
    if (ci !== cr.corner) cr.mode = 'line';
    else {
      // The move: now, or (late) once braking is LATE_LEAD s away. Mirror covers the side the
      // attacker shows then (in line behind: the inside).
      if (!cr.moved && !braking && (!cr.late || plans.envelope(ahead + st.v * LATE_LEAD, st.delta, depth.tow, depth.dirty) < st.v - 1)) {
        cr.moved = true;
        const a = near.find((o) => o.j === cr.other);
        cr.side = cr.cover === 'line' ? 0 : cr.cover === 'mirror' && a && Math.abs(a.dd) > 1.2 ? Math.sign(a.dd) : corner!.dir;
        // The attacker sees which side was covered (reading the opponent).
        seenOf(cars[cr.other].craft, me.idx).cover[cr.side === 0 ? 'line' : cr.side === corner!.dir ? 'inside' : 'outside']++;
      }
      // One move, made before braking. Under braking, no more moving across: follow the line
      // from where the move left us (at Monza T5 a late cover swung 7 m across under braking,
      // into a car already committed to the inside).
      if (braking && Number.isNaN(cr.hold)) cr.hold = st.delta;
      wantDelta = !Number.isNaN(cr.hold) ? cr.hold : cr.moved && cr.side !== 0 ? clamp(cr.side * (lim - 1), -lim, lim) - lineD : 0;
    }
  }
  if (cr.mode !== 'defend') cr.hold = NaN;

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

  // --- Rule 5: a battle just ahead (a committed pass, or two cars side by side) brakes early and
  // unevenly. A car following it into a corner keeps its place across the road (the whole road
  // is in use, not one line) and brakes with a wider margin.
  // Only a car in line behind (not one pulled out beside the train: holding its place there and
  // braking early made it give up its tow on the straight, Monza T1), and only with braking
  // for the corner close.
  let battle = false;
  const inLine = !!front && Math.abs(front.dd) < HIT_W;
  if (cr.mode === 'line' && !ctx.neutral && corner && toCorner < 200 && inLine && plans.envelope(ahead + st.v * 1.5, st.delta, depth.tow, depth.dirty) < st.v - 1) {
    for (const o of near) {
      if (o.gap <= HIT_LEN || o.gap > BATTLE_RANGE || !o.racing) continue;
      const c = cars[o.j].craft;
      if ((c.mode === 'attack' && c.commit) || near.some((x) => x.j !== o.j && x.gap > HIT_LEN && Math.abs(x.gap - o.gap) < ALONGSIDE && Math.abs(x.d - o.d) > 1.2)) { battle = true; break; }
    }
    if (battle && anyAlongside === false) wantDelta = st.delta;
  }

  // --- Rule 3, for every car (an attacker diving on the car ahead too): under braking, no move
  // toward a car pulled out close behind me on that side (Monza T5: a car diving on the car in
  // front moved 1 m across into the one pulled out behind it). Following the line is not a move.
  // From half a second before braking: a move started then is still going under braking (the
  // car can't stop moving across at once).
  if ((braking || plans.envelope(ahead + st.v * 0.5, st.delta, depth.tow, depth.dirty) < st.v - 1) && !ctx.neutral && avoid.hazard < 0) {
    for (const o of near) {
      if (o.gap >= 0 || o.gap < -12 || Math.abs(o.dd) < 1 || Math.abs(o.dd) > 4 || o.v < 10) continue;
      if ((wantDelta - st.delta) * Math.sign(o.dd) > 0) wantDelta = st.delta;
    }
  }

  // --- Exit room: a car level beside me on the outside of the exit (its centre no more than
  // ROOM_LEVEL behind mine) is owed room to the end of the exit; a car further back isn't (it
  // backs out, and if it runs out of road that's its own off).
  let exitRoom = -1;
  {
    const L = lanes.track.length;
    let exitOut = 0;
    for (const c of ctx.corners) {
      const past = (((st.s - c.apex * lanes.track.ds) % L) + L) % L;
      if (past < EXIT_LEN) { exitOut = -c.dir; break; }
    }
    let best = Infinity;
    if (exitOut !== 0) for (const o of near) {
      if (Math.abs(o.gap) >= ALONGSIDE || Math.abs(o.dd) < 1.2 || Math.sign(o.dd) !== exitOut || o.gap < -ROOM_LEVEL || o.v < 10) continue;
      if (Math.abs(o.dd) < best) { best = Math.abs(o.dd); exitRoom = o.j; }
    }
  }
  if (avoid.hazard >= 0) wantDelta = avoidSlowCar(view, near, wantDelta).delta;

  // Only in the braking zone (the envelope asks to slow down) and before the turn-in: the car
  // brakes later and less, but never speeds up from it, and corner speed is unchanged.
  // A committed attacker takes a lane it can make by braking into the planned margin (late
  // braking): held to the planned envelope, it could never leave its line once braking.
  const committed = cr.mode === 'attack' && cr.commit;
  wantDelta = feasibleDelta(me, wantDelta, depth, ahead, committed ? COMMIT_SLACK : 0.995, committed && !braking);
  const braveNow = brave > 1 && vEnv < st.v && toCorner > 30;
  if (braveNow) vEnv = Math.min(st.v, vEnv * brave);
  if (cr.mode !== 'attack') cr.commit = false;
  const tc = trafficControls(view, near, wantDelta, vEnv, battle ? BATTLE_BRAKE : undefined, { ...(cr.mode === 'attack' ? relax : {}), ...(owed >= 0 ? { yieldTo: owed } : {}), ...(exitRoom >= 0 ? { exitRoom } : {}) });
  // Moving across the road: respect the speed of the lane we're heading for too, so a car isn't
  // carried onto a tighter line faster than it can take it.
  let vLane = plans.envelope(ahead, tc.ctl.deltaTarget, depth.tow, depth.dirty);
  if (braveNow) vLane = Math.min(st.v, vLane * brave);
  // A lane that's only capping top speed (no braking in it for the next second) isn't a limit
  // on speed carried from a tow (rule 1; see vEnv above).
  if (flatOut(me, tc.ctl.deltaTarget, depth, ahead)) vLane = Math.max(vLane, st.v);
  const ctl = { ...tc.ctl, vTarget: Math.min(tc.ctl.vTarget, vLane), effects, ...(cr.mode === 'attack' && cr.commit ? { lateralSpeed: COMMIT_LATERAL } : {}) };
  return { ctl, following: tc.following, mistake: started, ...(choice ? { choice } : {}) };
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
 * Whether lane `delta`'s plan is flat for the next second (no braking in it): only its top speed,
 * which a car carrying speed from a tow may be over without needing to slow down.
 */
function flatOut(me: CraftCar, delta: number, depth: { tow: number; dirty: number }, ahead: number): boolean {
  const env = (s: number) => me.plans.envelope(s, delta, depth.tow, depth.dirty);
  const now = env(ahead);
  return env(ahead + me.st.v * 0.5) >= now - 0.5 && env(ahead + me.st.v) >= now - 0.5;
}

/**
 * A driver doesn't steer onto a lane it can't take at its current speed: at the cornering limit
 * there is no grip left to slow down, so tightening the line mid-corner would only slide. Moves
 * the wanted offset back toward the current one until the lane's braking envelope (just ahead
 * and a little further on) allows the current speed or, for a committed attacker, is no slower
 * than staying in the lane it is in. (Against the current speed alone, once the braking for a corner was within half
 * a second every lane failed, the car's own included: a committed attacker could not leave the
 * leader's line in the braking zone, and braked in line behind it.)
 */
function feasibleDelta(me: CraftCar, want: number, depth: { tow: number; dirty: number }, ahead: number, slack = 0.995, againstLane = false): number {
  const { st, plans } = me;
  const env = (s: number, delta: number) => plans.envelope(s, delta, depth.tow, depth.dirty);
  const later = ahead + st.v * 0.5;
  // Only a committed attacker is judged against its own lane: anyone else changing lanes in a
  // braking zone (the pack into T1 on lap 1, a defender) doubled the spins and contacts.
  const cap = (s: number) => (againstLane ? Math.min(st.v, env(s, st.delta)) : st.v);
  const need = [slack * cap(ahead), slack * cap(later)];
  // A lane with no braking in it for the next second can be taken at any speed the car has
  // (speed carried from a tow is over its plan's top speed, which made every lane look too fast
  // to take: the attacker could hardly pull out, Monza, phase B).
  const ok = (delta: number) => flatOut(me, delta, depth, ahead) || (env(ahead, delta) >= need[0] && env(later, delta) >= need[1]);
  if (ok(want)) return want;
  for (let f = 0.75; f > 0; f -= 0.25) {
    const d = st.delta + (want - st.delta) * f;
    if (ok(d)) return d;
  }
  return st.delta;
}
