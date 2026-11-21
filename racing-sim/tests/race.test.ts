import { describe, expect, it } from 'vitest';
import { FRAME_STRIDE as F, HIT_LEN, HIT_W, generateTrack, LaneSet, makeField, makeRng, Race } from '../src/core';
import { unloggedOffTicks } from './incident-helpers';

const track = generateTrack({ seed: 7 });
const lanes = new LaneSet(track);
const race = (seed: number, n = 12, laps = 3) =>
  new Race({ track, lanes, entrants: makeField(n, makeRng(seed)), laps, seed }).run();

describe('a field of cars', () => {
  const r = race(1, 20, 3);
  const L = track.length;
  const N = r.cars.length;

  // Phase 5: the road edge is no longer a wall. "No car leaves the track" became "no car leaves
  // the road without a logged incident" (an open 'off' event on every tick it is off).
  it('finishes, nobody overlaps, and no car leaves the road without a logged incident', () => {
    expect(r.finished).toBe(true);
    expect(unloggedOffTicks(r)).toEqual([]);
    // Overlap of the two footprints: positive on both axes means the cars intersect.
    let worst = -Infinity;
    for (const f of r.frames) {
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          let ds = f[j * F] - f[i * F];
          if (ds > L / 2) ds -= L;
          if (ds < -L / 2) ds += L;
          const dd = f[j * F + 1] - f[i * F + 1];
          worst = Math.max(worst, Math.min(HIT_LEN - Math.abs(ds), HIT_W - Math.abs(dd)));
        }
      }
    }
    // Float32 log rounding allowance.
    expect(worst).toBeLessThan(1e-3);
  });

  it('positions are a permutation, follow race distance every tick, and end in finish order', () => {
    const q = new Race({ track, lanes, entrants: makeField(12, makeRng(3)), laps: 2, seed: 3 });
    while (!q.finished) {
      q.step();
      const o = [...q.orders[q.orders.length - 1]];
      expect([...o].sort((a, b) => a - b)).toEqual([...Array(12).keys()]);
      const running = o.filter((i) => !q.cars[i].finished && !q.cars[i].dnf);
      const finished = o.filter((i) => q.cars[i].finished);
      // Retired cars are classified last.
      const out = o.filter((i) => q.cars[i].dnf);
      expect(o.slice(o.length - out.length)).toEqual(out);
      // Running cars ordered by distance covered; finished cars by laps, then finish time.
      for (let p = 1; p < running.length; p++) expect(q.cars[running[p - 1]].st.dist).toBeGreaterThanOrEqual(q.cars[running[p]].st.dist);
      for (let p = 1; p < finished.length; p++) {
        const A = q.cars[finished[p - 1]], B = q.cars[finished[p]];
        expect(A.finishLaps > B.finishLaps || (A.finishLaps === B.finishLaps && A.finishTime <= B.finishTime)).toBe(true);
      }
      // A finished car is never behind a running car on the same or fewer laps' distance.
      if (finished.length && running.length) expect(o.indexOf(finished[0])).toBe(0);
      // Interval to the car ahead is a non-negative time once both have timing data.
      if (q.tick % 30 === 0) {
        for (let p = 1; p < running.length; p++) {
          const g = q.gapTo(running[p], running[p - 1]);
          if (!Number.isNaN(g)) expect(g).toBeGreaterThanOrEqual(-1e-9);
        }
      }
    }
    expect(q.tick).toBe(q.frames.length - 1);
  });

  it('lap times add up and gaps match finish times', () => {
    const winner = r.cars[r.orders[r.orders.length - 1][0]];
    expect(winner.finishLaps).toBe(3);
    for (const c of r.cars) {
      if (c.dnf) continue;
      expect(c.finished).toBe(true);
      expect(c.lapTimes.length).toBe(c.finishLaps);
      const first = c.finishTime - c.lapTimes.reduce((a, b) => a + b, 0); // when it crossed the start line
      expect(first).toBeGreaterThan(0);
      expect(first).toBeLessThan(15);
      for (const t of c.lapTimes) expect(t).toBeGreaterThan(50);
      if (c !== winner && c.finishLaps === winner.finishLaps) {
        expect(r.gapTo(c.idx, winner.idx)).toBeCloseTo(c.finishTime - winner.finishTime, 2);
      }
    }
  });

});

describe('determinism', () => {
  it('same seed gives an identical state log; a different seed does not', () => {
    const a = race(5, 10, 2), b = race(5, 10, 2), c = race(6, 10, 2);
    expect(a.frames.length).toBe(b.frames.length);
    for (let k = 0; k < a.frames.length; k++) expect(Buffer.from(a.frames[k].buffer).equals(Buffer.from(b.frames[k].buffer))).toBe(true);
    expect(a.events).toEqual(b.events);
    const same = a.frames.length === c.frames.length && a.frames.every((f, k) => Buffer.from(f.buffer).equals(Buffer.from(c.frames[k].buffer)));
    expect(same).toBe(false);
  });
});
