/**
 * Tabbed preview pane. Three tabs:
 *   1. Input  — raw TIFF with frame & channel sliders (loaded on demand)
 *   2. Cleaned — per-frame cleaned IRM grayscale (after Run)
 *   3. Overlay — per-frame overlay RGB with lineage colours (after Run)
 *
 * Each tab gets its own canvas + frame slider. Frame index is shared
 * across tabs when the underlying frame counts match.
 */

import type { PipelineOutput, PreviewStack } from '../core/pipeline';
import { readTiffStack } from '../core/io/tiff';
import { showKymoModal } from './kymoModal';

export type PreviewTab = 'input' | 'cleaned' | 'overlay';

export type LineageHit = {
  lineageId: number;
  label: string;
  color: [number, number, number];
};

export type OverlayClickHandler = (hit: LineageHit) => void;

interface InputState {
  loading: boolean;
  channels: PreviewStack[]; // one entry per channel (grayscale)
  // contrast levels per channel for display
  levels: Array<{ lo: number; hi: number }>;
}

export class PreviewPane {
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private status: HTMLElement;
  private frameSlider: HTMLInputElement;
  private frameLabel: HTMLElement;
  private channelSelect: HTMLSelectElement;
  private channelRow: HTMLElement;
  private playBtn: HTMLButtonElement;
  private speedSelect: HTMLSelectElement;

  private tab: PreviewTab = 'input';
  private frame = 0;
  private channel = 0;
  private playing = false;
  private playTimer: number | null = null;
  /** Base playback rate (frames/second) at 1×. */
  private static readonly BASE_FPS = 4;
  private playSpeed = 4; // 1x, 2x, 4x, 8x, 16x

  // Wheel-zoom state. Pan is in CSS pixels relative to the canvas-wrap.
  private zoom = 1;
  private panX = 0;
  private panY = 0;

  // Drag-to-pan state. `dragMaxDistance` is used to suppress the click
  // event when the gesture was actually a drag.
  private dragStart: { clientX: number; clientY: number; panX: number; panY: number } | null = null;
  private dragMaxDistance = 0;
  private static readonly CLICK_DRAG_THRESHOLD = 4;

  // Lineage hover state for the overlay tab.
  private hoveredLineageId: number | null = null;

  private currentFile: File | null = null;
  private input: InputState | null = null;
  private cleaned: PreviewStack | null = null;
  private fluorFrames: PreviewStack | null = null;
  private overlayPerFrame: PipelineOutput['overlayPerFrame'] | null = null;
  private kymographsRaw: PipelineOutput['kymographsRaw'] | null = null;
  private resultScale: PipelineOutput['scale'] | null = null;
  private resultMetrics: PipelineOutput['metrics'] | null = null;
  private resultTimeseries: PipelineOutput['timeseries'] | null = null;

  constructor(root: HTMLElement) {
    root.classList.add('preview-pane');
    root.innerHTML = `
      <div class="preview-tabs" role="tablist">
        <button class="tab active" data-tab="input" role="tab">Input</button>
        <button class="tab" data-tab="cleaned" role="tab" disabled>Cleaned</button>
        <button class="tab" data-tab="overlay" role="tab" disabled>Overlay</button>
      </div>
      <div class="preview-canvas-wrap">
        <canvas class="preview-canvas"></canvas>
        <div class="preview-status">No file loaded</div>
      </div>
      <div class="preview-controls">
        <div class="preview-row" id="prevChannelRow" hidden>
          <label>Channel</label>
          <select class="preview-channel"></select>
        </div>
        <div class="preview-row">
          <label>Frame</label>
          <button class="preview-play" type="button" aria-label="Play" disabled>▶</button>
          <select class="preview-speed" title="Playback speed">
            <option value="1">1×</option>
            <option value="2">2×</option>
            <option value="4" selected>4×</option>
            <option value="8">8×</option>
            <option value="16">16×</option>
          </select>
          <input class="preview-frame-slider" type="range" min="0" max="0" value="0" />
          <span class="preview-frame-label hint">0 / 0</span>
        </div>
      </div>
    `;
    this.root = root;
    this.canvas = root.querySelector<HTMLCanvasElement>('.preview-canvas')!;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('preview canvas: no 2d context');
    this.ctx = ctx;
    this.status = root.querySelector<HTMLElement>('.preview-status')!;
    this.frameSlider = root.querySelector<HTMLInputElement>('.preview-frame-slider')!;
    this.frameLabel = root.querySelector<HTMLElement>('.preview-frame-label')!;
    this.channelSelect = root.querySelector<HTMLSelectElement>('.preview-channel')!;
    this.channelRow = root.querySelector<HTMLElement>('#prevChannelRow')!;
    this.playBtn = root.querySelector<HTMLButtonElement>('.preview-play')!;
    this.speedSelect = root.querySelector<HTMLSelectElement>('.preview-speed')!;

    root.querySelectorAll<HTMLButtonElement>('.tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        this.setTab(btn.dataset.tab as PreviewTab);
      });
    });

    this.frameSlider.addEventListener('input', () => {
      this.frame = Number(this.frameSlider.value);
      // User dragged the slider — pause playback.
      if (this.playing) this.pause();
      this.render();
    });
    this.channelSelect.addEventListener('change', () => {
      this.channel = Number(this.channelSelect.value);
      this.render();
    });
    this.playBtn.addEventListener('click', () => {
      if (this.playing) this.pause();
      else this.play();
    });
    this.speedSelect.addEventListener('change', () => {
      this.playSpeed = Number(this.speedSelect.value);
      if (this.playing) {
        // Restart timer at new speed.
        this.pause();
        this.play();
      }
    });

    this.canvas.addEventListener('click', (ev) => {
      // Suppress the click if the gesture was actually a drag.
      if (this.dragMaxDistance > PreviewPane.CLICK_DRAG_THRESHOLD) return;
      this.handleCanvasClick(ev);
    });

    // Scroll-wheel zoom centred on the cursor. Listen on the wrap so
    // wheel events near (but outside) the canvas still zoom.
    const wrap = root.querySelector<HTMLElement>('.preview-canvas-wrap')!;
    wrap.addEventListener('wheel', (ev) => this.handleWheel(ev, wrap), { passive: false });
    // Double-click resets zoom + pan.
    this.canvas.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      this.resetZoom();
    });

    // Drag-to-pan.
    this.canvas.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return; // primary button only
      ev.preventDefault();
      this.dragStart = {
        clientX: ev.clientX,
        clientY: ev.clientY,
        panX: this.panX,
        panY: this.panY,
      };
      this.dragMaxDistance = 0;
      this.canvas.classList.add('dragging');
    });
    window.addEventListener('mousemove', (ev) => {
      if (!this.dragStart) return;
      const dx = ev.clientX - this.dragStart.clientX;
      const dy = ev.clientY - this.dragStart.clientY;
      const dist = Math.hypot(dx, dy);
      if (dist > this.dragMaxDistance) this.dragMaxDistance = dist;
      this.panX = this.dragStart.panX + dx;
      this.panY = this.dragStart.panY + dy;
      this.applyTransform();
    });
    window.addEventListener('mouseup', () => {
      if (!this.dragStart) return;
      this.dragStart = null;
      this.canvas.classList.remove('dragging');
    });

    // Hover-highlight: when over a clickable lineage on the overlay
    // tab, brighten its arcs.
    this.canvas.addEventListener('mousemove', (ev) => this.handleHoverMove(ev));
    this.canvas.addEventListener('mouseleave', () => this.setHoveredLineage(null));
  }

  /** Find the lineage whose arc has a vertex closest to a given image-space
   *  pixel on the current frame. Returns null when nothing's loaded. */
  private nearestLineage(
    cx: number,
    cy: number
  ): {
    lineageId: number;
    label: string;
    color: [number, number, number];
  } | null {
    if (!this.overlayPerFrame) return null;
    const arcs = this.overlayPerFrame[this.frame] ?? [];
    if (arcs.length === 0) return null;
    let bestDist2 = Infinity;
    let best: (typeof arcs)[number] | null = null;
    for (const entry of arcs) {
      const arc = entry.arc;
      for (let p = 0; p < arc.length; p += 2) {
        const dy = arc[p]! - cy;
        const dx = arc[p + 1]! - cx;
        const d2 = dy * dy + dx * dx;
        if (d2 < bestDist2) {
          bestDist2 = d2;
          best = entry;
        }
      }
    }
    return best ? { lineageId: best.lineageId, label: best.label, color: best.color } : null;
  }

  private handleHoverMove(ev: MouseEvent): void {
    if (this.tab !== 'overlay' || !this.overlayPerFrame) {
      this.setHoveredLineage(null);
      return;
    }
    if (this.dragStart) return; // suppress hover while dragging
    const stack = this.currentStack();
    if (!stack) return;
    const rect = this.canvas.getBoundingClientRect();
    const cx = ((ev.clientX - rect.left) / rect.width) * stack.width;
    const cy = ((ev.clientY - rect.top) / rect.height) * stack.height;
    const hit = this.nearestLineage(cx, cy);
    this.setHoveredLineage(hit ? hit.lineageId : null);
  }

  private setHoveredLineage(id: number | null): void {
    if (this.hoveredLineageId === id) return;
    this.hoveredLineageId = id;
    if (this.tab === 'overlay') this.render();
  }

  private handleWheel(ev: WheelEvent, wrap: HTMLElement): void {
    ev.preventDefault();
    const wrapRect = wrap.getBoundingClientRect();
    const mouseX = ev.clientX - wrapRect.left;
    const mouseY = ev.clientY - wrapRect.top;
    const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newZoom = Math.max(0.5, Math.min(16, this.zoom * factor));
    if (newZoom === this.zoom) return;
    const k = newZoom / this.zoom;
    // Keep the image-space pixel under the cursor fixed in screen space.
    this.panX = (1 - k) * mouseX + k * this.panX;
    this.panY = (1 - k) * mouseY + k * this.panY;
    this.zoom = newZoom;
    this.applyTransform();
  }

  private resetZoom(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.applyTransform();
  }

  private applyTransform(): void {
    this.canvas.style.transformOrigin = '0 0';
    this.canvas.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
  }

  /** Click on the overlay canvas → open the *nearest* lineage's
   *  kymograph in a modal. No distance threshold. */
  private handleCanvasClick(ev: MouseEvent): void {
    if (this.tab !== 'overlay') return;
    if (!this.overlayPerFrame || !this.kymographsRaw) return;
    const stack = this.currentStack();
    if (!stack) return;
    const rect = this.canvas.getBoundingClientRect();
    const cx = ((ev.clientX - rect.left) / rect.width) * stack.width;
    const cy = ((ev.clientY - rect.top) / rect.height) * stack.height;
    const hit = this.nearestLineage(cx, cy);
    if (!hit) return;
    const kymo = this.kymographsRaw[hit.lineageId];
    if (!kymo) return;
    const metricRow = this.resultMetrics?.[hit.lineageId];
    const timeseries = this.resultTimeseries?.[hit.lineageId];
    showKymoModal(
      kymo,
      hit.color,
      this.resultScale ?? { umPerPx: null, fps: null },
      metricRow,
      timeseries
    );
  }

  private play(): void {
    const stack = this.currentStack();
    if (!stack || stack.frameCount < 2) return;
    this.playing = true;
    this.playBtn.textContent = '⏸';
    this.playBtn.setAttribute('aria-label', 'Pause');
    const periodMs = 1000 / (PreviewPane.BASE_FPS * this.playSpeed);
    this.playTimer = window.setInterval(() => {
      const cur = this.currentStack();
      if (!cur) {
        this.pause();
        return;
      }
      this.frame = (this.frame + 1) % cur.frameCount;
      this.render();
    }, periodMs);
  }

  private pause(): void {
    this.playing = false;
    this.playBtn.textContent = '▶';
    this.playBtn.setAttribute('aria-label', 'Play');
    if (this.playTimer != null) {
      window.clearInterval(this.playTimer);
      this.playTimer = null;
    }
  }

  /** Called when the user picks a new file. Resets state but doesn't
   *  load yet — load happens on first render of the input tab. */
  setFile(file: File | null): void {
    this.currentFile = file;
    this.input = null;
    this.cleaned = null;
    this.fluorFrames = null;
    this.overlayPerFrame = null;
    this.kymographsRaw = null;
    this.resultScale = null;
    this.resultMetrics = null;
    this.resultTimeseries = null;
    this.hoveredLineageId = null;
    this.frame = 0;
    this.channel = 0;
    this.tab = 'input';
    this.resetZoom();
    this.updateTabs();
    if (file) {
      this.status.textContent = 'Loading…';
      this.status.hidden = false;
      void this.ensureInputLoaded();
    } else {
      this.status.textContent = 'No file loaded';
      this.status.hidden = false;
      this.clearCanvas();
    }
  }

  /** Plug in cleaned + overlay stacks (and lineage hit-test data) after
   *  a Run completes. */
  setResult(result: PipelineOutput): void {
    this.cleaned = result.cleanedFrames;
    this.fluorFrames = result.fluorFrames;
    this.overlayPerFrame = result.overlayPerFrame;
    this.kymographsRaw = result.kymographsRaw;
    this.resultScale = result.scale;
    this.resultMetrics = result.metrics;
    this.resultTimeseries = result.timeseries;
    this.updateTabs();
    this.setTab('overlay');
  }

  private async ensureInputLoaded(): Promise<void> {
    if (!this.currentFile || this.input) return;
    try {
      const { channels } = await readTiffStack(this.currentFile);
      const inputChannels: PreviewStack[] = [];
      const levels: Array<{ lo: number; hi: number }> = [];
      for (const ch of channels) {
        const [T, h, w] = ch.shape;
        // Compute robust per-channel display levels (1% / 99%).
        const lvl = percentileLevels(ch.data, 0.01, 0.99);
        levels.push(lvl);
        // Quantise to Uint8 for memory. Apply contrast stretch for display.
        const data = new Uint8Array(T * h * w);
        const span = lvl.hi > lvl.lo ? lvl.hi - lvl.lo : 1;
        const scale = 255 / span;
        for (let i = 0; i < ch.data.length; i++) {
          const v = (ch.data[i]! - lvl.lo) * scale;
          data[i] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
        inputChannels.push({
          width: w,
          height: h,
          frameCount: T,
          channels: 1,
          data,
        });
      }
      this.input = { loading: false, channels: inputChannels, levels };

      // Populate channel selector.
      this.channelSelect.innerHTML = '';
      for (let c = 0; c < inputChannels.length; c++) {
        const o = document.createElement('option');
        o.value = String(c);
        o.textContent = `Ch ${c}`;
        this.channelSelect.appendChild(o);
      }
      this.channelRow.hidden = inputChannels.length <= 1;
      this.channelSelect.disabled = this.tab !== 'input';

      this.updateTabs();
      this.render();
    } catch (e) {
      this.status.textContent = `Failed to load: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private setTab(tab: PreviewTab): void {
    if (this.playing) this.pause();
    if (tab !== this.tab) {
      this.resetZoom();
      this.hoveredLineageId = null;
    }
    this.tab = tab;
    this.root.querySelectorAll<HTMLButtonElement>('.tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    // Show + enable the channel dropdown on tabs that have a real
    // per-channel render path. Input tab uses the raw TIFF channels;
    // overlay tab uses cleaned IRM (ch 0) vs fluor (ch 1) as the
    // grayscale base for the arc paint.
    const inputHasChannels = !!this.input && this.input.channels.length > 1;
    const overlayHasChannels = !!this.fluorFrames;
    const tabSupportsChannels =
      (tab === 'input' && inputHasChannels) || (tab === 'overlay' && overlayHasChannels);
    this.channelRow.hidden = !tabSupportsChannels;
    this.channelSelect.disabled = !tabSupportsChannels;
    this.render();
  }

  private updateTabs(): void {
    const cleanedBtn = this.root.querySelector<HTMLButtonElement>('.tab[data-tab="cleaned"]')!;
    const overlayBtn = this.root.querySelector<HTMLButtonElement>('.tab[data-tab="overlay"]')!;
    cleanedBtn.disabled = !this.cleaned;
    // Overlay tab is available whenever we have cleanup output and arc
    // metadata — even on single-channel inputs where ch1 is unavailable.
    overlayBtn.disabled = !this.cleaned || !this.overlayPerFrame;
  }

  private currentStack(): PreviewStack | null {
    if (this.tab === 'input') {
      return this.input?.channels[this.channel] ?? null;
    }
    if (this.tab === 'cleaned') return this.cleaned;
    // Overlay: ch 0 = cleaned IRM (default), ch 1 = fluor (if loaded).
    if (this.channel === 1 && this.fluorFrames) return this.fluorFrames;
    return this.cleaned;
  }

  private render(): void {
    const stack = this.currentStack();
    if (!stack) {
      this.status.hidden = false;
      this.clearCanvas();
      this.playBtn.disabled = true;
      if (this.playing) this.pause();
      return;
    }
    this.status.hidden = true;

    const T = stack.frameCount;
    const f = Math.min(this.frame, T - 1);
    this.frame = f;
    this.frameSlider.max = String(Math.max(0, T - 1));
    this.frameSlider.value = String(f);
    this.frameLabel.textContent = `${f + 1} / ${T}`;
    this.playBtn.disabled = T < 2;

    this.canvas.width = stack.width;
    this.canvas.height = stack.height;
    const W = stack.width;
    const H = stack.height;
    const stride = W * H;
    const offset = f * stride * stack.channels;

    const imgData = this.ctx.createImageData(W, H);
    if (stack.channels === 1) {
      for (let p = 0; p < stride; p++) {
        const v = stack.data[offset + p]!;
        const o = p * 4;
        imgData.data[o] = v;
        imgData.data[o + 1] = v;
        imgData.data[o + 2] = v;
        imgData.data[o + 3] = 255;
      }
    } else {
      for (let p = 0; p < stride; p++) {
        const s = offset + p * 3;
        const o = p * 4;
        imgData.data[o] = stack.data[s]!;
        imgData.data[o + 1] = stack.data[s + 1]!;
        imgData.data[o + 2] = stack.data[s + 2]!;
        imgData.data[o + 3] = 255;
      }
    }
    this.ctx.putImageData(imgData, 0, 0);

    // Overlay tab: paint each lineage's arcs over the grayscale base
    // in their lineage colour, then paint a thicker halo+stroke for
    // the hovered lineage so the user sees which one a click will
    // open. Rendered on demand here (rather than via a precomputed
    // RGB stack) so the same arcs work over either grayscale base
    // (cleaned IRM or fluor) without doubling memory.
    if (this.tab === 'overlay' && this.overlayPerFrame) {
      const arcs = this.overlayPerFrame[this.frame] ?? [];
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      // Pass 1: every arc in its lineage colour.
      this.ctx.lineWidth = 2;
      for (const entry of arcs) {
        const arc = entry.arc;
        if (arc.length < 4) continue;
        const [r, g, b] = entry.color;
        this.ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
        this.ctx.beginPath();
        this.ctx.moveTo(arc[1]!, arc[0]!);
        for (let p = 2; p < arc.length; p += 2) {
          this.ctx.lineTo(arc[p + 1]!, arc[p]!);
        }
        this.ctx.stroke();
      }
      // Pass 2: hover highlight on top — white halo + thicker
      // lineage-colour stroke.
      if (this.hoveredLineageId != null) {
        for (const entry of arcs) {
          if (entry.lineageId !== this.hoveredLineageId) continue;
          const arc = entry.arc;
          if (arc.length < 4) continue;
          this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
          this.ctx.lineWidth = 6;
          this.ctx.beginPath();
          this.ctx.moveTo(arc[1]!, arc[0]!);
          for (let p = 2; p < arc.length; p += 2) {
            this.ctx.lineTo(arc[p + 1]!, arc[p]!);
          }
          this.ctx.stroke();
          const [r, g, b] = entry.color;
          this.ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
          this.ctx.lineWidth = 3;
          this.ctx.beginPath();
          this.ctx.moveTo(arc[1]!, arc[0]!);
          for (let p = 2; p < arc.length; p += 2) {
            this.ctx.lineTo(arc[p + 1]!, arc[p]!);
          }
          this.ctx.stroke();
        }
      }
    }
  }

  private clearCanvas(): void {
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}

function percentileLevels(data: Float32Array, lo: number, hi: number): { lo: number; hi: number } {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (Number.isFinite(v)) {
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  }
  if (!Number.isFinite(mn) || mn === mx) return { lo: 0, hi: 1 };
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
  const findBin = (frac: number): number => {
    const target = Math.floor(frac * n);
    let cum = 0;
    for (let b = 0; b < bins; b++) {
      cum += counts[b]!;
      if (cum >= target) return b;
    }
    return bins - 1;
  };
  return {
    lo: mn + (findBin(lo) / bins) * span,
    hi: mn + (findBin(hi) / bins) * span,
  };
}
