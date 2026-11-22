import type { Entrant } from '../core';
import { fmtTime } from './draw';

/**
 * The qualifying panel (no DOM, so it can be tested): each car's session in grid order, from the
 * entrants a qualifying grid made (`Entrant.quali`). Rows can be watched: the viewer re-runs that
 * car's session from its seed.
 */
export interface QualiRow {
  /** Entrant index, which is the grid slot − 1. */
  i: number;
  name: string;
  color: string;
  car: string;
  /** Each timed lap, the best one marked. */
  laps: { text: string; best: boolean }[];
  /** Pole's lap time; the rest as "+gap"; "No time" for a car out of the session. */
  result: string;
  pole: boolean;
  note: string;
}

export interface QualiSummary {
  rows: QualiRow[];
  multiCar: boolean;
  /** How many laps each car had (columns). */
  laps: number;
}

/** null when the grid wasn't set by qualifying. */
export function qualiSummary(field: Entrant[]): QualiSummary | null {
  if (!field.some((e) => e.quali)) return null;
  const pole = Math.min(...field.map((e) => e.gridTime ?? Infinity));
  const laps = Math.max(1, ...field.map((e) => e.quali?.laps.length ?? 0));
  const rows = field.map((e, i): QualiRow => {
    const ls = e.quali?.laps ?? [];
    const best = ls.length ? Math.min(...ls) : NaN;
    const t = e.gridTime;
    return {
      i, name: e.driver.name, color: e.color, car: e.car.id,
      laps: ls.map((x) => ({ text: fmtTime(x), best: x === best })),
      result: t === undefined ? 'No time' : t === pole ? fmtTime(t) : `+${(t - pole).toFixed(3)}`,
      pole: t !== undefined && t === pole,
      note: e.quali?.note ?? '',
    };
  });
  return { rows, multiCar: new Set(field.map((e) => e.car.id)).size > 1, laps };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function qualiHtml(title: string, q: QualiSummary | null): string {
  const hd = `<div class="hd"><span>Qualifying · ${esc(title)}</span><button class="x" title="Close (Esc)">×</button></div>`;
  if (!q) return `${hd}<div class="facts">This grid wasn't set by qualifying. Set the grid to "Qualifying" in the scenario to run a session.</div>`;
  const lapCols = Array.from({ length: q.laps }, (_, k) => `<th class="n">Lap ${k + 1}</th>`).join('');
  const rows = q.rows.map((x, p) => {
    const laps = Array.from({ length: q.laps }, (_, k) => {
      const l = x.laps[k];
      return `<td class="n${l?.best ? ' best' : ''}">${l ? l.text : '–'}</td>`;
    }).join('');
    return `<tr class="${x.result === 'No time' ? 'out' : ''}" data-i="${x.i}">
      <td class="p">${p + 1}</td><td><span class="sw" style="background:${x.color}"></span>${esc(x.name)}</td>
      ${q.multiCar ? `<td class="car">${esc(x.car)}</td>` : ''}${laps}<td class="n${x.pole ? ' purple' : ''}">${x.result}</td>
      <td class="note">${esc(x.note)}</td><td><button class="watch" data-watch="${x.i}" title="Watch this run">▶ Watch</button></td></tr>`;
  }).join('');
  return `${hd}<div class="facts">Each car alone at the limit, ${q.laps} timed laps, best counts. Watch a run to see it.</div>
    <table><thead><tr><th></th><th>Driver</th>${q.multiCar ? '<th>Car</th>' : ''}${lapCols}<th class="n">Best</th><th>Note</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}
