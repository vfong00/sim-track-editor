import type { Track, Vec } from '../core';
import { fitView, type View } from './draw';

/**
 * The minimap: the whole track in a corner, every car as a dot, the followed car ringed, the
 * safety car in amber, and the main camera's view as a box.
 */
export interface MiniCar {
  p: Vec;
  color: string;
  out: boolean;
  /** Cleared away by marshals: not drawn. */
  gone?: boolean;
}

export function drawMinimap(
  ctx: CanvasRenderingContext2D, w: number, h: number, track: Track, cars: MiniCar[], follow: number,
  sc: Vec | null, cam: View | null, camW: number, camH: number, dpr: number, sectors: number[] = [],
): View {
  const v = fitView(track.centerline(), w, h, 10 * dpr);
  const X = (x: number) => v.ox + x * v.scale;
  const Y = (y: number) => v.oy - y * v.scale;
  ctx.clearRect(0, 0, w, h);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#4a5260';
  ctx.lineWidth = Math.max(3 * dpr, track.width * v.scale);
  ctx.beginPath();
  for (let i = 0; i <= track.n; i++) ctx[i ? 'lineTo' : 'moveTo'](X(track.xs[i % track.n]), Y(track.ys[i % track.n]));
  ctx.stroke();
  // Start line (white) and sector lines (amber).
  const tick = (i: number, color: string) => {
    const a = track.edge(i, 1), b = track.edge(i, -1);
    const nx = b.x - a.x, ny = b.y - a.y, nl = Math.hypot(nx, ny) || 1;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, half = 5 * dpr / v.scale;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(X(m.x - nx / nl * half), Y(m.y - ny / nl * half));
    ctx.lineTo(X(m.x + nx / nl * half), Y(m.y + ny / nl * half));
    ctx.stroke();
  };
  for (const s of sectors) tick(Math.round(s / track.ds) % track.n, 'rgba(255, 210, 80, 0.85)');
  tick(0, '#fff');
  // What the main camera shows.
  if (cam) {
    const x0 = (0 - cam.ox) / cam.scale, x1 = (camW - cam.ox) / cam.scale;
    const y0 = (cam.oy - 0) / cam.scale, y1 = (cam.oy - camH) / cam.scale;
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = dpr;
    ctx.strokeRect(X(x0), Y(y0), (x1 - x0) * v.scale, (y0 - y1) * v.scale);
  }
  const dot = (p: Vec, r: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(X(p.x), Y(p.y), r, 0, 7);
    ctx.fill();
  };
  cars.forEach((c, i) => { if (i !== follow && !c.gone) dot(c.p, 3 * dpr, c.out ? '#555b66' : c.color); });
  if (sc) dot(sc, 3.5 * dpr, '#ffb000');
  const f = cars[follow];
  if (f) {
    dot(f.p, 4.5 * dpr, f.color);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(X(f.p.x), Y(f.p.y), 7 * dpr, 0, 7);
    ctx.stroke();
  }
  return v;
}
