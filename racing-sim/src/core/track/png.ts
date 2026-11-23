import type { Vec } from '../math';
import { exp } from '../fmath';
import { Track } from './track';

/**
 * PNG import, ported from the notebook (`track_monster.py`): threshold → skeletonize →
 * order the skeleton pixels into a loop → smooth → resample → scale from a user-given length.
 *
 * Differences from the notebook: the notebook greedily walked the skeleton and gave up at
 * branches. Here stray spurs are pruned first (a closed track has no endpoints, so peeling
 * endpoints until none remain removes only spurs), and the walk must close into a loop or
 * we throw. Smoothing is a periodic Gaussian instead of `splprep`, which does not wrap.
 * Image rows run down but the world's y runs up (the viewer draws y up), so rows are negated:
 * the track appears the way it looks in the image instead of mirrored top to bottom.
 */
export interface PngImportOptions {
  /** Pixels with gray value <= this count as track (notebook: 200, inverted binary threshold). */
  threshold?: number;
  /** Gaussian smoothing sigma in skeleton pixels (replaces the notebook's spline smoothing factor). */
  smoothing?: number;
  /** Drive the trace the other way round (the trace's own direction is arbitrary). */
  reverse?: boolean;
  /** Where the start/finish line is: metres along the trace (after `reverse`) from where it begins. */
  start?: number;
}

export function trackFromPng(image: ImageData, lengthMeters: number, width = 14, opts: PngImportOptions = {}): Track {
  if (!(lengthMeters > 0)) throw new Error('lengthMeters must be positive');
  const { width: w, height: h, data } = image;
  const mask = new Uint8Array(w * h);
  const thr = opts.threshold ?? 200;
  for (let i = 0; i < w * h; i++) {
    const gray = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    mask[i] = gray <= thr && data[i * 4 + 3] > 0 ? 1 : 0;
  }
  skeletonize(mask, w, h);
  pruneSpurs(mask, w, h);
  const loop = walkLoop(mask, w, h);
  if (opts.reverse) loop.reverse();
  const smoothed = smoothClosed(loop, opts.smoothing ?? 6);
  // Scale so the resampled track has exactly the requested length.
  let px = 0;
  for (let i = 0; i < smoothed.length; i++) {
    const a = smoothed[i], b = smoothed[(i + 1) % smoothed.length];
    px += Math.hypot(b.x - a.x, b.y - a.y);
  }
  const k = lengthMeters / px;
  // Begin the loop at the start/finish line (the trace begins wherever its first pixel was).
  let i0 = 0;
  const startPx = ((((opts.start ?? 0) % lengthMeters) + lengthMeters) % lengthMeters) / k;
  for (let i = 0, run = 0; i < smoothed.length; i++) {
    if (run >= startPx) { i0 = i; break; }
    const a = smoothed[i], b = smoothed[(i + 1) % smoothed.length];
    run += Math.hypot(b.x - a.x, b.y - a.y);
  }
  const loop2 = [...smoothed.slice(i0), ...smoothed.slice(0, i0)];
  return Track.fromPolyline(loop2.map((p) => ({ x: p.x * k, y: -p.y * k })), width);
}

/** Zhang–Suen thinning, in place. */
export function skeletonize(m: Uint8Array, w: number, h: number): void {
  const toClear: number[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      toClear.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!m[i]) continue;
          const p2 = m[i - w], p3 = m[i - w + 1], p4 = m[i + 1], p5 = m[i + w + 1];
          const p6 = m[i + w], p7 = m[i + w - 1], p8 = m[i - 1], p9 = m[i - w - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const a =
            (!p2 && p3 ? 1 : 0) + (!p3 && p4 ? 1 : 0) + (!p4 && p5 ? 1 : 0) + (!p5 && p6 ? 1 : 0) +
            (!p6 && p7 ? 1 : 0) + (!p7 && p8 ? 1 : 0) + (!p8 && p9 ? 1 : 0) + (!p9 && p2 ? 1 : 0);
          if (a !== 1) continue;
          if (pass === 0 ? p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0 : p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0) toClear.push(i);
        }
      }
      if (toClear.length) changed = true;
      for (const i of toClear) m[i] = 0;
    }
  }
}

const DIRS8: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0], [-1, -1], [1, -1], [1, 1], [-1, 1]]; // 4-neighbors first

/** The notebook's `get_neighbors`: set pixels around (x, y), 4-connected first. */
export function getNeighbors(m: Uint8Array, w: number, h: number, x: number, y: number): number[] {
  const out: number[] = [];
  for (const [dx, dy] of DIRS8) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < w && ny < h && m[ny * w + nx]) out.push(ny * w + nx);
  }
  return out;
}

/** Peel endpoints until none remain: removes spurs, leaves closed loops intact. */
function pruneSpurs(m: Uint8Array, w: number, h: number): void {
  let frontier: number[] = [];
  for (let i = 0; i < w * h; i++) if (m[i]) frontier.push(i);
  let stack = frontier.filter((i) => getNeighbors(m, w, h, i % w, (i / w) | 0).length <= 1);
  while (stack.length) {
    const i = stack.pop()!;
    if (!m[i]) continue;
    const nb = getNeighbors(m, w, h, i % w, (i / w) | 0);
    if (nb.length > 1) continue;
    m[i] = 0;
    for (const j of nb) stack.push(j);
  }
}

function walkLoop(m: Uint8Array, w: number, h: number): Vec[] {
  let total = 0, start = -1;
  for (let i = 0; i < w * h; i++) if (m[i]) { total++; if (start < 0) start = i; }
  if (start < 0) throw new Error('PNG import: no track pixels found');
  const visited = new Uint8Array(w * h);
  const path: number[] = [start];
  visited[start] = 1;
  let cur = start;
  for (;;) {
    const nb = getNeighbors(m, w, h, cur % w, (cur / w) | 0).filter((j) => !visited[j]);
    if (!nb.length) break;
    // Prefer the neighbor with the fewest onward options so corner pixels are not skipped into dead ends.
    let best = nb[0], bestScore = Infinity;
    for (const j of nb) {
      const s = getNeighbors(m, w, h, j % w, (j / w) | 0).filter((q) => !visited[q]).length;
      if (s < bestScore) { bestScore = s; best = j; }
    }
    visited[best] = 1;
    path.push(best);
    cur = best;
  }
  const first = path[0], last = path[path.length - 1];
  const closeGap = Math.hypot((first % w) - (last % w), ((first / w) | 0) - ((last / w) | 0));
  if (closeGap > 3 || path.length < 0.9 * total) {
    throw new Error(`PNG import: could not trace a single closed loop (traced ${path.length}/${total} px, end gap ${closeGap.toFixed(1)} px)`);
  }
  return path.map((i) => ({ x: i % w, y: (i / w) | 0 }));
}

/** Periodic Gaussian smoothing of a closed polyline, after thinning it to ~1 px spacing. */
function smoothClosed(pts: Vec[], sigma: number): Vec[] {
  const dense = Track.fromPolyline(pts, 1, 1); // evenly spaced ~1 px
  const n = dense.n;
  const r = Math.ceil(sigma * 3);
  const wts: number[] = [];
  let sum = 0;
  for (let k = -r; k <= r; k++) { const v = exp(-(k * k) / (2 * sigma * sigma)); wts.push(v); sum += v; }
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    let x = 0, y = 0;
    for (let k = -r; k <= r; k++) {
      const j = (((i + k) % n) + n) % n;
      x += dense.xs[j] * wts[k + r];
      y += dense.ys[j] * wts[k + r];
    }
    out.push({ x: x / sum, y: y / sum });
  }
  return out;
}
