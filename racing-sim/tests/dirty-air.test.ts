import { describe, expect, it } from 'vitest';
import { CAR_PRESETS, CarModel, DEFAULT_PHYSICS, dirtyEffects, STANDARD_CAR } from '../src/core';

const spec = (k: keyof typeof CAR_PRESETS) => ({ id: k, ...CAR_PRESETS[k] });
/** Share of corner speed lost right behind another car, on a corner of radius r. */
const loss = (s: typeof STANDARD_CAR, r: number) => {
  const m = new CarModel(s);
  return 1 - m.cornerSpeed(1 / r, { ...dirtyEffects(DEFAULT_PHYSICS.dirtyAir, 1), drag: 1 }) / m.cornerSpeed(1 / r);
};

describe('dirty air by downforce', () => {
  it('a wingless car loses only 2% of its grip right behind another', () => {
    const m = new CarModel(STANDARD_CAR);
    expect(m.gripLimit({ ...dirtyEffects(DEFAULT_PHYSICS.dirtyAir, 1), drag: 1 }, 50) / m.gripLimit(undefined, 50)).toBeCloseTo(0.98, 10);
  });

  it('hurts winged cars far more in fast corners: F1 over twice a road car, GT3 in between', () => {
    const r = 60;
    const road = loss(spec('road'), r), gt3 = loss(spec('gt3'), r), f1 = loss(spec('f1'), r);
    expect(gt3).toBeGreaterThan(road);
    expect(f1).toBeGreaterThan(gt3);
    expect(f1).toBeGreaterThan(2 * road);
  });

  it('matters less for a winged car in slow corners, where its grip is mostly mechanical', () => {
    expect(loss(spec("f1"), 15)).toBeLessThan(loss(spec("f1"), 60));
  });

  it('no dirty air, no loss', () => {
    expect(dirtyEffects(0, 1)).toEqual({ grip: 1, aero: 1 });
    expect(dirtyEffects(0.3, 0)).toEqual({ grip: 1, aero: 1 });
  });
});
