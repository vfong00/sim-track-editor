import { type CarState, lineSideSpeed } from './car';
import { clamp, HIT_LEN, HIT_W, type LaneSet } from './lanes';

export interface Contact {
  a: number;
  b: number;
  /** Closing speed along the line between centres before the hit (m/s). */
  closing: number;
  /**
   * How off-centre the hit is, 0–1: a side-by-side hit is 1, a nose-to-tail hit counts by how
   * far the cars are offset sideways (square behind = 0, one corner on the other = ~1).
   * Off-centre hits are the ones that turn a car round.
   */
  angle: number;
}

interface Body {
  st: CarState;
  d: number;
  /** A retired car: it doesn't move, the other car takes the whole push and the whole hit. */
  fixed?: boolean;
  /** Cleared away by marshals: no longer there to hit. */
  cleared?: boolean;
}

/** Speed lost by both cars in a contact of 2 m/s or more (fraction), on top of the inelastic exchange. */
const SCRUB = 0.03;

/**
 * Rectangle collisions in the (s, d) frame (cars are roughly aligned with the road): overlapping
 * cars are pushed apart along the axis of least overlap (nose-to-tail along s, side-by-side
 * along d), their closing speed along that axis is removed (nearly inelastic)
 * and both scrub a little speed. Repeats until nothing overlaps. Cars can be pushed into the
 * run-off but not through the barrier; if one car is pinned against it, the other takes the
 * whole push.
 */
export function resolveCollisions(cars: Body[], lanes: LaneSet, edgeWall = false): Contact[] {
  const lim = edgeWall ? lanes.lim : lanes.wall;
  const L = lanes.track.length;
  const out: Contact[] = [];
  const seen = new Set<number>();
  for (let iter = 0; iter < 30; iter++) {
    let any = false;
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const A = cars[i], B = cars[j];
        if (A.cleared || B.cleared) continue;
        let ds = B.st.s - A.st.s;
        if (ds >= L / 2) ds -= L;
        else if (ds < -L / 2) ds += L;
        if (Math.abs(ds) >= HIT_LEN - 1e-9) continue;
        const dd = B.d - A.d;
        if (Math.abs(dd) >= HIT_W - 1e-9) continue;
        any = true;
        // Separate along the axis with the smaller overlap (relative to the footprint size).
        const penS = HIT_LEN - Math.abs(ds), penD = HIT_W - Math.abs(dd);
        const alongS = penS / HIT_LEN <= penD / HIT_W;
        const nx = alongS ? (ds >= 0 ? 1 : -1) : 0, ny = alongS ? 0 : dd >= 0 ? 1 : -1;
        const key = i * 1000 + j;
        if (!seen.has(key)) {
          seen.add(key);
          // Velocity of each car in (s, d): (v_along, vDelta).
          const va = Math.sqrt(Math.max(0, A.st.v * A.st.v - A.st.vDelta * A.st.vDelta)), vb = Math.sqrt(Math.max(0, B.st.v * B.st.v - B.st.vDelta * B.st.vDelta));
          // Sideways relative to the racing line for both (one may be spinning or in the run-off,
          // its sideways speed across the road), converted with the same slope of the line.
          const slope = lanes.lineSlope(A.st.s);
          const closing = (va - vb) * nx + (lineSideSpeed(A.st, lanes, slope) - lineSideSpeed(B.st, lanes, slope)) * ny;
          const angle = alongS ? Math.min(1, Math.abs(dd) / HIT_W) : 1;
          out.push({ a: i, b: j, closing: Math.max(0, closing), angle });
          if (closing > 0 && !(A.fixed && B.fixed)) {
            // Restitution 0.1; a fixed car is an immovable wall, so the other takes all of it.
            const share = A.fixed || B.fixed ? 1 : 0.5;
            const imp = closing * 1.1 * share;
            if (!A.fixed) setVel(A.st, va - imp * nx, A.st.vDelta - imp * ny);
            if (!B.fixed) setVel(B.st, vb + imp * nx, B.st.vDelta + imp * ny);
            // Scrub scales with the hit: cars leaning on each other lose almost nothing per tick.
            const scrub = SCRUB * Math.min(1, closing / 2);
            if (!A.fixed) A.st.v *= 1 - scrub;
            if (!B.fixed) B.st.v *= 1 - scrub;
          }
        }
        if (A.fixed && B.fixed) continue;
        const push = (alongS ? penS : penD) + 1e-6;
        const movedA = A.fixed ? 0 : move(A, lanes, -push / 2 * nx, -push / 2 * ny, L, lim);
        const left = push - movedA;
        if (!B.fixed) move(B, lanes, left * nx, left * ny, L, lim);
        else if (left > 1e-6) move(A, lanes, -left * nx, -left * ny, L, lim);
      }
    }
    if (!any) break;
  }
  return out;
}

function setVel(st: CarState, along: number, side: number): void {
  along = Math.max(0, along);
  st.vDelta = side;
  st.v = Math.hypot(along, side);
}

/** Move a car by (Δs, Δd), respecting the barrier (or the road edge, with incidents off). Returns the distance actually moved. */
function move(c: Body, lanes: LaneSet, dS: number, dD: number, L: number, lim: number): number {
  c.st.s = (((c.st.s + dS) % L) + L) % L;
  c.st.dist += dS;
  const lineD = lanes.lineD(c.st.s);
  const d = clamp(c.d + dD, -lim, lim);
  const movedD = d - c.d;
  c.d = d;
  c.st.delta = d - lineD;
  return Math.hypot(dS, movedD);
}
