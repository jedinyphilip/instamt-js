import { reverseArc } from './arc';
import type { Track } from './track';

/**
 * Compare the variance of arc[0] and arc[-1] across the track and
 * flip every arc so the lower-variance (stable, "minus") end is at
 * index 0. Mirrors `orient_track_to_seed`.
 */
export function orientTrackToSeed(track: Track, anchor: 'minus' | 'plus' = 'minus'): Track {
  if (track.arcs.length < 2) return track;
  const starts: Array<[number, number]> = [];
  const ends: Array<[number, number]> = [];
  for (const a of track.arcs) {
    if (a.length < 2) continue;
    starts.push([a[0]!, a[1]!]);
    ends.push([a[a.length - 2]!, a[a.length - 1]!]);
  }
  const vStart = pointVariance(starts);
  const vEnd = pointVariance(ends);
  const flip = anchor === 'minus' ? vEnd < vStart : vStart < vEnd;
  if (!flip) return track;
  return {
    id: track.id,
    frames: track.frames,
    arcs: track.arcs.map((a) => reverseArc(a)),
  };
}

function pointVariance(pts: Array<[number, number]>): number {
  if (pts.length === 0) return 0;
  let my = 0;
  let mx = 0;
  for (const [y, x] of pts) {
    my += y;
    mx += x;
  }
  my /= pts.length;
  mx /= pts.length;
  let s = 0;
  for (const [y, x] of pts) {
    const dy = y - my;
    const dx = x - mx;
    s += dy * dy + dx * dx;
  }
  return s / pts.length;
}

/**
 * Per-track temporal Gaussian smoothing. Each arc is resampled at
 * 1-px steps, padded with NaN to the longest frame's length, then
 * Gaussian-smoothed along the time axis (NaN-aware so tips don't
 * blur in from short frames). Mirrors the Python `smooth_track_temporal`.
 *
 * Samples are aligned by arc-length index from the minus end, not
 * by spatial position. When the minus-end pixel jitters or the MT
 * shape evolves across the smoothing window, the index-averaged
 * point drifts off the current frame's ridge. `maxDeltaPx` caps each
 * smoothed sample's displacement from its raw position (Infinity =
 * no cap, recovers the original behaviour).
 */
export function smoothTrackTemporal(
  track: Track,
  sigmaT: number,
  maxDeltaPx: number = Infinity
): Track {
  if (sigmaT <= 0 || track.arcs.length < 3) return track;

  const T = track.arcs.length;
  // Resample each arc at 1-px steps along its own arc length.
  const resampled: Array<{ y: Float32Array; x: Float32Array; n: number }> = [];
  let maxN = 0;
  for (const arc of track.arcs) {
    const r = resampleArc(arc, 1.0);
    resampled.push(r);
    if (r.n > maxN) maxN = r.n;
  }
  if (maxN < 2) return track;

  // Pad each row with NaN to maxN.
  const Y = new Float32Array(T * maxN);
  const X = new Float32Array(T * maxN);
  const W = new Float32Array(T * maxN); // 1 where valid, 0 where NaN
  for (let i = 0; i < T; i++) {
    const r = resampled[i]!;
    for (let k = 0; k < r.n; k++) {
      Y[i * maxN + k] = r.y[k]!;
      X[i * maxN + k] = r.x[k]!;
      W[i * maxN + k] = 1;
    }
  }

  // NaN-aware 1-D Gaussian along the time axis. Build the kernel once.
  const radius = Math.max(1, Math.round(4 * sigmaT));
  const kernel = new Float32Array(2 * radius + 1);
  let kSum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigmaT * sigmaT));
    kernel[i + radius] = v;
    kSum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] = kernel[i]! / kSum;

  const smY = new Float32Array(T * maxN);
  const smX = new Float32Array(T * maxN);
  for (let k = 0; k < maxN; k++) {
    for (let t = 0; t < T; t++) {
      let nY = 0;
      let nX = 0;
      let dW = 0;
      for (let q = -radius; q <= radius; q++) {
        let tt = t + q;
        if (tt < 0) tt = 0;
        else if (tt >= T) tt = T - 1;
        const wt = W[tt * maxN + k]! * kernel[q + radius]!;
        nY += Y[tt * maxN + k]! * wt;
        nX += X[tt * maxN + k]! * wt;
        dW += wt;
      }
      smY[t * maxN + k] = dW > 1e-9 ? nY / dW : Y[t * maxN + k]!;
      smX[t * maxN + k] = dW > 1e-9 ? nX / dW : X[t * maxN + k]!;
    }
  }

  // Reconstruct each frame's arc using only the valid (non-padded)
  // part. Cap each smoothed sample's displacement from the raw
  // resampled position to `maxDeltaPx` so the smoothed arc cannot
  // drift far from the current frame's IRM ridge even when the
  // smoothing window contains arcs with substantially different
  // geometry / minus-end position.
  const capEnabled = Number.isFinite(maxDeltaPx) && maxDeltaPx >= 0;
  const newArcs = track.arcs.map((_, i) => {
    const n = resampled[i]!.n;
    const out = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) {
      let sy = smY[i * maxN + k]!;
      let sx = smX[i * maxN + k]!;
      if (capEnabled) {
        const ry = Y[i * maxN + k]!;
        const rx = X[i * maxN + k]!;
        const dy = sy - ry;
        const dx = sx - rx;
        const d = Math.hypot(dy, dx);
        if (d > maxDeltaPx) {
          const s = maxDeltaPx / d;
          sy = ry + dy * s;
          sx = rx + dx * s;
        }
      }
      out[k * 2] = sy;
      out[k * 2 + 1] = sx;
    }
    return out;
  });

  return { id: track.id, frames: track.frames, arcs: newArcs };
}

function resampleArc(arc: Float32Array, step: number): { y: Float32Array; x: Float32Array; n: number } {
  const n = arc.length / 2;
  if (n < 2) {
    return { y: new Float32Array([arc[0] ?? 0]), x: new Float32Array([arc[1] ?? 0]), n: 1 };
  }
  // Cumulative arc length at each input point.
  const cum = new Float32Array(n);
  cum[0] = 0;
  for (let i = 1; i < n; i++) {
    const dy = arc[i * 2]! - arc[(i - 1) * 2]!;
    const dx = arc[i * 2 + 1]! - arc[(i - 1) * 2 + 1]!;
    cum[i] = cum[i - 1]! + Math.hypot(dy, dx);
  }
  const L = cum[n - 1]!;
  if (L < 1e-6) {
    return { y: new Float32Array([arc[0]!]), x: new Float32Array([arc[1]!]), n: 1 };
  }
  const m = Math.max(2, Math.floor(L / step) + 1);
  const y = new Float32Array(m);
  const x = new Float32Array(m);
  let j = 0;
  for (let k = 0; k < m; k++) {
    const s = (k * L) / (m - 1);
    while (j < n - 2 && cum[j + 1]! < s) j++;
    const c0 = cum[j]!;
    const c1 = cum[j + 1]!;
    const u = c1 - c0 < 1e-9 ? 0 : (s - c0) / (c1 - c0);
    y[k] = arc[j * 2]! + u * (arc[(j + 1) * 2]! - arc[j * 2]!);
    x[k] = arc[j * 2 + 1]! + u * (arc[(j + 1) * 2 + 1]! - arc[j * 2 + 1]!);
  }
  return { y, x, n: m };
}
