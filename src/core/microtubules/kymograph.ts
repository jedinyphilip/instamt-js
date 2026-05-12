import type { Image2D, Stack3D } from '../types';
import { arcLength, type Arc } from './arc';
import type { Track } from './track';

export interface KymographResult {
  /** (T, L) cleaned-IRM intensity sampled along the per-frame arc,
   *  in the same units as the input frame (Float32 ~[0, 255]). Named
   *  `irmMask` for historical reasons — it used to carry a binary
   *  presence mask, but that conveyed less information than the
   *  fluor panel and made the two kymograph rows visually mismatch
   *  even when the underlying detection was correct. */
  irmMask: Image2D;
  /** (T, L) sampled fluor intensity. */
  fluor: Image2D;
  /** Per-frame "did the lineage exist this frame" flag, length T. */
  framesPresent: Uint8Array;
  /** First frame index in the lineage's window. */
  fMin: number;
  /** Reference arc (longest single arc in the lineage). */
  refArc: Arc;
}

/**
 * Build a (T × L) kymograph for a lineage. Mirrors the Python
 * `build_lineage_kymograph` exactly, including:
 *   - Singleton lineages: each frame's arc sampled directly with
 *     seed at column 0; the IRM mask covers [0, chord(arc_t)].
 *   - Multi-member lineages: a reference geometry (the longest arc the
 *     lineage ever had) defines the column axis. For each frame's
 *     active members, the member's endpoints are projected onto the
 *     reference to get a column range [col_lo, col_hi]; fluor inside
 *     that range is sampled along the MEMBER's arc, mapping
 *     arc-length 0..L_member into col_lo..col_hi. Off-member columns
 *     stay at 0 in both kymographs.
 */
export function buildLineageKymograph(
  members: Track[],
  irm: Stack3D,
  fluor: Stack3D,
  thickness = 2,
  step = 1.0
): KymographResult | null {
  const refArc = pickReferenceArc(members);
  if (!refArc || refArc.length < 4) return null;
  const Lmax = arcLength(refArc);
  if (Lmax < 1e-6) return null;
  const nSamples = Math.max(8, Math.ceil(Lmax / step) + 1);

  const allFrames = new Set<number>();
  for (const m of members) for (const f of m.frames) allFrames.add(f);
  const sortedFrames = [...allFrames].sort((a, b) => a - b);
  const fMin = sortedFrames[0]!;
  const fMax = sortedFrames[sortedFrames.length - 1]!;
  const nFrames = fMax - fMin + 1;

  const irmKymo = new Float32Array(nFrames * nSamples);
  const fluorKymo = new Float32Array(nFrames * nSamples);
  const framesPresent = new Uint8Array(nFrames);

  const [, h, w] = irm.shape;
  const stride = h * w;

  if (members.length === 1) {
    // Singleton path: sample IRM + fluor along the per-frame arc
    // directly, seed end at column 0. Both channels go through the
    // same `sampleAlongExtended` so the IRM panel and the fluor
    // panel cover identical (T, L) and use identical arc geometry
    // — they only differ in what frame data they pull from.
    const tr = members[0]!;
    for (let i = 0; i < tr.frames.length; i++) {
      const f = tr.frames[i]!;
      const arc = tr.arcs[i]!;
      const row = f - fMin;
      framesPresent[row] = 1;
      const irmFrame = irm.data.subarray(f * stride, (f + 1) * stride);
      const fluorFrame = fluor.data.subarray(f * stride, (f + 1) * stride);
      const sampledIrm = sampleAlongExtended(arc, irmFrame, h, w, thickness, nSamples, step);
      const sampledFluor = sampleAlongExtended(arc, fluorFrame, h, w, thickness, nSamples, step);
      for (let c = 0; c < nSamples; c++) {
        irmKymo[row * nSamples + c] = sampledIrm[c]!;
        fluorKymo[row * nSamples + c] = sampledFluor[c]!;
      }
    }
  } else {
    // Multi-member: project onto the reference arc.
    const refN = refArc.length / 2;
    const refY = new Float64Array(refN);
    const refX = new Float64Array(refN);
    for (let k = 0; k < refN; k++) {
      refY[k] = refArc[2 * k]!;
      refX[k] = refArc[2 * k + 1]!;
    }
    const refCum = new Float64Array(refN);
    for (let k = 1; k < refN; k++) {
      const dy = refY[k]! - refY[k - 1]!;
      const dx = refX[k]! - refX[k - 1]!;
      refCum[k] = refCum[k - 1]! + Math.hypot(dy, dx);
    }

    for (const tr of members) {
      for (let i = 0; i < tr.frames.length; i++) {
        const f = tr.frames[i]!;
        const arc = tr.arcs[i]!;
        const row = f - fMin;
        framesPresent[row] = 1;

        // Find the closest reference index for each member endpoint.
        let idx0 = 0, idx1 = 0;
        let best0 = Infinity, best1 = Infinity;
        const a0y = arc[0]!, a0x = arc[1]!;
        const a1y = arc[arc.length - 2]!, a1x = arc[arc.length - 1]!;
        for (let k = 0; k < refN; k++) {
          const d0 = Math.hypot(refY[k]! - a0y, refX[k]! - a0x);
          const d1 = Math.hypot(refY[k]! - a1y, refX[k]! - a1x);
          if (d0 < best0) {
            best0 = d0;
            idx0 = k;
          }
          if (d1 < best1) {
            best1 = d1;
            idx1 = k;
          }
        }

        const d0 = refCum[idx0]!;
        const d1 = refCum[idx1]!;
        const arcForSampling = d0 <= d1 ? arc : reverseArc(arc);
        const dLo = Math.min(d0, d1);
        const dHi = Math.max(d0, d1);
        const colLo = Math.max(0, Math.round(dLo / step));
        const colHi = Math.min(nSamples - 1, Math.round(dHi / step));
        const nIn = colHi - colLo + 1;
        if (nIn < 2) continue;

        const irmFrame = irm.data.subarray(f * stride, (f + 1) * stride);
        const fluorFrame = fluor.data.subarray(f * stride, (f + 1) * stride);
        const sampledIrm = sampleAlongExtended(arcForSampling, irmFrame, h, w, thickness, nIn, step);
        const sampledFluor = sampleAlongExtended(arcForSampling, fluorFrame, h, w, thickness, nIn, step);
        for (let c = colLo; c <= colHi; c++) {
          irmKymo[row * nSamples + c] = sampledIrm[c - colLo]!;
          fluorKymo[row * nSamples + c] = sampledFluor[c - colLo]!;
        }
      }
    }
  }

  return {
    irmMask: { data: irmKymo, shape: [nFrames, nSamples] },
    fluor: { data: fluorKymo, shape: [nFrames, nSamples] },
    framesPresent,
    fMin,
    refArc,
  };
}

function pickReferenceArc(members: Track[]): Arc | null {
  let best: Arc | null = null;
  let bestL = -1;
  for (const m of members) {
    for (const a of m.arcs) {
      const l = arcLength(a);
      if (l > bestL) {
        bestL = l;
        best = a;
      }
    }
  }
  return best;
}

function reverseArc(arc: Arc): Arc {
  const n = arc.length / 2;
  const out = new Float32Array(arc.length);
  for (let i = 0; i < n; i++) {
    out[i * 2] = arc[(n - 1 - i) * 2]!;
    out[i * 2 + 1] = arc[(n - 1 - i) * 2 + 1]!;
  }
  return out;
}

/**
 * Sample fluor along an arc with perpendicular thickness averaging,
 * resampling the arc to `nSamples` evenly spaced points along its arc
 * length. Out-of-frame samples contribute 0 / cnt-=0.
 */
function sampleAlongExtended(
  arc: Arc,
  frame: Float32Array,
  H: number,
  W: number,
  thickness: number,
  nSamples: number,
  step: number
): Float32Array {
  const n = arc.length / 2;
  if (n < 2) return new Float32Array(nSamples);

  // Cumulative arc length.
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dy = arc[i * 2]! - arc[(i - 1) * 2]!;
    const dx = arc[i * 2 + 1]! - arc[(i - 1) * 2 + 1]!;
    cum[i] = cum[i - 1]! + Math.hypot(dy, dx);
  }
  void cum[n - 1]; // total arc length captured by `cum`; unused in
                   // this resample helper but kept for clarity.

  // Resample to nSamples points evenly along arc length.
  const ys = new Float64Array(nSamples);
  const xs = new Float64Array(nSamples);
  let j = 0;
  for (let k = 0; k < nSamples; k++) {
    const s = nSamples === 1 ? 0 : (k * step);
    while (j < n - 2 && cum[j + 1]! < s) j++;
    const c0 = cum[j]!;
    const c1 = cum[j + 1]!;
    const u = c1 - c0 < 1e-9 ? 0 : (s - c0) / (c1 - c0);
    ys[k] = arc[j * 2]! + u * (arc[(j + 1) * 2]! - arc[j * 2]!);
    xs[k] = arc[j * 2 + 1]! + u * (arc[(j + 1) * 2 + 1]! - arc[j * 2 + 1]!);
  }

  // Sample with perpendicular thickness averaging.
  const out = new Float32Array(nSamples);
  for (let k = 0; k < nSamples; k++) {
    const kPrev = Math.max(0, k - 1);
    const kNext = Math.min(nSamples - 1, k + 1);
    const dy = ys[kNext]! - ys[kPrev]!;
    const dx = xs[kNext]! - xs[kPrev]!;
    const norm = Math.hypot(dy, dx);
    let py = 0, px = 0;
    if (norm > 1e-6) {
      // Perpendicular = rotate tangent 90°.
      py = -dx / norm;
      px = dy / norm;
    }
    let acc = 0, cnt = 0;
    for (let t = -thickness; t <= thickness; t++) {
      const yy = Math.round(ys[k]! + py * t);
      const xx = Math.round(xs[k]! + px * t);
      if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue;
      acc += frame[yy * W + xx]!;
      cnt++;
    }
    out[k] = cnt > 0 ? acc / cnt : 0;
  }
  return out;
}
