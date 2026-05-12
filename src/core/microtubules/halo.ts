/**
 * Halo filter. Dust on the coverslip shows up as a dark blob with a
 * bright interference halo; the halo reads as a clean Meijering ridge
 * and gets walked into a closed-ish arc that tracks across frames.
 *
 * `findHaloDots` locates the dark blobs per frame (dust drifts, so a
 * single-frame snapshot misses some). `isHaloTrack` then asks, frame
 * by frame, whether a track's arc sits inside the halo band of any
 * dot detected in that frame.
 *
 * Shape gate is PCA-eigenvalue aspect ratio, not 4πA/P² compactness:
 * the latter under-scores even perfect digital discs (≈ 0.4 for r=4
 * with a bbox-perimeter approximation) and the gate silently fails.
 * The size gate is on absolute bbox dimensions vs. MT width — "dust
 * is wider AND taller than an MT" is the actual signal.
 */

import type { Image2D } from '../types';
import type { Track } from './track';

export interface HaloFilterConfig {
  /**
   * Pixel-intensity threshold (0–255) below which a pixel counts as
   * a dust-dot candidate. The cleaned IRM is stack-normalised to
   * [0, 255]; dust centres typically sit near 0. Set to 0 to disable
   * the filter entirely.
   */
  darkThreshold: number;
  /**
   * Minimum bbox dimension (px) — BOTH width AND height must exceed
   * this for a dark blob to qualify as a dust dot. Should be a few
   * times the apparent MT ridge width (≈ 3–5 px), so an MT segment
   * never makes it past on its short axis. Default 5.
   */
  minDotDimPx: number;
  /**
   * Maximum bbox dimension (px) — larger dark regions (cells, big
   * debris, image edges) are not dust. Default 40.
   */
  maxDotDimPx: number;
  /**
   * Minimum PCA-eigenvalue aspect ratio √(λ_small / λ_large) of the
   * component's pixel distribution. 1.0 = isotropic (perfect disc /
   * square / blob), 0 = perfectly linear. Default 0.7. PCA is
   * preferred over bbox aspect because a + / T / L shape can have
   * bbox aspect 1.0 while its eigenvalue ratio is < 0.5.
   */
  minAspectRatio: number;
  /**
   * Halo band inner margin (px). A track point at distance `d` from
   * a dot centre counts as "on the halo" if d ≥ dot_radius − this.
   * Default 3.
   */
  haloInnerMarginPx: number;
  /**
   * Halo band outer margin (px). A track point counts as "on the
   * halo" if d ≤ dot_radius + this. The bright IRM halo typically
   * extends ~10 px outside the dust perimeter. Default 10.
   */
  haloOuterMarginPx: number;
  /**
   * Per-frame: fraction of arc points that must lie in the halo
   * band of any dust dot detected in that frame for the frame to
   * count as halo-following. Default 0.6.
   */
  minPerFrameHaloFraction: number;
  /**
   * Per-track: fraction of frames classified halo-following for the
   * whole track to be dropped. Default 0.5.
   */
  minTrackHaloFraction: number;
}

export const DEFAULT_HALO_FILTER: HaloFilterConfig = {
  darkThreshold: 60,
  minDotDimPx: 5,
  maxDotDimPx: 40,
  minAspectRatio: 0.7,
  haloInnerMarginPx: 3,
  haloOuterMarginPx: 10,
  minPerFrameHaloFraction: 0.6,
  minTrackHaloFraction: 0.5,
};

export interface HaloDot {
  cy: number;
  cx: number;
  /** Effective radius for the halo band — max bbox half-extent. */
  r: number;
}

/**
 * Find dark, roughly-isotropic blobs in one frame of cleaned IRM.
 * Returns one entry per accepted dust dot; pass through `isHaloTrack`
 * with a parallel list of per-frame dots to filter halo-following
 * tracks.
 */
export function findHaloDots(image: Image2D, cfg: HaloFilterConfig): HaloDot[] {
  if (cfg.darkThreshold <= 0) return [];
  const [h, w] = image.shape;
  const N = w * h;

  // Dark-pixel mask.
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (image.data[i]! < cfg.darkThreshold) mask[i] = 1;
  }

  const labels = new Int32Array(N);
  const stack: number[] = [];
  const dots: HaloDot[] = [];
  // Abort runaway flood fills (cells, image-edge dark regions).
  const maxArea = cfg.maxDotDimPx * cfg.maxDotDimPx * 4;
  let nextLabel = 0;

  for (let p0 = 0; p0 < N; p0++) {
    if (!mask[p0] || labels[p0] !== 0) continue;
    nextLabel++;
    labels[p0] = nextLabel;
    stack.length = 0;
    stack.push(p0);
    let area = 0;
    let sumY = 0;
    let sumX = 0;
    let sumYY = 0;
    let sumXX = 0;
    let sumYX = 0;
    let y0 = h;
    let y1 = -1;
    let x0 = w;
    let x1 = -1;
    let blew = false;
    while (stack.length > 0) {
      const p = stack.pop()!;
      area++;
      const y = (p / w) | 0;
      const x = p - y * w;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      sumY += y;
      sumX += x;
      sumYY += y * y;
      sumXX += x * x;
      sumYX += y * x;
      if (area > maxArea) {
        blew = true;
        break;
      }
      if (y > 0) {
        const np = p - w;
        if (mask[np] && labels[np] === 0) {
          labels[np] = nextLabel;
          stack.push(np);
        }
      }
      if (y < h - 1) {
        const np = p + w;
        if (mask[np] && labels[np] === 0) {
          labels[np] = nextLabel;
          stack.push(np);
        }
      }
      if (x > 0) {
        const np = p - 1;
        if (mask[np] && labels[np] === 0) {
          labels[np] = nextLabel;
          stack.push(np);
        }
      }
      if (x < w - 1) {
        const np = p + 1;
        if (mask[np] && labels[np] === 0) {
          labels[np] = nextLabel;
          stack.push(np);
        }
      }
    }
    if (blew) continue;
    const dh = y1 - y0 + 1;
    const dw = x1 - x0 + 1;
    if (dh < cfg.minDotDimPx || dw < cfg.minDotDimPx) continue;
    if (dh > cfg.maxDotDimPx || dw > cfg.maxDotDimPx) continue;

    // PCA on the pixel coords — eigenvalue ratio = squared aspect.
    const cy = sumY / area;
    const cx = sumX / area;
    const syy = sumYY / area - cy * cy;
    const sxx = sumXX / area - cx * cx;
    const syx = sumYX / area - cy * cx;
    const tr = syy + sxx;
    const det = syy * sxx - syx * syx;
    const disc = Math.max(0, (tr * tr) / 4 - det);
    const lamLarge = tr / 2 + Math.sqrt(disc);
    const lamSmall = tr / 2 - Math.sqrt(disc);
    if (lamLarge < 1e-9) continue;
    const aspect = Math.sqrt(Math.max(0, lamSmall) / lamLarge);
    if (aspect < cfg.minAspectRatio) continue;

    const r = Math.max(dh, dw) / 2;
    dots.push({ cy, cx, r });
  }
  return dots;
}

/**
 * True iff `track` predominantly follows the halo of a dust dot
 * detected on the corresponding frame. `dotsPerFrame[t]` must be the
 * dot list produced by `findHaloDots` on frame `t`. Per-frame
 * indexing is required because dust drifts — the halo a track
 * follows in frame 0 may not be at the same (cy, cx) in frame 50.
 */
export function isHaloTrack(
  track: Track,
  dotsPerFrame: readonly (readonly HaloDot[])[],
  cfg: HaloFilterConfig
): boolean {
  let totalFrames = 0;
  let haloFrames = 0;
  for (let i = 0; i < track.arcs.length; i++) {
    const arc = track.arcs[i]!;
    const ft = track.frames[i]!;
    const n = arc.length / 2;
    if (n < 2) continue;
    totalFrames++;
    const dots = dotsPerFrame[ft];
    if (!dots || dots.length === 0) continue;
    let bestFraction = 0;
    for (const d of dots) {
      const rLo = d.r - cfg.haloInnerMarginPx;
      const rHi = d.r + cfg.haloOuterMarginPx;
      let inHalo = 0;
      for (let k = 0; k < n; k++) {
        const dy = arc[k * 2]! - d.cy;
        const dx = arc[k * 2 + 1]! - d.cx;
        const dist = Math.hypot(dy, dx);
        if (dist >= rLo && dist <= rHi) inHalo++;
      }
      const f = inHalo / n;
      if (f > bestFraction) bestFraction = f;
    }
    if (bestFraction >= cfg.minPerFrameHaloFraction) haloFrames++;
  }
  if (totalFrames === 0) return false;
  return haloFrames / totalFrames >= cfg.minTrackHaloFraction;
}
