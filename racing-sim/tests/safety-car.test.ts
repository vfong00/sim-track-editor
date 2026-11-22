import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AVERAGE_DRIVER, CAR_LENGTH, dWall, identicalField, loadScenario, Race, type Scenario } from '../src/core';
import { lanes7, track7 } from './racing-helpers';

const BASE = JSON.parse(readFileSync(new URL('../scenarios/safety-car.json', import.meta.url).pathname, 'utf8')) as Scenario;

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
  const runs = seeds.map((seed) => runSC({ ...BASE, seed }));

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
    const a = runSC({ ...BASE, seed: 4 }).r, b = runs[0].r;
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
