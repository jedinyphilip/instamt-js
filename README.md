# insta-mt (browser build)

In-browser IRM microtubule cleanup, detection, tracking and per-MT kymograph
extraction. Drop a multi-page TIFF in, get a zip out. Nothing leaves your
machine — there is no server.

Live: <https://yourusername.github.io/instamt-js/> (set this after you deploy.)

## Why

The desktop pipeline works fine, but it's a Python + conda dance every time
you want to hand it to someone else. The browser version exists for exactly
one workflow: sending a colleague a URL so they can run their own data without
installing anything. If you're doing batch processing, headless work, or
anything that doesn't fit in one tab, stay on the desktop side.

## Quick start

```
npm install
npm run dev
```

Vite serves on `http://localhost:5173/`. The dev server sets the COOP/COEP
headers itself so SharedArrayBuffer works without the service-worker dance
described below.

Drop a 2-channel TIFF (IRM on channel 0, fluor on channel 1) onto the page
and hit **Run**, or **Preview** to chew through the first 8 frames while you
tune config. There's a hint next to every config field if you hover.

## Input format

- Multi-page TIFF, 8 or 16-bit, single or two channel.
- Channel 0 is IRM, channel 1 is fluor. There's a `swapChannels` flag if
  yours is the other way around.
- `.nd2` and friends: convert to TIFF in Fiji first
  (`File → Import → Bio-Formats…` then `File → Save As → Tiff…`). Native
  ND2 reading would mean shipping the Bio-Formats WASM bundle (~25 MB),
  which I haven't been willing to pay for yet.

If the TIFF doesn't carry ImageJ metadata, the reader can't always tell
whether N pages means "N frames" or "C channels × N/C frames"; the
`forceTiffChannels` knob lets you override.

## What the pipeline does

The stages mirror the Python pipeline closely, with a few simplifications.

1. **Cleanup** — stack-wide percentile normalisation to [0, 255], FFT
   low-pass background subtraction, fringe unification, NLM denoise,
   contrast boost. All run per-frame in a worker pool.
2. **Detection** — Meijering ridge filter at multiple scales, Li threshold
   (optionally local + hysteresis), skeletonisation, branch-point split,
   skeleton walk, junction-aware pairing. Auto-scale probes a middle
   frame and rescales the pixel-tied params so the same defaults work
   across acquisitions.
3. **Tracking** — dilated-mask IoU + Hungarian linker, per-frame.
4. **Halo filter** — per-frame, finds dark dust spots (PCA-isotropic
   blobs above a few × MT width) and drops any track that traces their
   bright IRM halo. Dust drifts, so the dots are recomputed each frame.
5. **Smoothing + orientation** — temporal Gaussian over arc-length-indexed
   samples, with each smoothed sample capped to within
   `temporalSmoothMaxDeltaPx` of its raw position (otherwise the
   index-aligned smoothing tugs arcs off the ridge when the minus end
   wobbles).
6. **Lineages** — three merge criteria, any of which is sufficient:
   temporal IoU at the boundary frame, endpoint anti-parallel adjacency,
   and per-frame spatial-overlap IoU on the dilated arc masks. The PCA-
   based endpoint tangent (in `arc.ts`) is what makes the anti-parallel
   test actually reliable.
7. **Length filter** — applied per-track within each lineage, so a short
   noise fragment absorbed into a long lineage gets dropped from it
   instead of inflating its metrics.
8. **Outputs** — overlay TIFF + PNG, per-lineage kymographs (IRM and
   fluor, sampled along the arc), per-MT metrics CSV, global metrics CSV,
   all bundled into a zip.

The kymograph modal shows the IRM and fluor channels side by side, both
sampled the same way along the arc, with a units toggle (sec/µm ↔
frame/px) that rewrites the axes and the metrics table.

## Tests

```
npm test
```

Vitest. The suite mostly checks that the filter primitives (Gaussian,
median, FFT background, Meijering, Li threshold, skeletonisation,
Hungarian) match their scikit-image / scipy counterparts on small
fixtures. There's also a TIFF round-trip and a tracker sanity check.
End-to-end parity against the Python pipeline lives in
[scripts/parity-test.ts](scripts/parity-test.ts) and runs against
locally-staged reference outputs — not part of `npm test`.

When you add an algorithm port, please add a fixture-vs-reference test.
It catches drift much faster than eyeballing the overlay.

## Build for production

```
npm run build
```

Static bundle in `dist/`. Deploy anywhere that serves files. The default
`vite.config.ts` builds with `base = /instamt-js/`; override `VITE_BASE`
for a different repo name or a custom domain.

## Deploying to GitHub Pages

`.github/workflows/pages.yml` builds and deploys on every push to `main`.
Enable Pages in repo settings (**Source: GitHub Actions**) and that's it.
If your repo isn't called `instamt-js`, set a `VITE_BASE` repo Actions
variable like `/your-repo-name/`.

Pages doesn't let you set custom HTTP headers, but multi-threaded WASM
and SharedArrayBuffer need cross-origin-isolation. The trick is
`public/coi-serviceworker.js` (vendored from
[gzuidhof/coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker)):
it registers a service worker on first load that re-injects the headers
via fetch interception. First-load reload is unavoidable; everything
after is normal.

## Layout

```
src/
  core/
    pipeline.ts            top-level orchestrator
    progress.ts            event type for the progress callback
    types.ts               Stack3D / Image2D
    io/
      tiff.ts              utif wrapper, Float32 normalised
      nd2.ts               placeholder (convert in Fiji for now)
    filters/
      fft.ts               2D FFT around fft.js, with mirror pad
      gaussian.ts          separable Gaussian, σ/√2 two-pass
      hessian.ts           Gaussian-derivative kernels
      median.ts            quickselect-based
      meijering.ts         port of skimage `meijering`
      nlm.ts               non-local means
      skeletonize.ts       Zhang–Suen
      threshold.ts         Li threshold, global + tiled local
      wavelet.ts           unused; kept for an experiment
    cleanup/
      background.ts        FFT low-pass subtract
      denoise.ts           median + NLM + Gaussian + contrast
      fringe.ts            median baseline + |dev| mirror
    microtubules/
      arc.ts               arc type + PCA-based endpoint tangent
      calibration.ts       FWHM-based px → µm fallback
      detect.ts            per-frame ridge → mask → skeleton → arcs
      halo.ts              dust-dot detector + halo-track filter
      hungarian.ts         Jonker–Volgenant for the tracker
      junctions.ts         branch-point clusters, arc pairing
      kymograph.ts         per-lineage (T, L) IRM + fluor sampling
      lineage.ts           temporal + spatial track merging
      overlay.ts           Bresenham line drawing onto a Uint8 RGB
      postprocess.ts       seed-end orientation, temporal smoothing
      scale.ts             γ-normalised Hessian probe for autoscale
      segment.ts           skeleton walk → ordered arcs
      track.ts             dilated-mask IoU + Hungarian linker
    metrics/
      per-mt.ts            length / curvature / fluor / catastrophes
    worker/
      pipeline.worker.ts   per-frame cleanup + detection in a worker
      pool.ts              tiny round-robin worker pool
  ui/
    App.ts                 page shell + run/preview/download wiring
    configDescriptions.ts  per-field tooltips
    configForm.ts          the config panel
    kymoModal.ts           per-lineage IRM/fluor + metrics modal
    log.ts                 in-page console
    metrics.ts             global + per-MT metric tables
    preview.ts             input / cleaned / overlay viewer
    styles.css
  main.ts                  entry
tests/                     small per-primitive fixtures
public/
  coi-serviceworker.js     COOP/COEP injector for Pages
scripts/
  parity-test.ts           offline JS-vs-Python comparison harness
```

## Known rough edges

- Closed-loop MTs aren't really supported — they'd be filtered as tight
  wraps. None of the data I've seen has them.
- The temporal-smoothing alignment is by arc-length index from the
  oriented minus end, not by spatial registration. The displacement cap
  patches around the worst cases but a proper ICP-style alignment would
  be cleaner.
- Single-page TIFFs go through the multi-page path with `T=1`. It works,
  but most of the pipeline is dead weight in that case.

## Performance

On a Macbook M1: a 109-frame 1024² 2-channel TIFF (~430 MB on disk)
runs end-to-end in ~25 seconds with 8 workers. Cleanup is the
dominant cost (~60% of total) because NLM is genuinely expensive. If
you're impatient, drop `nlmSearch` to 7 or `nlmHFactor` to 1.5 — both
give back a few seconds at the cost of slightly fuzzier ridges.

Memory peaks around 2× the stack size; a 1 GB stack wants ~2.5 GB of
free RAM. The encoding phase used to OOM on bigger inputs but the
buffer ordering in `pipeline.ts` was rewritten to drop the Float32
sources before allocating the RGB overlay.

## Configuration

Everything in `pipeline.ts:PipelineConfig` is exposed in the config
panel, with a tooltip explaining what it does. The defaults are
calibrated against the Python operating point. The fields you'll
actually touch:

- `previewFrames` — how many frames the **Preview** button chews
  through. Smaller = faster iteration when tuning. Default 8.
- `swapChannels` — flip if your TIFF has fluor at channel 0.
- `minLengthUm` — drop short detections. Raise if your overlay has
  too many tiny fragments.
- `lineage.adjacencyPx` — endpoint-merge radius. Raise if MTs
  crossing at junctions are getting split into two lineages; lower if
  unrelated MTs are merging.
- `haloFilter.darkThreshold` — set to `0` to disable dust-halo
  filtering entirely.

Hit **Save** in the config panel to dump current settings to a JSON
file; **Import** loads one back. Useful for sharing exact runs.

## License

MIT.
