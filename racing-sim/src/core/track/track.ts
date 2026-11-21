import type { Vec } from '../math';
import { closedSpline } from './spline';

/**
 * A closed track: evenly spaced centerline samples (spacing `ds`, ~1 m), signed curvature
 * (positive = left turn) and a constant width. Sample i sits at arc length s = i * ds and
 * sample N wraps to sample 0, so there is no seam.
 */
export class Track {
  readonly n: number;
  readonly length: number;
  readonly ds: number;
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  /** Unit tangent of the segment i → i+1. */
  readonly tx: Float64Array;
  readonly ty: Float64Array;
  readonly curvature: Float64Array;
  /** Unit left normal at each sample (average of the adjacent segments), used by the (s, d) frame. */
  readonly nx: Float64Array;
  readonly ny: Float64Array;

  constructor(points: Vec[], readonly width: number) {
    this.n = points.length;
    this.xs = Float64Array.from(points, (p) => p.x);
    this.ys = Float64Array.from(points, (p) => p.y);
    this.tx = new Float64Array(this.n);
    this.ty = new Float64Array(this.n);
    let total = 0;
    for (let i = 0; i < this.n; i++) {
      const j = (i + 1) % this.n;
      const dx = this.xs[j] - this.xs[i], dy = this.ys[j] - this.ys[i];
      const l = Math.hypot(dx, dy);
      this.tx[i] = dx / l;
      this.ty[i] = dy / l;
      total += l;
    }
    this.length = total;
    this.ds = total / this.n;
    this.curvature = new Float64Array(this.n);
    this.nx = new Float64Array(this.n);
    this.ny = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const a = (i - 1 + this.n) % this.n;
      const hx = this.tx[a] + this.tx[i], hy = this.ty[a] + this.ty[i];
      const l = Math.hypot(hx, hy);
      this.nx[i] = -hy / l;
      this.ny[i] = hx / l;
    }
    for (let i = 0; i < this.n; i++) {
      // Three-point circle over a ±3 m stencil: far less noisy than adjacent samples.
      const h = Math.max(1, Math.round(3 / this.ds));
      const a = (i - h + this.n * 8) % this.n, c = (i + h) % this.n;
      this.curvature[i] = mengerCurvature(this.xs[a], this.ys[a], this.xs[i], this.ys[i], this.xs[c], this.ys[c]);
    }
  }

  /** Resample a dense closed polyline to even spacing (~`spacing` m). */
  static fromPolyline(dense: Vec[], width: number, spacing = 1): Track {
    const m = dense.length;
    const cum = new Float64Array(m + 1);
    for (let i = 0; i < m; i++) {
      const b = dense[(i + 1) % m];
      cum[i + 1] = cum[i] + Math.hypot(b.x - dense[i].x, b.y - dense[i].y);
    }
    const total = cum[m];
    const n = Math.max(8, Math.round(total / spacing));
    const step = total / n;
    const out: Vec[] = [];
    let seg = 0;
    for (let k = 0; k < n; k++) {
      const target = k * step;
      while (seg < m - 1 && cum[seg + 1] < target) seg++;
      const a = dense[seg], b = dense[(seg + 1) % m];
      const t = (target - cum[seg]) / (cum[seg + 1] - cum[seg] || 1);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    return new Track(out, width);
  }

  /** Closed periodic spline through control points (drawn tracks), resampled evenly. */
  static fromControlPoints(ctrl: Vec[], width: number, spacing = 1): Track {
    if (ctrl.length < 3) throw new Error('A track needs at least 3 points');
    return Track.fromPolyline(closedSpline(ctrl, 4 / spacing), width, spacing);
  }

  private wrap(s: number): number {
    return ((s % this.length) + this.length) % this.length;
  }

  /** Centerline position at arc length s. */
  pointAt(s: number): Vec {
    const u = this.wrap(s) / this.ds;
    const i = Math.min(Math.floor(u), this.n - 1);
    const t = u - i;
    const j = (i + 1) % this.n;
    return { x: this.xs[i] + (this.xs[j] - this.xs[i]) * t, y: this.ys[i] + (this.ys[j] - this.ys[i]) * t };
  }

  /** Unit tangent at s. */
  tangentAt(s: number): Vec {
    const i = Math.min(Math.floor(this.wrap(s) / this.ds), this.n - 1);
    return { x: this.tx[i], y: this.ty[i] };
  }

  curvatureAt(s: number): number {
    const u = this.wrap(s) / this.ds;
    const i = Math.min(Math.floor(u), this.n - 1);
    const t = u - i;
    return this.curvature[i] * (1 - t) + this.curvature[(i + 1) % this.n] * t;
  }

  /** Unit left normal at s (interpolated between sample normals, so the frame is smooth). */
  normalAt(s: number): Vec {
    const u = this.wrap(s) / this.ds;
    const i = Math.min(Math.floor(u), this.n - 1);
    const t = u - i;
    const j = (i + 1) % this.n;
    const x = this.nx[i] * (1 - t) + this.nx[j] * t, y = this.ny[i] * (1 - t) + this.ny[j] * t;
    const l = Math.hypot(x, y);
    return { x: x / l, y: y / l };
  }

  /** (s, d) → (x, y). d is the sideways offset, positive to the left of travel. */
  toXY(s: number, d: number): Vec {
    const p = this.pointAt(s), n = this.normalAt(s);
    return { x: p.x + n.x * d, y: p.y + n.y * d };
  }

  /**
   * (x, y) → (s, d): nearest centerline segment for a first guess, then Newton-style
   * refinement so that toXY(toFrame(p)) == p to numerical precision. Pass `hintS` to search
   * only ±`window` metres (fast path for cars that move continuously).
   */
  toFrame(x: number, y: number, hintS?: number, window = 50): { s: number; d: number } {
    let best = Infinity, bi = 0, bt = 0;
    const test = (i: number) => {
      const j = (i + 1) % this.n;
      const ax = this.xs[i], ay = this.ys[i];
      const ex = this.xs[j] - ax, ey = this.ys[j] - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
      const dd = Math.hypot(x - (ax + ex * t), y - (ay + ey * t));
      if (dd < best) {
        best = dd;
        bi = i;
        bt = t;
      }
    };
    if (hintS === undefined) {
      for (let i = 0; i < this.n; i++) test(i);
    } else {
      const c = Math.floor(this.wrap(hintS) / this.ds);
      const r = Math.ceil(window / this.ds);
      for (let k = -r; k <= r; k++) test(((c + k) % this.n + this.n) % this.n);
    }
    let s = (bi + bt) * this.ds;
    let d = 0;
    for (let it = 0; it < 12; it++) {
      const p = this.pointAt(s), n = this.normalAt(s);
      const rx = x - p.x, ry = y - p.y;
      d = rx * n.x + ry * n.y;
      const e = rx * n.y - ry * n.x; // component along the tangent (n rotated -90°)
      if (Math.abs(e) < 1e-10) break;
      s += e / Math.max(0.2, 1 - d * this.curvatureAt(s));
    }
    return { s: this.wrap(s), d };
  }

  /** Left (+1) or right (-1) road edge at sample i, for drawing. */
  edge(i: number, side: 1 | -1): Vec {
    return { x: this.xs[i] + this.nx[i] * side * this.width / 2, y: this.ys[i] + this.ny[i] * side * this.width / 2 };
  }

  centerline(): Vec[] {
    return Array.from({ length: this.n }, (_, i) => ({ x: this.xs[i], y: this.ys[i] }));
  }

  /** Smallest corner radius (m) on the track. */
  minRadius(): number {
    let k = 0;
    for (const c of this.curvature) k = Math.max(k, Math.abs(c));
    return k > 0 ? 1 / k : Infinity;
  }

  /**
   * Smallest distance between centerline points that are far apart along the track
   * (arc separation > `exclude`). A value below `width` means the road overlaps itself.
   */
  clearance(exclude = Math.max(60, this.width * 4)): number {
    const cell = Math.max(this.width * 2, 10);
    const grid = new Map<number, number[]>();
    const key = (cx: number, cy: number) => cx * 73856093 ^ cy * 19349663;
    for (let i = 0; i < this.n; i++) {
      const k = key(Math.floor(this.xs[i] / cell), Math.floor(this.ys[i] / cell));
      const list = grid.get(k);
      if (list) list.push(i);
      else grid.set(k, [i]);
    }
    const skip = Math.ceil(exclude / this.ds);
    let best = Infinity;
    for (let i = 0; i < this.n; i++) {
      const cx = Math.floor(this.xs[i] / cell), cy = Math.floor(this.ys[i] / cell);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          for (const j of grid.get(key(cx + ox, cy + oy)) ?? []) {
            if (j <= i) continue;
            const gap = Math.min(j - i, this.n - (j - i));
            if (gap <= skip) continue;
            best = Math.min(best, Math.hypot(this.xs[i] - this.xs[j], this.ys[i] - this.ys[j]));
          }
        }
      }
    }
    return best;
  }
}

/** Signed curvature of the circle through three points (positive = counter-clockwise). */
export function mengerCurvature(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const cr = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d = Math.hypot(bx - ax, by - ay) * Math.hypot(cx - bx, cy - by) * Math.hypot(cx - ax, cy - ay);
  return d === 0 ? 0 : (2 * cr) / d;
}
