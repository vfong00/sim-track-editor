import { log } from '../fmath';
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
  const v = xs.reduce((a, x) => a + (x - mean) * (x - mean), 0) / (n - 1);
  return { mean, se: Math.sqrt(v / n) };
};

/**
 * One driver over a batch (matched by name: a random grid puts them in a different slot each race).
 * A generated field draws its drivers per seed, so every figure covers only the races the driver
 * was in (`races`); wins, podiums and DNFs are counts out of those.
 */
export interface DriverSummary {
  name: string;
  /** Races of the batch the driver was in. */
  races: number;
  /** Grid slot (1-based). */
  grid: Spread;
  wins: number;
  podiums: number;
  dnfs: number;
  /** Finishing position (1-based, DNFs classified behind the finishers as the race orders them). */
  position: Spread;
  /** How many times the driver finished in each position (index 0 = P1; as long as the largest field). */
  finishes: number[];
  /** Best lap over the batch (Infinity if no lap was completed). */
  bestLap: number;
  /** Racecraft decisions over the batch, by `role:kind` (e.g. `attack:dummy`, `defend:mirror-late`). */
  choices: Record<string, number>;
  /**
   * How varied the driver's choices are: the normalised entropy (0 = always the same, 1 = evenly
   * spread) of its attack plans and of its covers, averaged over the roles it played. NaN = none.
   */
  variety: number;
}

/** Attack plans and defensive covers that count toward variety (`hold` and `stay` are outcomes, not plans; late is timing). */
export const ATTACK_PLANS = ['inside', 'outside', 'dummy'];
export const COVERS = ['inside', 'mirror', 'line'];

/** Normalised entropy of counts (0 = one kind only, 1 = all equally often); NaN for no samples. */
export function evenness(counts: number[]): number {
  const n = counts.reduce((a, b) => a + b, 0);
  if (!n || counts.length < 2) return NaN;
  let h = 0;
  for (const c of counts) if (c > 0) h -= (c / n) * log(c / n);
  return h / log(counts.length);
}

/** Variety of a driver's choices (see `DriverSummary.variety`). */
export function varietyOf(choices: Record<string, number>): number {
  const count = (role: string, kinds: string[]) => kinds.map((k) => Object.entries(choices).filter(([key]) => key === `${role}:${k}` || key === `${role}:${k}-late`).reduce((a, [, v]) => a + v, 0));
  const parts = [evenness(count('attack', ATTACK_PLANS)), evenness(count('defend', COVERS))].filter((x) => !Number.isNaN(x));
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : NaN;
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
  /** Racecraft decisions (car = entrant index). */
  decisions?: { car: number; role: string; kind: string }[];
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
    decisions: race.decisions.map((d) => ({ car: d.car, role: d.role, kind: d.kind })),
  };
}

/**
 * Summarise a set of runs. Drivers are listed in the first run's grid order, then anyone who first
 * appears in a later run (a generated field draws its drivers per seed).
 */
export function summarize(runs: RunResult[], ms = 0): BatchSummary {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const r of runs) for (const name of r.names) if (!seen.has(name)) (seen.add(name), names.push(name));
  const n = Math.max(0, ...runs.map((r) => r.names.length));
  const drivers: DriverSummary[] = names.map((name) => {
    const ins = runs.flatMap((r) => {
      const slot = r.names.indexOf(name);
      return slot < 0 ? [] : [{ r, slot }];
    });
    const pos = ins.map(({ r, slot }) => r.order.indexOf(slot) + 1);
    const finishes = new Array(n).fill(0);
    pos.forEach((p) => finishes[p - 1]++);
    const choices: Record<string, number> = {};
    for (const { r, slot } of ins) for (const d of r.decisions ?? []) if (d.car === slot) choices[`${d.role}:${d.kind}`] = (choices[`${d.role}:${d.kind}`] ?? 0) + 1;
    return {
      name,
      races: ins.length,
      grid: spread(ins.map(({ slot }) => slot + 1)),
      wins: pos.filter((p) => p === 1).length,
      podiums: pos.filter((p) => p <= 3).length,
      dnfs: ins.filter(({ r, slot }) => r.dnf[slot]).length,
      position: spread(pos),
      finishes,
      bestLap: Math.min(...ins.map(({ r, slot }) => r.bestLaps[slot])),
      choices,
      variety: varietyOf(choices),
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
