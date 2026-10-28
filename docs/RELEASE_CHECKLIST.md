# Release checklist

Run on a Windows 10/11 x64 machine. Heavy steps go through `node scripts/with-lock.mjs <label> -- …` on shared machines.

## Before tagging

- [ ] `package.json` version bumped; `productName`/`appId` unchanged (they determine the userData folder — changing them orphans users' cats).
- [ ] `npm ci` then `node node_modules/electron/install.js` (Electron downloads lazily).
- [ ] `npm run typecheck` — 0 errors.
- [ ] `npm run lint` — 0 problems.
- [ ] `npm test` — all vitest suites pass.
- [ ] `npm run build && npx playwright test` — all E2E specs pass (puts a real cat on the desktop for ~30 s).
- [ ] `node scripts/qa-desktop.mjs` — cat renders, 0 warnings/errors in the log.
- [ ] `node scripts/bench.mjs --phase-sec=120` — CPU/memory within the budgets in TEST_REPORT.md; no timer/handle growth.
- [ ] `npm audit --omit=dev` — no high/critical advisories in shipped dependencies.
- [ ] Docs reflect behaviour: README, PRIVACY, THREAT_MODEL, USER_GUIDE, AI_SETUP, THIRD_PARTY_NOTICES (versions match `package.json`).

## Package

- [ ] `npm run package` → `release/Desktop-Cat-Setup-<version>.exe`.
- [ ] Code signing: set `CSC_LINK`/`CSC_KEY_PASSWORD` (or Azure Trusted Signing) if an identity exists. **Never** describe an unsigned build as signed.
- [ ] `npx @electron/fuses read --app release/win-unpacked/DesktopCat.exe` — RunAsNode, NODE_OPTIONS and inspect disabled; ASAR integrity + only-load-from-ASAR enabled.
- [ ] `release/win-unpacked/resources/app.asar.unpacked/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node` exists.
- [ ] `node scripts/smoke-packaged.mjs` — packaged exe starts, 0 log errors, second launch exits 0.
- [ ] `powershell -File scripts/install-test.ps1` — silent install, smoke, silent uninstall, shortcuts and uninstall entry removed.
- [ ] Manual: install over the previous version → settings and cat memories preserved.
- [ ] Manual: multi-monitor with different scale factors (drag the cat across), disconnect a monitor while the cat is on it.
- [ ] Manual: tray left/right click, right-click menu on the cat, shortcut toggle, diagnostics export dialog.
- [ ] Publish SHA-256 of the installer with the release notes.
