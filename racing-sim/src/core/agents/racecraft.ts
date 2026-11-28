import { exp } from '../fmath';
import type { CarState, Controls } from '../race/car';
import { BRAKE_STYLE, BRAKE_USE, brakeUseFor, CAR_WIDTH, clamp, EDGE_KEEP, HIT_LEN, HIT_W, type LanePlans, type LaneSet, offShare, RUNOFF_GRIP } from '../race/lanes';
import { type CarModel, contactTolerance, dirtyEffects, type PhysicsParams } from '../physics/model';
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
  kind: 'lockup' | 'wide' | 'power';
  until: number;
  corner: number;
}

/** A driver's memory between ticks. */
export interface Craft {
  /**
   * Lap 1 (phase C): the lateral position the car started from (its grid side), held down to the
   * first braking zone; NaN until the car first moves. lap1Done once that braking starts.
   */
  gridD: number;
  lap1Done: boolean;
  /** Double-file form-up behind the safety car: the lateral position of my column (NaN: none). */
  column: number;
  /** Race distance the side hold ends by at the latest: the end of lap 1, or a lap after a double-file restart. */
  holdTo: number;
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
  /** The corner a cutback was weighed for (once per corner, phase D). */
  cutCorner: number;
  /** The braking corner being approached, to reset the once-per-corner decisions on the next. */
  cornerNow: number;
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
export type AttackPlan = 'inside' | 'outside' | 'dummy' | 'cutback';
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

export const newCraft = (): Craft => ({ gridD: NaN, lap1Done: false, holdTo: NaN, column: NaN, mode: 'line', other: -1, side: 0, corner: -1, defendedCorner: -1, commit: false, swapped: false, nextThink: 0, pushCorner: -1, push: 1, rhythmLap: -1, rhythm: 0, mistake: null, hold: NaN, gaveUp: -1, plan: 'inside', cover: 'inside', late: false, moved: false, stayCorner: -1, stay: false, cutCorner: -1, cornerNow: -1, memory: new Map() });

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
/** Defending: the cover is weighed up to this many seconds before the apex (at least 220 m). */
export const DEFEND_TIME = 2.5;
/** …and a run this many m/s quicker behind makes the threat plain. */
export const DEFEND_RUN = 6;
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
/**
 * Three lines per corner (phase D): the racing line, the inside (the dive: the inside edge from
 * DIVE_FROM before the apex) and the outside: a car's width (OUTSIDE_WIDTH) outside the racing
 * line from OUTSIDE_FROM before the apex, held to the apex and eased back onto the line over
 * OUTSIDE_EXIT after it. Worked out from the corner, so it doesn't move with the other car.
 */
export const OUTSIDE_FROM = 120;
export const OUTSIDE_EASE = 50;
export const OUTSIDE_EXIT = 60;
export const OUTSIDE_WIDTH = () => SIDE_GAP + 0.3;
/** The outside line's offset from the racing line at s (my lanes), for `corner`. */
export function outsideLine(lanes: LaneSet, corner: Corner, s: number, lineD: number): number {
  const L = lanes.track.length;
  let x = s - corner.apex * lanes.track.ds; // metres past the apex
  x = ((x % L) + L) % L;
  if (x > L / 2) x -= L;
  let w = 0;
  if (x >= -OUTSIDE_FROM && x < -OUTSIDE_FROM + OUTSIDE_EASE) { const u = (x + OUTSIDE_FROM) / OUTSIDE_EASE; w = u * u * (3 - 2 * u); }
  else if (x >= -OUTSIDE_FROM + OUTSIDE_EASE && x <= 0) w = 1;
  else if (x > 0 && x < OUTSIDE_EXIT) { const u = x / OUTSIDE_EXIT; w = 1 - u * u * (3 - 2 * u); }
  const d = clamp(lineD - corner.dir * OUTSIDE_WIDTH() * w, -lanes.lim, lanes.lim);
  return d - lineD;
}
/** The switchback: the next braking corner turns the other way within SWITCH_REACH m of this one's apex. */
export const SWITCH_REACH = 200;
export const SWITCH_GAIN = 1.5;
function switchback(plans: LanePlans, ctx: CraftContext, ci: number): boolean {
  if (ci < 0) return false;
  const map = brakingCorners(plans, ctx.corners, ctx.lanes);
  const next = map[(ci + 1) % ctx.corners.length];
  if (next < 0 || next === ci) return false;
  const a = ctx.corners[ci], b = ctx.corners[next];
  const L = ctx.lanes.track.length;
  const gap = ((((b.apex - a.apex) * ctx.lanes.track.ds) % L) + L) % L;
  return b.dir !== a.dir && gap < SWITCH_REACH;
}
/** An attacker waiting in the tow takes its own line, not the leader's, when the leader is more than OFFLINE m off its line with braking within OFFLINE_LEAD s. */
export const OFFLINE = 2;
export const OFFLINE_LEAD = 2.5;
/** Cutback: weighed from CUT_FROM m before the apex; a held-up car needs CUT_FASTER s/lap on the leader; CUT_RATE scales the odds. */
export const CUT_FROM = 160;
export const CUT_FASTER = 0.3;
export const CUT_RATE = 0.5;

/** A line within this of its edge bound (m) on a kerbed edge is "using the kerb", and a kerb-loving driver leans further onto it. */
export const KERB_NEAR_LINE = 0.6;
/** Kerb lean only where the line is tighter than this radius (m). */
export const KERB_LEAN_RADIUS = 150;
/** Offset from the line (toward the kerb) a driver with kerb use `use` (0–1) aims for at s. */
export function kerbLean(lanes: LaneSet, s: number, lineD: number, use: number): number {
  if (use <= 0) return 0;
  const k = lanes.surface.kerbs, n = lanes.track.n;
  const i = Math.min(n - 1, Math.floor((((s % lanes.track.length) + lanes.track.length) % lanes.track.length) / lanes.track.ds));
  const side = lineD > 0 ? 1 : -1;
  if (!(side > 0 ? k.left[i] : k.right[i])) return 0;
  // Only in a real corner: riding the kerb through a flat-out kink gains nothing.
  if (Math.abs(lanes.line.kappa[i]) < 1 / KERB_LEAN_RADIUS) return 0;
  const room = lanes.lim - Math.abs(lineD);
  if (room > EDGE_KEEP + KERB_NEAR_LINE || room <= 0) return 0;
  return side * room * use;
}

/** Late braking from bravery (at bravery 1): up to this share of speed into the braking zone. */
export const BRAVE_GAIN = 0.04;
/** Of an aggressive driver's (throttle 1) mistakes on the way out of a corner, this share is getting loose on the power (the rest run wide). */
export const POWER_SHARE = 0.6;

/** A corner needs braking in a car if its plan's apex speed is under this share of the fastest it goes in the BRAKE_LOOK m before. */
export const FLAT_SHARE = 0.98;
const BRAKE_LOOK = 300;
const brakingCache = new WeakMap<LanePlans, Int32Array>();
/**
 * For each corner on the map, the index of the first corner at or after it that needs braking in
 * this car (on its racing-line plan); -1 if none does. Cached per plan set.
 */
export function brakingCorners(plans: LanePlans, corners: Corner[], lanes: LaneSet): Int32Array {
  let t = brakingCache.get(plans);
  if (t) return t;
  const v = plans.profiles[lanes.zero].v, n = v.length, back = Math.round(BRAKE_LOOK / lanes.track.ds);
  const brakes = corners.map((c) => {
    let top = 0;
    for (let k = 0; k <= back; k++) top = Math.max(top, v[(c.apex - k + n) % n]);
    return v[c.apex] < FLAT_SHARE * top;
  });
  t = new Int32Array(corners.length).fill(-1);
  for (let k = 0; k < corners.length; k++) {
    for (let m = 0; m < corners.length; m++) {
      const j = (k + m) % corners.length;
      if (brakes[j]) { t[k] = j; break; }
    }
  }
  brakingCache.set(plans, t);
  return t;
}

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
  // The next corner on the map (pace scatter, lap 1), and the next one that needs braking in this
  // car (racecraft): a flat-out kink isn't a corner to attack into or defend (phase D, Laguna T1:
  // attacks ended and defences began on a bend taken flat, and the attacker lost its run).
  const ciMap = ctx.nextCorner[i];
  const toMapCorner = ciMap >= 0 ? distTo(lanes, st.s, ctx.corners[ciMap].apex) : Infinity;
  const ci = ciMap >= 0 ? brakingCorners(plans, ctx.corners, lanes)[ciMap] : -1;
  const corner = ci >= 0 ? ctx.corners[ci] : null;
  const toCorner = corner ? distTo(lanes, st.s, corner.apex) : Infinity;
  // Once-per-corner decisions are once per pass: on to the next corner, forget the last one's.
  // (They were only replaced by a decision at another corner, so a car that gave up a move into
  // Monza T1 never attacked into it again, however big its run: Abreu behind Alvarez, seed 4.)
  if (ci !== cr.cornerNow) {
    cr.cornerNow = ci;
    cr.gaveUp = cr.defendedCorner = cr.cutCorner = cr.stayCorner = -1;
  }
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
    if (ciMap !== cr.pushCorner) {
      cr.pushCorner = ciMap;
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
    if (ciMap !== cr.pushCorner) {
      cr.pushCorner = ciMap;
      cr.push = 1 + me.rng.normal() * sd;
    }
    vEnv *= cr.push + cr.rhythm;
    // Lap 1: cold tyres, a full field and nobody sure where the others will brake, so a margin
    // under race pace, largest into T1 and smaller for a braver driver (phase C; the user's view:
    // T1 can't be taken flat out physically, but racers still go as fast as they can).
    if (st.dist < lanes.track.length && ciMap >= 0) vEnv *= 1 - (ciMap === 0 ? LAP1_CAUTION.t1 : LAP1_CAUTION.rest) * (1 - drv.bravery);
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
  // Kerb use (style, phase D): where the line runs near an edge that has a kerb, a driver who
  // likes kerbs takes more of it (the lanes' plans pay its grip; it spins more on the power).
  let wantDelta = drv.style ? kerbLean(lanes, st.s, lineD, drv.style.kerbs) : 0;
  // Off the start, every car keeps its grid side down to the first braking zone (phase C): the
  // field arrives at T1 two or three wide instead of funnelling onto the racing line within two
  // seconds. Moves made by attacking or defending (their one move) still override it below.
  if (Number.isNaN(cr.gridD)) cr.gridD = me.d;
  if (!cr.lap1Done) {
    // Down to T1: its braking zone, or its approach for a corner taken without braking.
    if (braking || toMapCorner < LAP1_HOLD_TO || st.dist > (Number.isNaN(cr.holdTo) ? lanes.track.length : cr.holdTo) || ctx.neutral || ctx.push) cr.lap1Done = true;
    else wantDelta = clamp(cr.gridD, -lim, lim) - lineD;
  }
  // Forming up two wide behind the safety car: my column, under the usual side spacing.
  if (!Number.isNaN(cr.column)) wantDelta = clamp(cr.column, -lim, lim) - lineD;
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
    const braking = st.aLong < -3 && toCorner < 200;
    const cornering = Math.abs(st.aLat) > 0.5 * me.model.gripLimit(undefined, st.v);
    // Styles cost mistakes (phase D, until tyres give them a long-run cost): a late, hard braker
    // locks up more; a U driver, carrying speed, runs wide more; an aggressive throttle gets
    // loose on the way out.
    const sty = drv.style;
    const styleRate = !sty ? 1 : braking ? 0.6 + 0.8 * sty.braking : (1.2 - 0.4 * sty.line) * (0.8 + 0.4 * sty.throttle);
    const rate = (1 - drv.consistency) * (0.004 + 4 * excess) * styleRate;
    if (me.rng.next() < rate * dt && st.v > 15) {
      if (braking || cornering) {
        const power = !braking && sty !== undefined && st.aLong > 0 && me.rng.next() < POWER_SHARE * sty.throttle;
        cr.mistake = { kind: braking ? 'lockup' : power ? 'power' : 'wide', until: ctx.t + (braking ? 0.9 : power ? 0.8 : 1.6), corner: ci };
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
    // Power: the rear steps out on the way out; the driver lifts to catch it and drifts wide.
    const ctl: Controls = m.kind === 'lockup'
      ? { vTarget: Math.max(0, st.v - 0.45 * bMax * dt), deltaTarget: st.delta, effects }
      : m.kind === 'power'
        ? { vTarget: Math.min(vEnv, st.v), deltaTarget: clamp(lineD + st.delta + outward * 1.5, -lim, lim) - lineD, effects }
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
      // Styles (phase D): a late braker dives, a U driver goes round the outside; the outside of
      // a corner is the inside of the next if it turns the other way soon after (the switchback,
      // the user's Monza T9/T10 ruling).
      const sty = drv.style;
      const plan = lapping ? 'inside' : pick<Exclude<AttackPlan, 'cutback'>>({
        inside: (0.6 + 0.4 * drv.aggression) * (sty ? 0.6 + 0.8 * sty.braking : 1) * lean((seen.inside + 1) / n),
        outside: (0.3 + 0.3 * (1 - drv.aggression)) * (sty ? 0.6 + 0.8 * (1 - sty.line) : 1) * (switchback(plans, ctx, ci) ? 1 + SWITCH_GAIN : 1) * lean((seen.outside + 1) / n),
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
        // Logged when the move is made (the pull-out), not when the car starts waiting in the tow
        // for one: a car stuck behind logged an attack at nearly every corner (phase D).
        if (lapping) choice = { role: 'attack', other: front.j, kind: cr.plan, corner: ci };
        break;
      }
    }
  }

  // Bravery's late braking only uses the margin the driver's braking style hasn't already taken: a
  // late braker (style 0.95) plans with 96% of the brakes, and adding bravery on top put Hughes into
  // the back of cars at Yas T5 on lap 1 (lap-1 crashes 1 → 7 in 8 races, phase D).
  const braveGain = BRAVE_GAIN * drv.bravery * clamp(1 - (brakeUseFor(drv.style) - BRAKE_USE) / (BRAKE_STYLE / 2), 0, 1);
  let brave = ctx.push ? 1 + braveGain : 1;
  const relax: GapRuleRelax = {};
  if (cr.mode === 'attack') {
    let o: Near | undefined;
    for (const x of near) if (x.j === cr.other) o = x;
    // Past it once clear ahead (no overlap): holding the move until ALONGSIDE behind kept the
    // passer a car's width off the car it had passed, mirroring it across the road (Monza seed 1,
    // phase D: Abreu, leading, slid across the straight with Alvarez as Alvarez pulled out).
    const passed = !o || o.gap < -HIT_LEN;
    const dropped = o && o.gap > 35;
    // A cutback runs the outside line through the corner behind the leader, then attacks on the
    // way out: past the apex it carries on as an ordinary attack on the next corner.
    if (cr.plan === 'cutback' && ci !== cr.corner && o && !passed && !dropped) {
      cr.plan = corner && Math.sign(o.d - me.d) === corner.dir ? 'outside' : 'inside';
      cr.corner = ci;
      cr.commit = false;
      cr.swapped = false;
    }
    const beatenAtApex = o && toCorner < 8 && corner && ci === cr.corner && o.gap > HIT_LEN && cr.plan !== 'cutback';
    if (passed || dropped || beatenAtApex || ci !== cr.corner && o && o.gap > ALONGSIDE) {
      cr.mode = 'line';
    } else if (o) {
      // The leader's line swings across the road; if our side runs out of room, use the other.
      const room = (side: number) => side * (side * lim - o.d) >= SIDE_GAP;
      const lateOutside = (side: number) => !!corner && ci === cr.corner && side === -corner.dir && corner.radius < 25 && toCorner < OUTSIDE_FROM && !classQuicker(me, cars[cr.other]);
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
        if (roomFor && cr.plan !== 'cutback' && (run || (brakingSoon && o.gap < DIVE_GAP))) {
          // The leader's line swings across the road; if our side has no room, use the other.
          if ((!room(cr.side) || busy(cr.side)) && room(-cr.side) && !busy(-cr.side)) cr.side = -cr.side;
          // No slot on either side: stay in the tow and wait. Not out to the outside once inside
          // OUTSIDE_FROM: the whole car's width across in the braking zone, while turning in, left
          // no grip to brake with (MX-5 T3: committed 83 m out, braking fell to 1 m/s², into the
          // barrier). The outside move is set up before the corner, or not at all.
          if (room(cr.side) && !busy(cr.side) && !lateOutside(cr.side)) {
            cr.commit = true;
            choice = { role: 'attack', other: cr.other, kind: cr.plan, corner: ci };
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
      // The dummy: shown one side, switch to the other once, just before braking, if it's open,
      // and only with time to get across before reaching the leader: with a big run up a straight
      // the switch cut back behind its gearbox and the attacker braked 60 km/h to miss it (Monza
      // seed 3, Abreu on Dlamini, the user's ruling). Keep going on the side shown instead.
      const crossTime = (Math.abs(o.dd) + HIT_W) / PULL_LATERAL + 0.3;
      const reachTime = (o.gap - HIT_LEN) / Math.max(0.1, st.v - o.v);
      if (cr.commit && cr.plan === 'dummy' && !cr.swapped && corner && ci === cr.corner && o.gap > HIT_LEN && !braking && reachTime > crossTime &&
        plans.envelope(ahead + st.v * DUMMY_LEAD, st.delta, depth.tow, depth.dirty) < st.v - 1 && room(-cr.side) && !busy(-cr.side) && !lateOutside(-cr.side)) {
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
        if (!braking && !cr.swapped && room(-cr.side) && !busy(-cr.side) && !lateOutside(-cr.side)) {
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
        // The cutback (phase D), weighed once per corner: the leader has dived for the inside, or
        // I'm quicker but held up in its dirty air. Run the outside line through the corner (off
        // the leader's line and out of its wake) for the better exit, and go on the way out.
        if (corner && ci === cr.corner && cr.cutCorner !== ci && toCorner < CUT_FROM && cr.plan !== 'cutback') {
          cr.cutCorner = ci;
          const t = cars[cr.other].craft;
          const dived = t.mode === 'defend' && t.moved && t.side === corner.dir;
          const heldUp = depth.dirty > 0.3 && cars[cr.other].plans.lapTime - plans.lapTime > CUT_FASTER;
          const sty = drv.style;
          if ((dived || heldUp) && me.rng.next() < CUT_RATE * (0.5 + drv.racecraft) * (sty ? 0.6 + 0.8 * sty.line : 1)) {
            cr.plan = 'cutback';
            choice = { role: 'attack', other: cr.other, kind: 'cutback', corner: ci };
          }
        }
        if (cr.plan === 'cutback' && corner && ci === cr.corner) wantDelta = outsideLine(lanes, corner, st.s, lineD);
        else {
          // The leader's line, as an offset from the racing line where the leader is (its lateral
          // position now would be a different point of the corner here). Not where the leader is
          // well off its line with braking close (defending, or in a fight of its own): the tow
          // isn't worth a slower way into the corner (the user's Monza T9 ruling: Alvarez
          // shouldn't follow Abreu's line).
          // Only past lap 1 (there every car is off its line, keeping its grid side, and taking the
          // line under braking put attackers onto the cars ahead: Monza T1 squeezes went 2 → 19 in
          // 8 races) and only behind a leader busy in a fight of its own.
          const leaderOff = o.d - lanes.lineD(st.s + o.gap);
          const busyLeader = cars[o.j].craft.mode !== 'line';
          const brakingNear = st.dist > lanes.track.length && busyLeader && plans.envelope(ahead + st.v * OFFLINE_LEAD, st.delta, depth.tow, depth.dirty) < st.v - 1;
          wantDelta = Math.abs(leaderOff) > OFFLINE && brakingNear ? 0 : leaderOff;
        }
        relax.tow = cr.other;
      } else {
        // Into the corner on the inside: dive for the inside edge (the leader's line sweeps
        // across from the outside, so sitting a car's width off the leader would be squeezed onto
        // the same edge behind it). Elsewhere, sit a car's width off the leader.
        const dive = corner && ci === cr.corner && cr.side === corner.dir && toCorner < DIVE_FROM && room(cr.side);
        // Round the outside (phase D): the corner's outside line, worked out from the corner, not
        // from the leader (sitting a car's width off the leader, the attacker was squeezed as the
        // leader swept to the apex, and lifted).
        const wide = corner && ci === cr.corner && cr.side === -corner.dir && toCorner < OUTSIDE_FROM;
        // The dive goes for the inside edge, short of any car already alongside there: three wide
        // into Monza T1, the middle car dived for the edge with a car on it and put it off (the
        // user's Ito ruling: not fully ahead, you can't squeeze).
        let edge = cr.side * lim;
        for (const x of near) {
          if (x.j === cr.other || Math.abs(x.gap) >= ALONGSIDE || Math.abs(x.dd) < 1.2 || Math.sign(x.dd) !== cr.side) continue;
          const keep = x.d - cr.side * SIDE_GAP;
          edge = cr.side > 0 ? Math.min(edge, keep) : Math.max(edge, keep);
        }
        wantDelta = dive ? edge - lineD : wide ? outsideLine(lanes, corner, st.s, lineD) : clamp(o.d + cr.side * (SIDE_GAP + 0.3), -lim, lim) - lineD;
        relax.commit = cr.other;
        // Brave: brake later while fighting for the corner (not a higher cornering speed). The
        // planned braking leaves a margin (BRAKE_USE ≈ 3% of speed); an average driver uses about
        // two thirds of it, the bravest a little more than all of it (and may overshoot).
        if (Math.abs(o.gap) < 12) brave = 1 + braveGain;
      }
    }
  }

  // --- Defend: one move to the inside of the next corner when someone is close behind.
  // The window is ~2.5 s before the apex at speed (a fixed 220 m was 2 s at Monza's T1, often
  // over before the attacker showed its hand).
  if (cr.mode === 'line' && !yieldTo && !ctx.neutral && avoid.hazard < 0 && off === 0 && behind && corner && cr.defendedCorner !== ci && toCorner < Math.max(220, DEFEND_TIME * st.v) && toCorner > 40 && !braking) {
    const threat = cars[behind.j];
    const attacking = threat.craft.mode === 'attack' && threat.craft.other === me.idx;
    // Still a weighted roll (drivers miss things), but the plainer the threat the likelier the
    // cover: a committed move or a big run out of the tow (the user's Monza ruling: Abreu, towed
    // and towing, had to cover the inside from Bianchi). Racecraft reads the subtler ones.
    const run = clamp((behind.v - st.v) / DEFEND_RUN, 0, 1);
    const plain = (threat.craft.commit && attacking ? 0.5 : 0) + 0.4 * run;
    const pDefend = 1 - (1 - drv.racecraft * 0.6) * (1 - plain);
    // Nothing to defend against yet: decide later in the window, once there is.
    const rival = !classQuicker(threat, me) && (attacking || behind.v > st.v + 1.5) && behind.gap > -15;
    // A class quicker car isn't a rival: hold the line and let it by.
    if (rival && me.rng.next() < pDefend) {
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
    if (rival) cr.defendedCorner = ci; // the decision (either way) is made once per corner
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
        // Too late to cover a side someone is already alongside on: moving across into them was
        // the commonest Monza contact once defending got likelier (inside dive vs inside cover).
        // Nor one an attacker has already pulled out to and is about to draw alongside on (within
        // a car length of overlap): that's a chop, not a cover.
        const chop = near.some((x) => x.gap < 0 && x.gap > -(2 * HIT_LEN) && Math.abs(x.dd) > 1.2 && Math.sign(x.dd) === cr.side);
        if (cr.side !== 0 && ((cr.side > 0 ? leftBusy : rightBusy) || chop)) cr.side = 0;
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
  // --- Rule 3 amended (phase C, from the user's Monza seed 5 rulings): with a car alongside on
  // that side, following the racing line toward it is a move too. The line pulls every car in a
  // pack to the same spot, so a car on the line squeezed the two beside it into one lane (Chen,
  // Kowalski), and a middle car drove down the line onto the inside one (Jovanovic onto
  // Nakamura). Hold my place across the road instead (my d, not my offset from a sweeping line).
  // Not for a committed attacker: its move is the pass, judged by the rules above.
  if ((braking || plans.envelope(ahead + st.v * 0.5, st.delta, depth.tow, depth.dirty) < st.v - 1) && !ctx.neutral && avoid.hazard < 0 && !(cr.mode === 'attack' && cr.commit)) {
    const toward = lineD + wantDelta - me.d;
    if (Math.abs(toward) > 0.2) {
      for (const o of near) {
        if (Math.abs(o.gap) >= ALONGSIDE || o.v < 10 || Math.sign(o.dd) !== Math.sign(toward) || Math.abs(o.dd) > SIDE_GAP + HOLD_REACH) continue;
        wantDelta = me.d - lineD;
        break;
      }
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
  const tc = trafficControls(view, near, wantDelta, vEnv, battle ? BATTLE_BRAKE : undefined, { ...(cr.mode === 'attack' ? relax : {}), ...(owed >= 0 ? { yieldTo: owed } : {}), ...(exitRoom >= 0 ? { exitRoom } : {}), ...(st.dist < lanes.track.length && !ctx.push ? { extraRoom: LAP1_FOLLOW * st.v * (1.5 - drv.bravery) * (1 - contactTolerance(me.model.spec)) } : {}) });
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
  // Only where the plan is capped by top speed (a straight), never by grip: a corner held at a
  // steady radius is flat too, and letting a car keep its speed over the plan there let it beat
  // physics (phase B: qualifying and race laps came in under the ideal lap; phase C fix).
  const top = TOP_SHARE * me.model.topSpeedWith();
  const env = (s: number) => me.plans.envelope(s, delta, depth.tow, depth.dirty);
  const now = env(ahead);
  if (now < top) return false;
  return env(ahead + me.st.v * 0.5) >= top && env(ahead + me.st.v) >= top;
}
/** How much further than the side gap (m) a car alongside still pins me to my place across the road (rule 3 amended). */
export const HOLD_REACH = 1.5;
/** Lap 1: extra following room, seconds of my speed at bravery 0.5 (more for a timid driver, less for a brave one). */
export const LAP1_FOLLOW = 0.06;
/** Lap 1: the grid side is held until this far (m) from the first corner's apex at the latest. */
export const LAP1_HOLD_TO = 150;
/** Lap-1 speed margin at bravery 0 (share of the envelope): into T1, and the corners after it. */
export const LAP1_CAUTION = { t1: 0.06, rest: 0.02 };
/** Share of the car's clean-air top speed at which a plan counts as top-speed limited (flatOut). */
const TOP_SHARE = 0.985;

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
