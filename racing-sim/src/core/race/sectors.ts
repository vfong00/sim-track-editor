import type { Entrant } from '../agents/driver';
import type { Race } from './race';

/**
 * Sector times, worked out from each car's checkpoints (`RaceCar.cp`), so they need nothing
 * from the race beyond what it already logs. Every class crosses the same timing lines
 * (`Race.sectorEnds`); only the colours compare within a class.
 */

/** Sectors in a lap. */
export const SECTORS = 3;

/**
 * Car i's sector times, lap by lap (lap 1 first, from the start line), each [S1, S2, S3]: NaN for
 * a sector not finished by time `until`. Laps it hasn't started by then are left out.
 */
export function sectorTimes(r: Race, i: number, until = Infinity): number[][] {
  const L = r.track.length;
  const ends = r.sectorEnds;
  const ct = r.cars[i].crossTimes;
  // At the line, the logged crossing (so the sectors add up to the lap time exactly); between,
  // the checkpoints.
  const when = (lap: number, k: number) => (k === SECTORS - 1 && lap + 1 < ct.length ? ct[lap + 1] : r.timeAt(i, lap * L + ends[k]));
  const out: number[][] = [];
  for (let lap = 0; ; lap++) {
    const t0 = lap < ct.length ? ct[lap] : NaN;
    if (!(t0 <= until)) break;
    const row: number[] = [];
    let prev = t0;
    for (let k = 0; k < SECTORS; k++) {
      const t = when(lap, k);
      row.push(t <= until ? t - prev : NaN);
      prev = t;
    }
    out.push(row);
    if (lap + 1 >= r.laps) break;
  }
  return out;
}

/** Each sector's best time in a set of laps (Infinity where none was finished). */
export function bestSectors(laps: number[][]): number[] {
  const best = Array<number>(SECTORS).fill(Infinity);
  for (const row of laps) row.forEach((t, k) => { if (t < best[k]) best[k] = t; });
  return best;
}

/** The class a car races in, for the colours: its preset, or its own id without one. */
export const classOf = (e: Entrant): string => e.car.preset ?? e.car.id;

/**
 * Sector colour, as on a timing screen: 'purple' = the fastest in class so far, 'green' = the
 * driver's own best, 'yellow' = slower than that, 'none' = not run yet.
 */
export type SectorColor = 'purple' | 'green' | 'yellow' | 'none';

export function sectorColor(t: number, own: number, classBest: number): SectorColor {
  if (!Number.isFinite(t)) return 'none';
  if (t <= classBest) return 'purple';
  if (t <= own) return 'green';
  return 'yellow';
}
