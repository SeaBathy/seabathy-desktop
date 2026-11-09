# Developing SeaBathy Desktop

Building, testing and the technical details. For using the app, see the [README](README.md).

## Build from source

- **From source** (needs Node.js and npm):

  ```
  npm install --ignore-scripts
  node node_modules/electron/install.js
  npm start
  ```

  `--ignore-scripts` skips better-sqlite3's own compile step, which would need a C++
  toolchain; it isn't needed, because better-sqlite3 ships ready-made builds that work
  with any Electron. That also skips Electron's download, so the second line fetches it.
- **Rebuild the exe:** `npm run dist` (on Windows without Developer Mode, set
  `ELECTRON_CACHE` / `ELECTRON_BUILDER_CACHE` to a folder on the same drive as `%TEMP%`).

## Data

Settings, waypoints, routes and layers are JSON files in `%APPDATA%\SeaBathy Desktop\data\`;
downloaded sea conditions and tides are under `data\conditions` and `data\tides`. Writes go
to a temp file and are renamed, with a `.bak` of the previous version; a file that can't be
read is set aside, never overwritten. The debug log (Settings → Export debug log) is
`%APPDATA%\SeaBathy Desktop\logs\seabathy-debug.log`.

## GeoTIFF support

Single-band float/int depth rasters (either sign convention; positive-down soundings are
flipped) and RGB(A) imagery. Big files are read in windows, and internal overviews (COGs)
are used when present. Recognised CRSs: WGS84 / GDA94 / GDA2020 / NAD83 geographic, Web
Mercator, World Mercator, WGS84 UTM, GDA94 & GDA2020 MGA zones, NAD83, NAD27 & ETRS89 UTM,
ETRS89 LAEA and LCC, British National Grid, Australian Albers, GA Lambert, NZTM, polar
stereographic. Any other EPSG code is looked up once at epsg.io when online, then remembered.

## Test

`python -I test/make_test_tif.py test/synthetic_cliff_utm56s.tif` writes a synthetic
survey with a 120 m escarpment, reefs, a canyon and a no-data hole.
`npx electron test/smoke.js test/synthetic_cliff_utm56s.tif <outDir>` drives the real app
(open the TIF, depth readout, a route and its depth check, GPX round trip, 3D view) and
writes screenshots; it exits non-zero on a failed check or a renderer error.
