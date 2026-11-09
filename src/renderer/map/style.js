// Basemaps and style changes, as on the phone (map/MapStyleFactory.kt,
// map/MapStyleCoordinator.kt): Dark and OpenStreetMap are OpenFreeMap's styles,
// Custom is the user's own tile link, None a blank canvas. With no internet
// an online basemap is swapped for the blank canvas at once, and comes back
// when the connection does.

import { prefs, log, isOnline } from '../core.js';

export const BasemapType = { DARK: 'dark', OSM: 'osm', CUSTOM: 'custom', NONE: 'none' };

const DARK_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
const OSM_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const EMPTY_BACKGROUND = '#111418';
export const OVERLAY_ANCHOR = 'overlay-anchor';

export const requiresNetwork = (type) => type === BasemapType.DARK || type === BasemapType.OSM;

function emptyStyle() {
  return { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': EMPTY_BACKGROUND } }] };
}

function customStyle(url) {
  return {
    version: 8,
    sources: { custom: { type: 'raster', tiles: [url], tileSize: 256, maxzoom: 22 } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': EMPTY_BACKGROUND } },
      { id: 'custom', type: 'raster', source: 'custom' }
    ]
  };
}

function styleFor(type, customUrl) {
  if (type === BasemapType.DARK) return DARK_STYLE_URL;
  if (type === BasemapType.OSM) return OSM_STYLE_URL;
  if (type === BasemapType.CUSTOM && customUrl) return customStyle(customUrl);
  return emptyStyle();
}

export class StyleCoordinator {
  /**
   * callbacks: onInstalled() after each style (re-add everything drawn on
   * it), onMessage(text), onAttribution(text), overlayCredits() → [strings],
   * extraCredits() → [strings].
   */
  constructor(map, callbacks) {
    this.map = map;
    this.callbacks = callbacks;
    this.currentType = prefs.getString('last_basemap', BasemapType.DARK);
    this.customUrl = prefs.getString('custom_basemap_url', '');
    this.customAttribution = prefs.getString('custom_basemap_attribution', '');
    // A saved "custom" choice means nothing without a link.
    if (this.currentType === BasemapType.CUSTOM && !this.customUrl) this.currentType = BasemapType.DARK;
    this.usingOfflineFallback = false;
    this.generation = 0;

    map.on('error', (e) => {
      // The online style document failing to load: fall back to the blank canvas.
      const status = e?.error?.status;
      const url = e?.error?.url || '';
      if (this.pendingRemote && (url.includes('tiles.openfreemap.org/styles/') || status === undefined) && !this.map.isStyleLoaded()) {
        this.handleStyleLoadFailure();
      }
    });
  }

  get hasCustom() {
    return Boolean(this.customUrl);
  }

  saveCustomBasemap(url, attribution) {
    this.customUrl = url;
    this.customAttribution = attribution;
    prefs.put('custom_basemap_url', url);
    prefs.put('custom_basemap_attribution', attribution);
  }

  clearCustomBasemap() {
    this.customUrl = '';
    this.customAttribution = '';
    prefs.remove('custom_basemap_url');
    prefs.remove('custom_basemap_attribution');
    if (this.currentType === BasemapType.CUSTOM) this.rebuild(BasemapType.DARK);
  }

  /** Falls back off "custom" when no link has been set. */
  resolveType(requested) {
    if (requested !== BasemapType.CUSTOM || this.customUrl) return requested;
    this.callbacks.onMessage('Set a custom basemap link in Settings first');
    return this.currentType === BasemapType.CUSTOM ? BasemapType.DARK : this.currentType;
  }

  async rebuild(requested = this.currentType) {
    const type = this.resolveType(requested);
    this.currentType = type;
    prefs.put('last_basemap', type);
    const generation = ++this.generation;
    this.pendingRemote = requiresNetwork(type);
    log('SeaBathyStyle', `rebuild: type=${type} remote=${this.pendingRemote} generation=${generation}`);

    if (this.pendingRemote && !(await isOnline())) {
      if (generation !== this.generation) return;
      this.usingOfflineFallback = true;
      this.pendingRemote = false;
      log('SeaBathyStyle', 'rebuild: offline, using the offline style straight away');
      this.callbacks.onMessage("No internet — showing your own layers. The online basemap comes back when you're connected.");
      this.apply(emptyStyle(), generation);
      return;
    }
    this.usingOfflineFallback = false;
    this.apply(styleFor(type, this.customUrl), generation);
  }

  apply(style, generation) {
    const camera = { center: this.map.getCenter(), zoom: this.map.getZoom(), bearing: this.map.getBearing(), pitch: this.map.getPitch() };
    this.map.once('style.load', () => {
      if (generation !== this.generation) return;
      this.pendingRemote = false;
      // Some styles set their own centre and zoom when they load; the view is put back.
      this.map.jumpTo(camera);
      this.installAnchor();
      this.callbacks.onInstalled();
      this.refreshAttribution();
    });
    this.map.setStyle(style, { diff: false });
  }

  /** Everything the app adds goes below this, so it sits above the basemap. */
  installAnchor() {
    if (!this.map.getLayer(OVERLAY_ANCHOR)) {
      this.map.addLayer({ id: OVERLAY_ANCHOR, type: 'background', paint: { 'background-opacity': 0 } });
    }
  }

  handleStyleLoadFailure() {
    if (this.usingOfflineFallback) return;
    log('SeaBathyStyle', 'handleStyleLoadFailure: falling back to offline style');
    this.usingOfflineFallback = true;
    this.pendingRemote = false;
    this.callbacks.onMessage("Couldn't load the online basemap (no internet, or the basemap address isn't working) — showing offline layers only");
    this.apply(emptyStyle(), ++this.generation);
  }

  /** The internet is back: swap the offline canvas for the chosen basemap. */
  onConnectivityRestored() {
    if (!this.usingOfflineFallback || !requiresNetwork(this.currentType)) return;
    log('SeaBathyStyle', `connectivity restored: reloading the ${this.currentType} basemap`);
    this.rebuild(this.currentType);
  }

  baseAttribution() {
    if (this.usingOfflineFallback) return null;
    if (this.currentType === BasemapType.DARK || this.currentType === BasemapType.OSM) return 'OpenFreeMap © OpenMapTiles • © OpenStreetMap contributors';
    if (this.currentType === BasemapType.CUSTOM) {
      const text = this.customAttribution.trim() || 'Custom online tiles';
      // Esri's terms ask for "Powered by Esri" with any of its basemaps.
      return /arcgis/i.test(this.customUrl) && !/Powered by Esri/i.test(text) ? `${text} · Powered by Esri` : text;
    }
    return null;
  }

  /** Recomputes the credit line from the basemap and visible overlays. */
  refreshAttribution() {
    const credits = [this.baseAttribution(), ...this.callbacks.overlayCredits(), ...this.callbacks.extraCredits()].filter(Boolean);
    this.callbacks.onAttribution([...new Set(credits)].join(' • '));
  }
}
