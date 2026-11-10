# Branding transition: Desktop Cat → GizeCat (GizeVerse)

Status: display strings done; persistent identifiers frozen; installer names deferred. Code at `9f95590` and later. Design: [ADR 0004 §9](../adr/0004-gizeverse-platform.md).

## What users see now

| Where | Before | Now |
|---|---|---|
| Settings window title, page headings, all Settings strings | Desktop Cat | **GizeCat** |
| About page | Desktop Cat | "GizeCat — a GizeVerse character (formerly Desktop Cat)" |
| Tray tooltip, tray and cat menus ("Quit …"), menu tooltip line | Desktop Cat | GizeCat |
| Overlay window title (invisible; seen by window tools) | Desktop Cat | GizeCat |
| Startup-failure dialog, `--no-sandbox` refusal dialog | Desktop Cat | GizeCat |
| Login-item messages and the one-time "starts with Windows" notice | Desktop Cat | GizeCat, except where the text tells the user what to find in Windows (below) |
| Start-menu and desktop shortcuts, the Apps list, Task Manager › Startup apps, the installer file name, the install folder `Programs\DesktopCat` | Desktop Cat | **unchanged: "Desktop Cat"** (deferred) |

**Why some text still says "Desktop Cat".** Windows still shows the installed app under that name, so instructions point at what the user will actually see:
- Settings, the "disabled in Windows" status: "enable the Desktop Cat entry";
- Settings › About, uninstall: "find Desktop Cat";
- login-item messages about Task Manager › Startup apps, and "the next time you open Desktop Cat from the Start menu".

`BRAND.installedName` holds that name in one place, so the eventual rename is a one-line change.

## Frozen identifiers (unchanged, pinned by tests)

Each value lives in [src/shared/identity.ts](../../src/shared/identity.ts) with the reason it is frozen. `tests/unit/shared/identity.test.ts` compares each against its source of truth: package.json, electron-builder.yml, build/installer.nsh and the code that uses it.
- **App identity.** appId and AppUserModelID `io.github.enesiltas.desktopcat`, which is also the Run value name. The package `name` `desktop-cat`.
- **The `productName` "Desktop Cat".** It is Electron's app name. It names:
  - the userData folder;
  - the single-instance lock;
  - the macOS Keychain item "Desktop Cat Safe Storage";
  - the Linux os_crypt name.
- **Install markers and kinds.** The executables `DesktopCat` (Windows) and `desktop-cat` (Linux); the uninstall marker; the sidecar kind `desktop-cat-opt-outs`; the diagnostics kind `desktop-cat-diagnostics`; the lock key `desktop-cat:second-instance`.
- **Process surface.** The `DESKTOP_CAT_*` environment variables, the `desktop-cat://` scheme, the preload globals, `DesktopCatUia.exe`, and the log file name.

**userData pin.** Without an override, the app now sets userData to `<appData>/Desktop Cat` before taking the single-instance lock. That is exactly today's default, so nothing moves today, and a later productName change can never move users' cats, settings, API keys or the lock. The startup test fails when the pin is removed (REAL: checked by disabling it).

## 1.4.0 names (release candidate)

| Where | 1.3.0 | 1.4.0 |
|---|---|---|
| Windows installer file | `Desktop-Cat-Setup-<version>.exe` | **`Desktop-Cat-Setup-<version>-x64.exe`** and **`Desktop-Cat-Setup-<version>-arm64.exe`** (one per architecture; `artifactName` in electron-builder.yml). The "Desktop Cat" prefix stays until the installer rename below. |
| Windows shortcuts, Apps entry, install folder | Desktop Cat | Unchanged: Desktop Cat. The NSIS GUID derives from the appId, so the per-arch names do not affect upgrades. |
| macOS artifacts | `package:mac` was never built | Developer ID signed and notarized: `GizeCat-<version>-mac-<x64, arm64, universal>.dmg` / `.zip`. Ad-hoc signed, never notarized: `GizeCat-<version>-mac-<arch>-adhoc.zip` (WSL or container route), and `-adhoc-macrunner.dmg` / `.zip` from the workflow |
| macOS app bundle | `Desktop Cat.app` | Unchanged (frozen: the Keychain item and login items are keyed by the bundle and its id) |
| macOS menus and Settings | — | "About GizeCat", "Quit GizeCat", "Show GizeCat in the Dock" |
| Web app | — | Name GizeCat (manifest), icons generated from `build/icon.png`; `GizeCat-web-<version>.zip` |
| Android app | — | Launcher name GizeCat (trial build: "GizeCat (trial)"); `GizeCat-<version>-android.apk` / `.aab` when signed, `GizeCat-<version>-android-unsigned.apk` / `.aab` otherwise, `GizeCat-<version>-android-trial-debugsigned.apk` for the trial |

**New frozen identifiers in 1.4.0** (in `src/shared/identity.ts`, pinned by `tests/unit/shared/identity.test.ts`, written and not run in 1.4.0):
- `androidApplicationId` = `io.github.gizeverse.gizecat`: permanent once published on Google Play. It differs from the desktop appId.
- `androidWebOrigin` = `https://appassets.androidplatform.net`: the Android cat's storage is keyed by it ([14-android-app.md](14-android-app.md)).
- `profileKind` = `gizeverse-character-profile`: the tag of the portable profile file.

No new logos or artwork were made; every icon derives from `build/icon.png`.

## Character seam

[src/shared/character.ts](../../src/shared/character.ts): `CharacterDescriptor` and `CAT_CHARACTER`, built from the existing cat vocabularies (body size, clips, skins, reactions). It is the documented contract for a second GizeVerse character; nothing is persisted and no behaviour changes.

## Verification

- **Unit and type checks (REAL).**
  - The full vitest pass after the rename: 3756 passed (agent run) and later 3785 passed in `verify fast`.
  - Typecheck and lint clean.
  - New tests: identity, brand, character, Settings branding, Settings platform view.
- **E2E (REAL in `verify full`).** The text assertions in tests/e2e/lifecycle.spec.ts are covered there; see the Windows regression report.
- **Visual check.** The layout of the About heading and of the Diagnostics › Platform section was not looked at by a person (UNVERIFIED).

## Remaining steps (owner)

1. **Installer names.** Rename the installer-visible names (builder `productName`, shortcutName, uninstallDisplayName, artifactName) only after `scripts/upgrade-test.ps1` passes from 1.2.0 on a disposable Windows user or VM. Never on a machine with a real install. Since 1.4.0 the test takes `-Arch x64|arm64`, and the rename must keep the `-x64` / `-arm64` suffixes.
2. **Diagnostics export file name.** `desktop-cat-diagnostics-<stamp>.json` could become a GizeCat name, since the audit classes it as display. It was left as it is because tools may look for it.
3. **Logos.** No new logos or assets were created; the cat icon has no text and needs no change.
