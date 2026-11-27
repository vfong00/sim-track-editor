import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BRAKE_USE, buildTrack, CAR_PRESETS, CarModel, type CarPreset, type CarSpec, dHard, type DriverStyle, EDGE_KEEP, evenBounds, fastLanes, KERB_REACH, lanePlansFor, LaneSet,
  lineBounds, type Scenario, simulateLap, surfaceFor, Track,
} from '../src/core';
import { bendLine, fastLine, lineLap } from '../src/core';
import { decodeDataUrl } from '../src/cli/png-node';

/**
 * Phase D: the fastest line per car class, and driving styles.
 * - The old racing line got slower the more road it had (it never converged at the fine scale);
 *   the fastest line must get faster with room, and a driven car must be able to follow it.
 * - Styles (U/V line, braking, throttle) change a lap by a few tenths of a percent at most, and
 *   which style is quickest depends on the car: an MX-5 (balance 2) suits a U driver, an F1 car
 *   (balance 1.7) a V driver. No style is quickest in every car.
 */
const preset = (p: CarPreset): CarSpec => {
  const { label: _l, ...x } = CAR_PRESETS[p];
  return { id: p, ...x, preset: p };
};
const style = (line: number, braking = 0.5, throttle = 0.5): DriverStyle => ({ braking, line, throttle, kerbs: 0.5 });

// A small, varied closed track: quick to optimise.
const ctrl = Array.from({ length: 18 }, (_, i) => {
  const a = (i / 18) * 2 * Math.PI;
  const r = 260 * (1 + 0.25 * Math.sin(3 * a) + 0.1 * Math.cos(5 * a));
  return { x: r * Math.cos(a), y: r * Math.sin(a) };
});
const track = Track.fromControlPoints(ctrl, 13);

describe('phase D: the fastest line', () => {
  it('stays within its bounds and gets faster with more road', { timeout: 60000 }, () => {
    const model = new CarModel(preset('gt3'));
    const judge = { model, brakeUse: BRAKE_USE };
    const laps = [3, 2, 1.5].map((margin) => {
      const b = evenBounds(track, track.width / 2 - margin);
      const line = fastLine(track, b, judge, 30);
      for (let i = 0; i < track.n; i++) expect(Math.abs(line.d[i])).toBeLessThanOrEqual(track.width / 2 - margin + 1e-9);
      return lineLap(track, line.d, judge).lapTime;
    });
    expect(laps[1]).toBeLessThan(laps[0] + 1e-6);
    expect(laps[2]).toBeLessThan(laps[1] + 1e-6);
  });

  it('the least-bending start respects the bounds', () => {
    const b = evenBounds(track, 3);
    const d = bendLine(track, b, new Float64Array(track.n));
    for (let i = 0; i < track.n; i++) expect(Math.abs(d[i])).toBeLessThanOrEqual(3 + 1e-9);
  });

  it('a driven car follows it: the stepped lap is within 1% of the plan', { timeout: 60000 }, () => {
    const spec = preset('gt3');
    const lanes = fastLanes(track, spec);
    const { model, plans } = lanePlansFor(lanes, spec, 1);
    const lap = simulateLap(lanes, plans, model);
    expect(Math.abs(lap.lapTime / plans.lapTime - 1)).toBeLessThan(0.01);
  });

  it('kerbs add width: the bounds reach KERB_REACH further only where a kerb lines the edge', () => {
    const b = lineBounds(track), k = surfaceFor(track).kerbs, plain = dHard(track) - EDGE_KEEP;
    let kerbed = 0;
    for (let i = 0; i < track.n; i++) {
      expect(b.hi[i]).toBeCloseTo(plain + (k.left[i] ? KERB_REACH : 0), 9);
      expect(-b.lo[i]).toBeCloseTo(plain + (k.right[i] ? KERB_REACH : 0), 9);
      kerbed += k.left[i] + k.right[i];
    }
    expect(kerbed).toBeGreaterThan(0);
  });
});

/** [slow] Each class's line on a real track, and the style fit. */
describe('phase D: styles fit the car [slow]', () => {
  const scn = JSON.parse(readFileSync(new URL('./fixtures/scenarios/png-yas.json', import.meta.url).pathname, 'utf8')) as Scenario;
  const yas = buildTrack(scn.track, scn.track.type === 'png' ? decodeDataUrl(scn.track.image) : undefined);
  const lap = (lanes: LaneSet, spec: CarSpec, st: DriverStyle) => lanePlansFor(lanes, spec, 1, {}, st).plans.lapTime;

  it('no style is quickest in every car, and none moves a lap by more than 0.5%', { timeout: 300000 }, () => {
    const best: Record<string, string> = {};
    for (const p of ['mx5', 'f1'] as const) {
      const spec = preset(p);
      const lanes = fastLanes(yas, spec);
      const mid = lap(lanes, spec, style(0.5));
      const u = lap(lanes, spec, style(0)), v = lap(lanes, spec, style(1));
      for (const t of [u, v, lap(lanes, spec, style(0.5, 1)), lap(lanes, spec, style(0.5, 0)), lap(lanes, spec, style(0.5, 0.5, 1)), lap(lanes, spec, style(0.5, 0.5, 0))]) {
        expect(Math.abs(t / mid - 1)).toBeLessThan(0.005);
      }
      best[p] = u < v ? 'U' : 'V';
    }
    expect(best).toEqual({ mx5: 'U', f1: 'V' });
  });
});
