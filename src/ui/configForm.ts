/**
 * Auto-generated config form. Walks a defaults object and emits one
 * input per leaf, recursing into nested objects. Reuses the same path
 * as the form field name and round-trips changes via callback.
 *
 * Type handling:
 *   number          → <input type="number">
 *   number | null   → <input type="number"> (empty string ⇒ null)
 *   string          → <select> if listed in `enums`, else <input>
 *   number[]        → <input type="text"> (comma-separated)
 *   nested object   → recurse inside a <fieldset>
 */

type Path = readonly string[];

export interface ConfigFormOptions<T> {
  defaults: T;
  initial: T;
  /** Per-path enum lists for string fields rendered as <select>. */
  enums?: Partial<Record<string, readonly string[]>>;
  /** Per-path human-readable description for tooltips. */
  descriptions?: Partial<Record<string, string>>;
  onChange: (next: T) => void;
}

export function mountConfigForm<T extends Record<string, unknown>>(
  root: HTMLElement,
  options: ConfigFormOptions<T>
): { reset: () => void; getValue: () => T } {
  // Deep clone so mutations don't leak back to the caller.
  let value: T = deepClone(options.initial) as T;

  const render = (): void => {
    root.innerHTML = '';
    renderInto(
      root,
      value as unknown as Record<string, unknown>,
      [],
      options.enums ?? {},
      options.descriptions ?? {},
      (path, v) => {
        setPath(value as unknown as Record<string, unknown>, path, v);
        options.onChange(value);
      }
    );
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'secondary';
    resetBtn.textContent = 'Reset to defaults';
    resetBtn.style.marginTop = '12px';
    resetBtn.addEventListener('click', () => {
      value = deepClone(options.defaults) as T;
      options.onChange(value);
      render();
    });
    root.appendChild(resetBtn);
  };

  render();

  return {
    reset: () => {
      value = deepClone(options.defaults) as T;
      options.onChange(value);
      render();
    },
    getValue: () => value,
  };
}

function renderInto(
  parent: HTMLElement,
  obj: Record<string, unknown>,
  path: Path,
  enums: Partial<Record<string, readonly string[]>>,
  descriptions: Partial<Record<string, string>>,
  onChange: (path: Path, value: unknown) => void
): void {
  for (const key of Object.keys(obj)) {
    const cur = obj[key];
    const fieldPath = [...path, key];
    if (cur !== null && typeof cur === 'object' && !Array.isArray(cur)) {
      const fs = document.createElement('fieldset');
      fs.className = 'config-group';
      const legend = document.createElement('legend');
      legend.textContent = humanLabel(key);
      fs.appendChild(legend);
      renderInto(fs, cur as Record<string, unknown>, fieldPath, enums, descriptions, onChange);
      parent.appendChild(fs);
    } else {
      parent.appendChild(renderLeaf(fieldPath, cur, enums, descriptions, onChange));
    }
  }
}

function renderLeaf(
  path: Path,
  value: unknown,
  enums: Partial<Record<string, readonly string[]>>,
  descriptions: Partial<Record<string, string>>,
  onChange: (path: Path, value: unknown) => void
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'config-row';

  const flatKey = path.join('.');
  const description = descriptions[flatKey];

  const label = document.createElement('label');
  label.textContent = humanLabel(path[path.length - 1]!);
  // Tooltip: full description if provided, falling back to path.
  label.title = description ? `${description}\n(${flatKey})` : flatKey;
  if (description) wrapper.title = description;
  wrapper.appendChild(label);

  const enumOptions = enums[flatKey];

  if (typeof value === 'boolean') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = value;
    cb.addEventListener('change', () => onChange(path, cb.checked));
    wrapper.appendChild(cb);
  } else if (Array.isArray(value)) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = (value as unknown[]).join(', ');
    input.addEventListener('change', () => {
      const parsed = input.value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => Number(s))
        .filter((n) => !Number.isNaN(n));
      onChange(path, parsed);
    });
    wrapper.appendChild(input);
  } else if (typeof value === 'string' || (value === null && enumOptions)) {
    if (enumOptions) {
      const select = document.createElement('select');
      for (const opt of enumOptions) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        if (opt === value) o.selected = true;
        select.appendChild(o);
      }
      select.addEventListener('change', () => onChange(path, select.value));
      wrapper.appendChild(select);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = String(value ?? '');
      input.addEventListener('change', () => onChange(path, input.value));
      wrapper.appendChild(input);
    }
  } else {
    // number | number | null — wrap with custom +/- buttons.
    const numWrap = document.createElement('div');
    numWrap.className = 'num-input';

    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.value = value == null ? '' : String(value);
    input.placeholder = value == null ? 'auto' : '';
    const commit = (): void => {
      if (input.value === '') {
        onChange(path, null);
      } else {
        const n = Number(input.value);
        if (!Number.isNaN(n)) onChange(path, n);
      }
    };
    input.addEventListener('change', commit);

    const stepSize = pickStep(value, path);
    const dec = document.createElement('button');
    dec.type = 'button';
    dec.className = 'num-step';
    dec.textContent = '−';
    dec.tabIndex = -1;
    dec.addEventListener('click', () => {
      const cur = input.value === '' ? 0 : Number(input.value);
      if (Number.isNaN(cur)) return;
      const next = cur - stepSize;
      input.value = formatStep(next, stepSize);
      commit();
    });

    const inc = document.createElement('button');
    inc.type = 'button';
    inc.className = 'num-step';
    inc.textContent = '+';
    inc.tabIndex = -1;
    inc.addEventListener('click', () => {
      const cur = input.value === '' ? 0 : Number(input.value);
      if (Number.isNaN(cur)) return;
      const next = cur + stepSize;
      input.value = formatStep(next, stepSize);
      commit();
    });

    numWrap.appendChild(dec);
    numWrap.appendChild(input);
    numWrap.appendChild(inc);
    wrapper.appendChild(numWrap);
  }

  return wrapper;
}

/** Pick a sensible step size for a numeric field. Tries the path first
 *  (so we can hand-tune step for known fields), then falls back to a
 *  power-of-ten heuristic based on the current value's magnitude. */
function pickStep(value: unknown, path: Path): number {
  const flat = path.join('.');
  // Hand-tuned steps for known fields.
  const exact: Record<string, number> = {
    fftCutoffPixels: 5,
    fringeWindow: 2,
    fringeBoost: 0.1,
    contrast: 0.1,
    nlmHFactor: 0.5,
    nlmPatch: 2,
    nlmSearch: 1,
    iouThresh: 0.05,
    minTrackLength: 1,
    temporalSigma: 0.25,
    fpsCh0: 1,
    fpsCh1: 1,
    umPerPx: 0.001,
    mtWidthUm: 0.005,
    minLengthUm: 0.1,
    workerCount: 1,
    forceTiffChannels: 1,
    previewFrames: 1,
    'detect.minObjectSize': 5,
    'detect.minArcLength': 1,
    'detect.maxJunctionGap': 0.5,
    'detect.junctionMergeRadius': 0.5,
    'detect.maxPairCost': 0.1,
    'detect.maxBrightnessPct': 5,
    'detect.hysteresisLowRatio': 0.05,
    'detect.localThresholdTile': 32,
    'detect.localThresholdFloorRatio': 0.05,
    'haloFilter.darkThreshold': 5,
    'haloFilter.minDotDimPx': 1,
    'haloFilter.maxDotDimPx': 1,
    'haloFilter.minAspectRatio': 0.05,
    'haloFilter.haloInnerMarginPx': 1,
    'haloFilter.haloOuterMarginPx': 1,
    'haloFilter.minPerFrameHaloFraction': 0.05,
    'haloFilter.minTrackHaloFraction': 0.05,
    'lineage.iouThresh': 0.05,
    'lineage.maxGap': 1,
    'lineage.adjacencyPx': 1,
    'lineage.adjacencyDot': 0.05,
    'lineage.overlapIou': 0.05,
    'lineage.overlapDilatePx': 1,
  };
  if (flat in exact) return exact[flat]!;
  // Fallback: scale by current value.
  const v = typeof value === 'number' ? Math.abs(value) : 0;
  if (v === 0) return 1;
  const oom = Math.pow(10, Math.floor(Math.log10(v)) - 1);
  return oom > 0 ? oom : 1;
}

function formatStep(n: number, step: number): string {
  // Round to the step's precision so we don't show 0.30000000000000004.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return n.toFixed(decimals);
}

function setPath(obj: Record<string, unknown>, path: Path, value: unknown): void {
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    cur = cur[path[i]!] as Record<string, unknown>;
  }
  cur[path[path.length - 1]!] = value;
}

function humanLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function deepClone<T>(x: T): T {
  if (x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return (x as unknown[]).map((v) => deepClone(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(x as Record<string, unknown>)) {
    out[k] = deepClone((x as Record<string, unknown>)[k]);
  }
  return out as unknown as T;
}
