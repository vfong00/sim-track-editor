import { generateTrack } from '../core';

const HELP = `Racing sim CLI

Usage:
  npm run sim -- --help
  npm run sim -- track [--seed N] [--width M] [--complexity 0..1]

Commands:
  track   Generate a random track and print its stats (length, min corner radius, clearance).
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
} else {
  console.error(`Unknown command: ${args[0]}\n\n${HELP}`);
  process.exit(1);
}
