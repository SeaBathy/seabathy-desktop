// Shared basics: the settings store (like the phone's SharedPreferences),
// saved lists, the debug log, toasts and small helpers.

const api = window.seabathy;

// ------------------------------------------------------------------ preferences

const values = {};
let saveTimer = null;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.saveStore('prefs', values).catch((e) => log('Prefs', `save failed: ${e.message}`));
  }, 200);
}

/** Key/value settings, read synchronously once [loadPrefs] has run. */
export const prefs = {
  getString: (key, fallback = null) => (typeof values[key] === 'string' ? values[key] : fallback),
  getBoolean: (key, fallback = false) => (typeof values[key] === 'boolean' ? values[key] : fallback),
  getNumber: (key, fallback = 0) => (typeof values[key] === 'number' && Number.isFinite(values[key]) ? values[key] : fallback),
  getJson: (key, fallback = null) => (values[key] === undefined ? fallback : values[key]),
  contains: (key) => key in values,
  put(key, value) {
    if (value === undefined || value === null) delete values[key];
    else values[key] = value;
    scheduleSave();
  },
  remove(key) {
    delete values[key];
    scheduleSave();
  }
};

export async function loadPrefs() {
  Object.assign(values, (await api.loadStore('prefs')) || {});
}

// ------------------------------------------------------------------ saved lists

const listTimers = {};

/** Saves a list store (waypoints, routes, layers…) shortly after the last change. */
export function saveList(name, data) {
  clearTimeout(listTimers[name]);
  listTimers[name] = setTimeout(() => {
    api.saveStore(name, data).catch((e) => toast(`Couldn't save ${name}: ${e.message}`));
  }, 150);
}

export async function loadList(name) {
  const data = await api.loadStore(name);
  return Array.isArray(data) ? data : [];
}

// ------------------------------------------------------------------ log

export function log(tag, message) {
  api.log(tag, message).catch(() => {});
}

export function logError(tag, message, error) {
  log(tag, `${message}: ${error?.stack || error}`);
}

// ------------------------------------------------------------------ toasts

let toastTimer = null;

/** A short message at the foot of the screen, like an Android toast. */
export function toast(message, ms = 3500) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), Math.max(ms, Math.min(8000, message.length * 60)));
}

// ------------------------------------------------------------------ helpers

export const uuid = () => crypto.randomUUID();

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** String.format("%.Nf") as the phone writes numbers: always a dot, never grouped. */
export const fixed = (v, digits) => Number(v).toFixed(digits);

/** Network GET through the main process; throws an Error with a plain message on failure. */
export async function httpGet(url, { userAgent, what = 'The service' } = {}) {
  const result = await api.httpGet(url, userAgent ? { userAgent } : undefined);
  if (result.ok) return result.body;
  if (result.error === 'offline') throw new NetworkError('No internet connection.');
  if (result.error === 'timeout') throw new NetworkError(`${what} didn't answer — check the connection and try again.`);
  if (result.error) throw new NetworkError(`Couldn't reach ${what.toLowerCase()}: ${result.error}`);
  const error = new Error(`${what} returned an error (HTTP ${result.status})`);
  error.status = result.status;
  error.body = result.body;
  throw error;
}

/** A failure to reach a service at all (no internet, DNS, timeout). */
export class NetworkError extends Error {}

export const isOnline = () => api.isOnline();

export { api };
