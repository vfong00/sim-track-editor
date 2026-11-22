import { AVERAGE_RATINGS, DRIVER_COLORS, driverFromRatings, type Entrant } from '../agents/driver';
import { ROSTER, rosterDriver } from '../agents/roster';
import { polylineSelfIntersects, type Vec } from '../math';
import { CAR_PRESETS, STANDARD_CAR, type CarSpec } from '../physics/model';
import { LaneSet } from '../race/lanes';
import { lanePlansFor, type RaceOptions, type ScriptedEvent } from '../race/race';
import { makeRng } from '../rng';
import { generateTrack } from '../track/generate';
import { trackFromPng } from '../track/png';
import { Track } from '../track/track';
import { type Scenario, type ScenarioError, type TrackSpec, parseScenario } from './schema';

/**
 * Bumped whenever the code that turns a track spec into a Track changes, so a cached track
 * (rule 5) built by older code is never reused.
 */
export const TRACK_CODE_VERSION = 2;

export const DEFAULT_WIDTH = 14;

/** A track spec with every default filled in (what the track actually depends on). */
export function normalizeTrack(t: TrackSpec): Required<TrackSpec> {
  const width = t.width ?? DEFAULT_WIDTH;
  if (t.type === 'generated') return { type: 'generated', seed: t.seed, width, complexity: t.complexity ?? 0.6 };
  if (t.type === 'drawn') return { type: 'drawn', points: t.points, width };
  return { type: 'png', image: t.image, length: t.length, width, threshold: t.threshold ?? 200, smoothing: t.smoothing ?? 6, reverse: t.reverse ?? false, start: t.start ?? 0 };
}

/**
 * Cache key for the track (and the lane set and racing line, which depend only on it): every
 * input of `buildTrack` plus the code version (rule 5). The race-specific inputs (cars,
 * drivers, physics, seed) don't go in here; the race's plan cache keys those.
 */
export function trackKey(t: TrackSpec): string {
  return JSON.stringify([TRACK_CODE_VERSION, normalizeTrack(t)]);
}

export class ScenarioBuildError extends Error {
  constructor(readonly errors: ScenarioError[]) {
    super(errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('\n'));
  }
}

/**
 * Build the track. A PNG track needs its image decoded first (`image`; decoding is the
 * caller's job, since it differs between the browser and Node).
 */
export function buildTrack(spec: TrackSpec, image?: ImageData): Track {
  const t = normalizeTrack(spec);
  try {
    if (t.type === 'generated') return generateTrack({ seed: t.seed, width: t.width, complexity: t.complexity });
    if (t.type === 'drawn') {
      const pts: Vec[] = t.points.map(([x, y]) => ({ x, y }));
      const track = Track.fromControlPoints(pts, t.width);
      if (track.length < 200) throw new Error(`the drawn loop is only ${track.length.toFixed(0)} m long (at least 200 m)`);
      const coarse: Vec[] = [];
      for (let i = 0; i < track.n; i += 4) coarse.push({ x: track.xs[i], y: track.ys[i] });
      if (polylineSelfIntersects(coarse)) throw new Error('the drawn loop crosses itself');
      if (track.clearance() < t.width) throw new Error('the drawn loop passes too close to itself (the road would overlap)');
      return track;
    }
    if (!image) throw new Error('the PNG image has not been decoded');
    return trackFromPng(image, t.length, t.width, { threshold: t.threshold, smoothing: t.smoothing, reverse: t.reverse, start: t.start });
  } catch (e) {
    if (e instanceof ScenarioBuildError) throw e;
    throw new ScenarioBuildError([{ path: 'track', message: (e as Error).message }]);
  }
}

/** Car specs by id, with defaults from the car's preset, or else the standard car. */
export function carSpecs(s: Scenario): Map<string, CarSpec> {
  return new Map(s.cars.map((c) => {
    const base: Omit<CarSpec, 'id'> = c.preset ? CAR_PRESETS[c.preset] : STANDARD_CAR;
    return [c.id, {
      id: c.id,
      topSpeed: c.topSpeed ?? base.topSpeed,
      accel: c.accel ?? base.accel,
      grip: c.grip ?? base.grip,
      brake: c.brake ?? base.brake,
      downforce: c.downforce ?? base.downforce ?? 0,
      ...(c.preset ? { preset: c.preset } : {}),
    }];
  }));
}

/** Ratings spread of drivers made up past the end of the roster (at spread 1), around AVERAGE_RATINGS. */
const FIELD_SPREAD = { speed: 0.3, consistency: 0.12, risk: 0.4 };

/**
 * The entrants in grid order (pole first). Listed drivers, then the generated field, then
 * sorted by `race.gridOrder`: 'rating' puts the quickest car-and-driver on pole (by the solver
 * lap time on this track at the starting grip, so a rocket car counts), 'reverse-rating' the
 * slowest. Deterministic in the scenario.
 */
export function scenarioEntrants(s: Scenario, lanes: LaneSet): Entrant[] {
  const cars = carSpecs(s);
  const list: Entrant[] = [];
  const used = new Set((s.drivers ?? []).map((d) => d.name));
  (s.drivers ?? []).forEach((d) => {
    // A roster name brings that driver's own ratings and colour unless the entry overrides them.
    const base = rosterDriver(d.name) ?? { ...AVERAGE_RATINGS, color: undefined };
    const ratings = { speed: d.speed ?? base.speed, consistency: d.consistency ?? base.consistency, risk: d.risk ?? base.risk };
    list.push({
      id: d.name,
      color: d.color ?? base.color ?? DRIVER_COLORS[(DRIVER_COLORS.length - 1 - list.length + 40 * DRIVER_COLORS.length) % DRIVER_COLORS.length],
      car: cars.get(d.car)!,
      driver: driverFromRatings(d.name, ratings, d.advanced),
    });
  });
  if (s.field) {
    const f = s.field;
    const spread = f.spread ?? 1;
    // Roster drivers in roster order (the same people every time), their ratings pulled toward
    // the average by `spread` (0 = all average). Only past the end of the roster are drivers
    // made up, from the field seed.
    const toward = (avg: number, x: number) => avg + (x - avg) * spread;
    const free = ROSTER.filter((d) => !used.has(d.name));
    const rng = makeRng(f.seed ?? s.seed);
    const r = (base: number, x: number) => Math.max(0, Math.min(1, base + (rng.next() * 2 - 1) * x * spread));
    for (let k = 0; k < f.count; k++) {
      const rd = free[k];
      if (rd) {
        const ratings = { speed: toward(AVERAGE_RATINGS.speed, rd.speed), consistency: toward(AVERAGE_RATINGS.consistency, rd.consistency), risk: toward(AVERAGE_RATINGS.risk, rd.risk) };
        list.push({ id: rd.name, color: rd.color, car: cars.get(f.car)!, driver: driverFromRatings(rd.name, ratings) });
        continue;
      }
      const name = `${free[k % Math.max(1, free.length)]?.name ?? 'Driver'} ${Math.floor(k / Math.max(1, free.length)) + 1}`;
      const ratings = { speed: r(AVERAGE_RATINGS.speed, FIELD_SPREAD.speed), consistency: r(AVERAGE_RATINGS.consistency, FIELD_SPREAD.consistency), risk: r(AVERAGE_RATINGS.risk, FIELD_SPREAD.risk) };
      list.push({ id: name, color: DRIVER_COLORS[list.length % DRIVER_COLORS.length], car: cars.get(f.car)!, driver: driverFromRatings(name, ratings) });
    }
  }
  const order = s.race.gridOrder ?? 'as-listed';
  // Rating = clean-air lap time of the car and driver; ties keep list order.
  if (order === 'rating' || order === 'reverse-rating') {
    const lap = new Map(list.map((e) => [e, lanePlansFor(lanes, e.car, e.driver.pace, s.physics).plans.lapTime]));
    const sign = order === 'rating' ? 1 : -1;
    return stableSort(list, (a, b) => sign * (lap.get(a)! - lap.get(b)!));
  }
  if (order === 'random') {
    // Its own stream (not the race's), so the grid draw doesn't shift the race's rolls.
    const rng = makeRng((s.seed ^ 0x5bd1e995) >>> 0);
    for (let i = list.length - 1; i > 0; i--) {
      const j = rng.int(0, i + 1);
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  return list;
}

const stableSort = <T>(a: T[], cmp: (x: T, y: T) => number) =>
  a.map((x, i) => [x, i] as const).sort((p, q) => cmp(p[0], q[0]) || p[1] - q[1]).map((p) => p[0]);

/** Race options for a scenario on a built track (pass `lanes` to reuse a cached lane set). */
export function scenarioRaceOptions(s: Scenario, track: Track, lanes?: LaneSet): RaceOptions {
  lanes ??= new LaneSet(track);
  const entrants = scenarioEntrants(s, lanes);
  const index = new Map(entrants.map((e, i) => [e.driver.name, i]));
  // Stable by lap, so same-lap events fire in the order written.
  const events: ScriptedEvent[] = stableSort(s.events ?? [], (a, b) => a.lap - b.lap).map((e): ScriptedEvent =>
    e.type === 'grip' ? { lap: e.lap, type: 'grip', value: e.value, note: e.note }
      : e.type === 'safety-car' ? { lap: e.lap, type: 'safety-car', laps: e.laps, note: e.note }
      : { lap: e.lap, type: e.type, car: index.get(e.driver)!, note: e.note });
  return {
    track,
    lanes,
    entrants,
    laps: s.race.laps,
    seed: s.seed,
    physics: { ...s.physics },
    incidents: s.race.incidents ?? true,
    incidentRate: s.race.incidentRate ?? 1,
    safetyCar: s.race.safetyCar ?? 'off',
    events,
  };
}

/** Parse, validate and build. Throws ScenarioBuildError (listing every problem) if invalid. */
export function loadScenario(input: unknown, image?: ImageData): { scenario: Scenario; track: Track; options: RaceOptions } {
  const res = parseScenario(input);
  if (!res.ok) throw new ScenarioBuildError(res.errors);
  const track = buildTrack(res.scenario.track, image);
  return { scenario: res.scenario, track, options: scenarioRaceOptions(res.scenario, track) };
}
