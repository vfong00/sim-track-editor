import { type DriverSpec, type Entrant, racePace } from '../agents/driver';
import { avoidSlowCar, QUEUE_SHARE, RACING_SHARE, trafficControls, type Near, useCarSize } from '../agents/controller';
import { CLASS_GAP, type Craft, type CraftCar, type CraftChoice, newCraft, raceCraft, type CraftContext, ROOM_LEVEL } from '../agents/racecraft';
import { CarModel, carSize, type CarSpec, DEFAULT_PHYSICS, dirtyEffects, type DriverStyle, gripUse, type PhysicsParams, STANDARD_CAR } from '../physics/model';
import { type Corner, findCorners, nextCornerTable } from '../track/corners';
import { makeRng, type Rng } from '../rng';
import type { Track } from '../track/track';
import { type CarState, type Controls, newCarState, stepCar } from './car';
import { type Contact, resolveCollisions } from './collide';
import { brakeUseFor, CAR_WIDTH, geometricLine, HIT_LEN, isOffRoad, LanePlans, LaneSet } from './lanes';
import { DT } from './lap';

export interface RaceOptions {
  track: Track;
  entrants: Entrant[];
  laps: number;
  seed: number;
  physics?: Partial<PhysicsParams>;
  dt?: number;
  /** Reuse a precomputed lane set for this track. */
  lanes?: LaneSet;
  /** 'race' (default): full Phase 4 race craft. 'traffic': Phase 3 queueing rules only. */
  ai?: 'race' | 'traffic';
  /**
   * Phase 5 incidents (default on). Off: the road edge is a wall again and there are no offs,
   * spins, crashes or damage, so checks of the racing rules alone (Phase 4's wake checks) can
   * measure them without incidents mixed in.
   */
  incidents?: boolean;
  /**
   * Phase 6: multiplies every driver's incidentScale (1 = as tuned; 0 = no driver-caused spins
   * or crashes from slides and hits, though cars still slide and run off).
   */
  incidentRate?: number;
  /** Phase 6: scripted mid-race events (scenario `events`), applied in list order when due. */
  events?: ScriptedEvent[];
  /**
   * 'auto': deploy the safety car (for SAFETY_CAR.autoLaps laps) when a car comes to rest out of
   * the race on or beside the road. 'off' (default): only scripted deployments.
   */
  safetyCar?: 'off' | 'auto';
  /** 'grid' (default): standing start, lights out. 'rolling': the field two-wide at ROLLING speed, held to it until the leader reaches the line. */
  start?: 'grid' | 'rolling';
  /**
   * 'race' (default): a grid start, driven at race pace (a margin under the limit).
   * 'qualifying': each car starts QUALI_RUNUP m behind the line at speed, on the racing line, and
   * drives at the limit (full pace, bravery's late braking in every braking zone).
   */
  session?: 'race' | 'qualifying';
  /**
   * Where sectors 1 and 2 end (m from the start line along the centreline); sector 3 ends at the
   * line. Default: the lap in thirds. Timing only: it changes nothing in the race.
   */
  sectors?: [number, number];
}

/** Qualifying: the flying run-up to the line (m). Within CP_BASE, so the checkpoints cover it. */
export const QUALI_RUNUP = 350;
/** Shortest grid slot (m, from one car to the next, alternating sides). */
export const GRID_SLOT = 7;
/**
 * Rolling start (phase C): the field lines up on its grid slots `back` m further behind the line,
 * at `share` of the class's top speed (F1 ≈ 120 km/h), and holds that pace in formation until the
 * leader reaches the line: green. (The formation lap itself, behind the safety car, isn't driven.)
 */
export const ROLLING = { back: 150, share: 0.35 };
/** Double-file restart columns: this share of the half-width either side of the centre. */
export const RESTART_COLUMN = 0.45;

/**
 * Standing start (phase C): one red light a second from t = 1 until all five are on, a random
 * hold, then lights out. The race clock runs from the first light, so lights out is at 5.2–8 s.
 */
export const LIGHTS = { every: 1, count: 5, holdMin: 0.2, holdMax: 3 };
/**
 * Reaction after lights out (s): `best` for the steadiest, most racecraft-savvy driver, `worst` for
 * the least, plus noise; never under `min` unless the car jumps the start.
 */
export const REACTION = { best: 0.15, worst: 0.35, sd: 0.03, min: 0.12 };
/** Chance a car anticipates and moves before the lights go out, at aggression 0.5 (scales with it). */
export const JUMP_RATE = 0.004;
/**
 * Launch: a car gets `launch` of its drive for the first `time` s (wheelspin or bog-down), drawn
 * from |normal| × (sdBase + sdPerInconsistency × (1 − consistency)), never under `min`.
 */
export const LAUNCH = { time: 2.0, sdBase: 0.03, sdPerInconsistency: 0.3, min: 0.6 };

/**
 * A scripted mid-race event. It fires when the leader starts lap `lap` (lap 1 = at the start):
 * a track grip change (rain, drying), or a car spinning or retiring (car = entrant index).
 */
export type ScriptedEvent =
  | { lap: number; type: 'grip'; value: number; note?: string }
  | { lap: number; type: 'spin' | 'retire'; car: number; note?: string }
  | { lap: number; type: 'safety-car'; laps: number; note?: string };

export type RaceEventType = 'start' | 'jump' | 'contact' | 'pass' | 'mistake' | 'slide' | 'off' | 'rejoin' | 'spin' | 'crash' | 'retire' | 'cleared' | 'grip' | 'safety-car' | 'lap' | 'finish';

export interface RaceEvent {
  t: number;
  type: RaceEventType;
  cars: number[];
  /** Leader's lap when it happened. */
  lap: number;
  text: string;
  /**
   * Index (into `events`) of what led to this one: an off, spin or crash points at the slide,
   * mistake, contact or off that caused it; a rejoin points at its off.
   */
  cause?: number;
  /**
   * The car blamed (entrant index), where the sim judged it: a squeeze over the edge is the
   * squeezer's fault if the car squeezed was level (owed room), else the squeezed car's own.
   */
  blame?: number;
}

/** A racecraft decision (phase B), for variety per driver: which car, against whom, what it chose. */
export interface DecisionLog extends CraftChoice {
  t: number;
  car: number;
}

/**
 * Where a car is in an incident (Phase 5): running (on or off the road), spinning (no control,
 * sliding to a stop), stopped after a spin (waiting to rejoin), crashing (sliding to a stop,
 * out of the race), retiring (a mechanical failure: coasting to a stop at the side) or out
 * (retired, stays where it stopped).
 */
export type CarStatus = 'run' | 'spin' | 'stopped' | 'crash' | 'retiring' | 'out';

/** Status codes in the state log. */
export const STATUS = { run: 0, off: 1, spin: 2, stopped: 3, crash: 4, retiring: 4, out: 5, cleared: 6 } as const;

/**
 * Incident model (Phase 5). Odds come from the physics: how far over the grip limit a car is,
 * how hard it hits another car or the barrier. They are scaled by the driver's `incidentScale`
 * (consistency and risk-taking), 1 for an average driver. Every roll uses the car's own rng.
 */
export const INCIDENTS = {
  /** A slide this far over the limit (excess cornering / grip) is logged as a moment. */
  slideLog: 0.1,
  /**
   * Spins: sliding beyond spinFrom over the limit (for an average driver; divided by the
   * driver's incidentScale) spins the car at spinRate per second per unit beyond.
   */
  spinFrom: 0.35,
  spinRate: 3,
  /**
   * Kerbs: under throttle with friction-circle usage above kerbSpinFrom, a car on a kerb spins
   * at kerbSpinRate per second, times its share on the kerb, how far it is from kerbSpinFrom to
   * the limit, and the driver's incidentScale.
   */
  kerbSpinFrom: 0.9,
  kerbSpinRate: 0.006,
  /** …only putting the power down (m/s² of acceleration): not cruising near top speed through a kink (phase D). */
  kerbSpinPower: 1,
  /** Contact: spin odds rise from contactSpin m/s of closing speed over contactSpinSpan (times how off-centre). */
  contactSpin: 3,
  contactSpinSpan: 6,
  /** Contact: crash odds rise from contactCrash m/s over contactCrashSpan. */
  contactCrash: 10,
  contactCrashSpan: 10,
  /** Barrier: crash odds rise from wallCrash m/s of sideways impact over wallCrashSpan. */
  wallCrash: 6,
  wallCrashSpan: 8,
  /** Damage: share of grip lost per m/s of impact above damageFrom, capped; in steps for the plans. */
  damageFrom: 2,
  damagePer: 0.004,
  damageMax: 0.05,
  damageStep: 0.005,
  /** A cause is only blamed for an incident within this many seconds. */
  causeWindow: 6,
  /** A running car at a standstill this long is beached (e.g. against a wreck in the run-off) and retires. */
  stuckAfter: 30,
  /**
   * Marshals clear a car that is out of the race this long after it stopped: it is no longer an
   * obstacle (without this, a pile-up at one corner could block the whole field for good).
   */
  clearAfter: 40,
};

/**
 * Risk-taking: the mean of aggression and bravery. Phase 6 scenarios set both from one `risk`
 * rating (see `driverFromRatings`), so for those drivers riskTaking equals that rating.
 */
export const riskTaking = (d: DriverSpec) => (d.aggression + d.bravery) / 2;
const scaleRaw = (d: DriverSpec) => (1.5 - d.consistency) * (0.5 + riskTaking(d));
/**
 * How incident-prone a driver is once in trouble (1 = average): rises with risk-taking (keeps
 * pushing through a moment instead of backing off), falls with consistency (catches it).
 */
export const incidentScale = (d: DriverSpec) => scaleRaw(d) / 0.65;

export interface RaceCar {
  idx: number;
  entrant: Entrant;
  /** The lanes around this car's own line (phase D: its class and style); its st.delta is measured from that line. */
  lanes: LaneSet;
  model: CarModel;
  plans: LanePlans;
  st: CarState;
  /** Lateral position (derived from st each tick, for neighbours and the log). */
  d: number;
  /** When the car moves off the grid: lights out plus its reaction (negative reaction = a jump start). */
  startDelay: number;
  /** Share of the drive it gets off the line for LAUNCH.time s (wheelspin or bog-down below 1). */
  launch: number;
  rng: Rng;
  /** Highest line crossing seen (0 = crossed the start line, k = completed k laps). */
  crossings: number;
  lapTimes: number[];
  lastCross: number;
  finished: boolean;
  finishTime: number;
  finishLaps: number;
  /** Time at which the car reached each checkpoint (every CP metres of race distance). */
  cp: number[];
  following: number;
  craft: Craft;
  /** Who gave this car a tow / dirty air this tick (-1 = clean air). */
  wake: number;
  status: CarStatus;
  /** Out of the race (crashing or retired). */
  dnf: boolean;
  /** Retired: an immovable obstacle for the others. */
  fixed: boolean;
  /** When it came to rest out of the race (NaN while running), and whether marshals have cleared it. */
  outSince: number;
  cleared: boolean;
  /** Heading relative to the road while spinning or stopped (rad, cosmetic), and its rate. */
  yaw: number;
  yawRate: number;
  /**
   * Cosmetic drift angle while running (rad, nose into the corner): eases toward a target set
   * by how far over the grip limit the car is. Logged in the yaw slot; changes nothing in the race.
   */
  drift: number;
  /** Speed when the spin or crash started (the rotation slows with the car). */
  vSpin: number;
  restartAt: number;
  /** Index of the open 'off' event while off the road, else -1. */
  offEvent: number;
  /** Most recent slide, mistake or contact event for this car (-1 = none). */
  cause: number;
  lastSlideLog: number;
  /** Last time the car was over its grip limit. */
  lastSlideT: number;
  /** Last touch with another car (any closing speed, or a squeeze over the edge) and with whom. */
  lastTouchT: number;
  lastTouchWith: number;
  /** The last touch was a squeeze over the edge with the car level beside the squeezer (owed room). */
  lastTouchLevel: boolean;
  /** When the car's wheels first went over the road edge in the current excursion (NaN = on the road). */
  edgeT: number;
  /** Lasting grip loss from contact (share), and the level the current plans were made for. */
  damage: number;
  damageLevel: number;
  /** Since when a running car has been at a standstill (NaN = moving). */
  stillSince: number;
  /** Time of each start/finish line crossing (index 0 = the start line at the start). */
  crossTimes: number[];
}

export interface RaceStats {
  passes: number;
  mistakes: number;
  contacts: number;
  offs: number;
  spins: number;
  /** Cars out of the race. */
  dnfs: number;
  /** Share of sampled (car, time) points where a car ran within 1.0 s of the car ahead (after lap 1). */
  trainShare: number;
  /**
   * Car-seconds (after lap 1) a quicker car (clean-air lap ≥ 0.3 s faster) spent stuck within
   * 1.0 s behind a slower one. Dirty air raises this; passing lowers it.
   */
  stuckTime: number;
  /**
   * Car-seconds a car spent within 1.0 s behind a car on the road at least CLASS_GAP slower over a
   * clean-air lap (another class, or a backmarker in a much slower car), whatever lap either is on.
   */
  trafficTime: number;
}

/** Ticks between train samples. */
const TRAIN_EVERY = 30;

/** Checkpoint spacing for time gaps, and the race distance of checkpoint 0. */
const CP = 10;
const CP_BASE = -400;

/** Race-craft mode codes in `modeLog`. */
export const MODE = { line: 0, attack: 1, defend: 2 } as const;

/**
 * Display only: the drift angle a sliding car is drawn at (rad, about 20°), and how fast it
 * builds and settles (1/s).
 */
export const DRIFT = { max: 0.35, rise: 12, fall: 5 };

/**
 * Frame layout in the state log: per car [s, d, v, yaw, status code (STATUS)]. Yaw is relative
 * to the road: the spin angle while spinning or stopped, the drift angle (`RaceCar.drift`) while running.
 */
export const FRAME_STRIDE = 5;

const planCache = new WeakMap<LaneSet, Map<string, LanePlans>>();

/**
 * Car model and lane plans for a car spec driven at `pace` under `physics`, cached per lane set.
 * The key covers every input (rule 5): the spec, the full physics and the pace; the lane set
 * (track and racing line) is the WeakMap key. Shared by races and by scenario grid ordering.
 */
export function lanePlansFor(lanes: LaneSet, spec: CarSpec, pace: number, physics: Partial<PhysicsParams> = {}, style?: DriverStyle): { model: CarModel; plans: LanePlans } {
  let cache = planCache.get(lanes);
  if (!cache) planCache.set(lanes, (cache = new Map()));
  const model = new CarModel(spec, physics, gripUse(spec, style));
  const p = model.physics;
  const key = JSON.stringify([spec, p, pace, style ?? null]);
  let plans = cache.get(key);
  const dirty = dirtyEffects(p.dirtyAir, 1);
  if (!plans) cache.set(key, (plans = new LanePlans(lanes, model, { grip: pace, drag: 1 },
    { grip: pace, drag: 1 - p.slipstream }, { grip: pace * dirty.grip, aero: dirty.aero, drag: 1 }, brakeUseFor(style))));
  return { model: plans.model, plans };
}

/**
 * The race loop. Pure and deterministic: the same options give the same `frames` and
 * `events`. Viewers read `frames` / `orders` / `events` and never touch car state (rule 4).
 */
export class Race {
  readonly lanes: LaneSet;
  readonly cars: RaceCar[];
  readonly dt: number;
  readonly laps: number;
  /** State log: frames[k] is the state after tick k (frames[0] = grid). */
  readonly frames: Float32Array[] = [];
  /** Running order (car indices, P1 first) for each frame. */
  readonly orders: Uint8Array[] = [];
  readonly events: RaceEvent[] = [];
  readonly rng: Rng;
  readonly corners: Corner[];
  readonly nextCorner: Int32Array;
  /** Current physics (a scripted grip change replaces gripLevel mid-race). */
  physics: PhysicsParams;
  t = 0;
  tick = 0;
  leaderFinished = false;
  private contactCooldown = new Map<number, number>();
  /** Last contact event per pair (blamed for incidents from hits inside the cooldown). */
  private pairEvent = new Map<number, number>();
  /** Pair key → which car was ahead, and since when a swap has held (pass confirmation). */
  private pairAhead = new Map<number, { ahead: number; since: number; confirmed: number }>();
  private trainSamples = 0;
  private trainHits = 0;
  private stuckTime = 0;
  private trafficTime = 0;
  /** Next scripted event (index into opts.events) still to fire. */
  private nextScripted = 0;
  /** The safety car while deployed (out or just pulled in), else null. */
  sc: SafetyCarState | null = null;
  /** Safety car position (track s) for each frame; NaN when it isn't on track. */
  readonly scLog: number[] = [];
  /** Race-craft mode of every car for each frame (MODE codes), for viewers. */
  readonly modeLog: Uint8Array[] = [];
  /** Racecraft decisions (phase B), in order. */
  readonly decisions: DecisionLog[] = [];
  /** Track grip changes (the first entry is the start). */
  readonly gripLog: { t: number; level: number }[] = [];
  /** Damage changes: the grip-loss level a car's plans were made for, from time t. */
  readonly damageLog: { t: number; car: number; level: number }[] = [];
  /** Plans the safety car's speed comes from (a standard car on the current grip). */
  private scPlans: LanePlans | null = null;

  /** Lap distance (m) at the end of each sector: [end of S1, end of S2, lap length]. */
  readonly sectorEnds: number[];

  constructor(readonly opts: RaceOptions) {
    const { track, entrants } = opts;
    this.dt = opts.dt ?? DT;
    this.sectorEnds = sectorEnds(track.length, opts.sectors);
    this.laps = opts.laps;
    this.lanes = opts.lanes ?? new LaneSet(track);
    this.rng = makeRng(opts.seed);
    this.physics = { ...DEFAULT_PHYSICS, ...opts.physics };
    this.gripLog.push({ t: 0, level: this.physics.gripLevel });
    // Named from the geometric line, so T-numbers don't move with the class lines (phase D).
    this.corners = findCorners(geometricLine(track));
    this.nextCorner = nextCornerTable(track.n, this.corners);
    const quali = opts.session === 'qualifying';
    // The field's car size: the largest preset in it (a mixed field judges every pair by the biggest).
    this.size = entrants.reduce((m, e) => { const z = carSize(e.car); return { length: Math.max(m.length, z.length), width: Math.max(m.width, z.width) }; }, { length: 0, width: 0 });
    useCarSize(this.size);
    // Grid slots by car length: 7 m apart (staggered, so 14 m on each side) for short cars, F1's 8 m.
    const slot = Math.max(GRID_SLOT, this.size.length + 2.4);
    const rolling = !quali && opts.start === 'rolling';
    this.rolling = rolling;
    this.lightsOut = quali || rolling ? 0 : LIGHTS.count * LIGHTS.every + LIGHTS.holdMin + (LIGHTS.holdMax - LIGHTS.holdMin) * this.rng.next();
    this.cars = entrants.map((e, idx) => {
      const { model, plans } = this.plansFor(e, 0);
      const lanes = e.lanes ?? this.lanes;
      // Race: a staggered two-wide grid behind the line. Qualifying: on the racing line, at speed,
      // QUALI_RUNUP m back (further cars a run-up apart).
      const s0 = quali ? -QUALI_RUNUP * (idx + 1) : -5 - slot * idx - (rolling ? ROLLING.back : 0);
      const s = ((s0 % track.length) + track.length) % track.length;
      const d = quali ? lanes.lineD(s) : (idx % 2 === 0 ? 1 : -1) * Math.min(3.2, this.lanes.lim - 1);
      const st = newCarState(s, d - lanes.lineD(s), quali ? plans.speed(s, 0) : rolling ? Math.min(this.rollingSpeed(), plans.speed(s, 0)) : 0, s0);
      const rng = this.rng.fork();
      return {
        idx, entrant: e, lanes, model, plans, st, d, rng,
        ...(quali || rolling ? { startDelay: 0, launch: 1 } : this.standingStart(e, rng)),
        crossings: -1, lapTimes: [], lastCross: NaN, finished: false, finishTime: NaN, finishLaps: 0, cp: [], following: -1,
        craft: newCraft(), wake: -1,
        status: 'run', dnf: false, fixed: false, yaw: 0, yawRate: 0, drift: 0, vSpin: 0, restartAt: 0, offEvent: -1, cause: -1,
        lastSlideLog: -Infinity, lastSlideT: -Infinity, lastTouchT: -Infinity, lastTouchWith: -1, lastTouchLevel: true, edgeT: NaN, damage: 0, damageLevel: 0, stillSince: NaN, outSince: NaN, cleared: false, crossTimes: [],
      };
    });
    for (const c of this.cars) c.d = c.lanes.dOf(c.st.s, c.st.delta);
    this.log();
    if (quali) this.emit('start', [], 'Qualifying: on a flying lap');
    if (rolling) this.emit('start', [], 'Rolling start: the field in formation');
  }

  /** Rolling start: in formation until the leader reaches the line (then green). */
  private readonly rolling: boolean;
  private green = false;
  /** The formation pace: the slowest car's ROLLING share of its top speed, so every car can hold it. */
  private rollingSpeed(): number {
    return ROLLING.share * Math.min(...this.opts.entrants.map((e) => e.car.topSpeed));
  }

  /** The field's car body, length × width (m): collisions, side gaps and the grid use it. */
  readonly size: { length: number; width: number };

  /** When lights out comes (s on the race clock; 0 in qualifying). Light k (1–5) is on from k·LIGHTS.every s. */
  readonly lightsOut: number;

  /** A car's reaction (a jump start if it anticipates) and launch off a standing start. */
  private standingStart(e: Entrant, rng: Rng): { startDelay: number; launch: number } {
    const d = e.driver;
    const steady = (d.consistency + d.racecraft) / 2;
    let reaction = Math.max(REACTION.min, REACTION.best + (REACTION.worst - REACTION.best) * (1 - steady) + REACTION.sd * rng.normal());
    if (rng.next() < JUMP_RATE * 2 * d.aggression) reaction = -(0.05 + 0.25 * rng.next());
    const sd = LAUNCH.sdBase + LAUNCH.sdPerInconsistency * (1 - d.consistency);
    const launch = Math.max(LAUNCH.min, 1 - Math.abs(rng.normal()) * sd);
    return { startDelay: this.lightsOut + reaction, launch };
  }

  /** Car model and lane plans for an entrant with `damage` grip loss (shared across races on the lanes). */
  private plansFor(e: Entrant, damage: number): { model: CarModel; plans: LanePlans } {
    const spec = damage > 0 ? { ...e.car, grip: e.car.grip * (1 - damage) } : e.car;
    return lanePlansFor(e.lanes ?? this.lanes, spec, this.paceOf(e), this.physics, e.driver.style);
  }

  /** Share of the car's grip a driver uses in this session: a margin under the limit in a race. */
  paceOf(e: Entrant): number {
    return this.opts.session === 'qualifying' ? e.driver.pace : racePace(e.driver);
  }

  get track(): Track {
    return this.lanes.track;
  }

  get leaderLap(): number {
    return Math.max(0, ...this.cars.map((c) => c.crossings)) + 1;
  }

  get finished(): boolean {
    return this.cars.every((c) => c.finished || c.status === 'out');
  }

  /** Log an event; returns its index. */
  emit(type: RaceEventType, cars: number[], text: string, cause?: number): number {
    const e: RaceEvent = { t: this.t, type, cars, lap: Math.min(this.laps, this.leaderLap), text };
    if (cause !== undefined && cause >= 0) e.cause = cause;
    this.events.push(e);
    return this.events.length - 1;
  }

  /** Every other car relative to car i. */
  neighbours(i: number): Near[] {
    const L = this.track.length;
    const me = this.cars[i];
    const out: Near[] = [];
    for (const o of this.cars) {
      if (o === me || o.cleared) continue;
      let gap = o.st.s - me.st.s;
      if (gap >= L / 2) gap -= L;
      else if (gap < -L / 2) gap += L;
      if (gap > 300 || gap < -60) continue;
      // Queued behind another car it is still racing, down to QUEUE_SHARE of its plan: a car slowed
      // behind another at a hairpin apex was taken for a wreck, and a car 300 m back at full speed
      // dropped its attack and braked for it (Yas seed 2, phase D: Eriksen in Hughes's tow).
      const env = o.plans.envelope(o.st.s, o.st.delta);
      const racing = o.status === 'run' && o.offEvent < 0 && (o.st.v >= RACING_SHARE * env || (o.following >= 0 && o.st.v >= QUEUE_SHARE * env));
      out.push({ j: o.idx, gap, dd: o.d - me.d, d: o.d, v: o.st.v, racing, spinning: o.status === 'spin' || o.status === 'crash', aLong: o.st.aLong });
    }
    return out;
  }

  /** Decide this tick's controls for car i. */
  protected controls(i: number, near: Near[]) {
    const c = this.cars[i];
    if (this.opts.ai === 'traffic') {
      const ahead = c.st.s + (c.st.v * this.dt) / c.lanes.stretch(c.st.s, c.st.delta);
      const view = { st: c.st, d: c.d, model: c.model, plans: c.plans, lanes: c.lanes, dt: this.dt };
      const dec = trafficControls(view, near, avoidSlowCar(view, near, 0).delta, c.plans.envelope(ahead, c.st.delta));
      c.following = dec.following;
      return dec.ctl;
    }
    const ctx: CraftContext = { t: this.t, dt: this.dt, lanes: c.lanes, corners: this.corners, nextCorner: this.nextCorner, physics: this.physics, neutral: this.sc !== null, push: this.opts.session === 'qualifying' };
    const dec = raceCraft(this.views[i], near, this.views, ctx);
    c.following = dec.following;
    c.wake = dec.ctl.effects && (dec.ctl.effects.drag < 1 || dec.ctl.effects.grip < 1) ? 1 : -1;
    if (dec.choice) this.decisions.push({ t: this.t, car: i, ...dec.choice });
    if (dec.mistake) {
      const corner = this.corners[dec.mistake.corner]?.name ?? '';
      const k = dec.mistake.kind;
      c.cause = this.emit('mistake', [i], k === 'lockup' ? `${this.name(i)} locks up into ${corner}` : k === 'power' ? `${this.name(i)} gets loose on the power out of ${corner}` : `${this.name(i)} runs wide at ${corner}`);
    }
    return dec.ctl;
  }

  /** Race-craft views of the cars (same objects every tick; `d` refreshed before use). */
  private views: CraftCar[] = [];

  /**
   * Change the track grip level now (weather). Every car gets a model and lane plans for the new
   * grip (keeping its damage), so drivers re-plan their braking and corner speeds from here on.
   */
  setGrip(level: number, note?: string): void {
    this.physics = { ...this.physics, gripLevel: level };
    this.scPlans = null;
    this.gripLog.push({ t: this.t, level });
    for (const c of this.cars) {
      const { model, plans } = this.plansFor(c.entrant, c.damageLevel);
      c.model = model;
      c.plans = plans;
      const v = this.views[c.idx];
      if (v) { v.model = model; v.plans = plans; }
    }
    this.emit('grip', [], `${note ? note[0].toUpperCase() + note.slice(1) + ': ' : ''}track grip ${(level * 100).toFixed(0)}%`);
  }

  /**
   * Deploy the safety car for `laps` laps (racing resumes when the leader starts lap
   * leaderLap + laps). Ignored while one is already deployed or once the leader has finished.
   */
  deploySafetyCar(laps: number, why?: string, cause?: number, scripted = false): void {
    if (this.leaderFinished) return;
    if (this.sc) {
      // A scripted deployment always happens: a safety car already on track stays out for at
      // least that long, and one that has pulled in (no green yet) comes straight back out.
      if (!scripted) return;
      if (this.sc.phase === 'out') {
        this.sc.endLap = Math.max(this.sc.endLap, this.leaderLap + laps);
        this.emit('safety-car', [], `Safety car: ${why ? `${why} (stays out)` : 'stays out'}`, cause);
        return;
      }
      this.sc = null;
    }
    const lead = this.order().find((i) => !this.cars[i].dnf && !this.cars[i].finished);
    if (lead === undefined) return;
    const c = this.cars[lead];
    const dist = Math.max(c.st.dist, 0) + SAFETY_CAR.enterAhead;
    const event = this.emit('safety-car', [], `Safety car${why ? `: ${why}` : ''}`, cause);
    this.sc = { phase: 'out', dist, v: this.scSpeed(dist), endLap: this.leaderLap + laps, event };
  }

  /** Safety car target speed at race distance `dist`. */
  private scSpeed(dist: number): number {
    this.scPlans ??= lanePlansFor(this.lanes, STANDARD_CAR, 1, this.physics).plans;
    const L = this.track.length;
    return SAFETY_CAR.pace * this.scPlans.speed(((dist % L) + L) % L, 0);
  }

  /** Move the safety car one tick; pull it in on its last lap; green flag at the line. */
  private moveSafetyCar(): void {
    const sc = this.sc;
    if (!sc) return;
    const L = this.track.length;
    if (sc.phase === 'out') {
      const s = ((sc.dist % L) + L) % L;
      sc.v = this.scSpeed(sc.dist);
      sc.dist += (sc.v * this.dt) / this.lanes.stretch(s, 0);
      const lastLap = Math.min(sc.endLap - 1, this.laps);
      const s2 = ((sc.dist % L) + L) % L;
      if (this.leaderLap >= lastLap && s2 > L - SAFETY_CAR.pitIn) {
        sc.phase = 'in';
        this.emit('safety-car', [], sc.endLap > this.laps ? 'Safety car in: the race finishes under yellow' : 'Safety car in this lap');
      }
    } else if (this.leaderLap >= sc.endLap || this.leaderFinished) {
      const two = this.doubleFile();
      this.sc = null;
      this.columnsSet = false;
      if (two) for (const c of this.cars) {
        if (c.dnf || c.finished) continue;
        c.craft.lap1Done = false;
        c.craft.gridD = Number.isNaN(c.craft.column) ? c.d : c.craft.column;
        c.craft.column = NaN;
        c.craft.holdTo = c.st.dist + this.track.length;
      }
      if (!this.leaderFinished) this.emit('safety-car', [], two ? 'Green flag: racing resumes, two wide' : 'Green flag: racing resumes');
    }
  }

  /**
   * Speed limit for car c behind the safety car: close up to the queue gap behind the car (or
   * safety car) in front on the road, never braking harder than SAFETY_CAR.brake for it.
   */
  private queueSpeed(c: RaceCar): number {
    const SC = SAFETY_CAR;
    const L = this.track.length;
    const sc = this.sc!;
    let gap = Infinity, vAhead = 0, want = SC.gap;
    if (sc.phase === 'out') {
      gap = (((sc.dist - c.st.s) % L) + L) % L;
      vAhead = sc.v;
      want = SC.scGap;
    }
    // Only cars in the queue: running on the road. A stopped, crawling or off-road car is a
    // hazard to drive round (the avoidance rules), not a car to queue behind.
    const col = this.doubleFile() ? c.craft.column : NaN;
    if (!Number.isNaN(col)) {
      // Double file: queue behind the nearest car ahead in my column; the first car of the second
      // column lines up beside the leader of the queue.
      const q = this.queue();
      let o: RaceCar | null = null, g = Infinity;
      for (const x of q) {
        if (x === c || x.craft.column !== col) continue;
        const gx = (((x.st.s - c.st.s) % L) + L) % L;
        if (gx > 0 && gx < L / 2 && gx < g) { g = gx; o = x; }
      }
      if (o) { gap = g; vAhead = o.st.v; want = SC.gap; }
      else if (q[0] && q[0] !== c && q[0].craft.column !== col) {
        gap = (((q[0].st.s - c.st.s) % L) + L) % L; vAhead = q[0].st.v; want = 0.5;
      }
    } else for (const o of this.cars) {
      if (o === c || o.dnf || o.finished || o.status !== 'run' || o.offEvent >= 0 || o.st.v < 5) continue;
      const g = (((o.st.s - c.st.s) % L) + L) % L;
      if (g > 0 && g < gap) { gap = g; vAhead = o.st.v; want = SC.gap; }
    }
    const env = c.plans.envelope(c.st.s, c.st.delta);
    const catchUp = sc.phase === 'out' ? SC.catchUp * env : env;
    const v = gap >= want ? Math.sqrt(vAhead * vAhead + 2 * SC.brake * (gap - want)) : Math.max(0, vAhead + SC.close * (gap - want));
    return Math.min(catchUp, v);
  }

  /**
   * Restarts follow the start (phase D): after a rolling start the field forms up two wide on the
   * safety car's last lap and keeps its side to the first braking zone after the green, as at the
   * start; after a standing start it restarts single file (F1).
   */
  private doubleFile(): boolean {
    return this.rolling && !!this.sc && this.leaderLap >= this.sc.endLap - 1;
  }
  private queueCache: { tick: number; cars: RaceCar[] } = { tick: -1, cars: [] };
  /** Cars in the safety-car queue, in road order. */
  private queue(): RaceCar[] {
    if (this.queueCache.tick !== this.tick) {
      const cars = this.cars.filter((o) => !o.dnf && !o.finished && o.status === 'run' && o.offEvent < 0 && o.st.v >= 5);
      cars.sort((a, b) => b.st.dist - a.st.dist);
      this.queueCache = { tick: this.tick, cars };
    }
    return this.queueCache.cars;
  }
  /** Double file: give each car in the queue its column once, as the form-up lap starts (alternating in road order). */
  private formColumns(): void {
    if (!this.doubleFile() || this.columnsSet) return;
    this.columnsSet = true;
    this.queue().forEach((c, q) => { c.craft.column = (q % 2 === 0 ? 1 : -1) * RESTART_COLUMN * this.lanes.lim; });
  }
  private columnsSet = false;

  /** Fire the scripted events that are due (the leader has started their lap). */
  private scripted(): void {
    const evs = this.opts.events;
    if (!evs) return;
    const lap = this.leaderLap;
    while (this.nextScripted < evs.length && evs[this.nextScripted].lap <= lap) {
      const e = evs[this.nextScripted++];
      if (e.type === 'grip') this.setGrip(e.value, e.note);
      else if (e.type === 'spin') this.spin(e.car);
      else if (e.type === 'safety-car') this.deploySafetyCar(e.laps, e.note, undefined, true);
      else this.retire(e.car);
    }
  }

  step(): void {
    const dt = this.dt;
    useCarSize(this.size);
    this.scripted();
    if (this.views.length !== this.cars.length) {
      this.views = this.cars.map((x) => ({ idx: x.idx, st: x.st, d: x.d, model: x.model, plans: x.plans, driver: x.entrant.driver, craft: x.craft, rng: x.rng }));
    }
    for (const v of this.views) v.d = this.cars[v.idx].d;
    if (this.rolling && !this.green && this.cars.some((c) => c.st.dist >= 0)) {
      this.green = true;
      this.emit('start', [], 'Green flag: racing');
    }
    if (this.opts.session !== 'qualifying' && !this.rolling) {
      if (this.t <= this.lightsOut && this.t + dt > this.lightsOut) this.emit('start', [], 'Lights out');
      for (const c of this.cars) {
        if (c.startDelay < this.lightsOut && this.t <= c.startDelay && this.t + dt > c.startDelay) {
          this.emit('jump', [c.idx], `${this.name(c.idx)} jumps the start`);
        }
      }
    }
    this.formColumns();
    const ctls = this.cars.map((c, i): Controls => {
      if (this.t < c.startDelay || c.status === 'stopped' || c.status === 'out') return { vTarget: 0, deltaTarget: c.st.delta };
      if (c.status === 'spin' || c.status === 'crash') return { vTarget: 0, deltaTarget: c.st.delta, free: true };
      if (c.status === 'retiring') {
        // Losing power: slow down gently and pull over to the nearer edge of the road.
        const edge = (c.d >= 0 ? 1 : -1) * (this.lanes.lim - 0.3);
        return { vTarget: Math.max(0, c.st.v - 4 * this.dt), deltaTarget: edge - c.lanes.lineD(c.st.s) };
      }
      const ctl = this.controls(i, this.neighbours(i));
      if (this.sc && !c.finished) {
        ctl.vTarget = Math.min(ctl.vTarget, this.queueSpeed(c));
      }
      if (this.rolling && !this.green) ctl.vTarget = Math.min(ctl.vTarget, this.rollingSpeed());
      // Off the line: a poor launch (wheelspin, bog-down) gets only part of the drive.
      if (c.launch < 1 && this.t < c.startDelay + LAUNCH.time) {
        ctl.vTarget = Math.min(ctl.vTarget, c.st.v + c.launch * Math.max(0, c.model.maxDrive(c.st.v, 0)) * dt);
      }
      return ctl;
    });
    const prev = this.cars.map((c) => c.st.dist);
    const edgeWall = this.opts.incidents === false;
    // Squeezed over the edge by a car alongside counts as a touch for blaming an off on it,
    // even when the two never actually touch (the squeezed driver gave way). Not by a car at a
    // standstill: steering round a wreck onto the grass isn't being squeezed by it (it was logged
    // as contact with the wreck, from a car creeping by at walking pace).
    ctls.forEach((ctl, i) => {
      const j = ctl.squeezedBy ?? -1;
      if (j >= 0 && this.cars[j].st.v > 1) {
        const c = this.cars[i], L = this.track.length;
        let g = c.st.s - this.cars[j].st.s;
        if (g >= L / 2) g -= L; else if (g < -L / 2) g += L;
        c.lastTouchT = this.t;
        c.lastTouchWith = j;
        c.lastTouchLevel = g >= -ROOM_LEVEL;
      }
    });
    this.cars.forEach((c, i) => { if (c.status !== 'out') stepCar(c.st, ctls[i], c.model, c.lanes, dt, edgeWall); });
    this.moveSafetyCar();
    this.t += dt;
    this.tick++;
    for (const c of this.cars) c.d = c.lanes.dOf(c.st.s, c.st.delta);

    for (const hit of resolveCollisions(this.cars, this.lanes, edgeWall)) {
      const key = Math.min(hit.a, hit.b) * 1000 + Math.max(hit.a, hit.b);
      // Cars leaning on each other log one contact, not one per tick. But a hit with no contact on
      // record for the pair (the touches before it were too soft to log) is logged, so whatever
      // it causes has a cause.
      const last = this.pairEvent.get(key);
      const logged = last !== undefined && this.t - this.events[last].t <= INCIDENTS.causeWindow;
      if (hit.closing > 1 && ((this.contactCooldown.get(key) ?? -Infinity) < this.t - 2 || !logged)) {
        const ev = this.emit('contact', [hit.a, hit.b], `Contact: ${this.name(hit.a)} and ${this.name(hit.b)}`);
        this.pairEvent.set(key, ev);
        this.cars[hit.a].cause = this.cars[hit.b].cause = ev;
      }
      this.contactCooldown.set(key, this.t);
      const A = this.cars[hit.a], B = this.cars[hit.b];
      A.lastTouchT = B.lastTouchT = this.t;
      A.lastTouchWith = hit.b;
      B.lastTouchWith = hit.a;
      A.lastTouchLevel = B.lastTouchLevel = true;
      if (hit.closing > 1 && !edgeWall) this.contactIncidents(hit, this.pairEvent.get(key) ?? -1);
    }
    if (!edgeWall) this.incidents();
    this.cars.forEach((c, i) => this.timing(c, prev[i]));
    const order = this.log();
    this.detectPasses(order);
    if (this.tick % TRAIN_EVERY === 0) this.sampleTrains();
  }

  /** The corner nearest to s (by apex), for incident lines. */
  cornerName(s: number): string {
    if (!this.corners.length) return 'the track';
    const L = this.track.length, ds = this.track.ds;
    let best = this.corners[0], bd = Infinity;
    for (const c of this.corners) {
      let g = Math.abs(c.apex * ds - s);
      g = Math.min(g, L - g);
      if (g < bd) { bd = g; best = c; }
    }
    return best.name;
  }

  /** The car's most recent slide, mistake or contact event, if recent enough to blame. */
  private causeOf(c: RaceCar): number {
    return c.cause >= 0 && this.t - this.events[c.cause].t <= INCIDENTS.causeWindow ? c.cause : -1;
  }

  private canCrash(c: RaceCar): boolean {
    return !c.finished && (c.status === 'run' || c.status === 'spin' || c.status === 'stopped');
  }

  private startSpin(c: RaceCar, cause: number, where = 'at'): void {
    c.status = 'spin';
    c.vSpin = Math.max(c.st.v, 1);
    c.yawRate = (c.rng.next() < 0.5 ? -1 : 1) * (2.5 + 2.5 * c.rng.next());
    c.craft.mistake = null;
    c.craft.mode = 'line';
    this.emit('spin', [c.idx], `${this.name(c.idx)} spins ${where} ${this.cornerName(c.st.s)}`, cause);
  }

  private startCrash(c: RaceCar, cause: number): void {
    if (c.status !== 'spin') c.yawRate = (c.rng.next() < 0.5 ? -1 : 1) * (2 + 3 * c.rng.next());
    c.vSpin = Math.max(c.st.v, 1);
    c.status = 'crash';
    c.dnf = true;
    c.craft.mistake = null;
    this.emit('crash', [c.idx], `${this.name(c.idx)} crashes out at ${this.cornerName(c.st.s)}`, cause);
  }

  /**
   * Retire car i on the spot (a mechanical failure; Phase 6 scenarios and the checks use it): it
   * stops dead where it is and stays there as an obstacle, like a crashed car.
   */
  retire(i: number, stuck = false): void {
    const c = this.cars[i];
    if (c.dnf || c.finished) return;
    c.status = 'retiring';
    c.dnf = true;
    c.craft.mistake = null;
    c.craft.mode = 'line';
    const where = this.cornerName(c.st.s);
    this.emit('retire', [i], stuck ? `${this.name(i)} is stuck at ${where} and retires` : `${this.name(i)} retires at ${where}`,
      stuck && c.offEvent >= 0 ? c.offEvent : undefined);
  }

  /** Spin car i now (a scenario hook, e.g. oil on the track; the checks use it). */
  spin(i: number): void {
    const c = this.cars[i];
    if (c.status === 'run' && !c.finished) this.startSpin(c, -1);
  }

  /** A car's incident scale, times the race's incidentRate. */
  private scaleOf(c: RaceCar): number {
    return incidentScale(c.entrant.driver) * (this.opts.incidentRate ?? 1);
  }

  /** Lasting grip loss from an impact of `speed` m/s; the driver re-plans for the damaged car. */
  private addDamage(c: RaceCar, speed: number): void {
    const I = INCIDENTS;
    if (speed <= I.damageFrom) return;
    c.damage = Math.min(I.damageMax, c.damage + I.damagePer * (speed - I.damageFrom));
    const level = Math.floor(c.damage / I.damageStep + 1e-9) * I.damageStep;
    if (level <= c.damageLevel) return;
    c.damageLevel = level;
    this.damageLog.push({ t: this.t, car: c.idx, level });
    const { model, plans } = this.plansFor(c.entrant, level);
    c.model = model;
    c.plans = plans;
    const v = this.views[c.idx];
    if (v) { v.model = model; v.plans = plans; }
  }

  /** Spin and crash odds from a hit (closing speed, how off-centre), and damage. */
  private contactIncidents(hit: Contact, ev: number): void {
    const I = INCIDENTS;
    for (const k of [hit.a, hit.b]) {
      const c = this.cars[k];
      if (!this.canCrash(c)) continue;
      this.addDamage(c, hit.closing);
      const scale = this.scaleOf(c);
      const pCrash = Math.min(1, clamp01((hit.closing - I.contactCrash) / I.contactCrashSpan) * scale);
      const pSpin = Math.min(1, clamp01((hit.closing - I.contactSpin) / I.contactSpinSpan) * hit.angle * scale);
      const u = c.rng.next();
      if (u < pCrash) this.startCrash(c, ev);
      else if (c.status === 'run' && c.st.v > 5 && u < pCrash + pSpin) this.startSpin(c, ev);
    }
  }

  /** Per-tick incident physics: logged slides, spins, the barrier, offs and rejoins, stopping. */
  private incidents(): void {
    const I = INCIDENTS, dt = this.dt;
    for (const c of this.cars) {
      if (c.status === 'out') {
        if (!c.cleared && this.t - c.outSince > I.clearAfter) {
          c.cleared = true;
          this.emit('cleared', [c.idx], `Marshals clear ${this.name(c.idx)}'s car at ${this.cornerName(c.st.s)}`);
        }
        continue;
      }
      const i = c.idx;
      const excess = c.st.mu > 0 ? c.st.slide / c.st.mu : 0;
      if (c.st.slide > 0) c.lastSlideT = this.t;
      // Drift angle for the viewer: up to DRIFT.max where a spin becomes likely (square root, so
      // small slides show too), easing in and out. Pure display: nothing reads it back.
      if (c.status === 'run') {
        // Steering back onto the road from over the edge, the car's path bends back toward the
        // road, against the corner: the drift goes, quickly (it was drawn nose into the corner
        // while the car turned the other way, equal field seed 1 at T1).
        const returning = Math.abs(c.d) > this.lanes.lim - 0.2 && c.st.vDelta * Math.sign(c.d) < -0.5;
        const target = returning ? 0 : DRIFT.max * Math.sqrt(Math.min(1, excess / I.spinFrom)) * Math.sign(c.lanes.kappa(c.st.s, c.st.delta));
        c.drift += (target - c.drift) * Math.min(1, dt * (returning || Math.abs(target) > Math.abs(c.drift) ? DRIFT.rise : DRIFT.fall));
      } else c.drift = 0;
      if (c.status === 'run' && !c.finished) {
        if (excess > I.slideLog && this.t - c.lastSlideLog > 3) {
          c.lastSlideLog = this.t;
          c.cause = this.emit('slide', [i], `${this.name(i)} slides wide at ${this.cornerName(c.st.s)}`);
        }
        // A steadier, more careful driver holds a bigger slide before it goes (threshold) and
        // catches more of those that do (rate).
        const scale = this.scaleOf(c);
        const rate = I.spinRate * Math.max(0, excess - I.spinFrom / scale) * scale;
        // In the run-off, the off itself is to blame if nothing more recent is.
        if (rate > 0 && c.st.v > 10 && c.rng.next() < rate * dt) this.startSpin(c, this.causeOf(c) >= 0 || c.offEvent < 0 ? this.causeOf(c) : c.offEvent);
        // Power down on a kerb: near the limit of grip under throttle, the ridges can break the
        // rear loose. Odds by how much of the car is on it and how close to the limit it is.
        else if (c.status === 'run' && c.st.aLong > I.kerbSpinPower && c.st.v > 10 && c.st.usage > I.kerbSpinFrom) {
          const kerb = this.lanes.surface.kerbShare(c.st.s, c.d);
          // An aggressive throttle (style, phase D) spins on a kerb more often, a smooth one less.
          const sty = c.entrant.driver.style;
          const kRate = I.kerbSpinRate * kerb * ((c.st.usage - I.kerbSpinFrom) / (1 - I.kerbSpinFrom)) * scale * (sty ? 0.5 + sty.throttle : 1);
          if (kRate > 0 && c.rng.next() < kRate * dt) {
            c.cause = this.emit('slide', [i], `${this.name(i)} puts the power down on the kerb at ${this.cornerName(c.st.s)}`);
            this.startSpin(c, c.cause, 'on the kerb at');
          }
        }
      }
      if (c.st.wall > 0 && this.canCrash(c)) {
        const cause = c.offEvent >= 0 ? c.offEvent : this.causeOf(c);
        const p = Math.min(1, clamp01((c.st.wall - I.wallCrash) / I.wallCrashSpan) * this.scaleOf(c));
        this.addDamage(c, c.st.wall);
        if (c.rng.next() < p) this.startCrash(c, cause);
      }
      // Off and back on: off once the centre is past the edge, back on once the whole car is.
      // What put the wheels over the edge is what the off is blamed on.
      if (Math.abs(c.d) <= this.lanes.lim) c.edgeT = NaN;
      else if (Number.isNaN(c.edgeT)) c.edgeT = this.t;
      if (c.offEvent < 0 && isOffRoad(this.track, c.d)) {
        let cause = this.causeOf(c);
        const near = (t: number) => c.edgeT - t < 1;
        // A smaller slide than a logged moment, or a lean too gentle to log as contact, can still
        // carry a car off: log it now.
        if (cause < 0 && near(c.lastTouchT)) {
          const j = c.lastTouchWith;
          // Owed room (level beside the squeezer): the squeezer's fault. Not level: it had no
          // claim to the space and ran out of road (Monza T9, a car a length back on the inside).
          const level = c.lastTouchLevel;
          cause = c.cause = this.emit('contact', [i, j], level ? `Contact: ${this.name(j)} squeezes ${this.name(i)} wide` : `Contact: ${this.name(i)} runs out of room beside ${this.name(j)}`);
          this.events[cause].blame = level ? j : i;
        } else if (cause < 0 && near(c.lastSlideT)) cause = c.cause = this.emit('slide', [i], `${this.name(i)} slides wide at ${this.cornerName(c.st.s)}`);
        c.offEvent = this.emit('off', [i], `${this.name(i)} off at ${this.cornerName(c.st.s)}`, cause);
      } else if (c.offEvent >= 0 && c.status === 'run' && Math.abs(c.d) <= this.lanes.lim) {
        const where = this.events[c.offEvent].text.replace(/^.* off at /, '');
        const pos = this.order().indexOf(i) + 1;
        this.emit('rejoin', [i], `${this.name(i)} off at ${where}, rejoins P${pos}`, c.offEvent);
        c.offEvent = -1;
      }
      // Spinning or crashing: rotating, sliding to a stop.
      if (c.status === 'spin' || c.status === 'crash') {
        c.yaw = wrapAngle(c.yaw + c.yawRate * dt * Math.min(1, c.st.v / c.vSpin + 0.15));
        if (c.st.v < 0.3) {
          c.st.v = 0;
          c.st.vDelta = 0;
          if (c.status === 'crash') { c.status = 'out'; c.fixed = true; c.outSince = this.t; this.autoSafetyCar(c); }
          else { c.status = 'stopped'; c.restartAt = this.t + 1.5 + 1.5 * c.rng.next(); }
        }
      } else if (c.status === 'retiring' && c.st.v < 0.3) {
        c.st.v = 0;
        c.st.vDelta = 0;
        c.status = 'out';
        c.fixed = true;
        c.outSince = this.t;
        this.autoSafetyCar(c);
      } else if (c.status === 'run' && !c.finished && this.t > c.startDelay + 5) {
        // Beached: no way past (e.g. nose against a wreck at the barrier). Retire rather than
        // sit there for ever (the race could never finish).
        if (c.st.v > 0.5) c.stillSince = NaN;
        else if (Number.isNaN(c.stillSince)) c.stillSince = this.t;
        else if (this.t - c.stillSince > I.stuckAfter) this.retire(i, true);
      } else if (c.status === 'stopped') {
        // Turning the car round, then waiting for a gap in the traffic.
        const turn = 1.5 * dt;
        c.yaw = Math.abs(c.yaw) <= turn ? 0 : c.yaw - Math.sign(c.yaw) * turn;
        if (this.t >= c.restartAt && c.yaw === 0 && (this.clearBehind(c) || this.t > c.restartAt + 15)) c.status = 'run';
      }
    }
  }

  /**
   * Automatic safety car (option 'auto'): a car out of the race at rest on the road or touching
   * it (not deep in the run-off) brings it out.
   */
  private autoSafetyCar(c: RaceCar): void {
    if (this.opts.safetyCar !== 'auto' || Math.abs(c.d) > this.track.width / 2 + CAR_WIDTH) return;
    let why = -1;
    for (let k = this.events.length - 1; k >= 0; k--) {
      const e = this.events[k];
      if ((e.type === 'crash' || e.type === 'retire') && e.cars[0] === c.idx) { why = k; break; }
    }
    this.deploySafetyCar(SAFETY_CAR.autoLaps, `${this.name(c.idx)} stopped at ${this.cornerName(c.st.s)}`, why);
  }

  /** No running car arriving within ~3 s in the stopped car's part of the road. */
  private clearBehind(me: RaceCar): boolean {
    const L = this.track.length;
    for (const o of this.cars) {
      if (o === me || o.dnf || o.status !== 'run' || o.st.v < 5) continue;
      let gap = me.st.s - o.st.s;
      if (gap < 0) gap += L;
      if (gap > 0 && gap < 200 && gap / o.st.v < 3 && Math.abs(o.d - me.d) < 6) return false;
    }
    return true;
  }

  /**
   * A pass is a swap in race distance between two running cars on the same lap, with the passer
   * clear by a car length, that holds for 1.5 s (so side-by-side wobbles don't count). Lapping
   * isn't a pass.
   */
  private detectPasses(order: number[]): void {
    const L = this.track.length;
    const n = this.cars.length;
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const A = this.cars[a], B = this.cars[b];
        if (A.finished || B.finished || A.dnf || B.dnf || A.st.dist < 0 || B.st.dist < 0) continue;
        const diff = A.st.dist - B.st.dist;
        if (Math.abs(diff) > L / 2) continue;
        const key = a * 1000 + b;
        const rec = this.pairAhead.get(key);
        if (!rec) { this.pairAhead.set(key, { ahead: diff >= 0 ? a : b, since: this.t, confirmed: diff >= 0 ? a : b }); continue; }
        // Who is ahead only changes once a car is clear by a car length: nose swaps while
        // side by side aren't passes.
        if (Math.abs(diff) < HIT_LEN) continue;
        const ahead = diff >= 0 ? a : b;
        if (rec.ahead !== ahead) { rec.ahead = ahead; rec.since = this.t; }
        if (rec.ahead !== rec.confirmed && this.t - rec.since >= 1.5) {
          rec.confirmed = rec.ahead;
          const passer = rec.ahead, passed = passer === a ? b : a;
          const pos = order.indexOf(passer) + 1;
          const pc = this.cars[passer];
          const idx = Math.min(Math.floor(pc.st.s / this.track.ds), this.track.n - 1);
          const c = this.corners[this.nextCorner[idx]];
          const toC = c ? ((c.apex * this.track.ds - pc.st.s) % L + L) % L : Infinity;
          const where = !c ? '' : toC < 150 ? ` into ${c.name}` : toC > L - 150 ? ` at ${c.name}` : ' on the straight';
          const pd = this.cars[passed];
          // Still recovering from an off if it rejoined only just now (the pass is confirmed
          // 1.5 s after the swap, by which time a car crawling out of the gravel may be back on).
          const offRecently = pd.offEvent >= 0 || this.events.some((e) => e.type === 'rejoin' && e.cars[0] === passed && this.t - e.t < 5);
          // Likewise a car pulling away from a standstill after a spin.
          const spunRecently = pd.status !== 'run' || this.events.some((e) => e.type === 'spin' && e.cars[0] === passed && this.t - e.t < 10);
          const why = spunRecently ? ' after a spin' : offRecently ? ' after an off' : pd.craft.mistake ? ' after a mistake' : '';
          this.emit('pass', [passer, passed], `P${pos} ${this.name(passer)} passes ${this.name(passed)}${where}${why}`);
        }
      }
    }
  }

  private sampleTrains(): void {
    this.sampleTraffic();
    if (this.leaderLap < 2 || this.leaderFinished) return;
    const order = this.order();
    for (let p = 1; p < order.length; p++) {
      if (this.cars[order[p]].dnf) break;
      const g = this.gapTo(order[p], order[p - 1]);
      if (!Number.isFinite(g)) continue;
      this.trainSamples++;
      if (g < 1.0) this.trainHits++;
      const quicker = this.cars[order[p - 1]].plans.lapTime - this.cars[order[p]].plans.lapTime >= 0.3;
      if (quicker && g < 1.0) this.stuckTime += TRAIN_EVERY * this.dt;
    }
  }

  /** Class traffic: each running car's nearest car ahead on the road, if much slower and within 1 s. */
  private sampleTraffic(): void {
    const racing = (c: RaceCar) => !c.dnf && !c.finished && !c.cleared && c.status === 'run';
    for (const me of this.cars) {
      if (!racing(me) || me.st.v < 10) continue;
      let ahead: Near | null = null;
      for (const o of this.neighbours(me.idx)) if (o.gap > 0 && racing(this.cars[o.j]) && (!ahead || o.gap < ahead.gap)) ahead = o;
      if (!ahead || ahead.gap > me.st.v * 1.0) continue;
      const slow = this.cars[ahead.j].plans.lapTime;
      if (slow - me.plans.lapTime >= CLASS_GAP * slow) this.trafficTime += TRAIN_EVERY * this.dt;
    }
  }

  stats(): RaceStats {
    const count = (t: RaceEventType) => this.events.filter((e) => e.type === t).length;
    return {
      passes: count('pass'), mistakes: count('mistake'), contacts: count('contact'),
      offs: count('off'), spins: count('spin'), dnfs: this.cars.filter((c) => c.dnf).length,
      trainShare: this.trainSamples ? this.trainHits / this.trainSamples : 0,
      stuckTime: this.stuckTime,
      trafficTime: this.trafficTime,
    };
  }

  name(i: number): string {
    return this.cars[i].entrant.driver.name;
  }

  private timing(c: RaceCar, prevDist: number): void {
    if (c.dnf) return;
    const L = this.track.length;
    const dist = c.st.dist;
    const at = (x: number) => this.t - this.dt + (this.dt * (x - prevDist)) / (dist - prevDist || 1);
    // Checkpoints.
    for (let k = c.cp.length; CP_BASE + k * CP <= dist; k++) c.cp.push(at(CP_BASE + k * CP));
    // Line crossings (count each only once, even if a shunt pushes the car back over the line).
    const k = Math.floor(dist / L);
    if (dist >= 0 && k > c.crossings) {
      const tc = at(k * L);
      if (k >= 1 && !c.finished) {
        c.lapTimes.push(tc - c.lastCross);
        if (k >= this.laps || this.leaderFinished) {
          c.finished = true;
          c.finishTime = tc;
          c.finishLaps = k;
          if (this.opts.session === 'qualifying') this.emit('finish', [c.idx], `Chequered flag for ${c.entrant.driver.name}`);
          else if (!this.leaderFinished) this.emit('finish', [c.idx], `${c.entrant.driver.name} wins!`);
          else this.emit('finish', [c.idx], `${c.entrant.driver.name} finishes`);
          this.leaderFinished = true;
        }
      }
      c.crossings = k;
      c.lastCross = tc;
      c.crossTimes.push(tc);
    }
  }

  /** Classification key: finished cars by laps then finish time, running cars by distance. */
  order(): number[] {
    const L = this.track.length;
    const n = this.cars.length;
    const key = new Float64Array(n), ft = new Float64Array(n);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const c = this.cars[i];
      // Retired cars are classified behind every running car, by distance covered.
      key[i] = c.finished ? c.finishLaps * L : c.dnf ? c.st.dist - 1e9 : c.st.dist;
      ft[i] = c.finished ? c.finishTime : Infinity;
      idx.push(i);
    }
    // Finished cars before running cars at the same distance; then by finish time.
    return idx.sort((a, b) => key[b] - key[a] || ft[a] - ft[b] || a - b);
  }

  /** Race distance of checkpoint k (see `RaceCar.cp`). */
  cpDist(k: number): number {
    return CP_BASE + k * CP;
  }

  /** When car i reached race distance x (s), from its checkpoints; NaN if it hasn't yet. */
  timeAt(i: number, x: number): number {
    const cp = this.cars[i].cp;
    const u = (x - CP_BASE) / CP;
    const k = Math.floor(u);
    if (k >= 0 && k === u && k < cp.length) return cp[k];
    if (k < 0 || k + 1 >= cp.length) return NaN;
    return cp[k] + (cp[k + 1] - cp[k]) * (u - k);
  }

  /** Time gap (s) of car i behind car j at car i's current race distance. */
  gapTo(i: number, j: number): number {
    const a = this.cars[i], b = this.cars[j];
    const dist = a.finished ? a.finishLaps * this.track.length : a.st.dist;
    const tNow = a.finished ? a.finishTime : this.t;
    const u = (dist - CP_BASE) / CP;
    const k = Math.floor(u);
    if (k < 0 || k + 1 >= b.cp.length) return NaN;
    const tb = b.cp[k] + (b.cp[k + 1] - b.cp[k]) * (u - k);
    return tNow - tb;
  }

  private log(): number[] {
    const f = new Float32Array(this.cars.length * FRAME_STRIDE);
    this.cars.forEach((c, i) => {
      const k = i * FRAME_STRIDE;
      f[k] = c.st.s;
      f[k + 1] = c.d;
      f[k + 2] = c.st.v;
      f[k + 3] = c.status === 'run' ? c.drift : c.yaw;
      f[k + 4] = c.cleared ? STATUS.cleared : c.status === 'run' ? (c.offEvent >= 0 ? STATUS.off : STATUS.run) : STATUS[c.status];
    });
    this.frames.push(f);
    this.modeLog.push(Uint8Array.from(this.cars, (c) => MODE[c.craft.mode]));
    this.scLog.push(this.sc?.phase === 'out' ? ((this.sc.dist % this.track.length) + this.track.length) % this.track.length : NaN);
    const order = this.order();
    this.orders.push(Uint8Array.from(order));
    return order;
  }

  /** Run until everyone finishes (or the time limit). */
  run(maxTime = 3600): this {
    while (!this.finished && this.t < maxTime) this.step();
    return this;
  }
}

/**
 * The safety car. It enters `enterAhead` m in front of the leader and laps at `pace` × a standard
 * car's planned speed. Nobody attacks or defends; every car closes up to `gap` m behind the car
 * (or safety car) in front on the road, braking at no more than `brake` m/s² to get there, and
 * a car further back catches up at up to `catchUp` × its own braking envelope. On its last lap
 * the safety car pulls in `pitIn` m before the line ("in this lap"); passing stays off until the
 * leader crosses the line (green flag).
 */
export const SAFETY_CAR = {
  pace: 0.6,
  enterAhead: 150,
  gap: 14,
  scGap: 40,
  brake: 3,
  /** Below the queue gap, speed drops by this per metre short (1/s). */
  close: 0.4,
  catchUp: 0.85,
  pitIn: 400,
  autoLaps: 2,
};

export interface SafetyCarState {
  /** 'out': on track; 'in': pulled in, no passing until the leader starts lap `endLap`. */
  phase: 'out' | 'in';
  /** Race distance and speed of the safety car (while out). */
  dist: number;
  v: number;
  /** Leader's lap on which racing resumes (at the line). */
  endLap: number;
  /** The 'safety-car' event that deployed it. */
  event: number;
}

/** Sector ends for a lap of length L: the given cut points, or thirds. */
export function sectorEnds(L: number, sectors?: [number, number]): number[] {
  return sectors ? [sectors[0], sectors[1], L] : [L / 3, (2 * L) / 3, L];
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const wrapAngle = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
