import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAR_PRESETS, driverFromRatings, type Entrant, loadScenario, Race, type Scenario, STANDARD_CAR } from '../src/core';
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
    expect(profile({ speed: 0.7, consistency: 0.95, risk: 0.2, racecraft: 0.8 })).toBe('Quick, very consistent, cautious');
    expect(profile({ speed: 0.5, consistency: 0.85, risk: 0.5, racecraft: 0.7 })).toBe('Average pace, consistent, measured');
    expect(profile({ speed: 0.1, consistency: 0.6, risk: 0.9, racecraft: 0.3 })).toBe('Slow, error-prone, reckless');
  });

  it('gives each rating and car value its rank in the field', () => {
    const field = [entrant('A', 0.79, 0.9, 0.3, 90), entrant('B', 0.9, 0.8, 0.5), entrant('C', 0.2, 0.95, 0.7)];
    const st = statRows(field, 0);
    expect(st.profile).toBe('Quick, consistent, careful, in a custom car');
    expect(st.driver.map((r) => `${r.label} ${r.value} · ${r.rank}`)).toEqual([
      'Pace 97.9% · 2nd of 3', 'Consistency 0.90 · 2nd of 3', 'Aggression 0.30 · 3rd of 3', 'Bravery 0.30 · 3rd of 3',
      'Racecraft 0.84 · 2nd of 3', 'Incident risk ×0.74 · 1st of 3',
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

  it('cycles gap → interval → last lap → best lap', () => {
    expect(TOWER_MODES.map(nextMode)).toEqual(['interval', 'last', 'best', 'gap']);
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
  it('names the preset, a modified preset, the standard car or a custom car', () => {
    expect(carPhrase({ id: 'a', ...CAR_PRESETS.f1, preset: 'f1' })).toBe('an F1 car');
    expect(carPhrase({ id: 'a', ...CAR_PRESETS.gt3, grip: 1.5, preset: 'gt3' })).toBe('a modified GT3 car');
    expect(carPhrase({ ...STANDARD_CAR })).toBe('the standard car');
    expect(carPhrase({ ...STANDARD_CAR, topSpeed: 90 })).toBe('a custom car');
  });
});
