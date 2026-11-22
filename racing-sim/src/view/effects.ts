import { FRAME_STRIDE, type Race, type RaceEvent, STATUS, type Vec } from '../core';
import type { View } from './draw';

/**
 * Visual effects read from the race's logs (rule 4): brake lights from the logged speed, tyre
 * smoke and dust, sparks at contact and skid marks that stay on the track. Particles are tied to
 * a fixed time grid and seeded by car and time, so scrubbing back and forth shows the same smoke.
 * Nothing here changes the race.
 */

/** Smoke emission step (s) and how long a puff lives (s). */
export const PUFF_STEP = 0.05;
export const PUFF_LIFE = 1.6;
/** How long sparks fly after a contact (s). */
export const SPARK_LIFE = 0.4;
/** Braking (m/s²) from which brake lights show, and at which they are brightest. */
export const BRAKE_FROM = 3;
export const BRAKE_FULL = 14;

/** How long each kind of moment smokes (s from its event), and whether it marks the road. */
const MOMENTS: Partial<Record<RaceEvent['type'], { dur: number; marks: boolean }>> = {
  mistake: { dur: 0.7, marks: true },
  slide: { dur: 0.5, marks: false },
  spin: { dur: 2.5, marks: true },
  crash: { dur: 2.0, marks: true },
};

/** A car's state at a time, interpolated from the frames. */
function stateAt(r: Race, i: number, t: number): { s: number; d: number; v: number; status: number } | null {
  const k = Math.floor(t / r.dt);
  if (k < 0 || k + 1 >= r.frames.length) return null;
  const u = t / r.dt - k;
  const a = r.frames[k], b = r.frames[k + 1], o = i * FRAME_STRIDE;
  const L = r.track.length;
  let ds = b[o] - a[o];
  if (ds < -L / 2) ds += L;
  if (ds > L / 2) ds -= L;
  return { s: (a[o] + ds * u + L) % L, d: a[o + 1] + (b[o + 1] - a[o + 1]) * u, v: a[o + 2] + (b[o + 2] - a[o + 2]) * u, status: a[o + 4] };
}

/** Braking strength 0–1 for the brake lights: deceleration over the last ~0.1 s of the log. */
export function brakeAt(r: Race, i: number, t: number): number {
  const now = stateAt(r, i, t), before = stateAt(r, i, t - 0.1);
  if (!now || !before || now.status !== STATUS.run && now.status !== STATUS.off) return 0;
  const decel = (before.v - now.v) / 0.1;
  return decel < BRAKE_FROM ? 0 : Math.min(1, (decel - BRAKE_FROM) / (BRAKE_FULL - BRAKE_FROM) + 0.35);
}

/** Smoke and skid windows per car, from the event log (cached per race and event count). */
interface Moments {
  n: number;
  byCar: { t0: number; t1: number; marks: boolean }[][];
}
const momentCache = new WeakMap<Race, Moments>();
function moments(r: Race): Moments {
  let m = momentCache.get(r);
  if (m && m.n === r.events.length) return m;
  m = { n: r.events.length, byCar: r.cars.map(() => []) };
  for (const e of r.events) {
    const k = MOMENTS[e.type];
    if (!k) continue;
    m.byCar[e.cars[0]]?.push({ t0: e.t, t1: e.t + k.dur, marks: k.marks });
  }
  momentCache.set(r, m);
  return m;
}

/** 0–1 hash of integers (for stable particle jitter). */
function rand(a: number, b: number, c = 0): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be59b, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export interface Puff {
  p: Vec;
  /** Age 0–1 over PUFF_LIFE. */
  age: number;
  /** Smoke (grey) or dust (off the road, brown). */
  dust: boolean;
  size: number;
}

/** Smoke and dust alive at time t: emitted by cars in a moment, spinning or crashing, or off the road at speed. */
export function puffsAt(r: Race, t: number): Puff[] {
  const out: Puff[] = [];
  const mm = moments(r);
  const k1 = Math.floor(t / PUFF_STEP), k0 = Math.ceil((t - PUFF_LIFE) / PUFF_STEP);
  for (let i = 0; i < r.cars.length; i++) {
    const wins = mm.byCar[i];
    for (let k = Math.max(0, k0); k <= k1; k++) {
      const te = k * PUFF_STEP;
      const st = stateAt(r, i, te);
      if (!st || st.status === STATUS.cleared || st.v < 3) continue;
      const spinning = st.status === STATUS.spin || st.status === STATUS.crash;
      const off = st.status === STATUS.off;
      const smoking = spinning || wins.some((w) => te >= w.t0 && te <= w.t1);
      if (!smoking && !(off && st.v > 8)) continue;
      const jx = rand(i, k, 1) - 0.5, jy = rand(i, k, 2) - 0.5;
      const p = r.track.toXY(st.s, st.d);
      const age = (t - te) / PUFF_LIFE;
      // Puffs drift a little and grow as they fade.
      out.push({ p: { x: p.x + jx * (1 + 3 * age), y: p.y + jy * (1 + 3 * age) }, age, dust: !smoking, size: 0.9 + rand(i, k, 3) * 0.8 });
    }
  }
  return out;
}

export interface Spark {
  p: Vec;
  /** Age 0–1 over SPARK_LIFE. */
  age: number;
}

/** Sparks from contacts in the last SPARK_LIFE s, thrown out from where the cars touched. */
export function sparksAt(r: Race, t: number): Spark[] {
  const out: Spark[] = [];
  for (let n = r.events.length - 1; n >= 0; n--) {
    const e = r.events[n];
    if (e.t > t) continue; // logged ahead of the viewer clock
    if (t - e.t > SPARK_LIFE) break; // events are in time order: the rest are older
    if (e.type !== 'contact' || e.cars.length < 2) continue;
    const a = stateAt(r, e.cars[0], e.t), b = stateAt(r, e.cars[1], e.t);
    if (!a || !b) continue;
    const pa = r.track.toXY(a.s, a.d), pb = r.track.toXY(b.s, b.d);
    const c = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
    const age = (t - e.t) / SPARK_LIFE;
    for (let j = 0; j < 14; j++) {
      const ang = rand(n, j, 4) * 2 * Math.PI, sp = 4 + rand(n, j, 5) * 10;
      out.push({ p: { x: c.x + Math.cos(ang) * sp * (t - e.t), y: c.y + Math.sin(ang) * sp * (t - e.t) }, age });
    }
  }
  return out;
}

/** A skid mark: the car's path through a lock-up, spin or crash, as two tyre lines. */
export interface SkidMark {
  t0: number;
  /** Per sample: time and the two tyre positions. */
  pts: { t: number; l: Vec; r: Vec }[];
}
const markCache = new WeakMap<Race, Map<string, SkidMark>>();

/** Skid marks laid down by time t (each drawn only up to t). Cached once a mark's window is in the log. */
export function skidMarksAt(r: Race, t: number): SkidMark[] {
  let cache = markCache.get(r);
  if (!cache) markCache.set(r, (cache = new Map()));
  const out: SkidMark[] = [];
  const mm = moments(r);
  const logged = (r.frames.length - 2) * r.dt;
  mm.byCar.forEach((wins, i) => {
    for (const w of wins) {
      if (!w.marks || w.t0 > t) continue;
      const key = `${i}:${w.t0}`;
      let m = cache!.get(key);
      if (!m) {
        m = { t0: w.t0, pts: [] };
        for (let te = w.t0; te <= Math.min(w.t1, logged); te += PUFF_STEP) {
          const st = stateAt(r, i, te);
          if (!st || st.v < 2) break;
          m.pts.push({ t: te, l: r.track.toXY(st.s, st.d + 0.75), r: r.track.toXY(st.s, st.d - 0.75) });
        }
        if (w.t1 <= logged) cache!.set(key, m);
      }
      out.push(m);
    }
  });
  return out;
}

/** Draw the skid marks (under the cars). */
export function drawSkidMarks(ctx: CanvasRenderingContext2D, v: View, marks: SkidMark[], t: number): void {
  const X = (x: number) => v.ox + x * v.scale, Y = (y: number) => v.oy - y * v.scale;
  ctx.strokeStyle = 'rgba(8, 8, 10, 0.55)';
  ctx.lineWidth = Math.max(1, 0.28 * v.scale);
  ctx.lineCap = 'round';
  for (const m of marks) {
    for (const side of ['l', 'r'] as const) {
      ctx.beginPath();
      let n = 0;
      for (const q of m.pts) {
        if (q.t > t) break;
        ctx[n++ ? 'lineTo' : 'moveTo'](X(q[side].x), Y(q[side].y));
      }
      if (n > 1) ctx.stroke();
    }
  }
}

/** Draw smoke, dust and sparks (over the cars). */
export function drawParticles(ctx: CanvasRenderingContext2D, v: View, puffs: Puff[], sparks: Spark[]): void {
  const X = (x: number) => v.ox + x * v.scale, Y = (y: number) => v.oy - y * v.scale;
  for (const p of puffs) {
    const r = Math.max(2, (p.size + 2.5 * p.age) * v.scale);
    const a = (1 - p.age) * (p.dust ? 0.35 : 0.3);
    ctx.fillStyle = p.dust ? `rgba(150, 120, 80, ${a})` : `rgba(225, 228, 232, ${a})`;
    ctx.beginPath();
    ctx.arc(X(p.p.x), Y(p.p.y), r, 0, 7);
    ctx.fill();
  }
  for (const s of sparks) {
    ctx.fillStyle = `rgba(255, ${200 - 120 * s.age}, 60, ${1 - s.age})`;
    const r = Math.max(1, 0.18 * v.scale);
    ctx.fillRect(X(s.p.x) - r, Y(s.p.y) - r, 2 * r, 2 * r);
  }
}
