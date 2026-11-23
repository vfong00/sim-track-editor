# Handoff: next session

Work on the `racing-sim` branch in `racing-sim/`. Phases 0–7 are done (7 as a CLI), plus the work in
`docs/PLAN.md` → **Feature map** → "Done since Phase 6". The same section lists what is next.

Same rules as before: follow the plan's design rules; run `npm test` and `npm run typecheck`;
keep `npm run dev` running (launch config `racing-sim-dev` in `.claude/launch.json`), add
visible output and verify it in the browser at **1x**; commit as "racing-sim: ..." and don't
push unless asked. If a check looks wrong, stop, explain and propose a change rather than
loosening it.

npm on this Mac: Artifactory may be unreachable. Install with
`npm ci --registry=https://registry.npmjs.org/ --replace-registry-host=always --no-audit`.

## Where things are today

- **Physics** (`src/core/physics/model.ts`): one model for planner and integrator (rule 1). Grip
  is `g·(grip + downforce·v²)`. `CAR_PRESETS` holds the quick configurations; scenario cars
  take `preset` and override any field.
- **Racing line** (`src/core/track/line.ts`): minimum curvature, coarse to fine. Lanes
  (`src/core/race/lanes.ts`) are the line shifted sideways, eased off the road edge.
- **Racecraft** (`src/core/agents/racecraft.ts`): attack, dive for the inside (`DIVE_FROM`),
  defend, slipstream (`WAKE_RANGE` or `WAKE_TIME` back) and dirty air (`DIRTY_RANGE`).
- **Drivers**: the fixed roster (`src/core/agents/roster.ts`), 30 drivers named A–Z by overall ability (M and N mid-pack; A, M, R and W have two);
  a test keeps the order. Scenarios use speed / consistency / risk (`driverFromRatings`).
  `pace` is the limit (qualifying); races run at `racePace` (a margin set by consistency) via
  `Race.paceOf`. Qualifying grids run each car's session (`src/core/race/qualifying.ts`).
- **Scenarios** (`src/core/scenario/`): strict validation; PNG tracks take `reverse` and
  `start` (metres along the trace to the start line). Examples shown in the viewer live in
  `scenarios/` and can change freely; the checks use their own copies in
  `tests/fixtures/scenarios/`. Track images: `tests/fixtures/*.png` (Laguna and the
  Nordschleife are cleaned-up, upscaled versions of the originals).
- **Viewer** (`src/view/`): reads only logs (`RaceAt` in `at.ts`); stats, tower, minimap and
  the result panel are DOM-free modules (`stats.ts`, `tower.ts`, `minimap.ts`, `summary.ts`).
- **Batch runs** (`src/core/race/batch.ts`, CLI `batch`): one track and lane set, many seeds;
  `runBatch` / `summarize` work in Node and the browser. Use it to tune instead of single races.

## Determinism (Node and the browser run the same race)

- The race is chaotic, so one bit anywhere becomes a different race. Engines round `Math.exp`,
  `log`, `sin`, `cos` (and `atan2`, `pow`, `**`) differently in the last bit: Node 24 and Chrome
  disagreed, so until 2026-11-23 the viewer showed a different race from the CLI, the tests and
  the batch baselines for the same scenario and seed. Core code now uses `src/core/fmath.ts`
  (fdlibm ports, only + − × ÷), and `tests/determinism.test.ts` fails on any engine-rounded Math
  call or `**` in `src/core`. `sqrt`, `hypot`, `floor` and the like are exact and fine.
- To check parity: `tools/parity/` runs a scenario the way the viewer does and prints its events,
  setup hashes or per-tick state (instructions at the top of the page). Run it in headless Chrome
  and diff against the same run in Node (`tools/parity/dump.js` has the shared dump functions).
  The 30-lap F1 Yas race matched event for event when this landed.

## Known soft spots

- A 6%-faster car sometimes spins after contact on a late dive instead of passing.
- Overtaking: late lunges are rare and capped, and on a corner exit nobody owns their lane (a car
  alongside gets edged out and lifts). Causes and fixes in `docs/PLAN.md` → "Overtaking bugs".
- Many Phase 4 checks use 4–8 seeds and sit near their thresholds. Use the batch runner
  (`npm run sim -- batch <scenario> --runs N`) or more seeds before reading a change into them.
  The traffic-rule checks run with the standard car, which has no downforce, so they don't
  exercise dirty air by downforce; `tests/dirty-air.test.ts` does.
