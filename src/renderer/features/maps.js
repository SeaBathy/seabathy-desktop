// Online map layers, the custom basemap, and offline map downloads, as on
// the phone (ui/XyzTileDialog.kt, ui/CustomBasemapDialog.kt,
// ui/DataSourceDialog.kt, ui/DownloadZoneDialog.kt,
// download/OfflineTileDownloadController.kt). The download runs in the
// main process; its progress shows in a card on the chart.

import { api, toast, saveList, loadList, uuid, log } from '../core.js';
import { el, body, sectionHeader, caption, addRow, button, input, showPanel, confirm } from '../ui/panels.js';
import { XYZ_PRESETS, xyzValidationError } from '../settings/presets.js';
import { BasemapType } from '../map/style.js';

const CATEGORY_LABELS = { SATELLITE: 'Satellite imagery', TOPOGRAPHIC: 'Topographic', STREET: 'Street map', NAUTICAL: 'Nautical' };
const SATELLITE_DEFAULT_OPACITY = 0.7;
const DEFAULT_MIN_ZOOM = 10;
const DEFAULT_MAX_ZOOM = 14;
/** The 3D area's suggested download stops its max zoom here (tens of MB of imagery). */
const SUGGESTED_TILE_COUNT = 30000;
const MAX_SANE_ZOOM = 22;
/** More than this is almost always a mistake (an area or zoom range far too big): refused. */
const MAX_REASONABLE_TILE_COUNT = 200_000;
const ASSUMED_AVERAGE_TILE_BYTES = 25_000;

/** EOX's Sentinel-2 cloudless (Copernicus Sentinel-2 imagery, 2024 edition: CC BY-NC-SA 4.0). */
const DEFAULT_SOURCE = {
  id: 'eox-s2cloudless',
  name: 'Sentinel-2 cloudless (EOX)',
  urlTemplate: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg',
  attribution: 'Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024)',
  builtIn: true
};

function formatBytes(bytes) {
  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;
  if (bytes >= gb) return `${(bytes / gb).toFixed(1)} GB`;
  if (bytes >= mb) return `${(bytes / mb).toFixed(0)} MB`;
  if (bytes >= kb) return `${(bytes / kb).toFixed(0)} KB`;
  return `${bytes} bytes`;
}
const formatCount = (n) => n.toLocaleString('en-US');

/** A ready-made tile source: name, description, kind, and a button. */
function presetRow(preset, actionLabel, onChoose) {
  const node = el('div', 'preset-row');
  const text = el('div', 'preset-text');
  text.append(el('div', 'preset-name', preset.label), el('div', 'preset-desc', preset.description), el('div', 'preset-kind', CATEGORY_LABELS[preset.category]));
  const action = el('button', 'preset-action', actionLabel);
  action.addEventListener('click', (e) => {
    e.stopPropagation();
    onChoose();
  });
  node.append(text, action);
  node.addEventListener('click', onChoose);
  return node;
}

export function create(app) {
  let sources = [DEFAULT_SOURCE];
  loadList('sources').then((saved) => {
    sources = [DEFAULT_SOURCE, ...saved.filter((s) => s && s.id !== DEFAULT_SOURCE.id && s.urlTemplate)];
  });
  const persistSources = () => saveList('sources', sources.filter((s) => !s.builtIn));

  // ---------------------------------------------------------------- online map layers

  function showOnlineLayers() {
    const content = body();
    let handle;
    content.append(sectionHeader('ADD A LAYER'));
    content.append(caption('Adds it to your layers, with the same show/hide and opacity as your own maps.', 0));
    for (const preset of XYZ_PRESETS) {
      addRow(content, presetRow(preset, 'ADD', () => {
        handle.dismiss();
        app.overlays.addXyz(preset.label, preset.urlTemplate, preset.attribution, preset.category === 'SATELLITE' ? SATELLITE_DEFAULT_OPACITY : 1, preset.maxZoom);
        toast(`Added ${preset.label}`);
      }));
    }
    content.append(sectionHeader('YOUR OWN TILE LINK'));
    content.append(caption("A link with {z}, {x} and {y} in it. Check the provider's licence allows this.", 0));
    content.append(caption('Tile URL template', 10));
    const url = input({ value: app.style.customUrl, placeholder: 'https://example.com/tiles/{z}/{x}/{y}.png', multiline: true });
    url.rows = 2;
    url.classList.add('mono');
    addRow(content, url);
    content.append(caption('Attribution', 10));
    const attribution = input({ value: app.style.customAttribution, placeholder: 'Provider credit shown on the map', multiline: true });
    attribution.rows = 2;
    addRow(content, attribution);
    const error = el('div', 'field-error');
    error.hidden = true;
    content.append(error);
    const validated = () => {
      const value = url.value.trim();
      const problem = xyzValidationError(value);
      error.textContent = problem || '';
      error.hidden = !problem;
      return problem ? null : value;
    };
    addRow(content, button('Add as a layer', () => {
      const value = validated();
      if (!value) return;
      handle.dismiss();
      app.overlays.addXyz('Custom tiles', value, attribution.value.trim());
      toast('Added Custom tiles');
    }, { primary: true }));
    addRow(content, button('Use as the basemap', () => {
      const value = validated();
      if (!value) return;
      handle.dismiss();
      app.style.saveCustomBasemap(value, attribution.value.trim());
      app.style.rebuild(BasemapType.CUSTOM);
      document.getElementById('basemap').value = app.style.currentType;
      toast('Custom basemap saved');
    }));
    const clear = button('Clear the custom basemap', () => confirm('Clear the custom basemap?', 'Its link and credit are removed.', () => {
      url.value = '';
      attribution.value = '';
      error.hidden = true;
      app.style.clearCustomBasemap();
      document.getElementById('basemap').value = app.style.currentType;
      toast('Custom basemap cleared');
    }, { confirmLabel: 'Clear' }));
    clear.classList.add('text-destructive');
    addRow(content, clear);
    content.querySelectorAll('.pd-button').forEach((b) => { b.style.width = '100%'; });
    handle = showPanel('Online map layers', content);
  }

  /** Shown when "Custom" is picked as the basemap; onDismissed runs however it closes. */
  function showCustomBasemap(onDismissed) {
    const content = body();
    let handle;
    const use = (urlTemplate, attribution) => {
      app.style.saveCustomBasemap(urlTemplate, attribution);
      handle.dismiss();
      app.style.rebuild(BasemapType.CUSTOM);
    };
    content.append(sectionHeader('READY-MADE'));
    content.append(caption('Its credit is shown on the map for you.', 0));
    for (const preset of XYZ_PRESETS) addRow(content, presetRow(preset, 'USE', () => use(preset.urlTemplate, preset.attribution)));
    content.append(sectionHeader('YOUR OWN TILE LINK'));
    content.append(caption("A link with {z}, {x} and {y} in it. Check the provider's licence allows this.", 0));
    content.append(caption('Tile URL template', 10));
    const url = input({ placeholder: 'https://example.com/tiles/{z}/{x}/{y}.png', multiline: true });
    url.rows = 2;
    url.classList.add('mono');
    addRow(content, url);
    content.append(caption('Attribution', 10));
    const attribution = input({ placeholder: 'Provider credit shown on the map', multiline: true });
    attribution.rows = 2;
    addRow(content, attribution);
    const error = el('div', 'field-error');
    error.hidden = true;
    content.append(error);
    const go = button('Use as the basemap', () => {
      const value = url.value.trim();
      const problem = xyzValidationError(value);
      if (problem) {
        error.textContent = problem;
        error.hidden = false;
        return;
      }
      use(value, attribution.value.trim());
    }, { primary: true });
    go.style.width = '100%';
    addRow(content, go);
    handle = showPanel('Custom basemap', content, { onDismiss: onDismissed });
  }

  // ---------------------------------------------------------------- offline maps

  function showOfflineMaps() {
    const content = body();
    let handle;
    const rebuild = () => {
      content.replaceChildren();
      content.append(sectionHeader('MAP SOURCES'));
      if (!sources.length) content.append(caption('None yet: add one below.', 0));
      for (const source of sources) {
        const card = el('div', 'layer-card');
        card.append(el('div', 'layer-name', source.name));
        const link = el('div', 'layer-sub', source.urlTemplate);
        link.title = source.urlTemplate;
        card.append(link);
        if (source.attribution) card.append(el('div', 'layer-sub', source.attribution));
        const chips = el('div', 'chip-row');
        chips.style.paddingTop = '8px';
        const download = el('button', 'chip', 'DOWNLOAD');
        download.title = `Download ${source.name} for the area on screen`;
        download.addEventListener('click', () => {
          handle.dismiss();
          beginDownload(source);
        });
        chips.append(download, el('span', 'spacer'));
        if (!source.builtIn) {
          const remove = el('button', 'chip destructive', 'REMOVE');
          remove.addEventListener('click', () => confirm(`Remove ${source.name}?`, 'Only the link is removed; maps already downloaded stay.', () => {
            sources = sources.filter((s) => s !== source);
            persistSources();
            rebuild();
          }, { confirmLabel: 'Remove' }));
          chips.append(remove);
        }
        card.append(chips);
        content.append(card);
      }
      content.append(sectionHeader('ADD A SOURCE'));
      content.append(caption('A map or satellite tile link with {z}, {x} and {y} in it. Check its licence allows saving tiles offline.', 0));
      const name = input({ placeholder: 'Source name' });
      const url = input({ placeholder: 'https://example.com/{z}/{x}/{y}.png' });
      const attribution = input({ placeholder: 'Credit shown on the map (optional)' });
      const error = el('div', 'field-error');
      error.hidden = true;
      addRow(content, name);
      addRow(content, url);
      addRow(content, attribution);
      content.append(error);
      const add = button('Add source', () => {
        const n = name.value.trim();
        const u = url.value.trim();
        if (!n) {
          error.textContent = 'Give this source a name';
          error.hidden = false;
          return;
        }
        if (!/^https?:\/\//.test(u) || !['{z}', '{x}', '{y}'].every((t) => u.includes(t))) {
          error.textContent = 'A full http(s) link with {z}, {x} and {y}';
          error.hidden = false;
          return;
        }
        sources.push({ id: uuid(), name: n, urlTemplate: u, attribution: attribution.value.trim(), builtIn: false });
        persistSources();
        rebuild();
      });
      add.style.width = '100%';
      addRow(content, add);
      const folder = button('Open the downloads folder', async () => api.showInFolder(await api.downloadsFolder()));
      folder.style.width = '100%';
      addRow(content, folder);
    };
    rebuild();
    handle = showPanel('Offline maps', content);
  }

  function viewportBounds() {
    const b = app.map.getBounds();
    return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
  }

  /**
   * The download screen for [source] over the area on screen, or over
   * [bounds] (the 3D view's), whose max zoom then starts as deep as
   * [maxZoom] allows while staying a sensible size.
   */
  async function beginDownload(source, { bounds = viewportBounds(), maxZoom = null, areaNote = null } = {}) {
    let deepest = DEFAULT_MAX_ZOOM;
    if (maxZoom !== null) {
      deepest = Math.max(DEFAULT_MIN_ZOOM, maxZoom);
      while (deepest > DEFAULT_MIN_ZOOM && (await api.tileCount(bounds, DEFAULT_MIN_ZOOM, deepest)) > SUGGESTED_TILE_COUNT) deepest--;
    }
    const content = body();
    let handle;
    content.append(sectionHeader('AREA'));
    content.append(caption(`${areaNote || 'The area on screen. To change it, close this, move the map and open it again.'}\n\n${source.name}\n` +
      `West ${bounds.west.toFixed(4)}   East ${bounds.east.toFixed(4)}\nSouth ${bounds.south.toFixed(4)}   North ${bounds.north.toFixed(4)}`, 0));
    content.append(sectionHeader('ZOOM RANGE'));
    content.append(caption('A higher max zoom has more detail, but many more tiles.', 0));
    const minZoom = input({ value: String(DEFAULT_MIN_ZOOM), placeholder: 'Min zoom', type: 'number' });
    const maxZoomInput = input({ value: String(deepest), placeholder: 'Max zoom', type: 'number' });
    const zooms = el('div', 'pd-button-row');
    zooms.append(minZoom, maxZoomInput);
    content.append(zooms);
    content.append(sectionHeader('SIZE ESTIMATE'));
    const status = el('div', 'pd-status', 'Click Assess to see how big the download is. Nothing is downloaded yet.');
    content.append(status);
    let assessedRange = null;
    const readRange = () => {
      const lo = Number.parseInt(minZoom.value, 10);
      const hi = Number.parseInt(maxZoomInput.value, 10);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi > MAX_SANE_ZOOM || lo > hi) return null;
      return [lo, hi];
    };
    const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
    const assess = button('Assess', async () => {
      const range = readRange();
      if (!range) {
        status.className = 'pd-status error';
        status.textContent = `Zooms run 0–${MAX_SANE_ZOOM}, min no higher than max.`;
        return;
      }
      const count = await api.tileCount(bounds, range[0], range[1]);
      if (count <= 0) {
        status.className = 'pd-status error';
        status.textContent = 'No tiles in this area at these zooms';
        return;
      }
      if (count > MAX_REASONABLE_TILE_COUNT) {
        status.className = 'pd-status error';
        status.textContent = `That's ${formatCount(count)} tiles — zoom in or lower the max zoom`;
        return;
      }
      if (!(await api.isOnline())) {
        status.className = 'pd-status error';
        status.textContent = 'No internet: connect to check the size and download';
        return;
      }
      assess.disabled = true;
      assess.textContent = 'Assessing…';
      status.className = 'pd-status';
      status.textContent = 'Checking a few tiles…';
      const sizes = await api.sampleTiles(source.urlTemplate, bounds, range[0], range[1]);
      assess.disabled = false;
      // The fields changed while sampling: this estimate is for a range no longer shown.
      if (!same(readRange(), range)) {
        assess.textContent = 'Assess';
        return;
      }
      const average = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : ASSUMED_AVERAGE_TILE_BYTES;
      const basis = sizes.length ? `from ${sizes.length} sample tiles` : 'from a typical tile size: no sample tiles came back, so check the link if the download fails';
      assessedRange = range;
      assess.textContent = 'Re-assess';
      status.textContent = `About ${formatCount(count)} tiles, ~${formatBytes(Math.round(count * average))} (${basis}).`;
      download.disabled = false;
    });
    const download = button('Download', async () => {
      const range = readRange();
      if (!same(assessedRange, range)) return;
      if (!(await api.isOnline())) {
        toast('No internet: connect, then download');
        return;
      }
      if (await api.downloadRunning()) {
        toast('Another download is still running. Wait for it to finish, or cancel it.');
        return;
      }
      handle.dismiss();
      startDownload(source, bounds, range);
    }, { primary: true });
    download.disabled = true;
    const reset = () => {
      assessedRange = null;
      download.disabled = true;
      status.className = 'pd-status';
      status.textContent = 'Zoom range changed — click Assess again.';
    };
    minZoom.addEventListener('input', reset);
    maxZoomInput.addEventListener('input', reset);
    const actions = el('div', 'pd-button-row');
    actions.append(assess, download);
    content.append(actions);
    handle = showPanel('Download an offline map', content);
  }

  // ---------------------------------------------------------------- download progress

  const progress = el('div', 'download-card');
  progress.hidden = true;
  const progressText = el('div', 'download-text');
  const progressBar = el('div', 'download-bar');
  const progressFill = el('div');
  progressBar.append(progressFill);
  const cancel = el('button', 'small-button muted', 'CANCEL');
  cancel.addEventListener('click', () => api.cancelDownload());
  const progressHead = el('div', 'card-row');
  progressHead.append(progressText, cancel);
  progress.append(progressHead, progressBar);
  document.getElementById('bottom').prepend(progress);

  async function startDownload(source, bounds, range) {
    const started = await api.startDownload({ source, bounds, minZoom: range[0], maxZoom: range[1] });
    if (!started) {
      toast('Another download is still running. Wait for it to finish, or cancel it.');
      return;
    }
    log('OfflineTileDownload', `started ${source.name} zoom ${range[0]}-${range[1]}`);
    progress.hidden = false;
    progressText.textContent = `Downloading ${source.name}…`;
    progressFill.style.width = '0%';
  }

  api.onDownloadProgress(({ done, total, bytes, name }) => {
    progress.hidden = false;
    progressText.textContent = `Downloading ${name}: ${formatCount(done)} of ${formatCount(total)} tiles · ${formatBytes(bytes)}`;
    progressFill.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
  });
  api.onDownloadDone(({ file, name, attribution, total, failed, bytes }) => {
    progress.hidden = true;
    const holes = failed > 0 ? ` ${formatCount(failed)} of ${formatCount(total)} tiles couldn't be downloaded and will be blank.` : '';
    confirm('Download complete', `${name} finished downloading (${formatBytes(bytes)}) to:\n${file}${holes}\n\nLoad it as a layer now?`,
      () => import('../app.js').then((m) => m.loadMbtilesPath(file, { name, attribution })), { confirmLabel: 'Load', destructive: false });
  });
  api.onDownloadFailed(({ name, cancelled, message }) => {
    progress.hidden = true;
    toast(cancelled ? 'Download cancelled' : `${name} could not be downloaded: ${message}`);
  });

  return {
    name: 'onlineMaps',
    showOnlineLayers,
    showCustomBasemap,
    offline: { show: showOfflineMaps, download: beginDownload }
  };
}
