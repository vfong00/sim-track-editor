import { it } from 'vitest';
import { generateTrack, Race, makeField, makeRng, LaneSet } from '../../racing-sim/src/core';
it('perf', () => {
  const track = generateTrack({ seed: 7 });
  const lanes = new LaneSet(track);
  for (const seed of [1, 2]) {
    const t0 = performance.now();
    new Race({ track, lanes, entrants: makeField(12, makeRng(seed)), laps: 10, seed }).run();
    console.log('race ms', (performance.now() - t0).toFixed(0));
  }
});
