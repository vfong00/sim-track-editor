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
- **Done.** Ratings: speed → pace 0.96–1.0 (0.5 = average 0.98); consistency as is; risk →
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
  real tracks. The skill check is marked `it.fails`: with equal cars the result follows the grid
  (see "Passing balance" below). No in-browser button yet.

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
  the canvas, minimap, rotating timing tower (gap, interval, last, best), driver and car stats
  with field ranks in the follow panel, closable scenario panel.
- Racing line is truly minimum curvature (it used to hug the inside: shortest path). Lanes ease
  off the road edge instead of kinking. Inside attacks dive for the inside edge; slipstream
  reaches 1 s back at speed.
- Car presets with downforce: F1, LMP, GT3, sports car, MX-5 Cup, civilian car (Yas laps
  1:24.9, 1:43.5, 1:57.0, 2:10.4, 2:18.1, 2:45.4).
- Fixed roster of 20 drivers, named A–T by overall ability (Alvarez best, Tanaka weakest).
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
  Over 16 races: F1 at Silverstone 14 passes a race (was 18), chaos 0.44 (0.56), DNFs 1.1 (0.8);
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

**Next (racing and sim)**
- Skill check (`batch.test.ts`, `it.fails`): the first eight roster drivers are within ~0.3 s
  a lap of each other in real race pace, less than it takes to pass, so the best one only wins
  from near the front, even over 15 laps. Needs a field where ability makes a real pace
  difference, or a different measure (e.g. places gained against ability). S
- The speed rating spans little real pace: the whole roster is ~0.7 s a lap apart, and the
  Ideal lap figure overstates gaps (a "3%" pace gap is 0.94 s there, 0.5 s on track). S–M
- Yas trace: a sharp kink at the top of the image (about 40 km/h) may be a tracing artefact. S

**Real-map tracks (its own session)** M
- Build tracks from OpenStreetMap geometry instead of traced images: road ways converted to
  metres and fed in as a drawn track (true length and corner radii, no tracing blur). OSM maps
  most circuits as `highway=raceway`.
- A loop of real roads in Verona: the user names the roads (or corner intersections) in order,
  plus which Verona and the road width (real, about 7–10 m, or race-track width). Querying OSM
  sends that area and those names to its public service, so do it only with that input.
- Remap the traced tracks the same way: the PNG traces soften or tighten corners and needed
  hand-tuned smoothing. Yas: a sharp kink at the top. Silverstone: Brooklands and Luffield
  ~75 km/h in F1 vs ~110 real. Laguna Seca (from a 300 px silhouette): the Corkscrew is too
  gentle. Nordschleife (800 px for 20.8 km): laps 5–10% quick, no GP section (the 24h layout
  needs it), no elevation.

**Driving styles (its own session)** L
- Replace the risk and racecraft ratings with styles that bring several behaviours together:
  smooth vs aggressive at the wheel (trail-braking and oversteer moments vs tidy lines),
  divebomber vs defender, fair vs dirty in wheel-to-wheel. Today "risk" sets attacking and
  late braking together, and "racecraft" (defending) is just the mean of speed and
  consistency.
- Mistake mix to revisit with it: per 12-car, 10-lap race (standard car) there are ~24 logged
  slides (over the limit and caught), ~4 run-wides, ~1 lock-up and ~1.5 spins, half of them
  after contact. Lock-ups are rarer than run-wides, which feels backwards.

**Marshalling and flags** M
- Done: marshals clear a car out of the race 40 s after it stops. Still to do: sooner off the
  road than on it, and flags while they work.
- Local yellow flags at an incident: no passing and a little slower through that stretch,
  double yellow for a car on the road. Blue flags: a lapped car lets the leaders by.
- Escalation: yellow → virtual safety car (a speed limit, no queue) → safety car → red flag
  (stop, restart from the grid order).

**Later (a "racing revamp" with playability)**
- Tyre wear and temperature, weather that builds, pit stops, team radio, picking your driver.

**Watching**
- Car art or liveries. S–M
- Phone and tablet layout. M
- Lap and gap charts: not needed; the timing tower covers it.

**Dropped**: sharing and hosting, rating cards, seasons, broadcast replays, commentary.
