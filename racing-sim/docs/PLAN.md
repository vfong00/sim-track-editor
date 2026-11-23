# Racing Sim — Plan

> A 2D racing simulator that runs races on any track you can draw or generate, with drivers of
> different skill, watchable live like a broadcast and scriptable like a FIFA "custom match."
> Successor to `track_monster.py` (the Colab notebook), rebuilt from scratch.

## Vision

- **Any track:** generate a random layout, draw one by clicking, or import a PNG.
- **Real racing on it:** cars of different specs, drivers of different skill, and overtakes,
  trains, mistakes and incidents that come out of simple rules rather than scripted events.
- **Watch it live:** real-time 2D view with a timing tower, camera follow, playback speed
  controls, and an event feed ("P3 Ortiz passes Lee into T1").
- **Dream up scenarios:** "10 equal cars, one rookie with a rocket car, rain from lap 5,
  reverse grid." A scenario is a file you can edit, share and rerun with the same seed.
- **Ask "what if" at scale:** run the same scenario 1,000 times headless and get result
  distributions (win %, average overtakes, how processional a layout is).

**Not goals:** real-world accuracy (no F1-specific aerodynamics, power or tire models), 3D or
elevation, multiplayer, or game physics engines. Plausible and fun beats faithful.

## Design rules (lessons from reviewing the notebook)

1. **One physics model.** The planner and the integrator must use the same limits. (The old bug:
   braking planned with drag, simulated without it, so the car braked ~26% too late.)
2. **Closed tracks are closed.** Periodic splines, evenly resampled, no seam.
3. **Deterministic:** same scenario and seed give the same race. All randomness goes through one
   seeded random number generator per race.
4. **The sim never knows about rendering.** The core produces a state log, and viewers read it.
   Headless runs and live view share the same code.
5. **Every cache key covers every input** (track, cars, drivers, physics, seed, code version).
6. **Behavior from rules, not special cases.** Trains, slipstream battles and defending should
   emerge from the lane, gap and grip rules.
7. **Self-testable.** Every phase ends with automated checks an agent can run, not "looks right."
8. **Always keep the dev server up.** Start `npm run dev` (Vite, localhost) at the start of each
   phase and leave it running throughout, so progress can be tracked visually. Each phase must add
   something visible to the page (track, car, field, event feed). Verify it in the browser
   (screenshot and console check) before calling the phase done, and leave the server running at
   the end.

## Architecture

```
racing-sim/
  src/
    core/        # pure, deterministic, no DOM: math, track, car, driver, race loop
      track/     #   generation, spline, resample, curvature, width, (s,d) frame
      physics/   #   point mass + friction circle, speed-profile solver
      agents/    #   driver controller, overtaking, collisions
      race/      #   race loop, timing, events, state log
      scenario/  #   schema, validation, loading
    view/        # HTML canvas renderer, camera, HUD, timing tower, event feed
    editor/      # track drawing and scenario editing UI
    cli/         # headless runner: run N races, write summary JSON
  tests/
  scenarios/     # example scenario JSON files
```

- **Stack:** TypeScript, Vite, HTML Canvas 2D, and Vitest for tests. The core runs in the browser
  and in Node, so one codebase covers both the live view and batch runs.
- **Coordinates:** each car's position is `(s, d)` (distance along the centerline, sideways
  offset within the track width), converted to `(x, y)` only for drawing.
- **Fixed timestep:** the sim ticks at a fixed `dt` (e.g. 1/60 s). The viewer interpolates between
  ticks and can run at 0.25x–16x or skip ahead.

## Scenario format (draft)

```json
{
  "name": "Rookie with a rocket",
  "seed": 42,
  "track": { "type": "generated", "seed": 7, "width": 14, "complexity": 0.6 },
  "race":  { "laps": 20, "start": "grid", "gridOrder": "reverse-rating" },
  "physics": { "slipstream": 0.08, "dirtyAir": 0.2 },
  "cars": [
    { "id": "rocket", "topSpeed": 95, "accel": 14, "grip": 1.15, "brake": 1.1 },
    { "id": "standard", "topSpeed": 85, "accel": 11, "grip": 1.0, "brake": 1.0 }
  ],
  "drivers": [
    { "name": "Ortiz", "car": "rocket", "pace": 0.94, "consistency": 0.7,
      "aggression": 0.8, "racecraft": 0.4, "bravery": 0.9 },
    { "name": "Lee", "car": "standard", "pace": 0.99, "consistency": 0.95,
      "aggression": 0.5, "racecraft": 0.9, "bravery": 0.5 }
  ],
  "events": [ { "lap": 5, "type": "grip", "value": 0.8, "note": "rain" } ]
}
```

Track `type` can also be `"drawn"` (a list of points) or `"png"` (an image plus a known length for
scale).

## Phases

Each phase is shippable on its own and ends with checks an agent can run. Every phase also
ends with the localhost dev server running and showing that phase's visuals (design rule 8).

### Phase 0: Skeleton
- Vite + TypeScript project, Vitest, a seeded random number generator, a blank canvas page and a
  CLI entry point.
- **Done when:** `npm test` passes, `npm run dev` shows a page, and `npm run sim -- --help` works.

### Phase 1: Tracks
- Random generator: random points → convex hull → perturb → closed periodic spline, with a minimum
  corner radius and no self-intersection.
- Even resampling (~1 m), curvature, constant width, the `(s, d) ↔ (x, y)` mapping.
- Drawn tracks from clicked points. PNG import ported from the notebook (thin to a centerline,
  order the pixels, fit), scaled from a user-given length.
- Canvas view: the track with curvature coloring.
- **Checks:** a circle of radius r gives curvature 1/r everywhere; the generator never produces
  self-intersecting tracks across 1,000 seeds; the spline is continuous at the seam; `(s, d)`
  round-trips through `(x, y)`.

### Phase 2: One car, one lap
- Point-mass car with a friction circle (braking plus turning ≤ grip), top speed and acceleration.
- Racing line heuristic: outside → apex → outside, smoothed, kept within the width.
- Forward–backward speed solver on the racing line gives the lap time.
- Time-stepped car that follows the line using the **same** limits (rule 1).
- Live view: car driving, speed trace, lap timer.
- **Checks:** the solver's lap time and the time-stepped lap time agree within 1%; constant-radius
  circle speed equals `√(grip·g·r)`; braking and acceleration distances match the formulas; the
  racing line is faster than the centerline on every generated track.

### Phase 3: A field of cars
- N cars, grid start, and lap and position timing.
- Same-lane gap rule (can't pass through a car ahead), sideways spacing, collisions (push apart
  and scrub speed; a car-sized 4 m × 2 m footprint since Phase 4, first a circle), staying on track.
- Timing tower, camera follow, playback speed controls.
- **Checks:** no two cars overlap after collision resolution; no car leaves the track; positions
  and timing are consistent; same seed gives an identical state log.

### Phase 4: Racing
- Driver controller: follow the racing line → pull out to an open side when close behind →
  brake later (bravery) → defend the inside once (racecraft) → keep the inside line at the apex.
- Slipstream (drag cut when close behind on straights) and dirty air (grip loss in corners).
- Mistakes (running wide, lock-ups) scaled by consistency and how far over the limit the driver is.
- Event feed (passes, mistakes, contact).
- **Checks:** with identical cars and drivers, overtakes happen but stay rare; with a large pace gap,
  the faster driver gets through within a few laps; dirty air holds a faster car up (removing it
  cuts the time spent stuck behind a slower car by ≥30%) and slipstream helps it by (removing it
  raises that time by ≥30%), measured in 2-car races over 3%, 4.5% and 6% pace gaps; long-straight
  tracks produce more passes than twisty ones.
- **Done** (64e9b28, 7ca4885, 882e366). The original check "zero slipstream and dirty air removes
  trains" was reworded: the two effects pull opposite ways and "within 1 s" can't tell a battle from
  a car stuck behind. Drivers plan braking at 94% of maximum (the margin bravery uses up).
  Soft spot: a 3%-faster car rarely gets past with dirty air on.

### Phase 5: Incidents (crashes and off-track) — Opus
- The road edge stops being a wall: a run-off strip beyond it with low grip and extra drag. A car
  that slides wide, locks up or gets pushed in contact can drop wheels off, lose time and rejoin.
- Spins: sliding well past the limit (or a hard hit at an angle) spins the car; it loses most of
  its speed, may stop on track and becomes a hazard the others must avoid.
- Crashes: a heavy off at speed or a big closing-speed contact ends the race for that car (DNF).
  The car stays where it stopped (off line or in the run-off) for the rest of the race.
- Light damage from contact: a small, lasting loss of grip or top speed.
- Odds come from the physics (how far over the limit, closing speed), scaled by the driver's
  consistency and risk-taking; nothing is rolled from thin air.
- View: run-off drawn beside the road, spun / stopped / retired cars marked, DNF in the tower, and
  feed lines ("Rossi spins at T3", "Kaur off at T5, rejoins P9", "Brandt crashes out at T2").
- **Checks:** a lone, perfectly consistent driver never leaves the road or spins; every off-track
  excursion, spin and crash follows a logged slide, lock-up or contact; incident rates rise with
  risk-taking and fall with consistency; an average 12-car, 10-lap field has a sane DNF count
  (e.g. mean 0–2 over seeds); stopped and retired cars are avoided (no car drives through one);
  same seed still gives an identical log. Phase 3's "no car leaves the track" becomes "no car
  leaves the road without a logged incident."
- **Done.** Run-off 10 m each side (half grip, gravel drag) with a barrier; track limits are
  cosmetic. Every off, spin and crash carries a `cause` chain to a slide, mistake or contact.
  Risk-taking = mean(aggression, bravery). The rates check counts incidents rooted in the
  driver's own slide or mistake (contact-caused ones are noise). Phase 4's wake checks now run
  with `incidents: false` (the road edge is a wall again): with incidents on, brave late braking
  that overshoots costs an off or spin, which cut slipstream's measured benefit to ~15%.

### Phase 6: Scenarios — Opus
- Scenario schema, validation and loading; example scenario files.
- Driver ratings exposed simply: speed, consistency and risk-taking (the internal aggression,
  racecraft and bravery derive from these).
- Scenario editor UI (track, cars, drivers, race rules, incident settings, mid-race events like
  grip changes or a safety car).
- Share by file or URL; replays from seed.
- **Checks:** every example scenario validates and runs to completion; invalid files fail with
  clear errors; replay from seed matches the original log.
- **Done.** Ratings: speed → pace 0.96–1.0 (0.5 = average 0.98; since widened to 0.90–1.0, see the feature map); consistency as is; risk →
  aggression and bravery (so riskTaking = risk); racecraft = mean(speed, consistency). Internal
  ratings stay available as `advanced` overrides. Strict validation (unknown keys are errors with
  "did you mean"; every error names its field), `version` 1. Events fire when the leader starts a
  lap: grip (rebuilds every car's model and plans), spin, retire. Safety car deferred (a new
  behaviour: pace car, no passing, bunching). Grid orders rank by solver lap time of car + driver.
  Share links: deflate + base64url in `#s=`, refused over 16 kB (PNG tracks: share the file).
  Fixed a Phase 5 avoidance bug the rain example exposed: hazards are judged where the car's lane
  will be at the hazard, not where the car is now (a line sweeping across the road ran the field
  into a wreck at the edge). Replay is bit-identical in one JS engine; generated and drawn tracks
  also match between Node and Chrome, PNG tracks can differ in the last float digits.
- **Follow-up (after Phase 6):** safety car (scripted `safety-car` event for N laps, or
  `race.safetyCar: "auto"` when a car stops for good on or beside the road): enters 150 m ahead
  of the leader at 60% of a standard car's pace; no attacking or defending; each car closes to a
  14 m queue gap braking ≤ 3 m/s²; stragglers catch up at 85% pace; pulls in 400 m before the
  line on its last lap; green when the leader crosses. Wrecks are not cleared under it. A beached
  running car (still for 30 s) retires, fixing a Phase 5 hang. Viewer: wheel/+/− zoom, overview
  pan, ↑/↓ step through drivers, Battle cam framing the followed car's group (and the safety car).

### Phase 7: Batch runs and stats — Sonnet is likely enough
- CLI runs a scenario N times and writes a summary: win %, average finishing positions, overtakes
  and incidents per race, and a "processional vs chaotic" score for the track.
- Optional in-browser "simulate 100" button with result charts.
- **Checks:** results are stable across reruns with the same seed set; the most skilled driver
  wins most often in an equal-car scenario.
- **Done** (CLI only). `npm run sim -- batch <scenario> --runs N [--from S] [--json]`: win %,
  podiums, DNFs, average grid and finish per driver (matched by name, since a random grid moves
  them), and per race passes, contacts, incidents, spins, DNFs, stuck time and train share, each
  ± its standard error. Chaos score: mean |finish − grid| as a share of a random order's (0 =
  processional, 1 = the grid means nothing). About 0.3 s a race on the lab field, 1–8 s on the
  real tracks. The skill check measures average finish in a best-four/worst-four field (see the
  feature map). No in-browser button yet.

### Nice to haves (pick and choose)
- Observable tuning: a panel to adjust a driver or car (ratings, grip, power, brakes) and see what
  changes (lap time, speed trace, braking points, where it gains or loses on another car).
- Tyres as management rather than strategy: wear and temperature that cost grip, so pushing hard
  (or sliding, or following in dirty air) has a cost later in the stint. Pit stops not a focus.
- Weather: grip changes over the race (drying line, rain from lap N), building on scenario events.
- Dropped from the earlier "FIFA layer": rating cards, generated rosters, seasons and standings,
  broadcast replays and commentary.

## Open questions (answered)

- Car art: still rectangles; open.
- Track width: constant; varying width is in the feature map.
- Player input: not now. Pure simming first; team radio and a campaign belong with a later
  "playability" revamp.
- Where it runs: local only. Sharing is not a goal (the share link can go).

## Feature map (after the racing line, presets and roster work)

Size: S = an hour or two, M = a session, L = a phase of its own.

**Done since Phase 6**
- Viewer: one-row toolbar with a Race menu, playback in the timeline bar, camera controls over
  the canvas, minimap, timing tower (gap, interval, last, best, sectors; click to switch), driver and car stats
  with field ranks in the follow panel, closable scenario panel.
- Racing line is truly minimum curvature (it used to hug the inside: shortest path). Lanes ease
  off the road edge instead of kinking. Inside attacks dive for the inside edge; slipstream
  reaches 1 s back at speed.
- Car presets with downforce: F1, LMP, GT3, sports car, MX-5 Cup, civilian car (Yas laps
  1:24.9, 1:43.5, 1:57.0, 2:10.4, 2:18.1, 2:45.4).
- Fixed roster, named by overall ability: 20 drivers A–T at first, now 30 on A–Z (Alvarez and Abreu best, M and N the middle, Zhou weakest; A, M, R and W have two each). Abreu is quicker over a lap than Alvarez and scrappier in a race.
- PNG import: no longer mirrored; `reverse` and `start` options; Yas runs anticlockwise from
  its pit straight.
- Real tracks: Yas Marina, Silverstone, Laguna Seca and the Nordschleife (on its own, 20.8 km;
  the GP section was left out because the source image's junction there is ambiguous). The
  examples are a lineup on these (F1, GT3, MX-5 Cup, multi-class, rookie, drying track,
  safety car, Sunday drive), plus a generated "lab" field and the drawn-track demo.
- Marshals clear a car that is out of the race 40 s after it stops (before, a pile-up at one
  corner could block every car for good). A deep tow makes drivers go for the pass.

- Batch runs (Phase 7, above).
- Squeezed at the edge: a car alongside closer than `SQUEEZE` (HIT_W + 0.25 m) pushes a car on
  the road edge over it; the edge no longer holds it like a wall. An off after a squeeze is
  blamed on the squeezer, a spin in the run-off on the off. Straight-track passing fell by
  about a quarter (squeezed attackers lose the move), so that check runs 16 seeds.
- Result panel at the flag (also Race menu → Result, or r): classification, gaps, places
  gained, best laps (fastest in purple), passes and incidents per driver.
- Dirty air by downforce: `physics.dirtyAir` (default 0.2) is the share of downforce lost right
  behind another car, plus `DIRTY_MECH` (0.1) of that on mechanical grip. A wingless car loses
  2% (6% when this went in, lowered with the passing work below); F1 at 200 km/h about 13%. The downforce part
  fades across the wake's width, and the gap rule brakes with the grip the car has in dirty air.
  Over 16 races: F1 spec at Silverstone 14 passes a race (was 18), chaos 0.44 (0.56), DNFs 1.1 (0.8);
  GT3 at Laguna 43 passes (48), DNFs 0.9 (1.8).
- A scripted safety car always deploys (one on track stays out for the scripted laps).
- Passing: attackers tuck into the leader's tow on its line, where the gap rule lets them close
  tighter (no reaction margin, same braking as the leader, `TOW_ROOM` 1.5 m nose to tail), then
  commit to one move: when the run would carry them alongside (`PULL_GAP` + `PULL_TIME` of
  closing speed), or `PULL_LEAD` 2 s before the braking point within `DIVE_GAP` 12 m. Committed,
  they move out at `COMMIT_LATERAL` 5 m/s, only their current position counts for the gap rule,
  and they may take a line within `COMMIT_SLACK` (1.5%) of its braking envelope. Before, an
  attack started up to 17 m back, drifted off line (losing the tow), and once braking could not
  leave the leader's line, so it braked with the leader. A wingless car now loses 2% in dirty
  air (was 6%, which kept a faster road car too far back to use the tow).
  Over 8 seeds a 3/4.5/6%-faster car is stuck 50/3/0 s a race (was 311/137/47); the dirty-air
  wake check holds again (0.27× without it). Over 16 races: MX-5 Cup 97 passes (was 68), GT3
  42 (43), F1 10 (14) with DNFs 0.5 (1.1). Tried and dropped: starting attacks from 0.6 s back
  (lap-1 pile-ups doubled GT3 DNFs), tow relaxation only on straights (passing fell back).
- Speed rating widened: speed 0–1 → pace 0.90–1.0 (was 0.96–1.0; the average driver is now
  0.95). The whole roster spanned ~0.4 s a lap (0.7%), less than it takes to pass, so ability
  never showed; now ~1.1 s (1.9%). With equal cars from a random grid, the four best drivers
  average P3.9 and the four weakest P5.1 (was 4.45 vs 4.55). The skill check uses that field
  (`strong-weak.json`) and average finish, not wins (the top two have the same pace).
- F1 constructors at Yas Marina (`f1-constructors-yas.json`): ten invented teams of two, cars
  1.5 s a lap apart first to last with different trade-offs (downforce vs top speed), drivers
  mostly but not strictly better at better teams, rating grid, ten laps, incidentRate 0.5 (at 1,
  a 20-car F1 field averaged ~4 DNFs, nearly all lap-1 contact at T1/T4/T5). The old F1 example
  is now "F1 spec at Silverstone". Schema grip limit raised to 3 (the F1 preset itself is 2.1).
- Lap-1 pile-ups in big winged fields: 20 F1 cars at Yas average ~4 DNFs a race at the default
  incident rate (was ~9 before the passing work), mostly contact into T1. S–M
- Slower-class traffic (done): a car `CLASS_GAP` (4%) or more quicker over a clean-air lap
  starts a move from up to `CLASS_FROM` (30 m) back, even near a corner, pulls straight out
  instead of waiting in the tow, and may switch sides once if the slower car's line closes its
  side. The slower car drops its own battle and keeps to the other side of the road (a blue
  flag). New stat `trafficTime` (car-s within 1 s behind a much slower car, any lap; shown by
  `batch`). On a mixed-grid Nordschleife (LMPs and MX-5s) the worst 10% of LMP laps lost 21 s
  instead of 30 s and DNFs halved; most of what is left is the lap-1 pack on a narrow road.
  Still to do: lapped cars of the same class (blue flags, below).
- Qualifying at the limit, races under it. `pace` (speed rating, 0.90–1.0 of the car's grip) is
  now the limit. Races plan at `racePace`: 2.5% grip under it plus 12% per point of
  inconsistency, about 1% (steady) to 2% (erratic) off the limit lap on the traced circuits
  (lap time moves ~0.3–0.4% per 1% grip). `Race.paceOf` is the one place that picks the pace.
  Batch, 16 seeds: racing passes after lap 1 rose (GT3 Laguna 4.8 → 6.7, MX-5 12.3 → 14.8,
  F1 Yas 9.5 → 11.7); spins and lap-1 contact fell (F1 Yas DNFs 3.2 → 1.2, spec F1 Silverstone
  incidents 4.4 → 2.2), so fewer passes come from cars in trouble. Incident odds were left as
  they are: racing under the limit is meant to be safer, and qualifying carries the risk. (A
  higher base mistake rate barely moved them; at incidentRate 1 the F1 Yas example is back to
  ~3 DNFs, so it keeps 0.5.) The car presets still match real lap times, as push laps.
- Qualifying session (`gridOrder: "qualifying"`, the examples' default): each car alone, a
  flying start 350 m back, two timed laps, best counts (`qualifyingRun`, `session:
  'qualifying'`). Full pace, bravery's late braking into every corner, and each corner driven a
  little over or under the limit (`PUSH_SPREAD` 0.8% plus `PUSH_PER_INCONSISTENCY` 7% per point
  of inconsistency): overdriving slides, and the usual mistake and spin odds follow. Spec F1 at
  Silverstone, 20 seeds: Alvarez on pole 12 times, Chen 8. About 5% of runs have a moment (32%
  on the Nordschleife). A 20-car Nordschleife grid takes ~1.5 s to build. No time (out on the
  first lap) = back of the grid. Entrants keep `gridTime` and `quali` (seed, laps, note).
- Viewer: Race ▾ → Qualifying (`q`) lists every run (both laps, best, gap, what happened); Watch
  re-runs that car's session from its seed (identical lap times) as its own session, and "Back
  to race" returns to the race where it was left. The HUD shows the ideal race lap and the ideal
  push lap; the stats add a Race pace row.
- Still open: drivers stepping up to the limit when attacking or defending (deferred on
  purpose), and a formation of cars on track together in qualifying (traffic, tows).
- Race pace scatter: each corner's target speed is race pace times a factor drawn around 1
  (`raceSpread`: 0.3% plus 3.5% per point of inconsistency) plus a per-lap rhythm (0.8 of that
  spread), so laps differ. Consistency sets the spread; the race margin is now headroom for it,
  1% of grip plus (2 − bravery) spreads, so a brave driver runs closer to the limit and slides
  more (bravery 0 → 1 is ~0.35 s a lap at Laguna). Off under the safety car. A lone car's lap
  SD: GT3 Laguna 0.09 / 0.25 / 0.35 s at consistency 0.96 / 0.85 / 0.70, F1 Yas 0.06 / 0.12 /
  0.28 s. Trains break up a little (5–9% less time in one).
- F1 constructors respecced so each team has one clear strength and one weakness, measured by
  section of the Yas lap (straights 51%, braking 17%, slow corners 22%, fast corners 13%):
  Aurora downforce, Brightwater power, Kestrel mechanical grip, Corsair brakes, Helix and
  Saltire top speed, Lumen no strength or weakness, Meridian best overall without topping any
  one section. 1.6 s first to last; the description lists each team's gains and losses. Abreu
  partners Alvarez at Meridian: 20 seeds, Alvarez 60% of wins, Abreu 40% (pole every time).
- Fields can draw from the whole roster: `field.pick: "mix"` takes one driver from each of
  `count` equal bands of ability (with the field seed, default the race seed), so a 12-car
  field runs A to Z and a new seed brings a new line-up. Six examples use it; the lab and the
  30-car MX-5 race don't need it.
- Event feed: rewinding keeps what was already watched (greyed while it's ahead of the replay),
  showing the next 10 events ahead and the latest behind. Spoilers (⚙, `s`) show the whole
  race in the feed and on the timeline.
- Wrecks: a hazard stop is planned with the braking the car really has all the way down
  (`hazardSpeed`: braking is A + B·v², so a winged car brakes far harder at speed; planning at
  today's braking left a GT3 13 m short from 50 m/s), keeping 10% for steering round
  (`HAZARD_RESERVE`). No car hits a wreck already at rest in 192 example races (12 examples ×
  16 seeds; 4 in 96 before); DNFs in those races roughly halved.

**Next, in order**
1. One of the bigger sessions: driving styles with corner lines and lap 1 (with car size
   per preset), marshalling with penalties, or real-map tracks.

**Done: batch baseline.** `batch --save` writes each race's numbers to `baselines/<name>.json`
(the commit and a hash of the scenario file go with them); later batches print the change,
paired by seed when the seeds match (* = more than twice its standard error), and say when the
races are identical. New metric: lap-1 contacts (contacts while the leader is on lap 1).
Baselines saved for five examples at 16 seeds. They show lap 1 is most of the contact: F1
constructors at Yas 15.1 of 17.3 contacts a race, GT3 Laguna 5.3 of 6.4, MX-5 Laguna 11.4 of
18.4, multi-class Nordschleife 7.4 of 10.7. Re-save a baseline when a change is meant to move it.

**Racing and sim (small)**
- Kerbs: let the racing line use a little kerb at the apex and exit (a per-track kerb width
  past the road edge, with a small grip cost), as real lines do. S–M. Drawn already: red and
  white kerbs where the racing line comes within 2.5 m of the edge in a corner tighter than
  250 m radius (`kerbsFor` in `view/draw.ts`): outside at turn-in, inside at the apex, outside
  at the exit. The physics could use the same mask. The old curvature-coloured edges are a
  debug view (k, or Race ▾ → Curvature colours).

**Race starts: lights out, standing and rolling** M
- Today every race is a standing start (`race.start: 'grid'`, the only value the schema takes):
  a staggered two-wide grid, 7 m a slot, everyone released at t = 0 ("Lights out") after a
  random 0.15–0.5 s delay that has nothing to do with the driver.
- Lights out: five red lights on a gantry overlay, one a second, then a random 0.2–3 s hold
  before they go out (the sequence on the clock and in the feed). Reaction time from the
  driver (0.15–0.35 s, quicker for a steadier, more experienced one), then the launch: wheelspin
  and bog-down drawn by consistency, limited by the physics (grip and power off the line). A
  car moving before the lights go out is a jump start: logged now, a penalty once penalties
  exist (Marshalling below). This is the "launch variation" in the lap-1 plan under Driving
  styles: build it here, measure there.
- Rolling start (`race.start: 'rolling'`): the field forms up two-wide behind the safety car
  for a formation lap and stays in order. It pulls in, and the leader sets the pace to a
  marked start (or the line), where racing starts. Reuses the safety car's queue (`queueSpeed`,
  `SAFETY_CAR`) and its "no passing until the line" rule. Options: the start speed per class
  (slower classes start behind, as at the Nordschleife), and a jumped start (passing before the
  line) handled like a jump start above.
- Standing restarts after a safety car (optional, F1 style): the field lines up on the grid in
  race order and does lights out again, instead of today's rolling restart.
- Scenario: `race.start` takes `'standing'` (the default; `'grid'` stays as its old name) or
  `'rolling'`; the examples pick what fits (F1 and spec F1 standing, the multiclass and
  Nordschleife races rolling, the safety-car race either).
- Measure with `batch`: lap-1 contacts, DNFs and lap-1 position changes for the same scenario
  standing vs rolling (a rolling start should be calmer and shuffle the order less), and how
  much the reaction and launch spread moves the order before T1.

**Real-map tracks (its own session)** M
- Build tracks from OpenStreetMap geometry instead of traced images: road ways converted to
  metres and fed in as a drawn track (true length and corner radii, no tracing blur). OSM maps
  most circuits as `highway=raceway`.
- A loop of real roads in Verona: the user names the roads (or corner intersections) in order,
  plus which Verona and the road width (real, about 7–10 m, or race-track width). Querying OSM
  sends that area and those names to its public service, so do it only with that input.
- Remap the traced tracks the same way: the PNG traces soften or tighten corners and needed
  hand-tuned smoothing. Yas: the "kink" at the top is not a tracing artefact. The source image
  draws the chicane before the long back straight as a hard Z step about a road width deep,
  so the trace has two tight bends (12 and 17 m radius, 60 and 81 km/h in F1), the slowest
  point of the lap. Smoothing 14 only gets them to 31 and 36 m and softens everything else.
  Tried a second map (a venue map with grandstands, the line extracted by colour): worse. Its
  chicane is one sharp corner (39 km/h in F1) and its hairpin a narrow loop that more
  smoothing pinches (29 km/h at smoothing 20); F1 laps 1:35 (smoothing 6) to 1:25 (20) vs
  1:25.5 now. Kept the current image; OSM geometry is the real fix. Silverstone: Brooklands and Luffield
  ~75 km/h in F1 vs ~110 real. Laguna Seca (from a 300 px silhouette): the Corkscrew is too
  gentle. Nordschleife (800 px for 20.8 km): laps 5–10% quick, no GP section (the 24h layout
  needs it), no elevation. Monza (added 2026-11-23, a 600 px outline upscaled 2×, smoothing 3:
  4 and up flattens Ascari, 2 adds false corners): F1 1:16.4 at the limit vs ~1:19 real. Ascari
  is right (~205/255/210 km/h); the Rettifilo (64 vs ~80), Roggia (111 vs ~140) and Lesmo 2
  (140 vs ~175) are tight. Curva Grande counts as two corners, so the sim's numbers run one
  ahead of the real ones from the Roggia on.

**Overtaking bugs (from watching F1 at Yas over 30 laps, 2026-11-23)** S–M each
Some of this can wait for driving styles. Some of it is logic we can fix now.
- **Late lunges are rare, and the brave ones are capped.** The good version, at the T9 hairpin (the sim's
  T7) in F1 Yas, seed 1, 30 laps: Kowalski for P11 at 5:29.6, and Dlamini for P3 at 13:51.1 (the
  dramatic one). It happens about six times in that race. (An outside pass there turns up early
  in the same race too.) The defender sits a little off the inside and
  squeezes. The attacker takes the inside anyway, locks up a little and trail-brakes past. We
  want more of these. (More attempts round the outside here would be realistic too: see three
  lines per corner.) Why they're rare, from the code:
  - Bravery is a small knob. A committed attacker within 12 m brakes up to `0.04 · bravery`
    later (`brave` in `racecraft.ts`): 2% for an average driver, 4% at most. Bravery is also
    set to the same value as aggression (`risk`). So "bravery" can't make a lunge on its own,
    and styles alone won't fix that.
  - Moves are only started with more than 60 m to the corner (`toCorner > 60`), and pull out
    at `DIVE_GAP` (12 m) once braking is `PULL_LEAD` s away. Nobody starts a lunge from 15–25 m
    back once the braking zone has begun.
  - `feasibleDelta` with `COMMIT_SLACK` (0.985) stops a committed attacker taking a lane it
    can't make within 1.5% of its speed. A hairpin's inside line is much slower than that, so
    the dive has to start before the braking. A real lunge arrives too fast and accepts it.
  - A defence sits 1 m from the inside edge (`lim - 1`). `room()` needs `SIDE_GAP` (2.6 m), so
    a defended inside closes the dive. Passes like these only work because the dive started
    before the defender got across.
  - A lock-up is only a random mistake, rolled at `(1 − consistency) · (0.004 + 4 · excess)`
    per second. Braking too late doesn't lock the wheels directly. It only slides a little,
    because bravery keeps the car near the limit.
  - Fix now: a "lunge" for a committed attacker in the braking zone. It starts from up to ~25 m
    back when the inside is open. Allow a looser slack scaled by bravery (and by what's at stake:
    a faster car, laps left). Lock-up odds rise with how far over the braking limit the car is,
    so a lunge can lock up, run wide or make it. Widen bravery's range once it's separate from
    aggression (driving styles). Measure with `batch`: passes, lock-ups, lap-1 contacts and DNFs
    on F1 Yas and GT3 Laguna.
  - From watching: inside and outside moves at the hairpin should be about equally likely (the
    outside needs the three lines per corner). Lock-ups from braking too late are needed either
    way, and go with driving styles. Today a lunge costs nothing if it doesn't come off. Tyre
    management or brake temperatures (Later) should make it rarer, since a lock-up or a hot
    brake would then cost something for the rest of the stint.
- **Side by side out of a corner, nobody owns their lane.** At the T6/T7 chicane onto the back
  straight, the attacker holds the inside and tries to beat the defender to the straight. Bad
  example (F1 Yas, seed 1, 30 laps): Chen and Dlamini around 6:25–6:30 (Dlamini brakes at
  −40 m/s² at 6:31.4 with Chen 1.2 m ahead and 2.1 m across). The car holding its line gets
  edged and lifts to tuck in behind. Either the other car leaves a car's width (a drag race to
  the hairpin), or it's blamed for the squeeze (a penalty once stewards exist). Suspects, from
  the code:
  - An attack is aimed at one corner (`cr.corner`). It ends at that corner's apex if the leader
    is ahead (`beatenAtApex`), or once the next corner is up and the two aren't alongside. In a
    chicane, a move decided for T6 is over by T7. Then the attacker is in `line` mode with no
    idea it is still racing for position.
  - The only side-by-side rule in `line` mode ("whoever is on the inside keeps the inside line")
    applies on the way into a corner (`toCorner < 150`) and only to the car on the inside. On
    the exit and down a straight, both cars head for the racing line, and only the symmetric
    side spacing keeps them apart.
  - **Confirmed (seed 1, 30 laps, after the determinism fix): the gap rule mistakes a car
    alongside for a car ahead.** 5:04, Chen and Alvarez exit T6 nose to nose, Chen on the line
    and Alvarez outside. Chen's sideways speed carries him to 2.1 m from Alvarez, inside
    `SIDE_GAP` (2.6 m): the spacing clamps where a car aims (`lo`/`hi`), not the sideways speed it
    already has. Alvarez is pushed past the edge (d 6.2–6.8, edge 6.1). Alvarez is then 0.7 m
    ahead and 2.1 m across, within the gap rule's 2.2 m "same lane" width (`HIT_W + 0.2`) with
    negative room, so Chen is allowed `o.v − 2 + room` and brakes at −40 m/s² (−15 km/h in
    0.1 s). The car that was level loses. The same −35 to −40 m/s² lift out of T6 (s ≈ 2690,
    ~150 km/h, everyone accelerating) happens about a dozen times in that race. (The sim names
    corners as it finds them: its T5/T6 is the T6/T7 chicane, its T7 the long T9 hairpin.)
  - A squeeze is only logged when the squeezed car's road runs out (`squeezedBy`, then an off).
    A squeeze that makes the other car lift, but stay on the road, leaves no trace.
  - **Done (2026-11-23):** the gap rule ignores a car that overlaps lengthwise (`o.gap < HIT_LEN`)
    and isn't touching sideways (`|o.d − me.d| ≥ HIT_W`). The side spacing also aims `SIDE_LOOK`
    (0.4 s) ahead, with cars driving the road assumed to hold their offset from the line, so a car
    doesn't lean into the one beside it as the line sweeps across. Over 8 F1 Yas races T6-exit
    lifts went 58 → 0. Against the baselines (16 races): contacts −34% (F1 Yas, MX-5) and −57%
    (Nordschleife), passes and DNFs unchanged within the noise. T6 exits are drag races now.
  - **What it cost: most hairpin lunges were this bug.** Over 12 races of 20 laps, hairpin passes
    went 55 → 31. In the old code, 45 of those 55 (and 311 of all 537 clean passes) had the passed
    car braking for a car alongside in the 2 s before, including Kowalski at 5:29.6 and Dlamini
    at 13:51. The defender gave way because of the gap rule, not a rule about the corner. The room
    rule below is meant to bring them back for the right reason.
  - **Done (2026-11-23): the room rule into a corner.** Before the apex (from `ROOM_FROM`, 150 m),
    a car alongside on my inside whose centre is no more than `ROOM_LEVEL` (1 m) behind mine
    (front wheels about level with my mirrors) has earned the corner: I tuck in behind it
    (`owedRoom` in `racecraft.ts`, `yieldTo` in the gap rule). Hairpin passes over 12 races:
    55 (bug) → 31 (gap fix) → 46. Clean passes 537 → 561. T6-exit lifts stay gone. Against the
    baselines: F1 Yas passes unchanged, contacts −29% (F1 Yas), −27% (MX-5), −59% (Nordschleife).
    Also: `avoidSlowCar` tries the sides of other wrecks beside the nearest one when both of its
    sides are shut (a field was stuck behind two wrecks side by side at MX-5 Laguna T13).
  - Then: a car alongside at the exit of a corner (front wheels level with the other car's
    rear wheels or better) is owed a car's width to the next braking zone. That's the room rule
    from three lines per corner, brought forward for exits and straights. Keep an attack alive
    through a linked sequence of corners (a chicane) while the two are alongside. Log a "forced
    to lift" squeeze for blame as well as an off. Check: on F1 Yas, count side-by-side exits at
    the T7 chicane that end in a lift with no contact, before and after.

**Driving styles, corner lines and lap 1 (its own session)** L
- Replace the risk and racecraft ratings with styles that bring several behaviours together:
  smooth vs aggressive at the wheel (trail-braking and oversteer moments vs tidy lines),
  divebomber vs defender, fair vs dirty in wheel-to-wheel. Today "risk" sets attacking and
  late braking together, and "racecraft" (defending) is just the mean of speed and
  consistency.
- Mistake mix to revisit with it: per 12-car, 10-lap race (standard car) there are ~24 logged
  slides (over the limit and caught), ~4 run-wides, ~1 lock-up and ~1.5 spins, half of them
  after contact. Lock-ups are rarer than run-wides, which feels backwards.
- Three lines per corner, done in the same session (styles pick lines, and racecraft needs the
  third choice). Today an attacker either dives for the inside edge or sits a car's width off
  the leader (`racecraft.ts`, the committed move); that outside spot follows the leader, so as
  the leader sweeps to the apex the outside car is squeezed and lifts, and nobody tries it. We
  see hard and soft dive-bombs but no switchbacks.
  - Racing, inside (early apex, slow exit) and outside (wide entry, late apex, better exit) as
    lane-offset profiles worked out once per corner, not relative to the other car.
  - The side comes from the corners after this one: the outside of T1 is the inside of T2, so an
    outside move works into a change of direction. The cutback: when the defender dives, go
    wide and cross under on the exit.
  - Room rules: a car with its front wheels level by the apex is owed a car's width; the inside
    car may not run out to the edge on the exit if a car is there; the middle car of three
    holds its line. Breaking them is blame (the squeeze rule already blames), and later a
    penalty.
  - Styles: some drivers prefer the outside or the cutback, others the dive.
- Lap 1 logic, in the same session (the worst case for pile-ups: ~4 DNFs with 20 F1 cars at
  Yas, mostly into T1). Cars keep their grid side down to the first corner instead of funnelling
  onto the line, so the field arrives two or three wide and uses the room rules. Launch
  variation (reaction time, wheelspin by consistency) shuffles the grid before T1 instead of
  in it. Measure with `batch` on the F1 Yas and GT3 Laguna examples: DNFs and lap-1 contacts.
- Car size per preset, before or with this: every car is 1.8 × 4.0 m (`CAR_WIDTH`,
  `CAR_LENGTH`). Real: F1 ~2.0 × 5.6 m, LMP and GT3 ~2.0 × 4.7 m, MX-5 ~1.73 × 3.9 m. Changes
  collisions, the tow range, the gap rule, whether three wide fits (three 2 m cars fit a 14 m
  road easily) and how thin the cars look. The constants become per-car fields; re-tune with
  `batch`. M

**Marshalling, flags and penalties** M
- Done: marshals clear a car out of the race 40 s after it stops. Still to do: sooner off the
  road than on it, and flags while they work.
- Local yellow flags at an incident: no passing and a little slower through that stretch,
  double yellow for a car on the road. Blue flags: a lapped car lets the leaders by.
- Escalation: yellow → virtual safety car (a speed limit, no queue) → safety car → red flag
  (stop, restart from the grid order).
- Penalties, in the same session (flags without stewards feel half done, and some spins are
  egregious). Blame is already assigned (contact, the squeeze rule), so stewards have something
  to judge. Offences: causing a collision, squeezing a car off the road, track limits (time
  gained off the road), an unsafe rejoin, later ignoring blue flags. Penalties: 5 s or 10 s added
  at the finish first (a drive-through needs a pit lane). M
- Stewards' room in the result panel: each incident with who was blamed and the penalty; click
  one to jump the replay to 5 s before it, following the blamed car. S–M
- Look at the late-dive spin first (Known soft spots in the handoff): a 6%-faster car spinning
  after contact instead of passing is a racecraft bug, not something to penalise.

**Long races (shelved: 60 min covers most uses)** M
- Today the viewer and `Race.run` stop at 3600 s (`MAX_RACE_TIME` in `view/main.ts`), and the
  schema allows 200 laps (~6 h at Silverstone). Nothing is saved to disk: the state log lives
  in memory and a replay re-runs the seed.
- Memory is the limit, not CPU (the sim runs ~200–400× real time, so 24 h of a 20-car field
  is ~4–8 min of compute). Each tick stores a frame, the order and race-craft modes: ~800 B at
  60 Hz for 20 cars, ~170 MB per race hour, ~4 GB for 24 h.
- 1. Compact, decimated log: physics still steps every tick (so the race, its events and
  incidents are unchanged), but poses are recorded at 10 Hz in packed chunks (s as float32,
  offset and yaw as int16, speed and status as small ints): ~6–15 MB per hour. The viewer
  already interpolates; along-track coordinates follow the curve. Keep every tick while any
  car is spinning, off or in contact, so incidents don't look choppy.
- 2. Compute in a Web Worker: the viewer gets 6 ms a frame to compute ahead, so a 24 h race
  would take a long time to scrub to the end.
- 3. Only if 1 isn't enough: keep an hour's window and re-simulate from checkpoints. Needs a
  serialisable race state (the RNGs keep their state in closures today).
- Also: lift the 3600 s caps and the 200-lap schema limit. Long races mean little without pit
  stops, fuel, tyres and driver swaps (below).

**Later (a "racing revamp" with playability)**
- Tyre wear and temperature, weather that builds, pit stops, team radio, picking your driver.

**Watching**
- Done: sector times. The track takes `sectors: [m1, m2]` (metres from the start line; default
  thirds); every class crosses the same lines, and only the colours compare within a class
  (`classOf`: the car's preset, else its id). Split times come from the checkpoints and line
  crossings (`sectorTimes` in `core/race/sectors.ts`), so the race is unchanged and the
  sectors add up to the lap exactly. Tower mode Sectors: chips for the current lap (purple =
  fastest in class, green = own best, yellow = slower, grey = not run) and the latest split.
  Follow panel: this lap's sectors and the delta to the car's best lap (`deltaToBest`). The
  qualifying and result panels show each driver's best sectors and the ideal lap they add up
  to. Sector lines on the map and minimap. Default lines on the four real tracks are still
  thirds; set real ones once corners have names.
- Done: throttle and brake on the speed trace (Inputs, `i`). Worked out from the logged speed
  and the car model (`pedals` in `view/trace.ts`), clean air assumed.
- Car art and effects (bumped up: after sectors). M
  - Done: shape by class, top down (`view/livery.ts`, `drawBody` in `view/draw.ts`):
    open-wheel (exposed wheels, wings, helmet), prototype (canopy, rear wing), GT (glass, wing),
    road car. From the preset, else from downforce. Liveries seeded from the team (car id and
    colour, so teammates match): stripe, halves, chevron, tail or side stripes in an accent
    with enough contrast, and a race number from the driver's name (unique in the field,
    whatever the grid). Below 14 px a car is still a plain block; the number shows from 34 px.
    Still drawn in the shared 1.8 × 4.0 m footprint (scales with car size per preset).
  - Done: effects (`view/effects.ts`), all read from the logs: brake lights from the logged
    deceleration; tyre smoke from lock-ups, run-wides, slides, spins and crashes, and dust off
    the road at speed (puffs on a fixed 0.05 s grid, seeded by car and time, so scrubbing
    shows the same smoke); sparks for 0.4 s at a contact; skid marks that stay for the race
    where a car locked up, ran wide, spun or crashed. About 0.1 ms a frame for 20 cars.
  - Done: drift angle. A running car over its grip limit is drawn nose into the turn, up to
    20° where a spin becomes likely (`RaceCar.drift`, logged in the yaw slot, display only:
    the baselines are identical race by race).
- Track scenery and looks (after car art; display only, nothing in the race reads it). M
  - Settings per track: an optional `look` on the scenario's track (a theme plus overrides),
    defaulting by track (the generated ones pick from the seed). Themes:
    - desert: sand run-off instead of grass, pale tarmac, heat haze far off, palms;
    - city / street: concrete walls instead of run-off, kerbs flush, buildings and grandstands
      along the outside, painted road markings;
    - forest: dark grass and trees right up to the barrier (the Nordschleife), shade on the road;
    - classic circuit: grass, gravel traps at the outside of fast corners, grandstands at the
      big braking zones.
  - Kerb colours by theme or by circuit (red and white, blue and white, green and white, yellow
    and black), and sausage kerbs at chicanes. The kerb mask (`kerbsFor`) already says where.
  - Run-off drawn by type: grass, gravel (where the physics' run-off is), tarmac with painted
    stripes, and the barrier as tyre wall, armco or concrete.
  - Pit lane, garages and the start-finish gantry (with the lights-out sequence, under Race
    starts), drawn even before there are pit stops.
  - Time of day and weather: dusk and night with headlights and floodlights (Yas), and rain
    shown when the scenario's grip drops (spray behind the cars, a darker, shinier road, the
    dry line appearing as it dries).
  - Scenery from the image or OSM where it exists (real-map tracks): grandstands and buildings
    where they really are. Until then, placed by rules (grandstands at the start and at the
    slowest corners, trees elsewhere) and seeded, so a track always looks the same.
  - Cost: draw static scenery once to an offscreen layer per zoom band, so it stays well under
    a millisecond a frame at 20 cars.
- Auto-director camera: follow the closest live battle (cars within ~1 s for a while), cut to
  an incident as it happens and back. A camera mode next to Follow. M
- Corner names: an optional `corners` list on the track (name, metres along), shown on the map
  and used in event text ("contact at Copse") and the stewards' room. S. Do it with the
  real-map remap: corner positions move then, and only a few names matter per track. Real
  sector lines (instead of thirds) follow from the names.
- Phone and tablet layout. M
- Lap and gap charts: not needed; the timing tower covers it.

**Dropped**: sharing and hosting, rating cards, seasons, broadcast replays, commentary.
