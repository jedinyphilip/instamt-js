import { describe, expect, it } from 'vitest';

import { gaussianFilter2d } from '../src/core/filters/gaussian';

describe('gaussianFilter2d', () => {
  it('returns the input on σ=0 (no smoothing)', () => {
    const data = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const out = gaussianFilter2d({ data, shape: [3, 3] }, 0);
    expect(Array.from(out.data)).toEqual(Array.from(data));
  });

  it('preserves a constant image', () => {
    const data = new Float32Array(25).fill(3.5);
    const out = gaussianFilter2d({ data, shape: [5, 5] }, 1.5);
    for (const v of out.data) expect(v).toBeCloseTo(3.5, 4);
  });

  it('blurs a delta into a Gaussian shape', () => {
    const w = 21;
    const data = new Float32Array(w * w);
    data[10 * w + 10] = 1; // unit delta at the centre
    const out = gaussianFilter2d({ data, shape: [w, w] }, 2);
    // Peak stays at the centre
    let max = -Infinity;
    let argmax = -1;
    for (let i = 0; i < out.data.length; i++) {
      const v = out.data[i]!;
      if (v > max) {
        max = v;
        argmax = i;
      }
    }
    expect(argmax).toBe(10 * w + 10);
    // Total mass is preserved within float rounding
    let sum = 0;
    for (const v of out.data) sum += v;
    expect(sum).toBeCloseTo(1, 3);
  });
});
