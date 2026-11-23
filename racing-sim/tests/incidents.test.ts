import { describe, expect, it } from 'vitest';
import {
  AVERAGE_DRIVER, type DriverSpec, FRAME_STRIDE as F, generateTrack, HIT_LEN, HIT_W, identicalField, LaneSet, makeField, makeRng,
  Race, STATUS, type Track,
} from '../src/core';
import { stadium } from './helpers';
import { incidentIdx, ownIncidentCount, unexplained, unloggedOffTicks } from './incident-helpers';
import { lanes7, mean, track7 } from './racing-helpers';

const field = (seed: number, n = 12, ratings: Partial<DriverSpec> = {}) =>
  makeField(n, makeRng(seed)).map((e) => ({ ...e, driver: { ...e.driver, ...ratings } }));
const race = (seed: number, laps = 10, ratings: Partial<DriverSpec> = {}) =>
  new Race({ track: track7, lanes: lanes7, entrants: field(seed, 12, ratings), laps, seed }).run();

describe('Phase 5: a lone, perfectly consistent driver', () => {
  const tracks: [string, Track][] = [
    ['generated 7', track7], ['generated 3', generateTrack({ seed: 3 })], ['generated 11', generateTrack({ seed: 11 })], ['stadium', stadium(600, 90)],
  ];
  it.each(tracks)('never leaves the road or spins (%s)', (_, track) => {
    for (const pace of [AVERAGE_DRIVER.pace, 1]) {
      const e = identicalField(1, { ...AVERAGE_DRIVER, pace, consistency: 1 });
      const r = new Race({ track, entrants: e, laps: 4, seed: 1 }).run();
      expect(r.finished).toBe(true);
      expect(r.events.filter((x) => ['slide', 'off', 'spin', 'crash', 'mistake'].includes(x.type))).toEqual([]);
      for (const f of r.frames) {
        expect(Math.abs(f[1])).toBeLessThanOrEqual(track.width / 2);
        expect(f[4]).toBe(STATUS.run);
      }
    }
  });
});

describe('Phase 5: incidents in a field', () => {
  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const races = SEEDS.map((seed) => race(seed));

  it('every off-track excursion, spin and crash follows a logged slide, lock-up or contact', () => {
    let n = 0;
    for (const r of races) {
      expect(r.finished).toBe(true);
      for (const k of incidentIdx(r)) {
        n++;
        expect(unexplained(r, k)).toBe('');
      }
      expect(unloggedOffTicks(r)).toEqual([]);
    }
    // There is something to explain: offs and spins do happen.
    expect(n).toBeGreaterThan(SEEDS.length);
  });

  it('an average 12-car, 10-lap field has a sane DNF count (mean 0–2 over seeds)', () => {
    const dnfs = races.map((r) => r.stats().dnfs);
    expect(mean(dnfs)).toBeGreaterThanOrEqual(0);
    expect(mean(dnfs)).toBeLessThanOrEqual(2);
    expect(Math.max(...dnfs)).toBeLessThanOrEqual(5);
  });

  it('same seed still gives an identical log, incidents included', () => {
    const a = race(3, 4), b = race(3, 4);
    expect(a.events).toEqual(b.events);
    expect(a.frames.length).toBe(b.frames.length);
    for (let k = 0; k < a.frames.length; k++) expect(Buffer.from(a.frames[k].buffer).equals(Buffer.from(b.frames[k].buffer))).toBe(true);
  });
});

describe('Phase 5: incident rates follow the driver', () => {
  // Incidents drivers bring on themselves (rooted in their own slide or mistake), summed over a
  // spread of fields: contact-caused ones depend as much on the other car and only add noise.
  // 16 seeds: on 6, one lucky draw (steady drivers bunching half their 30-seed incidents into
  // seeds 1–6) failed it while 30 seeds gave sloppy 2.8× steady.
  const SEEDS = Array.from({ length: 16 }, (_, k) => k + 1);
  const rate = (ratings: Partial<DriverSpec>) => SEEDS.reduce((sum, seed) => sum + ownIncidentCount(race(seed, 6, ratings)), 0);

  it('rise with risk-taking', () => {
    const careful = rate({ aggression: 0.15, bravery: 0.15 });
    const risky = rate({ aggression: 0.9, bravery: 0.9 });
    expect(risky).toBeGreaterThanOrEqual(1.3 * Math.max(1, careful));
  });

  it('fall with consistency', () => {
    const sloppy = rate({ consistency: 0.65 });
    const steady = rate({ consistency: 0.98 });
    expect(sloppy).toBeGreaterThanOrEqual(1.3 * Math.max(1, steady));
  });
});

describe('Phase 5: stopped and retired cars are avoided', () => {
  /**
   * The leader's car fails (coasts to a stop at the side and retires) or spins and sits there
   * (never restarting) mid-race. Once it is stationary, nobody hits it (contact over 1 m/s) or
   * overlaps it, and everyone else gets round it and finishes.
   */
  const cases: [string, number, number, 'retire' | 'spin'][] = [
    ['retired', 1, 25, 'retire'], ['retired', 2, 47, 'retire'], ['retired', 3, 71, 'retire'],
    ['stopped after a spin', 4, 33, 'spin'], ['stopped after a spin', 5, 58, 'spin'], ['stopped after a spin', 6, 90, 'spin'],
  ];
  it.each(cases)('%s (seed %d, at %d s)', (_, seed, at, how) => {
    const r = new Race({ track: track7, lanes: lanes7, entrants: field(seed), laps: 3, seed });
    while (r.t < at) r.step();
    const x = r.orders[r.orders.length - 1][0];
    const c = r.cars[x];
    if (how === 'retire') r.retire(x);
    else r.spin(x);
    // Wait until it has come to rest; a spun car then waits for ever.
    while (c.st.v > 0 || (c.status !== 'out' && c.status !== 'stopped')) r.step();
    if (how === 'spin') c.restartAt = Infinity;
    const still = r.t;
    const k0 = r.frames.length;
    const othersDone = () => r.cars.every((q) => q.idx === x || q.finished || q.dnf);
    while (!othersDone() && r.t < 1200) r.step();
    expect(othersDone()).toBe(true);
    const hits = r.events.filter((e) => e.type === 'contact' && e.t > still && e.cars.includes(x));
    expect(hits.map((e) => e.text)).toEqual([]);
    const L = r.track.length;
    for (let k = k0; k < r.frames.length; k++) {
      const f = r.frames[k];
      for (let j = 0; j < r.cars.length; j++) {
        if (j === x) continue;
        let ds = f[j * F] - f[x * F];
        if (ds > L / 2) ds -= L;
        if (ds < -L / 2) ds += L;
        const dd = f[j * F + 1] - f[x * F + 1];
        expect(Math.min(HIT_LEN - Math.abs(ds), HIT_W - Math.abs(dd))).toBeLessThan(1e-3);
      }
    }
  });
});

describe('Phase 5: incidents can be switched off', () => {
  it('with incidents off the road edge is a wall again: no offs, spins or crashes', () => {
    const r = new Race({ track: track7, lanes: lanes7, entrants: field(5), laps: 3, seed: 5, incidents: false }).run();
    expect(r.finished).toBe(true);
    expect(r.events.filter((e) => ['off', 'spin', 'crash'].includes(e.type))).toEqual([]);
    for (const f of r.frames) for (let i = 0; i < r.cars.length; i++) expect(Math.abs(f[i * F + 1])).toBeLessThanOrEqual(r.lanes.lim + 1e-4);
  });
});
