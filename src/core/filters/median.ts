import type { Image2D } from '../types';

/**
 * 2-D median filter with a square window of side `size` (must be odd).
 * O(W * H * size² * log(size²)) without histogram tricks — fine for
 * the sizes the cleanup pipeline uses (≤41 px), but if it shows up in
 * the profiler we can switch to a constant-time histogram update along
 * each row.
 *
 * Edges use mirror reflection like scipy.ndimage.median_filter("mirror"),
 * matching the Python implementation.
 */
export function medianFilter2d(img: Image2D, size: number): Image2D {
  if (size < 1 || size % 2 === 0) {
    throw new Error(`medianFilter2d: size must be a positive odd number, got ${size}`);
  }
  const [h, w] = img.shape;
  const r = (size - 1) / 2;
  const out = new Float32Array(h * w);
  const window = new Float32Array(size * size);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let k = 0;
      for (let dy = -r; dy <= r; dy++) {
        let sy = y + dy;
        if (sy < 0) sy = -sy - 1;
        else if (sy >= h) sy = 2 * h - sy - 1;
        if (sy < 0) sy = 0;
        if (sy >= h) sy = h - 1;
        for (let dx = -r; dx <= r; dx++) {
          let sx = x + dx;
          if (sx < 0) sx = -sx - 1;
          else if (sx >= w) sx = 2 * w - sx - 1;
          if (sx < 0) sx = 0;
          if (sx >= w) sx = w - 1;
          window[k++] = img.data[sy * w + sx]!;
        }
      }
      // Quickselect for median. For our small windows the constant
      // factor of full sort is negligible and the code stays simpler.
      out[y * w + x] = quickselect(window, 0, k - 1, k >>> 1);
    }
  }
  return { data: out, shape: img.shape };
}

/** In-place selection of the k-th smallest element in arr[lo..hi]. */
function quickselect(arr: Float32Array, lo: number, hi: number, k: number): number {
  while (lo < hi) {
    const pivot = arr[(lo + hi) >>> 1]!;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (arr[i]! < pivot) i++;
      while (arr[j]! > pivot) j--;
      if (i <= j) {
        const tmp = arr[i]!;
        arr[i] = arr[j]!;
        arr[j] = tmp;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return arr[k]!;
  }
  return arr[k]!;
}
