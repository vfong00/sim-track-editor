import type { CarState } from './car';
import { CAR_RADIUS, clamp, type LaneSet } from './lanes';

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
 * Circle collisions in the (s, d) frame: overlapping cars are pushed apart along the line
 * between their centres, their closing speed along that line is removed (nearly inelastic)
 * and both scrub a little speed. Repeats until nothing overlaps. The road clamp still
 * applies; if one car is pinned against the edge, the other takes the whole push.
 */
export function resolveCollisions(cars: Body[], lanes: LaneSet): Contact[] {
  const L = lanes.track.length;
  const min = 2 * CAR_RADIUS;
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
        if (Math.abs(ds) >= min) continue;
        const dd = B.d - A.d;
        const dist = Math.hypot(ds, dd);
        if (dist >= min - 1e-9) continue;
        any = true;
        // Unit normal from A to B (in s, d); if exactly on top of each other, split along s.
        const nx = dist > 1e-9 ? ds / dist : 1, ny = dist > 1e-9 ? dd / dist : 0;
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
        const push = min - dist + 1e-6;
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
