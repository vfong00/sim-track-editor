import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type Baseline, type BaselineComparison, type BatchSummary, buildTrack, compareBaseline, hashText, makeBaseline, type RunResult, CarModel, generateTrack, LanePlans, LaneSet, loadScenario, makeField, makeRng, parseScenario, Race, runBatch, ScenarioBuildError, scenarioRaceOptions, seedRange, simulateLap, type Spread, STANDARD_CAR } from '../core';
import { decodeGrayPngBytes } from './png-node';

const HELP = `Racing sim CLI

Usage:
  npm run sim -- --help
  npm run sim -- track [--seed N] [--width M] [--complexity 0..1]
  npm run sim -- lap [--seed N]
  npm run sim -- race [--seed N] [--race N] [--cars N] [--laps N]
  npm run sim -- scenario <file.json> [--seed N]
  npm run sim -- batch <file.json> [--runs N] [--from S] [--json] [--save] [--baseline FILE]

Commands:
  track   Generate a random track and print its stats (length, min corner radius, clearance).
  race    Run a race headless and print the classification and event counts.
  lap     One flying lap of the standard car: solver lap time vs time-stepped lap time.
  scenario  Validate and run a scenario file headless (--seed overrides its race seed).
  batch   Run a scenario N times (default 20) with race seeds S, S+1, … (default 1) and print
          win %, positions, passes, incidents and how processional the race is (± = standard
          error of the mean).
          --save writes the batch as the scenario's baseline (baselines/<name>.json, or
          --baseline FILE). Later batches print the change against it, race by race for
          the seeds both ran; * marks a change bigger than twice its standard error.
`;

/** Where a scenario's baseline lives unless --baseline says otherwise. */
const baselinePath = (args: string[], file: string) => {
  const i = args.indexOf('--baseline');
  return i >= 0 && args[i + 1] ? args[i + 1] : join('baselines', basename(file).replace(/\.json$/, '') + '.json');
};

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
  if (!args[1] || args[1].startsWith('--')) { console.error('Usage: npm run sim -- batch <file.json> [--runs N] [--from S] [--json] [--save] [--baseline FILE]'); process.exit(1); }
  let data: { track?: { type?: string; image?: string } };
  let text: string;
  try { text = readFileSync(args[1], 'utf8'); data = JSON.parse(text); } catch (e) { console.error(`${args[1]}: ${(e as Error).message}`); process.exit(1); }
  const res = parseScenario(data);
  if (!res.ok) { console.error(`${args[1]} is not a valid scenario:\n${new ScenarioBuildError(res.errors).message.replace(/^/gm, '  ')}`); process.exit(1); }
  const png = data.track?.type === 'png' && data.track.image?.startsWith('data:image/png;base64,')
    ? decodeGrayPngBytes(Buffer.from(data.track.image.slice(22), 'base64')) : undefined;
  const s = res.scenario;
  const track = buildTrack(s.track, png);
  const lanes = new LaneSet(track);
  const runs = flag(args, 'runs', 20);
  const json = args.includes('--json');
  const results: RunResult[] = [];
  const sum = runBatch((seed) => scenarioRaceOptions({ ...s, seed }, track, lanes), seedRange(runs, flag(args, 'from', 1)), (k, r) => {
    results.push(r);
    if (!json && process.stderr.isTTY) process.stderr.write(`\r${k}/${runs} races`);
  });
  if (!json && process.stderr.isTTY) process.stderr.write('\r');
  const bpath = baselinePath(args, args[1]);
  const hash = hashText(text);
  if (args.includes('--save')) {
    let commit: string | undefined;
    try { commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a git checkout */ }
    mkdirSync(dirname(bpath), { recursive: true });
    writeFileSync(bpath, JSON.stringify(makeBaseline(s.name, hash, results, new Date().toISOString(), commit)) + '\n');
  }
  const base: Baseline | null = !args.includes('--save') && existsSync(bpath) ? JSON.parse(readFileSync(bpath, 'utf8')) : null;
  const cmp = base ? compareBaseline(base, results) : null;
  if (json) console.log(JSON.stringify(cmp ? { ...sum, baseline: { file: bpath, ...cmp } } : sum, null, 1));
  else {
    console.log(batchReport(s.name, sum));
    if (args.includes('--save')) console.log(`\n  Saved as the baseline: ${bpath}`);
    if (base && cmp) console.log(`\n${baselineReport(bpath, base, cmp, hash)}`);
  }
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

function baselineReport(file: string, base: Baseline, c: BaselineComparison, hash: string): string {
  const fmt = (x: number, d: number) => x.toFixed(d);
  const sign = (x: number, d: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;
  const w = Math.max(...c.rows.map((r) => r.label.length));
  const head = `  Against ${file} (saved ${base.saved.slice(0, 10)}${base.commit ? ` at ${base.commit}` : ''}): ${c.unpaired ? 'different seeds, compared as two samples' : `${c.paired} races paired by seed`}`;
  const same = !c.unpaired && c.rows.every((r) => r.delta.mean === 0 && r.delta.se === 0);
  const notes = [
    base.scenarioHash !== hash ? '  The scenario file has changed since the baseline was saved.' : '',
    same ? '  Identical race by race: nothing that affects these races has changed.' : '',
  ].filter(Boolean);
  const rows = c.rows.map((r) => {
    const d = r.digits;
    const rel = Math.abs(r.before.mean) > 1e-9 ? ` (${sign((100 * r.delta.mean) / r.before.mean, 0)}%)` : '';
    return `  ${r.notable ? '*' : ' '} ${r.label.padEnd(w)}  ${fmt(r.before.mean, d).padStart(8)} → ${fmt(r.after.mean, d).padStart(8)}   ${sign(r.delta.mean, d)} ± ${fmt(r.delta.se, d)}${rel}`;
  });
  return [head, ...notes, ...rows].join('\n');
}

function batchReport(name: string, b: BatchSummary): string {
  const pm = (x: Spread, d = 1) => `${x.mean.toFixed(d)} ± ${x.se.toFixed(d)}`;
  const pct = (k: number, of: number) => `${((100 * k) / of).toFixed(0)}%`.padStart(5);
  // A generated field draws its drivers per seed: show how many races each was in, and rate them over those.
  const mixed = b.drivers.some((d) => d.races < b.runs);
  const w = Math.max(6, ...b.drivers.map((d) => d.name.length));
  const lap = (t: number) => (Number.isFinite(t) ? `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}` : '-');
  const rows = [...b.drivers].sort((x, y) => x.position.mean - y.position.mean).map((d) =>
    `  ${d.name.padEnd(w)}  ${mixed ? `${String(d.races).padStart(5)}  ` : ''}${d.grid.mean.toFixed(1).padStart(4)}  ${pct(d.wins, d.races)}  ${pct(d.podiums, d.races)}  ${pct(d.dnfs, d.races)}  ${pm(d.position).padStart(11)}  ${lap(d.bestLap)}`);
  const chaos = b.chaos.mean < 0.25 ? 'processional' : b.chaos.mean < 0.5 ? 'some shuffling' : b.chaos.mean < 0.8 ? 'lively' : 'chaotic';
  return [
    `${name}: ${b.runs} races (seeds ${b.seeds[0]}–${b.seeds[b.seeds.length - 1]}) in ${(b.ms / 1000).toFixed(1)} s`,
    '',
    ...(mixed ? [`  (the field is drawn per seed: each driver's figures cover only the races they were in)`] : []),
    `  ${'Driver'.padEnd(w)}  ${mixed ? 'Races  ' : ''}Grid    Win  Podium  DNF     Avg pos     Best lap`,
    ...rows,
    '',
    `  Per race: passes ${pm(b.passes)}, contacts ${pm(b.contacts)} (lap 1 ${pm(b.lap1Contacts)}), incidents ${pm(b.incidents)}, spins ${pm(b.spins)}, DNFs ${pm(b.dnfs)}`,
    `  Stuck time ${pm(b.stuckTime, 0)} car-s, in a train ${(100 * b.trainShare.mean).toFixed(0)}% of the time, behind a slower class ${pm(b.trafficTime, 0)} car-s`,
    `  Chaos ${pm(b.chaos, 2)} (${chaos}: 0 = finish as they started, 1 = grid order means nothing)`,
    ...choiceRows(b, w),
  ].join('\n');
}

/** Racecraft choices per driver (phase B): attack plans, covers, and how varied they are. */
function choiceRows(b: BatchSummary, w: number): string[] {
  if (!b.drivers.some((d) => Object.keys(d.choices).length)) return [];
  const c = (d: BatchSummary['drivers'][number], key: string) => String(d.choices[key] ?? 0).padStart(4);
  const late = (d: BatchSummary['drivers'][number]) => String(Object.entries(d.choices).filter(([k]) => k.endsWith('-late')).reduce((a, [, v]) => a + v, 0)).padStart(4);
  const cover = (d: BatchSummary['drivers'][number], k: string) => String((d.choices[`defend:${k}`] ?? 0) + (d.choices[`defend:${k}-late`] ?? 0)).padStart(4);
  return [
    '',
    `  Racecraft choices (attack: inside / outside / dummy, held back, stayed in; defend: inside / mirror / line, of them late; variety 0–1)`,
    `  ${'Driver'.padEnd(w)}    in  out  dum hold stay     in  mir line late  variety`,
    ...b.drivers.map((d) => `  ${d.name.padEnd(w)}  ${c(d, 'attack:inside')} ${c(d, 'attack:outside')} ${c(d, 'attack:dummy')} ${c(d, 'attack:hold')} ${c(d, 'attack:stay')}   ${cover(d, 'inside')} ${cover(d, 'mirror')} ${cover(d, 'line')} ${late(d)}     ${Number.isNaN(d.variety) ? '   -' : d.variety.toFixed(2)}`),
  ];
}
