/**
 * Scenario files (Phase 6): the schema, and validation with errors that name the field.
 *
 * A scenario is plain JSON: a track, cars, drivers, race rules and mid-race events, plus a seed.
 * The same scenario and seed always give the same race (design rule 3).
 *
 * Validation is strict: unknown keys are errors (with a "did you mean" hint), because a typo
 * like "lpas" that silently falls back to a default would give a different race than intended
 * with no sign why. Optional fields have documented defaults (see `normalizeScenario`).
 */

import { CAR_PRESET_IDS, type CarPreset } from '../physics/model';

export const SCENARIO_VERSION = 1;

export type GridOrder = 'as-listed' | 'qualifying' | 'rating' | 'reverse-rating' | 'random';

/** The track's shape: everything the built track (and its cache key) depends on. */
export type TrackShape =
  | { type: 'generated'; seed: number; width?: number; complexity?: number }
  /** Control points of a closed spline, in metres. */
  | { type: 'drawn'; points: [number, number][]; width?: number }
  /** A PNG data URL of a dark track line on a light background, scaled to `length` metres. */
  | { type: 'png'; image: string; length: number; width?: number; threshold?: number; smoothing?: number; reverse?: boolean; start?: number };

/**
 * A track: its shape, plus timing that doesn't change the shape. `sectors`: where sectors 1 and
 * 2 end, in metres from the start line along the centreline (default: the lap in thirds).
 */
export type TrackSpec = TrackShape & { sectors?: [number, number] };

export interface CarEntry {
  id: string;
  /** A quick configuration (f1, lmp, gt3, road, mx5) whose values are the defaults for the rest. */
  preset?: CarPreset;
  /** m/s; default 85 (or the preset's). */
  topSpeed?: number;
  /** m/s²; default 11. */
  accel?: number;
  /** Tyre friction (g); default 1. */
  grip?: number;
  /** Braking relative to grip; default 1. */
  brake?: number;
  /** Extra grip per (m/s)² from downforce, in g; default 0 (or the preset's). */
  downforce?: number;
}

/** Internal ratings, for when the simple three are not enough. Any given here win. */
export interface AdvancedRatings {
  pace?: number;
  consistency?: number;
  aggression?: number;
  racecraft?: number;
  bravery?: number;
}

export interface DriverEntry {
  name: string;
  /** A car id from `cars`. */
  car: string;
  /** 0–1; default 0.5 (pace 0.98). */
  speed?: number;
  /** 0–1; default 0.85. */
  consistency?: number;
  /** 0–1; default 0.5 (aggression and bravery). */
  risk?: number;
  /** CSS colour; default from the palette. */
  color?: string;
  /** Driving style, each 0–1 (phase D): a roster driver's own, else neutral (0.5), for any not given. */
  style?: Partial<DriverStyleEntry>;
  advanced?: AdvancedRatings;
}

/** braking: early and smooth (0) to late and hard (1); line: U (0) to V (1); throttle: smooth to aggressive; kerbs: how much kerb. */
export interface DriverStyleEntry {
  braking: number;
  line: number;
  throttle: number;
  kerbs: number;
}

/** Drivers from the fixed roster added after the listed ones (in roster order, skipping listed names). */
export interface FieldEntry {
  count: number;
  car: string;
  /** How far each roster driver's ratings are from the average: 0 = all average, 1 (default) = as rostered. */
  spread?: number;
  /** Seed for drivers made up past the end of the roster, and for `pick: 'mix'`; default the scenario seed. */
  seed?: number;
  /**
   * Which roster drivers: 'roster' (default) the first `count` in roster order, the same people
   * every time; 'mix' one from each of `count` equal bands of the roster by ability, drawn with
   * the field seed, so a field covers the range from A to Z.
   */
  pick?: 'roster' | 'mix';
}

export type EventEntry =
  | { lap: number; type: 'grip'; value: number; note?: string }
  | { lap: number; type: 'spin' | 'retire'; driver: string; note?: string }
  /** The safety car comes out when the leader starts `lap`, for `laps` laps. */
  | { lap: number; type: 'safety-car'; laps: number; note?: string };

export interface Scenario {
  version?: number;
  name: string;
  description?: string;
  /** Race seed: every random roll in the race comes from it. */
  seed: number;
  track: TrackSpec;
  race: {
    laps: number;
    /** 'grid' (default): a standing start from the lights. 'rolling': two-wide at a class start speed, green at the line. */
    start?: 'grid' | 'rolling';
    /** default 'as-listed' (generated field drivers after the listed ones). */
    gridOrder?: GridOrder;
    /** Offs, spins, crashes and damage (default true). False: the road edge is a wall. */
    incidents?: boolean;
    /** Multiplies every driver's incident odds (default 1). */
    incidentRate?: number;
    /** 'auto': the safety car comes out when a car stops for good on or beside the road. Default 'off'. */
    safetyCar?: 'off' | 'auto';
  };
  physics?: { gripLevel?: number; slipstream?: number; dirtyAir?: number };
  cars: CarEntry[];
  drivers?: DriverEntry[];
  field?: FieldEntry;
  events?: EventEntry[];
}

export interface ScenarioError {
  /** Where, e.g. "drivers[2].speed" ("" for the whole file). */
  path: string;
  message: string;
}

export const formatError = (e: ScenarioError) => (e.path ? `${e.path}: ${e.message}` : e.message);

export type ParseResult = { ok: true; scenario: Scenario } | { ok: false; errors: ScenarioError[] };

export const MAX_CARS = 40;

/** Parse (if text) and validate a scenario. */
export function parseScenario(input: unknown): ParseResult {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (e) {
      return { ok: false, errors: [{ path: '', message: `not valid JSON (${(e as Error).message})` }] };
    }
  }
  const errors = validateScenario(data);
  return errors.length ? { ok: false, errors } : { ok: true, scenario: data as Scenario };
}

// ---- validation helpers -------------------------------------------------------------------

type V = { errors: ScenarioError[] };
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const kind = (x: unknown) => (x === null ? 'null' : Array.isArray(x) ? 'an array' : typeof x === 'object' ? 'an object' : `${typeof x} ${JSON.stringify(x)}`);
const join = (path: string, key: string | number) => (typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key);

function err(v: V, path: string, message: string) {
  v.errors.push({ path, message });
}

/** Edit distance, for "did you mean". */
function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function suggest(key: string, allowed: string[]): string {
  let best = '', bd = Infinity;
  for (const k of allowed) {
    const dist = lev(key.toLowerCase(), k.toLowerCase());
    if (dist < bd) { bd = dist; best = k; }
  }
  return bd <= Math.max(2, Math.floor(key.length / 3)) ? ` (did you mean "${best}"?)` : ` (allowed: ${allowed.join(', ')})`;
}

/** Check `x` is an object with only `allowed` keys and the `required` ones present. */
function object(v: V, path: string, x: unknown, required: string[], optional: string[]): x is Record<string, unknown> {
  if (!isObj(x)) {
    err(v, path, `must be an object (got ${kind(x)})`);
    return false;
  }
  const allowed = [...required, ...optional];
  for (const k of Object.keys(x)) if (!allowed.includes(k)) err(v, join(path, k), `unknown key${suggest(k, allowed)}`);
  for (const k of required) if (!(k in x)) err(v, join(path, k), 'is required');
  return true;
}

function num(v: V, path: string, x: unknown, lo: number, hi: number, opts: { int?: boolean; optional?: boolean } = {}): boolean {
  if (x === undefined && opts.optional) return true;
  if (x === undefined) return false; // reported as missing by `object`
  if (typeof x !== 'number' || !Number.isFinite(x)) {
    err(v, path, `must be a number (got ${kind(x)})`);
    return false;
  }
  if (opts.int && !Number.isInteger(x)) {
    err(v, path, `must be a whole number (got ${x})`);
    return false;
  }
  if (x < lo || x > hi) {
    err(v, path, `must be between ${lo} and ${hi} (got ${x})`);
    return false;
  }
  return true;
}

function str(v: V, path: string, x: unknown, opts: { optional?: boolean; max?: number } = {}): boolean {
  if (x === undefined) return !!opts.optional;
  if (typeof x !== 'string') {
    err(v, path, `must be a string (got ${kind(x)})`);
    return false;
  }
  if (!opts.optional && x.trim() === '') {
    err(v, path, 'must not be empty');
    return false;
  }
  if (x.length > (opts.max ?? 200)) {
    err(v, path, `is too long (${x.length} characters, at most ${opts.max ?? 200})`);
    return false;
  }
  return true;
}

function oneOf<T extends string>(v: V, path: string, x: unknown, values: readonly T[], optional = false): x is T {
  if (x === undefined && optional) return true;
  if (x === undefined) return false;
  if (typeof x !== 'string' || !values.includes(x as T)) {
    err(v, path, `must be one of ${values.map((s) => `"${s}"`).join(', ')} (got ${kind(x)})`);
    return false;
  }
  return true;
}

function bool(v: V, path: string, x: unknown): void {
  if (x !== undefined && typeof x !== 'boolean') err(v, path, `must be true or false (got ${kind(x)})`);
}

function array(v: V, path: string, x: unknown, min: number, max: number, optional = false): x is unknown[] {
  if (x === undefined) return false;
  if (!Array.isArray(x)) {
    err(v, path, `must be a list (got ${kind(x)})`);
    return false;
  }
  if (x.length < min) err(v, path, `needs at least ${min} entr${min === 1 ? 'y' : 'ies'} (got ${x.length})`);
  if (x.length > max) err(v, path, `has too many entries (${x.length}, at most ${max})`);
  void optional;
  return true;
}

// ---- the schema ----------------------------------------------------------------------------

/** Ranges for numbers (also used by the editor's inputs). */
export const RANGES = {
  laps: [1, 200],
  width: [6, 30],
  complexity: [0, 1],
  pngLength: [300, 30000],
  topSpeed: [20, 150],
  accel: [2, 30],
  grip: [0.3, 3],
  brake: [0.3, 2],
  downforce: [0, 0.002],
  rating: [0, 1],
  pace: [0.8, 1],
  gripLevel: [0.3, 1.5],
  slipstream: [0, 0.6],
  dirtyAir: [0, 1],
  incidentRate: [0, 5],
  fieldCount: [1, MAX_CARS],
  safetyCarLaps: [1, 10],
} as const;

const SEED: [number, number] = [0, 2 ** 32 - 1];

function validateTrack(v: V, path: string, t: unknown): void {
  if (!isObj(t)) {
    err(v, path, `must be an object (got ${kind(t)})`);
    return;
  }
  const types = ['generated', 'drawn', 'png'] as const;
  if (!oneOf(v, join(path, 'type'), t.type, types)) {
    if (t.type === undefined) err(v, join(path, 'type'), 'is required');
    return;
  }
  const w = RANGES.width;
  if (t.type === 'generated') {
    if (!object(v, path, t, ['type', 'seed'], ['width', 'complexity', 'sectors'])) return;
    num(v, join(path, 'seed'), t.seed, SEED[0], SEED[1], { int: true });
    num(v, join(path, 'width'), t.width, w[0], w[1], { optional: true });
    num(v, join(path, 'complexity'), t.complexity, RANGES.complexity[0], RANGES.complexity[1], { optional: true });
  } else if (t.type === 'drawn') {
    if (!object(v, path, t, ['type', 'points'], ['width', 'sectors'])) return;
    num(v, join(path, 'width'), t.width, w[0], w[1], { optional: true });
    if (array(v, join(path, 'points'), t.points, 3, 2000)) {
      (t.points as unknown[]).forEach((p, i) => {
        const pp = join(join(path, 'points'), i);
        if (!Array.isArray(p) || p.length !== 2 || !p.every((c) => typeof c === 'number' && Number.isFinite(c))) {
          err(v, pp, `must be [x, y] in metres (got ${JSON.stringify(p)})`);
        } else if (Math.abs(p[0]) > 1e5 || Math.abs(p[1]) > 1e5) err(v, pp, 'is more than 100 km from the origin');
      });
    }
  } else {
    if (!object(v, path, t, ['type', 'image', 'length'], ['width', 'threshold', 'smoothing', 'reverse', 'start', 'sectors'])) return;
    if (str(v, join(path, 'image'), t.image, { max: 8_000_000 }) && !/^data:image\/png;base64,/.test(t.image as string)) {
      err(v, join(path, 'image'), 'must be a PNG data URL ("data:image/png;base64,...")');
    }
    num(v, join(path, 'length'), t.length, RANGES.pngLength[0], RANGES.pngLength[1]);
    num(v, join(path, 'width'), t.width, w[0], w[1], { optional: true });
    num(v, join(path, 'threshold'), t.threshold, 0, 255, { optional: true });
    num(v, join(path, 'smoothing'), t.smoothing, 0, 50, { optional: true });
    bool(v, join(path, 'reverse'), t.reverse);
    num(v, join(path, 'start'), t.start, 0, RANGES.pngLength[1], { optional: true });
  }
  validateSectors(v, join(path, 'sectors'), t.sectors);
}

/** Two increasing distances in metres (whether they fit the lap is checked once the track is built). */
function validateSectors(v: V, path: string, x: unknown): void {
  if (x === undefined) return;
  if (!Array.isArray(x) || x.length !== 2 || !x.every((m) => typeof m === 'number' && Number.isFinite(m))) {
    err(v, path, `must be [end of sector 1, end of sector 2] in metres from the start line (got ${JSON.stringify(x)})`);
    return;
  }
  if (x[0] <= 0) err(v, path, 'sector 1 must end after the start line');
  else if (x[1] <= x[0]) err(v, path, 'sector 2 must end after sector 1');
}

export function validateScenario(x: unknown): ScenarioError[] {
  const v: V = { errors: [] };
  if (!object(v, '', x, ['name', 'seed', 'track', 'race', 'cars'], ['version', 'description', 'physics', 'drivers', 'field', 'events'])) return v.errors;
  if (x.version !== undefined) {
    if (typeof x.version !== 'number' || !Number.isInteger(x.version) || x.version < 1) err(v, 'version', `must be a whole number ≥ 1 (got ${kind(x.version)})`);
    else if (x.version > SCENARIO_VERSION) err(v, 'version', `${x.version} is newer than this sim understands (${SCENARIO_VERSION}); update the sim`);
  }
  str(v, 'name', x.name, { max: 120 });
  str(v, 'description', x.description, { optional: true, max: 2000 });
  num(v, 'seed', x.seed, SEED[0], SEED[1], { int: true });
  validateTrack(v, 'track', x.track);

  let laps = Infinity;
  if (object(v, 'race', x.race, ['laps'], ['start', 'gridOrder', 'incidents', 'incidentRate', 'safetyCar'])) {
    const r = x.race;
    if (num(v, 'race.laps', r.laps, RANGES.laps[0], RANGES.laps[1], { int: true })) laps = r.laps as number;
    oneOf(v, 'race.start', r.start, ['grid', 'rolling'], true);
    oneOf(v, 'race.gridOrder', r.gridOrder, ['as-listed', 'qualifying', 'rating', 'reverse-rating', 'random'], true);
    bool(v, 'race.incidents', r.incidents);
    num(v, 'race.incidentRate', r.incidentRate, RANGES.incidentRate[0], RANGES.incidentRate[1], { optional: true });
    oneOf(v, 'race.safetyCar', r.safetyCar, ['off', 'auto'], true);
  }

  if (x.physics !== undefined && object(v, 'physics', x.physics, [], ['gripLevel', 'slipstream', 'dirtyAir'])) {
    const p = x.physics;
    for (const k of ['gripLevel', 'slipstream', 'dirtyAir'] as const) num(v, `physics.${k}`, p[k], RANGES[k][0], RANGES[k][1], { optional: true });
  }

  const carIds = new Set<string>();
  if (array(v, 'cars', x.cars, 1, MAX_CARS)) {
    (x.cars as unknown[]).forEach((c, i) => {
      const p = `cars[${i}]`;
      if (!object(v, p, c, ['id'], ['preset', 'topSpeed', 'accel', 'grip', 'brake', 'downforce'])) return;
      if (c.preset !== undefined) oneOf(v, `${p}.preset`, c.preset, CAR_PRESET_IDS);
      if (str(v, `${p}.id`, c.id, { max: 40 })) {
        if (carIds.has(c.id as string)) err(v, `${p}.id`, `"${c.id}" is used by another car`);
        carIds.add(c.id as string);
      }
      for (const k of ['topSpeed', 'accel', 'grip', 'brake', 'downforce'] as const) num(v, `${p}.${k}`, c[k], RANGES[k][0], RANGES[k][1], { optional: true });
    });
  } else if (x.cars === undefined) { /* reported as required */ }

  const carRef = (path: string, id: unknown) => {
    if (str(v, path, id, { max: 40 }) && carIds.size && !carIds.has(id as string)) err(v, path, `no car with id "${id}"${suggest(id as string, [...carIds])}`);
  };

  const names = new Set<string>();
  let total = 0;
  if (x.drivers !== undefined && array(v, 'drivers', x.drivers, 0, MAX_CARS)) {
    (x.drivers as unknown[]).forEach((d, i) => {
      const p = `drivers[${i}]`;
      if (!object(v, p, d, ['name', 'car'], ['speed', 'consistency', 'risk', 'color', 'style', 'advanced'])) return;
      if (d.style !== undefined && object(v, `${p}.style`, d.style, [], ['braking', 'line', 'throttle', 'kerbs'])) {
        for (const k of ['braking', 'line', 'throttle', 'kerbs'] as const) num(v, `${p}.style.${k}`, d.style[k], 0, 1, { optional: true });
      }
      total++;
      if (str(v, `${p}.name`, d.name, { max: 40 })) {
        if (names.has(d.name as string)) err(v, `${p}.name`, `"${d.name}" is used by another driver`);
        names.add(d.name as string);
      }
      carRef(`${p}.car`, d.car);
      for (const k of ['speed', 'consistency', 'risk'] as const) num(v, `${p}.${k}`, d[k], 0, 1, { optional: true });
      if (str(v, `${p}.color`, d.color, { optional: true, max: 40 }) && d.color !== undefined && !/^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|(rgb|hsl)a?\([^)]*\))$/.test(d.color as string)) {
        err(v, `${p}.color`, `is not a colour (got "${d.color}")`);
      }
      if (d.advanced !== undefined && object(v, `${p}.advanced`, d.advanced, [], ['pace', 'consistency', 'aggression', 'racecraft', 'bravery'])) {
        const a = d.advanced;
        num(v, `${p}.advanced.pace`, a.pace, RANGES.pace[0], RANGES.pace[1], { optional: true });
        for (const k of ['consistency', 'aggression', 'racecraft', 'bravery'] as const) num(v, `${p}.advanced.${k}`, a[k], 0, 1, { optional: true });
      }
    });
  }
  if (x.field !== undefined && object(v, 'field', x.field, ['count', 'car'], ['spread', 'seed', 'pick'])) {
    const f = x.field;
    if (num(v, 'field.count', f.count, RANGES.fieldCount[0], RANGES.fieldCount[1], { int: true })) total += f.count as number;
    carRef('field.car', f.car);
    num(v, 'field.spread', f.spread, 0, 1, { optional: true });
    num(v, 'field.seed', f.seed, SEED[0], SEED[1], { int: true, optional: true });
    oneOf(v, 'field.pick', f.pick, ['roster', 'mix'], true);
  }
  if (!v.errors.some((e) => e.path.startsWith('drivers') || e.path.startsWith('field'))) {
    if (total === 0) err(v, 'drivers', 'the race needs at least one driver (list them in "drivers" or add a "field")');
    else if (total > MAX_CARS) err(v, 'drivers', `too many cars: ${total} (drivers plus field), at most ${MAX_CARS}`);
  }

  if (x.events !== undefined && array(v, 'events', x.events, 0, 200)) {
    (x.events as unknown[]).forEach((e, i) => {
      const p = `events[${i}]`;
      if (!isObj(e)) return err(v, p, `must be an object (got ${kind(e)})`);
      if (!oneOf(v, `${p}.type`, e.type, ['grip', 'spin', 'retire', 'safety-car'])) {
        if (e.type === undefined) err(v, `${p}.type`, 'is required');
        return;
      }
      if (e.type === 'grip') {
        if (!object(v, p, e, ['lap', 'type', 'value'], ['note'])) return;
        num(v, `${p}.value`, e.value, RANGES.gripLevel[0], RANGES.gripLevel[1]);
      } else if (e.type === 'safety-car') {
        if (!object(v, p, e, ['lap', 'type', 'laps'], ['note'])) return;
        num(v, `${p}.laps`, e.laps, RANGES.safetyCarLaps[0], RANGES.safetyCarLaps[1], { int: true });
      } else {
        if (!object(v, p, e, ['lap', 'type', 'driver'], ['note'])) return;
        if (str(v, `${p}.driver`, e.driver, { max: 40 }) && !names.has(e.driver as string)) {
          err(v, `${p}.driver`, `no listed driver named "${e.driver}"${names.size ? suggest(e.driver as string, [...names]) : ''}`);
        }
      }
      if (num(v, `${p}.lap`, e.lap, 1, RANGES.laps[1], { int: true }) && (e.lap as number) > laps) {
        err(v, `${p}.lap`, `is after the last lap (${laps})`);
      }
      str(v, `${p}.note`, e.note, { optional: true, max: 80 });
    });
  }
  return v.errors;
}
