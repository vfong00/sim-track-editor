import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bestSectors, buildTrack, formatError, loadScenario, parseScenario, Race, type Scenario, ScenarioBuildError, sectorColor, sectorTimes, trackKey,
} from '../src/core';
import { RaceAt } from '../src/view/at';
import { qualiSummary } from '../src/view/quali';
import { raceSummary } from '../src/view/summary';
import { deltaToBest, sectorBoard, sectorCell } from '../src/view/tower';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/scenarios/${name}.json`, import.meta.url).pathname, 'utf8')) as Scenario;

describe('sector times', () => {
  const scn = fixture('equal-field');
  const race = new Race(loadScenario(scn).options).run();

  it('default to thirds of the lap', () => {
    const L = race.track.length;
    expect(race.sectorEnds).toEqual([L / 3, (2 * L) / 3, L]);
  });

  it("add up to each finished lap's time", () => {
    race.cars.forEach((c, i) => {
      const secs = sectorTimes(race, i);
      c.lapTimes.forEach((t, n) => {
        expect(secs[n].every((x) => x > 0)).toBe(true);
        expect(secs[n].reduce((a, b) => a + b, 0)).toBeCloseTo(t, 6);
      });
    });
  });

  it('a sector not reached by the viewer clock has no time yet', () => {
    const c = race.cars[0];
    const midLap2 = (c.crossTimes[1] + c.crossTimes[2]) / 2;
    const secs = sectorTimes(race, 0, midLap2);
    expect(secs).toHaveLength(2);
    expect(secs[0].every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(secs[1][2])).toBe(false);
  });

  it('follow the lines a scenario sets, and change nothing in the race', () => {
    const L = race.track.length;
    const cut: [number, number] = [Math.round(L * 0.2), Math.round(L * 0.5)];
    const r2 = new Race(loadScenario({ ...scn, track: { ...scn.track, sectors: cut } }).options).run();
    expect(r2.sectorEnds).toEqual([...cut, L]);
    expect(r2.cars.map((c) => c.lapTimes)).toEqual(race.cars.map((c) => c.lapTimes));
    const s = sectorTimes(r2, 0)[1];
    expect(s[0]).toBeLessThan(s[1]); // 20% of the lap vs 30%
  });

  it('colour like a timing screen', () => {
    expect(sectorColor(30, 30, 30)).toBe('purple');
    expect(sectorColor(30.2, 30.2, 30)).toBe('green');
    expect(sectorColor(30.4, 30.2, 30)).toBe('yellow');
    expect(sectorColor(NaN, 30.2, 30)).toBe('none');
    expect(bestSectors([[1, 5, 3], [2, 4, NaN]])).toEqual([1, 4, 3]);
  });
});

describe('sectors in the scenario file', () => {
  const scn = fixture('equal-field');
  const errorsOf = (sectors: unknown) => {
    const res = parseScenario({ ...scn, track: { ...scn.track, sectors } });
    return res.ok ? [] : res.errors.map(formatError);
  };

  it('must be two increasing distances past the line', () => {
    expect(errorsOf([400, 900])).toEqual([]);
    expect(errorsOf([400])[0]).toMatch(/^track\.sectors: must be \[end of sector 1, end of sector 2\]/);
    expect(errorsOf([0, 900])).toEqual(['track.sectors: sector 1 must end after the start line']);
    expect(errorsOf([900, 400])).toEqual(['track.sectors: sector 2 must end after sector 1']);
  });

  it('must fall inside the lap, checked once the track is built', () => {
    let caught: unknown;
    try { buildTrack({ ...scn.track, sectors: [400, 1e6] }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ScenarioBuildError);
    expect((caught as ScenarioBuildError).errors[0].path).toBe('track.sectors');
  });

  it("don't change the track's cache key (they aren't part of its shape)", () => {
    expect(trackKey({ ...scn.track, sectors: [400, 900] })).toBe(trackKey(scn.track));
  });
});

describe('sectors in the viewer', () => {
  const race = new Race(loadScenario(fixture('equal-field')).options).run();

  it('the tower shows the current lap, with the class best in purple', () => {
    const c = race.cars[0];
    const at = new RaceAt(race, (c.crossTimes[2] + c.crossTimes[3]) / 2);
    const board = sectorBoard(at);
    const cells = race.cars.map((_, i) => sectorCell(board, i));
    // Every car has a first sector to show (this lap's, or its last lap's if only just onto lap 3).
    for (const cell of cells) expect(cell.colors[0]).not.toBe('none');
    // One purple per sector over the field's laps so far (ties aside), and not on a sector not yet run.
    for (let k = 0; k < 3; k++) {
      const best = Math.min(...board.own.map((o) => o[k]));
      expect(best).toBe(board.classBest.get(board.cls[0])![k]);
    }
    // Running with car 0 (onto lap 3 within 5 s of it): sector 3 of this lap not run yet. A car
    // held up on lap 1 is still on lap 2, or only just onto lap 3 (showing its last lap still),
    // and a retired car shows the last lap it ran.
    const onLap3 = cells.filter((_, i) => !race.cars[i].dnf && race.cars[i].crossTimes[2] <= c.crossTimes[2] + 5);
    expect(onLap3.length).toBeGreaterThan(1);
    expect(onLap3.every((x) => x.colors[2] === 'none')).toBe(true);
    expect(cells[0].text).toMatch(/^S\d \d+\.\d{3}$/);
  });

  it('purple is per class: a slower class has its own fastest sectors', () => {
    const scn = fixture('equal-field');
    const multi = new Race(loadScenario({
      ...scn,
      cars: [{ id: 'standard' }, { id: 'quick', grip: 1.25 }],
      drivers: [{ name: 'A', car: 'quick' }, { name: 'B', car: 'quick' }, { name: 'C', car: 'standard' }, { name: 'D', car: 'standard' }],
      field: undefined,
      race: { laps: 3 },
    }).options).run();
    const board = sectorBoard(new RaceAt(multi, multi.t));
    expect([...board.classBest.keys()].sort()).toEqual(['quick', 'standard']);
    const q = board.classBest.get('quick')!, st = board.classBest.get('standard')!;
    for (let k = 0; k < 3; k++) expect(q[k]).toBeLessThan(st[k]);
    // The slower class still gets purple sectors of its own.
    const slow = [2, 3].map((i) => board.own[i]);
    for (let k = 0; k < 3; k++) expect(slow.some((o) => o[k] === st[k])).toBe(true);
    const s = raceSummary(multi);
    for (let k = 0; k < 3; k++) expect(s.rows.filter((x) => x.sectors[k].purple).length).toBe(2);
  });

  it('the lap just finished stays up until the next lap has its first sector', () => {
    const c = race.cars[0];
    const secs = sectorTimes(race, 0);
    const justOver = new RaceAt(race, c.crossTimes[2] + 0.5);
    const held = sectorCell(sectorBoard(justOver), 0);
    expect(held.times).toEqual(secs[1]);
    expect(held.colors.every((x) => x !== 'none')).toBe(true);
    const s1Done = new RaceAt(race, c.crossTimes[2] + secs[2][0] + 0.2);
    const next = sectorCell(sectorBoard(s1Done), 0);
    expect(next.times[0]).toBeCloseTo(secs[2][0], 9);
    expect(next.colors[1]).toBe('none');
  });

  it('the delta to best is about zero on the best lap, and none before a lap is done', () => {
    const c = race.cars[0];
    expect(deltaToBest(new RaceAt(race, (c.crossTimes[0] + c.crossTimes[1]) / 2), 0)).toBeNaN();
    const best = c.lapTimes.indexOf(Math.min(...c.lapTimes.slice(0, -1)));
    if (best === 0) return; // lap 1 (from the grid) can't be compared with itself mid-lap
    const t = (c.crossTimes[best] + c.crossTimes[best + 1]) / 2;
    // During the best lap, the "best so far" is an earlier lap, so it trails it at the end.
    const atEnd = new RaceAt(race, c.crossTimes[best + 1] - 0.05);
    expect(deltaToBest(atEnd, 0)).toBeLessThan(0.05);
    expect(Number.isFinite(deltaToBest(new RaceAt(race, t), 0))).toBe(true);
  });

  it('the result shows best sectors and the ideal lap they add up to', () => {
    const s = raceSummary(race);
    const secs = (x: string) => x.split(':').reduce((a, b) => a * 60 + Number(b), 0);
    for (const row of s.rows) {
      expect(row.sectors).toHaveLength(3);
      if (row.ideal !== '–') expect(secs(row.ideal)).toBeLessThanOrEqual(secs(row.best));
    }
    for (let k = 0; k < 3; k++) expect(s.rows.filter((x) => x.sectors[k].purple).length).toBeGreaterThanOrEqual(1);
  });

  it("qualifying keeps each lap's sectors; the panel shows each driver's best ones", () => {
    const scn = fixture('equal-field');
    const { options } = loadScenario({ ...scn, race: { ...scn.race, gridOrder: 'qualifying' }, field: { ...scn.field!, count: 4 } });
    for (const e of options.entrants) {
      e.quali!.laps.forEach((t, n) => expect(e.quali!.sectors[n].reduce((a, b) => a + b, 0)).toBeCloseTo(t, 6));
    }
    const q = qualiSummary(options.entrants)!;
    expect(q.rows[0].sectors.every((x) => /^\d+\.\d{3}$/.test(x.text))).toBe(true);
    for (let k = 0; k < 3; k++) expect(q.rows.filter((x) => x.sectors[k].purple).length).toBeGreaterThanOrEqual(1);
  });
});
