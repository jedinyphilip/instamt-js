/**
 * ND2 reader. Currently unsupported in the browser build.
 *
 * ND2 is Nikon's proprietary container. The Python pipeline uses the
 * `nd2` package which links libnd2 (C); no equivalent native-JS reader
 * exists. The two routes that get this working in-browser are:
 *
 * 1. Bio-Formats WASM (glencoesoftware/bioformats.js). Reads ND2 plus
 *    ~150 other microscopy formats. Java-via-CheerpJ build, ~25-30 MB
 *    asset, can be lazy-loaded so the cold path stays fast.
 * 2. Wrap libnd2 directly via Emscripten. Smaller artefact but more
 *    work to ship and maintain.
 *
 * Until then, the recommended workflow is to convert ND2 → multi-page
 * TIFF using Fiji (File ▸ Save As ▸ TIFF) or the standalone `bfconvert`
 * tool, then load the TIFF here.
 */

export class Nd2NotSupportedError extends Error {
  constructor() {
    super(
      'ND2 input is not supported in the browser build. ' +
        'Convert to multi-page TIFF first — Fiji: File ▸ Save As ▸ TIFF, ' +
        'or run `bfconvert input.nd2 output.tif` from the Bio-Formats CLI.'
    );
    this.name = 'Nd2NotSupportedError';
  }
}

export async function readNd2(_file: File | Blob): Promise<never> {
  throw new Nd2NotSupportedError();
}
