import type { Arc } from './arc';

/**
 * Walk the connected components of `mask` and return one ordered arc
 * per component. The mask should already have branch pixels removed
 * so the skeleton is split at junctions.
 *
 * Ordering: start at an endpoint (one same-component neighbour) if any
 * exist, else any pixel for a closed loop. Walk preferring 4-connected
 * neighbours over diagonals.
 */
export function walkArcs(skel: Uint8Array, w: number, h: number, minLen: number): Arc[] {
  const visited = new Uint8Array(skel.length);
  const stack = new Int32Array(skel.length);
  const arcs: Arc[] = [];

  for (let seed = 0; seed < skel.length; seed++) {
    if (!skel[seed] || visited[seed]) continue;

    // Flood-fill the connected component starting at `seed`.
    const component: number[] = [];
    let top = 0;
    stack[top++] = seed;
    visited[seed] = 1;
    while (top > 0) {
      const idx = stack[--top]!;
      component.push(idx);
      const y = (idx / w) | 0;
      const x = idx - y * w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (skel[j] && !visited[j]) {
            visited[j] = 1;
            stack[top++] = j;
          }
        }
      }
    }
    if (component.length < minLen) continue;

    // Pick a start: an endpoint (degree 1 within the component) if any.
    const inComp = new Uint8Array(skel.length);
    for (const idx of component) inComp[idx] = 1;

    let start = component[0]!;
    for (const idx of component) {
      if (degree(idx, inComp, w, h) === 1) {
        start = idx;
        break;
      }
    }

    // Walk from `start`, preferring 4-connected neighbours.
    const ordered: number[] = [];
    const walked = new Uint8Array(skel.length);
    let cur = start;
    for (;;) {
      ordered.push(cur);
      walked[cur] = 1;
      const y = (cur / w) | 0;
      const x = cur - y * w;
      let nextIdx = -1;
      let nextManhattan = 99;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (!inComp[j] || walked[j]) continue;
          const m = Math.abs(dy) + Math.abs(dx);
          if (m < nextManhattan) {
            nextManhattan = m;
            nextIdx = j;
          }
        }
      }
      if (nextIdx < 0) break;
      cur = nextIdx;
    }
    if (ordered.length < minLen) continue;

    const arc = new Float32Array(ordered.length * 2);
    for (let k = 0; k < ordered.length; k++) {
      const idx = ordered[k]!;
      const y = (idx / w) | 0;
      arc[k * 2] = y;
      arc[k * 2 + 1] = idx - y * w;
    }
    arcs.push(arc);
  }
  return arcs;
}

function degree(idx: number, mask: Uint8Array, w: number, h: number): number {
  const y = (idx / w) | 0;
  const x = idx - y * w;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= h) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const xx = x + dx;
      if (xx < 0 || xx >= w) continue;
      if (mask[yy * w + xx]) n++;
    }
  }
  return n;
}
