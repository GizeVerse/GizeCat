# Release checklist

Run on a Windows 10/11 x64 machine. Heavy steps go through `node scripts/with-lock.mjs <label> -- …` on shared machines.

## Before tagging

- [ ] `package.json` version bumped; `productName`/`appId` unchanged (they determine the userData folder — changing them orphans users' cats).
- [ ] `npm ci --ignore-scripts` then `node node_modules/electron/install.js` (no dependency needs install scripts; Electron downloads its binary lazily).
- [ ] `npm run typecheck` — 0 errors.
- [ ] `npm run lint` — 0 problems.
- [ ] `npm test` — all vitest suites pass.
- [ ] `npm run build && npx playwright test` — all E2E tests pass (puts a real cat on the desktop for ~1–2 min).
- [ ] `node scripts/qa-desktop.mjs` — cat renders, 0 warnings/errors in the log.
- [ ] `node scripts/bench.mjs --phase-sec=120` — CPU/memory within the budgets in TEST_REPORT.md; no timer/handle growth.
- [ ] `npm audit --audit-level=high` (all dependencies: Electron and zod are devDependencies but ship) — no high/critical advisories.
- [ ] Docs reflect behaviour: README, PRIVACY, THREAT_MODEL, USER_GUIDE, AI_SETUP, THIRD_PARTY_NOTICES (versions match `package.json`).

## Package

- [ ] `npm run package` → `release/Desktop-Cat-Setup-<version>.exe`.
- [ ] Code signing: set `CSC_LINK`/`CSC_KEY_PASSWORD` (or Azure Trusted Signing) if an identity exists. **Never** describe an unsigned build as signed.
- [ ] `npx @electron/fuses read --app release/win-unpacked/DesktopCat.exe` — RunAsNode, NODE_OPTIONS and inspect disabled; ASAR integrity + only-load-from-ASAR enabled.
- [ ] `release/win-unpacked/resources/app.asar.unpacked/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node` exists.
- [ ] `release/win-unpacked/resources/native/DesktopCatUia.exe` exists and `DesktopCatUia.exe --version` prints the protocol version (the build only warns when csc.exe is missing; a release must not ship without the helper).
- [ ] `node scripts/smoke-packaged.mjs` — packaged exe starts, 0 log errors, second launch exits 0.
- [ ] `node scripts/taskbar-probe.mjs` — overlays keep the taskbar topmost (NonRudeHWND) and the reveal strip still hits the taskbar.
- [ ] `node scripts/uia-probe.mjs --browsers edge,chrome` — tab strips found through the shipped helper with your own throwaway browser instances; no web-accessibility activation.
- [ ] `node scripts/login-item-probe.mjs` — Electron's Run-value quoting and StartupApproved rules still match the app's reader.
- [ ] Manual: install the previous release, then upgrade → settings migrate (v1 → v2), startup is registered once with the installed path and the one-time notice appears; a Task Manager disable survives the upgrade.
- [ ] Manual: reveal an auto-hide taskbar with the mouse next to the cat → it may hop on and ride, is set down calmly when it hides, and taskbar buttons stay clickable.
- [ ] `powershell -File scripts/install-test.ps1` — exits 0: silent install, smoke, silent uninstall, shortcuts and uninstall entry removed.
- [ ] Manual: install over the previous version → settings and cat memories preserved.
- [ ] Manual: multi-monitor with different scale factors (drag the cat across), disconnect a monitor while the cat is on it.
- [ ] Manual: tray left/right click, right-click menu on the cat, shortcut toggle, diagnostics export dialog.
- [ ] Publish SHA-256 of the installer with the release notes.
