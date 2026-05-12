import { gaussianFilter2d } from '../filters/gaussian';
import { medianFilter2d } from '../filters/median';
import type { Image2D } from '../types';

/**
 * Fringe unification. Mirrors `src/fringe.py:unify_fringes` byte-for-byte:
 *   1. Pre-smooth with σ=`preSmooth` Gaussian (default 1.0).
 *   2. Build a uint8-quantised view of the smoothed image (np.clip
 *      then .astype(np.uint8) — TRUNCATION, not round).
 *   3. Local baseline = `skimage.filters.rank.median` on that uint8
 *      view with a square window. We approximate rank.median with our
 *      Float32 medianFilter2d acting on the truncated values; for a
 *      square window of integer values the histogram-based median and
 *      a quickselect median return the same answer (both pick the
 *      same rank-position element).
 *   4. deviation = (original Float32) smoothed − baseline.
 *   5. result = baseline − |deviation| × boost  (mirror down)
 *   6. clip to [0, 255]
 *
 * Skipping the uint8 truncation here and using the clipped-but-not-
 * truncated Float32 in the deviation step shifts both the baseline
 * and the deviation by sub-grey-level amounts, which is enough to
 * visibly distort the cleanup output.
 */
export function fringeUnify(img: Image2D, windowSize = 41, boost = 1.3, preSmooth = 1.0): Image2D {
  const smoothed = preSmooth > 0 ? gaussianFilter2d(img, preSmooth) : img;
  // uint8 view (clip + truncate) — input to the median, matching
  // `np.clip(smoothed, 0, 255).astype(np.uint8)`.
  const u8 = new Float32Array(smoothed.data.length);
  for (let i = 0; i < smoothed.data.length; i++) {
    const v = smoothed.data[i]!;
    u8[i] = v < 0 ? 0 : v > 255 ? 255 : Math.floor(v);
  }
  const baseline = medianFilter2d({ data: u8, shape: img.shape }, windowSize);

  // Deviation uses the ORIGINAL Float32 smoothed, not the truncated
  // uint8 view — the latter loses sub-grey-level detail.
  const out = new Float32Array(img.data.length);
  for (let i = 0; i < img.data.length; i++) {
    const dev = smoothed.data[i]! - baseline.data[i]!;
    const r = baseline.data[i]! - Math.abs(dev) * boost;
    out[i] = r < 0 ? 0 : r > 255 ? 255 : r;
  }
  return { data: out, shape: img.shape };
}
