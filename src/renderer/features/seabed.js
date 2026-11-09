// Free depth data for anywhere in the world, as a GeoTIFF the app opens like
// any survey, as on the phone (storage/SeabedDownload.kt): GMRT (Global
// Multi-Resolution Topography, CC BY 4.0), which blends ship surveys with the
// GEBCO grid. Its server picks the finest detail that fits about 55 MB, so a
// small area comes sharper than a big one.

import { api, toast, log, logError, isOnline } from '../core.js';
import { confirm } from '../ui/panels.js';
import { loadGeoTiff, setLoading } from '../app.js';

export const SEABED_CREDIT = 'Depths: GMRT, Ryan et al. 2009 (CC BY 4.0)';
const MAX_SPAN_DEG = 4;
const MAX_SPAN_KM = 440;
/** Zoomed right in, still enough around the crosshair to be useful. */
const MIN_SPAN_DEG = 0.25;
const MAX_LAT = 85;
const MAX_LNG = 180;

/** The area to ask for, from what's on screen; east may be past 180 when the date line is on screen. */
export function seabedArea(south, west, north, east, centreLat, centreLng) {
  let w = west;
  let e = east;
  // Back into -180..180, on the crosshair's side of the date line.
  const centre = ((centreLng + 540) % 360) - 180;
  const shift = centre - centreLng;
  w += shift;
  e += shift;
  if (e > MAX_LNG) e = MAX_LNG;
  if (w < -MAX_LNG) w = -MAX_LNG;
  const trimmed = north - south > MAX_SPAN_DEG || e - w > MAX_SPAN_DEG;
  const fit = (lo, hi, middle) => {
    const span = Math.min(MAX_SPAN_DEG, Math.max(MIN_SPAN_DEG, hi - lo));
    const at = hi - lo > MAX_SPAN_DEG ? middle : (lo + hi) / 2;
    return [at - span / 2, at + span / 2];
  };
  const [s, n] = fit(south, north, centreLat);
  const [a, b] = fit(w, e, centre);
  return {
    south: Math.max(-MAX_LAT, s), west: Math.max(-MAX_LNG, a),
    north: Math.min(MAX_LAT, n), east: Math.min(MAX_LNG, b), trimmed
  };
}

/** "Seabed 18.05S 146.55E (0.30°)": the same area gets the same file. */
export function seabedName(area) {
  const lat = (area.south + area.north) / 2;
  const lng = (area.west + area.east) / 2;
  return `Seabed ${Math.abs(lat).toFixed(2)}${lat < 0 ? 'S' : 'N'} ${Math.abs(lng).toFixed(2)}${lng < 0 ? 'W' : 'E'} (${Math.max(area.north - area.south, area.east - area.west).toFixed(2)}°)`;
}

export const seabedUrl = (a) => 'https://www.gmrt.org/services/GridServer?' +
  `north=${a.north.toFixed(5)}&south=${a.south.toFixed(5)}&east=${a.east.toFixed(5)}&west=${a.west.toFixed(5)}&layer=topo&format=geotiff&resolution=high`;

export function create(app) {
  async function show() {
    const c = app.map.getCenter();
    const b = app.map.getBounds();
    const area = seabedArea(b.getSouth(), b.getWest(), b.getNorth(), b.getEast(), c.lat, c.lng);
    const note = area.trimmed ? ` The most one download holds is about ${MAX_SPAN_KM} km across, so this is the middle of the screen.` : '';
    confirm(
      'Get seabed depths?',
      'Downloads depths for the area on screen from GMRT, which blends ship surveys with the global GEBCO grid, and adds them as a layer that also works in 3D and offline. ' +
        `Detail is best where ships have surveyed; elsewhere it's much coarser. Up to about 55 MB.${note} Not for navigation.`,
      () => download(area),
      { confirmLabel: 'Download', destructive: false }
    );
  }

  async function download(area) {
    if (!(await isOnline())) {
      toast('No internet: the seabed depths need a connection to download');
      return;
    }
    const name = seabedName(area);
    log('Seabed', `download ${name}`);
    setLoading('Seabed depths', 'Downloading the depths… this can take a minute');
    let result;
    try {
      result = await api.downloadSeabed(seabedUrl(area), name);
    } catch (error) {
      logError('Seabed', 'download FAILED', error);
      result = { ok: false, message: error.message };
    } finally {
      setLoading(null);
    }
    if (!result.ok) {
      toast(result.message || "Couldn't get the seabed depths");
      return;
    }
    const existing = app.overlays.layers.find((l) => l.source === result.info.path);
    if (existing) {
      if (!existing.visible) app.overlays.setVisible(existing.id, true);
      const bounds = app.overlays.boundsOf(existing.id);
      if (bounds) app.map.fitBounds([[bounds.west, bounds.south], [bounds.east, bounds.north]], { padding: 48 });
      toast(`${existing.name} is already loaded`);
      return;
    }
    await loadGeoTiff(result.info, { attribution: SEABED_CREDIT });
  }

  return { name: 'seabed', show };
}
