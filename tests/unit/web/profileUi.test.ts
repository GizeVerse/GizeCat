// 1.4.0 "Take your cat to another device" in the web host (src/web/profileUi.ts), the DOM-free
// parts: the host id written into a file, the save outcomes in words, and the in-sheet preview
// model built from a real preview (src/shared/profileTransfer.ts). The DOM wiring is left to the web
// spec. Written in the 1.4.0 mission, NOT executed there.
import { describe, expect, it } from 'vitest';
import { mulberry32, newPersistedCat } from '../../../src/core/behavior';
import { buildProfile, IMPORT_NEVER_ENABLES, previewImport } from '../../../src/shared/profileTransfer';
import { defaultSettings } from '../../../src/shared/settings';
import type { HostMode } from '../../../src/web/hostMode';
import { changeLine, memoryAllowed, profileHostId, saveText, WEB_PROFILE_PARTS, webPreviewModel } from '../../../src/web/profileUi';
import { WS } from '../../../src/web/strings';

const T = WS.transfer;
const WALL = 1_800_000_000_000;
const BROWSER: HostMode = { kind: 'browser', standalone: false, apple: false, place: 'browser' };
const IPAD_APP: HostMode = { kind: 'browser', standalone: true, apple: true, place: 'app' };
const ANDROID: HostMode = { kind: 'android-app', standalone: true, apple: false, place: 'app' };

describe('web profile UI helpers', () => {
  it('names the host in the file: android, ios (an Apple touch device) or web', () => {
    expect(profileHostId(ANDROID)).toBe('android');
    expect(profileHostId(IPAD_APP)).toBe('ios');
    expect(profileHostId(BROWSER)).toBe('web');
  });

  it('words every save outcome; a browser download points at the downloads', () => {
    expect(saveText('saved', BROWSER)).toBe(T.saved);
    expect(saveText('saved', ANDROID)).toBe(T.savedApp);
    expect(saveText('shared', IPAD_APP)).toBe(T.shared);
    expect(saveText('cancelled', BROWSER)).toBe(T.cancelled);
    expect(saveText('busy', ANDROID)).toBe(T.busy);
    expect(saveText('failed', BROWSER)).toBe(T.saveFailed);
  });

  it('button names avoid the words the web spec finds toolbar buttons by', () => {
    for (const label of [T.saveButton, T.loadButton, T.confirm, T.cancel]) {
      for (const word of ['Pause', 'Resume', 'Call the cat', 'Sleep', 'Wake', 'Turn sound', 'Start over', 'Settings']) expect(label).not.toContain(word);
    }
  });

  it('the preview model: another cat replaces this one, the learned part needs the cat part', () => {
    const here = defaultSettings();
    here.general.catName = 'Pamuk';
    const local = newPersistedCat(mulberry32(1), WALL - 86_400_000);
    const s = defaultSettings();
    s.general.catName = 'Miso';
    s.appearance.skin = 'tuxedo';
    const theirs = newPersistedCat(mulberry32(2), WALL - 5 * 86_400_000);
    const p = previewImport(buildProfile(s, theirs, { includeMemory: true, app: { version: '1.4.0', host: 'win32' }, now: WALL }), here, local);
    const m = webPreviewModel(p);
    expect(m.title).toBe(T.confirmTitle('Miso'));
    expect(m.lines[0]).toBe(T.replace('Miso', 'Pamuk'));
    expect(m.lines[1]).toBe(T.savedWith('1.4.0', 'Windows 10/11', '2027-01-15'));
    expect(m.parts.map((x) => x.part)).toEqual(WEB_PROFILE_PARTS);
    const memory = m.parts.find((x) => x.part === 'memory')!;
    expect(memory.checked).toBe(false);
    expect(memory.disabled).toBe(false);
    expect(memoryAllowed(p, false)).toBe(false);
    expect(m.notes).toContain(T.memoryNeedsCat);
    expect(m.changes).toContain(`${WS.cat.coatLabel}: ${WS.skins.ginger} → ${WS.skins.tuxedo}`);
    expect(m.changes.some((l) => l.includes(theirs.catId))).toBe(false);
  });

  it('the kept-off note names only the opt-outs the import really kept off (SEC-2)', () => {
    const here = defaultSettings();
    here.behavior.disabledBehaviors = [];
    here.behavior.disabledExtras = ['terminalTabs'];
    const local = newPersistedCat(mulberry32(1), WALL - 86_400_000);
    const p = previewImport(buildProfile(defaultSettings(), local, { includeMemory: false, app: { version: '1.4.0', host: 'win32' }, now: WALL }), here, local);
    expect(p.keptOff).toEqual(['terminalTabs']);
    const notes = webPreviewModel(p).notes;
    expect(notes).toContain('Walking on terminal tabs stays off, because it is off here.');
    expect(notes.some((n) => n.includes('browser') || n.includes('File Explorer'))).toBe(false);
    expect(T.keptOff(['tabStrips', 'explorerTabs', 'terminalTabs'])).toBe('Walking on browser, File Explorer and terminal tabs stays off, because it is off here.');
    expect(T.keptOff(['tabStrips'])).toBe('Walking on browser tabs stays off, because it is off here.');
    expect(T.keptOff([])).toBeNull();
    for (const id of [...IMPORT_NEVER_ENABLES.disabledBehaviors, ...IMPORT_NEVER_ENABLES.disabledExtras]) expect(T.keptOff([id])).not.toBeNull();
  });

  it('change lines: booleans On/Off, traits as percent, lists counted, the name as written', () => {
    expect(changeLine({ field: 'appearance.shadow' }, true, false)).toBe('Shadow: On → Off');
    expect(changeLine({ field: 'traits.curiosity' }, 0.5, 0.75)).toBe('Curiosity: 50% → 75%');
    expect(changeLine({ field: 'behavior.disabledBehaviors' }, [], ['tabStrips'])).toBe('Disabled behaviors: 0 entries → 1 entry');
    expect(changeLine({ field: 'general.catName' }, 'Pamuk', 'Miso')).toBe(`${WS.cat.nameLabel}: Pamuk → Miso`);
  });

  it('never names the app "Desktop Cat"', () => {
    expect(JSON.stringify(T)).not.toContain('Desktop Cat');
  });
});
