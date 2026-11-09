// The feature modules the chart screen hands work to. Each is optional and
// may define: onStyleInstalled(), onConnectivityRestored(), credits().

import * as depthColours from './features/depthColours.js';
import * as terrain from './features/terrain.js';
import * as conditions from './features/conditions.js';
import * as tides from './features/tides.js';
import * as maps from './features/maps.js';
import * as route from './features/route.js';
import * as seabed from './features/seabed.js';

/** Every feature module, in start-up order. */
const MODULES = [depthColours, terrain, tides, conditions, maps, route, seabed];

const registry = [];

export const features = {
  route: null,
  tides: null,
  conditions: null,
  terrain: null,
  depthColours: null,
  onlineMaps: null,
  offlineMaps: null,
  gpx: null,
  seabed: null,

  async init(app) {
    for (const module of MODULES) {
      // A module may hand back more than one feature (route also gives gpx).
      for (const feature of [await module.create(app)].flat()) {
        if (feature?.name) this[feature.name] = feature;
        registry.push(feature);
      }
    }
    this.offlineMaps = this.onlineMaps?.offline || null;
  },

  all() {
    return registry;
  },

  credits() {
    return registry.flatMap((f) => f.credits?.() || []);
  },

  onMapClick(lat, lng) {
    for (const f of registry) f.onMapClick?.(lat, lng);
  },

  onLayersChanged() {
    for (const f of registry) f.onLayersChanged?.();
  }
};
