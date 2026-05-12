import FFT from 'fft.js';
import type { Image2D } from '../types';

/**
 * 2-D FFT via row-then-column 1-D FFTs. fft.js does power-of-two only,
 * so non-pow2 inputs are zero-padded up. The padding has to be done
 * with mirror reflection at the image boundary, otherwise the low-pass
 * gets ringing artefacts at the edges (which is exactly what the
 * scipy.ndimage.gaussian_filter("mirror") in the Python code avoids).
 */

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Reflect-pad an image into a padH × padW canvas with the source
 *  centred at (offsetY, offsetX). Out-of-image samples reflect about
 *  the source-image boundary (numpy 'reflect' mode). */
function reflectPadCentred(
  img: Image2D,
  padH: number,
  padW: number,
  offsetY: number,
  offsetX: number
): Float32Array {
  const [h, w] = img.shape;
  const out = new Float32Array(padH * padW);
  for (let y = 0; y < padH; y++) {
    // Source row (relative to image origin).
    let sy = y - offsetY;
    // Reflect into [0, h-1] using 'reflect' mode (period = 2*(h-1)).
    if (h > 1) {
      const period = 2 * (h - 1);
      sy = ((sy % period) + period) % period;
      if (sy >= h) sy = period - sy;
    } else {
      sy = 0;
    }
    for (let x = 0; x < padW; x++) {
      let sx = x - offsetX;
      if (w > 1) {
        const period = 2 * (w - 1);
        sx = ((sx % period) + period) % period;
        if (sx >= w) sx = period - sx;
      } else {
        sx = 0;
      }
      out[y * padW + x] = img.data[sy * w + sx]!;
    }
  }
  return out;
}

/**
 * Gaussian low-pass in the Fourier domain. `cutoffPixels` is the
 * spatial period at which the filter response is exp(-0.5) ≈ 0.607 —
 * features with periods longer than this pass through, shorter ones
 * are attenuated.
 *
 * Filter: exp(-0.5 * (f/fc)²) with fc = 1/cutoffPixels, f in
 * cycles/pixel. Matches numpy.fft.fft2 + the formula in the Python
 * `background.py`.
 */
export function gaussianLowPass(img: Image2D, cutoffPixels: number): Image2D {
  const [h, w] = img.shape;
  // Python pads symmetrically by cutoff*2 on each side, then FFTs. We
  // match that pad amount and round up to the next power of two for
  // fft.js. Because the FFT-domain Gaussian filter is symmetric, the
  // exact alignment of the reflected pad doesn't change the interior
  // result, only the suppressed edge ringing — so as long as our pad
  // is at least as wide as Python's, the unpadded crop matches.
  const pad = Math.max(2, Math.round(cutoffPixels * 2));
  const padH = nextPow2(h + 2 * pad);
  const padW = nextPow2(w + 2 * pad);
  // Centre the source in the padded canvas.
  const offsetY = Math.floor((padH - h) / 2);
  const offsetX = Math.floor((padW - w) / 2);

  _ensureScratch(padH, padW);
  const padded = reflectPadCentred(img, padH, padW, offsetY, offsetX);

  // Row FFT
  const fftW = new FFT(padW);
  const rowOut = fftW.createComplexArray();
  const rowIn = fftW.createComplexArray();
  // Real -> complex by interleaving zeros for imaginary
  for (let y = 0; y < padH; y++) {
    for (let x = 0; x < padW; x++) {
      rowIn[2 * x] = padded[y * padW + x]!;
      rowIn[2 * x + 1] = 0;
    }
    fftW.transform(rowOut, rowIn);
    for (let x = 0; x < padW; x++) {
      // Stash row-FFT result back into `padded` (real interleaved imaginary
      // needs different storage; use two arrays for real/imag of the 2-D
      // intermediate plane).
      const ri = 2 * x;
      _intermediateRe[y * padW + x] = rowOut[ri]!;
      _intermediateIm[y * padW + x] = rowOut[ri + 1]!;
    }
  }

  // Column FFT
  const fftH = new FFT(padH);
  const colIn = fftH.createComplexArray();
  const colOut = fftH.createComplexArray();
  for (let x = 0; x < padW; x++) {
    for (let y = 0; y < padH; y++) {
      colIn[2 * y] = _intermediateRe[y * padW + x]!;
      colIn[2 * y + 1] = _intermediateIm[y * padW + x]!;
    }
    fftH.transform(colOut, colIn);
    // Apply Gaussian filter and write back. Frequency index v wraps:
    // [0, padH/2) is positive freq, [padH/2, padH) is negative.
    // Filter: exp(-0.5 * (f / fc)²) with fc = 1/cutoffPixels.
    const fc = 1 / cutoffPixels;
    for (let y = 0; y < padH; y++) {
      const fy = y < padH / 2 ? y : y - padH;
      const fx = x < padW / 2 ? x : x - padW;
      const fxn = fx / padW;
      const fyn = fy / padH;
      const fr2 = fxn * fxn + fyn * fyn;
      const g = Math.exp(-0.5 * (fr2 / (fc * fc)));
      _colRe[y] = colOut[2 * y]! * g;
      _colIm[y] = colOut[2 * y + 1]! * g;
    }
    // Inverse column FFT. fft.js normalises internally (output of
    // inverseTransform already divided by N), so no manual scaling.
    for (let y = 0; y < padH; y++) {
      colIn[2 * y] = _colRe[y]!;
      colIn[2 * y + 1] = _colIm[y]!;
    }
    fftH.inverseTransform(colOut, colIn);
    for (let y = 0; y < padH; y++) {
      _intermediateRe[y * padW + x] = colOut[2 * y]!;
      _intermediateIm[y * padW + x] = colOut[2 * y + 1]!;
    }
  }

  // Inverse row FFT (already normalised). Crop the centred region.
  const out = new Float32Array(h * w);
  for (let y = 0; y < padH; y++) {
    for (let x = 0; x < padW; x++) {
      rowIn[2 * x] = _intermediateRe[y * padW + x]!;
      rowIn[2 * x + 1] = _intermediateIm[y * padW + x]!;
    }
    fftW.inverseTransform(rowOut, rowIn);
    const dy = y - offsetY;
    if (dy >= 0 && dy < h) {
      for (let x = 0; x < w; x++) {
        out[dy * w + x] = rowOut[2 * (x + offsetX)]!;
      }
    }
  }

  return { data: out, shape: img.shape };
}

// Module-scoped scratch buffers, sized lazily. Using arrays keeps things
// simple at the cost of not being reentrant-safe; if we ever go
// multi-threaded we'll move these into the function or pass them in.
let _intermediateRe = new Float32Array(0);
let _intermediateIm = new Float32Array(0);
let _colRe = new Float32Array(0);
let _colIm = new Float32Array(0);

export function _ensureScratch(padH: number, padW: number): void {
  const n = padH * padW;
  if (_intermediateRe.length < n) {
    _intermediateRe = new Float32Array(n);
    _intermediateIm = new Float32Array(n);
  }
  if (_colRe.length < padH) {
    _colRe = new Float32Array(padH);
    _colIm = new Float32Array(padH);
  }
}
