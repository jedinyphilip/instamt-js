/**
 * Per-frame worker. The main thread sends a frame plus the cleanup +
 * detection config and receives back the cleaned frame and detected
 * filaments. Workers are stateless — fresh config every call.
 *
 * Two new modes vs the original two-pass pipeline:
 *
 *   - 'cleanup': cleanup + return a per-frame median scalar alongside
 *      the cleaned buffer. Lets us compute the global flatten-time
 *      shift on T scalars on the main thread instead of T·N pixels.
 *
 *   - 'detectWithShift': accept a cleaned frame + a shift scalar,
 *      apply `pix - shift` (clipped to [0, 255]) in place, then run
 *      detection. Replaces the standalone `flattenTime` main-thread
 *      pass and the legacy 'detect' worker call.
 *
 *   - 'kymograph': read a SharedArrayBuffer-backed irm + fluor stack
 *      and build a per-lineage kymograph. Lets us parallelise the
 *      kymograph phase across the worker pool with no per-job buffer
 *      copy (SAB is shared, not transferred).
 */

import { fftBackgroundSubtract } from '../cleanup/background';
import { denoise } from '../cleanup/denoise';
import { fringeUnify } from '../cleanup/fringe';
import { buildLineageKymograph, type KymographResult } from '../microtubules/kymograph';
import { detectFilaments, type DetectConfig } from '../microtubules/detect';
import type { Track } from '../microtubules/track';
import type { Shape3D } from '../types';

interface FrameCleanupParams {
  fftCutoffPixels: number;
  fringeWindow: number;
  fringeBoost: number;
  contrast: number;
  nlmHFactor: number;
  nlmPatch: number;
  nlmSearch: number;
}

export type WorkerRequest =
  | (FrameCleanupParams & {
      jobId: number;
      mode: 'cleanup';
      frame: Float32Array;
      width: number;
      height: number;
    })
  | {
      jobId: number;
      mode: 'detectWithShift';
      frame: Float32Array;
      width: number;
      height: number;
      shift: number;
      detect: DetectConfig;
    }
  | (FrameCleanupParams & {
      jobId: number;
      mode: 'both';
      frame: Float32Array;
      width: number;
      height: number;
      detect: DetectConfig;
    })
  | {
      jobId: number;
      mode: 'kymograph';
      irmShape: Shape3D;
      irmData: Float32Array;
      fluorData: Float32Array;
      members: Track[];
      thickness: number;
      step: number;
    };

export interface WorkerResponse {
  jobId: number;
  /** Cleaned frame for cleanup/detectWithShift/both modes. */
  cleaned?: Float32Array;
  filaments?: Float32Array[] | null;
  /** Set for mode='cleanup': median of the cleaned frame. */
  perFrameMedian?: number;
  /** Set for mode='kymograph'. */
  kymograph?: KymographResult | null;
}

self.addEventListener('message', (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;

  if (req.mode === 'kymograph') {
    handleKymograph(req);
    return;
  }

  const img = { data: req.frame, shape: [req.height, req.width] as const };
  let cleaned = img;

  if (req.mode === 'cleanup' || req.mode === 'both') {
    // bg-correct → fringe-unify → denoise+enhance.
    const { corrected } = fftBackgroundSubtract(img, req.fftCutoffPixels);
    const flipped = fringeUnify(corrected, req.fringeWindow, req.fringeBoost);
    cleaned = denoise(flipped, req.contrast, req.nlmHFactor, req.nlmPatch, req.nlmSearch);
  }

  let perFrameMedian: number | undefined;
  if (req.mode === 'cleanup') {
    perFrameMedian = histogramMedian(cleaned.data);
  }

  if (req.mode === 'detectWithShift') {
    const data = cleaned.data;
    const shift = req.shift;
    for (let i = 0; i < data.length; i++) {
      const v = data[i]! - shift;
      data[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }

  let filaments: Float32Array[] | null = null;
  if (req.mode === 'detectWithShift' || req.mode === 'both') {
    filaments = detectFilaments(cleaned, req.detect);
  }

  const transfer: Transferable[] = [cleaned.data.buffer];
  if (filaments) {
    for (const f of filaments) transfer.push(f.buffer);
  }
  const resp: WorkerResponse = {
    jobId: req.jobId,
    cleaned: cleaned.data,
    filaments,
    ...(perFrameMedian !== undefined ? { perFrameMedian } : {}),
  };
  (self as unknown as Worker).postMessage(resp, transfer);
});

function handleKymograph(req: Extract<WorkerRequest, { mode: 'kymograph' }>): void {
  const irmStack = { data: req.irmData, shape: req.irmShape };
  const fluorStack = { data: req.fluorData, shape: req.irmShape };
  const kymo = buildLineageKymograph(req.members, irmStack, fluorStack, req.thickness, req.step);
  const transfer: Transferable[] = [];
  if (kymo) {
    transfer.push(kymo.irmMask.data.buffer, kymo.fluor.data.buffer);
    if (kymo.framesPresent.buffer instanceof ArrayBuffer) {
      transfer.push(kymo.framesPresent.buffer);
    }
    transfer.push(kymo.refArc.buffer);
  }
  const resp: WorkerResponse = {
    jobId: req.jobId,
    kymograph: kymo,
  };
  (self as unknown as Worker).postMessage(resp, transfer);
}

/**
 * Histogram-based 50th-percentile estimate over a Float32Array of values
 * roughly bounded by [0, 255]. Matches `percentile1d` in pipeline.ts —
 * the worker copy avoids a main-thread import inside the worker bundle.
 */
function histogramMedian(data: Float32Array): number {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (Number.isFinite(v)) {
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  }
  if (!Number.isFinite(mn) || mn === mx) return Number.isFinite(mn) ? mn : 0;
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
  const target = Math.floor(0.5 * n);
  let cum = 0;
  for (let b = 0; b < bins; b++) {
    cum += counts[b]!;
    if (cum >= target) return mn + (b / bins) * span;
  }
  return mx;
}
