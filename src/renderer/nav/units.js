// Units, number formats and the boat profile, as on the phone (nav/NavUnits.kt,
// nav/NavSettings.kt).

import { prefs } from '../core.js';

export const DistanceUnit = {
  NAUTICAL_MILES: { name: 'NAUTICAL_MILES', label: 'nm', perNm: 1.0 },
  KILOMETRES: { name: 'KILOMETRES', label: 'km', perNm: 1.852 },
  STATUTE_MILES: { name: 'STATUTE_MILES', label: 'mi', perNm: 1.150779 }
};
export const SpeedUnit = {
  KNOTS: { name: 'KNOTS', label: 'kn', perKnot: 1.0 },
  KMH: { name: 'KMH', label: 'km/h', perKnot: 1.852 },
  MPH: { name: 'MPH', label: 'mph', perKnot: 1.150779 }
};
export const DepthUnit = {
  METRES: { name: 'METRES', label: 'm', perMetre: 1.0 },
  FEET: { name: 'FEET', label: 'ft', perMetre: 3.28084 },
  FATHOMS: { name: 'FATHOMS', label: 'fm', perMetre: 0.546807 }
};
export const FuelUnit = {
  LITRES: { name: 'LITRES', label: 'L', perLitre: 1.0 },
  US_GALLONS: { name: 'US_GALLONS', label: 'US gal', perLitre: 0.264172 },
  UK_GALLONS: { name: 'UK_GALLONS', label: 'gal', perLitre: 0.219969 }
};
export const BearingReference = { TRUE: 'TRUE', MAGNETIC: 'MAGNETIC' };
export const TemperatureUnit = {
  CELSIUS: { name: 'CELSIUS', label: '°C', of: (c) => c, toCelsius: (v) => v, ofDifference: (c) => c },
  FAHRENHEIT: { name: 'FAHRENHEIT', label: '°F', of: (c) => (c * 9) / 5 + 32, toCelsius: (v) => ((v - 32) * 5) / 9, ofDifference: (c) => (c * 9) / 5 }
};
/** Heights at sea: tides, waves and swell. */
export const HeightUnit = {
  METRES: { name: 'METRES', label: 'm', perMetre: 1.0 },
  FEET: { name: 'FEET', label: 'ft', perMetre: 3.28084 }
};
/** Wind and current. Beaufort is for wind only. */
export const SeaSpeedUnit = {
  KNOTS: { name: 'KNOTS', label: 'kn', perKnot: 1.0 },
  KMH: { name: 'KMH', label: 'km/h', perKnot: 1.852 },
  MPH: { name: 'MPH', label: 'mph', perKnot: 1.150779 },
  METRES_PER_SECOND: { name: 'METRES_PER_SECOND', label: 'm/s', perKnot: 0.514444 },
  BEAUFORT: { name: 'BEAUFORT', label: 'Bft', perKnot: 0 }
};
/** Each Beaufort force's top speed, in knots. */
const BEAUFORT_TOPS = [1, 4, 7, 11, 17, 22, 28, 34, 41, 48, 56, 64];
export function beaufort(knots) {
  const force = BEAUFORT_TOPS.findIndex((top) => knots < top);
  return force < 0 ? 12 : force;
}
/** A speed given in knots, in [unit]. */
export function seaSpeed(knots, unit) {
  if (knots === null || knots === undefined || !Number.isFinite(knots)) return '—';
  return unit === SeaSpeedUnit.BEAUFORT ? `${beaufort(knots)} Bft` : `${(knots * unit.perKnot).toFixed(1)} ${unit.label}`;
}
let systemCountry = '';
/** The country set in Windows: the display language alone can't tell (US English is common everywhere). */
export function setSystemCountry(code) {
  systemCountry = code || '';
}

const IMPERIAL_COUNTRIES = ['US', 'BS', 'BZ', 'KY', 'PW', 'FM', 'MH', 'LR'];

/** Feet for anyone already using feet or fathoms for depth, or where people use them. */
export function defaultHeightUnit(depth, code = systemCountry) {
  return depth !== DepthUnit.METRES || IMPERIAL_COUNTRIES.includes(code.toUpperCase()) ? HeightUnit.FEET : HeightUnit.METRES;
}

/** Until one is chosen, wind and current stay in the boat's speed unit. */
const seaSpeedLike = (speed) => SeaSpeedUnit[speed.name];

/** Fahrenheit where people use it, Celsius everywhere else. */
export function defaultTemperatureUnit(code = systemCountry) {
  const country = code.toUpperCase();
  return IMPERIAL_COUNTRIES.includes(country) ? TemperatureUnit.FAHRENHEIT : TemperatureUnit.CELSIUS;
}
export const PlanSpeedSource = { CRUISE: 'CRUISE', GPS: 'GPS' };

export const METRES_PER_NM = 1852.0;
export const FEET_PER_METRE = 3.28084;

export const normaliseDegrees = (d) => ((d % 360) + 360) % 360;

/** The signed smallest turn from [from] to [to], in -180..180 (positive = to starboard). */
export function turnDegrees(from, to) {
  const diff = normaliseDegrees(to - from);
  return diff > 180 ? diff - 360 : diff;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Display formatting for navigation values in the user's chosen units. */
export class NavFormat {
  constructor(units) {
    this.units = units;
  }

  /** A distance given in nautical miles; short ones in metres (or feet for miles). */
  distance(nm) {
    if (!Number.isFinite(nm)) return '—';
    const metres = nm * METRES_PER_NM;
    switch (this.units.distance) {
      case DistanceUnit.KILOMETRES:
        return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(2)} km`;
      case DistanceUnit.STATUTE_MILES: {
        const miles = nm * DistanceUnit.STATUTE_MILES.perNm;
        return miles < 0.1 ? `${Math.round(metres * FEET_PER_METRE)} ft` : `${miles.toFixed(2)} mi`;
      }
      default:
        return nm < 0.1 ? `${Math.round(metres)} m` : `${nm.toFixed(2)} nm`;
    }
  }

  /** A cross-track error in metres, always in a small unit, with no sign. */
  offset(metres) {
    if (!Number.isFinite(metres)) return '—';
    const m = Math.abs(metres);
    if (this.units.distance === DistanceUnit.STATUTE_MILES) return `${Math.round(m * FEET_PER_METRE)} ft`;
    if (this.units.distance === DistanceUnit.NAUTICAL_MILES && m >= 0.1 * METRES_PER_NM) return `${(m / METRES_PER_NM).toFixed(2)} nm`;
    if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
    return `${Math.round(m)} m`;
  }

  speed(knots) {
    return knots === null || knots === undefined || !Number.isFinite(knots) ? '—' : `${(knots * this.units.speed.perKnot).toFixed(1)} ${this.units.speed.label}`;
  }

  /** A depth of water; below zero the bottom is above the water ("dries 0.4 m"). */
  depth(metres) {
    if (metres === null || metres === undefined || !Number.isFinite(metres)) return '—';
    const u = this.units.depth;
    return metres < 0 ? `dries ${(-metres * u.perMetre).toFixed(1)} ${u.label}` : `${(metres * u.perMetre).toFixed(1)} ${u.label}`;
  }

  wind(knots) {
    return seaSpeed(knots, this.units.wind || SeaSpeedUnit.KNOTS);
  }

  current(knots) {
    return seaSpeed(knots, this.units.current || SeaSpeedUnit.KNOTS);
  }

  /** A wave or swell height, in metres. */
  waveHeight(metres) {
    if (metres === null || metres === undefined || !Number.isFinite(metres)) return '—';
    const u = this.units.waves || HeightUnit.METRES;
    return `${(metres * u.perMetre).toFixed(1)} ${u.label}`;
  }

  /** A tide height, in metres: to the centimetre, or to a tenth of a foot. */
  tideHeight(metres) {
    if (metres === null || metres === undefined || !Number.isFinite(metres)) return '—';
    const u = this.units.tide || HeightUnit.METRES;
    return `${(metres * u.perMetre).toFixed(u === HeightUnit.FEET ? 1 : 2)} ${u.label}`;
  }

  /** Tide chart height lines, in the tide unit: a step between lines that reads well for a tide of [rangeMetres]. */
  tideChartStep(rangeMetres) {
    const u = this.units.tide || HeightUnit.METRES;
    const range = rangeMetres * u.perMetre;
    if (u === HeightUnit.METRES) return range > 3 ? 1 : 0.5;
    return range > 12 ? 5 : range > 6 ? 2 : 1;
  }

  tideUnitsPerMetre() {
    return (this.units.tide || HeightUnit.METRES).perMetre;
  }

  /** A tide height for a small label on the chart. */
  tideMark(metres) {
    const u = this.units.tide || HeightUnit.METRES;
    return `${(metres * u.perMetre).toFixed(1)} ${u.label}`;
  }

  /** How fast the tide is moving, in metres an hour. */
  tideRate(metresPerHour) {
    const u = this.units.tide || HeightUnit.METRES;
    return `${(metresPerHour * u.perMetre).toFixed(u === HeightUnit.FEET ? 1 : 2)} ${u.label}/h`;
  }

  /** Sea level against its average, given in cm: cm, or inches with tides in feet. */
  seaLevel(cm) {
    const sign = cm >= 0 ? '+' : '';
    return this.units.tide === HeightUnit.FEET ? `${sign}${(cm / 2.54).toFixed(1)} in` : `${sign}${cm.toFixed(0)} cm`;
  }

  /** A temperature given in °C. */
  temperature(celsius) {
    if (celsius === null || celsius === undefined || !Number.isFinite(celsius)) return '—';
    const u = this.units.temperature || TemperatureUnit.CELSIUS;
    return `${u.of(celsius).toFixed(1)} ${u.label}`;
  }

  fuel(litres) {
    return litres === null || litres === undefined || !Number.isFinite(litres) ? '—' : `${(litres * this.units.fuel.perLitre).toFixed(1)} ${this.units.fuel.label}`;
  }

  /** A true bearing shown in the chosen reference; [variation] is east-positive degrees. */
  bearing(trueDegrees, variation = 0) {
    if (trueDegrees === null || trueDegrees === undefined || !Number.isFinite(trueDegrees)) return '—';
    const magnetic = this.units.bearing === BearingReference.MAGNETIC;
    const shown = magnetic ? trueDegrees - variation : trueDegrees;
    return `${pad(Math.round(normaliseDegrees(shown)) % 360, 3)}°${magnetic ? 'M' : 'T'}`;
  }

  /** "2h 05m", "45m", "<1m", or "—". */
  duration(hours) {
    if (hours === null || hours === undefined || !Number.isFinite(hours) || hours < 0) return '—';
    const total = Math.round(hours * 60);
    if (hours * 60 < 1) return '<1m';
    if (total >= 60 * 48) return `${Math.floor(total / (60 * 24))}d ${Math.floor(total / 60) % 24}h`;
    if (total >= 60) return `${Math.floor(total / 60)}h ${pad(total % 60)}m`;
    return `${total}m`;
  }

  /** A clock time, with the weekday when it is not today. */
  clock(epochMillis, nowMillis = Date.now()) {
    if (epochMillis === null || epochMillis === undefined) return '—';
    const d = new Date(epochMillis);
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toDateString() === new Date(nowMillis).toDateString() ? time : `${WEEKDAYS[d.getDay()]} ${time}`;
  }
}

/** The boat and how navigation behaves (phone defaults). */
export const DEFAULT_NAV_SETTINGS = {
  units: {
    distance: DistanceUnit.NAUTICAL_MILES,
    speed: SpeedUnit.KNOTS,
    depth: DepthUnit.METRES,
    fuel: FuelUnit.LITRES,
    bearing: BearingReference.TRUE,
    temperature: TemperatureUnit.CELSIUS,
    tide: HeightUnit.METRES,
    waves: HeightUnit.METRES,
    wind: SeaSpeedUnit.KNOTS,
    current: SeaSpeedUnit.KNOTS
  },
  cruiseSpeedKn: 6.0,
  speedSource: PlanSpeedSource.CRUISE,
  fuelBurnLph: 0.0,
  tankLitres: 0.0,
  fuelOnBoardLitres: 0.0,
  reservePercent: 20.0,
  draftM: 1.0,
  safetyMarginM: 1.0
};

export const MAX_CRUISE_KN = 100.0;

/** Usable fuel for range: on board (or a full tank) less the reserve. */
export function usableFuelLitres(s) {
  const onBoard = s.fuelOnBoardLitres > 0 ? s.fuelOnBoardLitres : s.tankLitres;
  const reserve = (Math.max(s.tankLitres, onBoard) * s.reservePercent) / 100.0;
  return Math.max(0, onBoard - reserve);
}

export const fuelSet = (s) => s.fuelBurnLph > 0;
export const minimumDepthM = (s) => s.draftM + s.safetyMarginM;

/** Litres per nautical mile at cruise, or null if fuel is not set. */
export const litresPerNm = (s) => (fuelSet(s) && s.cruiseSpeedKn > 0 ? s.fuelBurnLph / s.cruiseSpeedKn : null);

const enumOr = (table, name, fallback) => Object.values(table).find((v) => (v.name || v) === name) || fallback;
const num = (key, fallback) => {
  const v = Number.parseFloat(prefs.getString(key, ''));
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

/** Saved one key per field (the phone's keys), so a missing key keeps its default. */
export function loadNavSettings() {
  const d = DEFAULT_NAV_SETTINGS;
  const cruise = num('nav_cruise_kn', d.cruiseSpeedKn);
  const depth = enumOr(DepthUnit, prefs.getString('nav_unit_depth'), d.units.depth);
  const speed = enumOr(SpeedUnit, prefs.getString('nav_unit_speed'), d.units.speed);
  return {
    units: {
      distance: enumOr(DistanceUnit, prefs.getString('nav_unit_distance'), d.units.distance),
      speed,
      depth,
      fuel: enumOr(FuelUnit, prefs.getString('nav_unit_fuel'), d.units.fuel),
      bearing: enumOr(BearingReference, prefs.getString('nav_bearing_ref'), d.units.bearing),
      temperature: enumOr(TemperatureUnit, prefs.getString('nav_unit_temperature'), defaultTemperatureUnit()),
      tide: enumOr(HeightUnit, prefs.getString('nav_unit_tide'), defaultHeightUnit(depth)),
      waves: enumOr(HeightUnit, prefs.getString('nav_unit_waves'), defaultHeightUnit(depth)),
      wind: enumOr(SeaSpeedUnit, prefs.getString('nav_unit_wind'), seaSpeedLike(speed)),
      current: enumOr(SeaSpeedUnit, prefs.getString('nav_unit_current'), seaSpeedLike(speed))
    },
    cruiseSpeedKn: cruise > 0 && cruise <= MAX_CRUISE_KN ? cruise : d.cruiseSpeedKn,
    speedSource: PlanSpeedSource.CRUISE,
    fuelBurnLph: num('nav_burn_lph', d.fuelBurnLph),
    tankLitres: num('nav_tank_l', d.tankLitres),
    fuelOnBoardLitres: num('nav_on_board_l', d.fuelOnBoardLitres),
    reservePercent: num('nav_reserve_pct', d.reservePercent),
    draftM: num('nav_draft_m', d.draftM),
    safetyMarginM: num('nav_safety_m', d.safetyMarginM)
  };
}

export function saveNavSettings(s) {
  prefs.put('nav_unit_distance', s.units.distance.name);
  prefs.put('nav_unit_speed', s.units.speed.name);
  prefs.put('nav_unit_depth', s.units.depth.name);
  prefs.put('nav_unit_fuel', s.units.fuel.name);
  prefs.put('nav_bearing_ref', s.units.bearing);
  prefs.put('nav_unit_temperature', (s.units.temperature || TemperatureUnit.CELSIUS).name);
  prefs.put('nav_unit_tide', s.units.tide.name);
  prefs.put('nav_unit_waves', s.units.waves.name);
  prefs.put('nav_unit_wind', s.units.wind.name);
  prefs.put('nav_unit_current', s.units.current.name);
  prefs.put('nav_cruise_kn', String(s.cruiseSpeedKn));
  prefs.put('nav_burn_lph', String(s.fuelBurnLph));
  prefs.put('nav_tank_l', String(s.tankLitres));
  prefs.put('nav_on_board_l', String(s.fuelOnBoardLitres));
  prefs.put('nav_reserve_pct', String(s.reservePercent));
  prefs.put('nav_draft_m', String(s.draftM));
  prefs.put('nav_safety_m', String(s.safetyMarginM));
}
