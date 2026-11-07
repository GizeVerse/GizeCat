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
import type { ActivityPresetId } from '../shared/settingsPresets';
import type { InstallHint } from './hostMode';
import type { PersistenceState } from './storage';

const P = BRAND.product;

export type Place = 'browser' | 'app';

const here = (place: Place): string => (place === 'app' ? 'this app' : 'this browser');

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
    updateReady: `A new version of ${P} is ready. It starts the next time you open ${P}.`,
  },
  // Wired up later (profile export/import, src/shared/profileTransfer.ts).
  transfer: {
    title: 'Take your cat to another device',
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
    startOverFailed: 'Your cat could not be deleted: storage refused. Try again, or clear this site’s data in your browser settings.',
  },
  about: {
    title: 'About',
    text: `${P} is the first ${BRAND.platform} character.`,
    version: (v: string) => `Version ${v}`,
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
