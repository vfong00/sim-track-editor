# Handoff: next session

Work on the `racing-sim` branch in `racing-sim/`. Phases 0–6 are done, plus the work in
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
- **Drivers**: the fixed roster (`src/core/agents/roster.ts`), named A–T by overall ability;
  a test keeps the order. Scenarios use speed / consistency / risk (`driverFromRatings`).
- **Scenarios** (`src/core/scenario/`): strict validation; PNG tracks take `reverse` and
  `start` (metres along the trace to the start line).
- **Viewer** (`src/view/`): reads only logs (`RaceAt` in `at.ts`); stats, tower and minimap
  are DOM-free modules (`stats.ts`, `tower.ts`, `minimap.ts`).

## Known soft spots

- Dirty air no longer holds a faster car up (`tests/racing-wake.test.ts`, marked `it.fails`).
  Turn it back into a normal `it()` once it holds again.
- A 6%-faster car sometimes spins after contact on a late dive instead of passing.
- These are small-sample checks; batch stats would make tuning them far less noisy.
