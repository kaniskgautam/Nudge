import { defineConfig } from 'vite';
import webExtension from 'vite-plugin-web-extension';

export default defineConfig({
  plugins: [
    webExtension({
      // Point to manifest.json at project root
      manifest: 'manifest.json',
      // Extra entry points beyond those auto-detected from manifest
      additionalInputs: [
        'src/content/nudge-overlay.ts',
        'src/content/nudge-overlay.css',
      ],
    }),
  ],
  // Use relative base so extension-internal asset paths resolve correctly
  base: './',
  // publicDir files are copied verbatim into dist/ — icons live here
  publicDir: 'public',
  build: {
    // Output into the dist/ folder
    outDir: 'dist',
    sourcemap: false,
    // Don't empty outDir on each build sub-step; the plugin handles this
    emptyOutDir: true,
    minify: false,
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
