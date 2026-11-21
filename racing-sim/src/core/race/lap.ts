import type { CarModel } from '../physics/model';
import { newCarState, stepCar } from './car';
import type { LanePlans, LaneSet } from './lanes';

export const DT = 1 / 60;

export interface LapSample {
  t: number;
  s: number;
  v: number;
  usage: number;
}

export interface LapResult {
  lapTime: number;
  trace: LapSample[];
  /** Peak friction-circle usage (1 = exactly at the limit). */
  maxUsage: number;
}

/**
 * One flying lap with the time-stepped car on the racing line, using the same model and plan
 * as the solver. Starts at s = 0 at the planned speed; the lap time is interpolated to the
 * exact tick fraction where the car crosses the line again.
 */
export function simulateLap(lanes: LaneSet, plans: LanePlans, model: CarModel, dt = DT): LapResult {
  const L = lanes.track.length;
  const st = newCarState(0, 0, plans.speed(0, 0), 0);
  const trace: LapSample[] = [{ t: 0, s: 0, v: st.v, usage: 0 }];
  let t = 0, maxUsage = 0;
  while (t < 3600) {
    const prev = st.dist;
    const ahead = st.s + (st.v * dt) / lanes.stretch(st.s, 0);
    stepCar(st, { vTarget: plans.speed(ahead, 0), deltaTarget: 0 }, model, lanes, dt);
    t += dt;
    maxUsage = Math.max(maxUsage, st.usage);
    if (st.dist >= L) {
      const lapTime = t - dt + (dt * (L - prev)) / (st.dist - prev);
      return { lapTime, trace, maxUsage };
    }
    trace.push({ t, s: st.dist, v: st.v, usage: st.usage });
  }
  throw new Error('lap did not finish');
}

export interface SoloFrame {
  t: number;
  s: number;
  d: number;
  v: number;
}

/**
 * Endless laps for one car on the racing line, logging a frame per tick. Viewers read
 * `frames` (and `laps`); they never touch the car state (rule 4).
 */
export class SoloRun {
  readonly frames: SoloFrame[] = [];
  readonly laps: number[] = [];
  private st;
  private t = 0;
  private lapStart = 0;

  constructor(readonly lanes: LaneSet, readonly plans: LanePlans, readonly model: CarModel, readonly dt = DT) {
    this.st = newCarState(0, 0, plans.speed(0, 0), 0);
    this.frames.push(this.frame());
  }

  private frame(): SoloFrame {
    return { t: this.t, s: this.st.s, d: this.lanes.dAt(this.st.s, this.st.delta), v: this.st.v };
  }

  step(): void {
    const { st, lanes, dt } = this;
    const L = lanes.track.length;
    const prev = st.dist;
    const ahead = st.s + (st.v * dt) / lanes.stretch(st.s, 0);
    stepCar(st, { vTarget: this.plans.speed(ahead, 0), deltaTarget: 0 }, this.model, lanes, dt);
    this.t += dt;
    const lapsDone = Math.floor(st.dist / L);
    if (lapsDone > this.laps.length) {
      const cross = this.t - dt + (dt * (lapsDone * L - prev)) / (st.dist - prev);
      this.laps.push(cross - this.lapStart);
      this.lapStart = cross;
    }
    this.frames.push(this.frame());
  }

  /** Time into the current lap. */
  get lapTime(): number {
    return this.t - this.lapStart;
  }
  get time(): number {
    return this.t;
  }
}
