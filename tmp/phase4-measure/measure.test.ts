import { it } from 'vitest';
import { generateTrack, Race, makeField, makeRng, LaneSet, identicalField, AVERAGE_DRIVER, Track, type Entrant, type PhysicsParams } from '../../racing-sim/src/core';
import { stadium } from '../../racing-sim/tests/helpers';

function run(track: Track, lanes: LaneSet, entrants: Entrant[], laps: number, seed: number, physics?: Partial<PhysicsParams>) {
  return new Race({ track, lanes, entrants, laps, seed, physics }).run();
}
const after1 = (r: Race) => r.events.filter((e) => e.type === 'pass' && e.lap >= 2).length;

it('measure', () => {
  const track = generateTrack({ seed: 7 });
  const lanes = new LaneSet(track);
  // A: identical
  const A: string[] = [];
  for (const seed of [1, 2, 3, 4]) { const r = run(track, lanes, identicalField(10), 6, seed); A.push(`${r.stats().passes}/${after1(r)}`); }
  console.log('A identical passes (all/after lap1) 10 cars x6 laps:', A.join(' '));
  // B: pace gap
  const B: string[] = [];
  for (const seed of [1, 2, 3, 4]) {
    const slow = { ...AVERAGE_DRIVER, pace: 0.94 };
    const e = identicalField(2, slow);
    e[1].driver = { ...e[1].driver, pace: 1.0 };
    const r = new Race({ track, lanes, entrants: e, laps: 5, seed });
    let lead = -1, since = -1;
    while (!r.finished) {
      r.step();
      const ahead = r.cars[1].st.dist > r.cars[0].st.dist;
      if (!ahead) since = -1; else if (since < 0) since = r.t;
      if (lead < 0 && since >= 0 && r.t - since > 5) lead = r.cars[1].crossings + 1;
    }
    B.push(`lap${lead}(${r.events.filter((x) => x.type !== 'finish' && x.type !== 'start').map((x) => x.type[0]).join('')})`);
  }
  console.log('B fast car takes lead on:', B.join(' '));
  // C: trains
  for (const [name, ph] of [['default', {}], ['zero', { slipstream: 0, dirtyAir: 0 }]] as const) {
    const C: string[] = [];
    for (const seed of [1, 2, 3, 4]) { const r = run(track, lanes, makeField(12, makeRng(seed)), 6, seed, ph); const s = r.stats(); C.push(`${s.trainShare.toFixed(3)}(p${s.passes})`); }
    console.log('C trains', name, C.join(' '));
  }
  // D: straights vs twisty
  const st = stadium(800, 110); const stl = new LaneSet(st);
  const twCtrl = Array.from({ length: 24 }, (_, i) => { const a = (i / 24) * 2 * Math.PI; const r = 330 * (1 + 0.22 * Math.sin(6 * a)); return { x: r * Math.cos(a), y: r * Math.sin(a) }; });
  const tw = Track.fromControlPoints(twCtrl, 14); const twl = new LaneSet(tw);
  console.log('D lengths', st.length.toFixed(0), tw.length.toFixed(0), 'minR tw', tw.minRadius().toFixed(0));
  for (const [name, t, l] of [['straights', st, stl], ['twisty', tw, twl]] as const) {
    const D: number[] = [];
    for (const seed of [1, 2, 3, 4]) D.push(after1(run(t, l, makeField(10, makeRng(seed)), 6, seed)));
    console.log('D', name, D.join(' '));
  }
}, 600_000);
