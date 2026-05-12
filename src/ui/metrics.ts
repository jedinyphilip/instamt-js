/**
 * Helpers for displaying / exporting metrics in the UI:
 *   - aggregating per-MT metrics into a global summary
 *     (n_mts + total_mt_frames + mean/std of every numeric column)
 *   - rendering a key/value table
 *   - rendering small inline line-chart canvases for timeseries traces
 */

import type { PipelineOutput } from '../core/pipeline';

type Row = PipelineOutput['metrics'][number];
type Scale = PipelineOutput['scale'];

/** Display units for length-/time-derived metrics. Matches the kymo
 *  modal toggle: 'physical' = µm + seconds, 'pixels' = pixels + frames. */
export type Units = 'physical' | 'pixels';

export interface GlobalMetric {
  statistic: string;
  value: number | string;
}

/** Per-metric unit info: physical label/unit (canonical, what the
 *  pipeline stores), optional pixel-unit label/unit + conversion
 *  function from physical → pixel value. Keys without a `pixels`
 *  entry are unit-invariant (frame indices, counts, angles). */
type UnitVariant = { label: string; unit?: string };
interface MetricInfo {
  physical: UnitVariant;
  pixels?: UnitVariant;
  /** Multiplier physical → pixel. Applied to both mean and std. */
  toPixels?: (scale: Scale) => number;
}

/** Resolve label + display value for a metric key under the chosen units. */
function resolveSpec(key: string, units: Units, scale: Scale): {
  spec: UnitVariant;
  factor: number;
} {
  const info = METRIC_INFO[key];
  if (!info) return { spec: { label: humanise(key) }, factor: 1 };
  if (units === 'pixels' && info.pixels && info.toPixels) {
    const factor = info.toPixels(scale);
    if (Number.isFinite(factor)) return { spec: info.pixels, factor };
  }
  return { spec: info.physical, factor: 1 };
}

/** Compute mean + std of every numeric column across the per-MT rows. */
export function aggregateGlobal(rows: Row[]): GlobalMetric[] {
  if (rows.length === 0) return [];
  const out: GlobalMetric[] = [];
  out.push({ statistic: 'n_mts', value: rows.length });
  // Skipped: total_mt_frames, nFrames — book-keeping counts that don't
  // belong in the user-facing metrics table.
  const skipFromAggregate = new Set(['label', 'firstFrame', 'lastFrame', 'nFrames']);
  const numericKeys = Object.keys(rows[0]!).filter((k) => {
    if (skipFromAggregate.has(k)) return false;
    return typeof (rows[0] as unknown as Record<string, unknown>)[k] === 'number';
  });
  for (const k of numericKeys) {
    const xs: number[] = [];
    for (const r of rows) {
      const v = (r as unknown as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isFinite(v)) xs.push(v);
    }
    out.push({ statistic: `mean_${k}`, value: xs.length ? mean(xs) : '' });
    out.push({ statistic: `std_${k}`, value: xs.length ? stddev(xs) : '' });
  }
  return out;
}

export function globalCsv(rows: GlobalMetric[]): string {
  const out = ['statistic,value'];
  for (const r of rows) {
    const v = typeof r.value === 'number' ? formatNumber(r.value) : String(r.value);
    out.push(`${r.statistic},${v}`);
  }
  return out.join('\n');
}

/**
 * Friendly display names + units for every metric column. The order
 * here is the display order in the table. Each `meanX` entry is
 * automatically paired with its `stdX` counterpart in the row (the
 * pair renders as a single "{label}: {mean} ± {std} {unit}" line);
 * pure counts and singletons render alone.
 *
 * The signed delta mean (`Mean length Δ`) is displayed with its sign
 * on purpose: positive → net growth across the track, negative → net
 * decay. The σ on the same line carries the per-frame magnitude either
 * way.
 */
const METRIC_INFO: Record<string, MetricInfo> = {
  // Identifiers & frame counts (unit-invariant).
  label: { physical: { label: 'Label' } },
  nFrames: { physical: { label: 'Frames' } },
  firstFrame: { physical: { label: 'First frame' } },
  lastFrame: { physical: { label: 'Last frame' } },
  // Length & growth.
  meanLengthUm: {
    physical: { label: 'Mean length', unit: 'µm' },
    pixels: { label: 'Mean length', unit: 'px' },
    toPixels: (s) => (s.umPerPx ? 1 / s.umPerPx : NaN),
  },
  meanLengthDeltaUmPerS: {
    physical: { label: 'Mean length Δ', unit: 'µm/s' },
    pixels: { label: 'Mean length Δ', unit: 'px/frame' },
    toPixels: (s) => (s.umPerPx && s.fps ? 1 / (s.umPerPx * s.fps) : NaN),
  },
  catastropheCount: { physical: { label: 'Catastrophes' } },
  rescueCount: { physical: { label: 'Rescues' } },
  // Shape.
  meanCurvatureRadPerUm: {
    physical: { label: 'Mean curvature', unit: 'rad/µm' },
    pixels: { label: 'Mean curvature', unit: 'rad/px' },
    toPixels: (s) => (s.umPerPx ? s.umPerPx : NaN),
  },
  meanOrientationDeg: { physical: { label: 'Mean orientation', unit: '°' } },
  // Fluor (unit-invariant).
  meanFluorIntensityAu: { physical: { label: 'Mean fluor intensity', unit: 'a.u.' } },
  // Global-only synthetic rows.
  n_mts: { physical: { label: 'MTs' } },
  total_mt_frames: { physical: { label: 'Total MT-frames' } },
};

/** If a key starts with `mean…`, return the corresponding `std…` key
 *  (e.g. `meanLengthUm` → `stdLengthUm`). Otherwise null. */
function stdPairOf(key: string): string | null {
  if (!key.startsWith('mean') || key.length <= 4) return null;
  return 'std' + key.slice(4);
}

function renderRow(label: string, value: string): string {
  return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
}

/** Toolbar HTML with Copy + Download buttons. The caller wires up the
 *  click handlers via `wireTableToolbar`. */
function toolbarHtml(): string {
  return `<div class="metrics-toolbar">
    <button type="button" class="metrics-btn metrics-copy">Copy</button>
    <button type="button" class="metrics-btn metrics-download">Download CSV</button>
  </div>`;
}

/** Serialise a `<table>` to a delimiter-separated string by reading the
 *  rendered DOM. Pulls `label\tvalue` lines so a paste into Excel/Sheets
 *  drops cleanly into two columns. */
function serializeTable(table: HTMLTableElement, delim: string): string {
  const lines: string[] = [];
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    const cells = Array.from(tr.children).map((c) => {
      const text = (c.textContent ?? '').trim();
      // CSV-escape when the delim is comma — TSV doesn't need it.
      if (delim === ',' && /[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
      return text;
    });
    lines.push(cells.join(delim));
  }
  return lines.join('\n');
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Attach Copy / Download click handlers to a toolbar emitted by
 *  `toolbarHtml()`. `csvBasename` controls the downloaded filename. */
function wireTableToolbar(
  root: HTMLElement,
  table: HTMLTableElement,
  csvBasename: string
): void {
  const copyBtn = root.querySelector<HTMLButtonElement>('.metrics-copy');
  const dlBtn = root.querySelector<HTMLButtonElement>('.metrics-download');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const tsv = serializeTable(table, '\t');
      navigator.clipboard
        .writeText(tsv)
        .then(() => flashButton(copyBtn, 'Copied'))
        .catch((e) => {
          console.warn('clipboard write failed', e);
          flashButton(copyBtn, 'Copy failed');
        });
    });
  }
  if (dlBtn) {
    dlBtn.addEventListener('click', () => {
      const csv = serializeTable(table, ',');
      downloadBlob(new Blob([csv], { type: 'text/csv' }), `${csvBasename}.csv`);
    });
  }
}

function flashButton(btn: HTMLButtonElement, msg: string): void {
  const original = btn.textContent ?? '';
  btn.textContent = msg;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1200);
}

/** Attach Copy / Download click handlers to a canvas's toolbar. The
 *  toolbar HTML is `<button class="kymo-copy">Copy</button>
 *  <button class="kymo-download">Download PNG</button>`. */
export function wireCanvasToolbar(
  toolbar: HTMLElement,
  canvas: HTMLCanvasElement,
  basename: string
): void {
  const copyBtn = toolbar.querySelector<HTMLButtonElement>('.kymo-copy');
  const dlBtn = toolbar.querySelector<HTMLButtonElement>('.kymo-download');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      canvas.toBlob((blob) => {
        if (!blob) {
          flashButton(copyBtn, 'No image');
          return;
        }
        // ClipboardItem is gated on secure context; fall back to a no-op
        // with a visible error label if the browser refuses.
        if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
          flashButton(copyBtn, 'Not supported');
          return;
        }
        navigator.clipboard
          .write([new ClipboardItem({ 'image/png': blob })])
          .then(() => flashButton(copyBtn, 'Copied'))
          .catch((e) => {
            console.warn('canvas clipboard write failed', e);
            flashButton(copyBtn, 'Copy failed');
          });
      });
    });
  }
  if (dlBtn) {
    dlBtn.addEventListener('click', () => {
      canvas.toBlob((blob) => {
        if (!blob) return;
        downloadBlob(blob, `${basename}.png`);
      });
    });
  }
}

function joinLabelUnit(spec: UnitVariant): string {
  return spec.unit ? `${spec.label} (${spec.unit})` : spec.label;
}

function fmtPair(meanVal: number, stdVal: number | undefined): string {
  if (stdVal === undefined || !Number.isFinite(stdVal)) return formatNumber(meanVal);
  return `${formatNumber(meanVal)} ± ${formatNumber(stdVal)}`;
}

const NULL_SCALE: Scale = { umPerPx: null, fps: null };

/** Render a key/value table for global metrics into the given root.
 *  `mean_X` and `std_X` rows are paired into a single line. Values are
 *  converted to the requested `units` using `scale`; keys without a
 *  pixel variant render unchanged. Adds a Copy / Download CSV toolbar
 *  above the table. */
export function renderGlobalMetrics(
  root: HTMLElement,
  rows: GlobalMetric[],
  units: Units = 'physical',
  scale: Scale = NULL_SCALE
): void {
  if (rows.length === 0) {
    root.innerHTML = '<div class="metrics-empty">No metrics — run the full pipeline first.</div>';
    return;
  }
  // Index every emitted row so we can pair mean/std and find singletons.
  const idx = new Map<string, GlobalMetric>();
  for (const r of rows) idx.set(r.statistic, r);

  const html: string[] = ['<table class="metrics-table"><tbody>'];
  const consumed = new Set<string>();
  // First pass: emit standalone singletons (n_mts, total_mt_frames) in
  // their natural order at the top.
  for (const r of rows) {
    if (consumed.has(r.statistic)) continue;
    if (r.statistic.startsWith('mean_') || r.statistic.startsWith('std_')) continue;
    consumed.add(r.statistic);
    const { spec, factor } = resolveSpec(r.statistic, units, scale);
    const num = typeof r.value === 'number' ? r.value * factor : null;
    const v = num !== null ? formatNumber(num) : String(r.value);
    html.push(renderRow(joinLabelUnit(spec), v));
  }
  // Second pass: emit mean/std pairs in display-label order.
  const seenBases = new Set<string>();
  for (const r of rows) {
    if (!r.statistic.startsWith('mean_')) continue;
    const base = r.statistic.slice(5);
    if (seenBases.has(base)) continue;
    seenBases.add(base);
    // Skip "std-of-std" branches — the within-MT std fields aggregated
    // across MTs are not user-facing.
    if (base.startsWith('std')) {
      consumed.add(`mean_${base}`);
      consumed.add(`std_${base}`);
      continue;
    }
    const { spec, factor } = resolveSpec(base, units, scale);
    const meanRow = idx.get(`mean_${base}`);
    const stdRow = idx.get(`std_${base}`);
    consumed.add(`mean_${base}`);
    consumed.add(`std_${base}`);
    if (!meanRow || typeof meanRow.value !== 'number' || !Number.isFinite(meanRow.value)) continue;
    const stdVal =
      stdRow && typeof stdRow.value === 'number' && Number.isFinite(stdRow.value)
        ? stdRow.value * factor
        : undefined;
    html.push(renderRow(joinLabelUnit(spec), fmtPair(meanRow.value * factor, stdVal)));
  }
  html.push('</tbody></table>');
  root.innerHTML = toolbarHtml() + html.join('');
  const table = root.querySelector<HTMLTableElement>('table.metrics-table');
  if (table) wireTableToolbar(root, table, 'global_metrics');
}

/** Render a key/value table of per-MT metrics for a single lineage.
 *  `meanX` and `stdX` columns are paired into a single line. Values
 *  are converted to the requested `units` using `scale`; keys without
 *  a pixel variant render unchanged. Adds a Copy / Download CSV
 *  toolbar above the table. */
export function renderPerMtMetricsTable(
  root: HTMLElement,
  row: Row | undefined,
  units: Units = 'physical',
  scale: Scale = NULL_SCALE
): void {
  if (!row) {
    root.innerHTML = '<div class="metrics-empty">No metrics for this lineage.</div>';
    return;
  }
  const rec = row as unknown as Record<string, unknown>;
  const html: string[] = ['<table class="metrics-table compact"><tbody>'];
  const consumed = new Set<string>();
  // Per-MT counts that are still emitted into the underlying CSV /
  // global aggregation but hidden in the per-lineage table.
  const skipFromLocal = new Set(['catastropheCount', 'rescueCount']);
  for (const k of Object.keys(rec)) {
    if (consumed.has(k)) continue;
    consumed.add(k);
    if (skipFromLocal.has(k)) continue;
    // Skip raw `std…` keys — they're shown next to their `mean…` pair.
    if (k.startsWith('std') && k.length > 3 && k[3]! === k[3]!.toUpperCase()) {
      // Will be picked up via its mean partner below; but if there's
      // no `mean…` partner in the row, surface it as a fallback below.
      // For now, fall through and let the standard render path catch it
      // (it'll display alone).
      // (we still consumed it; if a mean partner shows up later it
      // takes precedence)
      // Actually, prefer: silently skip — std without a mean partner
      // is rare and not informative on its own.
      continue;
    }
    const stdKey = stdPairOf(k);
    if (stdKey && stdKey in rec) {
      consumed.add(stdKey);
      const meanVal = rec[k];
      const stdVal = rec[stdKey];
      const { spec, factor } = resolveSpec(k, units, scale);
      if (typeof meanVal !== 'number' || !Number.isFinite(meanVal)) {
        html.push(renderRow(joinLabelUnit(spec), '—'));
        continue;
      }
      const stdNum =
        typeof stdVal === 'number' && Number.isFinite(stdVal) ? stdVal * factor : undefined;
      html.push(renderRow(joinLabelUnit(spec), fmtPair(meanVal * factor, stdNum)));
      continue;
    }
    // Singleton field.
    const { spec, factor } = resolveSpec(k, units, scale);
    const v = rec[k];
    let display: string;
    if (typeof v === 'number') {
      display = Number.isFinite(v) ? formatNumber(v * factor) : '—';
    } else {
      display = String(v ?? '');
    }
    html.push(renderRow(joinLabelUnit(spec), display));
  }
  html.push('</tbody></table>');
  const labelStr = String((row as unknown as Record<string, unknown>).label ?? 'lineage');
  root.innerHTML = toolbarHtml() + html.join('');
  const table = root.querySelector<HTMLTableElement>('table.metrics-table');
  if (table) wireTableToolbar(root, table, `${labelStr}_metrics`);
}

/** Draw a line chart of `(xs, ys)` with a rolling ±1σ band: filled
 *  band + line on top, light grid, large axis labels. Margins / fonts
 *  match the kymograph axed plot so the panels in the kymo modal
 *  share a unified look.
 *
 *  The σ band is a rolling-window standard deviation (window = 5
 *  frames) around each frame's local mean — `mean ± std` computed
 *  within a single MT trace.
 *
 *  Caller must set `canvas.width`/`height`. */
export function drawLineChart(
  canvas: HTMLCanvasElement,
  xs: number[],
  ys: number[],
  options: { title: string; xLabel: string; yLabel: string; color?: string }
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  // Margins match kymoModal so the IRM/Fluor and metric panels line up
  // visually inside the modal's 3×2 grid.
  // Match kymoModal's smaller canvas footprint — see the comment on
  // TARGET_SIZE there for memory rationale.
  const ML = 170;
  const MR = 60;
  const MT = 44;
  const MB = 120;
  const TICK_FONT = '28px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const TITLE_FONT =
    '28px -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';
  void options.title;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  // Filter NaN.
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < xs.length && i < ys.length; i++) {
    const y = ys[i]!;
    if (Number.isFinite(y)) pts.push([xs[i]!, y]);
  }
  if (pts.length < 2) {
    ctx.fillStyle = '#7d8590';
    ctx.font = TITLE_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('— insufficient data —', W / 2, H / 2);
    return;
  }

  // Rolling mean + std for the ±1σ band (the band is fill_between
  // mean - std and mean + std).
  const yVals = pts.map((p) => p[1]);
  const { mean: rollMean, std: rollStd } = rollingStats(yVals, 5);

  const xMin = pts[0]![0];
  const xMax = pts[pts.length - 1]![0];
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const y = pts[i]![1];
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
    const m = rollMean[i]!;
    const s = rollStd[i]!;
    if (Number.isFinite(m) && Number.isFinite(s)) {
      if (m - s < yMin) yMin = m - s;
      if (m + s > yMax) yMax = m + s;
    }
  }
  // Treat any range that's degenerate at the float-precision level as
  // "effectively constant" and bump to a visible window. Strict
  // equality misses near-constant series (e.g. a stable MT length
  // varying by 1e-12 µm between frames) — those used to drive
  // niceTicks into an unbounded loop and crash with "out of memory".
  const relTol = Math.max(1e-9, Math.abs(yMax) * 1e-9, Math.abs(yMin) * 1e-9);
  if (yMax - yMin <= relTol) {
    const c = (yMin + yMax) / 2;
    const halfRange = Math.max(0.5, Math.abs(c) * 0.1);
    yMin = c - halfRange;
    yMax = c + halfRange;
  }
  // 5% headroom so the band/line don't kiss the frame.
  const headroom = (yMax - yMin) * 0.05;
  yMin -= headroom;
  yMax += headroom;

  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin;
  const plotX0 = ML;
  const plotY0 = MT;
  const plotX1 = W - MR;
  const plotY1 = H - MB;
  const xS = (plotX1 - plotX0) / xSpan;
  const yS = (plotY1 - plotY0) / ySpan;

  // Light grid behind the data.
  ctx.strokeStyle = '#21262d';
  ctx.lineWidth = 1;
  for (const v of niceTicks(yMin, yMax, 5)) {
    const y = plotY1 - (v - yMin) * yS;
    ctx.beginPath();
    ctx.moveTo(plotX0, y);
    ctx.lineTo(plotX1, y);
    ctx.stroke();
  }
  for (const v of niceTicks(xMin, xMax, 6)) {
    const x = plotX0 + (v - xMin) * xS;
    ctx.beginPath();
    ctx.moveTo(x, plotY0);
    ctx.lineTo(x, plotY1);
    ctx.stroke();
  }

  // ±1σ band.
  const color = options.color ?? '#2f81f7';
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.22;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < pts.length; i++) {
    const m = rollMean[i]!;
    const s = rollStd[i]!;
    if (!Number.isFinite(m) || !Number.isFinite(s)) continue;
    const x = plotX0 + (pts[i]![0] - xMin) * xS;
    const y = plotY1 - (m + s - yMin) * yS;
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const m = rollMean[i]!;
    const s = rollStd[i]!;
    if (!Number.isFinite(m) || !Number.isFinite(s)) continue;
    const x = plotX0 + (pts[i]![0] - xMin) * xS;
    const y = plotY1 - (m - s - yMin) * yS;
    ctx.lineTo(x, y);
  }
  if (started) {
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1.0;

  // Axes.
  ctx.strokeStyle = '#7d8590';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plotX0 - 2, plotY0);
  ctx.lineTo(plotX0 - 2, plotY1);
  ctx.moveTo(plotX0, plotY1 + 2);
  ctx.lineTo(plotX1, plotY1 + 2);
  ctx.stroke();

  // Y ticks.
  ctx.fillStyle = '#e6edf3';
  ctx.font = TICK_FONT;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of niceTicks(yMin, yMax, 5)) {
    const y = plotY1 - (v - yMin) * yS;
    ctx.beginPath();
    ctx.moveTo(plotX0 - 8, y);
    ctx.lineTo(plotX0 - 2, y);
    ctx.stroke();
    ctx.fillText(formatTick(v, yMax - yMin), plotX0 - 11, y);
  }

  // X ticks.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const v of niceTicks(xMin, xMax, 6)) {
    const x = plotX0 + (v - xMin) * xS;
    ctx.beginPath();
    ctx.moveTo(x, plotY1 + 2);
    ctx.lineTo(x, plotY1 + 8);
    ctx.stroke();
    ctx.fillText(formatTick(v, xMax - xMin), x, plotY1 + 24);
  }

  // Axis titles.
  ctx.fillStyle = '#e6edf3';
  ctx.font = TITLE_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(options.xLabel, (plotX0 + plotX1) / 2, plotY1 + 100);
  ctx.save();
  ctx.translate(18, (plotY0 + plotY1) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(options.yLabel, 0, 0);
  ctx.restore();

  // Trace line on top of the band.
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = plotX0 + (pts[i]![0] - xMin) * xS;
    const y = plotY1 - (pts[i]![1] - yMin) * yS;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/** Rolling mean and std with a centred window of `window` samples.
 *  Edge samples use whatever fits inside the half-window. NaN inputs
 *  contribute neither to the count nor to the moments; if every sample
 *  in a window is NaN, the result is NaN. */
function rollingStats(ys: number[], window: number): { mean: number[]; std: number[] } {
  const n = ys.length;
  const m: number[] = new Array(n).fill(Number.NaN);
  const s: number[] = new Array(n).fill(Number.NaN);
  const half = Math.floor(window / 2);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    let sum = 0;
    let count = 0;
    for (let j = lo; j <= hi; j++) {
      const v = ys[j]!;
      if (Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
    if (count === 0) continue;
    const meanVal = sum / count;
    let vSum = 0;
    for (let j = lo; j <= hi; j++) {
      const v = ys[j]!;
      if (Number.isFinite(v)) vSum += (v - meanVal) * (v - meanVal);
    }
    m[i] = meanVal;
    s[i] = Math.sqrt(vSum / count);
  }
  return { mean: m, std: s };
}

function mean(xs: number[]): number {
  let s = 0;
  for (const v of xs) s += v;
  return s / xs.length;
}

function stddev(xs: number[]): number {
  const m = mean(xs);
  let s = 0;
  for (const v of xs) s += (v - m) * (v - m);
  return Math.sqrt(s / xs.length);
}

function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Number.isInteger(v) && Math.abs(v) < 1e6) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(3);
  return v.toPrecision(5);
}

function humanise(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function niceTicks(lo: number, hi: number, target: number): number[] {
  if (hi <= lo) return [lo];
  const span = hi - lo;
  const rough = span / target;
  if (!Number.isFinite(rough) || rough <= 0) return [lo, hi];
  const pow10 = Math.pow(10, Math.floor(Math.log10(rough)));
  const m = rough / pow10;
  const step = (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * pow10;
  if (!Number.isFinite(step) || step <= 0) return [lo, hi];
  const ticks: number[] = [];
  const start = Math.ceil(lo / step) * step;
  // Cap the tick count even when numerics misbehave (very small span,
  // huge magnitudes). Without this an unbounded loop here used to
  // exhaust memory and surface as a "render error: out of memory" in
  // the modal.
  const maxTicks = target * 4 + 16;
  for (let v = start; v <= hi + 1e-9 && ticks.length < maxTicks; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  return ticks;
}

function formatTick(v: number, span: number): string {
  if (span >= 100) return v.toFixed(0);
  if (span >= 10) return v.toFixed(1);
  if (span >= 1) return v.toFixed(2);
  return v.toFixed(3);
}
