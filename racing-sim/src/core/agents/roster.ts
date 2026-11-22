import { DRIVER_COLORS, type SimpleRatings } from './driver';

/**
 * The fixed roster: every driver keeps the same ratings and colour in every scenario and on
 * every seed, so a name means a driver ("Lee is quick and almost never makes a mistake").
 * Generated fields take drivers from here in this order. Ratings are each in [0, 1]; see
 * `driverFromRatings` for what they drive. The first twelve match what the seed-1 random
 * field used to generate, so that field looks the same as before.
 */
export interface RosterDriver extends SimpleRatings {
  name: string;
  color: string;
}

const R: [string, number, number, number][] = [
  // name, speed, consistency, risk
  ['Ortiz', 0.58, 0.73, 0.52],
  ['Lee', 0.79, 0.96, 0.32],
  ['Novak', 0.57, 0.9, 0.44],
  ['Haddad', 0.8, 0.84, 0.49],
  ['Sato', 0.28, 0.83, 0.3],
  ['Okafor', 0.29, 0.85, 0.15],
  ['Brandt', 0.44, 0.91, 0.33],
  ['Rossi', 0.31, 0.74, 0.44],
  ['Kaur', 0.55, 0.92, 0.34],
  ['Dubois', 0.32, 0.89, 0.54],
  ['Silva', 0.66, 0.78, 0.68],
  ['Moreau', 0.47, 0.91, 0.9],
  ['Jensen', 0.7, 0.88, 0.6],
  ['Abe', 0.62, 0.95, 0.25],
  ['Costa', 0.52, 0.7, 0.8],
  ['Ivanova', 0.74, 0.8, 0.7],
  ['Walsh', 0.4, 0.82, 0.6],
  ['Mensah', 0.36, 0.93, 0.4],
  ['Park', 0.48, 0.86, 0.5],
  ['Fischer', 0.2, 0.78, 0.75],
];

export const ROSTER: readonly RosterDriver[] = R.map(([name, speed, consistency, risk], i) => ({
  name, speed, consistency, risk, color: DRIVER_COLORS[i % DRIVER_COLORS.length],
}));

export const rosterDriver = (name: string): RosterDriver | undefined => ROSTER.find((d) => d.name === name);
