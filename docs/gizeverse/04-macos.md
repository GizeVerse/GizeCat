# GizeCat on macOS: foundation report

Status: **IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED.** No Mac, no macOS VM and no Xcode toolchain exist on this machine. Nothing here has run on macOS. Every statement about runtime behaviour is from Electron 44's documentation, Electron's v44.9.3 sources as read by the design reviewer, or unit tests with a fake platform: **SIMULATED_OR_MOCK_TESTED**. Per-capability statuses: [capability matrix](capability-matrix.md), macOS section.

## What exists in code

| Area | Implementation | Where | Test |
|---|---|---|---|
| Platform identity | `process.platform === 'darwin'` maps to `darwin` | src/shared/platform.ts | platform.test.ts |
| Coordinates | Logical world (points). `dipToScreenRect` and `dipToScreenPoint` are never called; they do not exist on macOS. Mixed Retina and 1× layouts do not overlap. | src/core/display/coordinates.ts, src/main/display/coordinates.ts | coordinates.test.ts, platformServices.test.ts (a fake screen asserts zero Windows-only calls) |
| Overlay window | `type: 'panel'` (NSPanel, non-activating) at the `screen-saver` level; `acceptFirstMouse: true`, because macOS otherwise drops the first click on a non-focusable panel; `hiddenInMissionControl: true`. No `setVisibleOnAllWorkspaces`: it would show the Dock icon and briefly hide the window (review M1). No Windows shell extras or session-end events. | src/main/overlay/overlayProfile.ts, overlayWindow.ts | platformServices.test.ts, overlayManager.test.ts |
| Click-through | The shared T8 mechanism: `setIgnoreMouseEvents(true)` until the cursor, polled through `screen.getCursorScreenPoint()`, is over a fresh renderer-reported hit region | overlayManager.ts, catHost.ts | existing suite |
| Menus | A minimal application menu with roles only (`appMenu`, `editMenu`, `windowMenu`), so Cmd+C/V/X/A/Z work in Settings | src/main/platform/appMenu.ts | platformServices.test.ts |
| Reachability | The Dock icon stays. `activate` (a Dock click, or a launch from Finder while running) opens Settings and shows the cat, after a 3 s grace for the launch's own activation. The menu-bar icon is the tray. | src/main/index.ts, src/main/platform/index.ts | platformServices.test.ts (flag); the event itself UNVERIFIED |
| Saving at shutdown | `powerMonitor` `shutdown` calls the same synchronous save as Windows' session-end window | src/main/app.ts | flag unit-tested; the event UNVERIFIED |
| Idle | `powerMonitor.getSystemIdleTime()` in coarse mode: no typing inference | src/main/win32/activityMonitor.ts | activityMonitor.test.ts (a 1 s source at the real 50 ms poll) |
| Secrets | safeStorage (the Keychain item is keyed on the app name "Desktop Cat", which is frozen: review M6) | src/main/store/secretStore.ts | existing suite |
| Startup at sign-in | Explicitly blocked ("not supported on this platform yet"); nothing is registered | loginItemReconcile.ts | loginItemService.test.ts |
| Perception | Fail-closed, as before: no per-OS process identity for the privacy exclusions, and no Screen Recording consent design | perception/* | existing suite |
| Window surfaces, Dock surface, tab strips, fullscreen awareness | Not implemented: the cat lives on the work-area floor | — | capability table |
| Packaging | `mac:` section (dmg + zip, x64 + arm64, category utilities, koffi excluded). Unsigned, not notarized, never built. | electron-builder.yml | UNVERIFIED |

## What a Mac run must check (in order)

1. **Build.**
   - Run `npm ci --ignore-scripts && node node_modules/electron/install.js && node .claude/scripts/verify.mjs fast`.
   - The unit suite has not run on macOS. Six files already skip off Windows; others may assume Windows paths.
2. **Startup.**
   - Run `npm run dev`. The log (`~/Library/Application Support/Desktop Cat/logs/`) must show `platform {"id":"darwin","coordinates":"logical","overlay":true}`, `display topology` with your displays, `overlay created` per display, and `platform capabilities` with the expected unavailable list.
3. **T8 first (the invariant).**
   - Click, scroll and drag on apps under every part of the overlay except the cat. Everything must work exactly as without GizeCat.
   - Then click the cat: it must react on the **first** click (`acceptFirstMouse`).
4. **Stacking.**
   - The cat stays above normal windows and above the menu bar level.
   - Check it across Spaces and over a fullscreen app (expected: only on its own Space; that is UNVERIFIED either way).
   - The overlay must never show in Mission Control or Cmd+Tab.
5. **Retina plus an external 1× display.** The cat keeps its size in points on both, and is drawn sharply (the renderer uses `devicePixelRatio`).
6. **Reachability.** Clicking the Dock icon opens Settings. A second `open -a` does the same. Quitting from the menu-bar menu saves the cat.
7. **Secrets.** Saving an API key creates the Keychain item `Desktop Cat Safe Storage`; this needs a Keychain prompt approval.
8. **Packaging.**
   - `npm run package:mac` on a Mac produces an unsigned dmg; Gatekeeper will block it (right-click → Open).
   - Distribution needs a Developer ID and notarization (`hardenedRuntime` defaults to true).

## Known risks

- **Panel behaviour.** A `panel` with `focusable: false` and a transparent background has not been seen working with `setIgnoreMouseEvents` on Electron 44. If the first-click delivery or the click-through fails, T8 is at stake. The fallback is to keep the overlay off on darwin: a one-line profile change.
- **Electron 44.** It supports macOS 13 and later only, on x64 and arm64.
- **Login items.** `setLoginItemSettings` (SMAppService) may need user approval and fails silently for unsigned apps. That is why login items stay off.
