import { describe, it, expect } from 'vitest';
import UTIF from 'utif';
import { writeTiffStackRgb, writeTiffStack16 } from '../src/core/io/tiff';
import type { Stack3D } from '../src/core/types';

describe('tiff bytes are decodeable by UTIF (independent reader)', () => {
  it('writeTiffStackRgb output decodes correctly with UTIF', () => {
    const T = 2,
      H = 3,
      W = 4;
    const stack: Stack3D = {
      data: new Float32Array(T * H * W * 3),
      shape: [T, H, W * 3],
    };
    for (let i = 0; i < stack.data.length; i++) stack.data[i] = i % 256;

    const tiff = writeTiffStackRgb(stack);
    const ifds = UTIF.decode(tiff.slice().buffer);
    expect(ifds.length).toBe(T);
    UTIF.decodeImage(tiff.slice().buffer, ifds[0]!);

    expect(ifds[0]!.width).toBe(W);
    expect(ifds[0]!.height).toBe(H);
    const t258 = (ifds[0] as unknown as { t258?: number[] }).t258;
    expect(t258).toEqual([8, 8, 8]);
    const t277 = (ifds[0] as unknown as { t277?: number[] }).t277;
    expect(t277).toEqual([3]);
    const t262 = (ifds[0] as unknown as { t262?: number[] }).t262;
    expect(t262).toEqual([2]);

    const expected = Array.from({ length: H * W * 3 }, (_, i) => i % 256);
    const actual = Array.from(ifds[0]!.data!);
    expect(actual).toEqual(expected);
  });

  it('writeTiffStack16 output decodes correctly with UTIF', () => {
    const T = 2,
      H = 3,
      W = 4;
    const stack: Stack3D = { data: new Float32Array(T * H * W), shape: [T, H, W] };
    for (let i = 0; i < stack.data.length; i++) stack.data[i] = (i * 251) % 65536;

    const tiff = writeTiffStack16(stack);
    const ifds = UTIF.decode(tiff.slice().buffer);
    expect(ifds.length).toBe(T);
    UTIF.decodeImage(tiff.slice().buffer, ifds[0]!);

    expect(ifds[0]!.width).toBe(W);
    expect(ifds[0]!.height).toBe(H);
    const t258 = (ifds[0] as unknown as { t258?: number[] }).t258;
    expect(t258).toEqual([16]);
    const t277 = (ifds[0] as unknown as { t277?: number[] }).t277;
    expect(t277).toEqual([1]);

    // Decoded data should match the source values (interpreted as Uint16 LE).
    const u16 = new Uint16Array(
      ifds[0]!.data!.buffer,
      ifds[0]!.data!.byteOffset,
      ifds[0]!.data!.byteLength / 2
    );
    for (let i = 0; i < H * W; i++) {
      expect(u16[i]).toBe(stack.data[i]! & 0xffff);
    }
  });
});
