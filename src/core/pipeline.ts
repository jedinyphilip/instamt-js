import {
  readTiffStack,
  writeTiffStack16,
  writeTiffStack8FromU8,
  writeTiffStackRgbFromU8,
} from './io/tiff';
import {
  computePerMtMetrics,
  type PerMtMetrics,
  type PerMtTimeseries,
} from './metrics/per-mt';
import { measureAvgFwhmPx } from './microtubules/calibration';
import { DEFAULT_DETECT, type DetectConfig } from './microtubules/detect';
import {
  DEFAULT_HALO_FILTER,
  findHaloDots,
  isHaloTrack,
  type HaloFilterConfig,
} from './microtubules/halo';
import type { KymographResult } from './microtubules/kymograph';
import {
  detectLineages,
  DEFAULT_LINEAGE,
  type Lineage,
  type LineageConfig,
} from './microtubules/lineage';
import { renderOverlay, trackColors } from './microtubules/overlay';
import { orientTrackToSeed, smoothTrackTemporal } from './microtubules/postprocess';
import { cropCenter, probeMtScale, scaleDetectConfig } from './microtubules/scale';
import { trackArcs, DEFAULT_TRACK, type Track } from './microtubules/track';
import { noop, type ProgressCallback } from './progress';
import { emptyStackShared, type Stack3D } from './types';
import { WorkerPool } from './worker/pool';

export interface PipelineConfig {
  fftCutoffPixels: number;
  fringeWindow: number;
  fringeBoost: number;
  contrast: number;
  /** Multiplier for NLM smoothing strength (h = factor × estimated σ).
   *  1.0 ≈ skimage default, 0.5–0.8 preserves more fine detail, > 2 over-smooths. */
  nlmHFactor: number;
  /** NLM patch size (odd integer, default 7). */
  nlmPatch: number;
  /** NLM search-window radius (default 11). Larger = slower, better quality. */
  nlmSearch: number;
  detect: DetectConfig;
  /**
   * Auto-scale the pixel-tied detection params (σ, min-arc-length,
   * junction gaps, min-object-size) to match the apparent MT
   * cross-section in the input. Implemented as a γ-normalised Hessian
   * scale probe on a representative cleaned frame, run between cleanup
   * and detection. Disable to use `detect.*` exactly as configured.
   */
  autoScale: boolean;
  iouThresh: number;
  minTrackLength: number;
  /**
   * Per-track temporal Gaussian smoothing of arc geometry (in frames).
   * 0 = disabled. Default 1.0.
   */
  temporalSigma: number;
  /**
   * Maximum allowed displacement (px) of a smoothed arc sample from
   * its raw per-frame position. Bounds the off-IRM-ridge drift that
   * the index-aligned smoothing introduces when the minus-end pixel
   * jitters or the MT shape evolves across the smoothing window.
   * Default 2.0; raise toward Infinity to recover plain index-only
   * smoothing, set to 0 to fully suppress smoothing (always keep raw).
   */
  temporalSmoothMaxDeltaPx: number;
  /**
   * Lineage detection — how multiple tracks of the same physical MT get
   * merged. The momentum check (`continuationCosine`) handles smooth
   * crossings while rejecting 90° meetings.
   */
  lineage: LineageConfig;
  /**
   * Halo filter — locates dark dust dots in the cleaned image and
   * drops tracks whose per-frame arcs predominantly sit on their
   * bright IRM halos. Disable by setting `darkThreshold` to 0.
   */
  haloFilter: HaloFilterConfig;
  anchor: 'minus' | 'plus';
  /**
   * Frame rate (Hz) for input channel 0. Drives kymograph time axis and
   * IRM-derived per-MT rates (the IRM channel paces kymograph rows).
   * null → fall back to the inverse of the TIFF-declared seconds/frame.
   */
  fpsCh0: number | null;
  /**
   * Frame rate (Hz) for input channel 1. Used as the IRM frame rate
   * when `swapChannels` is on. null → fall back to the TIFF-declared rate.
   */
  fpsCh1: number | null;
  /** Pixel size; null → auto-calibrate from the median MT-FWHM. */
  umPerPx: number | null;
  /** Known MT diameter (µm) used for the FWHM-based px → µm conversion. */
  mtWidthUm: number;
  minLengthUm: number;
  /** Override worker count; null → use `navigator.hardwareConcurrency`. */
  workerCount: number | null;
  /**
   * Force the channel count when reading the input TIFF. Use this if
   * Fiji exported your file without ImageJ ImageDescription metadata —
   * the reader can't otherwise tell whether N pages is "N time frames"
   * or "C channels × N/C frames". null → trust auto-detection.
   */
  forceTiffChannels: number | null;
  /**
   * Swap the IRM and fluor channels. Most acquisitions put IRM at
   * channel 0; some flip it. Default false (no swap).
   */
  swapChannels: boolean;
  /**
   * When true, include the raw (pre-cleanup) per-channel stacks in the
   * output ZIP as 16-bit TIFFs. Lets you sanity-check whether the read
   * itself is correct, independently of the cleanup pipeline.
   */
  dumpRawChannels: boolean;
  /**
   * When true, draw per-frame raw detections (cyan) and pre-lineage
   * tracks (yellow) on the overlay alongside the final lineage arcs
   * (in colour). Lets you see what the detector found vs what made it
   * through tracking and the length filter.
   */
  debugOverlay: boolean;
  /**
   * Number of frames the "Preview" button processes. Smaller =
   * snappier turnaround for tuning the cleanup / detection params.
   */
  previewFrames: number;
}

export const DEFAULT_CONFIG: PipelineConfig = {
  fftCutoffPixels: 60,
  fringeWindow: 41,
  fringeBoost: 1.3,
  contrast: 2.5,
  // 4.0 is the right h-factor when the input has already been
  // normalised to 0-255 (which the stack pre-normalisation step
  // guarantees).
  nlmHFactor: 4.0,
  nlmPatch: 7,
  // skimage's default. The previous default of 7 saved ~2.5× cleanup
  // time but knocked weak ridges below the Li threshold downstream,
  // losing real MTs. Drop to 7 only after confirming detection is
  // unaffected on your data.
  nlmSearch: 11,
  detect: DEFAULT_DETECT,
  autoScale: true,
  iouThresh: DEFAULT_TRACK.iouThresh,
  minTrackLength: DEFAULT_TRACK.minTrackLength,
  temporalSigma: 1.0,
  temporalSmoothMaxDeltaPx: 2.0,
  lineage: DEFAULT_LINEAGE,
  haloFilter: DEFAULT_HALO_FILTER,
  anchor: 'minus',
  fpsCh0: 20,
  fpsCh1: 20,
  umPerPx: null, // null → auto-calibrate from MT FWHM
  mtWidthUm: 0.025,
  // Calibrated against real data — 1.0 µm drops legitimate short MTs.
  minLengthUm: 0.5,
  workerCount: null,
  forceTiffChannels: null,
  swapChannels: false,
  dumpRawChannels: false,
  debugOverlay: false,
  previewFrames: 8,
};

export interface PipelineOutput {
  cleanedTiff: Uint8Array;
  overlayTiff: Uint8Array;
  /** One per surviving lineage. */
  kymographs: Array<{ label: string; tiff: Uint8Array }>;
  /** Per-MT metrics, ready for CSV. Indexed by lineage. */
  metrics: PerMtMetrics[];
  /** Per-MT per-frame metric traces. Same indexing as `metrics`. */
  timeseries: PerMtTimeseries[];
  /** Raw (pre-cleanup) per-channel TIFFs when `dumpRawChannels` is set. */
  rawChannels?: Array<{ name: string; tiff: Uint8Array }>;
  /** First-frame overlay preview as 8-bit RGBA (length = width*height*4),
   *  ready for `ImageData` / `putImageData`. */
  preview: { width: number; height: number; rgba: Uint8ClampedArray };
  /** All-frames cleaned IRM as packed Uint8 grayscale (T*H*W bytes).
   *  Used by the UI's preview-tab frame slider. */
  cleanedFrames: PreviewStack;
  /** All-frames overlay as packed Uint8 RGB (T*H*W*3 bytes). */
  /** Per-frame Uint8 quantisation of the (post-pre-norm) fluor channel.
   *  null for single-channel inputs. The overlay tab paints arcs over
   *  this when the user picks "Ch 1". */
  fluorFrames: PreviewStack | null;
  /** Per-frame list of (lineageId, label, colour, arc) entries — used by
   *  the UI to hit-test clicks on the overlay canvas to surface the
   *  corresponding lineage's kymograph. */
  overlayPerFrame: Array<
    Array<{ lineageId: number; label: string; color: [number, number, number]; arc: Float32Array }>
  >;
  /** Raw (un-encoded) kymograph buffers, indexed by lineage id —
   *  letting the UI render kymographs in modal popups without re-decoding
   *  the TIFF. */
  kymographsRaw: Array<{
    label: string;
    irmMask: { width: number; height: number; data: Float32Array };
    fluor: { width: number; height: number; data: Float32Array };
  }>;
  /** Resolved physical scales used at run-time, surfaced for the UI so
   *  kymograph axes can switch between (frames, px) and (sec, µm). */
  scale: {
    umPerPx: number | null;
    fps: number | null;
  };
  stem: string;
}

export interface PreviewStack {
  width: number;
  height: number;
  frameCount: number;
  /** Bytes per pixel: 1 for grayscale, 3 for RGB. */
  channels: 1 | 3;
  /** Length = frameCount * width * height * channels. */
  data: Uint8Array;
}

export interface RunOptions {
  /** When set, only process the first `previewMaxFrames` frames and
   *  skip kymograph extraction. Useful for "live" preview with the
   *  current config without waiting for the full stack. */
  previewMaxFrames?: number;
}

export async function runPipeline(
  file: File,
  config: PipelineConfig = DEFAULT_CONFIG,
  onProgress: ProgressCallback = noop,
  options: RunOptions = {}
): Promise<PipelineOutput> {
  // 1. Read.
  onProgress({ phase: 'reading', message: `Reading ${file.name}` });
  const readOpts =
    config.forceTiffChannels && config.forceTiffChannels > 1
      ? { forceChannels: config.forceTiffChannels }
      : {};
  const {
    channels,
    imagej,
    diagnostics,
    umPerPx: tiffUmPerPx,
    secondsPerFrame: tiffSecPerFrame,
  } = await readTiffStack(file, readOpts);
  const irmChannelIdx = config.swapChannels ? 1 : 0;
  const fluorChannelIdx = config.swapChannels ? 0 : 1;
  let stack = channels[irmChannelIdx] ?? channels[0]!;
  // If the TIFF has a second channel, treat it as raw fluorescence for
  // the kymograph sampling step. With one channel, we fall back to the
  // cleaned IRM as the fluor source — same behaviour as v0.1.
  let fluorRaw = channels[fluorChannelIdx] ?? null;
  if (config.swapChannels) {
    onProgress({ phase: 'reading', message: 'Channels swapped: ch1 → IRM, ch0 → fluor' });
  }
  // Preview mode: truncate the stack to the first N frames before any
  // per-frame work. Rebind `stack` and `fluorRaw` to the shorter views
  // so the rest of the pipeline reads natural lengths.
  if (
    options.previewMaxFrames &&
    options.previewMaxFrames > 0 &&
    options.previewMaxFrames < stack.shape[0]
  ) {
    const Tprev = options.previewMaxFrames;
    const [, hh, ww] = stack.shape;
    const stride = hh * ww;
    stack = { data: stack.data.subarray(0, Tprev * stride), shape: [Tprev, hh, ww] };
    if (fluorRaw) {
      fluorRaw = {
        data: fluorRaw.data.subarray(0, Tprev * stride),
        shape: [Tprev, hh, ww],
      };
    }
    onProgress({
      phase: 'reading',
      message: `Preview mode: processing first ${Tprev} frames only`,
    });
  }
  const [T, h, w] = stack.shape;
  onProgress({
    phase: 'reading',
    message:
      `TIFF: ${diagnostics.pageCount} pages, ${diagnostics.width}×${diagnostics.height}, ` +
      `${diagnostics.samplesPerPixel} samples/pixel, ${diagnostics.bitsPerSample}-bit, ` +
      `planar=${diagnostics.planarConfig}${diagnostics.planarConfigPresent ? '' : ' (default)'}; ` +
      `→ ${channels.length} channels × ${T} frames (${diagnostics.channelSource})`,
  });
  diagnostics.firstFrameStats.forEach((st, i) => {
    onProgress({
      phase: 'reading',
      message: `  ch${i} first-frame stats: min=${st.min.toFixed(0)} mean=${st.mean.toFixed(0)} max=${st.max.toFixed(0)}`,
    });
  });
  if (diagnostics.imageDescriptionExcerpt) {
    onProgress({
      phase: 'reading',
      message: `ImageDescription: ${diagnostics.imageDescriptionExcerpt.replace(/\n/g, ' | ')}`,
    });
  }
  if (imagej) {
    onProgress({
      phase: 'reading',
      message: `ImageJ hyperstack: channels=${imagej.channels} slices=${imagej.slices} frames=${imagej.frames}`,
    });
  }
  if (tiffUmPerPx != null) {
    onProgress({
      phase: 'reading',
      message: `Pixel size from TIFF metadata: ${tiffUmPerPx.toFixed(5)} µm/px${
        tiffSecPerFrame != null ? `, ${tiffSecPerFrame.toFixed(4)} s/frame` : ''
      }`,
    });
  }

  // 1b. Stack-wide pre-normalisation. Compute the 0.1% / 99.9%
  // percentiles across the whole stack, then map every pixel of
  // every frame linearly onto [0, 255]. Every cleanup default (NLM
  // h-factor, contrast, fringe boost…) is calibrated for that range;
  // without this step raw 16-bit values feed cleanup with a dynamic
  // range ~100× off and no parameter retune compensates.
  const [pLo, pHi] = stackPercentileLevels(stack.data, 0.001, 0.999);
  onProgress({
    phase: 'reading',
    message: `Stack levels: 0.1%=${pLo.toFixed(0)}, 99.9%=${pHi.toFixed(0)} → mapping to [0, 255]`,
  });
  const lvScale = pHi > pLo ? 255 / (pHi - pLo) : 0;
  for (let i = 0; i < stack.data.length; i++) {
    const v = (stack.data[i]! - pLo) * lvScale;
    stack.data[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  if (fluorRaw) {
    // Fluor channel keeps its own per-stack levelling (different
    // distribution from IRM). Same percentile recipe.
    const [fLo, fHi] = stackPercentileLevels(fluorRaw.data, 0.001, 0.999);
    const fScale = fHi > fLo ? 255 / (fHi - fLo) : 0;
    for (let i = 0; i < fluorRaw.data.length; i++) {
      const v = (fluorRaw.data[i]! - fLo) * fScale;
      fluorRaw.data[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    // Re-allocate fluor into a SharedArrayBuffer so the kymograph phase
    // can read it concurrently from multiple workers without a
    // per-job copy. One-time copy here is cheap relative to the savings
    // when N kymograph workers each avoid a (T·H·W·4)-byte round-trip.
    const sharedFluor = emptyStackShared(fluorRaw.shape, 'fluor');
    sharedFluor.data.set(fluorRaw.data);
    fluorRaw = sharedFluor;
  }

  // 2 + 3. Cleanup + per-frame detection in parallel via a worker pool.
  // Pool size defaults to `navigator.hardwareConcurrency` (logical cores).
  // Anti-fingerprinting browsers may cap this — we just take what they
  // expose. Honour an explicit override on the config when the caller
  // wants fewer workers (e.g. to leave headroom for other tabs).
  //
  // `cleaned` lives in a SharedArrayBuffer so that (a) per-frame
  // `subarray().set(res.cleaned)` writes from worker callbacks land
  // straight in the shared buffer, and (b) the parallel-kymograph
  // phase below reads it concurrently with no copy.
  let cleaned: Stack3D = emptyStackShared(stack.shape, 'irm');
  const stride = h * w;
  const perFrame: Float32Array[][] = new Array<Float32Array[]>(T);
  const perFrameMedian = new Float64Array(T);
  const detectedCores = navigator.hardwareConcurrency || 4;
  const poolSize = Math.max(1, Math.min(T, config.workerCount ?? detectedCores));
  onProgress({
    phase: 'cleanup',
    message: `Spawning ${poolSize} workers (detected ${detectedCores} logical cores)`,
  });
  const pool = new WorkerPool(poolSize);
  try {
    // Pass 1: cleanup. Each worker also returns the per-frame median —
    // we use those scalars to compute the flatten-time shift on the
    // main thread (T scalars, not T·N pixels), and apply the shift
    // inside pass 2's worker call. This eliminates the ~1-3 s
    // serial main-thread `flattenTime` pass over the full stack.
    let done = 0;
    const cleanupPromises: Promise<void>[] = [];
    for (let i = 0; i < T; i++) {
      const frameCopy = new Float32Array(stride);
      frameCopy.set(stack.data.subarray(i * stride, (i + 1) * stride));
      const idx = i;
      cleanupPromises.push(
        pool
          .submit(frameCopy, w, h, {
            fftCutoffPixels: config.fftCutoffPixels,
            fringeWindow: config.fringeWindow,
            fringeBoost: config.fringeBoost,
            contrast: config.contrast,
            nlmHFactor: config.nlmHFactor,
            nlmPatch: config.nlmPatch,
            nlmSearch: config.nlmSearch,
            detect: config.detect,
            mode: 'cleanup',
          })
          .then((res) => {
            cleaned.data.subarray(idx * stride, (idx + 1) * stride).set(res.cleaned);
            perFrameMedian[idx] = res.perFrameMedian ?? 0;
            done++;
            onProgress({
              phase: 'cleanup',
              channel: 'irm',
              current: done,
              total: T,
              message: `Cleanup ${done}/${T} (×${poolSize} workers)`,
            });
          })
      );
    }
    await Promise.all(cleanupPromises);

    // Memory: pass-1 inputs are no longer needed. The only consumers
    // downstream are the cleaned (SAB) and fluorRaw (SAB) buffers; the
    // original raw channel buffers (1× T·H·W per channel) can be GC'd.
    // Skipped when `dumpRawChannels` is on, since that path needs the
    // original channels for the end-of-pipeline TIFF dump.
    if (!config.dumpRawChannels) {
      channels.length = 0;
      // Replace `stack` with an empty placeholder so its underlying
      // buffer (which was channels[irm].data) becomes unreachable.
      stack = { data: new Float32Array(0), shape: stack.shape };
    }

    // 3a. Brightness flatten via per-frame medians. Each frame's
    // median is moved to the median-of-medians; computed from T
    // scalars so there's no main-thread pass over T·N pixels.
    const refMedian = medianOf(perFrameMedian);
    const shifts = new Float64Array(T);
    let maxShift = 0;
    for (let t = 0; t < T; t++) {
      shifts[t] = perFrameMedian[t]! - refMedian;
      const a = Math.abs(shifts[t]!);
      if (a > maxShift) maxShift = a;
    }
    onProgress({
      phase: 'cleanup',
      message: `Per-frame median: ref=${refMedian.toFixed(1)}, max |shift|=${maxShift.toFixed(1)}`,
    });

    // 3b. Auto-scale probe. Sweep γ-normalised Hessian eigenvalue
    // across σ on a centre-cropped middle frame; pick the σ with the
    // strongest ridge response and rescale the pixel-tied detection
    // params (sigmas, min-arc-length, junction gaps, min-object-size).
    // Skipped when the inferred scale is within ±10% of the default.
    let effectiveDetect = config.detect;
    if (config.autoScale) {
      const probeFrameIdx = Math.floor(T / 2);
      const probeImg = {
        data: cleaned.data.slice(
          probeFrameIdx * stride,
          (probeFrameIdx + 1) * stride
        ),
        shape: [h, w] as const,
      };
      // Probe the per-frame shift first so we don't bias the response
      // on a frame whose median is far from the reference.
      const sh = shifts[probeFrameIdx]!;
      if (sh !== 0) {
        for (let i = 0; i < probeImg.data.length; i++) {
          const v = probeImg.data[i]! - sh;
          probeImg.data[i] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
      const cropped = cropCenter(probeImg, 512);
      const probe = probeMtScale(cropped);
      onProgress({
        phase: 'cleanup',
        message:
          `Auto-scale: probe peak σ=${probe.peakSigma.toFixed(2)} px ` +
          `(scale ×${probe.scale.toFixed(2)} relative to default)`,
      });
      if (probe.scale < 0.9 || probe.scale > 1.1) {
        effectiveDetect = scaleDetectConfig(config.detect, probe.scale);
        onProgress({
          phase: 'cleanup',
          message:
            `Auto-scale: detect.sigmas → [${effectiveDetect.sigmas.join(', ')}], ` +
            `minArcLength=${effectiveDetect.minArcLength}, ` +
            `minObjectSize=${effectiveDetect.minObjectSize}, ` +
            `maxJunctionGap=${effectiveDetect.maxJunctionGap}, ` +
            `junctionMergeRadius=${effectiveDetect.junctionMergeRadius}`,
        });
      }
    }

    // Pass 2: shift-and-detect. The worker subtracts the per-frame
    // shift in place (clipped to [0, 255]) before running the ridge
    // filter — same numerics as the old flatten+detect, one fewer
    // serial main-thread step.
    let doneDet = 0;
    const detPromises: Promise<void>[] = [];
    for (let i = 0; i < T; i++) {
      const frameCopy = new Float32Array(stride);
      frameCopy.set(cleaned.data.subarray(i * stride, (i + 1) * stride));
      const idx = i;
      detPromises.push(
        pool
          .submit(frameCopy, w, h, {
            fftCutoffPixels: config.fftCutoffPixels,
            fringeWindow: config.fringeWindow,
            fringeBoost: config.fringeBoost,
            contrast: config.contrast,
            nlmHFactor: config.nlmHFactor,
            nlmPatch: config.nlmPatch,
            nlmSearch: config.nlmSearch,
            detect: effectiveDetect,
            mode: 'detectWithShift',
            shift: shifts[idx]!,
          })
          .then((res) => {
            // Write the shifted cleaned back into the shared stack so
            // downstream steps see flatten-time-corrected data.
            cleaned.data.subarray(idx * stride, (idx + 1) * stride).set(res.cleaned);
            perFrame[idx] = res.filaments ?? [];
            doneDet++;
            onProgress({
              phase: 'cleanup',
              channel: 'irm',
              current: doneDet,
              total: T,
              message: `Detect ${doneDet}/${T} (×${poolSize} workers)`,
            });
          })
      );
    }
    await Promise.all(detPromises);
  } catch (e) {
    pool.terminate();
    throw e;
  }
  // Defensive fill — any frame whose worker errored without a result.
  for (let i = 0; i < T; i++) {
    if (!perFrame[i]) perFrame[i] = [];
  }

  // Detection diagnostics: how many filaments did we find per frame?
  let totalFilaments = 0;
  let minFil = Infinity;
  let maxFil = -Infinity;
  for (let i = 0; i < T; i++) {
    const n = perFrame[i]!.length;
    totalFilaments += n;
    if (n < minFil) minFil = n;
    if (n > maxFil) maxFil = n;
  }
  const meanFil = totalFilaments / Math.max(1, T);
  onProgress({
    phase: 'cleanup',
    message: `Detection: ${totalFilaments} filaments across ${T} frames (min=${minFil} mean=${meanFil.toFixed(1)} max=${maxFil}/frame)`,
  });

  // 4. Tracking. In preview mode the stack is too short for the
  // configured `minTrackLength` to be satisfied — clamp so we can
  // still surface a meaningful overlay.
  const effectiveMinTrack = options.previewMaxFrames
    ? Math.min(config.minTrackLength, Math.max(2, T - 1))
    : config.minTrackLength;
  onProgress({
    phase: 'tracking',
    message:
      effectiveMinTrack === config.minTrackLength
        ? 'Linking arcs across frames'
        : `Linking arcs across frames (preview: minTrackLength reduced ${config.minTrackLength} → ${effectiveMinTrack})`,
  });
  let tracks: Track[] = trackArcs(perFrame, h, w, {
    iouThresh: config.iouThresh,
    minTrackLength: effectiveMinTrack,
    dilate: 3,
  });
  onProgress({
    phase: 'tracking',
    message: `Tracking: ${tracks.length} tracks survived (minTrackLength=${effectiveMinTrack})`,
  });

  // 4b. Halo filter — locate dark dust dots PER FRAME (dust drifts,
  //     so a single representative frame misses where the dot was
  //     earlier / later) and drop any track whose per-frame arcs
  //     predominantly trace a halo around their current dot. Done
  //     before orientation/smoothing/lineage so dust tracks don't
  //     get polished or merged into real lineages downstream.
  if (config.haloFilter.darkThreshold > 0) {
    const dotsPerFrame: ReturnType<typeof findHaloDots>[] = new Array(T);
    let totalDots = 0;
    let framesWithDots = 0;
    for (let ft = 0; ft < T; ft++) {
      const frameImg = {
        data: cleaned.data.subarray(ft * stride, (ft + 1) * stride),
        shape: [h, w] as const,
      };
      const dots = findHaloDots(frameImg, config.haloFilter);
      dotsPerFrame[ft] = dots;
      totalDots += dots.length;
      if (dots.length > 0) framesWithDots++;
    }
    onProgress({
      phase: 'tracking',
      message:
        `Halo filter: ${totalDots} dust-dot detections across ${framesWithDots}/${T} frames ` +
        `(avg ${(totalDots / Math.max(1, T)).toFixed(1)}/frame, ` +
        `darkThreshold=${config.haloFilter.darkThreshold}, ` +
        `dim ${config.haloFilter.minDotDimPx}-${config.haloFilter.maxDotDimPx} px)`,
    });
    if (totalDots > 0) {
      const before = tracks.length;
      tracks = tracks.filter((t) => !isHaloTrack(t, dotsPerFrame, config.haloFilter));
      onProgress({
        phase: 'tracking',
        message: `Halo filter: ${before} → ${tracks.length} tracks (${before - tracks.length} dropped)`,
      });
    }
  }

  // 5. Orientation + temporal smoothing.
  tracks = tracks.map((t) => orientTrackToSeed(t, config.anchor));
  if (config.temporalSigma > 0) {
    tracks = tracks.map((t) =>
      smoothTrackTemporal(t, config.temporalSigma, config.temporalSmoothMaxDeltaPx)
    );
  }

  // 6. Lineages.
  onProgress({ phase: 'lineages', message: 'Grouping tracks into lineages' });
  let lineages: Lineage[] = detectLineages(tracks, h, w, config.lineage);
  onProgress({
    phase: 'lineages',
    message: `Lineages: ${lineages.length} groups built from ${tracks.length} tracks`,
  });

  // 6b. Pixel-size calibration. Priority:
  //   1. Explicit config.umPerPx (user override)
  //   2. TIFF-declared scale (SCIFIO/OME/ImageJ ImageDescription)
  //   3. Auto-derive from MT cross-section FWHM (only when nothing else)
  //
  // The FWHM path is the least reliable — it depends on `mtWidthUm`
  // being the apparent IRM-broadened width, which varies with
  // objective/PSF. When the source TIFF tells us the actual µm/px,
  // that's authoritative.
  let umPerPx = config.umPerPx;
  if (umPerPx == null && tiffUmPerPx != null && tiffUmPerPx > 0) {
    umPerPx = tiffUmPerPx;
    onProgress({
      phase: 'lineages',
      message: `Calibration: ${umPerPx.toFixed(5)} µm/px from TIFF metadata`,
    });
  }
  if (umPerPx == null) {
    const fwhm = measureAvgFwhmPx(tracks, cleaned);
    if (fwhm != null && fwhm > 0) {
      umPerPx = config.mtWidthUm / fwhm;
      onProgress({
        phase: 'lineages',
        message: `Auto-calibrated: median FWHM = ${fwhm.toFixed(2)} px → ${umPerPx.toFixed(4)} µm/px (no TIFF metadata)`,
      });
    }
  }

  // 7. Length filter — applied per-track within each lineage. Short
  //    fragment tracks that got absorbed into a lineage (via temporal
  //    IoU or spatial-overlap merging) get dropped from their lineage
  //    so they don't clutter the overlay or inflate the lineage's
  //    metrics. Empty lineages after this filter are dropped entirely.
  const lineagesBeforeFilter = lineages.length;
  let tracksRemoved = 0;
  if (umPerPx && config.minLengthUm > 0) {
    const minLenPx = config.minLengthUm / (umPerPx ?? 1);
    const passesMinLength = (ti: number): boolean => {
      let maxLen = 0;
      for (const arc of tracks[ti]!.arcs) {
        let s = 0;
        for (let i = 2; i < arc.length; i += 2) {
          const dy = arc[i]! - arc[i - 2]!;
          const dx = arc[i + 1]! - arc[i - 1]!;
          s += Math.hypot(dy, dx);
        }
        if (s > maxLen) maxLen = s;
      }
      return maxLen >= minLenPx;
    };
    lineages = lineages
      .map((g) => {
        const kept = g.filter(passesMinLength);
        tracksRemoved += g.length - kept.length;
        return kept;
      })
      .filter((g) => g.length > 0);
  }
  onProgress({
    phase: 'lineages',
    message:
      `Length filter: ${lineagesBeforeFilter} → ${lineages.length} lineages ` +
      `(minLengthUm=${config.minLengthUm}, ${tracksRemoved} short tracks dropped from surviving lineages)`,
  });

  // 8. Per-lineage outputs. Kymographs + metrics are always computed,
  // including in preview mode — preview is now just "process fewer
  // frames", not "skip downstream analysis". Catastrophe counts simply
  // read as 0 / NaN when the frame count is too small.
  //
  // Kymograph extraction is dispatched to the worker pool: each
  // lineage is independent, the irm + fluor stacks live in shared
  // memory (SharedArrayBuffer-backed Float32Arrays), so workers read
  // them concurrently without per-job copy. Per-MT metrics still run
  // on the main thread once all kymographs land — those are cheap
  // enough that worker overhead would dominate.
  const kymoResults: Array<{ label: string; kymo: KymographResult }> = [];
  const metrics: PipelineOutput['metrics'] = [];
  const timeseries: PipelineOutput['timeseries'] = [];

  // Use cleaned as the fluor source if the input was single-channel.
  // Both stacks must be SAB-backed for the worker reads to avoid a
  // copy; cleaned already is, fluorRaw was reallocated above.
  const fluorForKymo = fluorRaw ?? cleaned;

  let kymoDone = 0;
  const kymoPromises: Promise<{
    li: number;
    label: string;
    kymo: KymographResult | null;
    members: Track[];
  }>[] = [];
  for (let li = 0; li < lineages.length; li++) {
    const label = `L${(li + 1).toString().padStart(3, '0')}`;
    const members = lineages[li]!.map((idx) => tracks[idx]!);
    kymoPromises.push(
      pool
        .submitKymograph({
          irmShape: cleaned.shape,
          irmData: cleaned.data,
          fluorData: fluorForKymo.data,
          members,
          thickness: 2,
          step: 1.0,
        })
        .then((kymo) => {
          kymoDone++;
          onProgress({ phase: 'kymographs', current: kymoDone, total: lineages.length });
          return { li, label, kymo, members };
        })
    );
  }
  const kymoOutputs = await Promise.all(kymoPromises);
  // Stitch results in original lineage order so downstream consumers
  // (overlay colours, label `L001`, …) line up with `lineages`.
  kymoOutputs.sort((a, b) => a.li - b.li);

  for (const { label, kymo, members } of kymoOutputs) {
    if (!kymo) continue;
    kymoResults.push({ label, kymo });

    // If the user didn't pin an fps, fall back to the inverse of the
    // TIFF-declared seconds/frame. IRM paces the kymograph rows / per-MT
    // length traces.
    const tiffFallback = tiffSecPerFrame && tiffSecPerFrame > 0 ? 1 / tiffSecPerFrame : null;
    const irmFps = (config.swapChannels ? config.fpsCh1 : config.fpsCh0) ?? tiffFallback;
    const { summary, timeseries: ts } = computePerMtMetrics(
      label,
      members,
      cleaned,
      umPerPx,
      irmFps
    );
    metrics.push(summary);
    timeseries.push(ts);
  }
  pool.terminate();

  // 9. Encode outputs.
  //
  // Memory-tight ordering: build the Uint8 preview buffers first
  // (cleanedFrames + overlayFrames, both reused as the Uint8-input to
  // the TIFF encoders), drop the Float32 source buffers (cleaned,
  // fluorRaw), then encode TIFFs straight from the Uint8 buffers. The
  // previous order alloc'd a Float32 RGB overlay (12 bytes/pixel) on
  // top of cleaned (4 bytes/pixel) on top of both Uint8 preview
  // buffers, which OOM'd on bigger stacks.
  onProgress({ phase: 'writing', message: 'Encoding outputs' });

  const previewW = w;
  const previewH = h;

  // 9a. Quantise cleaned (Float32 [0, 255]) → Uint8.
  const cleanedFrames: PreviewStack = {
    width: previewW,
    height: previewH,
    frameCount: T,
    channels: 1,
    data: new Uint8Array(T * previewW * previewH),
  };
  for (let i = 0; i < cleaned.data.length; i++) {
    const v = cleaned.data[i]!;
    cleanedFrames.data[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }

  // 9b. Quantise fluorRaw → Uint8 fluorFrames (used by the overlay
  // tab when the user picks "Ch 1"). Skipped for single-channel input.
  let fluorFrames: PreviewStack | null = null;
  if (fluorRaw) {
    fluorFrames = {
      width: previewW,
      height: previewH,
      frameCount: T,
      channels: 1,
      data: new Uint8Array(T * previewW * previewH),
    };
    for (let i = 0; i < fluorRaw.data.length; i++) {
      const v = fluorRaw.data[i]!;
      fluorFrames.data[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }

  // 9c. Render overlay (Uint8 RGB) — used only to encode overlayTiff
  // for the download zip. The preview pane's overlay tab renders on
  // demand from cleanedFrames / fluorFrames + overlayPerFrame, so we
  // don't have to keep this RGB buffer alive after encoding.
  const colors = trackColors(lineages.length);
  const overlayOpts = config.debugOverlay
    ? { rawDetections: perFrame, rawTracks: tracks }
    : {};
  const { rgb: overlayRgb } = renderOverlay(cleaned, tracks, lineages, colors, overlayOpts);

  // 9d. Drop the Float32 sources now that all derived buffers are
  // built. ~T·H·W·4 bytes each — substantial headroom on big inputs.
  cleaned = { data: new Float32Array(0), shape: cleaned.shape };
  fluorRaw = null;

  // 9e. Encode TIFFs from the Uint8 sources.
  const cleanedTiff = writeTiffStack8FromU8(cleanedFrames.data, T, previewH, previewW);
  const overlayTiff = writeTiffStackRgbFromU8(overlayRgb.data, T, previewH, previewW);
  const kymographs = kymoResults.map(({ label, kymo }) => {
    const composite = kymoToFloat32Stack(kymo);
    return { label, tiff: writeTiffStack16(rescaleForU16(composite)) };
  });

  let rawChannels: PipelineOutput['rawChannels'];
  if (config.dumpRawChannels) {
    rawChannels = channels.map((ch, idx) => ({
      name: `raw_ch${idx}`,
      tiff: writeTiffStack16(rescaleForU16(ch)),
    }));
    onProgress({
      phase: 'writing',
      message: `Dumped ${rawChannels.length} raw channel TIFFs for inspection`,
    });
  }

  // First-frame preview: pull frame 0 RGB from the overlay Uint8
  // buffer and expand to RGBA for canvas putImageData.
  const previewRgba = new Uint8ClampedArray(previewW * previewH * 4);
  const f0 = overlayRgb.data;
  for (let p = 0; p < previewW * previewH; p++) {
    const sIdx = p * 3;
    const dIdx = p * 4;
    previewRgba[dIdx] = f0[sIdx]!;
    previewRgba[dIdx + 1] = f0[sIdx + 1]!;
    previewRgba[dIdx + 2] = f0[sIdx + 2]!;
    previewRgba[dIdx + 3] = 255;
  }

  // Per-frame lineage hit-test data: list of (lineageId, label, color, arc)
  // entries for every frame, so the UI can map clicks on the overlay
  // canvas back to a specific lineage and pop up its kymograph.
  const overlayPerFrame: PipelineOutput['overlayPerFrame'] = Array.from(
    { length: T },
    () => []
  );
  // Each lineage's kymograph index matches its position in `lineages`.
  const labelOf = (li: number): string => `L${(li + 1).toString().padStart(3, '0')}`;
  for (let li = 0; li < lineages.length; li++) {
    const color = colors[li] ?? [255, 255, 255];
    const label = labelOf(li);
    for (const ti of lineages[li]!) {
      const tr = tracks[ti]!;
      for (let i = 0; i < tr.frames.length; i++) {
        const f = tr.frames[i]!;
        if (f >= 0 && f < T) {
          overlayPerFrame[f]!.push({
            lineageId: li,
            label,
            color: color as [number, number, number],
            arc: tr.arcs[i]!,
          });
        }
      }
    }
  }

  const kymographsRaw: PipelineOutput['kymographsRaw'] = kymoResults.map(({ label, kymo }) => ({
    label,
    irmMask: {
      width: kymo.irmMask.shape[1],
      height: kymo.irmMask.shape[0],
      data: kymo.irmMask.data,
    },
    fluor: {
      width: kymo.fluor.shape[1],
      height: kymo.fluor.shape[0],
      data: kymo.fluor.data,
    },
  }));

  // Resolve fps the same way the metrics step does: configured fps,
  // else inverse of TIFF seconds/frame, else null. The kymograph axis
  // is paced by the IRM frame rate, so use that here.
  const tiffFallbackFps = tiffSecPerFrame && tiffSecPerFrame > 0 ? 1 / tiffSecPerFrame : null;
  const resolvedFps =
    (config.swapChannels ? config.fpsCh1 : config.fpsCh0) ?? tiffFallbackFps;

  const stem = file.name.replace(/\.(tif|tiff)$/i, '');
  const out: PipelineOutput = {
    cleanedTiff,
    overlayTiff,
    kymographs,
    metrics,
    timeseries,
    preview: { width: previewW, height: previewH, rgba: previewRgba },
    cleanedFrames,
    fluorFrames,
    overlayPerFrame,
    kymographsRaw,
    scale: { umPerPx: umPerPx ?? null, fps: resolvedFps },
    stem,
  };
  if (rawChannels) out.rawChannels = rawChannels;
  return out;
}

function rescaleForU16(stack: Stack3D): Stack3D {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < stack.data.length; i++) {
    const v = stack.data[i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  const out = new Float32Array(stack.data.length);
  for (let i = 0; i < stack.data.length; i++) {
    out[i] = ((stack.data[i]! - lo) / span) * 65535;
  }
  return { ...stack, data: out };
}

/** Median of a Float64Array. Used to pick the flatten-time reference
 *  brightness from a small array of per-frame medians (T scalars). */
function medianOf(arr: Float64Array): number {
  if (arr.length === 0) return 0;
  const sorted = Array.from(arr).filter((v) => Number.isFinite(v));
  sorted.sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = sorted.length >>> 1;
  return sorted.length % 2 === 0
    ? 0.5 * (sorted[mid - 1]! + sorted[mid]!)
    : sorted[mid]!;
}

/**
 * Stack-wide robust min/max via histogram-based percentiles. Mirrors
 * `pipeline.py:_stack_levels` (np.percentile across the whole T-stack).
 * Two passes: one for min/max bounds, one for the histogram.
 */
function stackPercentileLevels(
  data: Float32Array,
  lowFrac: number,
  highFrac: number
): [number, number] {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (Number.isFinite(v)) {
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  }
  if (!Number.isFinite(mn) || !Number.isFinite(mx) || mn === mx) {
    return [mn, mx];
  }
  const bins = 8192;
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
  const findBin = (frac: number): number => {
    const target = Math.floor(frac * n);
    let cum = 0;
    for (let b = 0; b < bins; b++) {
      cum += counts[b]!;
      if (cum >= target) return b;
    }
    return bins - 1;
  };
  return [mn + (findBin(lowFrac) / bins) * span, mn + (findBin(highFrac) / bins) * span];
}

function kymoToFloat32Stack(k: KymographResult): Stack3D {
  const [T, L] = k.fluor.shape;
  // Two-page stack: IRM mask first, fluor second. Lets users flip
  // between the two views in any TIFF viewer.
  const data = new Float32Array(2 * T * L);
  data.set(k.irmMask.data, 0);
  data.set(k.fluor.data, T * L);
  return { data, shape: [2, T, L] };
}
