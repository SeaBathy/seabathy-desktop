'use strict';

// Main process: the window, saved data in the user-data folder, file
// dialogs, network requests for the renderer (with the phone app's
// User-Agent), MBTiles reading and writing, offline map downloads, and the
// debug log.

const { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');

const FILE_SCHEME = 'seabathy-file';
const TILE_SCHEME = 'seabathy-tiles';
const STORE_NAMES = new Set(['prefs', 'waypoints', 'routes', 'layers', 'layers-unavailable', 'sources', 'tracks', 'recent', 'places', 'settings']);
const FILE_DIRS = new Set(['conditions', 'tides']);

protocol.registerSchemesAsPrivileged([
  { scheme: FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: TILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

// ------------------------------------------------------------------ debug log

const LOG_MAX_BYTES = 4 * 1024 * 1024;

function logPath() {
  return path.join(app.getPath('userData'), 'logs', 'seabathy-debug.log');
}

/** Appends a line; the log is cut to its newer half past [LOG_MAX_BYTES]. Query strings are removed (tile links can carry keys). */
function log(tag, message) {
  try {
    const file = logPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
    const text = String(message).replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/g, '$1?…').replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//');
    fs.appendFileSync(file, `${stamp} [${tag}] ${text}\n`);
    const size = fs.statSync(file).size;
    if (size > LOG_MAX_BYTES) {
      const kept = fs.readFileSync(file).subarray(size - LOG_MAX_BYTES / 2);
      fs.writeFileSync(file, kept);
    }
  } catch {
    // Logging must never break the app.
  }
}

// ------------------------------------------------------------------ files the user picked

const allowedFiles = new Map(); // token -> absolute path
let nextToken = 1;

function allowFile(filePath) {
  const resolved = path.resolve(filePath);
  for (const [token, existing] of allowedFiles) {
    if (existing === resolved) return token;
  }
  // Letter prefix: a numeric host would be parsed as an IPv4 address.
  const token = `f${nextToken++}`;
  allowedFiles.set(token, resolved);
  return token;
}

function fileInfo(filePath) {
  const token = allowFile(filePath);
  return { path: filePath, name: path.basename(filePath), url: `${FILE_SCHEME}://${token}/data` };
}

async function serveFile(request) {
  const url = new URL(request.url);
  const filePath = allowedFiles.get(url.hostname);
  if (!filePath) return new Response('Not allowed', { status: 403 });

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const size = stat.size;
  // The page (file://) reads with Range requests, which need CORS headers.
  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges'
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
  }

  const range = request.headers.get('Range');
  const match = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) {
    const data = await fsp.readFile(filePath);
    return new Response(data, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
  }
  let start = match[1] === '' ? size - Number(match[2]) : Number(match[1]);
  let end = match[1] !== '' && match[2] !== '' ? Number(match[2]) : size - 1;
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });

  const length = end - start + 1;
  const buffer = Buffer.alloc(length);
  const handle = await fsp.open(filePath, 'r');
  try {
    await handle.read(buffer, 0, length, start);
  } finally {
    await handle.close();
  }
  return new Response(buffer, {
    status: 206,
    headers: { ...headers, 'Content-Length': String(length), 'Content-Range': `bytes ${start}-${end}/${size}` }
  });
}

// ------------------------------------------------------------------ saved data

function dataDir() {
  return path.join(app.getPath('userData'), 'data');
}

function storePath(name) {
  if (!STORE_NAMES.has(name)) throw new Error(`Unknown store: ${name}`);
  return path.join(dataDir(), `${name}.json`);
}

async function readStore(name) {
  try {
    return JSON.parse(await fsp.readFile(storePath(name), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    // A damaged file is kept aside rather than silently overwritten.
    const target = storePath(name);
    log('Store', `${name} unreadable (${error.message}); kept as .corrupt`);
    await fsp.rename(target, `${target}.corrupt-${Date.now()}`).catch(() => {});
    return null;
  }
}

/** Written to a temp file then renamed, with one backup of the previous version. */
async function writeAtomic(target, data) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  await fsp.writeFile(temp, data);
  await fsp.copyFile(target, `${target}.bak`).catch(() => {});
  await fsp.rename(temp, target);
}

function filePath(dir, name) {
  if (!FILE_DIRS.has(dir) || !/^[\w.-]+$/.test(name)) throw new Error('Bad file name');
  return path.join(dataDir(), dir, name);
}

// ------------------------------------------------------------------ network

const USER_AGENT = `SeaBathy/${app.getVersion()} (Windows)`;

/** GET over https; [userAgent] as the phone sends for that service. */
async function httpGet(url, { userAgent = USER_AGENT, binary = false, timeoutMs = 60000 } = {}) {
  if (!/^https:\/\//i.test(url)) throw new Error('Only https links are fetched');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await net.fetch(url, { headers: { 'User-Agent': userAgent }, signal: controller.signal });
    const body = binary ? Buffer.from(await response.arrayBuffer()) : await response.text();
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    const offline = !net.isOnline();
    return { ok: false, status: 0, error: offline ? 'offline' : controller.signal.aborted ? 'timeout' : String(error.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ MBTiles

const mbtiles = new Map(); // id -> { db, format, isVector }

function readMbtilesMetadata(db) {
  const meta = {};
  try {
    for (const row of db.prepare('SELECT name, value FROM metadata').all()) meta[String(row.name).toLowerCase()] = row.value;
  } catch {
    // A file without metadata still works with the defaults.
  }
  const format = (meta.format || 'png').toLowerCase();
  let bounds = null;
  const parts = String(meta.bounds || '').split(',').map((v) => Number(v.trim()));
  if (parts.length === 4 && parts.every(Number.isFinite) && parts[0] < parts[2] && parts[1] < parts[3]) {
    bounds = { west: parts[0], south: parts[1], east: parts[2], north: parts[3] };
  }
  return {
    name: meta.name || null,
    format,
    isVector: format === 'pbf' || format === 'mvt',
    minZoom: Number.parseInt(meta.minzoom, 10) || 0,
    maxZoom: Number.parseInt(meta.maxzoom, 10) || 22,
    bounds,
    attribution: meta.attribution || ''
  };
}

/** The area the tiles at [zoom] cover, for files without a "bounds" entry. */
function mbtilesTileBounds(db, zoom) {
  try {
    const c = db.prepare('SELECT MIN(tile_column) a, MAX(tile_column) b, MIN(tile_row) c, MAX(tile_row) d FROM tiles WHERE zoom_level = ?').get(zoom);
    if (c.a === null) return null;
    const n = 2 ** zoom;
    const lng = (x) => (x / n) * 360 - 180;
    // MBTiles rows count up from the south (TMS).
    const lat = (tmsRow) => {
      const y = n - tmsRow;
      return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
    };
    return { west: lng(c.a), south: lat(c.c), east: lng(c.b + 1), north: lat(c.d + 1) };
  } catch {
    return null;
  }
}

function openMbtiles(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    db.prepare('SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles LIMIT 1').all();
  } catch (error) {
    db.close();
    throw new Error("This isn't an MBTiles map: it has no tiles table");
  }
  const meta = readMbtilesMetadata(db);
  if (!meta.bounds) meta.bounds = mbtilesTileBounds(db, meta.maxZoom);
  const id = `m${nextToken++}`;
  mbtiles.set(id, { db, format: meta.format, isVector: meta.isVector, tile: db.prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?') });
  log('Mbtiles', `opened ${path.basename(file)}: format=${meta.format} zoom ${meta.minZoom}-${meta.maxZoom}`);
  return { id, ...meta, url: `${TILE_SCHEME}://${id}/{z}/{x}/{y}` };
}

const TILE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pbf: 'application/x-protobuf', mvt: 'application/x-protobuf' };

function serveTile(request) {
  const url = new URL(request.url);
  const entry = mbtiles.get(url.hostname);
  const [z, x, y] = url.pathname.split('/').filter(Boolean).map(Number);
  if (!entry || ![z, x, y].every(Number.isInteger)) return new Response(null, { status: 404 });
  // MBTiles rows are TMS: 0 at the south.
  const row = entry.tile.get(z, x, 2 ** z - 1 - y);
  if (!row) return new Response(null, { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
  let data = row.tile_data;
  // Vector tiles are stored gzipped; the map wants them plain.
  if (entry.isVector && data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data);
  return new Response(data, { status: 200, headers: { 'Content-Type': TILE_TYPES[entry.format] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' } });
}

// ------------------------------------------------------------------ offline map downloads

const HALF_WORLD = Math.PI * 6378137;
const MAX_LAT = 85.05112878;

function tileRangeCovering(bounds, z) {
  const n = 2 ** z;
  const size = (2 * HALF_WORLD) / n;
  const xAt = (lng) => Math.min(n - 1, Math.max(0, Math.floor(((lng * Math.PI * 6378137) / 180 + HALF_WORLD) / size)));
  const yAt = (lat) => {
    const l = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
    const y = 6378137 * Math.log(Math.tan(Math.PI / 4 + (l * Math.PI) / 360));
    return Math.min(n - 1, Math.max(0, Math.floor((HALF_WORLD - y) / size)));
  };
  const a = xAt(bounds.west);
  const b = xAt(bounds.east);
  const c = yAt(bounds.north);
  const d = yAt(bounds.south);
  return { minX: Math.min(a, b), maxX: Math.max(a, b), minY: Math.min(c, d), maxY: Math.max(c, d) };
}

function tileCount(bounds, minZoom, maxZoom) {
  let count = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const r = tileRangeCovering(bounds, z);
    count += (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
  }
  return count;
}

function tilesToFetch(bounds, minZoom, maxZoom) {
  const tiles = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const r = tileRangeCovering(bounds, z);
    for (let x = r.minX; x <= r.maxX; x++) for (let y = r.minY; y <= r.maxY; y++) tiles.push([z, x, y]);
  }
  return tiles;
}

function tileUrl(template, z, x, y) {
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_TILE_BYTES = 8 * 1024 * 1024;

/** One tile, tried up to 3 times (300 ms, 600 ms apart) when the failure may pass; null if it never came. */
async function fetchTile(url, shouldStop) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (shouldStop()) return null;
    const result = await httpGet(url, { binary: true, timeoutMs: 20000 });
    if (result.ok) return result.body.length > MAX_TILE_BYTES ? null : result.body;
    if (result.status && !RETRYABLE.has(result.status)) return null;
    if (attempt < 3 && !shouldStop()) await new Promise((r) => setTimeout(r, 300 * attempt));
  }
  return null;
}

/** About [count] tiles spread over every zoom and across each level, for the size estimate. */
function samplePicks(bounds, minZoom, maxZoom, count = 8) {
  const zooms = maxZoom - minZoom + 1;
  const perZoom = Math.max(1, Math.floor(count / zooms));
  const picks = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const tiles = tilesToFetch(bounds, z, z);
    const n = Math.min(perZoom, tiles.length);
    for (let i = 0; i < n; i++) picks.push(tiles[Math.floor((i * tiles.length) / n)]);
  }
  return picks;
}

// ------------------------------------------------------------------ seabed depths

/**
 * Saves free depth data from GMRT beside the offline maps and opens it. The
 * same area gets the same file. Written beside the final name first, so a
 * dropped connection never leaves half a file.
 */
async function downloadSeabed(url, name) {
  if (!/^https:\/\/www\.gmrt\.org\/services\/GridServer\?/.test(url)) return { ok: false, message: 'Not a depth service link' };
  const dir = path.join(app.getPath('documents'), 'SeaBathy', 'Seabed');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${name.replace(/[^\w .()°-]+/g, '_')}.tif`);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return { ok: true, info: fileInfo(target) };
  const result = await httpGet(url, { binary: true, timeoutMs: 180000 });
  if (!result.ok) {
    const why = result.error === 'offline' ? 'No internet connection'
      : result.error === 'timeout' ? "The depth service didn't answer in time"
        : `The depth service answered ${result.status || result.error}. Try again later.`;
    return { ok: false, message: why };
  }
  const head = result.body.subarray(0, 4);
  const tiff = (head[0] === 0x49 && head[1] === 0x49 && head[2] === 42) || (head[0] === 0x4d && head[1] === 0x4d && head[3] === 42);
  if (!tiff) return { ok: false, message: 'The depth service has no data for this area' };
  const partial = `${target}.part`;
  await fsp.writeFile(partial, result.body);
  await fsp.rename(partial, target);
  log('Seabed', `saved ${target} (${result.body.length} bytes)`);
  return { ok: true, info: fileInfo(target) };
}

function downloadsDir() {
  return path.join(app.getPath('documents'), 'SeaBathy', 'OfflineDownloads');
}

function freeMbtilesFile(dir, base) {
  for (let n = 1; ; n++) {
    const file = path.join(dir, n === 1 ? `${base}.mbtiles` : `${base}_${n}.mbtiles`);
    if (!fs.existsSync(file) && !fs.existsSync(`${file}.part`)) return file;
  }
}

let download = null; // { cancelled }

async function runDownload(win, { source, bounds, minZoom, maxZoom }) {
  const job = { cancelled: false };
  download = job;
  const send = (channel, data) => { if (!win.isDestroyed()) win.webContents.send(channel, data); };
  const dir = downloadsDir();
  fs.mkdirSync(dir, { recursive: true });
  const slug = source.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'source';
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const base = `${slug}_${((bounds.north + bounds.south) / 2).toFixed(1)}_${((bounds.west + bounds.east) / 2).toFixed(1)}_${date}`;
  const destination = freeMbtilesFile(dir, base);
  const partial = `${destination}.part`;
  const tiles = tilesToFetch(bounds, minZoom, maxZoom);
  const total = tiles.length;
  log('OfflineTileDownload', `start: source=${source.name} zoom ${minZoom}-${maxZoom} tiles=${total}`);

  let db;
  let done = 0;
  let bytes = 0;
  let succeeded = 0;
  const failed = [];
  try {
    db = new Database(partial);
    db.exec('CREATE TABLE metadata (name TEXT, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB); CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);');
    const putMeta = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
    const meta = { name: source.name, format: 'jpg', minzoom: String(minZoom), maxzoom: String(maxZoom), bounds: `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`, type: 'baselayer', version: '1.1' };
    if (source.attribution) meta.attribution = source.attribution;
    for (const [k, v] of Object.entries(meta)) putMeta.run(k, v);
    const putTile = db.prepare('INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)');
    const writeBatch = db.transaction((rows) => { for (const r of rows) putTile.run(r[0], r[1], 2 ** r[0] - 1 - r[2], r[3]); });

    const fetchBatch = async (batch) => {
      const results = new Array(batch.length);
      let next = 0;
      // Six fetches at a time, as on the phone.
      await Promise.all(Array.from({ length: 6 }, async () => {
        while (next < batch.length && !job.cancelled) {
          const i = next++;
          const [z, x, y] = batch[i];
          results[i] = await fetchTile(tileUrl(source.urlTemplate, z, x, y), () => job.cancelled);
        }
      }));
      return results;
    };

    let lastSent = 0;
    for (let i = 0; i < tiles.length && !job.cancelled; i += 200) {
      const batch = tiles.slice(i, i + 200);
      const data = await fetchBatch(batch);
      const rows = [];
      batch.forEach((t, k) => {
        if (data[k]) {
          rows.push([...t, data[k]]);
          succeeded++;
          bytes += data[k].length;
        } else {
          failed.push(t);
        }
      });
      writeBatch(rows);
      done += batch.length;
      if (Date.now() - lastSent > 500 || done === total) {
        send('download:progress', { done, total, bytes, name: source.name });
        lastSent = Date.now();
      }
    }
    // One more go at whatever failed.
    if (failed.length && !job.cancelled) {
      log('OfflineTileDownload', `retrying ${failed.length} failed tiles`);
      const retry = failed.splice(0);
      for (let i = 0; i < retry.length && !job.cancelled; i += 200) {
        const batch = retry.slice(i, i + 200);
        const data = await fetchBatch(batch);
        const rows = [];
        batch.forEach((t, k) => {
          if (data[k]) {
            rows.push([...t, data[k]]);
            succeeded++;
            bytes += data[k].length;
          } else {
            failed.push(t);
          }
        });
        writeBatch(rows);
        send('download:progress', { done, total, bytes, name: source.name });
      }
    }
    db.close();
    db = null;
    if (job.cancelled) throw new Error('cancelled');
    if (succeeded === 0) throw new Error(`None of the ${total} tiles in this area could be downloaded`);
    fs.renameSync(partial, destination);
    fs.rmSync(`${partial}-journal`, { force: true });
    log('OfflineTileDownload', `finished: ${destination} tiles ${succeeded}/${total} bytes ${bytes}`);
    send('download:done', { file: destination, name: source.name, attribution: source.attribution, total, failed: failed.length, bytes });
  } catch (error) {
    try { db?.close(); } catch { /* already closed */ }
    fs.rmSync(partial, { force: true });
    fs.rmSync(`${partial}-journal`, { force: true });
    const cancelled = job.cancelled;
    log('OfflineTileDownload', cancelled ? 'cancelled' : `FAILED: ${error.message}`);
    send('download:failed', { name: source.name, cancelled, message: cancelled ? 'Download cancelled' : error.message });
  } finally {
    if (download === job) download = null;
  }
}

// ------------------------------------------------------------------ window

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#111418',
    title: 'SeaBathy',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));

  // External links open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !/ResizeObserver loop/.test(message)) log('Console', message);
  });
  win.webContents.on('render-process-gone', (_e, details) => log('App', `renderer gone: ${details.reason}`));
}

async function pickFile(event, title, filters) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters: [...filters, { name: 'All files', extensions: ['*'] }] });
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

app.whenReady().then(() => {
  log('App', `start: SeaBathy Desktop ${app.getVersion()}, Electron ${process.versions.electron}`);
  protocol.handle(FILE_SCHEME, serveFile);
  protocol.handle(TILE_SCHEME, serveTile);

  ipcMain.handle('store:load', (_e, name) => readStore(name));
  ipcMain.handle('store:save', (_e, name, data) => writeAtomic(storePath(name), JSON.stringify(data, null, 1)));
  ipcMain.handle('store:folder', () => {
    fs.mkdirSync(dataDir(), { recursive: true });
    return shell.openPath(dataDir());
  });

  // Saved tides and sea conditions: one gzipped file each.
  ipcMain.handle('files:save', async (_e, dir, name, text) => {
    await writeAtomic(filePath(dir, name), zlib.gzipSync(Buffer.from(text, 'utf8')));
    return (await fsp.stat(filePath(dir, name))).size;
  });
  ipcMain.handle('files:load', async (_e, dir, name) => {
    try {
      return zlib.gunzipSync(await fsp.readFile(filePath(dir, name))).toString('utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') log('Files', `${dir}/${name} unreadable: ${error.message}`);
      return null;
    }
  });
  ipcMain.handle('files:list', async (_e, dir) => {
    if (!FILE_DIRS.has(dir)) return [];
    const folder = path.join(dataDir(), dir);
    const names = await fsp.readdir(folder).catch(() => []);
    const out = [];
    for (const name of names) {
      if (name.endsWith('.tmp') || name.endsWith('.bak')) continue;
      const stat = await fsp.stat(path.join(folder, name)).catch(() => null);
      if (stat?.isFile()) out.push({ name, size: stat.size, modified: stat.mtimeMs });
    }
    return out;
  });
  ipcMain.handle('files:delete', async (_e, dir, name) => {
    await fsp.rm(filePath(dir, name), { force: true });
    await fsp.rm(`${filePath(dir, name)}.bak`, { force: true });
  });

  ipcMain.handle('net:get', (_e, url, options) => httpGet(url, options));
  ipcMain.handle('net:online', () => net.isOnline());
  ipcMain.handle('app:country', () => app.getLocaleCountryCode());

  ipcMain.handle('log:write', (_e, tag, message) => log(tag, message));
  ipcMain.handle('log:export', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win, { defaultPath: 'seabathy-debug.log', filters: [{ name: 'Log', extensions: ['log', 'txt'] }] });
    if (result.canceled || !result.filePath) return null;
    await fsp.copyFile(logPath(), result.filePath).catch(() => fsp.writeFile(result.filePath, ''));
    return result.filePath;
  });

  ipcMain.handle('file:openTif', async (event) => {
    const file = await pickFile(event, 'Load GeoTIFF', [{ name: 'GeoTIFF', extensions: ['tif', 'tiff'] }]);
    return file ? fileInfo(file) : null;
  });
  // Drag-and-drop and saved layers hand over a path the user chose.
  ipcMain.handle('file:fromPath', async (_e, file) => {
    if (typeof file !== 'string' || !/\.tiff?$/i.test(file)) return null;
    try {
      await fsp.access(file);
    } catch {
      return null;
    }
    return fileInfo(file);
  });
  ipcMain.handle('seabed:download', (_e, url, name) => downloadSeabed(url, name));
  ipcMain.handle('file:openMbtiles', (event) => pickFile(event, 'Load MBTiles file', [{ name: 'MBTiles', extensions: ['mbtiles'] }]));
  ipcMain.handle('file:exists', async (_e, file) => fsp.access(file).then(() => true, () => false));
  ipcMain.handle('file:openText', async (event, extensions) => {
    const file = await pickFile(event, 'Open', [{ name: 'Files', extensions }]);
    return file ? { name: path.basename(file), text: await fsp.readFile(file, 'utf8') } : null;
  });
  ipcMain.handle('file:saveText', async (event, defaultName, text, extensions) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: 'Files', extensions }] });
    if (result.canceled || !result.filePath) return null;
    await fsp.writeFile(result.filePath, text, 'utf8');
    return result.filePath;
  });
  ipcMain.handle('file:savePng', async (event, defaultName, dataUrl) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: 'PNG image', extensions: ['png'] }] });
    if (result.canceled || !result.filePath) return null;
    await fsp.writeFile(result.filePath, Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64'));
    return result.filePath;
  });
  ipcMain.handle('file:show', (_e, file) => shell.showItemInFolder(file));

  ipcMain.handle('mbtiles:open', (_e, file) => {
    try {
      return { ok: true, layer: openMbtiles(file) };
    } catch (error) {
      log('Mbtiles', `open FAILED ${file}: ${error.message}`);
      return { ok: false, message: error.code === 'SQLITE_CANTOPEN' ? 'The file couldn\'t be opened. It may have been moved or deleted.' : error.message };
    }
  });
  ipcMain.handle('mbtiles:close', (_e, id) => {
    const entry = mbtiles.get(id);
    if (entry) {
      entry.db.close();
      mbtiles.delete(id);
    }
  });

  ipcMain.handle('download:count', (_e, bounds, minZoom, maxZoom) => tileCount(bounds, minZoom, maxZoom));
  ipcMain.handle('download:sample', async (_e, template, bounds, minZoom, maxZoom) => {
    const sizes = [];
    for (const [z, x, y] of samplePicks(bounds, minZoom, maxZoom)) {
      const data = await fetchTile(tileUrl(template, z, x, y), () => false);
      if (data) sizes.push(data.length);
    }
    return sizes;
  });
  ipcMain.handle('download:start', (event, job) => {
    if (download) return false;
    runDownload(BrowserWindow.fromWebContents(event.sender), job);
    return true;
  });
  ipcMain.handle('download:cancel', () => {
    if (download) download.cancelled = true;
  });
  ipcMain.handle('download:running', () => Boolean(download));
  ipcMain.handle('download:folder', () => {
    fs.mkdirSync(downloadsDir(), { recursive: true });
    return downloadsDir();
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const entry of mbtiles.values()) {
    try { entry.db.close(); } catch { /* closing anyway */ }
  }
  if (process.platform !== 'darwin') app.quit();
});
