import { describe, expect, it } from 'vitest';
import { LaneSet, makeField, makeRng, Race, Track } from '../src/core';
import { stadium } from './helpers';
import { passesAfterLap1 } from './racing-helpers';

// 16 seeds: with 4, a couple of squeezed-off attacks on the straights track swing the count by half.
const SEEDS = Array.from({ length: 16 }, (_, k) => k + 1);

describe('Phase 4: track character', () => {
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
      return SEEDS.map((seed) => passesAfterLap1(new Race({ track: t, lanes, entrants: makeField(10, makeRng(seed)), laps: 6, seed }).run()));
    };
    const s = count(straights).reduce((a, b) => a + b, 0);
    const w = count(twisty).reduce((a, b) => a + b, 0);
    expect(s).toBeGreaterThanOrEqual(2 * Math.max(1, w));
  });
});
