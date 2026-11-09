// Tides, as on the phone (tides/TideFeature.kt, tides/TideDialog.kt): the
// chip on the chart, the tide screen (now, a chart to drag along, highs and
// lows, saving offline), places picked on the map or found by name, and
// settings. A PC has no GPS, so tides are always for a saved place.

import { toast, log } from '../core.js';
import { el, body, sectionHeader, caption, row, addRow, button, input, showPanel, showChoicePanel, confirm } from '../ui/panels.js';
import { svg } from '../ui/icons.js';
import { TidePlaceStore, sunTimes, phaseName, springOrNeap, HOUR_MS } from '../tides/model.js';
import {
  TideStore, TideMode, TideDatum, loadTideSettings, saveTideSettings, SAVE_PERIODS, periodEnd,
  shownOffset, shownHeight, showsChartDatum, validChartDatum, validTideHeight
} from '../tides/store.js';
import { tideGraph } from '../tides/graph.js';
import { NavFormat, loadNavSettings, HeightUnit } from '../nav/units.js';
import { bearingDegrees } from '../app.js';

const DAY_MS = 24 * HOUR_MS;
const TICK_MS = 60_000;
const RETRY_MS = 5 * 60_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
const hm = (t) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const clock = (t, now) => (now === null || sameDay(t, now) ? hm(t) : `${WEEKDAYS[new Date(t).getDay()]} ${hm(t)}`);
const dateText = (t) => {
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};
const dayMonth = (t) => {
  const d = new Date(t);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
const inHours = (ms) => {
  const minutes = Math.round(Math.abs(ms) / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m` : `${minutes}m`;
};
const size = (bytes) => (bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);
const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.trunc((deg + 22.5) / 45) % 8];

/** Local midnight [offset] days from [now]'s day. */
function startOfDay(now, offset) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.getTime();
}

function distanceKm(aLat, aLng, bLat, bLng) {
  const p1 = (aLat * Math.PI) / 180;
  const p2 = (bLat * Math.PI) / 180;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((((bLng - aLng) * Math.PI) / 180) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}

const modeLabel = (m) => ({ MODEL: 'Forecast (free, works offline once saved)', MANUAL: 'Manual height', OFF: 'Off' }[m]);
const datumLabel = (d) => (d === TideDatum.MEAN_SEA_LEVEL ? 'Mean sea level' : 'Chart datum (lowest tide, LAT)');

/** A row with an accent icon at its start. */
function option(iconName, title, detail, selected, onClick) {
  const node = row(title, detail, onClick);
  node.classList.add('with-icon');
  if (selected) node.classList.add('selected');
  const glyph = el('span', 'row-icon');
  glyph.innerHTML = svg(iconName);
  node.prepend(glyph);
  return node;
}

export function create(app) {
  let settings = loadTideSettings();
  const places = new TidePlaceStore();
  const store = new TideStore();
  let refreshing = false;
  let saving = false;
  let lowestRunning = false;
  let lowestFailedAt = 0;
  let lastError = null;
  let lastFailedAt = 0;
  let main = null;
  let dayOffset = 0;
  let picking = false;

  const key = () => settings.placeId || 'none';
  const place = () => places.byId(settings.placeId);
  const forecast = () => (place() ? store.forecast(key()) : null);
  const position = () => {
    const p = place();
    return p ? [p.lat, p.lng] : null;
  };

  function update(next) {
    settings = next;
    saveTideSettings(next);
  }

  // A saved place that was deleted falls back to none.
  if (settings.placeId && !place()) update({ ...settings, placeId: null });

  // ---------------------------------------------------------------- chip

  const chip = el('button', 'tide-chip');
  chip.title = 'Tide — open the tide screen';
  chip.hidden = true;
  chip.addEventListener('click', () => show());
  document.getElementById('map-chips').prepend(chip);

  const banner = el('div', 'cond-pick');
  banner.hidden = true;
  const bannerButtons = el('div', 'pd-button-row');
  bannerButtons.append(button('Cancel', () => endMapPick()), button('Save this spot', () => saveMapPick(), { primary: true }));
  banner.append(el('div', 'cond-pick-title', 'Pick a tide spot'), el('div', 'cond-pick-text', 'Put the centre dot on the water, then save.'), bannerButtons);
  document.body.append(banner);

  const heightFormat = () => new NavFormat(loadNavSettings().units);
  document.addEventListener('nav-units-changed', () => refreshChip());

  function refreshChip() {
    const s = settings;
    const now = Date.now();
    if (!s.showChip || s.mode === TideMode.OFF || picking) {
      chip.hidden = true;
      return;
    }
    const name = place()?.name;
    const where = name ? `${name.length > 14 ? `${name.slice(0, 13)}…` : name} ` : '';
    if (s.mode === TideMode.MANUAL) {
      chip.textContent = `Tide ${heightFormat().tideHeight(s.manualHeightM)} (manual)`;
    } else {
      const f = forecast();
      const height = shownHeight(s, f, now);
      if (!f || height === null) {
        chip.textContent = !s.locationChosen || !place() ? 'Tides: click to set up' : `${where}Tide —`;
      } else {
        const rate = f.curve.rateMPerHour(now) ?? 0;
        const arrow = rate > 0.02 ? '▲' : rate < -0.02 ? '▼' : '■';
        const next = f.curve.nextExtremes(now, 1)[0];
        chip.textContent = `${where || 'Tide '}${arrow} ${heightFormat().tideHeight(height)}${next ? ` • ${next.isHigh ? 'H' : 'L'} ${hm(next.timeMillis)}` : ''}`;
      }
    }
    chip.hidden = false;
  }

  // ---------------------------------------------------------------- downloading

  async function refreshIfNeeded(force = false) {
    if (settings.mode !== TideMode.MODEL) return;
    const p = position();
    if (!p) return;
    // Don't retry a failing download over and over.
    if (!force && Date.now() - lastFailedAt < RETRY_MS) return;
    if (force || store.needsRefresh(key(), p[0], p[1])) await refresh(false);
    else ensureLowest();
  }

  /** Works out chart datum (the lowest tide) once per place, so heights read like a tide table. */
  async function ensureLowest() {
    if (settings.mode !== TideMode.MODEL || lowestRunning) return;
    const p = position();
    if (!p || !store.needsLowest(key(), p[0], p[1])) return;
    if (Date.now() - lowestFailedAt < RETRY_MS) return;
    const forKey = key();
    lowestRunning = true;
    try {
      await store.findLowest(forKey, p[0], p[1]);
      if (forKey !== key()) return;
      refreshChip();
      if (main?.isShowing) showMain();
    } catch (error) {
      lowestFailedAt = Date.now();
      log('TideFeature', `chart datum failed: ${error.message}`);
    } finally {
      lowestRunning = false;
    }
  }

  async function refresh(manual) {
    if (refreshing) return;
    const p = position();
    if (!p) {
      if (manual) toast('Choose a place for the tides first');
      return;
    }
    const forKey = key();
    refreshing = true;
    if (main?.isShowing && !forecast()) showMain();
    try {
      await store.refresh(forKey, p[0], p[1]);
      lastError = null;
      if (manual) toast('Tides updated');
    } catch (error) {
      lastFailedAt = Date.now();
      lastError = error.message || "Couldn't download tides";
      if (manual) toast(lastError);
      log('TideFeature', `tide refresh failed: ${error.message}`);
    } finally {
      refreshing = false;
    }
    if (forKey !== key()) return;
    refreshChip();
    if (main?.isShowing || manual) showMain();
    ensureLowest();
  }

  /** Downloads a year of tides for the place and keeps [period] of predictions offline. */
  async function saveOffline(period) {
    const target = place();
    if (!target || saving) return;
    saving = true;
    showMain();
    try {
      const f = await store.saveOffline(target.id, target.lat, target.lng, period);
      lastError = null;
      toast(`Tides saved offline until ${dateText(f.savedUntilMillis)}`);
    } catch (error) {
      lastError = error.message || "Couldn't save tides";
    }
    saving = false;
    refreshChip();
    if (key() === target.id) showMain();
  }

  async function select(placeId) {
    // Choosing a place means wanting its forecast, whatever the source was before.
    update({ ...settings, placeId, locationChosen: true, mode: TideMode.MODEL });
    lastError = null;
    await store.load(key());
    refreshChip();
    showMain();
    refreshIfNeeded(!forecast());
  }

  // ---------------------------------------------------------------- screens

  function show() {
    if (!settings.locationChosen || !place()) showLocationPicker();
    else showMain(true);
  }

  function closeMain() {
    main?.dismiss();
    main = null;
  }

  function whereLine(f, now) {
    const s = settings;
    if (s.mode === TideMode.MANUAL) return 'Manual tide from your tide table';
    if (s.mode === TideMode.OFF) return 'Tides off';
    if (!f) return 'Saved place';
    const km = distanceKm(f.requestLat, f.requestLng, f.modelLat, f.modelLng);
    const name = place()?.name || 'the spot';
    const point = km < 1 ? `Tide point at ${name}`
      : `Tide point ${km.toFixed(1)} km ${compass(bearingDegrees({ lat: f.requestLat, lng: f.requestLng }, { lat: f.modelLat, lng: f.modelLng }))} of ${name}`;
    return `${point} · updated ${clock(f.fetchedMillis, now)}`;
  }

  function nowCard(parent, big, line, next) {
    const card = el('div', 'tide-now');
    card.append(el('div', 'tide-now-label', 'NOW'), el('div', 'tide-now-big', big), el('div', 'tide-now-line', line));
    if (next) card.append(el('div', 'tide-now-next', `Next: ${next}`));
    parent.append(card);
  }

  async function showMain(resetDay = false) {
    if (resetDay) dayOffset = 0;
    const savedUntil = await store.savedUntil(key());
    closeMain();
    const content = body();
    const s = settings;
    const now = Date.now();
    const f = forecast();
    const offset = shownOffset(s, f);
    const format = heightFormat();
    const curve = f && f.curve.covers(now) ? f.curve : null;

    const where = el('div', 'tide-where');
    const whereText = el('div', 'tide-where-text');
    const title = el('div', 'tide-where-title');
    title.innerHTML = `<span class="row-icon">${svg('ic_place_pin')}</span>`;
    title.append(place()?.name || 'No place chosen');
    whereText.append(title, el('div', 'tide-where-line', whereLine(f, now)));
    where.append(whereText, button('Change', () => showLocationPicker()));
    addRow(content, where);

    if (s.mode === TideMode.OFF) {
      content.append(caption('Tides are off. Turn them on in Settings.'));
    } else if (s.mode === TideMode.MANUAL) {
      nowCard(content, format.tideHeight(s.manualHeightM), 'Manual height', null);
    } else if ((refreshing || saving) && !curve) {
      content.append(el('div', 'tide-status', 'Getting tides…'));
    } else if (!curve) {
      content.append(el('div', 'tide-message', lastError || 'No tides downloaded for here yet.'));
      addRow(content, button('Get tides', () => refresh(true), { primary: true }));
    } else {
      const h = curve.heightAt(now) + offset;
      const rate = curve.rateMPerHour(now) ?? 0;
      const trend = rate > 0.02 ? `▲ Rising ${format.tideRate(rate)}` : rate < -0.02 ? `▼ Falling ${format.tideRate(-rate)}` : '■ Slack';
      const next = curve.nextExtremes(now, 1)[0];
      nowCard(content, format.tideHeight(h), trend, next
        ? `${next.isHigh ? 'High' : 'Low'} ${clock(next.timeMillis, now)} · ${format.tideHeight(next.heightM + offset)} · in ${inHours(next.timeMillis - now)}`
        : null);
      // With tides saved offline, a failed forecast update doesn't matter.
      if (lastError && !((savedUntil ?? 0) > now)) content.append(caption(`Couldn't update: ${lastError}`));
      chartSection(content, f, offset, now);
    }

    if (s.mode === TideMode.MODEL && place()) offlineSection(content, f, savedUntil);

    const buttons = el('div', 'pd-button-row');
    buttons.style.marginTop = '14px';
    if (s.mode === TideMode.MODEL) buttons.append(button('Refresh', () => refresh(true)));
    buttons.append(button('Settings', () => {
      closeMain();
      showSettings();
    }));
    content.append(buttons);
    content.append(caption((showsChartDatum(s, f)
      ? 'Heights above the lowest tide (chart datum, LAT), like a tide table. '
      : 'Heights from mean sea level — lows read below zero until the lowest tide here is worked out (needs a connection, once). ') +
      'Modelled tides, worked out from Open-Meteo data (CC BY 4.0, E.U. Copernicus Marine Service). Not an official tide table. Not for navigation.'));
    const handle = showPanel('Tides', content, { onDismiss: () => { if (main === handle) main = null; } });
    main = handle;
  }

  function chartSection(parent, f, offset, now) {
    const curve = f.curve;
    const section = el('div', 'tide-chart');
    parent.append(section);
    const lastDay = Math.trunc(((curve.endMillis ?? now) - startOfDay(now, 0)) / DAY_MS) - 1;
    const firstDay = -1;
    dayOffset = Math.min(Math.max(0, lastDay), Math.max(firstDay, dayOffset));

    const nights = (from, to) => {
      const suns = [];
      for (let noon = startOfDay(from, 0) + DAY_MS / 2; noon < to + DAY_MS; noon += DAY_MS) {
        const st = sunTimes(noon, f.requestLat, f.requestLng);
        if (st) suns.push(st);
      }
      return suns.slice(0, -1).map((today, i) => [today[1], suns[i + 1][0]]);
    };

    const sunAndMoon = (noon) => {
      const st = sunTimes(noon, f.requestLat, f.requestLng);
      const sun = st ? `Sunrise ${hm(st[0])} · Sunset ${hm(st[1])} · ` : '';
      const moon = phaseName(noon);
      const spring = springOrNeap(noon);
      return sun + (spring ? `${moon}, ${spring}` : moon);
    };

    const dayLabel = (o) => (o === 0 ? 'Today' : o === 1 ? 'Tomorrow' : o === -1 ? 'Yesterday' : `${dayMonth(startOfDay(now, o))} ${new Date(startOfDay(now, o)).getFullYear()}`);

    function render() {
      section.replaceChildren();
      const nav = el('div', 'tide-day-nav');
      const prev = el('button', 'tide-icon-button');
      prev.innerHTML = svg('ic_chevron_left');
      prev.title = 'Previous day';
      prev.disabled = dayOffset <= firstDay;
      prev.addEventListener('click', () => { dayOffset--; render(); });
      const next = el('button', 'tide-icon-button');
      next.innerHTML = svg('ic_chevron_right');
      next.title = 'Next day';
      next.disabled = dayOffset >= lastDay;
      next.addEventListener('click', () => { dayOffset++; render(); });
      const label = el('input', 'tide-day-label');
      label.type = 'date';
      label.title = 'Choose a date';
      const day = new Date(startOfDay(now, dayOffset));
      label.value = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
      label.min = new Date(startOfDay(now, firstDay)).toISOString().slice(0, 10);
      label.max = new Date(startOfDay(now, Math.max(0, lastDay))).toISOString().slice(0, 10);
      const labelText = el('div', 'tide-day-text', dayLabel(dayOffset));
      const labelBox = el('label', 'tide-day-box');
      labelBox.append(labelText, label);
      label.addEventListener('change', () => {
        const [y, m, d] = label.value.split('-').map(Number);
        const chosen = new Date(y, m - 1, d, 12).getTime();
        dayOffset = Math.min(lastDay, Math.max(firstDay, Math.round((chosen - startOfDay(now, 0) - DAY_MS / 2) / DAY_MS)));
        render();
      });
      nav.append(prev, labelBox);
      if (dayOffset !== 0) nav.append(button('Today', () => { dayOffset = 0; render(); }));
      nav.append(next);
      section.append(nav);

      const start = dayOffset === 0 ? now - 3 * HOUR_MS : startOfDay(now, dayOffset);
      section.append(tideGraph({ curve, offset, now, windowStart: start, format: heightFormat(), nights: nights(start - DAY_MS, start + 3 * DAY_MS) }));
      section.append(caption(sunAndMoon(startOfDay(now, dayOffset) + DAY_MS / 2), 6));
      section.append(caption('Drag along the chart to see the tide at any time.', 2));

      section.append(sectionHeader('HIGHS AND LOWS'));
      const from = startOfDay(now, dayOffset);
      const byDay = new Map();
      for (const e of curve.extremes(from, from + 3 * DAY_MS)) {
        const d = new Date(e.timeMillis);
        const name = `${WEEKDAYS_LONG[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
        if (!byDay.has(name)) byDay.set(name, []);
        byDay.get(name).push(e);
      }
      for (const [name, items] of byDay) {
        section.append(el('div', 'tide-day-name', name));
        const rowEl = el('div', 'tide-extremes');
        for (const e of items.slice(0, 4)) {
          const cell = el('div', 'tide-extreme' + (e.isHigh ? ' high' : '') + (e.timeMillis < now ? ' past' : ''));
          cell.append(el('div', 'tide-extreme-kind', e.isHigh ? '▲ High' : '▼ Low'), el('div', 'tide-extreme-time', clock(e.timeMillis, null)), el('div', 'tide-extreme-height', heightFormat().tideHeight(e.heightM + offset)));
          rowEl.append(cell);
        }
        for (let i = items.length; i < 4; i++) rowEl.append(el('div', 'tide-extreme empty'));
        section.append(rowEl);
      }
    }
    render();
  }

  function offlineSection(parent, f, until) {
    parent.append(sectionHeader('OFFLINE'));
    const now = Date.now();
    const bytes = f?.storedBytes || 0;
    const forecastEnd = f && (until === null || until < now) ? f.curve.endMillis : null;
    let line;
    if (saving) line = 'Saving tides… this takes a few seconds.';
    else if (until !== null && until >= now) line = `Saved offline until ${dateText(until)} · ${size(bytes)}`;
    else if (until !== null) line = `Saved tides ran out on ${dateText(until)}. Renew to keep them offline.`;
    else if (forecastEnd) line = `Live forecast to ${dayMonth(forecastEnd)} · ${size(bytes)}`;
    else line = 'Nothing saved yet.';
    parent.append(el('div', 'tide-offline-line', line));
    if (saving) return;
    const rowEl = el('div', 'pd-button-row');
    const label = until === null ? 'Save offline' : until < now ? 'Renew' : 'Save longer';
    const save = button(label, () => {
      // Each choice shows the day it runs to, so a shorter pick can't quietly cut saved tides back.
      const ends = SAVE_PERIODS.map((p) => periodEnd(p));
      const current = until !== null && until >= now ? until : null;
      const title = current === null ? 'Keep tides offline for' : `Keep tides offline for (saved to ${dateText(current)} now)`;
      showChoicePanel(title, SAVE_PERIODS.map((p, i) => `${p.label} · to ${dateText(ends[i])}`), -1, (i) => {
        if (current !== null && ends[i] < current) {
          confirm('Keep fewer tides?', `Tides here are saved to ${dateText(current)}. This keeps them only to ${dateText(ends[i])}.`, () => saveOffline(SAVE_PERIODS[i]), { confirmLabel: 'Keep fewer' });
        } else {
          saveOffline(SAVE_PERIODS[i]);
        }
      });
    }, { primary: until === null || until < now });
    save.prepend(Object.assign(el('span', 'button-icon'), { innerHTML: svg('ic_save_offline') }));
    rowEl.append(save);
    if (bytes > 0) {
      const del = button('Delete', () => confirm('Delete saved tides?', 'They can be downloaded again any time.', async () => {
        await store.deleteSaved(key());
        lastError = null;
        refreshChip();
        showMain();
      }));
      del.prepend(Object.assign(el('span', 'button-icon'), { innerHTML: svg('ic_delete') }));
      rowEl.append(del);
    }
    parent.append(rowEl);
  }

  async function showLocationPicker() {
    closeMain();
    const content = body();
    let handle;
    content.append(caption('Tides use the nearest ocean point to where you choose.', 0));
    addRow(content, option('ic_map_pick', 'Pick on the map', 'A harbour, reef or ramp', false, () => { handle.dismiss(); startMapPick(); }));
    addRow(content, option('ic_search', 'Search a place', 'A town or harbour by name', false, () => { handle.dismiss(); showSearch(); }));
    const all = places.all;
    if (all.length) {
      content.append(sectionHeader('SAVED PLACES'));
      const now = Date.now();
      for (const p of all) {
        const until = await store.savedUntil(p.id);
        const detail = until === null ? 'Live forecast only' : until >= now ? `Offline until ${dateText(until)}` : `Offline tides ran out ${dateText(until)}`;
        const line = el('div', 'tide-place-row');
        const choose = option('ic_place_pin', p.name, detail, p.id === settings.placeId, () => { handle.dismiss(); select(p.id); });
        const remove = el('button', 'tide-icon-button');
        remove.innerHTML = svg('ic_delete');
        remove.title = `Remove ${p.name}`;
        remove.addEventListener('click', () => confirm(`Remove ${p.name}?`, 'Its saved tides are deleted too.', async () => {
          handle.dismiss();
          places.delete(p.id);
          await store.forget(p.id);
          if (settings.placeId === p.id) {
            update({ ...settings, placeId: null });
            refreshChip();
          }
          showLocationPicker();
        }, { confirmLabel: 'Remove' }));
        line.append(choose, remove);
        addRow(content, line);
      }
    }
    handle = showPanel('Tides for', content);
  }

  function showSearch() {
    const content = body();
    let handle;
    const field = input({ placeholder: 'Town, harbour or bay' });
    addRow(content, field);
    const status = caption('', 0);
    const results = el('div');
    content.append(status, results);
    const run = async () => {
      const query = field.value.trim();
      if (query.length < 2) {
        status.textContent = 'Type at least two letters.';
        return;
      }
      status.textContent = 'Searching…';
      results.replaceChildren();
      try {
        const found = await store.search(query);
        if (!found.length) {
          status.textContent = `Nothing found for "${query}".`;
          return;
        }
        status.textContent = 'Click one to save it.';
        for (const r of found) {
          addRow(results, option('ic_place_pin', r.name, r.detail || `${r.lat.toFixed(3)}, ${r.lng.toFixed(3)}`, false, () => {
            handle.dismiss();
            const saved = places.add(r.name, r.lat, r.lng);
            select(saved.id);
          }));
        }
      } catch (error) {
        status.textContent = error.message || 'Search failed';
      }
    };
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    addRow(content, button('Search', run, { primary: true }));
    handle = showPanel('Search a place', content);
    setTimeout(() => field.focus(), 0);
  }

  function startMapPick() {
    document.getElementById('side-panel').classList.remove('open');
    document.getElementById('scrim').hidden = true;
    picking = true;
    banner.hidden = false;
    chip.hidden = true;
  }

  function endMapPick() {
    picking = false;
    banner.hidden = true;
    refreshChip();
  }

  async function saveMapPick() {
    const c = app.map.getCenter();
    endMapPick();
    const nearby = await store.nearbyName(c.lat, c.lng).catch(() => null);
    const suggested = nearby || `Spot ${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}`;
    const content = body();
    const field = input({ value: suggested });
    addRow(content, field);
    if (nearby) content.append(caption('Suggested name from © OpenStreetMap contributors (ODbL).', 2));
    const handle = showPanel('Name this spot', content, {
      actionLabel: 'Save',
      onAction: () => {
        handle.dismiss();
        const saved = places.add(field.value.trim() || suggested, c.lat, c.lng);
        select(saved.id);
      }
    });
    setTimeout(() => { field.focus(); field.select(); }, 0);
  }

  function showSettings() {
    const content = body();
    let mode = settings.mode;
    let datum = settings.datum;
    const modes = [TideMode.MODEL, TideMode.MANUAL, TideMode.OFF];
    const modeRow = row('Tides from', modeLabel(mode), () => showChoicePanel('Tides from', modes.map(modeLabel), modes.indexOf(mode), (i) => {
      mode = modes[i];
      modeRow.querySelector('.pd-row-value').textContent = modeLabel(mode);
    }));
    addRow(content, modeRow);
    const datums = [TideDatum.MEAN_SEA_LEVEL, TideDatum.CHART_DATUM];
    const datumRow = row('Survey depths are from', datumLabel(datum), () => showChoicePanel('Survey depths are from', datums.map(datumLabel), datums.indexOf(datum), (i) => {
      datum = datums[i];
      datumRow.querySelector('.pd-row-value').textContent = datumLabel(datum);
    }));
    addRow(content, datumRow);
    const height = loadNavSettings().units.tide;
    const shown = (metres) => (metres * height.perMetre).toFixed(2);
    content.append(caption(`Lowest tide (chart datum) below mean sea level, ${height.label}`, 2));
    const auto = forecast()?.lowestTideM;
    const datumOffset = input({ value: settings.chartDatumAuto ? '' : shown(settings.chartDatumBelowMslM), placeholder: auto !== null && auto !== undefined ? `Auto: ${shown(-auto)} here` : 'Auto' });
    const datumShown = datumOffset.value;
    addRow(content, datumOffset);
    content.append(caption(`Leave empty to work it out from the tide model. Type your tide table's value (0–${height === HeightUnit.FEET ? 32 : 10} ${height.label}) to use that instead.`, 0));
    content.append(caption(`Manual tide height, from a tide table (${height.label})`, 2));
    const manual = input({ value: shown(settings.manualHeightM) });
    const manualShown = manual.value;
    // Left as shown keeps the exact value: rounding through another unit would slowly change it.
    const typedMetres = (field, was, original) => (field.value === was && was
      ? original
      : Number.parseFloat(field.value.replace(',', '.')) / height.perMetre);
    addRow(content, manual);
    const check = (label, checked) => {
      const wrap = el('label', 'pd-check');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = checked;
      wrap.append(box, el('span', '', label));
      return { wrap, box };
    };
    const chipCheck = check('Show the tide on the chart', settings.showChip);
    addRow(content, chipCheck.wrap, 2);
    showPanel('Tide settings', content, {
      onDismiss: () => {
        // Anything empty or out of reason means auto / unchanged.
        const typed = typedMetres(datumOffset, datumShown, settings.chartDatumBelowMslM);
        const typedDatum = validChartDatum(typed) ? typed : null;
        const typedManual = typedMetres(manual, manualShown, settings.manualHeightM);
        const modeChanged = mode !== settings.mode;
        update({
          ...settings, mode, datum,
          chartDatumAuto: typedDatum === null,
          chartDatumBelowMslM: typedDatum ?? settings.chartDatumBelowMslM,
          manualHeightM: validTideHeight(typedManual) ? typedManual : settings.manualHeightM,
          showChip: chipCheck.box.checked
        });
        refreshChip();
        if (modeChanged && mode === TideMode.MODEL) refreshIfNeeded();
        showMain();
      }
    });
  }

  // ---------------------------------------------------------------- start

  (async () => {
    if (place()) await store.load(key());
    refreshChip();
    refreshIfNeeded();
  })();
  setInterval(refreshChip, TICK_MS);
  window.addEventListener('focus', () => refreshIfNeeded());

  return {
    name: 'tides',
    showMain: () => show(),
    onConnectivityRestored: () => refreshIfNeeded()
  };
}
