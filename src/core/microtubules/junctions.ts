import { endpointTangent, type Arc } from './arc';

/**
 * Junction discovery, arc-end-to-junction incidence, and pairing.
 */

export interface Junction {
  id: number;
  /** Centre of the merged branch-point cluster. */
  cy: number;
  cx: number;
  /** Pixel positions making up the cluster (flat: y0, x0, y1, x1, ...). */
  pixels: Int32Array;
}

/**
 * Cluster branch-point pixels by 8-connectivity, then merge clusters
 * whose pixel sets come within `mergeRadius` of each other.
 */
export function findJunctions(
  branchPixels: Uint8Array,
  w: number,
  h: number,
  mergeRadius: number
): Junction[] {
  // Phase 1: 8-connected components labelling.
  const labels = new Int32Array(branchPixels.length);
  const clusters: number[][] = [[]]; // index 0 unused
  const stack = new Int32Array(branchPixels.length);
  for (let seed = 0; seed < branchPixels.length; seed++) {
    if (!branchPixels[seed] || labels[seed]) continue;
    const id = clusters.length;
    const cluster: number[] = [];
    let top = 0;
    stack[top++] = seed;
    labels[seed] = id;
    while (top > 0) {
      const idx = stack[--top]!;
      cluster.push(idx);
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
          if (branchPixels[j] && !labels[j]) {
            labels[j] = id;
            stack[top++] = j;
          }
        }
      }
    }
    clusters.push(cluster);
  }

  // Phase 2: union-find merge of clusters whose pixel sets come within
  // mergeRadius of each other. Skipping the all-pairs distance is fine
  // here because we expect ≤ a few dozen clusters per frame.
  const parent = new Int32Array(clusters.length);
  for (let i = 0; i < clusters.length; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const unite = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const r2 = mergeRadius * mergeRadius;
  for (let i = 1; i < clusters.length; i++) {
    const ci = clusters[i]!;
    for (let j = i + 1; j < clusters.length; j++) {
      if (find(i) === find(j)) continue;
      const cj = clusters[j]!;
      let close = false;
      outer: for (const a of ci) {
        const ya = (a / w) | 0;
        const xa = a - ya * w;
        for (const b of cj) {
          const yb = (b / w) | 0;
          const xb = b - yb * w;
          const dy = ya - yb;
          const dx = xa - xb;
          if (dy * dy + dx * dx <= r2) {
            close = true;
            break outer;
          }
        }
      }
      if (close) unite(i, j);
    }
  }

  // Phase 3: emit one Junction per super-cluster.
  const groups = new Map<number, number[]>();
  for (let i = 1; i < clusters.length; i++) {
    const r = find(i);
    const acc = groups.get(r) ?? [];
    acc.push(...clusters[i]!);
    groups.set(r, acc);
  }
  const out: Junction[] = [];
  let id = 0;
  for (const pixels of groups.values()) {
    let sy = 0;
    let sx = 0;
    const arr = new Int32Array(pixels.length * 2);
    for (let k = 0; k < pixels.length; k++) {
      const idx = pixels[k]!;
      const y = (idx / w) | 0;
      const x = idx - y * w;
      arr[2 * k] = y;
      arr[2 * k + 1] = x;
      sy += y;
      sx += x;
    }
    out.push({
      id: id++,
      cy: sy / pixels.length,
      cx: sx / pixels.length,
      pixels: arr,
    });
  }
  return out;
}

/** Per-arc-end junction incidence (within `maxGap` of any junction pixel). */
export interface Incidence {
  arcIdx: number;
  end: 0 | 1;
  jid: number;
  ty: number;
  tx: number;
}

export function findIncidences(
  arcs: Arc[],
  junctions: Junction[],
  maxGap: number
): { incidents: Map<number, Incidence[]>; arcEnds: number[][]; bridgeArcs: Set<number> } {
  const incidents = new Map<number, Incidence[]>();
  const arcEnds: number[][] = arcs.map(() => []);
  const r2 = maxGap * maxGap;

  for (let ai = 0; ai < arcs.length; ai++) {
    const arc = arcs[ai]!;
    if (arc.length < 4) continue;
    const ends: Array<{ y: number; x: number; e: 0 | 1 }> = [
      { y: arc[0]!, x: arc[1]!, e: 0 },
      { y: arc[arc.length - 2]!, x: arc[arc.length - 1]!, e: 1 },
    ];
    for (const ep of ends) {
      let bestJid = -1;
      let bestDist = Infinity;
      for (const j of junctions) {
        for (let p = 0; p < j.pixels.length; p += 2) {
          const dy = ep.y - j.pixels[p]!;
          const dx = ep.x - j.pixels[p + 1]!;
          const d2 = dy * dy + dx * dx;
          if (d2 < bestDist) {
            bestDist = d2;
            bestJid = j.id;
          }
        }
      }
      if (bestJid >= 0 && bestDist <= r2) {
        arcEnds[ai]!.push(bestJid);
        const t = endpointTangent(arc, ep.e);
        const list = incidents.get(bestJid) ?? [];
        list.push({ arcIdx: ai, end: ep.e, jid: bestJid, ty: t.ty, tx: t.tx });
        incidents.set(bestJid, list);
      }
    }
  }

  // An arc whose two ends both touch the same merged junction is a
  // "bridge" through a fattened crossing; absorb into the junction
  // rather than pair through it.
  const bridgeArcs = new Set<number>();
  for (let ai = 0; ai < arcs.length; ai++) {
    const ends = arcEnds[ai]!;
    if (ends.length === 2 && ends[0] === ends[1]) bridgeArcs.add(ai);
  }
  return { incidents, arcEnds, bridgeArcs };
}

/**
 * Pick the best disjoint pairing among `items` (incidences at one
 * junction). Threshold scales with junction size:
 *   - 2 arcs (T-junction): strict threshold (default -0.7)
 *   - 3 arcs (Y-junction): base threshold (default -0.5)
 *   - 4+ arcs (likely X): looser, max(base + 0.2, -0.3)
 */
export function bestPairing(items: Incidence[], maxPairCost: number): Array<[number, number]> {
  const n = items.length;
  if (n < 2) return [];

  // Pairwise tangent dot products.
  const cost: number[][] = [];
  for (let i = 0; i < n; i++) {
    cost.push(new Array(n).fill(0));
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const c = items[i]!.ty * items[j]!.ty + items[i]!.tx * items[j]!.tx;
      cost[i]![j] = c;
      cost[j]![i] = c;
    }
  }

  // Context-aware threshold: the more arcs meet at a junction, the
  // more permissive the pairing — X-crossings benefit from looser
  // constraints than T-junctions.
  //   n ≥ 4 (X):  cost_thresh = max(maxPairCost + 0.2, -0.3)
  //   n == 3 (Y): cost_thresh = maxPairCost
  //   n == 2 (T): cost_thresh = min(maxPairCost - 0.2, -0.7)
  let thresh: number;
  if (n >= 4) thresh = Math.max(maxPairCost + 0.2, -0.3);
  else if (n === 3) thresh = maxPairCost;
  else thresh = Math.min(maxPairCost - 0.2, -0.7);

  if (n === 2) {
    return cost[0]![1]! <= thresh ? [[0, 1]] : [];
  }
  if (n === 3) {
    const candidates: Array<[number, number]> = [
      [0, 1],
      [0, 2],
      [1, 2],
    ];
    let best: [number, number] | null = null;
    let bestC = Infinity;
    for (const [a, b] of candidates) {
      const c = cost[a]![b]!;
      if (c < bestC) {
        bestC = c;
        best = [a, b];
      }
    }
    return best && bestC <= thresh ? [best] : [];
  }
  if (n === 4) {
    const partitions: Array<Array<[number, number]>> = [
      [
        [0, 1],
        [2, 3],
      ],
      [
        [0, 2],
        [1, 3],
      ],
      [
        [0, 3],
        [1, 2],
      ],
    ];
    let bestPart = partitions[0]!;
    let bestSum = Infinity;
    for (const part of partitions) {
      const s = cost[part[0]![0]]![part[0]![1]]! + cost[part[1]![0]]![part[1]![1]]!;
      if (s < bestSum) {
        bestSum = s;
        bestPart = part;
      }
    }
    return bestPart.filter(([a, b]) => cost[a]![b]! <= thresh);
  }
  // n ≥ 5: greedy on sorted pairwise cost. Rare in practice.
  const flat: Array<[number, number, number]> = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) flat.push([cost[i]![j]!, i, j]);
  }
  flat.sort((a, b) => a[0] - b[0]);
  const used = new Set<number>();
  const out: Array<[number, number]> = [];
  for (const [c, i, j] of flat) {
    if (c > thresh) break;
    if (used.has(i) || used.has(j)) continue;
    used.add(i);
    used.add(j);
    out.push([i, j]);
  }
  return out;
}

/**
 * Assemble arcs into filaments by walking through the junction graph.
 * Each pair (arcIdx, end) → (otherArcIdx, otherEnd, jid) tells us where
 * to continue when we exit the arc through a particular endpoint.
 */
export function buildFilaments(
  arcs: Arc[],
  partners: Map<string, { arcIdx: number; end: 0 | 1; jid: number }>,
  junctionCenters: Map<number, { y: number; x: number }>
): Arc[] {
  const visited = new Set<number>();
  const filaments: Arc[] = [];
  const key = (ai: number, e: 0 | 1): string => `${ai}:${e}`;

  const walk = (startArc: number, startEnd: 0 | 1): Arc => {
    const pieces: number[] = [];
    let curArc = startArc;
    let curEnd = startEnd;
    while (!visited.has(curArc)) {
      visited.add(curArc);
      const arc = arcs[curArc]!;
      if (curEnd === 0) {
        for (let i = 0; i < arc.length; i++) pieces.push(arc[i]!);
      } else {
        for (let i = arc.length - 2; i >= 0; i -= 2) {
          pieces.push(arc[i]!, arc[i + 1]!);
        }
      }
      const exitEnd: 0 | 1 = curEnd === 0 ? 1 : 0;
      const next = partners.get(key(curArc, exitEnd));
      if (!next) break;
      const ctr = junctionCenters.get(next.jid);
      if (ctr) pieces.push(ctr.y, ctr.x);
      curArc = next.arcIdx;
      curEnd = next.end;
    }
    return new Float32Array(pieces);
  };

  // Start from arcs with a free end (degree-1 within the partner graph).
  for (let ai = 0; ai < arcs.length; ai++) {
    if (visited.has(ai)) continue;
    const has0 = partners.has(key(ai, 0));
    const has1 = partners.has(key(ai, 1));
    if (!has0) {
      filaments.push(walk(ai, 0));
    } else if (!has1) {
      filaments.push(walk(ai, 1));
    }
  }
  // Cycles (no free ends) — start arbitrarily.
  for (let ai = 0; ai < arcs.length; ai++) {
    if (!visited.has(ai)) filaments.push(walk(ai, 0));
  }
  return filaments;
}
