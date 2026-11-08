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
- [ ] `npm run package:win` → `release/Desktop-Cat-Setup-<version>-x64.exe` and `release/Desktop-Cat-Setup-<version>-arm64.exe` (or the explicit `npx electron-builder --win nsis --x64 --arm64 --publish never -c.directories.output=release/<version>/windows`; the arch flags are required). `npm run package` alone builds x64 only.
- [ ] Code signing: set `CSC_LINK`/`CSC_KEY_PASSWORD` (or Azure Trusted Signing) if an identity exists. **Never** describe an unsigned build as signed.
- [ ] `node scripts/check-win-payload.mjs --arch x64 --dir <release>/win-unpacked` and `--arch arm64 --dir <release>/win-arm64-unpacked` — exit 0 (executable machine, koffi binary per arch, asar header and integrity, fuses).
- [ ] `npx @electron/fuses read --app release/win-unpacked/DesktopCat.exe` — RunAsNode, NODE_OPTIONS and inspect disabled; ASAR integrity + only-load-from-ASAR enabled.
- [ ] `release/win-unpacked/resources/app.asar.unpacked/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node` exists, and `release/win-arm64-unpacked/resources/app.asar.unpacked/node_modules/@koromix/koffi-win32-arm64/win32_arm64/koffi.node` exists.
- [ ] `release/win-unpacked/resources/native/DesktopCatUia.exe` exists and `DesktopCatUia.exe --version` prints the protocol version (the build only warns when csc.exe is missing; a release must not ship without the helper).
- [ ] `node scripts/smoke-packaged.mjs` — packaged exe starts, 0 log errors, second launch exits 0.
- [ ] `node scripts/taskbar-probe.mjs` — overlays keep the taskbar topmost (NonRudeHWND) and the reveal strip still hits the taskbar.
- [ ] `node scripts/uia-probe.mjs --browsers edge,chrome` — tab strips found through the shipped helper with your own throwaway browser instances; no web-accessibility activation.
- [ ] `node scripts/login-item-probe.mjs` — Electron's Run-value quoting and StartupApproved rules still match the app's reader.
- [ ] Manual: install the previous release, then upgrade → settings migrate (v1 → v2), startup is registered once with the installed path and the one-time notice appears; a Task Manager disable survives the upgrade.
- [ ] Manual: reveal an auto-hide taskbar with the mouse next to the cat → it may hop on and ride, is set down calmly when it hides, and taskbar buttons stay clickable.
- [ ] `powershell -File scripts/install-test.ps1 -Arch x64` — exits 0: silent install, smoke, silent uninstall, shortcuts and uninstall entry removed.
- [ ] Manual: install over the previous version → settings and cat memories preserved.
- [ ] Manual: multi-monitor with different scale factors (drag the cat across), disconnect a monitor while the cat is on it.
- [ ] Manual: tray left/right click, right-click menu on the cat, shortcut toggle, diagnostics export dialog.
- [ ] ARM64, only on a Windows on Arm PC or disposable ARM64 VM: `node scripts/smoke-packaged.mjs <release>\win-arm64-unpacked\DesktopCat.exe`, `install-test.ps1 -Arch arm64`, `install-test.ps1 -Arch x64` (emulation), `upgrade-test.ps1 -OldInstaller Desktop-Cat-Setup-1.3.0.exe -Arch arm64`. Until this runs, the ARM64 runtime stays THEORETICALLY_COMPATIBLE_NOT_EXECUTED.

## Package: macOS

- [ ] Commit first, then `npm run package:mac:adhoc-docker` (Docker Desktop running; start it detached on a shared machine) → `release/<version>/mac/GizeCat-<version>-mac-x64-adhoc.zip`, `…-arm64-adhoc.zip`, `README-adhoc.txt`, `SHA256SUMS.txt`. Ad-hoc zips are never called signed or notarized.
- [ ] Optional, owner only: dispatch `.github/workflows/macos-packages.yml` (job `developer-id`, environment `macos-signing` with a required reviewer and the signing secrets) for Developer ID signed and notarized DMG and zip, x64, arm64 and universal.
- [ ] On a real Mac (Apple Silicon and Intel), before any macOS status moves: the checklist in [docs/gizeverse/04-macos.md](gizeverse/04-macos.md#mac-checklist-additions-run-on-real-hardware-none-has-run).

## Package: web app

- [ ] `npm run package:web` → `release/<version>/web/` (folder, `GizeCat-web-<version>.zip`, `README-web.txt`, `SHA256SUMS.txt`). The build's own check must pass (exact file set, no test hook or key-listener code, pinned CSP, precache list).
- [ ] Optional, owner only: enable GitHub Pages (Source: GitHub Actions) and dispatch `.github/workflows/pages.yml`. A successful deployment is not evidence that the app works on an iPad or an Android tablet.

## Package: Android

- [ ] `npm run android:apk`, `npm run android:aab` and `npm run android:trial` from the final commit, **without** `--no-web` → `release/<version>/android/` with `SHA256SUMS-android.txt`.
- [ ] Inspect the merged manifest: no `<uses-permission>` (an inspection, not a test).
- [ ] Owner only: sign the release APK and AAB with the owner's upload keystore (`android/keystore.properties`). Unsigned outputs keep `-unsigned` in their names and are described as unsigned.
- [ ] The trial APK, if attached at all, is labelled as debug-signed and for trials only.

## Publish (owner)

- [ ] One `SHA256SUMS.txt` covering every attached file; publish it with the release notes.
- [ ] Remove from the release notes any artifact that was not produced.
- [ ] README: update the "current release" line when the release is published.
