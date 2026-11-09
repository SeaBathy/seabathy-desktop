'use strict';

// Smoke test: `electron test/smoke.js <tif> <outDir>`.
// Starts the real app with a throwaway user-data folder, opens the TIF,
// reads the depth at the crosshair, plans a route over it and checks the
// legs' depth check, round-trips a GPX file, opens the 3D view, and exits
// non-zero on renderer errors or a failed check.

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const [tifArg, outArg] = process.argv.slice(-2);
const tif = path.resolve(tifArg);
const outDir = path.resolve(outArg);
fs.mkdirSync(outDir, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'seabathy-smoke-')));

require('../src/main.js');

const errors = [];
const failures = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (_ev, level, message) => {
    if (level >= 3) errors.push(message);
  });
  win.webContents.once('did-finish-load', () => run(win).catch((e) => {
    console.error(e);
    app.exit(1);
  }));
});

async function shot(win, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, name), image.toPNG());
}

const js = (win, code) => win.webContents.executeJavaScript(code, true);

async function run(win) {
  await wait(2500);
  await js(win, `window.seabathy.tifFromPath(${JSON.stringify(tif)}).then((info) => window.seabathyTest.loadGeoTiff(info))`);
  await wait(3000);
  const layer = await js(win, `(() => { const l = window.seabathyTest.app.overlays.stackTopFirst[0]; return l && { id: l.id, kind: l.kind }; })()`);
  check(layer?.kind === 'GEOTIFF', `GeoTIFF layer added (${layer?.kind})`);
  const b = await js(win, `window.seabathyTest.app.overlays.boundsOf(${JSON.stringify(layer?.id)})`);
  const mid = { lat: (b.north + b.south) / 2, lng: (b.east + b.west) / 2 };
  const depth = await js(win, `window.seabathyTest.app.overlays.depthMetres(${mid.lat}, ${mid.lng})`);
  check(Number.isFinite(depth) && depth < 0, `depth at the survey centre ${depth?.toFixed?.(1)} m`);
  await wait(1500);
  await shot(win, '1-chart.png');

  // A route across the survey, west to east over the escarpment.
  const legs = await js(win, `(async () => {
    const { features, toggleTool } = window.seabathyTest;
    toggleTool('route');
    features.route.addPoint(${mid.lat}, ${b.west + (b.east - b.west) * 0.1});
    features.route.addPoint(${mid.lat}, ${b.east - (b.east - b.west) * 0.1}, 'Escarpment');
    document.getElementById('btn-route-legs').click();
    await new Promise((r) => setTimeout(r, 300));
    return document.querySelector('.pd-card').innerText;
  })()`);
  check(/Leg 1 → Escarpment/.test(legs) && /least depth/.test(legs), 'route legs show the survey depth');
  await shot(win, '2-legs.png');
  await js(win, `document.querySelectorAll('.pd-scrim').forEach((s) => s.remove())`);

  // GPX: waypoints and a named route survive export and import.
  const gpx = await js(win, `(async () => {
    const { app, features } = window.seabathyTest;
    app.waypoints.add({ name: 'Cliff edge', lat: ${mid.lat}, lng: ${mid.lng} });
    features.gpx.importText('round-trip.gpx', '<gpx><wpt lat="${mid.lat}" lon="${mid.lng}"><name>Cliff edge</name></wpt><rte><name>Run</name><rtept lat="${mid.lat}" lon="${b.west + 0.001}"><name>Start</name></rtept><rtept lat="${b.north - 0.001}" lon="${mid.lng}"><name>End</name></rtept></rte></gpx>');
    await new Promise((r) => setTimeout(r, 500));
    return { waypoints: (await window.seabathy.loadStore('waypoints')).map((w) => w.name), routes: await window.seabathy.loadStore('routes') };
  })()`);
  check(gpx.waypoints.includes('Cliff edge (2)'), `GPX waypoint imported with a free name (${gpx.waypoints})`);
  check(gpx.routes[0]?.points?.[1]?.name === 'End', 'GPX route keeps its point names');

  await js(win, `window.seabathyTest.features.terrain.open(window.seabathyTest.app.overlays.stackTopFirst[0])`);
  await wait(4000);
  check(await js(win, `!document.getElementById('terrain').hidden`), '3D view open');
  const maps = await js(win, `[...document.querySelectorAll('#map-list .map-name')].map((e) => e.textContent)`);
  check(maps[0] === 'Depth colours' && maps[1] === 'Esri satellite' && !maps.includes('OpenStreetMap'), `3D Map list (${maps.join(', ')})`);
  await shot(win, '3-terrain.png');

  await js(win, `document.getElementById('btn-terrain-close')?.click()`);

  // The grid labels what's on screen, and the world's edge isn't a special case.
  const grid = await js(win, `(async () => {
    const { app, flyTo } = window.seabathyTest;
    app.map.jumpTo({ center: [179.9, -17], zoom: 7 });
    app.graticule.setVisible(true);
    await new Promise((r) => setTimeout(r, 400));
    const labels = [...document.querySelectorAll('.grid-label')].map((e) => e.textContent);
    app.graticule.setVisible(false);
    return { labels, left: document.querySelectorAll('.grid-label').length };
  })()`);
  check(grid.labels.some((l) => /E$/.test(l)) && grid.labels.some((l) => /W$/.test(l)) && grid.labels.some((l) => /S$/.test(l)), `grid across the date line (${grid.labels.join(', ')})`);
  check(grid.left === 0, 'grid labels go when it is turned off');

  check(!errors.length, errors.length ? `renderer errors:\n${errors.join('\n')}` : 'no renderer errors');
  app.exit(failures.length ? 1 : 0);
}
