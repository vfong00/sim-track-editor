/**
 * exp, log, sin, cos and hypot that give the same bits in every JavaScript engine.
 *
 * Math.exp, Math.log, Math.sin and Math.cos are only required to be close, and engines differ in
 * the last bit: Node 24 and Chrome disagree on all four. The race is chaotic, so one bit in a
 * normal draw or the track smoothing grew into a different race in the viewer than in the CLI
 * (and the batch baselines). These are ports of fdlibm (e_exp.c, e_log.c, s_sin.c, s_cos.c,
 * k_sin.c, k_cos.c, e_rem_pio2.c) using only + − × ÷ and bit access, which IEEE 754 makes exact.
 * Core code uses these, never the Math versions (a test checks).
 */

const F = new Float64Array(1);
const U = new Uint32Array(F.buffer); // little endian: U[0] low word, U[1] high word
const hiWord = (x: number) => { F[0] = x; return U[1] | 0; };
const loWord = (x: number) => { F[0] = x; return U[0]; };
const withHi = (x: number, hi: number) => { F[0] = x; U[1] = hi; return F[0]; };
const fromWords = (hi: number, lo: number) => { U[1] = hi; U[0] = lo; return F[0]; };

// --- exp (e_exp.c)
const HUGE = 1e300, TWOM1000 = 9.33263618503218878990e-302;
const O_THRESHOLD = 7.09782712893383973096e+02, U_THRESHOLD = -7.45133219101941108420e+02;
const LN2_HI = 6.93147180369123816490e-01, LN2_LO = 1.90821492927058770002e-10, INV_LN2 = 1.44269504088896338700e+00;
const P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03, P3 = 6.61375632143793436117e-05,
  P4 = -1.65339022054652515390e-06, P5 = 4.13813679705723846039e-08;

export function exp(x: number): number {
  let hx = hiWord(x);
  const xsb = (hx >>> 31) & 1;
  hx &= 0x7fffffff;
  let hi = 0, lo = 0, k = 0;
  if (hx >= 0x40862e42) {
    if (hx >= 0x7ff00000) return ((hx & 0xfffff) | loWord(x)) !== 0 ? x + x : xsb === 0 ? x : 0;
    if (x > O_THRESHOLD) return HUGE * HUGE;
    if (x < U_THRESHOLD) return TWOM1000 * TWOM1000;
  }
  if (hx > 0x3fd62e42) {
    if (hx < 0x3ff0a2b2) {
      hi = xsb ? x + LN2_HI : x - LN2_HI;
      lo = xsb ? -LN2_LO : LN2_LO;
      k = 1 - xsb - xsb;
    } else {
      k = (INV_LN2 * x + (xsb ? -0.5 : 0.5)) | 0;
      hi = x - k * LN2_HI;
      lo = k * LN2_LO;
    }
    x = hi - lo;
  } else if (hx < 0x3e300000) {
    if (HUGE + x > 1) return 1 + x;
  }
  const t = x * x;
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((x * c) / (c - 2) - x);
  const y = 1 - ((lo - (x * c) / (2 - c)) - hi);
  if (k >= -1021) return withHi(y, hiWord(y) + (k << 20));
  return withHi(y, hiWord(y) + ((k + 1000) << 20)) * TWOM1000;
}

// --- log (e_log.c)
const TWO54 = 1.80143985094819840000e+16;
const LG1 = 6.666666666666735130e-01, LG2 = 3.999999999940941908e-01, LG3 = 2.857142874366239149e-01,
  LG4 = 2.222219843214978396e-01, LG5 = 1.818357216161805012e-01, LG6 = 1.531383769920937332e-01, LG7 = 1.479819860511658591e-01;

export function log(x: number): number {
  let hx = hiWord(x);
  const lx = loWord(x);
  let k = 0;
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54;
    x *= TWO54;
    hx = hiWord(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  let i = (hx + 0x95f64) & 0x100000;
  x = withHi(x, hx | (i ^ 0x3ff00000));
  k += i >> 20;
  const f = x - 1;
  if ((0x000fffff & (2 + hx)) < 3) {
    if (f === 0) return k === 0 ? 0 : k * LN2_HI + k * LN2_LO;
    const R = f * f * (0.5 - 0.33333333333333333 * f);
    return k === 0 ? f - R : k * LN2_HI - ((R - k * LN2_LO) - f);
  }
  const s = f / (2 + f), dk = k, z = s * s;
  i = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  i |= j;
  const R = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    return k === 0 ? f - (hfsq - s * (hfsq + R)) : dk * LN2_HI - ((hfsq - (s * (hfsq + R) + dk * LN2_LO)) - f);
  }
  return k === 0 ? f - s * (f - R) : dk * LN2_HI - ((s * (f - R) - dk * LN2_LO) - f);
}

// --- sin and cos kernels on [-π/4, π/4] (k_sin.c, k_cos.c)
const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04,
  S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05,
  C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;

function kSin(x: number, y: number, iy: number): number {
  const ix = hiWord(x) & 0x7fffffff;
  if (ix < 0x3e400000 && (x | 0) === 0) return x;
  const z = x * x, v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return iy === 0 ? x + v * (S1 + z * r) : x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

function kCos(x: number, y: number): number {
  const ix = hiWord(x) & 0x7fffffff;
  if (ix < 0x3e400000 && (x | 0) === 0) return 1;
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3fd33333) return 1 - (0.5 * z - (z * r - x * y));
  const qx = ix > 0x3fe90000 ? 0.28125 : fromWords(ix - 0x00200000, 0);
  const hz = 0.5 * z - qx, a = 1 - qx;
  return a - (hz - (z * r - x * y));
}

// --- argument reduction by π/2 (e_rem_pio2.c, up to |x| ≈ 2^19·π/2)
const INV_PIO2 = 6.36619772367581382433e-01;
const PIO2_1 = 1.57079632673412561417e+00, PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11, PIO2_2T = 2.02226624879595063154e-21;
const PIO2_3 = 2.02226624871116645580e-21, PIO2_3T = 8.47842766036889956997e-32;
const NPIO2_HW = [
  0x3ff921fb, 0x400921fb, 0x4012d97c, 0x401921fb, 0x401f6a7a, 0x4022d97c, 0x4025fdbb, 0x402921fb,
  0x402c463a, 0x402f6a7a, 0x4031475c, 0x4032d97c, 0x40346b9c, 0x4035fdbb, 0x40378fdb, 0x403921fb,
  0x403ab41b, 0x403c463a, 0x403dd85a, 0x403f6a7a, 0x40407e4c, 0x4041475c, 0x4042106c, 0x4042d97c,
  0x4043a28c, 0x40446b9c, 0x404534ac, 0x4045fdbb, 0x4046c6cb, 0x40478fdb, 0x404858eb, 0x404921fb,
];
/** Reduced argument (y0 + y1) and quadrant, shared by sin and cos. */
const red = { y0: 0, y1: 0 };

function remPio2(x: number): number {
  const hx = hiWord(x), ix = hx & 0x7fffffff;
  if (ix < 0x4002d97c) {
    let z: number;
    if (hx > 0) {
      z = x - PIO2_1;
      if (ix !== 0x3ff921fb) { red.y0 = z - PIO2_1T; red.y1 = (z - red.y0) - PIO2_1T; }
      else { z -= PIO2_2; red.y0 = z - PIO2_2T; red.y1 = (z - red.y0) - PIO2_2T; }
      return 1;
    }
    z = x + PIO2_1;
    if (ix !== 0x3ff921fb) { red.y0 = z + PIO2_1T; red.y1 = (z - red.y0) + PIO2_1T; }
    else { z += PIO2_2; red.y0 = z + PIO2_2T; red.y1 = (z - red.y0) + PIO2_2T; }
    return -1;
  }
  if (ix > 0x413921fb) throw new RangeError(`fmath: sin/cos argument too large for deterministic reduction (${x})`);
  let t = Math.abs(x);
  const n = (t * INV_PIO2 + 0.5) | 0;
  const fn = n;
  let r = t - fn * PIO2_1;
  let w = fn * PIO2_1T;
  if (n < 32 && ix !== NPIO2_HW[n - 1]) red.y0 = r - w;
  else {
    const j = ix >> 20;
    red.y0 = r - w;
    let i = j - ((hiWord(red.y0) >> 20) & 0x7ff);
    if (i > 16) {
      t = r; w = fn * PIO2_2; r = t - w; w = fn * PIO2_2T - ((t - r) - w); red.y0 = r - w;
      i = j - ((hiWord(red.y0) >> 20) & 0x7ff);
      if (i > 49) { t = r; w = fn * PIO2_3; r = t - w; w = fn * PIO2_3T - ((t - r) - w); red.y0 = r - w; }
    }
  }
  red.y1 = (r - red.y0) - w;
  if (hx < 0) { red.y0 = -red.y0; red.y1 = -red.y1; return -n; }
  return n;
}

export function sin(x: number): number {
  const ix = hiWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kSin(x, 0, 0);
  if (ix >= 0x7ff00000) return NaN;
  const n = remPio2(x) & 3;
  return n === 0 ? kSin(red.y0, red.y1, 1) : n === 1 ? kCos(red.y0, red.y1) : n === 2 ? -kSin(red.y0, red.y1, 1) : -kCos(red.y0, red.y1);
}

export function cos(x: number): number {
  const ix = hiWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kCos(x, 0);
  if (ix >= 0x7ff00000) return NaN;
  const n = remPio2(x) & 3;
  return n === 0 ? kCos(red.y0, red.y1) : n === 1 ? -kSin(red.y0, red.y1, 1) : n === 2 ? -kCos(red.y0, red.y1) : kSin(red.y0, red.y1, 1);
}

// --- hypot (V8's MathHypot in src/builtins/math.tq, to the bit)
/**
 * Math.hypot isn't required to be exact either: V8 (Node, Chrome) scales by the largest argument
 * and sums the squares with Kahan compensation, Safari's JavaScriptCore rounds another way, and the
 * race split from Chrome's within 20 s. This is V8's algorithm in + − × ÷ and sqrt (exact in IEEE
 * 754), so Node's races keep their bits and every engine now gets them.
 */
export function hypot(x: number, y: number, z?: number): number {
  const three = z !== undefined;
  if (x !== x || y !== y || (three && z !== z)) {
    return Math.abs(x) === Infinity || Math.abs(y) === Infinity || (three && Math.abs(z) === Infinity) ? Infinity : NaN;
  }
  const a = Math.abs(x), b = Math.abs(y), c = three ? Math.abs(z) : 0;
  const max = Math.max(a, b, c);
  if (max === Infinity) return Infinity;
  if (max === 0) return 0;
  // Kahan summation of the scaled squares, term by term as V8 does (a third term only if given).
  let n = a / max, sum = n * n, comp = 0;
  n = b / max;
  let summand = n * n - comp, pre = sum + summand;
  comp = (pre - sum) - summand; sum = pre;
  if (three) {
    n = c / max; summand = n * n - comp; pre = sum + summand;
    sum = pre;
  }
  return Math.sqrt(sum) * max;
}
