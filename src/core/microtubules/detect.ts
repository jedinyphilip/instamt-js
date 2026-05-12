import { meijering } from '../filters/meijering';
import { branchPoints, skeletonize } from '../filters/skeletonize';
import {
  applyHysteresisThreshold,
  applyHysteresisThresholdMap,
  applyThreshold,
  liThreshold,
  localLiThresholdMap,
  removeSmallObjects,
} from '../filters/threshold';
import type { Image2D } from '../types';
import { arcCenter, arcChord, arcLength, type Arc } from './arc';
import {
  bestPairing,
  buildFilaments,
  findIncidences,
  findJunctions,
} from './junctions';
import { walkArcs } from './segment';

export interface DetectConfig {
  sigmas: readonly number[];
  /** Min connected-component size (pixels) before skeletonising. */
  minObjectSize: number;
  /** Min arc path length (pixels) to keep. */
  minArcLength: number;
  /** Max distance (pixels) from arc end to a junction pixel for incidence. */
  maxJunctionGap: number;
  /** Cluster-merge radius for branch-point clusters. */
  junctionMergeRadius: number;
  /** Pair-cost threshold for tangent dot product (more negative = stricter). */
  maxPairCost: number;
  /**
   * Reject filaments whose median pixel intensity is above this
   * percentile of the frame (catches non-MT bright structures).
   * `null` disables.
   */
  maxBrightnessPct: number | null;
  /**
   * Hysteresis low/high ratio for the ridge mask. The high threshold is
   * the (global or local) Li cutoff; pixels above ratio × cutoff that
   * are 4-connected to a pixel above the cutoff are also kept. 1.0
   * disables hysteresis.
   */
  hysteresisLowRatio: number;
  /**
   * Tile size (px) for local Li thresholding. When set, Li is computed
   * per overlapping tile (centres on a `tileSize/2`-spaced grid) and
   * bilinearly interpolated to a per-pixel cutoff. Adapts to regions
   * where the global Li is dragged up by stronger ridges elsewhere.
   * null disables local thresholding (plain global Li).
   */
  localThresholdTile: number | null;
  /**
   * Floor for per-tile Li, expressed as a fraction of the global Li.
   * Tiles whose Li drops below this floor get pinned to it; prevents
   * empty/uniform tiles from producing a noise-level threshold that
   * lets the entire background through. Only applies when
   * `localThresholdTile` is set.
   */
  localThresholdFloorRatio: number;
}

// Defaults aligned with the user's Python `config.json` operating point:
// max_junction_gap=6, junction_merge_radius=8 (the argparse defaults of
// 3/6 are too tight for the MT scales we're seeing in real data).
export const DEFAULT_DETECT: DetectConfig = {
  sigmas: [1.0, 1.5, 2.0],
  minObjectSize: 30,
  minArcLength: 15,
  maxJunctionGap: 6.0,
  junctionMergeRadius: 8.0,
  maxPairCost: 0.0,
  maxBrightnessPct: null,
  // Disabled by default — Python's `_detect_arcs_and_junctions` uses a
  // single global Li without hysteresis. Bump below 1 to enable
  // hysteresis-rescue as an opt-in enhancement.
  hysteresisLowRatio: 1.0,
  // Disabled by default — Python uses a single global Li threshold.
  // Set to an integer (e.g. 256) to enable per-tile Li thresholding as
  // an opt-in enhancement for inputs with strong illumination gradient.
  localThresholdTile: null,
  localThresholdFloorRatio: 0.5,
};

/**
 * Per-frame detection. Returns the assembled MT filaments as ordered
 * (y, x) Float32 arrays. Mirrors the Python `detect_filaments`.
 */
export function detectFilaments(frame: Image2D, cfg: DetectConfig = DEFAULT_DETECT): Arc[] {
  const [h, w] = frame.shape;

  // Match Python `_detect_arcs_and_junctions` exactly:
  //   f = uint8_frame.astype(np.float32) / 255.0
  //   ridge = meijering(1-f, sigmas, black_ridges=False)
  //   ridge = ridge / ridge.max()
  //   mask = ridge > threshold_li(ridge)
  //
  // Python reads the cleaned IRM from disk as uint8 (truncated), so
  // detect sees integer-valued pixels in [0, 255] divided by 255. The
  // JS pipeline keeps the cleanup output as Float32 in-memory; we
  // truncate here to match Python's uint8 round-trip exactly. Without
  // this, sub-grey-level Float32 residuals in the cleaned data shift
  // borderline ridge pixels across the Li threshold and produce extra
  // candidate arcs.
  const normFrame = new Float32Array(frame.data.length);
  for (let i = 0; i < frame.data.length; i++) {
    let v = frame.data[i]!;
    if (v < 0) v = 0;
    else if (v > 255) v = 255;
    normFrame[i] = Math.floor(v) / 255;
  }
  const ridge = meijering({ data: normFrame, shape: frame.shape }, cfg.sigmas, true);
  let ridgeMax = 0;
  for (let i = 0; i < ridge.data.length; i++) {
    if (ridge.data[i]! > ridgeMax) ridgeMax = ridge.data[i]!;
  }
  if (ridgeMax > 0) {
    const inv = 1 / ridgeMax;
    for (let i = 0; i < ridge.data.length; i++) ridge.data[i] = ridge.data[i]! * inv;
  }

  const globalThresh = liThreshold(ridge);
  // Threshold construction:
  //   - localThresholdTile null: a single global Li scalar (legacy path).
  //   - localThresholdTile set:  per-pixel Li from overlapping tiles,
  //     floored at floorRatio × globalLi to keep empty tiles from
  //     producing a noise threshold.
  // Then hysteresis rescue (faint pixels 4-connected to a seed) on top
  // of either, controlled by hysteresisLowRatio.
  const useLocal =
    cfg.localThresholdTile != null && cfg.localThresholdTile > 0;
  const useHysteresis =
    cfg.hysteresisLowRatio < 1.0 && cfg.hysteresisLowRatio > 0;
  let mask: Uint8Array;
  if (useLocal) {
    const tHighMap = localLiThresholdMap(
      ridge,
      cfg.localThresholdTile!,
      globalThresh,
      cfg.localThresholdFloorRatio
    );
    mask = useHysteresis
      ? applyHysteresisThresholdMap(ridge, tHighMap, cfg.hysteresisLowRatio)
      : applyHysteresisThresholdMap(ridge, tHighMap, 1.0);
  } else {
    mask = useHysteresis
      ? applyHysteresisThreshold(
          ridge,
          globalThresh * cfg.hysteresisLowRatio,
          globalThresh
        )
      : applyThreshold(ridge, globalThresh);
  }
  removeSmallObjects(mask, w, h, cfg.minObjectSize);

  // 3. Skeletonise.
  const skel = skeletonize(mask, w, h);

  // 4. Branch-point detection. Remove branches from the skeleton so
  //    the remaining components are individual arcs.
  const branches = branchPoints(skel, w, h);
  const arcsOnly = new Uint8Array(skel.length);
  for (let i = 0; i < skel.length; i++) {
    if (skel[i] && !branches[i]) arcsOnly[i] = 1;
  }

  // 5. Walk components → ordered arcs.
  const rawArcs = walkArcs(arcsOnly, w, h, cfg.minArcLength);

  // 6. Per-arc rejection: closed loops / tight wraps. A real MT arc
  //    has chord ≥ 12 px or chord/path ≥ 0.4; tight wraps fail both.
  const filteredArcs: Arc[] = [];
  for (const arc of rawArcs) {
    const path = arcLength(arc);
    const chord = arcChord(arc);
    if (path > 0 && chord < 12 && chord / path < 0.4) continue;
    filteredArcs.push(arc);
  }

  // 7. Junction discovery + arc-end-to-junction incidence.
  const junctions = findJunctions(branches, w, h, cfg.junctionMergeRadius);
  const junctionCenters = new Map<number, { y: number; x: number }>();
  for (const j of junctions) junctionCenters.set(j.id, { y: j.cy, x: j.cx });

  const { incidents, bridgeArcs } = findIncidences(filteredArcs, junctions, cfg.maxJunctionGap);

  // 8. Pair arcs at each junction.
  const partners = new Map<string, { arcIdx: number; end: 0 | 1; jid: number }>();
  const key = (ai: number, e: 0 | 1): string => `${ai}:${e}`;
  for (const [jid, list] of incidents) {
    if (list.length < 2) continue;
    const pairs = bestPairing(list, cfg.maxPairCost);
    for (const [i, j] of pairs) {
      const a = list[i]!;
      const b = list[j]!;
      partners.set(key(a.arcIdx, a.end), { arcIdx: b.arcIdx, end: b.end, jid });
      partners.set(key(b.arcIdx, b.end), { arcIdx: a.arcIdx, end: a.end, jid });
    }
  }

  // 9. Drop bridge arcs (two ends at same junction). Remap partner indices.
  const surviving: Arc[] = [];
  const idxMap = new Map<number, number>();
  for (let i = 0; i < filteredArcs.length; i++) {
    if (bridgeArcs.has(i)) continue;
    idxMap.set(i, surviving.length);
    surviving.push(filteredArcs[i]!);
  }
  const remappedPartners = new Map<string, { arcIdx: number; end: 0 | 1; jid: number }>();
  for (const [k, v] of partners) {
    const [aiStr, eStr] = k.split(':');
    const ai = +aiStr!;
    const e = +eStr! as 0 | 1;
    const newAi = idxMap.get(ai);
    const newBi = idxMap.get(v.arcIdx);
    if (newAi === undefined || newBi === undefined) continue;
    remappedPartners.set(key(newAi, e), { arcIdx: newBi, end: v.end, jid: v.jid });
  }

  // 10. Assemble filaments by walking the partner graph.
  const filaments = buildFilaments(surviving, remappedPartners, junctionCenters);

  // 11. Filament-level filters: closed-loop wrap rejection, brightness.
  const out: Arc[] = [];
  let brightThresh: number | null = null;
  if (cfg.maxBrightnessPct != null) brightThresh = percentile(frame.data, cfg.maxBrightnessPct);

  for (const fil of filaments) {
    if (fil.length < 4) continue;
    const path = arcLength(fil);
    const chord = arcChord(fil);
    if (path > 0 && chord < 12 && chord / path < 0.4) continue;

    if (brightThresh !== null) {
      // Median intensity of the frame pixels along the filament.
      const intensities = new Float32Array(fil.length / 2);
      for (let k = 0; k < intensities.length; k++) {
        let y = Math.round(fil[2 * k]!);
        let x = Math.round(fil[2 * k + 1]!);
        if (y < 0) y = 0;
        if (y >= h) y = h - 1;
        if (x < 0) x = 0;
        if (x >= w) x = w - 1;
        intensities[k] = frame.data[y * w + x]!;
      }
      const med = quickMedian(intensities);
      if (med > brightThresh) continue;
    }
    out.push(fil);
  }
  return out;
}

function percentile(arr: Float32Array | number[], pct: number): number {
  const sorted = Float32Array.from(arr);
  sorted.sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((pct / 100) * sorted.length)));
  return sorted[idx]!;
}

function quickMedian(arr: Float32Array): number {
  const copy = new Float32Array(arr);
  copy.sort();
  const m = copy.length >>> 1;
  return copy.length % 2 === 0 ? (copy[m - 1]! + copy[m]!) / 2 : copy[m]!;
}

// Re-export the canonical Arc type for ergonomics.
export type { Arc } from './arc';
export { arcCenter, arcChord, arcLength };
