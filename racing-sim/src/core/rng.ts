/** Seeded PRNG (mulberry32). All randomness in the sim goes through one of these. */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  range(lo: number, hi: number): number;
  int(lo: number, hiExclusive: number): number;
  /** Standard normal (Box–Muller). */
  normal(): number;
  /** Independent child generator, so sub-systems don't perturb each other's streams. */
  fork(): Rng;
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo)),
    normal: () => {
      const u = 1 - next();
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    fork: () => makeRng(Math.floor(next() * 4294967296)),
  };
  return rng;
}
