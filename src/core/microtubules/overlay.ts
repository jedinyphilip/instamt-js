import type { Shape3D, Stack3D } from '../types';
import type { Lineage } from './lineage';
import type { Track } from './track';

/**
 * Per-lineage colours: distinct hues evenly spaced around the colour
 * wheel, deterministically shuffled. Optimised for visibility on light
 * IRM backgrounds — uses HSL with medium-low lightness (L=0.42) so
 * that hues like yellow and lime, which are perceptually pale at
 * lightness 0.5, render as olive / forest-green and stand out against
 * the bright cleaned IRM. Saturation pegged to 1.0 for vivid colour
 * rather than gray-ish.
 */
export function trackColors(n: number, seed = 42): Array<[number, number, number]> {
  const hues = new Float64Array(n);
  for (let i = 0; i < n; i++) hues[i] = (i + 0.5) / Math.max(n, 1);
  // Mulberry32 RNG seeded for determinism.
  let state = seed >>> 0;
  for (let i = n - 1; i > 0; i--) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    const j = Math.floor(r * (i + 1));
    const tmp = hues[i]!;
    hues[i] = hues[j]!;
    hues[j] = tmp;
  }
  return Array.from(hues, (h) => hslToRgb(h, 1.0, 0.42));
}

/** HSL → RGB with each component in [0, 255]. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h * 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0,
    g = 0,
    b = 0;
  if (hp < 1) {
    r = c;
    g = x;
  } else if (hp < 2) {
    r = x;
    g = c;
  } else if (hp < 3) {
    g = c;
    b = x;
  } else if (hp < 4) {
    g = x;
    b = c;
  } else if (hp < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export interface OverlayOptions {
  /** Per-frame raw detections (before tracking). Drawn cyan, behind tracks. */
  rawDetections?: Float32Array[][];
  /** All tracked arcs (before lineage / length filter). Drawn yellow. */
  rawTracks?: Track[];
}

/**
 * Render a (T, H, W*3) RGB stack: each frame is the IRM background
 * (replicated to RGB) with each lineage's per-frame arc rasterised in
 * its lineage colour. Returned as a Stack3D where the last axis is
 * actually W*3 (R, G, B per pixel interleaved). The overlay is always
 * fully opaque so we don't carry an alpha channel — keeps the encoded
 * TIFF at 3 samples/pixel, which is what every TIFF viewer handles
 * cleanly without ExtraSamples-related ambiguity.
 *
 * Layer order (back to front): IRM bg → cyan raw detections → yellow
 * pre-filter tracks → coloured lineages.
 *
 * Implementation: Bresenham line drawing per arc, 2-px-wide brush.
 */
/**
 * Render the overlay directly into a Uint8 RGB buffer (T·H·W·3 bytes).
 *
 * The previous Float32 RGB intermediate was 12 bytes/pixel — for a
 * 164-frame 1024² stack that's ≈ 2 GB of float buffer that the
 * encoding step kept alive on top of `cleaned`, `cleanedFrames`,
 * `overlayFrames`, and the encoded TIFFs. Rendering straight to
 * Uint8 cuts that to 3 bytes/pixel (~500 MB for the same input) and
 * lets us reuse the same buffer as the preview-tab payload.
 *
 * Values are always in [0, 255] (255-clamped during the contrast
 * stretch and arc paint), so nothing's lost vs the Float32 path.
 */
export function renderOverlay(
  irm: Stack3D,
  tracks: Track[],
  lineages: Lineage[],
  colors: Array<[number, number, number]>,
  options: OverlayOptions = {}
): { rgb: { data: Uint8Array; shape: Shape3D } } {
  const [T, H, W] = irm.shape;
  const stride = H * W;
  const trackToLineage = new Map<number, number>();
  for (let li = 0; li < lineages.length; li++) {
    for (const ti of lineages[li]!) trackToLineage.set(ti, li);
  }

  const perFrame: Array<Array<{ li: number; arc: Float32Array }>> = [];
  for (let t = 0; t < T; t++) perFrame.push([]);
  for (let ti = 0; ti < tracks.length; ti++) {
    const li = trackToLineage.get(ti);
    if (li === undefined) continue;
    const tr = tracks[ti]!;
    for (let i = 0; i < tr.frames.length; i++) {
      const ft = tr.frames[i]!;
      if (ft >= 0 && ft < T) perFrame[ft]!.push({ li, arc: tr.arcs[i]! });
    }
  }

  const rgb = new Uint8Array(T * H * W * 3);
  for (let t = 0; t < T; t++) {
    const src = irm.data.subarray(t * stride, (t + 1) * stride);
    // Robust contrast stretch: percentile-based so a few outliers
    // (e.g. residual fringe artefacts) don't blow out the dynamic
    // range.
    const [lo, hi] = percentileRange(src, 0.005, 0.995);
    const span = hi - lo || 1;
    const dstBase = t * H * W * 3;
    for (let p = 0; p < src.length; p++) {
      let v = ((src[p]! - lo) / span) * 255;
      if (!Number.isFinite(v)) v = 0;
      else if (v < 0) v = 0;
      else if (v > 255) v = 255;
      const o = dstBase + p * 3;
      const u = v | 0;
      rgb[o] = u;
      rgb[o + 1] = u;
      rgb[o + 2] = u;
    }
    if (options.rawDetections) {
      for (const arc of options.rawDetections[t] ?? []) {
        drawArc(rgb, dstBase, H, W, arc, 0, 200, 220);
      }
    }
    if (options.rawTracks) {
      for (const tr of options.rawTracks) {
        const idx = tr.frames.indexOf(t);
        if (idx < 0) continue;
        drawArc(rgb, dstBase, H, W, tr.arcs[idx]!, 200, 200, 0);
      }
    }
    for (const { li, arc } of perFrame[t]!) {
      const [r, g, b] = colors[li] ?? [255, 255, 255];
      drawArc(rgb, dstBase, H, W, arc, r, g, b);
    }
  }
  return { rgb: { data: rgb, shape: [T, H, W * 3] } };
}

/** Approximate percentile stretch. Linear-time bucket histogram on the
 *  observed [min, max] range; good enough for display rescaling. */
function percentileRange(src: Float32Array, lo: number, hi: number): [number, number] {
  let mn = Infinity;
  let mx = -Infinity;
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i]!;
    if (!Number.isFinite(v)) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    n++;
  }
  if (n === 0 || mn === mx) return [0, 1];
  const bins = 4096;
  const counts = new Uint32Array(bins);
  const span = mx - mn;
  for (let i = 0; i < src.length; i++) {
    const v = src[i]!;
    if (!Number.isFinite(v)) continue;
    let b = Math.floor(((v - mn) / span) * bins);
    if (b < 0) b = 0;
    else if (b >= bins) b = bins - 1;
    counts[b]!++;
  }
  const targetLo = Math.floor(lo * n);
  const targetHi = Math.floor(hi * n);
  let cum = 0;
  let bLo = 0;
  let bHi = bins - 1;
  for (let b = 0; b < bins; b++) {
    cum += counts[b]!;
    if (cum >= targetLo) {
      bLo = b;
      break;
    }
  }
  cum = 0;
  for (let b = 0; b < bins; b++) {
    cum += counts[b]!;
    if (cum >= targetHi) {
      bHi = b;
      break;
    }
  }
  return [mn + (bLo / bins) * span, mn + (bHi / bins) * span];
}

function drawArc(
  rgb: Uint8Array,
  base: number,
  H: number,
  W: number,
  arc: Float32Array,
  r: number,
  g: number,
  b: number
): void {
  const n = arc.length / 2;
  if (n < 2) return;
  for (let i = 1; i < n; i++) {
    const y0 = Math.round(arc[(i - 1) * 2]!);
    const x0 = Math.round(arc[(i - 1) * 2 + 1]!);
    const y1 = Math.round(arc[i * 2]!);
    const x1 = Math.round(arc[i * 2 + 1]!);
    bresenham(rgb, base, H, W, y0, x0, y1, x1, r, g, b);
  }
}

function bresenham(
  rgb: Uint8Array,
  base: number,
  H: number,
  W: number,
  y0: number,
  x0: number,
  y1: number,
  x1: number,
  r: number,
  g: number,
  b: number
): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0,
    y = y0;
  for (;;) {
    plot(rgb, base, H, W, y, x, r, g, b);
    plot(rgb, base, H, W, y + 1, x, r, g, b);
    plot(rgb, base, H, W, y, x + 1, r, g, b);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

function plot(
  rgb: Uint8Array,
  base: number,
  H: number,
  W: number,
  y: number,
  x: number,
  r: number,
  g: number,
  b: number
): void {
  if (y < 0 || y >= H || x < 0 || x >= W) return;
  const o = base + (y * W + x) * 3;
  rgb[o] = r;
  rgb[o + 1] = g;
  rgb[o + 2] = b;
}
