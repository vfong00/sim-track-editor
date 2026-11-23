import { DRIVER_COLORS, type SimpleRatings } from './driver';

/**
 * The fixed roster: every driver keeps the same ratings and colour in every scenario and on
 * every seed, so a name means a driver ("Alvarez is quick and almost never makes a mistake").
 * Generated fields take drivers from here in this order. Ratings are each in [0, 1]; see
 * `driverFromRatings` for what they drive.
 *
 * Names run A to Z by overall ability (0.7 × speed + 0.3 × consistency, consistency scaled
 * over the roster's range; ties to the faster driver): all the A names rank above all the B
 * names, and so on, so Alvarez and Abreu are the best, M and N the middle of the pack and Zhou
 * the weakest. A, M, R and W have two drivers each. Risk is a style, not a skill, so it doesn't
 * count. A test keeps this true. Generated fields take drivers in the order listed here, so new
 * names go at the end.
 */
export interface RosterDriver extends SimpleRatings {
  name: string;
  color: string;
}

const R: [string, number, number, number][] = [
  // name, speed, consistency, risk
  ['Nakamura', 0.58, 0.73, 0.52],
  ['Alvarez', 0.79, 0.96, 0.32],
  ['Garcia', 0.57, 0.9, 0.44],
  ['Chen', 0.8, 0.84, 0.49],
  ['Reyes', 0.28, 0.83, 0.3],
  ['Petrov', 0.29, 0.85, 0.15],
  ['Jovanovic', 0.44, 0.91, 0.33],
  ['Schmidt', 0.31, 0.74, 0.44],
  ['Eriksen', 0.55, 0.92, 0.34],
  ['Murphy', 0.32, 0.89, 0.54],
  ['Ito', 0.66, 0.78, 0.68],
  ['Hughes', 0.47, 0.91, 0.9],
  ['Dlamini', 0.7, 0.88, 0.6],
  ['Bianchi', 0.62, 0.95, 0.25],
  ['Quinn', 0.52, 0.7, 0.8],
  ['Fontaine', 0.74, 0.8, 0.7],
  ['Olsen', 0.4, 0.82, 0.6],
  ['Laurent', 0.36, 0.93, 0.4],
  ['Kowalski', 0.48, 0.86, 0.5],
  ['Tanaka', 0.2, 0.78, 0.75],
  // Phase 7: 30 drivers on A–Z (ranks 15–16 of 30 are M and N, the middle of the pack). A, M, R
  // and W have two drivers. New names go at the end, so generated fields keep their drivers.
  ['Abreu', 0.87, 0.84, 0.6], // quicker than Alvarez over a lap, scrappier over a race
  ['Moreau', 0.45, 0.83, 0.35],
  ['Ruiz', 0.45, 0.72, 0.9],
  ['Ueda', 0.29, 0.72, 0.8],
  ['Vargas', 0.08, 0.84, 0.4],
  ['Weber', 0.12, 0.8, 0.35],
  ['Walsh', 0.25, 0.7, 0.95],
  ['Xu', 0.16, 0.72, 0.6],
  ['Yilmaz', 0.05, 0.78, 0.5],
  ['Zhou', 0.02, 0.75, 0.45],
];

export const ROSTER: readonly RosterDriver[] = R.map(([name, speed, consistency, risk], i) => ({
  name, speed, consistency, risk, color: DRIVER_COLORS[i % DRIVER_COLORS.length],
}));

/** Overall ability for ordering the roster (see the comment at the top): higher is better. */
export function overallAbility(d: SimpleRatings): number {
  const cs = ROSTER_RATINGS.map((r) => r.consistency);
  const lo = Math.min(...cs), hi = Math.max(...cs);
  return 0.7 * d.speed + 0.3 * (d.consistency - lo) / (hi - lo);
}
const ROSTER_RATINGS: readonly SimpleRatings[] = R.map(([, speed, consistency, risk]) => ({ speed, consistency, risk }));

export const rosterDriver = (name: string): RosterDriver | undefined => ROSTER.find((d) => d.name === name);
