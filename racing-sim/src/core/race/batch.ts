import { Race, type RaceOptions, type RaceStats } from './race';

/** Mean and standard error of the mean (0 with fewer than two samples). */
export interface Spread {
  mean: number;
  se: number;
}

export const spread = (xs: number[]): Spread => {
  const n = xs.length;
  if (!n) return { mean: 0, se: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, se: 0 };
  const v = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1);
  return { mean, se: Math.sqrt(v / n) };
};

/** One driver over a batch (matched by name: a random grid puts them in a different slot each race). */
export interface DriverSummary {
  name: string;
  /** Grid slot (1-based). */
  grid: Spread;
  wins: number;
  podiums: number;
  dnfs: number;
  /** Finishing position (1-based, DNFs classified behind the finishers as the race orders them). */
  position: Spread;
  /** How many times the driver finished in each position (index 0 = P1). */
  finishes: number[];
  /** Best lap over the batch (Infinity if no lap was completed). */
  bestLap: number;
}

/** Per-race numbers of a single run, the input a batch summary is built from. */
export interface RunResult {
  seed: number;
  /** Driver names in entrant order, which is the grid order. */
  names: string[];
  /** Entrant indices in finishing order. */
  order: number[];
  dnf: boolean[];
  bestLaps: number[];
  stats: RaceStats;
  /** Incidents (offs, spins and crashes) in the race. */
  incidents: number;
  /** Contacts while the leader was on lap 1 (the start and the first corners). */
  lap1Contacts: number;
  /** Position-change score of this race (see `BatchSummary.chaos`). */
  chaos: number;
  /** Simulated race time (s). */
  time: number;
}

export interface BatchSummary {
  runs: number;
  seeds: number[];
  drivers: DriverSummary[];
  /** Per race. */
  passes: Spread;
  contacts: Spread;
  lap1Contacts: Spread;
  incidents: Spread;
  spins: Spread;
  dnfs: Spread;
  stuckTime: Spread;
  /** Car-seconds within 1 s behind a much slower car on the road (RaceStats.trafficTime). */
  trafficTime: Spread;
  trainShare: Spread;
  /**
   * Processional vs chaotic: the mean |finish − grid| position change of the field, as a share of
   * what a random finishing order would give. 0 = everyone finishes where they started, 1 = the
   * grid tells you nothing about the result (above 1 = the order tends to invert).
   */
  chaos: Spread;
  /** Wall-clock milliseconds the batch took. */
  ms: number;
}

/** Expected |finish − grid| for a uniformly random finishing order of n cars: (n² − 1) / 3n. */
export const randomShuffle = (n: number) => (n > 1 ? (n * n - 1) / (3 * n) : 1);

/** Run one race to the end and reduce it to a `RunResult`. */
export function runOne(options: RaceOptions): RunResult {
  const race = new Race(options).run();
  const order = race.order();
  const n = race.cars.length;
  let moved = 0;
  order.forEach((i, p) => (moved += Math.abs(p - i)));
  const stats = race.stats();
  return {
    seed: options.seed,
    names: race.cars.map((c) => c.entrant.driver.name),
    order,
    dnf: race.cars.map((c) => c.dnf),
    bestLaps: race.cars.map((c) => (c.lapTimes.length ? Math.min(...c.lapTimes) : Infinity)),
    stats,
    incidents: stats.offs + stats.spins + race.events.filter((e) => e.type === 'crash').length,
    lap1Contacts: race.events.filter((e) => e.type === 'contact' && e.lap <= 1).length,
    chaos: moved / n / randomShuffle(n),
    time: race.t,
  };
}

/** Summarise a set of runs of the same field (drivers listed in the first run's grid order). */
export function summarize(runs: RunResult[], ms = 0): BatchSummary {
  const names = runs[0]?.names ?? [];
  const n = names.length;
  const drivers: DriverSummary[] = names.map((name) => {
    const slot = runs.map((r) => r.names.indexOf(name));
    if (slot.includes(-1)) throw new Error(`summarize: ${name} is not in every race`);
    const pos = runs.map((r, k) => r.order.indexOf(slot[k]) + 1);
    const finishes = new Array(n).fill(0);
    pos.forEach((p) => finishes[p - 1]++);
    return {
      name,
      grid: spread(slot.map((i) => i + 1)),
      wins: pos.filter((p) => p === 1).length,
      podiums: pos.filter((p) => p <= 3).length,
      dnfs: runs.filter((r, k) => r.dnf[slot[k]]).length,
      position: spread(pos),
      finishes,
      bestLap: Math.min(...runs.map((r, k) => r.bestLaps[slot[k]])),
    };
  });
  const of = (f: (r: RunResult) => number) => spread(runs.map(f));
  return {
    runs: runs.length,
    seeds: runs.map((r) => r.seed),
    drivers,
    passes: of((r) => r.stats.passes),
    contacts: of((r) => r.stats.contacts),
    lap1Contacts: of((r) => r.lap1Contacts),
    incidents: of((r) => r.incidents),
    spins: of((r) => r.stats.spins),
    dnfs: of((r) => r.stats.dnfs),
    stuckTime: of((r) => r.stats.stuckTime),
    trafficTime: of((r) => r.stats.trafficTime),
    trainShare: of((r) => r.stats.trainShare),
    chaos: of((r) => r.chaos),
    ms,
  };
}

/**
 * Run the same race once per seed (`make(seed)` builds its options; reuse one track and lane set
 * across seeds) and summarise. `onRun` reports progress after each race.
 */
export function runBatch(make: (seed: number) => RaceOptions, seeds: number[], onRun?: (done: number, r: RunResult) => void): BatchSummary {
  const t0 = Date.now();
  const runs: RunResult[] = [];
  for (const seed of seeds) {
    const r = runOne(make(seed));
    runs.push(r);
    onRun?.(runs.length, r);
  }
  return summarize(runs, Date.now() - t0);
}

/** Seeds `from`, `from + 1`, … (`count` of them). */
export const seedRange = (count: number, from = 1) => Array.from({ length: count }, (_, k) => from + k);
