import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAR_PRESETS, loadScenario, type Scenario, STANDARD_CAR } from '../src/core';
import { bodyShape, contrast, liveries, luminance } from '../src/view/livery';

/** An example's field (on a generated track, as listed: only the entrants matter here). */
const example = (name: string): Scenario => {
  const s = JSON.parse(readFileSync(new URL(`../scenarios/${name}.json`, import.meta.url).pathname, 'utf8')) as Scenario;
  return { ...s, track: { type: 'generated', seed: 1 }, race: { ...s.race, gridOrder: 'as-listed' } };
};

describe('car art', () => {
  it('shapes the body by class: preset first, else by downforce', () => {
    expect(bodyShape({ id: 'a', ...CAR_PRESETS.f1, preset: 'f1' })).toBe('open');
    expect(bodyShape({ id: 'a', ...CAR_PRESETS.lmp, preset: 'lmp' })).toBe('proto');
    expect(bodyShape({ id: 'a', ...CAR_PRESETS.gt3, preset: 'gt3' })).toBe('gt');
    expect(bodyShape({ id: 'a', ...CAR_PRESETS.mx5, preset: 'mx5' })).toBe('road');
    expect(bodyShape({ ...STANDARD_CAR })).toBe('road');
    expect(bodyShape({ ...STANDARD_CAR, downforce: 8e-4 })).toBe('open');
  });

  it('teammates share a livery; numbers are unique and the same every load', () => {
    const { options } = loadScenario(example('f1-constructors-yas'));
    const lv = liveries(options.entrants);
    const byTeam = new Map<string, string>();
    options.entrants.forEach((e, i) => {
      const key = `${lv[i].pattern}|${lv[i].accent}|${lv[i].base}`;
      const team = e.car.id;
      if (byTeam.has(team)) expect(key).toBe(byTeam.get(team));
      byTeam.set(team, key);
    });
    const nums = lv.map((l) => l.number);
    expect(new Set(nums).size).toBe(nums.length);
    expect(nums.every((n) => n >= 2 && n <= 99)).toBe(true);
    expect(liveries(options.entrants)).toEqual(lv);
    // A driver keeps their number whatever their grid slot.
    const flipped = liveries([...options.entrants].reverse()).reverse();
    expect(flipped.map((l) => l.number)).toEqual(nums);
  });

  it('accents stand out from the base colour', () => {
    expect(luminance('#000000')).toBe(0);
    expect(luminance('#ffffff')).toBeCloseTo(1, 9);
    expect(contrast('#000', '#fff')).toBeCloseTo(21, 6);
    for (const name of ['f1-constructors-yas', 'multiclass-nordschleife', 'gt3-laguna-seca']) {
      const { options } = loadScenario(example(name));
      for (const l of liveries(options.entrants)) expect(contrast(l.base, l.accent)).toBeGreaterThanOrEqual(2.2);
    }
  });
});
