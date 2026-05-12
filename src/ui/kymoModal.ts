/**
 * Modal window for displaying a single lineage's kymograph (IRM mask +
 * Fluorescence) alongside its per-MT metrics table.
 *
 * Layout:
 *   ┌────────────┬───────────────────────────┐
 *   │  Metrics   │   IRM kymo  │ Fluor kymo  │
 *   │   table    │             │             │
 *   └────────────┴───────────────────────────┘
 *
 * The "sec / µm ↔ frame / px" toggle in the header rewires the
 * kymograph axes between physical and pixel units.
 *
 * Close: × button, click on backdrop, or Esc.
 */

import type { PipelineOutput } from '../core/pipeline';
import { renderPerMtMetricsTable, wireCanvasToolbar } from './metrics';

type Kymo = PipelineOutput['kymographsRaw'][number];
type Scale = PipelineOutput['scale'];
type MetricRow = PipelineOutput['metrics'][number];
type Timeseries = PipelineOutput['timeseries'][number];

// Canvas resolution: chosen so the canvas can be downscaled to its CSS
// display size (~500 px wide in the modal grid) without visible
// blockiness, while keeping the per-canvas memory footprint modest.
// Six canvases at the previous 1024-target (~36 MB) put the tab over
// its memory ceiling on bigger stacks and triggered "out of memory"
// during modal open.
const TARGET_SIZE = 720;
// Bumped from 170 → 220 to give the rotated "T (…)" title and the
// right-aligned y-tick labels visible breathing room from the canvas's
// left edge. At 170 the title sat ~18 px from the edge and felt cramped.
const AXIS_LEFT = 220;
const AXIS_BOTTOM = 120;
const AXIS_TOP = 44;
const AXIS_RIGHT = 60;
const AXIS_PAD = 8;
const AXIS_FONT = '28px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const TITLE_FONT =
  '28px -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';

export type Units = 'pixels' | 'physical';

export function showKymoModal(
  kymo: Kymo,
  color: [number, number, number],
  scale: Scale,
  metrics?: MetricRow,
  timeseries?: Timeseries
): void {
  document.querySelector('.kymo-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'kymo-modal';
  const colorCss = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
  const havePhysical = scale.umPerPx != null && scale.fps != null;
  overlay.innerHTML = `
    <div class="kymo-window" role="dialog" aria-label="Kymograph ${kymo.label}">
      <div class="kymo-header">
        <span class="kymo-swatch" style="background:${colorCss}"></span>
        <span class="kymo-title">${kymo.label}</span>
        <span class="kymo-dims hint"></span>
        <button class="kymo-units secondary" type="button" ${havePhysical ? '' : 'disabled title="No µm/px or fps"'}>
          ${havePhysical ? 'sec / µm' : 'frame / px'}
        </button>
        <button class="kymo-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="kymo-body">
        <aside class="kymo-side">
          <div class="kymo-side-label">Per-MT metrics</div>
          <div class="kymo-metrics-table"></div>
        </aside>
        <div class="kymo-grid">
          <div class="kymo-cell">
            <div class="kymo-cell-label">
              <span>IRM</span>
              <span class="kymo-cell-tools" data-cell="irm">
                <button type="button" class="kymo-copy">Copy</button>
                <button type="button" class="kymo-download">Download PNG</button>
              </span>
            </div>
            <canvas class="kymo-canvas" data-which="irm"></canvas>
          </div>
          <div class="kymo-cell">
            <div class="kymo-cell-label">
              <span>Fluorescence</span>
              <span class="kymo-cell-tools" data-cell="fluor">
                <button type="button" class="kymo-copy">Copy</button>
                <button type="button" class="kymo-download">Download PNG</button>
              </span>
            </div>
            <canvas class="kymo-canvas" data-which="fluor"></canvas>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const dimsLabel = overlay.querySelector<HTMLElement>('.kymo-dims')!;
  dimsLabel.textContent = `${kymo.irmMask.width} × ${kymo.irmMask.height} (L × T)`;

  // Metrics table — re-rendered whenever the units toggle flips.
  const tableRoot = overlay.querySelector<HTMLElement>('.kymo-metrics-table')!;

  // Per-canvas Copy / Download PNG buttons.
  const irmCanvas = overlay.querySelector<HTMLCanvasElement>('canvas[data-which="irm"]')!;
  const fluorCanvas = overlay.querySelector<HTMLCanvasElement>('canvas[data-which="fluor"]')!;
  const irmTools = overlay.querySelector<HTMLElement>('.kymo-cell-tools[data-cell="irm"]')!;
  const fluorTools = overlay.querySelector<HTMLElement>('.kymo-cell-tools[data-cell="fluor"]')!;
  wireCanvasToolbar(irmTools, irmCanvas, `${kymo.label}_irm`);
  wireCanvasToolbar(fluorTools, fluorCanvas, `${kymo.label}_fluor`);

  // Default to physical units when both are available.
  let units: Units = havePhysical ? 'physical' : 'pixels';

  // Render in stages across animation frames so the modal pops up
  // immediately (just the table + empty canvases) and the heavy
  // canvas blits don't block paint. Earlier code drew all six panels
  // synchronously, which made the modal feel stuck for hundreds of
  // ms on heavier lineages and left charts in a half-painted state
  // when any single chart threw (e.g. a degenerate timeseries
  // wedging the for-loop).
  let renderToken = 0;
  const renderAll = (): void => {
    const myToken = ++renderToken;
    const stage = (fn: () => void): void => {
      requestAnimationFrame(() => {
        if (myToken !== renderToken) return; // superseded by a later renderAll
        try {
          fn();
        } catch (e) {
          // Swallow so subsequent stages still run; surface in dev console.
          console.warn('kymo modal render stage failed', e);
        }
      });
    };
    // Metrics table tracks the unit toggle alongside the kymo axes.
    stage(() => renderPerMtMetricsTable(tableRoot, metrics, units, scale));
    stage(() =>
      drawAxedKymo(
        overlay.querySelector<HTMLCanvasElement>('canvas[data-which="irm"]')!,
        kymo.irmMask,
        'auto',
        units,
        scale
      )
    );
    stage(() =>
      drawAxedKymo(
        overlay.querySelector<HTMLCanvasElement>('canvas[data-which="fluor"]')!,
        kymo.fluor,
        'auto',
        units,
        scale
      )
    );
    // Timeseries line charts were removed from the modal — only the
    // IRM mask + Fluorescence kymographs remain. `timeseries` is still
    // accepted in the signature so the CSV export path elsewhere keeps
    // working unchanged.
    void timeseries;
    void colorCss;
  };
  renderAll();

  const unitsBtn = overlay.querySelector<HTMLButtonElement>('.kymo-units')!;
  unitsBtn.addEventListener('click', () => {
    units = units === 'physical' ? 'pixels' : 'physical';
    unitsBtn.textContent = units === 'physical' ? 'sec / µm' : 'frame / px';
    renderAll();
  });

  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  overlay.querySelector('.kymo-close')!.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
}


/**
 * Draw a kymograph rescaled to TARGET_SIZE × TARGET_SIZE on a canvas
 * that also carries L (x) and T (y) axes in the requested units.
 */
export function drawAxedKymo(
  canvas: HTMLCanvasElement,
  img: { width: number; height: number; data: Float32Array },
  mode: 'binary' | 'auto',
  units: Units,
  scale: Scale
): void {
  const totalW = AXIS_LEFT + AXIS_PAD + TARGET_SIZE + AXIS_RIGHT;
  const totalH = AXIS_TOP + TARGET_SIZE + AXIS_PAD + AXIS_BOTTOM;
  canvas.width = totalW;
  canvas.height = totalH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, totalW, totalH);

  const { width: L, height: T, data } = img;
  const lo = mode === 'binary' ? 0 : computeLo(data);
  const hi = mode === 'binary' ? 255 : computeHi(data, lo);
  const span = hi - lo || 1;
  const scaleByte = 255 / span;

  const tmp = document.createElement('canvas');
  tmp.width = L;
  tmp.height = T;
  const tctx = tmp.getContext('2d')!;
  const tImgData = tctx.createImageData(L, T);
  for (let p = 0; p < L * T; p++) {
    const v = (data[p]! - lo) * scaleByte;
    const u = v < 0 ? 0 : v > 255 ? 255 : v;
    const o = p * 4;
    tImgData.data[o] = u;
    tImgData.data[o + 1] = u;
    tImgData.data[o + 2] = u;
    tImgData.data[o + 3] = 255;
  }
  tctx.putImageData(tImgData, 0, 0);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(tmp, 0, 0, L, T, AXIS_LEFT + AXIS_PAD, AXIS_TOP, TARGET_SIZE, TARGET_SIZE);

  drawAxes(ctx, L, T, units, scale);
}

function drawAxes(
  ctx: CanvasRenderingContext2D,
  L: number,
  T: number,
  units: Units,
  scale: Scale
): void {
  const imgX0 = AXIS_LEFT + AXIS_PAD;
  const imgY0 = AXIS_TOP;
  const imgX1 = imgX0 + TARGET_SIZE;
  const imgY1 = imgY0 + TARGET_SIZE;

  ctx.strokeStyle = '#7d8590';
  ctx.fillStyle = '#e6edf3';
  ctx.font = AXIS_FONT;
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(imgX0 - 2, imgY0);
  ctx.lineTo(imgX0 - 2, imgY1);
  ctx.moveTo(imgX0, imgY1 + 2);
  ctx.lineTo(imgX1, imgY1 + 2);
  ctx.stroke();

  const xMax = units === 'physical' && scale.umPerPx != null ? L * scale.umPerPx : L;
  const yMax = units === 'physical' && scale.fps != null ? T / scale.fps : T;
  const xUnit = units === 'physical' && scale.umPerPx != null ? 'µm' : 'px';
  const yUnit = units === 'physical' && scale.fps != null ? 's' : 'fr';

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const tickValue of niceTicks(0, xMax, 6)) {
    const u = xMax > 0 ? tickValue / xMax : 0;
    const xPx = imgX0 + u * TARGET_SIZE;
    ctx.beginPath();
    ctx.moveTo(xPx, imgY1 + 2);
    ctx.lineTo(xPx, imgY1 + 8);
    ctx.stroke();
    ctx.fillText(formatTick(tickValue, xMax), xPx, imgY1 + 24);
  }
  ctx.font = TITLE_FONT;
  ctx.fillText(`L (${xUnit})`, (imgX0 + imgX1) / 2, imgY1 + 80);
  ctx.font = AXIS_FONT;

  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const tickValue of niceTicks(0, yMax, 8)) {
    const u = yMax > 0 ? tickValue / yMax : 0;
    const yPx = imgY0 + u * TARGET_SIZE;
    ctx.beginPath();
    ctx.moveTo(imgX0 - 8, yPx);
    ctx.lineTo(imgX0 - 2, yPx);
    ctx.stroke();
    ctx.fillText(formatTick(tickValue, yMax), imgX0 - 11, yPx);
  }
  ctx.save();
  ctx.font = TITLE_FONT;
  // Centre the rotated title within the left margin (AXIS_LEFT wide):
  // anchor it about 1/4 of the way in so it sits clear of both the
  // canvas's left edge and the tick labels.
  ctx.translate(AXIS_LEFT / 4, (imgY0 + imgY1) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`T (${yUnit})`, 0, 0);
  ctx.restore();
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
  const maxTicks = target * 4 + 16;
  for (let v = start; v <= hi + 1e-9 && ticks.length < maxTicks; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  return ticks;
}

function formatTick(v: number, max: number): string {
  if (max >= 100) return v.toFixed(0);
  if (max >= 10) return v.toFixed(1);
  if (max >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

function computeLo(data: Float32Array): number {
  const arr: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (v !== 0 && Number.isFinite(v)) arr.push(v);
  }
  if (arr.length === 0) return 0;
  arr.sort((a, b) => a - b);
  return arr[Math.floor(arr.length * 0.01)]!;
}

function computeHi(data: Float32Array, lo: number): number {
  const arr: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (v !== 0 && Number.isFinite(v)) arr.push(v);
  }
  if (arr.length === 0) return lo + 1;
  arr.sort((a, b) => a - b);
  const hi = arr[Math.floor(arr.length * 0.99)]!;
  return hi > lo ? hi : lo + 1;
}
