# GizeCat web host: report

Branch `feat/gizeverse-foundation`, code at `d97c36f`. Design: [ADR 0004 §8](../adr/0004-gizeverse-platform.md). Evidence: [evidence-web-e2e.txt](evidence-web-e2e.txt).

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
