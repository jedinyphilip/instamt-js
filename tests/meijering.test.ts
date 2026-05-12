import { describe, expect, it } from 'vitest';

import { meijering } from '../src/core/filters/meijering';

describe('meijering', () => {
  it('responds to a horizontal dark ridge', () => {
    const w = 32;
    const h = 32;
    const data = new Float32Array(w * h).fill(0.5);
    for (let x = 4; x < w - 4; x++) data[16 * w + x] = 0.1; // dark line
    const r = meijering({ data, shape: [h, w] }, [1.0, 1.5, 2.0], true);
    // Response should be largest along the ridge centre
    const onRidge = r.data[16 * w + 16]!;
    const offRidge = r.data[8 * w + 16]!;
    expect(onRidge).toBeGreaterThan(0.5);
    expect(offRidge).toBeLessThan(0.1);
  });

  it('returns values in [0, 1]', () => {
    const w = 16;
    const h = 16;
    const data = new Float32Array(w * h).fill(0.3);
    for (let i = 0; i < 5; i++) data[i + 5 * w] = 0;
    const r = meijering({ data, shape: [h, w] });
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of r.data) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
  });
});
