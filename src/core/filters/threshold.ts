import type { Image2D } from '../types';

/**
 * Li's iterative minimum cross-entropy threshold (Li & Tam 1998).
 * Matches `skimage.filters.threshold_li` on the standard fixtures —
 * see `tests/li.test.ts`.
 *
 * Iteratively refine t until t_next ≈ t_curr (within tolerance):
 *   t_next = (mean_back - mean_fore) / (ln(mean_back) - ln(mean_fore))
 *
 * The image is shifted to be non-negative for the log step and the
 * shift is undone in the returned threshold. Default tolerance is
 * half the smallest difference between distinct image values.
 */
export function liThreshold(img: Image2D): number {
  const data = img.data;
  if (data.length === 0) return NaN;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (Number.isNaN(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === hi) return lo;

  // Tolerance: half the smallest non-zero difference between sorted
  // unique values, mirroring skimage's float branch.
  const sorted = Float32Array.from(data).sort();
  let smallestDiff = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i]! - sorted[i - 1]!;
    if (d > 0 && d < smallestDiff) smallestDiff = d;
  }
  if (!Number.isFinite(smallestDiff)) return lo;
  const tolerance = smallestDiff / 2;

  // Shifted image (subtract min so we can take log of positive means).
  // We work with the original values + bookkeeping rather than copying
  // a shifted array — saves an N-sized allocation on large frames.
  const offset = lo;

  let tCurr = -2 * tolerance;
  let tNext = 0;
  // Initial guess: mean of (image - offset).
  let sumAll = 0;
  for (let i = 0; i < data.length; i++) sumAll += data[i]! - offset;
  tNext = sumAll / data.length;

  let safety = 100; // hard cap on iterations
  while (Math.abs(tNext - tCurr) > tolerance && safety-- > 0) {
    tCurr = tNext;
    let sumF = 0;
    let cntF = 0;
    let sumB = 0;
    let cntB = 0;
    const tShift = tCurr; // threshold in shifted space
    for (let i = 0; i < data.length; i++) {
      const v = data[i]! - offset;
      if (v > tShift) {
        sumF += v;
        cntF++;
      } else {
        sumB += v;
        cntB++;
      }
    }
    if (cntF === 0 || cntB === 0) break;
    const mF = sumF / cntF;
    const mB = sumB / cntB;
    if (mB <= 0 || mF <= 0) break;
    const denom = Math.log(mB) - Math.log(mF);
    if (Math.abs(denom) < 1e-12) break;
    tNext = (mB - mF) / denom;
  }
  return tNext + offset;
}

/**
 * Otsu's method on a 256-bin histogram. Kept for tests / comparison;
 * the pipeline uses {@link liThreshold}.
 */
export function otsuThreshold(img: Image2D): number {
  const data = img.data;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi <= lo) return lo;

  const nBins = 256;
  const hist = new Int32Array(nBins);
  const span = hi - lo;
  for (let i = 0; i < data.length; i++) {
    let b = Math.floor(((data[i]! - lo) / span) * (nBins - 1));
    if (b < 0) b = 0;
    if (b >= nBins) b = nBins - 1;
    hist[b]!++;
  }

  // Standard between-class variance maximisation.
  const total = data.length;
  let sum = 0;
  for (let i = 0; i < nBins; i++) sum += i * hist[i]!;

  let sumB = 0;
  let wB = 0;
  let varMax = 0;
  let argmax = 0;
  for (let t = 0; t < nBins; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > varMax) {
      varMax = between;
      argmax = t;
    }
  }
  return lo + ((argmax + 0.5) / (nBins - 1)) * span;
}

/** Threshold an image; returns a Uint8Array binary mask. */
export function applyThreshold(img: Image2D, threshold: number): Uint8Array {
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < img.data.length; i++) out[i] = img.data[i]! > threshold ? 1 : 0;
  return out;
}

/**
 * Per-pixel Li threshold map, built from Li thresholds computed on
 * overlapping tiles whose centres sit on a regular grid spaced
 * `tileSize / 2` apart. The per-pixel cutoff is bilinearly interpolated
 * between the four surrounding tile-centre cutoffs.
 *
 * Tiles whose Li response is below `floorRatio * globalLi` get pinned
 * to that floor so empty/uniform tiles don't produce a noise-level
 * threshold that lets the full background through.
 *
 * Use this when MTs in low-density regions are dragged below the
 * global Li by stronger ridges elsewhere — local Li adapts the cutoff
 * to each region's own ridge-response statistics.
 */
export function localLiThresholdMap(
  img: Image2D,
  tileSize: number,
  globalLi: number,
  floorRatio: number
): Float32Array {
  const data = img.data;
  const [h, w] = img.shape;
  const out = new Float32Array(h * w);
  const step = Math.max(1, Math.floor(tileSize / 2));
  const half = Math.floor(tileSize / 2);
  const cyCount = Math.max(2, Math.ceil((h - 1) / step) + 1);
  const cxCount = Math.max(2, Math.ceil((w - 1) / step) + 1);
  const floor = globalLi * floorRatio;

  // 1. Per-tile Li at each centre on the grid.
  const grid = new Float32Array(cyCount * cxCount);
  for (let cy = 0; cy < cyCount; cy++) {
    const py = Math.min(h - 1, cy * step);
    const y0 = Math.max(0, py - half);
    const y1 = Math.min(h, py + half);
    for (let cx = 0; cx < cxCount; cx++) {
      const px = Math.min(w - 1, cx * step);
      const x0 = Math.max(0, px - half);
      const x1 = Math.min(w, px + half);
      const tH = y1 - y0;
      const tW = x1 - x0;
      const tile = new Float32Array(tH * tW);
      for (let y = 0; y < tH; y++) {
        const src = (y0 + y) * w + x0;
        tile.set(data.subarray(src, src + tW), y * tW);
      }
      const t = liThreshold({ data: tile, shape: [tH, tW] });
      grid[cy * cxCount + cx] = Number.isFinite(t) ? Math.max(t, floor) : globalLi;
    }
  }

  // 2. Bilinear interpolation to a per-pixel map.
  for (let y = 0; y < h; y++) {
    const fy = y / step;
    let cy0 = Math.floor(fy);
    if (cy0 < 0) cy0 = 0;
    if (cy0 > cyCount - 1) cy0 = cyCount - 1;
    let cy1 = cy0 + 1;
    if (cy1 > cyCount - 1) cy1 = cyCount - 1;
    const ty = cy1 === cy0 ? 0 : fy - cy0;
    for (let x = 0; x < w; x++) {
      const fx = x / step;
      let cx0 = Math.floor(fx);
      if (cx0 < 0) cx0 = 0;
      if (cx0 > cxCount - 1) cx0 = cxCount - 1;
      let cx1 = cx0 + 1;
      if (cx1 > cxCount - 1) cx1 = cxCount - 1;
      const tx = cx1 === cx0 ? 0 : fx - cx0;
      const t00 = grid[cy0 * cxCount + cx0]!;
      const t01 = grid[cy0 * cxCount + cx1]!;
      const t10 = grid[cy1 * cxCount + cx0]!;
      const t11 = grid[cy1 * cxCount + cx1]!;
      const t0 = t00 * (1 - tx) + t01 * tx;
      const t1 = t10 * (1 - tx) + t11 * tx;
      out[y * w + x] = t0 * (1 - ty) + t1 * ty;
    }
  }
  return out;
}

/**
 * Hysteresis variant where the high cutoff varies per pixel (e.g. from
 * a local-Li threshold map). Low cutoff at each pixel = `tHighMap[i] *
 * lowRatio`. Keeps a 4-connected component of (img > tLow) iff it
 * contains at least one pixel above its own tHigh.
 */
export function applyHysteresisThresholdMap(
  img: Image2D,
  tHighMap: Float32Array,
  lowRatio: number
): Uint8Array {
  const data = img.data;
  const n = data.length;
  const [h, w] = img.shape;
  const out = new Uint8Array(n);
  if (lowRatio >= 1.0 || lowRatio <= 0) {
    for (let i = 0; i < n; i++) out[i] = data[i]! > tHighMap[i]! ? 1 : 0;
    return out;
  }
  const labels = new Int32Array(n);
  const queue = new Int32Array(n);
  const componentHasSeed: boolean[] = [false];
  let label = 0;
  for (let seed = 0; seed < n; seed++) {
    if (labels[seed] || data[seed]! <= tHighMap[seed]! * lowRatio) continue;
    label++;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    labels[seed] = label;
    let hasSeed = data[seed]! > tHighMap[seed]!;
    while (head < tail) {
      const idx = queue[head++]!;
      const y = (idx / w) | 0;
      const x = idx - y * w;
      const neighbours: Array<[number, number]> = [
        [y - 1, x],
        [y + 1, x],
        [y, x - 1],
        [y, x + 1],
      ];
      for (const [yy, xx] of neighbours) {
        if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
        const j = yy * w + xx;
        if (!labels[j] && data[j]! > tHighMap[j]! * lowRatio) {
          labels[j] = label;
          if (data[j]! > tHighMap[j]!) hasSeed = true;
          queue[tail++] = j;
        }
      }
    }
    componentHasSeed.push(hasSeed);
  }
  for (let i = 0; i < n; i++) {
    if (labels[i] && componentHasSeed[labels[i]!]!) out[i] = 1;
  }
  return out;
}

/**
 * Hysteresis thresholding. A pixel is kept if it lies in a 4-connected
 * component of (img > tLow) that contains at least one pixel above
 * tHigh. Lets faint-but-contiguous segments survive when their global
 * Li threshold is dragged up by stronger ridges elsewhere in the frame.
 *
 * 4-connectivity matches skimage's `apply_hysteresis_threshold` default
 * and avoids bridging real ridges to diagonal noise specks (which would
 * fatten the resulting skeleton and inflate the junction count).
 *
 * tLow ≥ tHigh degenerates to plain `applyThreshold(img, tHigh)`.
 */
export function applyHysteresisThreshold(
  img: Image2D,
  tLow: number,
  tHigh: number
): Uint8Array {
  const data = img.data;
  const n = data.length;
  const [h, w] = img.shape;
  const out = new Uint8Array(n);
  if (tLow >= tHigh) {
    for (let i = 0; i < n; i++) out[i] = data[i]! > tHigh ? 1 : 0;
    return out;
  }
  const labels = new Int32Array(n);
  const queue = new Int32Array(n);
  const componentHasSeed: boolean[] = [false]; // labels start at 1
  let label = 0;
  for (let seed = 0; seed < n; seed++) {
    if (labels[seed] || data[seed]! <= tLow) continue;
    label++;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    labels[seed] = label;
    let hasSeed = data[seed]! > tHigh;
    while (head < tail) {
      const idx = queue[head++]!;
      const y = (idx / w) | 0;
      const x = idx - y * w;
      // 4-connected neighbours (N, S, W, E).
      const neighbours: Array<[number, number]> = [
        [y - 1, x],
        [y + 1, x],
        [y, x - 1],
        [y, x + 1],
      ];
      for (const [yy, xx] of neighbours) {
        if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
        const j = yy * w + xx;
        if (!labels[j] && data[j]! > tLow) {
          labels[j] = label;
          if (data[j]! > tHigh) hasSeed = true;
          queue[tail++] = j;
        }
      }
    }
    componentHasSeed.push(hasSeed);
  }
  for (let i = 0; i < n; i++) {
    if (labels[i] && componentHasSeed[labels[i]!]!) out[i] = 1;
  }
  return out;
}

/**
 * Remove connected components smaller than `minSize` pixels. 4-connected
 * (matches skimage's `remove_small_objects` default of `connectivity=1`).
 * In-place on the binary mask.
 *
 * The previous 8-connected version kept many diagonal-only components
 * (single-pixel chains) that should be dropped — they're a major
 * source of spurious filaments downstream.
 */
export function removeSmallObjects(mask: Uint8Array, w: number, h: number, minSize: number): void {
  const labels = new Int32Array(mask.length);
  const sizes: number[] = [0]; // labels start at 1

  const queue = new Int32Array(mask.length);
  let label = 0;
  // 4-connected neighbour offsets.
  const D4 = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;
    label++;
    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    labels[i] = label;
    let size = 0;
    while (head < tail) {
      const idx = queue[head++]!;
      size++;
      const y = (idx / w) | 0;
      const x = idx - y * w;
      for (const [dy, dx] of D4) {
        const yy = y + dy!;
        if (yy < 0 || yy >= h) continue;
        const xx = x + dx!;
        if (xx < 0 || xx >= w) continue;
        const j = yy * w + xx;
        if (mask[j] && !labels[j]) {
          labels[j] = label;
          queue[tail++] = j;
        }
      }
    }
    sizes.push(size);
  }

  // skimage 0.26+ removes objects with size *<= min_size* (was `<`).
  // Same here: a min_size=30 call drops 30-pixel components.
  for (let i = 0; i < mask.length; i++) {
    if (labels[i] && sizes[labels[i]!]! <= minSize) mask[i] = 0;
  }
}
