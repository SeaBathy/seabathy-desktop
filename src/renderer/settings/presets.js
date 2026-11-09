// The phone's fixed choices: GeoTIFF quality (settings/RasterQuality.kt) and
// ready-made online map layers (settings/XyzTilePresets.kt).

import { prefs } from '../core.js';

/** maxDimension: the overview's longest edge; tilePixels: detail tile size. */
export const RASTER_QUALITIES = [
  { id: 'battery', label: 'Battery saver', detail: 'older or low-memory computers', maxDimension: 1024, tilePixels: 256 },
  { id: 'standard', label: 'Standard', detail: 'most computers', maxDimension: 1600, tilePixels: 384 },
  { id: 'high', label: 'High', detail: 'sharp — needs more memory', maxDimension: 2560, tilePixels: 512 },
  { id: 'maximum', label: 'Maximum', detail: 'full detail — recent computers', maxDimension: 4096, tilePixels: 768 }
];

/** The saved quality; a PC starts at High. */
export function rasterQuality() {
  return RASTER_QUALITIES.find((q) => q.id === prefs.getString('raster_quality')) || RASTER_QUALITIES[2];
}

const GIBS_CREDIT = "Imagery: NASA Global Imagery Browse Services (GIBS), part of NASA's ESDIS";
/** NASA's daily picture of the world: "default" is always the latest. */
const gibsTrueColour = (layer) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/default/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;

export const XYZ_PRESETS = [
  {
    id: 'esri_world_imagery', label: 'Esri World Imagery', description: 'High resolution satellite and aerial imagery',
    urlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community · Powered by Esri', category: 'SATELLITE', maxZoom: 19
  },
  {
    id: 'gibs_true_colour_n20', label: 'Latest true colour (NOAA-20)',
    description: "Yesterday or today's satellite pass, about 250 m: water colour, clouds, river plumes. Worldwide",
    urlTemplate: gibsTrueColour('VIIRS_NOAA20_CorrectedReflectance_TrueColor'), attribution: GIBS_CREDIT, category: 'SATELLITE', maxZoom: 9
  },
  {
    id: 'gibs_true_colour_n21', label: 'Latest true colour (NOAA-21)',
    description: 'The same from another satellite, passing at another time: try it if clouds hide the first',
    urlTemplate: gibsTrueColour('VIIRS_NOAA21_CorrectedReflectance_TrueColor'), attribution: GIBS_CREDIT, category: 'SATELLITE', maxZoom: 9
  },
  {
    id: 'esri_world_ocean', label: 'Esri Ocean Basemap', description: 'Bathymetric shaded relief and ocean features',
    urlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Esri, GEBCO, NOAA, National Geographic · Powered by Esri', category: 'NAUTICAL', maxZoom: 13
  },
  {
    id: 'usgs_imagery', label: 'USGS Imagery', description: 'Public domain aerial imagery, best over the USA',
    urlTemplate: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    attribution: 'USGS The National Map', category: 'SATELLITE', maxZoom: 16
  },
  {
    id: 'openstreetmap', label: 'OpenStreetMap', description: 'Standard OSM street map',
    urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '(c) OpenStreetMap contributors', category: 'STREET', maxZoom: 19
  },
  {
    id: 'opentopomap', label: 'OpenTopoMap', description: 'Topographic contours and hillshading',
    urlTemplate: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '(c) OpenStreetMap contributors, SRTM, OpenTopoMap (CC-BY-SA)', category: 'TOPOGRAPHIC', maxZoom: 17
  },
  {
    id: 'esri_world_topo', label: 'Esri World Topographic', description: 'Land detail, roads and place names',
    urlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Esri, HERE, Garmin, USGS, NGA · Powered by Esri', category: 'TOPOGRAPHIC', maxZoom: 19
  }
];

/** Why a tile link won't work, or null when it will. */
export function xyzValidationError(urlTemplate) {
  const url = urlTemplate.trim();
  if (!url) return 'Enter an XYZ tile URL';
  if (!/^https?:\/\//i.test(url)) return 'URL must start with http:// or https://';
  if (!url.includes('{z}') || !url.includes('{x}') || !url.includes('{y}')) return 'URL must contain {z}, {x} and {y}';
  return null;
}
