import { RUNOFF, STATUS, type Track, type TrackPath, type Vec } from '../core';
import type { Livery } from './livery';

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

/**
 * The track: run-off, road, edge lines and kerbs (or, with `curvature`, the edges coloured by
 * curvature: a debug view), the racing line (dashed), the start line and, if given, the sector
 * lines (`sectors`: lap distances where sectors 1 and 2 end).
 */
export function drawTrack(ctx: CanvasRenderingContext2D, t: Track, v: View, line?: TrackPath, sectors: number[] = [], curvature = false): void {
  const X = (x: number) => v.ox + x * v.scale;
  const Y = (y: number) => v.oy - y * v.scale;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const loop = () => {
    ctx.beginPath();
    for (let i = 0; i <= t.n; i++) ctx[i ? 'lineTo' : 'moveTo'](X(t.xs[i % t.n]), Y(t.ys[i % t.n]));
    ctx.stroke();
  };
  // Run-off (grass and gravel) with the barrier along its far side, under the road.
  ctx.strokeStyle = '#8a8f99';
  ctx.lineWidth = (t.width + 2 * RUNOFF + 0.8) * v.scale;
  loop();
  ctx.strokeStyle = '#1d2a1f';
  ctx.lineWidth = (t.width + 2 * RUNOFF) * v.scale;
  loop();
  ctx.strokeStyle = '#2b2f37';
  ctx.lineWidth = t.width * v.scale;
  loop();
  if (curvature) {
    // Debug view: curvature colouring as edge strips (green straight → red tight).
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
  } else {
    // White edge lines, then red and white kerbs where the racing line uses the edge.
    ctx.strokeStyle = 'rgba(235, 235, 235, 0.8)';
    ctx.lineWidth = Math.max(1, 0.15 * v.scale);
    for (const side of [1, -1] as const) {
      ctx.beginPath();
      for (let i = 0; i <= t.n; i++) {
        const a = t.edge(i % t.n, side);
        ctx[i ? 'lineTo' : 'moveTo'](X(a.x), Y(a.y));
      }
      ctx.stroke();
    }
    if (line) {
      const kerb = kerbsFor(t, line);
      const off = t.width / 2 - KERB_WIDTH / 2;
      const at = (i: number, side: number) => ({ x: t.xs[i] + t.nx[i] * side * off, y: t.ys[i] + t.ny[i] * side * off });
      ctx.lineWidth = Math.max(1, KERB_WIDTH * v.scale);
      ctx.lineCap = 'butt';
      for (const side of [1, -1] as const) {
        const mask = side > 0 ? kerb.left : kerb.right;
        for (const red of [true, false]) {
          ctx.strokeStyle = red ? '#d62828' : '#f2f2f2';
          ctx.beginPath();
          for (let i = 0; i < t.n; i++) {
            if (!mask[i] || (Math.floor((i * t.ds) / KERB_STRIPE) % 2 === 0) !== red) continue;
            const a = at(i, side), b = at((i + 1) % t.n, side);
            ctx.moveTo(X(a.x), Y(a.y));
            ctx.lineTo(X(b.x), Y(b.y));
          }
          ctx.stroke();
        }
      }
      ctx.lineCap = 'round';
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
  // Sector lines: dashed, across the road and a little into the run-off on both sides.
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 210, 80, 0.75)';
  ctx.lineWidth = Math.max(1.5, 0.5 * v.scale);
  ctx.setLineDash([Math.max(3, 1.2 * v.scale), Math.max(3, 1.2 * v.scale)]);
  ctx.fillStyle = 'rgba(255, 210, 80, 0.9)';
  ctx.font = `600 ${Math.max(10, Math.min(16, 3 * v.scale))}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  sectors.forEach((s, k) => {
    const i = Math.round(s / t.ds) % t.n;
    const a = t.edge(i, 1), b = t.edge(i, -1);
    const ux = (a.x - b.x) / (t.width || 1), uy = (a.y - b.y) / (t.width || 1);
    const ext = 3;
    ctx.beginPath();
    ctx.moveTo(X(a.x + ux * ext), Y(a.y + uy * ext));
    ctx.lineTo(X(b.x - ux * ext), Y(b.y - uy * ext));
    ctx.stroke();
    ctx.fillText(`S${k + 1}`, X(a.x + ux * (ext + 4)), Y(a.y + uy * (ext + 4)));
  });
  ctx.restore(); // dash, font and text alignment back as they were (labels drawn later rely on it)
  const a = t.edge(0, 1), b = t.edge(0, -1);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(2, 0.8 * v.scale);
  ctx.beginPath();
  ctx.moveTo(X(a.x), Y(a.y));
  ctx.lineTo(X(b.x), Y(b.y));
  ctx.stroke();
}

/** Kerb width (m), stripe length (m), and where kerbs go: see `kerbsFor`. */
export const KERB_WIDTH = 1.0;
export const KERB_STRIPE = 2.5;
/** The racing line within this of the road edge (m) uses the kerb there... */
const KERB_NEAR = 2.5;
/** ...in a corner: somewhere within KERB_LOOK m the centreline is tighter than this radius (m). */
const KERB_RADIUS = 250;
const KERB_LOOK = 15;
/** Kerbs run on this far (m) either side of where the line touches. */
const KERB_EXTEND = 6;

const kerbCache = new WeakMap<TrackPath, { left: Uint8Array; right: Uint8Array }>();

/**
 * Where the kerbs go, per node and side (left = side +1): where the racing line comes close to
 * the edge in a corner, which is the outside at turn-in, the inside at the apex and the outside
 * at the exit, as on a real circuit.
 */
export function kerbsFor(t: Track, line: TrackPath): { left: Uint8Array; right: Uint8Array } {
  const hit = kerbCache.get(line);
  if (hit) return hit;
  const n = t.n, edge = t.width / 2;
  const look = Math.round(KERB_LOOK / t.ds), ext = Math.round(KERB_EXTEND / t.ds);
  // Tightest centreline curvature near each node.
  const near = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = -look; j <= look; j++) m = Math.max(m, Math.abs(t.curvature[(i + j + n) % n]));
    near[i] = m;
  }
  const left = new Uint8Array(n), right = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = line.d[i];
    if (Math.abs(d) < edge - KERB_NEAR || near[i] < 1 / KERB_RADIUS) continue;
    const mask = d > 0 ? left : right;
    for (let j = -ext; j <= ext; j++) mask[(i + j + n) % n] = 1;
  }
  const out = { left, right };
  kerbCache.set(line, out);
  return out;
}

/** Below this length on screen (px) a car is a plain coloured block: details would be mush. */
const DETAIL_PX = 14;
/** From this length on screen (px) the race number shows. */
const NUMBER_PX = 34;

/**
 * Car (world size, at least a few pixels so it stays visible): with a livery, its body shape
 * and paint once it is big enough on screen; else an oriented rectangle.
 */
export function drawCar(ctx: CanvasRenderingContext2D, v: View, p: Vec, heading: number, color: string, len: number, wid: number, outline = false, status = 0, livery?: Livery, brake = 0): void {
  if (status === STATUS.cleared) return; // taken away by marshals
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
  const out = status === STATUS.crash || status === STATUS.out;
  if (status === STATUS.spin || status === STATUS.stopped) {
    // Spun or stopped: a hazard ring.
    ctx.strokeStyle = '#ffd23f';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(L * 0.9, 10), 0, 7);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (outline && !livery) {
    // The safety car: its box.
  } else if (outline) {
    // The followed car: a soft light on the road under it.
    const r = Math.max(L * 0.9, 10);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, 'rgba(255,255,255,0.22)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, 7);
    ctx.fill();
  }
  ctx.rotate(-heading);
  ctx.globalAlpha = out ? 0.55 : 1;
  if (livery && L >= DETAIL_PX) drawBody(ctx, L, W, livery);
  else {
    ctx.fillStyle = color;
    ctx.fillRect(-L / 2, -W / 2, L, W);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(L / 2 - L * 0.22, -W / 2, L * 0.22, W);
  }
  ctx.globalAlpha = 1;
  if (brake > 0 && !out) {
    // Brake lights: two red glows at the tail, brighter the harder the braking.
    const r = Math.max(1, W * 0.085);
    ctx.save();
    ctx.shadowColor = '#ff2a2a';
    ctx.shadowBlur = Math.max(4, W * 0.9) * brake;
    ctx.fillStyle = `rgba(255, ${70 - 40 * brake}, ${60 - 40 * brake}, ${0.5 + 0.5 * brake})`;
    for (const y of [-W * 0.3, W * 0.3]) {
      ctx.beginPath();
      ctx.arc(-L / 2 + r * 0.6, y, r, 0, 7);
      ctx.fill();
    }
    ctx.restore();
  }
  if (out) {
    // Retired: a red cross over the car.
    ctx.strokeStyle = '#ff4d4d';
    ctx.lineWidth = 2;
    const r = Math.max(L, 8) * 0.6;
    ctx.beginPath();
    ctx.moveTo(-r, -r); ctx.lineTo(r, r);
    ctx.moveTo(-r, r); ctx.lineTo(r, -r);
    ctx.stroke();
  }
  if (outline && !livery) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-L / 2 - 2, -W / 2 - 2, L + 4, W + 4);
  }
  ctx.restore();
}

const TYRE = '#101215';
const GLASS = 'rgba(20, 26, 36, 0.9)';

/** A rounded rectangle path (x, y = top-left corner). */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * The car's body in its own frame (pixels; +x forward, centred on the car), filling L × W: the
 * class's shape, the base colour, the pattern in the accent, glass and wings, and the number.
 */
function drawBody(ctx: CanvasRenderingContext2D, L: number, W: number, lv: Livery): void {
  const hl = L / 2, hw = W / 2;
  // The body outline, used to fill and then to clip the pattern.
  const body = () => {
    if (lv.shape === 'open') {
      // Nose cone, cockpit, sidepods, engine cover tapering to the gearbox.
      ctx.beginPath();
      ctx.moveTo(hl * 0.92, -hw * 0.12);
      ctx.lineTo(hl * 0.92, hw * 0.12);
      ctx.lineTo(hl * 0.3, hw * 0.3);
      ctx.lineTo(hl * 0.1, hw * 0.62);
      ctx.lineTo(-hl * 0.45, hw * 0.62);
      ctx.lineTo(-hl * 0.72, hw * 0.3);
      ctx.lineTo(-hl * 0.72, -hw * 0.3);
      ctx.lineTo(-hl * 0.45, -hw * 0.62);
      ctx.lineTo(hl * 0.1, -hw * 0.62);
      ctx.lineTo(hl * 0.3, -hw * 0.3);
      ctx.closePath();
    } else if (lv.shape === 'proto') {
      roundRect(ctx, -hl, -hw * 0.96, L, W * 0.96, hw * 0.7);
    } else {
      roundRect(ctx, -hl * 0.98, -hw * 0.92, L * 0.98, W * 0.92, hw * (lv.shape === 'gt' ? 0.45 : 0.55));
    }
  };
  // Open wheels and wings go under and around the body.
  if (lv.shape === 'open') {
    ctx.fillStyle = TYRE;
    const tw = L * 0.15, th = W * 0.26;
    for (const x of [hl * 0.56, -hl * 0.62]) for (const y of [-hw, hw - th]) ctx.fillRect(x - tw / 2, y, tw, th);
    // Front wing (accent) and rear wing (dark, accent endplates).
    ctx.fillStyle = lv.accent;
    ctx.fillRect(hl * 0.86, -hw * 0.92, L * 0.07, W * 0.92);
    ctx.fillStyle = TYRE;
    ctx.fillRect(-hl, -hw * 0.6, L * 0.09, W * 0.6);
    ctx.fillStyle = lv.accent;
    ctx.fillRect(-hl, -hw * 0.6, L * 0.09, W * 0.08);
    ctx.fillRect(-hl, hw * 0.52, L * 0.09, W * 0.08);
  }
  ctx.fillStyle = lv.base;
  body();
  ctx.fill();
  // Pattern, clipped to the body.
  ctx.save();
  body();
  ctx.clip();
  ctx.fillStyle = lv.accent;
  switch (lv.pattern) {
    case 'stripe': ctx.fillRect(-hl, -W * 0.09, L, W * 0.18); break;
    case 'halves': ctx.fillRect(0, -hw, hl, W); break;
    case 'tail': ctx.fillRect(-hl, -hw, L * 0.3, W); break;
    case 'sides': ctx.fillRect(-hl, -hw * 0.78, L, W * 0.1); ctx.fillRect(-hl, hw * 0.68, L, W * 0.1); break;
    case 'chevron':
      ctx.beginPath();
      ctx.moveTo(hl * 0.55, 0);
      ctx.lineTo(hl * 0.05, -hw);
      ctx.lineTo(-hl * 0.15, -hw);
      ctx.lineTo(hl * 0.35, 0);
      ctx.lineTo(-hl * 0.15, hw);
      ctx.lineTo(hl * 0.05, hw);
      ctx.closePath();
      ctx.fill();
      break;
  }
  ctx.restore();
  // Glass, wings and details by shape.
  ctx.fillStyle = GLASS;
  if (lv.shape === 'open') {
    // Cockpit opening with the driver's helmet in the accent.
    roundRect(ctx, -hl * 0.12, -hw * 0.2, L * 0.16, W * 0.4, hw * 0.2);
    ctx.fill();
    ctx.fillStyle = lv.accent;
    ctx.beginPath();
    ctx.arc(-hl * 0.02, 0, Math.min(hw * 0.16, L * 0.05), 0, 7);
    ctx.fill();
  } else if (lv.shape === 'proto') {
    // Canopy bubble forward of centre, and a full-width rear wing.
    ctx.beginPath();
    ctx.ellipse(hl * 0.12, 0, L * 0.14, W * 0.2, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = TYRE;
    ctx.fillRect(-hl, -hw * 0.9, L * 0.07, W * 0.9);
  } else {
    // Windscreen and rear window; a GT gets a wing on stands.
    const cab = lv.shape === 'gt' ? 0.34 : 0.4;
    ctx.beginPath();
    ctx.moveTo(hl * 0.32, -hw * 0.7);
    ctx.lineTo(hl * 0.32, hw * 0.7);
    ctx.lineTo(hl * (0.32 - cab * 0.45), hw * 0.62);
    ctx.lineTo(hl * (0.32 - cab * 0.45), -hw * 0.62);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(-hl * 0.62, -hw * 0.6, L * 0.08, W * 0.6);
    if (lv.shape === 'gt') {
      ctx.fillStyle = TYRE;
      ctx.fillRect(-hl * 0.97, -hw * 0.94, L * 0.06, W * 0.94);
    }
  }
  // Number roundel on the roof or engine cover.
  if (L >= NUMBER_PX) {
    const nx = lv.shape === 'open' ? -hl * 0.38 : lv.shape === 'proto' ? -hl * 0.3 : -hl * 0.12;
    const r = Math.min(hw * 0.5, L * 0.11);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(nx, 0, r, 0, 7);
    ctx.fill();
    ctx.save();
    ctx.translate(nx, 0);
    ctx.rotate(Math.PI / 2);
    ctx.fillStyle = '#111';
    ctx.font = `700 ${r * 1.15}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(lv.number), 0, r * 0.06);
    ctx.restore();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  body();
  ctx.stroke();
}

export const fmtTime = (t: number): string => {
  if (!isFinite(t)) return '–';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m > 0 ? `${m}:${s.toFixed(3).padStart(6, '0')}` : s.toFixed(3);
};
