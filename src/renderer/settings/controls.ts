// Fluent-style controls bound to settings leaves through the store.
import type { SettingsAction } from '../../shared/ipc';
import type { Settings } from '../../shared/settings';
import type { PageContext } from './context';
import { h, icon, uid, type Child, type GlyphName } from './dom';
import { formatValue, nearestStopIndex, snapToStep, type BoolKey, type FieldKey, type NumericField, type SectionKey, type StrKey } from './fields';
import { fieldId } from './patch';
import { errorText, type FieldBinding } from './store';
import { S } from './strings';
import type { Validation } from './validate';

export const SLIDER_DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// Layout

export interface RowParts {
  row: HTMLElement;
  control: HTMLElement;
  note: HTMLElement;
  error: HTMLElement;
  titleId: string;
  descId: string | null;
  /** ids for aria-describedby (description, note, error). */
  describedBy: string;
}

export interface RowOptions {
  title: string;
  desc?: string;
  icon?: GlyphName;
  /** Puts the control on its own line below the text (lists, swatches). */
  stacked?: boolean;
  /** Keeps the title for assistive technology only (when a group heading already says it). */
  hideTitle?: boolean;
}

export function row(opts: RowOptions): RowParts {
  const titleId = uid('t');
  const descId = opts.desc ? uid('d') : null;
  const noteId = uid('n');
  const errorId = uid('e');
  const control = h('div', { class: 'row-control' });
  const note = h('div', { class: 'row-note', id: noteId, hidden: true });
  const error = h('div', { class: 'row-error', id: errorId, 'aria-live': 'polite', hidden: true });
  const text = h('div', { class: 'row-text' }, [
    h('div', { class: opts.hideTitle ? 'row-title sr-only' : 'row-title', id: titleId, text: opts.title }),
    opts.desc ? h('div', { class: 'row-desc', id: descId, text: opts.desc }) : null,
  ]);
  const head = h('div', { class: 'row-head' }, [opts.icon ? icon(opts.icon, 'row-icon') : null, text, opts.stacked ? null : control]);
  const row = h('div', { class: `row${opts.stacked ? ' row-stacked' : ''}` }, [head, opts.stacked ? control : null, note, error]);
  return { row, control, note, error, titleId, descId, describedBy: [descId, noteId, errorId].filter(Boolean).join(' ') };
}

export function group(title: string | null, children: readonly Child[], desc?: string): HTMLElement {
  const headingId = title ? uid('g') : null;
  return h('section', { class: 'group', 'aria-labelledby': headingId }, [
    title ? h('h2', { class: 'group-title', id: headingId, text: title }) : null,
    desc ? h('p', { class: 'group-desc', text: desc }) : null,
    h('div', { class: 'group-rows' }, children),
  ]);
}

export function page(title: string, children: readonly Child[]): HTMLElement {
  const headingId = uid('p');
  return h('section', { class: 'page', 'aria-labelledby': headingId, hidden: true }, [
    h('h1', { class: 'page-title', id: headingId, tabindex: -1, text: title }),
    ...children,
  ]);
}

export type NoteTone = 'info' | 'ok' | 'warn' | 'error';

export function setNote(el: HTMLElement, text: string | null, tone: NoteTone = 'info'): void {
  el.hidden = text === null || text === '';
  el.className = `${el.className.split(' ')[0] ?? 'row-note'} tone-${tone}`;
  el.replaceChildren();
  if (text) {
    const glyph: GlyphName = tone === 'ok' ? 'completed' : tone === 'warn' ? 'warning' : tone === 'error' ? 'error' : 'info';
    el.append(icon(glyph, 'note-icon'), h('span', { text }));
  }
}

function setRowError(parts: RowParts, target: HTMLElement | null, message: string | null): void {
  setNote(parts.error, message, 'error');
  if (target) {
    if (message) target.setAttribute('aria-invalid', 'true');
    else target.removeAttribute('aria-invalid');
  }
}

export function statusLine(): HTMLElement {
  return h('p', { class: 'status-line', role: 'status', 'aria-live': 'polite', hidden: true });
}

// ---------------------------------------------------------------------------
// Buttons

export type ButtonVariant = 'standard' | 'accent' | 'subtle' | 'danger';

export function button(label: string, opts: { variant?: ButtonVariant; icon?: GlyphName; describedBy?: string } = {}): HTMLButtonElement {
  return h('button', { type: 'button', class: `btn btn-${opts.variant ?? 'standard'}`, 'aria-describedby': opts.describedBy }, [
    opts.icon ? icon(opts.icon, 'btn-icon') : null,
    h('span', { class: 'btn-label', text: label }),
  ]);
}

export function setButtonLabel(btn: HTMLButtonElement, label: string): void {
  const span = btn.querySelector('.btn-label');
  if (span) span.textContent = label;
}

/** Runs an async task with the button disabled and reports failures in `status`. */
export async function withBusy<T>(btn: HTMLButtonElement, task: () => Promise<T>): Promise<T> {
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try {
    return await task();
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
}

/** Calls a settings action, shows the outcome in `status` and refreshes the view. */
export async function runAction(ctx: PageContext, action: SettingsAction, btn: HTMLButtonElement, status: HTMLElement | null, successText?: string): Promise<boolean> {
  return withBusy(btn, async () => {
    let okResult = false;
    try {
      const res = await ctx.api.action(action);
      okResult = res.ok;
      if (status) {
        if (res.ok) setNote(status, res.message ?? successText ?? null, 'ok');
        else setNote(status, S.errors.actionFailed(res.message ?? S.errors.unexpected), 'error');
      }
    } catch (e) {
      if (status) setNote(status, S.errors.actionFailed(errorText(e)), 'error');
    }
    try {
      await ctx.refresh();
    } catch {
      // The next broadcast from main will bring the view up to date.
    }
    return okResult;
  });
}

// ---------------------------------------------------------------------------
// Radio groups (segmented controls, swatches, option cards)

export interface RadioItem<T extends string> {
  value: T;
  el: HTMLElement;
}

export interface RadioGroupHandle<T extends string> {
  set(value: T): void;
  focusSelected(): void;
}

/**
 * Wires the ARIA radio-group pattern (roving tabindex, arrow keys, Home/End).
 * With `followFocus` false, arrow keys only move focus and Enter/Space selects;
 * used where selecting opens a consent dialog.
 */
export function radioGroup<T extends string>(
  container: HTMLElement,
  items: ReadonlyArray<RadioItem<T>>,
  onSelect: (value: T) => void,
  followFocus = true,
): RadioGroupHandle<T> {
  container.setAttribute('role', 'radiogroup');
  let current: T | null = null;
  const render = (): void => {
    const hasSelection = items.some((it) => it.value === current);
    items.forEach((it, i) => {
      const selected = it.value === current;
      it.el.setAttribute('aria-checked', String(selected));
      it.el.classList.toggle('selected', selected);
      it.el.tabIndex = selected || (!hasSelection && i === 0) ? 0 : -1;
    });
  };
  items.forEach((it, i) => {
    it.el.setAttribute('role', 'radio');
    it.el.addEventListener('click', () => {
      if (it.el.getAttribute('aria-disabled') === 'true') return;
      onSelect(it.value);
    });
    it.el.addEventListener('keydown', (e) => {
      let target: number;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') target = (i + 1) % items.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') target = (i - 1 + items.length) % items.length;
      else if (e.key === 'Home') target = 0;
      else if (e.key === 'End') target = items.length - 1;
      else return;
      e.preventDefault();
      const next = items[target];
      if (!next) return;
      items.forEach((other) => (other.el.tabIndex = other === next ? 0 : -1));
      next.el.focus();
      if (followFocus && next.el.getAttribute('aria-disabled') !== 'true') onSelect(next.value);
    });
  });
  render();
  return {
    set(value: T) {
      current = value;
      render();
    },
    focusSelected() {
      (items.find((it) => it.value === current) ?? items[0])?.el.focus();
    },
  };
}

// ---------------------------------------------------------------------------
// Bound controls

function makeBinding(field: FieldBinding['field'], parts: RowParts, target: HTMLElement | null, isBusy: () => boolean, sync: (v: unknown) => void): FieldBinding {
  return { field, isBusy, sync, showError: (msg) => setRowError(parts, target, msg) };
}

export interface ToggleHandle {
  parts: RowParts;
  input: HTMLInputElement;
  setDisabled(disabled: boolean): void;
}

export function toggleSwitch(labelledBy: string, describedBy: string): { root: HTMLLabelElement; input: HTMLInputElement; refresh(): void } {
  const input = h('input', { type: 'checkbox', role: 'switch', class: 'toggle-input', 'aria-labelledby': labelledBy, 'aria-describedby': describedBy });
  const state = h('span', { class: 'toggle-state', 'aria-hidden': 'true' });
  const root = h('label', { class: 'toggle' }, [state, input, h('span', { class: 'toggle-track', 'aria-hidden': 'true' }, [h('span', { class: 'toggle-thumb' })])]);
  const refresh = (): void => {
    state.textContent = input.checked ? S.common.on : S.common.off;
  };
  input.addEventListener('change', refresh);
  refresh();
  return { root, input, refresh };
}

export function toggleRow<Sec extends SectionKey>(ctx: PageContext, section: Sec, key: BoolKey<Sec>, opts: RowOptions): ToggleHandle {
  const parts = row(opts);
  const sw = toggleSwitch(parts.titleId, parts.describedBy);
  parts.control.append(sw.root);
  const binding = makeBinding(fieldId(section, key), parts, sw.input, () => false, (v) => {
    sw.input.checked = v === true;
    sw.refresh();
  });
  sw.input.addEventListener('change', () => {
    ctx.store.set(section, key, sw.input.checked as Settings[Sec][BoolKey<Sec>], { origin: binding });
  });
  ctx.store.bind(binding);
  return {
    parts,
    input: sw.input,
    setDisabled(disabled: boolean) {
      sw.input.disabled = disabled;
      parts.row.classList.toggle('is-disabled', disabled);
    },
  };
}

export interface SliderHandle {
  parts: RowParts;
  input: HTMLInputElement;
  setDisabled(disabled: boolean): void;
}

interface SliderModel {
  min: number;
  max: number;
  step: number;
  toPosition(value: number): number;
  fromPosition(position: number): number;
  label(value: number): string;
}

function sliderControl<Sec extends SectionKey>(ctx: PageContext, field: NumericField<Sec>, model: SliderModel, opts: RowOptions): SliderHandle {
  const parts = row(opts);
  const input = h('input', {
    type: 'range',
    class: 'slider-input',
    min: model.min,
    max: model.max,
    step: model.step,
    'aria-labelledby': parts.titleId,
    'aria-describedby': parts.describedBy,
  });
  const output = h('output', { class: 'slider-value', 'aria-hidden': 'true' });
  parts.control.append(h('div', { class: 'slider' }, [input, output]));
  let dragging = false;
  const show = (value: number): void => {
    const text = model.label(value);
    output.textContent = text;
    input.setAttribute('aria-valuetext', text);
    const pos = Number(input.value);
    const pct = model.max > model.min ? ((pos - model.min) / (model.max - model.min)) * 100 : 0;
    input.style.setProperty('--fill', `${pct}%`);
  };
  const key = field.key as FieldKey<Sec>;
  const binding = makeBinding(fieldId(field.section, key), parts, input, () => dragging, (v) => {
    const value = typeof v === 'number' ? v : model.fromPosition(model.min);
    input.value = String(model.toPosition(value));
    show(value);
  });
  const commit = (debounceMs: number): void => {
    const value = model.fromPosition(Number(input.value));
    show(value);
    ctx.store.set(field.section, key, value as Settings[Sec][FieldKey<Sec>], { debounceMs, origin: binding });
  };
  input.addEventListener('pointerdown', () => {
    dragging = true;
    const end = (): void => {
      dragging = false;
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      ctx.store.release(binding);
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  });
  input.addEventListener('input', () => commit(SLIDER_DEBOUNCE_MS));
  input.addEventListener('change', () => commit(0));
  ctx.store.bind(binding);
  return {
    parts,
    input,
    setDisabled(disabled: boolean) {
      input.disabled = disabled;
      parts.row.classList.toggle('is-disabled', disabled);
    },
  };
}

/** Linear slider over a numeric field's step grid. */
export function sliderRow<Sec extends SectionKey>(ctx: PageContext, field: NumericField<Sec>, opts: RowOptions): SliderHandle {
  return sliderControl(ctx, field, {
    min: field.min,
    max: field.max,
    step: field.step,
    toPosition: (v) => snapToStep(field, v),
    fromPosition: (p) => snapToStep(field, p),
    label: (v) => formatValue(field.format, v),
  }, opts);
}

/** Slider over discrete "nice" stops for long ranges; the label always shows the real value. */
export function stopsSliderRow<Sec extends SectionKey>(ctx: PageContext, field: NumericField<Sec>, stops: readonly number[], opts: RowOptions): SliderHandle {
  return sliderControl(ctx, field, {
    min: 0,
    max: stops.length - 1,
    step: 1,
    toPosition: (v) => nearestStopIndex(stops, v),
    fromPosition: (p) => stops[Math.max(0, Math.min(stops.length - 1, Math.round(p)))] ?? field.min,
    label: (v) => formatValue(field.format, v),
  }, opts);
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

export function segmentedRow<Sec extends SectionKey, K extends StrKey<Sec>>(
  ctx: PageContext,
  section: Sec,
  key: K,
  options: ReadonlyArray<SegmentOption<Extract<Settings[Sec][K], string>>>,
  opts: RowOptions,
): { parts: RowParts } {
  type V = Extract<Settings[Sec][K], string>;
  const parts = row(opts);
  const container = h('div', { class: 'segmented', 'aria-labelledby': parts.titleId, 'aria-describedby': parts.describedBy });
  const items: Array<RadioItem<V>> = options.map((o) => ({ value: o.value, el: h('button', { type: 'button', class: 'segment', text: o.label }) }));
  container.append(...items.map((i) => i.el));
  parts.control.append(container);
  const binding = makeBinding(fieldId(section, key), parts, container, () => false, (v) => handle.set(v as V));
  const handle = radioGroup<V>(container, items, (value) => {
    handle.set(value);
    ctx.store.set(section, key, value, { origin: binding });
  });
  ctx.store.bind(binding);
  return { parts };
}

export interface TextRowOptions<T> extends RowOptions {
  validate: (text: string) => Validation<T>;
  /** Maps the validated result to the stored string. */
  toValue: (valid: T) => string;
  placeholder?: string;
  maxLength: number;
  hint?: string;
  /** Called with every committed or synced value (for derived notes). */
  onValue?: (value: string) => void;
  spellcheck?: boolean;
  wide?: boolean;
}

export function textRow<Sec extends SectionKey, T>(ctx: PageContext, section: Sec, key: StrKey<Sec>, opts: TextRowOptions<T>): { parts: RowParts; input: HTMLInputElement } {
  const parts = row(opts);
  const input = h('input', {
    type: 'text',
    class: `text-input${opts.wide ? ' text-wide' : ''}`,
    maxlength: opts.maxLength,
    placeholder: opts.placeholder,
    spellcheck: opts.spellcheck ? 'true' : 'false',
    autocomplete: 'off',
    'aria-labelledby': parts.titleId,
    'aria-describedby': parts.describedBy,
  });
  parts.control.append(input);
  if (opts.hint) setNote(parts.note, opts.hint, 'info');
  let synced = '';
  let invalid = false;
  const dirty = (): boolean => input.value !== synced;
  const binding = makeBinding(fieldId(section, key), parts, input, () => invalid || (document.activeElement === input && dirty()), (v) => {
    synced = typeof v === 'string' ? v : '';
    input.value = synced;
    opts.onValue?.(synced);
  });
  const commit = (): void => {
    if (!dirty()) {
      invalid = false;
      binding.showError(null);
      return;
    }
    const res = opts.validate(input.value);
    if (!res.ok) {
      invalid = true;
      binding.showError(res.error);
      return;
    }
    invalid = false;
    const value = opts.toValue(res.value);
    input.value = value;
    opts.onValue?.(value);
    ctx.store.set(section, key, value as Settings[Sec][StrKey<Sec>], { origin: binding });
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape' && dirty()) {
      e.preventDefault();
      invalid = false;
      input.value = synced;
      binding.showError(null);
    }
  });
  ctx.store.bind(binding);
  return { parts, input };
}

type ListKey<Sec extends SectionKey> = { [K in FieldKey<Sec>]: Settings[Sec][K] extends string[] ? K : never }[FieldKey<Sec>];

export interface ListEditorOptions extends RowOptions {
  validate: (text: string, existing: readonly string[]) => Validation;
  placeholder: string;
  hint: string;
  countLabel: (n: number) => string;
}

/** Chip list with an add box; every change patches the whole array. */
export function listEditorRow<Sec extends SectionKey>(ctx: PageContext, section: Sec, key: ListKey<Sec>, opts: ListEditorOptions): { parts: RowParts } {
  const parts = row({ ...opts, stacked: true });
  const count = h('span', { class: 'chip-count' });
  const list = h('ul', { class: 'chips', 'aria-labelledby': parts.titleId });
  const inputId = uid('add');
  const input = h('input', {
    type: 'text',
    id: inputId,
    class: 'text-input',
    maxlength: 160,
    placeholder: opts.placeholder,
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-labelledby': parts.titleId,
    'aria-describedby': parts.describedBy,
  });
  const addBtn = button(S.common.add, { icon: 'add' });
  parts.control.append(h('div', { class: 'chip-add' }, [input, addBtn, count]), list);
  setNote(parts.note, opts.hint, 'info');
  const current = (): string[] => [...(ctx.store.intended(section, key) as readonly string[])];
  const binding = makeBinding(fieldId(section, key), parts, input, () => false, (v) => render(Array.isArray(v) ? (v as string[]) : []));
  const write = (next: string[]): void => {
    render(next);
    ctx.store.set(section, key, next as Settings[Sec][ListKey<Sec>], { origin: binding });
  };
  function render(values: readonly string[]): void {
    count.textContent = opts.countLabel(values.length);
    list.replaceChildren(
      ...values.map((value) => {
        const remove = h('button', { type: 'button', class: 'chip-remove', 'aria-label': S.common.remove(value) }, [icon('close')]);
        remove.addEventListener('click', () => {
          write(current().filter((e) => e !== value));
          input.focus();
        });
        return h('li', { class: 'chip' }, [h('span', { class: 'chip-text', text: value }), remove]);
      }),
    );
  }
  const add = (): void => {
    const res = opts.validate(input.value, current());
    if (!res.ok) {
      binding.showError(res.error);
      return;
    }
    binding.showError(null);
    input.value = '';
    write([...current(), res.value]);
  };
  addBtn.addEventListener('click', add);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  });
  input.addEventListener('input', () => binding.showError(null));
  ctx.store.bind(binding);
  return { parts };
}

// ---------------------------------------------------------------------------
// Read-only displays

/** Horizontal bar for a 0..1 value. */
export function meter(label: string, value: number, valueText: string): HTMLElement {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const fill = h('div', { class: 'meter-fill' });
  fill.style.setProperty('--value', String(clamped));
  const labelId = uid('m');
  return h('div', { class: 'meter-row' }, [
    h('span', { class: 'meter-label', id: labelId, text: label }),
    h('div', {
      class: 'meter',
      role: 'meter',
      'aria-labelledby': labelId,
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': Math.round(clamped * 100),
      'aria-valuetext': valueText,
    }, [fill]),
    h('span', { class: 'meter-value', text: valueText }),
  ]);
}

/** Two-column key/value list. */
export function keyValues(entries: ReadonlyArray<readonly [string, Child]>): HTMLElement {
  return h('dl', { class: 'kv' }, entries.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', {}, [v])]));
}

export function bullets(items: readonly string[], cls = 'bullets'): HTMLElement {
  return h('ul', { class: cls }, items.map((t) => h('li', { text: t })));
}
