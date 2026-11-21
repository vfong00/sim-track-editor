import type { Vec } from '../math';

/**
 * Closed centripetal Catmull–Rom spline through `pts` (Barry–Goldman form).
 * Periodic: segment i runs pts[i] → pts[(i+1) % n], so there is no seam.
 * Returns a dense closed polyline (last point is NOT repeated).
 */
export function closedSpline(pts: Vec[], samplesPerMeter = 4): Vec[] {
  const n = pts.length;
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const steps = Math.max(4, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) * samplesPerMeter));
    const t1 = knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
    for (let k = 0; k < steps; k++) out.push(evalSegment(p0, p1, p2, p3, t1, t2, t3, t1 + ((t2 - t1) * k) / steps));
  }
  return out;
}

/** Centripetal Catmull–Rom point on segment p1→p2 at u in [0,1]. */
export function catmullRom(p0: Vec, p1: Vec, p2: Vec, p3: Vec, u: number): Vec {
  const t1 = knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  return evalSegment(p0, p1, p2, p3, t1, t2, t3, t1 + (t2 - t1) * u);
}

const knot = (a: Vec, b: Vec) => Math.max(Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)), 1e-6);

function evalSegment(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t1: number, t2: number, t3: number, t: number): Vec {
  const w = (ta: number, tb: number) => (t - ta) / (tb - ta);
  let k = w(0, t1);
  const a1x = p0.x + (p1.x - p0.x) * k, a1y = p0.y + (p1.y - p0.y) * k;
  k = w(t1, t2);
  const a2x = p1.x + (p2.x - p1.x) * k, a2y = p1.y + (p2.y - p1.y) * k;
  k = w(t2, t3);
  const a3x = p2.x + (p3.x - p2.x) * k, a3y = p2.y + (p3.y - p2.y) * k;
  k = w(0, t2);
  const b1x = a1x + (a2x - a1x) * k, b1y = a1y + (a2y - a1y) * k;
  k = w(t1, t3);
  const b2x = a2x + (a3x - a2x) * k, b2y = a2y + (a3y - a2y) * k;
  k = w(t1, t2);
  return { x: b1x + (b2x - b1x) * k, y: b1y + (b2y - b1y) * k };
}
