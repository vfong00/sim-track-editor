import type { PathLike } from '../physics/profile';
import { mengerCurvature, type Track } from './track';

/**
 * A path around the track given as a sideways offset d[i] at every centerline sample i
 * (so every path shares the track's s coordinate). Node i of the path is toXY(s_i, d[i]).
 */
export interface TrackPath extends PathLike {
  d: Float64Array;
  xs: Float64Array;
  ys: Float64Array;
  /** Path distance from node 0 to node i (length n + 1; cum[n] = path length). */
  cum: Float64Array;
  length: number;
}

/** Margin (m) the racing line keeps from the road edge: car half-width plus a little. */
export const LINE_MARGIN = 1.5;

export function pathFromOffsets(track: Track, d: Float64Array): TrackPath {
  const n = track.n;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = track.xs[i] + track.nx[i] * d[i];
    ys[i] = track.ys[i] + track.ny[i] * d[i];
  }
  const segLen = new Float64Array(n);
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    segLen[i] = Math.hypot(xs[j] - xs[i], ys[j] - ys[i]);
    cum[i + 1] = cum[i] + segLen[i];
  }
  const kappa = new Float64Array(n);
  const h = Math.max(1, Math.round(3 / track.ds));
  for (let i = 0; i < n; i++) {
    const a = (i - h + n) % n, c = (i + h) % n;
    kappa[i] = mengerCurvature(xs[a], ys[a], xs[i], ys[i], xs[c], ys[c]);
  }
  return { n, d, xs, ys, segLen, kappa, cum, length: cum[n], closed: true };
}

export function centerlinePath(track: Track): TrackPath {
  return pathFromOffsets(track, new Float64Array(track.n));
}

/**
 * Racing-line heuristic: start on the centerline and repeatedly pull each point sideways
 * toward the midpoint of its neighbours (an elastic band, i.e. minimum curvature), clamped
 * to the road minus `margin`. That straightens the path through each corner, which puts it
 * outside → apex → outside. Coarse-to-fine neighbour spacing makes long corners converge fast.
 */
export function racingLine(track: Track, margin = LINE_MARGIN): TrackPath {
  const n = track.n;
  const lim = Math.max(0, track.width / 2 - margin);
  const d = new Float64Array(n);
  const { xs: cx, ys: cy, nx, ny } = track;
  const schedule: [number, number][] = [[96, 30], [48, 30], [24, 40], [12, 40], [6, 50], [3, 60], [1, 80]];
  for (const [hm, iters] of schedule) {
    const h = Math.max(1, Math.round(hm / track.ds));
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < n; i++) {
        const a = (i - h + n) % n, b = (i + h) % n;
        const mx = (cx[a] + nx[a] * d[a] + cx[b] + nx[b] * d[b]) / 2;
        const my = (cy[a] + ny[a] * d[a] + cy[b] + ny[b] * d[b]) / 2;
        const px = cx[i] + nx[i] * d[i], py = cy[i] + ny[i] * d[i];
        let v = d[i] + (mx - px) * nx[i] + (my - py) * ny[i];
        if (v > lim) v = lim;
        else if (v < -lim) v = -lim;
        d[i] = v;
      }
    }
  }
  return pathFromOffsets(track, d);
}
