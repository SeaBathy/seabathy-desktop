// The layer cards in the side panel, as on the phone (ui/LayerPanelBinder.kt):
// top of the stack first, each with a switch, an opacity slider and chips.

import { el, confirm } from './panels.js';
import { LayerKind } from '../map/overlays.js';

const formatOpacity = (fraction) => `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;

function chip(label, description, onClick, { destructive = false, wide = false } = {}) {
  const node = el('button', 'chip' + (destructive ? ' destructive' : '') + (wide ? ' wide' : ''), label);
  node.title = description;
  node.setAttribute('aria-label', description);
  node.addEventListener('click', onClick);
  return node;
}

export class LayerPanel {
  /** callbacks: onEditDepthColours(layer), onOpen3d(layer), onShowLayer(layer) */
  constructor(container, overlays, callbacks) {
    this.container = container;
    this.overlays = overlays;
    this.callbacks = callbacks;
  }

  rebuild() {
    this.container.replaceChildren();
    const layers = this.overlays.stackTopFirst;
    const unavailable = this.overlays.unavailable;
    if (!layers.length && !unavailable.length) {
      this.container.append(el('div', 'empty-note', 'No map layers loaded yet'));
      return;
    }
    layers.forEach((layer) => this.container.append(this.layerRow(layer)));
    // Listed last: they sit below the loaded layers in the saved stack.
    unavailable.forEach((layer) => this.container.append(this.unavailableRow(layer)));
  }

  confirmRemove(layer) {
    confirm(`Remove ${layer.name}?`, 'Remove this layer from the map? Your original file is not deleted.', () => this.overlays.remove(layer.id), { confirmLabel: 'Remove' });
  }

  unavailableRow(layer) {
    const card = el('div', 'layer-card');
    const title = el('div', 'layer-title');
    const names = el('div', 'layer-names');
    names.style.cursor = 'default';
    names.append(el('div', 'layer-name', layer.name), el('div', 'layer-sub', "Couldn't load — will try again next launch"));
    names.firstChild.style.color = 'var(--muted)';
    title.append(names, chip('REMOVE', `Remove ${layer.name}`, () => this.confirmRemove(layer), { destructive: true }));
    card.append(title);
    return card;
  }

  subtitleFor(layer, opacity = layer.opacity ?? 1) {
    const shown = formatOpacity(opacity);
    if (layer.kind === LayerKind.MBTILES) return `MBTiles • ${shown}`;
    if (layer.kind === LayerKind.XYZ) return `Online tiles • ${shown}`;
    const ramp = layer.ramp;
    if (this.overlays.depthSourceFor(layer.id) && ramp) {
      return `Depth GeoTIFF • ${Math.round(ramp.shallowMetres)} to ${Math.round(ramp.deepMetres)} m • ${shown}`;
    }
    return `Image GeoTIFF • ${shown}`;
  }

  layerRow(layer) {
    const card = el('div', 'layer-card');
    const subtitle = el('div', 'layer-sub', this.subtitleFor(layer));

    const title = el('div', 'layer-title');
    const names = el('div', 'layer-names');
    names.title = `Go to ${layer.name} on the map`;
    names.append(el('div', 'layer-name', layer.name), subtitle);
    names.addEventListener('click', () => this.callbacks.onShowLayer(layer));
    const toggle = el('label', 'switch');
    toggle.title = `Show ${layer.name}`;
    const box = el('input');
    box.type = 'checkbox';
    box.checked = layer.visible;
    box.addEventListener('change', () => this.overlays.setVisible(layer.id, box.checked));
    toggle.append(box, el('span'));
    title.append(names, toggle);

    const slider = el('input');
    slider.type = 'range';
    slider.min = 0;
    slider.max = 100;
    slider.value = Math.round((layer.opacity ?? 1) * 100);
    slider.title = `Opacity for ${layer.name}`;
    slider.addEventListener('input', () => {
      const opacity = slider.value / 100;
      this.overlays.setOpacity(layer.id, opacity, false);
      subtitle.textContent = this.subtitleFor(layer, opacity);
    });
    // Saved once the drag finishes, not per step.
    slider.addEventListener('change', () => this.overlays.setOpacity(layer.id, slider.value / 100, true));

    const order = el('div', 'chip-row');
    order.append(
      chip('▲', `Move ${layer.name} up`, () => this.overlays.move(layer.id, 1)),
      chip('▼', `Move ${layer.name} down`, () => this.overlays.move(layer.id, -1)),
      chip('BOTTOM', `Send ${layer.name} to the bottom`, () => this.overlays.sendToBottom(layer.id)),
      el('span', 'spacer'),
      chip('REMOVE', `Remove ${layer.name}`, () => this.confirmRemove(layer), { destructive: true })
    );
    card.append(title, slider, order);

    if (this.overlays.depthSourceFor(layer.id)) {
      const tools = el('div', 'chip-row');
      tools.append(
        chip('COLOURS', `Depth colours for ${layer.name}`, () => this.callbacks.onEditDepthColours(layer), { wide: true }),
        chip('3D VIEW', `Show ${layer.name} in 3D`, () => this.callbacks.onOpen3d(layer), { wide: true })
      );
      card.append(tools);
    }
    return card;
  }
}
