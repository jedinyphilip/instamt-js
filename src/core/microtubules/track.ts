import type { Arc } from './arc';
import { hungarian } from './hungarian';

export interface Track {
  readonly id: number;
  readonly frames: number[];
  readonly arcs: Arc[];
}

export interface TrackConfig {
  iouThresh: number;
  /** Dilation radius (pixels) for the IoU mask. */
  dilate: number;
  minTrackLength: number;
}

export const DEFAULT_TRACK: TrackConfig = {
  iouThresh: 0.2,
  dilate: 3,
  minTrackLength: 5,
};

/**
 * Link per-frame arcs into tracks via dilated-mask IoU + Hungarian.
 * Mirrors the Python `track_arcs`.
 */
export function trackArcs(
  perFrameArcs: Arc[][],
  imageH: number,
  imageW: number,
  cfg: TrackConfig = DEFAULT_TRACK
): Track[] {
  let nextId = 0;
  let active: Track[] = [];
  const finished: Track[] = [];

  for (let t = 0; t < perFrameArcs.length; t++) {
    const arcs = perFrameArcs[t]!;
    if (active.length === 0) {
      for (const arc of arcs) {
        active.push({ id: nextId++, frames: [t], arcs: [arc] });
      }
      continue;
    }
    if (arcs.length === 0) {
      finished.push(...active);
      active = [];
      continue;
    }

    const prevMasks = active.map((tr) =>
      dilatedMaskSparse(tr.arcs[tr.arcs.length - 1]!, imageW, imageH, cfg.dilate)
    );
    const curMasks = arcs.map((a) => dilatedMaskSparse(a, imageW, imageH, cfg.dilate));

    const cost: number[][] = [];
    for (let i = 0; i < active.length; i++) {
      const row: number[] = [];
      const pm = prevMasks[i]!;
      for (let j = 0; j < arcs.length; j++) {
        const cm = curMasks[j]!;
        const iou = iouSparse(pm, cm);
        row.push(iou === 0 ? 1.0 : 1.0 - iou);
      }
      cost.push(row);
    }

    const assignment = hungarian(cost);
    const matchedActive = new Set<number>();
    const matchedCur = new Set<number>();
    for (let i = 0; i < assignment.length; i++) {
      const j = assignment[i]!;
      if (j < 0) continue;
      if (cost[i]![j]! > 1.0 - cfg.iouThresh) continue;
      const tr = active[i]!;
      const newArc = alignToPrev(arcs[j]!, tr.arcs[tr.arcs.length - 1]!);
      tr.frames.push(t);
      tr.arcs.push(newArc);
      matchedActive.add(i);
      matchedCur.add(j);
    }

    const stillActive: Track[] = [];
    for (let i = 0; i < active.length; i++) {
      if (matchedActive.has(i)) stillActive.push(active[i]!);
      else finished.push(active[i]!);
    }
    for (let j = 0; j < arcs.length; j++) {
      if (matchedCur.has(j)) continue;
      stillActive.push({ id: nextId++, frames: [t], arcs: [arcs[j]!] });
    }
    active = stillActive;
  }
  finished.push(...active);
  return finished.filter((tr) => tr.frames.length >= cfg.minTrackLength);
}

/** Sparse representation of a dilated arc mask: sorted unique linear
 *  pixel indices `y*W + x`, plus an axis-aligned bounding box. This is
 *  >100× cheaper than the W·H bitmap on typical arcs (~200 px → ~5 k
 *  dilated px), since the bitmap is 99% zeros at 1024².
 */
interface SparseMask {
  indices: Int32Array;
  /** Inclusive bounding box. */
  y0: number;
  y1: number;
  x0: number;
  x1: number;
}

/** Build the sparse dilated mask for an arc.
 *
 *  Matches Python's `binary_dilation(m, iterations=radius)`: scipy's
 *  default structure is the 4-connected cross, and iterating it
 *  `radius` times grows a Manhattan-distance ≤ radius diamond around
 *  every arc pixel — NOT a `(2r+1)²` square. A square dilation makes
 *  masks ~2× larger than Python's, which fuses parallel MTs into one
 *  track and fragments their continuations.
 */
function dilatedMaskSparse(arc: Arc, w: number, h: number, radius: number): SparseMask {
  const arcLen = arc.length / 2;
  const side = 2 * radius + 1;
  const buf = new Int32Array(arcLen * side * side);
  let n = 0;
  let y0 = h;
  let y1 = -1;
  let x0 = w;
  let x1 = -1;
  for (let p = 0; p < arc.length; p += 2) {
    const cy = Math.round(arc[p]!);
    const cx = Math.round(arc[p + 1]!);
    for (let dy = -radius; dy <= radius; dy++) {
      const yy = cy + dy;
      if (yy < 0 || yy >= h) continue;
      const dxBound = radius - Math.abs(dy);
      const rowBase = yy * w;
      for (let dx = -dxBound; dx <= dxBound; dx++) {
        const xx = cx + dx;
        if (xx < 0 || xx >= w) continue;
        buf[n++] = rowBase + xx;
        if (yy < y0) y0 = yy;
        if (yy > y1) y1 = yy;
        if (xx < x0) x0 = xx;
        if (xx > x1) x1 = xx;
      }
    }
  }
  // Sort numerically (TypedArray.sort is numeric by default), then
  // dedup in place.
  const view = buf.subarray(0, n);
  view.sort();
  let m = 0;
  let last = -1;
  for (let i = 0; i < n; i++) {
    const v = view[i]!;
    if (v !== last) {
      view[m++] = v;
      last = v;
    }
  }
  return {
    indices: view.slice(0, m),
    y0,
    y1,
    x0,
    x1,
  };
}

/** IoU between two sparse masks. Bbox-disjoint pairs short-circuit to
 *  0; otherwise we two-pointer merge the sorted index arrays. */
function iouSparse(a: SparseMask, b: SparseMask): number {
  if (a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0) return 0;
  const ai = a.indices;
  const bi = b.indices;
  const aLen = ai.length;
  const bLen = bi.length;
  if (aLen === 0 || bLen === 0) return 0;
  let i = 0;
  let j = 0;
  let inter = 0;
  while (i < aLen && j < bLen) {
    const av = ai[i]!;
    const bv = bi[j]!;
    if (av === bv) {
      inter++;
      i++;
      j++;
    } else if (av < bv) {
      i++;
    } else {
      j++;
    }
  }
  const union = aLen + bLen - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * If reversing `newArc` puts its end0 closer to `prevArc.end1` than the
 * current orientation does, flip it. Keeps consecutive frames'
 * endpoint-orderings consistent so seed-end / plus-end semantics
 * survive across the track.
 */
function alignToPrev(newArc: Arc, prevArc: Arc): Arc {
  const pn = prevArc.length / 2;
  const nn = newArc.length / 2;
  if (pn < 1 || nn < 1) return newArc;
  const pEndY = prevArc[(pn - 1) * 2]!;
  const pEndX = prevArc[(pn - 1) * 2 + 1]!;
  const dSame = Math.hypot(newArc[(nn - 1) * 2]! - pEndY, newArc[(nn - 1) * 2 + 1]! - pEndX);
  const dFlip = Math.hypot(newArc[0]! - pEndY, newArc[1]! - pEndX);
  if (dFlip < dSame) {
    const out = new Float32Array(newArc.length);
    for (let i = 0; i < nn; i++) {
      out[i * 2] = newArc[(nn - 1 - i) * 2]!;
      out[i * 2 + 1] = newArc[(nn - 1 - i) * 2 + 1]!;
    }
    return out;
  }
  return newArc;
}
