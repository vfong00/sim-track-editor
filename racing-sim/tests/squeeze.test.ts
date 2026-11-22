import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildTrack, FRAME_STRIDE, HIT_LEN, LaneSet, parseScenario, Race, scenarioRaceOptions, SQUEEZE } from '../src/core';

/**
 * Longest stretch (s) any car spends held exactly on the road edge while a car alongside leans
 * in closer than SQUEEZE on its inside. A squeezed car should give way over the edge (or touch),
 * not ride the edge like a wall.
 */
function longestPin(r: Race, lim: number): { t: number; who: string } {
  const n = r.cars.length, L = r.track.length;
  const run = new Array(n).fill(0);
  let best = { t: 0, who: '' };
  r.frames.forEach((fr, k) => {
    for (let i = 0; i < n; i++) {
      const d = fr[i * FRAME_STRIDE + 1];
      let pinned = false;
      if (Math.abs(Math.abs(d) - lim) < 1e-4) {
        for (let j = 0; j < n && !pinned; j++) {
          if (j === i) continue;
          let ds = fr[j * FRAME_STRIDE] - fr[i * FRAME_STRIDE];
          if (ds > L / 2) ds -= L;
          if (ds < -L / 2) ds += L;
          const inner = -Math.sign(d) * (fr[j * FRAME_STRIDE + 1] - d);
          pinned = Math.abs(ds) < HIT_LEN && inner > 0 && inner < SQUEEZE - 0.05;
        }
      }
      run[i] = pinned ? run[i] + 1 : 0;
      if (run[i] * r.dt > best.t) best = { t: run[i] * r.dt, who: `${r.name(i)} at ${(k * r.dt).toFixed(1)} s` };
    }
  });
  return best;
}

describe('Squeezed on the road edge', () => {
  const r0 = parseScenario(JSON.parse(readFileSync(new URL('./fixtures/scenarios/random-field.json', import.meta.url), 'utf8')));
  if (!r0.ok) throw new Error('random-field.json');
  const track = buildTrack(r0.scenario.track);
  const lanes = new LaneSet(track);

  it.each([1, 2, 3, 4])('a car leaned on at the edge gives way instead of riding it (seed %d)', (seed) => {
    const r = new Race(scenarioRaceOptions({ ...r0.scenario, seed }, track, lanes)).run();
    const p = longestPin(r, lanes.lim);
    expect(p.t, p.who).toBeLessThanOrEqual(0.1);
  });
});
