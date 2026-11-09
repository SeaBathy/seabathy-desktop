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
console.log('built dist/renderer.js');
