// The app's panels and confirmation dialogs, built the same way as the
// phone's PanelDialogs: a title and ✕, scrolling content, a footer with
// Close and an optional action. Sizes are the phone's, in CSS pixels.

const openPanels = new Set();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export { el };

/** A vertical container padded like a panel body. */
export function body() {
  return el('div', 'pd-body');
}

/** An accent-coloured section heading. */
export function sectionHeader(title) {
  return el('div', 'pd-section', title);
}

/** A small muted caption, used as a field label or explanatory note. */
export function caption(text, topPadding = 4) {
  const node = el('div', 'pd-caption', text);
  node.style.paddingTop = `${topPadding}px`;
  return node;
}

/** A clickable settings row showing a title and its current value. */
export function row(title, value = '', onClick, { destructive = false } = {}) {
  const node = el('button', 'pd-row' + (destructive ? ' destructive' : ''));
  setRowText(node, title, value);
  node.addEventListener('click', () => onClick?.());
  return node;
}

/** Updates a row made by [row]. */
export function setRowText(node, title, value = '') {
  node.replaceChildren(el('span', 'pd-row-title', title));
  if (value && String(value).trim()) node.append(el('span', 'pd-row-value', value));
}

/** Adds [view] to [parent] with the standard row spacing. */
export function addRow(parent, view, bottomMargin = 9) {
  view.style.marginBottom = `${bottomMargin}px`;
  parent.append(view);
  return view;
}

export function input({ placeholder = '', value = '', type = 'text', multiline = false } = {}) {
  const node = el(multiline ? 'textarea' : 'input', 'pd-input');
  if (!multiline) node.type = type;
  node.placeholder = placeholder;
  node.value = value;
  if (multiline) node.rows = 3;
  return node;
}

export function button(label, onClick, { primary = false, destructive = false } = {}) {
  const node = el('button', 'pd-button' + (primary ? ' primary' : '') + (destructive ? ' destructive' : ''), label);
  node.addEventListener('click', () => onClick?.());
  return node;
}

/** A row of buttons sharing the width equally. */
export function buttonRow(...buttons) {
  const node = el('div', 'pd-button-row');
  node.append(...buttons);
  return node;
}

export function closeButton(onClose) {
  const node = el('button', 'pd-close', '✕');
  node.title = 'Close';
  node.setAttribute('aria-label', 'Close');
  node.addEventListener('click', onClose);
  return node;
}

/** Closes every panel, e.g. once a picked file starts loading. */
export function dismissAll() {
  [...openPanels].forEach((p) => p.dismiss());
}

/**
 * Shows a panel with a title bar, scrolling content and a footer. Returns a
 * handle with dismiss(). With overMap it sits low on the screen without
 * dimming, so changes to the map (colours) can be seen while editing.
 */
export function showPanel(title, content, { actionLabel = null, onAction = null, overMap = false, onDismiss = null } = {}) {
  const scrim = el('div', 'pd-scrim' + (overMap ? ' over-map' : ''));
  const card = el('div', 'pd-card');
  const header = el('div', 'pd-header');
  header.append(el('div', 'pd-title', title));
  const scroll = el('div', 'pd-content');
  scroll.append(content);
  const footer = el('div', 'pd-footer');
  card.append(header, scroll, footer);
  scrim.append(card);

  let closed = false;
  const handle = {
    element: card,
    dismiss() {
      if (closed) return;
      closed = true;
      scrim.remove();
      openPanels.delete(handle);
      document.removeEventListener('keydown', onKey, true);
      onDismiss?.();
    },
    get isShowing() { return !closed; }
  };
  header.append(closeButton(() => handle.dismiss()));
  footer.append(button('Close', () => handle.dismiss()));
  if (actionLabel && onAction) footer.append(button(actionLabel, onAction, { primary: true }));

  // Esc closes the top panel only.
  function onKey(event) {
    if (event.key !== 'Escape') return;
    const panels = [...openPanels];
    if (panels[panels.length - 1] !== handle) return;
    event.stopPropagation();
    handle.dismiss();
  }
  document.addEventListener('keydown', onKey, true);

  document.body.append(scrim);
  openPanels.add(handle);
  return handle;
}

/** A single-select list panel; reports the chosen index. */
export function showChoicePanel(title, labels, selectedIndex, onChosen) {
  const list = el('div', 'pd-choices');
  let handle;
  labels.forEach((label, index) => {
    const item = el('button', 'pd-choice' + (index === selectedIndex ? ' selected' : ''), label);
    item.addEventListener('click', () => {
      handle.dismiss();
      onChosen(index);
    });
    list.append(item);
  });
  handle = showPanel(title, list);
  return handle;
}

/** Asks before an action that can't be undone. */
export function confirm(title, message, onConfirm, { confirmLabel = 'Delete', destructive = true } = {}) {
  const scrim = el('div', 'pd-scrim');
  const card = el('div', 'pd-card pd-confirm');
  card.append(el('div', 'pd-confirm-title', title));
  if (message) card.append(el('div', 'pd-confirm-message', message));
  const buttons = el('div', 'pd-confirm-buttons');
  const dismiss = () => {
    scrim.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  function onKey(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      dismiss();
    }
  }
  buttons.append(
    button('Cancel', dismiss),
    button(confirmLabel, () => {
      dismiss();
      onConfirm();
    }, { primary: !destructive, destructive })
  );
  card.append(buttons);
  scrim.append(card);
  document.addEventListener('keydown', onKey, true);
  document.body.append(scrim);
  return { dismiss };
}

/** Asks for one line of text; [onDone] gets the trimmed text. */
export function prompt(title, { label = '', value = '', placeholder = '', actionLabel = 'Save' } = {}, onDone) {
  const content = body();
  if (label) content.append(caption(label, 0));
  const field = input({ value, placeholder });
  addRow(content, field);
  let handle;
  const submit = () => {
    const text = field.value.trim();
    if (!text) return;
    handle.dismiss();
    onDone(text);
  };
  field.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  handle = showPanel(title, content, { actionLabel, onAction: submit });
  setTimeout(() => { field.focus(); field.select(); }, 0);
  return handle;
}
