import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAR_PRESETS, driverFromRatings, type Entrant, loadScenario, Race, racePace, ROSTER, type Scenario, STANDARD_CAR } from '../src/core';
import { RaceAt } from '../src/view/at';
import { carPhrase, ordinal, profile, rankIn, rankText, ratingsOf, statRows } from '../src/view/stats';
import { nextMode, TOWER_MODES, towerCell } from '../src/view/tower';

const entrant = (name: string, speed: number, consistency: number, risk: number, topSpeed = STANDARD_CAR.topSpeed): Entrant => ({
  id: name, color: '#fff', car: { ...STANDARD_CAR, topSpeed }, driver: driverFromRatings(name, { speed, consistency, risk }),
});

describe('follow panel stats', () => {
  it('recovers the scenario ratings from a driver (pace from speed, inverted)', () => {
    const r = ratingsOf(entrant('A', 0.79, 0.9, 0.3));
    expect(r.speed).toBeCloseTo(0.79, 9);
    expect(r.consistency).toBe(0.9);
    expect(r.risk).toBeCloseTo(0.3, 9);
    expect(r.racecraft).toBeCloseTo((0.79 + 0.9) / 2, 9);
  });

  it('ranks with ties and an all-equal field', () => {
    expect(rankIn([0.5, 0.9, 0.7], 2)).toMatchObject({ rank: 2, of: 3, tied: false });
    expect(rankText(rankIn([0.5, 0.9, 0.7], 2))).toBe('2nd of 3');
    expect(rankText(rankIn([0.9, 0.9, 0.7], 1))).toBe('=1st of 3');
    expect(rankText(rankIn([1, 1, 1], 0))).toBe('all equal');
    expect(rankIn([3, 1, 2], 1, false).rank).toBe(1);
  });

  it('writes ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 112].map(ordinal)).toEqual(
      ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '112th']);
  });

  it('profiles a driver in one line', () => {
    const at = (speed: number, consistency: number, risk: number) => {
      const d = driverFromRatings('x', { speed, consistency, risk });
      return profile({ speed, consistency, risk, racecraft: d.racecraft }, d.pace, racePace(d));
    };
    // The roster's ends: Alvarez is dominant on race pace; Tanaka is off the pace.
    expect(at(0.79, 0.96, 0.32)).toBe('Dominant, very consistent, careful');
    expect(at(0.8, 0.84, 0.49)).toBe('Very quick, consistent, measured');
    expect(at(0.2, 0.78, 0.75)).toBe('Off the pace, a bit erratic, reckless');
    // Quick over one lap but erratic: the race word is lower, and both are said.
    expect(at(0.66, 0.78, 0.68)).toBe('Quick over a lap, average in races, a bit erratic, aggressive');
  });

  it('spreads the roster over the pace words (no word for nearly everyone)', () => {
    const words = ROSTER.map((r) => {
      const d = driverFromRatings(r.name, r);
      return profile({ ...r, racecraft: d.racecraft }, d.pace, racePace(d)).split(/,| over /)[0];
    });
    const counts = new Map<string, number>();
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
    expect(counts.size).toBeGreaterThanOrEqual(5);
    // No word for more than 30% of the roster (6 of the first 20; 9 of 30).
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(Math.floor(0.3 * ROSTER.length));
    // "Dominant" is for the A drivers only.
    expect(ROSTER.filter((_, i) => words[i] === 'Dominant').map((r) => r.name[0])).toEqual(['A', 'A']);
  });

  it('gives each rating and car value its rank in the field', () => {
    const field = [entrant('A', 0.79, 0.9, 0.3, 90), entrant('B', 0.9, 0.8, 0.5), entrant('C', 0.2, 0.95, 0.7)];
    const st = statRows(field, 0);
    expect(st.blurb).toEqual({ driver: 'Very quick, consistent, careful', car: "A custom car that's the quickest on the straights" });
    // A spec field: no car line.
    const spec = [entrant('A', 0.79, 0.9, 0.3), entrant('B', 0.9, 0.8, 0.5)];
    expect(statRows(spec, 0).blurb.car).toBeNull();
    expect(st.driver.map((r) => `${r.label} ${r.value} · ${r.rank}`)).toEqual([
      'Pace 97.9% · 2nd of 3', 'Race pace 94.2% · 2nd of 3', 'Consistency 0.90 · 2nd of 3', 'Aggression 0.30 · 3rd of 3', 'Bravery 0.30 · 3rd of 3',
      'Racecraft 0.84 · 2nd of 3',
      // No style given (a generated field): every dial neutral.
      'Braking mid 0.50 · all equal', 'Line U–V 0.50 · all equal', 'Throttle mid 0.50 · all equal', 'Kerbs 0.50 · all equal',
      'Incident risk ×0.74 · 1st of 3',
    ]);
    expect(st.car[0]).toMatchObject({ label: 'Top speed', value: '324 km/h', rank: '1st of 3' });
    expect(st.car[2].rank).toBe('all equal');
  });
});

describe('timing tower modes', () => {
  const scn = JSON.parse(readFileSync(new URL('./fixtures/scenarios/equal-field.json', import.meta.url).pathname, 'utf8')) as Scenario;
  const race = new Race(loadScenario(scn).options);
  while (race.t < 200 && !race.finished) race.step();
  const at = new RaceAt(race, race.t);
  const order = [...race.orders[at.k]];

  it('cycles gap → interval → last lap → best lap → sectors', () => {
    expect(TOWER_MODES.map(nextMode)).toEqual(['interval', 'last', 'best', 'sectors', 'gap']);
  });

  it('gap is to the leader and interval to the car ahead', () => {
    expect(towerCell(at, order, 0, 'gap').text).toBe('Leader');
    expect(towerCell(at, order, 0, 'interval').text).toBe('Leader');
    // P2: interval and gap are the same thing.
    expect(towerCell(at, order, 1, 'interval').text).toBe(towerCell(at, order, 1, 'gap').text);
    let checked = 0;
    for (let p = 2; p < order.length; p++) {
      const gap = towerCell(at, order, p, 'gap').text, int = towerCell(at, order, p, 'interval').text;
      if (gap.includes('lap') || !gap || !int || int.includes('lap')) continue;
      // The interval is the time to the car ahead, which is part of the gap to the leader. (Gaps
      // are timed at each car's last checkpoint, so intervals don't add up to the gap exactly.)
      expect(int).toBe(`+${at.gap(order[p], order[p - 1]).toFixed(3)}`);
      expect(Number(int)).toBeGreaterThanOrEqual(0);
      expect(Number(int)).toBeLessThan(Number(gap));
      checked++;
    }
    expect(checked).toBeGreaterThan(3);
  });

  it('last and best lap come from the lap times, with the race fastest lap marked', () => {
    let purple = 0;
    order.forEach((i, p) => {
      const laps = at.lapTimes(i);
      if (!laps.length) return;
      expect(towerCell(at, order, p, 'last').text).toMatch(/^\d/);
      const best = towerCell(at, order, p, 'best');
      if (best.purple) purple++;
    });
    expect(purple).toBeGreaterThanOrEqual(1);
  });
});

describe('car phrase', () => {
  it('names the preset or the standard car, and says what stands out in a changed car', () => {
    expect(carPhrase({ id: 'a', ...CAR_PRESETS.f1, preset: 'f1' })).toBe('an F1 car');
    expect(carPhrase({ ...STANDARD_CAR })).toBe('the standard car');
    // Changed from the preset, alone or with nothing to compare against: just its name.
    expect(carPhrase({ id: 'a', ...CAR_PRESETS.gt3, grip: 1.5, preset: 'gt3' })).toBe('a GT3 car');
    expect(carPhrase({ ...STANDARD_CAR, topSpeed: 90 })).toBe('a custom car');
    // Against its rivals: its strongest and weakest points.
    const f1 = (o: object) => ({ id: 'x', ...CAR_PRESETS.f1, preset: 'f1' as const, ...o });
    const rivals = [f1({ topSpeed: 94 }), f1({ topSpeed: 95, grip: 2.2 }), f1({ grip: 2.15 })];
    expect(carPhrase(f1({ topSpeed: 98, grip: 2.0 }), rivals)).toBe("an F1 car that's the quickest on the straights, the weakest in the corners");
    expect(carPhrase(f1({ topSpeed: 95.5, grip: 2.12 }), [...rivals, f1({ topSpeed: 97, grip: 2.05 })])).toBe('an all-round F1 car');
  });
});

describe('pedals from the log', () => {
  it('reads full throttle, full brake and a lift from the car model', async () => {
    const { pedals } = await import('../src/view/trace');
    const { CarModel, CAR_PRESETS } = await import('../src/core');
    const m = new CarModel({ ...CAR_PRESETS.gt3, id: 'gt3' });
    const v = 50;
    expect(pedals(m, v, m.maxDrive(v, 0)).throttle).toBeCloseTo(1, 6);
    expect(pedals(m, v, -m.maxBrake(v, 0)).brake).toBeCloseTo(1, 6);
    const lift = pedals(m, v, -m.cd * v * v);
    expect(lift.throttle).toBeCloseTo(0, 6);
    expect(lift.brake).toBe(0);
    // Half the braking force beyond drag reads as half brake.
    const half = pedals(m, v, -m.cd * v * v - 0.5 * (m.maxBrake(v, 0) - m.cd * v * v));
    expect(half.brake).toBeCloseTo(0.5, 6);
    // Braking at the most the tyres allow while turning reads as less than full: the pedal tapers.
    const alat = 0.8 * m.gripLimit(undefined, v);
    expect(pedals(m, v, -m.maxBrake(v, alat)).brake).toBeLessThan(0.9);
  });
});

describe('kerbs', () => {
  it('go where the racing line uses the edge in corners: inside at the apex, outside either side', async () => {
    const { kerbsFor } = await import('../src/view/draw');
    const scn = JSON.parse(readFileSync(new URL('./fixtures/scenarios/equal-field.json', import.meta.url).pathname, 'utf8')) as Scenario;
    const race = new Race(loadScenario(scn).options);
    const t = race.track, line = race.lanes.line;
    const k = kerbsFor(t, line);
    const share = (m: Uint8Array) => m.reduce((a, b) => a + b, 0) / t.n;
    // Some of the lap, on both sides, but far from all of it.
    expect(share(k.left)).toBeGreaterThan(0.02);
    expect(share(k.right)).toBeGreaterThan(0.02);
    expect(share(k.left) + share(k.right)).toBeLessThan(0.6);
    // Wherever the line is right at the edge in a tight corner, that side has a kerb.
    let checked = 0;
    for (let i = 0; i < t.n; i++) {
      if (Math.abs(t.curvature[i]) > 1 / 120 && Math.abs(line.d[i]) > t.width / 2 - 2) {
        expect((line.d[i] > 0 ? k.left : k.right)[i]).toBe(1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(kerbsFor(t, line)).toBe(k); // cached
  });
});
