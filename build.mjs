import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';

mkdirSync('dist', { recursive: true });
copyFileSync('node_modules/maplibre-gl/dist/maplibre-gl.css', 'dist/maplibre-gl.css');
await build({
  entryPoints: ['src/renderer/app.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome128',
  outfile: 'dist/renderer.js',
  loader: { '.txt': 'text' },
  sourcemap: true,
  logLevel: 'warning'
});
// MapLibre's background worker, as one classic script: a desktop page loads from local files,
// where module workers can't, and MapLibre runs a worker whose name ends in .cjs as a classic one.
await build({
  entryPoints: ['node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome128',
  outfile: 'dist/maplibre-gl-worker.cjs',
  minify: true,
  logLevel: 'warning'
});
console.log('built dist/renderer.js');
