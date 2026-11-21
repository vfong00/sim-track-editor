import { describe, expect, it } from 'vitest';
import { polylineSelfIntersects, trackFromPng, type Vec } from '../src/core';
import { decodeGrayPng } from '../src/cli/png-node';

describe('PNG import', () => {
  it.each([
    ['gb', 5891],
    ['yas', 5281],
  ])('%s: closed, scaled to the given length, not self-intersecting', (name, len) => {
    const t = trackFromPng(decodeGrayPng(new URL(`./fixtures/${name}.png`, import.meta.url).pathname), len);
    expect(Math.abs(t.length / len - 1)).toBeLessThan(0.002);
    expect(t.ds).toBeGreaterThan(0.95);
    expect(t.ds).toBeLessThan(1.05);
    const coarse: Vec[] = [];
    for (let i = 0; i < t.n; i += 5) coarse.push({ x: t.xs[i], y: t.ys[i] });
    expect(polylineSelfIntersects(coarse)).toBe(false);
    expect(t.clearance()).toBeGreaterThan(t.width);
    // seam: last → first spacing matches the rest
    expect(Math.hypot(t.xs[0] - t.xs[t.n - 1], t.ys[0] - t.ys[t.n - 1])).toBeLessThan(1.1 * t.ds);
  });

  it('scales with the requested length', () => {
    const img = decodeGrayPng(new URL('./fixtures/yas.png', import.meta.url).pathname);
    expect(trackFromPng(img, 3000).length / trackFromPng(img, 6000).length).toBeCloseTo(0.5, 2);
  });
});
