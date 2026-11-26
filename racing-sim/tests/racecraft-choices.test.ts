import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cornerRoom, evenness, loadScenario, Race, type Scenario, varietyOf } from '../src/core';
import { decisionText, RaceAt } from '../src/view/at';

/** Phase B: racecraft decisions are logged, varied, and shown. */
const scn = JSON.parse(readFileSync(new URL('./fixtures/scenarios/equal-field.json', import.meta.url).pathname, 'utf8')) as Scenario;

describe('racecraft decisions (phase B)', () => {
  const race = new Race(loadScenario({ ...scn, seed: 1 }).options).run();

  it('are logged in time order, with both roles and known kinds', () => {
    const ds = race.decisions;
    expect(ds.length).toBeGreaterThan(10);
    for (let k = 1; k < ds.length; k++) expect(ds[k].t).toBeGreaterThanOrEqual(ds[k - 1].t);
    expect(ds.some((d) => d.role === 'attack')).toBe(true);
    expect(ds.some((d) => d.role === 'defend')).toBe(true);
    for (const d of ds) {
      expect(d.other).not.toBe(d.car);
      if (d.role === 'attack') expect(['inside', 'outside', 'dummy', 'hold', 'stay']).toContain(d.kind);
      else expect(['inside', 'mirror', 'line']).toContain(d.kind.replace(/-late$/, ''));
    }
  });

  it('are a mixed strategy: more than one plan and more than one cover across the field', () => {
    const kinds = (role: string) => new Set(race.decisions.filter((d) => d.role === role).map((d) => d.kind.replace(/-late$/, '')));
    expect(kinds('attack').size).toBeGreaterThan(1);
    expect(kinds('defend').size).toBeGreaterThan(1);
  });

  it('variety is the evenness of the choices', () => {
    expect(evenness([5, 0, 0])).toBe(0);
    expect(evenness([3, 3, 3])).toBeCloseTo(1, 9);
    expect(Number.isNaN(evenness([0, 0, 0]))).toBe(true);
    // Late covers count with their cover; hold and stay aren't plans.
    expect(varietyOf({ 'attack:inside': 2, 'attack:hold': 9, 'defend:inside': 1, 'defend:inside-late': 1 })).toBe(0);
    expect(varietyOf({ 'attack:inside': 1, 'attack:outside': 1, 'attack:dummy': 1 })).toBeCloseTo(1, 9);
  });

  it('a slow corner has room for two, a fast one for up to three', () => {
    expect(cornerRoom({ name: 'T1', apex: 0, dir: 1, radius: 30 }, 6)).toBe(2);
    expect(cornerRoom({ name: 'T2', apex: 0, dir: 1, radius: 200 }, 6)).toBe(3);
    expect(cornerRoom({ name: 'T3', apex: 0, dir: 1, radius: 200 }, 2)).toBe(2);
  });

  it('the viewer shows the latest one for a few seconds, in words', () => {
    const d = race.decisions.find((x) => x.role === 'attack' && x.kind === 'inside')!;
    const at = new RaceAt(race, d.t + 0.5);
    const shown = at.decision(d.car);
    expect(shown).not.toBeNull();
    expect(shown!.t).toBeLessThanOrEqual(d.t + 0.5);
    expect(new RaceAt(race, d.t - 0.01).decision(d.car)?.t ?? -1).toBeLessThan(d.t);
    expect(decisionText(d, (i) => race.name(i))).toBe(`Goes for the inside on ${race.name(d.other)}`);
    expect(decisionText({ ...d, role: 'defend', kind: 'mirror-late' }, (i) => race.name(i))).toBe(`Covers the side shown late from ${race.name(d.other)}`);
  });
});
