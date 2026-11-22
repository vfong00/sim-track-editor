import type { CarModel } from '../core';

/** One point of the trace: distance into the lap, speed, and (if shown) pedal shares 0–1. */
export interface TracePoint {
  s: number;
  v: number;
  throttle?: number;
  brake?: number;
}

/**
 * Pedals recovered from the log (it stores speed, not inputs): the tyre force behind the car's
 * acceleration `a` at speed v, beyond what drag alone does, as a share of what the engine
 * (throttle) or brakes could give there in a straight line. So braking that tapers off as the
 * car turns in (the tyres share their grip between braking and cornering: trail braking) reads
 * as the pedal coming up, and throttle fed in out of a corner as the pedal going down. Clean air
 * assumed, so a tow can read a little over full throttle (clamped); a lift reads as neither.
 */
export function pedals(model: CarModel, v: number, a: number): { throttle: number; brake: number } {
  const coast = -model.cd * v * v;
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  if (a >= coast) {
    const room = model.maxDrive(v, 0) - coast;
    return { throttle: room > 1e-6 ? clamp01((a - coast) / room) : a > coast ? 1 : 0, brake: 0 };
  }
  const room = model.maxBrake(v, 0) + coast;
  return { throttle: 0, brake: room > 1e-6 ? clamp01((coast - a) / room) : 1 };
}

/**
 * Speed vs distance for one car: its plan on the racing line (grey) and this lap's actual speed.
 * With inputs, a band along the bottom shows throttle (green, up) and brake (red, down).
 */
export function drawSpeedTrace(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  plan: Float64Array, length: number, actual: TracePoint[], carS: number, color: string, inputs = false,
): void {
  ctx.fillStyle = '#101216';
  ctx.fillRect(0, 0, w, h);
  const dpr = devicePixelRatio || 1;
  const padL = 44 * dpr, padR = 12 * dpr, padT = 10 * dpr, padB = 18 * dpr;
  let top = 0;
  for (const v of plan) top = Math.max(top, v);
  const vmax = top * 1.1;
  const X = (d: number) => padL + (d / length) * (w - padL - padR);
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
  ctx.fillText(`km/h vs distance · grey = solver plan, colour = this lap${inputs ? ' · green = throttle, red = brake' : ''}`, padL, h - 4 * dpr);

  if (inputs && actual.length > 1) {
    // Pedal band: the whole plot, throttle rising from its middle, brake falling.
    const bandH = h - padT - padB;
    const mid = h - padB - bandH / 2;
    const area = (key: 'throttle' | 'brake', sign: number, fill: string) => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(X(actual[0].s), mid);
      for (const p of actual) ctx.lineTo(X(p.s), mid - sign * (p[key] ?? 0) * (bandH / 2));
      ctx.lineTo(X(actual[actual.length - 1].s), mid);
      ctx.closePath();
      ctx.fill();
    };
    area('throttle', 1, 'rgba(61, 220, 132, 0.35)');
    area('brake', -1, 'rgba(255, 77, 77, 0.45)');
    ctx.strokeStyle = '#2a2f38';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, mid);
    ctx.lineTo(w - padR, mid);
    ctx.stroke();
  }

  ctx.strokeStyle = '#6b7280';
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  const n = plan.length;
  for (let i = 0; i < n; i += 2) ctx[i ? 'lineTo' : 'moveTo'](X((i / n) * length), Y(plan[i]));
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.beginPath();
  actual.forEach((p, k) => ctx[k ? 'lineTo' : 'moveTo'](X(p.s), Y(p.v)));
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fillRect(X(carS) - dpr, padT, 2 * dpr, h - padT - padB);
}
