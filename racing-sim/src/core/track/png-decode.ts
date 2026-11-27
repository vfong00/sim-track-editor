/**
 * PNG decoding in plain code, shared by the browser and Node, so every engine builds the same
 * track from the same image. Decoding through a canvas let the browser colour-manage the pixels:
 * Safari applied the Yas and Silverstone images' colour profile (iCCP), the traced track came out
 * a little different, and the viewer showed a different race from the CLI for the same seed.
 *
 * Handles 8-bit, non-interlaced greyscale, RGB, greyscale + alpha and RGBA (every example track is
 * 8-bit greyscale). Alpha is composited onto white, as the canvas path did. Colour profiles and
 * gamma are ignored: the pixel values are taken as they are stored.
 */

export interface PngData {
  width: number;
  height: number;
  /** Colour type: 0 grey, 2 RGB, 4 grey + alpha, 6 RGBA. */
  color: number;
  /** The concatenated IDAT payload (zlib), to inflate. */
  idat: Uint8Array<ArrayBuffer>;
}

/** Channels per pixel of each supported colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Read the header and image data of a PNG, or null if it isn't one this decoder handles. */
export function readPng(bytes: Uint8Array): PngData | null {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 8 || sig.some((b, i) => bytes[i] !== b)) return null;
  const u32 = (p: number) => ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
  let pos = 8, width = 0, height = 0, color = -1;
  const parts: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const len = u32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = u32(pos + 8);
      height = u32(pos + 12);
      if (body[8] !== 8 || body[12] !== 0 || !(body[9] in CHANNELS)) return null;
      color = body[9];
    } else if (type === 'IDAT') parts.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (color < 0 || !parts.length) return null;
  const idat = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let k = 0;
  for (const p of parts) { idat.set(p, k); k += p.length; }
  return { width, height, color, idat };
}

/** Undo the PNG row filters on the inflated data and return RGBA pixels (alpha composited onto white, opaque). */
export function pngPixels(png: PngData, raw: Uint8Array): ImageData {
  const { width: w, height: h, color } = png;
  const n = CHANNELS[color], stride = w * n;
  if (raw.length < h * (stride + 1)) throw new Error('PNG data is truncated');
  const out = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = y * stride, src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= n ? out[row + x - n] : 0, b = y ? out[row - stride + x] : 0, c = x >= n && y ? out[row - stride + x - n] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[row + x] = v & 255;
    }
  }
  const data = new Uint8ClampedArray(w * h * 4);
  const onWhite = (v: number, al: number) => ((v * al + 255 * (255 - al) + 127) / 255) | 0;
  for (let i = 0; i < w * h; i++) {
    const p = i * n;
    let r: number, g: number, b: number;
    if (color === 0) r = g = b = out[p];
    else if (color === 4) r = g = b = onWhite(out[p], out[p + 1]);
    else if (color === 2) { r = out[p]; g = out[p + 1]; b = out[p + 2]; }
    else { const al = out[p + 3]; r = onWhite(out[p], al); g = onWhite(out[p + 1], al); b = onWhite(out[p + 2], al); }
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData;
}

/** Bytes of a `data:image/png;base64,` URL (null if it isn't one). */
export function dataUrlBytes(url: string): Uint8Array | null {
  const m = /^data:image\/png;base64,/.exec(url);
  if (!m) return null;
  const bin = atob(url.slice(m[0].length));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
