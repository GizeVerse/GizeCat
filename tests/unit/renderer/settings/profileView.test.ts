// 1.4.0 "Take your cat to another device" in the settings window (src/renderer/settings/profileView.ts):
// main's reason codes worded, the preview model (who, from where, which parts, what changes), the
// learned part tied to the cat part for another cat, and the macOS wording fixes on the Diagnostics
// and Behaviour pages. DOM-free: pure functions only. The previews are built with the real shared
// module. Written in the 1.4.0 mission, NOT executed there.
import { describe, expect, it } from 'vitest';
import { mulberry32, newPersistedCat } from '../../../../src/core/behavior';
import type { AppStatus } from '../../../../src/shared/ipc';
import { CAPABILITY_MATRIX, type PlatformReport, type RuntimeCapabilities } from '../../../../src/shared/platform';
import { buildProfile, previewImport, type ProfilePreview } from '../../../../src/shared/profileTransfer';
import { defaultSettings } from '../../../../src/shared/settings';
import { fullscreenRowNote } from '../../../../src/renderer/settings/pages/behavior';
import { loginItemRowLabel } from '../../../../src/renderer/settings/pages/diagnostics';
import { applyNote, changeLabel, changeValue, exportNote, memoryAllowed, openNote, previewModel, PROFILE_PART_ORDER } from '../../../../src/renderer/settings/profileView';
import { S } from '../../../../src/renderer/settings/strings';

const R = S.profile;
const WALL = 1_800_000_000_000;

function preview(opts: { sameCat?: boolean; memory?: boolean; skin?: 'gray' | 'ginger' } = {}): ProfilePreview {
  const here = defaultSettings();
  here.general.catName = 'Pamuk';
  const local = newPersistedCat(mulberry32(1), WALL - 86_400_000);
  const theirs = opts.sameCat ? local : newPersistedCat(mulberry32(2), WALL - 9 * 86_400_000);
  const s = defaultSettings();
  s.general.catName = 'Miso';
  s.appearance.skin = opts.skin ?? 'gray';
  const profile = buildProfile(s, theirs, { includeMemory: opts.memory ?? false, app: { version: '1.4.0', host: 'darwin' }, now: WALL });
  return previewImport(profile, here, local);
}

describe('reason codes in words', () => {
  it('export outcomes', () => {
    expect(exportNote({ status: 'saved', fileName: 'gizecat-miso.json' })).toEqual({ text: R.exportDone('gizecat-miso.json'), tone: 'ok' });
    expect(exportNote({ status: 'cancelled' }).tone).toBe('info');
    expect(exportNote({ status: 'busy' }).text).toBe(R.busy);
    expect(exportNote({ status: 'failed' }).text).toBe(R.exportFailed);
    expect(exportNote({ status: 'unavailable' }).text).toBe(R.unavailable);
  });

  it('open outcomes: a cancel says nothing; every rejection has its own text; unknown codes fall back', () => {
    expect(openNote({ status: 'cancelled' }).text).toBeNull();
    for (const reason of Object.keys(R.rejected) as Array<keyof typeof R.rejected>) expect(openNote({ status: 'rejected', reason }).text).toBe(R.rejected[reason]);
    expect(openNote({ status: 'rejected', reason: 'constructor' as never }).text).toBe(R.rejected.invalid);
  });

  it('apply outcomes: another cat arrives, the same cat is updated, failures are worded', () => {
    expect(applyNote({ ok: true, name: 'Miso', catReplaced: true, keptOff: [] }).text).toBe(R.importDone('Miso'));
    expect(applyNote({ ok: true, name: 'Miso', catReplaced: false, keptOff: [] }).text).toBe(R.importDoneUpdated('Miso'));
    expect(applyNote({ ok: false, reason: 'nothing-selected' }).tone).toBe('warn');
    for (const reason of Object.keys(R.applyFailed) as Array<keyof typeof R.applyFailed>) expect(applyNote({ ok: false, reason }).text).toBe(R.applyFailed[reason]);
  });

  it('never names the app "Desktop Cat"', () => {
    expect(JSON.stringify(R)).not.toContain('Desktop Cat');
    expect(R.groupTitle).toBe('Take your cat to another device');
  });
});

describe('preview model', () => {
  it('another cat: the replace warning, where it comes from, parts ticked except what it has learned', () => {
    const m = previewModel(preview());
    expect(m.title).toBe(R.confirmTitle('Miso'));
    expect(m.lines[0]).toBe(R.confirmReplace('Miso', 'Pamuk'));
    expect(m.lines[1]).toBe(R.savedWith('1.4.0', 'macOS', '2027-01-15'));
    expect(m.parts.map((p) => p.part)).toEqual(PROFILE_PART_ORDER);
    expect(PROFILE_PART_ORDER).toEqual(['cat', 'appearance', 'preferences', 'memory']);
    const byPart = Object.fromEntries(m.parts.map((p) => [p.part, p]));
    expect(byPart.cat!.checked).toBe(true);
    expect(byPart.memory!.checked).toBe(false);
    // No memory in this file.
    expect(byPart.memory!.disabled).toBe(true);
    expect(byPart.memory!.hint).toBe(R.partMissing);
    expect(m.notes.at(-1)).toBe(R.notChanged);
    // The coat change is listed in words; the catId never is.
    expect(m.changes).toContain(R.changeLine(S.appearance.skinTitle, S.appearance.skins.ginger, S.appearance.skins.gray));
    expect(m.changes.some((l) => l.includes('cat-'))).toBe(false);
  });

  it('the same cat: the "this is" line; what it has learned may load without the cat part', () => {
    const p = preview({ sameCat: true, memory: true });
    expect(p.sameCat).toBe(true);
    const m = previewModel(p);
    expect(m.lines[0]).toBe(R.confirmSame('Miso'));
    expect(memoryAllowed(p, false)).toBe(true);
  });

  it('another cat with memory: what it has learned loads only together with the cat part', () => {
    const p = preview({ memory: true });
    expect(p.memoryNeedsCat).toBe(true);
    expect(memoryAllowed(p, true)).toBe(true);
    expect(memoryAllowed(p, false)).toBe(false);
    expect(previewModel(p).notes).toContain(R.memoryNeedsCat);
  });

  it('labels and values: traits as percent, counters as counts, booleans On/Off, lists counted', () => {
    expect(changeLabel({ target: 'cat', field: 'traits.curiosity' })).toBe(S.personality.traits.curiosity);
    expect(changeLabel({ target: 'cat', field: 'memory.counters.pets' })).toBe(S.personality.counters.pets);
    expect(changeLabel({ target: 'cat', field: 'stats.bond' })).toBe(S.personality.stats.bond);
    expect(changeLabel({ target: 'settings', field: 'general.catName' })).toBe(S.general.nameTitle);
    expect(changeLabel({ target: 'settings', field: 'behavior.somethingNew' })).toBe('Something new');
    expect(changeValue({ target: 'cat', field: 'traits.curiosity' }, 0.6)).toBe('60%');
    expect(changeValue({ target: 'settings', field: 'appearance.shadow' }, true)).toBe(S.common.on);
    expect(changeValue({ target: 'settings', field: 'behavior.disabledBehaviors' }, ['tabStrips'])).toBe(R.listValue(1));
    expect(changeValue({ target: 'cat', field: 'bornAt' }, Date.UTC(2026, 10, 8))).toBe('2026-11-08');
    expect(changeValue({ target: 'settings', field: 'appearance.skin' }, 'constructor')).toBe('Constructor');
  });
});

function report(id: PlatformReport['id'], overrides: Partial<Record<keyof RuntimeCapabilities, { available: boolean; reason: string | null }>> = {}): Pick<AppStatus, 'platform'> {
  const capabilities = Object.fromEntries(Object.keys(CAPABILITY_MATRIX[id]).map((k) => [k, { available: false, reason: 'n/a' }])) as unknown as RuntimeCapabilities;
  return { platform: { id, label: id, capabilities: { ...capabilities, ...overrides } } };
}

describe('macOS wording (1.4.0)', () => {
  it('Diagnostics names the login row per platform; Windows keeps "Start with Windows"', () => {
    expect(loginItemRowLabel(undefined)).toBe('Start with Windows');
    expect(loginItemRowLabel(report('win32').platform)).toBe(S.diagnostics.launchAtLogin);
    expect(loginItemRowLabel(report('darwin').platform)).toBe('Open at login');
    expect(loginItemRowLabel(report('linux-x11').platform)).toBe('Start when you sign in');
  });

  it('the full-screen row explains macOS, shows main’s reason elsewhere, and says nothing on Windows', () => {
    expect(fullscreenRowNote({ platform: undefined })).toBeNull();
    expect(fullscreenRowNote(report('win32'))).toBeNull();
    expect(fullscreenRowNote(report('darwin'))).toBe(S.behavior.fullscreenNoteMac);
    expect(S.behavior.fullscreenNoteMac).toContain('full screen');
    expect(fullscreenRowNote(report('linux-x11', { fullscreenAware: { available: false, reason: 'Not on X11.' } }))).toBe('Not on X11.');
    expect(fullscreenRowNote(report('darwin', { fullscreenAware: { available: true, reason: null } }))).toBeNull();
  });
});
