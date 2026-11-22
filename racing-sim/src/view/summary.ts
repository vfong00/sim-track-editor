import type { Race } from '../core';
import { fmtTime } from './draw';

/**
 * The end-of-race summary (no DOM, so it can be tested): classification with gaps, best laps,
 * places gained from the grid, passes made and incidents, plus the race's headline numbers.
 * Read from the logs only (rule 4).
 */
export interface SummaryRow {
  /** Entrant index. */
  i: number;
  /** Classified position (1-based; DNFs are classified behind the finishers). */
  pos: number;
  name: string;
  color: string;
  car: string;
  grid: number;
  /** Places gained from the grid (negative = lost). */
  gained: number;
  /** Race time for the winner, "+gap" or "+N laps" for the others, "DNF" with the lap for retirements. */
  result: string;
  dnf: boolean;
  best: string;
  /** Holds the race's fastest lap. */
  fastest: boolean;
  passes: number;
  incidents: number;
}

export interface RaceSummary {
  rows: SummaryRow[];
  /** Show a car column (the field has more than one car). */
  multiCar: boolean;
  passes: number;
  contacts: number;
  incidents: number;
  dnfs: number;
  /** Fastest lap of the race: who, the time and on which lap (null if nobody completed a lap). */
  fastestLap: { name: string; time: string; lap: number } | null;
  /** Most places gained (null if nobody gained any). */
  mover: { name: string; gained: number } | null;
}

const INCIDENT_TYPES = new Set(['off', 'spin', 'crash']);

/** The race is over at viewer frame k: every car has finished or is out, and the viewer has reached the end of the log. */
export const raceOver = (r: Race, k: number) => r.finished && k >= r.frames.length - 1;

export function raceSummary(r: Race): RaceSummary {
  const order = r.orders.length ? [...r.orders[r.orders.length - 1]] : r.order();
  const winner = r.cars[order[0]];
  const lapsOf = (i: number) => r.cars[i].crossTimes.slice(1).map((t, n) => t - r.cars[i].crossTimes[n]);
  let fastest = Infinity, fastestBy = -1, fastestLap = 0;
  r.cars.forEach((_, i) => lapsOf(i).forEach((t, n) => { if (t < fastest) { fastest = t; fastestBy = i; fastestLap = n + 1; } }));
  const count = (i: number, f: (type: string) => boolean) => r.events.filter((e) => f(e.type) && e.cars[0] === i).length;
  const rows = order.map((i, p): SummaryRow => {
    const c = r.cars[i];
    const laps = lapsOf(i);
    let result: string;
    if (c.dnf) result = `DNF · L${Math.min(r.laps, laps.length + 1)}`;
    else if (p === 0) result = fmtTime(c.finishTime);
    else {
      const down = winner.finishLaps - c.finishLaps;
      result = down >= 1 ? `+${down} lap${down > 1 ? 's' : ''}` : `+${(c.finishTime - winner.finishTime).toFixed(3)}`;
    }
    return {
      i, pos: p + 1, name: c.entrant.driver.name, color: c.entrant.color, car: c.entrant.car.id,
      grid: i + 1, gained: i - p, result, dnf: c.dnf,
      best: laps.length ? fmtTime(Math.min(...laps)) : '–', fastest: i === fastestBy,
      passes: count(i, (t) => t === 'pass'), incidents: count(i, (t) => INCIDENT_TYPES.has(t)),
    };
  });
  const top = rows.filter((x) => !x.dnf).reduce<SummaryRow | null>((b, x) => (x.gained > (b?.gained ?? 0) ? x : b), null);
  return {
    rows,
    multiCar: new Set(r.cars.map((c) => c.entrant.car.id)).size > 1,
    passes: r.events.filter((e) => e.type === 'pass').length,
    contacts: r.events.filter((e) => e.type === 'contact').length,
    incidents: r.events.filter((e) => INCIDENT_TYPES.has(e.type)).length,
    dnfs: r.cars.filter((c) => c.dnf).length,
    fastestLap: fastestBy >= 0 ? { name: r.cars[fastestBy].entrant.driver.name, time: fmtTime(fastest), lap: fastestLap } : null,
    mover: top ? { name: top.name, gained: top.gained } : null,
  };
}

/** The summary as HTML for the overlay panel. */
export function summaryHtml(title: string, s: RaceSummary): string {
  const gained = (g: number) => (g > 0 ? `<span class="up">▲${g}</span>` : g < 0 ? `<span class="dn">▼${-g}</span>` : '<span class="eq">–</span>');
  const rows = s.rows.map((x) => `<tr class="${x.dnf ? 'out' : ''}" data-i="${x.i}">
    <td class="p">${x.dnf ? '' : x.pos}</td><td><span class="sw" style="background:${x.color}"></span>${x.name}</td>
    ${s.multiCar ? `<td class="car">${x.car}</td>` : ''}<td class="n">${x.grid}</td><td class="n">${gained(x.gained)}</td>
    <td class="n">${x.result}</td><td class="n${x.fastest ? ' purple' : ''}">${x.best}</td><td class="n">${x.passes || ''}</td><td class="n">${x.incidents || ''}</td></tr>`).join('');
  const facts = [
    s.fastestLap ? `Fastest lap <b>${s.fastestLap.name}</b> ${s.fastestLap.time} (L${s.fastestLap.lap})` : '',
    s.mover ? `Most places gained <b>${s.mover.name}</b> +${s.mover.gained}` : '',
    `${s.passes} pass${s.passes === 1 ? '' : 'es'} · ${s.contacts} contact${s.contacts === 1 ? '' : 's'} · ${s.incidents} incident${s.incidents === 1 ? '' : 's'} · ${s.dnfs} DNF`,
  ].filter(Boolean).map((f) => `<div>${f}</div>`).join('');
  return `<div class="hd"><span>Result · ${title}</span><button class="x" title="Close (Esc)">×</button></div>
    <div class="facts">${facts}</div>
    <table><thead><tr><th></th><th>Driver</th>${s.multiCar ? '<th>Car</th>' : ''}<th class="n">Grid</th><th class="n">+/−</th><th class="n">Time</th><th class="n">Best</th><th class="n" title="Passes made">Pass</th><th class="n" title="Offs, spins and crashes">Inc</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}
