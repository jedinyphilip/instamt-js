/**
 * Auto-detect the apparent MT cross-section scale (in pixels) from a
 * representative cleaned frame.
 *
 * The Hessian eigenvalue magnitude of a Gaussian-blurred dark ridge of
 * half-width `w` peaks (under γ-normalisation σ²) at σ ≈ w. So if we
 * sweep σ and measure the γ-normalised peak Hessian response, the σ
 * that maximises it gives us the dominant ridge scale.
 *
 * From that we derive a scale factor: the default detection config is
 * tuned for σ ≈ 1.5 px (mid of `[1.0, 1.5, 2.0]`); a probe σ of 3 px
 * means MTs appear ~2× thicker than default and we should multiply
 * sigmas, lengths, and gaps by 2.
 */

import { hessianEigenvaluesAbs } from '../filters/hessian';
import type { Image2D, Shape2D } from '../types';
import type { DetectConfig } from './detect';

export interface ScaleProbeResult {
  /** Estimated dominant ridge σ in pixels. */
  peakSigma: number;
  /** Multiplicative factor relative to the default reference σ=1.5. */
  scale: number;
  /** Per-σ γ-normalised peak response, for diagnostic logging. */
  perSigma: Array<{ sigma: number; score: number }>;
}

const DEFAULT_REFERENCE_SIGMA = 1.5;

const DEFAULT_PROBE_SIGMAS: readonly number[] = [
  0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0,
];

/** Centre-crop an image to at most `maxSide × maxSide`. Cheaper to
 *  probe than the full frame; ridge content is usually present near
 *  the centre and the periphery often has FFT-bg residual. */
export function cropCenter(img: Image2D, maxSide: number): Image2D {
  const [H, W] = img.shape;
  if (H <= maxSide && W <= maxSide) return img;
  const side = Math.min(maxSide, Math.min(H, W));
  const y0 = Math.max(0, Math.floor((H - side) / 2));
  const x0 = Math.max(0, Math.floor((W - side) / 2));
  const out = new Float32Array(side * side);
  for (let y = 0; y < side; y++) {
    const src = (y0 + y) * W + x0;
    out.set(img.data.subarray(src, src + side), y * side);
  }
  const shape: Shape2D = [side, side];
  return { data: out, shape };
}

/** Run the scale probe on `img`. Returns the σ that maximises the
 *  γ-normalised peak Hessian response, plus the implied scale factor.
 *
 *  γ-normalisation here means multiplying the Hessian eigenvalue by σ²
 *  before comparing across scales; this makes responses commensurate
 *  with each other (Lindeberg, "Feature detection with automatic scale
 *  selection" 1998).
 *
 *  Peak-σ selection: the raw argmax over a γ-normalised response curve
 *  is biased toward larger σ when the response plateaus (e.g. when the
 *  scene has broad-scale structure on top of MTs). To prefer the true
 *  ridge scale we pick the SMALLEST σ whose response is within
 *  `peakTolerance` of the global peak. */
export function probeMtScale(
  img: Image2D,
  sigmas: readonly number[] = DEFAULT_PROBE_SIGMAS,
  referenceSigma: number = DEFAULT_REFERENCE_SIGMA,
  peakTolerance = 0.05
): ScaleProbeResult {
  const perSigma: Array<{ sigma: number; score: number }> = [];
  let peakScore = -Infinity;
  for (const sigma of sigmas) {
    const eig = hessianEigenvaluesAbs(img, sigma);
    // hessianEigenvaluesAbs returns ascending |·|; e2 has the larger
    // magnitude, which is what's diagnostic for ridges.
    const e = eig.e2;
    const norm = sigma * sigma;
    // 99th percentile of γ-normalised |e_max|.
    const score = approxPercentile(e, norm, 0.99);
    perSigma.push({ sigma, score });
    if (score > peakScore) peakScore = score;
  }
  const threshold = peakScore * (1 - peakTolerance);
  let peakSigma = referenceSigma;
  for (const { sigma, score } of perSigma) {
    if (score >= threshold) {
      peakSigma = sigma;
      break;
    }
  }
  return {
    peakSigma,
    scale: peakSigma / referenceSigma,
    perSigma,
  };
}

/** Histogram-based percentile of `mult * |arr[i]|`. Avoids a full
 *  Float32 sort for million-pixel inputs. */
function approxPercentile(arr: Float32Array, mult: number, frac: number): number {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = mult * Math.abs(arr[i]!);
    if (Number.isFinite(v)) {
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  }
  if (!Number.isFinite(mn) || mn === mx) return Number.isFinite(mn) ? mn : 0;
  const bins = 1024;
  const counts = new Uint32Array(bins);
  const span = mx - mn;
  let n = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = mult * Math.abs(arr[i]!);
    if (!Number.isFinite(v)) continue;
    let b = Math.floor(((v - mn) / span) * bins);
    if (b < 0) b = 0;
    else if (b >= bins) b = bins - 1;
    counts[b]!++;
    n++;
  }
  const target = Math.floor(frac * n);
  let cum = 0;
  for (let b = 0; b < bins; b++) {
    cum += counts[b]!;
    if (cum >= target) return mn + (b / bins) * span;
  }
  return mx;
}

/** Apply a multiplicative scale to the pixel-tied detect params.
 *
 *  What scales with apparent MT width (σ) and what doesn't:
 *   - sigmas:          scale (Meijering needs σ matched to MT width).
 *   - maxJunctionGap, junctionMergeRadius: scale (junction features
 *     widen with MT width).
 *   - minObjectSize:   scale LINEARLY, not σ² — mask area for a fixed
 *     minimum length grows as width × length, so doubling the width
 *     doubles the mask area for that same length. Squaring overcounts
 *     and drops short-but-thick MTs.
 *   - minArcLength:    DO NOT scale — this is a skeleton-length
 *     threshold in absolute pixels, purely topological. Scaling it
 *     drops legitimate arcs that happen to be short, which fragments
 *     curving MTs at crossings.
 */
export function scaleDetectConfig(base: DetectConfig, scale: number): DetectConfig {
  // Sigmas: scale all of them; round to 1 decimal so logs stay readable.
  const sigmas = base.sigmas.map((s) => Math.max(0.5, round1(s * scale)));
  return {
    ...base,
    sigmas,
    minArcLength: base.minArcLength,
    maxJunctionGap: Math.max(1, round1(base.maxJunctionGap * scale)),
    junctionMergeRadius: Math.max(1, round1(base.junctionMergeRadius * scale)),
    minObjectSize: Math.max(4, Math.round(base.minObjectSize * scale)),
    // Local-Li tile scales linearly with apparent MT thickness so each
    // tile still contains a representative mix of ridge + background.
    localThresholdTile:
      base.localThresholdTile == null
        ? null
        : Math.max(32, Math.round(base.localThresholdTile * scale)),
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
