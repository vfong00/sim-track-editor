# sim-track-editor

i try to make a physics simulation of a car on a track with the help of gemini

## Racing sim

The current project lives in `racing-sim/`: a 2D racing simulator (TypeScript, Vite). See
`racing-sim/docs/PLAN.md` for the plan and roadmap, and `racing-sim/docs/HANDOFF.md` for where
things stand.

### Run it

From the repo root:

```bash
npm --prefix racing-sim run dev
```

Then open http://localhost:5173.

### Other commands

Run these from `racing-sim/`:

```bash
npm test            # Vitest checks
npm run typecheck   # tsc --noEmit
npm run build       # typecheck and production build
npm run sim -- --help   # headless CLI
```

### Install

```bash
npm --prefix racing-sim ci
```

If the default registry (Artifactory) is unreachable, run this from `racing-sim/`:

```bash
npm ci --registry=https://registry.npmjs.org/ --replace-registry-host=always --no-audit
```
