// The Android app's home panel (1.4.2): the screen a person opens GizeCat to. It replaces the
// toolbar-and-sheet as the first thing seen in the native app (the sheet stays, behind "More looks
// and sound" and "All settings", and the in-app cat stays, behind "Show the cat in this app").
//
// What it holds, top to bottom: the floating cat (status, a large Start/Stop, Pause and Hide, the
// permission state and the in-app explanation that precedes Android's own settings page), the cat
// (name, coat, size), movement (personality, walking speed, screen edges, hunting, playfulness),
// touch (petting, carrying, throwing), battery (when it falls asleep, how active it is) and a footer.
// Every control goes through the web allow-list (settingsModel.ts), exactly like the sheet; nothing
// here reads the screen, other apps or the network. The floating cat itself is a separate service:
// opening and closing this panel never touches its state.
//
// Built with the CSP-safe helpers (no innerHTML, no style attributes). DOM access only through the
// elements this module creates.
import { h, uid } from '../renderer/settings/dom';
import { coatArt } from '../renderer/settings/skins';
import { SKINS, type SkinId } from '../shared/cat';
import { disabledBehaviorSet, type BehaviorId, type Settings } from '../shared/settings';
import { ACTIVITY_PRESET_IDS, type ActivityPresetId } from '../shared/settingsPresets';
import type { FloatingElements } from './floatingUi';
import type { FloatingState } from './floatingProtocol';
import { CAT_NAME_MAX, LEVEL_RANGE, MOVEMENT_RANGE, patchFor, selectedPreset, SIZE_RANGE, SLEEP_RANGE, type WebField, type WebPatchResult } from './settingsModel';
import { WS } from './strings';

export interface AndroidPanelDeps {
  getSettings: () => Settings;
  /** One control's patch, through the web allow-list; `save` false is a live preview while a slider moves. */
  apply: (patch: Record<string, Record<string, unknown>>, save: boolean) => WebPatchResult;
  /** Opens the full settings sheet (more coats, drawing styles, sound, profile, start over). */
  onCustomize: () => void;
  /** Leaves the panel for the in-app cat. */
  onStage: () => void;
  version: string;
  /** The panel opened or closed (the in-app cat steps aside while it is open). */
  onOpenChange?: (open: boolean) => void;
}

export interface AndroidPanel {
  readonly root: HTMLElement;
  /** The floating-cat buttons and texts, for createFloatingUi (floatingUi.ts). */
  readonly floating: FloatingElements;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  /** The settings changed elsewhere (the sheet, a profile): show them. */
  refresh(): void;
  /** Native's floating-cat state: the chip, the hero line and the permission rows. */
  setFloatingState(state: FloatingState): void;
}

interface Slider {
  root: HTMLElement;
  input: HTMLInputElement;
  set(v: number): void;
}

export function createAndroidPanel(deps: AndroidPanelDeps): AndroidPanel {
  let isOpen = false;

  const change = (c: WebField, save = true): void => {
    const patch = patchFor(c);
    if (!patch) return;
    const r = deps.apply(patch, save);
    // A refused change puts the old value back; a saved personality changes the sliders under it.
    if (!r.ok || save) refresh();
  };

  function switchRow(label: string, desc: string | null, onToggle: (on: boolean) => void): { root: HTMLElement; input: HTMLInputElement } {
    const id = uid('panel-switch');
    const input = h('input', { type: 'checkbox', role: 'switch', class: 'switch', id });
    input.addEventListener('change', () => onToggle(input.checked));
    const text = h('div', { class: 'row-text' }, [h('label', { for: id, text: label }), desc ? h('span', { class: 'row-desc', text: desc }) : null]);
    return { root: h('div', { class: 'field-row panel-row' }, [text, input]), input };
  }

  function slider(label: string, r: { min: number; max: number; step: number }, format: (v: number) => string, onValue: (v: number, save: boolean) => void): Slider {
    const id = uid('panel-range');
    const input = h('input', { type: 'range', id, min: r.min, max: r.max, step: r.step });
    const out = h('output', { for: id });
    input.addEventListener('input', () => {
      out.textContent = format(Number(input.value));
      onValue(Number(input.value), false);
    });
    input.addEventListener('change', () => onValue(Number(input.value), true));
    return {
      root: h('div', { class: 'field' }, [h('div', { class: 'field-row' }, [h('label', { for: id, text: label }), out]), input]),
      input,
      set(v) {
        input.value = String(v);
        out.textContent = format(v);
      },
    };
  }

  function radioCards<T extends string>(name: string, label: string, values: readonly T[], content: (v: T) => (Node | string)[], onPick: (v: T) => void, wide = false) {
    const labelId = uid(`${name}-label`);
    const inputs = new Map<T, { input: HTMLInputElement; card: HTMLElement }>();
    const cards = values.map((v) => {
      const input = h('input', { type: 'radio', name: `gizecat-panel-${name}`, value: v });
      input.addEventListener('change', () => {
        if (!input.checked) return;
        for (const other of inputs.values()) other.card.classList.toggle('checked', other.input.checked);
        onPick(v);
      });
      const card = h('label', { class: 'card' }, [input, ...content(v)]);
      inputs.set(v, { input, card });
      return card;
    });
    return {
      root: h('div', {}, [h('p', { class: 'legend', id: labelId, text: label }), h('div', { class: wide ? 'cards wide' : 'cards', role: 'radiogroup', 'aria-labelledby': labelId }, cards)]),
      set(value: T | null) {
        for (const [v, { input, card }] of inputs) {
          input.checked = v === value;
          card.classList.toggle('checked', v === value);
        }
      },
    };
  }

  const pcard = (title: string, children: readonly (Node | null)[], id?: string): HTMLElement => {
    const headingId = uid('pcard');
    return h('section', { class: 'pcard', 'aria-labelledby': headingId, id }, [h('h2', { id: headingId, text: title }), ...children]);
  };

  // ---- header
  const chip = h('span', { class: 'chip', 'aria-live': 'polite' });
  const head = h('header', { class: 'panel-head' }, [
    h('img', { class: 'panel-logo', src: 'icons/icon-192.png', alt: '', width: 48, height: 48 }),
    h('div', { class: 'panel-title' }, [h('h1', { text: 'GizeCat' }), h('p', { text: WS.panel.subtitle })]),
    chip,
  ]);

  // ---- floating cat (the elements createFloatingUi drives)
  const heroText = h('p', { class: 'lead' });
  const startBtn = h('button', { type: 'button', class: 'primary big' });
  const pauseBtn = h('button', { type: 'button', hidden: true });
  const hideBtn = h('button', { type: 'button', hidden: true });
  const stopBtn = h('button', { type: 'button', class: 'danger', hidden: true });
  const statusLine = h('p', { class: 'panel-status', role: 'status', 'aria-live': 'polite', hidden: true });
  const overlayState = h('span', { class: 'row-state' });
  const overlayRow = h('div', { class: 'perm-row' }, [h('span', { class: 'row-label', text: WS.panel.permissions.overlay }), overlayState]);
  const notifState = h('span', { class: 'row-state' });
  const notifRow = h('div', { class: 'perm-row' }, [h('span', { class: 'row-label', text: WS.panel.permissions.notifications }), notifState]);
  const askTitle = h('h3', { id: 'floating-ask-title' });
  const askText = h('div', { class: 'ask-text' });
  const askOpen = h('button', { type: 'button', class: 'primary' });
  const askLater = h('button', { type: 'button' });
  const ask = h('div', { class: 'panel-ask', role: 'region', hidden: true }, [askTitle, askText, h('div', { class: 'actions' }, [askOpen, askLater])]);
  const hero = pcard(WS.panel.hero.title, [
    heroText,
    h('div', { class: 'hero-actions' }, [startBtn, pauseBtn, hideBtn, stopBtn]),
    statusLine,
    ask,
    h('div', { class: 'perm-list' }, [overlayRow, notifRow]),
    h('p', { class: 'note', text: WS.panel.permissions.note }),
  ]);
  hero.classList.add('hero');

  // ---- your cat
  const nameId = uid('panel-name');
  const nameErrId = uid('panel-name-error');
  const nameInput = h('input', { type: 'text', id: nameId, maxlength: CAT_NAME_MAX, autocomplete: 'off', autocapitalize: 'words', enterkeyhint: 'done', spellcheck: 'false', 'aria-describedby': nameErrId });
  const nameErr = h('p', { class: 'error', id: nameErrId, 'aria-live': 'polite' });
  nameInput.addEventListener('change', () => {
    const patch = patchFor({ field: 'catName', value: nameInput.value });
    const r = patch ? deps.apply(patch, true) : null;
    if (!r || !r.ok) {
      nameErr.textContent = WS.cat.nameInvalid;
      nameInput.value = deps.getSettings().general.catName;
    } else {
      nameErr.textContent = '';
      nameInput.value = r.settings.general.catName;
    }
  });
  const coat = radioCards<SkinId>('coat', WS.cat.coatLabel, SKINS, (s) => [coatArt(s), h('span', { class: 'title', text: WS.skins[s] })], (s) => change({ field: 'skin', value: s }));
  const size = slider(WS.cat.sizeLabel, SIZE_RANGE, (v) => `${Math.round(v * 100)}%`, (v, save) => change({ field: 'size', value: v }, save));
  const moreBtn = h('button', { type: 'button', text: WS.panel.cat.more });
  moreBtn.addEventListener('click', () => deps.onCustomize());
  const catCard = pcard(WS.panel.cat.title, [h('div', { class: 'field' }, [h('label', { for: nameId, text: WS.cat.nameLabel }), nameInput, nameErr]), coat.root, size.root, h('div', { class: 'actions' }, [moreBtn])]);

  // ---- movement
  const personality = radioCards<ActivityPresetId>(
    'preset',
    WS.panel.movement.personality,
    ACTIVITY_PRESET_IDS,
    (p) => [h('span', { class: 'title', text: WS.presets[p].title }), h('span', { class: 'desc', text: WS.presets[p].desc })],
    (p) => change({ field: 'preset', value: p }),
    true,
  );
  const speed = slider(WS.panel.movement.speed, MOVEMENT_RANGE, (v) => `${Math.round(v * 100)}%`, (v, save) => change({ field: 'movementSpeed', value: v }, save));
  const toggle = (id: BehaviorId, enabled: boolean): void => change({ field: 'behaviorToggle', id, enabled, current: deps.getSettings() });
  const edges = switchRow(WS.panel.movement.edges, WS.panel.movement.edgesDesc, (on) => toggle('screenEdges', on));
  const hunt = switchRow(WS.panel.movement.hunt, WS.panel.movement.huntDesc, (on) => {
    // Hunting is the chase and the pounce; the pounce needs the chase.
    toggle('chaseCursor', on);
    toggle('pounce', on);
  });
  const play = slider(WS.panel.movement.play, LEVEL_RANGE, (v) => `${Math.round(v * 100)}%`, (v, save) => change({ field: 'cursorPlay', value: v }, save));
  const movementCard = pcard(WS.panel.movement.title, [personality.root, speed.root, edges.root, hunt.root, play.root]);

  // ---- touch
  const petting = switchRow(WS.panel.touch.petting, null, (on) => change({ field: 'petting', value: on }));
  const dragging = switchRow(WS.panel.touch.dragging, null, (on) => change({ field: 'dragging', value: on }));
  const throwing = switchRow(WS.panel.touch.throwing, null, (on) => change({ field: 'throwing', value: on }));
  const touchCard = pcard(WS.panel.touch.title, [petting.root, dragging.root, throwing.root, h('p', { class: 'note', text: WS.panel.touch.note })]);

  // ---- battery
  const sleep = slider(WS.panel.battery.sleep, SLEEP_RANGE, (v) => WS.panel.battery.sleepValue(Math.round(v)), (v, save) => change({ field: 'sleepMinutes', value: v }, save));
  const activity = slider(WS.panel.battery.activity, LEVEL_RANGE, (v) => `${Math.round(v * 100)}%`, (v, save) => change({ field: 'autonomy', value: v }, save));
  const batteryCard = pcard(WS.panel.battery.title, [sleep.root, activity.root, h('p', { class: 'note', text: WS.panel.battery.note })]);

  // ---- footer
  const stageBtn = h('button', { type: 'button', text: WS.panel.footer.stage });
  stageBtn.addEventListener('click', () => deps.onStage());
  const allBtn = h('button', { type: 'button', text: WS.panel.footer.settings });
  allBtn.addEventListener('click', () => deps.onCustomize());
  const footer = h('footer', { class: 'panel-foot' }, [h('div', { class: 'actions' }, [stageBtn, allBtn]), h('p', { class: 'note', text: WS.about.version(deps.version) })]);

  const grid = h('div', { class: 'panel-grid' }, [hero, catCard, movementCard, touchCard, batteryCard]);
  const root = h('main', { class: 'panel', id: 'panel', 'aria-label': 'GizeCat', hidden: true }, [head, grid, footer]);

  function refresh(): void {
    const s = deps.getSettings();
    const off = disabledBehaviorSet(s.behavior);
    if (document.activeElement !== nameInput) nameInput.value = s.general.catName;
    coat.set(s.appearance.skin);
    size.set(s.appearance.size);
    personality.set(selectedPreset(s));
    speed.set(s.behavior.movementSpeed);
    edges.input.checked = !off.has('screenEdges');
    hunt.input.checked = !off.has('chaseCursor') && !off.has('pounce');
    play.set(s.behavior.cursorPlay);
    play.input.disabled = off.has('chaseCursor');
    petting.input.checked = s.interaction.petting;
    dragging.input.checked = s.interaction.dragging;
    throwing.input.checked = s.interaction.throwing;
    sleep.set(s.behavior.sleepAfterIdleMinutes);
    activity.set(s.behavior.autonomy);
  }

  function setFloatingState(state: FloatingState): void {
    const word = !state.running ? WS.panel.chip.off : state.hidden ? WS.panel.chip.hidden : state.paused ? WS.panel.chip.paused : WS.panel.chip.running;
    chip.textContent = word;
    chip.className = `chip ${!state.running ? 'chip-off' : state.hidden || state.paused ? 'chip-idle' : 'chip-on'}`;
    heroText.textContent = !state.running ? WS.panel.hero.off : state.hidden ? WS.panel.hero.hidden : state.paused ? WS.panel.hero.paused : WS.panel.hero.running;
    overlayState.textContent = state.overlayPermission ? WS.panel.permissions.overlayOk : WS.panel.permissions.overlayNeeded;
    overlayState.className = `row-state ${state.overlayPermission ? 'ok' : 'needed'}`;
    notifState.textContent = state.notifications ? WS.panel.permissions.notificationsOn : state.canAskNotifications ? WS.panel.permissions.notificationsOptional : WS.panel.permissions.notificationsOff;
    notifState.className = `row-state ${state.notifications ? 'ok' : 'optional'}`;
  }
  // Before native answers: calm defaults, not a guess about the permission.
  heroText.textContent = WS.panel.hero.off;
  chip.textContent = WS.panel.chip.off;
  chip.className = 'chip chip-off';

  function setOpen(open: boolean): void {
    if (isOpen === open) return;
    isOpen = open;
    root.hidden = !open;
    document.documentElement.classList.toggle('gizecat-panel-open', open);
    try {
      deps.onOpenChange?.(open);
    } catch {
      // The listener is optional.
    }
    if (open) {
      refresh();
      head.querySelector('h1')?.setAttribute('tabindex', '-1');
      head.querySelector<HTMLElement>('h1')?.focus();
    }
  }

  refresh();
  return {
    root,
    floating: { start: startBtn, pause: pauseBtn, hide: hideBtn, stop: stopBtn, ask, askText, askOpen, askLater, status: statusLine },
    get isOpen() {
      return isOpen;
    },
    open: () => setOpen(true),
    close: () => setOpen(false),
    refresh,
    setFloatingState,
  };
}
