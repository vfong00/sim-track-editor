import type { Vec } from '../core';
import type { View } from './draw';

/**
 * Camera framing (no DOM, so it can be tested). Three modes:
 * - all: the whole track (user zoom and pan on top);
 * - follow: centred on one car at a fixed scale (times the user zoom);
 * - battle: the followed car and the cars racing it, zooming out as the group spreads.
 */
export type CamMode = 'all' | 'follow' | 'battle';

/** Follow scale in px/m (before devicePixelRatio and user zoom). */
export const FOLLOW_SCALE = 5;
/** Battle cam: everyone within NEAR m of the followed car, else the nearest car ahead and behind within FAR m. */
export const BATTLE_NEAR = 60;
export const BATTLE_FAR = 250;
/** Battle cam scale limits, px/m (before devicePixelRatio). */
export const BATTLE_MAX = 9;
export const BATTLE_MIN = 0.6;
export const ZOOM_MIN = 0.15;
export const ZOOM_MAX = 8;

export interface CarPose {
  p: Vec;
  /** Distance along the track. */
  sPos: number;
  /** Status code (STATUS); out-of-the-race cars are left out of a battle. */
  status: number;
}

/**
 * Who is in the followed car's battle: every car within BATTLE_NEAR m along the track; if that
 * is nobody, the nearest car ahead and the nearest behind within BATTLE_FAR m. Cars that are
 * out (status ≥ `outFrom`) don't count. Always includes the followed car (first).
 */
export function battleGroup(poses: CarPose[], me: number, trackLength: number, outFrom: number): number[] {
  const L = trackLength;
  const group = [me];
  let ahead = -1, behind = -1, ga = Infinity, gb = Infinity;
  for (let j = 0; j < poses.length; j++) {
    if (j === me || poses[j].status >= outFrom) continue;
    let g = poses[j].sPos - poses[me].sPos;
    if (g > L / 2) g -= L;
    if (g < -L / 2) g += L;
    if (Math.abs(g) <= BATTLE_NEAR) group.push(j);
    if (g > 0 && g < ga) { ga = g; ahead = j; }
    if (g <= 0 && -g < gb) { gb = -g; behind = j; }
  }
  if (group.length === 1) {
    if (ahead >= 0 && ga <= BATTLE_FAR) group.push(ahead);
    if (behind >= 0 && gb <= BATTLE_FAR) group.push(behind);
  }
  return group;
}

/** Scale and centre that fit `pts` in a w×h canvas with `pad` px each side, within [min, max] px/m. */
export function frame(pts: Vec[], w: number, h: number, pad: number, min: number, max: number): { scale: number; c: Vec } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  const fit = Math.min((w - 2 * pad) / Math.max(x1 - x0, 1e-6), (h - 2 * pad) / Math.max(y1 - y0, 1e-6));
  return { scale: Math.max(min, Math.min(max, fit)), c: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } };
}

/** The view that puts world point c at the canvas centre at `scale`. */
export const centred = (c: Vec, scale: number, w: number, h: number): View => ({ scale, ox: w / 2 - c.x * scale, oy: h / 2 + c.y * scale });

/** Zoom a view by `f` keeping the world point under screen point (mx, my) fixed. */
export function zoomAt(v: View, f: number, mx: number, my: number): View {
  const wx = (mx - v.ox) / v.scale, wy = (v.oy - my) / v.scale;
  const scale = v.scale * f;
  return { scale, ox: mx - wx * scale, oy: my + wy * scale };
}

export const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
