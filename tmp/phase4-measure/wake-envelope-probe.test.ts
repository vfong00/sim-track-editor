import { it } from 'vitest';
import { Race, makeField, makeRng, identicalField } from '../src/core';
import { lanes7, paceGapRace, track7, mean } from './racing-helpers';
it('f probe', () => {
  const A = [1, 2, 3, 4].map(seed => { const r = new Race({ track: track7, lanes: lanes7, entrants: identicalField(10), laps: 6, seed }).run(); return `${r.events.filter(e => e.type === 'pass' && e.lap >= 2).length}/m${r.stats().mistakes}`; });
  console.log('A identical passes/mistakes:', A.join(' '));
  const F = [1, 2, 3].map(seed => { const s = new Race({ track: track7, lanes: lanes7, entrants: makeField(12, makeRng(seed)), laps: 6, seed }).run().stats(); return `p${s.passes}/m${s.mistakes}/c${s.contacts}`; });
  console.log('F field 12x6:', F.join(' '));
  for (const gap of [0.03, 0.06]) for (const [n, ph] of [['default', {}], ['noDirty', { dirtyAir: 0 }], ['noSlip', { slipstream: 0 }]] as const)
    console.log(`S gap${gap} ${n.padEnd(8)} stuck ${mean([1, 2, 3, 4, 5, 6, 7, 8].map(seed => paceGapRace(gap, seed, ph).run().stats().stuckTime)).toFixed(1)}s`);
}, 600_000);
