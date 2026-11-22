import { bestSectors, classOf, SECTORS, type SectorColor, sectorColor, sectorTimes } from '../core';
import type { RaceAt } from './at';
import { fmtTime } from './draw';

/**
 * What the timing tower's right-hand column shows (no DOM, so it can be tested). It cycles
 * through gap to the leader, interval to the car ahead, last lap, best lap and sectors.
 */
export type TowerMode = 'gap' | 'interval' | 'last' | 'best' | 'sectors';
export const TOWER_MODES: TowerMode[] = ['gap', 'interval', 'last', 'best', 'sectors'];
export const TOWER_LABEL: Record<TowerMode, string> = { gap: 'Gap', interval: 'Interval', last: 'Last lap', best: 'Best lap', sectors: 'Sectors' };
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

/**
 * Sector timing at the viewer clock, for the tower's sector mode and the follow panel: every
 * car's sector times so far (lap by lap), its own best in each sector, and the best in each
 * class (`classOf`). Colours compare a time with the bests so far, which include it.
 */
export interface SectorBoard {
  laps: number[][][];
  own: number[][];
  cls: string[];
  classBest: Map<string, number[]>;
}

export function sectorBoard(at: RaceAt): SectorBoard {
  const r = at.r;
  const laps = r.cars.map((_, i) => sectorTimes(r, i, at.t));
  const own = laps.map(bestSectors);
  const cls = r.cars.map((c) => classOf(c.entrant));
  const classBest = new Map<string, number[]>();
  own.forEach((b, i) => {
    const cb = classBest.get(cls[i]);
    if (!cb) classBest.set(cls[i], [...b]);
    else b.forEach((t, k) => { if (t < cb[k]) cb[k] = t; });
  });
  return { laps, own, cls, classBest };
}

export interface SectorCell {
  /**
   * The lap's sectors: the current lap once its first sector is done, until then the lap just
   * finished (so its last sector's colour shows for a whole sector). A finished car: its last lap.
   */
  times: number[];
  colors: SectorColor[];
  /** The latest sector finished (this lap or the end of the last): "S2 28.412", or '' before any. */
  text: string;
  textColor: SectorColor;
}

export function sectorCell(b: SectorBoard, i: number): SectorCell {
  const laps = b.laps[i];
  const cb = b.classBest.get(b.cls[i])!;
  const color = (t: number, k: number) => sectorColor(t, b.own[i][k], cb[k]);
  let cur = laps[laps.length - 1] ?? [NaN, NaN, NaN];
  if (!Number.isFinite(cur[0]) && laps.length > 1) cur = laps[laps.length - 2];
  const colors = cur.map(color);
  let text = '', textColor: SectorColor = 'none';
  // The latest finished sector: in the current lap, else the last sector of the lap before.
  for (let n = laps.length - 1; n >= 0 && !text; n--) {
    for (let k = SECTORS - 1; k >= 0; k--) {
      if (Number.isFinite(laps[n][k])) {
        text = `S${k + 1} ${laps[n][k].toFixed(3)}`;
        textColor = color(laps[n][k], k);
        break;
      }
    }
  }
  return { times: cur, colors, text, textColor };
}

/**
 * Car i's time against its best lap at the same point of the lap (s; negative = ahead of it), at
 * the last checkpoint it passed. NaN without a finished lap or before the start line.
 */
export function deltaToBest(at: RaceAt, i: number): number {
  const r = at.r;
  const L = r.track.length;
  const laps = at.lapTimes(i);
  const n = at.crossings(i);
  if (!laps.length || n < 0 || at.finished(i)) return NaN;
  const best = laps.indexOf(Math.min(...laps));
  const dist = at.dist(i);
  const x = dist - n * L;
  if (x < 0 || x >= L) return NaN;
  const ct = r.cars[i].crossTimes;
  const now = r.timeAt(i, dist) - ct[n];
  const then = r.timeAt(i, best * L + x) - ct[best];
  return now - then;
}
