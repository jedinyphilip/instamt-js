/// <reference types="vitest" />
import { defineConfig } from 'vite';

// Pages serves under /<repo-name>/, so the build needs that base path.
// Override with VITE_BASE for custom domain or local previews.
const base = process.env.VITE_BASE ?? '/instamt-js/';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Separate the heavy WASM/TIFF deps so the initial parse stays fast.
        manualChunks: {
          tiff: ['utif'],
          fft: ['fft.js'],
          zip: ['jszip'],
        },
      },
    },
  },
  server: {
    // Required for SharedArrayBuffer in dev. The deployed site uses the
    // service worker in public/coi-serviceworker.js to set the same
    // headers, since GitHub Pages doesn't allow custom headers.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  test: {
    globals: true,
    environment: 'node',
  },
});
