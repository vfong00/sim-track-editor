import type { CarModel, Effects } from '../physics/model';
import { solveSpeedProfile, type SpeedProfile } from '../physics/profile';
import { pathFromOffsets, racingLine, type TrackPath } from '../track/line';
import type { Track } from '../track/track';

/** Car body: drawn size and the collision circle. */
export const CAR_LENGTH = 4.0;
export const CAR_WIDTH = 1.8;
export const CAR_RADIUS = 2.0;

/** Hard sideways limit for the car's centre so the body stays on the road. */
export const dHard = (track: Track) => track.width / 2 - CAR_WIDTH / 2;

/**
 * Lanes: copies of the racing line shifted sideways by `offset` metres (clamped to the road).
 * A car's lateral position is its offset δ from the racing line, and its curvature, path
 * stretch and planned speed come from interpolating the two lanes either side of δ. The
 * racing line itself is the lane with offset 0.
 */
export class LaneSet {
  readonly line: TrackPath;
  readonly offsets: number[];
  readonly paths: TrackPath[];
  readonly lim: number;
  readonly step = 1;

  constructor(readonly track: Track, line?: TrackPath) {
    this.line = line ?? racingLine(track);
    this.lim = dHard(track);
    const k = Math.ceil((2 * this.lim) / this.step);
    this.offsets = [];
    this.paths = [];
    for (let i = -k; i <= k; i++) {
      const off = i * this.step;
      this.offsets.push(off);
      if (off === 0) {
        this.paths.push(this.line);
        continue;
      }
      const d = new Float64Array(track.n);
      for (let j = 0; j < track.n; j++) d[j] = clamp(this.line.d[j] + off, -this.lim, this.lim);
      // Clamping leaves kinks where the shifted line meets the edge, which would read as tight
      // corners. Two passes of a moving average (an average of in-bounds values stays in bounds)
      // round them off.
      const half = Math.round(15 / track.ds);
      smoothPeriodic(d, half);
      smoothPeriodic(d, half);
      this.paths.push(pathFromOffsets(track, d));
    }
  }

  get zero(): number {
    return (this.offsets.length - 1) / 2;
  }

  /** Lane index (fractional) for an offset δ. */
  laneOf(delta: number): number {
    const u = delta / this.step + this.zero;
    return clamp(u, 0, this.offsets.length - 1);
  }

  /** Racing-line lateral position at s. */
  lineD(s: number): number {
    return interpNode(this.line.d, s / this.track.ds);
  }

  /** Lateral position for offset δ at s (clamped to the road, like the lanes). */
  dAt(s: number, delta: number): number {
    return clamp(this.lineD(s) + delta, -this.lim, this.lim);
  }

  /** Bilinear sample of per-lane node arrays (one per lane) at (s, δ). */
  sample(arrs: Float64Array[], s: number, delta: number): number {
    const u = s / this.track.ds;
    const l = this.laneOf(delta);
    const a = Math.floor(l), b = Math.min(a + 1, this.offsets.length - 1), t = l - a;
    const va = interpNode(arrs[a], u);
    return t === 0 ? va : va * (1 - t) + interpNode(arrs[b], u) * t;
  }

  /** Per-lane curvature arrays. */
  readonly kappas: Float64Array[] = [];

  /** Path length per metre of centerline (segment-constant, so stepping is exact on a lane). */
  stretch(s: number, delta: number): number {
    const i = segIndex(s, this.track);
    const l = this.laneOf(delta);
    const a = Math.floor(l), b = Math.min(a + 1, this.offsets.length - 1), t = l - a;
    const la = this.paths[a].segLen[i], lb = this.paths[b].segLen[i];
    return (la * (1 - t) + lb * t) / this.track.ds;
  }

  kappa(s: number, delta: number): number {
    if (this.kappas.length === 0) for (const p of this.paths) this.kappas.push(p.kappa);
    return this.sample(this.kappas, s, delta);
  }
}

/** Speed plans for one car (or car + driver) on every lane. */
export class LanePlans {
  readonly profiles: SpeedProfile[];
  private readonly speeds: Float64Array[];
  /** Braking envelopes (no forward pass): the speed a driver may carry at each point. */
  readonly envelopes: Float64Array[];
  constructor(readonly lanes: LaneSet, readonly model: CarModel, effects?: Effects) {
    this.profiles = lanes.paths.map((p) => solveSpeedProfile(p, model, { effects }));
    this.envelopes = lanes.paths.map((p) => solveSpeedProfile(p, model, { effects, forward: false }).v);
    this.speeds = this.profiles.map((p) => p.v);
  }
  /** Braking-envelope speed at (s, δ). */
  envelope(s: number, delta: number): number {
    return this.lanes.sample(this.envelopes, s, delta);
  }
  /** Planned speed at (s, δ). */
  speed(s: number, delta: number): number {
    return this.lanes.sample(this.speeds, s, delta);
  }
  get lapTime(): number {
    return this.profiles[this.lanes.zero].lapTime;
  }
}

/** In-place periodic moving average over ±half samples. */
function smoothPeriodic(a: Float64Array, half: number): void {
  const n = a.length;
  const src = Float64Array.from(a);
  let sum = 0;
  for (let k = -half; k <= half; k++) sum += src[(k + n) % n];
  const w = 2 * half + 1;
  for (let i = 0; i < n; i++) {
    a[i] = sum / w;
    sum += src[(i + half + 1) % n] - src[(i - half + n) % n];
  }
}

export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

export function segIndex(s: number, track: Track): number {
  const u = (((s % track.length) + track.length) % track.length) / track.ds;
  return Math.min(Math.floor(u), track.n - 1);
}

function interpNode(arr: Float64Array, u: number): number {
  const n = arr.length;
  u = ((u % n) + n) % n;
  const i = Math.min(Math.floor(u), n - 1);
  const t = u - i;
  return arr[i] * (1 - t) + arr[(i + 1) % n] * t;
}
