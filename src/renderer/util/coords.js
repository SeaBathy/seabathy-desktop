// Coordinate formats and parsing, as on the phone (util/CoordinateFormatter.kt).

export const MODE_DDM = 'DDM';
export const MODE_DD = 'DD';
export const MODE_DMS = 'DMS';
export const MODES = [MODE_DDM, MODE_DD, MODE_DMS];
export const MODE_LABELS = ['Marine — degrees and decimal minutes', 'Decimal degrees', 'Degrees, minutes and seconds'];

// Rounded to the shown precision before splitting, so 33.99999999 shows as
// 34°00.000' rather than the impossible 33°60.000'.
function ddmPart(value, positive, negative) {
  const thousandths = Math.round(Math.abs(value) * 60000);
  const degrees = Math.floor(thousandths / 60000);
  const minutes = (thousandths % 60000) / 1000;
  return `${degrees}°${minutes.toFixed(3).padStart(6, '0')}'${value >= 0 ? positive : negative}`;
}

function dmsPart(value, positive, negative) {
  const hundredths = Math.round(Math.abs(value) * 360000);
  const degrees = Math.floor(hundredths / 360000);
  const minutes = Math.floor((hundredths % 360000) / 6000);
  const seconds = (hundredths % 6000) / 100;
  return `${degrees}°${String(minutes).padStart(2, '0')}'${seconds.toFixed(2).padStart(5, '0')}"${value >= 0 ? positive : negative}`;
}

export const formatDdm = (lat, lng) => `${ddmPart(lat, 'N', 'S')} ${ddmPart(lng, 'E', 'W')}`;
export const formatDd = (lat, lng) => `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
export const formatDms = (lat, lng) => `${dmsPart(lat, 'N', 'S')} ${dmsPart(lng, 'E', 'W')}`;

export function formatPair(lat, lng, mode) {
  if (mode === MODE_DD) return formatDd(lat, lng);
  if (mode === MODE_DMS) return formatDms(lat, lng);
  return formatDdm(lat, lng);
}

const NUMBER = /[-+]?\d+(?:\.\d+)?/g;

export function parseSingle(raw, isLat) {
  const text = raw.trim().toUpperCase();
  const hemisphere = [...text].find((c) => 'NSEW'.includes(c));
  const numbers = (text.match(NUMBER) || []).map(Number);
  if (!numbers.length) return null;
  // Minutes and seconds past 59.99 are a typo, not a position.
  if (numbers.slice(1).some((n) => n < 0 || n >= 60)) return null;
  let value = numbers.length === 1 ? Math.abs(numbers[0])
    : numbers.length === 2 ? Math.abs(numbers[0]) + numbers[1] / 60
      : Math.abs(numbers[0]) + numbers[1] / 60 + numbers[2] / 3600;
  // Checked on the text: "-0 30.5" parses its degrees as -0.
  if (text.trimStart().startsWith('-') || hemisphere === 'S' || hemisphere === 'W') value = -value;
  if (hemisphere === 'N' || hemisphere === 'E') value = Math.abs(value);
  const limit = isLat ? 90 : 180;
  return value >= -limit && value <= limit ? value : null;
}

export function parsePair(raw) {
  const text = raw.trim().replace(/\n/g, ' ');
  if (!text) return null;
  const comma = text.split(',').map((s) => s.trim()).filter(Boolean);
  if (comma.length === 2) {
    const lat = parseSingle(comma[0], true);
    const lng = parseSingle(comma[1], false);
    if (lat !== null && lng !== null) return [lat, lng];
  }
  const latMatch = /(.+?[NS])/i.exec(text);
  const rest = latMatch ? text.slice(latMatch.index + latMatch[0].length) : text;
  const lngMatch = /(.+?[EW])/i.exec(rest);
  if (latMatch && lngMatch) {
    const lat = parseSingle(latMatch[0], true);
    const lng = parseSingle(lngMatch[0], false);
    if (lat !== null && lng !== null) return [lat, lng];
  }
  const numbers = text.match(NUMBER) || [];
  if (numbers.length === 2) {
    const lat = Number(numbers[0]);
    const lng = Number(numbers[1]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return [lat, lng];
  }
  return null;
}
