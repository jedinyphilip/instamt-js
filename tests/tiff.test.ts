import { describe, it, expect } from 'vitest';
import {
  parseImageJDescription,
  parseScales,
  readTiffStack,
  writeTiffStack16,
  writeTiffStackRgb,
} from '../src/core/io/tiff';
import type { Stack3D } from '../src/core/types';

function makeBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes.slice().buffer], { type: 'image/tiff' });
}

describe('tiff round-trip', () => {
  it('encodes and decodes a multi-page 16-bit grayscale stack', async () => {
    const T = 3,
      H = 5,
      W = 4;
    const stack: Stack3D = { data: new Float32Array(T * H * W), shape: [T, H, W] };
    for (let i = 0; i < stack.data.length; i++) stack.data[i] = (i * 257) % 65536;

    const tiff = writeTiffStack16(stack);
    const { channels, bitsPerSample } = await readTiffStack(makeBlob(tiff));

    expect(bitsPerSample).toBe(16);
    expect(channels).toHaveLength(1);
    const decoded = channels[0]!;
    expect(decoded.shape).toEqual([T, H, W]);
    for (let i = 0; i < stack.data.length; i++) {
      expect(decoded.data[i]).toBe(stack.data[i]);
    }
  });

  it('parses ImageJ hyperstack ImageDescription text', () => {
    const fiji =
      'ImageJ=1.53k\nimages=164\nchannels=2\nslices=1\nframes=82\nhyperstack=true\nmode=composite\nloop=false\n';
    expect(parseImageJDescription(fiji)).toEqual({
      channels: 2,
      slices: 1,
      frames: 82,
      hyperstack: true,
      mode: 'composite',
    });
    expect(parseImageJDescription('Some other software v1.0')).toBeNull();
    expect(parseImageJDescription(undefined)).toBeNull();
    expect(
      parseImageJDescription('ImageJ=1.53\nchannels=2\nframes=10\nhyperstack=false\n')
    ).toEqual({ channels: 2, slices: 1, frames: 10, hyperstack: false, mode: null });
  });

  it('parses SCIFIO and ImageJ pixel/time scales', () => {
    const scifio =
      'SCIFIO=0.46.0 | axes=X,Y,Channel,Time | lengths=1024,1022,2,164 | scales=0.06536893,0.06536893,1.0,0.99147772 | units=micron,micron,null,sec | bitsPerPixel=16';
    expect(parseScales(scifio)).toEqual({
      umPerPx: 0.06536893,
      secondsPerFrame: 0.99147772,
    });

    const imageJ = 'ImageJ=1.53\nunit=micron\nspacing=0.107\nfinterval=0.05\n';
    expect(parseScales(imageJ)).toEqual({ umPerPx: 0.107, secondsPerFrame: 0.05 });

    expect(parseScales(undefined)).toEqual({});
    // Unknown unit isn't trusted as microns.
    expect(parseScales('axes=X,Y | scales=0.5,0.5 | units=pixel,pixel')).toEqual({});
  });

  it('decodes PlanarConfiguration=2 correctly (UTIF cannot)', async () => {
    // Build a synthetic LE TIFF with 1 page, 2 channels, 16-bit, planar=2.
    // ch0 has all values = 100, ch1 has all values = 200. After the read,
    // channels[0].data should be uniformly 100 and channels[1].data 200.
    const W = 4,
      H = 3;
    const headerSize = 8;
    const numTags = 11;
    const ifdSize = 2 + 12 * numTags + 4;
    // Out-of-line: t273 (StripOffsets = 2 LONGs) = 8 bytes; t279 (StripByteCounts = 2 LONGs) = 8 bytes.
    // BitsPerSample fits inline (2 SHORTs = 4 bytes).
    const oolSize = 8 + 8;
    const stripBytes = H * W * 2; // bytes for one channel of one strip
    const ifdOffset = headerSize;
    const oolBase = ifdOffset + ifdSize;
    const ch0Offset = oolBase + oolSize;
    const ch1Offset = ch0Offset + stripBytes;
    const total = ch1Offset + stripBytes;

    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    // Header: II + magic(42) + IFD offset.
    view.setUint16(0, 0x4949, true);
    view.setUint16(2, 42, true);
    view.setUint32(4, ifdOffset, true);

    // Helper to write IFD entries.
    let off = ifdOffset;
    view.setUint16(off, numTags, true);
    off += 2;
    let oolCursor = oolBase;
    const writeTag = (
      tag: number,
      type: 1 | 3 | 4,
      count: number,
      payload: number[],
      forceOutOfLine = false
    ): void => {
      view.setUint16(off, tag, true);
      view.setUint16(off + 2, type, true);
      view.setUint32(off + 4, count, true);
      const elem = type === 1 ? 1 : type === 3 ? 2 : 4;
      const sz = elem * count;
      if (sz <= 4 && !forceOutOfLine) {
        view.setUint32(off + 8, 0, true);
        for (let i = 0; i < count; i++) {
          if (type === 3) view.setUint16(off + 8 + i * 2, payload[i]!, true);
          else if (type === 4) view.setUint32(off + 8 + i * 4, payload[i]!, true);
          else out[off + 8 + i] = payload[i]! & 0xff;
        }
      } else {
        view.setUint32(off + 8, oolCursor, true);
        for (let i = 0; i < count; i++) {
          if (type === 3) view.setUint16(oolCursor + i * 2, payload[i]!, true);
          else if (type === 4) view.setUint32(oolCursor + i * 4, payload[i]!, true);
          else out[oolCursor + i] = payload[i]! & 0xff;
        }
        oolCursor += sz + (sz & 1);
      }
      off += 12;
    };

    // Tags must be sorted by tag number.
    writeTag(256, 4, 1, [W]); // ImageWidth
    writeTag(257, 4, 1, [H]); // ImageLength
    writeTag(258, 3, 2, [16, 16]); // BitsPerSample (inline, fits in 4 bytes)
    writeTag(259, 3, 1, [1]); // Compression
    writeTag(262, 3, 1, [1]); // Photometric
    writeTag(273, 4, 2, [ch0Offset, ch1Offset]); // StripOffsets — 2 LONGs go OOL
    writeTag(277, 3, 1, [2]); // SamplesPerPixel
    writeTag(278, 4, 1, [H]); // RowsPerStrip
    writeTag(279, 4, 2, [stripBytes, stripBytes]); // StripByteCounts
    writeTag(284, 3, 1, [2]); // PlanarConfiguration = planar
    writeTag(338, 3, 1, [0]); // ExtraSamples (unspecified) so spp=2 doesn't trip alpha logic

    // Next IFD = 0 (last page).
    view.setUint32(off, 0, true);

    // Channel data.
    for (let i = 0; i < H * W; i++) view.setUint16(ch0Offset + i * 2, 100, true);
    for (let i = 0; i < H * W; i++) view.setUint16(ch1Offset + i * 2, 200, true);

    const { channels, diagnostics } = await readTiffStack(makeBlob(out));
    expect(diagnostics.planarConfig).toBe(2);
    expect(channels).toHaveLength(2);
    expect(channels[0]!.data.every((v) => v === 100)).toBe(true);
    expect(channels[1]!.data.every((v) => v === 200)).toBe(true);
  });

  it('encodes and decodes a multi-page 8-bit RGB stack', async () => {
    const T = 2,
      H = 3,
      W = 4;
    const stack: Stack3D = {
      data: new Float32Array(T * H * W * 3),
      shape: [T, H, W * 3],
    };
    for (let i = 0; i < stack.data.length; i++) stack.data[i] = i % 256;

    const tiff = writeTiffStackRgb(stack);
    const { channels, bitsPerSample } = await readTiffStack(makeBlob(tiff));

    expect(bitsPerSample).toBe(8);
    expect(channels).toHaveLength(3);
    for (const ch of channels) expect(ch.shape).toEqual([T, H, W]);

    const ch0 = channels[0]!.data;
    for (let i = 0; i < T * H * W; i++) {
      expect(ch0[i]).toBe(stack.data[i * 3]);
    }
  });
});
