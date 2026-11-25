# Handoff: next session

Work on the `racing-sim` branch in `racing-sim/`. Phases 0–7 are done (7 as a CLI), plus the work in
`docs/PLAN.md` → **Feature map** → "Done since Phase 6". The same section lists what is next.

**Next: the racing sprint**, phases A–I in `docs/PLAN.md` → Feature map → "Next: the racing
sprint". They run in order: each one changes what the next one tunes against.

## Sprint loop (every phase)

1. **Design note first** (for B, D, E and G especially): what changes and how it's measured.
   The user agrees it before any code.
2. **Build**, iterating on a few seeds.
3. **Measure** with `batch` against the last phase's baselines.
4. **Watch list** for the user: scenario, timestamp, what to look for. Required, not extra:
   the user watching races as a marshal catches what the numbers miss.
5. **Tests, full suite once**, re-save baselines if the user agrees, then one commit for the
   phase (only when the user asks). Tests come in three kinds:
   - invariants (determinism, no NaNs, sectors add up, wreck avoidance): keep them as they are;
   - rule checks: add one for each rule the phase agreed with the user, read from the race log
     over several seeds (count violations), never from internals like mode names or constants;
   - tuning numbers (rates near a threshold): these go in the `batch` baselines at 16+ seeds,
     not in unit tests, unless the margin is wide. Tag slow multi-seed checks so the fast set
     can run while iterating.
6. **Hand off.** Update this file and the sprint section of `docs/PLAN.md`: what landed, what's
   still open, what the next phase should know. Then write the next phase's kickoff prompt
   under "Kickoff prompt" below, replacing the old one, and show it to the user. If the app can
   start sessions, also propose the next phase as a new session with that prompt as the brief,
   so the user can start it with a click.

Watch set for the whole sprint, so phases compare like for like: F1 constructors at Monza and
Yas, GT3 and MX-5 at Laguna, and the safety-car race.

## Kickoff prompt

The ending phase rewrites this. It should stand on its own for a fresh session: which phase,
its goal and scope from `docs/PLAN.md`, what the last phase left open, the files to start
from, and what done looks like. Keep it to about 15 lines and point to this file and the plan
rather than copying them.

> Racing sprint, phase B (racecraft decisions). Read `racing-sim/docs/HANDOFF.md` (rules, sprint
> loop, "Phase A: what landed") and phase B in the sprint section of `racing-sim/docs/PLAN.md`.
>
> Start with the design note (sprint loop step 1) and get the user's agreement before code: the
> mixed strategy for defender and attacker, reading the opponent, and rule 5 (cars behind a
> battle). Say how each is measured: variety of choices per driver, contacts and passes in `batch`.
>
> Open from phase A, to settle in the note:
> - Rule 3 check (`tests/racecraft-rules.test.ts`) is pinned at 5 violations a race (16 in 4 Yas
>   races); B is to bring it to none. Some may be a defender held on the road edge while the line
>   moves under it; look at the listed moments first.
> - The Monza exit squeeze: alongside through a chicane, the car on the outside of the exit gets
>   run onto the grass (rule 2 covers turn-in only). Ask the user whether exit room is a rule.
> - The dirty-air check fails (committed so): dirty air hardly holds a faster car up since A.
>   Numbers under "Phase A: what landed".
> - Incidents: compare with `batch` against the baselines the user chose at the end of A.
>
> Files: `src/core/agents/racecraft.ts`, `src/core/agents/controller.ts`. Time-box measuring
> (memory: plan test depth first). Done: the agreed note built, rule checks for every new rule,
> a watch list, the full suite passing, and the phase C kickoff written here.

## Phase A: what landed (2026-11-24)

- **Lane-edge kink.** A car that began to spin turned on the spot by the racing line's slope:
  its sideways speed is relative to the line while driven, across the road once spinning.
  `toFrame` in `car.ts` converts it; contacts compare cars in the line frame (`lineSideSpeed`).
  A driven car holding the edge now eases onto it (`EDGE_STOP`, a limit on position that stores
  no sideways speed) instead of stopping dead: big sideways jumps at the edge fell by about
  half. Left: jumps when a slide, a squeeze or a push releases a car from the edge.
  Tried and reverted, because each threw cars back across the road into the car beside them:
  holding the speed across the road at zero on the edge, and converting the frame on the way
  into the run-off (that doubled contacts at Monza).
- **Kerbs** (`src/core/track/surface.ts`): a surface grip grid per node across the road (rain
  writes into it later). Kerbs (`kerbsFor`, moved from the viewer) have `KERB_GRIP` 0.9; a car
  has the mean over its tyres. The speed plans pay for it per lane (`LaneSet.grips`), about
  +0.1% lap time on the line at Monza, 0.7% at Yas. Power down near the limit on a kerb can spin
  a car (`INCIDENTS.kerbSpin*`), logged as a slide first: 0.1–0.5 a race.
  The kerbs only cost: they sit inside the road, and the line keeps `LINE_MARGIN` from the edge
  whatever the kerbs. Real kerbs give width (a wider line, a faster corner) for grip and spin
  risk, and how much kerb a driver uses is a style. Belongs with D (corner lines, styles).
- **Monza 5:27 (seed 1)**: Alvarez alongside Abreu holds his side through the chicane (inside
  into part 1, outside of part 2: the switchback), and the throttle blip between the parts is
  the racing line's own minimum-time input (79 → 98 → 65 km/h). Not a controller fault. What
  breaks a rule, maybe: Abreu runs him onto the grass on the exit. Open with the user.
- **Rule checks** (`tests/racecraft-rules.test.ts`, `[slow]`, from the race log): rule 3 (no
  move toward a pulled-out attacker under braking: 16 in 4 races, pinned), rule 2 (room at
  turn-in: 0 of 60), rule 1 (tow kept on a straight: 0 of 6), and kerbs (spins only under power on
  a kerb, logged; the grip cost). Skip slow ones while iterating with
  `npx vitest run --testNamePattern='^(?!.*\[slow\])'`.
- **Dirty-air check fails** (`tests/racing-wake.test.ts`, committed failing with the user's
  agreement). Races of 48 (16 seeds × 3 pace gaps) where the faster car is held up over 30 s:
  HEAD before A 13, dirty air off 8, slipstream off 23; after A 5, 6 and 14. Passing got much
  easier (likely the edge change: cars no longer stuck pinned to the edge) and dirty air
  hardly holds a car up now. For B to settle (and E re-tunes dirty air); the check itself is
  also all-or-nothing per seed (0 or 150–285 s stuck), so count held-up races instead.

## Racecraft rules (agreed with the user, F1 style)

1. An attacker carries the most speed it can and never gives up its tow while pulling out.
2. Overlap at turn-in decides who gets the corner. Overlap only counts if the defender had
   time to see it.
3. The defender gets one move before braking. No moving back, no moving under braking.
4. The attacker is only entitled to the other side. Braking early can be right, to set up the
   exit or keep the tow.
5. Cars behind a battle expect early, uneven braking and use the whole width of the road.

The rules exist for safety and feasibility. Three wide is the same rule as two wide: is there
room for it? Within the rules, choices are a mixed strategy (phase B), not one fixed move. Check
changes against these rules, and bring up cases they don't settle instead of tuning around them.

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
  A generated field draws its drivers per seed, so per-driver figures cover only the races each
  driver was in (`DriverSummary.races`); baselines hold per-race numbers and pair by seed.

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
