import { Track, type Vec } from '../src/core';

export const circle = (r: number, n: number): Vec[] =>
  Array.from({ length: n }, (_, i) => ({ x: r * Math.cos((i / n) * 2 * Math.PI), y: r * Math.sin((i / n) * 2 * Math.PI) }));

/** Stadium: straight of `straight` m from s = 0, semicircle of radius r, straight back, semicircle. */
export function stadium(straight: number, r: number, width = 14): Track {
  const pts: Vec[] = [];
  const step = 0.25;
  for (let x = 0; x < straight; x += step) pts.push({ x, y: -r });
  for (let a = -Math.PI / 2; a < Math.PI / 2; a += step / r) pts.push({ x: straight + r * Math.cos(a), y: r * Math.sin(a) });
  for (let x = straight; x > 0; x -= step) pts.push({ x, y: r });
  for (let a = Math.PI / 2; a < (3 * Math.PI) / 2; a += step / r) pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
  return Track.fromPolyline(pts, width);
}
