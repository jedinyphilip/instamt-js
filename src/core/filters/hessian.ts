import type { Image2D } from '../types';

/**
 * Hessian matrix elements computed via Gaussian-derivative convolutions,
 * matching scikit-image's `_hessian_matrix_with_gaussian` exactly:
 *   - sigma_scaled = sigma / sqrt(2)
 *   - apply 1st-order Gaussian-derivative along one axis to get
 *     `gradients[axis]`
 *   - apply another Gaussian-derivative pass to get the second
 *     mixed/non-mixed partial
 *
 * The two-pass approach with sigma/sqrt(2) is more numerically stable
 * than a single 2nd-derivative kernel and is what skimage's `meijering`
 * uses internally. Boundary handling is scipy's 'reflect' (half-sample
 * symmetric).
 */

/** Build a 1-D Gaussian-derivative kernel of order 0 or 1. */
function gaussianKernel1d(sigma: number, order: 0 | 1, radius: number): Float64Array {
  const k = new Float64Array(2 * radius + 1);
  const sigma2 = sigma * sigma;
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-0.5 * (i * i) / sigma2);
    k[i + radius] = v;
    sum += v;
  }
  // Normalise the 0-order kernel to sum=1.
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  if (order === 0) return k;
  // First derivative: multiply by -x/σ². scipy then enforces
  // zero-mean (subtracts the mean so the kernel integrates to 0).
  let mean = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = (-i / sigma2) * k[i + radius]!;
    k[i + radius] = v;
    mean += v;
  }
  mean /= k.length;
  for (let i = 0; i < k.length; i++) k[i]! -= mean;
  return k;
}

function radiusFor(sigma: number): number {
  // scikit-image uses truncate=8 when σ > 1, else truncate=100
  // (because small σ filters approximate badly-decaying functions).
  const truncate = sigma > 1 ? 8 : 100;
  return Math.max(1, Math.round(truncate * sigma));
}

/** Apply a 1-D kernel along the given axis with reflect boundary. */
function convolve1d(
  src: Float64Array,
  h: number,
  w: number,
  kernel: Float64Array,
  axis: 0 | 1
): Float64Array {
  const out = new Float64Array(src.length);
  const radius = (kernel.length - 1) / 2;
  if (axis === 1) {
    // Along x.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          let sx = x + k;
          if (sx < 0) sx = -sx - 1;
          else if (sx >= w) sx = 2 * w - sx - 1;
          if (sx < 0) sx = 0;
          if (sx >= w) sx = w - 1;
          acc += src[y * w + sx]! * kernel[k + radius]!;
        }
        out[y * w + x] = acc;
      }
    }
  } else {
    // Along y.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          let sy = y + k;
          if (sy < 0) sy = -sy - 1;
          else if (sy >= h) sy = 2 * h - sy - 1;
          if (sy < 0) sy = 0;
          if (sy >= h) sy = h - 1;
          acc += src[sy * w + x]! * kernel[k + radius]!;
        }
        out[y * w + x] = acc;
      }
    }
  }
  return out;
}

/**
 * Apply scipy.ndimage.gaussian_filter with per-axis derivative orders.
 * `orders[0]` is the order along axis 0 (y/r), `orders[1]` along axis 1 (x/c).
 */
function gaussianFilterWithOrders(
  src: Float64Array,
  h: number,
  w: number,
  sigma: number,
  orders: readonly [0 | 1, 0 | 1]
): Float64Array {
  const radius = radiusFor(sigma);
  // Apply along axis 1 (x) first, then axis 0 (y) — order doesn't matter
  // for separable filters but we have to pick one.
  const kx = gaussianKernel1d(sigma, orders[1], radius);
  const ky = gaussianKernel1d(sigma, orders[0], radius);
  const tmp = convolve1d(src, h, w, kx, 1);
  return convolve1d(tmp, h, w, ky, 0);
}

/**
 * Hessian eigenvalues at scale σ, packed into two (e1, e2) Float32
 * buffers. Returned ordering is ASCENDING by absolute value (|e1| ≤
 * |e2|) — callers that want skimage's descending order swap them.
 */
export function hessianEigenvaluesAbs(
  img: Image2D,
  sigma: number
): { e1: Float32Array; e2: Float32Array } {
  const [h, w] = img.shape;
  const n = h * w;
  // Promote to float64 for the convolutions; scipy does the same.
  const src = new Float64Array(n);
  for (let i = 0; i < n; i++) src[i] = img.data[i]!;

  const sigmaScaled = sigma / Math.SQRT2;

  // gradients[0] = ∂I/∂y (axis-0 derivative + axis-1 smooth)
  // gradients[1] = ∂I/∂x
  const gy = gaussianFilterWithOrders(src, h, w, sigmaScaled, [1, 0]);
  const gx = gaussianFilterWithOrders(src, h, w, sigmaScaled, [0, 1]);

  // Hyy = derivative-along-y of gy
  // Hxy = derivative-along-x of gy
  // Hxx = derivative-along-x of gx
  const Hyy = gaussianFilterWithOrders(gy, h, w, sigmaScaled, [1, 0]);
  const Hxy = gaussianFilterWithOrders(gy, h, w, sigmaScaled, [0, 1]);
  const Hxx = gaussianFilterWithOrders(gx, h, w, sigmaScaled, [0, 1]);

  // Closed-form 2x2 symmetric eigenvalues. Note: NO σ² scaling here;
  // skimage's hessian_matrix doesn't apply that scaling either when
  // `use_gaussian_derivatives=True`. The scaling is implicit in the
  // Gaussian-derivative kernels themselves.
  const e1 = new Float32Array(n);
  const e2 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Hyy[i]!;
    const b = Hxy[i]!;
    const d = Hxx[i]!;
    const tr = a + d;
    const disc = Math.sqrt(((a - d) * (a - d)) / 4 + b * b);
    const lam1 = tr / 2 - disc;
    const lam2 = tr / 2 + disc;
    if (Math.abs(lam1) <= Math.abs(lam2)) {
      e1[i] = lam1;
      e2[i] = lam2;
    } else {
      e1[i] = lam2;
      e2[i] = lam1;
    }
  }
  return { e1, e2 };
}
