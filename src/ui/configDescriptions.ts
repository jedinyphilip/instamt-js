/**
 * Human-readable descriptions for every field in `PipelineConfig`.
 * Keyed by dot-path (e.g. `detect.maxJunctionGap`). Shown as tooltips
 * on hover in the config form.
 */
export const CONFIG_DESCRIPTIONS: Record<string, string> = {
  // Cleanup pipeline.
  fftCutoffPixels:
    'FFT background-subtraction Gaussian low-pass cutoff in pixels. Features with spatial period > this are treated as background. Lower values remove more low-frequency drift; default 60.',
  fringeWindow:
    'Median window size for the local baseline in fringe-unification. Should be larger than the widest MT bundle. Default 41.',
  fringeBoost:
    'Multiplier applied to the mirrored deviation in fringe-unification. >1 recovers contrast lost to the median. Default 1.3.',
  contrast:
    'Linear contrast boost: deviations from the per-frame mean are multiplied by this factor after denoising. Default 2.5.',
  nlmHFactor:
    'Non-local means smoothing strength as a multiple of the estimated noise σ. ~1.0 preserves fine detail, ~4.0 smooths aggressively. Calibrated for 0-255 input.',
  nlmPatch: 'Non-local means patch size in pixels. Default 7.',
  nlmSearch:
    'Non-local means search-window radius in pixels. Larger = slower but better quality (cost scales as r²). Default 7; bump to 11 for skimage parity if you see residual graininess.',

  // Auto-scale.
  autoScale:
    'Auto-detect the apparent MT thickness (px) on a representative cleaned frame and rescale the pixel-tied detection params (sigmas, min-arc-length, junction gaps, min-object-size). Disable to use detect.* exactly as configured.',

  // Detection.
  'detect.sigmas':
    'Hessian-derivative scales (in px) for the Meijering ridge filter. The filter response is taken as the elementwise max across these scales. Match to the apparent MT cross-section.',
  'detect.minObjectSize':
    'Minimum connected-component size (pixels) in the binary ridge mask. Smaller components are dropped before skeletonisation. Default 30.',
  'detect.minArcLength':
    'Minimum arc length (pixels) after skeleton walking. Shorter arcs are discarded. Default 15.',
  'detect.maxJunctionGap':
    'Max distance (px) from an arc endpoint to a junction pixel for the endpoint to count as incident on that junction. Default 3.',
  'detect.junctionMergeRadius':
    'Branch-point clusters whose pixel sets are within this radius (px) get merged into a single super-junction. Default 6.',
  'detect.maxPairCost':
    'Max tangent dot-product to accept a pair of arcs as continuing through a junction. 0 = ≥90° from anti-parallel rejected. Default 0.',
  'detect.maxBrightnessPct':
    'Reject filaments whose median pixel intensity is above this percentile of the frame. MTs are dark in IRM. null = disabled. Set 50–70 to filter bright-spot artefacts.',
  'detect.hysteresisLowRatio':
    'Hysteresis low/high ratio for the ridge mask. The high threshold is the (global or local) Li cutoff; pixels above ratio × cutoff that are 4-connected to a seed pixel are also kept, rescuing faint MT terminals dragged below threshold by stronger ridges elsewhere. Lower = more aggressive rescue. 1.0 = disabled. Default 0.8.',
  'detect.localThresholdTile':
    'Tile size (px) for local Li thresholding. Li is computed per overlapping tile (centres on a tile/2-spaced grid) and bilinearly interpolated to a per-pixel cutoff. Adapts the threshold to regions where the global Li is dragged up by stronger ridges elsewhere. null = disabled (plain global Li). Default 256.',
  'detect.localThresholdFloorRatio':
    'Floor for per-tile Li, expressed as a fraction of the global Li. Tiles whose Li drops below this floor get pinned to it, preventing empty/uniform tiles from producing a noise-level threshold that lets the entire background through. Only applies when localThresholdTile is set. Default 0.5.',
  'haloFilter.darkThreshold':
    'Pixel intensity (0–255) below which a pixel counts as a dust-dot candidate. The cleaned IRM is stack-normalised to [0, 255]; dust centres typically sit near 0, so 60 is a conservative default. Lower = stricter (only the very darkest blobs are dust); raise to catch faintly-dark dust. Set to 0 to disable the halo filter entirely.',
  'haloFilter.minDotDimPx':
    'Minimum bbox dimension (px) — BOTH width AND height must exceed this for a dark blob to qualify as a dust dot. Should be a few times the apparent MT ridge width (~3–5 px), so an MT segment never makes it past on its short axis. Default 5.',
  'haloFilter.maxDotDimPx':
    'Maximum bbox dimension (px) — larger dark regions (cells, big debris, image edges) are not treated as dust. Default 40.',
  'haloFilter.minAspectRatio':
    'Minimum PCA-eigenvalue aspect ratio √(λ_small / λ_large) of the component pixels. 1.0 = isotropic (perfect disc / square / blob), 0 = perfectly linear. Default 0.7. PCA is preferred over bbox aspect because shapes like + / T can have bbox aspect 1.0 while their eigenvalue ratio is < 0.5.',
  'haloFilter.haloInnerMarginPx':
    'Halo band inner margin (px). A track point at distance d from a dot centre is "on the halo" if d ≥ dot_radius − this. Default 3.',
  'haloFilter.haloOuterMarginPx':
    'Halo band outer margin (px). A track point counts as "on the halo" if d ≤ dot_radius + this. Bright IRM halos typically extend ~10 px outside the dust perimeter. Default 10.',
  'haloFilter.minPerFrameHaloFraction':
    'Per-frame: fraction of arc points that must lie in the halo band of any dust dot for that frame to count as halo-following. Default 0.6.',
  'haloFilter.minTrackHaloFraction':
    'Per-track: fraction of frames classified halo-following for the whole track to be dropped. Default 0.5.',

  // Tracking.
  iouThresh:
    'Min dilated-mask IoU between consecutive frames to link arcs into the same track. Default 0.2.',
  minTrackLength:
    'Drop tracks shorter than this many frames. Filters out transient detections. Default 5.',

  // Lineage detection (merging tracks that belong to the same physical MT).
  'lineage.iouThresh':
    'Min dilated-mask IoU at the boundary frame to temporally link a track that ends with one that starts. Same idea as the tracking IoU but applied at lineage boundaries (merge/split events). Default 0.2.',
  'lineage.maxGap':
    'Max temporal gap (frames) between one track ending and another starting for them to be merged into one lineage. Default 2.',
  'lineage.adjacencyPx':
    'Endpoint distance threshold (px) for spatial lineage merging. Two coexisting tracks whose endpoints come within this radius AND pass the momentum test get merged. Needs to cover the synthetic gap that junctionMergeRadius + maxJunctionGap create between fragments meeting at a crossing — at default detect settings (radius 8, gap 6) two arcs continuing through a junction can have endpoints up to ~28 px apart. Default 20; raise toward 28 if crossing-MT lineages still split.',
  'lineage.adjacencyDot':
    'Tangent dot-product threshold for endpoint-adjacency lineage merging. Two coexisting tracks whose endpoints come within adjacencyPx AND whose outward tangents have dot ≤ this value get merged. −1 = perfectly anti-parallel; −0.9 ≈ 26° from anti-parallel. Less negative = more permissive merging.',
  'lineage.overlapIou':
    'Spatial-overlap threshold (IoU) for lineage merging. Two coexisting tracks whose dilated arc masks have IoU ≥ this value at any common frame get merged regardless of tangent direction — catches duplicate parallel detections of the same MT. Plain IoU (no containment fallback) keeps small-vs-large parallel pairs apart: the union is dominated by the larger arc so the IoU stays low. Default 0.4. Set to 1.0 to disable.',
  'lineage.overlapDilatePx':
    'Manhattan dilation radius (px) for the spatial-overlap arc masks. Larger = catches duplicates with bigger lateral offsets, but risks merging genuinely separate but close MTs. Default 6 — parallel arcs up to ~5 px apart trigger the IoU branch; raise to 8 for noisier detectors.',

  // Post-process.
  temporalSigma:
    'Per-track temporal Gaussian smoothing of arc geometry (in frames). 0 = disabled. Default 1.0.',
  temporalSmoothMaxDeltaPx:
    'Cap (in pixels) on how far each temporally-smoothed arc sample can move from its raw per-frame position. The smoothing aligns samples by arc-length index, not spatial position, which lets it drift off the IRM ridge when the minus-end pixel jitters or the MT shape evolves across the smoothing window — this cap bounds that drift. Default 2.0. Raise toward Infinity for un-capped smoothing, lower toward 0 to keep arcs near their raw detected positions.',
  anchor:
    'Which MT end is anchored at column 0 of the kymograph. "minus" = stable end (default), "plus" = dynamic end (for +TIPs).',

  // Calibration.
  fpsCh0:
    'Frame rate (Hz) for input channel 0. The IRM channel paces the kymograph time axis and IRM-derived per-MT rates, so this drives those when ch0 is IRM (default). null = inverse of the TIFF-declared seconds-per-frame, or leave axes in frames.',
  fpsCh1:
    'Frame rate (Hz) for input channel 1. Used as the IRM frame rate when `swapChannels` is on. null = inverse of the TIFF-declared seconds-per-frame.',
  umPerPx:
    'Pixel size in micrometres. null = use the TIFF-declared scale (SCIFIO/OME), or auto-calibrate from MT FWHM.',
  mtWidthUm:
    'Apparent MT width in µm, used for the FWHM-based fallback calibration when no other scale is available. Default 0.025.',
  minLengthUm:
    'Drop lineages whose longest arc-chord is below this many µm. Default 1.0. Needs a calibration to apply.',

  // Worker pool.
  workerCount:
    'Override the worker pool size. null = use `navigator.hardwareConcurrency` (logical cores).',

  // I/O.
  forceTiffChannels:
    'Force the channel count when reading the input TIFF — useful when Fiji exported without ImageJ ImageDescription metadata. null = auto.',
  swapChannels:
    'Swap the IRM and fluor channels. Most acquisitions put IRM at channel 0; some flip it.',
  dumpRawChannels:
    'Include the raw (pre-cleanup) per-channel TIFFs in the output ZIP for sanity-checking.',
  debugOverlay:
    'Draw raw per-frame detections (cyan) and pre-lineage tracks (yellow) on the overlay alongside the final lineage arcs.',
  previewFrames:
    'Number of frames the "Preview" button processes. Smaller = snappier param tuning; bigger = more representative metrics. Default 8.',
};
