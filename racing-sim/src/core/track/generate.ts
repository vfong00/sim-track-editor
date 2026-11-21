import { convexHull, dist, type Vec } from '../math';
import { makeRng } from '../rng';
import { Track } from './track';

export interface GenerateOptions {
  seed: number;
  /** Road width in metres. */
  width?: number;
  /** 0 = smooth blob, 1 = very wiggly. */
  complexity?: number;
  /** Tightest allowed corner radius in metres. */
  minRadius?: number;
  /** Rough half-extent of the layout in metres. */
  size?: number;
}

/**
 * Random closed track: random points → convex hull → perturbed midpoints → periodic spline,
 * rejected unless the corner radius is at least `minRadius` and the road never overlaps itself.
 * Deterministic in `seed`.
 */
export function generateTrack(opts: GenerateOptions): Track {
  const width = opts.width ?? 14;
  const minRadius = opts.minRadius ?? 25;
  const size = opts.size ?? 500;
  let complexity = opts.complexity ?? 0.6;
  const rng = makeRng(opts.seed);
  const clearance = width * 1.5;

  for (let attempt = 0; attempt < 400; attempt++) {
    // Get gentler as attempts fail, so we always terminate with something valid.
    if (attempt > 0 && attempt % 25 === 0) complexity *= 0.75;

    const raw: Vec[] = [];
    const count = rng.int(10, 18);
    for (let i = 0; i < count; i++) raw.push({ x: rng.range(-size, size), y: rng.range(-size * 0.7, size * 0.7) });
    const hull = convexHull(raw).filter((p, i, a) => dist(p, a[(i + a.length - 1) % a.length]) > size * 0.25);
    if (hull.length < 5) continue;

    // Perturb: push each edge midpoint in or out, and jitter the hull corners a little.
    const ctrl: Vec[] = [];
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length];
      const len = dist(a, b);
      const nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len; // outward for a CCW hull
      const push = rng.normal() * len * 0.3 * complexity;
      ctrl.push({ x: a.x + rng.normal() * size * 0.04 * complexity, y: a.y + rng.normal() * size * 0.04 * complexity });
      ctrl.push({ x: (a.x + b.x) / 2 + nx * push, y: (a.y + b.y) / 2 + ny * push });
    }

    // Cheap screen on a coarse (4 m) copy, then confirm on the real 1 m track.
    const coarse = Track.fromControlPoints(ctrl, width, 4);
    if (coarse.minRadius() < minRadius * 0.9 || coarse.clearance() < clearance) continue;
    const track = Track.fromControlPoints(ctrl, width);
    if (track.minRadius() < minRadius || track.clearance() < clearance) continue;
    return track;
  }
  // Practically unreachable: a plain ellipse is always valid.
  const ell: Vec[] = Array.from({ length: 16 }, (_, i) => ({
    x: size * Math.cos((i / 16) * 2 * Math.PI),
    y: size * 0.6 * Math.sin((i / 16) * 2 * Math.PI),
  }));
  return Track.fromControlPoints(ell, width);
}
