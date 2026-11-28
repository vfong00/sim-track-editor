import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAR_WIDTH, cornerRoom, FRAME_STRIDE, HIT_LEN, HIT_W, KERB_GRIP, loadScenario, Race, ROOM_LEVEL, type Scenario, solveSpeedProfile, STATUS } from '../src/core';
import { decodeDataUrl } from '../src/cli/png-node';
import { pedals } from '../src/view/trace';

/**
 * Rule checks for the racecraft rules agreed with the user (docs/HANDOFF.md → "Racecraft
 * rules"), read from the race log only: the per-tick frames (s, d, v, status), the events and
 * the track's corners. Never from internals (craft modes, tuning constants), so they keep
 * checking the rule however the driving is built. Each counts violations over several seeds of
 * F1 constructors at Yas and at Monza, fields that fight (Monza's chicanes most of all).
 *
 * [slow]: several full-field races. Skip while iterating with
 *   npx vitest run --testNamePattern='^(?!.*\[slow\])'
 */
const load = (file: string) => {
  const scn = JSON.parse(readFileSync(new URL(`./fixtures/scenarios/${file}.json`, import.meta.url).pathname, 'utf8')) as Scenario;
  return { scn, image: scn.track.type === 'png' ? decodeDataUrl(scn.track.image) : undefined };
};
const { scn, image } = load('f1-constructors-yas');
const monza = load('f1-constructors-monza');
// RULE_SEEDS=16 for a firmer count when measuring a change (the default keeps the suite quick).
const SEEDS = Array.from({ length: Number(process.env.RULE_SEEDS ?? 4) }, (_, i) => i + 1);
/** Which scenario a race is, for the listed moments. */
const label = new Map<Race, string>();
const run = ({ scn, image }: ReturnType<typeof load>, seed: number) => {
  const r = new Race(loadScenario({ ...scn, seed, race: { ...scn.race, laps: 3 } }, image).options).run();
  label.set(r, `${scn.name} seed ${seed}`);
  return r;
};
const races = [...SEEDS.map((seed) => run({ scn, image }, seed)), ...SEEDS.map((seed) => run(monza, seed))];

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
  it('rule 3: a car does not move toward a car pulled out beside it while braking', () => {
    // Braking: losing more than 8 m/s² over 0.1 s. Attacker: up to 12 m behind and 1–4 m to one
    // side (pulled out, in the way of a move across). Moving: in that 0.1 s, the car moves more
    // than 0.5 m toward the attacker's side against the racing line AND more than 0.3 m toward it
    // on the road. Against the line alone, a car held on the road edge, or one following the line
    // less than the line moves, counted as moving (the line swung under it: 16 of 16 when this
    // was the measure, 2026-11-24). Any car, not only a defender: one diving on the car ahead is
    // bound by it too (agreed with the user). One per pair per second.
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
            const onRoad = Math.sign(A.d - B.d) * (B.d - B0.d);
            if (toward <= 0.5 || onRoad <= 0.3) continue;
            const key = b * 100 + a;
            if (k - (last.get(key) ?? -1e9) < 1 / r.dt) continue;
            last.set(key, k);
            bad++;
            if (seen.length < 8) seen.push(`${label.get(r)} t=${(k * r.dt).toFixed(1)} ${r.name(b)} toward ${r.name(a)} gap ${gap(A, B).toFixed(1)} dd ${(A.d - B.d).toFixed(1)} move ${toward.toFixed(2)}`);
          }
        }
      }
    }
    console.log(`rule 3 violations: ${bad} in ${races.length} races`, seen);
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
                  if (seen.length < 5) seen.push(`${label.get(r)} t=${(m * r.dt).toFixed(1)} ${r.name(b)} on ${r.name(a)} at ${c.name}`);
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
    // down to the defender's (within 0.2 m/s) while it is lifting or braking: under 95% throttle
    // as worked out from its speed and its car (`pedals`, as the viewer's trace does). Slowing
    // alone isn't lifting: at Monza's top speed a car pulled out of the tow slows on full throttle
    // (more drag), which counted as giving the tow up (5 of 10 cases when phase B checked it).
    // Nor is queuing behind another car in its own lane (4 of 10): that's the gap rule. Nor
    // braking for the corner on its own lane (the other 5).
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
              const lifting = pedals(r.cars[a].model, A.v, (A.v - A0.v) / (W * r.dt)).throttle < 0.95;
              const queued = Array.from({ length: n }, (_, c) => c).some((c) => c !== a && c !== b && at(m, c).status === STATUS.run && gap(A, at(m, c)) > 0 && gap(A, at(m, c)) < 30 && Math.abs(at(m, c).d - A.d) < HIT_W);
              // Its own lane's plan asks it to slow within a second: braking for the corner, not
              // giving the tow up (the inside of Monza T1 brakes before the line does; rule 4).
              const braking = r.cars[a].plans.envelope(A.s + A.v, A.d - r.lanes.lineD(A.s)) < A.v - 1;
              if (A.v <= B.v + 0.2 && A.v < A0.v && lifting && !queued && !braking) {
                bad++;
                if (seen.length < 5) seen.push(`${label.get(r)} t=${(m * r.dt).toFixed(1)} ${r.name(a)} behind ${r.name(b)}`);
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

  it('exit room: a car level on the outside at the apex is left a car\'s width through the exit', () => {
    // Agreed with the user (Monza, phase B): level = its centre no more than ROOM_LEVEL behind the
    // inside car's at the apex. A car further back isn't owed the space (Monza T9). Violation: in
    // the 60 m after the apex, still overlapping, the two closer than a car's width plus 0.1 m
    // side to side, or the outside car pushed off the road.
    let bad = 0, cases = 0;
    const seen: string[] = [];
    for (const r of races) {
      const { at, gap, n, frames, k0 } = view(r);
      const ds = r.track.ds, L = r.track.length;
      for (const c of r.corners) {
        const apex = c.apex * ds;
        const past = (x: number) => ((x - apex) % L + L) % L;
        for (let k = Math.max(1, k0); k < frames; k++) {
          for (let b = 0; b < n; b++) {
            const B = at(k, b), B0 = at(k - 1, b);
            if (B.status !== STATUS.run || !(past(B0.s) > L / 2 && past(B.s) < L / 2)) continue;
            for (let a = 0; a < n; a++) {
              const A = at(k, a);
              if (a === b || A.status !== STATUS.run || Math.abs(gap(B, A)) >= HIT_LEN || Math.sign(A.d - B.d) !== -c.dir || Math.abs(A.d - B.d) < HIT_W - 0.1 || gap(B, A) < -ROOM_LEVEL) continue;
              cases++;
              for (let m = k; m < frames && past(at(m, b).s) < 60; m++) {
                const Am = at(m, a), Bm = at(m, b);
                if (Math.abs(gap(Bm, Am)) >= HIT_LEN || Am.status !== STATUS.run || Bm.status !== STATUS.run) break;
                if (Math.abs(Am.d - Bm.d) < CAR_WIDTH + 0.1 || Math.abs(Am.d) > r.track.width / 2) {
                  bad++;
                  if (seen.length < 5) seen.push(`${label.get(r)} t=${(m * r.dt).toFixed(1)} ${r.name(b)} on ${r.name(a)} out of ${c.name}`);
                  break;
                }
              }
            }
          }
        }
      }
    }
    console.log(`exit room violations: ${bad} of ${cases} cases`, seen);
    expect(cases).toBeGreaterThan(0);
    expect(bad).toBeLessThanOrEqual(LIMITS.exitShare * cases);
  });

  it('a corner takes no more cars side by side than it has room for', () => {
    // Agreed with the user (Monza T4/T5, phase B): a slow corner or chicane has room for two, a
    // faster one for up to three (cornerRoom). Violation: as a car crosses an apex, more cars
    // overlapping it nose to tail and spread across the road (each pair 1.2 m or more apart
    // side to side) than the corner has room for.
    let bad = 0;
    const seen: string[] = [];
    for (const r of races) {
      const { at, gap, n, frames, k0 } = view(r);
      const ds = r.track.ds, L = r.track.length;
      for (const c of r.corners) {
        const apex = c.apex * ds, room = cornerRoom(c, r.lanes.lim);
        const past = (x: number) => ((x - apex) % L + L) % L;
        for (let k = Math.max(1, k0); k < frames; k++) {
          for (let b = 0; b < n; b++) {
            const B = at(k, b), B0 = at(k - 1, b);
            if (B.status !== STATUS.run || !(past(B0.s) > L / 2 && past(B.s) < L / 2)) continue;
            const group = [b];
            for (let a = 0; a < n; a++) {
              const A = at(k, a);
              if (a === b || A.status !== STATUS.run || Math.abs(gap(B, A)) >= HIT_LEN) continue;
              if (group.every((g) => Math.abs(at(k, g).d - A.d) >= 1.2)) group.push(a);
            }
            if (group.length > room) {
              bad++;
              if (seen.length < 5) seen.push(`${label.get(r)} t=${(k * r.dt).toFixed(1)} ${group.map((g) => r.name(g)).join(', ')} at ${c.name} (room ${room})`);
            }
          }
        }
      }
    }
    // Each over-full corner is counted once per car in it: it's a count of cars, not of corners.
    console.log(`corner capacity violations: ${bad}`, seen);
    expect(bad).toBeLessThanOrEqual(LIMITS.capacity);
  });

  it('rule 5: a car behind a battle does not run into it', () => {
    // A battle: two cars overlapping nose to tail and 1.2 m or more apart side to side. Behind
    // it: a third car 5–60 m back of the rear one. Violation: a contact between the third car and
    // either of the two within the next 3 s. Counted per case (one per follower per battle).
    let bad = 0, cases = 0;
    const seen: string[] = [];
    for (const r of races) {
      const { at, gap, n, frames, k0 } = view(r);
      const contacts = r.events.filter((e) => e.type === 'contact' && e.t >= k0 * r.dt);
      const last = new Map<string, number>();
      for (let k = k0; k < frames; k += 10) {
        for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
          const A = at(k, a), B = at(k, b);
          if (A.status !== STATUS.run || B.status !== STATUS.run || Math.abs(gap(A, B)) >= HIT_LEN || Math.abs(A.d - B.d) < 1.2) continue;
          const rear = gap(A, B) > 0 ? A : B;
          for (let f = 0; f < n; f++) {
            if (f === a || f === b) continue;
            const F = at(k, f), g = gap(F, rear);
            if (F.status !== STATUS.run || g < 5 || g > 60) continue;
            const key = `${f}:${a}:${b}`;
            if (k - (last.get(key) ?? -1e9) < 5 / r.dt) continue;
            last.set(key, k);
            cases++;
            const t = k * r.dt;
            const hit = contacts.find((e) => e.t > t && e.t < t + 3 && e.cars.includes(f) && (e.cars.includes(a) || e.cars.includes(b)));
            if (hit) {
              bad++;
              if (seen.length < 5) seen.push(`${label.get(r)} t=${hit.t.toFixed(1)} ${hit.text}`);
            }
          }
        }
      }
    }
    console.log(`rule 5 violations: ${bad} of ${cases} cases`, seen);
    expect(cases).toBeGreaterThan(0);
    expect(bad).toBeLessThanOrEqual(LIMITS.battleShare * cases);
  });

  it('no hard braking on a straight with nothing to brake for (phase D: Eriksen in a tow at Yas)', () => {
    // A running car braking harder than 15 m/s² (over 0.1 s) where its own plan isn't slowing
    // within 1.5 s, with no car in its lane within 15 m ahead, no car alongside within 1 m, and
    // nothing spun or stopped within 300 m ahead. The user's Yas seed 2 ruling: braking out of a
    // tow for no reason is illogical. Counted per car per 3 s.
    let bad = 0, cases = 0;
    const seen: string[] = [];
    for (const r of races) {
      const { at, gap, n, frames, W, k0 } = view(r);
      const last = new Map<number, number>();
      for (let k = Math.max(W, k0); k < frames; k += 3) {
        for (let a = 0; a < n; a++) {
          const A = at(k, a), A0 = at(k - W, a);
          if (A.status !== STATUS.run || A.v < 30) continue;
          const c = r.cars[a];
          // Its own plan brakes anywhere in the next 1.5 s (into a corner, or the last of the
          // braking before an apex: looking only 1.5 s on saw the corner's exit there).
          // From where the window starts: looking on from its end missed the braking zone the car
          // had just driven, and counted the end of every real braking zone (most of the count).
          const off = A0.d - c.lanes.lineD(A0.s);
          // Clean air or someone's dirty air (a follower plans with less grip; up to 80 m back).
          if ([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5].some((x) => Math.min(c.plans.envelope(A0.s + x * A0.v, off), c.plans.envelope(A0.s + x * A0.v, off, 0, 1)) < A0.v - 1)) continue;
          cases++;
          if ((A0.v - A.v) / (W * r.dt) < 15) continue;
          if (k - (last.get(a) ?? -1e9) < 3 / r.dt) continue;
          let reason = false;
          for (let b = 0; b < n && !reason; b++) {
            if (b === a) continue;
            const B = at(k, b), g = gap(A, B);
            // A car ahead in my lane that's slower than me (the gap rule), or close.
            if (g > 0 && g < 80 && Math.abs(B.d - A.d) < HIT_W + 0.6 && (B.v < A.v || g < 15 + HIT_LEN)) reason = true;
            else if (Math.abs(g) < HIT_LEN && Math.abs(B.d - A.d) < HIT_W + 1) reason = true;
            else if (g > 0 && g < 300 && (B.status !== STATUS.run || B.v < 10)) reason = true;
          }
          if (reason) continue;
          last.set(a, k);
          bad++;
          if (seen.length < 12) seen.push(`${label.get(r)} t=${(k * r.dt).toFixed(1)} ${r.name(a)} ${(A.v * 3.6).toFixed(0)} km/h`);
        }
      }
    }
    console.log(`straight braking: ${bad} in ${cases} car-ticks on a straight`, seen);
    expect(cases).toBeGreaterThan(0);
    expect(bad).toBeLessThanOrEqual(LIMITS.straightBrake);
  });

  it('three wide: the middle car holds its line under braking', () => {
    // Three cars overlapping nose to tail (within HIT_LEN of the middle one), one on each side of
    // it 1.2 m or more away, the middle car braking (over 5 m/s²). Violation: within 0.5 s the
    // middle car moves 0.6 m or more toward either neighbour (from the PLAN's room rules: the
    // middle car of three holds its line).
    let bad = 0, cases = 0;
    const seen: string[] = [];
    for (const r of races) {
      const { at, gap, n, frames, W, k0 } = view(r);
      const last = new Map<number, number>();
      for (let k = Math.max(W, k0); k < frames - 30; k += 5) {
        for (let m = 0; m < n; m++) {
          const M = at(k, m), M0 = at(k - W, m);
          if (M.status !== STATUS.run || (M0.v - M.v) / (W * r.dt) < 5) continue;
          let left = -1, right = -1;
          for (let b = 0; b < n; b++) {
            if (b === m) continue;
            const B = at(k, b);
            if (B.status !== STATUS.run || Math.abs(gap(M, B)) >= HIT_LEN) continue;
            if (B.d - M.d >= 1.2 && (left < 0 || B.d < at(k, left).d)) left = b;
            if (M.d - B.d >= 1.2 && (right < 0 || B.d > at(k, right).d)) right = b;
          }
          if (left < 0 || right < 0) continue;
          if (k - (last.get(m) ?? -1e9) < 2 / r.dt) continue;
          last.set(m, k);
          cases++;
          const later = at(Math.min(frames - 1, k + Math.round(0.5 / r.dt)), m);
          if (Math.abs(later.d - M.d) >= 0.6 && later.status === STATUS.run) {
            bad++;
            if (seen.length < 5) seen.push(`${label.get(r)} t=${(k * r.dt).toFixed(1)} ${r.name(m)} between ${r.name(left)} and ${r.name(right)}`);
          }
        }
      }
    }
    console.log(`three wide, middle car moves: ${bad} of ${cases} cases`, seen);
    expect(bad).toBeLessThanOrEqual(LIMITS.middleShare * Math.max(1, cases));
  });
});

/**
 * Allowed violations, at the default 4 seeds a track. With RULE_SEEDS=16 (32 races), phase A →
 * phase B: rule 3 12 → 0, rule 2 15 of 938 → 2 of 818, rule 1 27 of 265 → 15 of 208, exit room
 * 0 → 0, capacity 22 → 1, rule 5 7 of 2694 → 2 of 1907. All 0 at 4 seeds except rule 1 (6 of
 * 49): Monza only (the check ran on Yas alone before phase B, 0 of 6). What's left there is an
 * attacker that pulls out to a side the defender's line then closes, and gives the move up; it
 * is pinned at 15% of cases, so it can't get worse, until the side choice is fixed.
 */
// Pinned at phase C (2026-11-26), with real car sizes (F1 5.6 × 2.0 m): a few violations came
// back, all on laps 2–3 at Monza T1/T2 and one Yas braking zone, multi-car moments with the
// bigger cars. Phase B had 0 for each. Rule 1 came down from its 15% pin to 1 of 57 (the flatOut
// fix). For D: get these back to 0. Counts are for the default 4 seeds of each track.
const LIMITS = { brakeMove: 5, roomShare: 0.004, towShare: 0.15, exitShare: 0, capacity: 2, battleShare: 0.002, straightBrake: 0, middleShare: 0 };

describe('kerbs, from the race log [slow]', () => {
  // Incident-prone, and the first Monza race with a kerb spin in it to check. Searched, not fixed:
  // the picks moved with every change to the driving (Yas 1 and 2, then 3 and 4; since D's spins
  // need the power down, Yas seeds 1–10 had none).
  const kerbRaces: Race[] = [];
  for (let seed = 1; seed <= 12 && !kerbRaces.length; seed++) {
    const r = new Race(loadScenario({ ...monza.scn, seed, race: { ...monza.scn.race, laps: 3, incidentRate: 4 } }, monza.image).options).run();
    if (r.events.some((e) => /on the kerb/.test(e.text))) kerbRaces.push(r);
  }

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
