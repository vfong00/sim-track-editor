import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/** Minimal Node decoder for 8-bit grayscale, non-interlaced PNGs (the test fixtures and the CLI; the browser decodes any PNG itself). */
export function decodeGrayPng(path: string): ImageData {
  return decodeGrayPngBytes(readFileSync(path));
}

/** Decode PNG bytes (a data URL's payload) the same way. */
export function decodeGrayPngBytes(buf: Buffer): ImageData {
  let pos = 8, w = 0, h = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); if (body[8] !== 8 || body[9] !== 0) throw new Error('test decoder: only 8-bit grayscale PNGs'); }
    if (type === 'IDAT') idat.push(body);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (w + 1)];
    for (let x = 0; x < w; x++) {
      const a = x ? gray[y * w + x - 1] : 0, b = y ? gray[(y - 1) * w + x] : 0, c = x && y ? gray[(y - 1) * w + x - 1] : 0;
      let v = raw[y * (w + 1) + 1 + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      gray[y * w + x] = v & 255;
    }
  }
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([gray[i], gray[i], gray[i], 255], i * 4);
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData;
}


/** Decode a PNG data URL. */
export const decodeDataUrl = (url: string) => decodeGrayPngBytes(Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
