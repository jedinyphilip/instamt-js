import type { Stack3D } from '../types';
import type { Track } from './track';

/**
 * Sub-pixel FWHM of a downward-dip intensity profile (MT cross-section
 * in IRM). Returns null if the dip is too shallow or doesn't cross the
 * half-depth threshold cleanly. Mirrors `_fwhm_dip` from Python.
 */
function fwhmDip(profile: Float64Array): number | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < profile.length; i++) {
    const v = profile[i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi - lo < 5.0) return null;
  const half = (lo + hi) / 2;
  // Find first / last indices below half-depth.
  let li = -1;
  let ri = -1;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i]! < half) {
      li = i;
      break;
    }
  }
  for (let i = profile.length - 1; i >= 0; i--) {
    if (profile[i]! < half) {
      ri = i;
      break;
    }
  }
  if (li < 0 || ri < 0 || ri - li < 1) return null;
  // Sub-pixel crossings via linear interp.
  let leftX: number;
  if (li > 0 && Math.abs(profile[li]! - profile[li - 1]!) > 1e-9) {
    leftX = li - 1 + (half - profile[li - 1]!) / (profile[li]! - profile[li - 1]!);
  } else {
    leftX = li;
  }
  let rightX: number;
  if (ri < profile.length - 1 && Math.abs(profile[ri + 1]! - profile[ri]!) > 1e-9) {
    rightX = ri + (half - profile[ri]!) / (profile[ri + 1]! - profile[ri]!);
  } else {
    rightX = ri;
  }
  return rightX - leftX;
}

/**
 * Median FWHM of MT cross-section profiles, in pixels. Samples
 * perpendicular profiles every `everyN` arc pixels for every track in
 * every frame, fits sub-pixel FWHM, returns the median.
 *
 * Used to convert px → µm via `mtWidthUm / measuredFwhm` so the
 * reported lengths and speeds are calibrated without prior knowledge
 * of the camera pixel size.
 */
export function measureAvgFwhmPx(
  tracks: Track[],
  irmStack: Stack3D,
  halfWidth = 10,
  everyN = 5
): number | null {
  const [, H, W] = irmStack.shape;
  const stride = H * W;
  const fwhms: number[] = [];

  for (const tr of tracks) {
    for (let fi = 0; fi < tr.frames.length; fi++) {
      const t = tr.frames[fi]!;
      const arc = tr.arcs[fi]!;
      const n = arc.length / 2;
      if (n < 4) continue;
      const frame = irmStack.data.subarray(t * stride, (t + 1) * stride);

      for (let i = 2; i < n - 2; i += everyN) {
        const yPrev = arc[(i - 1) * 2]!;
        const xPrev = arc[(i - 1) * 2 + 1]!;
        const yNext = arc[(i + 1) * 2]!;
        const xNext = arc[(i + 1) * 2 + 1]!;
        const ty = yNext - yPrev;
        const tx = xNext - xPrev;
        const norm = Math.hypot(ty, tx);
        if (norm < 1e-6) continue;
        const py = -tx / norm;
        const px = ty / norm;

        const profile = new Float64Array(2 * halfWidth + 1);
        const cy = arc[i * 2]!;
        const cx = arc[i * 2 + 1]!;
        for (let k = -halfWidth; k <= halfWidth; k++) {
          const sy = cy + k * py;
          const sx = cx + k * px;
          profile[k + halfWidth] = bilinearSample(frame, H, W, sy, sx);
        }
        const w = fwhmDip(profile);
        if (w !== null && w >= 1.0 && w <= 2 * halfWidth) fwhms.push(w);
      }
    }
  }
  if (fwhms.length === 0) return null;
  fwhms.sort((a, b) => a - b);
  const m = fwhms.length >>> 1;
  return fwhms.length % 2 === 0 ? (fwhms[m - 1]! + fwhms[m]!) / 2 : fwhms[m]!;
}

/** Bilinear sampling with scipy 'nearest' boundary (clamp to edge). */
function bilinearSample(
  frame: Float32Array,
  H: number,
  W: number,
  y: number,
  x: number
): number {
  // 'nearest' mode: clamp to [0, H-1] and [0, W-1].
  const yc = Math.max(0, Math.min(H - 1, y));
  const xc = Math.max(0, Math.min(W - 1, x));
  const y0 = Math.floor(yc);
  const x0 = Math.floor(xc);
  const y1 = Math.min(H - 1, y0 + 1);
  const x1 = Math.min(W - 1, x0 + 1);
  const fy = yc - y0;
  const fx = xc - x0;
  const v00 = frame[y0 * W + x0]!;
  const v01 = frame[y0 * W + x1]!;
  const v10 = frame[y1 * W + x0]!;
  const v11 = frame[y1 * W + x1]!;
  return v00 * (1 - fx) * (1 - fy) + v01 * fx * (1 - fy) + v10 * (1 - fx) * fy + v11 * fx * fy;
}
