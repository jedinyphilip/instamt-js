/**
 * ND2 reader. Not implemented.
 *
 * ND2 is Nikon's proprietary container. There's no native-JS reader;
 * the two practical routes are Bio-Formats WASM (~25-30 MB asset, can
 * be lazy-loaded so the cold path stays fast) or wrapping libnd2
 * directly via Emscripten (smaller artefact, more maintenance).
 *
 * Until then, convert ND2 → multi-page TIFF in Fiji
 * (File ▸ Save As ▸ TIFF) or with `bfconvert` from the Bio-Formats CLI.
 */

export class Nd2NotSupportedError extends Error {
  constructor() {
    super(
      'ND2 input is not supported. Convert to multi-page TIFF first — ' +
        'Fiji: File ▸ Save As ▸ TIFF, or run ' +
        '`bfconvert input.nd2 output.tif` from the Bio-Formats CLI.'
    );
    this.name = 'Nd2NotSupportedError';
  }
}

export async function readNd2(_file: File | Blob): Promise<never> {
  throw new Nd2NotSupportedError();
}
