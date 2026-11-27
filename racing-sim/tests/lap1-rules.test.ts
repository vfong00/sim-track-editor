import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FRAME_STRIDE, HIT_LEN, loadScenario, Race, type Scenario, STATUS } from '../src/core';
import { decodeDataUrl } from '../src/cli/png-node';

/**
 * Lap-1 rule checks (phase C), read from the race log only, like tests/racecraft-rules.test.ts
 * (which starts at lap 2). Lap 1 runs from the start to the leader starting lap 2. Over several
 * seeds of F1 constructors at Yas and Monza.
 *
 * [slow]: several full-field lap 1s. LAP1_SEEDS=16 for a firmer count when measuring a change.
 */
const load = (file: string) => {
  const scn = JSON.parse(readFileSync(new URL(`./fixtures/scenarios/${file}.json`, import.meta.url).pathname, 'utf8')) as Scenario;
  return { scn, image: scn.track.type === 'png' ? decodeDataUrl(scn.track.image) : undefined };
};
const SEEDS = Array.from({ length: Number(process.env.LAP1_SEEDS ?? 4) }, (_, i) => i + 1);
const label = new Map<Race, string>();
const races = ['f1-constructors-yas', 'f1-constructors-monza'].flatMap((file) => {
  const x = load(file);
  return SEEDS.map((seed) => {
    const r = new Race(loadScenario({ ...x.scn, seed, race: { ...x.scn.race, laps: 2 } }, x.image).options);
    // To the leader starting lap 2.
    while (!r.events.some((e) => e.lap >= 2) && r.t < 400) r.step();
    label.set(r, `${x.scn.name} seed ${seed}`);
    return r;
  });
});

/**
 * Limits, pinned at phase C (2026-11-26). Measured with the same checks run on phase B's code.
 * The pinch count is still noisy (side spacing nudges, a car squeezed by a third): it halved from
 * B but isn't near 0, so it's a guard against going back, for D to bring down.
 */
const LIMITS = {
  /** Amended rule 3 on lap 1, per race: phase B 43.6, phase C 22.5 (16 seeds), 20.4 (4 seeds). */
  pinchPerRace: 25,
  /** Share of cars off their grid side before their first braking: phase B 0.53, phase C 0.03. */
  offSide: 0.1,
};

const view = (r: Race) => {
  const L = r.track.length;
  const at = (k: number, i: number) => {
    const f = r.frames[k], o = i * FRAME_STRIDE;
    return { s: f[o], d: f[o + 1], v: f[o + 2], status: f[o + 4] };
  };
  const gap = (a: { s: number }, b: { s: number }) => { let g = b.s - a.s; if (g >= L / 2) g -= L; else if (g < -L / 2) g += L; return g; };
  return { at, gap, n: r.cars.length, frames: r.frames.length, W: Math.round(0.1 / r.dt) };
};

describe('lap 1 rules, from the race log [slow]', () => {
  it('rule 3 amended: under braking, no car moves across toward a car alongside it', () => {
    // Braking: losing more than 8 m/s² over 0.1 s. Alongside: overlapping nose to tail within 2 m,
    // 1.2–4.5 m to the side. A move: more than 0.3 m toward it on the road in that 0.1 s, line or
    // no line (following the racing line toward a car alongside is a move too: the user's Monza
    // seed 5 rulings), that ends closer than the side gap (3 m centre to centre for F1): a pinch,
    // not two cars still a lane apart closing up. Not when the other car moved toward me as much.
    // One per pair per second.
    let bad = 0;
    const seen: string[] = [];
    for (const r of races) {
      const { at, gap, n, frames, W } = view(r);
      const last = new Map<number, number>();
      for (let k = W; k < frames; k++) {
        for (let b = 0; b < n; b++) {
          const B = at(k, b), B0 = at(k - W, b);
          if (B.status !== STATUS.run || (B.v - B0.v) / (W * r.dt) > -8) continue;
          for (let a = 0; a < n; a++) {
            if (a === b) continue;
            const A = at(k, a), dd = A.d - B.d;
            if (A.status !== STATUS.run || A.v < 10 || Math.abs(gap(B, A)) >= HIT_LEN + 2 || Math.abs(dd) < 1.2 || Math.abs(dd) > 4.5) continue;
            const onRoad = Math.sign(dd) * (B.d - B0.d), A0 = at(k - W, a);
            if (onRoad <= 0.3 || Math.abs(dd) >= 3.0 || -Math.sign(dd) * (A.d - A0.d) >= onRoad) continue;
            const key = b * 100 + a;
            if (k - (last.get(key) ?? -1e9) < 1 / r.dt) continue;
            last.set(key, k);
            bad++;
            if (seen.length < 8) seen.push(`${label.get(r)} t=${(k * r.dt).toFixed(1)} ${r.name(b)} toward ${r.name(a)} dd ${dd.toFixed(1)} move ${onRoad.toFixed(2)}`);
          }
        }
      }
    }
    console.log(`lap 1, amended rule 3: ${bad} in ${races.length} races (${(bad / races.length).toFixed(1)} a race)`, seen);
    expect(bad / races.length).toBeLessThanOrEqual(LIMITS.pinchPerRace);
  });

  it('cars keep their grid side down to their first braking zone', () => {
    // Grid side: the sign of the car's d on the grid. Off it: more than 1 m over the centre line
    // of the road toward the other side, at any point before the car first brakes hard (8 m/s²).
    let off = 0, cars = 0;
    for (const r of races) {
      const { at, n, frames, W } = view(r);
      for (let i = 0; i < n; i++) {
        const side = Math.sign(at(0, i).d);
        cars++;
        for (let k = W; k < frames; k++) {
          const c = at(k, i), c0 = at(k - W, i);
          if (c.v > 5 && (c.v - c0.v) / (W * r.dt) < -8) break;
          if (side * c.d < -1) { off++; break; }
        }
      }
    }
    console.log(`lap 1: ${off} of ${cars} cars off their grid side before braking (${(off / cars).toFixed(2)})`);
    expect(off / cars).toBeLessThanOrEqual(LIMITS.offSide);
  });

  it('lights out: every car starts after the lights, a jump start is logged', () => {
    for (const r of races) {
      const out = r.events.find((e) => e.type === 'start' && e.text === 'Lights out');
      expect(out, label.get(r)).toBeDefined();
      expect(out!.t).toBeGreaterThanOrEqual(5.2 - r.dt);
      expect(out!.t).toBeLessThanOrEqual(8);
      const jumped = new Set(r.events.filter((e) => e.type === 'jump').flatMap((e) => e.cars));
      for (let i = 0; i < r.cars.length; i++) {
        // First tick the car moved.
        let k = 0;
        while (k < r.frames.length && r.frames[k][i * FRAME_STRIDE + 2] === 0) k++;
        if (k * r.dt < out!.t) expect(jumped.has(i), `${label.get(r)} ${r.name(i)} moved at ${(k * r.dt).toFixed(2)}`).toBe(true);
        else expect(k * r.dt - out!.t, `${label.get(r)} ${r.name(i)} reaction`).toBeLessThan(0.5);
      }
    }
  });
});
