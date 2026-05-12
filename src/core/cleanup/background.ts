import { gaussianLowPass } from '../filters/fft';
import type { Image2D } from '../types';

/**
 * IRM background subtraction. Mirrors `src/background.py`:
 *   bg = gaussian_lowpass(img, cutoffPixels)
 *   mean_val = mean(bg)
 *   corrected = clip(img - bg + mean_val, 0, 255)
 *
 * Re-adding `mean_val` (rather than just subtracting `bg`) keeps the
 * output in the 0-255 range expected by the downstream uint8 pipeline,
 * and preserves a sensible local baseline for the median-based fringe
 * unification that follows.
 */
export function fftBackgroundSubtract(
  img: Image2D,
  cutoffPixels = 60
): { corrected: Image2D; background: Image2D } {
  const background = gaussianLowPass(img, cutoffPixels);
  let bgSum = 0;
  for (let i = 0; i < background.data.length; i++) bgSum += background.data[i]!;
  const meanVal = bgSum / background.data.length;
  const out = new Float32Array(img.data.length);
  for (let i = 0; i < img.data.length; i++) {
    const v = img.data[i]! - background.data[i]! + meanVal;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return {
    corrected: { data: out, shape: img.shape },
    background,
  };
}
