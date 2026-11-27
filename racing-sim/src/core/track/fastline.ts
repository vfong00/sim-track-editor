import { hypot } from '../fmath';
import type { CarModel } from '../physics/model';
import { solveSpeedProfile, type SpeedProfile } from '../physics/profile';
import { pathFromOffsets, racingLine, type TrackPath } from './line';
import type { Surface } from './surface';
import { mengerCurvature, type Track } from './track';

/**
 * The fastest line for a car (phase D). The old racing line (`racingLine`) iterates a smoothing
 * stencil that never converges at the fine scale, so it got slower the more road it was given
 * (GT3 at Laguna: 85.5 s with 3 m kept from the edge, 86.7 s with 1.5 m), and the kerbs couldn't
 * add width. Here:
 *  1. `bendLine`: the line with the least bending, Σ |P(i−1) − 2P(i) + P(i+1)|², solved exactly
 *     within the road (a banded least-squares solve with an active set for the edges).
 *  2. `refineLine`: lap-time descent for one car from a start line: move the line by smooth bumps
 *     every BUMP_EVERY m, each bump's effect on lap time worked out on a window of the lap.
 * `fastLine` runs 2 from both the old line and 1 and keeps the quicker. Each car class gets its
 * own line (and later each driving style), because the fastest line depends on the car.
 *
 * Only + − × ÷, sqrt and fmath here (determinism: Node and the browser must get the same line).
 */

/** Bounds for the car's centre at each node, and how the line is judged. */
export interface LineBounds {
  lo: Float64Array;
  hi: Float64Array;
}

export const BUMP_EVERY = 10;
export const BUMP_HALF = 15;
const WINDOW = 350;
const EPS = 0.05;

/** Bounds within ±lim at every node. */
export function evenBounds(track: Track, lim: number): LineBounds {
  return { lo: new Float64Array(track.n).fill(-lim), hi: new Float64Array(track.n).fill(lim) };
}

/**
 * The least-bending line within the bounds: minimises Σ |P(i−1) − 2P(i) + P(i+1)|² over the
 * offsets (exactly quadratic in them). Solved on the lap cut open at its straightest node, where
 * the line is held at `seamD`; an active set handles the edges.
 */
export function bendLine(track: Track, b: LineBounds, seamD: Float64Array): Float64Array {
  const n = track.n;
  let seam = 0;
  for (let i = 0; i < n; i++) if (Math.abs(track.curvature[i]) < Math.abs(track.curvature[seam])) seam = i;
  const node = (k: number) => (seam + k) % n;
  const BW = 2;
  const W = BW + 1;
  const H = new Float64Array(n * W);
  const g = new Float64Array(n);
  const hAt = (k: number, j: number) => (j > k ? H[j * W + (j - k)] : k - j <= BW ? H[k * W + (k - j)] : 0);
  for (let i = 1; i < n - 1; i++) {
    const js = [i - 1, i, i + 1], cs = [1, -2, 1];
    const a = node(i - 1), c = node(i), e = node(i + 1);
    const ax = track.xs[a] - 2 * track.xs[c] + track.xs[e];
    const ay = track.ys[a] - 2 * track.ys[c] + track.ys[e];
    for (let p = 0; p < 3; p++) {
      const jp = js[p], np = node(jp), vx = cs[p] * track.nx[np], vy = cs[p] * track.ny[np];
      g[jp] += ax * vx + ay * vy;
      for (let q = 0; q <= p; q++) {
        const jq = js[q], nq = node(jq);
        H[jp * W + (jp - jq)] += vx * cs[q] * track.nx[nq] + vy * cs[q] * track.ny[nq];
      }
    }
  }
  const lo = (k: number) => b.lo[node(k)], hi = (k: number) => b.hi[node(k)];
  // The seam (the first and last two nodes) is held where the start line has it.
  const held = new Float64Array(n).fill(NaN);
  for (let k = 0; k < 2; k++) { held[k] = seamD[node(k)]; held[n - 1 - k] = seamD[node(n - 1 - k)]; }
  const at = new Int8Array(n); // −1 on the lower bound, +1 on the upper
  let d = new Float64Array(n);
  for (let iter = 0; iter < 80; iter++) {
    const val = new Float64Array(n), free = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      if (!Number.isNaN(held[k])) val[k] = held[k];
      else if (at[k] < 0) val[k] = lo(k);
      else if (at[k] > 0) val[k] = hi(k);
      else free[k] = 1;
    }
    // Banded LDLᵀ of the free block (held and bound rows become identity rows).
    const M = new Float64Array(n * W), rhs = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      if (!free[k]) { M[k * W] = 1; rhs[k] = val[k]; continue; }
      let r = -g[k];
      for (let j = Math.max(0, k - BW); j <= Math.min(n - 1, k + BW); j++) {
        const hv = hAt(k, j);
        if (free[j]) { if (j <= k) M[k * W + (k - j)] = hv; } else r -= hv * val[j];
      }
      rhs[k] = r;
    }
    for (let k = 0; k < n; k++) {
      for (let j = Math.max(0, k - BW); j < k; j++) {
        let s = M[k * W + (k - j)];
        for (let m = Math.max(0, k - BW); m < j; m++) if (j - m <= BW) s -= M[k * W + (k - m)] * M[j * W + (j - m)] * M[m * W];
        M[k * W + (k - j)] = s / M[j * W];
      }
      let dk = M[k * W];
      for (let m = Math.max(0, k - BW); m < k; m++) dk -= M[k * W + (k - m)] * M[k * W + (k - m)] * M[m * W];
      M[k * W] = dk;
    }
    const y = rhs;
    for (let k = 0; k < n; k++) for (let m = Math.max(0, k - BW); m < k; m++) y[k] -= M[k * W + (k - m)] * y[m];
    for (let k = 0; k < n; k++) y[k] /= M[k * W];
    for (let k = n - 1; k >= 0; k--) for (let m = k + 1; m <= Math.min(n - 1, k + BW); m++) y[k] -= M[m * W + (m - k)] * y[m];
    d = y;
    let changed = false;
    for (let k = 0; k < n; k++) {
      if (!Number.isNaN(held[k])) continue;
      if (!at[k]) {
        if (d[k] < lo(k) - 1e-9) { at[k] = -1; changed = true; } else if (d[k] > hi(k) + 1e-9) { at[k] = 1; changed = true; }
      } else {
        let grad = g[k];
        for (let j = Math.max(0, k - BW); j <= Math.min(n - 1, k + BW); j++) grad += hAt(k, j) * d[j];
        if ((at[k] < 0 && grad < -1e-9) || (at[k] > 0 && grad > 1e-9)) { at[k] = 0; changed = true; }
      }
    }
    if (!changed) break;
  }
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) out[node(k)] = Math.max(lo(k), Math.min(hi(k), d[k]));
  return out;
}

/** How a line is timed: the car, the braking share drivers plan with, and the surface under it. */
export interface LineJudge {
  model: CarModel;
  brakeUse: number;
  surface?: Surface;
}

function gripAlong(track: Track, d: Float64Array, surface: Surface | undefined, from = 0, count = track.n): Float64Array | undefined {
  if (!surface) return undefined;
  const g = new Float64Array(count);
  for (let j = 0; j < count; j++) {
    const i = (((from + j) % track.n) + track.n) % track.n;
    g[j] = surface.nodeGrip(i, d[i]);
  }
  return g;
}

/** Lap time of a line for a judge (the braking envelope's flying lap, as drivers aim at it). */
export function lineLap(track: Track, d: Float64Array, judge: LineJudge): SpeedProfile {
  return solveSpeedProfile(pathFromOffsets(track, d), judge.model, { brakeUse: judge.brakeUse, grip: gripAlong(track, d, judge.surface) });
}

/** Lap-time descent from `d0` within the bounds (see the file note). Returns the quickest line found. */
export function refineLine(track: Track, d0: Float64Array, b: LineBounds, judge: LineJudge, iters = 60): { d: Float64Array; lapTime: number } {
  const n = track.n, ds = track.ds;
  const hk = Math.max(1, Math.round(3 / ds));
  const SP = Math.max(1, Math.round(BUMP_EVERY / ds)), HW = Math.max(1, Math.round(BUMP_HALF / ds));
  const WIN = Math.round(WINDOW / ds), K = Math.floor(n / SP);
  const bump = new Float64Array(2 * HW + 1);
  for (let x = -HW; x <= HW; x++) { const u = x / HW; bump[x + HW] = (1 - u * u) * (1 - u * u); }
  const clampAt = (i: number, v: number) => (v < b.lo[i] ? b.lo[i] : v > b.hi[i] ? b.hi[i] : v);
  let d = Float64Array.from(d0);
  for (let i = 0; i < n; i++) d[i] = clampAt(i, d[i]);
  let best = lineLap(track, d, judge).lapTime;
  let step = 0.4;
  const m = 2 * WIN + 1;
  const px = new Float64Array(m + 2 * hk + 1), py = new Float64Array(m + 2 * hk + 1);
  const segLen = new Float64Array(m), kappa = new Float64Array(m), dWin = new Float64Array(m);
  const grad = new Float64Array(K);
  for (let it = 0; it < iters; it++) {
    const path = pathFromOffsets(track, d);
    const base = solveSpeedProfile(path, judge.model, { brakeUse: judge.brakeUse, grip: gripAlong(track, d, judge.surface) });
    const segT = (i: number) => base.t[i + 1] - base.t[i];
    for (let k = 0; k < K; k++) {
      const c = k * SP, a0 = c - WIN - hk;
      for (let j = 0; j < px.length; j++) {
        const i = (((a0 + j) % n) + n) % n;
        const x = a0 + j - c;
        const add = x >= -HW && x <= HW ? clampAt(i, d[i] + EPS * bump[x + HW]) - d[i] : 0;
        px[j] = path.xs[i] + track.nx[i] * add;
        py[j] = path.ys[i] + track.ny[i] * add;
        if (j >= hk && j < hk + m) dWin[j - hk] = d[i] + add;
      }
      for (let j = 0; j < m; j++) {
        const q = j + hk;
        segLen[j] = hypot(px[q + 1] - px[q], py[q + 1] - py[q]);
        kappa[j] = mengerCurvature(px[q - hk], py[q - hk], px[q], py[q], px[q + hk], py[q + hk]);
      }
      const s0 = (((c - WIN) % n) + n) % n;
      let grip: Float64Array | undefined;
      if (judge.surface) {
        grip = new Float64Array(m);
        for (let j = 0; j < m; j++) grip[j] = judge.surface.nodeGrip((s0 + j) % n, dWin[j]);
      }
      const prof = solveSpeedProfile({ n: m, segLen, kappa, closed: false }, judge.model, { v0: base.v[s0], vEnd: base.v[(s0 + m - 1) % n], brakeUse: judge.brakeUse, grip });
      let tBase = 0;
      for (let j = 0; j < m - 1; j++) tBase += segT((s0 + j) % n);
      grad[k] = (prof.t[m - 1] - tBase) / EPS;
    }
    let gmax = 0;
    for (let k = 0; k < K; k++) gmax = Math.max(gmax, Math.abs(grad[k]));
    if (gmax === 0) break;
    let ok = false;
    for (let tries = 0; tries < 6 && !ok; tries++) {
      const nd = Float64Array.from(d);
      for (let k = 0; k < K; k++) {
        const g = (grad[k] / gmax) * step;
        if (!g) continue;
        for (let x = -HW; x <= HW; x++) { const i = (((k * SP + x) % n) + n) % n; nd[i] -= g * bump[x + HW]; }
      }
      for (let i = 0; i < n; i++) nd[i] = clampAt(i, nd[i]);
      const t = lineLap(track, nd, judge).lapTime;
      if (t < best - 1e-6) { d = nd; best = t; ok = true; step *= 1.3; } else step *= 0.5;
    }
    if (!ok) {
      if (step < 0.004) break;
      step = Math.max(step, 0.02);
    }
  }
  return { d, lapTime: best };
}

/** The quickest line for a judge within the bounds (see the file note). */
export function fastLine(track: Track, b: LineBounds, judge: LineJudge, iters = 60): TrackPath {
  // Start lines: the old racing line (kept within these bounds) and the least-bending line.
  let inner = Infinity;
  for (let i = 0; i < track.n; i++) inner = Math.min(inner, b.hi[i], -b.lo[i]);
  const old = racingLine(track, Math.max(0, track.width / 2 - inner)).d;
  const bend = bendLine(track, b, old);
  let best: { d: Float64Array; lapTime: number } | null = null;
  for (const start of [old, bend]) {
    const r = refineLine(track, start, b, judge, iters);
    if (!best || r.lapTime < best.lapTime) best = r;
  }
  return pathFromOffsets(track, best!.d);
}

