import { type CarModel, type Effects, NO_EFFECTS } from './model';

/** Anything the speed solver can run on: node curvatures and the lengths between nodes. */
export interface PathLike {
  n: number;
  /** segLen[i] = distance from node i to node i+1 (closed: node n-1 → node 0). */
  segLen: Float64Array;
  kappa: Float64Array;
  closed: boolean;
}

export interface SpeedProfile {
  /** Speed at each node, m/s. */
  v: Float64Array;
  /** Time from node 0 to each node (length n + 1 for closed paths: t[n] = lap time). */
  t: Float64Array;
  /** Closed: flying-lap time. Open: time from first to last node. */
  lapTime: number;
}

export interface ProfileOptions {
  effects?: Effects;
  /** Open paths: speed at the first node (default 0). */
  v0?: number;
  /** Open paths: speed cap at the last node (default: unconstrained). */
  vEnd?: number;
  /** Extra per-node speed caps (e.g. a driver's own limits). */
  cap?: Float64Array;
}

/**
 * Forward–backward speed solver. Start from each node's corner speed, then
 *   forward:  v[i+1]² ≤ v[i]² + 2·maxDrive(v[i], v[i]²κ[i])·L[i]
 *   backward: v[i]²   ≤ v[i+1]² + 2·maxBrake(v[i], v[i]²κ[i])·L[i]
 * Both use the car's state at the start of the segment, exactly what the time-stepped car
 * sees when it gets there. Closed paths wrap around (two rounds, so the seam is settled).
 */
export function solveSpeedProfile(path: PathLike, model: CarModel, opts: ProfileOptions = {}): SpeedProfile {
  const { n, segLen: L, kappa: k, closed } = path;
  const f = opts.effects ?? NO_EFFECTS;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = Math.min(model.cornerSpeed(k[i], f), opts.cap ? opts.cap[i] : Infinity);

  const forward = (i: number, j: number) => {
    const a = model.maxDrive(v[i], v[i] * v[i] * Math.abs(k[i]), f);
    const lim = v[i] * v[i] + 2 * a * L[i];
    const vj = lim > 0 ? Math.sqrt(lim) : 0;
    if (vj < v[j]) v[j] = vj;
  };
  const backward = (i: number, j: number) => {
    // Brake capacity depends on v[i] itself (drag, cornering load): two fixed-point rounds.
    let est = Math.min(v[i], v[j]);
    let vi = v[i];
    for (let it = 0; it < 3; it++) {
      const b = model.maxBrake(est, est * est * Math.abs(k[i]), f);
      vi = Math.sqrt(v[j] * v[j] + 2 * b * L[i]);
      est = Math.min(v[i], vi);
    }
    if (vi < v[i]) v[i] = vi;
  };

  if (closed) {
    let i0 = 0;
    for (let i = 1; i < n; i++) if (v[i] < v[i0]) i0 = i;
    for (let round = 0; round < 2; round++) {
      for (let s = 0; s < n; s++) {
        const i = (i0 + s) % n;
        forward(i, (i + 1) % n);
      }
      for (let s = 0; s < n; s++) {
        const j = (i0 - s + n) % n;
        backward((j - 1 + n) % n, j);
      }
    }
  } else {
    v[0] = Math.min(v[0], opts.v0 ?? 0);
    if (opts.vEnd !== undefined) v[n - 1] = Math.min(v[n - 1], opts.vEnd);
    for (let i = 0; i < n - 1; i++) forward(i, i + 1);
    for (let i = n - 2; i >= 0; i--) backward(i, i + 1);
  }

  const segs = closed ? n : n - 1;
  const t = new Float64Array(segs + 1);
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const vm = (v[i] + v[j]) / 2;
    t[i + 1] = t[i] + (vm > 0 ? L[i] / vm : Infinity);
  }
  return { v, t, lapTime: t[segs] };
}

/** Linear interpolation of a node array at fractional node position u (wraps if closed). */
export function sampleAt(arr: Float64Array, u: number, closed = true): number {
  const n = arr.length;
  if (closed) u = ((u % n) + n) % n;
  else u = Math.max(0, Math.min(n - 1, u));
  const i = Math.min(Math.floor(u), n - 1);
  const t = u - i;
  const j = closed ? (i + 1) % n : Math.min(i + 1, n - 1);
  return arr[i] * (1 - t) + arr[j] * t;
}
