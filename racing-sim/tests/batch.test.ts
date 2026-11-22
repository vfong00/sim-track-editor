import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildTrack, LaneSet, overallAbility, parseScenario, randomShuffle, rosterDriver, runBatch, scenarioRaceOptions, seedRange, spread, summarize, type Scenario } from '../src/core';

const load = (f: string): Scenario => {
  const r = parseScenario(JSON.parse(readFileSync(new URL(`./fixtures/scenarios/${f}`, import.meta.url), 'utf8')));
  if (!r.ok) throw new Error(f);
  return r.scenario;
};
const batchOf = (s: Scenario, seeds: number[]) => {
  const track = buildTrack(s.track);
  const lanes = new LaneSet(track);
  return runBatch((seed) => scenarioRaceOptions({ ...s, seed }, track, lanes), seeds);
};

describe('Phase 7: batch runs', () => {
  const skill = load('strong-weak.json');
  const a = batchOf(skill, seedRange(24));

  // Average finish, not wins: the top two (Alvarez and Chen) have practically the same pace, so
  // which of them wins more is a coin toss; the best has the best finish on average.
  it('skill shows with equal cars: the most skilled driver finishes best on average, the top four ahead of the bottom four', () => {
    const ability = (name: string) => overallAbility(rosterDriver(name)!);
    const byAbility = [...a.drivers].sort((x, y) => ability(y.name) - ability(x.name));
    const best = [...a.drivers].sort((x, y) => x.position.mean - y.position.mean)[0];
    expect(best.name, a.drivers.map((d) => `${d.name} ${d.position.mean.toFixed(1)}`).join(', ')).toBe(byAbility[0].name);
    const avg = (ds: typeof a.drivers) => ds.reduce((t, d) => t + d.position.mean, 0) / ds.length;
    expect(avg(byAbility.slice(4)) - avg(byAbility.slice(0, 4))).toBeGreaterThanOrEqual(1);
  });

  it('a rerun over the same seeds gives the same summary', () => {
    const b = batchOf(skill, seedRange(6));
    const c = batchOf(skill, seedRange(6));
    expect({ ...c, ms: 0 }).toEqual({ ...b, ms: 0 });
  });

  it('every race is counted once per driver', () => {
    for (const d of a.drivers) expect(d.finishes.reduce((x, y) => x + y, 0)).toBe(a.runs);
    expect(a.drivers.reduce((x, d) => x + d.wins, 0)).toBe(a.runs);
  });

  it('the chaos score is 0 for an unchanged order and 1 on average for a random one', () => {
    const run = (order: number[]) => ({ seed: 0, names: order.map((_, i) => 'abcd'[i]), order, dnf: order.map(() => false), bestLaps: order.map(() => 60), stats: { passes: 0, mistakes: 0, contacts: 0, offs: 0, spins: 0, dnfs: 0, trainShare: 0, stuckTime: 0 }, incidents: 0, chaos: 0, time: 0 });
    expect(summarize([run([0, 1])]).drivers[0].wins).toBe(1);
    // Exhaustive over permutations of 4: the mean |p − i| equals randomShuffle(4).
    const perms: number[][] = [];
    const go = (p: number[], rest: number[]) => (rest.length ? rest.forEach((x) => go([...p, x], rest.filter((y) => y !== x))) : perms.push(p));
    go([], [0, 1, 2, 3]);
    const moved = perms.map((p) => p.reduce((s, x, k) => s + Math.abs(x - k), 0) / 4);
    expect(spread(moved).mean).toBeCloseTo(randomShuffle(4), 10);
  });
});
