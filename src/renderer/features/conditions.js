// Sea conditions for fishing, as on the phone (conditions/ConditionsFeature.kt):
// currents (tidal flow included), waves, swell and wind forecast hourly for
// up to 8 days, plus satellite sea temperature and chlorophyll. Downloaded
// and saved, so it works offline. Shown as a colour layer and moving lines
// over the chart, a time slider, and a values box. A PC has no GPS, so the
// spot is one picked on the map.

import { prefs, toast, log, logError, isOnline } from '../core.js';
import { el, body, sectionHeader, caption, row, addRow, input, showPanel, showChoicePanel, confirm } from '../ui/panels.js';
import { NavFormat, loadNavSettings, SeaSpeedUnit, seaSpeed } from '../nav/units.js';
import { ForecastField as F, HOUR_MS, GeoGrid, ConditionsArea, SatelliteKind, MAX_AGE_MS, MAX_LAT, MAX_LNG, DEFAULT_BELOW_DEPTH_M, needsUpdate, newestCovering, toRemove } from '../conditions/data.js';
import * as client from '../conditions/client.js';
import { ConditionsStore } from '../conditions/store.js';
import { ColourChoice, COLOUR_CHOICES, ArrowChoice, resolveArrow, DirectionStyle, DIRECTION_STYLES, ColourScale, renderPicture } from '../conditions/picture.js';
import { FlowLines } from '../conditions/flowLines.js';
import { OVERLAY_ANCHOR } from '../map/style.js';

const TAG = 'SeaBathyConditions';
const KEY_SHOWN = 'conditions_shown';
const KEY_AREA = 'conditions_area';
const KEY_COLOUR = 'conditions_colour';
const KEY_OPACITY = 'conditions_opacity';
const KEY_DAYS = 'conditions_days';
const KEY_SATELLITE = 'conditions_satellite';
const KEY_STYLE = 'conditions_direction_style';
const KEY_BOX = 'conditions_box';
const KEY_SPOT = 'conditions_spot';
const KEY_AUTO_HOURS = 'conditions_update_hours';
const KEY_BOX_OPEN = 'conditions_box_open';
const KEY_BELOW_DEPTH = 'conditions_below_depth_m';
const KEY_TEMP_RANGE = 'conditions_temperature_range';
/** Depths the ocean model reports exactly, in metres. */
const BELOW_DEPTHS = [10, 20, 30, 50, 100, 150, 200, 300];

/** How often, at most, to ask whether there's a new forecast. */
const RUN_CHECK_MS = 15 * 60_000;
const STARTUP_DOWNLOAD_DELAY_MS = 8_000;
const ONLINE_CHECK_MS = 5_000;
const CLOSED_MARK = '▾';
const OPEN_MARK = '▴';
const ROW_ORDER = ['Wind', 'Current', 'Waves', 'Swell', 'Sea', 'Water'];
/** What "Show on the map" offers (the forecast's own sea temperature is left out: the satellite's is better). */
const MAP_CHOICES = [
  ColourChoice.WIND, ColourChoice.CURRENT, ColourChoice.WAVES, ColourChoice.SWELL,
  ColourChoice.SEA_TEMP_SATELLITE, ColourChoice.SEA_TEMP_BREAKS, ColourChoice.TEMP_BELOW,
  ColourChoice.CHLOROPHYLL, ColourChoice.SEA_LEVEL, ColourChoice.SALINITY
];
/** The area kept round the spot has this id, so each update replaces it. */
export const SPOT_ID = 'spot';
const SPOT_NAME = 'Round my spot';
const SPOT_RADIUS_KM = 200;
const AUTO_RETRY_MS = 15 * 60_000;
const IMAGE_SOURCE = 'conditions-image-src';
const IMAGE_LAYER = 'conditions-image';
const ARROW_SOURCE = 'conditions-arrows-src';
const ARROW_LAYER = 'conditions-arrows';
const ARROW_IMAGE = 'conditions-arrow';
const KNOTS_PER_MS = 1.943844;
/** Largest area: about 500 km a side, so the forecast points stay close enough to be useful. */
const MAX_SPAN_DEG = 4.5;
const MIN_SPAN_DEG = 0.3;
/** The current model is about 0.08° apart; closer points add nothing. */
const MIN_STEP_DEG = 0.08;
const MAX_POINTS_PER_SIDE = 16;
const MAX_WIND_POINTS_PER_SIDE = 10;
/** Between downloads, so two never land in the same minute of Open-Meteo's limit. */
const MIN_DOWNLOAD_GAP_MS = 75_000;
const MAX_ARROWS_PER_SIDE = 12;
const BOX_ROWS = 6;
const PLAY_STEP_MS = 650;
const FORECAST_PICTURE_SIDE = 320;
const MAX_PICTURE_SIDE = 512;
/** The forecast picture is redrawn as the time moves on by this much. */
const PICTURE_STEP_MS = 10 * 60_000;
const TICK_MS = 5 * 60_000;
const OWN_FLOW = new Set([ColourChoice.WIND, ColourChoice.WAVES, ColourChoice.SWELL, ColourChoice.CURRENT]);
const EMPTY = { type: 'FeatureCollection', features: [] };

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
export const day = (ms) => {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
export const clock = (ms) => {
  const d = new Date(ms);
  return `${day(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const dayText = (days) => (days === 1 ? '1 day' : `${days} days`);
const autoLabel = (hours) => (hours > 0 ? "When there's a new forecast" : 'Off (only when you click Update now)');

/** How long ago, said simply. */
export function ago(millis, nowMillis) {
  const minutes = Math.floor((nowMillis - millis) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 90) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / (24 * 60))} days ago`;
}

/** South, west, north and east of a square [radiusKm] each way from lat/lng, stopping at the date line (the data services do too). */
export function boxAround(lat, lng, radiusKm) {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return [Math.max(-MAX_LAT, lat - dLat), Math.max(-MAX_LNG, lng - dLng), Math.min(MAX_LAT, lat + dLat), Math.min(MAX_LNG, lng + dLng)];
}

/** Says how old saved data is when offline (after half an hour) or when it hasn't updated for half a day. */
export function staleNote(fetchedMillis, nowMillis, online) {
  const age = nowMillis - fetchedMillis;
  if (!online && age > 30 * 60_000) return `Offline: saved data from ${ago(fetchedMillis, nowMillis)} (${clock(fetchedMillis)})`;
  if (age > MAX_AGE_MS) return `Old data: downloaded ${ago(fetchedMillis, nowMillis)}`;
  return null;
}

/** A legend number: whole above 10, one decimal below, plain 0. */
function legendSpeed(knots, unit) {
  return unit === SeaSpeedUnit.BEAUFORT ? seaSpeed(knots, unit) : legendNumber(knots * unit.perKnot, unit.label);
}

function legendNumber(value, unit) {
  if (Math.abs(value) < 0.05) return `0 ${unit}`;
  if (Math.abs(value) >= 10) return `${Math.round(value)} ${unit}`;
  return `${value.toFixed(1)} ${unit}`;
}

export function defaultName(south, west, north, east) {
  const lat = (south + north) / 2;
  const lng = (west + east) / 2;
  return `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'} ${Math.abs(lng).toFixed(2)}°${lng < 0 ? 'W' : 'E'}`;
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = (degrees) => POINTS[Math.trunc((((degrees % 360) + 360) % 360) / 45 + 0.5) % 8];

function wave(f, name, height, period, u, v, lat, lng, time, format, coastal) {
  const h = f.sample(height, lat, lng, time, coastal);
  if (!Number.isFinite(h)) return null;
  const p = f.sample(period, lat, lng, time, coastal);
  const flow = f.vector(u, v, lat, lng, time, coastal);
  return {
    towardsDegrees: flow ? flow.towardsDegrees : null,
    text: `${name} ${format.waveHeight(h)}${Number.isFinite(p) ? `, ${p.toFixed(0)} s` : ''}${flow ? ` from ${compass(flow.fromDegrees)}` : ''}`
  };
}

/**
 * The values at a point and time, in the user's units. With satellite
 * temperature saved, its coastline says where the sea is.
 */
export function values(a, lat, lng, time, format) {
  const out = [];
  const masked = Boolean(a.satellites.SEA_TEMP);
  const f = a.forecast && (!masked || a.isSea(lat, lng) !== false) ? a.forecast : null;
  if (f) {
    const current = f.vector(F.CURRENT_U, F.CURRENT_V, lat, lng, time, masked);
    if (current) out.push({ towardsDegrees: current.towardsDegrees, text: `Current ${format.current(current.speed * KNOTS_PER_MS)} to ${compass(current.towardsDegrees)}` });
    const wind = f.vector(F.WIND_U, F.WIND_V, lat, lng, time, masked);
    if (wind) {
      const gust = f.sample(F.GUST, lat, lng, time, masked);
      out.push({
        towardsDegrees: wind.towardsDegrees,
        text: `Wind ${format.wind(wind.speed * KNOTS_PER_MS)} from ${compass(wind.fromDegrees)}` +
          (Number.isFinite(gust) && gust > wind.speed * 1.15 ? `, gusts ${format.wind(gust * KNOTS_PER_MS)}` : '')
      });
    }
    for (const w of [
      wave(f, 'Waves', F.WAVE_HEIGHT, F.WAVE_PERIOD, F.WAVE_U, F.WAVE_V, lat, lng, time, format, masked),
      wave(f, 'Swell', F.SWELL_HEIGHT, F.SWELL_PERIOD, F.SWELL_U, F.SWELL_V, lat, lng, time, format, masked)
    ]) if (w) out.push(w);
  }
  const water = [];
  const satTemp = a.satellites.SEA_TEMP?.sample(lat, lng);
  const modelTemp = f?.sample(F.SEA_TEMP, lat, lng, time, masked);
  if (Number.isFinite(satTemp)) water.push(`Surface ${format.temperature(satTemp)}`);
  else if (Number.isFinite(modelTemp)) water.push(`Surface ${format.temperature(modelTemp)}`);
  const chl = a.satellites.CHLOROPHYLL?.sample(lat, lng);
  if (Number.isFinite(chl) && a.isSea(lat, lng) !== false) water.push(`chlorophyll ${chl < 1 ? chl.toFixed(2) : chl.toFixed(1)} mg/m³`);
  if (water.length) out.push({ towardsDegrees: null, text: water.join(' · ') });

  // The coarser layers: one line, as they change slowly.
  if (a.isSea(lat, lng) !== false) {
    const coarse = (name) => {
      const s = a.satellites[name];
      if (!s) return NaN;
      return masked ? s.sampleToShore(lat, lng) : s.sample(lat, lng);
    };
    const below = coarse('TEMP_BELOW');
    if (Number.isFinite(below)) out.push({ towardsDegrees: null, text: `${format.depth(a.belowDepthM)} down ${format.temperature(below)}` });
    const surface = [];
    const salinity = coarse('SALINITY');
    if (Number.isFinite(salinity)) surface.push(`Salinity ${salinity.toFixed(1)}`);
    const level = coarse('SEA_LEVEL');
    if (Number.isFinite(level)) surface.push(`sea level ${format.seaLevel(level)}`);
    if (surface.length) out.push({ towardsDegrees: null, text: surface.join(' · ') });
  }
  return out;
}

const rowNameOf = (layer) => ({
  WIND: 'Wind', CURRENT: 'Current', WAVES: 'Waves', SWELL: 'Swell',
  SEA_TEMP_SATELLITE: 'Sea', SEA_TEMP_BREAKS: 'Sea', SEA_TEMP_FORECAST: 'Sea', CHLOROPHYLL: 'Sea',
  TEMP_BELOW: 'Water', SEA_LEVEL: 'Water', SALINITY: 'Water'
}[layer.name] || null);

const layerOfRow = (name, a, showing = null) => {
  // Keeps the layer showing when it's one of this line's.
  if (name === 'Water' && showing && rowNameOf(showing) === 'Water' && a.satellites[showing.satellite?.name]) return showing;
  return ({
    Wind: ColourChoice.WIND, Current: ColourChoice.CURRENT, Waves: ColourChoice.WAVES, Swell: ColourChoice.SWELL,
    Sea: a.satellites.SEA_TEMP ? ColourChoice.SEA_TEMP_SATELLITE : ColourChoice.SEA_TEMP_FORECAST,
    Water: a.satellites.TEMP_BELOW ? ColourChoice.TEMP_BELOW : a.satellites.SEA_LEVEL ? ColourChoice.SEA_LEVEL : ColourChoice.SALINITY
  }[name] || null);
};

/** A white arrow with a dark edge, pointing up (north). */
function arrowCanvas(size = 30) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const s = size;
  ctx.beginPath();
  ctx.moveTo(s * 0.5, s * 0.06);
  ctx.lineTo(s * 0.82, s * 0.46);
  ctx.lineTo(s * 0.6, s * 0.46);
  ctx.lineTo(s * 0.6, s * 0.94);
  ctx.lineTo(s * 0.4, s * 0.94);
  ctx.lineTo(s * 0.4, s * 0.46);
  ctx.lineTo(s * 0.18, s * 0.46);
  ctx.closePath();
  ctx.lineWidth = s * 0.1;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(11,22,34,0.9)';
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fill();
  return canvas;
}

export function create(app) {
  const map = app.map;
  const store = new ConditionsStore();
  const units = () => loadNavSettings().units;
  // Units changed in the route settings: the box and the card show their values again in the new ones.
  document.addEventListener('nav-units-changed', () => {
    if (shown && area) refreshCard(area);
    updateBox();
  });

  let shown = prefs.getBoolean(KEY_SHOWN, false);
  let areaId = prefs.getString(KEY_AREA);
  let colour = ColourChoice[prefs.getString(KEY_COLOUR)] || ColourChoice.CURRENT;
  if (colour === ColourChoice.NONE) colour = ColourChoice.CURRENT;
  const arrows = ArrowChoice.SAME;
  const flow = () => resolveArrow(arrows, colour);
  let opacity = Math.min(1, Math.max(0, prefs.getNumber(KEY_OPACITY, 0.65)));
  let days = Math.min(client.MAX_DAYS, Math.max(1, prefs.getNumber(KEY_DAYS, 7)));
  let withSatellite = prefs.getBoolean(KEY_SATELLITE, true);
  /** How far down "temperature below the surface" is downloaded for, in metres. */
  let belowDepthM = prefs.getNumber(KEY_BELOW_DEPTH, DEFAULT_BELOW_DEPTH_M);
  /** A range for the temperature colours, in °C; null stretches them to the area. */
  let temperatureRange = (() => {
    const p = (prefs.getString(KEY_TEMP_RANGE) || '').split(',').map(Number);
    return p.length === 2 && p.every(Number.isFinite) && p[0] < p[1] ? p : null;
  })();
  let directionStyle = DirectionStyle[prefs.getString(KEY_STYLE)] || DirectionStyle.FLOW;
  let boxShown = prefs.getBoolean(KEY_BOX, true);
  let fixedSpot = (() => {
    const p = (prefs.getString(KEY_SPOT) || '').split(',').map(Number);
    return p.length === 2 && p.every(Number.isFinite) ? p : null;
  })();
  let autoHours = prefs.getNumber(KEY_AUTO_HOURS, 6);
  const keepUpdated = () => autoHours > 0;
  let boxOpen = prefs.getBoolean(KEY_BOX_OPEN, false);
  let onlineAt = 0;
  let onlineNow = true;
  let wasOffline = false;
  let picking = false;
  let lastAutoAttempt = 0;
  let latestRun = null;
  let lastRunCheck = 0;
  let nextDownloadAllowed = 0;
  let spotArea = null;
  let playing = false;
  let playTimer = null;
  let live = true;
  let pickedMillis = 0;
  const timeMillis = () => (live ? Date.now() : pickedMillis);
  let area = null;
  let downloading = false;
  let status = null;
  let dialog = null;
  let dialogBody = null;
  let lastPicture = null; // { url, key }
  let drawToken = 0;
  let scaleCache = null;
  let startupDone = false;

  // ---------------------------------------------------------------- views

  const cardTitle = el('div', 'cond-title');
  const cardWarning = el('div', 'cond-warning');
  cardWarning.hidden = true;
  const legendBar = el('div', 'cond-legend-bar');
  const legendLow = el('span');
  const legendMid = el('span');
  const legendHigh = el('span');
  const legendLabels = el('div', 'cond-legend-labels');
  legendLabels.append(legendLow, legendMid, legendHigh);
  const legend = el('div', 'cond-legend');
  legend.append(legendBar, legendLabels);
  const slider = el('input', 'cond-slider');
  slider.type = 'range';
  slider.min = 0;
  slider.title = 'Forecast time';
  const smallButton = (label, onClick, title) => {
    const b = el('button', 'cond-button' + (label === 'Now' ? ' primary' : ''), label);
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  };
  const playButton = smallButton('Play', () => setPlaying(!playing), 'Play the forecast');
  playButton.classList.add('play');
  const nowButton = smallButton('Now', () => {
    setPlaying(false);
    live = true;
    redraw();
  });
  const timeRow = el('div', 'cond-time');
  timeRow.append(playButton, smallButton('◀', () => step(-1), 'An hour earlier'), slider, smallButton('▶', () => step(1), 'An hour later'), nowButton);
  const head = el('div', 'cond-head');
  head.append(cardTitle, smallButton('⚙', () => showDialog(), 'Sea conditions settings'), smallButton('✕', () => setShown(false), 'Hide sea conditions'));
  const card = el('div', 'cond-card');
  card.hidden = true;
  card.append(head, cardWarning, legend, timeRow);

  slider.addEventListener('input', () => {
    const forecast = area?.forecast;
    if (!forecast) return;
    setPlaying(false);
    live = false;
    pickedMillis = forecast.times[Math.min(forecast.times.length - 1, Math.max(0, Number(slider.value)))];
    redraw();
  });

  const boxTitle = el('span', 'cond-box-title');
  const boxToggle = el('button', 'cond-box-toggle', boxOpen ? OPEN_MARK : CLOSED_MARK);
  boxToggle.title = boxOpen ? 'Show less' : 'Show waves, swell, current and sea';
  boxToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    boxOpen = !boxOpen;
    prefs.put(KEY_BOX_OPEN, boxOpen);
    boxToggle.textContent = boxOpen ? OPEN_MARK : CLOSED_MARK;
    boxToggle.title = boxOpen ? 'Show less' : 'Show waves, swell, current and sea';
    updateBox();
  });
  const boxWarning = el('div', 'cond-warning');
  boxWarning.hidden = true;
  const arrowUrl = arrowCanvas(36).toDataURL();
  const boxRows = Array.from({ length: BOX_ROWS }, () => {
    const r = { layer: null, from: null };
    r.arrow = el('img', 'cond-row-arrow');
    r.arrow.src = arrowUrl;
    r.text = el('span', 'cond-row-text');
    r.view = el('div', 'cond-row');
    r.view.append(r.arrow, r.text);
    r.view.addEventListener('click', (e) => {
      e.stopPropagation();
      if (r.layer) toggleLayer(r.layer, r.from);
    });
    r.highlight = (on) => r.view.classList.toggle('active', on);
    return r;
  });
  const boxHeadRow = el('div', 'cond-box-head');
  boxHeadRow.append(boxTitle, boxToggle);
  const box = el('div', 'cond-box');
  box.title = 'Sea conditions — open the settings';
  box.hidden = true;
  box.append(boxHeadRow, ...boxRows.map((r) => r.view), boxWarning);
  box.addEventListener('click', () => showDialog());

  const pickBanner = el('div', 'cond-pick');
  pickBanner.hidden = true;
  const pickButtons = el('div', 'pd-button-row');
  const cancelPick = el('button', 'pd-button', 'Cancel');
  cancelPick.addEventListener('click', () => endPicking(false));
  const setPick = el('button', 'pd-button primary', 'Set');
  setPick.addEventListener('click', () => endPicking(true));
  pickButtons.append(cancelPick, setPick);
  pickBanner.append(el('div', 'cond-pick-title', 'Choose the spot'), el('div', 'cond-pick-text', 'Move the map so the crosshair is on the spot, then click Set.'), pickButtons);

  document.getElementById('map-chips').append(box);
  document.getElementById('bottom').prepend(card);
  document.body.append(pickBanner);
  const flowLines = new FlowLines(map);

  // ---------------------------------------------------------------- showing

  function setShown(value) {
    shown = value;
    prefs.put(KEY_SHOWN, value);
    if (value) redraw();
    else clearMap();
    app.style.refreshAttribution();
    refreshDialog();
  }

  function clearMap() {
    drawToken++;
    setPlaying(false);
    card.hidden = true;
    flowLines.stop();
    updateBox();
    if (map.getLayer(IMAGE_LAYER)) map.removeLayer(IMAGE_LAYER);
    if (map.getSource(IMAGE_SOURCE)) map.removeSource(IMAGE_SOURCE);
    map.getSource(ARROW_SOURCE)?.setData(EMPTY);
    lastPicture = null;
  }

  async function pickArea() {
    const summaries = await store.summaries();
    const id = summaries.some((s) => s.id === areaId) ? areaId : summaries[0]?.id;
    return id ? store.load(id) : null;
  }

  function toggleLayer(layer, from = null) {
    if (shown && colour === layer && (!from || from.id === area?.id)) {
      setShown(false);
      return;
    }
    colour = layer;
    prefs.put(KEY_COLOUR, colour.name);
    lastPicture = null;
    if (from && from.id !== area?.id) {
      area = from;
      areaId = from.id;
      prefs.put(KEY_AREA, from.id);
      scaleCache = null;
      app.style.refreshAttribution();
    }
    if (!area) area = spotArea;
    if (!shown) setShown(true);
    else redraw();
    refreshDialog();
  }

  /** What the colours show at a point; the satellite coastline masks the land when saved. */
  function sampler(a, choice, time) {
    const masked = Boolean(a.satellites.SEA_TEMP);
    const f = a.forecast;
    let raw = null;
    const magnitude = (u, v) => (lat, lng) => {
      const east = f.sample(u, lat, lng, time, masked);
      const north = f.sample(v, lat, lng, time, masked);
      return Number.isNaN(east) || Number.isNaN(north) ? NaN : Math.hypot(east, north) * KNOTS_PER_MS;
    };
    switch (choice) {
      case ColourChoice.SEA_TEMP_SATELLITE:
      case ColourChoice.CHLOROPHYLL: {
        const sat = a.satellites[choice.satellite.name];
        if (!sat) return null;
        raw = (lat, lng) => sat.sample(lat, lng);
        break;
      }
      case ColourChoice.SEA_TEMP_BREAKS: {
        const breaks = a.breaks;
        if (!breaks) return null;
        raw = (lat, lng) => breaks.sample(lat, lng);
        break;
      }
      // Coarse: with a finer coastline to hide the land, they reach the shore.
      case ColourChoice.TEMP_BELOW:
      case ColourChoice.SEA_LEVEL:
      case ColourChoice.SALINITY: {
        const sat = a.satellites[choice.satellite.name];
        if (!sat) return null;
        raw = masked ? (lat, lng) => sat.sampleToShore(lat, lng) : (lat, lng) => sat.sample(lat, lng);
        break;
      }
      case ColourChoice.CURRENT: raw = f && magnitude(F.CURRENT_U, F.CURRENT_V); break;
      case ColourChoice.WIND: raw = f && magnitude(F.WIND_U, F.WIND_V); break;
      case ColourChoice.WAVES: raw = f && ((lat, lng) => f.sample(F.WAVE_HEIGHT, lat, lng, time, masked)); break;
      case ColourChoice.SWELL: raw = f && ((lat, lng) => f.sample(F.SWELL_HEIGHT, lat, lng, time, masked)); break;
      case ColourChoice.SEA_TEMP_FORECAST: raw = f && ((lat, lng) => f.sample(F.SEA_TEMP, lat, lng, time, masked)); break;
      default: return null;
    }
    if (!raw) return null;
    if (choice === ColourChoice.SEA_TEMP_SATELLITE || choice === ColourChoice.SEA_TEMP_BREAKS || !masked) return raw;
    return (lat, lng) => (a.isSea(lat, lng) === false ? NaN : raw(lat, lng));
  }

  /** The colour range; the stretched ones come from all of the area's values, so they hold still as the time changes. */
  function scaleFor(a, choice) {
    const range = choice.isTemperature ? temperatureRange : null;
    const key = `${a.id}:${a.fetchedMillis}:${choice.name}:${range}`;
    if (scaleCache?.key === key) return scaleCache.scale;
    let scale;
    if (range) {
      scale = ColourScale.temperatureRange(range[0], range[1]);
    } else {
      const v = choice === ColourChoice.SEA_TEMP_BREAKS ? a.breaks?.values
        : choice === ColourChoice.SEA_TEMP_FORECAST ? a.forecast?.fields[F.SEA_TEMP]
          : choice.satellite ? a.satellites[choice.satellite.name]?.values : null;
      scale = ColourScale.forChoice(choice, v);
    }
    scaleCache = { key, scale };
    return scale;
  }

  function redraw() {
    const a = area;
    if (!shown || !a) {
      clearMap();
      return;
    }
    refreshCard(a);
    updateBox();
    const time = timeMillis();
    const choice = colour;
    showFlowLines(a, time);
    // A satellite picture doesn't change with the time; a range set for the colours changes any temperature's.
    const key = `${a.id}:${a.fetchedMillis}:${choice.name}:${choice.forecast ? Math.floor(time / PICTURE_STEP_MS) : 0}${choice.isTemperature ? `:${temperatureRange}` : ''}`;
    const token = ++drawToken;
    // Drawn in the next frame, so a burst of changes (dragging the slider) draws once.
    requestAnimationFrame(() => {
      if (token !== drawToken) return;
      const satellite = choice.satellite ? a.satellites[choice.satellite.name] : null;
      let picture = null;
      if (choice !== ColourChoice.NONE && !(choice.satellite && !satellite) && !(choice.forecast && !a.forecast)) {
        if (lastPicture?.key === key) {
          picture = lastPicture;
        } else {
          const sample = sampler(a, choice, time);
          if (sample) {
            const started = performance.now();
            const maxSide = satellite ? Math.min(MAX_PICTURE_SIDE, Math.max(satellite.grid.rows, satellite.grid.cols) * 2) : FORECAST_PICTURE_SIDE;
            const pixels = renderPicture(a.south, a.west, a.north, a.east, Math.max(64, maxSide), scaleFor(a, choice), sample);
            const canvas = document.createElement('canvas');
            canvas.width = pixels.width;
            canvas.height = pixels.height;
            canvas.getContext('2d').putImageData(new ImageData(pixels.rgba, pixels.width, pixels.height), 0, 0);
            picture = { url: canvas.toDataURL('image/png'), key };
            log(TAG, `picture ${choice.name} ${pixels.width}x${pixels.height} in ${Math.round(performance.now() - started)} ms`);
          }
        }
      }
      showPicture(a, picture);
      map.getSource(ARROW_SOURCE)?.setData(directionStyle.arrows ? arrowGeoJson(a, flow(), time) : EMPTY);
    });
  }

  function showPicture(a, picture) {
    if (!picture) {
      if (map.getLayer(IMAGE_LAYER)) map.removeLayer(IMAGE_LAYER);
      if (map.getSource(IMAGE_SOURCE)) map.removeSource(IMAGE_SOURCE);
      lastPicture = null;
      return;
    }
    // Drawn before the style has loaded (at start-up, or while the basemap
    // changes): kept for onStyleInstalled, as adding a layer now throws.
    if (!map.getLayer(ARROW_LAYER)) {
      lastPicture = picture;
      return;
    }
    const coordinates = [[a.west, a.north], [a.east, a.north], [a.east, a.south], [a.west, a.south]];
    const source = map.getSource(IMAGE_SOURCE);
    if (!source) map.addSource(IMAGE_SOURCE, { type: 'image', url: picture.url, coordinates });
    else if (picture !== lastPicture) source.updateImage({ url: picture.url, coordinates });
    if (!map.getLayer(IMAGE_LAYER)) {
      // Under the arrows, above every imported layer.
      map.addLayer({
        id: IMAGE_LAYER, type: 'raster', source: IMAGE_SOURCE,
        paint: { 'raster-opacity': opacity, 'raster-resampling': 'linear', 'raster-fade-duration': 0 }
      }, map.getLayer(ARROW_LAYER) ? ARROW_LAYER : nextAfterAnchor());
    }
    lastPicture = picture;
  }

  /** The first layer above the overlay anchor (the colours go just above the imported layers). */
  function nextAfterAnchor() {
    const layers = map.getStyle().layers;
    const i = layers.findIndex((l) => l.id === OVERLAY_ANCHOR);
    return i >= 0 && i + 1 < layers.length ? layers[i + 1].id : undefined;
  }

  const arrowOpacity = () => Math.max(0.55, opacity);

  function applyOpacity() {
    if (map.getLayer(IMAGE_LAYER)) map.setPaintProperty(IMAGE_LAYER, 'raster-opacity', opacity);
    if (map.getLayer(ARROW_LAYER)) map.setPaintProperty(ARROW_LAYER, 'icon-opacity', arrowOpacity());
  }

  function showFlowLines(a, time) {
    const f = a.forecast;
    const choice = flow();
    if (!directionStyle.flow || !f || !choice.fields) {
      flowLines.stop();
      return;
    }
    const [u, v] = choice.fields;
    const masked = Boolean(a.satellites.SEA_TEMP);
    const heightField = choice === ArrowChoice.WAVES ? F.WAVE_HEIGHT : choice === ArrowChoice.SWELL ? F.SWELL_HEIGHT : null;
    flowLines.show((lat, lng, out) => {
      if (masked && a.isSea(lat, lng) === false) return false;
      const east = f.sample(u, lat, lng, time, masked);
      const north = f.sample(v, lat, lng, time, masked);
      if (Number.isNaN(east) || Number.isNaN(north)) return false;
      // Waves and swell store a direction only: their height sets the speed.
      let scale = 1;
      if (heightField) {
        scale = f.sample(heightField, lat, lng, time, masked);
        if (Number.isNaN(scale)) return false;
      }
      out[0] = east * scale;
      out[1] = north * scale;
      return true;
    }, choice.reference, a.south, a.west, a.north, a.east);
  }

  function arrowGeoJson(a, choice, time) {
    const f = a.forecast;
    if (!f || !choice.fields) return EMPTY;
    const [u, v] = choice.fields;
    const features = [];
    // About a dozen arrows across at most: the flow lines show the detail.
    const stride = Math.max(1, Math.ceil(Math.max(f.grid.rows, f.grid.cols) / MAX_ARROWS_PER_SIDE));
    for (let r = 0; r < f.grid.rows; r += stride) {
      for (let c = 0; c < f.grid.cols; c += stride) {
        const lat = f.grid.lats[r];
        const lng = f.grid.lngs[c];
        if (a.isSea(lat, lng) === false) continue;
        const fl = f.vector(u, v, lat, lng, time);
        if (!fl) continue;
        const strength = choice === ArrowChoice.WAVES ? f.sample(F.WAVE_HEIGHT, lat, lng, time)
          : choice === ArrowChoice.SWELL ? f.sample(F.SWELL_HEIGHT, lat, lng, time) : fl.speed;
        if (!Number.isFinite(strength) || strength < 0.01) continue;
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lng, lat] },
          properties: { rot: fl.towardsDegrees, size: 0.3 + 0.7 * Math.min(1, strength / choice.reference) }
        });
      }
    }
    return { type: 'FeatureCollection', features };
  }

  // ---------------------------------------------------------------- bottom card

  function legendValue(value) {
    const u = units();
    switch (colour) {
      case ColourChoice.CURRENT: return legendSpeed(value, u.current);
      case ColourChoice.WIND: return legendSpeed(value, u.wind);
      case ColourChoice.WAVES:
      case ColourChoice.SWELL: return legendNumber(value * u.waves.perMetre, u.waves.label);
      case ColourChoice.SEA_TEMP_SATELLITE:
      case ColourChoice.SEA_TEMP_FORECAST:
      case ColourChoice.TEMP_BELOW: return new NavFormat(u).temperature(value);
      case ColourChoice.SEA_TEMP_BREAKS: return `${u.temperature.ofDifference(value).toFixed(2)} ${u.temperature.label}/km`;
      case ColourChoice.CHLOROPHYLL: return `${value < 1 ? value.toFixed(2) : value.toFixed(1)} mg/m³`;
      case ColourChoice.SEA_LEVEL: return new NavFormat(u).seaLevel(value);
      case ColourChoice.SALINITY: return `${value.toFixed(1)} PSU`;
      default: return '';
    }
  }

  function refreshCard(a) {
    card.hidden = false;
    const forecast = a.forecast;
    const time = timeMillis();
    const fl = flow();
    const usesForecast = (colour.forecast || (directionStyle !== DirectionStyle.NONE && fl !== ArrowChoice.NONE)) && forecast;
    // "Wind speed", not "Wind speed · wind flow": the lines are the layer's own.
    const ownFlow = OWN_FLOW.has(colour) && fl === resolveArrow(ArrowChoice.SAME, colour);
    const layerName = colour === ColourChoice.TEMP_BELOW ? `Temperature ${new NavFormat(units()).depth(a.belowDepthM)} down (model)` : colour.label;
    const what = [colour !== ColourChoice.NONE ? layerName : null, fl !== ArrowChoice.NONE && forecast && !ownFlow ? fl.short : null]
      .filter(Boolean).join(' · ') || 'Sea conditions';
    const satellite = colour.satellite ? a.satellites[colour.satellite.name] : null;
    const source = colour === ColourChoice.TEMP_BELOW ? 'model' : 'satellite';
    let whenText = '';
    if (colour.satellite && !satellite) whenText = `No ${colour.satellite.label.toLowerCase()} saved here: update the area`;
    else if (colour.forecast && !forecast) whenText = 'No forecast saved for this area';
    else if (usesForecast && time > forecast.endMillis + HOUR_MS) whenText = `The forecast ran out ${day(forecast.endMillis)}: update it`;
    else if (usesForecast) whenText = clock(time) + (live ? ' (now)' : '') + (satellite ? ` · ${source} ${day(satellite.dateMillis)}` : '');
    else if (satellite) whenText = `${source}, ${day(satellite.dateMillis)}`;
    cardTitle.textContent = whenText ? `${what}\n${whenText}` : `${what} — ${a.name}`;
    showWarning(cardWarning, a);

    if (colour === ColourChoice.NONE || (colour.satellite && !satellite) || (colour.forecast && !forecast)) {
      legend.hidden = true;
    } else {
      legend.hidden = false;
      const scale = scaleFor(a, colour);
      const stops = Array.from({ length: 16 }, (_, i) => `rgb(${scale.colourAt(i / 15).join(',')})`);
      legendBar.style.background = `linear-gradient(to right, ${stops.join(',')})`;
      legendLow.textContent = legendValue(scale.valueAt(0));
      legendMid.textContent = legendValue(scale.valueAt(0.5));
      // The fixed ranges show anything stronger in the top colour.
      legendHigh.textContent = legendValue(scale.valueAt(1)) + (colour.fixedRange ? '+' : '');
    }

    if (usesForecast) {
      timeRow.hidden = false;
      slider.max = forecast.times.length - 1;
      let hour = forecast.times.findIndex((t) => t >= time - HOUR_MS / 2);
      if (hour < 0) hour = forecast.times.length - 1;
      slider.value = hour;
      nowButton.classList.toggle('dim', live);
    } else {
      timeRow.hidden = true;
    }
  }

  function step(hours, wrap = false, fromPlay = false) {
    if (!fromPlay) setPlaying(false);
    const forecast = area?.forecast;
    if (!forecast) return;
    const now = timeMillis();
    let current = forecast.times.findIndex((t) => t >= now - HOUR_MS / 2);
    if (current < 0) current = forecast.times.length - 1;
    let next = current + hours;
    // Playing goes round again from the start; stepping stops at the ends.
    if (wrap && next >= forecast.times.length) next = 0;
    next = Math.min(forecast.times.length - 1, Math.max(0, next));
    live = false;
    pickedMillis = forecast.times[next];
    redraw();
  }

  function setPlaying(value) {
    if (playing === value) return;
    playing = value;
    clearInterval(playTimer);
    playButton.textContent = value ? 'Pause' : 'Play';
    playButton.title = value ? 'Pause' : 'Play the forecast';
    if (value) playTimer = setInterval(() => step(1, true, true), PLAY_STEP_MS);
  }

  // ---------------------------------------------------------------- values box

  function updateBox() {
    if (!boxShown) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const time = timeMillis();
    const target = map.getCenter().wrap();
    const shownArea = area;
    let a;
    let lat;
    let lng;
    let wanted;
    if (shown && shownArea && shownArea.contains(target.lat, target.lng)) {
      // The map layer is on: everything, where the crosshair is.
      a = shownArea;
      lat = target.lat;
      lng = target.lng;
      wanted = boxOpen ? null : new Set(['Wind', rowNameOf(colour)].filter(Boolean));
      boxTitle.textContent = `At the crosshair · ${live ? 'now' : clock(time)}`;
    } else {
      const data = [spotArea, shownArea].find((x) => fixedSpot && x && x.contains(fixedSpot[0], fixedSpot[1]));
      if (!fixedSpot || !data) {
        boxTitle.textContent = downloading ? 'Sea conditions · downloading…'
          : keepUpdated() && !onlineNow ? 'Sea conditions · none saved here (offline)'
            : 'Sea conditions · click to set up';
        boxRows.forEach((r) => { r.view.hidden = true; });
        boxWarning.hidden = true;
        return;
      }
      a = data;
      [lat, lng] = fixedSpot;
      wanted = boxOpen ? null : new Set(['Wind', shown ? rowNameOf(colour) : null].filter(Boolean));
      boxTitle.textContent = `At your spot · ${live ? 'now' : clock(time)}`;
    }
    // The card already says when the layer's area is old.
    if (shown && a === shownArea) boxWarning.hidden = true;
    else showWarning(boxWarning, a);
    const list = values(a, lat, lng, time, new NavFormat(units()))
      .filter((v) => !wanted || wanted.has(v.text.split(' ')[0]))
      .sort((x, y) => {
        const i = ROW_ORDER.indexOf(x.text.split(' ')[0]);
        const j = ROW_ORDER.indexOf(y.text.split(' ')[0]);
        return (i < 0 ? ROW_ORDER.length : i) - (j < 0 ? ROW_ORDER.length : j);
      });
    const bearing = map.getBearing();
    boxRows.forEach((r, i) => {
      const value = list[i];
      if (!value) {
        r.view.hidden = true;
        return;
      }
      r.view.hidden = false;
      r.text.textContent = value.text;
      r.layer = layerOfRow(value.text.split(' ')[0], a, colour);
      r.from = a;
      r.highlight(shown && r.layer && (r.layer === colour || (colour === ColourChoice.CHLOROPHYLL && r.layer.satellite)));
      if (value.towardsDegrees === null) {
        r.arrow.style.visibility = 'hidden';
      } else {
        r.arrow.style.visibility = 'visible';
        // As it points on the chart, which may be turned.
        r.arrow.style.transform = `rotate(${value.towardsDegrees - bearing}deg)`;
      }
    });
    if (!list.length) {
      const forecast = a.forecast;
      boxTitle.textContent = forecast && time > forecast.endMillis + HOUR_MS ? 'The forecast has run out: update it' : 'No sea data here (on land?)';
    }
  }

  /** Working internet, asked at most every few seconds (this runs as the map moves). */
  async function online() {
    const now = Date.now();
    if (now - onlineAt > ONLINE_CHECK_MS) {
      onlineNow = await isOnline();
      onlineAt = now;
      if (!onlineNow) wasOffline = true;
    }
    return onlineNow;
  }

  function showWarning(view, a) {
    const note = staleNote(a.fetchedMillis, Date.now(), onlineNow);
    view.textContent = note || '';
    view.hidden = !note;
  }

  // ---------------------------------------------------------------- the spot

  const spotLabel = () => (fixedSpot ? defaultName(fixedSpot[0], fixedSpot[1], fixedSpot[0], fixedSpot[1]) : 'Not set');

  /** Keeps the area round the spot downloaded: when online, if there's none, it's old, or the spot moved out of its middle. */
  async function keepSpotUpdated(force = false) {
    if (!keepUpdated() || downloading) return;
    const now = Date.now();
    if (!force && now - lastAutoAttempt < AUTO_RETRY_MS) return;
    const centre = (x) => [(x.south + x.north) / 2, (x.west + x.east) / 2];
    const position = fixedSpot || (spotArea && centre(spotArea)) || (area && centre(area));
    if (!position) {
      log(TAG, 'spot not updated: no spot set and nothing saved to go by');
      return;
    }
    const [lat, lng] = position;
    const saved = spotArea;
    const fresh = saved && !needsUpdate(saved.fetchedMillis, latestRun, now) && saved.middleContains(lat, lng);
    if (fresh) return;
    if (!(await online())) {
      log(TAG, "spot needs an update but there's no internet: showing the saved data");
      return;
    }
    if (now < nextDownloadAllowed) {
      setTimeout(() => keepSpotUpdated(true), nextDownloadAllowed - now + 500);
      return;
    }
    lastAutoAttempt = now;
    log(TAG, 'updating the spot: ' + (!saved ? 'nothing saved yet'
      : !saved.middleContains(lat, lng) ? "the spot moved out of the saved area's middle"
        : `saved ${ago(saved.fetchedMillis, now)}, newest forecast run ${latestRun ? ago(latestRun, now) : 'unknown'}`));
    const b = boxAround(lat, lng, SPOT_RADIUS_KM);
    download(b[0], b[1], b[2], b[3], { replacingId: SPOT_ID, quiet: true });
  }

  /** When online, at most every [RUN_CHECK_MS]: is a newer forecast out? Then update the spot and the area on the map. */
  async function checkForUpdates(force = false) {
    if (!keepUpdated()) return;
    const now = Date.now();
    if (!force && now - lastRunCheck < RUN_CHECK_MS) return;
    if (!(await online())) return;
    lastRunCheck = now;
    const run = await client.latestRunMillis().catch(() => null);
    if (run !== null) latestRun = run;
    log(TAG, `update check: newest forecast run ${run ? ago(run, Date.now()) : "couldn't be read"}`);
    await keepSpotUpdated(true);
    updateShownArea();
  }

  async function updateShownArea() {
    const a = area;
    if (!a || a.id === SPOT_ID || !keepUpdated()) return;
    const now = Date.now();
    if (!needsUpdate(a.fetchedMillis, latestRun, now) || !(await online())) return;
    if (downloading || now < nextDownloadAllowed) {
      setTimeout(updateShownArea, Math.max(nextDownloadAllowed - now, 5000) + 500);
      return;
    }
    log(TAG, `updating ${a.name}: saved ${ago(a.fetchedMillis, now)}`);
    download(a.south, a.west, a.north, a.east, { replacingId: a.id, quiet: true });
  }

  /** Removes saved areas of no more use: forecasts that ran out days ago, and older copies covered by a newer one. */
  async function removeOldAreas() {
    const removed = toRemove(await store.summaries(), SPOT_ID, Date.now());
    for (const [summary, reason] of removed) {
      await store.delete(summary.id);
      log(TAG, `removed ${summary.name}: ${reason === 'EXPIRED' ? 'its forecast ran out' : 'a newer download covers it'}`);
    }
    if (removed.some(([s]) => s.id === area?.id)) {
      area = null;
      showNewestHere();
    }
    if (removed.length) refreshDialog();
  }

  /** The map shows the newest saved data where it's looking. */
  async function showNewestHere() {
    if (!shown) return;
    const target = map.getCenter().wrap();
    const summaries = store.cachedSummaries();
    if (!summaries) return;
    const newest = newestCovering(target.lat, target.lng, summaries);
    if (!newest) return;
    const current = area;
    if (current && newest.id === current.id) return;
    if (current && current.contains(target.lat, target.lng) && newest.fetchedMillis <= current.fetchedMillis) return;
    const loaded = await store.load(newest.id);
    if (!loaded || !shown) return;
    log(TAG, `map now shows ${loaded.name}, the newest data here`);
    area = loaded;
    areaId = loaded.id;
    prefs.put(KEY_AREA, loaded.id);
    scaleCache = null;
    redraw();
    app.style.refreshAttribution();
  }

  function startPicking() {
    dialog?.dismiss();
    picking = true;
    if (fixedSpot) map.easeTo({ center: [fixedSpot[1], fixedSpot[0]] });
    pickBanner.hidden = false;
  }

  function endPicking(set) {
    if (!picking) return;
    picking = false;
    pickBanner.hidden = true;
    if (!set) return;
    const c = map.getCenter().wrap();
    fixedSpot = [c.lat, c.lng];
    prefs.put(KEY_SPOT, `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`);
    keepSpotUpdated(true);
    updateBox();
    refreshDialog();
    toast('Spot set');
  }

  // ---------------------------------------------------------------- settings sheet

  async function showDialog() {
    if (picking) endPicking(false);
    if (!store.cachedSummaries()) store.summaries().then(refreshDialog);
    dialog?.dismiss();
    const content = body();
    dialogBody = content;
    fill(content);
    dialog = showPanel('Sea conditions', content, { onDismiss: () => { dialog = null; dialogBody = null; } });
  }

  function refreshDialog() {
    if (dialogBody) fill(dialogBody);
  }

  function fill(content) {
    content.replaceChildren();
    content.append(caption('Wind, waves, swell and currents (tidal flow included) for up to 8 days, plus sea temperature and its breaks, chlorophyll, sea level and salinity from satellites, and temperature at depth from an ocean model. Worldwide, and saved on this computer for use offline.', 8));
    const summaries = store.cachedSummaries() || [];
    addRow(content, row('Show on the map', shown ? colour.label : 'Off', () => {
      showChoicePanel('Show on the map', ['Off', ...MAP_CHOICES.map((c) => c.label)], shown ? MAP_CHOICES.indexOf(colour) + 1 : 0, (i) => {
        if (i === 0) setShown(false);
        else if (!area && !spotArea && !summaries.length) toast('Nothing downloaded yet: click Update now');
        else toggleLayer(MAP_CHOICES[i - 1]);
        refreshDialog();
      });
    }));
    content.append(caption('Or click a line in the box on the chart. Each shows its own direction lines; sea temperature and chlorophyll show the current\'s. Temperature breaks are where warm and cold water meet, often where fish gather.', 0));

    content.append(sectionHeader('SPOT'));
    addRow(content, row('Spot', spotLabel(), startPicking));
    addRow(content, row('Update automatically', autoLabel(autoHours), () => {
      const choices = [6, 0];
      showChoicePanel('Update automatically', choices.map(autoLabel), keepUpdated() ? 0 : 1, (i) => {
        autoHours = choices[i];
        prefs.put(KEY_AUTO_HOURS, autoHours);
        checkForUpdates(true);
        refreshDialog();
      });
    }));
    content.append(caption(`Online, the app checks for a new forecast every ${RUN_CHECK_MS / 60_000} minutes and when you open it, and downloads ${SPOT_RADIUS_KM} km round the spot when there is one. Each update replaces the last; old copies and forecasts that ran out are removed. Offline, the latest saved data is shown.`, 0));
    addRow(content, row(downloading ? 'Downloading…' : 'Update now', `${dayText(days)} of forecast${withSatellite ? ' + satellite' : ''}`, async () => {
      if (downloading) return;
      const position = fixedSpot || (spotArea && [(spotArea.south + spotArea.north) / 2, (spotArea.west + spotArea.east) / 2]);
      if (!position) {
        toast('Set a spot first: click Spot and choose it on the map');
        return;
      }
      if (!(await isOnline())) {
        toast('No internet: the saved data is still shown');
        return;
      }
      const b = boxAround(position[0], position[1], SPOT_RADIUS_KM);
      lastAutoAttempt = Date.now();
      download(b[0], b[1], b[2], b[3], { replacingId: SPOT_ID });
    }));

    content.append(sectionHeader('ON THE MAP'));
    addRow(content, row('Direction shown as', directionStyle.label, () => {
      showChoicePanel('Direction shown as', DIRECTION_STYLES.map((d) => d.label), DIRECTION_STYLES.indexOf(directionStyle), (i) => {
        directionStyle = DIRECTION_STYLES[i];
        prefs.put(KEY_STYLE, directionStyle.name);
        redraw();
        refreshDialog();
      });
    }));
    addRow(content, row('Values box on the chart', boxShown ? 'On: at your spot; at the crosshair while a layer shows' : 'Off', () => {
      boxShown = !boxShown;
      prefs.put(KEY_BOX, boxShown);
      updateBox();
      refreshDialog();
    }));
    addRow(content, row('Sea temperature colours', temperatureRangeLabel(), pickTemperatureRange));
    addRow(content, row('Temperature at depth', `${new NavFormat(units()).depth(belowDepthM)} down`, () => {
      const format = new NavFormat(units());
      showChoicePanel('How far down', BELOW_DEPTHS.map((d) => format.depth(d)), BELOW_DEPTHS.indexOf(belowDepthM), (i) => {
        if (BELOW_DEPTHS[i] === belowDepthM) return;
        belowDepthM = BELOW_DEPTHS[i];
        prefs.put(KEY_BELOW_DEPTH, belowDepthM);
        refreshDialog();
        refreshBelowDepth();
      });
    }));
    const opacityLabel = caption(`Colour opacity ${Math.round(opacity * 100)}%`, 4);
    const opacitySlider = el('input', 'pd-slider');
    opacitySlider.type = 'range';
    opacitySlider.min = 0;
    opacitySlider.max = 100;
    opacitySlider.value = Math.round(opacity * 100);
    opacitySlider.addEventListener('input', () => {
      opacity = opacitySlider.value / 100;
      opacityLabel.textContent = `Colour opacity ${opacitySlider.value}%`;
      applyOpacity();
    });
    opacitySlider.addEventListener('change', () => prefs.put(KEY_OPACITY, opacity));
    content.append(opacityLabel, opacitySlider);

    content.append(sectionHeader('SAVED AREAS'));
    if (!summaries.length) content.append(caption('None yet.', 0));
    const format = new NavFormat(units());
    for (const s of summaries) {
      const active = s.id === area?.id;
      const forecastText = s.forecastUntilMillis !== null
        ? (s.forecastUntilMillis < Date.now() ? `forecast ran out ${day(s.forecastUntilMillis)}` : `forecast to ${day(s.forecastUntilMillis)}`)
        : null;
      const satText = s.satellites.length > 1 ? `${s.satellites.length} ocean layers`
        : s.satellites.length ? SatelliteKind[s.satellites[0]]?.label.toLowerCase() : null;
      const detail = [active && shown ? 'Showing' : null, forecastText, satText, `got ${format.clock(s.fetchedMillis)}`, `${(s.bytes / 1024).toFixed(0)} KB`].filter(Boolean).join(' · ');
      addRow(content, row((active ? '● ' : '') + s.name, detail, () => areaOptions(s)));
    }

    content.append(sectionHeader('DOWNLOADS'));
    addRow(content, row(downloading ? 'Downloading…' : 'Save the area on screen', 'As well as the spot: another fishing ground', () => {
      if (!downloading) downloadScreenArea();
    }));
    addRow(content, row('Days of forecast to save', `${dayText(days)} (up to ${client.MAX_DAYS})`, () => {
      const choices = [1, 2, 3, 5, 7, 8];
      showChoicePanel('Days of forecast', choices.map(dayText), choices.indexOf(days), (i) => {
        days = choices[i];
        prefs.put(KEY_DAYS, days);
        refreshDialog();
      });
    }));
    addRow(content, row('Satellite and ocean layers', withSatellite ? 'Yes (usually 2 to 5 days old)' : 'No', () => {
      withSatellite = !withSatellite;
      prefs.put(KEY_SATELLITE, withSatellite);
      refreshDialog();
    }));
    if (status) content.append(caption(status, 2));
    content.append(caption("Forecast model points are about 8 km apart, so it's less accurate close to shore and in channels. Not for navigation.", 8));
  }

  function temperatureRangeLabel() {
    if (!temperatureRange) return 'Automatic: stretched to the area, so small breaks show';
    const format = new NavFormat(units());
    return `${format.temperature(temperatureRange[0])} to ${format.temperature(temperatureRange[1])}`;
  }

  function pickTemperatureRange() {
    showChoicePanel('Sea temperature colours', ['Automatic: stretched to the area', 'Set the range'], temperatureRange ? 1 : 0, (i) => {
      if (i === 0) applyTemperatureRange(null);
      else editTemperatureRange();
    });
  }

  function editTemperatureRange() {
    const unit = units().temperature;
    const a = area || spotArea;
    const auto = a?.satellites.SEA_TEMP ? ColourScale.forChoice(ColourChoice.SEA_TEMP_SATELLITE, a.satellites.SEA_TEMP.values) : null;
    const [startLow, startHigh] = temperatureRange || (auto ? [auto.low, auto.high] : [20, 30]);
    const content = body();
    content.append(caption(`Coolest (${unit.label})`, 8));
    const low = input({ value: unit.of(startLow).toFixed(1) });
    addRow(content, low);
    content.append(caption(`Warmest (${unit.label})`, 8));
    const high = input({ value: unit.of(startHigh).toFixed(1) });
    addRow(content, high);
    const handle = showPanel('Sea temperature colours', content, {
      actionLabel: 'Save',
      onAction: () => {
        const x = Number.parseFloat(low.value);
        const y = Number.parseFloat(high.value);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x >= y) {
          toast('Enter two temperatures, the coolest first');
          return;
        }
        handle.dismiss();
        applyTemperatureRange([unit.toCelsius(x), unit.toCelsius(y)]);
      }
    });
  }

  function applyTemperatureRange(range) {
    temperatureRange = range;
    prefs.put(KEY_TEMP_RANGE, range ? `${range[0].toFixed(3)},${range[1].toFixed(3)}` : '');
    scaleCache = null;
    lastPicture = null;
    if (shown) redraw();
    refreshDialog();
  }

  function areaOptions(s) {
    const options = ['Show this area', 'Go to it on the map', 'Update (download again)', 'Rename', 'Delete'];
    showChoicePanel(s.name, options, -1, async (i) => {
      if (i === 0 || i === 1) selectArea(s.id, i === 1);
      else if (i === 2) {
        const saved = await store.load(s.id);
        if (saved) download(saved.south, saved.west, saved.north, saved.east, { replacingId: saved.id });
      } else if (i === 3) rename(s);
      else if (i === 4) {
        confirm(`Delete ${s.name}?`, 'Its saved sea conditions are removed from this computer.', async () => {
          if (s.id === SPOT_ID) {
            spotArea = null;
            // Not straight back: it downloads again at the next update.
            lastAutoAttempt = Date.now();
          }
          const wasShown = area?.id === s.id;
          if (wasShown) area = null;
          await store.delete(s.id);
          if (wasShown) {
            area = await pickArea();
            if (!area) setShown(false);
            else redraw();
            app.style.refreshAttribution();
          }
          updateBox();
          refreshDialog();
        });
      }
    });
  }

  async function selectArea(id, goTo) {
    const loaded = await store.load(id);
    if (!loaded) {
      toast("Couldn't read that area");
      return;
    }
    area = loaded;
    areaId = id;
    prefs.put(KEY_AREA, id);
    lastPicture = null;
    if (goTo) app.map.fitBounds([[loaded.west, loaded.south], [loaded.east, loaded.north]], { padding: 48 });
    if (!shown) setShown(true);
    else redraw();
    app.style.refreshAttribution();
    refreshDialog();
  }

  function rename(s) {
    const content = body();
    const field = input({ value: s.name });
    addRow(content, field);
    const handle = showPanel('Rename area', content, {
      actionLabel: 'Save',
      onAction: async () => {
        const name = field.value.trim();
        handle.dismiss();
        if (!name) return;
        const renamed = await store.rename(s.id, name).catch(() => null);
        if (renamed && area?.id === s.id) {
          area = renamed;
          redraw();
        }
        refreshDialog();
      }
    });
    setTimeout(() => field.focus(), 0);
  }

  // ---------------------------------------------------------------- downloading

  function downloadScreenArea() {
    const b = map.getBounds();
    const centre = map.getCenter();
    let south = b.getSouth();
    let north = b.getNorth();
    // Back into -180..180 about the crosshair. The data services stop at the date line, so take its side.
    const shift = centre.wrap().lng - centre.lng;
    let west = b.getWest() + shift;
    let east = b.getEast() + shift;
    const crossesDateLine = west < -MAX_LNG || east > MAX_LNG;
    west = Math.max(-MAX_LNG, west);
    east = Math.min(MAX_LNG, east);
    // Zoomed out too far: the middle of the screen, the most an area can be.
    const tooBig = north - south > MAX_SPAN_DEG || east - west > MAX_SPAN_DEG;
    const fit = (lo, hi) => {
      const mid = (lo + hi) / 2;
      const span = Math.min(MAX_SPAN_DEG, Math.max(MIN_SPAN_DEG, hi - lo));
      return [mid - span / 2, mid + span / 2];
    };
    [south, north] = fit(south, north);
    south = Math.max(-MAX_LAT, south);
    north = Math.min(MAX_LAT, north);
    [west, east] = fit(west, east);
    west = Math.max(-MAX_LNG, west);
    east = Math.min(MAX_LNG, east);
    const note = tooBig ? `This was the middle ${Math.round(MAX_SPAN_DEG * 111)} km of the screen, the most one area holds.`
      : crossesDateLine ? 'This was the side of the date line the crosshair is on.' : null;
    download(south, west, north, east, { replacingId: null, note });
  }

  function message(error) {
    return error?.message || String(error);
  }

  /** Downloads an area; replacingId updates that saved area (otherwise one with the same bounds is replaced). */
  /**
   * After "How far down" changes: downloads only the temperature at the new depth for the area on the map (or
   * the spot's), so it shows straight away without downloading the whole forecast again.
   */
  async function refreshBelowDepth() {
    const target = area || spotArea;
    const depthText = new NavFormat(units()).depth(belowDepthM);
    if (!target || downloading) { toast(`Saved: the next download gets the temperature ${depthText} down`); return; }
    if (!(await isOnline())) { toast(`No internet: the temperature ${depthText} down comes with the next update`); return; }
    const depth = belowDepthM;
    downloading = true;
    status = `Downloading the temperature ${depthText} down…`;
    refreshDialog();
    try {
      const grid = await client.satellite(SatelliteKind.TEMP_BELOW, target.south, target.west, target.north, target.east, depth);
      const fresh = new ConditionsArea({
        id: target.id, name: target.name, south: target.south, west: target.west, north: target.north, east: target.east,
        fetchedMillis: Date.now(), forecast: target.forecast, satellites: { ...target.satellites, TEMP_BELOW: grid }, belowDepthM: depth
      });
      await store.save(fresh);
      if (spotArea?.id === fresh.id) spotArea = fresh;
      if (area?.id === fresh.id) { area = fresh; lastPicture = null; scaleCache = null; }
      status = null;
      downloading = false;
      if (shown) redraw(); else updateBox();
      toast(`Temperature ${depthText} down updated for ${fresh.name}`);
    } catch (error) {
      logError(TAG, 'temperature at depth download FAILED', error);
      toast(`Couldn't get the temperature ${depthText} down: ${message(error)}`);
    } finally {
      status = null;
      downloading = false;
      refreshDialog();
    }
  }

  async function download(south, west, north, east, { replacingId = null, note = null, quiet = false } = {}) {
    if (downloading) return;
    const now = Date.now();
    if (now < nextDownloadAllowed) {
      if (!quiet) toast(`Just downloaded: try again in ${Math.ceil((nextDownloadAllowed - now) / 1000)} s`);
      return;
    }
    nextDownloadAllowed = now + MIN_DOWNLOAD_GAP_MS;
    downloading = true;
    updateBox();
    const dayCount = days;
    const satellites = withSatellite;
    const depth = belowDepthM;
    status = 'Downloading the forecast…';
    refreshDialog();
    const problems = [];
    let result = null;
    try {
      const summaries = await store.summaries();
      const replacing = replacingId ? await store.load(replacingId)
        : await (async () => {
          const same = summaries.find((s) => Math.abs(s.south - south) < 0.01 && Math.abs(s.west - west) < 0.01 && Math.abs(s.north - north) < 0.01 && Math.abs(s.east - east) < 0.01);
          return same ? store.load(same.id) : null;
        })();
      const span = Math.max(north - south, east - west);
      const grid = GeoGrid.covering(south, west, north, east, Math.max(MIN_STEP_DEG, span / (MAX_POINTS_PER_SIDE - 1)), MAX_POINTS_PER_SIDE);
      const windGrid = GeoGrid.covering(south, west, north, east, Math.max(MIN_STEP_DEG, span / (MAX_WIND_POINTS_PER_SIDE - 1)), MAX_WIND_POINTS_PER_SIDE);
      let forecast = null;
      try {
        forecast = await client.forecast(grid, dayCount, windGrid, (p) => {
          status = `Downloading the forecast… ${Math.round(p * 100)}%`;
          refreshDialog();
        });
      } catch (error) {
        logError(TAG, 'forecast download FAILED', error);
        problems.push(`Forecast: ${message(error)}`);
      }
      const sats = {};
      if (satellites) {
        for (const kind of Object.values(SatelliteKind)) {
          status = `Downloading ${kind.label.toLowerCase()}…`;
          refreshDialog();
          try {
            sats[kind.name] = await client.satellite(kind, south, west, north, east, depth);
          } catch (error) {
            logError(TAG, `${kind.name} download FAILED`, error);
            // Salinity and the rest often have nothing near a coast: only said for the main ones.
            if (kind.required) problems.push(`${kind.label}: ${message(error)}`);
          }
        }
      }
      if (forecast || Object.keys(sats).length) {
        // Keep what an update couldn't get again rather than losing it, unless it was for another depth.
        const kept = Object.fromEntries(Object.entries(replacing?.satellites || {})
          .filter(([k]) => !(k in sats) && !(k === 'TEMP_BELOW' && replacing.belowDepthM !== depth)));
        const newArea = new ConditionsArea({
          id: replacing?.id || replacingId || crypto.randomUUID(),
          name: replacing?.name || (replacingId === SPOT_ID ? SPOT_NAME : defaultName(south, west, north, east)),
          south, west, north, east,
          fetchedMillis: Date.now(),
          forecast: forecast || replacing?.forecast || null,
          satellites: { ...sats, ...kept },
          belowDepthM: depth
        });
        try {
          await store.save(newArea);
          result = newArea;
        } catch (error) {
          problems.push(`Saving: ${message(error)}`);
        }
      }
    } finally {
      status = null;
      downloading = false;
    }
    if (!result) {
      if (!quiet) toast("Couldn't get the sea conditions. " + problems.join(' '));
      updateBox();
    } else {
      if (result.id === SPOT_ID) spotArea = result;
      // An update of the spot only changes the map if the spot's area is the one on it.
      const showIt = !quiet || !area || area.id === result.id;
      if (showIt) {
        area = result;
        areaId = result.id;
        prefs.put(KEY_AREA, result.id);
        lastPicture = null;
        scaleCache = null;
      }
      if (!quiet) {
        live = true;
        if (!shown) setShown(true);
        else redraw();
        const saved = problems.length ? `Saved ${result.name}, but: ${problems.join(' ')}` : `Sea conditions saved for ${result.name}.`;
        toast([saved, note].filter(Boolean).join(' '));
      } else if (shown) {
        redraw();
      } else {
        updateBox();
      }
      app.style.refreshAttribution();
      removeOldAreas();
    }
    refreshDialog();
  }

  // ---------------------------------------------------------------- start

  map.on('move', updateBox);
  map.on('moveend', () => {
    updateBox();
    showNewestHere();
  });

  (async () => {
    const started = performance.now();
    area = await pickArea();
    spotArea = await store.load(SPOT_ID);
    log(TAG, `saved areas read in ${Math.round(performance.now() - started)} ms`);
    onlineNow = await isOnline();
    if (shown) redraw();
    else updateBox();
    app.style.refreshAttribution();
    removeOldAreas();
    // Let the chart and its layers load first; the update can wait a few seconds.
    setTimeout(() => {
      startupDone = true;
      checkForUpdates(true);
    }, STARTUP_DOWNLOAD_DELAY_MS);
  })();

  setInterval(() => {
    if (shown && live) redraw();
    else updateBox();
    checkForUpdates();
  }, TICK_MS);

  window.addEventListener('offline', () => {
    onlineNow = false;
    wasOffline = true;
    updateBox();
  });
  window.addEventListener('focus', () => {
    // Back to the app after a while: is there a newer forecast?
    if (startupDone) checkForUpdates();
  });

  return {
    name: 'conditions',
    showDialog,
    credits() {
      const a = area;
      if (!a || !shown) return [];
      const sources = [];
      if (a.forecast) sources.push('Open-Meteo (CC BY 4.0): Copernicus Marine, Météo-France, ECMWF, DWD, NOAA');
      if (Object.keys(a.satellites).some((k) => k !== 'TEMP_BELOW')) sources.push('NOAA CoastWatch');
      if (a.satellites.SEA_TEMP) sources.push('NASA JPL MUR');
      if (a.satellites.SEA_LEVEL || a.satellites.CHLOROPHYLL) sources.push('contains modified Copernicus Sentinel data');
      if (a.satellites.SEA_LEVEL) sources.push('AVISO+');
      if (a.satellites.TEMP_BELOW) sources.push('HYCOM');
      return sources.length ? [`Sea: ${sources.join(', ')}`] : [];
    },
    onStyleInstalled() {
      if (!map.hasImage(ARROW_IMAGE)) {
        const c = arrowCanvas(30);
        map.addImage(ARROW_IMAGE, c.getContext('2d').getImageData(0, 0, 30, 30));
      }
      if (!map.getSource(ARROW_SOURCE)) map.addSource(ARROW_SOURCE, { type: 'geojson', data: EMPTY });
      if (!map.getLayer(ARROW_LAYER)) {
        map.addLayer({
          id: ARROW_LAYER, type: 'symbol', source: ARROW_SOURCE,
          layout: {
            'icon-image': ARROW_IMAGE, 'icon-rotate': ['get', 'rot'], 'icon-size': ['get', 'size'],
            'icon-allow-overlap': true, 'icon-ignore-placement': true,
            'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map'
          },
          paint: { 'icon-opacity': arrowOpacity() }
        }, nextAfterAnchor());
      }
      // A new style has none of the layers: put the picture back.
      const picture = lastPicture;
      lastPicture = null;
      if (shown && area && picture) showPicture(area, picture);
      if (shown) redraw();
      else clearMap();
    },
    onConnectivityRestored() {
      if (!wasOffline) return;
      wasOffline = false;
      onlineAt = 0;
      log(TAG, 'back online: checking for updates');
      checkForUpdates(true);
      updateBox();
    }
  };
}
