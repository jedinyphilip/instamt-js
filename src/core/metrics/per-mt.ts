import type { Stack3D } from '../types';
import { arcLength } from '../microtubules/arc';
import type { Track } from '../microtubules/track';

export interface PerMtMetrics {
  label: string;
  nFrames: number;
  firstFrame: number;
  lastFrame: number;
  meanLengthUm: number;
  stdLengthUm: number;
  meanLengthDeltaUmPerS: number;
  stdLengthDeltaUmPerS: number;
  catastropheCount: number;
  rescueCount: number;
  meanCurvatureRadPerUm: number;
  stdCurvatureRadPerUm: number;
  meanOrientationDeg: number;
  meanFluorIntensityAu: number;
  stdFluorIntensityAu: number;
}

/** Per-frame trace of every metric that's a single number per frame.
 *  Used by the kymo modal to plot how each metric evolves through the
 *  MT's lifetime. Frame indices are absolute (not relative to the
 *  track's `firstFrame`). */
export interface PerMtTimeseries {
  frames: number[];
  lengthUm: number[];
  /** Diff between consecutive `lengthUm` samples × fps; length-1 short. */
  lengthDeltaUmPerS: number[];
  curvatureRadPerUm: number[];
  fluorIntensityAu: number[];
}

/**
 * Per-lineage structural + dynamics + fluor metrics. Mirrors the
 * Python `compute_lineage_metrics` for every column we currently
 * report.
 */
export function computePerMtMetrics(
  label: string,
  members: Track[],
  fluor: Stack3D,
  umPerPx: number | null,
  fps: number | null
): { summary: PerMtMetrics; timeseries: PerMtTimeseries } {
  // Pick the longest arc per frame as the representative ("most-merged")
  const frameToArc = new Map<number, Float32Array>();
  for (const m of members) {
    for (let i = 0; i < m.frames.length; i++) {
      const ft = m.frames[i]!;
      const arc = m.arcs[i]!;
      const cur = frameToArc.get(ft);
      if (!cur || arc.length > cur.length) frameToArc.set(ft, arc);
    }
  }
  const frames = [...frameToArc.keys()].sort((a, b) => a - b);
  const arcs = frames.map((f) => frameToArc.get(f)!);
  const lengthsUm = arcs.map((a) => arcLength(a) * (umPerPx ?? 1));
  const lengthDeltas: number[] = [];
  for (let i = 1; i < lengthsUm.length; i++) {
    let d = lengthsUm[i]! - lengthsUm[i - 1]!;
    if (fps) d = d * fps;
    lengthDeltas.push(d);
  }

  const { catastrophes, rescues } = countCatastrophesRescues(lengthsUm);

  const curvatures = arcs.map((a) => netTurnPerUm(a, umPerPx));
  const orientations = arcs
    .filter((a) => a.length >= 4)
    .map((a) => Math.atan2(a[a.length - 1]! - a[1]!, a[a.length - 2]! - a[0]!) * (180 / Math.PI));

  const [, h, w] = fluor.shape;
  const stride = h * w;
  const fluorMeans = arcs.map((a, i) => {
    const ft = frames[i]!;
    return sampleMean(a, fluor.data.subarray(ft * stride, (ft + 1) * stride), w, h);
  });

  const summary: PerMtMetrics = {
    label,
    nFrames: frames.length,
    firstFrame: frames[0]!,
    lastFrame: frames[frames.length - 1]!,
    meanLengthUm: mean(lengthsUm),
    stdLengthUm: std(lengthsUm),
    meanLengthDeltaUmPerS: mean(lengthDeltas),
    stdLengthDeltaUmPerS: std(lengthDeltas),
    catastropheCount: catastrophes,
    rescueCount: rescues,
    meanCurvatureRadPerUm: mean(curvatures),
    stdCurvatureRadPerUm: std(curvatures),
    meanOrientationDeg: mean(orientations),
    meanFluorIntensityAu: mean(fluorMeans),
    stdFluorIntensityAu: std(fluorMeans),
  };
  const timeseries: PerMtTimeseries = {
    frames,
    lengthUm: lengthsUm,
    lengthDeltaUmPerS: lengthDeltas,
    curvatureRadPerUm: curvatures,
    fluorIntensityAu: fluorMeans,
  };
  return { summary, timeseries };
}

function mean(arr: number[]): number {
  if (arr.length === 0) return NaN;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function std(arr: number[]): number {
  if (arr.length === 0) return NaN;
  const m = mean(arr);
  let s = 0;
  for (const v of arr) s += (v - m) * (v - m);
  return Math.sqrt(s / arr.length);
}

/**
 * Count growth→shrink (catastrophe) and shrink→growth (rescue) transitions
 * in a 3-frame uniformly-smoothed length signal.
 */
function countCatastrophesRescues(lengths: number[]): { catastrophes: number; rescues: number } {
  if (lengths.length < 5) return { catastrophes: 0, rescues: 0 };
  // 3-frame uniform smoothing.
  const sm = new Array<number>(lengths.length).fill(0);
  for (let i = 0; i < lengths.length; i++) {
    let acc = 0;
    let cnt = 0;
    for (let q = -1; q <= 1; q++) {
      const j = i + q;
      if (j < 0 || j >= lengths.length) continue;
      acc += lengths[j]!;
      cnt++;
    }
    sm[i] = acc / cnt;
  }
  // Count transitions in the sign sequence, but skip zero diffs
  // (constant-length plateaus): they're "no-information", not a phase
  // change, and treating them as a third value blocks transition
  // detection asymmetrically (e.g. + 0 - registers no catastrophe even
  // though the underlying motion was growth → shrink). Compare each
  // non-zero sign against the most recent prior non-zero sign instead.
  let cat = 0;
  let res = 0;
  let prev = 0;
  for (let i = 1; i < sm.length; i++) {
    const s = Math.sign(sm[i]! - sm[i - 1]!);
    if (s === 0) continue;
    if (prev > 0 && s < 0) cat++;
    if (prev < 0 && s > 0) res++;
    prev = s;
  }
  return { catastrophes: cat, rescues: res };
}

/**
 * Signed net tangent rotation from start to end of the arc, divided by
 * the arc length. Uses ±5-px windowed tangents to suppress 1-px
 * skeleton noise. Returns rad/µm if `umPerPx` is given.
 */
function netTurnPerUm(arc: Float32Array, umPerPx: number | null): number {
  const n = arc.length / 2;
  const win = 5;
  if (n < 2 * win + 2) return 0;

  const tangents: number[] = [];
  for (let i = win; i < n - win; i++) {
    const dy = arc[(i + win) * 2]! - arc[(i - win) * 2]!;
    const dx = arc[(i + win) * 2 + 1]! - arc[(i - win) * 2 + 1]!;
    const norm = Math.hypot(dy, dx);
    if (norm > 1e-9) tangents.push(Math.atan2(dx, dy));
  }
  if (tangents.length < 2) return 0;
  // Unwrap.
  for (let i = 1; i < tangents.length; i++) {
    let d = tangents[i]! - tangents[i - 1]!;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    tangents[i] = tangents[i - 1]! + d;
  }
  const netTurn = Math.abs(tangents[tangents.length - 1]! - tangents[0]!);
  // Effective length in pixels (skip the ±win edges).
  let path = 0;
  for (let i = 1 + win; i < n - win; i++) {
    const dy = arc[i * 2]! - arc[(i - 1) * 2]!;
    const dx = arc[i * 2 + 1]! - arc[(i - 1) * 2 + 1]!;
    path += Math.hypot(dy, dx);
  }
  if (path < 1e-9) return 0;
  const scale = path * (umPerPx ?? 1);
  return netTurn / scale;
}

function sampleMean(arc: Float32Array, frame: Float32Array, w: number, h: number): number {
  if (arc.length === 0) return 0;
  let acc = 0;
  let cnt = 0;
  for (let p = 0; p < arc.length; p += 2) {
    const y = Math.round(arc[p]!);
    const x = Math.round(arc[p + 1]!);
    if (y < 0 || y >= h || x < 0 || x >= w) continue;
    acc += frame[y * w + x]!;
    cnt++;
  }
  return cnt > 0 ? acc / cnt : 0;
}

