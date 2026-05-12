import { hessianEigenvaluesAbs } from './hessian';
import type { Image2D } from '../types';

/**
 * Meijering "neuriteness" ridge filter. Ports
 * skimage.filters.ridges.meijering for 2-D images.
 *
 * Algorithm per σ:
 *   1. Hessian eigenvalues (e0, e1) sorted by |·| DESCENDING (skimage
 *      convention); so |e0| ≥ |e1|.
 *   2. Apply circulant α-matrix: vals[k] = e[k] + α * Σ_{j≠k} e[j].
 *      For 2D, α = 1/3 and:
 *        m0 = e0 + α * e1
 *        m1 = α * e0 + e1
 *   3. Pick the modified value with max |·| at each pixel.
 *   4. Clip to ≥ 0.
 *   5. Divide by the per-σ max (if > 0).
 *
 * Final response is the elementwise max across all σ.
 *
 * `blackRidges=true` (the default, what IRM uses) detects dark ridges
 * directly. For `blackRidges=false`, the image is negated first.
 */
export function meijering(
  img: Image2D,
  sigmas: readonly number[] = [1.0, 1.5, 2.0],
  blackRidges = true
): Image2D {
  const [h, w] = img.shape;
  const n = h * w;

  const work: Image2D = blackRidges
    ? img
    : { data: negate(img.data), shape: img.shape };

  const alpha = 1 / 3; // 1/(ndim + 1) for 2D
  const filteredMax = new Float32Array(n);

  for (const sigma of sigmas) {
    const eig = hessianEigenvaluesAbs(work, sigma);
    // hessianEigenvaluesAbs returns ascending |·|. Swap to descending so
    // e0 has the LARGER magnitude, matching skimage.
    const e0 = eig.e2;
    const e1 = eig.e1;

    const vals = new Float32Array(n);
    let maxAbs = 0;
    let maxClipped = 0;
    for (let i = 0; i < n; i++) {
      const a = e0[i]!;
      const b = e1[i]!;
      const m0 = a + alpha * b;
      const m1 = alpha * a + b;
      const v = Math.abs(m0) >= Math.abs(m1) ? m0 : m1;
      vals[i] = v;
      if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
      // Clipped max (≥ 0 only).
      if (v > maxClipped) maxClipped = v;
    }
    void maxAbs;

    if (maxClipped > 0) {
      const inv = 1 / maxClipped;
      for (let i = 0; i < n; i++) {
        const v = vals[i]!;
        const clipped = v > 0 ? v * inv : 0;
        if (clipped > filteredMax[i]!) filteredMax[i] = clipped;
      }
    }
  }

  return { data: filteredMax, shape: img.shape };
}

function negate(arr: Float32Array): Float32Array {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = -arr[i]!;
  return out;
}
