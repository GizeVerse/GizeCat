import type { AppStatus } from '../../../shared/ipc';
import type { CapabilityId, RuntimeCapability } from '../../../shared/platform';
import type { LivelyBehavior, ToggleableBehavior } from '../../../shared/settings';
import { BEHAVIOR_IDS, LIVELY_IDS, LIVELY_PARENT } from '../catalog';
import type { PageContext, PageView } from '../context';
import { group, page, radioGroup, row, segmentedRow, setNote, sliderRow, toggleRow, toggleSwitch, type RadioItem, type SliderHandle } from '../controls';
import { h, icon, type GlyphName } from '../dom';
import { NUMERIC_FIELDS, type FieldId, type FieldKey, type NumericField, type SectionKey } from '../fields';
import { companionsFor, fieldId, presetLeaves, setBehaviorEnabled, setExtraEnabled } from '../patch';
import { intendedPresetValues, PRESET_CHOICES, presetSelection } from '../presetView';
import type { FieldBinding } from '../store';
import { platformWording, S } from '../strings';
import { worldEventRows } from '../worldEventRows';

const B = S.behavior;
const F = NUMERIC_FIELDS;

type LivelyId = (typeof LIVELY_IDS)[number];

/** A slider of the Personality group (built per page; the spec is plain data for tests). */
export interface SliderSpec {
  readonly id: FieldId;
  readonly title: string;
  readonly desc: string;
  build(ctx: PageContext): SliderHandle;
}

function sliderSpec<Sec extends SectionKey>(field: NumericField<Sec>, title: string, desc: string, glyph: GlyphName, descFloorOnly?: string): SliderSpec {
  const key = field.key as FieldKey<Sec>;
  return {
    id: fieldId(field.section, key),
    title,
    desc,
    // A preset-governed value carries activityPreset 'custom'; main re-derives the real choice.
    build: (ctx) =>
      sliderRow(ctx, field, {
        title,
        desc: descFloorOnly !== undefined && platformWording(ctx.store.view.status.platform) !== 'windows' ? descFloorOnly : desc,
        icon: glyph,
        with: companionsFor(field.section, key),
      }),
  };
}

/** Up front in the Personality group (ADR 0003 §9.1). */
export const PERSONALITY_SLIDERS: readonly SliderSpec[] = [
  sliderSpec(F.autonomy, B.activityTitle, B.activityDesc, 'lightbulb'),
  sliderSpec(F.cursorPlay, B.huntingTitle, B.huntingDesc, 'mouse'),
  sliderSpec(F.workDisruption, B.workTitle, B.workDesc, 'keyboard'),
];

/** Behind "Fine-tune". */
export const FINE_TUNE_SLIDERS: readonly SliderSpec[] = [
  sliderSpec(F.exploration, B.exploringTitle, B.exploringDesc, 'mapPin'),
  sliderSpec(F.heights, B.heightsTitle, B.heightsDesc, 'up'),
  sliderSpec(F.mischief, B.mischiefTitle, B.mischiefDesc, 'sparkle', B.mischiefDescFloorOnly),
  sliderSpec(F.stayLength, B.staysTitle, B.staysDesc, 'clock'),
  sliderSpec(F.reactionIntensity, B.reactionsTitle, B.reactionsDesc, 'touch'),
];

/** Every setting the Personality group has a control for (tests check that no v1.2 field is left without one). */
export const PERSONALITY_FIELD_IDS: readonly FieldId[] = [
  fieldId('behavior', 'activityPreset'),
  ...PERSONALITY_SLIDERS.map((s) => s.id),
  ...FINE_TUNE_SLIDERS.map((s) => s.id),
  fieldId('behavior', 'disabledExtras'),
];

/** Rows that need what only Windows reports today: other apps' windows, or its shell (File Explorer, Windows Terminal, the taskbar, its browser tab strips). */
const ROW_NEEDS: Readonly<Partial<Record<ToggleableBehavior | LivelyBehavior, CapabilityId>>> = {
  inspectWindows: 'windowSurfaces',
  perchOnWindows: 'windowSurfaces',
  climbWindows: 'windowSurfaces',
  screenEdges: 'windowSurfaces',
  taskbarPlay: 'taskbarSurfaces',
  surfaceHops: 'windowSurfaces',
  tabStrips: 'tabStrips',
  tabReactions: 'tabStrips',
  explorerTabs: 'tabStrips',
  terminalTabs: 'tabStrips',
};

/**
 * Settings with a row of their own that act only on these inputs (any one is enough). An empty list
 * means no capability reports the input: typing is inferred only from Windows' GetLastInputInfo, and
 * activityIdle, which macOS and Linux do have, says nothing about it.
 */
const SETTING_NEEDS: Readonly<Partial<Record<FieldId, readonly CapabilityId[]>>> = {
  'behavior.stayLength': ['windowSurfaces', 'tabStrips'],
  'behavior.activitySensitivity': ['windowSurfaces', 'taskbarSurfaces', 'perception'],
  'behavior.reactToWindows': ['windowSurfaces'],
  'behavior.reactToTyping': [],
};

/** True on Windows and without a platform report; elsewhere when main reports at least one of these available. */
function anyCapabilityOffered(anyOf: readonly CapabilityId[], status: Pick<AppStatus, 'platform'>): boolean {
  const platform = status.platform;
  if (!platform || platform.id === 'win32') return true;
  return anyOf.some((id) => {
    const cap = platform.capabilities[id] as RuntimeCapability | undefined;
    return !cap || cap.available;
  });
}

/**
 * Whether a behaviour row is offered (1.4.0). Off Windows, a row that depends on something main
 * reports unavailable is left out: it would have no effect and names things that platform does not
 * have. On Windows (and without a platform report) every row stays, as before.
 */
export function behaviorRowOffered(id: ToggleableBehavior | LivelyBehavior, status: Pick<AppStatus, 'platform'>): boolean {
  const needs = ROW_NEEDS[id];
  return needs === undefined || anyCapabilityOffered([needs], status);
}

/** The same rule for a slider or switch bound to its own setting. The value stays stored and preset-governed. */
export function settingRowOffered(id: FieldId, status: Pick<AppStatus, 'platform'>): boolean {
  const needs = SETTING_NEEDS[id];
  return needs === undefined || anyCapabilityOffered(needs, status);
}

/** The summary of "Fine-tune" names the stays slider only where it is offered. */
export function fineTuneDesc(status: Pick<AppStatus, 'platform'>): string {
  return settingRowOffered(fieldId('behavior', 'stayLength'), status) ? B.fineTuneDesc : B.fineTuneDescFloorOnly;
}

/**
 * The notes under the Behaviour rows (1.4.0). Where the cat cannot use windows, advice about
 * maximized windows does not apply, and the pointer to Fine-tune names only rows that are offered.
 */
export function behaviorPageNotes(status: Pick<AppStatus, 'platform'>): readonly string[] {
  return behaviorRowOffered('climbWindows', status) ? [B.maximizedNote, B.extrasPointer] : [B.extrasPointerFloorOnly];
}

/** The v2 switch that must be on for a v1.2 behaviour to be offered, if any. */
export function extraParentOff(extra: LivelyId, disabledBehaviors: readonly ToggleableBehavior[]): ToggleableBehavior | null {
  const parent = LIVELY_PARENT[extra];
  return parent !== undefined && disabledBehaviors.includes(parent) ? parent : null;
}

function behaviorToggle(ctx: PageContext, behavior: ToggleableBehavior): HTMLElement {
  const text = B.behaviors[behavior];
  const parts = row({ title: text.title, desc: text.desc });
  const sw = toggleSwitch(parts.titleId, parts.describedBy);
  parts.control.append(sw.root);
  const binding: FieldBinding = {
    field: fieldId('behavior', 'disabledBehaviors'),
    isBusy: () => false,
    sync: (v) => {
      sw.input.checked = !(Array.isArray(v) && (v as unknown[]).includes(behavior));
      sw.refresh();
    },
    showError: (msg) => setNote(parts.error, msg, 'error'),
  };
  sw.input.addEventListener('change', () => {
    const next = setBehaviorEnabled(ctx.store.intended('behavior', 'disabledBehaviors'), behavior, sw.input.checked);
    ctx.store.set('behavior', 'disabledBehaviors', next, { origin: binding });
  });
  ctx.store.bind(binding);
  return parts.row;
}

/** A v1.2 opt-out (behavior.disabledExtras). Shown off and disabled while the v2 switch it lives under is off. */
function extraToggle(ctx: PageContext, extra: LivelyId): HTMLElement {
  const text = B.extras[extra];
  const parts = row({ title: text.title, desc: text.desc });
  const sw = toggleSwitch(parts.titleId, parts.describedBy);
  parts.control.append(sw.root);
  const render = (): void => {
    const parent = extraParentOff(extra, ctx.store.intended('behavior', 'disabledBehaviors'));
    const own = ctx.store.intended('behavior', 'disabledExtras').includes(extra);
    sw.input.checked = parent === null && !own;
    sw.input.disabled = parent !== null;
    parts.row.classList.toggle('is-disabled', parent !== null);
    sw.refresh();
    setNote(parts.note, parent === null ? null : B.extraNeeds(B.behaviors[parent].title), 'info');
  };
  const binding: FieldBinding = {
    field: fieldId('behavior', 'disabledExtras'),
    isBusy: () => false,
    sync: () => render(),
    showError: (msg) => setNote(parts.error, msg, 'error'),
  };
  sw.input.addEventListener('change', () => {
    const next = setExtraEnabled(ctx.store.intended('behavior', 'disabledExtras'), extra, sw.input.checked);
    ctx.store.set('behavior', 'disabledExtras', next, { origin: binding });
  });
  ctx.store.bind(binding);
  ctx.store.subscribe(render);
  return parts.row;
}

/** Calm / Playful / Mischievous, plus the Custom card, which only moving a slider selects. */
function presetSelector(ctx: PageContext): HTMLElement {
  const parts = row({ title: B.presetLabel, stacked: true, hideTitle: true });
  const container = h('div', { class: 'option-cards preset-cards', 'aria-labelledby': parts.titleId });
  const customTitle = h('span', { class: 'option-title', text: B.customTitle });
  const items: Array<RadioItem<(typeof PRESET_CHOICES)[number]>> = PRESET_CHOICES.map((choice) => {
    const custom = choice === 'custom';
    return {
      value: choice,
      el: h('button', { type: 'button', class: `option-card preset-${choice}`, 'aria-disabled': custom ? 'true' : undefined }, [
        h('span', { class: 'radio-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'option-text' }, [
          custom ? customTitle : h('span', { class: 'option-title', text: B.presets[choice].title }),
          h('span', { class: 'option-desc', text: custom ? B.customDesc : B.presets[choice].desc }),
        ]),
      ]),
    };
  });
  container.append(...items.map((i) => i.el));
  parts.control.append(container);
  const handle = radioGroup(container, items, (choice) => {
    if (choice === 'custom') return;
    handle.set(choice);
    ctx.store.setMany(presetLeaves(choice), { origin: binding });
  });
  const render = (): void => {
    const sel = presetSelection(intendedPresetValues(ctx.store));
    handle.set(sel.choice);
    customTitle.textContent = sel.customTitle;
  };
  const binding: FieldBinding = {
    field: fieldId('behavior', 'activityPreset'),
    isBusy: () => false,
    sync: () => render(),
    showError: (msg) => setNote(parts.error, msg, 'error'),
  };
  ctx.store.bind(binding);
  ctx.store.subscribe(render);
  return parts.row;
}

function fineTune(ctx: PageContext): HTMLElement {
  const status = ctx.store.view.status;
  const summary = h('summary', { class: 'row fine-tune-summary' }, [
    icon('equalizer', 'row-icon'),
    h('span', { class: 'row-text' }, [h('span', { class: 'row-title', text: B.fineTuneTitle }), h('span', { class: 'row-desc', text: fineTuneDesc(status) })]),
    icon('chevronDown', 'fine-tune-chevron'),
  ]);
  const extras = h('div', { class: 'fine-tune-extras' }, [h('h3', { class: 'fine-tune-heading', text: B.groupExtras }), h('p', { class: 'group-desc', text: B.groupExtrasDesc })]);
  return h('details', { class: 'fine-tune' }, [
    summary,
    h('div', { class: 'group-rows fine-tune-rows' }, [
      ...FINE_TUNE_SLIDERS.filter((s) => settingRowOffered(s.id, status)).map((s) => s.build(ctx).parts.row),
      extras,
      ...LIVELY_IDS.filter((id) => behaviorRowOffered(id, status)).map((id) => extraToggle(ctx, id)),
    ]),
  ]);
}

/**
 * The note under "When an app is full screen" (1.4.0): null on Windows (and without a platform
 * report), and wherever main reports full-screen detection available. On macOS a fixed sentence
 * (no detection, and the panel overlays also show over full-screen apps); elsewhere main's reason.
 */
export function fullscreenRowNote(status: Pick<AppStatus, 'platform'>): string | null {
  const platform = status.platform;
  if (!platform || platform.id === 'win32') return null;
  const cap = platform.capabilities.fullscreenAware as RuntimeCapability | undefined;
  if (!cap || cap.available) return null;
  if (platform.id === 'darwin') return B.fullscreenNoteMac;
  return cap.reason ?? B.fullscreenNoteElsewhere;
}

/**
 * The "when an app is full screen" choice (behavior.fullscreenBehavior). It moved to Accessibility &
 * Focus as "Full-screen quiet mode"; the row, its platform note and their behaviour are unchanged, so
 * the page that shows it passes its own words.
 */
export function fullscreenControl(ctx: PageContext, words: { title: string; desc: string }): { row: HTMLElement; sync(): void } {
  const parts = segmentedRow(
    ctx,
    'behavior',
    'fullscreenBehavior',
    (['hide', 'quiet', 'ignore'] as const).map((v) => ({ value: v, label: B.fullscreen[v] })),
    { title: words.title, desc: words.desc, icon: 'fullscreen' },
  ).parts;
  let shown: string | null | undefined;
  const sync = (): void => {
    const note = fullscreenRowNote(ctx.store.view.status);
    if (note === shown) return;
    shown = note;
    setNote(parts.note, note, 'info');
  };
  ctx.store.subscribe(sync);
  return { row: parts.row, sync };
}

export function behaviorPage(ctx: PageContext): PageView {
  const status = ctx.store.view.status;
  const offered = (key: FieldKey<'behavior'>): boolean => settingRowOffered(fieldId('behavior', key), status);
  const personality = [presetSelector(ctx), ...PERSONALITY_SLIDERS.map((s) => s.build(ctx).parts.row), fineTune(ctx)];
  const habits = [
    sliderRow(ctx, F.movementSpeed, { title: B.speedTitle, desc: B.speedDesc, icon: 'behavior' }),
    sliderRow(ctx, F.chaseDuration, { title: B.chaseTitle, desc: B.chaseDesc, icon: 'stopwatch' }),
    sliderRow(ctx, F.attentionSeeking, { title: B.attentionTitle, desc: B.attentionDesc, icon: 'message' }),
    ...(offered('activitySensitivity') ? [sliderRow(ctx, F.activitySensitivity, { title: B.sensitivityTitle, desc: B.sensitivityDesc, icon: 'window' })] : []),
    sliderRow(ctx, F.sleepAfterIdleMinutes, { title: B.sleepTitle, desc: B.sleepDesc, icon: 'moon' }),
  ];
  const awareness = [
    toggleRow(ctx, 'behavior', 'allowMultiMonitor', { title: B.multiMonitorTitle, desc: B.multiMonitorDesc, icon: 'monitor' }).parts.row,
    ...(offered('reactToTyping') ? [toggleRow(ctx, 'behavior', 'reactToTyping', { title: B.typingTitle, desc: B.typingDesc, icon: 'keyboard' }).parts.row] : []),
    ...(offered('reactToWindows') ? [toggleRow(ctx, 'behavior', 'reactToWindows', { title: B.windowsTitle, desc: B.windowsDesc, icon: 'window' }).parts.row] : []),
  ];
  const world = worldEventRows(ctx);
  const element = page(B.title, [
    group(B.groupPersonality, personality, B.groupPersonalityDesc),
    group(B.groupActivity, habits.map((s) => s.parts.row)),
    group(B.groupWorld, world.master, B.groupWorldDesc),
    group(B.groupWorldList, world.normal, B.groupWorldListDesc),
    group(B.groupWorldRare, world.rare, B.groupWorldRareDesc),
    group(B.groupAwareness, awareness),
    group(B.groupBehaviors, BEHAVIOR_IDS.filter((b) => behaviorRowOffered(b, status)).map((b) => behaviorToggle(ctx, b)), B.groupBehaviorsDesc),
    // Right under the window-climbing and tab-strip toggles, which end the list where they are offered.
    ...behaviorPageNotes(status).map((note) => h('p', { class: 'page-note' }, [icon('info'), h('span', { text: note })])),
  ]);
  return { id: 'behavior', title: B.title, element };
}
