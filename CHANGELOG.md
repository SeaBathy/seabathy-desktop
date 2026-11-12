# Changelog

## 1.0.2 — 2026-11-12

Small improvements to sea conditions.

- **Temperature at depth updates straight away:** choosing a new "How far down" downloads just that layer
  for the area on the chart, instead of waiting for the next full update.
- **Clearer values box:** surface temperature and chlorophyll, then the temperature at your chosen depth,
  then salinity and sea level, each on its own line.
- **Clearer names:** "Temperature at depth (model)", and a one-line explanation of temperature breaks.

## 1.0.1 — 2026-11-09

Security and maintenance update. Everything works as before.

- **Up-to-date browser engine:** Electron 45 (from 33), with the latest Chromium security fixes.
- **Map library:** MapLibre GL JS 6.17 (from 4.7), including a security fix.
- **Build tools:** esbuild 0.28 and electron-builder 26; `npm audit` reports no known vulnerabilities.
- **Smaller download:** the exe leaves out unused language packs and files for other platforms.
- **3D view:** a new **Sentinel-2 satellite** map that can be saved offline with "Save this area offline". Esri satellite stays in the list to look at, but can no longer be saved offline, because Esri's terms don't allow offline copies.

## 1.0.0 — 2026-11-09

First public release: the SeaBathy Android app for Windows.

- **Your own surveys:** GeoTIFF depth rasters, coloured with the phone's palettes and
  relief shading, and MBTiles charts. Open from Settings or drag onto the window.
- **Free seabed depths** for the area on screen, anywhere in the world (GMRT).
- **3D seabed view** of any depth layer, with satellite or offline maps draped on it.
- **Offline maps:** download the area on screen as MBTiles.
- **Tides and sea conditions,** saved for offline use, in the units you choose.
- **Waypoints and route planning,** with GPX import and export and depth checks
  along each leg.
- **No account, ads or analytics.** Portable: no install.

Not for navigation.
