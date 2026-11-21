import { CarModel, generateTrack, LanePlans, LaneSet, makeField, makeRng, Race, simulateLap, STANDARD_CAR } from '../core';

const HELP = `Racing sim CLI

Usage:
  npm run sim -- --help
  npm run sim -- track [--seed N] [--width M] [--complexity 0..1]
  npm run sim -- lap [--seed N]
  npm run sim -- race [--seed N] [--race N] [--cars N] [--laps N]

Commands:
  track   Generate a random track and print its stats (length, min corner radius, clearance).
  race    Run a race headless and print the classification and event counts.
  lap     One flying lap of the standard car: solver lap time vs time-stepped lap time.
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
} else if (args[0] === 'race') {
  const track = generateTrack({ seed: flag(args, 'seed', 7), width: flag(args, 'width', 14) });
  const seed = flag(args, 'race', 1);
  const race = new Race({ track, entrants: makeField(flag(args, 'cars', 12), makeRng(seed)), laps: flag(args, 'laps', 10), seed }).run();
  const order = race.order();
  const winner = race.cars[order[0]];
  console.log(JSON.stringify({
    time: +race.t.toFixed(2),
    results: order.map((i, p) => {
      const c = race.cars[i];
      return { pos: p + 1, name: c.entrant.driver.name, laps: c.finishLaps, gap: p ? +(c.finishTime - winner.finishTime).toFixed(3) : 0, best: +Math.min(...c.lapTimes).toFixed(3) };
    }),
    events: race.events.reduce<Record<string, number>>((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {}),
  }, null, 1));
} else {
  console.error(`Unknown command: ${args[0]}\n\n${HELP}`);
  process.exit(1);
}
