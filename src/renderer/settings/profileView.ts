// 1.4.0 "Take your cat to another device" on the Personality page: an Export row (with "Include
// what it has learned", off by default) and an Import row whose preview dialog shows what would
// change and asks which parts to load. Main does all the work (dialogs, parsing, applying); this
// view only asks and words main's reason codes (strings.ts S.profile).
//
// Imports from src/shared/profileTransfer.ts and ipc.ts are TYPE ONLY: both build zod schemas at
// load, which must stay out of the settings bundle (tests/unit/main/profileBundle.test.ts).
import type { ProfileApplyResponse, ProfileExportResponse, ProfileOpenResponse } from '../../shared/ipc';
import { PLATFORM_LABELS } from '../../shared/platform';
import type { ProfileChange, ProfilePart, ProfileParts, ProfilePreview, ProfileValue } from '../../shared/profileTransfer';
import type { PageContext } from './context';
import { button, row, setNote, withBusy, type NoteTone, type RowParts } from './controls';
import { openDialog } from './dialog';
import { h, uid } from './dom';
import { formatCount, formatDecimal, formatPercent, humanizeId } from './format';
import { errorText } from './store';
import { S } from './strings';

const R = S.profile;
const P = S.personality;

/** The parts in the order the file and the dialog list them (keys of the exhaustive strings record). */
export const PROFILE_PART_ORDER = Object.keys(R.parts) as ProfilePart[];

export interface NoteView {
  text: string | null;
  tone: NoteTone;
}

/** Own keys only: codes come over IPC, so "constructor" must never hit the prototype. */
function own<T>(labels: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(labels, key) ? labels[key] : undefined;
}

export function exportNote(r: ProfileExportResponse): NoteView {
  switch (r.status) {
    case 'saved':
      return { text: R.exportDone(r.fileName), tone: 'ok' };
    case 'cancelled':
      return { text: R.exportCancelled, tone: 'info' };
    case 'busy':
      return { text: R.busy, tone: 'warn' };
    case 'unavailable':
      return { text: R.unavailable, tone: 'error' };
    default:
      return { text: R.exportFailed, tone: 'error' };
  }
}

/** The note for an open that did not produce a preview; a cancelled dialog says nothing. */
export function openNote(r: Exclude<ProfileOpenResponse, { status: 'ready' }>): NoteView {
  switch (r.status) {
    case 'cancelled':
      return { text: null, tone: 'info' };
    case 'busy':
      return { text: R.busy, tone: 'warn' };
    case 'unavailable':
      return { text: R.unavailable, tone: 'error' };
    default:
      return { text: own<string>(R.rejected, r.reason) ?? R.rejected.invalid, tone: 'error' };
  }
}

export function applyNote(r: ProfileApplyResponse): NoteView {
  if (r.ok) return { text: r.catReplaced ? R.importDone(r.name) : R.importDoneUpdated(r.name), tone: 'ok' };
  return { text: own<string>(R.applyFailed, r.reason) ?? R.applyFailed.failed, tone: r.reason === 'nothing-selected' ? 'warn' : 'error' };
}

/** The learned part loads with another cat only together with the cat part (resolveProfileParts). */
export function memoryAllowed(preview: Pick<ProfilePreview, 'parts' | 'sameCat'>, catChecked: boolean): boolean {
  return preview.parts.memory.available && (preview.sameCat || catChecked);
}

export interface PartView {
  part: ProfilePart;
  label: string;
  available: boolean;
  checked: boolean;
  disabled: boolean;
  hint: string;
}

export interface PreviewModel {
  title: string;
  /** Who the file is and where it comes from. */
  lines: string[];
  /** Notes under the part list (format, skipped values, kept-off opt-outs, what never changes). */
  notes: string[];
  parts: PartView[];
  /** One line per changed value, in part order ("Coat: Ginger → Grey"). */
  changes: string[];
}

// ---- field labels and values (preview details)

const SETTINGS_LABELS: Readonly<Record<string, string>> = {
  'general.catName': S.general.nameTitle,
  'appearance.skin': S.appearance.skinTitle,
  'appearance.style': S.appearance.styleTitle,
  'appearance.size': S.appearance.sizeTitle,
  'appearance.opacity': S.appearance.opacityTitle,
  'appearance.animationSpeed': S.appearance.animTitle,
  'appearance.shadow': S.appearance.shadowTitle,
  'appearance.emotes': S.appearance.emotesTitle,
  'sound.enabled': S.appearance.soundTitle,
  'sound.volume': S.appearance.volumeTitle,
  'behavior.movementSpeed': S.behavior.speedTitle,
  'behavior.autonomy': S.behavior.activityTitle,
  'behavior.cursorPlay': S.behavior.huntingTitle,
  'behavior.workDisruption': S.behavior.workTitle,
  'behavior.attentionSeeking': S.behavior.attentionTitle,
  'behavior.activitySensitivity': S.behavior.sensitivityTitle,
  'behavior.sleepAfterIdleMinutes': S.behavior.sleepTitle,
  'behavior.chaseDurationSec': S.behavior.chaseTitle,
  'behavior.reactToTyping': S.behavior.typingTitle,
  'behavior.reactToWindows': S.behavior.windowsTitle,
  'behavior.fullscreenBehavior': S.behavior.fullscreenTitle,
  'behavior.exploration': S.behavior.exploringTitle,
  'behavior.heights': S.behavior.heightsTitle,
  'behavior.mischief': S.behavior.mischiefTitle,
  'behavior.stayLength': S.behavior.staysTitle,
  'behavior.disabledBehaviors': S.behavior.groupBehaviors,
  'behavior.disabledExtras': S.behavior.groupExtras,
  'interaction.petting': S.interaction.pettingTitle,
  'interaction.dragging': S.interaction.draggingTitle,
  'interaction.throwing': S.interaction.throwingTitle,
  'interaction.patience': S.interaction.patienceTitle,
  'interaction.reactionIntensity': S.behavior.reactionsTitle,
};

const lastSegment = (field: string): string => field.slice(field.lastIndexOf('.') + 1);

export function changeLabel(c: Pick<ProfileChange, 'target' | 'field'>): string {
  const key = lastSegment(c.field);
  if (c.target === 'settings') return own(SETTINGS_LABELS, c.field) ?? humanizeId(key);
  if (c.field === 'bornAt') return R.fieldBornAt;
  if (c.field.startsWith('traits.')) return own<string>(P.traits, key) ?? humanizeId(key);
  if (c.field.startsWith('memory.counters.')) return own<string>(P.counters, key) ?? humanizeId(key);
  if (c.field.startsWith('memory.preferences.')) return own<string>(P.preferences, key) ?? humanizeId(key);
  if (c.field === 'stats.bond') return P.stats.bond;
  return humanizeId(key);
}

function dateText(epochMs: number): string {
  return Number.isFinite(epochMs) && Math.abs(epochMs) <= 8.64e15 ? new Date(epochMs).toISOString().slice(0, 10) : R.emptyValue;
}

export function changeValue(c: Pick<ProfileChange, 'target' | 'field'>, v: ProfileValue): string {
  if (v === null) return R.emptyValue;
  if (typeof v === 'boolean') return v ? S.common.on : S.common.off;
  if (Array.isArray(v)) return R.listValue(v.length);
  if (typeof v === 'string') {
    if (c.field === 'appearance.skin') return own<string>(S.appearance.skins, v) ?? humanizeId(v);
    if (c.field === 'appearance.style') return own<string>(S.appearance.styles, v) ?? humanizeId(v);
    if (c.field === 'behavior.fullscreenBehavior') return own<string>(S.behavior.fullscreen, v) ?? humanizeId(v);
    return c.field === 'general.catName' ? v : humanizeId(v);
  }
  if (typeof v !== 'number') return R.emptyValue;
  if (c.target === 'cat') {
    if (c.field === 'bornAt') return dateText(v);
    if (c.field.startsWith('traits.') || c.field === 'stats.bond' || c.field.endsWith('Acceptance')) return formatPercent(v);
    if (c.field.startsWith('memory.counters.')) return formatCount(v);
    return formatDecimal(v, 1);
  }
  return Number.isInteger(v) ? formatCount(v) : formatDecimal(v, 2);
}

/** Plain data for the confirmation dialog (no DOM: unit-tested). */
export function previewModel(preview: ProfilePreview): PreviewModel {
  const host = preview.fromHost === null ? null : (own<string>(PLATFORM_LABELS, preview.fromHost) ?? null);
  const date = preview.exportedAt === null ? null : preview.exportedAt.slice(0, 10);
  const lines = [
    preview.sameCat ? R.confirmSame(preview.incoming.name) : R.confirmReplace(preview.incoming.name, preview.current.name),
    R.savedWith(preview.fromVersion, host, date),
  ];
  const notes: string[] = [];
  if (preview.format.newerMinor) notes.push(R.newerMinor);
  if (preview.skipped.length > 0) notes.push(R.skipped(preview.skipped.length));
  if (preview.keptOff.length > 0) notes.push(R.keptOff);
  if (preview.memoryNeedsCat) notes.push(R.memoryNeedsCat);
  notes.push(R.notChanged);
  const parts = PROFILE_PART_ORDER.map((part): PartView => {
    const p = preview.parts[part];
    const available = p.available;
    // The cat, its look and the preferences start ticked; what it has learned only when asked for.
    const checked = available && part !== 'memory';
    const disabled = !available || (part === 'memory' && !memoryAllowed(preview, true));
    const hint = !available ? R.partMissing : p.changes === 0 ? R.partUnchanged : R.partChanges(p.changes);
    return { part, label: R.parts[part], available, checked, disabled, hint };
  });
  const changes = preview.changes.filter((c) => c.field !== 'catId').map((c) => R.changeLine(changeLabel(c), changeValue(c, c.from), changeValue(c, c.to)));
  return { title: R.confirmTitle(preview.incoming.name), lines, notes, parts, changes };
}

// ---- DOM

function showNote(el: HTMLElement, n: NoteView): void {
  setNote(el, n.text, n.tone);
}

/** The dialog body: who, where from, the part checkboxes, notes and the change list; selected() reads the ticks. */
export function previewBody(model: PreviewModel, preview: Pick<ProfilePreview, 'parts' | 'sameCat'>): { body: HTMLElement[]; selected(): ProfileParts } {
  const inputs = new Map<ProfilePart, HTMLInputElement>();
  const listLabel = uid('pp-label');
  const rows = model.parts.map((p) => {
    const hintId = uid('pp-hint');
    const input = h('input', { type: 'checkbox', 'aria-describedby': hintId });
    input.checked = p.checked;
    input.disabled = p.disabled;
    inputs.set(p.part, input);
    return h('label', { class: `check-row${p.disabled ? ' is-disabled' : ''}` }, [
      input,
      h('span', { class: 'check-text' }, [h('span', { class: 'check-label', text: p.label }), h('span', { class: 'check-hint', id: hintId, text: p.hint })]),
    ]);
  });
  const catInput = inputs.get('cat');
  const memoryInput = inputs.get('memory');
  const memoryRow = rows[PROFILE_PART_ORDER.indexOf('memory')];
  catInput?.addEventListener('change', () => {
    if (!memoryInput) return;
    const allowed = memoryAllowed(preview, catInput.checked);
    memoryInput.disabled = !allowed;
    if (!allowed) memoryInput.checked = false;
    memoryRow?.classList.toggle('is-disabled', !allowed);
  });
  const details =
    model.changes.length === 0
      ? h('p', { class: 'muted', text: R.noChanges })
      : h('details', { class: 'profile-changes' }, [
          h('summary', { text: R.detailsTitle }),
          h(
            'ul',
            { class: 'bullets' },
            model.changes.map((line) => h('li', { text: line })),
          ),
        ]);
  const body: HTMLElement[] = [
    ...model.lines.map((text) => h('p', { text })),
    h('p', { class: 'check-list-title', id: listLabel, text: R.choose }),
    h('div', { class: 'check-list', role: 'group', 'aria-labelledby': listLabel }, rows),
    ...model.notes.map((text) => h('p', { class: 'muted profile-note', text })),
    details,
  ];
  const ticked = (part: ProfilePart): boolean => {
    const el = inputs.get(part);
    return el !== undefined && el.checked && !el.disabled;
  };
  return {
    body,
    selected: () => ({ cat: ticked('cat'), appearance: ticked('appearance'), preferences: ticked('preferences'), memory: ticked('memory') }),
  };
}

async function runImport(ctx: PageContext, note: HTMLElement): Promise<void> {
  setNote(note, null);
  let opened: ProfileOpenResponse;
  try {
    opened = await ctx.api.openProfile();
  } catch (e) {
    setNote(note, S.errors.actionFailed(errorText(e)), 'error');
    return;
  }
  if (opened.status !== 'ready') {
    showNote(note, openNote(opened));
    return;
  }
  const model = previewModel(opened.preview);
  const view = previewBody(model, opened.preview);
  // Nothing is written before this confirmation; a cancel leaves everything as it is.
  if (!(await openDialog({ title: model.title, body: view.body, confirmLabel: R.confirmButton, tone: 'caution' }))) return;
  try {
    showNote(note, applyNote(await ctx.api.applyProfile(opened.token, view.selected())));
  } catch (e) {
    setNote(note, S.errors.actionFailed(errorText(e)), 'error');
  }
  try {
    await ctx.refresh();
  } catch {
    // The next broadcast from main brings the view up to date.
  }
}

/** The two rows of the group (personality.ts puts them before "Start over"). */
export function transferRows(ctx: PageContext): { exportRow: RowParts; importRow: RowParts } {
  const exp = row({ title: R.exportTitle, desc: R.exportDesc, icon: 'download', stacked: true });
  const memoryId = uid('pm');
  // UI state only (never a setting): off by default, so the file stays minimal.
  const memory = h('input', { type: 'checkbox', id: memoryId });
  memory.checked = false;
  const exportBtn = button(R.exportButton, { icon: 'download', describedBy: exp.describedBy });
  exp.control.append(
    h('div', { class: 'transfer-controls' }, [h('label', { class: 'check-row', for: memoryId }, [memory, h('span', { class: 'check-label', text: R.includeMemory })]), exportBtn]),
  );
  exportBtn.addEventListener('click', () => {
    void withBusy(exportBtn, async () => {
      try {
        showNote(exp.note, exportNote(await ctx.api.exportProfile({ includeMemory: memory.checked })));
      } catch (e) {
        setNote(exp.note, S.errors.actionFailed(errorText(e)), 'error');
      }
    });
  });

  const imp = row({ title: R.importTitle, desc: R.importDesc, icon: 'upload' });
  const importBtn = button(R.importButton, { icon: 'upload', describedBy: imp.describedBy });
  imp.control.append(importBtn);
  importBtn.addEventListener('click', () => {
    void withBusy(importBtn, () => runImport(ctx, imp.note));
  });
  return { exportRow: exp, importRow: imp };
}
