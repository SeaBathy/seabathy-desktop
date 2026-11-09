// What the sea-condition colours show and how, as on the phone
// (conditions/ConditionsPicture.kt): layer and direction choices, colour
// scales, and the colour picture laid out on the web-Mercator map.

import { ForecastField as F, SatelliteKind } from './data.js';

export const ColourChoice = {
  NONE: { name: 'NONE', label: 'None', forecast: false },
  CURRENT: { name: 'CURRENT', label: 'Current speed', forecast: true, fixedRange: true },
  WAVES: { name: 'WAVES', label: 'Wave height', forecast: true, fixedRange: true },
  SWELL: { name: 'SWELL', label: 'Swell height', forecast: true, fixedRange: true },
  WIND: { name: 'WIND', label: 'Wind speed', forecast: true, fixedRange: true },
  SEA_TEMP_SATELLITE: { name: 'SEA_TEMP_SATELLITE', label: 'Sea temperature (satellite)', forecast: false, satellite: SatelliteKind.SEA_TEMP, isTemperature: true },
  SEA_TEMP_BREAKS: { name: 'SEA_TEMP_BREAKS', label: 'Temperature breaks (satellite)', forecast: false, satellite: SatelliteKind.SEA_TEMP },
  SEA_TEMP_FORECAST: { name: 'SEA_TEMP_FORECAST', label: 'Sea temperature (forecast)', forecast: true, isTemperature: true },
  TEMP_BELOW: { name: 'TEMP_BELOW', label: 'Temperature below the surface (model)', forecast: false, satellite: SatelliteKind.TEMP_BELOW, isTemperature: true },
  CHLOROPHYLL: { name: 'CHLOROPHYLL', label: 'Chlorophyll (satellite, 5-day blend)', forecast: false, satellite: SatelliteKind.CHLOROPHYLL },
  SEA_LEVEL: { name: 'SEA_LEVEL', label: 'Sea level, eddies (satellite altimetry)', forecast: false, satellite: SatelliteKind.SEA_LEVEL },
  SALINITY: { name: 'SALINITY', label: 'Salinity (satellite)', forecast: false, satellite: SatelliteKind.SALINITY }
};
export const COLOUR_CHOICES = Object.values(ColourChoice);

/** Which way the flow lines (or arrows) show things moving. */
export const ArrowChoice = {
  SAME: { name: 'SAME', label: 'Same as the map layer', short: '' },
  CURRENT: { name: 'CURRENT', label: 'Current', short: 'current flow', reference: 1.5, fields: [F.CURRENT_U, F.CURRENT_V] },
  WIND: { name: 'WIND', label: 'Wind', short: 'wind flow', reference: 15.0, fields: [F.WIND_U, F.WIND_V] },
  WAVES: { name: 'WAVES', label: 'Waves', short: 'wave flow', reference: 3.0, fields: [F.WAVE_U, F.WAVE_V] },
  SWELL: { name: 'SWELL', label: 'Swell', short: 'swell flow', reference: 3.0, fields: [F.SWELL_U, F.SWELL_V] },
  NONE: { name: 'NONE', label: 'Off', short: '' }
};
export const ARROW_CHOICES = Object.values(ArrowChoice);

/** What SAME stands for with [layer] on the map: wind for wind, waves for waves, the current for the rest. */
export function resolveArrow(choice, layer) {
  if (choice !== ArrowChoice.SAME) return choice;
  if (layer === ColourChoice.WIND) return ArrowChoice.WIND;
  if (layer === ColourChoice.WAVES) return ArrowChoice.WAVES;
  if (layer === ColourChoice.SWELL) return ArrowChoice.SWELL;
  return ArrowChoice.CURRENT;
}

/** How the direction is drawn. */
export const DirectionStyle = {
  FLOW: { name: 'FLOW', label: 'Moving lines', arrows: false, flow: true },
  ARROWS: { name: 'ARROWS', label: 'Arrows', arrows: true, flow: false },
  BOTH: { name: 'BOTH', label: 'Moving lines and arrows', arrows: true, flow: true },
  NONE: { name: 'NONE', label: 'Off', arrows: false, flow: false }
};
export const DIRECTION_STYLES = Object.values(DirectionStyle);

const KNOTS_PER_MS = 1.943844;

/** Dark blue through cyan, green and yellow to red: easy to read in sunlight. */
const SPECTRUM = [0x30123b, 0x4662d7, 0x36aaf9, 0x1ae4b6, 0x72fe5e, 0xc8ef34, 0xfaba39, 0xf66b19, 0xca2a04];
/** Wind as windy.com colours it: stops at 0, 1, 3, 5 … 21 m/s on a 0–21 m/s (41 kn) scale. */
const WIND_COLOURS = [0x6271b7, 0x39619f, 0x4a94a9, 0x4d8d7b, 0x53a553, 0x359f35, 0xa79d51, 0x9f7f3a, 0xa16c5c, 0x813a4e, 0xaf5088, 0x754a93];
const WIND_AT = [0, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21].map((v) => v / 21);
/** Clear blue water to green and yellow plankton-rich water. */
const PLANKTON = [0x1b2a6b, 0x1f5fa8, 0x1f9aa6, 0x2db36b, 0x8ccb3a, 0xe5d93a, 0xb5651d];
/** Blue below the average, white on it, red above. */
const DIVERGING = [0x1b3a8c, 0x3b82c4, 0x9ccbe6, 0xf4f6f8, 0xf5b7a0, 0xd9543c, 0x8e1616];
/** Calm water dark, sharp temperature breaks bright. */
const BREAKS = [0x0b1622, 0x1b3a6b, 0x2a7f9e, 0x45c4a0, 0xe5d93a, 0xf4f6f8];
/** °C per km: flat water shouldn't fill the whole colour range. */
const MIN_BREAK_RANGE = 0.05;
const MIN_SEA_LEVEL_REACH_CM = 5;

/**
 * The colour range for a layer. Speeds and heights use fixed ranges so a
 * colour always means the same; sea temperature and chlorophyll are
 * stretched to the area, so a 1 °C temperature break shows.
 */
export class ColourScale {
  constructor(low, high, logarithmic, stops, at = null) {
    Object.assign(this, { low, high, logarithmic, stops, at });
  }

  /** 0..1 along the scale. */
  position(value) {
    if (!Number.isFinite(value)) return NaN;
    const t = this.logarithmic
      ? (value <= 0 ? 0 : (Math.log10(value) - Math.log10(this.low)) / (Math.log10(this.high) - Math.log10(this.low)))
      : (value - this.low) / (this.high - this.low);
    return Math.min(1, Math.max(0, t));
  }

  /** [r, g, b] at t (0..1). */
  colourAt(t) {
    const u = Math.min(1, Math.max(0, t));
    const stops = this.stops;
    let i;
    let f;
    if (!this.at) {
      const scaled = u * (stops.length - 1);
      i = Math.min(stops.length - 2, Math.trunc(scaled));
      f = scaled - i;
    } else {
      i = 0;
      for (let k = 0; k < this.at.length; k++) if (this.at[k] <= u) i = k;
      i = Math.min(stops.length - 2, Math.max(0, i));
      f = Math.min(1, Math.max(0, (u - this.at[i]) / (this.at[i + 1] - this.at[i])));
    }
    const a = stops[i];
    const b = stops[i + 1];
    const mix = (shift) => Math.round(((a >> shift) & 0xff) * (1 - f) + ((b >> shift) & 0xff) * f);
    return [mix(16), mix(8), mix(0)];
  }

  /** The value at t (0..1) along the scale, for legend labels. */
  valueAt(t) {
    return this.logarithmic
      ? 10 ** (Math.log10(this.low) + (Math.log10(this.high) - Math.log10(this.low)) * t)
      : this.low + (this.high - this.low) * t;
  }

  /** For [choice] over [values] (the area's numbers, for the stretched layers), in display units. */
  static forChoice(choice, values = null) {
    switch (choice) {
      case ColourChoice.CURRENT: return new ColourScale(0, 3, false, SPECTRUM);
      case ColourChoice.WAVES:
      case ColourChoice.SWELL: return new ColourScale(0, 4, false, SPECTRUM);
      case ColourChoice.WIND: return new ColourScale(0, 21 * KNOTS_PER_MS, false, WIND_COLOURS, WIND_AT);
      case ColourChoice.SEA_TEMP_SATELLITE:
      case ColourChoice.SEA_TEMP_FORECAST:
      case ColourChoice.TEMP_BELOW: {
        const [lo, hi] = stretch(values, 1) || [10, 30];
        return new ColourScale(lo, hi, false, SPECTRUM);
      }
      case ColourChoice.SEA_TEMP_BREAKS: {
        const [, hi] = stretch(values, 0) || [0, 0.1];
        return new ColourScale(0, Math.max(hi, MIN_BREAK_RANGE), false, BREAKS);
      }
      // Even about the average, so white always means average.
      case ColourChoice.SEA_LEVEL: {
        const [lo, hi] = stretch(values, 0) || [-20, 20];
        const reach = Math.max(Math.abs(lo), Math.abs(hi), MIN_SEA_LEVEL_REACH_CM);
        return new ColourScale(-reach, reach, false, DIVERGING);
      }
      case ColourChoice.SALINITY: {
        const [lo, hi] = stretch(values, 0.5) || [33, 37];
        return new ColourScale(lo, hi, false, SPECTRUM);
      }
      case ColourChoice.CHLOROPHYLL: {
        const logs = values && Float32Array.from(values, (v) => (v > 0 ? Math.log10(v) : NaN));
        const [lo, hi] = stretch(logs, 0.5) || [-1.5, 1];
        return new ColourScale(10 ** lo, 10 ** hi, true, PLANKTON);
      }
      default: return new ColourScale(0, 1, false, SPECTRUM);
    }
  }

  /** A range set by hand for the temperatures, in °C. */
  static temperatureRange(lowCelsius, highCelsius) {
    return new ColourScale(lowCelsius, highCelsius, false, SPECTRUM);
  }
}

/** The 2nd to 98th percentile of [values], widened to at least [minSpan]. */
export function stretch(values, minSpan) {
  if (!values) return null;
  const finite = Float32Array.from(values).filter(Number.isFinite).sort();
  if (!finite.length) return null;
  let lo = finite[Math.min(finite.length - 1, Math.trunc(finite.length * 0.02))];
  let hi = finite[Math.min(finite.length - 1, Math.trunc(finite.length * 0.98))];
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  return [lo, hi];
}

export const mercatorY = (lat) => Math.log(Math.tan(Math.PI / 4 + ((Math.min(85, Math.max(-85, lat)) * Math.PI) / 180) / 2));
export const latitudeOf = (y) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;

/**
 * The colour picture of a layer for an area, as RGBA pixels laid out on the
 * web-Mercator map (rows evenly spaced in map height), so it lines up when
 * the map stretches it over the area's corners. sampler(lat, lng) gives the
 * value in display units, or NaN.
 */
export function renderPicture(south, west, north, east, maxSide, scale, sampler, alpha = 255) {
  const yTop = mercatorY(north);
  const yBottom = mercatorY(south);
  const widthDeg = east - west;
  const mapWidth = (widthDeg * Math.PI) / 180;
  const mapHeight = yTop - yBottom;
  let width;
  let height;
  if (mapWidth >= mapHeight) {
    width = maxSide;
    height = Math.max(2, Math.round((maxSide * mapHeight) / mapWidth));
  } else {
    height = maxSide;
    width = Math.max(2, Math.round((maxSide * mapWidth) / mapHeight));
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const lat = latitudeOf(yTop - ((y + 0.5) / height) * mapHeight);
    for (let x = 0; x < width; x++) {
      const t = scale.position(sampler(lat, west + ((x + 0.5) / width) * widthDeg));
      if (Number.isNaN(t)) continue;
      const [r, g, b] = scale.colourAt(t);
      const i = (y * width + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = alpha;
    }
  }
  return { width, height, rgba };
}
