# sim-track-editor

A racing simulator: deterministic car physics, AI drivers who race each other by a set of
agreed racecraft rules, and a browser viewer to watch, replay and judge the races.

The project lives in `racing-sim/` (TypeScript, Vite). The Python script and `tracks/` at the
root are the original prototype.

## What it does

- **Physics:** one car model for the planner and the integrator (grip, downforce, braking,
  slides, spins, kerbs). Car presets from F1 to a road car.
- **Tracks:** drawn, generated, or traced from images (Yas Marina, Silverstone, Monza, Laguna
  Seca, the Nordschleife), each with a minimum-curvature racing line.
- **Drivers:** a fixed roster rated on speed, consistency and risk. Qualifying runs at the
  limit, races a little under it.
- **Racecraft:** attacking and defending as a mixed strategy (inside, outside, dummy; cover,
  mirror, protect the exit), slipstream and dirty air, corner capacity, exit room, and blame for
  contact. Incidents, retirements, marshals and a safety car.
- **Viewer:** timing tower, minimap, event feed, follow and battle cameras, replay, qualifying
  runs, results, and a scenario editor. The build version shows at the top right (hide it in ⚙).
- **Batch runs:** many seeds headless, with stats and saved baselines to compare changes.

Races are deterministic: the same scenario and seed give the same race in Node and the browser.

## Run it

```bash
npm --prefix racing-sim ci
npm --prefix racing-sim run dev
```

Then open http://localhost:5173 and pick a scenario from ⚙ → Scenario → Examples.

If the default npm registry is unreachable, install from `racing-sim/` with:

```bash
npm ci --registry=https://registry.npmjs.org/ --replace-registry-host=always --no-audit
```

## Commands

From `racing-sim/`:

```bash
npm test                 # Vitest checks (skip slow ones: --testNamePattern='^(?!.*\[slow\])')
npm run typecheck        # tsc --noEmit
npm run build            # typecheck and production build
npm run sim -- --help    # headless CLI: track, lap, race, scenario, batch
npm run sim -- batch scenarios/f1-constructors-yas.json --runs 16   # multi-seed stats
```

## Docs

- `racing-sim/docs/PLAN.md`: design rules, architecture and the roadmap (the racing sprint).
- `racing-sim/docs/HANDOFF.md`: where things stand, the racecraft rules, and the next phase.
