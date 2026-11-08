# GizeCat on macOS: foundation report

## 1.4.0 update

2026-11-08, branch `release/1.4.0-universal-devices` (release candidate). 1.4.0 makes macOS a first-class desktop target for Intel and Apple Silicon. Statuses use the 1.4.0 vocabulary ([docs/platforms/README.md](../platforms/README.md#status-vocabulary-for-140)); the user guide is [docs/platforms/macos.md](../platforms/macos.md). **Nothing was run on a Mac.** Runtime statements come from reading Electron 44.9.3's sources (as cited in the 1.4.0 design pass) and app-builder-lib 26.18.1. The 1.3.0 foundation report further down is kept as written; where this section differs, this section is current (the overlay level, the login item, the Dock, the menu and packaging).

### Decisions

| # | Decision |
|---|---|
| D1 | **Floor only.** No window climbing, Dock surface or fullscreen detection in 1.4.0. The only permission-free source of other windows' bounds is `CGWindowListCopyWindowInfo`, which needs native code (koffi) that has never run; koffi stays out of the macOS payload. |
| D2 | The panel overlay stays. By Electron's panel code it is on every Space and above fullscreen apps (it forces CanJoinAllSpaces and FullScreenAuxiliary), so the fullscreen setting has no effect on macOS. Review M1 is moot. |
| D3 | **Overlay level `floating`** instead of `screen-saver` (this changes ADR 0004 G7): above normal windows, below pop-up menus, the menu bar, the Dock, Notification Center and system alerts, so the cat's hit region can never sit over a menu item. |
| D4 | **Dock icon on by default**, with a darwin-only switch "Show GizeCat in the Dock" (`general.showDockIcon`) that sets the activation policy to `regular` or `accessory`. Never `LSUIElement`. |
| D5 | **Template menu-bar icons** (black plus alpha) with a different shape per state: paused shows bars, vision shows a ring eye (a privacy indicator). A click opens the menu and never toggles the cat. |
| D6 | **Open at login through SMAppService** (`app.setLoginItemSettings({ openAtLogin })`), in a separate darwin service; the Windows startup code is untouched. **Off by default, opt-in only.** No writes at startup. Write gate: packaged, not a test run, `DESKTOP_CAT_LOGIN_ITEM` not `off`, and the app in /Applications. Every macOS status (`requires-approval`, `not-registered`, `not-found`, turned on in System Settings) maps to a reason in Settings. |
| D7 | A quick quit at logout or shutdown: the quit animation is skipped, the cat is saved at once, and disposal is bounded at 500 ms. |
| D8 | An explicit application menu (About, Services, Hide Others, Show All, Quit) **without Hide**, so Cmd+H can never order the overlays out. Edit and Window menus stay. |
| D9 | **No permissions:** no Accessibility, Screen Recording or Input Monitoring request, no screen-capture usage string. Perception stays fail-closed until it has a consent design and a per-OS exclusion identity. Electron's camera, microphone, audio-capture and Bluetooth usage strings are replaced with "GizeCat never uses …; choose Don't Allow". |
| D10 | **Minimal entitlements:** `com.apple.security.cs.allow-jit` only, in `build/entitlements.mac.plist` and the inherit plist, with the hardened runtime. Fallback if a signed build fails to start: `allow-unsigned-executable-memory`. |
| D11 | **Artifact matrix.** A macOS runner builds DMG and zip for x64, arm64 and universal: Developer ID plus notarization when the owner's secrets exist, otherwise ad hoc. A Linux container builds ad-hoc zips for x64 and arm64 only, named `GizeCat-<version>-mac-<arch>-adhoc.zip` so they cannot be confused with notarized builds. |
| D12 | Signed builds come only from a manual workflow (`macos-packages.yml`, `workflow_dispatch`) in the GitHub Environment `macos-signing` with a required reviewer. |
| D14 | A guarded window-geometry probe is deferred until a Mac exists (NOT_IMPLEMENTED). |
| D15 | The bundle stays `Desktop Cat.app` with the frozen id `io.github.enesiltas.desktopcat` (the Keychain and login items are keyed by it). Artifacts are named `GizeCat-*`. |

Also new: diagnostics report `os.arm64Translation` (true for an x64 build under Rosetta or Windows-on-Arm emulation; a boolean), and the "API key saved" message names the macOS Keychain.

### Statuses

| Capability or artifact | Status |
|---|---|
| Floating panel overlay, template menu-bar icon, menu without Hide, Dock switch, Open at login, quick quit, entitlements | IMPLEMENTED; THEORETICALLY_COMPATIBLE_NOT_EXECUTED |
| Window surfaces, Dock as a surface, fullscreen awareness | NOT_IMPLEMENTED (D1) |
| Perception | NOT_IMPLEMENTED (fails closed by design, D9) |
| Browser tab strips | BLOCKED_BY_PLATFORM (Windows UI Automation only) |
| `GizeCat-1.4.0-mac-x64-adhoc.zip`, `GizeCat-1.4.0-mac-arm64-adhoc.zip` (Linux container) | COMPILED_OR_PACKAGED only once a real container run produced them; a zip proves only that it packages |
| Ad-hoc zips from the macOS runner | THEORETICALLY_COMPATIBLE_NOT_EXECUTED (the workflow has never run) |
| Developer ID signed and notarized DMG and zip, x64, arm64, universal | REQUIRES_OWNER_CREDENTIALS |
| Universal build | THEORETICALLY_COMPATIBLE_NOT_EXECUTED (a macOS host only) |

The capability matrix's darwin column records the same, in its own vocabulary ([capability-matrix.md](capability-matrix.md)).

### Packaging

- `electron-builder.yml`, mac section: DMG and zip for `[x64, arm64, universal]`, hardened runtime, the two entitlement plists, the replaced usage strings, koffi excluded, `notarize` deliberately unset (the workflow notarizes and staples).
- Linux route: `npm run package:mac:adhoc-docker` (`scripts/package-mac-docker.mjs` and `scripts/docker/mac-adhoc-build.sh`): `git archive HEAD` into one `node:24-bookworm-slim` container, `electron-builder --mac dir --x64 --arm64`, ad-hoc signing with rcodesign 0.29.0 (sha256-checked), zips with their symbolic links kept, `README-adhoc.txt`, `SHA256SUMS.txt`, all copied to `release/<version>/mac/`.
- Manual workflow `.github/workflows/macos-packages.yml`: job `adhoc` (no secrets) and job `developer-id` (environment `macos-signing`, a guard that fails closed without secrets, notarization by App Store Connect API key or Apple ID, then `codesign --verify --deep --strict`, the hardened-runtime flag, TeamIdentifier, an entitlements dump, `spctl`, `stapler validate`, DMG notarization and stapling, and removal of the key file).
- Commands: [building-and-packaging.md](../platforms/building-and-packaging.md#macos-intel-apple-silicon-universal).

### Mac checklist additions (run on real hardware; none has run)

- T8 click-through and first-click delivery on the floating panel; hover strokes reaching a non-key panel.
- Menus, Notification Center and alerts drawn over the cat at the floating level.
- Spaces and fullscreen apps, and logging `display-metrics-changed` and the work area while entering a fullscreen Space.
- Retina plus a 1× display.
- The menu-bar menu opening on click without toggling the cat; the template icon in light, dark and tinted menu bars.
- Dock activate; the Dock switch both ways (does Settings stay reachable, does `activate` fire for an accessory app, do Cmd+C and Cmd+V still work in Settings without a Dock icon).
- Login-item statuses (`enabled`, `requires-approval`, `not-registered`, `not-found`), from /Applications and from Downloads.
- Logout and shutdown speed with the quick quit; the Keychain prompt; whether the Window menu lists overlay windows.
- The first signed build starting under the hardened runtime with `allow-jit` only.

### Known limits (1.4.0)

- Settings words the macOS differences: the Diagnostics startup row reads "Open at login", the secure-storage messages name the macOS Keychain, and the fullscreen row explains that the setting has no effect (D2). None of this has been seen on a Mac.
- SMAppService needs macOS 13 or later; Electron's behaviour on older macOS was not checked.
- The "Open Login Items settings" button opens `x-apple.systempreferences:com.apple.LoginItems-Settings.extension`. That pane id comes from the design pass, not from Apple documentation; the status text also names the place in words.
- `hideFromScreenCapture` maps to NSWindowSharingNone; ScreenCaptureKit capture on macOS 15 and later may ignore it (not checked).
- The DMG container itself is signed only if electron-builder signs DMGs (its default is no); the workflow notarizes and staples DMGs in a separate step.

## 1.3.0 foundation report

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
