// Minimal DOM construction helpers. Elements are built with properties and
// setAttribute only (never innerHTML or style attributes) so the page works under
// a strict Content-Security-Policy and never interprets data as markup.

export type Attrs = Record<string, string | number | boolean | null | undefined>;
export type Child = Node | string | null | undefined | false;

function applyAttrs(el: Element, attrs: Attrs): void {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'style') throw new Error('inline styles are not allowed (CSP)');
    if (name === 'text') el.textContent = String(value);
    else if (name === 'class') el.setAttribute('class', String(value));
    else el.setAttribute(name, value === true ? '' : String(value));
  }
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, children: readonly Child[] = []): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, children: readonly Child[] = []): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

let counter = 0;
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Segoe Fluent Icons / Segoe MDL2 Assets code points (system fonts on Windows 10/11). */
export const GLYPH = {
  home: '\uE80F',
  settings: '\uE713',
  color: '\uE790',
  behavior: '\uE805',
  touch: '\uE815',
  shield: '\uEA18',
  robot: '\uE99A',
  heart: '\uEB51',
  diagnostic: '\uE9D9',
  info: '\uE946',
  check: '\uE73E',
  completed: '\uE930',
  warning: '\uE7BA',
  error: '\uE783',
  close: '\uE711',
  add: '\uE710',
  chevronDown: '\uE70D',
  chevronRight: '\uE76C',
  play: '\uE768',
  pause: '\uE769',
  view: '\uE890',
  hide: '\uED1A',
  folder: '\uE8B7',
  download: '\uE896',
  power: '\uE7E8',
  lock: '\uE72E',
  globe: '\uE774',
  refresh: '\uE72C',
  keyboard: '\uE765',
  monitor: '\uE7F4',
  people: '\uE716',
  delete: '\uE74D',
  history: '\uE81C',
  lightbulb: '\uEA80',
  sparkle: '\uE945',
  mouse: '\uE962',
  rename: '\uE8AC',
  startup: '\uE7B5',
  cloud: '\uE753',
  pin: '\uE718',
  zoom: '\uE8A3',
  brightness: '\uE706',
  stopwatch: '\uE916',
  layers: '\uE81E',
  message: '\uE8BD',
  moon: '\uE708',
  window: '\uE8A7',
  fullscreen: '\uE740',
  clock: '\uE823',
  more: '\uE712',
  // v1.2 settings (Personality, Fine-tune, Sound)
  volume: '\uE767',
  mapPin: '\uE707',
  up: '\uE74A',
  equalizer: '\uE9E9',
} as const;
export type GlyphName = keyof typeof GLYPH;

export function icon(name: GlyphName, extraClass = ''): HTMLSpanElement {
  return h('span', { class: `icon ${extraClass}`.trim(), 'aria-hidden': 'true', text: GLYPH[name] });
}

/** Clears an element and appends new children. */
export function replaceChildren(el: Element, children: readonly Child[]): void {
  el.replaceChildren();
  append(el, children);
}

export function setHidden(el: HTMLElement, hidden: boolean): void {
  el.hidden = hidden;
}
