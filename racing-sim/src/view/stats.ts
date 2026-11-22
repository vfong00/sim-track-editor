import { CAR_PRESETS, type CarSpec, type Entrant, incidentScale, PACE_MAX, PACE_MIN, racePace, STANDARD_CAR } from '../core';

/**
 * Driver and car stats for the follow panel (no DOM, so it can be tested): the scenario-style
 * ratings recovered from a driver's internal spec, each value's rank in the field, and a
 * one-line profile ("Quick, very consistent, cautious").
 */

export interface Ratings {
  speed: number;
  consistency: number;
  risk: number;
  racecraft: number;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * The simple ratings behind a driver (the inverse of `driverFromRatings`): speed from pace
 * (pace = PACE_MIN + (PACE_MAX − PACE_MIN) × speed), risk as the mean of aggression and bravery.
 */
export function ratingsOf(e: Entrant): Ratings {
  const d = e.driver;
  return {
    speed: clamp01((d.pace - PACE_MIN) / (PACE_MAX - PACE_MIN)),
    consistency: d.consistency,
    risk: (d.aggression + d.bravery) / 2,
    racecraft: d.racecraft,
  };
}

export interface Rank {
  /** 1 = best. Cars tied with others share the better rank. */
  rank: number;
  of: number;
  tied: boolean;
  /** Everyone has the same value. */
  allEqual: boolean;
}

/**
 * Rank of `values[i]` in the field. `higherIsBetter` false ranks the smallest first. Values
 * within `eps` count as equal.
 */
export function rankIn(values: number[], i: number, higherIsBetter = true, eps = 1e-9): Rank {
  const v = values[i];
  const better = values.filter((x) => (higherIsBetter ? x - v : v - x) > eps).length;
  const same = values.filter((x) => Math.abs(x - v) <= eps).length;
  return { rank: better + 1, of: values.length, tied: same > 1, allEqual: same === values.length };
}

export const ordinal = (n: number): string => {
  const t = n % 100;
  const s = t >= 11 && t <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
};

/** "2nd of 12", "=3rd of 12", "all equal". */
export function rankText(r: Rank): string {
  if (r.allEqual) return 'all equal';
  return `${r.tied ? '=' : ''}${ordinal(r.rank)} of ${r.of}`;
}

/**
 * Pace words, from the share of the car's grip used. Race pace sets the main word (it is what
 * the race shows: Alvarez's consistency puts him well clear); the bands spread the roster out
 * (1 dominant, 1 very quick, 3 quick, 5 average, 5 slower, 5 off the pace).
 */
const RACE_BANDS: [number, string][] = [[0.945, 'Dominant'], [0.935, 'Very quick'], [0.925, 'Quick'], [0.91, 'Average'], [0.895, 'Slower'], [0, 'Off the pace']];
/** The same words for one flying lap (pace at the limit), for "quick over a lap, average in races". */
const LAP_BANDS: [number, string][] = [[0.985, 'Dominant'], [0.975, 'Very quick'], [0.965, 'Quick'], [0.95, 'Average'], [0.935, 'Slower'], [0, 'Off the pace']];
const band = (x: number, bands: [number, string][]) => bands.findIndex(([lo]) => x >= lo);

/**
 * One line about the driver: pace (race pace, and one-lap pace when that is a band better),
 * then consistency, then attacking (risk). `pace` and `race` are shares of the car's grip.
 */
export function profile(r: Ratings, pace: number, race: number): string {
  const rb = band(race, RACE_BANDS), lb = band(pace, LAP_BANDS);
  const raceWord = RACE_BANDS[rb][1];
  const speed = lb < rb ? `${LAP_BANDS[lb][1]} over a lap, ${raceWord.toLowerCase()} in races` : raceWord;
  const cons = r.consistency >= 0.93 ? 'very consistent' : r.consistency >= 0.82 ? 'consistent' : r.consistency >= 0.7 ? 'a bit erratic' : 'error-prone';
  const risk = r.risk >= 0.75 ? 'reckless' : r.risk >= 0.6 ? 'aggressive' : r.risk > 0.4 ? 'measured' : r.risk > 0.25 ? 'careful' : 'cautious';
  return `${speed}, ${cons}, ${risk}`;
}

const CAR_NAMES: Record<keyof typeof CAR_PRESETS, string> = {
  f1: 'an F1 car', lmp: 'an LMP', gt3: 'a GT3 car', road: 'a sports car', mx5: 'an MX-5 Cup car', civilian: 'a civilian car',
};

/** What a car is good or bad at, each from one number (higher = better). */
const TRAITS: { of: (c: CarSpec) => number; best: string; good: string; bad: string; worst: string }[] = [
  { of: (c) => c.topSpeed, best: 'the quickest on the straights', good: 'quick on the straights', bad: 'slow on the straights', worst: 'the slowest on the straights' },
  // Cornering grip at 200 km/h: mechanical plus downforce.
  { of: (c) => c.grip + (c.downforce ?? 0) * 55.6 * 55.6, best: 'the best in the corners', good: 'strong in the corners', bad: 'weak in the corners', worst: 'the weakest in the corners' },
  { of: (c) => c.accel, best: 'the quickest out of corners', good: 'quick out of corners', bad: 'slow out of corners', worst: 'the slowest out of corners' },
  { of: (c) => c.brake, best: 'the latest on the brakes', good: 'strong on the brakes', bad: 'early on the brakes', worst: 'the earliest on the brakes' },
];

/**
 * "an F1 car" for a stock preset (or "the standard car"). A car changed from its preset (or a
 * custom one) says what stands out against `rivals` (the cars it races: its class, or the field):
 * "an F1 car that's the quickest on the straights, weak in the corners", or "an all-round F1 car".
 */
export function carPhrase(c: CarSpec, rivals: CarSpec[] = []): string {
  const keys = ['topSpeed', 'accel', 'grip', 'brake', 'downforce'] as const;
  const same = (a: Partial<CarSpec>, b: Partial<CarSpec>) => keys.every((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) < 1e-9);
  if (c.preset ? same(c, CAR_PRESETS[c.preset]) : same(c, STANDARD_CAR)) return c.preset ? CAR_NAMES[c.preset] : 'the standard car';
  const name = c.preset ? CAR_NAMES[c.preset] : 'a custom car';
  const others = rivals.filter((x) => !same(x, c));
  if (!others.length) return name;
  const all = [c, ...others];
  // Each trait's standing: 1 = best of all, 0 = worst; only clear standouts count.
  const notes: { score: number; text: string }[] = [];
  for (const t of TRAITS) {
    const v = t.of(c), vals = all.map(t.of);
    const above = vals.filter((x) => x > v + 1e-9).length, below = vals.filter((x) => x < v - 1e-9).length;
    if (!above && !below) continue;
    // "The best" only alone at the top; "good" in the top quarter (ties included), so a value
    // most of the class shares is never a standout.
    const n = all.length, tied = n - above - below;
    if (!above && tied === 1) notes.push({ score: 2, text: t.best });
    else if (!below && tied === 1) notes.push({ score: -2, text: t.worst });
    else if (above + tied <= n / 4) notes.push({ score: 1, text: t.good });
    else if (below + tied <= n / 4) notes.push({ score: -1, text: t.bad });
  }
  if (!notes.length) return name.replace(/^an? /, 'an all-round ');
  // The strongest point and the weakest, at most one of each.
  const best = notes.filter((x) => x.score > 0).sort((a, b) => b.score - a.score)[0];
  const worst = notes.filter((x) => x.score < 0).sort((a, b) => a.score - b.score)[0];
  return `${name} that's ${[best, worst].filter(Boolean).map((x) => x!.text).join(', ')}`;
}

export interface StatRow {
  label: string;
  value: string;
  rank: string;
  /** What the value does in the race (a tooltip). */
  hint: string;
}

/** The cars car i races: its class (same preset) when there are others in it, else the field. */
function rivalsOf(cars: CarSpec[], i: number): CarSpec[] {
  const cls = cars.filter((c, k) => k !== i && c.preset === cars[i].preset);
  return cls.length ? cls : cars.filter((_, k) => k !== i);
}

/** Rating and car rows for entrant i of the field, each with its rank. */
export function statRows(field: Entrant[], i: number): { profile: string; driver: StatRow[]; car: StatRow[] } {
  const rs = field.map(ratingsOf);
  const ds = field.map((e) => e.driver);
  const row = (label: string, vals: number[], fmt: (v: number) => string, hint: string, higher = true): StatRow =>
    ({ label, value: fmt(vals[i]), rank: rankText(rankIn(vals, i, higher, 1e-6)), hint });
  const f2 = (v: number) => v.toFixed(2);
  const cars = field.map((e) => e.car);
  return {
    profile: `${profile(rs[i], ds[i].pace, racePace(ds[i]))}, in ${carPhrase(cars[i], rivalsOf(cars, i))}`,
    driver: [
      // The numbers the sim actually uses (DriverSpec), not the scenario's simpler ratings.
      row('Pace', ds.map((d) => d.pace), (v) => `${(v * 100).toFixed(1)}%`, "Share of the car's grip used at the limit, on a qualifying lap (from the speed rating: 90% to 100%)."),
      row('Race pace', ds.map(racePace), (v) => `${(v * 100).toFixed(1)}%`, 'Share of the grip used in a race: the limit less a margin of 2.5% plus 12% per point of inconsistency (about 1% to 2% off the qualifying lap).'),
      row('Consistency', ds.map((d) => d.consistency), f2, 'Mistake rate: an average driver (0.85) locks up or runs wide about once every 20–25 laps, far more often when sliding over the limit.'),
      // Not better or worse: rank 1st = the most willing.
      row('Aggression', ds.map((d) => d.aggression), f2, 'How readily they try a pass: the urge to attack, and how far back they start (14 m, up to 20 m at 1).'),
      row('Bravery', ds.map((d) => d.bravery), f2, 'How much later they brake when fighting for a corner: up to 4% less braking margin at 1.'),
      row('Racecraft', ds.map((d) => d.racecraft), f2, 'Defending: chance to cover the inside when attacked (up to 60%). From speed and consistency (their mean) unless set.'),
      // Lower is safer: rank 1st = the least incident-prone.
      row('Incident risk', ds.map(incidentScale), (v) => `×${v.toFixed(2)}`, 'How likely a slide or contact ends in a spin or crash, from consistency and aggression + bravery. 1 = an average driver.', false),
    ],
    car: [
      row('Top speed', cars.map((c) => c.topSpeed), (v) => `${(v * 3.6).toFixed(0)} km/h`, 'Top speed on a long straight (drag balances the engine there).'),
      row('Accel', cars.map((c) => c.accel), (v) => `${v.toFixed(1)} m/s²`, 'Engine acceleration before drag; tyre grip caps it at low speed.'),
      row('Grip', cars.map((c) => c.grip), f2, 'Mechanical tyre grip in g (before downforce).'),
      row('Brakes', cars.map((c) => c.brake), f2, 'Braking strength relative to grip.'),
      // Extra grip from downforce at 250 km/h (69.4 m/s), in g.
      row('Downforce', cars.map((c) => (c.downforce ?? 0) * 69.4 * 69.4), (v) => `+${v.toFixed(1)} g @250`, 'Extra grip from downforce at 250 km/h; it grows with the square of speed.'),
    ],
  };
}
