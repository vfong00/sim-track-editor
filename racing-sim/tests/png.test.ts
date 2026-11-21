import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { polylineSelfIntersects, trackFromPng, type Vec } from '../src/core';

/** Minimal decoder for 8-bit grayscale, non-interlaced PNG fixtures (enough for tests). */
function decodeGrayPng(path: string): ImageData {
  const buf = readFileSync(path);
  let pos = 8, w = 0, h = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); expect(body[8]).toBe(8); expect(body[9]).toBe(0); }
    if (type === 'IDAT') idat.push(body);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (w + 1)];
    for (let x = 0; x < w; x++) {
      const a = x ? gray[y * w + x - 1] : 0, b = y ? gray[(y - 1) * w + x] : 0, c = x && y ? gray[(y - 1) * w + x - 1] : 0;
      let v = raw[y * (w + 1) + 1 + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      gray[y * w + x] = v & 255;
    }
  }
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([gray[i], gray[i], gray[i], 255], i * 4);
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData;
}

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
