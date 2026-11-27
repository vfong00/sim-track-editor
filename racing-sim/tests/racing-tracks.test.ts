import { describe, expect, it } from 'vitest';
import { LaneSet, makeField, makeRng, Race, Track } from '../src/core';
import { stadium } from './helpers';
import { racingPassesAfterLap1 } from './racing-helpers';

// 16 seeds: with 4, a couple of squeezed-off attacks on the straights track swing the count by half.
const SEEDS = Array.from({ length: 16 }, (_, k) => k + 1);

describe('Phase 4: track character', () => {
  // Racing passes only: the twisty track has ~20 incidents a race, and driving past a car that
  // spun is not what this is about (those were most of its "passes").
  it('long-straight tracks produce more passes than twisty ones', { timeout: 60000 }, () => {
    const straights = stadium(800, 110);
    const twCtrl = Array.from({ length: 24 }, (_, i) => {
      const a = (i / 24) * 2 * Math.PI;
      const r = 330 * (1 + 0.22 * Math.sin(6 * a));
      return { x: r * Math.cos(a), y: r * Math.sin(a) };
    });
    const twisty = Track.fromControlPoints(twCtrl, 14);
    const count = (t: Track) => {
      const lanes = new LaneSet(t);
      return SEEDS.map((seed) => racingPassesAfterLap1(new Race({ track: t, lanes, entrants: makeField(10, makeRng(seed)), laps: 6, seed }).run()));
    };
    const s = count(straights).reduce((a, b) => a + b, 0);
    const w = count(twisty).reduce((a, b) => a + b, 0);
    // Phase D (proposed to the user, not yet agreed): 2× → 1.5×. The corner lines (outside line,
    // cutback) gave the twisty track's stuck cars ways by: 16 seeds, phase C 75 vs 20, D 70 vs 45.
    expect(s).toBeGreaterThanOrEqual(1.5 * Math.max(1, w));
  });
});
