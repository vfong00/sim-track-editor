import { describe, expect, it } from 'vitest';
import { dHard, HIT_LEN, HIT_W, generateTrack, LaneSet, makeField, makeRng, Race } from '../src/core';

const track = generateTrack({ seed: 7 });
const lanes = new LaneSet(track);
const race = (seed: number, n = 12, laps = 3) =>
  new Race({ track, lanes, entrants: makeField(n, makeRng(seed)), laps, seed }).run();

describe('a field of cars', () => {
  const r = race(1, 20, 3);
  const L = track.length;
  const N = r.cars.length;

  it('finishes, and nobody overlaps or leaves the road on any tick', () => {
    expect(r.finished).toBe(true);
    const lim = dHard(track) + 1e-6;
    // Overlap of the two footprints: positive on both axes means the cars intersect.
    let worst = -Infinity;
    for (const f of r.frames) {
      for (let i = 0; i < N; i++) {
        expect(Math.abs(f[i * 3 + 1])).toBeLessThanOrEqual(lim);
        for (let j = i + 1; j < N; j++) {
          let ds = f[j * 3] - f[i * 3];
          if (ds > L / 2) ds -= L;
          if (ds < -L / 2) ds += L;
          const dd = f[j * 3 + 1] - f[i * 3 + 1];
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
      const running = o.filter((i) => !q.cars[i].finished);
      const finished = o.filter((i) => q.cars[i].finished);
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
