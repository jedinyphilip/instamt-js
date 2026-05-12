import { describe, expect, it } from 'vitest';

import { medianFilter2d } from '../src/core/filters/median';

describe('medianFilter2d', () => {
  it('returns the median of a 3x3 window in the centre of a flat image', () => {
    const data = new Float32Array(25).fill(7);
    const out = medianFilter2d({ data, shape: [5, 5] }, 3);
    expect(out.data[12]).toBe(7);
  });

  it('removes salt-and-pepper noise', () => {
    const w = 5;
    const data = new Float32Array(w * w).fill(0);
    data[12] = 100; // single hot pixel in the centre
    const out = medianFilter2d({ data, shape: [w, w] }, 3);
    expect(out.data[12]).toBe(0);
  });

  it('rejects even sizes', () => {
    expect(() => medianFilter2d({ data: new Float32Array(4), shape: [2, 2] }, 2)).toThrow();
  });

  it("uses scipy 'reflect' boundary handling (a[-1] = a[0])", () => {
    const data = new Float32Array([1, 2, 3, 4, 5]);
    const out = medianFilter2d({ data, shape: [1, 5] }, 3);
    // First pixel sees [reflect=1, 1, 2] -> median = 1
    expect(out.data[0]).toBe(1);
    // Last pixel sees [4, 5, reflect=5] -> median = 5
    expect(out.data[4]).toBe(5);
  });
});
