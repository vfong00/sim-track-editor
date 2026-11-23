import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CAR_PRESET_IDS, CAR_PRESETS, CarModel, generateTrack, LanePlans, LaneSet, loadScenario, overallAbility, ROSTER, type Scenario, simulateLap,
} from '../src/core';

const read = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/scenarios/${f}`, import.meta.url).pathname, 'utf8')) as Scenario;

describe('car presets', () => {
  const track = generateTrack({ seed: 7 });
  const lanes = new LaneSet(track);
  const laps = Object.fromEntries(CAR_PRESET_IDS.map((id) => {
    const model = new CarModel({ id, ...CAR_PRESETS[id] });
    const plans = new LanePlans(lanes, model);
    const lap = simulateLap(lanes, plans, model);
    return [id, { solver: plans.lapTime, stepped: lap.lapTime, usage: lap.maxUsage }];
  }));

  it.each(CAR_PRESET_IDS)('%s: the time-stepped lap matches the planned one (one physics model, with downforce)', (id) => {
    expect(Math.abs(laps[id].stepped / laps[id].solver - 1)).toBeLessThan(0.01);
    expect(laps[id].usage).toBeLessThan(1.01);
  });

  it('rank by class: F1 < LMP < GT3 < sports car and MX-5 Cup (they trade places by track) < civilian car', () => {
    const order = ['f1', 'lmp', 'gt3'].map((id) => laps[id].solver);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
    expect(Math.min(laps.road.solver, laps.mx5.solver)).toBeGreaterThan(laps.gt3.solver);
    expect(laps.civilian.solver).toBeGreaterThan(Math.max(laps.road.solver, laps.mx5.solver));
  });

  it('the MX-5 Cup corners faster than the road car (slicks) but is slower on the straights', () => {
    const mx5 = new CarModel({ id: 'm', ...CAR_PRESETS.mx5 }), road = new CarModel({ id: 'r', ...CAR_PRESETS.road });
    expect(mx5.cornerSpeed(1 / 30)).toBeGreaterThan(road.cornerSpeed(1 / 30));
    expect(mx5.spec.topSpeed).toBeLessThan(road.spec.topSpeed);
  });

  it('downforce helps most in fast corners', () => {
    const plain = new CarModel({ id: 'a', ...CAR_PRESETS.f1, downforce: 0 });
    const winged = new CarModel({ id: 'b', ...CAR_PRESETS.f1 });
    const gain = (r: number) => winged.cornerSpeed(1 / r) / plain.cornerSpeed(1 / r);
    expect(gain(200)).toBeGreaterThan(gain(20));
    expect(gain(20)).toBeGreaterThan(1);
  });

  it('a scenario car takes its preset values unless it overrides them', () => {
    const car = loadScenario({ ...read('equal-field.json'), cars: [{ id: 'standard', preset: 'gt3', topSpeed: 70 }] }).options.entrants[0].car;
    const { label: _, ...gt3 } = CAR_PRESETS.gt3;
    expect(car).toEqual({ id: 'standard', ...gt3, topSpeed: 70, preset: 'gt3' });
  });
});

describe('fixed roster', () => {
  const ratingsOf = (s: Scenario, name: string) => {
    const e = loadScenario(s).options.entrants.find((x) => x.driver.name === name)!;
    return { pace: e.driver.pace, consistency: e.driver.consistency, aggression: e.driver.aggression, color: e.color };
  };

  it('a driver keeps the same ratings and colour on every seed and in every scenario', () => {
    const a = read('random-field.json');
    const base = ratingsOf(a, 'Reyes');
    expect(ratingsOf({ ...a, seed: 99 }, 'Reyes')).toEqual(base);
    expect(ratingsOf(read('safety-car.json'), 'Reyes')).toEqual(base);
  });

  it('names run A, B, C… from the best driver down (overall ability, ties to the faster one)', () => {
    const ranked = [...ROSTER].sort((a, b) => overallAbility(b) - overallAbility(a) || b.speed - a.speed);
    const letters = ranked.map((d) => d.name[0]);
    // Every A ranks above every B, and so on; every letter A–Z is used.
    expect([...letters].sort().join('')).toBe(letters.join(''));
    expect([...new Set(letters)].join('')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    // The middle of the pack is M and N.
    expect(letters.slice(14, 16).join('')).toBe('MN');
    expect(new Set(ROSTER.map((d) => d.name)).size).toBe(ROSTER.length);
  });

  it('generated fields are the roster, in order', () => {
    const names = loadScenario(read('random-field.json')).options.entrants.map((e) => e.driver.name);
    expect([...names].sort()).toEqual(ROSTER.slice(0, 12).map((d) => d.name).sort());
  });

  it('a listed driver with a roster name brings their own ratings', () => {
    const s = read('random-field.json');
    const listed: Scenario = { ...s, drivers: [{ name: 'Alvarez', car: 'standard' }], field: { ...s.field!, count: 3 } };
    expect(ratingsOf(listed, 'Alvarez')).toEqual(ratingsOf(s, 'Alvarez'));
  });
});
