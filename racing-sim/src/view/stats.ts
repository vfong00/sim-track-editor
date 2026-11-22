import { type Entrant, PACE_MAX, PACE_MIN } from '../core';

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
 * (pace = 0.96 + 0.04 × speed), risk as the mean of aggression and bravery.
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

/** One line about the driver from their ratings: pace, then consistency, then attacking (risk). */
export function profile(r: Ratings): string {
  const pace = r.speed >= 0.8 ? 'Very quick' : r.speed >= 0.6 ? 'Quick' : r.speed > 0.4 ? 'Average pace' : r.speed > 0.2 ? 'Slower' : 'Slow';
  const cons = r.consistency >= 0.93 ? 'very consistent' : r.consistency >= 0.82 ? 'consistent' : r.consistency >= 0.7 ? 'a bit erratic' : 'error-prone';
  const risk = r.risk >= 0.75 ? 'reckless' : r.risk >= 0.6 ? 'aggressive' : r.risk > 0.4 ? 'measured' : r.risk > 0.25 ? 'careful' : 'cautious';
  return `${pace}, ${cons}, ${risk}`;
}

export interface StatRow {
  label: string;
  value: string;
  rank: string;
  /** What the value does in the race (a tooltip). */
  hint: string;
}

/** Rating and car rows for entrant i of the field, each with its rank. */
export function statRows(field: Entrant[], i: number): { profile: string; driver: StatRow[]; car: StatRow[] } {
  const rs = field.map(ratingsOf);
  const row = (label: string, vals: number[], fmt: (v: number) => string, hint: string, higher = true): StatRow =>
    ({ label, value: fmt(vals[i]), rank: rankText(rankIn(vals, i, higher, 1e-6)), hint });
  const f2 = (v: number) => v.toFixed(2);
  const cars = field.map((e) => e.car);
  return {
    profile: profile(rs[i]),
    driver: [
      row('Speed', rs.map((r) => r.speed), f2, "Share of the car's grip used on a normal lap: 0 = 96%, 1 = 100%. Sets the ideal lap."),
      row('Consistency', rs.map((r) => r.consistency), f2, 'How rarely they lock up or run wide, and how well they catch a slide.'),
      // The "risk" rating. Not better or worse: rank 1st = the most willing.
      row('Attacking', rs.map((r) => r.risk), f2, 'How readily they try a pass (and from how far back), and how late they brake in a fight. Also how hard they push on through a slide, so more spins.'),
      row('Defending', rs.map((r) => r.racecraft), f2, 'Chance to cover the inside when someone attacks. Comes from speed and consistency (their mean).'),
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
