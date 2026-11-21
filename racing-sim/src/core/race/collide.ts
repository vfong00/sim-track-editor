import type { CarState } from './car';
import { clamp, HIT_LEN, HIT_W, type LaneSet } from './lanes';

export interface Contact {
  a: number;
  b: number;
  /** Closing speed along the line between centres before the hit (m/s). */
  closing: number;
}

interface Body {
  st: CarState;
  d: number;
}

/** Speed lost by both cars in a contact (fraction), on top of the inelastic exchange. */
const SCRUB = 0.03;

/**
 * Rectangle collisions in the (s, d) frame (cars are roughly aligned with the road): overlapping
 * cars are pushed apart along the axis of least overlap (nose-to-tail along s, side-by-side
 * along d), their closing speed along that axis is removed (nearly inelastic)
 * and both scrub a little speed. Repeats until nothing overlaps. The road clamp still
 * applies; if one car is pinned against the edge, the other takes the whole push.
 */
export function resolveCollisions(cars: Body[], lanes: LaneSet): Contact[] {
  const L = lanes.track.length;
  const out: Contact[] = [];
  const seen = new Set<number>();
  for (let iter = 0; iter < 30; iter++) {
    let any = false;
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const A = cars[i], B = cars[j];
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
          const va = Math.sqrt(Math.max(0, A.st.v ** 2 - A.st.vDelta ** 2)), vb = Math.sqrt(Math.max(0, B.st.v ** 2 - B.st.vDelta ** 2));
          const closing = (va - vb) * nx + (A.st.vDelta - B.st.vDelta) * ny;
          out.push({ a: i, b: j, closing: Math.max(0, closing) });
          if (closing > 0) {
            const imp = (closing * 1.1) / 2; // restitution 0.1
            setVel(A.st, va - imp * nx, A.st.vDelta - imp * ny);
            setVel(B.st, vb + imp * nx, B.st.vDelta + imp * ny);
            A.st.v *= 1 - SCRUB;
            B.st.v *= 1 - SCRUB;
          }
        }
        const push = (alongS ? penS : penD) + 1e-6;
        const movedA = move(A, lanes, -push / 2 * nx, -push / 2 * ny, L);
        const left = push - movedA;
        move(B, lanes, left * nx, left * ny, L);
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

/** Move a car by (Δs, Δd), respecting the road edge. Returns the distance actually moved. */
function move(c: Body, lanes: LaneSet, dS: number, dD: number, L: number): number {
  c.st.s = (((c.st.s + dS) % L) + L) % L;
  c.st.dist += dS;
  const lineD = lanes.lineD(c.st.s);
  const d = clamp(c.d + dD, -lanes.lim, lanes.lim);
  const movedD = d - c.d;
  c.d = d;
  c.st.delta = d - lineD;
  return Math.hypot(dS, movedD);
}
