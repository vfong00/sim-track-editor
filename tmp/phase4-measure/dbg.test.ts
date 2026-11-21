import { it } from 'vitest';
import { generateTrack, Race, LaneSet, identicalField, AVERAGE_DRIVER } from '../../racing-sim/src/core';
it('dbg', () => {
  const track = generateTrack({ seed: 7 });
  const lanes = new LaneSet(track);
  const e = identicalField(2, { ...AVERAGE_DRIVER, pace: 0.94 });
  e[1].driver = { ...e[1].driver, pace: 1.0 };
  const r = new Race({ track, lanes, entrants: e, laps: 3, seed: 1 });
  console.log('laptimes plan', r.cars[0].plans.lapTime.toFixed(2), r.cars[1].plans.lapTime.toFixed(2));
  const modes: Record<string, number> = {};
  let lastMode = '';
  while (!r.finished) {
    r.step();
    const c = r.cars[1], o = r.cars[0];
    const m = c.craft.mode; modes[m] = (modes[m] ?? 0) + 1;
    if (m !== lastMode || (m === "attack" && r.tick % 15 === 0)) console.log(`t${r.t.toFixed(1)} mode ${m} gap ${(o.st.dist - c.st.dist).toFixed(1)} d ${c.d.toFixed(1)}/${o.d.toFixed(1)} v ${c.st.v.toFixed(1)}/${o.st.v.toFixed(1)} follow ${c.following} slide ${c.st.slide.toFixed(2)} oMode ${o.craft.mode}`);
    lastMode = m;
    if (r.t > 280) break;
  }
  console.log(modes, r.events.map((x) => x.text).join(' | '));
}, 60000);
