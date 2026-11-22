import type { Entrant } from '../agents/driver';
import type { PhysicsParams } from '../physics/model';
import type { LaneSet } from './lanes';
import { Race } from './race';

/** Timed laps in a qualifying run (after the flying run-up); the best one counts. */
export const QUALI_LAPS = 2;

export interface QualifyingOptions {
  lanes: LaneSet;
  entrant: Entrant;
  seed: number;
  physics?: Partial<PhysicsParams>;
  incidents?: boolean;
  incidentRate?: number;
}

/**
 * One car's qualifying run, alone on the track: a flying run-up, then QUALI_LAPS timed laps at
 * the limit. Deterministic in its options, so the viewer can re-run a car's session to watch it.
 */
export function qualifyingRun(o: QualifyingOptions): Race {
  return new Race({
    track: o.lanes.track, lanes: o.lanes, entrants: [o.entrant], laps: QUALI_LAPS, seed: o.seed,
    physics: o.physics, incidents: o.incidents, incidentRate: o.incidentRate, session: 'qualifying',
  }).run();
}

export interface QualifyingResult {
  /** Timed laps completed (s). */
  laps: number[];
  /** Best lap (Infinity if none: out of the session). */
  best: number;
  /** What happened, if anything: "Off at Stowe, lap 2", "Crashed out at Copse, lap 1", or ''. */
  note: string;
}

const NOTED = new Set(['mistake', 'off', 'spin', 'crash', 'retire']);

export function qualifyingResult(r: Race): QualifyingResult {
  const c = r.cars[0];
  const laps = [...c.lapTimes];
  const name = c.entrant.driver.name;
  // The worst thing that happened (a crash over a spin over an off over a mistake), else the first.
  const rank = ['mistake', 'off', 'spin', 'crash', 'retire'];
  let worst: (typeof r.events)[number] | undefined;
  for (const e of r.events) if (NOTED.has(e.type) && (!worst || rank.indexOf(e.type) > rank.indexOf(worst.type))) worst = e;
  const what = worst ? worst.text.replace(`${name} `, '') : '';
  const note = what ? `${what[0].toUpperCase()}${what.slice(1)}, lap ${Math.max(1, Math.min(QUALI_LAPS, worst!.lap))}` : '';
  return { laps, best: laps.length ? Math.min(...laps) : Infinity, note };
}
