# Third-party software

SeaBathy Desktop's own code is under the MIT licence in [`LICENSE`](LICENSE).
The app is built with, and ships, the open-source software below under its own
licences. Their full licence texts ship inside the app (Settings > Licences and
credits; in the source, `src/renderer/licenses.txt`). Map and data services are
listed separately in [`DATA_ATTRIBUTION.md`](DATA_ATTRIBUTION.md).

## Libraries

| Component | Version | Licence | Source |
| --- | --- | --- | --- |
| Electron (includes Chromium and Node.js) | 33.2.1 | MIT (Chromium's own notices ship in the exe as `LICENSES.chromium.html`) | https://github.com/electron/electron |
| MapLibre GL JS | 4.7.1 | BSD 3-Clause | https://github.com/maplibre/maplibre-gl-js |
| three.js | 0.170.0 | MIT | https://github.com/mrdoob/three.js |
| geotiff.js | 2.1.3 | MIT | https://github.com/geotiffjs/geotiff.js |
| proj4js | 2.12.1 | MIT | https://github.com/proj4js/proj4js |
| better-sqlite3 (includes SQLite) | 11.7.0 | MIT (SQLite: public domain) | https://github.com/WiseLibs/better-sqlite3 |
| esbuild, electron-builder (build tools only) | 0.24.0, 25.1.8 | MIT | https://esbuild.github.io, https://www.electron.build |

The full licence texts of the npm packages are in each package's folder under
`node_modules/` after `npm install`; `npm ls --all` lists them with
their dependencies.
