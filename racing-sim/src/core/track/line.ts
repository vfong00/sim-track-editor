import { hypot } from '../fmath';
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
    segLen[i] = hypot(xs[j] - xs[i], ys[j] - ys[i]);
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
 * Racing line: the minimum-curvature path within the road minus `margin`. Each point moves
 * sideways toward where a smooth curve through its neighbours would put it, which drives the
 * path's second differences toward zero: p_i → (4(p_{i−h} + p_{i+h}) − (p_{i−2h} + p_{i+2h})) / 6.
 * That puts the line outside → apex → outside and uses the whole road through long corners.
 *
 * (Pulling each point to the plain midpoint of its neighbours, as before, minimises path
 * length instead: the shortest path hugs the inside of every corner from entry to exit, and
 * cost ~7% of lap time.) Coarse-to-fine neighbour spacing makes long corners converge fast.
 */
export function racingLine(track: Track, margin = LINE_MARGIN): TrackPath {
  const n = track.n;
  const lim = Math.max(0, track.width / 2 - margin);
  const d = new Float64Array(n);
  const { xs: cx, ys: cy, nx, ny } = track;
  const X = (i: number) => cx[i] + nx[i] * d[i];
  const Y = (i: number) => cy[i] + ny[i] * d[i];
  for (const hm of [192, 96, 48, 24, 12, 6, 3]) {
    const h = Math.max(1, Math.round(hm / track.ds));
    for (let it = 0; it < 300; it++) {
      for (let i = 0; i < n; i++) {
        const a = (i - h + n) % n, b = (i + h) % n, a2 = (i - 2 * h + n) % n, b2 = (i + 2 * h) % n;
        const tx = (4 * (X(a) + X(b)) - (X(a2) + X(b2))) / 6;
        const ty = (4 * (Y(a) + Y(b)) - (Y(a2) + Y(b2))) / 6;
        // Half steps: a full step on this stencil overshoots and oscillates.
        let v = d[i] + 0.5 * ((tx - X(i)) * nx[i] + (ty - Y(i)) * ny[i]);
        if (v > lim) v = lim;
        else if (v < -lim) v = -lim;
        d[i] = v;
      }
    }
  }
  return pathFromOffsets(track, d);
}
