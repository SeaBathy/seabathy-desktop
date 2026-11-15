# Changelog

## Unreleased

- **Temperature lines:** smooth, labelled lines over the sea temperature maps (satellite, breaks
  and at depth), every 0.25, 0.5, 1 or 2 degrees or spaced automatically, with whole degrees drawn
  heavier. Tiny rings from satellite noise are left out. Turn them off in Sea conditions.
- **Target temperature band:** set a range, say 24 to 26 °C, and water in it shows bright with bold
  edges while the rest is dimmed, on the map and in the colour key.
- **Eddy outlines:** the sea level map now draws lines at 10, 20 and 30 cm above (solid) and below
  (dashed) average, and marks warm (W) and cold (C) eddy middles with their height. Shown on every
  sea map, they are drawn in white over the other colours, as IMOS OceanCurrent does.
- **Sun, moon and solunar times** in the values box: sunrise, sunset, first light, moon phase, and
  solunar major and minor times (a traditional fishing guide, not a promise). Worked out on the
  computer, nothing downloaded.
- **Clearer labels:** "Surface temp", "Sea temp 10 m down", and sea level as "3 cm below average"
  (satellite height against its long-term average: higher often means a warm eddy, lower a cold one).
  "Saved areas" are now "Downloaded areas", "Round my spot" is "My spot", and the satellite switch
  is "Satellite sea maps" and lists what it downloads.

## 1.1.0 — 2026-11-15

- **Buoys, beacons, pipelines (beta):** a new map layer in Settings → Map display, off by default.
  It shows channel markers, cardinals, special marks, lights, moorings, offshore pipelines,
  submarine cables and mooring areas from free government data and OpenStreetMap, with chart-style
  icons; click a mark for its type and source. It is not for navigation: every time it is turned on,
  the app shows a warning that must be ticked first, and it starts off each time the app opens.
- **Metric by default:** sea temperature in °C and tides and waves in metres until you choose
  otherwise, wherever the PC is set to. Temperature at depth now starts at 10 m instead of 50 m.
- **Esri maps are no longer ready-made links,** to match the phone app: Esri's terms expect an
  ArcGIS account for app use. You can still add them yourself under Online map layers → Your own tile link, under your own
  terms with Esri. Maps you already added stay.

## 1.0.3 — 2026-11-13

- **Sentinel-2 is the built-in satellite map** in the 3D view, instead of Esri's. Esri World
  Imagery, Ocean and Topographic are still in the ready-made map links, and **Add a map link**
  takes any other map. If you had Esri satellite chosen, the 3D view now uses Sentinel-2.
- **Licences:** the libraries that come with the map engine are now listed, with their full
  licence texts, under Settings → Licences and credits.

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
