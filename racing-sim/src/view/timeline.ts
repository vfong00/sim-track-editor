import type { Race, RaceEvent } from '../core';
import { fmtTime } from './draw';

/**
 * The timeline under the track: the whole race left to right, the part already computed, the
 * part watched, lap marks, and markers for what happened (only up to the furthest point
 * watched, so it never gives away what's coming). Click or drag to seek.
 */

/** Length of the timeline: the race's end once known, else an estimate from the plans. */
export function timelineDuration(r: Race): number {
  if (r.finished) return r.t;
  const best = Math.min(...r.cars.map((c) => c.plans.lapTime));
  return Math.max(r.t, r.laps * best * 1.15 + 20);
}

const MARK: Partial<Record<RaceEvent['type'], { color: string; h: number }>> = {
  'safety-car': { color: '#ffb000', h: 1 },
  grip: { color: '#7cc8ff', h: 1 },
  crash: { color: '#ff5a5a', h: 0.8 },
  retire: { color: '#ff5a5a', h: 0.8 },
  spin: { color: '#ffb347', h: 0.6 },
  pass: { color: '#9fd18b', h: 0.35 },
};

export function drawTimeline(ctx: CanvasRenderingContext2D, w: number, h: number, r: Race, clock: number, watched: number, dpr: number, marksTo = watched): void {
  const dur = timelineDuration(r);
  const X = (t: number) => (t / dur) * w;
  ctx.fillStyle = '#181b20';
  ctx.fillRect(0, 0, w, h);
  // Computed (light) and watched (lighter).
  ctx.fillStyle = '#20252d';
  ctx.fillRect(0, 0, X(r.t), h);
  ctx.fillStyle = '#28303b';
  ctx.fillRect(0, 0, X(watched), h);
  // Lap marks: when the first car started each lap (up to `marksTo`: the watched part, or all with spoilers).
  ctx.font = `${9 * dpr}px system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  for (let n = 1; n < r.laps; n++) {
    let t = Infinity;
    for (const c of r.cars) if (c.crossTimes[n] !== undefined) t = Math.min(t, c.crossTimes[n]);
    if (!(t <= marksTo)) break;
    ctx.fillStyle = '#3c4552';
    ctx.fillRect(X(t), 0, 1 * dpr, h);
    ctx.fillStyle = '#7d8896';
    ctx.fillText(`L${n + 1}`, X(t) + 3 * dpr, 2 * dpr);
  }
  // Event markers.
  for (const e of r.events) {
    if (e.t > marksTo) break;
    const m = MARK[e.type];
    if (!m) continue;
    ctx.fillStyle = m.color;
    const mh = m.h * (h - 4 * dpr);
    ctx.fillRect(X(e.t) - dpr, h - mh, 2 * dpr, mh);
  }
  // Playhead and time.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(X(clock) - dpr, 0, 2 * dpr, h);
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${10 * dpr}px system-ui, sans-serif`;
  const label = `${fmtTime(clock)} / ${r.finished ? fmtTime(r.t) : `~${fmtTime(dur)}`}`;
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(20,22,26,.85)';
  ctx.fillRect(w - tw - 12 * dpr, h / 2 - 7 * dpr, tw + 10 * dpr, 14 * dpr);
  ctx.fillStyle = '#cfd5dd';
  ctx.fillText(label, w - tw - 7 * dpr, h / 2);
  ctx.textBaseline = 'alphabetic';
}
