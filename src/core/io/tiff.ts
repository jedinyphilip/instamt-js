import UTIF from 'utif';
import type { Stack3D, Shape3D } from '../types';

export interface TiffReadResult {
  /** Per-channel Float32 stacks, length ≥ 1. Each has shape [T, H, W]. */
  channels: Stack3D[];
  /** Bit depth of the source (8 or 16). */
  bitsPerSample: number;
  /** Parsed ImageJ hyperstack metadata, when present. */
  imagej?: { channels: number; slices: number; frames: number };
  /** Pixel size in micrometres if the source TIFF declared it (SCIFIO
   *  scales tag, OME, or ImageJ unit/spacing). Same value for X and Y
   *  is assumed; non-square pixels are not handled. */
  umPerPx?: number;
  /** Frame interval in seconds, when declared in the source. */
  secondsPerFrame?: number;
  /** Diagnostics for the UI log. */
  diagnostics: {
    pageCount: number;
    samplesPerPixel: number;
    width: number;
    height: number;
    bitsPerSample: number;
    /** PlanarConfiguration: 1 = chunky, 2 = planar. */
    planarConfig: number;
    /** Whether `t284` was present in the IFD. */
    planarConfigPresent: boolean;
    /** First 200 chars of ImageDescription if any (truncated for display). */
    imageDescriptionExcerpt: string | null;
    /** Whether the channel split was driven by ImageJ metadata vs. a forced override vs. samplesPerPixel only. */
    channelSource: 'imagej' | 'override' | 'samples-only';
    /** Per-channel min/mean/max of the first frame, for sanity-checking reads. */
    firstFrameStats: Array<{ min: number; mean: number; max: number }>;
  };
}

interface ScaleMeta {
  umPerPx?: number;
  secondsPerFrame?: number;
}

/**
 * Parse pixel/time scales from SCIFIO and ImageJ-style ImageDescription
 * blobs. SCIFIO writes:
 *   axes=X,Y,Channel,Time | lengths=W,H,C,T | scales=sx,sy,sc,st |
 *   units=micron,micron,null,sec
 * ImageJ writes a flatter form: `unit=micron\nspacing=...\nfinterval=...\n`.
 */
export function parseScales(s: string | undefined): ScaleMeta {
  if (!s) return {};
  const out: ScaleMeta = {};

  // SCIFIO style: axes/lengths/scales/units lists separated by '|' or '\n'.
  const axesM = s.match(/axes=([^\n|]+)/);
  const scalesM = s.match(/scales=([^\n|]+)/);
  const unitsM = s.match(/units=([^\n|]+)/);
  if (axesM && scalesM) {
    const axes = axesM[1]!.split(',').map((x) => x.trim().toLowerCase());
    const scales = scalesM[1]!.split(',').map((x) => Number(x));
    const units = unitsM ? unitsM[1]!.split(',').map((x) => x.trim().toLowerCase()) : [];
    const xIdx = axes.indexOf('x');
    const yIdx = axes.indexOf('y');
    const tIdx = axes.indexOf('time');
    if (xIdx >= 0 && Number.isFinite(scales[xIdx])) {
      const xUnit = units[xIdx] ?? 'micron';
      if (xUnit === 'micron' || xUnit === 'um' || xUnit === 'µm') {
        // If Y scale also matches, take the X value; otherwise still use X.
        const sx = scales[xIdx]!;
        if (yIdx < 0 || Math.abs((scales[yIdx]! - sx) / sx) < 1e-3) {
          out.umPerPx = sx;
        } else {
          out.umPerPx = sx; // X-only — non-square pixels aren't handled downstream
        }
      }
    }
    if (tIdx >= 0 && Number.isFinite(scales[tIdx])) {
      const tUnit = units[tIdx] ?? 'sec';
      if (tUnit === 'sec' || tUnit === 's' || tUnit === 'second') {
        out.secondsPerFrame = scales[tIdx]!;
      }
    }
  }

  // ImageJ flat form fallback.
  if (out.umPerPx == null) {
    const unitM = s.match(/(?:^|\n)unit=([^\n]+)/);
    const spacingM = s.match(/(?:^|\n)spacing=([\d.eE+-]+)/);
    if (unitM && spacingM) {
      const u = unitM[1]!.trim().toLowerCase();
      if (u === 'micron' || u === 'um' || u === 'µm') {
        out.umPerPx = Number(spacingM[1]);
      }
    }
  }
  if (out.secondsPerFrame == null) {
    const fintM = s.match(/(?:^|\n)finterval=([\d.eE+-]+)/);
    if (fintM) out.secondsPerFrame = Number(fintM[1]);
  }

  return out;
}

export interface TiffReadOptions {
  /**
   * When set, overrides any auto-detected channel count from ImageJ
   * metadata. Useful when Fiji exported a TIFF without the
   * ImageDescription tag — in which case we can't tell from the bytes
   * alone whether 164 pages is "164 time frames" or "2 channels × 82
   * frames". Pages are split with the same C,Z,T ordering as Fiji.
   */
  forceChannels?: number;
}

interface ImageJMeta {
  channels: number;
  slices: number;
  frames: number;
  hyperstack: boolean;
  /** ImageJ display mode: 'grayscale', 'color', 'composite'. */
  mode: string | null;
}

/**
 * Parse the `ImageDescription` tag (270) from an ImageJ/Fiji-saved TIFF.
 * Fiji writes a key=value text block like:
 *
 *   ImageJ=1.53k\nimages=164\nchannels=2\nslices=1\nframes=82\n
 *   hyperstack=true\nmode=composite\n...
 *
 * Without parsing this we'd treat the file as 164 time frames when it's
 * really a 2-channel × 82-frame hyperstack, which scrambles the
 * tracking input.
 */
export function parseImageJDescription(s: string | undefined): ImageJMeta | null {
  if (!s || !s.includes('ImageJ=')) return null;
  const get = (key: string): number | null => {
    const m = s.match(new RegExp(`(?:^|\\n)${key}=(\\d+)`));
    return m ? parseInt(m[1]!, 10) : null;
  };
  const modeMatch = s.match(/(?:^|\n)mode=([^\n|]+)/);
  return {
    channels: get('channels') ?? 1,
    slices: get('slices') ?? 1,
    frames: get('frames') ?? 1,
    hyperstack: /(?:^|\n)hyperstack=true/.test(s),
    mode: modeMatch ? modeMatch[1]!.trim() : null,
  };
}

function readImageDescription(ifd: import('utif').IFD): string | undefined {
  // UTIF parses ASCII (type 2) tags as either string or string-array
  // depending on count; handle both shapes.
  const raw = (ifd as unknown as { t270?: unknown }).t270;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0] as string;
  return undefined;
}

/**
 * Decode a multi-page TIFF into one Float32 stack per channel. Handles:
 *   - 8/16-bit grayscale or 2..4-sample multi-channel pages, in either
 *     chunky (PlanarConfiguration=1) or planar (=2) layout
 *   - ImageJ/Fiji hyperstacks where channels are stored as separate
 *     pages with the layout encoded in the ImageDescription tag.
 *
 * Returned channel order: per-page samples (R, G, B, ...) outer,
 * ImageJ channels inner. For the typical Fiji case (single-sample
 * grayscale pages, 2 channels, N frames) the result is
 * `channels = [ch0_TxHxW, ch1_TxHxW]`.
 */
/**
 * Read a planar (PlanarConfiguration=2) TIFF page directly from the
 * file buffer, bypassing UTIF — UTIF only honours chunky layout and
 * silently drops half the data when the file is planar. Returns the
 * raw bytes laid out as `[ch0_full][ch1_full]…`, matching what our
 * downstream planar-split reader expects.
 *
 * Only handles uncompressed strips (Compression=1). Byte order is
 * detected from the TIFF header; 16-bit BE values are byte-swapped to
 * machine-native LE so a Uint16Array view returns correct values.
 */
function readPlanarPageBytes(
  buf: ArrayBuffer,
  ifd: import('utif').IFD,
  H: number,
  W: number,
  spp: number,
  bps: number,
  isLE: boolean
): Uint8Array {
  const compression = (ifd.t259 as number[] | undefined)?.[0] ?? 1;
  if (compression !== 1) {
    throw new Error(
      `PlanarConfiguration=2 with Compression=${compression} not supported (only uncompressed)`
    );
  }
  const stripOffsets = ifd.t273 as number[] | undefined;
  const stripByteCounts = ifd.t279 as number[] | undefined;
  if (!stripOffsets || stripOffsets.length === 0) {
    throw new Error('Missing StripOffsets');
  }
  const rowsPerStrip = (ifd.t278 as number[] | undefined)?.[0] ?? H;
  const stripsPerChannel = Math.ceil(H / rowsPerStrip);
  if (stripOffsets.length !== stripsPerChannel * spp) {
    throw new Error(
      `Planar strip count mismatch: expected ${stripsPerChannel * spp} (${stripsPerChannel} strips × ${spp} samples), got ${stripOffsets.length}`
    );
  }

  const bytesPerSample = bps / 8;
  const channelSize = H * W * bytesPerSample;
  const out = new Uint8Array(spp * channelSize);

  for (let j = 0; j < stripOffsets.length; j++) {
    const sample = Math.floor(j / stripsPerChannel);
    const stripIdxInChannel = j % stripsPerChannel;
    const firstRow = stripIdxInChannel * rowsPerStrip;
    const rowsInStrip = Math.min(rowsPerStrip, H - firstRow);
    const expectedBytes = rowsInStrip * W * bytesPerSample;
    const stripBytes = stripByteCounts ? stripByteCounts[j]! : expectedBytes;
    if (stripBytes < expectedBytes) {
      throw new Error(
        `Strip ${j} truncated: ${stripBytes} bytes vs expected ${expectedBytes}`
      );
    }
    const src = new Uint8Array(buf, stripOffsets[j]!, expectedBytes);
    const dstOffset = sample * channelSize + firstRow * W * bytesPerSample;
    out.set(src, dstOffset);
  }

  // Byte-swap 16-bit big-endian values into native LE so a Uint16Array
  // view reads correct values on x86/arm.
  if (bps === 16 && !isLE) {
    for (let i = 0; i < out.length; i += 2) {
      const t = out[i]!;
      out[i] = out[i + 1]!;
      out[i + 1] = t;
    }
  }

  return out;
}

export async function readTiffStack(
  file: File | Blob,
  options: TiffReadOptions = {}
): Promise<TiffReadResult> {
  const buf = await file.arrayBuffer();
  const ifds = UTIF.decode(buf);
  if (ifds.length === 0) throw new Error('TIFF has no pages');

  const first = ifds[0]!;
  // Read width/height from the tags directly. UTIF.decode parses them
  // into t256/t257 but only mirrors to ifd.width/.height during
  // decodeImage — and we may bypass decodeImage for planar pages.
  const w = (first.t256 as number[])[0]!;
  const h = (first.t257 as number[])[0]!;
  const bps = (first.t258 as number[] | undefined)?.[0] ?? 8;
  const spp = (first.t277 as number[] | undefined)?.[0] ?? 1;
  const planar = (first.t284 as number[] | undefined)?.[0] ?? 1;

  // Detect file byte order. UTIF parses tags correctly either way, but
  // for planar pages we read raw strip bytes ourselves and need to
  // byte-swap when the file is big-endian.
  const headerView = new DataView(buf, 0, 2);
  const isLE = headerView.getUint8(0) === 0x49;

  if (planar === 2) {
    // Decode each page manually — UTIF.decodeImage's strip loop assumes
    // chunky layout and corrupts planar data.
    for (const ifd of ifds) {
      // Hydrate width/height that UTIF.decode sets only inside decodeImage.
      ifd.width = (ifd.t256 as number[])[0]!;
      ifd.height = (ifd.t257 as number[])[0]!;
      ifd.data = readPlanarPageBytes(buf, ifd, ifd.height, ifd.width, spp, bps, isLE);
    }
  } else {
    for (const ifd of ifds) UTIF.decodeImage(buf, ifd);
  }

  if (bps !== 8 && bps !== 16) {
    throw new Error(`Unsupported bit depth: ${bps}. Only 8 and 16 are handled.`);
  }
  if (spp < 1 || spp > 4) {
    throw new Error(`Unsupported SamplesPerPixel=${spp}; only 1..4 are handled.`);
  }

  const description = readImageDescription(first);
  const ijMeta = parseImageJDescription(description);

  // Decide channel count: explicit override > ImageJ metadata > 1.
  let ijChannels = 1;
  let channelSource: 'imagej' | 'override' | 'samples-only' = 'samples-only';
  if (options.forceChannels && options.forceChannels > 1) {
    if (ifds.length % options.forceChannels !== 0) {
      throw new Error(
        `forceChannels=${options.forceChannels} doesn't divide page count ${ifds.length}`
      );
    }
    ijChannels = options.forceChannels;
    channelSource = 'override';
  } else if (
    ijMeta &&
    ijMeta.hyperstack &&
    ijMeta.channels * ijMeta.slices * ijMeta.frames === ifds.length
  ) {
    // tifffile.imwrite(arr_3d, imagej=True) labels the leading axis as
    // "channels" regardless of whether it's actually time. Detect the
    // mislabel: a grayscale multi-channel hyperstack with no Z and no
    // T is in practice a single-channel time series. Treat its
    // "channels" as frames.
    const looksLikeTimeMislabel =
      ijMeta.channels > 1 &&
      ijMeta.slices === 1 &&
      ijMeta.frames === 1 &&
      (ijMeta.mode === 'grayscale' || ijMeta.mode === null);
    if (looksLikeTimeMislabel) {
      ijChannels = 1; // treat as single-channel time series
    } else {
      ijChannels = ijMeta.channels;
      if (ijChannels > 1) channelSource = 'imagej';
    }
  }
  const totalChannels = spp * ijChannels;
  // The remaining pages-per-channel become time frames. If slices > 1,
  // we collapse them onto the time axis — the IRM tracker is not Z-aware.
  const T = ifds.length / ijChannels;
  const stride = h * w;
  const channels: Float32Array[] = [];
  for (let c = 0; c < totalChannels; c++) channels.push(new Float32Array(T * stride));

  // Page order in Fiji hyperstacks is C, Z, T (channel changes fastest).
  // For each output frame `t`, channel `cIJ` lives at page `t*ijChannels + cIJ`.
  for (let t = 0; t < T; t++) {
    for (let cIJ = 0; cIJ < ijChannels; cIJ++) {
      const pageIdx = t * ijChannels + cIJ;
      const ifd = ifds[pageIdx]!;
      if (ifd.width !== w || ifd.height !== h) {
        throw new Error(`Page ${pageIdx} has different dimensions (${ifd.width}x${ifd.height})`);
      }
      const raw = ifd.data;
      const off = t * stride;

      const decodeAt = (sampleIdx: number, dst: Float32Array): void => {
        if (bps === 8) {
          if (planar === 1) {
            for (let p = 0; p < stride; p++) dst[off + p] = raw[p * spp + sampleIdx]!;
          } else {
            const src = sampleIdx * stride;
            for (let p = 0; p < stride; p++) dst[off + p] = raw[src + p]!;
          }
        } else {
          const u16 = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
          if (planar === 1) {
            for (let p = 0; p < stride; p++) dst[off + p] = u16[p * spp + sampleIdx]!;
          } else {
            const src = sampleIdx * stride;
            for (let p = 0; p < stride; p++) dst[off + p] = u16[src + p]!;
          }
        }
      };

      for (let s = 0; s < spp; s++) {
        // Output channel layout: (sample-of-page) × (ImageJ channel),
        // outer = sample, inner = IJ channel. For the typical case
        // (spp=1, ijChannels=2): channels = [ch0, ch1].
        const outIdx = s * ijChannels + cIJ;
        decodeAt(s, channels[outIdx]!);
      }
    }
  }

  // Per-channel first-frame stats for sanity-checking. If channels are
  // mis-decoded, mean/max/min will look pathological (e.g. one channel
  // matching the other's range, or values clipped to the channel-edges
  // of a planar split).
  const firstFrameStats: Array<{ min: number; mean: number; max: number }> = [];
  for (const ch of channels) {
    let mn = Infinity;
    let mx = -Infinity;
    let sum = 0;
    for (let i = 0; i < stride; i++) {
      const v = ch[i]!;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sum += v;
    }
    firstFrameStats.push({ min: mn, mean: sum / stride, max: mx });
  }

  const result: TiffReadResult = {
    channels: channels.map((data) => ({ data, shape: [T, h, w] as Shape3D })),
    bitsPerSample: bps,
    diagnostics: {
      pageCount: ifds.length,
      samplesPerPixel: spp,
      width: w,
      height: h,
      bitsPerSample: bps,
      planarConfig: planar,
      planarConfigPresent: (first.t284 as number[] | undefined) != null,
      imageDescriptionExcerpt:
        description != null
          ? description.length > 200
            ? description.slice(0, 200) + '…'
            : description
          : null,
      channelSource,
      firstFrameStats,
    },
  };
  if (ijMeta && ijMeta.hyperstack) {
    result.imagej = {
      channels: ijMeta.channels,
      slices: ijMeta.slices,
      frames: ijMeta.frames,
    };
  }
  const scale = parseScales(description);
  if (scale.umPerPx != null) result.umPerPx = scale.umPerPx;
  if (scale.secondsPerFrame != null) result.secondsPerFrame = scale.secondsPerFrame;
  return result;
}

// ---------------------------------------------------------------------------
// Multi-page TIFF encoder.
//
// We don't use UTIF.encode because it (a) writes only IFD metadata into a
// fixed 20 KB buffer with no strip data, and (b) iterates *all* IFD object
// keys, parsing each as a tag number — so passing `data`/`width`/`height`
// alongside the t<n> keys (UTIF's own encodeImage trick) makes encode throw
// "unknown type of tag: NaN" when the parser hits a non-tag key.
//
// The TIFF baseline format is small enough that writing it ourselves is
// safer. We emit little-endian, one strip per page, no compression.
// ---------------------------------------------------------------------------

type TagType = 1 | 3 | 4 | 5; // BYTE, SHORT, LONG, RATIONAL

interface IfdTag {
  tag: number;
  type: TagType;
  /** For type 5 (RATIONAL), values are flattened as [num0, den0, num1, den1, ...]. */
  values: number[];
}

interface TiffPage {
  width: number;
  height: number;
  /** Bit depths per sample, e.g. [16] for grayscale, [8,8,8,8] for RGBA. */
  bitsPerSample: number[];
  /** PhotometricInterpretation: 1 = BlackIsZero, 2 = RGB. */
  photometric: 1 | 2;
  samplesPerPixel: number;
  /** ExtraSamples values for samples beyond the colour samples (e.g. [2] = unassociated alpha). */
  extraSamples?: number[];
  /** Raw pixel bytes, already in little-endian order for 16-bit data. */
  pixelBytes: Uint8Array;
}

function tagCount(t: IfdTag): number {
  // RATIONAL stores 2 numbers per logical value (num, den).
  return t.type === 5 ? t.values.length / 2 : t.values.length;
}

function tagSize(t: IfdTag): number {
  switch (t.type) {
    case 1:
      return t.values.length;
    case 3:
      return t.values.length * 2;
    case 4:
      return t.values.length * 4;
    case 5:
      return (t.values.length / 2) * 8;
  }
}

function writeTagValues(t: IfdTag, dst: Uint8Array, offset: number): void {
  const view = new DataView(dst.buffer, dst.byteOffset);
  if (t.type === 1) {
    for (let i = 0; i < t.values.length; i++) dst[offset + i] = t.values[i]! & 0xff;
  } else if (t.type === 3) {
    for (let i = 0; i < t.values.length; i++) view.setUint16(offset + i * 2, t.values[i]!, true);
  } else if (t.type === 4) {
    for (let i = 0; i < t.values.length; i++) view.setUint32(offset + i * 4, t.values[i]!, true);
  } else {
    // RATIONAL: pairs of LONGs.
    for (let i = 0; i < t.values.length; i++) view.setUint32(offset + i * 4, t.values[i]!, true);
  }
}

function encodeTiff(pages: TiffPage[]): Uint8Array {
  if (pages.length === 0) throw new Error('encodeTiff: no pages');

  // Build sorted tag set per page — TIFF requires entries sorted by tag.
  const pageTags: IfdTag[][] = pages.map((p) => {
    const tags: IfdTag[] = [
      { tag: 256, type: 4, values: [p.width] }, // ImageWidth
      { tag: 257, type: 4, values: [p.height] }, // ImageLength
      { tag: 258, type: 3, values: p.bitsPerSample }, // BitsPerSample
      { tag: 259, type: 3, values: [1] }, // Compression: none
      { tag: 262, type: 3, values: [p.photometric] }, // PhotometricInterpretation
      { tag: 273, type: 4, values: [0] }, // StripOffsets — patched after layout
      { tag: 277, type: 3, values: [p.samplesPerPixel] }, // SamplesPerPixel
      { tag: 278, type: 4, values: [p.height] }, // RowsPerStrip = full height (one strip)
      { tag: 279, type: 4, values: [p.pixelBytes.length] }, // StripByteCounts
      // PlanarConfiguration. The TIFF spec defaults this to 1 (chunky)
      // when absent, but many viewers (Fiji among them) assume planar
      // layout without an explicit value, leading to channel-stride
      // corruption. Always emit it.
      { tag: 284, type: 3, values: [1] },
      { tag: 282, type: 5, values: [1, 1] }, // XResolution = 1/1
      { tag: 283, type: 5, values: [1, 1] }, // YResolution = 1/1
      { tag: 296, type: 3, values: [1] }, // ResolutionUnit: none
    ];
    if (p.extraSamples && p.extraSamples.length > 0) {
      tags.push({ tag: 338, type: 3, values: p.extraSamples });
    }
    tags.sort((a, b) => a.tag - b.tag);
    return tags;
  });

  // Layout each page as: [IFD entries][out-of-line tag data][pixel strip].
  // Pad out-of-line data to word boundary per spec.
  let cursor = 8; // skip header
  const ifdOffsets: number[] = [];
  const oolBaseOffsets: number[] = [];
  const pixelOffsets: number[] = [];
  for (let pi = 0; pi < pages.length; pi++) {
    const tags = pageTags[pi]!;
    const ifdBytes = 2 + 12 * tags.length + 4;
    let oolBytes = 0;
    for (const t of tags) {
      const sz = tagSize(t);
      if (sz > 4) oolBytes += sz + (sz & 1);
    }
    ifdOffsets.push(cursor);
    oolBaseOffsets.push(cursor + ifdBytes);
    pixelOffsets.push(cursor + ifdBytes + oolBytes);
    cursor = pixelOffsets[pi]! + pages[pi]!.pixelBytes.length;
    if (cursor & 1) cursor++;
  }

  const out = new Uint8Array(cursor);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0x4949, true); // 'II' little-endian
  view.setUint16(2, 42, true); // magic
  view.setUint32(4, ifdOffsets[0]!, true);

  for (let pi = 0; pi < pages.length; pi++) {
    const tags = pageTags[pi]!;
    const stripOffsets = tags.find((t) => t.tag === 273)!;
    stripOffsets.values[0] = pixelOffsets[pi]!;

    let off = ifdOffsets[pi]!;
    view.setUint16(off, tags.length, true);
    off += 2;

    let oolCursor = oolBaseOffsets[pi]!;
    for (const t of tags) {
      view.setUint16(off, t.tag, true);
      view.setUint16(off + 2, t.type, true);
      view.setUint32(off + 4, tagCount(t), true);

      const sz = tagSize(t);
      if (sz <= 4) {
        view.setUint32(off + 8, 0, true);
        writeTagValues(t, out, off + 8);
      } else {
        view.setUint32(off + 8, oolCursor, true);
        writeTagValues(t, out, oolCursor);
        oolCursor += sz + (sz & 1);
      }
      off += 12;
    }

    const nextOff = pi + 1 < pages.length ? ifdOffsets[pi + 1]! : 0;
    view.setUint32(off, nextOff, true);

    out.set(pages[pi]!.pixelBytes, pixelOffsets[pi]!);
  }

  return out;
}

/**
 * Encode a Stack3D into a multi-page 16-bit grayscale TIFF. Caller is
 * expected to have normalised values into [0, 65535]; out-of-range
 * values are clipped.
 */
export function writeTiffStack16(stack: Stack3D): Uint8Array {
  const [t, h, w] = stack.shape;
  const stride = h * w;
  const pages: TiffPage[] = [];
  for (let i = 0; i < t; i++) {
    const u16 = new Uint16Array(stride);
    const src = stack.data.subarray(i * stride, (i + 1) * stride);
    for (let p = 0; p < stride; p++) {
      const v = src[p]!;
      u16[p] = v < 0 ? 0 : v > 65535 ? 65535 : Math.round(v);
    }
    pages.push({
      width: w,
      height: h,
      bitsPerSample: [16],
      photometric: 1,
      samplesPerPixel: 1,
      pixelBytes: new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength),
    });
  }
  return encodeTiff(pages);
}

/**
 * Encode a Stack3D containing pre-packed RGB frames into a multi-page
 * 8-bit RGB TIFF. `stack.shape` is (T, H, W*3) where the last axis
 * holds R, G, B per pixel interleaved. Used for the overlay — we don't
 * carry alpha because the overlay is fully opaque, and 3-sample RGB
 * sidesteps ExtraSamples-related ambiguity in stricter TIFF readers
 * (the user's GNOME Image Viewer rendered our 4-sample TIFF as
 * banded gray).
 */
/**
 * Encode a Uint8 grayscale stack (T·H·W bytes, values [0, 255]) as an
 * 8-bit TIFF. Avoids the rescaleForU16 / Float32 round-trip when the
 * source is already an 8-bit preview buffer — saves ~T·H·W·4 bytes of
 * intermediate allocation on big inputs.
 */
export function writeTiffStack8FromU8(
  data: Uint8Array,
  T: number,
  H: number,
  W: number
): Uint8Array {
  const stride = H * W;
  const pages: TiffPage[] = [];
  for (let i = 0; i < T; i++) {
    pages.push({
      width: W,
      height: H,
      bitsPerSample: [8],
      photometric: 1,
      samplesPerPixel: 1,
      pixelBytes: data.subarray(i * stride, (i + 1) * stride),
    });
  }
  return encodeTiff(pages);
}

/**
 * Encode a Uint8 RGB stack (T·H·W·3 bytes, interleaved RGB) as an
 * 8-bit RGB TIFF. Mirrors `writeTiffStackRgb` but skips the Float32 →
 * Uint8 quantisation step when the source is already 8-bit.
 */
export function writeTiffStackRgbFromU8(
  data: Uint8Array,
  T: number,
  H: number,
  W: number
): Uint8Array {
  const stride = H * W * 3;
  const pages: TiffPage[] = [];
  for (let i = 0; i < T; i++) {
    pages.push({
      width: W,
      height: H,
      bitsPerSample: [8, 8, 8],
      photometric: 2,
      samplesPerPixel: 3,
      pixelBytes: data.subarray(i * stride, (i + 1) * stride),
    });
  }
  return encodeTiff(pages);
}

export function writeTiffStackRgb(stack: Stack3D): Uint8Array {
  const [t, h, w3] = stack.shape;
  const w = w3 / 3;
  const stride = h * w3;
  const pages: TiffPage[] = [];
  for (let i = 0; i < t; i++) {
    const rgb = new Uint8Array(stride);
    const src = stack.data.subarray(i * stride, (i + 1) * stride);
    for (let p = 0; p < stride; p++) {
      const v = src[p]!;
      rgb[p] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
    pages.push({
      width: w,
      height: h,
      bitsPerSample: [8, 8, 8],
      photometric: 2,
      samplesPerPixel: 3,
      pixelBytes: rgb,
    });
  }
  return encodeTiff(pages);
}
