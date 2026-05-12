import type { Image2D } from '../types';

/**
 * Separable 2-D Gaussian filter. Same default truncation as
 * scipy.ndimage.gaussian_filter (4σ → ~0.0001 weight at the edge), so
 * results match the Python pipeline within float rounding.
 */
export function gaussianFilter2d(img: Image2D, sigma: number, truncate = 4.0): Image2D {
  if (sigma <= 0) return { data: img.data.slice(), shape: img.shape };
  const radius = Math.max(1, Math.round(truncate * sigma));
  const kernel = makeKernel(sigma, radius);
  const [h, w] = img.shape;
  const tmp = new Float32Array(h * w);
  // Horizontal pass — scipy 'reflect' (half-sample symmetric).
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let sx = x + k;
        if (sx < 0) sx = -sx - 1;
        else if (sx >= w) sx = 2 * w - sx - 1;
        if (sx < 0) sx = 0;
        if (sx >= w) sx = w - 1;
        acc += img.data[y * w + sx]! * kernel[k + radius]!;
      }
      tmp[y * w + x] = acc;
    }
  }
  // Vertical pass — same convention.
  const out = new Float32Array(h * w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let sy = y + k;
        if (sy < 0) sy = -sy - 1;
        else if (sy >= h) sy = 2 * h - sy - 1;
        if (sy < 0) sy = 0;
        if (sy >= h) sy = h - 1;
        acc += tmp[sy * w + x]! * kernel[k + radius]!;
      }
      out[y * w + x] = acc;
    }
  }
  return { data: out, shape: img.shape };
}

function makeKernel(sigma: number, radius: number): Float32Array {
  const k = new Float32Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  return k;
}
