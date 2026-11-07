# Windows regression report (GizeVerse foundation and release 1.3.0)

Machine and setup:
- Windows 11 Home 10.0.26200 x64; one 1920×1200 display at 125 %; auto-hide bottom taskbar.
- The same machine as the v1.2.0 report. The owner's installed GizeCat/Desktop Cat 1.1.1 was running and was never touched. No installer, install-test or upgrade-test was run.
- Code: branch `feat/gizeverse-foundation`. Commits are named per run below.
- Labels: REAL unless noted.

## 1.3.0: the first public release (2026-11-07)

Same machine. The owner's installed 1.2.0 kept running and was never touched; no installer, install-test or upgrade-test ran here. The application code is that of `0ec2dd2`; later commits change tests and docs only (`git diff 0ec2dd2 HEAD -- src package.json package-lock.json electron-builder.yml build resources` is empty). The interaction fix and its evidence: [13-interaction-reliability.md](13-interaction-reliability.md).

| Check | Result |
|---|---|
| Automated suites | **PASS**, not stale: `node .claude/scripts/verify.mjs full` on `4d00e38` plus this documentation: typecheck, lint, unit (**3884 passed**, 26 skipped, 1 todo; 198 of 200 files), build, e2e (**32 passed, 14 skipped**: the 12 opt-in lively scenarios, the opt-in soak and the opt-in real-browser test, all run separately or not needed for this release) |
| Packaged installer | `Desktop-Cat-Setup-1.3.0.exe`, 121,530,241 bytes, SHA-256 `57BEC0A7DE46EE6A7178620EC43D74877120C120DC70F8EFF4CBA2B280B113C7`, unsigned; NSIS, built from `0ec2dd2` into its own `release/1.3.0/` folder (the 1.0.0–1.2.0 installers are untouched) |
| Packaged smoke (`scripts/smoke-packaged.mjs` on that build's `win-unpacked`) | **pass**: the first instance stays up; a second launch exits 0 quickly; 0 error lines; 0 login-item writes. One warning: the owner's running cat holds the shortcut, as before |
| Real-app soak, 120 min, all gestures and perturbations (app REAL, input SIMULATED) | **pass**: 1,251 of 1,251 judged gestures landed; 0 stuck; T8 272/272 on the cat and 0 blocking off it; 18 renderer freezes recovered; 660 Win32 "up" readings during a hold ended no press; 0 recreates; heap main 11.4 → 20.3 MB. An earlier 120-minute run on the same app code failed its gesture check on harness timing (see doc 13) |
| Lively: throws through the real drag path (app REAL, input SIMULATED) | **pass**: 10 of 10 thrown, 0 dropped |
| Lively: screen edge beside an own maximized window; covered support | **pass.** Covered support (`c8402a9`): cover up at 148 ms, guard at 253 ms, **0 wrong clicks**; on the floor afterwards the overlay takes the mouse (positive control, 28 of 30 checks). Screen edge: two runs on the loaded machine (the desk in use) made 0 click-through checks, because the cat climbed down from the cursor within about a second, before the test's slower loop could check. With the check's diagnostics (`4d00e38`), 3 of 3 runs passed: 26, 17 and 17 checks over the clinging cat, **0 wrong**, the overlay never behind the own window, no overlay re-created |
| Installing, upgrading from 1.2.0, uninstalling | not run here (the owner's install). `.github/workflows/installer-check.yml` runs install-test.ps1 and upgrade-test.ps1 on a disposable GitHub-hosted runner once the repository is public: UNVERIFIED until it has run |

## Automated suites (GizeVerse foundation, `60c408b`)

| Run | Commit | Result |
|---|---|---|
| `node .claude/scripts/verify.mjs full` | `60c408b` | **PASS**, not stale: typecheck, lint, unit, build, e2e |
| Vitest (unit + integration) | `60c408b` | **3790 passed**, 26 skipped, 1 todo (192 of 194 files). v1.2.0: 3645 passed. The +145 are the new GizeVerse tests. |
| Playwright default suite (real app) | `60c408b` | **30 passed, 15 skipped**: the 12 opt-in lively scenarios, the opt-in browser test and 2 environment preconditions. The same split as v1.2.0. Includes the renamed Settings texts in lifecycle.spec.ts. |
| Web host E2E (`npm run test:web`) | `d97c36f` | 25 passed, 8 skipped by design (Chrome 156, Edge 156; [07-web-host.md](07-web-host.md)) |

## Behaviour on the real desktop (REAL lively scenarios, own windows, `DESKTOP_CAT_E2E_LIVELY=1`)

Run at `60c408b`; time ×8–12 through the test hook; own throwaway windows only.

| Scenario | v1.2.0 | Now |
|---|---|---|
| Window: up by itself, stays, leaves by itself; closing the window under it lands it | 3 stays of 136, 72 and 413 sim-s; 0 falls, 0 stuck | **pass.** 3 stays of 253, 116 and 278 sim-s, walking 4149, 2589 and 1339 px; 0 physics-error falls, 0 stuck resets. Window closed with the cat up → on the floor in about 1.07 s. |
| Throws through the real drag path (input SIMULATED) | 10 throws, 6 kinds | **pass.** 10 throws, all reacted, 7 kinds (startled jump, defensive ×2, avoid ×2, grumpy ×2, flight, hide, surprise); fear back to about 0, the cat watching again |
| Covered support | guard within about 93 ms, 0 wrong clicks | **pass.** Guard up 273 ms after the cover started (cover at 107 ms), **0 wrong clicks**. On the floor afterwards the overlay takes the mouse (positive control, 30 of 31 checks). |
| Hunt (cursor injected) | 9 of 10 runs passed; 0 interactive strikes in 93 | **pass** (re-run after the harness fix, below): 10 strikes, **0 with the overlay taking the mouse**, smallest strike clearance 50.6 DIP (smallest overall 25.3 DIP), 2 pounces |
| Screen edge beside an own maximized window | 24 click-through checks, 0 wrong; setting off: 0 climbs | **pass** (re-run): 17 click-through checks over the clinging cat, **0 wrong**; with the setting off, 0 visits and 0 clings |

**The first attempt of hunt and edge failed in the test harness, not in the app.**
- What happened: the spec's `realDeskIdleMs()` registered a named koffi struct on every call, so the second lively scenario in one Playwright worker threw `Duplicate type name 'DCAT_E2E_LASTINPUT'` before it ran.
- Since when: the helper is unchanged since v1.2.
- Fix: `8056318` binds it once per worker. The re-run is above.

## Packaging and packaged build

| Check | Result |
|---|---|
| Builder configuration moved per platform | **Equivalent.** The same `out/` packaged with the v1.2 config and with the new one gives 144 files, all SHA-256 identical ([evidence](evidence-windows-payload-diff.json)). |
| Web build excluded from the desktop package (review H1) | **Excluded.** The final app.asar has 115 entries and 0 under out/web (REAL, @electron/asar listing). |
| Packaged smoke (`scripts/smoke-packaged.mjs` on a fresh `--dir` build of the final code) | **pass:** the first instance stays up; a second launch exits 0 quickly; 0 error lines; 0 login-item writes. One warning: the owner's running cat holds the shortcut, as in v1.2. |
| app.asar size | 1.2.0: 1,365,288 bytes; now 1,407,850 bytes (+42.6 KB, +3.1 %: the platform layer, branding, the Settings platform view) |

The NSIS installer itself was not rebuilt: its configuration is unchanged, and installing is not allowed on this machine.

## Resource benchmark (REAL)

The current code and v1.2.0's own code were benchmarked back to back on the same machine. Awake CPU means were 1.34 % against 1.27 % (+0.07 pp), inside each build's run-to-run spread. Asleep, hidden and paused were equal or lower. Timers and handles were flat.
- **No regression is measurable.** One smaller than about 0.1 pp cannot be excluded.
- **Gate B12** (fixed 1.05 % baseline from v1.1.1) passed in 2 of 4 runs and failed narrowly in 2.

Table and reading: [10-performance-dependencies.md](10-performance-dependencies.md#resource-benchmark).

## What changed on Windows on purpose

- **Display strings say GizeCat.** Text that points at Windows entries still says "Desktop Cat" ([12-branding.md](12-branding.md)).
- **userData** is pinned explicitly to the same `%APPDATA%\Desktop Cat`.
- **A packaged build started with `--no-sandbox`** now refuses to start.
- **Settings** gains Diagnostics › Platform. The launch-at-login row is unchanged on Windows.

## Not verified on Windows

- Installing this build over the owner's 1.1.1 (not allowed here) and the installer-name rename, which waits for an upgrade test on a disposable machine.
- Windows 10, multi-monitor and mixed-DPI hardware, other scale factors, a docked taskbar: as for v1.2.
- A person using the cat for hours on this build; the REAL scenarios are minutes long and partly time-scaled.
