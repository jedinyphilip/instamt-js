/**
 * Run detection/tracking/lineage on a pre-cleaned IRM stack and
 * report counts. Used for offline comparison against reference
 * outputs without going through the worker pool / browser layer.
 */

import * as fs from 'node:fs';
import { detectFilaments, DEFAULT_DETECT } from '../src/core/microtubules/detect';
import { trackArcs, DEFAULT_TRACK } from '../src/core/microtubules/track';
import { detectLineages, DEFAULT_LINEAGE } from '../src/core/microtubules/lineage';
import {
  orientTrackToSeed,
  smoothTrackTemporal,
} from '../src/core/microtubules/postprocess';
import { measureAvgFwhmPx } from '../src/core/microtubules/calibration';
import type { Stack3D, Image2D } from '../src/core/types';
import { readTiffStack } from '../src/core/io/tiff';
import { arcChord } from '../src/core/microtubules/arc';

async function main(tiffPath: string, maxFrames: number): Promise<void> {
  const buf = fs.readFileSync(tiffPath);
  const blob = new Blob([buf.slice().buffer], { type: 'image/tiff' });
  const { channels } = await readTiffStack(blob);
  const stack = channels[0]!;
  const [Tfull, h, w] = stack.shape;
  const T = Math.min(Tfull, maxFrames);
  console.log(`Loaded: ${Tfull} frames (using ${T}), ${h}x${w}`);

  // Apply flatten_time first (the reference pipeline does this before detect).
  flattenTime(stack.data, Tfull, h * w, 50);
  console.log('flatten_time applied');

  // Per-frame detection.
  const perFrame: Float32Array[][] = [];
  let total = 0;
  const t0 = Date.now();
  for (let t = 0; t < T; t++) {
    const frame: Image2D = {
      data: stack.data.subarray(t * h * w, (t + 1) * h * w),
      shape: [h, w],
    };
    const fil = detectFilaments(frame, DEFAULT_DETECT);
    perFrame.push(fil);
    total += fil.length;
    if ((t + 1) % 5 === 0) {
      const elapsed = (Date.now() - t0) / 1000;
      console.log(`  detect ${t + 1}/${T} (avg ${(total / (t + 1)).toFixed(1)} fil/frame, ${elapsed.toFixed(1)}s)`);
    }
  }
  const counts = perFrame.map((f) => f.length);
  console.log(
    `Filaments: min=${Math.min(...counts)}, mean=${(total / T).toFixed(1)}, max=${Math.max(...counts)}, total=${total}`
  );

  // Arc length distribution for frame 0 (compare against reference).
  const f0Lens = (perFrame[0] ?? []).map((a) => a.length / 2).sort((a, b) => b - a);
  console.log(`Frame 0 arc lengths (top 20): ${f0Lens.slice(0, 20).join(', ')}`);
  const mean0 = f0Lens.reduce((s, v) => s + v, 0) / f0Lens.length;
  const med0 = f0Lens[Math.floor(f0Lens.length / 2)] ?? 0;
  console.log(`Frame 0 mean=${mean0.toFixed(1)}, median=${med0}`);
  console.log(
    `Frame 0 >= 100 px: ${f0Lens.filter((l) => l >= 100).length}, >= 50: ${f0Lens.filter((l) => l >= 50).length}, >= 30: ${f0Lens.filter((l) => l >= 30).length}`
  );

  // Track.
  let tracks = trackArcs(perFrame, h, w, DEFAULT_TRACK);
  console.log(`Tracks (>= ${DEFAULT_TRACK.minTrackLength} frames): ${tracks.length}`);

  // Orient + smooth.
  tracks = tracks.map((tr) => orientTrackToSeed(tr, 'minus'));
  tracks = tracks.map((tr) => smoothTrackTemporal(tr, 1.0));

  // Lineages (no length filter).
  const lineages = detectLineages(tracks, h, w, DEFAULT_LINEAGE);
  console.log(`Lineages (no length filter): ${lineages.length}`);

  // Length filter.
  const cleanedStack: Stack3D = {
    data: stack.data,
    shape: stack.shape,
  };
  const fwhm = measureAvgFwhmPx(tracks, cleanedStack);
  console.log(`FWHM = ${fwhm}, um_per_px = ${fwhm ? 0.025 / fwhm : null}`);
  if (fwhm) {
    const umPerPx = 0.025 / fwhm;
    const kept = lineages.filter((g) => {
      let maxLen = 0;
      for (const ti of g) {
        for (const arc of tracks[ti]!.arcs) {
          const c = arcChord(arc);
          if (c > maxLen) maxLen = c;
        }
      }
      return maxLen * umPerPx >= 1.0;
    });
    console.log(`Lineages after length filter (>= 1.0 um): ${kept.length}`);
  }
}

function flattenTime(stack: Float32Array, T: number, stride: number, pct: number): void {
  const globalP = percentile1d(stack, pct);
  const tmp = new Float32Array(stride);
  for (let t = 0; t < T; t++) {
    const off = t * stride;
    tmp.set(stack.subarray(off, off + stride));
    const frameP = percentile1d(tmp, pct);
    const shift = frameP - globalP;
    for (let p = 0; p < stride; p++) {
      const v = stack[off + p]! - shift;
      stack[off + p] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
}

function percentile1d(data: Float32Array, pct: number): number {
  if (data.length === 0) return 0;
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (Number.isFinite(v)) {
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  }
  if (!Number.isFinite(mn) || mn === mx) return mn;
  const bins = 4096;
  const counts = new Uint32Array(bins);
  const span = mx - mn;
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (!Number.isFinite(v)) continue;
    let b = Math.floor(((v - mn) / span) * bins);
    if (b < 0) b = 0;
    else if (b >= bins) b = bins - 1;
    counts[b]!++;
    n++;
  }
  const target = Math.floor((pct / 100) * n);
  let cum = 0;
  for (let b = 0; b < bins; b++) {
    cum += counts[b]!;
    if (cum >= target) return mn + (b / bins) * span;
  }
  return mx;
}

const tiffPath = process.argv[2];
const maxFrames = process.argv[3] ? parseInt(process.argv[3], 10) : 9999;
if (!tiffPath) {
  console.error('Usage: vite-node scripts/parity-test.ts <cleaned.tif> [maxFrames]');
  process.exit(1);
}
main(tiffPath, maxFrames).catch((e) => {
  console.error(e);
  process.exit(1);
});
