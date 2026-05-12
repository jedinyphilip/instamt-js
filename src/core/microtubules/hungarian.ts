/**
 * Hungarian / Jonker-Volgenant algorithm for rectangular assignment.
 *
 * Given an n × m cost matrix, find a matching of rows to columns that
 * minimises total cost. Returns an array of length n where element i
 * is the column index matched to row i, or -1 if unmatched.
 *
 * Implementation is the standard O(n³) JV-style algorithm operating
 * on a square cost matrix; rectangular inputs are padded internally.
 */
export function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  if (n === 0) return [];
  const m = cost[0]!.length;
  if (m === 0) return new Array(n).fill(-1);

  // Pad to square by adding rows or columns of zeros so unmatched
  // entries in the smaller dimension cost nothing.
  const N = Math.max(n, m);
  const c: number[][] = [];
  for (let i = 0; i < N; i++) {
    const row: number[] = [];
    for (let j = 0; j < N; j++) {
      row.push(i < n && j < m ? cost[i]![j]! : 0);
    }
    c.push(row);
  }

  const u = new Array<number>(N + 1).fill(0);
  const v = new Array<number>(N + 1).fill(0);
  const p = new Array<number>(N + 1).fill(0);
  const way = new Array<number>(N + 1).fill(0);

  for (let i = 1; i <= N; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(N + 1).fill(Infinity);
    const used = new Array<boolean>(N + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = -1;
      for (let j = 1; j <= N; j++) {
        if (used[j]) continue;
        const cur = c[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= N; j++) {
        if (used[j]) {
          u[p[j]!] = u[p[j]!]! + delta;
          v[j] = v[j]! - delta;
        } else {
          minv[j] = minv[j]! - delta;
        }
      }
      j0 = j1;
    } while (p[j0]! !== 0);

    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0);
  }

  const ans = new Array<number>(n).fill(-1);
  for (let j = 1; j <= N; j++) {
    const row = p[j]!;
    if (row > 0 && row <= n && j - 1 < m) ans[row - 1] = j - 1;
  }
  return ans;
}
