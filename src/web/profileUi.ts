// "Take your cat to another device" in the web host's settings sheet (1.4.0): fills the sheet's
// transfer slot (settingsPanel.ts) with a save row ("Include what it has learned", off by default)
// and a load row. Loading reads a picked file (size checked first), parses it with the shared
// format (src/shared/profileTransfer.ts), shows in the sheet what would change with a checkbox per
// part, and changes nothing until the user confirms. Then the host commits (main.ts: storage, then a
// reload, the way "Start over" restarts the cat).
//
// Built with the desktop settings' CSP-safe h() helper (no innerHTML, no style attributes). No
// <form> and no keyboard listeners: buttons and checkboxes report clicks and changes only.
import type { PersistedCat } from '../shared/catState';
import { PLATFORM_LABELS, type PlatformId } from '../shared/platform';
import {
  applyProfile,
  MAX_PROFILE_BYTES,
  parseProfile,
  prepareProfileExport,
  PROFILE_FILE_EXTENSION,
  PROFILE_MIME,
  previewImport,
  type GizeProfile,
  type ProfileChange,
  type ProfilePart,
  type ProfileParts,
  type ProfilePreview,
  type ProfileValue,
} from '../shared/profileTransfer';
import type { Settings } from '../shared/settings';
import { h, uid } from '../renderer/settings/dom';
import type { HostMode } from './hostMode';
import { readPickedFile, type ProfileSaver, type SaveOutcome } from './profileFiles';
import { forceWebPrivacy } from './storage';
import { WS } from './strings';

const T = WS.transfer;

/** The parts in file and list order (keys of the exhaustive strings record). */
export const WEB_PROFILE_PARTS = Object.keys(T.parts) as ProfilePart[];

/** What the file says this host is (informational only): the Android app, an Apple touch device, or a browser. */
export function profileHostId(mode: HostMode): PlatformId {
  if (mode.kind === 'android-app') return 'android';
  return mode.apple ? 'ios' : 'web';
}

export function saveText(outcome: SaveOutcome, mode: HostMode): string {
  switch (outcome) {
    case 'saved':
      return mode.kind === 'android-app' ? T.savedApp : T.saved;
    case 'shared':
      return T.shared;
    case 'cancelled':
      return T.cancelled;
    case 'busy':
      return T.busy;
    default:
      return T.saveFailed;
  }
}

const own = <V>(labels: Readonly<Record<string, V>>, key: string): V | undefined => (Object.hasOwn(labels, key) ? labels[key] : undefined);

function humanize(id: string): string {
  const spaced = id
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return spaced.length === 0 ? id : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A short "Field: from → to" line (the web keeps it simple: the desktop words every field). */
export function changeLine(c: Pick<ProfileChange, 'field'>, from: ProfileValue, to: ProfileValue): string {
  const key = c.field.slice(c.field.lastIndexOf('.') + 1);
  const label = c.field === 'general.catName' ? WS.cat.nameLabel : c.field === 'appearance.skin' ? WS.cat.coatLabel : c.field === 'appearance.style' ? WS.cat.styleLabel : humanize(key);
  const value = (v: ProfileValue): string => {
    if (v === null) return '—';
    if (typeof v === 'boolean') return v ? 'On' : 'Off';
    if (Array.isArray(v)) return `${v.length} ${v.length === 1 ? 'entry' : 'entries'}`;
    if (typeof v === 'string') {
      if (c.field === 'appearance.skin') return own<string>(WS.skins, v) ?? humanize(v);
      if (c.field === 'appearance.style') return own<string>(WS.styles, v) ?? humanize(v);
      return c.field === 'general.catName' ? v : humanize(v);
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    if (c.field === 'bornAt') return Math.abs(v) <= 8.64e15 ? new Date(v).toISOString().slice(0, 10) : '—';
    if (c.field.startsWith('traits.') || c.field === 'stats.bond' || c.field.endsWith('Acceptance')) return `${Math.round(v * 100)}%`;
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  };
  return `${label}: ${value(from)} → ${value(to)}`;
}

export interface WebPartView {
  part: ProfilePart;
  label: string;
  checked: boolean;
  disabled: boolean;
  hint: string;
}

export interface WebPreviewModel {
  title: string;
  lines: string[];
  notes: string[];
  parts: WebPartView[];
  changes: string[];
}

/** The learned part loads with another cat only together with the cat part (resolveProfileParts). */
export function memoryAllowed(preview: Pick<ProfilePreview, 'parts' | 'sameCat'>, catChecked: boolean): boolean {
  return preview.parts.memory.available && (preview.sameCat || catChecked);
}

/** Plain data for the in-sheet confirmation (no DOM: unit-tested). */
export function webPreviewModel(preview: ProfilePreview): WebPreviewModel {
  const host = preview.fromHost === null ? null : (own<string>(PLATFORM_LABELS, preview.fromHost) ?? null);
  const lines = [
    preview.sameCat ? T.same(preview.incoming.name) : T.replace(preview.incoming.name, preview.current.name),
    T.savedWith(preview.fromVersion, host, preview.exportedAt === null ? null : preview.exportedAt.slice(0, 10)),
  ];
  const notes: string[] = [];
  if (preview.format.newerMinor) notes.push(T.newerMinor);
  if (preview.skipped.length > 0) notes.push(T.skipped(preview.skipped.length));
  if (preview.keptOff.length > 0) notes.push(T.keptOff);
  if (preview.memoryNeedsCat) notes.push(T.memoryNeedsCat);
  notes.push(T.notChanged);
  const parts = WEB_PROFILE_PARTS.map((part): WebPartView => {
    const p = preview.parts[part];
    return {
      part,
      label: T.parts[part],
      checked: p.available && part !== 'memory',
      disabled: !p.available || (part === 'memory' && !memoryAllowed(preview, true)),
      hint: !p.available ? T.partMissing : p.changes === 0 ? T.partUnchanged : T.partChanges(p.changes),
    };
  });
  const changes = preview.changes.filter((c) => c.field !== 'catId').map((c) => changeLine(c, c.from, c.to));
  return { title: T.confirmTitle(preview.incoming.name), lines, notes, parts, changes };
}

export interface ProfileUiDeps {
  /** The sheet's empty transfer container (SettingsPanel.transferSlot). */
  slot: HTMLElement;
  mode: HostMode;
  getSettings: () => Settings;
  /** The live cat (sim.serialize()). */
  getCat: () => PersistedCat;
  /** How files are saved here; null shows no save row (the Android app without its bridge). */
  saver: ProfileSaver | null;
  appVersion: string;
  /** Epoch ms. */
  now: () => number;
  /**
   * Keeps the loaded settings and cat and restarts the cat (main.ts: storage, then a reload, as
   * "Start over" does). False when this device refused to store them; nothing changed then.
   */
  commit: (settings: Settings, cat: PersistedCat) => boolean;
}

export interface ProfileUi {
  /** Forgets a shown preview (nothing was applied). */
  reset(): void;
}

export function createProfileUi(deps: ProfileUiDeps): ProfileUi {
  const status = h('p', { class: 'note', 'aria-live': 'polite' });
  const say = (text: string): void => {
    status.textContent = text;
  };

  // ---- save
  const memoryId = uid('profile-memory');
  const memory = h('input', { type: 'checkbox', id: memoryId });
  memory.checked = false;
  const saveBtn = h('button', { type: 'button', text: T.saveButton });
  saveBtn.addEventListener('click', () => {
    const saver = deps.saver;
    if (!saver) return;
    say('');
    const prepared = prepareProfileExport(deps.getSettings(), deps.getCat(), {
      includeMemory: memory.checked,
      app: { version: deps.appVersion, host: profileHostId(deps.mode) },
      now: deps.now(),
    });
    if (!prepared.ok) {
      say(T.exportFailed);
      return;
    }
    // Synchronous up to here: the share sheet (installed app on an iPad) needs this click's gesture.
    saveBtn.disabled = true;
    void saver
      .save(prepared.fileName, prepared.text)
      .then((outcome) => say(saveText(outcome, deps.mode)))
      .catch(() => say(T.saveFailed))
      .finally(() => {
        saveBtn.disabled = false;
      });
  });

  // ---- load: a file input the Load button clicks; nothing is read before the user picks a file
  const input = h('input', { type: 'file', accept: `.${PROFILE_FILE_EXTENSION},${PROFILE_MIME}`, hidden: true, tabindex: -1, 'aria-hidden': 'true' });
  const loadBtn = h('button', { type: 'button', text: T.loadButton });
  loadBtn.addEventListener('click', () => {
    say('');
    // The same file can be picked again after a cancel.
    input.value = '';
    input.click();
  });

  // ---- preview (in the sheet, like Start over's confirmation)
  const previewTitleId = uid('profile-preview-title');
  const preview = h('div', { class: 'transfer-preview', role: 'group', 'aria-labelledby': previewTitleId });
  preview.hidden = true;
  let pending: { profile: GizeProfile; preview: ProfilePreview; inputs: Map<ProfilePart, HTMLInputElement> } | null = null;

  function hidePreview(): void {
    pending = null;
    preview.hidden = true;
    preview.replaceChildren();
  }

  function showPreview(profile: GizeProfile, p: ProfilePreview): void {
    const model = webPreviewModel(p);
    const inputs = new Map<ProfilePart, HTMLInputElement>();
    const rows = model.parts.map((part) => {
      const hintId = uid('profile-part-hint');
      const box = h('input', { type: 'checkbox', 'aria-describedby': hintId });
      box.checked = part.checked;
      box.disabled = part.disabled;
      inputs.set(part.part, box);
      return h('label', { class: 'check-row' }, [box, h('span', {}, [h('span', { class: 'check-label', text: part.label }), h('span', { class: 'note check-hint', id: hintId, text: part.hint })])]);
    });
    const catBox = inputs.get('cat');
    const memoryBox = inputs.get('memory');
    catBox?.addEventListener('change', () => {
      if (!memoryBox) return;
      const allowed = memoryAllowed(p, catBox.checked);
      memoryBox.disabled = !allowed;
      if (!allowed) memoryBox.checked = false;
    });
    const confirmBtn = h('button', { type: 'button', class: 'primary', text: T.confirm });
    const cancelBtn = h('button', { type: 'button', text: T.cancel });
    confirmBtn.addEventListener('click', () => confirm());
    cancelBtn.addEventListener('click', () => {
      hidePreview();
      loadBtn.focus();
    });
    const title = h('h4', { id: previewTitleId, tabindex: -1, text: model.title });
    preview.replaceChildren(
      title,
      ...model.lines.map((text) => h('p', { text })),
      h('p', { class: 'legend', text: T.choose }),
      h('div', { class: 'check-list' }, rows),
      ...model.notes.map((text) => h('p', { class: 'note', text })),
      model.changes.length === 0
        ? h('p', { class: 'note', text: T.noChanges })
        : h('details', { class: 'transfer-changes' }, [h('summary', { text: T.detailsTitle(model.changes.length) }), h('ul', {}, model.changes.map((line) => h('li', { text: line })))]),
      h('div', { class: 'actions' }, [confirmBtn, cancelBtn]),
    );
    pending = { profile, preview: p, inputs };
    preview.hidden = false;
    title.focus();
  }

  function selected(inputs: Map<ProfilePart, HTMLInputElement>): ProfileParts {
    const on = (part: ProfilePart): boolean => {
      const el = inputs.get(part);
      return el !== undefined && el.checked && !el.disabled;
    };
    return { cat: on('cat'), appearance: on('appearance'), preferences: on('preferences'), memory: on('memory') };
  }

  function confirm(): void {
    const p = pending;
    if (!p) return;
    // Computed now, from the live cat and settings: the cat lived on while the preview was open.
    const result = applyProfile(p.profile, selected(p.inputs), deps.getSettings(), deps.getCat(), { now: deps.now() });
    if (!result.ok) {
      say(result.reason === 'nothing-selected' ? T.nothingSelected : T.applyFailed);
      return;
    }
    // applyProfile never touches screen analysis or AI; the web forces them off anyway.
    if (!deps.commit(forceWebPrivacy(result.settings), result.catState)) {
      say(T.storageFailed);
      return;
    }
    hidePreview();
  }

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    hidePreview();
    void readPickedFile(file, MAX_PROFILE_BYTES).then((read) => {
      input.value = '';
      if (!read.ok) {
        say(T.rejected[read.reason]);
        return;
      }
      const parsed = parseProfile(read.text);
      if (!parsed.ok) {
        say(own<string>(T.rejected, parsed.reason) ?? T.rejected.invalid);
        return;
      }
      showPreview(parsed.profile, previewImport(parsed.profile, deps.getSettings(), deps.getCat(), parsed));
    });
  });

  const memoryRow = h('label', { class: 'check-row', for: memoryId }, [memory, h('span', { class: 'check-label', text: T.includeMemory })]);
  const saveActions = h('div', { class: 'actions' }, [saveBtn]);
  memoryRow.hidden = deps.saver === null;
  saveActions.hidden = deps.saver === null;
  deps.slot.replaceChildren(
    h('p', { class: 'note', text: T.desc }),
    memoryRow,
    saveActions,
    h('div', { class: 'actions' }, [loadBtn]),
    input,
    status,
    preview,
  );

  return {
    reset() {
      hidePreview();
      say('');
    },
  };
}
