import { describe, expect, it } from 'vitest';

import { fftBackgroundSubtract } from '../src/core/cleanup/background';

describe('fftBackgroundSubtract', () => {
  it('captures a slowly-varying gradient as background and re-centres on its mean', () => {
    // 64×64 linear gradient in [0, 60]. With cutoff=16 the gradient
    // passes the low-pass strongly, so corrected ≈ mean(bg) everywhere
    // (Python re-adds mean(bg) to keep output in 0-255 range).
    const w = 64;
    const data = new Float32Array(w * w);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) data[y * w + x] = x * 0.5 + y * 0.3;
    }
    const { corrected, background } = fftBackgroundSubtract({ data, shape: [w, w] }, 16);

    const margin = 8;
    let bgErr = 0;
    let n = 0;
    let bgSum = 0;
    for (let y = margin; y < w - margin; y++) {
      for (let x = margin; x < w - margin; x++) {
        const i = y * w + x;
        const d = background.data[i]! - data[i]!;
        bgErr += d * d;
        bgSum += background.data[i]!;
        n++;
      }
    }
    bgErr = Math.sqrt(bgErr / n);
    expect(bgErr).toBeLessThan(2);
    const bgMean = bgSum / n;

    // Corrected interior should be ≈ mean(bg) since the gradient was
    // fully captured and added back.
    let maxDev = 0;
    for (let y = margin; y < w - margin; y++) {
      for (let x = margin; x < w - margin; x++) {
        const v = corrected.data[y * w + x]!;
        const d = Math.abs(v - bgMean);
        if (d > maxDev) maxDev = d;
      }
    }
    expect(maxDev).toBeLessThan(3);
  });

  it('preserves high-frequency structure (clipped to 0-255 range)', () => {
    // Flat field at 50 with a bright delta at 220. The delta is
    // high-frequency so it survives the high-pass; output is clipped
    // to [0, 255] per Python.
    const w = 64;
    const data = new Float32Array(w * w).fill(50);
    data[32 * w + 32] = 220;
    const { corrected } = fftBackgroundSubtract({ data, shape: [w, w] }, 30);
    // Background ≈ mean ≈ 50 + tiny bump. corrected at delta ≈
    // 220 - 50 + 50 = 220. Background elsewhere ≈ 50; corrected ≈ 50.
    expect(corrected.data[32 * w + 32]!).toBeGreaterThan(180);
    expect(Math.abs(corrected.data[0]! - 50)).toBeLessThan(5);
  });
});
