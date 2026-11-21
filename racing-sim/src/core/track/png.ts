import type { Track } from './track';

/**
 * PNG import (thin to a centerline → order the pixels → fit a closed spline → scale from a
 * user-given length). Stub for Phase 1; the notebook's algorithm gets ported later.
 */
export function trackFromPng(_image: ImageData, _lengthMeters: number, _width = 14): Track {
  throw new Error('PNG import is not implemented yet');
}
