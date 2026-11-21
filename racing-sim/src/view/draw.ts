import type { Track, TrackPath, Vec } from '../core';

export interface View {
  scale: number;
  ox: number;
  oy: number;
}

export const toScreen = (v: View, p: Vec): Vec => ({ x: v.ox + p.x * v.scale, y: v.oy - p.y * v.scale });

/** Fit a set of world points into a canvas with padding (in device pixels). */
export function fitView(points: Vec[], w: number, h: number, pad: number): View {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  const scale = Math.min((w - pad * 2) / (x1 - x0 || 1), (h - pad * 2) / (y1 - y0 || 1));
  return { scale, ox: w / 2 - ((x0 + x1) / 2) * scale, oy: h / 2 + ((y0 + y1) / 2) * scale };
}

/** Green (straight) → yellow → red (tight), by |curvature| against a 30 m radius. */
export function curvatureColor(k: number): string {
  const t = Math.min(1, Math.abs(k) * 30);
  return `hsl(${120 - 120 * t}, 85%, 50%)`;
}

export function drawTrack(ctx: CanvasRenderingContext2D, t: Track, v: View, line?: TrackPath): void {
  const X = (x: number) => v.ox + x * v.scale;
  const Y = (y: number) => v.oy - y * v.scale;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#2b2f37';
  ctx.lineWidth = t.width * v.scale;
  ctx.beginPath();
  for (let i = 0; i <= t.n; i++) ctx[i ? 'lineTo' : 'moveTo'](X(t.xs[i % t.n]), Y(t.ys[i % t.n]));
  ctx.stroke();
  // Curvature colouring as kerb-like edge strips.
  ctx.lineWidth = Math.max(1, 0.8 * v.scale);
  for (const side of [1, -1] as const) {
    for (let i = 0; i < t.n; i++) {
      const a = t.edge(i, side), b = t.edge((i + 1) % t.n, side);
      ctx.strokeStyle = curvatureColor(t.curvature[i]);
      ctx.beginPath();
      ctx.moveTo(X(a.x), Y(a.y));
      ctx.lineTo(X(b.x), Y(b.y));
      ctx.stroke();
    }
  }
  if (line) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = Math.max(1, 0.3 * v.scale);
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    for (let i = 0; i <= line.n; i++) ctx[i ? 'lineTo' : 'moveTo'](X(line.xs[i % line.n]), Y(line.ys[i % line.n]));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const a = t.edge(0, 1), b = t.edge(0, -1);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(2, 0.8 * v.scale);
  ctx.beginPath();
  ctx.moveTo(X(a.x), Y(a.y));
  ctx.lineTo(X(b.x), Y(b.y));
  ctx.stroke();
}

/** Car as an oriented rectangle (world size), at least a few pixels so it stays visible. */
export function drawCar(ctx: CanvasRenderingContext2D, v: View, p: Vec, heading: number, color: string, len: number, wid: number, outline = false): void {
  const q = toScreen(v, p);
  const L = Math.max(len * v.scale, 7), W = Math.max(wid * v.scale, 3.5);
  ctx.save();
  ctx.translate(q.x, q.y);
  if (len * v.scale < 10) {
    // Zoomed out: a halo so the car stays findable.
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, 7);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.rotate(-heading);
  ctx.fillStyle = color;
  ctx.fillRect(-L / 2, -W / 2, L, W);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(L / 2 - L * 0.22, -W / 2, L * 0.22, W);
  if (outline) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-L / 2 - 2, -W / 2 - 2, L + 4, W + 4);
  }
  ctx.restore();
}

export const fmtTime = (t: number): string => {
  if (!isFinite(t)) return '–';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m > 0 ? `${m}:${s.toFixed(3).padStart(6, '0')}` : s.toFixed(3);
};
