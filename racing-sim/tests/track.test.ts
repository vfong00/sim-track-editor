import { describe, expect, it } from 'vitest';
import { catmullRom, closedSpline, generateTrack, makeRng, polylineSelfIntersects, Track, type Vec } from '../src/core';

const circle = (r: number, n: number): Vec[] =>
  Array.from({ length: n }, (_, i) => ({ x: r * Math.cos((i / n) * 2 * Math.PI), y: r * Math.sin((i / n) * 2 * Math.PI) }));

describe('curvature', () => {
  it.each([20, 60, 250])('circle of radius %d m gives curvature 1/r everywhere', (r) => {
    const t = Track.fromPolyline(circle(r, 4000), 10);
    for (let i = 0; i < t.n; i++) expect(t.curvature[i]).toBeCloseTo(1 / r, 1 / r > 0.02 ? 3 : 4);
    expect(Math.abs(t.curvature[0] * r - 1)).toBeLessThan(0.005);
    expect(Math.abs(t.minRadius() / r - 1)).toBeLessThan(0.01);
  });

  it('a spline through points on a circle is near-circular', () => {
    const t = Track.fromControlPoints(circle(100, 24), 10);
    for (let i = 0; i < t.n; i++) expect(Math.abs(t.curvature[i] * 100 - 1)).toBeLessThan(0.1);
  });

  it('is signed: clockwise is negative', () => {
    const t = Track.fromPolyline(circle(50, 1000).reverse(), 10);
    expect(t.curvature[10]).toBeCloseTo(-1 / 50, 4);
  });
});

describe('resampling and seam', () => {
  it('spaces samples evenly at ~1 m', () => {
    const t = generateTrack({ seed: 3 });
    const gaps = Array.from({ length: t.n }, (_, i) => Math.hypot(t.xs[(i + 1) % t.n] - t.xs[i], t.ys[(i + 1) % t.n] - t.ys[i]));
    expect(Math.max(...gaps) / Math.min(...gaps)).toBeLessThan(1.01);
    expect(t.ds).toBeGreaterThan(0.99);
    expect(t.ds).toBeLessThan(1.01);
  });

  it('spline is continuous across the seam', () => {
    const ctrl = generateTrack({ seed: 4 }).centerline().filter((_, i) => i % 200 === 0);
    const n = ctrl.length;
    // End of the last segment equals start of the first; tangent matches too.
    const end = catmullRom(ctrl[n - 2], ctrl[n - 1], ctrl[0], ctrl[1], 1);
    expect(end.x).toBeCloseTo(ctrl[0].x, 9);
    expect(end.y).toBeCloseTo(ctrl[0].y, 9);
    const dense = closedSpline(ctrl);
    const step = Math.hypot(dense[0].x - dense[dense.length - 1].x, dense[0].y - dense[dense.length - 1].y);
    expect(step).toBeLessThan(0.5);
  });

  it('track is continuous in position, heading and curvature at the seam', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const t = generateTrack({ seed });
      const gap = Math.hypot(t.xs[0] - t.xs[t.n - 1], t.ys[0] - t.ys[t.n - 1]);
      expect(Math.abs(gap - t.ds)).toBeLessThan(0.02);
      const turn = Math.atan2(t.tx[t.n - 1] * t.ty[0] - t.ty[t.n - 1] * t.tx[0], t.tx[t.n - 1] * t.tx[0] + t.ty[t.n - 1] * t.ty[0]);
      expect(Math.abs(turn)).toBeLessThan(0.05);
      expect(Math.abs(t.curvature[0] - t.curvature[t.n - 1])).toBeLessThan(0.01);
      const p = t.pointAt(t.length - 1e-9), q = t.pointAt(0);
      expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(1.01);
    }
  });
});

describe('generator', () => {
  it('is deterministic', () => {
    const a = generateTrack({ seed: 11 }), b = generateTrack({ seed: 11 });
    expect(Array.from(a.xs)).toEqual(Array.from(b.xs));
  });

  it('never self-intersects and respects min radius across 1000 seeds', () => {
    const minRadius = 25;
    for (let seed = 0; seed < 1000; seed++) {
      const t = generateTrack({ seed, minRadius });
      const coarse = t.centerline().filter((_, i) => i % 4 === 0);
      expect(polylineSelfIntersects(coarse), `seed ${seed} self-intersects`).toBe(false);
      expect(t.minRadius(), `seed ${seed} radius`).toBeGreaterThanOrEqual(minRadius);
      expect(t.clearance(), `seed ${seed} clearance`).toBeGreaterThanOrEqual(t.width);
    }
  }, 120_000);

  it('intersection checker catches a figure eight', () => {
    expect(polylineSelfIntersects([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }])).toBe(true);
  });

  it('rejects too few drawn points', () => {
    expect(() => Track.fromControlPoints([{ x: 0, y: 0 }, { x: 1, y: 1 }], 10)).toThrow();
  });
});

describe('(s, d) <-> (x, y)', () => {
  it('round-trips on generated tracks', () => {
    const rng = makeRng(99);
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const t = generateTrack({ seed });
      for (let k = 0; k < 300; k++) {
        const s = rng.range(0, t.length), d = rng.range(-t.width / 2, t.width / 2);
        const p = t.toXY(s, d);
        const f = t.toFrame(p.x, p.y);
        const ds = Math.min(Math.abs(f.s - s), t.length - Math.abs(f.s - s));
        expect(ds).toBeLessThan(1e-6);
        expect(Math.abs(f.d - d)).toBeLessThan(1e-6);
        const q = t.toXY(f.s, f.d); // and back to xy exactly
        expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeLessThan(1e-6);
      }
    }
  });

  it('is exact on a circle and the hinted search agrees with the full search', () => {
    const t = Track.fromPolyline(circle(100, 3000), 12);
    const p = t.toXY(123.4, 3);
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(97, 1); // left of a CCW circle is inward
    const full = t.toFrame(p.x, p.y), hint = t.toFrame(p.x, p.y, 120);
    expect(hint.s).toBeCloseTo(full.s, 9);
    expect(full.s).toBeCloseTo(123.4, 1);
    expect(full.d).toBeCloseTo(3, 1);
  });

  it('wraps s past the lap length', () => {
    const t = generateTrack({ seed: 2 });
    const a = t.toXY(5, 2), b = t.toXY(5 + t.length, 2);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-6);
  });
});
