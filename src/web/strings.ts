// Every user-visible string of the web host (1.4.0), so the page can be localised later without
// touching its code. The coat, drawing style and personality labels are the desktop's own
// (src/renderer/settings/strings.ts), copied rather than imported to keep the desktop settings
// strings (and what they import) out of the web bundle; tests/unit/web/strings.test.ts asserts
// they stay equal.
//
// `place` is where the cat lives: 'browser' in a browser tab, 'app' in the installed web app or the
// Android app. Wording never promises what was not observed on a device.
import { BRAND } from '../shared/brand';
import type { RenderStyle, SkinId } from '../shared/cat';
import type { ProfilePart, ProfileRejectReason } from '../shared/profileTransfer';
import type { BehaviorId } from '../shared/settings';
import type { ActivityPresetId } from '../shared/settingsPresets';
import type { InstallHint } from './hostMode';
import type { PersistenceState } from './storage';
import type { OfflineState } from './swRegister';

const P = BRAND.product;

export type Place = 'browser' | 'app';

const here = (place: Place): string => (place === 'app' ? 'this app' : 'this browser');

/** "A", "A and B", "A, B and C". */
const listText = (items: readonly string[]): string => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.slice(-1).join('')}`);
/** The tab-strip opt-outs an import keeps off (IMPORT_NEVER_ENABLES in shared/profileTransfer.ts), in sentence order. */
const KEPT_OFF_TABS: ReadonlyArray<readonly [BehaviorId, string]> = [
  ['tabStrips', 'browser'],
  ['explorerTabs', 'File Explorer'],
  ['terminalTabs', 'terminal'],
];

export const WS = {
  toolbar: {
    call: 'Call the cat',
    sleep: 'Sleep',
    wake: 'Wake',
    pause: 'Pause',
    resume: 'Resume',
    soundOn: 'Turn sound on',
    soundOff: 'Turn sound off',
    settings: 'Settings',
  },
  sheet: {
    title: 'Settings',
    close: 'Close',
  },
  cat: {
    title: 'Your cat',
    nameLabel: 'Name',
    nameHint: '1 to 24 characters.',
    nameInvalid: 'Use 1 to 24 characters. The old name is kept.',
    coatLabel: 'Coat',
    styleLabel: 'Drawing style',
    sizeLabel: 'Size',
    shadowLabel: 'Shadow',
    emotesLabel: 'Emotes (hearts, Zzz and other bubbles)',
  },
  personality: {
    title: 'Personality',
    desc: 'How lively your cat is.',
  },
  sound: {
    title: 'Sound',
    enabledLabel: 'Cat sounds',
    desc: `Soft, synthesized meows, chirps and purrs, made on this device (no recordings, never the microphone). Your device's volume and silent mode apply.`,
    volumeLabel: 'Volume',
    volumeNeedsSound: 'Turn on Cat sounds to hear it.',
  },
  // The floating cat (Android app only, 1.4.0 preview 2; floatingUi.ts). Wording promises nothing
  // that was not observed on a device.
  floating: {
    start: 'Float over apps',
    pause: 'Pause floating cat',
    resume: 'Resume floating cat',
    hide: 'Hide floating cat',
    show: 'Show floating cat',
    stop: 'Stop floating cat',
    askTitle: 'Let your cat walk over other apps',
    askText: [
      `${P} needs Android's "Display over other apps" permission to draw the cat on top of your launcher and other apps. Without it the cat can only live inside this app, which keeps working normally.`,
      `${P} uses it only to draw the cat. It does not read what is on your screen, does not record anything and never touches the network. The cat takes touches only where it is drawn, and a small area around it.`,
      `Android will open its own settings page. Turn on ${P} there, then come back. You can turn it off again at any time.`,
    ],
    askOpen: 'Open Android settings',
    askLater: 'Not now',
    running: (name: string) => `${name} is floating over your apps. Use these buttons, or the notification, to pause, hide or stop it.`,
    runningPaused: (name: string) => `${name} is paused where it stands.`,
    runningHidden: (name: string) => `${name} is hidden. Show it again with Show floating cat.`,
    idleDenied: 'The floating cat stays off: Android has not allowed drawing over other apps. The cat still lives in this app.',
    noNotifications: 'Notifications are off for this app, so the floating cat can only be controlled from this screen.',
    stopped: {
      none: '',
      user: '',
      'permission-missing': 'The floating cat did not start: "Display over other apps" is not allowed for this app.',
      'permission-revoked': 'The floating cat stopped because Android took away the permission to draw over other apps.',
      'renderer-failed': 'The floating cat stopped because its drawing kept failing. Starting it again may help.',
      system: 'Android ended the floating cat. Start it again when you like.',
    },
  },
  help: {
    title: 'How to play',
    text: [
      'Stroke the cat back and forth to pet it. Tap it to say hello.',
      'Press and hold it for a moment, then drag to pick it up; let go to drop it, or flick to throw it.',
      'Everything else on the screen keeps working: only the cat itself takes your touches.',
    ],
  },
  install: {
    title: 'Install',
    installed: `${P} is running as an installed app.`,
    promptButton: `Install ${P}`,
    promptDesc: `Adds ${P} to your home screen or app list, so it opens in its own window and starts without a network connection.`,
    apple: `To install ${P}: tap Share, then Add to Home Screen. It then opens in its own window and starts without a network connection.`,
    appleStorage:
      'A Home Screen app may keep its own storage, separate from Safari, so a cat met in a Safari tab may not come along. Install first, then meet your cat.',
    menu: `To install ${P}, use your browser's menu: Install app, or Add to Home screen.`,
    evictionNote: `Safari may clear ${P} and your cat after 7 days without a visit. Add it to your Home Screen to keep it.`,
  },
  storage: {
    title: 'Your cat on this device',
    unavailable: (place: Place) => `${place === 'app' ? 'This app' : 'This browser'} does not allow storage here: your cat will not be remembered after you close it.`,
    androidApp: `Your cat and its settings are saved in this app's private storage on this device. Uninstalling the app, or clearing its data, deletes them.`,
    status: (place: Place, persistence: PersistenceState | null) => {
      const base = `Your cat and its settings are saved in ${here(place)}'s storage on this device, nowhere else.`;
      if (persistence === 'persisted') return `${base} ${place === 'app' ? 'The system' : 'The browser'} has agreed to keep them.`;
      if (persistence === 'best-effort') return `${base} ${place === 'app' ? 'The system' : 'The browser'} may clear them if space runs low.`;
      return base;
    },
  },
  // The sheet's line about the offline copy, one per service worker state (swRegister.ts). Not
  // shown in the Android app, whose files are inside the app itself.
  offline: {
    unavailable: `${P} cannot keep an offline copy here, so it needs a connection to start.`,
    preparing: `Getting ${P} ready to work offline.`,
    ready: `Ready to work offline: ${P} can start without a connection.`,
    'update-ready': `A new version of ${P} is ready. Close ${P} and open it again to start it.`,
    failed: `${P} could not save an offline copy. It keeps working while it is open, but it needs a connection to start again.`,
  } satisfies Record<OfflineState, string>,
  // Profile export/import (profileUi.ts, src/shared/profileTransfer.ts). Button names avoid the
  // words the web spec finds the toolbar buttons by (Pause, Resume, Call the cat, Sleep, Wake, Turn sound).
  transfer: {
    title: 'Take your cat to another device',
    desc: `Save ${P} to a file and load it on another computer, an iPad or an Android tablet. Nothing is uploaded and there is no account: the file goes only where you put it. It is a copy, not a sync.`,
    includeMemory: 'Include what it has learned (counters, learned habits and bond)',
    saveButton: 'Save my cat to a file',
    loadButton: 'Load a cat from a file',
    saved: 'Saved. Find the file in your downloads.',
    savedApp: 'Saved.',
    shared: 'Handed over to the share sheet.',
    cancelled: 'Nothing was saved.',
    busy: 'A save window is already open.',
    saveFailed: 'The file could not be saved.',
    exportFailed: 'Your cat could not be written to a file.',
    confirmTitle: (name: string) => `Load ${name}?`,
    replace: (incoming: string, current: string) =>
      `${incoming} is a different cat. Loading it replaces ${current} on this device: ${current}’s mood, memories and what it has learned here are cleared. This cannot be undone.`,
    same: (name: string) => `This is ${name}, saved on another device. The values you choose replace the ones here.`,
    savedWith: (version: string | null, host: string | null, date: string | null) =>
      `Saved with ${P}${version ? ` ${version}` : ''}${host ? ` on ${host}` : ''}${date ? `, ${date}` : ''}.`,
    newerMinor: `It was saved by a newer ${P}; a few details may not load.`,
    choose: 'What to load',
    parts: {
      cat: 'Name, age and personality',
      appearance: 'Look (coat, style, size and effects)',
      preferences: 'Behaviour, handling and sound preferences',
      memory: 'What it has learned (counters, learned habits and bond)',
    } satisfies Record<ProfilePart, string>,
    partChanges: (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`,
    partUnchanged: 'Same as now',
    partMissing: 'Not in this file',
    detailsTitle: (n: number) => `What changes (${n})`,
    noChanges: 'Nothing in this file differs from what is here now.',
    memoryNeedsCat: 'What it has learned can only be loaded together with the cat itself.',
    skipped: (n: number) => `${n} ${n === 1 ? 'value was' : 'values were'} not recognised and stay as they are here.`,
    /** Names only the opt-outs the import really kept off (the preview's keptOff); null when none is one of them. */
    keptOff: (ids: readonly BehaviorId[]): string | null => {
      const names = KEPT_OFF_TABS.filter(([id]) => ids.includes(id)).map(([, name]) => name);
      return names.length === 0 ? null : `Walking on ${listText(names)} tabs stays off, because it is off here.`;
    },
    notChanged: 'Never changed by a file: screen analysis and AI (off on this device), startup, shortcuts and other choices that belong to one device.',
    confirm: 'Load',
    cancel: 'Keep things as they are',
    applyFailed: 'Nothing was changed: the profile could not be applied.',
    storageFailed: 'Nothing was changed: this device refused to store the cat.',
    nothingSelected: 'Choose at least one thing to load.',
    rejected: {
      'too-large': `This file is too large to be a ${P} profile.`,
      'not-json': `This file is not a ${P} profile.`,
      'not-a-profile': `This file is not a ${P} profile.`,
      'newer-format': `This profile was saved by a newer ${P}. Update ${P} on this device, then try again.`,
      'unsupported-format': 'This profile format is not supported.',
      'other-character': `This file holds a different ${BRAND.platform} character, which this version cannot load.`,
      invalid: 'This profile is damaged or was edited by hand, so it cannot be loaded.',
      unreadable: 'The file could not be read.',
    } satisfies Record<ProfileRejectReason | 'unreadable', string>,
  },
  privacy: {
    title: 'Privacy',
    text: (place: Place) => [
      `${P} needs no account and has no ads, analytics or telemetry. It never listens to your keyboard and never sees your screen.`,
      place === 'app'
        ? `The page itself cannot make network requests. ${P} only loads its own files.`
        : `The page itself cannot make network requests. The only traffic is your browser loading ${P}'s own files from this site: when you open it, once per version to keep an offline copy, and the browser's own update checks.`,
      `Your cat lives only in ${here(place)} on this device. Nothing about it is ever sent anywhere.`,
    ],
  },
  reset: {
    title: 'Start again',
    resetSettings: 'Reset settings',
    resetSettingsDesc: 'Puts every setting back to its default. Your cat stays.',
    resetDone: 'Settings reset.',
    startOver: 'Start over with a new cat',
    startOverDesc: 'Your cat and everything it remembers are deleted from this device, and a new cat arrives.',
    startOverConfirm: 'Delete my cat and start over',
    startOverCancel: 'Keep my cat',
    startOverAsk: 'This cannot be undone. Delete your cat?',
    startOverFailed: 'Your cat could not be deleted: storage refused, or the floating cat is running (stop it first). Try again, or clear this site’s data in your browser settings.',
  },
  about: {
    title: 'About',
    text: `${P} is the first ${BRAND.platform} character.`,
    version: (v: string) => `Version ${v}`,
    privacy: 'Privacy statement',
    licenses: 'Third-party notices',
  },
  status: {
    noScript: 'The cat needs JavaScript to live here.',
  },
  // ---- labels shared with the desktop settings (keep equal: tests/unit/web/strings.test.ts)
  skins: {
    ginger: 'Ginger',
    gray: 'Grey',
    black: 'Black',
    tuxedo: 'Tuxedo',
    calico: 'Calico',
    siamese: 'Siamese',
    cream: 'Cream',
  } satisfies Record<SkinId, string>,
  styles: { smooth: 'Smooth', pixel: 'Pixel' } satisfies Record<RenderStyle, string>,
  presets: {
    calm: { title: 'Calm', desc: 'Rests and watches a lot, with short, gentle bursts of play.' },
    playful: { title: 'Playful', desc: 'Explores, climbs and hunts your pointer now and then. The default.' },
    mischievous: { title: 'Mischievous', desc: 'Always up to something: long trips, bold jumps, cheeky ambushes.' },
  } satisfies Record<ActivityPresetId, { title: string; desc: string }>,
} as const;

/** The install section's text for a hint (the button label for 'prompt'); null shows no section. */
export function installText(hint: InstallHint): string | null {
  switch (hint) {
    case 'none':
      return null;
    case 'installed':
      return WS.install.installed;
    case 'prompt':
      return WS.install.promptDesc;
    case 'apple':
      return WS.install.apple;
    case 'menu':
      return WS.install.menu;
  }
}
