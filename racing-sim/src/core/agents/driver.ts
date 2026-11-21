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

export const AVERAGE_DRIVER: Omit<DriverSpec, 'name'> = { pace: 0.98, consistency: 0.85, aggression: 0.5, racecraft: 0.6, bravery: 0.5 };

export interface Entrant {
  id: string;
  color: string;
  car: CarSpec;
  driver: DriverSpec;
}

const NAMES = ['Ortiz', 'Lee', 'Novak', 'Haddad', 'Sato', 'Okafor', 'Brandt', 'Rossi', 'Kaur', 'Dubois', 'Silva', 'Moreau',
  'Jensen', 'Abe', 'Costa', 'Ivanova', 'Walsh', 'Mensah', 'Park', 'Fischer'];
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
