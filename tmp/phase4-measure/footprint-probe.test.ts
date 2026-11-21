import { it } from 'vitest';
import { generateTrack, Race, LaneSet, identicalField, makeField, makeRng, AVERAGE_DRIVER } from '../src/core';
function leadLap(track: any, lanes: any, gap: number, seed: number) {
  const e = identicalField(2, { ...AVERAGE_DRIVER, pace: 1 - gap }); e[1].driver = { ...e[1].driver, pace: 1.0 };
  const r = new Race({ track, lanes, entrants: e, laps: 6, seed }); let since = -1;
  while (!r.finished) { r.step(); const ahead = r.cars[1].st.dist > r.cars[0].st.dist;
    if (!ahead) since = -1; else if (since < 0) since = r.t; if (since >= 0 && r.t - since > 5) return r.cars[1].crossings + 1; }
  return -1;
}
it('m probe', () => {
  for (const width of [10, 14, 20]) {
    const track = generateTrack({ seed: 7, width }); const lanes = new LaneSet(track);
    const row = (g: number) => [1, 2, 3, 4, 5, 6].map(s => leadLap(track, lanes, g, s)).join(',');
    console.log(`W${width} 6%: ${row(0.06)}  3%: ${row(0.03)}`);
  }
  const track = generateTrack({ seed: 7 }); const lanes = new LaneSet(track);
  const A = [1, 2, 3, 4].map(seed => new Race({ track, lanes, entrants: identicalField(10), laps: 6, seed }).run().events.filter(e => e.type === 'pass' && e.lap >= 2).length);
  console.log('A identical after lap1:', A.join(' '));
  for (const seed of [1, 2, 3]) {
    const r = new Race({ track, lanes, entrants: makeField(12, makeRng(seed)), laps: 10, seed }).run();
    const by = (t: string, l1: boolean) => r.events.filter(e => e.type === t && (e.lap <= 1) === l1).length;
    console.log(`field s${seed}: passes ${by('pass', true)}+${by('pass', false)} mistakes ${by('mistake', true)}+${by('mistake', false)} contacts ${by('contact', true)}+${by('contact', false)}  (lap1 + later)`);
  }
}, 600_000);
