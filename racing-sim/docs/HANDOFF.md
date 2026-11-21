# Handoff: next session

Start **Phase 7 (Batch runs and stats)** of `racing-sim/docs/PLAN.md` on the `racing-sim` branch in
`racing-sim/`. Phases 0–6 are committed, plus follow-ups: safety car, camera controls, timeline
scrubber and name labels (latest: see `git log`). `docs/PLAN.md` also has an **Ideas inventory**
section with what's left besides Phase 7.

Same rules as before: follow the plan's design rules; Phase 7 "Checks" become automated tests that
pass; run `npm test` and `npm run typecheck`; keep `npm run dev` running (launch config
`racing-sim-dev` in `.claude/launch.json`), add visible output and verify it in the browser at
**1x** (don't leave it at 16x); commit as "racing-sim: Phase 7 ..." and don't push unless asked.
If a check looks wrong, stop, explain and propose a change rather than loosening it.

## Where things are today

- **Scenarios** (`src/core/scenario/`): `parseScenario` (strict validation, errors name the
  field), `loadScenario(json, pngImage?)` → `{ scenario, track, options }`,
  `scenarioRaceOptions(s, track, lanes)` to reuse a cached `LaneSet`, `trackKey(spec)` for track
  caches (rule 5). Examples in `scenarios/*.json`. Share links: `encodeScenario` / `decodeScenario`.
- **CLI** (`src/cli/sim.ts`): `npm run sim -- scenario <file> [--seed N]` runs one race and
  prints the classification and event counts. Phase 7 extends this to N runs. PNG scenarios
  decode in Node via `src/cli/png-node.ts` (8-bit grayscale only).
- **Race** (`src/core/race/race.ts`): `new Race(options).run()`; `stats()` gives passes,
  mistakes, contacts, offs, spins, dnfs, trainShare, stuckTime. Results: `order()`, each car's
  `finished`, `finishTime`, `finishLaps`, `lapTimes`, `dnf`. Events carry `type`, `cars`, `lap`,
  `cause`. Deterministic per seed within one JS engine (generated and drawn tracks also match
  between Node and Chrome; PNG tracks can differ in the last float digits).
- **Timing**: a 12-car, 10-lap race takes roughly 2–5 s in Node. Lane sets and plans are cached
  (`lanePlansFor`, keyed by lane set, car spec, physics and pace), so reuse one `LaneSet` per track
  across runs. For many runs consider worker threads.
- **Drivers**: scenarios use speed / consistency / risk (`driverFromRatings`); racecraft = mean
  of speed and consistency. "Most skilled driver" for Phase 7's check: highest speed with
  average consistency and risk, in an equal-car scenario.
- **Viewer** (`src/view/`): reads only logs at the viewer clock (`RaceAt` in `at.ts`); the race
  computes ahead in the background. Timeline in `timeline.ts`, camera framing in `camera.ts`.

## Known soft spots (good to measure with Phase 7's stats)

- First-lap pile-ups at T1 are common (the random-field example loses 2 cars on lap 1).
- A 3%-faster car rarely gets past with dirty air on.
- Slipstream helps less with incidents on (~15% vs the 30% bar in Phase 4's check, which runs
  with `incidents: false`).

## Phase 7 design points to settle early (ask if unclear)

- Seed set: run seeds 1..N of a scenario (the scenario's own seed is ignored), or seed + k?
- Output: summary JSON shape (win %, mean finishing position, passes and incidents per race,
  DNF rate, a "processional vs chaotic" score; define the score).
- Stability check: same seed set gives identical summaries; how many runs make the "most
  skilled driver wins most often" check reliable without slowing the suite too much.
- Browser "simulate 100": run in a Web Worker so the page stays responsive; charts.
