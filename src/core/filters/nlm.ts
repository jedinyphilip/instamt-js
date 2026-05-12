import type { Image2D } from '../types';

/**
 * Fast non-local means denoising (Buades et al. with the Darbon et al.
 * integral-image acceleration). Mirrors `skimage.restoration.denoise_nl_means`
 * with `fast_mode=True`.
 *
 * For each search-window offset (dy, dx):
 *   - compute the squared-difference image D = (I - shift(I, dy, dx))²
 *   - compute integral image of D in O(N)
 *   - read the patch sum at every pixel in O(1) via the integral image
 *   - convert to weight w = exp(-(patchSum - 2σ²·patchPixels)/h²·patchPixels)
 *   - accumulate I[shifted] * w into the output and w into the
 *     normalisation buffer
 *
 * Total cost is O(N · search²) regardless of patchSize — patch size only
 * affects the integral-image lookup constants.
 *
 * Inputs and outputs are in the [0, 1] range (skimage's convention; the
 * caller should normalise an 8-bit image to img/255 first).
 */
export function denoiseNlMeansFast(
  img: Image2D,
  patchSize = 7,
  patchDistance = 11,
  h = 0.1,
  sigma = 0.0
): Image2D {
  const [H0, W0] = img.shape;
  const r = (patchSize - 1) >>> 1;
  const s = patchDistance;
  const patchPixels = patchSize * patchSize;
  const sigma2 = sigma * sigma;
  const hScaled = h;
  const norm2 = patchPixels * (hScaled * hScaled);

  // Reflect-pad the input to match skimage: skimage internally pads by
  // `patch_size//2 + patch_distance` and runs NLM on the padded image,
  // returning the un-padded centre. Without this, JS leaves the
  // outermost ~r+s pixels untouched (boundary pixels in the input pass
  // straight through), producing a ring of ~16 grey-level differences
  // vs Python's NLM output.
  const pad = r + s;
  const H = H0 + 2 * pad;
  const W = W0 + 2 * pad;
  const data = new Float32Array(H * W);
  for (let y = 0; y < H; y++) {
    let sy = y - pad;
    // whole-sample symmetric reflect (matches numpy.pad mode='reflect'
    // for the path skimage takes here).
    if (sy < 0) sy = -sy;
    else if (sy >= H0) sy = 2 * H0 - sy - 2;
    if (sy < 0) sy = 0;
    if (sy >= H0) sy = H0 - 1;
    for (let x = 0; x < W; x++) {
      let sx = x - pad;
      if (sx < 0) sx = -sx;
      else if (sx >= W0) sx = 2 * W0 - sx - 2;
      if (sx < 0) sx = 0;
      if (sx >= W0) sx = W0 - 1;
      data[y * W + x] = img.data[sy * W0 + sx]!;
    }
  }

  const out = new Float32Array(H * W);
  const wts = new Float32Array(H * W);
  const diff = new Float64Array(H * W);
  const integral = new Float64Array(H * W);

  for (let dy = -s; dy <= s; dy++) {
    for (let dx = -s; dx <= s; dx++) {
      // Squared difference image. Out-of-image neighbours contribute 0
      // (skimage clips at the boundary too).
      let yMin = Math.max(0, -dy);
      let yMax = Math.min(H, H - dy);
      let xMin = Math.max(0, -dx);
      let xMax = Math.min(W, W - dx);
      diff.fill(0);
      for (let y = yMin; y < yMax; y++) {
        const ny = y + dy;
        const baseSelf = y * W;
        const baseShift = ny * W;
        for (let x = xMin; x < xMax; x++) {
          const d = data[baseSelf + x]! - data[baseShift + x + dx]!;
          diff[baseSelf + x] = d * d;
        }
      }

      // Integral image (sum of `diff` over [0..y, 0..x]).
      // integral[y, x] = diff[y, x] + integral[y-1, x] + integral[y, x-1]
      //                            - integral[y-1, x-1]
      for (let y = 0; y < H; y++) {
        let rowSum = 0;
        for (let x = 0; x < W; x++) {
          rowSum += diff[y * W + x]!;
          integral[y * W + x] = rowSum + (y > 0 ? integral[(y - 1) * W + x]! : 0);
        }
      }

      // For each interior pixel where the patch fits and the shifted
      // patch fits too, accumulate the weighted shifted value.
      const yLo = Math.max(r, -dy + r);
      const yHi = Math.min(H - r, H - dy - r);
      const xLo = Math.max(r, -dx + r);
      const xHi = Math.min(W - r, W - dx - r);
      for (let y = yLo; y < yHi; y++) {
        const ny = y + dy;
        const yTopIdx = (y - r - 1) * W;
        const yBotIdx = (y + r) * W;
        const useTop = y - r > 0;
        for (let x = xLo; x < xHi; x++) {
          const nx = x + dx;
          let sum = integral[yBotIdx + (x + r)]!;
          if (useTop) sum -= integral[yTopIdx + (x + r)]!;
          if (x - r > 0) {
            sum -= integral[yBotIdx + (x - r - 1)]!;
            if (useTop) sum += integral[yTopIdx + (x - r - 1)]!;
          }
          // Subtract the noise-baseline so similar-looking patches
          // (separated by pure noise) don't get penalised.
          const dist = Math.max(sum - 2 * sigma2 * patchPixels, 0);
          const w = Math.exp(-dist / norm2);
          const i = y * W + x;
          out[i] = out[i]! + data[ny * W + nx]! * w;
          wts[i] = wts[i]! + w;
        }
      }
    }
  }

  // Normalise on the padded grid, then crop back to the original H0×W0.
  const result = new Float32Array(H0 * W0);
  for (let y = 0; y < H0; y++) {
    const srcRow = (y + pad) * W + pad;
    for (let x = 0; x < W0; x++) {
      const i = srcRow + x;
      result[y * W0 + x] = wts[i]! > 0 ? out[i]! / wts[i]! : data[i]!;
    }
  }
  return { data: result, shape: img.shape };
}
