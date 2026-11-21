import { it } from 'vitest';
import { generateTrack, Race, LaneSet, identicalField, AVERAGE_DRIVER } from '../../racing-sim/src/core';
it('dbg3', () => {
  const track = generateTrack({ seed: 7 });
  const lanes = new LaneSet(track);
  const e = identicalField(2, { ...AVERAGE_DRIVER, pace: 0.94 });
  e[1].driver = { ...e[1].driver, pace: 1.0 };
  const r = new Race({ track, lanes, entrants: e, laps: 3, seed: 1 });
  while (r.t < 75) r.step();
  let lastMode = '';
  while (r.t < 140) {
    r.step();
    const c = r.cars[1], o = r.cars[0];
    const m = c.craft.mode;
    const i = Math.floor(c.st.s / track.ds);
    const ci = r.nextCorner[i]; const cor = r.corners[ci];
    const toC = ((cor.apex - i) + track.n) % track.n;
    if (m === 'attack' || m !== lastMode) if (r.tick % 12 === 0 || m !== lastMode)
      console.log(`t${r.t.toFixed(1)} ${m} side${c.craft.side} gap ${(o.st.dist - c.st.dist).toFixed(1)} d ${c.d.toFixed(1)}/${o.d.toFixed(1)} line ${lanes.lineD(c.st.s).toFixed(1)} v ${c.st.v.toFixed(1)}/${o.st.v.toFixed(1)} env ${c.plans.envelope(c.st.s, c.st.delta).toFixed(1)} toC ${toC} ${cor.name}${cor.dir > 0 ? 'L' : 'R'} fol ${c.following}`);
    lastMode = m;
  }
}, 60000);
