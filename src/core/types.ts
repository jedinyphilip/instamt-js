/**
 * Shared types for the pipeline. Stack3D is a (T, H, W) row-major
 * Float32 array. Uint16 input gets converted on load so we don't
 * keep promoting back and forth.
 */

export type Shape3D = readonly [t: number, h: number, w: number];
export type Shape2D = readonly [h: number, w: number];

export interface Stack3D {
  /** Length T*H*W. Index by t*H*W + y*W + x. */
  readonly data: Float32Array;
  readonly shape: Shape3D;
  /** Optional per-channel label so multi-channel stacks survive. */
  readonly label?: string;
}

export interface Image2D {
  readonly data: Float32Array;
  readonly shape: Shape2D;
}

export function frameView(stack: Stack3D, t: number): Image2D {
  const [, h, w] = stack.shape;
  const stride = h * w;
  return {
    data: stack.data.subarray(t * stride, (t + 1) * stride),
    shape: [h, w] as const,
  };
}

export function emptyStack(shape: Shape3D, label?: string): Stack3D {
  const [t, h, w] = shape;
  return label !== undefined
    ? { data: new Float32Array(t * h * w), shape, label }
    : { data: new Float32Array(t * h * w), shape };
}

/**
 * Same as `emptyStack` but the underlying buffer is a
 * `SharedArrayBuffer`. Used for stacks that need to be read by worker
 * threads concurrently (e.g. parallel kymograph extraction) without
 * paying for a per-job copy.
 *
 * Falls back to a regular ArrayBuffer if `SharedArrayBuffer` is not
 * available (e.g. when COOP/COEP headers haven't been set on the
 * hosting page); behaviour is identical, just no cross-thread sharing.
 */
export function emptyStackShared(shape: Shape3D, label?: string): Stack3D {
  const [t, h, w] = shape;
  const bytes = t * h * w * 4;
  const buf =
    typeof SharedArrayBuffer !== 'undefined'
      ? new SharedArrayBuffer(bytes)
      : new ArrayBuffer(bytes);
  const data = new Float32Array(buf);
  return label !== undefined ? { data, shape, label } : { data, shape };
}

export function emptyImage(shape: Shape2D): Image2D {
  const [h, w] = shape;
  return { data: new Float32Array(h * w), shape };
}
