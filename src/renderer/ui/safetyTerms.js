// The one agreement that covers the whole app: shown on first launch (and again whenever the
// wording changes, by VERSION), and kept under Settings → Safety and terms. Individual features
// don't repeat it. The same text is in the phone app (SafetyTerms.kt) and on seabathy.com/terms.
import { prefs } from '../core.js';

export const VERSION = 1;
export const URL = 'https://seabathy.com/terms';
const KEY = 'terms_accepted_version';

export const SUMMARY = 'SeaBathy is not a nautical chart and must not be used for navigation.';
export const POINTS = [
  'Depths, tides, forecasts, marine park zones, buoys and names come from free public data. They can be wrong, missing or out of date.',
  'Routes and planning tools are aids only. Keep a proper lookout and use official charts, notices to mariners and your own judgement.',
  'Marine park zones are a guide: the official zoning map and rules are the law.',
  'In an emergency, call for help first: VHF channel 16, 000, or your EPIRB.',
  'SeaBathy is free software, given as is, with no warranty. You use it at your own risk.',
];

export const accepted = () => prefs.getNumber(KEY, 0) >= VERSION;

function card(title, buttons) {
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  const scrim = el('div', 'pd-scrim');
  const box = el('div', 'pd-card pd-confirm');
  box.append(el('div', 'pd-confirm-title', title), el('div', 'pd-confirm-message', SUMMARY));
  const list = el('ul', 'pd-confirm-message');
  list.style.cssText = 'margin: 10px 0 0; padding-left: 18px;';
  for (const p of POINTS) list.append(el('li', null, p));
  const link = el('div', 'pd-confirm-message', `Full terms: ${URL}`);
  link.style.cssText = 'margin-top: 10px; font-size: 11px; opacity: 0.7;';
  const row = el('div', 'pd-confirm-buttons');
  for (const [label, primary, onClick] of buttons) {
    const b = el('button', primary ? 'pd-button primary' : 'pd-button', label);
    b.addEventListener('click', () => { scrim.remove(); onClick(); });
    row.append(b);
  }
  box.append(list, link, row);
  scrim.append(box);
  document.body.append(scrim);
}

/** On launch: the agreement, if not yet accepted. It has no Escape or outside-click way out. */
export function showIfNeeded() {
  if (accepted()) return;
  card('Not for navigation', [
    ['Close app', false, () => window.close()],
    ['I agree', true, () => prefs.put(KEY, VERSION)],
  ]);
}

/** Settings → Safety and terms: the same text, to read again. */
export function show() {
  card('Safety and terms', [['OK', true, () => {}]]);
}
