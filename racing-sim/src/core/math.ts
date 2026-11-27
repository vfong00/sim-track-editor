import { hypot } from './fmath';
export interface Vec {
  x: number;
  y: number;
}

export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const dist = (a: Vec, b: Vec): number => hypot(a.x - b.x, a.y - b.y);

/** Convex hull (Andrew's monotone chain), counter-clockwise. */
export function convexHull(pts: Vec[]): Vec[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const build = (list: Vec[]): Vec[] => {
    const h: Vec[] = [];
    for (const q of list) {
      while (h.length >= 2 && cross(sub(h[h.length - 1], h[h.length - 2]), sub(q, h[h.length - 2])) <= 0) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return [...build(p), ...build([...p].reverse())];
}

/** Proper intersection of segments ab and cd (shared endpoints do not count). */
export function segmentsIntersect(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const d1 = cross(sub(b, a), sub(c, a));
  const d2 = cross(sub(b, a), sub(d, a));
  const d3 = cross(sub(d, c), sub(a, c));
  const d4 = cross(sub(d, c), sub(b, c));
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** True if the closed polyline crosses itself. Brute force: use on coarse polylines. */
export function polylineSelfIntersects(pts: Vec[]): boolean {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent across the seam
      if (segmentsIntersect(a, b, pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}
