# Verification matrix, commands and results

Every claim this work makes, how it was checked, and the label it earns.
- **Machine.** Windows 11 Home 10.0.26200 x64, Node 26.4, npm 11.17. Linux checks ran in own Docker containers (`node:24-bookworm-slim`, Debian 12, Node 24.21.0).
- **Shared machine.** Heavy work ran one job at a time through the machine lock (`scripts/with-lock.mjs`; `verify.mjs` takes it itself).
- **Commit names.** Runs are tied to the commit they ran on.

## Verification matrix

| Claim | How | Result | Label |
|---|---|---|---|
| Windows behaviour preserved | `verify.mjs full` (30 Playwright tests against the real app); the REAL lively scenarios; unit tests that pin every win32 seam; an adversarial review of the diff | pass ([03-windows-regression.md](03-windows-regression.md)) | REAL (Windows 11) |
| Persistent identifiers unchanged | `tests/unit/shared/identity.test.ts` against package.json, electron-builder.yml, installer.nsh and the code; review | pass | REAL |
| Builder config move changes no Windows file | build once; `electron-builder --win dir` with the v1.2 and the new config; SHA-256 of every file | 144/144 identical | REAL |
| Core and shared platform-agnostic | ESLint bans Node built-ins and globals; probe file | rule fires; tree clean | REAL |
| Capability table honest | `tests/unit/shared/platform.test.ts` (no LOCALLY_VERIFIED where this machine cannot run; evidence anchors; overlay blocked where unsafe); generated matrix stale test | pass | REAL |
| Coordinates, profiles, gates, boot rules, secrets policy, coarse idle (all platforms) | unit tests with fake screens, fake X11 and fake environments | pass | SIMULATED_OR_MOCK_TESTED |
| Builds and unit tests on Linux | container: `npm ci`, typecheck, lint, vitest, build | pass (3750 tests at `d97c36f`; 3755 at `60c408b`) | REAL (Linux container) |
| Linux X11 overlay policy | container + Xvfb: withheld without a compositor, created with one, withdrawn when it dies; X-server click routing with controls | pass; one-pixel gap at the overlay origin ([05-linux.md](05-linux.md)) | SIMULATED_OR_MOCK_TESTED |
| Linux packaging | container: `npm run package:linux` | AppImage + tar.gz built | REAL (artifact build only) |
| Packaged Linux build refuses `--no-sandbox` | container: run with `--no-sandbox` | refusal printed, exit 1, no logger | REAL (container) |
| Web host | `npm run test:web` with installed Chrome 156 and Edge 156; 50 unit tests | 25 passed, 8 skipped by design | REAL (Windows browsers) |
| Phone layout and touch | the same suite under desktop Chrome's Pixel 7 emulation | pass | SIMULATED_OR_MOCK_TESTED |
| macOS | code reading; unit tests with a fake darwin platform | — | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED |
| iOS / iPadOS | none | — | not run |
| Production dependencies | `npm audit --omit=dev` | 0 vulnerabilities | REAL |
| 1.3.0: clicks, drags and throws keep working over long runs | press-path, guard and 24 h sim suites (the press-path tests fail on the 1.2.0 code); a 120-minute soak of the real app under random gestures and perturbations; lively throws ([13-interaction-reliability.md](13-interaction-reliability.md)) | unit suites pass; soak passed (1,251/1,251 judged gestures, 0 stuck, T8 held); lively throws 10/10 | unit: REAL run, SIMULATED input; soak and lively: app REAL, input SIMULATED; more than 2 hours, and real-hand input: UNVERIFIED |
| 1.3.0 installer | NSIS build from `0ec2dd2`; packaged smoke | built, SHA-256 `57BEC0A7…113C7`, smoke pass | REAL (built and run unpacked); installing and upgrading: UNVERIFIED here |

## Commands and results

| Command | Where | Commit | Result |
|---|---|---|---|
| `node .claude/scripts/verify.mjs full` | Windows | `60c408b` | PASS: typecheck, lint, unit (3790 passed, 26 skipped, 1 todo), build, e2e (30 passed, 15 skipped) |
| `DESKTOP_CAT_E2E_LIVELY=1 node scripts/with-lock.mjs lively -- npx playwright test tests/e2e/lively.spec.ts -g "window: the cat goes up\|throws: several throws\|edge: clinging\|covered: an own window\|hunt: stalk"` | Windows | `60c408b` | 3 passed (window, throws, covered); hunt and edge failed in the harness (`Duplicate type name`), fixed in `8056318`; re-run of hunt and edge after the fix (`8056318`, the same app code): 2 passed, 8.5 min. Results in 03-windows-regression.md. |
| `node scripts/with-lock.mjs web-e2e -- npm run test:web` | Windows, Chrome 156.0.8078.76, Edge 156.0.4314.58 | `d97c36f` | 25 passed, 8 skipped, 54.2 s |
| `node scripts/with-lock.mjs payload -- node .claude/state/gv/payload-run.mjs` (build; `electron-builder --win dir` ×2; per-file SHA-256) | Windows | `8177ea1` | identical: 144 files |
| `node scripts/with-lock.mjs pkg-final -- node .claude/state/gv/pkg-final-run.mjs` (build; `electron-builder --win dir` with the committed config; asar listing; `scripts/smoke-packaged.mjs`) | Windows | `7940999` | pass: 0 errors, second instance exits 0, 0 login-item writes; app.asar 1,407,850 bytes, 0 out/web entries |
| `npm audit --omit=dev` / `npm audit` | Windows | `8177ea1` | 0 / 15 moderate (dev tooling, one minimatch advisory) |
| Container `verify-in-container.sh` (scripts in [evidence-linux/](evidence-linux/)) | Linux (Docker, Xvfb) | `8177ea1` (run 1), `d97c36f` (final), `60c408b` (rerun) | run 1: vitest 5 failed (host assumptions; fixed in `a033e96`); final: all steps pass; rerun: every step passes **with the Chromium sandbox on** (3755 tests; Xvfb phases A–C; the origin pixel is swallowed, as before) |
| Container `package-in-container.sh` | Linux (Docker) | `d97c36f`, `60c408b` | artifacts built at both commits. At `60c408b` the packaged tar.gz starts with its sandbox, keeps the test hooks off with `DESKTOP_CAT_TEST=1`, logs 0 errors, and refuses `--no-sandbox` (exit 1) |
| `node scripts/capability-matrix.mjs --check` | Windows | HEAD | up to date |
| 1.3.0 package: `npm run build && npx electron-builder --win nsis --publish never --config <electron-builder.yml with directories.output set to release/1.3.0>`, then `node scripts/smoke-packaged.mjs release/1.3.0/win-unpacked/DesktopCat.exe` (under `scripts/with-lock.mjs`) | Windows | `0ec2dd2` | installer 121,530,241 bytes, SHA-256 `57BEC0A7DE46EE6A7178620EC43D74877120C120DC70F8EFF4CBA2B280B113C7`; smoke pass (0 errors, second instance exits 0, 0 login-item writes) |
| `DESKTOP_CAT_E2E_LIVELY=1 … lively.spec.ts -g "throws: several throws"` | Windows | `ca7f0a2` (app code of `0ec2dd2`) | pass: 10 of 10 thrown (the first attempt, 6 of 10, was the harness flick; fixed in `2edf337`) |
| `DESKTOP_CAT_E2E_SOAK=1 DESKTOP_CAT_SOAK_MIN=120 node scripts/with-lock.mjs soak -- npx playwright test tests/e2e/soak.spec.ts` | Windows | `0ec2dd2`; `ca7f0a2`; `c8402a9` (same app code) | run 1: lost at 52 min (own test window closed from outside; no report). Run 2: full 120.1 min, failed its gesture check, 29 of 1,203 (harness timing, doc 13). Run 3, with the delivered-input oracle: **passed**, 120.1 min, 1,251 of 1,251 |
| Lively edge and covered, 1.3.0 | Windows | `c8402a9` | **pass.** Covered support (`c8402a9`): cover up at 148 ms, guard at 253 ms, **0 wrong clicks**; on the floor afterwards the overlay takes the mouse (positive control, 28 of 30 checks). Screen edge: two runs on the loaded machine (the desk in use) made 0 click-through checks, because the cat climbed down from the cursor within about a second, before the test's slower loop could check. With the check's diagnostics (`4d00e38`), 3 of 3 runs passed: 26, 17 and 17 checks over the clinging cat, **0 wrong**, the overlay never behind the own window, no overlay re-created |
| `node .claude/scripts/verify.mjs full` | Windows | `4d00e38` (plus the 1.3.0 documentation) | PASS: typecheck, lint, unit (3884 passed, 26 skipped, 1 todo), build, e2e (32 passed, 14 skipped: opt-in lively, soak and real-browser tests) |
| `node scripts/with-lock.mjs bench -- node scripts/bench.mjs --phase-sec=60`, then `--phase-sec=90`, then `.claude/state/gv/ab-bench.mjs` (v1.2.0's code and the current code, each built and run with `--phase-sec=90`, twice, back to back) | Windows | app code of `60c408b`; v1.2.0 `58b4cd6` | awake 1.33 / 1.39 / 1.48 / 1.15 % against v1.2.0's 1.23 / 1.31 % under the same conditions: no measurable regression. Gate B12 passed 2 of 4. See 10-performance-dependencies.md |

## Needs hardware or accounts

Each of these stays UNVERIFIED until it is run:

| Item | Needs |
|---|---|
| The whole macOS checklist ([04-macos.md](04-macos.md)): overlay, click-through, first click, Spaces, Retina plus 1×, Keychain, packaging, signing and notarization | a Mac (macOS 13+), an Apple Developer ID |
| Linux on real desktops: X11 sessions with compositing (GNOME on Xorg, KDE X11, Xfce, i3 + picom); Wayland sessions showing the explanation; tray, shortcut, keyrings, HiDPI; the packages on real distributions; the one-pixel origin gap on a real X server | Linux machines or VMs with desktop sessions |
| Android Chrome and iOS Safari running the web host | an emulator run, or devices (iOS needs a Mac for the simulator) |
| Windows 10; multi-monitor and mixed DPI; installing over 1.1.x/1.2.0; the installer-name rename (`upgrade-test.ps1`) | a disposable Windows user or VM, more displays |
| CI (ci.yml, and installer-check.yml for real install, upgrade and uninstall on a disposable runner) | the public repository; a first run checked step by step |
| Code signing (Windows Authenticode, macOS Developer ID) | certificates |
