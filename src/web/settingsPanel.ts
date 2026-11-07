// The web host's settings sheet (1.4.0): a native <dialog> opened with showModal(), which brings
// the focus trap, the top layer and Escape-to-close with no code of ours (the page never listens to
// keys). A bottom sheet on narrow windows, a side sheet from 700 CSS px (web.css), so the cat stays
// visible as a live preview while it is changed.
//
// Built with the desktop settings' CSP-safe helpers (h/svg: no innerHTML, no style attributes) and
// its coat art. No <form>: a method=dialog form could run into form-action 'none', so buttons call
// close(). Controls report on input/change/click only; every change goes through deps.apply, which
// main.ts routes through the web allow-list (settingsModel.ts).
import type { Settings } from '../shared/settings';
import { ACTIVITY_PRESET_IDS, type ActivityPresetId } from '../shared/settingsPresets';
import { RENDER_STYLES, SKINS, type RenderStyle, type SkinId } from '../shared/cat';
import { h, uid } from '../renderer/settings/dom';
import { coatArt } from '../renderer/settings/skins';
import { showEvictionNote, type HostMode, type InstallHint } from './hostMode';
import { CAT_NAME_MAX, patchFor, selectedPreset, SIZE_RANGE, VOLUME_RANGE, type WebField, type WebPatchResult } from './settingsModel';
import { installText, WS } from './strings';

export interface SettingsPanelDeps {
  dialog: HTMLDialogElement;
  getSettings: () => Settings;
  /**
   * Applies one control's patch (main.ts: allow-list, validation, privacy forced off). `save` false is
   * a live preview while a slider moves; the final value comes with `save` true.
   */
  apply: (patch: Record<string, Record<string, unknown>>, save: boolean) => WebPatchResult;
  /** Inside the click that turns sound on: unlocks audio (audioUnlock.ts). */
  onSoundGesture: () => void;
  onResetSettings: () => void;
  /** Deletes the cat and reloads; false when storage refused (the sheet says so). */
  onStartOver: () => boolean;
  host: HostMode;
  installHint: () => InstallHint;
  /** The browser's install prompt (only offered when installHint() is 'prompt'). */
  onInstall: () => void;
  storageText: () => string;
  version: string;
  onOpenChange?: (open: boolean) => void;
}

export interface SettingsPanel {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
  /** Puts the current settings and status into the controls (after a change made elsewhere). */
  refresh(): void;
  /** Shows "a new version is ready" (the service worker took over; nothing reloads). */
  showUpdateReady(): void;
  /**
   * "Take your cat to another device": an empty container for the profile export/import, inside a
   * section that stays hidden until something is put in it (setTransferVisible).
   */
  readonly transferSlot: HTMLElement;
  setTransferVisible(visible: boolean): void;
}

interface RadioGroup<T extends string> {
  root: HTMLElement;
  set(value: T | null): void;
}

export function createSettingsPanel(deps: SettingsPanelDeps): SettingsPanel {
  const { dialog } = deps;
  let isOpen = false;

  const change = (c: WebField, save = true): WebPatchResult | null => {
    const patch = patchFor(c);
    if (!patch) return null;
    const r = deps.apply(patch, save);
    if (!r.ok) refresh();
    return r;
  };

  function radioCards<T extends string>(name: string, label: string, values: readonly T[], content: (v: T) => (Node | string)[], onPick: (v: T) => void, wide = false): RadioGroup<T> {
    const labelId = uid(`${name}-label`);
    const inputs = new Map<T, { input: HTMLInputElement; card: HTMLElement }>();
    const cards = values.map((v) => {
      // One name per group: the browser keeps one choice checked and moves between them natively.
      const input = h('input', { type: 'radio', name: `gizecat-${name}`, value: v });
      input.addEventListener('change', () => {
        if (!input.checked) return;
        for (const other of inputs.values()) other.card.classList.toggle('checked', other.input.checked);
        // A refused patch refreshes the sheet, which puts the old choice back.
        onPick(v);
      });
      const card = h('label', { class: 'card' }, [input, ...content(v)]);
      inputs.set(v, { input, card });
      return card;
    });
    const root = h('div', {}, [
      h('p', { class: 'legend', id: labelId, text: label }),
      h('div', { class: wide ? 'cards wide' : 'cards', role: 'radiogroup', 'aria-labelledby': labelId }, cards),
    ]);
    return {
      root,
      set(value) {
        for (const [v, { input, card }] of inputs) {
          input.checked = v === value;
          card.classList.toggle('checked', v === value);
        }
      },
    };
  }

  function switchRow(label: string, onToggle: (on: boolean) => void): { root: HTMLElement; input: HTMLInputElement } {
    const id = uid('switch');
    const input = h('input', { type: 'checkbox', role: 'switch', class: 'switch', id });
    input.addEventListener('change', () => onToggle(input.checked));
    return { root: h('div', { class: 'field-row' }, [h('label', { for: id, text: label }), input]), input };
  }

  function range(label: string, r: { min: number; max: number; step: number }, format: (v: number) => string, onValue: (v: number, save: boolean) => void) {
    const id = uid('range');
    const input = h('input', { type: 'range', id, min: r.min, max: r.max, step: r.step });
    const out = h('output', { for: id });
    input.addEventListener('input', () => {
      out.textContent = format(Number(input.value));
      onValue(Number(input.value), false);
    });
    input.addEventListener('change', () => onValue(Number(input.value), true));
    const root = h('div', { class: 'field' }, [h('div', { class: 'field-row' }, [h('label', { for: id, text: label }), out]), input]);
    return {
      root,
      input,
      set(v: number) {
        input.value = String(v);
        out.textContent = format(v);
      },
    };
  }

  // ---- header
  const titleId = 'settings-title';
  const closeBtn = h('button', { type: 'button', autofocus: true, text: WS.sheet.close });
  closeBtn.addEventListener('click', () => close());
  const head = h('div', { class: 'sheet-head' }, [h('h2', { id: titleId, text: WS.sheet.title }), closeBtn]);

  // ---- your cat
  const nameId = uid('cat-name');
  const nameErrId = uid('cat-name-error');
  const nameInput = h('input', {
    type: 'text',
    id: nameId,
    maxlength: CAT_NAME_MAX,
    autocomplete: 'off',
    autocapitalize: 'words',
    enterkeyhint: 'done',
    spellcheck: 'false',
    'aria-describedby': nameErrId,
  });
  const nameErr = h('p', { class: 'error', id: nameErrId, 'aria-live': 'polite' });
  nameInput.addEventListener('change', () => {
    const r = change({ field: 'catName', value: nameInput.value });
    if (!r || !r.ok) {
      nameErr.textContent = WS.cat.nameInvalid;
      nameInput.value = deps.getSettings().general.catName;
    } else {
      nameErr.textContent = '';
      nameInput.value = r.settings.general.catName;
    }
  });
  const coat = radioCards<SkinId>('coat', WS.cat.coatLabel, SKINS, (s) => [coatArt(s), h('span', { class: 'title', text: WS.skins[s] })], (s) => change({ field: 'skin', value: s }));
  const style = radioCards<RenderStyle>('style', WS.cat.styleLabel, RENDER_STYLES, (s) => [h('span', { class: 'title', text: WS.styles[s] })], (s) => change({ field: 'style', value: s }));
  const size = range(WS.cat.sizeLabel, SIZE_RANGE, (v) => `${Math.round(v * 100)}%`, (v, save) => change({ field: 'size', value: v }, save));
  const shadow = switchRow(WS.cat.shadowLabel, (on) => change({ field: 'shadow', value: on }));
  const emotes = switchRow(WS.cat.emotesLabel, (on) => change({ field: 'emotes', value: on }));
  const catSection = h('section', {}, [
    h('h3', { text: WS.cat.title }),
    h('div', { class: 'field' }, [h('label', { for: nameId, text: WS.cat.nameLabel }), nameInput, nameErr]),
    coat.root,
    style.root,
    size.root,
    shadow.root,
    emotes.root,
  ]);

  // ---- personality (named presets only on the web)
  const personality = radioCards<ActivityPresetId>(
    'preset',
    WS.personality.desc,
    ACTIVITY_PRESET_IDS,
    (p) => [h('span', { class: 'title', text: WS.presets[p].title }), h('span', { class: 'desc', text: WS.presets[p].desc })],
    (p) => change({ field: 'preset', value: p }),
    true,
  );
  const personalitySection = h('section', {}, [h('h3', { text: WS.personality.title }), personality.root]);

  // ---- sound
  const soundSwitch = switchRow(WS.sound.enabledLabel, (on) => {
    // The change of a checkbox is dispatched within the click (a user gesture): audio can start here.
    if (on) deps.onSoundGesture();
    change({ field: 'soundEnabled', value: on });
    refresh();
  });
  const volume = range(WS.sound.volumeLabel, VOLUME_RANGE, (v) => `${Math.round(v * 100)}%`, (v, save) => change({ field: 'volume', value: v }, save));
  const volumeNote = h('p', { class: 'note', text: WS.sound.volumeNeedsSound });
  const soundSection = h('section', {}, [h('h3', { text: WS.sound.title }), h('p', { class: 'note', text: WS.sound.desc }), soundSwitch.root, volume.root, volumeNote]);

  // ---- install (not in the Android app)
  const installNote = h('p', {});
  const installBtn = h('button', { type: 'button', class: 'primary', text: WS.install.promptButton });
  installBtn.addEventListener('click', () => deps.onInstall());
  const appleStorageNote = h('p', { class: 'note', text: WS.install.appleStorage });
  const evictionNote = h('p', { class: 'note warn', text: WS.install.evictionNote });
  const installSection = h('section', {}, [h('h3', { text: WS.install.title }), installNote, h('div', { class: 'actions' }, [installBtn]), appleStorageNote, evictionNote]);

  // ---- storage on this device
  const storageNote = h('p', {});
  const updateNote = h('p', { class: 'note warn', text: WS.storage.updateReady });
  updateNote.hidden = true;
  const storageSection = h('section', {}, [h('h3', { text: WS.storage.title }), storageNote, updateNote]);

  // ---- take your cat to another device
  // TODO(1.4.0 profile transfer): a later change fills `transferSlot` with the export/import
  // controls built on src/shared/profileTransfer.ts (a local file only, never a network upload) and
  // calls setTransferVisible(true). Until then the section stays hidden and empty. Do not implement
  // export/import here.
  const transferSlot = h('div', { class: 'transfer-slot', id: 'transfer-slot' });
  const transferSection = h('section', { id: 'transfer-section', 'aria-labelledby': 'transfer-title' }, [h('h3', { id: 'transfer-title', text: WS.transfer.title }), transferSlot]);
  transferSection.hidden = true;

  // ---- how to play, privacy
  const helpSection = h('section', {}, [h('h3', { text: WS.help.title }), ...WS.help.text.map((t) => h('p', { text: t }))]);
  const privacySection = h('section', {}, [h('h3', { text: WS.privacy.title }), ...WS.privacy.text(deps.host.place).map((t) => h('p', { text: t }))]);

  // ---- start again
  const resetNote = h('p', { class: 'note', 'aria-live': 'polite' });
  const resetBtn = h('button', { type: 'button', text: WS.reset.resetSettings });
  resetBtn.addEventListener('click', () => {
    deps.onResetSettings();
    resetNote.textContent = WS.reset.resetDone;
    refresh();
  });
  const startOverBtn = h('button', { type: 'button', class: 'danger', text: WS.reset.startOver });
  const confirmBtn = h('button', { type: 'button', class: 'danger', text: WS.reset.startOverConfirm });
  const cancelBtn = h('button', { type: 'button', text: WS.reset.startOverCancel });
  const confirmRow = h('div', { class: 'actions' }, [confirmBtn, cancelBtn]);
  const confirmAsk = h('p', { class: 'note warn', text: WS.reset.startOverAsk });
  const startOverNote = h('p', { class: 'note', 'aria-live': 'polite' });
  const setConfirming = (on: boolean): void => {
    confirmRow.hidden = !on;
    confirmAsk.hidden = !on;
    startOverBtn.hidden = on;
  };
  startOverBtn.addEventListener('click', () => {
    setConfirming(true);
    cancelBtn.focus();
  });
  cancelBtn.addEventListener('click', () => {
    setConfirming(false);
    startOverBtn.focus();
  });
  confirmBtn.addEventListener('click', () => {
    if (!deps.onStartOver()) startOverNote.textContent = WS.reset.startOverFailed;
  });
  setConfirming(false);
  const resetSection = h('section', {}, [
    h('h3', { text: WS.reset.title }),
    h('p', { class: 'note', text: WS.reset.resetSettingsDesc }),
    h('div', { class: 'actions' }, [resetBtn]),
    resetNote,
    h('p', { class: 'note', text: WS.reset.startOverDesc }),
    h('div', { class: 'actions' }, [startOverBtn]),
    confirmAsk,
    confirmRow,
    startOverNote,
  ]);

  // ---- about
  const aboutSection = h('section', {}, [h('h3', { text: WS.about.title }), h('p', { text: WS.about.text }), h('p', { class: 'note', text: WS.about.version(deps.version) })]);

  dialog.replaceChildren(
    head,
    catSection,
    personalitySection,
    soundSection,
    installSection,
    storageSection,
    transferSection,
    helpSection,
    privacySection,
    resetSection,
    aboutSection,
  );
  if (!dialog.hasAttribute('aria-labelledby')) dialog.setAttribute('aria-labelledby', titleId);

  function refresh(): void {
    const s = deps.getSettings();
    if (document.activeElement !== nameInput) nameInput.value = s.general.catName;
    coat.set(s.appearance.skin);
    style.set(s.appearance.style);
    size.set(s.appearance.size);
    shadow.input.checked = s.appearance.shadow;
    emotes.input.checked = s.appearance.emotes;
    personality.set(selectedPreset(s));
    soundSwitch.input.checked = s.sound.enabled;
    volume.set(s.sound.volume);
    volume.input.disabled = !s.sound.enabled;
    volumeNote.hidden = s.sound.enabled;
    const hint = deps.installHint();
    const text = installText(hint);
    installSection.hidden = text === null && !showEvictionNote(deps.host);
    installNote.textContent = text ?? '';
    installNote.hidden = text === null;
    installBtn.hidden = hint !== 'prompt';
    appleStorageNote.hidden = hint !== 'apple';
    evictionNote.hidden = !showEvictionNote(deps.host);
    storageNote.textContent = deps.storageText();
  }

  function setOpen(open: boolean): void {
    if (isOpen === open) return;
    isOpen = open;
    try {
      deps.onOpenChange?.(open);
    } catch {
      // The listener is optional.
    }
  }

  function open(): void {
    if (isOpen) return;
    refresh();
    resetNote.textContent = '';
    startOverNote.textContent = '';
    setConfirming(false);
    try {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } catch {
      dialog.setAttribute('open', '');
    }
    setOpen(true);
  }

  function close(): void {
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
    setOpen(false);
  }

  // Escape (native), Android back (Chrome closes modal dialogs) or close(): all end here.
  dialog.addEventListener('close', () => setOpen(false));
  // A tap on the backdrop (outside the sheet's box) closes it.
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
  });

  return {
    open,
    close,
    get isOpen() {
      return isOpen;
    },
    refresh,
    showUpdateReady() {
      updateNote.hidden = false;
    },
    transferSlot,
    setTransferVisible(visible: boolean) {
      transferSection.hidden = !visible;
    },
  };
}
