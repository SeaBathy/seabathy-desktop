// Route planning, as on the phone (map/RouteController.kt, nav/RoutePlan.kt,
// nav/RouteDialogs.kt, nav/NavSettingsDialog.kt), without the parts that
// need the boat's GPS (GO, live navigation, alarms). Bearings are true:
// magnetic variation needs the phone's magnetic model.

import { prefs, toast, api, saveList, loadList, uuid } from '../core.js';
import { el, body, sectionHeader, caption, row, addRow, button, input, showPanel, showChoicePanel, confirm } from '../ui/panels.js';
import { icon } from '../ui/icons.js';
import {
  NavFormat, loadNavSettings, saveNavSettings, DistanceUnit, SpeedUnit, DepthUnit, FuelUnit, TemperatureUnit, HeightUnit, SeaSpeedUnit,
  usableFuelLitres, fuelSet, litresPerNm, minimumDepthM, METRES_PER_NM
} from '../nav/units.js';
import { toGpx, fromGpx } from '../geo.js';
import { sampleLonLat } from '../tif.js';
import { ToolMode, bearingDegrees, scheduleDepthQuery, refreshWaypoints } from '../app.js';

const ACCENT = '#00C8B4';
const CASING = '#0B1622';
const SAME_POINT_M = 5;
const HOUR_MS = 3_600_000;
const EMPTY = { type: 'FeatureCollection', features: [] };

function distanceM(a, b) {
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((((b.lng - a.lng) * Math.PI) / 180) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** Legs, distances, times and fuel for points at a speed (nav/RoutePlan.kt). */
export function routePlan(points, speedKn, burnLph) {
  const speed = speedKn > 0 ? speedKn : null;
  let cumulative = 0;
  let cumulativeHours = speed ? 0 : null;
  const legs = [];
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    const nm = distanceM(from, to) / METRES_PER_NM;
    cumulative += nm;
    const hours = speed ? nm / speed : null;
    cumulativeHours = hours !== null && cumulativeHours !== null ? cumulativeHours + hours : null;
    legs.push({
      number: i, from, to, distanceNm: nm, bearingTrue: bearingDegrees(from, to), cumulativeNm: cumulative,
      hours, cumulativeHours, fuelLitres: hours !== null && burnLph > 0 ? hours * burnLph : null
    });
  }
  const totalHours = speed ? cumulative / speed : null;
  return { legs, totalNm: cumulative, totalHours, totalFuelLitres: totalHours !== null && burnLph > 0 ? totalHours * burnLph : null };
}

export function create(app) {
  const map = app.map;
  let points = (prefs.getJson('route_points', []) || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  let savedId = prefs.getString('route_saved_id');
  let savedName = prefs.getString('route_saved_name');
  let library = [];
  loadList('routes').then((saved) => {
    library = saved.filter((r) => r && Array.isArray(r.points) && r.points.length >= 2).map((r) => ({ id: r.id || uuid(), name: String(r.name || 'Route'), points: r.points }));
  });
  const persistLibrary = () => saveList('routes', library);
  const settings = () => loadNavSettings();

  const changed = () => {
    prefs.put('route_points', points);
    prefs.put('route_saved_id', savedId);
    prefs.put('route_saved_name', savedName);
    refresh();
  };

  const card = document.getElementById('route-card');
  const info = document.getElementById('route-info');
  document.getElementById('btn-route-gpx').append(icon('ic_gpx'));

  function refresh() {
    const source = map.getSource('route');
    if (source) {
      const features = points.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } }));
      if (points.length >= 2) features.unshift({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) } });
      source.setData({ type: 'FeatureCollection', features });
    }
    const text = summary();
    info.textContent = text || '';
    card.hidden = !text;
  }

  /** The route card's readout, or null when the card is idle. */
  function summary(now = Date.now()) {
    const s = settings();
    const format = new NavFormat(s.units);
    const title = savedName || 'Unsaved route';
    const active = app.tool === ToolMode.ROUTE;
    if (!points.length) return active ? 'Click the map to add a point' : null;
    if (points.length < 2) return `${title} — 1 point, add another`;
    const plan = routePlan(points, s.cruiseSpeedKn, s.fuelBurnLph);
    const legs = plan.legs.length;
    const first = plan.legs[0];
    const eta = plan.totalHours !== null ? ` · ETA ${format.clock(now + plan.totalHours * HOUR_MS, now)}` : '';
    const lines = [
      `${title} — ${legs} ${legs === 1 ? 'leg' : 'legs'}, ${format.distance(plan.totalNm)}`,
      `${format.duration(plan.totalHours)} at ${format.speed(s.cruiseSpeedKn)} (cruise)${eta}`,
      `${legs > 1 ? '1st leg' : 'Course'} ${format.bearing(first.bearingTrue, 0)}`
    ];
    if (plan.totalFuelLitres !== null) {
      const usable = usableFuelLitres(s);
      const check = usable <= 0 ? '' : plan.totalFuelLitres > usable ? ` · ⚠ more than the usable ${format.fuel(usable)}` : ` · ${format.fuel(usable - plan.totalFuelLitres)} spare`;
      lines.push(`Fuel ${format.fuel(plan.totalFuelLitres)}${check}`);
    }
    return lines.join('\n');
  }

  function addPoint(lat, lng, name = null) {
    const last = points[points.length - 1];
    // A double click, or a click on the last point again, would add a leg of no length.
    if (last && distanceM(last, { lat, lng }) < SAME_POINT_M) return;
    points.push({ lat, lng, name });
    changed();
  }

  // ---------------------------------------------------------------- saving

  const isNameTaken = (name, exceptId) => library.some((r) => r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase());

  function promptName(title, initial, exceptId, onName) {
    const content = body();
    const field = input({ value: initial, placeholder: 'Route name' });
    const error = el('div', 'field-error');
    error.hidden = true;
    addRow(content, field);
    content.append(error);
    let handle;
    const save = () => {
      const name = field.value.trim();
      if (!name) {
        error.textContent = 'Enter a name';
        error.hidden = false;
      } else if (isNameTaken(name, exceptId)) {
        error.textContent = `A route called "${name}" already exists`;
        error.hidden = false;
      } else {
        handle.dismiss();
        onName(name);
      }
    };
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    handle = showPanel(title, content, { actionLabel: 'Save', onAction: save });
    setTimeout(() => { field.focus(); field.select(); }, 0);
  }

  function nextName() {
    for (let i = 1; ; i++) if (!isNameTaken(`Route ${i}`, null)) return `Route ${i}`;
  }

  /** Saves the plan on the chart; null when it has fewer than two points. */
  function saveCurrent() {
    if (points.length < 2) {
      toast('Plan a route of two or more points first');
      return null;
    }
    const existing = library.find((r) => r.id === savedId);
    if (existing) {
      existing.points = points.map((p) => ({ ...p }));
      persistLibrary();
      toast(`Saved ${existing.name}`);
      return true;
    }
    promptName('Save route', nextName(), null, (name) => {
      const route = { id: uuid(), name, points: points.map((p) => ({ ...p })) };
      library.push(route);
      persistLibrary();
      savedId = route.id;
      savedName = route.name;
      changed();
      toast(`Saved ${name}`);
    });
    return true;
  }

  async function exportRoute(route) {
    const path = await api.saveText(`${route.name}.gpx`, toGpx([], [route]), ['gpx']);
    if (path) toast(`Saved ${path}`);
  }

  function showLibrary() {
    const content = body();
    let handle;
    const s = settings();
    const format = new NavFormat(s.units);
    const top = el('div', 'pd-button-row');
    top.append(
      button('Save current route', () => { if (saveCurrent()) handle.dismiss(); }, { primary: true }),
      button('Import GPX', () => { handle.dismiss(); importFile(); })
    );
    content.append(top);
    if (!library.length) content.append(caption('No saved routes yet. Plan one on the chart and save it, or import a GPX file.'));
    for (const route of library) {
      const plan = routePlan(route.points, s.cruiseSpeedKn, s.fuelBurnLph);
      const box = el('div', 'route-box');
      box.append(el('div', 'route-name', route.name));
      box.append(el('div', 'route-detail', `${route.points.length} points • ${format.distance(plan.totalNm)} • ${format.duration(plan.totalHours)}` + (plan.totalFuelLitres !== null ? ` • ${format.fuel(plan.totalFuelLitres)}` : '')));
      const actions = el('div', 'pd-button-row');
      actions.style.marginTop = '8px';
      actions.append(
        button('Load', () => {
          handle.dismiss();
          points = route.points.map((p) => ({ ...p }));
          savedId = route.id;
          savedName = route.name;
          changed();
          const lngs = points.map((p) => p.lng);
          const lats = points.map((p) => p.lat);
          map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 80, maxZoom: 14 });
        }, { primary: true }),
        button('Reverse', () => {
          route.points.reverse();
          persistLibrary();
          handle.dismiss();
          showLibrary();
        }),
        button('Rename', () => promptName('Rename route', route.name, route.id, (name) => {
          route.name = name;
          if (savedId === route.id) savedName = name;
          persistLibrary();
          changed();
          handle.dismiss();
          showLibrary();
        }))
      );
      const more = el('div', 'pd-button-row');
      const del = button('Delete', () => confirm(`Delete ${route.name}?`, null, () => {
        library = library.filter((r) => r !== route);
        persistLibrary();
        if (savedId === route.id) {
          savedId = null;
          savedName = null;
          changed();
        }
        handle.dismiss();
        showLibrary();
      }));
      del.classList.add('text-destructive');
      more.append(button('GPX', () => exportRoute(route)), del);
      box.append(actions, more);
      addRow(content, box);
    }
    handle = showPanel('Saved routes', content);
  }

  // ---------------------------------------------------------------- legs

  /** The shallowest survey depth along a leg (from the surveys' overviews), or null with no survey there. */
  function legDepth(from, to) {
    const surveys = app.overlays.visibleDepthSurveys();
    if (!surveys.length) return null;
    const steps = Math.max(2, Math.min(400, Math.round(distanceM(from, to) / 50)));
    let shallowest = null;
    for (let i = 0; i <= steps; i++) {
      const lat = from.lat + ((to.lat - from.lat) * i) / steps;
      const lng = from.lng + ((to.lng - from.lng) * i) / steps;
      for (const survey of surveys) {
        const v = sampleLonLat(survey.model, lng, lat);
        if (v !== null && Number.isFinite(v)) {
          if (shallowest === null || v > shallowest) shallowest = v;
          break;
        }
      }
    }
    return shallowest;
  }

  function showLegs() {
    if (points.length < 2) {
      toast('Plan a route of two or more points first');
      return;
    }
    const s = settings();
    const f = new NavFormat(s.units);
    const plan = routePlan(points, s.cruiseSpeedKn, s.fuelBurnLph);
    const now = Date.now();
    const content = body();
    content.append(caption(`Departing now at ${f.speed(s.cruiseSpeedKn)}${fuelSet(s) ? `, burning ${f.fuel(s.fuelBurnLph)}/h` : ''}. Depths are survey depths (no tide).`, 0));
    const minDepth = minimumDepthM(s);
    const depths = plan.legs.map((leg) => legDepth(leg.from, leg.to));
    const surveyed = app.overlays.visibleDepthSurveys().length > 0;
    plan.legs.forEach((leg, i) => {
      const name = leg.to.name?.trim() || `Point ${leg.number + 1}`;
      const water = depths[i] === null ? null : -depths[i];
      const shallow = water !== null && water < minDepth;
      let text = `Leg ${leg.number} → ${name}\n${f.bearing(leg.bearingTrue, 0)}   ${f.distance(leg.distanceNm)}   ${f.duration(leg.hours)}`;
      if (leg.cumulativeHours !== null) text += `   arrive ${f.clock(now + leg.cumulativeHours * HOUR_MS, now)}`;
      if (leg.fuelLitres !== null) text += `   ${f.fuel(leg.fuelLitres)}`;
      text += `\nTotal ${f.distance(leg.cumulativeNm)}`;
      if (surveyed && water === null) text += '   •   no survey on this leg';
      else if (water !== null) text += `   •   least depth ${f.depth(water)}${shallow ? `  ⚠ less than ${f.depth(minDepth)}` : ''}`;
      const box = el('div', 'leg-row' + (shallow ? ' shallow' : ''), text);
      addRow(content, box, 6);
    });
    content.append(sectionHeader('TOTAL'));
    let total = `${plan.legs.length} ${plan.legs.length === 1 ? 'leg' : 'legs'}, ${f.distance(plan.totalNm)}, ${f.duration(plan.totalHours)}`;
    if (plan.totalHours !== null) total += `\nArrive ${f.clock(now + plan.totalHours * HOUR_MS, now)}`;
    if (plan.totalFuelLitres !== null) {
      total += `\nFuel ${f.fuel(plan.totalFuelLitres)}`;
      const usable = usableFuelLitres(s);
      if (usable > 0) total += plan.totalFuelLitres > usable ? `  ⚠ more than the usable ${f.fuel(usable)}` : `, leaving ${f.fuel(usable - plan.totalFuelLitres)} plus reserve`;
    }
    const known = depths.filter((d) => d !== null);
    if (known.length) {
      const water = -Math.max(...known);
      total += `\nLeast depth on route ${f.depth(water)}`;
      if (water < minDepth) total += `  ⚠ below your ${f.depth(minDepth)} (draft + margin)`;
    }
    content.append(el('div', 'leg-total', total));
    showPanel(savedName || 'Unsaved route', content);
  }

  // ---------------------------------------------------------------- boat settings

  function showBoatSettings() {
    const initial = settings();
    let units = { ...initial.units };
    const content = body();
    content.append(sectionHeader('UNITS'));
    let relabel = () => {};
    const choiceRow = (title, current, labels, selected, pick) => {
      const r = row(title, current(), () => showChoicePanel(title, labels, selected(), (i) => {
        pick(i);
        r.querySelector('.pd-row-value').textContent = current();
        relabel();
      }));
      addRow(content, r);
    };
    const dist = Object.values(DistanceUnit);
    const speeds = Object.values(SpeedUnit);
    const depths = Object.values(DepthUnit);
    const fuels = Object.values(FuelUnit);
    choiceRow('Distance', () => units.distance.label, ['Nautical miles (nm)', 'Kilometres (km)', 'Statute miles (mi)'], () => dist.indexOf(units.distance), (i) => { units.distance = dist[i]; });
    choiceRow('Speed', () => units.speed.label, ['Knots (kn)', 'km/h', 'mph'], () => speeds.indexOf(units.speed), (i) => { units.speed = speeds[i]; });
    choiceRow('Depth', () => units.depth.label, ['Metres (m)', 'Feet (ft)', 'Fathoms (fm)'], () => depths.indexOf(units.depth), (i) => { units.depth = depths[i]; });
    choiceRow('Fuel', () => units.fuel.label, ['Litres (L)', 'US gallons', 'UK gallons'], () => fuels.indexOf(units.fuel), (i) => { units.fuel = fuels[i]; });
    const temperatures = Object.values(TemperatureUnit);
    content.append(sectionHeader('TIDES AND SEA CONDITIONS'));
    const heights = Object.values(HeightUnit);
    const seaSpeeds = Object.values(SeaSpeedUnit);
    const heightLabels = ['Metres (m)', 'Feet (ft)'];
    const currentLabels = ['Knots (kn)', 'km/h', 'mph', 'Metres per second (m/s)'];
    choiceRow('Tide height', () => units.tide.label, heightLabels, () => heights.indexOf(units.tide), (i) => { units.tide = heights[i]; });
    choiceRow('Wind', () => units.wind.label, [...currentLabels, 'Beaufort (Bft)'], () => seaSpeeds.indexOf(units.wind), (i) => { units.wind = seaSpeeds[i]; });
    choiceRow('Waves and swell', () => units.waves.label, heightLabels, () => heights.indexOf(units.waves), (i) => { units.waves = heights[i]; });
    choiceRow('Current', () => units.current.label, currentLabels, () => seaSpeeds.indexOf(units.current), (i) => { units.current = seaSpeeds[i]; });
    choiceRow('Sea temperature', () => units.temperature.label, ['Celsius (°C)', 'Fahrenheit (°F)'], () => temperatures.indexOf(units.temperature), (i) => { units.temperature = temperatures[i]; });

    content.append(sectionHeader('BOAT'));
    const fields = [];
    const field = (title, unit, value) => {
      const label = caption(`${title} (${unit()})`, 2);
      const box = input({ type: 'text' });
      // An untouched field gives back the exact number it was set to, so
      // showing 6 kn as 11.11 km/h doesn't save 5.999 kn.
      let exact = 0;
      let shownText = '';
      const f = {
        set: (v) => {
          exact = v;
          shownText = v === 0 ? '0' : String(Number(v.toFixed(2)));
          box.value = shownText;
        },
        value: () => {
          if (box.value === shownText) return exact;
          const v = Number.parseFloat(box.value.replace(',', '.'));
          return Number.isFinite(v) && v >= 0 ? v : 0;
        },
        relabel: () => { label.textContent = `${title} (${unit()})`; },
        box
      };
      f.set(value);
      content.append(label);
      addRow(content, box);
      fields.push(f);
      return f;
    };
    const cruise = field('Cruise speed', () => units.speed.label, initial.cruiseSpeedKn * units.speed.perKnot);
    const burn = field('Fuel burn per hour', () => `${units.fuel.label}/h`, initial.fuelBurnLph * units.fuel.perLitre);
    const tank = field('Tank capacity', () => units.fuel.label, initial.tankLitres * units.fuel.perLitre);
    const onBoard = field('Fuel on board', () => units.fuel.label, initial.fuelOnBoardLitres * units.fuel.perLitre);
    content.append(caption('Fuel burn 0 turns the fuel figures off. Fuel on board 0 counts as a full tank.', 0));
    const reserve = field('Reserve', () => '% of tank', initial.reservePercent);
    const economy = caption('', 0);
    content.append(economy);
    const draft = field('Draft', () => units.depth.label, initial.draftM * units.depth.perMetre);
    const safety = field('Safety margin under keel', () => units.depth.label, initial.safetyMarginM * units.depth.perMetre);
    content.append(caption('Draft and margin are checked against your surveys in each leg of a route.', 4));

    let shown = { ...units };
    const read = (u) => ({
      units: { ...units, bearing: 'TRUE' },
      cruiseSpeedKn: cruise.value() / u.speed.perKnot,
      speedSource: 'CRUISE',
      fuelBurnLph: burn.value() / u.fuel.perLitre,
      tankLitres: tank.value() / u.fuel.perLitre,
      fuelOnBoardLitres: onBoard.value() / u.fuel.perLitre,
      reservePercent: Math.min(90, reserve.value()),
      draftM: draft.value() / u.depth.perMetre,
      safetyMarginM: safety.value() / u.depth.perMetre
    });
    const updateEconomy = () => {
      const s = read(shown);
      const f = new NavFormat(s.units);
      const perNm = litresPerNm(s);
      if (perNm === null) {
        economy.textContent = 'Set a fuel burn to see economy and range.';
        return;
      }
      const usable = usableFuelLitres(s);
      const range = usable > 0 ? usable / perNm : null;
      economy.textContent = `${((perNm / s.units.distance.perNm) * s.units.fuel.perLitre).toFixed(2)} ${s.units.fuel.label} per ${s.units.distance.label} at cruise.${range !== null ? `  Range ${f.distance(range)}.` : ''}`;
    };
    // Fields hold numbers in the units shown; switching units converts them.
    relabel = () => {
      const before = read(shown);
      shown = { ...units };
      cruise.set(before.cruiseSpeedKn * units.speed.perKnot);
      burn.set(before.fuelBurnLph * units.fuel.perLitre);
      tank.set(before.tankLitres * units.fuel.perLitre);
      onBoard.set(before.fuelOnBoardLitres * units.fuel.perLitre);
      draft.set(before.draftM * units.depth.perMetre);
      safety.set(before.safetyMarginM * units.depth.perMetre);
      fields.forEach((f) => f.relabel());
      updateEconomy();
    };
    [cruise, burn, tank, onBoard, reserve].forEach((f) => f.box.addEventListener('input', updateEconomy));
    updateEconomy();
    // Saved however the panel is closed: a Save button at the bottom was easy to miss.
    showPanel('Boat & units', content, {
      onDismiss: () => {
        const s = read(shown);
        if (!(s.cruiseSpeedKn > 0 && s.cruiseSpeedKn <= 100)) s.cruiseSpeedKn = initial.cruiseSpeedKn;
        saveNavSettings(s);
        document.dispatchEvent(new Event('nav-units-changed'));
        refresh();
        scheduleDepthQuery();
      }
    });
  }

  // ---------------------------------------------------------------- GPX

  function importText(name, text) {
    let result;
    try {
      result = fromGpx(text);
    } catch (error) {
      toast(error.message);
      return;
    }
    let added = 0;
    for (const w of result.waypoints) {
      let wName = w.name || app.waypoints.nextDefaultName();
      if (app.waypoints.isNameTaken(wName)) {
        let i = 2;
        while (app.waypoints.isNameTaken(`${wName} (${i})`)) i++;
        wName = `${wName} (${i})`;
      }
      app.waypoints.add({ name: wName, lat: w.lat, lng: w.lng, color: w.color || undefined, description: w.desc, icon: w.icon });
      added++;
    }
    for (const r of result.routes) {
      let rName = r.name;
      if (isNameTaken(rName, null)) {
        let i = 2;
        while (isNameTaken(`${rName} (${i})`, null)) i++;
        rName = `${rName} (${i})`;
      }
      library.push({ id: uuid(), name: rName, points: r.points });
    }
    if (result.routes.length) persistLibrary();
    if (added) refreshWaypoints();
    toast(added || result.routes.length
      ? `Imported ${added} waypoint${added === 1 ? '' : 's'} and ${result.routes.length} route${result.routes.length === 1 ? '' : 's'} from ${name}`
      : `No waypoints or routes in ${name}`);
  }

  async function importFile() {
    const file = await api.openText(['gpx']);
    if (file) importText(file.name, file.text);
  }

  async function exportAll() {
    const routes = points.length >= 2 ? [{ name: savedName || 'Route', points }] : [];
    if (!app.waypoints.all.length && !routes.length) {
      toast('No waypoints or route to export');
      return;
    }
    const path = await api.saveText('seabathy.gpx', toGpx(app.waypoints.all, routes), ['gpx']);
    if (path) toast(`Saved ${path}`);
  }

  // ---------------------------------------------------------------- card buttons

  document.getElementById('btn-route-undo').addEventListener('click', () => { points.pop(); changed(); });
  document.getElementById('btn-route-clear').addEventListener('click', () => {
    points = [];
    savedId = null;
    savedName = null;
    changed();
  });
  document.getElementById('btn-route-gpx').addEventListener('click', () => {
    if (points.length < 2) toast('Plan a route of two or more points first');
    else exportRoute({ name: savedName || 'Route', points });
  });
  document.getElementById('btn-route-save').addEventListener('click', saveCurrent);
  document.getElementById('btn-route-library').addEventListener('click', showLibrary);
  document.getElementById('btn-route-legs').addEventListener('click', showLegs);
  document.getElementById('btn-route-reverse').addEventListener('click', () => { points.reverse(); changed(); });

  const route = {
    name: 'route',
    addPoint,
    undo: () => { points.pop(); changed(); },
    onToolChanged: refresh,
    showLibrary,
    showBoatSettings,
    onStyleInstalled() {
      if (!map.getSource('route')) map.addSource('route', { type: 'geojson', data: EMPTY });
      map.addLayer({ id: 'route-casing', type: 'line', source: 'route', filter: ['==', '$type', 'LineString'], paint: { 'line-color': CASING, 'line-width': 7 } });
      map.addLayer({ id: 'route-line', type: 'line', source: 'route', filter: ['==', '$type', 'LineString'], paint: { 'line-color': ACCENT, 'line-width': 4, 'line-dasharray': [2, 1] } });
      map.addLayer({ id: 'route-points', type: 'circle', source: 'route', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 7, 'circle-color': ACCENT, 'circle-stroke-width': 2, 'circle-stroke-color': '#FFFFFF' } });
      refresh();
    }
  };
  return [route, { name: 'gpx', importText, importFile, exportAll }];
}
