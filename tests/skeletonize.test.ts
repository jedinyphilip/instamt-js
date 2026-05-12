import { describe, expect, it } from 'vitest';

import { branchPoints, skeletonize } from '../src/core/filters/skeletonize';

describe('skeletonize', () => {
  it('thins a thick horizontal bar to a 1-pixel line', () => {
    const w = 11;
    const h = 5;
    const mask = new Uint8Array(w * h);
    // 3-row thick bar across the middle
    for (let y = 1; y <= 3; y++) {
      for (let x = 0; x < w; x++) mask[y * w + x] = 1;
    }
    const skel = skeletonize(mask, w, h);
    // Count rows with foreground pixels — should be 1 (the centre row).
    let rowsWithFg = 0;
    for (let y = 0; y < h; y++) {
      let any = false;
      for (let x = 0; x < w; x++) if (skel[y * w + x]) any = true;
      if (any) rowsWithFg++;
    }
    expect(rowsWithFg).toBe(1);
  });

  it('preserves a single-pixel line unchanged', () => {
    const w = 7;
    const h = 7;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < 5; i++) mask[3 * w + 1 + i] = 1;
    const skel = skeletonize(mask, w, h);
    expect(Array.from(skel)).toEqual(Array.from(mask));
  });
});

describe('branchPoints', () => {
  it('flags the centre of a T-junction', () => {
    const w = 7;
    const h = 7;
    // T-shape: horizontal bar at y=3, vertical bar at x=3
    const skel = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) skel[3 * w + x] = 1;
    for (let y = 0; y < h; y++) skel[y * w + 3] = 1;
    const bp = branchPoints(skel, w, h);
    expect(bp[3 * w + 3]).toBe(1);
  });
});
