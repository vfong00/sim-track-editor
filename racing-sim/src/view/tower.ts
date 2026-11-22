import type { RaceAt } from './at';
import { fmtTime } from './draw';

/**
 * What the timing tower's right-hand column shows (no DOM, so it can be tested). It cycles
 * through gap to the leader, interval to the car ahead, last lap and best lap.
 */
export type TowerMode = 'gap' | 'interval' | 'last' | 'best';
export const TOWER_MODES: TowerMode[] = ['gap', 'interval', 'last', 'best'];
export const TOWER_LABEL: Record<TowerMode, string> = { gap: 'Gap', interval: 'Interval', last: 'Last lap', best: 'Best lap' };
/** Auto-rotation period, and how long a click holds the chosen mode before rotation resumes (wall-clock seconds). */
export const TOWER_ROTATE = 6;
export const TOWER_HOLD = 30;

export const nextMode = (m: TowerMode): TowerMode => TOWER_MODES[(TOWER_MODES.indexOf(m) + 1) % TOWER_MODES.length];

/** Race distance at the viewer clock (a finished car: its finishing distance). */
export function distAt(at: RaceAt, i: number): number {
  const c = at.r.cars[i];
  return at.finished(i) ? c.finishLaps * at.r.track.length : at.dist(i);
}

/** Time behind car `ahead`, or whole laps down ("+1 lap") if a lap or more behind in distance. */
function behind(at: RaceAt, i: number, ahead: number): string {
  // Lapped only if a whole lap behind in distance, not just across the line.
  const L = at.r.track.length;
  const down = distAt(at, ahead) - distAt(at, i);
  if (down >= L) return `+${Math.floor(down / L)} lap`;
  const g = at.gap(i, ahead);
  return isFinite(g) ? `+${g.toFixed(3)}` : '';
}

/** The fastest lap anyone has set so far (Infinity if none). */
export function fastestLap(at: RaceAt): number {
  let best = Infinity;
  for (let i = 0; i < at.r.cars.length; i++) for (const t of at.lapTimes(i)) best = Math.min(best, t);
  return best;
}

/**
 * The tower cell for the car in position p (0-based) of `order`. `purple` marks the race's
 * fastest lap (best-lap mode) or a last lap that is it.
 */
export function towerCell(at: RaceAt, order: number[], p: number, mode: TowerMode, fastest = fastestLap(at)): { text: string; purple: boolean } {
  const i = order[p];
  if (mode === 'gap' || mode === 'interval') {
    if (p === 0) return { text: at.finished(i) ? 'Winner' : 'Leader', purple: false };
    return { text: behind(at, i, mode === 'gap' ? order[0] : order[p - 1]), purple: false };
  }
  const laps = at.lapTimes(i);
  if (!laps.length) return { text: '–', purple: false };
  const t = mode === 'last' ? laps[laps.length - 1] : Math.min(...laps);
  return { text: fmtTime(t), purple: t === fastest };
}
