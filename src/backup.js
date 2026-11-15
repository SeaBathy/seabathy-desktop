'use strict';

// Backup and restore for SeaBathy Desktop (main process). A backup is a zip
// with seabathy-backup.json, the same format the phone app uses: a Desktop
// backup holds this app's saved lists and settings, plus its waypoints and
// routes in the phone's shape ("portable") so the phone can add them. A
// phone backup restored here adds its waypoints and routes.
//
// The daily backup goes to a folder the user picks (a OneDrive or Google
// Drive folder works). Its state lives in its own file, not in the
// renderer's settings, so the two never overwrite each other.

const fsp = require('fs/promises');
const path = require('path');
const { readZip, writeZip } = require('./zip.js');

const FORMAT = 1;
const MANIFEST = 'seabathy-backup.json';
/** Lists and settings that go into a backup; map layers point at this PC's own files, so they stay out. */
const STORES = ['prefs', 'waypoints', 'routes', 'tracks', 'sources', 'places', 'settings'];
const PREFIX = 'SeaBathy-Desktop-backup-';
const KEEP = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

function create({ readStore, writeStore, dataDir, version }) {
  const statePath = () => path.join(dataDir(), 'backup-state.json');
  let pending = null; // a backup chosen to restore: { manifest }

  async function state() {
    try {
      return JSON.parse(await fsp.readFile(statePath(), 'utf8'));
    } catch {
      return {};
    }
  }

  async function saveState(s) {
    await fsp.mkdir(dataDir(), { recursive: true });
    await fsp.writeFile(statePath(), JSON.stringify(s));
  }

  async function build(now = Date.now()) {
    const stores = {};
    for (const name of STORES) stores[name] = await readStore(name);
    const waypoints = (Array.isArray(stores.waypoints) ? stores.waypoints : []).map(({ photos, ...w }) => w);
    const routes = (Array.isArray(stores.routes) ? stores.routes : []).map((r) => ({
      id: r.id, name: r.name, updatedMillis: now,
      points: (r.points || []).map((p) => ({ lat: p.lat, lng: p.lng, name: p.name || null }))
    }));
    const manifest = {
      format: FORMAT, app: 'desktop', appVersion: version, created: now,
      waypoints: waypoints.length, routes: routes.length,
      stores,
      portable: { wpts: JSON.stringify(waypoints), saved_routes: JSON.stringify(routes) }
    };
    return writeZip([{ name: MANIFEST, data: JSON.stringify(manifest) }]);
  }

  /** Reads a backup file and keeps it ready to restore; returns its summary, or throws if it isn't one. */
  async function open(file) {
    const entries = readZip(await fsp.readFile(file));
    const entry = entries.find((e) => e.name === MANIFEST);
    if (!entry) throw new Error("That isn't a SeaBathy backup");
    const manifest = JSON.parse(entry.data.toString('utf8'));
    if (!(manifest.format >= 1 && manifest.format <= FORMAT)) throw new Error('That backup is from a newer SeaBathy');
    if (manifest.app !== 'desktop' && manifest.app !== 'android') throw new Error("That isn't a SeaBathy backup");
    pending = { manifest };
    const count = (json) => { try { return JSON.parse(json || '[]').length; } catch { return 0; } };
    const phone = manifest.app === 'android';
    return {
      app: manifest.app,
      created: manifest.created || 0,
      waypoints: phone ? count(manifest.settings?.wpts?.v) : manifest.waypoints || 0,
      routes: phone ? count(manifest.settings?.saved_routes?.v) : manifest.routes || 0
    };
  }

  /** Restores the backup [open] read. A Desktop backup replaces; a phone one adds. */
  async function apply() {
    const manifest = pending?.manifest;
    pending = null;
    if (!manifest) throw new Error('No backup chosen');
    if (manifest.app === 'desktop') {
      for (const name of STORES) {
        if (manifest.stores?.[name] !== undefined && manifest.stores[name] !== null) await writeStore(name, manifest.stores[name]);
      }
      return;
    }
    const parse = (json) => { try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
    const merge = (ours, theirs) => {
      const list = Array.isArray(ours) ? [...ours] : [];
      const ids = new Set(list.map((x) => x.id));
      for (const x of theirs) if (x && x.id && !ids.has(x.id)) { ids.add(x.id); list.push(x); }
      return list;
    };
    // Photos stay on the phone: their files aren't in a Desktop's data.
    const waypoints = parse(manifest.settings?.wpts?.v)
      .filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng))
      .map(({ photos, ...w }) => w);
    const routes = parse(manifest.settings?.saved_routes?.v)
      .map((r) => ({ id: r.id, name: r.name, points: (r.points || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)) }))
      .filter((r) => r.points.length >= 2);
    await writeStore('waypoints', merge(await readStore('waypoints'), waypoints));
    await writeStore('routes', merge(await readStore('routes'), routes));
  }

  /** Saves a backup into the chosen folder if one is due, keeping the newest [KEEP]. */
  async function autoBackup(force = false) {
    const s = await state();
    if (!s.folder) return false;
    const now = Date.now();
    if (!force && now - (s.last || 0) < DAY_MS) return false;
    const name = `${PREFIX}${day(now)}.zip`;
    await fsp.writeFile(path.join(s.folder, name), await build(now));
    await saveState({ ...s, last: now });
    const old = (await fsp.readdir(s.folder)).filter((n) => n.startsWith(PREFIX) && n.endsWith('.zip') && n !== name).sort().reverse();
    for (const n of old.slice(KEEP - 1)) await fsp.unlink(path.join(s.folder, n)).catch(() => {});
    return true;
  }

  return {
    build,
    open,
    apply,
    autoBackup,
    status: state,
    async setFolder(folder) {
      await saveState(folder ? { folder, last: 0 } : {});
      if (folder) await autoBackup(true);
    },
    defaultName: () => `${PREFIX}${day(Date.now())}.zip`
  };
}

module.exports = { create };
