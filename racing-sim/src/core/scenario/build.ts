import { AVERAGE_RATINGS, DRIVER_COLORS, driverFromRatings, type Entrant } from '../agents/driver';
import { overallAbility, ROSTER, type RosterDriver, rosterDriver } from '../agents/roster';
import { polylineSelfIntersects, type Vec } from '../math';
import { CAR_PRESETS, STANDARD_CAR, type CarSpec } from '../physics/model';
import { LaneSet } from '../race/lanes';
import { qualifyingResult, qualifyingRun } from '../race/qualifying';
import { lanePlansFor, type RaceOptions, type ScriptedEvent } from '../race/race';
import { makeRng } from '../rng';
import { generateTrack } from '../track/generate';
import { trackFromPng } from '../track/png';
import { Track } from '../track/track';
import { type Scenario, type ScenarioError, type TrackShape, type TrackSpec, parseScenario } from './schema';

/**
 * Bumped whenever the code that turns a track spec into a Track changes, so a cached track
 * (rule 5) built by older code is never reused.
 */
export const TRACK_CODE_VERSION = 2;

export const DEFAULT_WIDTH = 14;

/** A track spec's shape with every default filled in (what the track actually depends on; not its sectors). */
export function normalizeTrack(t: TrackSpec): Required<TrackShape> {
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
    if (t.type === 'generated') return checkSectors(spec, generateTrack({ seed: t.seed, width: t.width, complexity: t.complexity }));
    if (t.type === 'drawn') {
      const pts: Vec[] = t.points.map(([x, y]) => ({ x, y }));
      const track = Track.fromControlPoints(pts, t.width);
      if (track.length < 200) throw new Error(`the drawn loop is only ${track.length.toFixed(0)} m long (at least 200 m)`);
      const coarse: Vec[] = [];
      for (let i = 0; i < track.n; i += 4) coarse.push({ x: track.xs[i], y: track.ys[i] });
      if (polylineSelfIntersects(coarse)) throw new Error('the drawn loop crosses itself');
      if (track.clearance() < t.width) throw new Error('the drawn loop passes too close to itself (the road would overlap)');
      return checkSectors(spec, track);
    }
    if (!image) throw new Error('the PNG image has not been decoded');
    return checkSectors(spec, trackFromPng(image, t.length, t.width, { threshold: t.threshold, smoothing: t.smoothing, reverse: t.reverse, start: t.start }));
  } catch (e) {
    if (e instanceof ScenarioBuildError) throw e;
    throw new ScenarioBuildError([{ path: 'track', message: (e as Error).message }]);
  }
}

/** Sector lines must fall inside the lap, sector 2 ending at least SECTOR_MIN m before the line. */
const SECTOR_MIN = 50;
function checkSectors(spec: TrackSpec, track: Track): Track {
  const s = spec.sectors;
  if (s && s[1] > track.length - SECTOR_MIN) {
    throw new ScenarioBuildError([{ path: 'track.sectors', message: `sector 2 must end at least ${SECTOR_MIN} m before the line (the lap is ${track.length.toFixed(0)} m)` }]);
  }
  return track;
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
 * slowest, 'qualifying' runs each car's qualifying session (`qualifyingRun`: alone, at the
 * limit, two timed laps) and sorts by best lap; a car with no time starts at the back. Rating and
 * qualifying grids record each entrant's `gridTime`. Deterministic in the scenario.
 */
/**
 * The roster drivers a field takes: the first `count` in roster order, or ('mix') one drawn from
 * each of `count` equal bands of the roster sorted by ability, best band first. Its own stream,
 * so the drivers made up past the end of the roster are unchanged. A field as big as the roster
 * takes everyone either way.
 */
export function pickRoster(free: RosterDriver[], count: number, pick: 'roster' | 'mix', seed: number): RosterDriver[] {
  if (pick === 'roster' || count >= free.length) return free;
  const ranked = [...free].sort((a, b) => overallAbility(b) - overallAbility(a) || b.speed - a.speed);
  const rng = makeRng((seed ^ 0x5bd1e995) >>> 0);
  return Array.from({ length: count }, (_, i) => {
    const lo = Math.floor((i * ranked.length) / count), hi = Math.floor(((i + 1) * ranked.length) / count);
    return ranked[lo + rng.int(0, hi - lo)];
  });
}

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
    const free = pickRoster(ROSTER.filter((d) => !used.has(d.name)), f.count, f.pick ?? 'roster', f.seed ?? s.seed);
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
  if (order === 'rating' || order === 'reverse-rating' || order === 'qualifying') {
    const ideal = (e: Entrant) => lanePlansFor(lanes, e.car, e.driver.pace, s.physics).plans.lapTime;
    // Session seeds: their own stream, like the random grid's, drawn in list order.
    const rng = makeRng((s.seed ^ 0x2c1b3c6d) >>> 0);
    const timed = list.map((e): Entrant => {
      if (order !== 'qualifying') return { ...e, gridTime: ideal(e) };
      const seed = Math.floor(rng.next() * 4294967296);
      const q = qualifyingResult(qualifyingRun({ lanes, entrant: e, seed, physics: s.physics, incidents: s.race.incidents ?? true, incidentRate: s.race.incidentRate ?? 1, sectors: s.track.sectors }));
      return { ...e, gridTime: Number.isFinite(q.best) ? q.best : undefined, quali: { seed, laps: q.laps, sectors: q.sectors, note: q.note } };
    });
    const key = (e: Entrant) => e.gridTime ?? Infinity;
    const sign = order === 'reverse-rating' ? -1 : 1;
    return stableSort(timed, (a, b) => sign * (key(a) - key(b)) || 0);
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
    ...(s.track.sectors ? { sectors: s.track.sectors } : {}),
  };
}

/** Parse, validate and build. Throws ScenarioBuildError (listing every problem) if invalid. */
export function loadScenario(input: unknown, image?: ImageData): { scenario: Scenario; track: Track; options: RaceOptions } {
  const res = parseScenario(input);
  if (!res.ok) throw new ScenarioBuildError(res.errors);
  const track = buildTrack(res.scenario.track, image);
  return { scenario: res.scenario, track, options: scenarioRaceOptions(res.scenario, track) };
}
