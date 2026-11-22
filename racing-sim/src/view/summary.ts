import { bestSectors, CAR_PRESETS, type CarSpec, classOf, type Race, sectorTimes } from '../core';
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
  /** The lap that set the grid ("1:24.775" for pole, "+0.463" behind it), or '' on an untimed grid. */
  gridTime: string;
  /** Places gained from the grid (negative = lost). */
  gained: number;
  /** Race time for the winner, "+gap" or "+N laps" for the others, "DNF" with the lap for retirements. */
  result: string;
  dnf: boolean;
  best: string;
  /** Holds the fastest lap of its class. */
  fastest: boolean;
  /** Best time in each sector (any lap); `purple` = the best in the car's class. */
  sectors: { text: string; purple: boolean }[];
  /** The sum of those: the lap the driver had in them ('–' until every sector has a time). */
  ideal: string;
  passes: number;
  incidents: number;
}

export interface RaceSummary {
  rows: SummaryRow[];
  /** Show a car column (the field has more than one car). */
  multiCar: boolean;
  /** Show a grid time column (a qualifying or rating grid). */
  timedGrid: boolean;
  passes: number;
  contacts: number;
  incidents: number;
  dnfs: number;
  /**
   * Fastest lap of each class (one entry in a one-class race): the class's short name (''
   * in a one-class race), who, the time and on which lap. Empty if nobody completed a lap.
   */
  fastestLaps: { cls: string; name: string; time: string; lap: number }[];
  /** Most places gained (null if nobody gained any). */
  mover: { name: string; gained: number } | null;
}

const CLASS_LABELS: Record<keyof typeof CAR_PRESETS, string> = { f1: 'F1', lmp: 'LMP', gt3: 'GT3', road: 'Sports car', mx5: 'MX-5', civilian: 'Civilian' };
/** A class's short name: the preset's, or the car id. */
const classLabel = (c: CarSpec) => (c.preset ? CLASS_LABELS[c.preset] : c.id);

const INCIDENT_TYPES = new Set(['off', 'spin', 'crash']);

/** The race is over at viewer frame k: every car has finished or is out, and the viewer has reached the end of the log. */
export const raceOver = (r: Race, k: number) => r.finished && k >= r.frames.length - 1;

export function raceSummary(r: Race): RaceSummary {
  const order = r.orders.length ? [...r.orders[r.orders.length - 1]] : r.order();
  const winner = r.cars[order[0]];
  const lapsOf = (i: number) => r.cars[i].crossTimes.slice(1).map((t, n) => t - r.cars[i].crossTimes[n]);
  // Fastest lap per class: time, by whom, on which lap.
  const fast = new Map<string, { t: number; i: number; lap: number }>();
  r.cars.forEach((c, i) => {
    const k = classOf(c.entrant);
    lapsOf(i).forEach((t, n) => { if (t < (fast.get(k)?.t ?? Infinity)) fast.set(k, { t, i, lap: n + 1 }); });
  });
  const holders = new Set([...fast.values()].map((f) => f.i));
  const classes = new Set(r.cars.map((c) => classOf(c.entrant)));
  const pole = Math.min(...r.cars.map((c) => c.entrant.gridTime ?? Infinity));
  const gridTime = (t: number | undefined) => (t === undefined ? '' : t === pole ? fmtTime(t) : `+${(t - pole).toFixed(3)}`);
  // Best sectors per car, and per class.
  const best = r.cars.map((_, i) => bestSectors(sectorTimes(r, i)));
  const classBest = new Map<string, number[]>();
  r.cars.forEach((c, i) => {
    const k = classOf(c.entrant), cb = classBest.get(k);
    classBest.set(k, cb ? cb.map((t, n) => Math.min(t, best[i][n])) : [...best[i]]);
  });
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
      grid: i + 1, gridTime: gridTime(c.entrant.gridTime), gained: i - p, result, dnf: c.dnf,
      best: laps.length ? fmtTime(Math.min(...laps)) : '–', fastest: holders.has(i),
      sectors: best[i].map((t, n) => ({ text: Number.isFinite(t) ? t.toFixed(3) : '–', purple: Number.isFinite(t) && t <= classBest.get(classOf(c.entrant))![n] })),
      ideal: best[i].every(Number.isFinite) ? fmtTime(best[i].reduce((a, b) => a + b, 0)) : '–',
      passes: count(i, (t) => t === 'pass'), incidents: count(i, (t) => INCIDENT_TYPES.has(t)),
    };
  });
  const top = rows.filter((x) => !x.dnf).reduce<SummaryRow | null>((b, x) => (x.gained > (b?.gained ?? 0) ? x : b), null);
  return {
    rows,
    multiCar: new Set(r.cars.map((c) => c.entrant.car.id)).size > 1,
    timedGrid: pole < Infinity,
    passes: r.events.filter((e) => e.type === 'pass').length,
    contacts: r.events.filter((e) => e.type === 'contact').length,
    incidents: r.events.filter((e) => INCIDENT_TYPES.has(e.type)).length,
    dnfs: r.cars.filter((c) => c.dnf).length,
    fastestLaps: [...fast.values()].sort((a, b) => a.t - b.t).map((f) => ({
      cls: classes.size > 1 ? classLabel(r.cars[f.i].entrant.car) : '',
      name: r.cars[f.i].entrant.driver.name, time: fmtTime(f.t), lap: f.lap,
    })),
    mover: top ? { name: top.name, gained: top.gained } : null,
  };
}

/** The summary as HTML for the overlay panel. */
export function summaryHtml(title: string, s: RaceSummary): string {
  const gained = (g: number) => (g > 0 ? `<span class="up">▲${g}</span>` : g < 0 ? `<span class="dn">▼${-g}</span>` : '<span class="eq">–</span>');
  const rows = s.rows.map((x) => `<tr class="${x.dnf ? 'out' : ''}" data-i="${x.i}">
    <td class="p">${x.dnf ? '' : x.pos}</td><td><span class="sw" style="background:${x.color}"></span>${x.name}</td>
    ${s.multiCar ? `<td class="car">${x.car}</td>` : ''}<td class="n">${x.grid}</td>${s.timedGrid ? `<td class="n">${x.gridTime}</td>` : ''}<td class="n">${gained(x.gained)}</td>
    <td class="n">${x.result}</td><td class="n${x.fastest ? ' purple' : ''}">${x.best}</td>${x.sectors.map((c) => `<td class="n sec${c.purple ? ' purple' : ''}">${c.text}</td>`).join('')}<td class="n">${x.ideal}</td><td class="n">${x.passes || ''}</td><td class="n">${x.incidents || ''}</td></tr>`).join('');
  const facts = [
    s.fastestLaps.map((f) => `Fastest lap${f.cls ? ` (${f.cls})` : ''} <b>${f.name}</b> ${f.time} (L${f.lap})`).join(' · '),
    s.mover ? `Most places gained <b>${s.mover.name}</b> +${s.mover.gained}` : '',
    `${s.passes} pass${s.passes === 1 ? '' : 'es'} · ${s.contacts} contact${s.contacts === 1 ? '' : 's'} · ${s.incidents} incident${s.incidents === 1 ? '' : 's'} · ${s.dnfs} DNF`,
  ].filter(Boolean).map((f) => `<div>${f}</div>`).join('');
  return `<div class="hd"><span>Result · ${title}</span><button class="x" title="Close (Esc)">×</button></div>
    <div class="facts">${facts}</div>
    <table><thead><tr><th></th><th>Driver</th>${s.multiCar ? '<th>Car</th>' : ''}<th class="n">Grid</th>${s.timedGrid ? '<th class="n" title="The lap that set the grid">Quali</th>' : ''}<th class="n">+/−</th><th class="n">Time</th><th class="n">Best</th><th class="n" title="Best sector 1 (purple: best in class)">S1</th><th class="n" title="Best sector 2">S2</th><th class="n" title="Best sector 3">S3</th><th class="n" title="Best sectors added up">Ideal</th><th class="n" title="Passes made">Pass</th><th class="n" title="Offs, spins and crashes">Inc</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}
