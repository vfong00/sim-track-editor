import { FRAME_STRIDE, lanePlansFor, type LanePlans, MODE, type Race, STATUS } from '../core';

/**
 * The race as it stood at viewer time `t`, read only from the logs (rule 4). The race itself
 * may have been computed further ahead (the timeline computes ahead, and the viewer can rewind),
 * so nothing here reads a car's live state.
 */
export class RaceAt {
  readonly k: number;
  constructor(readonly r: Race, readonly t: number) {
    this.k = Math.max(0, Math.min(r.frames.length - 1, Math.floor(t / r.dt + 1e-6)));
  }

  /** Line crossings so far (0 = crossed the start line; -1 = still behind it). */
  crossings(i: number): number {
    const ct = this.r.cars[i].crossTimes;
    let n = 0;
    while (n < ct.length && ct[n] <= this.t) n++;
    return n - 1;
  }

  lapTimes(i: number): number[] {
    const ct = this.r.cars[i].crossTimes;
    const out: number[] = [];
    for (let n = 1; n < ct.length && ct[n] <= this.t; n++) out.push(ct[n] - ct[n - 1]);
    return out;
  }

  lastCross(i: number): number {
    const n = this.crossings(i);
    return n >= 0 ? this.r.cars[i].crossTimes[n] : NaN;
  }

  finished(i: number): boolean {
    const c = this.r.cars[i];
    return c.finished && c.finishTime <= this.t;
  }

  status(i: number): number {
    return this.r.frames[this.k][i * FRAME_STRIDE + 4];
  }

  /** Out of the race (crashed, retiring or retired). */
  out(i: number): boolean {
    return this.status(i) >= STATUS.crash;
  }

  mode(i: number): 'line' | 'attack' | 'defend' {
    const m = this.r.modeLog[this.k]?.[i] ?? 0;
    return m === MODE.attack ? 'attack' : m === MODE.defend ? 'defend' : 'line';
  }

  get leaderFinished(): boolean {
    return this.r.cars.some((_, i) => this.finished(i));
  }

  get leaderLap(): number {
    return Math.min(this.r.laps, Math.max(0, ...this.r.cars.map((_, i) => this.crossings(i))) + 1);
  }

  get gripLevel(): number {
    let g = this.r.gripLog[0]?.level ?? 1;
    for (const e of this.r.gripLog) if (e.t <= this.t) g = e.level;
    return g;
  }

  damage(i: number): number {
    let d = 0;
    for (const e of this.r.damageLog) if (e.car === i && e.t <= this.t) d = e.level;
    return d;
  }

  /** The lane plans the driver was using at this time (grip and damage then). */
  plans(i: number): LanePlans {
    const e = this.r.cars[i].entrant;
    const dmg = this.damage(i);
    const spec = dmg > 0 ? { ...e.car, grip: e.car.grip * (1 - dmg) } : e.car;
    return lanePlansFor(this.r.lanes, spec, e.driver.pace, { ...this.r.physics, gripLevel: this.gripLevel }).plans;
  }

  /** Checkpoints car i had passed by now (index of the last one, -1 = none). */
  private lastCp(i: number, until = this.t): number {
    const cp = this.r.cars[i].cp;
    let lo = -1, hi = cp.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (cp[m] <= until) lo = m;
      else hi = m - 1;
    }
    return lo;
  }

  /** Race distance covered (to the last checkpoint passed). */
  dist(i: number): number {
    return this.r.cpDist(this.lastCp(i));
  }

  /**
   * Time gap of car i behind car j: when both had passed the checkpoint car i passed last.
   * Two finished cars on the same lap: the difference of their finish times.
   */
  gap(i: number, j: number): number {
    const a = this.r.cars[i], b = this.r.cars[j];
    if (this.finished(i) && this.finished(j) && a.finishLaps === b.finishLaps) return a.finishTime - b.finishTime;
    const until = this.finished(i) ? a.finishTime : this.t;
    const k = this.lastCp(i, until);
    if (k < 0 || k >= b.cp.length || b.cp[k] > this.t) return NaN;
    return a.cp[k] - b.cp[k];
  }
}
