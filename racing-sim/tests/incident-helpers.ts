import { FRAME_STRIDE, INCIDENTS, type Race, type RaceEvent } from '../src/core';

const ROOTS = new Set(['slide', 'mistake', 'contact']);

/**
 * Follow an incident's cause chain back to its root. Returns a reason it is unexplained, or ''
 * if it ends at a slide, mistake or contact involving the same car, each link earlier (or the
 * same tick) and recent enough to blame.
 */
export function unexplained(r: Race, k: number): string {
  const e = r.events[k];
  const car = e.cars[0];
  let cur: RaceEvent = e;
  for (let hops = 0; hops < 5; hops++) {
    if (cur.cause === undefined) return `${e.text}: no cause (at ${cur.type})`;
    const c = r.events[cur.cause];
    if (c.t > cur.t) return `${e.text}: cause after it`;
    if (!c.cars.includes(car)) return `${e.text}: cause "${c.text}" is another car's`;
    if (ROOTS.has(c.type)) return cur.t - c.t <= INCIDENTS.causeWindow ? '' : `${e.text}: cause "${c.text}" too old`;
    // Chains go through an off (a crash in the barrier after running off).
    if (c.type !== 'off') return `${e.text}: cause is a ${c.type}`;
    cur = c;
  }
  return `${e.text}: cause chain too long`;
}

/** Incident events (off, spin, crash) of a race, with their indices. */
export const incidentIdx = (r: Race) =>
  r.events.map((e, k) => (e.type === 'off' || e.type === 'spin' || e.type === 'crash' ? k : -1)).filter((k) => k >= 0);

/**
 * Ticks (as "car@time") where a car is off the road (centre past the edge) without an open
 * logged off: every excursion must be an incident on record.
 */
export function unloggedOffTicks(r: Race): string[] {
  const half = r.track.width / 2;
  const n = r.cars.length;
  // Per car, the time intervals [off, rejoin) of logged excursions (a rejoin's cause is its off).
  const open: [number, number][][] = Array.from({ length: n }, () => []);
  const byOff = new Map<number, [number, number]>();
  r.events.forEach((e, k) => {
    if (e.type === 'off') { const iv: [number, number] = [e.t, Infinity]; open[e.cars[0]].push(iv); byOff.set(k, iv); }
    if (e.type === 'rejoin') byOff.get(e.cause!)![1] = e.t;
  });
  const bad: string[] = [];
  r.frames.forEach((f, k) => {
    const t = k * r.dt;
    for (let i = 0; i < n; i++) {
      if (Math.abs(f[i * FRAME_STRIDE + 1]) <= half + 1e-4) continue;
      if (!open[i].some(([a, b]) => t >= a - r.dt / 2 && t < b + r.dt / 2)) bad.push(`${r.name(i)}@${t.toFixed(2)}`);
    }
  });
  return bad;
}

/** Off, spin and crash count (incidents per race). */
export const incidentCount = (r: Race) => incidentIdx(r).length;

/**
 * Incidents a driver brings on themselves: those whose root cause is their own slide or mistake
 * (not contact, which is as much the other car's doing).
 */
export function ownIncidentCount(r: Race): number {
  let n = 0;
  for (const k of incidentIdx(r)) {
    let e = r.events[k];
    while (e.cause !== undefined && r.events[e.cause].type === 'off') e = r.events[e.cause];
    if (e.cause !== undefined && (r.events[e.cause].type === 'slide' || r.events[e.cause].type === 'mistake')) n++;
  }
  return n;
}
