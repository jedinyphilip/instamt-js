/**
 * Guo-Hall LUT-based thinning. Matches `skimage.morphology.thin()` which
 * uses the Lam-Lee-Suen survey's two LUTs, and produces a skeleton
 * essentially identical to skimage's `skeletonize()` (Zhang-Suen via
 * the Cython `_fast_skeletonize`) — same arc lengths within 1-2 px.
 *
 * Our previous textbook Zhang-Suen implementation produced 11× more
 * branch points than skimage on the same input mask, fragmenting MTs
 * into many short arcs. The LUT version doesn't have that problem.
 *
 * Neighbour weighting (matches `skimage.morphology._skeletonize.thin`):
 *   8  4  2
 *   16 0  1
 *   32 64 128
 *
 * Sub-iteration 1 uses G123_LUT, sub-iteration 2 uses G123P_LUT.
 * Both LUTs are taken verbatim from skimage 0.26's source.
 */

// G123_LUT — pixels removed in sub-iteration 1 (sum of weighted neighbors → boolean).
const G123_LUT = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0,
]);

// G123P_LUT — pixels removed in sub-iteration 2.
const G123P_LUT = new Uint8Array([
  0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
  0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0,
  1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
  0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1,
  0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0,
  1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

export function skeletonize(mask: Uint8Array, w: number, h: number): Uint8Array {
  const skel = new Uint8Array(mask);
  const N = new Uint8Array(skel.length);

  for (;;) {
    let nDeleted = 0;
    for (const lut of [G123_LUT, G123P_LUT]) {
      // Compute the weighted neighbourhood sum for every foreground pixel.
      // OOB neighbours are 0 (matches scipy's `convolve(mode='constant')`).
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!skel[i]) {
            N[i] = 0;
            continue;
          }
          let n = 0;
          // Weights: NW=8, N=4, NE=2, W=16, E=1, SW=32, S=64, SE=128
          if (y > 0) {
            if (x > 0 && skel[(y - 1) * w + (x - 1)]) n |= 8;
            if (skel[(y - 1) * w + x]) n |= 4;
            if (x < w - 1 && skel[(y - 1) * w + (x + 1)]) n |= 2;
          }
          if (x > 0 && skel[y * w + (x - 1)]) n |= 16;
          if (x < w - 1 && skel[y * w + (x + 1)]) n |= 1;
          if (y < h - 1) {
            if (x > 0 && skel[(y + 1) * w + (x - 1)]) n |= 32;
            if (skel[(y + 1) * w + x]) n |= 64;
            if (x < w - 1 && skel[(y + 1) * w + (x + 1)]) n |= 128;
          }
          N[i] = n;
        }
      }
      // Delete pixels whose neighbourhood index is "1" in this LUT.
      for (let i = 0; i < skel.length; i++) {
        if (skel[i] && lut[N[i]!]) {
          skel[i] = 0;
          nDeleted++;
        }
      }
    }
    if (nDeleted === 0) break;
  }
  return skel;
}

/** Branch points: pixels with ≥3 foreground neighbours. OOB = bg. */
export function branchPoints(skel: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(skel.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!skel[i]) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (skel[yy * w + xx]) n++;
        }
      }
      if (n >= 3) out[i] = 1;
    }
  }
  return out;
}
