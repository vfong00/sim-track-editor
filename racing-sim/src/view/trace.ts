import type { LanePlans, SoloFrame, Track } from '../core';

/** Speed vs distance: the solver's plan (grey) and this lap's actual speed (orange). */
export function drawSpeedTrace(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  s: { track: Track; plans: LanePlans; run: { frames: SoloFrame[]; laps: number[] }; clock: number },
  carS: number,
): void {
  ctx.fillStyle = '#101216';
  ctx.fillRect(0, 0, w, h);
  const dpr = devicePixelRatio || 1;
  const padL = 44 * dpr, padR = 12 * dpr, padT = 10 * dpr, padB = 18 * dpr;
  const plan = s.plans.profiles[s.plans.lanes.zero].v;
  const vmax = Math.max(...plan) * 1.1;
  const L = s.track.length;
  const X = (d: number) => padL + (d / L) * (w - padL - padR);
  const Y = (v: number) => h - padB - (v / vmax) * (h - padT - padB);

  ctx.font = `${10 * dpr}px system-ui`;
  ctx.fillStyle = '#777';
  ctx.strokeStyle = '#22262d';
  ctx.lineWidth = 1;
  for (let kmh = 0; kmh <= vmax * 3.6; kmh += 50) {
    ctx.beginPath();
    ctx.moveTo(padL, Y(kmh / 3.6));
    ctx.lineTo(w - padR, Y(kmh / 3.6));
    ctx.stroke();
    ctx.fillText(`${kmh}`, 6 * dpr, Y(kmh / 3.6) + 3 * dpr);
  }
  ctx.fillText('km/h · distance →', padL, h - 4 * dpr);

  ctx.strokeStyle = '#6b7280';
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  const n = plan.length;
  for (let i = 0; i < n; i += 2) ctx[i ? 'lineTo' : 'moveTo'](X((i / n) * L), Y(plan[i]));
  ctx.stroke();

  // Actual speed over the current lap (frames since the last crossing).
  const f = s.run.frames;
  const lapStart = s.run.laps.reduce((x, y) => x + y, 0);
  ctx.strokeStyle = '#ff5a36';
  ctx.beginPath();
  let started = false;
  const k0 = Math.max(0, Math.floor(lapStart / (f[1]?.t || 1 / 60)) - 1);
  for (let k = k0; k < f.length && f[k].t <= s.clock; k += 2) {
    if (f[k].t < lapStart) continue;
    ctx[started ? 'lineTo' : 'moveTo'](X(f[k].s), Y(f[k].v));
    started = true;
  }
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fillRect(X(carS) - dpr, padT, 2 * dpr, h - padT - padB);
}
