# Handoff: next session

Work on `main` in `racing-sim/` (the old `racing-sim` branch is merged and gone). Fetch first:
the user works from two computers. Phases 0–7 are done (7 as a CLI), plus the work in
`docs/PLAN.md` → **Feature map** → "Done since Phase 6". The same section lists what is next.

**Next: phase D of the racing sprint** (A, B and C are done), phases A–I in `docs/PLAN.md` → Feature map → "Next: the racing
sprint". They run in order: each one changes what the next one tunes against.

## Sprint loop (every phase)

The user's order for each phase (agreed 2026-11-24):

1. **Open with one message**, then wait for the user's go:
   - checks failing or pinned and bugs left from earlier phases that this phase should fix;
   - the high-level design for this phase: what changes and how it's measured;
   - race moments for the user to adjudicate (scenario, seed, time, cars, the question), the
     ones whose answer changes the design. Find real ones in the watch set where you can.
2. **Build** on the user's go, iterating on a few seeds.
3. **Measure** with `batch` against the last phase's baselines.
4. **Watch list** for the user: scenario, timestamp, what to look for. The user's testing is
   optional, but the list is required: watching races as a marshal catches what the numbers miss.
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

> Racing sprint, phase D (driving styles and corner lines). Read `racing-sim/docs/HANDOFF.md`
> (rules 1–7 and 3 amended, sprint loop, "Phase C: what landed") and phase D in the sprint section
> of `racing-sim/docs/PLAN.md`.
>
> Open with one message (sprint loop step 1) and wait for the user's go: fixes from C you want to
> make, the design (handling styles, three lines per corner, styles feeding B's decisions, kerbs
> as width), and real race moments for the user to adjudicate.
>
> Open from phase C:
> - Rule checks pinned back above 0 with real car sizes: rule 3 (5 in 8 races), rule 2 (1 of 295),
>   corner capacity (2), rule 5 (1 of 585), all multi-car moments at Monza T1/T2 laps 2–3 and one
>   Yas braking zone. The lap-1 pinch count halved (43.6 → 22.5 a race) but is noisy.
> - Passes fell 19–45% (the user accepted: there was never a right number). Look for passes that
>   should happen: GT3 Laguna has 15 stretches in 6 seeds of a car ≥0.4 s/lap quicker stuck within
>   1 s for 2.5+ laps (seed 1: Jovanovic behind Ueda the whole race, 1 s/lap quicker).
> - The rolling start (`race.start: 'rolling'`) arrives at T1 too tight: squeezes for the field.
> - Re-pick the seeds in `tests/effects.test.ts` and `tests/safety-car.test.ts` if races change.
>
> Files: `src/core/agents/racecraft.ts`, `src/core/agents/controller.ts`, `src/core/track/line.ts`.
> Baselines: `baselines/phase-b/` (16 seeds, from f36283f); re-save for C if the user agrees.
> Done: the agreed design built, rule checks for it, a watch list, the full suite passing, and the
> phase E kickoff written here.

## Phase C: what landed (2026-11-26)

Measured against phase B batches for the watch set at 16 seeds (`baselines/phase-b/`, saved from
f36283f), paired by seed. Lap-1 contacts: Monza 5.1 → 1.3, Yas 5.1 → 4.1, MX-5 18.4 → 6.5, GT3
2.2 → 1.7, safety-car Yas 5.6 → 2.0. Contacts over the race: flat for F1, −38% GT3, −44% MX-5.
DNFs: Monza 0.88 → 0.13, MX-5 1.9 → 0.4, Yas 0.13 → 0.31. Passes −19% to −45%, and fastest laps
+0.4% to +4% (laps no longer beat the ideal; Monza most, where the tow is worth most).

- **Laps no longer beat physics** (`flatOut` in `racecraft.ts`): a car keeps speed over its plan
  only where the plan is capped by top speed, not by grip (a corner at a steady radius is flat
  too). Qualifying laps were 1.7% under the push plan at Yas; now +0.1% (−0.2% to +0.3%).
- **Lights out** (`race.ts`, `LIGHTS`, `REACTION`, `JUMP_RATE`, `LAUNCH`): the race clock starts
  at the first red light, one a second, a 0.2–3 s hold, lights out at 5.2–8 s. Reaction 0.15–0.35 s
  from consistency and racecraft; a jump start (moving before the lights go out, about 0.1 a
  race) is logged (`jump` event, a penalty once H has them). Launch: a share of the drive for 2 s
  by consistency (wheelspin, bog-down). The viewer draws the gantry; `race.lightsOut` has the time.
- **Grid side to T1** (`Craft.gridD`): every car holds its grid side down to T1's braking or its
  approach (`LAP1_HOLD_TO`); attacking and defending moves still override it. Off the grid side
  before braking: 53% of cars at B, 3% now.
- **Car size per preset** (`CAR_SIZES` in `model.ts`): F1 5.6 × 2.0, LMP and GT3 4.7 × 2.0, MX-5
  3.9 × 1.73; the field's largest is the race's `size`, and `useCarSize` (each step) sets
  `HIT_LEN`, `HIT_W`, `SIDE_GAP`, `SQUEEZE` and `ALONGSIDE` from it. Road edges keep the default
  width, so lane plans don't depend on the field. Grid slots by length (F1 8 m). The bigger F1
  cars are the main reason passes fell (Monza 4 seeds: 64 a race, 98 with the old size).
- **Rule 3 amended** (from the user's Monza seed 5 rulings): under braking, with a car alongside
  on that side, following the racing line toward it is a move too: hold your place across the
  road (`HOLD_REACH`). First into a gap owns it; taking the open side is fair.
- **Hazards and braking cars** (`controller.ts`): a spinning car is a hazard at any speed (plan to
  reach it at `SPIN_END` of its speed; the user's Monza seed 3 ruling). A braking car ahead I'm
  within `BRAKING_MARGIN` of sideways counts as in line (Jovanovic into Hughes, same race).
- **Lap 1 caution** (`LAP1_CAUTION`, `LAP1_FOLLOW`, `CONTACT_TOLERANCE`): a margin under race
  pace, 6% into T1 and 2% after at bravery 0; extra following room on lap 1 (most of the lap-1
  gain: contacts were nose to tail at 3–4 km/h); classes that tolerate bumps (MX-5 0.6, GT3 0.3,
  F1 0) keep less of it. The tolerance lever is weak: it barely moved MX-5.
- **Rolling start** (`race.start: 'rolling'`, `ROLLING`): two-wide, 150 m further back, at 35% of
  the slowest car's top speed, green when the leader reaches the line. The formation lap isn't
  driven. Open: the field reaches T1 too tight (squeezes); SC restarts are still single file.
- **Ideal race lap** in the car details (the race plan's clean-air lap at race pace, with grip and
  damage now; tyre wear comes with E).
- **Rule checks**: `tests/lap1-rules.test.ts` (amended rule 3 on lap 1, grid side, lights out).
  `tests/racecraft-rules.test.ts` limits re-pinned (see the kickoff above). Rule 1 fell from its
  15% pin to 1 of 57.
- **Safari parity** (before C proper): the viewer decodes PNGs in code (bb9c67e) and core uses an
  engine-exact `hypot` (f36283f); see Determinism.

## Phase B: what landed (2026-11-26)

Measured against Phase A batches saved for the watch set at 16 seeds (`baselines/phase-a/`,
from 61f0087; the official `baselines/*.json` are unchanged). All paired by seed.

- **Mixed strategy** (`racecraft.ts`): an attacker picks a plan by weight (`inside`, `outside`,
  `dummy`: show the inside, switch once within `DUMMY_LEAD` of braking); a defender picks a cover
  (`inside`, `mirror` the side shown, `line` to protect the exit) and early or late (within
  `LATE_LEAD` of braking, still legal). Aggression and racecraft shape the weights.
- **Reading the opponent**: each driver remembers each rival's covers and attack sides
  (`Craft.memory`); high racecraft leans against the habit (`READ_GAIN`).
- **Backing out**: when the door shuts, a brave, low-racecraft driver sometimes stays in the
  gap (`STAY_RATE`); otherwise it gives the move up as before.
- **Corner capacity** (rule 7, `cornerRoom`): no move into a corner that would make one car too
  many, checked when the move starts, at the pull-out, and while committed but not yet level.
- **Rule 3 for every car**, from half a second before braking (a move started then is still
  going under braking). **Exit room** (rule 6, `GapRuleRelax.exitRoom`, `EXIT_MARGIN`).
  **Rule 5**: a car in line behind a battle near a braking zone holds its place across the road
  and brakes with `BATTLE_BRAKE` of its braking.
- **Squeeze blame**: a squeeze off the road is the squeezer's fault only if the squeezed car was
  level (`lastTouchLevel`); else "X runs out of room beside Y". `RaceEvent.blame` records it.
- **Tow speed kept** (rule 1 bug, found by the extended check): a car over its plan's top speed
  from a tow braked down to it on pulling out, and `feasibleDelta` thought every lane too fast to
  take, so pull-outs crawled. A lane with no braking in it for the next second (`flatOut`) no
  longer limits speed. Pull-outs also start early enough to clear sideways (`PULL_LATERAL`).
- **Decision log**: `Race.decisions` (`DecisionLog`); `batch` prints each driver's choices and a
  variety score (normalised entropy of plans and covers; F1 drivers 0.8–0.95). Viewer: the
  follow panel's Racecraft row shows the latest decision for 6 s (`RaceAt.decision`,
  `decisionText`).
- **Viewer fix**: a car steering back onto the road was drawn drifting into the corner it left.

Batch, 16 seeds, Phase A → Phase B:

| Scenario | Passes | Contacts | Lap-1 contacts | Incidents | DNFs |
|---|---|---|---|---|---|
| F1 Monza | 127.5 → 115.8 | 18.8 → 9.7 | 7.9 → 5.1 | 20.0 → 10.5 | 0.50 → 0.88 |
| F1 Yas | 66.4 → 63.3 | 13.6 → 7.6 | 10.5 → 5.1 | 10.7 → 7.9 | 0.44 → 0.13 |
| GT3 Laguna | 44.4 → 35.1 | 10.4 → 3.5 | 7.7 → 2.2 | 9.7 → 5.4 | 0.44 → 0.19 |
| MX-5 Laguna | 192.4 → 187.4 | 45.9 → 34.0 | 22.4 → 18.4 | 33.1 → 27.9 | 1.56 → 1.88 |
| Safety car Yas | 34.4 → 24.1 | 8.6 → 6.9 | 6.5 → 5.6 | 8.6 → 5.3 | 0.25 → 0.13 |

Rule checks (`RULE_SEEDS=16`, F1 at Yas and Monza, 32 races), Phase A → B: rule 3 12 → 0; rule 2
15 of 938 → 2 of 818; rule 1 27 of 265 → 15 of 208; exit room 0 → 0; capacity 22 → 1; rule 5 7
of 2694 → 2 of 1907. Check changes, all agreed or explained to the user: rule 3 counts a move on
the road as well as against the line (the line moving under a car isn't a move); rule 1 counts
lifting (from `pedals`), not slowing, and not a car queued in its own lane or braking for its
own lane's corner; Monza added to all of them. Dirty air holds again: held-up races 10 with it,
5 without (16 seeds × 3 gaps), so its assertion is back, counted in races.

Seeds re-picked because the races changed: `tests/effects.test.ts` (6), `tests/view-at.test.ts` (44),
the kerb-spin check in `tests/racecraft-rules.test.ts` (3 and 4).

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
3. The defender gets one move before braking. No moving back, no moving under braking. This
   binds any car with an attacker pulled out beside it, including one that is itself diving on
   the car ahead (phase B). Following the racing line is not a move,
   except toward a car alongside on that side (phase C, from the user's Monza seed 5 rulings): then
   it is, and the car holds its place across the road. First into a gap owns it; a car taking the
   open side is racing fair.
4. The attacker is only entitled to the other side. Braking early can be right, to set up the
   exit or keep the tow.
5. Cars behind a battle expect early, uneven braking and use the whole width of the road.
6. Exit room (phase B, from the user's Monza rulings): a car level at the apex (its centre no
   more than `ROOM_LEVEL` behind) is owed room to the end of the exit. A car further back
   isn't: if it runs out of road, that's its own off (Monza T9: Fontaine ahead the whole way,
   Bianchi not entitled). Squeeze contacts carry `blame` on the event accordingly.
7. Corner capacity (phase B): a slow corner or chicane takes two cars side by side, a faster
   one up to three (`cornerRoom`). Don't start, or keep, a move that would make one too many
   (Monza T4/T5 with four cars contesting it: the attacks never made sense when the outside was
   open). Multi-car corners are where the two-car rules break down; the user judges these by
   who is really wheel to wheel with whom.

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
- **Racecraft** (`src/core/agents/racecraft.ts`): attack (plans `inside` / `outside` / `dummy`),
  dive for the inside (`DIVE_FROM`), defend (covers `inside` / `mirror` / `line`, early or late),
  rival memory, corner capacity, exit room, slipstream (`WAKE_RANGE` or `WAKE_TIME` back) and
  dirty air (`DIRTY_RANGE`). Decisions are logged in `Race.decisions`.
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
  call or `**` in `src/core`. `sqrt`, `floor` and the like are exact and fine; `hypot` is not (Safari and V8 differ), so core uses `fmath.hypot`, a bit-exact port of V8's.
- To check parity: `tools/parity/` runs a scenario the way the viewer does and prints its events,
  setup hashes or per-tick state (instructions at the top of the page). Run it in headless Chrome
  and diff against the same run in Node (`tools/parity/dump.js` has the shared dump functions).
  The 30-lap F1 Yas race matched event for event when this landed.

## Known soft spots

- A 6%-faster car sometimes spins after contact on a late dive instead of passing.
- Rule 1 at Monza (phase B): an attacker sometimes pulls out to a side the defender's line then
  closes (on a curving straight), finds no room and gives the move up, lifting beside the
  defender. Pinned at 15% of cases in `tests/racecraft-rules.test.ts`.
- Overtaking: late lunges are rare and capped, and on a corner exit nobody owns their lane (a car
  alongside gets edged out and lifts). Causes and fixes in `docs/PLAN.md` → "Overtaking bugs".
- Many Phase 4 checks use 4–8 seeds and sit near their thresholds. Use the batch runner
  (`npm run sim -- batch <scenario> --runs N`) or more seeds before reading a change into them.
  The traffic-rule checks run with the standard car, which has no downforce, so they don't
  exercise dirty air by downforce; `tests/dirty-air.test.ts` does.
