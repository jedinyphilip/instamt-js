import { endpointTangent } from './arc';
import type { Track } from './track';

/** A lineage is a list of track ids belonging to the same physical MT. */
export type Lineage = number[];

export interface LineageConfig {
  iouThresh: number;
  /** Allowed temporal gap (frames) between one track ending and the next starting. */
  maxGap: number;
  /**
   * Endpoint distance threshold (px) for spatial-adjacency linking.
   * Needs to cover the synthetic gap that `junctionMergeRadius` +
   * `maxJunctionGap` create between fragments meeting at a crossing
   * — at the default detect settings (radius 8, gap 6) two arcs
   * continuing through a junction can have endpoints up to ~28 px
   * apart. Default 20 is conservative; raise toward 28 if you still
   * see crossing-MT lineages split.
   */
  adjacencyPx: number;
  /**
   * Tangent dot-product threshold for endpoint-adjacency lineage
   * merging. Two coexisting tracks whose endpoints come within
   * `adjacencyPx` AND whose outward tangents have dot product ≤ this
   * value get merged. −1 = perfectly anti-parallel; −0.9 ≈ 26°
   * tolerance from anti-parallel. Mirrors Python's `adjacency_dot=-0.9`.
   */
  adjacencyDot: number;
  /**
   * Spatial-overlap criterion threshold (IoU). Two coexisting tracks
   * whose dilated arc masks overlap with IoU ≥ this value at any
   * common frame get merged regardless of tangent direction. Catches
   * duplicate parallel detections of the same MT that the endpoint-
   * tangent test rejects.
   *
   * IoU only — the previous `max(IoU, containment)` variant absorbed
   * short noise fragments into a long lineage whenever the fragment
   * happened to fall inside the long arc's dilated band, inflating
   * the lineage. Plain IoU keeps small-vs-large parallel pairs apart
   * (IoU stays low because the union is dominated by the large arc).
   * Set to 1.0 to disable.
   */
  overlapIou: number;
  /**
   * Manhattan dilation radius (px) for the spatial-overlap arc masks.
   * 1-px arcs offset by ≤ 2r-1 px have non-zero overlap; for r=6 the
   * criterion fires on parallel duplicates up to ~5 px apart (IoU ≈
   * 0.4) while staying narrow enough not to merge genuinely separate
   * MTs (typically ≥ 10 px apart). Larger r = more aggressive merging.
   */
  overlapDilatePx: number;
}

export const DEFAULT_LINEAGE: LineageConfig = {
  iouThresh: 0.2,
  maxGap: 2,
  adjacencyPx: 20,
  adjacencyDot: -0.9,
  overlapIou: 0.4,
  overlapDilatePx: 6,
};

/**
 * Group tracks belonging to the same physical MT. Three linking
 * criteria, any of which is sufficient:
 *   1. Temporal: track A ends within `maxGap` frames of B starting,
 *      and their boundary arcs have IoU >= iouThresh.
 *   2. Endpoint adjacency: A and B coexist for at least one frame,
 *      and at any common frame have endpoints within `adjacencyPx`
 *      AND tangent dot <= `adjacencyDot` (anti-parallel meeting).
 *   3. Spatial overlap: A and B coexist for at least one frame, and
 *      their dilated arc masks at a common frame have IoU >=
 *      `overlapIou` (duplicate / parallel detection of the same MT).
 *
 * Mirrors the Python `detect_lineages`, plus criterion 3 to absorb
 * coexisting parallel duplicates that the endpoint test rejects.
 */
export function detectLineages(
  tracks: Track[],
  imageH: number,
  imageW: number,
  cfg: LineageConfig = DEFAULT_LINEAGE
): Lineage[] {
  const n = tracks.length;
  const parent = new Array<number>(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const unite = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const ranges: Array<[lo: number, hi: number]> = tracks.map((t) =>
    t.frames.length > 0 ? [t.frames[0]!, t.frames[t.frames.length - 1]!] : [0, -1]
  );

  for (let i = 0; i < n; i++) {
    if (tracks[i]!.frames.length === 0) continue;
    const [iLo, iHi] = ranges[i]!;
    for (let j = i + 1; j < n; j++) {
      if (tracks[j]!.frames.length === 0) continue;
      const [jLo, jHi] = ranges[j]!;

      // Criterion 1: temporal.
      let linked = false;
      if (iHi <= jLo && jLo - iHi <= cfg.maxGap + 1) {
        if (boundaryIoU(tracks[i]!, tracks[j]!, imageW, imageH) >= cfg.iouThresh) {
          unite(i, j);
          linked = true;
        }
      }
      if (!linked && jHi <= iLo && iLo - jHi <= cfg.maxGap + 1) {
        if (boundaryIoU(tracks[j]!, tracks[i]!, imageW, imageH) >= cfg.iouThresh) {
          unite(i, j);
          linked = true;
        }
      }
      if (linked) continue;

      // Criterion 2: endpoint adjacency at any common frame — Python's
      // `detect_lineages` test: endpoints within `adjacencyPx` AND
      // outward tangents nearly anti-parallel (dot ≤ adjacencyDot).
      // Criterion 3: spatial overlap at any common frame — dilated
      // arc-mask IoU ≥ overlapIou. Absorbs coexisting parallel
      // duplicates of the same MT that criterion 2 deliberately
      // rejects (parallel-not-anti-parallel tangents).
      const lo = Math.max(iLo, jLo);
      const hi = Math.min(iHi, jHi);
      if (lo > hi) continue;
      for (let ft = lo; ft <= hi && !linked; ft++) {
        const ai = arcAtFrame(tracks[i]!, ft);
        const aj = arcAtFrame(tracks[j]!, ft);
        if (!ai || !aj) continue;
        // Criterion 3 first: cheap-ish bbox short-circuit inside
        // arcIoU makes this near-free for spatially separate tracks,
        // and a hit lets us skip the endpoint-pair sweep entirely.
        if (cfg.overlapIou < 1) {
          const iou = arcIoU(ai, aj, imageW, imageH, cfg.overlapDilatePx);
          if (iou >= cfg.overlapIou) {
            unite(i, j);
            linked = true;
            break;
          }
        }
        for (const ei of [0, 1] as const) {
          const pi =
            ei === 0
              ? { y: ai[0]!, x: ai[1]! }
              : { y: ai[ai.length - 2]!, x: ai[ai.length - 1]! };
          const ti = endpointTangent(ai, ei);
          for (const ej of [0, 1] as const) {
            const pj =
              ej === 0
                ? { y: aj[0]!, x: aj[1]! }
                : { y: aj[aj.length - 2]!, x: aj[aj.length - 1]! };
            if (Math.hypot(pi.y - pj.y, pi.x - pj.x) > cfg.adjacencyPx) continue;
            const tj = endpointTangent(aj, ej);
            if (ti.ty * tj.ty + ti.tx * tj.tx <= cfg.adjacencyDot) {
              unite(i, j);
              linked = true;
              break;
            }
          }
          if (linked) break;
        }
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (tracks[i]!.frames.length === 0) continue;
    const r = find(i);
    const arr = groups.get(r) ?? [];
    arr.push(i);
    groups.set(r, arr);
  }
  return [...groups.values()];
}

function arcAtFrame(track: Track, frame: number): Float32Array | null {
  // Tracks have small frame counts; linear search is fine.
  const idx = track.frames.indexOf(frame);
  return idx >= 0 ? track.arcs[idx]! : null;
}

function boundaryIoU(a: Track, b: Track, w: number, h: number): number {
  return arcIoU(a.arcs[a.arcs.length - 1]!, b.arcs[0]!, w, h, 3);
}

/** Dilated-mask IoU between two arcs. Bbox-disjoint pairs short-
 *  circuit to 0 before allocating the full W·H masks. */
function arcIoU(
  aArc: Float32Array,
  bArc: Float32Array,
  w: number,
  h: number,
  radius: number
): number {
  // Cheap arc-bbox overlap test first — Manhattan-radius dilation
  // expands each bbox by `radius` on every side.
  const ab = arcBBox(aArc);
  const bb = arcBBox(bArc);
  if (
    ab.x1 + radius < bb.x0 - radius ||
    bb.x1 + radius < ab.x0 - radius ||
    ab.y1 + radius < bb.y0 - radius ||
    bb.y1 + radius < ab.y0 - radius
  ) {
    return 0;
  }
  const ma = dilatedMask(aArc, w, h, radius);
  const mb = dilatedMask(bArc, w, h, radius);
  let inter = 0;
  let union = 0;
  for (let i = 0; i < ma.length; i++) {
    const ai = ma[i]!;
    const bi = mb[i]!;
    if (ai && bi) inter++;
    if (ai || bi) union++;
  }
  return union === 0 ? 0 : inter / union;
}

function arcBBox(arc: Float32Array): { y0: number; y1: number; x0: number; x1: number } {
  let y0 = Infinity;
  let y1 = -Infinity;
  let x0 = Infinity;
  let x1 = -Infinity;
  for (let p = 0; p < arc.length; p += 2) {
    const y = arc[p]!;
    const x = arc[p + 1]!;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
  }
  return { y0, y1, x0, x1 };
}

// Manhattan-distance ≤ radius diamond, matching Python's
// `binary_dilation(m, iterations=radius)` with scipy's default 4-conn
// cross structure. See track.ts:dilatedMaskSparse for the parity
// rationale (a square dilation is ~2× larger and breaks IoU).
function dilatedMask(arc: Float32Array, w: number, h: number, radius: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  for (let p = 0; p < arc.length; p += 2) {
    const cy = Math.round(arc[p]!);
    const cx = Math.round(arc[p + 1]!);
    for (let dy = -radius; dy <= radius; dy++) {
      const yy = cy + dy;
      if (yy < 0 || yy >= h) continue;
      const dxBound = radius - Math.abs(dy);
      for (let dx = -dxBound; dx <= dxBound; dx++) {
        const xx = cx + dx;
        if (xx < 0 || xx >= w) continue;
        mask[yy * w + xx] = 1;
      }
    }
  }
  return mask;
}
