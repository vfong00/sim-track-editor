import { hypot } from '../fmath';
import { type RunResult, type Spread, spread } from './batch';

/**
 * Batch baselines: a scenario's per-race numbers saved once (`batch --save`), so a later batch
 * can print what a change did. With the same seeds the comparison is paired (each race against
 * the same seed's race before), which sees much smaller changes than comparing two means.
 */

export interface Metric {
  key: string;
  label: string;
  digits: number;
  of: (r: RunResult) => number;
}

/** What a baseline records per race. */
export const BASELINE_METRICS: Metric[] = [
  { key: 'passes', label: 'Passes', digits: 1, of: (r) => r.stats.passes },
  { key: 'contacts', label: 'Contacts', digits: 1, of: (r) => r.stats.contacts },
  { key: 'lap1Contacts', label: 'Lap-1 contacts', digits: 1, of: (r) => r.lap1Contacts },
  { key: 'incidents', label: 'Incidents', digits: 1, of: (r) => r.incidents },
  { key: 'spins', label: 'Spins', digits: 1, of: (r) => r.stats.spins },
  { key: 'dnfs', label: 'DNFs', digits: 2, of: (r) => r.stats.dnfs },
  { key: 'stuckTime', label: 'Stuck time (car-s)', digits: 0, of: (r) => r.stats.stuckTime },
  { key: 'trafficTime', label: 'Behind slower class (car-s)', digits: 0, of: (r) => r.stats.trafficTime },
  { key: 'trainShare', label: 'In a train (share)', digits: 3, of: (r) => r.stats.trainShare },
  { key: 'chaos', label: 'Chaos', digits: 2, of: (r) => r.chaos },
  { key: 'fastestLap', label: 'Fastest lap (s)', digits: 3, of: (r) => Math.min(...r.bestLaps) },
];

export const BASELINE_VERSION = 1;

export interface Baseline {
  version: number;
  scenario: string;
  /** Hash of the scenario file, to warn when it has changed since. */
  scenarioHash: string;
  /** When it was saved (ISO time) and the commit, if known. */
  saved: string;
  commit?: string;
  seeds: number[];
  /** Per metric key, one value per seed (seeds order). */
  values: Record<string, number[]>;
}

export function makeBaseline(scenario: string, scenarioHash: string, runs: RunResult[], saved: string, commit?: string): Baseline {
  const values: Record<string, number[]> = {};
  for (const m of BASELINE_METRICS) values[m.key] = runs.map(m.of);
  return { version: BASELINE_VERSION, scenario, scenarioHash, saved, ...(commit ? { commit } : {}), seeds: runs.map((r) => r.seed), values };
}

export interface BaselineRow {
  key: string;
  label: string;
  digits: number;
  before: Spread;
  after: Spread;
  /** After − before: paired by seed when the seeds match, else the difference of the means. */
  delta: Spread;
  /** The change is more than twice its standard error. */
  notable: boolean;
}

export interface BaselineComparison {
  /** Seeds in both, compared race by race. */
  paired: number;
  /** The seeds differ (compared as two separate samples). */
  unpaired: boolean;
  rows: BaselineRow[];
}

/** Compare a batch with a baseline (metrics the baseline lacks are left out). */
export function compareBaseline(base: Baseline, runs: RunResult[]): BaselineComparison {
  const at = new Map(base.seeds.map((s, k) => [s, k]));
  const shared = runs.filter((r) => at.has(r.seed));
  const paired = shared.length >= 2 ? shared : [];
  const rows: BaselineRow[] = [];
  for (const m of BASELINE_METRICS) {
    const old = base.values[m.key];
    if (!old) continue;
    const now = runs.map(m.of);
    let delta: Spread;
    if (paired.length) delta = spread(paired.map((r) => m.of(r) - old[at.get(r.seed)!]));
    else {
      const a = spread(old), b = spread(now);
      delta = { mean: b.mean - a.mean, se: hypot(a.se, b.se) };
    }
    const notable = Math.abs(delta.mean) > 2 * delta.se && Math.abs(delta.mean) > 1e-9;
    rows.push({ key: m.key, label: m.label, digits: m.digits, before: spread(old), after: spread(now), delta, notable });
  }
  return { paired: paired.length, unpaired: !paired.length, rows };
}

/** A short stable hash (FNV-1a, hex) of a string. */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
