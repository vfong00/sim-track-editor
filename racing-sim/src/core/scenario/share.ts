import { parseScenario, type ParseResult, type Scenario } from './schema';

/**
 * Share by URL: the scenario JSON, deflated and base64url-encoded, in the URL hash (`#s=...`;
 * the hash never goes to a server). Generated and drawn tracks are small. A PNG track carries its
 * image and is usually too big: links longer than SHARE_LIMIT are refused with a message saying
 * to share the file instead, rather than producing a link that chat apps or browsers truncate.
 */
export const SHARE_LIMIT = 16_000;
export const SHARE_PREFIX = 's=';

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

const b64url = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** The hash fragment (without '#') for a scenario. Throws if it would exceed SHARE_LIMIT. */
export async function encodeScenario(s: Scenario): Promise<string> {
  const packed = b64url(await pipe(new TextEncoder().encode(JSON.stringify(s)) as Uint8Array<ArrayBuffer>, new CompressionStream('deflate')));
  const hash = SHARE_PREFIX + packed;
  if (hash.length > SHARE_LIMIT) {
    throw new Error(`This scenario is too big to share as a link (${(hash.length / 1000).toFixed(0)} kB, limit ${SHARE_LIMIT / 1000} kB)` +
      (s.track.type === 'png' ? ': its PNG track image is in it. Share the scenario file instead.' : '. Share the scenario file instead.'));
  }
  return hash;
}

/** Decode and validate a hash fragment made by encodeScenario. */
export async function decodeScenario(hash: string): Promise<ParseResult> {
  const h = hash.replace(/^#/, '');
  if (!h.startsWith(SHARE_PREFIX)) return { ok: false, errors: [{ path: '', message: 'not a scenario link' }] };
  let text: string;
  try {
    text = new TextDecoder().decode(await pipe(unb64url(h.slice(SHARE_PREFIX.length)), new DecompressionStream('deflate')));
  } catch {
    return { ok: false, errors: [{ path: '', message: 'the scenario link is damaged (it may have been cut short)' }] };
  }
  return parseScenario(text);
}
