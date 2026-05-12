import { describe, expect, it } from 'vitest';

import { liThreshold } from '../src/core/filters/threshold';

describe('liThreshold', () => {
  it('matches the bimodal cross-entropy minimum', () => {
    // Two-Gaussian-mixture-style synthetic distribution. Li should
    // converge between the modes regardless of starting point.
    const w = 64;
    const data = new Float32Array(w * w);
    for (let i = 0; i < data.length; i++) {
      data[i] = i % 2 === 0 ? 0.2 + Math.random() * 0.1 : 0.8 + Math.random() * 0.1;
    }
    const t = liThreshold({ data, shape: [w, w] });
    expect(t).toBeGreaterThan(0.3);
    expect(t).toBeLessThan(0.7);
  });

  it('returns the single value for a flat image', () => {
    const data = new Float32Array(16).fill(7);
    expect(liThreshold({ data, shape: [4, 4] })).toBe(7);
  });
});
