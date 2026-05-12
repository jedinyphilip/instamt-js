import { gaussianFilter2d } from '../filters/gaussian';
import { medianFilter2d } from '../filters/median';
import { denoiseNlMeansFast } from '../filters/nlm';
import { estimateSigma } from '../filters/wavelet';
import type { Image2D } from '../types';

/**
 * Denoise an IRM image. Mirrors `src/denoise.py:denoise_and_enhance`
 * exactly. The input is expected to be in the 0-255 range (the upstream
 * pipeline pre-normalises the stack); we divide by 255 for NLM, run on
 * [0, 1] data, then rescale back. Output is clipped to [0, 255].
 *
 *   1. img_norm = img / 255
 *   2. sigma_est = estimateSigma(img_norm)
 *   3. denoised = NLM(img_norm, h = sigma * nlmHFactor) * 255
 *   4. 3×3 median (speckle removal)
 *   5. σ=0.5 Gaussian polish
 *   6. enhanced = mean + (denoised - mean) * contrast
 *   7. clip to [0, 255]
 */
export function denoise(
  img: Image2D,
  contrast = 2.5,
  nlmHFactor = 4.0, // 4.0 on 0-255-normalised input
  nlmPatch = 7,
  nlmSearch = 11
): Image2D {
  const meanVal = computeMean(img.data);

  const norm = new Float32Array(img.data.length);
  for (let i = 0; i < img.data.length; i++) norm[i] = img.data[i]! / 255;

  const [h, w] = img.shape;
  const sigma = estimateSigma(norm, h, w);
  const nlmH = sigma * nlmHFactor;
  const denoisedNorm = denoiseNlMeansFast(
    { data: norm, shape: img.shape },
    nlmPatch,
    nlmSearch,
    nlmH,
    sigma
  );
  const denoised = new Float32Array(img.data.length);
  for (let i = 0; i < img.data.length; i++) denoised[i] = denoisedNorm.data[i]! * 255;

  const speckleClean = medianFilter2d({ data: denoised, shape: img.shape }, 3);
  const smooth = gaussianFilter2d(speckleClean, 0.5);

  // Contrast: amplify deviations from the *original input's* mean
  // (the mean is computed once, before any processing).
  const out = new Float32Array(smooth.data.length);
  for (let i = 0; i < smooth.data.length; i++) {
    const enhanced = meanVal + (smooth.data[i]! - meanVal) * contrast;
    out[i] = enhanced < 0 ? 0 : enhanced > 255 ? 255 : enhanced;
  }
  return { data: out, shape: img.shape };
}

function computeMean(data: Float32Array): number {
  let s = 0;
  for (let i = 0; i < data.length; i++) s += data[i]!;
  return s / data.length;
}
