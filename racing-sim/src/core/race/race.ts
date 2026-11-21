import { type Entrant } from '../agents/driver';
import { trafficControls, type Near } from '../agents/controller';
import { CarModel, type PhysicsParams } from '../physics/model';
import { makeRng, type Rng } from '../rng';
import type { Track } from '../track/track';
import { type CarState, newCarState, stepCar } from './car';
import { resolveCollisions } from './collide';
import { LanePlans, LaneSet } from './lanes';
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
}

export type RaceEventType = 'start' | 'contact' | 'pass' | 'mistake' | 'lap' | 'finish';

export interface RaceEvent {
  t: number;
  type: RaceEventType;
  cars: number[];
  /** Leader's lap when it happened. */
  lap: number;
  text: string;
}

export interface RaceCar {
  idx: number;
  entrant: Entrant;
  model: CarModel;
  plans: LanePlans;
  st: CarState;
  /** Lateral position (derived from st each tick, for neighbours and the log). */
  d: number;
  startDelay: number;
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
}

/** Checkpoint spacing for time gaps, and the race distance of checkpoint 0. */
const CP = 10;
const CP_BASE = -400;

/** Frame layout in the state log: per car [s, d, v]. */
export const FRAME_STRIDE = 3;

const planCache = new WeakMap<LaneSet, Map<string, LanePlans>>();

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
  t = 0;
  tick = 0;
  leaderFinished = false;
  private contactCooldown = new Map<number, number>();

  constructor(readonly opts: RaceOptions) {
    const { track, entrants } = opts;
    this.dt = opts.dt ?? DT;
    this.laps = opts.laps;
    this.lanes = opts.lanes ?? new LaneSet(track);
    this.rng = makeRng(opts.seed);
    let cache = planCache.get(this.lanes);
    if (!cache) planCache.set(this.lanes, (cache = new Map()));
    this.cars = entrants.map((e, idx) => {
      const model = new CarModel(e.car, opts.physics);
      const key = JSON.stringify([e.car, model.physics, e.driver.pace]);
      let plans = cache!.get(key);
      if (!plans) cache!.set(key, (plans = new LanePlans(this.lanes, model, { grip: e.driver.pace, drag: 1 })));
      // Staggered two-wide grid behind the line.
      const s0 = -5 - 7 * idx;
      const s = ((s0 % track.length) + track.length) % track.length;
      const d = (idx % 2 === 0 ? 1 : -1) * Math.min(3.2, this.lanes.lim - 1);
      const st = newCarState(s, d - this.lanes.lineD(s), 0, s0);
      const rng = this.rng.fork();
      return {
        idx, entrant: e, model, plans, st, d, rng,
        startDelay: 0.15 + 0.35 * rng.next(),
        crossings: -1, lapTimes: [], lastCross: NaN, finished: false, finishTime: NaN, finishLaps: 0, cp: [], following: -1,
      };
    });
    for (const c of this.cars) c.d = this.lanes.dAt(c.st.s, c.st.delta);
    this.log();
    this.emit('start', [], 'Lights out');
  }

  get track(): Track {
    return this.lanes.track;
  }

  get leaderLap(): number {
    return Math.max(0, ...this.cars.map((c) => c.crossings)) + 1;
  }

  get finished(): boolean {
    return this.cars.every((c) => c.finished);
  }

  emit(type: RaceEventType, cars: number[], text: string): void {
    this.events.push({ t: this.t, type, cars, lap: Math.min(this.laps, this.leaderLap), text });
  }

  /** Every other car relative to car i. */
  neighbours(i: number): Near[] {
    const L = this.track.length;
    const me = this.cars[i];
    const out: Near[] = [];
    for (const o of this.cars) {
      if (o === me) continue;
      let gap = o.st.s - me.st.s;
      if (gap >= L / 2) gap -= L;
      else if (gap < -L / 2) gap += L;
      if (gap > 300 || gap < -60) continue;
      out.push({ j: o.idx, gap, dd: o.d - me.d, d: o.d, v: o.st.v });
    }
    return out;
  }

  /** Decide this tick's controls for car i (Phase 4 replaces this with full race craft). */
  protected controls(i: number, near: Near[]) {
    const c = this.cars[i];
    const ahead = c.st.s + (c.st.v * this.dt) / this.lanes.stretch(c.st.s, c.st.delta);
    const vPlan = c.plans.speed(ahead, c.st.delta);
    const dec = trafficControls({ st: c.st, d: c.d, model: c.model, plans: c.plans, lanes: this.lanes, dt: this.dt }, near, 0, vPlan);
    c.following = dec.following;
    return dec.ctl;
  }

  step(): void {
    const dt = this.dt;
    const ctls = this.cars.map((c, i) => {
      if (this.t < c.startDelay) return { vTarget: 0, deltaTarget: c.st.delta };
      return this.controls(i, this.neighbours(i));
    });
    const prev = this.cars.map((c) => c.st.dist);
    this.cars.forEach((c, i) => stepCar(c.st, ctls[i], c.model, this.lanes, dt));
    this.t += dt;
    this.tick++;
    for (const c of this.cars) c.d = this.lanes.dAt(c.st.s, c.st.delta);

    for (const hit of resolveCollisions(this.cars, this.lanes)) {
      const key = Math.min(hit.a, hit.b) * 1000 + Math.max(hit.a, hit.b);
      if (hit.closing > 1 && (this.contactCooldown.get(key) ?? -Infinity) < this.t - 2) {
        this.emit('contact', [hit.a, hit.b], `Contact: ${this.name(hit.a)} and ${this.name(hit.b)}`);
      }
      this.contactCooldown.set(key, this.t);
    }
    this.cars.forEach((c, i) => this.timing(c, prev[i]));
    this.log();
  }

  name(i: number): string {
    return this.cars[i].entrant.driver.name;
  }

  private timing(c: RaceCar, prevDist: number): void {
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
          if (!this.leaderFinished) this.emit('finish', [c.idx], `${c.entrant.driver.name} wins!`);
          else this.emit('finish', [c.idx], `${c.entrant.driver.name} finishes`);
          this.leaderFinished = true;
        }
      }
      c.crossings = k;
      c.lastCross = tc;
    }
  }

  /** Classification key: finished cars by laps then finish time, running cars by distance. */
  order(): number[] {
    const L = this.track.length;
    const key = (c: RaceCar) => (c.finished ? c.finishLaps * L : c.st.dist);
    return this.cars
      .map((c) => c.idx)
      .sort((a, b) => {
        const A = this.cars[a], B = this.cars[b];
        const ka = key(A), kb = key(B);
        if (ka !== kb) return kb - ka;
        if (A.finished !== B.finished) return A.finished ? -1 : 1;
        return (A.finishTime || 0) - (B.finishTime || 0) || a - b;
      });
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

  private log(): void {
    const f = new Float32Array(this.cars.length * FRAME_STRIDE);
    this.cars.forEach((c, i) => {
      f[i * 3] = c.st.s;
      f[i * 3 + 1] = c.d;
      f[i * 3 + 2] = c.st.v;
    });
    this.frames.push(f);
    this.orders.push(Uint8Array.from(this.order()));
  }

  /** Run until everyone finishes (or the time limit). */
  run(maxTime = 3600): this {
    while (!this.finished && this.t < maxTime) this.step();
    return this;
  }
}
