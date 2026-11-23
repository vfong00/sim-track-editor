import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AVERAGE_DRIVER, CAR_LENGTH, dWall, identicalField, INCIDENTS, loadScenario, Race, type Scenario, STATUS } from '../src/core';
import { lanes7, track7 } from './racing-helpers';

const BASE = JSON.parse(readFileSync(new URL('./fixtures/scenarios/safety-car.json', import.meta.url).pathname, 'utf8')) as Scenario;

/** Moves already under way when the safety car comes out may still complete (s). */
const GRACE = 5;

interface Window { deploy: number; green: number; spreadAtDeploy: number; gapsAtGreen: number[]; battling: string[] }

/** Run a scenario, recording when the safety car was out and how the field was spread. */
function runSC(s: Scenario): { r: Race; w: Window } {
  const r = new Race(loadScenario(s).options);
  const L = r.track.length;
  // Running cars on the lead lap, in order, and the road gaps between them.
  const queue = () => {
    const run = r.order().filter((i) => !r.cars[i].dnf && !r.cars[i].finished && r.cars[i].status === 'run');
    const lead = r.cars[run[0]].st.dist;
    return run.filter((i) => lead - r.cars[i].st.dist < L / 2).map((i) => r.cars[i].st.dist);
  };
  const w: Window = { deploy: NaN, green: NaN, spreadAtDeploy: NaN, gapsAtGreen: [], battling: [] };
  let was = false;
  while (!r.finished && r.t < 3600) {
    r.step();
    const out = r.sc !== null;
    if (out && !was && Number.isNaN(w.deploy)) {
      w.deploy = r.t;
      const q = queue();
      w.spreadAtDeploy = q[0] - q[q.length - 1];
    }
    if (!out && was && Number.isNaN(w.green)) {
      w.green = r.t;
      const q = queue();
      w.gapsAtGreen = q.slice(1).map((d, k) => q[k] - d);
    }
    if (out) for (const c of r.cars) if (c.craft.mode !== 'line') w.battling.push(`${r.name(c.idx)} ${c.craft.mode} @${r.t.toFixed(1)}`);
    was = out;
  }
  return { r, w };
}

describe('Phase 6: safety car', () => {
  const seeds = [4, 5, 6, 7];
  // The scripted safety car on its own: with 'auto' on, a car stopping later brings out a second
  // one, which these checks of the first window would count as its own (it has a test below).
  const runs = seeds.map((seed) => runSC({ ...BASE, seed, race: { ...BASE.race, safetyCar: 'off' } }));

  it('comes out on the lap set, stays out for the laps set, and the race finishes', () => {
    for (const { r, w } of runs) {
      expect(r.finished).toBe(true);
      const sc = r.events.filter((e) => e.type === 'safety-car');
      expect(sc.map((e) => e.text)).toEqual(['Safety car: debris', 'Safety car in this lap', 'Green flag: racing resumes']);
      expect(sc[0].lap).toBe(3);
      expect(sc[2].lap).toBe(5);
      expect(w.green).toBeGreaterThan(w.deploy);
    }
  });

  it('nobody passes or makes contact under it (moves already under way may finish)', () => {
    for (const { r, w } of runs) {
      const under = r.events.filter((e) => e.t > w.deploy + GRACE && e.t < w.green);
      // Passing a car in trouble (spun, off, after a mistake) is allowed; racing for position is not.
      expect(under.filter((e) => e.type === 'pass' && !/ after /.test(e.text)).map((e) => e.text)).toEqual([]);
      expect(under.filter((e) => e.type === 'contact').map((e) => e.text)).toEqual([]);
      // Nobody attacks or defends while it is out.
      expect(w.battling).toEqual([]);
    }
  });

  it('bunches the field up: at the restart every car is within 40 m of the one ahead', () => {
    for (const { w } of runs) {
      expect(w.gapsAtGreen.length).toBeGreaterThan(5);
      expect(Math.max(...w.gapsAtGreen)).toBeLessThan(40);
      // The whole queue is no longer than ~3 s at racing speed.
      expect(w.gapsAtGreen.reduce((a, b) => a + b, 0)).toBeLessThan(Math.max(300, w.spreadAtDeploy));
    }
  });

  it('laps under it are much slower, and racing pace returns after the green flag', () => {
    for (const { r } of runs) {
      const leader = r.cars[r.order()[0]];
      const t = leader.lapTimes;
      // Lap 2 is a green racing lap; laps 3 and 4 are behind the safety car; lap 6 is racing again.
      expect(Math.min(t[2], t[3])).toBeGreaterThan(1.3 * t[1]);
      expect(Math.abs(t[5] / t[1] - 1)).toBeLessThan(0.03);
    }
  });

  it('same seed gives the same race, safety car included', () => {
    const a = runSC({ ...BASE, seed: 4, race: { ...BASE.race, safetyCar: 'off' } }).r, b = runs[0].r;
    expect(a.frames.length).toBe(b.frames.length);
    for (let k = 0; k < a.frames.length; k += 7) expect(Buffer.from(a.frames[k].buffer).equals(Buffer.from(b.frames[k].buffer))).toBe(true);
    expect(a.events).toEqual(b.events);
    expect(a.scLog).toEqual(b.scLog);
  });

  it("'auto' sends it out when a car stops on track, with the stop as its cause; 'off' does not", () => {
    const s = (sc: 'auto' | 'off'): Scenario => ({
      ...BASE, events: [], race: { laps: 4, safetyCar: sc },
      drivers: [{ name: 'Ace', car: 'standard', speed: 0.8 }], field: { count: 7, car: 'standard' },
      // The leader's engine fails: it coasts to a stop at the side of the road.
    } as Scenario);
    const auto = new Race(loadScenario({ ...s('auto'), events: [{ lap: 2, type: 'retire', driver: 'Ace' }] }).options).run();
    const dep = auto.events.findIndex((e) => e.type === 'safety-car');
    expect(dep).toBeGreaterThan(-1);
    expect(auto.events[dep].text).toMatch(/^Safety car: Ace stopped at /);
    expect(auto.events[auto.events[dep].cause!].type).toBe('retire');
    expect(auto.finished).toBe(true);
    const off = new Race(loadScenario({ ...s('off'), events: [{ lap: 2, type: 'retire', driver: 'Ace' }] }).options).run();
    expect(off.events.some((e) => e.type === 'safety-car')).toBe(false);
  });
});

describe('Phase 5 fix: a beached car retires', () => {
  it('a car stuck in the run-off against a wreck retires instead of holding up the finish for ever', () => {
    // Staged (organic beachings depend on one exact crash, which any physics change moves): car 0
    // wrecked against the outside barrier, car 1 stopped nose-to-tail behind it in the run-off and
    // car 2 wrecked alongside car 1, so car 1 has no way out.
    const r = new Race({ track: track7, lanes: lanes7, entrants: identicalField(4, AVERAGE_DRIVER), laps: 2, seed: 1 });
    while (r.t < 8) r.step();
    const [wreck, stuckCar, wreck2] = [r.cars[0], r.cars[1], r.cars[2]];
    const s0 = (wreck.st.s + 400) % track7.length;
    const wall = dWall(track7);
    for (const [c, s, d] of [[wreck, s0, wall], [stuckCar, s0 - CAR_LENGTH - 0.3, wall], [wreck2, s0 - CAR_LENGTH - 0.3, wall - 2.2]] as const) {
      c.st.dist += s - c.st.s;
      c.st.s = s;
      c.st.v = 0;
      c.st.vDelta = 0;
      c.st.delta = d - lanes7.lineD(s);
    }
    r.retire(0);
    r.retire(2);
    while (!r.finished && r.t < 600) r.step();
    expect(r.finished).toBe(true);
    const stuck = r.events.find((e) => e.type === 'retire' && /is stuck at .* and retires/.test(e.text));
    expect(stuck?.text.startsWith(r.name(1))).toBe(true);
    expect(r.events[stuck!.cause!].type).toBe('off');
  });
});

describe('marshals clear wrecks', () => {
  it('a car out of the race is cleared after INCIDENTS.clearAfter and is no longer there to hit', () => {
    const r = new Race({ track: track7, lanes: lanes7, entrants: identicalField(3, AVERAGE_DRIVER), laps: 3, seed: 2 });
    while (r.t < 10) r.step();
    r.retire(0);
    const stopped = () => r.cars[0].status === 'out';
    while (!stopped()) r.step();
    const restAt = r.t;
    while (r.t < restAt + INCIDENTS.clearAfter + 1) r.step();
    const ev = r.events.find((e) => e.type === 'cleared');
    expect(ev?.cars).toEqual([0]);
    expect(ev!.t - restAt).toBeCloseTo(INCIDENTS.clearAfter, 0);
    expect(r.frames[r.frames.length - 1][4]).toBe(STATUS.cleared);
    // Nobody can touch it afterwards, and the others never queue behind it.
    while (!r.finished) r.step();
    expect(r.events.filter((e) => e.type === 'contact' && e.t > ev!.t && e.cars.includes(0))).toEqual([]);
  });
});

describe('a scripted safety car always comes out', () => {
  const sc = (r: Race) => r.events.filter((e) => e.type === 'safety-car').map((e) => `L${e.lap} ${e.text}`);
  const scripted = (events: Scenario['events']) => new Race(loadScenario({ ...BASE, race: { laps: 8 }, events }).options).run();

  it('one already on track stays out for the scripted laps too', () => {
    const r = scripted([{ lap: 2, type: 'safety-car', laps: 2, note: 'oil' }, { lap: 3, type: 'safety-car', laps: 2, note: 'debris' }]);
    expect(sc(r)).toEqual(['L2 Safety car: oil', 'L3 Safety car: debris (stays out)', 'L4 Safety car in this lap', 'L5 Green flag: racing resumes']);
  });

  it('one that has pulled in but not yet gone green comes straight back out', () => {
    const r = scripted([{ lap: 2, type: 'safety-car', laps: 1, note: 'oil' }, { lap: 3, type: 'safety-car', laps: 2, note: 'debris' }]);
    const log = sc(r);
    expect(log.slice(0, 3)).toEqual(['L2 Safety car: oil', 'L2 Safety car in this lap', 'L3 Safety car: debris']);
    expect(log.at(-1)).toBe('L5 Green flag: racing resumes');
  });
});

describe('cars caught in a pile-up drive out of it', () => {
  it('steers round the wreck in its own path and creeps past one it is already clear of', () => {
    // Staged from the rookie-rocket pile-up at Yas T10 (seed 42 in the browser), offsets from
    // the road centre as they were. Wrecks: P (3.6 m ahead of A, d −0.3), J (alongside A, d −0.3)
    // and R (alongside A, d 1.7). Running cars at a standstill: A (d −2.9, clear of P sideways
    // but already partly alongside it, with G stopped right behind), B (behind R and J, which sit
    // side by side, R in B's path, and G alongside B where B's racing line runs). G is a wreck
    // here; in the race it was a third stuck car. Before the fix A and B sat there until they
    // retired as stuck.
    const r = new Race({ track: track7, lanes: lanes7, entrants: identicalField(7, AVERAGE_DRIVER), laps: 2, seed: 1 });
    while (r.t < 8) r.step();
    const [P, J, R, G, A, B] = [0, 1, 2, 3, 4, 5].map((i) => r.cars[i]);
    const s0 = (r.cars[6].st.s + 400) % track7.length;
    const at = (ds: number) => (s0 + ds + track7.length) % track7.length;
    for (const [c, s, d] of [[P, at(3.56), -0.32], [J, at(-0.44), -0.32], [R, at(-0.28), 1.68], [G, at(-4.06), -2.92], [A, at(0), -2.92], [B, at(-4.44), 2.09]] as const) {
      c.st.dist += s - c.st.s;
      c.st.s = s;
      c.st.v = 0;
      c.st.vDelta = 0;
      c.st.delta = d - lanes7.lineD(s);
    }
    for (const i of [0, 1, 2, 3]) r.retire(i);
    const from = [A.st.dist, B.st.dist];
    const t0 = r.t;
    while (r.t < t0 + 15) r.step();
    expect(A.dnf || B.dnf).toBe(false);
    expect(A.st.dist - from[0]).toBeGreaterThan(30);
    expect(B.st.dist - from[1]).toBeGreaterThan(30);
  });
});
