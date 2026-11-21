import { type Entrant } from '../agents/driver';
import { trafficControls, type Near } from '../agents/controller';
import { type Craft, type CraftCar, newCraft, raceCraft, type CraftContext } from '../agents/racecraft';
import { CarModel, DEFAULT_PHYSICS, type PhysicsParams } from '../physics/model';
import { type Corner, findCorners, nextCornerTable } from '../track/corners';
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
  /** 'race' (default): full Phase 4 race craft. 'traffic': Phase 3 queueing rules only. */
  ai?: 'race' | 'traffic';
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
  craft: Craft;
  /** Who gave this car a tow / dirty air this tick (-1 = clean air). */
  wake: number;
}

export interface RaceStats {
  passes: number;
  mistakes: number;
  contacts: number;
  /** Share of sampled (car, time) points where a car ran within 1.0 s of the car ahead (after lap 1). */
  trainShare: number;
  /**
   * Car-seconds (after lap 1) a quicker car (clean-air lap ≥ 0.3 s faster) spent stuck within
   * 1.0 s behind a slower one. Dirty air raises this; passing lowers it.
   */
  stuckTime: number;
}

/** Ticks between train samples. */
const TRAIN_EVERY = 30;

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
  readonly corners: Corner[];
  readonly nextCorner: Int32Array;
  readonly physics: PhysicsParams;
  t = 0;
  tick = 0;
  leaderFinished = false;
  private contactCooldown = new Map<number, number>();
  /** Pair key → which car was ahead, and since when a swap has held (pass confirmation). */
  private pairAhead = new Map<number, { ahead: number; since: number; confirmed: number }>();
  private trainSamples = 0;
  private trainHits = 0;
  private stuckTime = 0;

  constructor(readonly opts: RaceOptions) {
    const { track, entrants } = opts;
    this.dt = opts.dt ?? DT;
    this.laps = opts.laps;
    this.lanes = opts.lanes ?? new LaneSet(track);
    this.rng = makeRng(opts.seed);
    this.physics = { ...DEFAULT_PHYSICS, ...opts.physics };
    this.corners = findCorners(this.lanes.line);
    this.nextCorner = nextCornerTable(track.n, this.corners);
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
        craft: newCraft(), wake: -1,
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

  /** Decide this tick's controls for car i. */
  protected controls(i: number, near: Near[]) {
    const c = this.cars[i];
    if (this.opts.ai === 'traffic') {
      const ahead = c.st.s + (c.st.v * this.dt) / this.lanes.stretch(c.st.s, c.st.delta);
      const dec = trafficControls({ st: c.st, d: c.d, model: c.model, plans: c.plans, lanes: this.lanes, dt: this.dt }, near, 0, c.plans.envelope(ahead, c.st.delta));
      c.following = dec.following;
      return dec.ctl;
    }
    const ctx: CraftContext = { t: this.t, dt: this.dt, lanes: this.lanes, corners: this.corners, nextCorner: this.nextCorner, physics: this.physics };
    const dec = raceCraft(this.views[i], near, this.views, ctx);
    c.following = dec.following;
    c.wake = dec.ctl.effects && (dec.ctl.effects.drag < 1 || dec.ctl.effects.grip < 1) ? 1 : -1;
    if (dec.mistake) {
      const corner = this.corners[dec.mistake.corner]?.name ?? '';
      this.emit('mistake', [i], dec.mistake.kind === 'lockup' ? `${this.name(i)} locks up into ${corner}` : `${this.name(i)} runs wide at ${corner}`);
    }
    return dec.ctl;
  }

  /** Race-craft views of the cars (same objects every tick; `d` refreshed before use). */
  private views: CraftCar[] = [];

  step(): void {
    const dt = this.dt;
    if (this.views.length !== this.cars.length) {
      this.views = this.cars.map((x) => ({ idx: x.idx, st: x.st, d: x.d, model: x.model, plans: x.plans, driver: x.entrant.driver, craft: x.craft, rng: x.rng }));
    }
    for (const v of this.views) v.d = this.cars[v.idx].d;
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
    const order = this.log();
    this.detectPasses(order);
    if (this.tick % TRAIN_EVERY === 0) this.sampleTrains();
  }

  /**
   * A pass is a swap in race distance between two running cars on the same lap that holds for
   * 1.5 s (so side-by-side wobbles don't count twice). Lapping isn't a pass.
   */
  private detectPasses(order: number[]): void {
    const L = this.track.length;
    const n = this.cars.length;
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const A = this.cars[a], B = this.cars[b];
        if (A.finished || B.finished || A.st.dist < 0 || B.st.dist < 0) continue;
        const diff = A.st.dist - B.st.dist;
        if (Math.abs(diff) > L / 2) continue;
        const key = a * 1000 + b;
        const ahead = diff >= 0 ? a : b;
        const rec = this.pairAhead.get(key);
        if (!rec) { this.pairAhead.set(key, { ahead, since: this.t, confirmed: ahead }); continue; }
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
          const why = this.cars[passed].craft.mistake ? ' after a mistake' : '';
          this.emit('pass', [passer, passed], `P${pos} ${this.name(passer)} passes ${this.name(passed)}${where}${why}`);
        }
      }
    }
  }

  private sampleTrains(): void {
    if (this.leaderLap < 2 || this.leaderFinished) return;
    const order = this.order();
    for (let p = 1; p < order.length; p++) {
      const g = this.gapTo(order[p], order[p - 1]);
      if (!Number.isFinite(g)) continue;
      this.trainSamples++;
      if (g < 1.0) this.trainHits++;
      const quicker = this.cars[order[p - 1]].plans.lapTime - this.cars[order[p]].plans.lapTime >= 0.3;
      if (quicker && g < 1.0) this.stuckTime += TRAIN_EVERY * this.dt;
    }
  }

  stats(): RaceStats {
    const count = (t: RaceEventType) => this.events.filter((e) => e.type === t).length;
    return {
      passes: count('pass'), mistakes: count('mistake'), contacts: count('contact'),
      trainShare: this.trainSamples ? this.trainHits / this.trainSamples : 0,
      stuckTime: this.stuckTime,
    };
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
    const n = this.cars.length;
    const key = new Float64Array(n), ft = new Float64Array(n);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const c = this.cars[i];
      key[i] = c.finished ? c.finishLaps * L : c.st.dist;
      ft[i] = c.finished ? c.finishTime : Infinity;
      idx.push(i);
    }
    // Finished cars before running cars at the same distance; then by finish time.
    return idx.sort((a, b) => key[b] - key[a] || ft[a] - ft[b] || a - b);
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
      f[i * 3] = c.st.s;
      f[i * 3 + 1] = c.d;
      f[i * 3 + 2] = c.st.v;
    });
    this.frames.push(f);
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
