// Waypoints, as on the phone: the store (data/WaypointStore.kt), the list in
// the side panel (ui/WaypointPanelBinder.kt), the new-waypoint sheet
// (ui/NewWaypointSheet.kt), the editor (ui/WaypointEditDialog.kt) and the
// coordinate editor (ui/CoordinateEditorDialog.kt).

import { el, button, input, sectionHeader, confirm, closeButton } from './panels.js';
import { svg } from './icons.js';
import { saveList, loadList, uuid } from '../core.js';
import { formatDdm, formatPair, parsePair, MODES, MODE_LABELS } from '../util/coords.js';

export const DEFAULT_COLOR = '#EF4444';
export const PALETTE = ['#EF4444', '#F97316', '#EAB308', '#22C55E', '#3B82F6', '#A855F7'];
export const ICONS = [
  { id: 'marker', label: 'Marker', drawable: 'ic_wpt_marker' },
  { id: 'diamond', label: 'Diamond', drawable: 'ic_wpt_diamond' },
  { id: 'flag', label: 'Flag', drawable: 'ic_wpt_flag' },
  { id: 'anchor', label: 'Anchor', drawable: 'ic_wpt_anchor' },
  { id: 'fish', label: 'Fishing spot', drawable: 'ic_wpt_fish' },
  { id: 'wreck', label: 'Wreck', drawable: 'ic_wpt_wreck' },
  { id: 'mob', label: 'Man overboard', drawable: 'ic_wpt_mob' }
];
export const DEFAULT_ICON_ID = 'marker';
export const iconById = (id) => ICONS.find((i) => i.id === id) || ICONS[0];

// ------------------------------------------------------------------ store

export class WaypointStore {
  constructor() {
    this.all = [];
  }

  async load() {
    this.all = (await loadList('waypoints')).filter((w) => w && Number.isFinite(w.lat) && Number.isFinite(w.lng));
    for (const w of this.all) {
      w.name = String(w.name || 'WPT');
      w.color = w.color || DEFAULT_COLOR;
      w.icon = w.icon || DEFAULT_ICON_ID;
    }
  }

  save() {
    saveList('waypoints', this.all);
  }

  byId(id) {
    return this.all.find((w) => w.id === id) || null;
  }

  isNameTaken(name, except = null) {
    return this.all.some((w) => w !== except && w.name.toLowerCase() === name.toLowerCase());
  }

  nextDefaultName() {
    for (let i = 1; ; i++) if (!this.isNameTaken(`WPT ${i}`)) return `WPT ${i}`;
  }

  add({ name, lat, lng, color = DEFAULT_COLOR, description = '', icon = DEFAULT_ICON_ID }) {
    const w = { id: uuid(), name, lat, lng, color, desc: description || null, icon };
    this.all.push(w);
    return w;
  }

  remove(w) {
    this.all = this.all.filter((x) => x !== w);
  }
}

// ------------------------------------------------------------------ list

export function renderWaypointList(container, search, waypoints, { onGoTo, onEdit }) {
  const query = search.value.trim().toLowerCase();
  container.replaceChildren();
  const matches = waypoints.filter((w) => w.name.toLowerCase().includes(query) || (w.desc || '').toLowerCase().includes(query));
  if (!matches.length) {
    container.append(el('div', 'empty-note', waypoints.length ? 'No matching waypoints' : 'No waypoints yet'));
    return;
  }
  for (const w of matches) {
    const row = el('div', 'wl-row');
    const dot = el('span', 'wl-dot');
    dot.style.background = w.color || DEFAULT_COLOR;
    const text = el('div', 'wl-text');
    text.append(el('div', 'wl-name', w.name), el('div', 'wl-desc', (w.desc || '').trim() || formatDdm(w.lat, w.lng)));
    const go = el('button', 'chip go', 'GO');
    go.title = `Go to ${w.name}`;
    go.addEventListener('click', () => onGoTo(w));
    const edit = el('button', 'chip edit', 'EDIT');
    edit.title = `Edit ${w.name}`;
    edit.addEventListener('click', () => onEdit(w));
    row.append(dot, text, go, edit);
    container.append(row);
  }
}

// ------------------------------------------------------------------ a plain card dialog

function cardDialog({ title, withClose = true }) {
  const scrim = el('div', 'pd-scrim');
  const card = el('div', 'pd-card pd-plain');
  const header = el('div', 'pd-plain-header');
  header.append(el('div', 'pd-title', title));
  const dismiss = () => {
    scrim.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  function onKey(event) {
    if (event.key === 'Escape' && scrim.isConnected && scrim === document.querySelector('.pd-scrim:last-of-type')) {
      event.stopPropagation();
      dismiss();
    }
  }
  if (withClose) header.append(closeButton(dismiss));
  card.append(header);
  scrim.append(card);
  document.addEventListener('keydown', onKey, true);
  document.body.append(scrim);
  return { card, dismiss };
}

// ------------------------------------------------------------------ coordinate editor

/**
 * DD, DDM or DMS entry with a live preview. onPositive(lat, lng); with
 * onMoveMap a "Move map" button goes there instead.
 */
export function showCoordinateEditor({ title, lat, lng, positiveLabel, onMoveMap = null, onPositive }) {
  const { card, dismiss } = cardDialog({ title });
  card.append(sectionHeader('FORMAT'));
  const format = el('select', 'pd-select');
  MODE_LABELS.forEach((label, i) => format.append(new Option(label, MODES[i])));
  card.append(format);
  card.append(sectionHeader('COORDINATES'));
  const field = input({ value: formatDdm(lat, lng), placeholder: 'Paste latitude and longitude', multiline: true });
  field.rows = 2;
  field.classList.add('mono');
  card.append(field);
  card.append(sectionHeader('PREVIEW'));
  const preview = el('div', 'pd-preview', formatDdm(lat, lng));
  card.append(preview);
  const error = el('div', 'field-error');
  error.hidden = true;

  format.addEventListener('change', () => {
    const parsed = parsePair(field.value) || [lat, lng];
    field.value = formatPair(parsed[0], parsed[1], format.value);
    preview.textContent = formatDdm(parsed[0], parsed[1]);
  });
  field.addEventListener('input', () => {
    const parsed = parsePair(field.value);
    preview.textContent = parsed ? formatDdm(parsed[0], parsed[1]) : 'Enter valid coordinates';
    preview.style.color = parsed ? '' : 'var(--destructive)';
    error.hidden = true;
  });
  const parsedOrError = () => {
    const parsed = parsePair(field.value);
    if (!parsed) {
      error.textContent = 'Use DD, DDM or DMS coordinates';
      error.hidden = false;
    }
    return parsed;
  };

  const actions = el('div', 'pd-plain-actions');
  actions.append(button('Cancel', dismiss));
  if (onMoveMap) {
    actions.append(button('Move map', () => {
      const p = parsedOrError();
      if (!p) return;
      onMoveMap(p[0], p[1]);
      dismiss();
    }));
  }
  actions.append(button(positiveLabel, () => {
    const p = parsedOrError();
    if (!p) return;
    onPositive(p[0], p[1]);
    dismiss();
  }, { primary: true }));
  card.append(error, actions);
  setTimeout(() => { field.focus(); field.select(); }, 0);
}

// ------------------------------------------------------------------ editor

export function showWaypointEditor(w, { isNameTaken, onChanged, onJumpTo, onDelete }) {
  const { card, dismiss } = cardDialog({ title: 'Waypoint', withClose: false });
  const name = input({ value: w.name, placeholder: 'Name' });
  name.style.marginTop = '14px';
  const nameError = el('div', 'field-error');
  nameError.hidden = true;
  nameError.style.margin = '6px 0 0 4px';
  const coordinates = el('button', 'pd-coord-link');
  const label = () => `${formatDdm(w.lat, w.lng)}   •   EDIT COORDINATES`;
  coordinates.textContent = label();
  coordinates.addEventListener('click', () => showCoordinateEditor({
    title: 'Waypoint coordinates', lat: w.lat, lng: w.lng, positiveLabel: 'Save',
    onPositive: (lat, lng) => {
      w.lat = lat;
      w.lng = lng;
      coordinates.textContent = label();
      onChanged();
    }
  }));
  const desc = input({ value: w.desc || '', placeholder: 'Description / notes', multiline: true });

  const actions = el('div', 'pd-plain-actions');
  const del = el('button', 'pd-text-button destructive', 'Delete');
  del.addEventListener('click', () => confirm(`Delete ${w.name}?`, null, () => {
    dismiss();
    onDelete(w);
  }));
  const save = () => {
    const text = name.value.trim() || w.name;
    if (text.toLowerCase() !== w.name.toLowerCase() && isNameTaken(text)) {
      nameError.textContent = `A waypoint called "${text}" already exists`;
      nameError.hidden = false;
      return;
    }
    w.name = text;
    w.desc = desc.value.trim() || null;
    onChanged();
    dismiss();
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  actions.append(del, el('span', 'spacer'), button('Jump', () => { dismiss(); onJumpTo(w); }), button('Save', save, { primary: true }));
  card.append(name, nameError, coordinates, desc, actions);
  setTimeout(() => { name.focus(); name.select(); }, 0);
}

// ------------------------------------------------------------------ new waypoint sheet

/** The "New waypoint" sheet at the foot of the map. onSave(request) returns an error message, or null. */
export class NewWaypointSheet {
  constructor(onSave) {
    this.onSave = onSave;
    this.bg = document.getElementById('wpt-sheet-bg');
    this.name = document.getElementById('wpt-name');
    this.nameError = document.getElementById('wpt-name-error');
    this.desc = document.getElementById('wpt-desc');
    this.coords = document.getElementById('wpt-coords');
    this.color = DEFAULT_COLOR;
    this.icon = DEFAULT_ICON_ID;

    const colors = document.getElementById('wpt-colors');
    this.swatches = PALETTE.map((c) => {
      const s = el('button', 'swatch');
      s.style.background = c;
      s.title = c;
      s.addEventListener('click', () => { this.color = c; this.refresh(); });
      colors.append(s);
      return s;
    });
    const icons = document.getElementById('wpt-icons');
    this.iconSwatches = ICONS.map((icon) => {
      const s = el('button', 'icon-swatch');
      s.title = icon.label;
      s.innerHTML = `<span class="icon">${svg(icon.drawable, false)}</span>`;
      s.addEventListener('click', () => { this.icon = icon.id; this.refresh(); });
      icons.append(s);
      return s;
    });

    document.getElementById('btn-wpt-cancel').addEventListener('click', () => this.hide());
    document.getElementById('btn-wpt-save').addEventListener('click', () => this.save());
    this.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.save(); });
    this.name.addEventListener('input', () => this.showError(null));
    this.bg.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.hide(); });
    this.coords.addEventListener('click', () => showCoordinateEditor({
      title: 'Waypoint coordinates', lat: this.lat, lng: this.lng, positiveLabel: 'Use coordinates',
      onPositive: (lat, lng) => {
        this.lat = lat;
        this.lng = lng;
        this.coords.textContent = formatDdm(lat, lng);
      }
    }));
  }

  get isVisible() {
    return !this.bg.hidden;
  }

  show(lat, lng) {
    this.lat = lat;
    this.lng = lng;
    this.color = DEFAULT_COLOR;
    this.icon = DEFAULT_ICON_ID;
    this.name.value = '';
    this.desc.value = '';
    this.showError(null);
    this.coords.textContent = formatDdm(lat, lng);
    this.refresh();
    this.bg.hidden = false;
    setTimeout(() => this.name.focus(), 0);
  }

  hide() {
    this.bg.hidden = true;
  }

  showError(message) {
    this.nameError.textContent = message || '';
    this.nameError.hidden = !message;
    this.name.classList.toggle('error', Boolean(message));
  }

  save() {
    if (!this.isVisible) return;
    const error = this.onSave({
      name: this.name.value.trim(), description: this.desc.value.trim(),
      lat: this.lat, lng: this.lng, color: this.color, icon: this.icon
    });
    if (error) {
      this.showError(error);
      return;
    }
    this.hide();
  }

  refresh() {
    this.swatches.forEach((s, i) => s.classList.toggle('selected', PALETTE[i] === this.color));
    this.iconSwatches.forEach((s, i) => s.classList.toggle('selected', ICONS[i].id === this.icon));
  }
}
