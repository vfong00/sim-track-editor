import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cos, exp, log, sin } from '../src/core/fmath';

/**
 * The viewer (Chrome) and the CLI and tests (Node) must run the same race for a scenario and seed.
 * Engines round Math.exp/log/sin/cos (and pow, so `**`) differently in the last bit, and the race
 * is chaotic, so one bit became a different race. Core code uses src/core/fmath.ts instead.
 */
const coreFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? coreFiles(p) : p.endsWith('.ts') && !p.endsWith('fmath.ts') ? [p] : [];
  });

describe('determinism across engines', () => {
  it('core code uses no engine-rounded Math functions or **', () => {
    const banned = /Math\.(exp|expm1|log|log1p|log2|log10|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|pow|cbrt)\b|[\w)\]]\s*\*\*\s*[\w(]/;
    const hits: string[] = [];
    for (const f of coreFiles(join(__dirname, '../src/core'))) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/^\s*\*/.test(code) || /2 \*\* 32/.test(code)) return; // doc comments, integer constants
        if (banned.test(code)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('fmath gives fixed bits (the same in every engine) within an ulp of Math', () => {
    const F = new Float64Array(1), U = new Uint32Array(F.buffer);
    let h = 0x811c9dc5;
    for (let i = 0; i < 4000; i++) {
      const x = (i - 2000) / 97.3;
      const ours = [exp(x / 4), log(Math.abs(x) + 1e-3), sin(x), cos(x)];
      const ref = [Math.exp(x / 4), Math.log(Math.abs(x) + 1e-3), Math.sin(x), Math.cos(x)];
      ours.forEach((v, k) => {
        expect(Math.abs(v - ref[k])).toBeLessThanOrEqual(Math.abs(ref[k]) * 2.3e-16 + 1e-300);
        F[0] = v;
        h = Math.imul(h ^ U[0], 16777619);
        h = Math.imul(h ^ U[1], 16777619);
      });
    }
    // Checked to match in Chrome (racing-sim/parity.html). A change here changes every race.
    expect((h >>> 0).toString(16)).toBe('fef6daa4');
  });

  it('handles the edges', () => {
    expect(exp(0)).toBe(1);
    expect(log(1)).toBe(0);
    expect(log(0)).toBe(-Infinity);
    expect(Number.isNaN(log(-1))).toBe(true);
    expect(exp(-Infinity)).toBe(0);
    expect(exp(1000)).toBe(Infinity);
    expect(cos(0)).toBe(1);
    expect(sin(0)).toBe(0);
    expect(() => sin(1e7)).toThrow(RangeError);
  });
});
