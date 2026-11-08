# GizeCat web host: report

Branch `feat/gizeverse-foundation`, code at `d97c36f`. Design: [ADR 0004 §8](../adr/0004-gizeverse-platform.md). Evidence: [evidence-web-e2e.txt](evidence-web-e2e.txt).

The 1.4.0 section below describes the installable tablet web app. The sections after it are the 1.3.0 report, kept as it was: its results are for the 1.3.0 code.

## 1.4.0: the installable tablet web app

Status: release candidate, branch `release/1.4.0-universal-devices`. Statuses use the 1.4.0 vocabulary ([docs/platforms/README.md](../platforms/README.md#status-vocabulary-for-140)). **Nothing in this section has run in a browser or on a device.** The 1.4.0 unit and Playwright tests are written and were not executed. User guides: [ipados.md](../platforms/ipados.md), [android.md](../platforms/android.md#the-web-app-in-chrome).

| What | Status |
|---|---|
| PWA code: manifest, icons, service worker, settings sheet, host modes, safe areas, audio unlock, Start over, persistence request | IMPLEMENTED |
| `out/web` production bundle; `release/1.4.0/web/` (folder, zip, `README-web.txt`, `SHA256SUMS.txt`) | COMPILED_OR_PACKAGED |
| iPadOS Safari tab and Home Screen app; Android Chrome tab and installed app; desktop Chrome and Edge install and offline start | THEORETICALLY_COMPATIBLE_NOT_EXECUTED |
| The same bundle inside the Android app (`android-app` host mode) | THEORETICALLY_COMPATIBLE_NOT_EXECUTED |
| Public HTTPS hosting (`pages.yml` or any host) | REQUIRES_OWNER_CREDENTIALS |
| The cat over other apps, from any web app | BLOCKED_BY_PLATFORM |
| Profile export and import in the sheet ("Take your cat to another device": a download, the share sheet in the installed iPad app, or the Android bridge; a picked file to load) | IMPLEMENTED; THEORETICALLY_COMPATIBLE_NOT_EXECUTED |

**What changed.**
- **Manifest** (`src/web/manifest.webmanifest`): relative `start_url` and `scope` (`./`), so any host path works; `display: standalone`; `orientation: any`; cream theme colours; 192 and 512 px icons, plain and maskable. The icons are generated from `build/icon.png` by `scripts/web-icons.mjs` (pure Node, no new dependency).
- **Service worker** (`src/web/sw.ts`, hand-written, no Workbox): it precaches every shell file at install (`cache: 'reload'`), serves navigations from the cached `index.html` and shell files cache-first, and passes everything else through. It handles only GET requests to the same origin inside its scope. Its cache is `gizecat-shell-<version>-<hash>`, where the hash covers the file paths and bytes; activation deletes only older `gizecat-shell-*` caches. There is no runtime caching, no messaging and no forced reload: a new version starts at the next launch, and the sheet says when one is ready. It is not registered in the Android app (origin `https://appassets.androidplatform.net`), on `file://`, or in a development build.
- **CSP** (meta tag; `scripts/web-csp.mjs` is the single source): `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; manifest-src 'self'; worker-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`. `data:` images are no longer allowed. Where headers can be set, `sw.js` gets `default-src 'none'; connect-src 'self'` so that it can cache the app's own files. GitHub Pages sends no custom headers, so there the policy is the meta tag only, without `frame-ancestors` ([THREAT_MODEL.md](../THREAT_MODEL.md), T18 and T19).
- **Layout for tablets:** a fixed toolbar (Call, Sleep or Wake, Pause, Sound, Settings) in which only the buttons take touches; `100dvh`; touch CSS (no tap highlight, no callout, no overscroll); the safe-area insets read from a hidden probe element, with the floor above the home indicator or gesture bar; the layout viewport (`documentElement.clientWidth/clientHeight`) for both the world and the canvas, so pinch zoom and the on-screen keyboard do not move the floor. The cat is blocked while the sheet is open or the page is pinch-zoomed.
- **Settings sheet:** a native `<dialog>` (bottom sheet on narrow screens, side sheet from 700 px): name, coat, drawing style, size, shadow, emotes, personality preset, sound, install hint, storage status, how to play, privacy, reset settings, start over, about. Built without `innerHTML` or style attributes. Escape closes it natively; there is no key listener.
- **Settings model:** an allow-list of web settings is applied through the desktop's own `applySettingsPatch`, then the web privacy floor. Personality is stored only as an exact named preset.
- **Sound:** one shared AudioContext, unlocked inside a tap.
- **Storage:** the same keys and format v1 (`gizecat.web.cat.v1`, `gizecat.web.settings.v1`), now also holding the personality values. The installed web app asks for persistent storage (`navigator.storage.persist()`); a browser tab only reads whether storage is persisted. Start over clears both keys and freezes the store before reloading, so the page cannot write the old cat back.
- **Packaging:** `npm run package:web` writes `release/<version>/web/`: the folder, a deterministic zip, `README-web.txt` (hosting, headers, install, privacy) and `SHA256SUMS.txt`. The build fails unless the file set is exact, no file contains test-hook or key-listener code, the CSP meta equals the pinned policy, and the precache list equals the files on disk.
- **Hosting:** `.github/workflows/pages.yml` (manual only, never run) publishes `out/web` to GitHub Pages once the owner enables it.

**Network, precisely.** The page itself can make no requests (`connect-src 'none'`). The only traffic is same-origin GETs of the app's own static files: on first load, once per version when the service worker caches them, and the browser's own update checks of `sw.js` and the manifest. No page data is ever sent. This replaces the 1.3.0 wording "no network after load".

**Known limits.**
- Device behaviour never observed: audio unlock, safe-area values, the viewport under pinch zoom and the keyboard, Home Screen storage separation on iPadOS, `orientation: any` against Android's rotation lock, Split View and Stage Manager widths, Android back closing the dialog.
- The first visit downloads the shell twice (the page, then the service worker's copy); `main.js` is about 0.9 MB.
- The iPad detection that picks the install hint is a heuristic; it only affects which hint is shown.
- No service-worker kill switch ships. If one is ever needed, deploy an `sw.js` that unregisters itself and deletes `gizecat-shell-*`.
- The sheet has no DOM unit tests (the repository has no DOM emulation library by design); only the unrun Playwright tests cover it.
- `playwright.web.config.mts` adds `tablet-ipad-emulated` (an iPad descriptor in Chrome, not WebKit) and `tablet-android-emulated` projects. Both would be SIMULATED; neither has run.

## What it is

The real character in a browser page:
- **Shared code.** The same `createCatSim`, `createCatHost`, overlay renderer (`OverlayRuntime`) and gesture recognizer as the desktop app. Nothing is copied or forked.
- **Host.** It runs in one logical display, the viewport, on the floor of the page. The window tracker is unavailable; activity comes from page pointer events, with no typing inference.
- **Input.** Pointer routing happens at the document in the capture phase.
  - The page stays usable outside the cat's hit region.
  - A press on the cat belongs to the cat, and its click is suppressed. Keyboard clicks always reach the page.
  - Touch is translated into the recognizer's mouse vocabulary, so the desktop's gesture rules are unchanged:
    - a tap is a click;
    - a stroke pets;
    - a hold of at least 350 ms followed by a move drags;
    - a fling throws.
- **Persistence.** localStorage (`gizecat.web.cat.v1`, `gizecat.web.settings.v1`), validated with the desktop's own migrations. Corrupt or blocked storage gives a fresh cat, never a crash.
- **Hidden tab.** The host is suspended: the cat naps and wakes when the tab is shown again. This is not a user pause.
- **Security.**
  - CSP: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`, in a meta tag, and as a header from the dev server.
  - Zod runs `jitless`: its JIT probe (`new Function`) violated the CSP, which the E2E test caught.
  - No network after load and no key listeners. ESLint bans the key-event literals in `src/web`, and the production build fails if `out/web` contains them or the test hook.
  - No HTML sinks (`innerHTML`, `eval`) and no network APIs in `src/web` (grep, REAL).
- **Build.**
  - `npm run build` also writes `out/web`.
  - `npm run build:web` writes the web host only.
  - `npm run test:web` builds `out/web-test` (with a read-only test hook) and runs Playwright.

## Results

These are the 1.3.0 results. Their anchor (`#results`) backs the web and Android cells of the capability matrix.

`node scripts/with-lock.mjs web-e2e -- npm run test:web` on 2026-11-06 at `d97c36f`: **25 passed, 8 skipped by design, 0 failed, 54.2 s.** The skips are touch tests on the desktop projects, mouse tests on the mobile project, and the build scan outside `chrome`. An independent earlier run by the implementing agent gave the same 25/8.

| Test | Chrome 156.0.8078.76 | Edge 156.0.4314.58 | Pixel 7 emulation (Chrome) |
|---|---|---|---|
| No console errors; CSP in force (header and meta) | pass | pass | pass |
| No request after load; only the page's three files | pass | pass | pass |
| The cat is drawn: opaque pixels at its bounds, a transparent canvas elsewhere | pass | pass | pass |
| A page button keeps its clicks; a click or tap on the cat stays with the cat, which reacts | pass | pass | pass |
| Mouse: stroking pets | pass | pass | — |
| Mouse: drag holds, release drops (falling, landing) | pass | pass | — |
| Touch: a stroke pets (no pick-up) | — | — | pass |
| Touch: hold, drag, release | — | — | pass |
| Reload keeps the cat (same catId) | pass | pass | pass |
| Hidden page: the cat naps, then wakes (`visibilityState` faked) | pass | pass | pass |
| The production build has no hook and no key-listener strings | pass | — | — |

Unit tests (vitest, `tests/unit/web`): 5 files and 50 tests, covering the router (every touch path, click suppression), storage (valid, corrupt, unavailable, quota), the display service, overlay mapping and hit-region freshness. They pass in the full suite.

## Labels

- **REAL:** the page, the sim, the renderer and the routing in installed Chrome 156 and Edge 156 on Windows 11. Input is synthesized through the DevTools protocol (Playwright), not by a person's hand.
- **SIMULATED:**
  - the Pixel 7 project: desktop Chrome's device emulation, touch through the DevTools protocol; not Android;
  - the hidden-tab test, which fakes `visibilityState`.
- **UNVERIFIED:**
  - Firefox and Safari/WebKit;
  - real Android and iOS devices or emulators;
  - a real hidden or frozen tab;
  - how scrolling and keyboard focus feel on a long page;
  - the Electron renderers' own CSP and Zod JIT probe. They share the CSP and probably log the same violation, which is harmless because Zod falls back, but it is unobserved.

## Known limits

- The production `main.js` is about 870 KB minified, about half of it Zod v4 with all its locales (src/shared imports `{ z }`). It works, but shrinking it is a next-milestone item.
- CSS `:hover` on page elements under the cat is not suppressed: the canvas has `pointer-events: none`.
- The cat lives in the viewport only, never over other tabs or apps (BLOCKED for any web page).
