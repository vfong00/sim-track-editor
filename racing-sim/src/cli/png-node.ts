import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { pngPixels, readPng } from '../core/track/png-decode';

/** Node decoder for 8-bit, non-interlaced PNGs (the CLI and tests; the viewer uses the same code, see png-decode.ts). */
export function decodeGrayPng(path: string): ImageData {
  return decodeGrayPngBytes(readFileSync(path));
}

/** Decode PNG bytes (a data URL's payload) the same way. */
export function decodeGrayPngBytes(buf: Uint8Array): ImageData {
  const png = readPng(buf);
  if (!png) throw new Error('PNG decoder: only 8-bit, non-interlaced greyscale, RGB or RGBA PNGs');
  return pngPixels(png, inflateSync(png.idat));
}

/** Decode a PNG data URL. */
export const decodeDataUrl = (url: string) => decodeGrayPngBytes(Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
