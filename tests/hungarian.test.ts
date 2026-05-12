import { describe, expect, it } from 'vitest';

import { hungarian } from '../src/core/microtubules/hungarian';

describe('hungarian', () => {
  it('solves a 3x3 with the obvious diagonal optimum', () => {
    const cost = [
      [1, 9, 9],
      [9, 2, 9],
      [9, 9, 3],
    ];
    expect(hungarian(cost)).toEqual([0, 1, 2]);
  });

  it('finds the non-trivial assignment that beats the greedy choice', () => {
    // Greedy on (0,1) costs 1+2+8 = 11. Optimum is (0,1)+(1,0)+(2,2) =
    // 1+3+5 = 9. Or (0,0)+(1,1)+(2,2) = 4+2+5 = 11. So Hungarian must
    // pick (0,1)/(1,0)/(2,2).
    const cost = [
      [4, 1, 3],
      [3, 2, 8],
      [9, 7, 5],
    ];
    const result = hungarian(cost);
    let total = 0;
    for (let i = 0; i < result.length; i++) total += cost[i]![result[i]!]!;
    expect(total).toBe(9);
  });

  it('handles rectangular cost (more cols than rows)', () => {
    const cost = [
      [3, 1, 4],
      [2, 5, 9],
    ];
    // Optimum: row 0 → col 1 (cost 1), row 1 → col 0 (cost 2). Total 3.
    const result = hungarian(cost);
    let total = 0;
    for (let i = 0; i < result.length; i++) total += cost[i]![result[i]!]!;
    expect(total).toBe(3);
  });
});
