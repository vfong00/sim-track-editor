/** Speed vs distance for one car: its plan on the racing line (grey) and this lap's actual speed. */
export function drawSpeedTrace(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  plan: Float64Array, length: number, actual: { s: number; v: number }[], carS: number, color: string,
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
  ctx.fillText('km/h vs distance · grey = solver plan, colour = this lap', padL, h - 4 * dpr);

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
