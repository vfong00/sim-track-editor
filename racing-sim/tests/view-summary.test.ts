import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadScenario, Race, type Scenario } from '../src/core';
import { raceOver, raceSummary, summaryHtml } from '../src/view/summary';

const scenario = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/scenarios/${f}`, import.meta.url), 'utf8'));

describe('end-of-race summary', () => {
  const r = new Race(loadScenario(scenario('random-field.json')).options).run();
  const s = raceSummary(r);

  it('is only over at the end of the log', () => {
    expect(raceOver(r, r.frames.length - 1)).toBe(true);
    expect(raceOver(r, r.frames.length - 2)).toBe(false);
  });

  it('classifies every car once, in the race order, finishers first', () => {
    expect(s.rows.map((x) => x.i)).toEqual(r.order());
    expect(new Set(s.rows.map((x) => x.i)).size).toBe(r.cars.length);
    const firstDnf = s.rows.findIndex((x) => x.dnf);
    if (firstDnf >= 0) expect(s.rows.slice(firstDnf).every((x) => x.dnf)).toBe(true);
    expect(s.rows[0].result).toMatch(/^\d+:\d\d\.\d{3}$/);
    for (const x of s.rows.slice(1).filter((x) => !x.dnf)) expect(x.result).toMatch(/^\+(\d+\.\d{3}|\d+ laps?)$/);
  });

  it('places gained add up to zero and match grid minus finish', () => {
    expect(s.rows.reduce((a, x) => a + x.gained, 0)).toBe(0);
    for (const x of s.rows) expect(x.gained).toBe(x.grid - x.pos);
  });

  it('counts passes, incidents and the fastest lap from the event log', () => {
    expect(s.rows.reduce((a, x) => a + x.passes, 0)).toBe(s.passes);
    expect(s.rows.reduce((a, x) => a + x.incidents, 0)).toBe(s.incidents);
    expect(s.passes).toBe(r.stats().passes);
    expect(s.rows.filter((x) => x.fastest)).toHaveLength(1);
    const best = Math.min(...r.cars.flatMap((c) => c.lapTimes));
    expect(s.fastestLaps).toHaveLength(1);
    expect(s.fastestLaps[0].cls).toBe('');
    expect(s.fastestLaps[0].name).toBe(s.rows.find((x) => x.fastest)!.name);
    expect(s.fastestLaps[0].time).toBe(s.rows.find((x) => x.fastest)!.best);
    expect(best).toBeGreaterThan(0);
  });

  it('renders one table row per car', () => {
    expect(summaryHtml('t', s).match(/<tr class="[^"]*" data-i=/g)).toHaveLength(r.cars.length);
  });

  it('shows grid times only for a timed grid: pole as a lap time, the rest as gaps to it', () => {
    expect(s.timedGrid).toBe(false);
    expect(summaryHtml('t', s)).not.toContain('Quali');
    const data = scenario('random-field.json');
    const q = raceSummary(new Race(loadScenario({ ...data, race: { ...data.race, laps: 1, gridOrder: 'qualifying' } }).options).run());
    expect(q.timedGrid).toBe(true);
    const byGrid = [...q.rows].sort((a, b) => a.grid - b.grid);
    expect(byGrid[0].gridTime).toMatch(/^\d+:\d\d\.\d{3}$/);
    for (const x of byGrid.slice(1)) expect(x.gridTime).toMatch(/^\+\d+\.\d{3}$/);
    expect(summaryHtml('t', q)).toContain('Quali');
  });
});

describe('qualifying panel', () => {
  it('lists each run in grid order with laps, the best marked, pole as a time and the rest as gaps', async () => {
    const { qualiSummary, qualiHtml } = await import('../src/view/quali');
    const data = scenario('random-field.json');
    const r = new Race(loadScenario({ ...data, race: { ...data.race, laps: 1, gridOrder: 'qualifying' } }).options);
    const q = qualiSummary(r.opts.entrants)!;
    expect(q.rows).toHaveLength(r.cars.length);
    expect(q.rows[0].pole).toBe(true);
    for (const x of q.rows.slice(1)) expect(x.result).toMatch(/^\+\d+\.\d{3}$|^No time$/);
    for (const x of q.rows) if (x.laps.length) expect(x.laps.filter((l) => l.best).length).toBeGreaterThanOrEqual(1);
    expect(qualiHtml('t', q).match(/data-watch=/g)).toHaveLength(r.cars.length);
    // An untimed grid has no session to show.
    expect(qualiSummary(new Race(loadScenario(data).options).opts.entrants)).toBeNull();
  });
});

describe('fastest lap per class', () => {
  it('a multi-class race marks the fastest lap of each class, in the tower and the result', async () => {
    const { towerCell, fastestLaps } = await import('../src/view/tower');
    const { RaceAt } = await import('../src/view/at');
    const scn = JSON.parse(readFileSync(new URL('./fixtures/scenarios/equal-field.json', import.meta.url).pathname, 'utf8')) as Scenario;
    const r = new Race(loadScenario({
      ...scn,
      cars: [{ id: 'fast', preset: 'gt3' }, { id: 'slow', preset: 'mx5' }],
      drivers: [{ name: 'A', car: 'fast' }, { name: 'B', car: 'fast' }, { name: 'C', car: 'slow' }, { name: 'D', car: 'slow' }],
      field: undefined,
      race: { laps: 3 },
    }).options).run();
    const at = new RaceAt(r, r.t);
    expect(fastestLaps(at).size).toBe(2);
    const order = [...r.orders[at.k]];
    const purple = order.map((_, p) => towerCell(at, order, p, 'best').purple);
    expect(purple.filter(Boolean)).toHaveLength(2);
    const s = raceSummary(r);
    expect(s.rows.filter((x) => x.fastest)).toHaveLength(2);
    expect(s.fastestLaps.map((f) => f.cls)).toEqual(['GT3', 'MX-5']);
  });
});
