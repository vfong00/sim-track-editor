import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAR_WIDTH, FRAME_STRIDE, HIT_LEN, HIT_W, KERB_GRIP, loadScenario, Race, type Scenario, solveSpeedProfile, STATUS } from '../src/core';
import { decodeDataUrl } from '../src/cli/png-node';

/**
 * Rule checks for the racecraft rules agreed with the user (docs/HANDOFF.md → "Racecraft
 * rules"), read from the race log only: the per-tick frames (s, d, v, status), the events and
 * the track's corners. Never from internals (craft modes, constants), so they keep checking the
 * rule however the driving is built. Each counts violations over several seeds of F1
 * constructors at Yas, a field that fights.
 *
 * [slow]: several full-field races. Skip while iterating with
 *   npx vitest run --testNamePattern='^(?!.*\[slow\])'
 */
const scn = JSON.parse(readFileSync(new URL('./fixtures/scenarios/f1-constructors-yas.json', import.meta.url).pathname, 'utf8')) as Scenario;
const image = scn.track.type === 'png' ? decodeDataUrl(scn.track.image) : undefined;
const SEEDS = [1, 2, 3, 4];
const races = SEEDS.map((seed) => new Race(loadScenario({ ...scn, seed, race: { ...scn.race, laps: 3 } }, image).options).run());

/** Per-tick log access for car i at frame k. */
const view = (r: Race) => {
  const L = r.track.length;
  const at = (k: number, i: number) => {
    const f = r.frames[k], o = i * FRAME_STRIDE;
    return { s: f[o], d: f[o + 1], v: f[o + 2], status: f[o + 4] };
  };
  /** b.s − a.s along the track, wrapped to [−L/2, L/2). */
  const gap = (a: { s: number }, b: { s: number }) => { let g = b.s - a.s; if (g >= L / 2) g -= L; else if (g < -L / 2) g += L; return g; };
  /** Offset from the racing line. */
  const off = (c: { s: number; d: number }) => c.d - r.lanes.lineD(c.s);
  // From lap 2: lap 1 is the start (phase C), not battles between two cars.
  const lap2 = r.events.find((e) => e.lap >= 2)?.t ?? Infinity;
  return { at, gap, off, n: r.cars.length, frames: r.frames.length, W: Math.round(0.1 / r.dt), k0: Math.ceil(lap2 / r.dt) };
};

describe('racecraft rules, from the race log [slow]', () => {
  it('rule 3: a defender does not move toward a car pulled out beside it while braking', () => {
    // Braking: losing more than 8 m/s² over 0.1 s. Attacker: up to 12 m behind and 1–4 m to one
    // side (pulled out, in the way of a move across). Moving: the defender's offset from the
    // racing line moves more than 0.5 m toward the attacker's side in that 0.1 s (5 m/s across;
    // following the line through the braking zone is offset 0). One per pair per second.
    let bad = 0;
    const seen: string[] = [];
    for (const r of races) {
      const { at, gap, off, n, frames, W, k0 } = view(r);
      const last = new Map<number, number>();
      for (let k = Math.max(W, k0); k < frames; k++) {
        for (let b = 0; b < n; b++) {
          const B = at(k, b), B0 = at(k - W, b);
          if (B.status !== STATUS.run || (B.v - B0.v) / (W * r.dt) > -8) continue;
          for (let a = 0; a < n; a++) {
            if (a === b) continue;
            const A = at(k, a);
            const g = gap(A, B);
            if (A.status !== STATUS.run || g <= 0 || g > 12 || Math.abs(A.d - B.d) < 1.0 || Math.abs(A.d - B.d) > 4) continue;
            const toward = Math.sign(A.d - B.d) * (off(B) - off(B0));
            if (toward <= 0.5) continue;
            const key = b * 100 + a;
            if (k - (last.get(key) ?? -1e9) < 1 / r.dt) continue;
            last.set(key, k);
            bad++;
            if (seen.length < 8) seen.push(`seed ${r.opts.seed} t=${(k * r.dt).toFixed(1)} ${r.name(b)} toward ${r.name(a)} gap ${gap(A, B).toFixed(1)} dd ${(A.d - B.d).toFixed(1)} move ${toward.toFixed(2)}`);
          }
        }
      }
    }
    console.log(`rule 3 violations: ${bad} in ${SEEDS.length} races`, seen);
    expect(bad).toBeLessThanOrEqual(LIMITS.brakeMove);
  });

  it('rule 2: a car alongside on the inside at turn-in is left a car\'s width to the apex', () => {
    // Turn-in: the defender 40 m before the apex. Alongside: overlapping nose to tail. Violation:
    // before the defender reaches the apex, the two closer than a car's width plus 0.1 m side to
    // side while still overlapping, or the inside car pushed off the road.
    let bad = 0, cases = 0;
    const seen: string[] = [];
    for (const r of races) {
      const { at, gap, n, frames, k0 } = view(r);
      const ds = r.track.ds, L = r.track.length;
      for (const c of r.corners) {
        const apex = c.apex * ds;
        for (let k = Math.max(1, k0); k < frames; k++) {
          for (let b = 0; b < n; b++) {
            const B = at(k, b), B0 = at(k - 1, b);
            const toApex = (x: number) => ((apex - x) % L + L) % L;
            if (B.status !== STATUS.run || !(toApex(B0.s) > 40 && toApex(B.s) <= 40)) continue;
            for (let a = 0; a < n; a++) {
              const A = at(k, a);
              if (a === b || A.status !== STATUS.run || Math.abs(gap(B, A)) >= HIT_LEN || Math.sign(A.d - B.d) !== c.dir || Math.abs(A.d - B.d) < HIT_W - 0.1) continue;
              cases++;
              for (let m = k; m < frames && toApex(at(m, b).s) <= 40 && toApex(at(m, b).s) > 0.5; m++) {
                const Am = at(m, a), Bm = at(m, b);
                if (Math.abs(gap(Bm, Am)) >= HIT_LEN) break;
                if (Math.abs(Am.d - Bm.d) < CAR_WIDTH + 0.1 || Math.abs(Am.d) > r.track.width / 2) {
                  bad++;
                  if (seen.length < 5) seen.push(`seed ${r.opts.seed} t=${(m * r.dt).toFixed(1)} ${r.name(b)} on ${r.name(a)} at ${c.name}`);
                  break;
                }
              }
            }
          }
        }
      }
    }
    console.log(`rule 2 violations: ${bad} of ${cases} cases`, seen);
    expect(cases).toBeGreaterThan(0);
    expect(bad).toBeLessThanOrEqual(LIMITS.roomShare * cases);
  });

  it('rule 1: a committed attacker on a straight does not drop to the defender\'s speed', () => {
    // Pulled out: 2–25 m behind, a car's width or more to the side, closing by 1 m/s or more, on
    // a straight (the centreline straighter than a 500 m radius 100 m around both), with the
    // defender not braking. Violation: within 1.5 s, still like that, the attacker's speed is
    // down to the defender's (within 0.2 m/s) while it is lifting or braking.
    let bad = 0, cases = 0;
    const seen: string[] = [];
    for (const r of races) {
      const { at, gap, n, frames, W, k0 } = view(r);
      const t = r.track;
      const straight = (s: number) => { for (let x = -100; x <= 100; x += 5) if (Math.abs(t.curvature[Math.floor((((s + x) % t.length) + t.length) % t.length / t.ds) % t.n]) > 1 / 500) return false; return true; };
      const last = new Map<number, number>();
      const setup = (k: number, a: number, b: number) => {
        const A = at(k, a), B = at(k, b), B0 = at(k - W, b);
        const g = gap(A, B);
        return A.status === STATUS.run && B.status === STATUS.run && g > 2 && g < 25 && Math.abs(A.d - B.d) >= HIT_W && straight(A.s) && straight(B.s) && (B.v - B0.v) / (W * r.dt) > -2;
      };
      for (let k = Math.max(W, k0); k < frames - 1; k++) {
        for (let a = 0; a < n; a++) {
          for (let b = 0; b < n; b++) {
            if (a === b || !setup(k, a, b) || at(k, a).v < at(k, b).v + 1) continue;
            const key = a * 100 + b;
            if (k - (last.get(key) ?? -1e9) < 3 / r.dt) continue;
            last.set(key, k);
            cases++;
            for (let m = k + W; m < Math.min(frames, k + 1.5 / r.dt); m++) {
              if (!setup(m, a, b)) break;
              const A = at(m, a), A0 = at(m - W, a), B = at(m, b);
              if (A.v <= B.v + 0.2 && A.v < A0.v) {
                bad++;
                if (seen.length < 5) seen.push(`seed ${r.opts.seed} t=${(m * r.dt).toFixed(1)} ${r.name(a)} behind ${r.name(b)}`);
                break;
              }
            }
          }
        }
      }
    }
    console.log(`rule 1 violations: ${bad} of ${cases} cases`, seen);
    expect(cases).toBeGreaterThan(0);
    expect(bad).toBeLessThanOrEqual(LIMITS.towShare * cases);
  });
});

/**
 * Allowed violations. Rules 1 and 2: none (0 of 6 and 0 of 60 cases when added). Rule 3 had 16
 * in the 4 races when added (2026-11-24): pinned here so it can't get worse; phase B (racecraft
 * decisions) is to bring it to none. Some may be a defender held on the road edge while the
 * line moves under it, which moves its offset without the driver moving.
 */
const LIMITS = { brakeMove: 5 * SEEDS.length, roomShare: 0, towShare: 0 };

describe('kerbs, from the race log [slow]', () => {
  // Incident-prone so the races have kerb spins to check.
  const kerbRaces = [1, 2].map((seed) => new Race(loadScenario({ ...scn, seed, race: { ...scn.race, laps: 3, incidentRate: 4 } }, image).options).run());

  it('a car spins on a kerb only with the power down on it, and the moment is logged first', () => {
    let n = 0;
    for (const r of kerbRaces) {
      const { at } = view(r);
      for (const e of r.events) {
        if (e.type !== 'spin' || !e.text.includes('on the kerb')) continue;
        n++;
        // Frame k is the tick it spun (frames start with the grid at t = 0): it was gaining speed.
        const k = Math.round(e.t / r.dt), i = e.cars[0];
        const c = at(k, i), c0 = at(k - 1, i);
        expect(r.lanes.surface.kerbShare(c.s, c.d)).toBeGreaterThan(0);
        expect(c.v).toBeGreaterThan(c0.v);
        expect(e.cause !== undefined && r.events[e.cause].text.includes('kerb')).toBe(true);
      }
    }
    expect(n).toBeGreaterThan(0);
  });
});

describe('kerbs cost grip', () => {
  it('a little on the racing line, more riding the kerb', () => {
    const r = races[0];
    const L = r.lanes, model = r.cars[0].model;
    const flat = new Float64Array(r.track.n).fill(1);
    const line = (grip: Float64Array) => solveSpeedProfile(L.line, model, { grip }).lapTime;
    const cost = line(L.grips[L.zero]) / line(flat) - 1;
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.01); // 0.7% at Yas, 0.1% at Monza when added
    // At the edge where a kerb runs, half the car is on it: it has 1 − (1 − KERB_GRIP)/2 of its grip.
    const i = r.lanes.surface.kerbs.left.indexOf(1);
    expect(r.lanes.surface.nodeGrip(i, L.lim)).toBeCloseTo(1 - (1 - KERB_GRIP) / 2, 6);
    expect(r.lanes.surface.nodeGrip(i, 0)).toBe(1);
  });
});
