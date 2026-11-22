import type { CarSpec } from '../physics/model';
import { STANDARD_CAR } from '../physics/model';
import type { Rng } from '../rng';

/** Driver ratings, all in [0, 1] except pace (fraction of the car's grip the driver uses). */
export interface DriverSpec {
  name: string;
  /** Share of the car's grip used on a normal lap (0.9 = slow, 1.0 = on the limit). */
  pace: number;
  /** 1 = never makes mistakes, 0 = error-prone. */
  consistency: number;
  /** Willingness to attempt a pass. */
  aggression: number;
  /** Skill in wheel-to-wheel: defending, picking the side, avoiding contact. */
  racecraft: number;
  /** How much later than normal the driver brakes when attacking. */
  bravery: number;
}

/**
 * Speed rating → pace (share of the car's grip used), linearly from PACE_MIN (speed 0) to
 * PACE_MAX (1). Was 0.96–1.0, which put the whole roster within ~0.4 s a lap (0.7%): less than
 * it takes to pass, so ability couldn't show. 0.90–1.0 spreads it to about 1.1 s (1.9%).
 */
export const PACE_MIN = 0.90;
export const PACE_MAX = 1.0;
export const paceFromSpeed = (speed: number) => PACE_MIN + (PACE_MAX - PACE_MIN) * speed;

/** The average driver: speed 0.5. */
export const AVERAGE_DRIVER: Omit<DriverSpec, 'name'> = { pace: paceFromSpeed(0.5), consistency: 0.85, aggression: 0.5, racecraft: 0.6, bravery: 0.5 };

export interface Entrant {
  id: string;
  color: string;
  car: CarSpec;
  driver: DriverSpec;
  /** The lap that set the grid (s): a qualifying lap, or the ideal lap for a rating grid. Absent for other grids. */
  gridTime?: number;
}

const NAMES = ['Nakamura', 'Alvarez', 'Garcia', 'Chen', 'Reyes', 'Petrov', 'Jovanovic', 'Schmidt', 'Eriksen', 'Murphy', 'Ito',
  'Hughes', 'Dlamini', 'Bianchi', 'Quinn', 'Fontaine', 'Olsen', 'Laurent', 'Kowalski', 'Tanaka'];
const COLORS = ['#ff5a36', '#36a2ff', '#ffd23f', '#3ddc84', '#c77dff', '#ff8fab', '#00d1c1', '#f4a261', '#e9ecef', '#8ac926',
  '#ff006e', '#4cc9f0', '#b5838d', '#ffbe0b', '#90be6d', '#adb5bd', '#e63946', '#a8dadc', '#fb8500', '#7209b7'];

/** A field of `n` cars. `spread` varies car specs and driver ratings around the averages. */
export function makeField(n: number, rng: Rng, spread = 1): Entrant[] {
  const out: Entrant[] = [];
  for (let i = 0; i < n; i++) {
    const j = (x: number) => 1 + (rng.next() * 2 - 1) * x * spread;
    const r = (base: number, x: number) => Math.max(0, Math.min(1, base + (rng.next() * 2 - 1) * x * spread));
    out.push({
      id: `car${i + 1}`,
      color: COLORS[i % COLORS.length],
      car: { ...STANDARD_CAR, id: `car${i + 1}`, topSpeed: STANDARD_CAR.topSpeed * j(0.015), grip: STANDARD_CAR.grip * j(0.01) },
      driver: {
        name: NAMES[i % NAMES.length],
        pace: Math.min(1, AVERAGE_DRIVER.pace * j(0.012)),
        consistency: r(AVERAGE_DRIVER.consistency, 0.12),
        aggression: r(AVERAGE_DRIVER.aggression, 0.4),
        racecraft: r(AVERAGE_DRIVER.racecraft, 0.35),
        bravery: r(AVERAGE_DRIVER.bravery, 0.4),
      },
    });
  }
  return out;
}

/** Identical cars and drivers (for checks). */
export function identicalField(n: number, driver: Omit<DriverSpec, 'name'> = AVERAGE_DRIVER): Entrant[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `car${i + 1}`,
    color: COLORS[i % COLORS.length],
    car: { ...STANDARD_CAR, id: 'standard' },
    driver: { ...driver, name: NAMES[i % NAMES.length] },
  }));
}

/**
 * The simple driver ratings scenarios expose (Phase 6), each in [0, 1]:
 * - speed → pace, linearly from PACE_MIN (0) to PACE_MAX (1); 0.5 is the average driver's 0.965.
 * - consistency → consistency, as is.
 * - risk → aggression and bravery, both set to it (so riskTaking(d) = risk).
 * - racecraft comes from experience-like skill: the mean of speed and consistency (a quick,
 *   steady driver is also good wheel to wheel). Average ratings give 0.675 (AVERAGE_DRIVER: 0.6).
 * Any internal rating can still be set directly (`advanced` in a scenario); those win.
 */
export interface SimpleRatings {
  speed: number;
  consistency: number;
  risk: number;
}

export const AVERAGE_RATINGS: SimpleRatings = { speed: 0.5, consistency: AVERAGE_DRIVER.consistency, risk: 0.5 };

export function driverFromRatings(name: string, r: SimpleRatings, advanced: Partial<Omit<DriverSpec, 'name'>> = {}): DriverSpec {
  return {
    name,
    pace: paceFromSpeed(r.speed),
    consistency: r.consistency,
    aggression: r.risk,
    racecraft: (r.speed + r.consistency) / 2,
    bravery: r.risk,
    ...advanced,
  };
}

export const DRIVER_NAMES = NAMES;
export const DRIVER_COLORS = COLORS;
