// Colours and depth range for a survey layer, as on the phone
// (ui/DepthRampDialog.kt). Changes show on the map as they're made.

import { el, body, sectionHeader, caption, row, addRow, setRowText, button, input, showPanel, showChoicePanel } from '../ui/panels.js';
import { toast } from '../core.js';
import {
  PALETTES, paletteById, normalised, fitRange, fractionWithin, coerceHillshade, drawLegend,
  MIN_HILLSHADE_EXAGGERATION, MAX_HILLSHADE_EXAGGERATION, autoFitRamp
} from '../geotiff/depth.js';

const SLIDER_STEPS = 1000;
const SLIDER_PADDING_METRES = 5;
const MIN_BAND_METRES = 1;
const NEARLY_NONE = 0.05;
const RECOLOUR_DELAY_MS = 90;

const PRESETS = [
  { label: "Fit to this layer's depths", build: (s, d, h) => fitRange(s, d, h) },
  { label: 'Reef and shallows: -1 m to -15 m', build: () => [-1, -15] },
  { label: 'Inshore detail: -10 m to -30 m', build: () => [-10, -30] },
  { label: 'Coastal: -6 m to -100 m', build: () => [-6, -100] },
  { label: 'Offshore: -20 m to -500 m', build: () => [-20, -500] }
];

/** "-12.5 m" below sea level, "+3.0 m" for land above it, as typed in the exact values. */
const formatDepth = (m) => (m < 0 ? `${m.toFixed(1)} m` : m > 0 ? `+${m.toFixed(1)} m` : '0.0 m');
const formatPlain = (m) => (Math.abs(m - Math.round(m)) < 0.05 ? String(Math.round(m)) : m.toFixed(1));
const parseDepth = (text) => {
  const v = Number.parseFloat(text.replace(',', '.'));
  return Number.isFinite(v) ? v : null;
};
const outsideLabel = (show) => (show ? 'Shown in the end colours' : 'Hidden — only the range is drawn');
const toProgress = (v, lo, hi) => (hi <= lo ? 0 : Math.min(SLIDER_STEPS, Math.max(0, Math.round(((v - lo) / (hi - lo)) * SLIDER_STEPS))));
const fromProgress = (p, lo, hi) => Math.round((lo + (p / SLIDER_STEPS) * (hi - lo)) * 10) / 10;

function slider() {
  const node = el('input', 'pd-slider');
  node.type = 'range';
  node.min = 0;
  node.max = SLIDER_STEPS;
  return node;
}

export function showDepthRampDialog({ layerName, shallowest, deepest, initial, histogram, onRampChanged }) {
  let ramp = normalised(initial);
  const dataShallow = Math.ceil(shallowest);
  const dataDeep = Math.floor(deepest);
  const padding = Math.max(SLIDER_PADDING_METRES, (dataShallow - dataDeep) * 0.25);
  const upper = dataShallow + padding;
  const lower = dataDeep - padding;
  let updating = false;
  let timer = null;

  const content = body();
  content.append(sectionHeader('LAYER'));
  content.append(caption(`${layerName}\nData range ${formatDepth(shallowest)} to ${formatDepth(deepest)}. Depths below sea level are negative (-10 = 10 m deep); land above it is +.`, 0));

  content.append(sectionHeader('PALETTE PREVIEW'));
  const legend = el('canvas', 'pd-legend');
  legend.width = 512;
  legend.height = 24;
  content.append(legend);
  const ends = el('div', 'pd-legend-ends');
  const shallowEnd = el('span');
  const deepEnd = el('span');
  ends.append(shallowEnd, deepEnd);
  content.append(ends);

  content.append(sectionHeader('DEPTH RANGE'));
  const coverage = caption('', 0);
  coverage.hidden = !histogram;
  content.append(coverage);
  const shallowValue = el('div', 'pd-value');
  const shallowSlider = slider();
  const deepValue = el('div', 'pd-value');
  const deepSlider = slider();
  content.append(caption('Shallow end', 4), shallowValue, shallowSlider, caption('Deep end', 4), deepValue, deepSlider);

  content.append(sectionHeader('EXACT VALUES'));
  const shallowInput = input({ placeholder: 'Shallow, e.g. -5' });
  const deepInput = input({ placeholder: 'Deep, e.g. -15' });
  shallowInput.classList.add('mono');
  deepInput.classList.add('mono');
  const inputs = el('div', 'pd-button-row');
  inputs.append(shallowInput, deepInput);
  content.append(inputs);

  content.append(sectionHeader('HILLSHADE'));
  content.append(caption('How strongly slopes and channels are shaded. 0 is flat.', 0));
  const shadeValue = el('div', 'pd-value');
  const shadeSlider = slider();
  const shadeInput = input({ placeholder: 'Exaggeration' });
  shadeInput.classList.add('mono');
  content.append(shadeValue, shadeSlider);
  addRow(content, shadeInput);

  const paletteRow = row('Colour palette', '', () => showChoicePanel('Colour palette', PALETTES.map((p) => p.label),
    PALETTES.findIndex((p) => p.id === ramp.paletteId), (i) => apply({ ...ramp, paletteId: PALETTES[i].id }, false, false)));
  const invertRow = row('Reverse ramp direction', '', () => apply({ ...ramp, invert: !ramp.invert }, false, false));
  const outsideRow = row('Outside the range', '', () => apply({ ...ramp, showOutside: !ramp.showOutside }, false, false));
  content.append(sectionHeader('COLOURS'));
  addRow(content, paletteRow);
  addRow(content, invertRow);
  addRow(content, outsideRow);

  content.append(sectionHeader('PRESETS'));
  for (const preset of PRESETS) {
    addRow(content, button(preset.label, () => {
      const [s, d] = preset.build(shallowest, deepest, histogram);
      apply({ ...ramp, shallowMetres: s, deepMetres: d }, true, true);
    }));
  }

  function publish(coalesce) {
    clearTimeout(timer);
    const settings = ramp;
    if (coalesce) timer = setTimeout(() => onRampChanged(settings), RECOLOUR_DELAY_MS);
    else onRampChanged(settings);
  }

  function apply(next, syncSliders, syncInputs, coalesce = false) {
    ramp = normalised(next);
    updating = true;
    drawLegend(legend, ramp);
    shallowEnd.textContent = formatDepth(ramp.shallowMetres);
    deepEnd.textContent = formatDepth(ramp.deepMetres);
    shallowValue.textContent = formatDepth(ramp.shallowMetres);
    deepValue.textContent = formatDepth(ramp.deepMetres);
    setRowText(paletteRow, 'Colour palette', paletteById(ramp.paletteId).label);
    setRowText(invertRow, 'Reverse ramp direction', ramp.invert ? 'On' : 'Off');
    setRowText(outsideRow, 'Outside the range', outsideLabel(ramp.showOutside));
    if (histogram) {
      const share = fractionWithin(histogram, ramp.shallowMetres, ramp.deepMetres);
      const percent = share * 100 > 0 && share * 100 < 1 ? 'under 1' : (share * 100).toFixed(0);
      coverage.textContent = ramp.showOutside
        ? `${percent}% of this layer is in this range; the rest is shown in the end colours.`
        : share < NEARLY_NONE
          ? `Only ${percent}% of this layer is in this range, so it will look almost empty. Depths outside are hidden.`
          : `Shows ${percent}% of this layer. Depths outside the range are hidden.`;
      coverage.style.color = !ramp.showOutside && share < NEARLY_NONE ? 'var(--destructive)' : '';
    }
    if (syncSliders) {
      shallowSlider.value = toProgress(ramp.shallowMetres, lower, upper);
      deepSlider.value = toProgress(ramp.deepMetres, lower, upper);
      shadeSlider.value = toProgress(ramp.hillshadeExaggeration, MIN_HILLSHADE_EXAGGERATION, MAX_HILLSHADE_EXAGGERATION);
    }
    if (syncInputs) {
      shallowInput.value = formatPlain(ramp.shallowMetres);
      deepInput.value = formatPlain(ramp.deepMetres);
      shadeInput.value = formatPlain(ramp.hillshadeExaggeration);
    }
    shadeValue.textContent = `${ramp.hillshadeExaggeration.toFixed(1)}x`;
    updating = false;
    publish(coalesce);
  }

  // The ends never meet or cross: an empty band hid the whole layer.
  const onShallow = (dragging) => {
    if (updating) return;
    const wanted = fromProgress(+shallowSlider.value, lower, upper);
    const shallow = Math.max(wanted, ramp.deepMetres + MIN_BAND_METRES);
    apply({ ...ramp, shallowMetres: shallow }, shallow !== wanted, true, dragging);
  };
  const onDeep = (dragging) => {
    if (updating) return;
    const wanted = fromProgress(+deepSlider.value, lower, upper);
    const deep = Math.min(wanted, ramp.shallowMetres - MIN_BAND_METRES);
    apply({ ...ramp, deepMetres: deep }, deep !== wanted, true, dragging);
  };
  shallowSlider.addEventListener('input', () => onShallow(true));
  shallowSlider.addEventListener('change', () => onShallow(false));
  deepSlider.addEventListener('input', () => onDeep(true));
  deepSlider.addEventListener('change', () => onDeep(false));
  const onShade = (dragging) => {
    if (updating) return;
    apply({ ...ramp, hillshadeExaggeration: fromProgress(+shadeSlider.value, MIN_HILLSHADE_EXAGGERATION, MAX_HILLSHADE_EXAGGERATION) }, false, true, dragging);
  };
  shadeSlider.addEventListener('input', () => onShade(true));
  shadeSlider.addEventListener('change', () => onShade(false));

  // Each typed value applies as it's typed; leaving the field tidies it.
  for (const [field, key] of [[shallowInput, 'shallowMetres'], [deepInput, 'deepMetres']]) {
    field.addEventListener('input', () => {
      const v = parseDepth(field.value);
      if (v !== null && !updating) apply({ ...ramp, [key]: v }, true, false, true);
    });
    field.addEventListener('change', () => {
      const v = parseDepth(field.value);
      if (v !== null) apply({ ...ramp, [key]: v }, true, true);
    });
  }
  shadeInput.addEventListener('change', () => {
    const v = parseDepth(shadeInput.value);
    if (v !== null) apply({ ...ramp, hillshadeExaggeration: coerceHillshade(v) }, true, true);
  });

  apply(ramp, true, true);
  showPanel('Depth colours', content, { overMap: true });
}

export function create(app) {
  const show = (layer) => {
    const survey = app.overlays.depthSourceFor(layer.id);
    if (!survey) {
      toast(`${layer.name} has no depth data to recolour`);
      return;
    }
    // The colours sheet leaves the map visible; the layer list would cover it.
    document.getElementById('side-panel').classList.remove('open');
    document.getElementById('scrim').hidden = true;
    showDepthRampDialog({
      layerName: layer.name,
      shallowest: survey.shallowestMetres,
      deepest: survey.deepestMetres,
      initial: layer.ramp || autoFitRamp(survey.shallowestMetres, survey.deepestMetres),
      histogram: survey.histogram,
      onRampChanged: (ramp) => app.overlays.setRamp(layer.id, ramp)
    });
  };
  return {
    name: 'depthColours',
    show,
    pickLayer() {
      const layers = app.overlays.stackTopFirst.filter((l) => app.overlays.depthSourceFor(l.id));
      if (!layers.length) toast('Load a GeoTIFF depth layer first');
      else if (layers.length === 1) show(layers[0]);
      else showChoicePanel('Choose a depth layer', layers.map((l) => l.name), -1, (i) => show(layers[i]));
    }
  };
}
