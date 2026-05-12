import JSZip from 'jszip';

import {
  DEFAULT_CONFIG,
  runPipeline,
  type PipelineConfig,
  type PipelineOutput,
} from '../core/pipeline';
import type { PipelineProgress } from '../core/progress';
import { CONFIG_DESCRIPTIONS } from './configDescriptions';
import { mountConfigForm } from './configForm';
import { drawAxedKymo } from './kymoModal';
import { LogPane } from './log';
import { aggregateGlobal, globalCsv, renderGlobalMetrics } from './metrics';
import { PreviewPane } from './preview';

// v5: halo filter schema changed — `minDotRadiusPx`/`maxDotRadiusPx`
// renamed to bbox-dim gates `minDotDimPx`/`maxDotDimPx`, and
// `minCompactness` was replaced by PCA-eigenvalue `minAspectRatio`.
// Bump to discard the stale v4 keys.
const CONFIG_STORAGE_KEY = 'instamt:pipelineConfig:v5';

function loadStoredConfig(): PipelineConfig {
  try {
    const raw = window.localStorage.getItem(CONFIG_STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<PipelineConfig>;
    migrateLegacyFps(parsed);
    return mergeDeep(DEFAULT_CONFIG, parsed) as PipelineConfig;
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Pre-split-fps configs had a single `fps` field — apply it to both
 *  per-channel fps fields when those are absent, so users don't lose
 *  their pinned frame rate on the first load after the upgrade. */
function migrateLegacyFps(parsed: Partial<PipelineConfig> & { fps?: number | null }): void {
  if (!('fps' in parsed)) return;
  const legacy = parsed.fps;
  if (parsed.fpsCh0 === undefined) parsed.fpsCh0 = legacy ?? null;
  if (parsed.fpsCh1 === undefined) parsed.fpsCh1 = legacy ?? null;
  delete parsed.fps;
}

function saveStoredConfig(cfg: PipelineConfig): void {
  try {
    window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    // Quota / private-mode failures: silently drop.
  }
}

function mergeDeep<T>(base: T, patch: Partial<T>): T {
  if (base === null || typeof base !== 'object' || Array.isArray(base)) {
    return (patch ?? base) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const k of Object.keys(patch as Record<string, unknown>)) {
    const pv = (patch as Record<string, unknown>)[k];
    const bv = (base as Record<string, unknown>)[k];
    if (
      bv !== null &&
      typeof bv === 'object' &&
      !Array.isArray(bv) &&
      pv !== null &&
      typeof pv === 'object' &&
      !Array.isArray(pv)
    ) {
      out[k] = mergeDeep(bv, pv as Record<string, unknown>);
    } else if (pv !== undefined) {
      out[k] = pv;
    }
  }
  return out as T;
}

interface AppEls {
  fileInput: HTMLInputElement;
  runBtn: HTMLButtonElement;
  previewBtn: HTMLButtonElement;
  downloadBtn: HTMLButtonElement;
  progress: HTMLProgressElement;
  phase: HTMLElement;
  eta: HTMLElement;
  log: HTMLElement;
  preview: HTMLElement;
}

export function mount(root: HTMLElement): void {
  root.innerHTML = `
    <h1>InstaMT – IRM microtubule analysis <span class="tag">v0.3</span></h1>
    <p class="note">
      <strong>Note:</strong> convert <code>.nd2</code> and other acquisition formats to TIFF in
      Fiji (ImageJ): <code>File → Import → Bio-Formats…</code>, then
      <code>File → Save As → Tiff…</code>.
    </p>

    <div class="layout">
      <div class="col-left">
        <div class="panel">
          <div class="field">
            <label for="file">TIFF file</label>
            <input id="file" type="file" accept=".tif,.tiff" />
          </div>
          <div class="controls">
            <button id="run" disabled>Run</button>
            <button id="previewBtn" class="secondary" disabled>Preview</button>
            <button id="download" class="secondary" disabled>Download results</button>
          </div>
          <div class="progress-row">
            <span id="phase" class="phase">Idle</span>
            <progress id="progress" value="0" max="100"></progress>
            <span id="eta" class="eta"></span>
          </div>
        </div>

        <details class="panel" id="configPanel">
          <summary>
            <span class="config-summary-text">Pipeline config</span>
            <span class="hint">hover for descriptions · persisted across sessions</span>
            <span class="config-actions" role="group">
              <button id="configSave" class="secondary mini" type="button" title="Save config to JSON file">Save</button>
              <button id="configImport" class="secondary mini" type="button" title="Load config from JSON file">Import</button>
            </span>
          </summary>
          <div id="configForm"></div>
        </details>
        <input id="configFileInput" type="file" accept=".json,application/json" hidden />

        <div class="panel">
          <pre id="log"></pre>
        </div>

        <div class="panel" id="globalMetricsPanel">
          <div class="panel-header">
            <h3>Global metrics</h3>
            <span class="hint">aggregated across all surviving lineages</span>
            <button
              id="globalUnitsBtn"
              class="secondary mini global-units-btn"
              type="button"
              title="Toggle units"
              disabled
            >frame / px</button>
          </div>
          <div id="globalMetrics"></div>
        </div>
      </div>

      <div class="col-right">
        <div class="panel" id="previewPanel"></div>
      </div>
    </div>

    <footer>
      <a href="https://github.com/yourusername/insta-mt" target="_blank" rel="noopener">source</a>
      · runs entirely in your browser, no upload
    </footer>
  `;

  const els: AppEls = {
    fileInput: must<HTMLInputElement>(root, '#file'),
    runBtn: must<HTMLButtonElement>(root, '#run'),
    previewBtn: must<HTMLButtonElement>(root, '#previewBtn'),
    downloadBtn: must<HTMLButtonElement>(root, '#download'),
    progress: must<HTMLProgressElement>(root, '#progress'),
    phase: must<HTMLElement>(root, '#phase'),
    eta: must<HTMLElement>(root, '#eta'),
    log: must<HTMLElement>(root, '#log'),
    preview: must<HTMLElement>(root, '#previewPanel'),
  };

  const log = new LogPane(els.log);
  const preview = new PreviewPane(els.preview);
  const globalMetricsRoot = must<HTMLElement>(root, '#globalMetrics');
  const globalUnitsBtn = must<HTMLButtonElement>(root, '#globalUnitsBtn');
  renderGlobalMetrics(globalMetricsRoot, []);
  let lastResult: PipelineOutput | null = null;
  // Snapshot of the currently-displayed metrics + scale. Tracked
  // separately from lastResult so preview runs (which intentionally
  // don't populate lastResult) still drive the units toggle.
  let displayedMetrics: PipelineOutput['metrics'] = [];
  let displayedScale: PipelineOutput['scale'] = { umPerPx: null, fps: null };
  // Global metrics units toggle. 'physical' (default) shows µm/s as
  // emitted; 'pixels' converts each scaled metric using displayedScale.
  // Mirrors the kymo modal's toggle so a single result reads identically
  // in both places.
  let globalUnits: 'physical' | 'pixels' = 'physical';
  const refreshGlobalMetrics = (): void => {
    if (displayedMetrics.length === 0) {
      renderGlobalMetrics(globalMetricsRoot, []);
      globalUnitsBtn.disabled = true;
      globalUnitsBtn.title = 'No metrics yet';
      globalUnitsBtn.textContent = 'frame / px';
      return;
    }
    const havePhysical = displayedScale.umPerPx != null && displayedScale.fps != null;
    globalUnitsBtn.disabled = !havePhysical;
    globalUnitsBtn.title = havePhysical ? 'Toggle units' : 'No µm/px or fps';
    if (!havePhysical) globalUnits = 'physical';
    globalUnitsBtn.textContent = globalUnits === 'physical' ? 'sec / µm' : 'frame / px';
    renderGlobalMetrics(
      globalMetricsRoot,
      aggregateGlobal(displayedMetrics),
      globalUnits,
      displayedScale
    );
  };
  globalUnitsBtn.addEventListener('click', () => {
    globalUnits = globalUnits === 'physical' ? 'pixels' : 'physical';
    refreshGlobalMetrics();
  });

  let activeConfig: PipelineConfig = loadStoredConfig();

  // Forward-declared so config-change callbacks can refresh the
  // Preview button label before the rest of the wiring is in place.
  const updatePreviewLabel = (): void => {
    els.previewBtn.textContent = `Preview (${activeConfig.previewFrames} frames)`;
  };

  const configRoot = must<HTMLElement>(root, '#configForm');
  let configForm = mountConfigForm<Record<string, unknown>>(configRoot, {
    defaults: DEFAULT_CONFIG as unknown as Record<string, unknown>,
    initial: activeConfig as unknown as Record<string, unknown>,
    enums: { anchor: ['minus', 'plus'] },
    descriptions: CONFIG_DESCRIPTIONS,
    onChange: (next) => {
      activeConfig = next as unknown as PipelineConfig;
      saveStoredConfig(activeConfig);
      updatePreviewLabel();
    },
  });

  const remountConfigForm = (initial: PipelineConfig): void => {
    activeConfig = initial;
    saveStoredConfig(activeConfig);
    configRoot.innerHTML = '';
    configForm = mountConfigForm<Record<string, unknown>>(configRoot, {
      defaults: DEFAULT_CONFIG as unknown as Record<string, unknown>,
      initial: activeConfig as unknown as Record<string, unknown>,
      enums: { anchor: ['minus', 'plus'] },
      descriptions: CONFIG_DESCRIPTIONS,
      onChange: (next) => {
        activeConfig = next as unknown as PipelineConfig;
        saveStoredConfig(activeConfig);
      },
    });
  };
  void configForm; // expose for future programmatic resets

  // ── Config Save / Import ───────────────────────────────────────────
  must<HTMLButtonElement>(root, '#configSave').addEventListener('click', (ev) => {
    // Buttons live inside <summary>, which would toggle the <details>
    // on click — stop propagation so Save/Import don't roll the panel up.
    ev.preventDefault();
    ev.stopPropagation();
    const blob = new Blob([JSON.stringify(activeConfig, null, 2)], {
      type: 'application/json',
    });
    triggerDownload(blob, 'instamt-config.json');
  });

  const configFileInput = must<HTMLInputElement>(root, '#configFileInput');
  must<HTMLButtonElement>(root, '#configImport').addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    configFileInput.click();
  });
  configFileInput.addEventListener('change', () => {
    const file = configFileInput.files?.[0];
    if (!file) return;
    file
      .text()
      .then((txt) => {
        const parsed = JSON.parse(txt) as Partial<PipelineConfig>;
        migrateLegacyFps(parsed);
        // Defaults-merge so partial JSON works and any unknown keys get
        // filtered against the schema.
        const merged = mergeDeep(DEFAULT_CONFIG, parsed) as PipelineConfig;
        remountConfigForm(merged);
      })
      .catch((e) => {
        log.err(`Failed to import config: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        // Allow re-importing the same file.
        configFileInput.value = '';
      });
  });

  updatePreviewLabel();

  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files?.[0] ?? null;
    const hasFile = !!file;
    els.runBtn.disabled = !hasFile;
    els.previewBtn.disabled = !hasFile;
    preview.setFile(file);
  });

  const execute = async (isPreview: boolean): Promise<void> => {
    const file = els.fileInput.files?.[0];
    if (!file) return;

    log.clear();
    log.info(
      isPreview
        ? `Preview run: first ${activeConfig.previewFrames} frames of ${file.name}`
        : `Loaded ${file.name} (${(file.size / 1e6).toFixed(1)} MB)`
    );
    els.runBtn.disabled = true;
    els.previewBtn.disabled = true;
    els.downloadBtn.disabled = true;
    els.progress.removeAttribute('value');
    els.phase.textContent = 'Starting…';
    displayedMetrics = [];
    displayedScale = { umPerPx: null, fps: null };
    refreshGlobalMetrics();

    const phaseStart = new Map<string, number>();
    try {
      const t0 = performance.now();
      const result = await runPipeline(
        file,
        activeConfig,
        (ev) => {
          renderProgress(els, ev, phaseStart);
          if (ev.message) log.raw(ev.message);
        },
        isPreview ? { previewMaxFrames: activeConfig.previewFrames } : {}
      );
      const elapsed = (performance.now() - t0) / 1000;
      if (isPreview) {
        log.ok(
          `Preview done in ${elapsed.toFixed(1)}s. ` +
            `${result.kymographs.length} MTs detected, ` +
            `${result.metrics.length} survived length filter. ` +
            `Adjust config and re-preview, or click Run for the full stack.`
        );
      } else {
        lastResult = result;
        log.ok(
          `Done in ${elapsed.toFixed(1)}s. ` +
            `${result.kymographs.length} MTs detected, ` +
            `${result.metrics.length} survived length filter.`
        );
        els.downloadBtn.disabled = false;
      }
      displayedMetrics = result.metrics;
      displayedScale = result.scale;
      refreshGlobalMetrics();
      els.progress.value = els.progress.max;
      els.phase.textContent = 'Done';
      els.eta.textContent = '';
      preview.setResult(result);
    } catch (e) {
      log.err(`Failed: ${e instanceof Error ? e.message : String(e)}`);
      console.error(e);
      els.phase.textContent = 'Error';
      els.eta.textContent = '';
    } finally {
      els.runBtn.disabled = false;
      els.previewBtn.disabled = false;
    }
  };

  els.runBtn.addEventListener('click', () => void execute(false));
  els.previewBtn.addEventListener('click', () => void execute(true));

  els.downloadBtn.addEventListener('click', async () => {
    if (!lastResult) return;
    const zip = new JSZip();
    const folder = `${lastResult.stem}/`;
    zip.file(`${folder}results/${lastResult.stem}_cleaned.tif`, lastResult.cleanedTiff);
    zip.file(`${folder}results/${lastResult.stem}_overlay.tif`, lastResult.overlayTiff);

    // Per-lineage outputs: raw TIFF (unchanged) + rendered PNG with
    // axes (using the same drawAxedKymo path as the inspector modal),
    // plus per-channel CSV dumps of the underlying float arrays.
    for (let i = 0; i < lastResult.kymographs.length; i++) {
      const { label, tiff } = lastResult.kymographs[i]!;
      zip.file(`${folder}results/${label}_${lastResult.stem}_kymo.tif`, tiff);

      const raw = lastResult.kymographsRaw[i];
      if (!raw) continue;
      const pngBlob = await renderKymoPng(raw, lastResult.scale);
      if (pngBlob) {
        zip.file(`${folder}results/${label}_${lastResult.stem}_kymo.png`, pngBlob);
      }
      // Raw float CSVs — easy to load into Excel / numpy / R without
      // needing a TIFF reader.
      zip.file(
        `${folder}results/raw/${label}_${lastResult.stem}_irm_mask.csv`,
        kymoChannelToCsv(raw.irmMask)
      );
      zip.file(
        `${folder}results/raw/${label}_${lastResult.stem}_fluor.csv`,
        kymoChannelToCsv(raw.fluor)
      );
    }

    if (lastResult.rawChannels) {
      for (const { name, tiff } of lastResult.rawChannels) {
        zip.file(`${folder}results/debug/${lastResult.stem}_${name}.tif`, tiff);
      }
    }
    zip.file(`${folder}results/${lastResult.stem}_metrics.csv`, metricsToCsv(lastResult));
    // Global aggregate (n_mts, total_mt_frames, mean/std of every numeric column).
    zip.file(
      `${folder}results/${lastResult.stem}_metrics_global.csv`,
      globalCsv(aggregateGlobal(lastResult.metrics))
    );
    // Long-format per-frame timeseries — one row per (lineage, frame).
    zip.file(`${folder}results/${lastResult.stem}_timeseries.csv`, timeseriesCsv(lastResult));

    const blob = await zip.generateAsync({ type: 'blob' });
    triggerDownload(blob, `${lastResult.stem}_results.zip`);
  });
}

/**
 * Render a kymograph (irm + fluor with axes) to a single PNG blob.
 * Mirrors the inspector modal layout: a thin header with the lineage
 * label, then the IRM-mask channel above the fluorescence channel.
 * Uses physical units (sec / µm) when both are available, else
 * (frames / px).
 */
async function renderKymoPng(
  kymo: PipelineOutput['kymographsRaw'][number],
  scale: PipelineOutput['scale']
): Promise<Blob | null> {
  const units = scale.umPerPx != null && scale.fps != null ? 'physical' : 'pixels';
  const irmCanvas = document.createElement('canvas');
  const fluorCanvas = document.createElement('canvas');
  drawAxedKymo(irmCanvas, kymo.irmMask, 'auto', units, scale);
  drawAxedKymo(fluorCanvas, kymo.fluor, 'auto', units, scale);

  const HEADER = 56;
  const GAP = 12;
  const SUBHEADER = 24;
  const W = Math.max(irmCanvas.width, fluorCanvas.width);
  const H = HEADER + SUBHEADER + irmCanvas.height + GAP + SUBHEADER + fluorCanvas.height;

  const final = document.createElement('canvas');
  final.width = W;
  final.height = H;
  const ctx = final.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#e6edf3';
  ctx.font =
    '24px -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    `${kymo.label}  (${kymo.irmMask.width} × ${kymo.irmMask.height} L × T)`,
    24,
    HEADER / 2
  );

  let y = HEADER;
  ctx.font =
    '14px -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';
  ctx.fillStyle = '#7d8590';
  ctx.fillText('IRM', 24, y + SUBHEADER / 2);
  y += SUBHEADER;
  ctx.drawImage(irmCanvas, 0, y);
  y += irmCanvas.height + GAP;
  ctx.fillText('FLUORESCENCE', 24, y + SUBHEADER / 2);
  y += SUBHEADER;
  ctx.drawImage(fluorCanvas, 0, y);

  return new Promise<Blob | null>((resolve) => {
    final.toBlob((blob) => resolve(blob), 'image/png');
  });
}

/** Long-format per-frame metric timeseries — one row per
 *  (lineage, frame), one column per numeric metric. */
function timeseriesCsv(out: PipelineOutput): string {
  if (out.timeseries.length === 0) return '';
  const cols = [
    'label',
    'frame_idx',
    'lengthUm',
    'lengthDeltaUmPerS',
    'curvatureRadPerUm',
    'fluorIntensityAu',
  ];
  const rows: string[] = [cols.join(',')];
  for (let li = 0; li < out.timeseries.length; li++) {
    const ts = out.timeseries[li]!;
    const m = out.metrics[li];
    const label = m?.label ?? `L${(li + 1).toString().padStart(3, '0')}`;
    for (let i = 0; i < ts.frames.length; i++) {
      const f = ts.frames[i]!;
      const len = ts.lengthUm[i] ?? '';
      const dlen = ts.lengthDeltaUmPerS[i - 1] ?? ''; // N-1 short
      const curv = ts.curvatureRadPerUm[i] ?? '';
      const flu = ts.fluorIntensityAu[i] ?? '';
      rows.push([label, f, numToCsv(len), numToCsv(dlen), numToCsv(curv), numToCsv(flu)].join(','));
    }
  }
  return rows.join('\n');
}

function numToCsv(v: number | string): string {
  if (typeof v !== 'number') return String(v);
  return Number.isFinite(v) ? v.toPrecision(6) : '';
}

/** Serialise a kymograph float buffer as CSV. Rows are time frames,
 *  columns are positions along the MT (the L axis). */
function kymoChannelToCsv(ch: { width: number; height: number; data: Float32Array }): string {
  const { width: W, height: H, data } = ch;
  const rows: string[] = [];
  for (let y = 0; y < H; y++) {
    const cols: string[] = [];
    for (let x = 0; x < W; x++) {
      const v = data[y * W + x]!;
      cols.push(Number.isFinite(v) ? v.toPrecision(6) : '');
    }
    rows.push(cols.join(','));
  }
  return rows.join('\n');
}

function metricsToCsv(out: PipelineOutput): string {
  if (out.metrics.length === 0) return '';
  const cols = Object.keys(out.metrics[0]!) as Array<keyof (typeof out.metrics)[number]>;
  const rows = [cols.join(',')];
  for (const m of out.metrics) {
    rows.push(
      cols
        .map((c) => {
          const v = m[c];
          if (typeof v === 'number') return Number.isFinite(v) ? v.toPrecision(6) : '';
          return String(v);
        })
        .join(',')
    );
  }
  return rows.join('\n');
}

function renderProgress(els: AppEls, ev: PipelineProgress, phaseStart: Map<string, number>): void {
  const key = `${ev.phase}:${ev.channel ?? ''}`;
  if (!phaseStart.has(key)) phaseStart.set(key, performance.now());

  if (ev.current !== undefined && ev.total !== undefined) {
    els.progress.max = ev.total;
    els.progress.value = ev.current;
    els.phase.textContent = `${ev.phase}${ev.channel ? ` [${ev.channel}]` : ''}: ${ev.current}/${ev.total}`;
    const elapsed = (performance.now() - (phaseStart.get(key) ?? 0)) / 1000;
    if (ev.current > 0 && elapsed > 0.3) {
      const rate = ev.current / elapsed;
      const remaining = (ev.total - ev.current) / rate;
      els.eta.textContent = `ETA ${formatEta(remaining)} (${rate.toFixed(1)}/s)`;
    }
  } else {
    els.progress.removeAttribute('value');
    els.phase.textContent = ev.phase + (ev.message ? ` — ${ev.message}` : '');
    els.eta.textContent = '';
  }
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '?';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)
    .toString()
    .padStart(2, '0')}m`;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function must<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`UI bootstrap: missing element ${selector}`);
  return el;
}
