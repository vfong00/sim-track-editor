import { type CarSpec, type Entrant, hashText, makeRng } from '../core';

/**
 * Car art (no DOM, so it can be tested): each car's body shape from its class, and a livery
 * seeded from its team (the car id and colour), so teammates match and a scenario always looks
 * the same. Drawn by `drawCar`.
 */

/** Open-wheeler, prototype, GT, or a road-based car. */
export type BodyShape = 'open' | 'proto' | 'gt' | 'road';

/** The preset's shape, or else one from downforce (a custom car). */
export function bodyShape(car: CarSpec): BodyShape {
  switch (car.preset) {
    case 'f1': return 'open';
    case 'lmp': return 'proto';
    case 'gt3': return 'gt';
    case 'mx5': case 'road': case 'civilian': return 'road';
  }
  const df = car.downforce ?? 0;
  return df >= 6e-4 ? 'open' : df >= 3e-4 ? 'proto' : df > 0 ? 'gt' : 'road';
}

export type Pattern = 'stripe' | 'halves' | 'chevron' | 'tail' | 'sides';
export const PATTERNS: Pattern[] = ['stripe', 'halves', 'chevron', 'tail', 'sides'];

export interface Livery {
  shape: BodyShape;
  base: string;
  accent: string;
  pattern: Pattern;
  /** Race number (2–99, unique in the field). */
  number: number;
}

/** Relative luminance of a #rgb / #rrggbb colour (0 black, 1 white). */
export function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((k) => {
    const c = parseInt(full.slice(k, k + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two colours (1 = none, 21 = black on white). */
export const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const ACCENTS = ['#ffffff', '#14171c', '#f2c14e', '#c9ced6', '#e63946', '#2ec4b6'];

/** Liveries for a field, in entrant order. */
export function liveries(entrants: Entrant[]): Livery[] {
  // The driver's own number, the same whatever the grid: from the name, clashes settled in name
  // order (the next free number).
  const used = new Set<number>();
  const numbers = new Map<string, number>();
  for (const name of entrants.map((e) => e.driver.name).sort()) {
    let n = 2 + (parseInt(hashText(name), 16) % 98);
    while (used.has(n)) n = n >= 99 ? 2 : n + 1;
    used.add(n);
    numbers.set(name, n);
  }
  return entrants.map((e) => {
    // Team: same car and colour (constructor teammates share both).
    const rng = makeRng(parseInt(hashText(`${e.car.id}|${e.color}`), 16));
    const pattern = PATTERNS[rng.int(0, PATTERNS.length)];
    const ok = ACCENTS.filter((c) => contrast(c, e.color) >= 2.2);
    const accent = ok.length ? ok[rng.int(0, ok.length)] : luminance(e.color) > 0.4 ? '#14171c' : '#ffffff';
    return { shape: bodyShape(e.car), base: e.color, accent, pattern, number: numbers.get(e.driver.name)! };
  });
}
