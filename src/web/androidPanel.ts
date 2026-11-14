// The Android app's home panel (1.4.2, rebuilt for the Living Companion): the screen a person opens
// GizeCat to. It replaces the toolbar-and-sheet as the first thing seen in the native app (the sheet
// stays, behind "More looks and sound" and "All settings", and the in-app cat stays, behind "Show the
// cat in this app").
//
// Sections, top to bottom: COMPANION (the floating cat: status, a large Start/Stop, Pause and Hide, the
// permission state, the in-app explanation that precedes Android's own settings page, and live status
// chips for mood, activity, personality and the world event), APPEARANCE (name, coat, size),
// PERSONALITY (the seven profiles and Auto), BEHAVIOR (activity, speed, rest and sleep, screen edges,
// hunting, and the world events with a switch for each), INTERACTIONS (petting, carrying, throwing and
// the session-only Laser mode), AUDIO, ACCESSIBILITY and JOURNAL. Every control goes through the web
// allow-list (settingsModel.ts), exactly like the sheet; nothing here reads the screen, other apps or
// the network. The floating cat itself is a separate service in another WebView: opening and closing
// this panel never touches its state, and while it runs this parked page only READS what it last
// saved (the journal) and never writes the cat.
//
// Built with the CSP-safe helpers (no innerHTML, no style attributes). DOM access only through the
// elements this module creates. The one timer (live status, every 2 s) runs only while the panel is
// open and the page is visible.
import { h, uid } from '../renderer/settings/dom';
import { coatArt } from '../renderer/settings/skins';
import { SKINS, type BehaviorState, type SkinId } from '../shared/cat';
import { ALL_EVENT_IDS, JOURNAL_MAX, PERSONALITY_IDS, type AnyEventId, type JournalEntry, type Mood, type PersonalityChoice, type PersonalityId } from '../shared/companion';
import { PERSONALITY_TEXT } from '../shared/personalityText';
import { disabledBehaviorSet, type BehaviorId, type Settings } from '../shared/settings';
import { ACTIVITY_PRESET_IDS, type ActivityPresetId } from '../shared/settingsPresets';
import { eventDescription, eventName, formatJournalDate, journalText } from '../shared/worldText';
import type { FloatingElements } from './floatingUi';
import type { FloatingState } from './floatingProtocol';
import type { SessionFlags } from './sessionFlags';
import {
  CAT_NAME_MAX,
  LEVEL_RANGE,
  MOVEMENT_RANGE,
  PACE_RANGE,
  patchFor,
  selectedPreset,
  SIZE_RANGE,
  SLEEP_RANGE,
  VOLUME_RANGE,
  type WebField,
  type WebPatchResult,
} from './settingsModel';
import { activityLabel } from './status';
import { attachSecretNote } from './secretNote';
import type { WebSecretName } from './secretName';
import { WS } from './strings';

/** What the status chips show: the in-page sim's companion status plus its behaviour state. */
export interface CompanionView {
  mood: Mood;
  event: AnyEventId | null;
  nextEventInMs: number | null;
  nearestPersonality: PersonalityId;
  personalityIsAuto: boolean;
  state: BehaviorState;
}

/**
 * Where the panel reads the cat from (main.ts). While the floating cat runs its WebView owns the cat,
 * so `live()` is false: no live status (null), the journal is the stored snapshot, and it cannot be
 * cleared from here.
 */
export interface CompanionSource {
  live(): boolean;
  status(): CompanionView | null;
  /** Oldest first, as the sim keeps it. */
  journal(): readonly JournalEntry[];
  /** True when the journal was cleared and saved. */
  clearJournal(): boolean;
}

export interface AndroidPanelDeps {
  getSettings: () => Settings;
  /** One control's patch, through the web allow-list; `save` false is a live preview while a slider moves. */
  apply: (patch: Record<string, Record<string, unknown>>, save: boolean) => WebPatchResult;
  companion: CompanionSource;
  /** Laser mode and the events pause: session-only, never stored with the settings (sessionFlags.ts). */
  session: { get(): SessionFlags; set(next: SessionFlags): void };
  /** A switch that turns sound on was just flipped (inside the gesture): unlock the AudioContext. */
  onSoundGesture?: () => void;
  /** Opens the full settings sheet (more coats, drawing styles, sound, profile, start over). */
  onCustomize: () => void;
  /** Leaves the panel for the in-app cat. */
  onStage: () => void;
  version: string;
  /** The panel opened or closed (the in-app cat steps aside while it is open). */
  onOpenChange?: (open: boolean) => void;
  /** The name-dependent extra (secretName.ts); absent: the name field is plain. */
  secret?: WebSecretName;
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

/** How often the live status and the journal are re-read while the panel is open, ms. */
const LIVE_REFRESH_MS = 2000;

export function createAndroidPanel(deps: AndroidPanelDeps): AndroidPanel {
  let isOpen = false;
  let liveTimer: number | null = null;

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

  /** A smaller heading inside a card. */
  const subhead = (text: string): HTMLElement => h('h3', { class: 'subhead', text });

  // ---- header
  const chip = h('span', { class: 'chip', 'aria-live': 'polite' });
  const head = h('header', { class: 'panel-head' }, [
    h('img', { class: 'panel-logo', src: 'icons/icon-192.png', alt: '', width: 48, height: 48 }),
    h('div', { class: 'panel-title' }, [h('h1', { text: 'GizeCat' }), h('p', { text: WS.panel.subtitle })]),
    chip,
  ]);

  // ---- companion: the floating cat (the elements createFloatingUi drives) and the live status
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

  const chipItem = (label: string): { root: HTMLElement; value: HTMLElement } => {
    const value = h('span', { class: 'sc-value' });
    return { root: h('li', { class: 'status-chip' }, [h('span', { class: 'sc-label', text: label }), value]), value };
  };
  const moodChip = chipItem(WS.panel.companion.mood);
  const doingChip = chipItem(WS.panel.companion.activity);
  const personalityChip = chipItem(WS.panel.companion.personality);
  const eventChip = chipItem(WS.panel.companion.event);
  const liveNote = h('p', { class: 'note', hidden: true, text: WS.panel.companion.floatingNote });
  const statusChips = h('div', { class: 'status-block' }, [h('h3', { class: 'subhead', text: WS.panel.companion.statusTitle }), h('ul', { class: 'status-chips' }, [moodChip.root, doingChip.root, personalityChip.root, eventChip.root]), liveNote]);

  const hero = pcard(WS.panel.companion.title, [
    heroText,
    h('div', { class: 'hero-actions' }, [startBtn, pauseBtn, hideBtn, stopBtn]),
    statusLine,
    ask,
    statusChips,
    h('div', { class: 'perm-list' }, [overlayRow, notifRow]),
    h('p', { class: 'note', text: WS.panel.permissions.note }),
  ]);
  hero.classList.add('hero');

  // ---- appearance
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
  // Registered after the change handler above, so it reads the value that handler settled on.
  const nameField = h('div', { class: 'field' }, [h('label', { for: nameId, text: WS.cat.nameLabel }), nameInput, nameErr]);
  attachSecretNote(nameInput, deps.secret);
  const coat = radioCards<SkinId>('coat', WS.cat.coatLabel, SKINS, (s) => [coatArt(s), h('span', { class: 'title', text: WS.skins[s] })], (s) => change({ field: 'skin', value: s }));
  const size = slider(WS.cat.sizeLabel, SIZE_RANGE, (v) => `${Math.round(v * 100)}%`, (v, save) => change({ field: 'size', value: v }, save));
  const moreBtn = h('button', { type: 'button', text: WS.panel.cat.more });
  moreBtn.addEventListener('click', () => deps.onCustomize());
  const catCard = pcard(WS.panel.cat.title, [nameField, coat.root, size.root, h('div', { class: 'actions' }, [moreBtn])]);

  // ---- personality: the seven profiles and Auto (the cat never changes the choice)
  const PERSONALITY_VALUES: readonly PersonalityChoice[] = ['auto', ...PERSONALITY_IDS];
  const personality = radioCards<PersonalityChoice>(
    'personality',
    WS.panel.personality.groupLabel,
    PERSONALITY_VALUES,
    (p) =>
      p === 'auto'
        ? [h('span', { class: 'title', text: WS.panel.personality.auto }), h('span', { class: 'desc', text: WS.panel.personality.autoDesc })]
        : [h('span', { class: 'title', text: PERSONALITY_TEXT[p].name }), h('span', { class: 'desc', text: PERSONALITY_TEXT[p].summary })],
    (p) => change({ field: 'personality', value: p }),
    true,
  );
  const personalityCard = pcard(WS.panel.personality.title, [h('p', { class: 'note', text: WS.panel.personality.desc }), personality.root]);

  // ---- behavior
  const preset = radioCards<ActivityPresetId>(
    'preset',
    WS.panel.behavior.activityLabel,
    ACTIVITY_PRESET_IDS,
    (p) => [h('span', { class: 'title', text: WS.presets[p].title }), h('span', { class: 'desc', text: WS.presets[p].desc })],
    (p) => change({ field: 'preset', value: p }),
    true,
  );
  const speed = slider(WS.panel.behavior.speed, MOVEMENT_RANGE, (v) => `${Math.round(v * 100)}%`, (v, save) => change({ field: 'movementSpeed', value: v }, save));
  const toggle = (id: BehaviorId, enabled: boolean): void => change({ field: 'behaviorToggle', id, enabled, current: deps.getSettings() });
  const edges = switchRow(WS.panel.behavior.edges, WS.panel.behavior.edgesDesc, (on) => toggle('screenEdges', on));
  const hunt = switchRow(WS.panel.behavior.hunt, WS.panel.behavior.huntDesc, (on) => {
    // Hunting is the chase and the pounce; the pounce needs the chase.
    toggle('chaseCursor', on);
    toggle('pounce', on);
  });
  const play = slider(WS.panel.behavior.play, LEVEL_RANGE, (v) => `${Math.round(v * 100)}%`, (v, save) => change({ field: 'cursorPlay', value: v }, save));
  const sleep = slider(WS.panel.behavior.sleep, SLEEP_RANGE, (v) => WS.panel.behavior.sleepValue(Math.round(v)), (v, save) => change({ field: 'sleepMinutes', value: v }, save));
  const activity = slider(WS.panel.behavior.activity, LEVEL_RANGE, (v) => `${Math.round(v * 100)}%`, (v, save) => change({ field: 'autonomy', value: v }, save));

  // World events: the master switch, the rare pool, the pace, a session pause and one switch per event.
  const eventsMaster = switchRow(WS.panel.behavior.eventsMaster, WS.panel.behavior.eventsMasterDesc, (on) => change({ field: 'eventsEnabled', value: on }));
  const eventsRare = switchRow(WS.panel.behavior.eventsRare, WS.panel.behavior.eventsRareDesc, (on) => change({ field: 'rareEvents', value: on }));
  const eventsPace = slider(WS.panel.behavior.eventsPace, PACE_RANGE, (v) => WS.panel.behavior.eventsPaceValue(v), (v, save) => change({ field: 'eventPace', value: v }, save));
  const eventsPause = switchRow(WS.panel.behavior.eventsPause, WS.panel.behavior.eventsPauseDesc, (on) => {
    deps.session.set({ ...deps.session.get(), eventsPaused: on });
    refresh();
  });
  const eventSwitches = new Map<AnyEventId, HTMLInputElement>();
  const eventRows = ALL_EVENT_IDS.map((id) => {
    const row = switchRow(eventName(id), eventDescription(id), (on) => change({ field: 'eventToggle', id, enabled: on, current: deps.getSettings() }));
    eventSwitches.set(id, row.input);
    return row.root;
  });
  const eventsList = h('details', { class: 'events-list' }, [h('summary', { text: WS.panel.behavior.eventsList }), h('p', { class: 'note', text: WS.panel.behavior.eventsListNote }), ...eventRows]);
  const behaviorCard = pcard(WS.panel.behavior.title, [
    preset.root,
    speed.root,
    edges.root,
    hunt.root,
    play.root,
    subhead(WS.panel.behavior.restTitle),
    sleep.root,
    activity.root,
    h('p', { class: 'note', text: WS.panel.behavior.restNote }),
    subhead(WS.panel.behavior.eventsTitle),
    eventsMaster.root,
    eventsRare.root,
    eventsPace.root,
    eventsPause.root,
    eventsList,
  ]);

  // ---- interactions
  const petting = switchRow(WS.panel.interactions.petting, null, (on) => change({ field: 'petting', value: on }));
  const dragging = switchRow(WS.panel.interactions.dragging, null, (on) => change({ field: 'dragging', value: on }));
  const throwing = switchRow(WS.panel.interactions.throwing, null, (on) => change({ field: 'throwing', value: on }));
  const laser = switchRow(WS.panel.interactions.laser, WS.panel.interactions.laserDesc, (on) => {
    deps.session.set({ ...deps.session.get(), laser: on });
    refresh();
  });
  const laserNeedsHunt = h('p', { class: 'note', hidden: true, text: WS.panel.interactions.laserNeedsHunt });
  const interactionsCard = pcard(WS.panel.interactions.title, [
    petting.root,
    dragging.root,
    throwing.root,
    h('p', { class: 'note', text: WS.panel.interactions.note }),
    laser.root,
    laserNeedsHunt,
    h('p', { class: 'note', text: WS.panel.interactions.laserLimit }),
  ]);

  // ---- audio
  const soundMaster = switchRow(WS.panel.audio.master, WS.panel.audio.masterDesc, (on) => {
    // Inside the gesture: the one moment a phone lets audio start.
    if (on) deps.onSoundGesture?.();
    change({ field: 'soundEnabled', value: on });
  });
  const soundCat = switchRow(WS.panel.audio.cat, null, (on) => change({ field: 'soundCat', value: on }));
  const soundWorld = switchRow(WS.panel.audio.world, null, (on) => change({ field: 'soundWorld', value: on }));
  const volume = slider(WS.panel.audio.volume, VOLUME_RANGE, (v) => `${Math.round(v * 100)}%`, (v, save) => change({ field: 'volume', value: v }, save));
  const audioNote = h('p', { class: 'note', text: WS.panel.audio.needsSound });
  const audioCard = pcard(WS.panel.audio.title, [soundMaster.root, soundCat.root, soundWorld.root, volume.root, audioNote]);

  // ---- accessibility
  const reduced = switchRow(WS.panel.accessibility.reducedMotion, WS.panel.accessibility.reducedMotionDesc, (on) => change({ field: 'reducedMotion', value: on }));
  const accessibilityCard = pcard(WS.panel.accessibility.title, [reduced.root, h('p', { class: 'note', text: WS.panel.accessibility.systemNote })]);

  // ---- journal: newest first, dates and sentences from worldText.ts
  const journalEnabled = switchRow(WS.panel.journal.enabled, null, (on) => change({ field: 'journalEnabled', value: on }));
  const journalCount = h('p', { class: 'note', 'aria-live': 'polite' });
  const journalList = h('ol', { class: 'journal-list' });
  const journalEmpty = h('p', { class: 'journal-empty', hidden: true });
  const journalNote = h('p', { class: 'note', hidden: true, text: WS.panel.journal.storedNote });
  const journalMsg = h('p', { class: 'note', role: 'status', 'aria-live': 'polite' });
  const clearBtn = h('button', { type: 'button', class: 'danger', text: WS.panel.journal.clear });
  const clearYes = h('button', { type: 'button', class: 'danger', text: WS.panel.journal.clearConfirm });
  const clearNo = h('button', { type: 'button', text: WS.panel.journal.clearCancel });
  const clearAsk = h('div', { class: 'panel-ask', role: 'group', 'aria-label': WS.panel.journal.clear, hidden: true }, [
    h('p', { text: WS.panel.journal.clearAsk }),
    h('div', { class: 'actions' }, [clearYes, clearNo]),
  ]);
  clearBtn.addEventListener('click', () => {
    clearAsk.hidden = false;
    clearNo.focus();
  });
  clearNo.addEventListener('click', () => {
    clearAsk.hidden = true;
    clearBtn.focus();
  });
  clearYes.addEventListener('click', () => {
    clearAsk.hidden = true;
    journalMsg.textContent = deps.companion.clearJournal() ? WS.panel.journal.cleared : WS.panel.journal.clearFailed;
    journalSignature = '';
    refreshLive();
    clearBtn.focus();
  });
  const journalCard = pcard(WS.panel.journal.title, [
    h('p', { class: 'note', text: WS.panel.journal.desc }),
    journalEnabled.root,
    journalCount,
    journalEmpty,
    journalList,
    journalNote,
    h('div', { class: 'actions' }, [clearBtn]),
    clearAsk,
    journalMsg,
  ]);
  let journalSignature = '';

  // ---- footer
  const stageBtn = h('button', { type: 'button', text: WS.panel.footer.stage });
  stageBtn.addEventListener('click', () => deps.onStage());
  const allBtn = h('button', { type: 'button', text: WS.panel.footer.settings });
  allBtn.addEventListener('click', () => deps.onCustomize());
  const footer = h('footer', { class: 'panel-foot' }, [h('div', { class: 'actions' }, [stageBtn, allBtn]), h('p', { class: 'note', text: WS.about.version(deps.version) })]);

  const grid = h('div', { class: 'panel-grid' }, [hero, catCard, personalityCard, behaviorCard, interactionsCard, audioCard, accessibilityCard, journalCard]);
  const root = h('main', { class: 'panel', id: 'panel', 'aria-label': 'GizeCat', hidden: true }, [head, grid, footer]);

  /** The live status chips and the journal: read from the cat (or its stored snapshot), never written here. */
  function refreshLive(): void {
    const s = deps.getSettings();
    const live = deps.companion.live();
    const status = deps.companion.status();
    const flags = deps.session.get();
    liveNote.hidden = live;
    moodChip.root.hidden = status === null;
    doingChip.root.hidden = status === null;
    if (status) {
      moodChip.value.textContent = WS.panel.companion.moods[status.mood] ?? String(status.mood);
      doingChip.value.textContent = activityLabel(status.state);
    }
    // 'auto' shows its nearest profile once the live cat can say which; the choice itself never changes.
    const choice = s.companion.personality;
    personalityChip.value.textContent =
      choice === 'auto'
        ? status && status.personalityIsAuto
          ? WS.panel.companion.personalityAuto(PERSONALITY_TEXT[status.nearestPersonality]?.name ?? '')
          : WS.panel.personality.auto
        : PERSONALITY_TEXT[choice].name;
    let eventText: string;
    if (!s.companion.events.enabled) eventText = WS.panel.companion.eventOff;
    else if (flags.eventsPaused) eventText = WS.panel.companion.eventPaused;
    else if (status?.event) eventText = WS.panel.companion.eventRunning(eventName(status.event));
    else if (status && status.nextEventInMs !== null && Number.isFinite(status.nextEventInMs)) eventText = WS.panel.companion.eventNext(Math.max(1, Math.round(status.nextEventInMs / 60_000)));
    else eventText = WS.panel.companion.eventNone;
    // Without a live cat nothing is known about the schedule: only the switches above can be said.
    eventChip.root.hidden = status === null && s.companion.events.enabled && !flags.eventsPaused;
    eventChip.value.textContent = eventText;

    const entries = deps.companion.journal();
    const newest = entries.length > 0 ? entries[entries.length - 1] : undefined;
    const signature = `${live ? 'l' : 's'}:${entries.length}:${newest ? newest.at : 0}:${s.companion.journal.enabled ? 1 : 0}`;
    journalNote.hidden = live;
    clearBtn.disabled = !live;
    if (signature !== journalSignature) {
      journalSignature = signature;
      const shown = entries.slice(-JOURNAL_MAX).reverse();
      journalList.replaceChildren(
        ...shown.map((e) => h('li', { class: 'journal-entry' }, [h('time', { class: 'journal-date', text: formatJournalDate(e.at) }), h('span', { class: 'journal-text', text: journalText(e.id, e.outcome) })])),
      );
      journalCount.textContent = shown.length > 0 ? WS.panel.journal.count(shown.length) : '';
      journalEmpty.hidden = shown.length > 0;
      journalEmpty.textContent = s.companion.journal.enabled ? WS.panel.journal.empty : WS.panel.journal.emptyOff;
    }
  }

  function refresh(): void {
    const s = deps.getSettings();
    const off = disabledBehaviorSet(s.behavior);
    if (document.activeElement !== nameInput) nameInput.value = s.general.catName;
    deps.secret?.setName(s.general.catName);
    coat.set(s.appearance.skin);
    size.set(s.appearance.size);
    personality.set(s.companion.personality);
    preset.set(selectedPreset(s));
    speed.set(s.behavior.movementSpeed);
    edges.input.checked = !off.has('screenEdges');
    hunt.input.checked = !off.has('chaseCursor') && !off.has('pounce');
    play.set(s.behavior.cursorPlay);
    play.input.disabled = off.has('chaseCursor');
    sleep.set(s.behavior.sleepAfterIdleMinutes);
    activity.set(s.behavior.autonomy);

    const events = s.companion.events;
    const disabled = new Set<AnyEventId>(events.disabled);
    eventsMaster.input.checked = events.enabled;
    eventsRare.input.checked = events.rare;
    eventsRare.input.disabled = !events.enabled;
    eventsPace.set(events.pace);
    eventsPace.input.disabled = !events.enabled;
    eventsPause.input.checked = deps.session.get().eventsPaused;
    eventsPause.input.disabled = !events.enabled;
    for (const [id, input] of eventSwitches) {
      input.checked = !disabled.has(id);
      input.disabled = !events.enabled;
    }

    petting.input.checked = s.interaction.petting;
    dragging.input.checked = s.interaction.dragging;
    throwing.input.checked = s.interaction.throwing;
    laser.input.checked = deps.session.get().laser;
    // Chasing a light is cursor play: with hunting and pointer play off the cat will not follow the dot.
    laser.input.disabled = off.has('chaseCursor');
    laserNeedsHunt.hidden = !off.has('chaseCursor');

    soundMaster.input.checked = s.sound.enabled;
    soundCat.input.checked = s.sound.cat;
    soundWorld.input.checked = s.sound.world;
    soundCat.input.disabled = !s.sound.enabled;
    soundWorld.input.disabled = !s.sound.enabled;
    volume.set(s.sound.volume);
    volume.input.disabled = !s.sound.enabled;
    audioNote.hidden = s.sound.enabled;

    reduced.input.checked = s.companion.reducedMotion;
    journalEnabled.input.checked = s.companion.journal.enabled;
    journalSignature = '';
    refreshLive();
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
    // Whether the floating cat runs decides what the status and the journal can show.
    if (isOpen) refreshLive();
  }
  // Before native answers: calm defaults, not a guess about the permission.
  heroText.textContent = WS.panel.hero.off;
  chip.textContent = WS.panel.chip.off;
  chip.className = 'chip chip-off';

  function stopLiveTimer(): void {
    if (liveTimer === null) return;
    window.clearInterval(liveTimer);
    liveTimer = null;
  }

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
      // Nothing keeps the CPU busy behind a page nobody can see: no ticks while hidden.
      liveTimer = window.setInterval(() => {
        if (!document.hidden) refreshLive();
      }, LIVE_REFRESH_MS);
      head.querySelector('h1')?.setAttribute('tabindex', '-1');
      head.querySelector<HTMLElement>('h1')?.focus();
    } else {
      stopLiveTimer();
      // A half-answered confirmation does not wait for the next visit.
      clearAsk.hidden = true;
      journalMsg.textContent = '';
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
