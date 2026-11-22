import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildTrack, decodeScenario, driverFromRatings, encodeScenario, formatError, loadScenario, parseScenario, Race,
  riskTaking, type Scenario, FRAME_STRIDE, STATUS, ScenarioBuildError, scenarioEntrants, scenarioRaceOptions, SHARE_LIMIT, trackKey, LaneSet, PACE_MAX, PACE_MIN,
} from '../src/core';
import { decodeDataUrl } from '../src/cli/png-node';

/** The example scenarios shipped with the viewer (each must validate and run). */
const DIR = new URL('../scenarios/', import.meta.url).pathname;
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
/** Scenarios the checks depend on, kept apart so the examples can change freely. */
const FIX = new URL('./fixtures/scenarios/', import.meta.url).pathname;
const read = (f: string) => JSON.parse(readFileSync(FIX + f, 'utf8')) as Scenario;
const readExample = (f: string) => JSON.parse(readFileSync(DIR + f, 'utf8')) as Scenario;
const imageOf = (s: Scenario) => (s.track.type === 'png' ? decodeDataUrl(s.track.image) : undefined);
const run = (s: Scenario) => new Race(loadScenario(s, imageOf(s)).options).run();

/** A small valid scenario to break in different ways. */
const base = (): Scenario => ({
  version: 1,
  name: 'test',
  seed: 3,
  track: { type: 'generated', seed: 7 },
  race: { laps: 2 },
  cars: [{ id: 'standard' }, { id: 'rocket', topSpeed: 95, grip: 1.1 }],
  drivers: [
    { name: 'Ortiz', car: 'standard' },
    { name: 'Lee', car: 'rocket', speed: 0.2 },
  ],
});

/**
 * Contacts with a car that was already out and at rest (a wreck or a retired car): drivers
 * must steer round those. A regression check for the Phase 5 avoidance, which judged a wreck
 * by where the car was then, not where its line would be at the wreck (in the rain example the
 * line sweeps across the road into T2 and the field piled into a wreck at the edge).
 */
function wreckHits(r: Race): string[] {
  // Only wrecks that were already at rest a reaction time earlier: in a pile-up, a car that
  // came to rest half a second ago can't be avoided by the one right behind it.
  const react = Math.round(1.5 / r.dt);
  return r.events.filter((e) => e.type === 'contact' && e.cars.some((x) => {
    const k = Math.max(0, Math.round(e.t / r.dt) - 2);
    return r.frames[k][x * FRAME_STRIDE + 4] === STATUS.out && r.frames[Math.max(0, k - react)][x * FRAME_STRIDE + 4] === STATUS.out;
  })).map((e) => `${e.t.toFixed(1)} ${e.text}`);
}

const sameLog = (a: Race, b: Race) =>
  a.frames.length === b.frames.length &&
  a.frames.every((f, k) => Buffer.from(f.buffer).equals(Buffer.from(b.frames[k].buffer))) &&
  JSON.stringify(a.events) === JSON.stringify(b.events);

describe('Phase 6: example scenarios', () => {
  it('there are examples, covering every track type and event type', () => {
    const all = files.map(readExample);
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(new Set(all.map((s) => s.track.type))).toEqual(new Set(['generated', 'drawn', 'png']));
    expect(new Set(all.flatMap((s) => (s.events ?? []).map((e) => e.type)))).toEqual(new Set(['grip', 'spin', 'retire', 'safety-car']));
  });

  it.each(files)('%s validates and runs to completion', (f) => {
    const s = readExample(f);
    const res = parseScenario(readFileSync(DIR + f, 'utf8'));
    expect(res.ok ? [] : res.errors.map(formatError)).toEqual([]);
    const r = run(s);
    expect(r.finished).toBe(true);
    // Somebody takes the flag, and the winner covered the full distance.
    const winner = r.cars[r.order()[0]];
    expect(winner.finished).toBe(true);
    expect(winner.finishLaps).toBe(s.race.laps);
    expect(wreckHits(r)).toEqual([]);
    // Every scripted event happened, on the lap it was set for.
    for (const e of s.events ?? []) {
      const logged = r.events.find((x) => x.type === e.type &&
        (e.type === 'grip' ? x.text.endsWith(`grip ${(e.value * 100).toFixed(0)}%`)
          : e.type === 'safety-car' ? x.text.startsWith('Safety car:') && x.lap === e.lap
          : r.name(x.cars[0]) === e.driver));
      expect(logged, `${e.type} on lap ${e.lap}`).toBeDefined();
      expect(logged!.lap).toBe(e.lap);
    }
  });
});

describe('Phase 6: invalid files fail with clear errors', () => {
  const errorsOf = (s: unknown) => {
    const res = parseScenario(s);
    return res.ok ? [] : res.errors.map(formatError);
  };
  const cases: [string, (s: any) => unknown, string[]][] = [
    ['not JSON', () => '{ "name": "x", ', ['not valid JSON']],
    ['a list, not an object', () => [], ['must be an object (got an array)']],
    ['missing name', (s) => { delete s.name; return s; }, ['name: is required']],
    ['misspelt key', (s) => { s.race = { lpas: 3 }; return s; }, ['race.lpas: unknown key (did you mean "laps"?)', 'race.laps: is required']],
    ['unknown top-level key', (s) => { s.weather = 'rain'; return s; }, ['weather: unknown key (allowed: ']],
    ['laps out of range', (s) => { s.race.laps = 0; return s; }, ['race.laps: must be between 1 and 200 (got 0)']],
    ['fractional laps', (s) => { s.race.laps = 2.5; return s; }, ['race.laps: must be a whole number (got 2.5)']],
    ['rating out of range', (s) => { s.drivers[1].speed = 1.4; return s; }, ['drivers[1].speed: must be between 0 and 1 (got 1.4)']],
    ['wrong type', (s) => { s.drivers[0].risk = 'high'; return s; }, ['drivers[0].risk: must be a number (got string "high")']],
    ['unknown car', (s) => { s.drivers[1].car = 'rockit'; return s; }, ['drivers[1].car: no car with id "rockit" (did you mean "rocket"?)']],
    ['duplicate driver', (s) => { s.drivers[1].name = 'Ortiz'; return s; }, ['drivers[1].name: "Ortiz" is used by another driver']],
    ['duplicate car', (s) => { s.cars[1].id = 'standard'; return s; }, ['cars[1].id: "standard" is used by another car']],
    ['car spec out of range', (s) => { s.cars[0].grip = 5; return s; }, ['cars[0].grip: must be between 0.3 and 3 (got 5)']],
    ['bad advanced rating', (s) => { s.drivers[0].advanced = { bravry: 1 }; return s; }, ['drivers[0].advanced.bravry: unknown key (did you mean "bravery"?)']],
    ['unknown track type', (s) => { s.track = { type: 'oval' }; return s; }, ['track.type: must be one of "generated", "drawn", "png" (got string "oval")']],
    ['too few drawn points', (s) => { s.track = { type: 'drawn', points: [[0, 0], [100, 0]] }; return s; }, ['track.points: needs at least 3 entries (got 2)']],
    ['bad drawn point', (s) => { s.track = { type: 'drawn', points: [[0, 0], [100, 0], [50]] }; return s; }, ['track.points[2]: must be [x, y] in metres (got [50])']],
    ['PNG without a data URL', (s) => { s.track = { type: 'png', image: 'track.png', length: 4000 }; return s; }, ['track.image: must be a PNG data URL']],
    ['no drivers', (s) => { delete s.drivers; return s; }, ['drivers: the race needs at least one driver']],
    ['too many cars', (s) => { s.field = { count: 40, car: 'standard' }; return s; }, ['drivers: too many cars: 42 (drivers plus field), at most 40']],
    ['event for an unknown driver', (s) => { s.events = [{ lap: 1, type: 'spin', driver: 'Leee' }]; return s; }, ['events[0].driver: no listed driver named "Leee" (did you mean "Lee"?)']],
    ['event after the last lap', (s) => { s.events = [{ lap: 5, type: 'grip', value: 0.8 }]; return s; }, ['events[0].lap: is after the last lap (2)']],
    ['event without its value', (s) => { s.events = [{ lap: 1, type: 'grip' }]; return s; }, ['events[0].value: is required']],
    ['safety car without laps', (s) => { s.events = [{ lap: 1, type: 'safety-car' }]; return s; }, ['events[0].laps: is required']],
    ['safety car for too long', (s) => { s.events = [{ lap: 1, type: 'safety-car', laps: 12 }]; return s; }, ['events[0].laps: must be between 1 and 10 (got 12)']],
    ['unknown event type', (s) => { s.events = [{ lap: 1, type: 'red-flag' }]; return s; }, ['events[0].type: must be one of "grip", "spin", "retire", "safety-car" (got string "red-flag")']],
    ['bad safety car option', (s) => { s.race.safetyCar = 'yes'; return s; }, ['race.safetyCar: must be one of "off", "auto" (got string "yes")']],
    ['newer version', (s) => { s.version = 2; return s; }, ['version: 2 is newer than this sim understands (1)']],
  ];
  it.each(cases)('%s', (_, mutate, expected) => {
    const errs = errorsOf(mutate(base()));
    for (const want of expected) expect(errs.some((e) => e.startsWith(want)), `wanted "${want}", got ${JSON.stringify(errs)}`).toBe(true);
  });

  it('the valid base passes, and every problem in a file is reported at once', () => {
    expect(errorsOf(base())).toEqual([]);
    const s: any = base();
    s.race.laps = -1;
    s.drivers[0].speed = 2;
    s.cars[0].brake = 0;
    expect(errorsOf(s)).toHaveLength(3);
  });

  it('tracks that cannot be built fail with a track error, not a crash', () => {
    const figure8: [number, number][] = [[-300, -150], [0, 0], [300, 150], [450, 0], [300, -150], [0, 0], [-300, 150], [-450, 0]];
    const tiny: [number, number][] = [[0, 0], [30, 0], [15, 20]];
    for (const [points, msg] of [[figure8, 'crosses itself'], [tiny, 'long']] as const) {
      let caught: unknown;
      try { buildTrack({ type: 'drawn', points: points as [number, number][] }); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(ScenarioBuildError);
      expect((caught as ScenarioBuildError).errors[0].path).toBe('track');
      expect((caught as ScenarioBuildError).message).toContain(msg);
    }
    expect(() => loadScenario({ ...base(), race: { laps: 0 } })).toThrow('race.laps: must be between 1 and 200');
  });
});

describe('Phase 6: replay from seed', () => {
  it('the same scenario file loaded twice gives an identical state log; another seed does not', () => {
    const text = readFileSync(FIX + 'drawn-kidney.json', 'utf8');
    const a = run(JSON.parse(text)), b = run(JSON.parse(text));
    expect(sameLog(a, b)).toBe(true);
    const c = run({ ...JSON.parse(text), seed: 6 });
    expect(sameLog(a, c)).toBe(false);
  });

  it('a shared link replays the original race exactly', async () => {
    const s = read('rookie-rocket-rain.json');
    const hash = await encodeScenario(s);
    expect(hash.length).toBeLessThan(2000);
    const back = await decodeScenario('#' + hash);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.scenario).toEqual(s);
    expect(sameLog(run(s), run(back.scenario))).toBe(true);
  });

  it('a damaged link fails clearly; a PNG scenario is refused as a link with a pointer to the file', async () => {
    const hash = await encodeScenario(base());
    const cut = await decodeScenario(hash.slice(0, hash.length - 10));
    expect(cut.ok).toBe(false);
    if (!cut.ok) expect(formatError(cut.errors[0])).toMatch(/damaged|not valid JSON/);
    expect((await decodeScenario('#x=1')).ok).toBe(false);
    await expect(encodeScenario(read('png-yas.json'))).rejects.toThrow(/too big to share as a link.*PNG.*file instead/);
    expect(SHARE_LIMIT).toBeGreaterThan(1000);
  });
});

describe('Phase 6: driver ratings', () => {
  it('speed, consistency and risk map onto the internal ratings; risk-taking equals risk', () => {
    const avg = driverFromRatings('A', { speed: 0.5, consistency: 0.85, risk: 0.5 });
    expect(avg.pace).toBeCloseTo((PACE_MIN + PACE_MAX) / 2, 10);
    for (const risk of [0, 0.3, 1]) {
      const d = driverFromRatings('A', { speed: 0.5, consistency: 0.85, risk });
      expect(d.aggression).toBe(risk);
      expect(d.bravery).toBe(risk);
      expect(riskTaking(d)).toBeCloseTo(risk, 12);
    }
    const fast = driverFromRatings('A', { speed: 1, consistency: 0.9, risk: 0.5 });
    expect(fast.pace).toBe(1);
    expect(fast.racecraft).toBeCloseTo(0.95, 12);
    // Advanced overrides win.
    const adv = driverFromRatings('A', { speed: 0.5, consistency: 0.85, risk: 0.5 }, { racecraft: 0.1, pace: 0.99 });
    expect(adv.racecraft).toBe(0.1);
    expect(adv.pace).toBe(0.99);
  });

  it('grid order: rating puts the quickest car-and-driver on pole, reverse-rating at the back, random is seeded', () => {
    const s = read('rookie-rocket-rain.json');
    const lanes = new LaneSet(buildTrack(s.track));
    const names = (o: Scenario['race']['gridOrder'], seed = s.seed) =>
      scenarioEntrants({ ...s, seed, race: { ...s.race, gridOrder: o } }, lanes).map((e) => e.driver.name);
    // The rookie is the slowest driver but in a much faster car: quickest overall.
    expect(names('rating')[0]).toBe('Rookie');
    expect(names('reverse-rating').at(-1)).toBe('Rookie');
    expect(names('as-listed')[0]).toBe('Rookie');
    expect(names('random')).toEqual(names('random'));
    expect([...names('random')].sort()).toEqual([...names('as-listed')].sort());
    const draws = new Set([1, 2, 3, 4, 5].map((k) => names('random', k).join()));
    expect(draws.size).toBeGreaterThan(1);
  });

  it('qualifying: each car runs its own session; best lap sets the grid; close drivers swap pole', () => {
    const s = read('equal-field.json');
    const lanes = new LaneSet(buildTrack(s.track));
    // Chen's ideal lap is a hair quicker; Alvarez is far steadier (their roster ratings).
    const base = { ...s, drivers: [{ name: 'Chen', car: s.cars[0].id }, { name: 'Alvarez', car: s.cars[0].id }], field: undefined };
    const grid = (seed: number) => scenarioEntrants({ ...base, seed, race: { ...s.race, gridOrder: 'qualifying' } }, lanes);
    expect(grid(3)).toEqual(grid(3));
    const poles = { Chen: 0, Alvarez: 0 };
    for (let seed = 1; seed <= 16; seed++) {
      const g = grid(seed);
      expect(g[0].gridTime!).toBeLessThanOrEqual(g[1].gridTime!);
      for (const e of g) expect(e.gridTime).toBe(Math.min(...e.quali!.laps));
      poles[g[0].driver.name as 'Chen' | 'Alvarez']++;
    }
    expect(poles.Chen).toBeGreaterThan(0);
    expect(poles.Alvarez).toBeGreaterThan(0);
  });

  // A crash on the second lap still leaves a time from the first, so look for a first-lap one.
  it('qualifying: a car that sets no time starts at the back', () => {
    const s = read('equal-field.json');
    const lanes = new LaneSet(buildTrack({ type: 'generated', seed: 7 }));
    const wild = { name: 'Wild', car: s.cars[0].id, speed: 0.5, consistency: 0, risk: 1 };
    const base = { ...s, drivers: [wild, { name: 'A', car: s.cars[0].id }, { name: 'B', car: s.cars[0].id }], field: undefined };
    let found = false;
    for (let seed = 1; seed <= 150 && !found; seed++) {
      const g = scenarioEntrants({ ...base, seed, race: { ...s.race, gridOrder: 'qualifying', incidentRate: 4 } }, lanes);
      const out = g.findIndex((e) => e.gridTime === undefined);
      if (out < 0) continue;
      found = true;
      expect(out).toBe(g.length - 1);
      expect(g[out].quali!.note).toMatch(/Crashes out|retires/);
    }
    expect(found).toBe(true);
  });
});

describe('Phase 6: mid-race events', () => {
  it('a grip change re-plans every car for the new grip from the lap it is set for', () => {
    const s: Scenario = { ...base(), race: { laps: 3 }, events: [{ lap: 2, type: 'grip', value: 0.8, note: 'rain' }] };
    const r = new Race(loadScenario(s).options);
    const before = r.cars.map((c) => ({ mu: c.model.mu, lap: c.plans.lapTime, plans: c.plans }));
    while (r.leaderLap < 2) r.step();
    expect(r.physics.gripLevel).toBe(1);
    r.step();
    expect(r.physics.gripLevel).toBe(0.8);
    const ev = r.events.find((e) => e.type === 'grip')!;
    expect(ev.text).toBe('Rain: track grip 80%');
    expect(ev.lap).toBe(2);
    r.cars.forEach((c, i) => {
      // Against the car's own spec now: contact before lap 2 can have damaged it (less grip).
      expect(c.model.mu).toBeCloseTo(c.model.spec.grip * r.physics.g * 0.8, 9);
      expect(c.plans).not.toBe(before[i].plans);
      expect(c.plans.lapTime).toBeGreaterThan(before[i].lap * 1.05);
    });
    r.run();
    expect(r.finished).toBe(true);
  });

  it('scripted retirements and spins hit the named driver', () => {
    const s: Scenario = { ...base(), race: { laps: 3, gridOrder: 'reverse-rating' }, events: [
      { lap: 2, type: 'retire', driver: 'Lee' }, { lap: 3, type: 'spin', driver: 'Ortiz' },
    ] };
    const r = new Race(loadScenario(s).options).run();
    const lee = r.cars.find((c) => r.name(c.idx) === 'Lee')!;
    expect(lee.dnf).toBe(true);
    expect(r.events.find((e) => e.type === 'retire')!.lap).toBe(2);
    // The scripted one, on lap 3 (Ortiz may also spin by himself earlier).
    const spins = r.events.filter((e) => e.type === 'spin' && r.name(e.cars[0]) === 'Ortiz');
    expect(spins.map((e) => e.lap)).toContain(3);
  });

  it('incident settings: off makes the edge a wall; the rate scales incidents', () => {
    const s = read('equal-field.json');
    const off = run({ ...s, race: { ...s.race, incidents: false } });
    expect(off.stats().offs + off.stats().spins + off.stats().dnfs).toBe(0);
    const opts = scenarioRaceOptions({ ...s, race: { ...s.race, incidentRate: 2 } }, buildTrack(s.track));
    expect(opts.incidentRate).toBe(2);
  });
});

describe('Phase 6: cache keys (rule 5)', () => {
  it('the track key changes with every track input and ignores spelled-out defaults', () => {
    const g = { type: 'generated', seed: 7 } as const;
    expect(trackKey(g)).toBe(trackKey({ ...g, width: 14, complexity: 0.6 }));
    const keys = [
      g, { ...g, seed: 8 }, { ...g, width: 12 }, { ...g, complexity: 0.5 },
      { type: 'drawn', points: [[0, 0], [400, 0], [200, 300]] }, { type: 'drawn', points: [[0, 0], [400, 0], [200, 301]] },
      { type: 'drawn', points: [[0, 0], [400, 0], [200, 300]], width: 12 },
      { type: 'png', image: 'data:image/png;base64,AAAA', length: 4000 }, { type: 'png', image: 'data:image/png;base64,AAAB', length: 4000 },
      { type: 'png', image: 'data:image/png;base64,AAAA', length: 4001 }, { type: 'png', image: 'data:image/png;base64,AAAA', length: 4000, threshold: 100 },
      { type: 'png', image: 'data:image/png;base64,AAAA', length: 4000, smoothing: 3 },
    ].map((t) => trackKey(t as Scenario['track']));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
