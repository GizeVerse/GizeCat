# Release checklist

Run on a Windows 10/11 x64 machine. Heavy steps go through `node scripts/with-lock.mjs <label> -- …` on shared machines. Since 1.4.0, the macOS, web and Android artifacts have their own sections below; the exact commands are in [docs/platforms/building-and-packaging.md](platforms/building-and-packaging.md).

**Install and upgrade tests (`scripts/install-test.ps1`, `scripts/upgrade-test.ps1`) run only on a disposable Windows user or VM, never on a PC where GizeCat is really used.**

## Before tagging

- [ ] `package.json` version bumped; `productName`/`appId` unchanged (they determine the userData folder — changing them orphans users' cats). The Android `versionName`/`versionCode` follow `package.json` automatically.
- [ ] `npm ci --ignore-scripts` then `node node_modules/electron/install.js` (no dependency needs install scripts; Electron downloads its binary lazily).
- [ ] `npm run typecheck` — 0 errors.
- [ ] `npm run lint` — 0 problems.
- [ ] `npm test` — all vitest suites pass.
- [ ] `npm run build && npx playwright test` — all E2E tests pass (puts a real cat on the desktop for ~1–2 min).
- [ ] `npm run test:web` — the web host's Playwright tests pass in Chrome and Edge (the tablet projects are device emulation: SIMULATED).
- [ ] `node scripts/qa-desktop.mjs` — cat renders, 0 warnings/errors in the log.
- [ ] `node scripts/bench.mjs --phase-sec=120` — CPU/memory within the budgets in TEST_REPORT.md; no timer/handle growth.
- [ ] `npm audit --audit-level=high` (all dependencies: Electron and zod are devDependencies but ship) — no high/critical advisories.
- [ ] `node scripts/capability-matrix.mjs --check` — the capability matrix matches `src/shared/platform.ts`.
- [ ] Docs reflect behaviour: README, CHANGELOG, PRIVACY, THREAT_MODEL, USER_GUIDE, AI_SETUP, THIRD_PARTY_NOTICES (versions match `package.json`), and `docs/platforms/` (the status of every target and artifact).
- [ ] Every status in the release notes uses the release vocabulary (IMPLEMENTED, COMPILED_OR_PACKAGED, THEORETICALLY_COMPATIBLE_NOT_EXECUTED, REQUIRES_OWNER_CREDENTIALS, BLOCKED_BY_PLATFORM, NOT_IMPLEMENTED). A platform or artifact that has not run on a device is never called verified or supported.

## Package: Windows (x64 and ARM64)

- [ ] Stage the ARM64 koffi binary: `node scripts/stage-koffi-arch.mjs --arch arm64`, then `git diff --exit-code -- package.json package-lock.json` prints nothing. Do not run `npm ci` after staging.
- [ ] For a release, package into the versioned folder: `npx electron-builder --win nsis --x64 --arm64 --publish never -c.directories.output=release/<version>/windows` (after `node scripts/build.mjs`; the arch flags are required) → `release/<version>/windows/Desktop-Cat-Setup-<version>-x64.exe`, `…-arm64.exe`, `win-unpacked/` and `win-arm64-unpacked/`. `npm run package:win` builds the same into `release/` instead, and `npm run package` alone builds x64 only. **`<release>` below is the folder you packaged into**: `release/<version>/windows` for a release (only installers there are covered by `npm run release:sums`), `release` after `npm run package:win`. Older builds left in the other folder are never evidence for this version.
- [ ] Code signing, if the owner has SignPath or a certificate:
  - run the manual `release.yml` workflow with `windows_signing: signpath` (environment `windows-signing` with a required reviewer);
  - or sign on your own computer with `scripts/sign-windows.ps1 -CertificateThumbprint <thumbprint>` (token or cloud-HSM certificate).
  - Check the result with `scripts/verify-windows-signature.ps1` ([Windows signing](platforms/windows-signing.md)).
  - **Never** describe an unsigned build as signed.
- [ ] `node scripts/check-win-payload.mjs --arch x64 --dir <release>/win-unpacked` and `--arch arm64 --dir <release>/win-arm64-unpacked` — exit 0 (executable machine, koffi binary per arch, asar header and integrity, fuses, nothing in `app.asar` outside the app's allow-list, `app.asar` under 32 MB) and no warning that the `app.asar` version differs from `package.json`.
- [ ] `npx @electron/fuses read --app <release>/win-unpacked/DesktopCat.exe` — RunAsNode, NODE_OPTIONS and inspect disabled; ASAR integrity + only-load-from-ASAR enabled.
- [ ] `<release>/win-unpacked/resources/app.asar.unpacked/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node` exists, and `<release>/win-arm64-unpacked/resources/app.asar.unpacked/node_modules/@koromix/koffi-win32-arm64/win32_arm64/koffi.node` exists.
- [ ] `<release>/win-unpacked/resources/native/DesktopCatUia.exe` exists and `DesktopCatUia.exe --version` prints the protocol version (the build only warns when csc.exe is missing; a release must not ship without the helper).
- [ ] `node scripts/smoke-packaged.mjs <release>\win-unpacked\DesktopCat.exe` — packaged exe starts, 0 log errors, second launch exits 0. Always pass the exe: with no argument the script uses `release\win-unpacked`. It refuses (exit 2, nothing launched) a build whose `app.asar` version is not the repository's.
- [ ] `node scripts/taskbar-probe.mjs` — overlays keep the taskbar topmost (NonRudeHWND) and the reveal strip still hits the taskbar.
- [ ] `node scripts/uia-probe.mjs --browsers edge,chrome` — tab strips found through the shipped helper with your own throwaway browser instances; no web-accessibility activation.
- [ ] `node scripts/login-item-probe.mjs` — Electron's Run-value quoting and StartupApproved rules still match the app's reader.
- [ ] Manual: install the previous release, then upgrade → settings migrate (v1 → v2), startup is registered once with the installed path and the one-time notice appears; a Task Manager disable survives the upgrade.
- [ ] Manual: reveal an auto-hide taskbar with the mouse next to the cat → it may hop on and ride, is set down calmly when it hides, and taskbar buttons stay clickable.
- [ ] `powershell -File scripts/install-test.ps1 -Arch x64 -Installer <release>\Desktop-Cat-Setup-<version>-x64.exe` — exits 0: silent install, smoke, silent uninstall, shortcuts and uninstall entry removed. (Without `-Installer` it looks in `release\`, `release\<version>\` and `release\<version>\windows\` and refuses when it finds none or several copies.)
- [ ] Manual: install over the previous version → settings and cat memories preserved.
- [ ] Manual: multi-monitor with different scale factors (drag the cat across), disconnect a monitor while the cat is on it.
- [ ] Manual: tray left/right click, right-click menu on the cat, shortcut toggle, diagnostics export dialog.
- [ ] ARM64, only on a Windows on Arm PC or disposable ARM64 VM: `node scripts/smoke-packaged.mjs <release>\win-arm64-unpacked\DesktopCat.exe`, `install-test.ps1 -Arch arm64 -Installer <release>\Desktop-Cat-Setup-<version>-arm64.exe`, `install-test.ps1 -Arch x64 -Installer <release>\Desktop-Cat-Setup-<version>-x64.exe` (emulation), `upgrade-test.ps1 -OldInstaller Desktop-Cat-Setup-1.3.0.exe -Arch arm64 -Installer <release>\Desktop-Cat-Setup-<version>-arm64.exe`. Until this runs, the ARM64 runtime stays THEORETICALLY_COMPATIBLE_NOT_EXECUTED.

## Package: macOS

- [ ] Commit first, then `npm run package:mac:adhoc-wsl` on a Windows PC with WSL 2, or `npm run package:mac:adhoc-docker` (Docker Desktop running). Start either one detached on a shared machine. → `release/<version>/mac/GizeCat-<version>-mac-x64-adhoc.zip`, `…-arm64-adhoc.zip`, `README-adhoc.txt`, `SHA256SUMS.txt` (a build by-product, not attached). Ad-hoc zips are never called Developer ID signed or notarized.
- [ ] `node scripts/check-mac-payload.mjs --arch x64 --zip <zip>` and `--arch arm64 --zip <zip>` — exit 0. This reads the zip and runs nothing.
- [ ] Optional, owner only: bring `.github/workflows/macos-packages.yml` to `main`, then dispatch it. Job `adhoc` needs no secrets and makes ad-hoc DMG and zip for x64, arm64 and universal, named `-adhoc`. Job `developer-id` (environment `macos-signing` with a required reviewer and the signing secrets) makes Developer ID signed and notarized DMG and zip. DMG and universal builds need a Mac.
- [ ] On a real Mac (Apple Silicon and Intel), before any macOS status moves: the checklist in [docs/gizeverse/04-macos.md](gizeverse/04-macos.md#mac-checklist-additions-run-on-real-hardware-none-has-run).

## Package: web app

- [ ] `npm run package:web` → `release/<version>/web/` (folder, `GizeCat-web-<version>.zip`, `README-web.txt`, `SHA256SUMS.txt`, a build by-product that is not attached). The build's own check must pass (exact file set, no test hook or key-listener code, pinned CSP, precache list).
- [ ] Optional, owner only: bring `.github/workflows/pages.yml` to `main` and dispatch it (the Pages source is already set to GitHub Actions since 2026-11-08). The expected address is `https://gizeverse.github.io/GizeCat/`; the deploy job prints the real one. Only then may any document call the address live. A successful deployment is not evidence that the app works on an iPad or an Android tablet.

## Package: Android

- [ ] `npm run android:release` (or `npm run android:apk` and `npm run android:aab`) and `npm run android:trial` from the final commit, **without** `--no-web` → `release/<version>/android/` with `SHA256SUMS-android.txt` (a build by-product, not attached). Note the commit you built from: the APK does not record it.
- [ ] Inspect the merged manifest: no `<uses-permission>` (an inspection, not a test). Confirm `licenses.html` is in the app's assets.
- [ ] Owner only: sign the release APK and AAB with the owner's upload key. The key comes from the `ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` environment variables, or else from `android/keystore.properties`; in CI, from the `android-signing` environment through `android-release.yml` ([android-signing.md](platforms/android-signing.md)). Unsigned outputs keep `-unsigned` in their names and are described as unsigned.
- [ ] The trial APK, if attached at all, is labelled as debug-signed and for trials only.
- [ ] Google Play, only if wanted: [docs/store/google-play/release-readiness.md](store/google-play/release-readiness.md). No document may say GizeCat is on Google Play until a listing is live.

## Workflows (owner)

The release workflows are manual and have never been started. `macos-packages.yml`, `pages.yml` and `android-release.yml` are not on `main`, so they cannot be started until the owner brings them there. Pushing to `main` also triggers `ci.yml`. Steps, inputs and secrets: [docs/platforms/release-automation.md](platforms/release-automation.md).

- [ ] Each signing path's environment (`macos-signing`, `android-signing`, `windows-signing`) exists with a required reviewer **before** its first run. Its secrets are set on the environment, never repository-wide.
- [ ] The first real run of each workflow is checked step by step, and every file it produces is inspected before anyone shares it.

## Publish (owner)

- [ ] `npm run release:sums` (`scripts/release-sums.mjs`) after the last package is in place → `release/<version>/SHA256SUMS.txt`, one line per `*.exe`, `*.dmg`, `*.zip`, `*.apk` and `*.aab` in `release/<version>/{windows,mac,web,android}`. Check that it lists exactly the files you attach, then attach it to the release. It is the only checksum file attached; the per-folder `SHA256SUMS.txt` and `SHA256SUMS-android.txt` stay behind.
- [ ] Remove from the release notes any artifact that was not produced.
- [ ] README: update the "Current release" lines (under "Get it on your device" and "Download and install") when the release is published.
