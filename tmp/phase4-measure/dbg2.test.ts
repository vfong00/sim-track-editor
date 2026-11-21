import { it } from 'vitest';
import { generateTrack, Race, LaneSet, identicalField, AVERAGE_DRIVER } from '../../racing-sim/src/core';
it('dbg2', () => {
  const track = generateTrack({ seed: 7 });
  const lanes = new LaneSet(track);
  for (const phys of [{}, { slipstream: 0, dirtyAir: 0 }]) {
    const e = identicalField(2, { ...AVERAGE_DRIVER, pace: 0.94 });
    e[1].driver = { ...e[1].driver, pace: 1.0 };
    const r = new Race({ track, lanes, entrants: e, laps: 4, seed: 1, physics: phys });
    let fol = 0, n = 0, bind = 0;
    while (!r.finished) { r.step(); n++; if (r.cars[1].following === 0) fol++; }
    console.log(JSON.stringify(phys), 'slow laps', r.cars[0].lapTimes.map((x) => x.toFixed(2)).join(' '), '| fast laps', r.cars[1].lapTimes.map((x) => x.toFixed(2)).join(' '), 'following share', (fol / n).toFixed(2));
  }
}, 60000);
