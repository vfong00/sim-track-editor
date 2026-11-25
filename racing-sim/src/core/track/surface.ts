import type { TrackPath } from './line';
import type { Track } from './track';

/** Kerb width (m) and stripe length (m, drawn only). */
export const KERB_WIDTH = 1.0;
export const KERB_STRIPE = 2.5;
/** The racing line within this of the road edge (m) uses the kerb there... */
const KERB_NEAR = 2.5;
/** ...in a corner: somewhere within KERB_LOOK m the centreline is tighter than this radius (m). */
const KERB_RADIUS = 250;
const KERB_LOOK = 15;
/** Kerbs run on this far (m) either side of where the line touches. */
const KERB_EXTEND = 6;

/** Grip of a tyre on a kerb, as a share of the asphalt's (painted, ridged, and it bounces the car). */
export const KERB_GRIP = 0.9;
/** Tyre centres across the car (m from its centre) and tyre width (m), for what each wheel is on. */
export const WHEEL_TRACK = 0.7;
export const TYRE_WIDTH = 0.35;

export interface Kerbs {
  /** Per node, 1 where a kerb runs along the left (+d) edge. */
  left: Uint8Array;
  /** Per node, 1 where a kerb runs along the right (−d) edge. */
  right: Uint8Array;
}

const kerbCache = new WeakMap<TrackPath, Kerbs>();

/**
 * Where the kerbs go, per node and side: where the racing line comes close to the edge in a
 * corner, which is the outside at turn-in, the inside at the apex and the outside at the exit,
 * as on a real circuit.
 */
export function kerbsFor(t: Track, line: TrackPath): Kerbs {
  const hit = kerbCache.get(line);
  if (hit) return hit;
  const n = t.n, edge = t.width / 2;
  const look = Math.round(KERB_LOOK / t.ds), ext = Math.round(KERB_EXTEND / t.ds);
  // Tightest centreline curvature near each node.
  const near = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = -look; j <= look; j++) m = Math.max(m, Math.abs(t.curvature[(i + j + n) % n]));
    near[i] = m;
  }
  const left = new Uint8Array(n), right = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = line.d[i];
    if (Math.abs(d) < edge - KERB_NEAR || near[i] < 1 / KERB_RADIUS) continue;
    const mask = d > 0 ? left : right;
    for (let j = -ext; j <= ext; j++) mask[(i + j + n) % n] = 1;
  }
  const out = { left, right };
  kerbCache.set(line, out);
  return out;
}

/** Width (m) of one cell of the surface grid across the road. */
const CELL = 0.25;

/**
 * Surface grip: a share of the car's grip (1 = clean dry asphalt) by position on the road, per
 * centreline node and across the road in CELL-wide cells. Kerbs are the first layer; rain (a
 * rubbered line, wet paint and kerbs, standing water) writes into the same grid. Off the road is
 * the run-off's business (see `offShare` in lanes.ts), not this.
 */
export class Surface {
  readonly cells: number;
  readonly grip: Float32Array;
  readonly kerbs: Kerbs;

  constructor(readonly track: Track, line: TrackPath) {
    this.cells = Math.ceil(track.width / CELL);
    this.grip = new Float32Array(track.n * this.cells).fill(1);
    this.kerbs = kerbsFor(track, line);
    const edge = track.width / 2;
    for (let i = 0; i < track.n; i++) {
      for (let c = 0; c < this.cells; c++) {
        const d = -edge + (c + 0.5) * CELL;
        const onKerb = (this.kerbs.left[i] && d > edge - KERB_WIDTH) || (this.kerbs.right[i] && d < -edge + KERB_WIDTH);
        if (onKerb) this.grip[i * this.cells + c] = KERB_GRIP;
      }
    }
  }

  /** Grip share at node i, lateral position d (1 off the road: see the class note). */
  at(i: number, d: number): number {
    const c = Math.floor((d + this.track.width / 2) / CELL);
    return c < 0 || c >= this.cells ? 1 : this.grip[i * this.cells + c];
  }

  /**
   * The grip share a car at (s, d) has: the mean over its tyres of what each tyre is on (left
   * and right tyre tracks, each sampled across its width). Every tyre does an equal share of the
   * work, so half the car on a kerb loses half the kerb's grip.
   */
  carGrip(s: number, d: number): number {
    return this.nodeGrip(this.node(s), d);
  }

  /** carGrip at node i (what the speed plans use along a lane). */
  nodeGrip(i: number, d: number): number {
    return this.overTyres(d, (w) => this.at(i, w));
  }

  /** Share of the car's tyre width on a kerb at (s, d), 0–1 (whatever the grip there). */
  kerbShare(s: number, d: number): number {
    const i = this.node(s), edge = this.track.width / 2;
    return this.overTyres(d, (w) => ((this.kerbs.left[i] && w > edge - KERB_WIDTH && w <= edge) || (this.kerbs.right[i] && w < -edge + KERB_WIDTH && w >= -edge) ? 1 : 0));
  }

  private node(s: number): number {
    const L = this.track.length;
    return Math.min(this.track.n - 1, Math.floor((((s % L) + L) % L) / this.track.ds));
  }

  /** Mean of f over the car's tyres: two points across each of the left and right tyres. */
  private overTyres(d: number, f: (w: number) => number): number {
    const h = TYRE_WIDTH / 4;
    return (f(d - WHEEL_TRACK - h) + f(d - WHEEL_TRACK + h) + f(d + WHEEL_TRACK - h) + f(d + WHEEL_TRACK + h)) / 4;
  }
}
