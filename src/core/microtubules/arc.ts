/**
 * Arc representation: a Float32Array of [y0, x0, y1, x1, ...] pairs.
 * That's the same byte layout as a Float32Array(pts*2) and lets us use
 * subarray() cheaply when slicing arcs.
 */

export type Arc = Float32Array;

export function arcLength(arc: Arc): number {
  let s = 0;
  for (let i = 2; i < arc.length; i += 2) {
    const dy = arc[i]! - arc[i - 2]!;
    const dx = arc[i + 1]! - arc[i - 1]!;
    s += Math.hypot(dy, dx);
  }
  return s;
}

export function arcChord(arc: Arc): number {
  if (arc.length < 4) return 0;
  const dy = arc[arc.length - 2]! - arc[0]!;
  const dx = arc[arc.length - 1]! - arc[1]!;
  return Math.hypot(dy, dx);
}

export function arcCenter(arc: Arc): { y: number; x: number } {
  let sy = 0;
  let sx = 0;
  const n = arc.length / 2;
  for (let i = 0; i < arc.length; i += 2) {
    sy += arc[i]!;
    sx += arc[i + 1]!;
  }
  return { y: sy / n, x: sx / n };
}

/**
 * Reverse an arc in place (swap endpoint orientation).
 */
export function reverseArc(arc: Arc): Arc {
  const out = new Float32Array(arc.length);
  const n = arc.length / 2;
  for (let i = 0; i < n; i++) {
    out[i * 2] = arc[(n - 1 - i) * 2]!;
    out[i * 2 + 1] = arc[(n - 1 - i) * 2 + 1]!;
  }
  return out;
}

/**
 * Outward unit tangent at an arc endpoint, computed as the principal
 * eigenvector of the last `nPts` vertices (i.e. the slope of a
 * least-squares line through them), signed centroid → endpoint.
 *
 * The 2-point chord this replaces was sensitive to a single-pixel
 * snap at the tip — enough to flip a tangent by 30°+ between frames
 * and tank the anti-parallel test in lineage merging.
 */
export function endpointTangent(arc: Arc, end: 0 | 1, nPts = 8): { ty: number; tx: number } {
  const n = arc.length / 2;
  if (n < 2) return { ty: 0, tx: 0 };
  let i0: number;
  let i1: number;
  if (end === 0) {
    i0 = 0;
    i1 = Math.min(nPts, n - 1);
  } else {
    i0 = Math.max(0, n - 1 - nPts);
    i1 = n - 1;
  }
  const len = i1 - i0 + 1;
  if (len < 2) return { ty: 0, tx: 0 };

  // Centroid.
  let cy = 0;
  let cx = 0;
  for (let k = i0; k <= i1; k++) {
    cy += arc[k * 2]!;
    cx += arc[k * 2 + 1]!;
  }
  cy /= len;
  cx /= len;

  // 2×2 covariance: [[syy, syx], [syx, sxx]].
  let syy = 0;
  let sxx = 0;
  let syx = 0;
  for (let k = i0; k <= i1; k++) {
    const dy = arc[k * 2]! - cy;
    const dx = arc[k * 2 + 1]! - cx;
    syy += dy * dy;
    sxx += dx * dx;
    syx += dy * dx;
  }
  // Larger eigenvalue λ = (tr + √(tr² − 4 det)) / 2; eigenvector
  // proportional to (syx, λ − syy) when the off-diagonal is non-zero.
  const tr = syy + sxx;
  const det = syy * sxx - syx * syx;
  const disc = Math.max(0, tr * tr * 0.25 - det);
  const lam = tr * 0.5 + Math.sqrt(disc);
  let vy: number;
  let vx: number;
  if (Math.abs(syx) > 1e-9) {
    vy = syx;
    vx = lam - syy;
  } else if (syy >= sxx) {
    vy = 1;
    vx = 0;
  } else {
    vy = 0;
    vx = 1;
  }
  const nrm = Math.hypot(vy, vx);
  if (nrm < 1e-9) {
    // Degenerate (all points collapse). Fall back to the 2-point chord.
    const endIdx = end === 0 ? i0 : i1;
    const farIdx = end === 0 ? i1 : i0;
    const dy = arc[endIdx * 2]! - arc[farIdx * 2]!;
    const dx = arc[endIdx * 2 + 1]! - arc[farIdx * 2 + 1]!;
    const m = Math.hypot(dy, dx);
    return m < 1e-9 ? { ty: 0, tx: 0 } : { ty: dy / m, tx: dx / m };
  }
  vy /= nrm;
  vx /= nrm;
  // Sign: outward from centroid toward the endpoint vertex.
  const endIdx = end === 0 ? i0 : i1;
  const dirY = arc[endIdx * 2]! - cy;
  const dirX = arc[endIdx * 2 + 1]! - cx;
  if (vy * dirY + vx * dirX < 0) {
    vy = -vy;
    vx = -vx;
  }
  return { ty: vy, tx: vx };
}
