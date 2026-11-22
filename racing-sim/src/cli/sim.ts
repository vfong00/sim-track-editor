import { readFileSync } from 'node:fs';
import { type BatchSummary, buildTrack, CarModel, generateTrack, LanePlans, LaneSet, loadScenario, makeField, makeRng, parseScenario, Race, runBatch, ScenarioBuildError, scenarioRaceOptions, seedRange, simulateLap, type Spread, STANDARD_CAR } from '../core';
import { decodeGrayPngBytes } from './png-node';

const HELP = `Racing sim CLI

Usage:
  npm run sim -- --help
  npm run sim -- track [--seed N] [--width M] [--complexity 0..1]
  npm run sim -- lap [--seed N]
  npm run sim -- race [--seed N] [--race N] [--cars N] [--laps N]
  npm run sim -- scenario <file.json> [--seed N]
  npm run sim -- batch <file.json> [--runs N] [--from S] [--json]

Commands:
  track   Generate a random track and print its stats (length, min corner radius, clearance).
  race    Run a race headless and print the classification and event counts.
  lap     One flying lap of the standard car: solver lap time vs time-stepped lap time.
  scenario  Validate and run a scenario file headless (--seed overrides its race seed).
  batch   Run a scenario N times (default 20) with race seeds S, S+1, … (default 1) and print
          win %, positions, passes, incidents and how processional the race is (± = standard
          error of the mean).
`;

function flag(args: string[], name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(HELP);
} else if (args[0] === 'track') {
  const t = generateTrack({ seed: flag(args, 'seed', 1), width: flag(args, 'width', 14), complexity: flag(args, 'complexity', 0.6) });
  console.log(JSON.stringify({ length: +t.length.toFixed(1), samples: t.n, minRadius: +t.minRadius().toFixed(1), clearance: +t.clearance().toFixed(1) }));
} else if (args[0] === 'lap') {
  const t = generateTrack({ seed: flag(args, 'seed', 1), width: flag(args, 'width', 14) });
  const model = new CarModel(STANDARD_CAR);
  const lanes = new LaneSet(t);
  const plans = new LanePlans(lanes, model);
  const lap = simulateLap(lanes, plans, model);
  console.log(JSON.stringify({ length: +t.length.toFixed(1), solverLap: +plans.lapTime.toFixed(3), steppedLap: +lap.lapTime.toFixed(3), maxGripUsage: +lap.maxUsage.toFixed(4) }));
} else if (args[0] === 'batch') {
  if (!args[1] || args[1].startsWith('--')) { console.error('Usage: npm run sim -- batch <file.json> [--runs N] [--from S] [--json]'); process.exit(1); }
  let data: { track?: { type?: string; image?: string } };
  try { data = JSON.parse(readFileSync(args[1], 'utf8')); } catch (e) { console.error(`${args[1]}: ${(e as Error).message}`); process.exit(1); }
  const res = parseScenario(data);
  if (!res.ok) { console.error(`${args[1]} is not a valid scenario:\n${new ScenarioBuildError(res.errors).message.replace(/^/gm, '  ')}`); process.exit(1); }
  const png = data.track?.type === 'png' && data.track.image?.startsWith('data:image/png;base64,')
    ? decodeGrayPngBytes(Buffer.from(data.track.image.slice(22), 'base64')) : undefined;
  const s = res.scenario;
  const track = buildTrack(s.track, png);
  const lanes = new LaneSet(track);
  const runs = flag(args, 'runs', 20);
  const json = args.includes('--json');
  const sum = runBatch((seed) => scenarioRaceOptions({ ...s, seed }, track, lanes), seedRange(runs, flag(args, 'from', 1)), (k) => {
    if (!json && process.stderr.isTTY) process.stderr.write(`\r${k}/${runs} races`);
  });
  if (!json && process.stderr.isTTY) process.stderr.write('\r');
  console.log(json ? JSON.stringify(sum, null, 1) : batchReport(s.name, sum));
} else if (args[0] === 'race' || args[0] === 'scenario') {
  let race: Race;
  if (args[0] === 'scenario') {
    if (!args[1] || args[1].startsWith('--')) { console.error('Usage: npm run sim -- scenario <file.json> [--seed N]'); process.exit(1); }
    let data: { seed?: number; track?: { type?: string; image?: string } };
    try { data = JSON.parse(readFileSync(args[1], 'utf8')); } catch (e) { console.error(`${args[1]}: ${(e as Error).message}`); process.exit(1); }
    if (args.includes('--seed')) data.seed = flag(args, 'seed', 0);
    try {
      const png = data.track?.type === 'png' && data.track.image?.startsWith('data:image/png;base64,')
        ? decodeGrayPngBytes(Buffer.from(data.track.image.slice(22), 'base64')) : undefined;
      race = new Race(loadScenario(data, png).options).run();
    } catch (e) {
      console.error(`${args[1]} is not a valid scenario:\n${e instanceof ScenarioBuildError ? e.message.replace(/^/gm, '  ') : (e as Error).message}`);
      process.exit(1);
    }
  } else {
    const track = generateTrack({ seed: flag(args, 'seed', 7), width: flag(args, 'width', 14) });
    const seed = flag(args, 'race', 1);
    race = new Race({ track, entrants: makeField(flag(args, 'cars', 12), makeRng(seed)), laps: flag(args, 'laps', 10), seed }).run();
  }
  const order = race.order();
  const winner = race.cars[order[0]];
  console.log(JSON.stringify({
    time: +race.t.toFixed(2),
    results: order.map((i, p) => {
      const c = race.cars[i];
      if (c.dnf) return { pos: p + 1, name: c.entrant.driver.name, laps: c.lapTimes.length, status: 'DNF' };
      return { pos: p + 1, name: c.entrant.driver.name, laps: c.finishLaps, gap: p ? +(c.finishTime - winner.finishTime).toFixed(3) : 0, best: +Math.min(...c.lapTimes).toFixed(3) };
    }),
    events: race.events.reduce<Record<string, number>>((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {}),
  }, null, 1));
} else {
  console.error(`Unknown command: ${args[0]}\n\n${HELP}`);
  process.exit(1);
}

function batchReport(name: string, b: BatchSummary): string {
  const pm = (x: Spread, d = 1) => `${x.mean.toFixed(d)} ± ${x.se.toFixed(d)}`;
  const pct = (k: number) => `${((100 * k) / b.runs).toFixed(0)}%`.padStart(5);
  const w = Math.max(6, ...b.drivers.map((d) => d.name.length));
  const lap = (t: number) => (Number.isFinite(t) ? `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}` : '-');
  const rows = [...b.drivers].sort((x, y) => x.position.mean - y.position.mean).map((d) =>
    `  ${d.name.padEnd(w)}  ${d.grid.mean.toFixed(1).padStart(4)}  ${pct(d.wins)}  ${pct(d.podiums)}  ${pct(d.dnfs)}  ${pm(d.position).padStart(11)}  ${lap(d.bestLap)}`);
  const chaos = b.chaos.mean < 0.25 ? 'processional' : b.chaos.mean < 0.5 ? 'some shuffling' : b.chaos.mean < 0.8 ? 'lively' : 'chaotic';
  return [
    `${name}: ${b.runs} races (seeds ${b.seeds[0]}–${b.seeds[b.seeds.length - 1]}) in ${(b.ms / 1000).toFixed(1)} s`,
    '',
    `  ${'Driver'.padEnd(w)}  Grid    Win  Podium  DNF     Avg pos     Best lap`,
    ...rows,
    '',
    `  Per race: passes ${pm(b.passes)}, contacts ${pm(b.contacts)}, incidents ${pm(b.incidents)}, spins ${pm(b.spins)}, DNFs ${pm(b.dnfs)}`,
    `  Stuck time ${pm(b.stuckTime, 0)} car-s, in a train ${(100 * b.trainShare.mean).toFixed(0)}% of the time, behind a slower class ${pm(b.trafficTime, 0)} car-s`,
    `  Chaos ${pm(b.chaos, 2)} (${chaos}: 0 = finish as they started, 1 = grid order means nothing)`,
  ].join('\n');
}
