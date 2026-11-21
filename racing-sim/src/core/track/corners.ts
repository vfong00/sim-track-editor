import type { TrackPath } from './line';

export interface Corner {
  /** "T1", "T2", … in order from the start line. */
  name: string;
  /** Apex sample index (peak |curvature| on the racing line). */
  apex: number;
  /** +1 left-hander, −1 right-hander. */
  dir: 1 | -1;
  radius: number;
}

/**
 * Corners on the racing line: runs where |κ| > 1/250 m⁻¹, each named by its tightest point.
 * Runs closer than 40 m are merged (a chicane wiggle is one corner per direction change).
 */
export function findCorners(line: TrackPath, minKappa = 1 / 250): Corner[] {
  const n = line.n;
  const k = line.kappa;
  // Start scanning on a straight-ish sample so a corner across the seam isn't split.
  let start = 0;
  for (let i = 0; i < n; i++) if (Math.abs(k[i]) < minKappa) { start = i; break; }
  const out: Omit<Corner, 'name'>[] = [];
  let i = 0;
  while (i < n) {
    const a = (start + i) % n;
    if (Math.abs(k[a]) < minKappa) { i++; continue; }
    const dir = k[a] > 0 ? 1 : -1;
    let apex = a, peak = 0, j = i;
    while (j < n) {
      const b = (start + j) % n;
      if (Math.abs(k[b]) < minKappa * 0.7 || Math.sign(k[b]) !== dir) break;
      if (Math.abs(k[b]) > peak) { peak = Math.abs(k[b]); apex = b; }
      j++;
    }
    const prev = out[out.length - 1];
    const gap = prev ? (apex - prev.apex + n) % n : Infinity;
    if (prev && prev.dir === dir && gap < 40 + (j - i)) {
      if (peak > 1 / prev.radius) { prev.apex = apex; prev.radius = 1 / peak; }
    } else out.push({ apex, dir: dir as 1 | -1, radius: 1 / peak });
    i = j;
  }
  out.sort((a, b) => a.apex - b.apex);
  return out.map((c, idx) => ({ ...c, name: `T${idx + 1}` }));
}

/** For every sample, the index (into `corners`) of the next apex at or ahead of it. */
export function nextCornerTable(n: number, corners: Corner[]): Int32Array {
  const t = new Int32Array(n).fill(-1);
  if (!corners.length) return t;
  let c = 0;
  for (let i = 0; i < n; i++) {
    while (c < corners.length && corners[c].apex < i) c++;
    t[i] = c < corners.length ? c : 0;
  }
  return t;
}
