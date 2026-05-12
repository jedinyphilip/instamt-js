/**
 * Minimal 2-D Daubechies-2 (db2) discrete wavelet transform —
 * just enough for `estimateSigma` (which only needs the HH/'dd'
 * diagonal detail coefficients of a single decomposition level).
 *
 * Filter coefficients match PyWavelets `pywt.Wavelet('db2').dec_lo /
 * dec_hi` exactly. PyWavelets stores its decomposition filters in
 * "forward" order, where the convolution formula at output sample k is
 *
 *     output[k] = sum_j filter[j] * input[2k + 1 - j]
 *
 * with whole-sample symmetric ('symmetric' mode) boundary padding —
 * a[-1] = a[0], a[-2] = a[1], … This mode is the PyWavelets default
 * and what `skimage.restoration.estimate_sigma` invokes.
 *
 * The earlier incarnation of this file stored the filters in REVERSED
 * order and offset by `(fLen-1)` — those two errors don't cancel under
 * symmetric padding, so the resulting σ estimate was biased ~8% low,
 * which then propagated into a too-weak NLM `h` and a noisier denoise
 * output (max ≈ 24 grey-level Δ vs Python). The corrected formula
 * matches PyWavelets to floating-point precision.
 */

const DB2_LOW = [-0.12940952255126037, 0.22414386804201339, 0.836516303737469, 0.48296291314453414];
const DB2_HIGH = [-0.48296291314453414, 0.836516303737469, -0.22414386804201339, -0.12940952255126037];

/** Symmetric pad and convolve a 1-D row with `filter`, then downsample by 2. */
function convolveDownsampleRow(
  src: Float64Array,
  rowOffset: number,
  rowStride: number,
  n: number,
  filter: number[],
  out: Float64Array,
  outOffset: number,
  outStride: number,
  outN: number
): void {
  const fLen = filter.length;
  for (let k = 0; k < outN; k++) {
    let acc = 0;
    for (let j = 0; j < fLen; j++) {
      let idx = 2 * k + 1 - j;
      // Whole-sample symmetric ('symmetric' / scipy.ndimage 'reflect'):
      // a[-1] = a[0], a[-2] = a[1], a[n] = a[n-1], a[n+1] = a[n-2].
      if (idx < 0) idx = -idx - 1;
      else if (idx >= n) idx = 2 * n - idx - 1;
      if (idx < 0) idx = 0;
      if (idx >= n) idx = n - 1;
      acc += filter[j]! * src[rowOffset + idx * rowStride]!;
    }
    out[outOffset + k * outStride] = acc;
  }
}

/**
 * Compute the diagonal detail (HH / 'dd') sub-band of a single-level
 * 2-D db2 wavelet decomposition of `img`.
 */
export function db2DiagonalDetail(
  data: Float32Array,
  h: number,
  w: number
): Float64Array {
  // Step 1: filter each row with high-pass (across columns) → temp
  // (h × w/2 elements).
  const halfW = Math.floor((w + DB2_HIGH.length - 1) / 2);
  const temp = new Float64Array(h * halfW);
  const src = new Float64Array(data); // promote
  for (let y = 0; y < h; y++) {
    convolveDownsampleRow(src, y * w, 1, w, DB2_HIGH, temp, y * halfW, 1, halfW);
  }
  // Step 2: filter each column of temp with high-pass → (h/2 × w/2).
  const halfH = Math.floor((h + DB2_HIGH.length - 1) / 2);
  const out = new Float64Array(halfH * halfW);
  for (let x = 0; x < halfW; x++) {
    convolveDownsampleRow(temp, x, halfW, h, DB2_HIGH, out, x, halfW, halfH);
  }
  return out;
}

/**
 * Robust noise standard-deviation estimator. Median-absolute-deviation
 * of the diagonal detail coefficients, scaled by the inverse normal
 * 75th-percentile (1.4826...). Mirrors `skimage.restoration.estimate_sigma`.
 */
export function estimateSigma(data: Float32Array, h: number, w: number): number {
  const dd = db2DiagonalDetail(data, h, w);
  // skimage takes median of |coeffs| INCLUDING zeros. We were dropping
  // zeros, which biased σ upward whenever the image had clipped
  // regions and produced exact-zero detail coefficients.
  if (dd.length === 0) return 0;
  const abs = new Float64Array(dd.length);
  for (let i = 0; i < dd.length; i++) abs[i] = Math.abs(dd[i]!);
  abs.sort();
  const med =
    abs.length % 2 === 0
      ? (abs[abs.length / 2 - 1]! + abs[abs.length / 2]!) / 2
      : abs[(abs.length - 1) >>> 1]!;
  // norm.ppf(0.75)
  const NORM_PPF_075 = 0.6744897501960817;
  return med / NORM_PPF_075;
}

void DB2_LOW; // exported only for completeness; not used yet
export const _DB2_LOW = DB2_LOW;
