# Test report — Desktop Cat

Labels: **REAL** = executed and observed on the machine below; **MOCKED** = executed against fakes/mock servers; **SIMULATED** = real code driven with synthetic geometry/events; **UNVERIFIED** = not executed.

# v1.2.0 (2026-11-05): a lively cat

Code: branch `feat/v1.2-lively`, application code at `d96c4ab` (later commits change a bench script and docs only; nothing that ships). Installer `release/Desktop-Cat-Setup-1.2.0.exe`, 121,515,413 bytes, SHA-256 `02C05826675D7F946BDDAB7A1C28DE59F644E1651915EEEC70507EC17B1657B3`, unsigned; `release/win-unpacked` is its payload from the same `npm run package`. Same machine: Windows 11 Home 10.0.26200, one 1920×1200 display at 125 %, auto-hide bottom taskbar, Edge 156.0.4314.50, Chrome 155.0.8059.79, Windows Terminal 1.24.12741.0. The owner was at the desk during several runs, usually with a maximized window in front. Design: ADR 0003. Why the cat was passive and left tab strips early: [docs/research/v1.2/diagnosis.md](research/v1.2/diagnosis.md).

## Automated suites

| Tier | Result |
|---|---|
| `node .claude/scripts/verify.mjs full` at `d96c4ab` | **PASS**, not stale: typecheck, lint, unit, build, e2e |
| Vitest (unit + integration) | **3645 passed, 26 skipped, 1 todo** (177 of 179 files; the skips are opt-in real-browser tests, the long band tier and one marker) |
| Playwright default suite (real app) | **30 passed, 15 skipped**: 12 opt-in lively scenarios (run separately, below), the v1.1 opt-in browser test, and 2 environment preconditions (a maximized window in front of the taskbar or probe, as in v1.1) |
| Band matrix (`scripts/behavior-profile.mjs`, 8 seeds × 3 sim-h per cell; SIMULATED: real Sim, Mover and host loop, synthetic user) | every band passes except 3 narrow checks, below. Raw: `docs/research/v1.2/profile-v12.json` |

## Before and after (SIMULATED, same harness; baseline = v1.1.1 behaviour, `profile-baseline.json`)

| Metric | P1 (the owner's cat and settings), floating browser | P2 (defaults), floating browser |
|---|---|---|
| Active share of awake time | 19.0 % → **31.8 %** | 12.9 % → **27.1 %** |
| Median stay up there (Kaplan–Meier) | 74 s → **177 s** | 89 s → **170 s** |
| Stays over 5 min | 3.7 % → **29.4 %** | 1.5 % → **26.8 %** |
| Cursor chases (v1.1.1) or hunts (v1.2) per hour, ordinary use | 1.04 → **1.92** | 0.29 → **1.92** |
| Pounces per hour, ordinary use (baseline from the diagnosis's older user model) | 0.08 → **0.92** | 0 → **0.83** |
| Hides after a hard throw | 81 % → **15.9 %** | 57 % → **14.5 %** |
| Own trips up per hour | 12.8 → 6.8 (longer stays) | 10.1 → 7.1 |
| Physics-error falls, stuck resets | 0, 0 | 0, 0 |

Also: playing with the pointer 6.6–7.2 hunts and 4.2–5.0 pounces per hour, smallest gap 247 s; 0 hunts while typing; throws give 9 reaction kinds, none above about 25 %, moods recover (160/160); two windows give 4 ways off, none above 37 %; nothing to climb but screen edges 3.1–3.7 visits per hour, 0 with the setting off or without the host's edge bands; a cat nobody pets keeps its stays (142 s experienced median) since the review.

**Bands not met, narrowly:** hunts while working with the mouse 1.38/h against ≤ 1 on one cell (pounces near a press stay 0); window climbs 12.3/h against ≤ 12 on the window-churn cell; one seed of "active share with a maximized window ≤ the same seed's floating window". **Changed by lead decision, with the measurements in ADR 0003 §14:** asleep floor 5 % instead of 8 % (the real handling rate ends most naps); typing excursion ratio up to 0.9; P(> 15 min) monitored, not gated; leave variety measured on a two-window layout; the short band budget is a runaway guard, not 20 s (about 5 s alone, 32.8 s of CPU in the loaded suite on this shared hybrid CPU).

## Real-Windows checks on the final code (REAL unless noted)

Own throwaway windows and browsers only, closed afterwards; the owner's windows and installed app were never touched. Sim-seconds are at time ×8–12 through the test hook.

| Scenario | Result |
|---|---|
| **Packaged build** (`scripts/qa-traversal-packaged.mjs`, no test hooks, real time, typical window) | up by itself within about 1 min (seen on a side, then the top); 3 stays: 36.8 s (ended by someone dragging the cat at the desk), 299.3 s (arrived carried) and 65.2 s (arrived by climbing), the last two ended by a climb-and-leap; window closed → back on the floor; 0 error lines; `DESKTOP_CAT_TEST=1` ignored. Raw: `docs/research/v1.2/qa-traversal-packaged.json` |
| Window (dev build) | fresh cat, 3 stays of 136, 72 and 413 sim-s, 1,170–4,559 px walked, each left by itself (climb down, climb and leap); window closed with the cat up → on the floor in about 1 s; 0 falls, 0 stuck |
| **Edge 156 dwell** (own instance, floating) | strip found on the floor; 5 stays of 70–614 sim-s, median 166, all ended by the cat's own choice (climb down 2, climb and leap 3), through up to 21 ordinary geometry updates (new tabs, moves, resizes of the own window); stays followed their plan closely; 0 lost to an update |
| **Chrome 155 dwell** (same) | 5 stays of 68–326 sim-s, median 301, all its own choice (climb down 2, climb and leap 3), through up to 11 updates |
| Hunting (cursor injected: input SIMULATED, app REAL) | stalk, crouch, pounce and bat seen; 9 of 10 runs passed with 93 strikes, 0 with the overlay taking the mouse, smallest clearance 45.4 DIP. **One earlier run saw the overlay interactive in 2 of 25 strike samples** (smallest strike clearance there 88 DIP). Renderer hit rects arriving late at a high time scale is a hypothesis; it did not recur in 9 runs with extra logging, so the cause is UNVERIFIED |
| Throws (real drag path, input SIMULATED) | 10 throws: grumpy 3, flight 2, hide 2, defensive 1, shrug 1, startled jump 1; fear back to 0, cat walking again |
| Screen edge beside an own maximized window | peeks only (6.6 s, 160 px high, ended by itself); 24 click-through checks over the clinging cat, 0 wrong; setting off: 0 climbs |
| Covered support | an own window maximized over the cat: guard up within about 93 ms of the cover, 0 wrong clicks, a jump, no free fall; on the floor afterwards the overlay takes the mouse (positive control) |
| Sound | a throw's cue opened an audio context; switching sound off closed it |
| Windows Terminal | helper probe on an own window passed: protocol 2, 2 tabs, 1.34 ms per read (max 2.49), owner memory +0.2 MB, helper 23.8 MB private, a new tab raised an event in 97 ms. **The cat walking a Terminal strip in the real app: UNVERIFIED**: the E2E skipped because the owner's Terminal shares the process, so its own window cannot be isolated (SIMULATED through the real pipeline only) |
| Packaged app | smoke: first instance stays up, second launch exits 0, 0 errors, 0 Run writes (1 warning: the owner's running cat holds the shortcut); fuses unchanged; helper protocol 2, per-monitor-v2 |

**Real bugs only the desktop showed, fixed with regression tests:** a cursor or typing during the mount left the cat 24 s on a screen edge (decisions waited out a hold); strip stays of 0 s right after a real one (a trip now names the surface its target lies on); a cat on the floor near a screen side could not be clicked, petted or grabbed over a window (found by review, RES-1).

## Adversarial review (REAL)

5 dimensions against the brief's failure list, each finding independently verified: **26 findings, 25 confirmed (2 high, 7 medium, 16 low), 1 refuted**. All fixed with regression tests, except that a cue playing when the cat is paused or sound goes off keeps a tail of at most 2.4 s (documented). The two high ones: a cat nobody pets had every stay cut to about 60 s (the bands assumed heavy handling; a hands-off band cell now gates it), and RES-1 above. Details in ADR 0003, "As built".

## Resource benchmark (REAL, `scripts/bench.mjs --phase-sec=90 --lively`)

CPU in % of one core over all app processes. Raw: `docs/bench/bench-2026-11-05T09-12-54-630Z.json`. Gate B12 passes.

| Phase | v1.1.1 | v1.2.0 avg (max) | Private MB | Timers / handles |
|---|---|---|---|---|
| Awake | 1.05 % | **0.91 %** (1.23 %) | 336 → 340 | 5 → 5 / 7 → 7 |
| Asleep | 0.66 % | 0.63 % (0.91 %) | 342 → 328 | 5 → 5 / 7 → 7 |
| Hidden | 0.03 % | **0.02 %** (0.03 %) | 333 → 334 | 5 → 5 / 7 → 7 |
| Paused | 0.58 % | 0.57 % (0.59 %) | 329 → 330 | 5 → 5 / 7 → 7 |
| Lively (own windows, injected cursor) | n/a | 1.06–1.13 % (1.56 %) | 345 → 355 | 5 → 5 / 11 → 7 |

0 tick errors, 0 errors, 1 warning (the owner's running cat holds the shortcut). Machine load differed between the runs. **Not measured:** the tab-strip helper's sustained CPU inside the app (the bench's sampler found no helper in its lively runs, whether idle or missed is UNVERIFIED) and the cost while the cat stays on a surface specifically. Upper bound from the REAL probe: at most about one read per second at about 1.3 ms, plus 23.8 MB private while it runs.

## Not verified in v1.2 (UNVERIFIED)

- **Installing 1.2.0 over the owner's running 1.1.1**: not done here (the NSIS installer would replace the running app; `install-test.ps1` also refuses while the production startup entry exists). Same installer configuration whose install, upgrade and uninstall passed REAL for 1.1.0. The settings v2 → v3 migration and the 1.1.1 downgrade round trip are tested on files (SIMULATED), not on the owner's install.
- The cat on a real Windows Terminal strip; File Explorer tab strips ship **off** (its soak was not run); Notepad, VS Code and other Electron apps and Firefox are never queried; maximized windows offer nothing to climb.
- The owner's own browsers (profiles, extensions, toolbar layouts); long runs (hours) of the lively behaviour; a real user throwing the cat (input SIMULATED through the real drag path).
- Sound quality (nobody has listened to it); new poses reviewed in preview sheets by the renderer engineer, not on a live desktop by a person.
- Multi-monitor, mixed DPI hardware, Windows 10, a docked always-visible taskbar, scales other than 125 %.
- Earlier items still open: a real reboot or sign-in start, the cat riding a physically revealed taskbar, a standard-user token.

# v1.1.1 (2026-10-29): the cat never left the floor

Code: branch `feat/v1.1-surfaces`, application code at `19cd1dd` (later commits change tests, scripts and docs only; nothing that ships). Installer `release/Desktop-Cat-Setup-1.1.1.exe`, 121,464,882 bytes, SHA-256 `D7B52F171FC0DA1C726AFE39A23EE67814236B63978D5B709D3B431DBB8EF36D`, unsigned; `release/win-unpacked` is its payload from the same `npm run package`. Same machine as below: Windows 11 Home 10.0.26200, one 1920×1200 display at 125 %, auto-hide bottom taskbar, Edge 156.0.4314.50, Chrome 155.0.8059.79. The user was working at the desk during the runs (maximized windows in front much of the time; they dragged test windows and the test cat in early runs).

## Reported failure, reproduced (REAL)

- The installed 1.1.0 (`%LOCALAPPDATA%\Programs\DesktopCat`) is byte-identical to the release build (`app.asar`, `DesktopCatUia.exe` SHA-256). Its own records after ~23.5 min awake: `windowsInspected 0`, no favourite spots, support `floor`, boredom 0.02; nothing disabled in settings. `main.log` had no surface counts at all — the failure was invisible.
- Window layout snapshot (geometry/class/exe only, no titles): three maximized windows (one in front) cover the whole screen; the floating windows end 82–485 px above the floor with tops 907–1095 px above it.
- Dev build with test hooks, own userData and own throwaway windows (time ×8): a typical window `[308,140,1284,892]` was never reached (0/913 samples over 1920 sim-s); an own floating Edge window was never measured (tab strips *idle* 43/43 checks, like the user's log); a small window within jump reach was reached only after raising boredom to 0.6.
- Headless replay of the real geometry through the real provider/world/graph/sim (SIMULATED): 0 surfaces with the maximized window in front; 0 edges from the floor to any floating window; browser climbs reversed at the corner (0/25 reached a top).

Root causes RC1–RC7 and why the tests missed them: [docs/research/v1.1.1-floor-only-diagnosis.md](research/v1.1.1-floor-only-diagnosis.md). Design: ADR 0002 §4.

## Automated suites

| Tier | Result |
|---|---|
| `node .claude/scripts/verify.mjs full` (final tree) | **PASS** — typecheck, lint, unit, build, e2e (final run on the committed tree, not stale) |
| Vitest (unit + integration) | **3078 passed, 2 skipped** (139 files; the 2 skipped are the opt-in real-browser UIA tests) |
| Playwright E2E (real app) | **30 passed, 3 skipped** of 33: the opt-in browser test (run separately below) and two environment preconditions that held because a maximized window was in front of the taskbar/probe (*taskbar topmost before start*, *small probe really topmost*), as in v1.1.0 |
| Opt-in real-browser E2E (`DESKTOP_CAT_REAL_BROWSER=1`, `…_KIND=chrome`) | Edge and Chrome: **passed** (REAL, below) |

New coverage: leap edges for side feet 40–480 px above the floor at 100/125/150 % with the app's floor inset (and their absence beyond reach); the user's five real window frames reached end to end; continuous leap physics (bounded per-tick motion, exact parabola), cling, climb, pull-up, walk; tab strip replacing the top mid-climb (and the reverse), window closed mid-climb, side vanishing mid-leap, drag/throw mid-leap and mid-climb; landing spans (pull-up beside a strip, walk-in, no stall/snap/glide on drops, dismounts, lifts); tab-strip interest for far visible browsers, top fallback, top held while clinging; selection beyond the nearest candidates, retry cooldowns, explore urge (personality, typing, reset), liveness with the user's profile (≥ 90 % of 20 seeds up within 10 sim-min; 3–15 trips/sim-h; ≥ 1/sim-h while typing heavily; 0 with nothing reachable); diagnostics producers, verdict (every branch incl. `frontMaximized`, `noWayUp`), schema, IPC sender checks, session-only outlines (DIP conversion, ≤ 4 Hz, suppressed while hidden/fullscreen), summary log rate limit; an integration suite composing the app's real pipeline on a virtual clock (32 tests; 28 of them fail on the pre-fix code, 11 on the stage-1 code without the behaviour fix).

## Real-Windows checks (REAL)

| Area | Check | Result |
|---|---|---|
| **Packaged build traversal** | `scripts/qa-traversal-packaged.mjs`: `release/win-unpacked/DesktopCat.exe` (fuses on, no test hooks), own userData, real time; own always-on-top window of typical size `[297,180,1334×832]` (top 1015 px above the floor, bottom 183 px above); observed through the app's own `surfaces summary` log lines | 10 s: on the floor, verdict *exploring*, 1 top + 2 sides reachable; **2 min 20 s: on the window's side; 3 min 20 s: on its top (excursion 1)**; then down by itself; window closed → back on the floor; 0 errors; `DESKTOP_CAT_TEST=1` ignored (boot `packaged:true, test:false`). Raw: `docs/research/v1.1.1-evidence/qa-traversal-packaged.json` |
| Diagnostics, user's situation | first attempt of the same check: the test window had not reached the topmost band (fixed by re-asserting `HWND_TOPMOST` on it) and sat behind the user's maximized window | the packaged app logged verdict `frontMaximized`, 0 surfaces, for 10 min — exactly the user's situation, now visible in the log and on the Diagnostics page |
| Dev build traversal (E2E) | `surfaces.spec.ts` "REAL traversal", fresh cat, time ×12 | two full runs: first on a side at 128.9 / 165.2 sim-s, on the top at 137.8 / 174.2 sim-s (11.5 / 14.5 s wall) via 1 leap + 1 pull-up, walked 404 / 482 px along it; window closed → on the floor 110 / 239 ms later |
| Edge 156 tab strip (E2E, opt-in) | own Edge, temp profile, floating `[296,180,1328×832]`, not maximized | strip measured 9 ms after start while the cat was on the floor (`land` 306–1614 around the strip 403–1190); cat on the strip at 153 sim-s (1 leap, 1 pull-up), walked 366 px; Edge closed gracefully, profile deleted |
| Chrome 155 tab strip (E2E, opt-in) | own Chrome, temp profile, same size | strip measured 15 ms after start; cat on the strip at 273 sim-s (1 leap, 1 pull-up), walked 846 px; Chrome closed gracefully, profile deleted |
| Packaged app | `npm run package`, `@electron/fuses read`, `smoke-packaged.mjs`, helper `--version`, asar contents | fuses unchanged (RunAsNode/NODE_OPTIONS/inspect off, asar integrity + only-from-asar on); smoke: first instance stays up, second launch exits 0, 0 errors, login item gate closed, 0 Run writes (1 warning: the global shortcut is held by the user's running 1.1.0); helper protocol 1, per-monitor-v2 (helper source unchanged since 1.1.0; the rebuilt exe differs only by compiler-embedded ids); `app.asar` contains the v1.1.1 code |
| Resource benchmark | below | |

## Resource benchmark (REAL, `scripts/bench.mjs --phase-sec=90`)

Dev build of the same code. CPU in % of one core over all app processes. Raw: `docs/bench/bench-2026-10-29T14-55-28-100Z.json`. No browser was open, so the tab-strip helper did not run (it is sampled now when it does).

| Phase | CPU avg (max) | Private MB | Timers / handles |
|---|---|---|---|
| Awake, kept active (33 % of samples napping) | 1.05 % (1.23 %) | 335 → 355 | 5 → 5 / 7 → 7 |
| Asleep | 0.66 % (1.05 %) | 364 → 357 | 5 → 5 / 7 → 7 |
| Hidden | **0.03 %** (0.07 %) | 301 → 301 | 5 → 5 / 7 → 7 |
| Paused | 0.58 % (0.60 %) | 311 → 316 | 5 → 5 / 7 → 7 |

Against v1.1.0 (0.95 / 0.58 / 0.02 / 0.54 %) about +0.04–0.10 % of a core (the 2 s look-around for reachable targets, the 10 s summary-log check — the 5th timer); machine load differed between the runs. 0 tick errors, 0 errors, 1 warning (the shortcut held by the user's running cat).

## Adversarial review (REAL)

5 dimensions (movement, behaviour, provider/tab strips, security/privacy, performance) over the v1.1.1 diff, each with an independent verifier: **13 findings, 12 confirmed (3 medium, 9 low), 1 refuted, 0 critical/high**. All 12 fixed with regression tests (each fix reverted once to confirm its test fails): a drop from beside a tab strip stalled or snapped the cat; dismounts/lifts onto a landing span glided or snapped; a too-narrow strip left a browser without a top; the verdict said *exploring* when only dead-end sides were reachable; "heading for" reported look targets; the helper never idled while a floating browser was visible (even with the cat asleep) and far browsers were re-described at 50 ms; useless browsers took far slots; outlines stayed drawn while the cat was hidden or over fullscreen apps.

## Not verified in v1.1.1 (UNVERIFIED)

- **Installing 1.1.1 over the user's running 1.1.0** on this machine: not done. The user's cat is running, and the NSIS installer first uninstalls the registered installation, which would replace the user's running app; `install-test.ps1` also refuses to run while the production startup entry exists. The installer uses the same electron-builder/NSIS configuration whose install, upgrade (1.0 → 1.1), startup registration and uninstall passed REAL for 1.1.0 (below); the 1.1.0 → 1.1.1 upgrade itself was not observed.
- The user's own browsers (their profiles, extensions, toolbar layouts) — only own instances with temp profiles were used; the user's own windows were never moved, focused or clicked.
- Maximized windows: by design nothing to climb (reported as such).
- Multi-monitor, mixed DPI hardware, Windows 10, a docked (always shown) taskbar, scales other than 125 % (100/150 % SIMULATED only), Firefox and vertical tabs (not supported).
- Long runs (hours), and the tab-strip helper's cost while resident for long periods (its per-read cost and memory were measured REAL in v1.1: 0.8–1.7 ms per read, ~22 MB private).
- A user dragging or throwing the cat mid-leap on the real desktop (SIMULATED and covered by unit/integration tests).
- Earlier v1.1 items still open: a real reboot/sign-in start, the cat riding a physically revealed taskbar, the one-time tray notice actually appearing, a standard-user token.

# v1.1.0 (2026-10-29)

Code: branch `feat/v1.1-surfaces`. The install, upgrade and probe runs below used an installer built from `9b5314c`; the final `release/Desktop-Cat-Setup-1.1.0.exe` was rebuilt from `b4a339b` (identical application code — that commit only changed documentation and the shipped `THIRD_PARTY_NOTICES.md`) and passed the packaged smoke test again. SHA-256 `73D24CB942912A018D82AD2EDFE216EC29C93999B714FD5C0455E9F85926F870`, 115.8 MB, unsigned. Same machine as v1.0 (below): Windows 11 Home 10.0.26200, one 1920×1200 display at 125 %, auto-hide **bottom** taskbar, Edge 156.0.4314.50, Chrome 155.0.8059.79. During the final runs the user had a full-monitor Chrome window in front (this strips the taskbar's topmost flag — a Windows behaviour, see below).

## Automated suites

| Tier | Result |
|---|---|
| `node .claude/scripts/verify.mjs full` | **PASS** — typecheck 0 errors (node + web), lint 0 problems, unit, build, e2e |
| Vitest (unit + integration) | **2834 passed, 2 skipped** (118 files). The 2 skipped are real-browser tests gated by `DESKTOP_CAT_REAL_BROWSER=1`; run with the flag they passed (REAL, Edge + Chrome) |
| Playwright E2E (real app) | **28 passed, 2 skipped** of 30 (6 + 1 new spec files). The 2 skips are environment preconditions that held during the final run: *taskbar topmost before start* and *probe window really topmost* — both were false because of the user's full-monitor Chrome window (verified with a read-only check: taskbar `WS_EX_TOPMOST` already cleared with Desktop Cat not running; Windows' hit-test at the probe's edge returned another window). Both tests passed REAL earlier in the session (30/30 at `0413285`) when no fullscreen window was in front |

New coverage (all deterministic): login-item reconcile tables, a FakeWindowsLogin mirroring Electron's quoting/StartupApproved rules, migration v1→v2 (true/false/missing/corrupt, opt-out evidence), property test "no automatic re-enable after an opt-out"; taskbar discovery/state machine/cadence/click guard (incl. hidden secondary taskbars, Explorer restart, flapping); surface provider (occlusion, rounded-corner insets at 100/125/150 %, riding through fast drags/resizes, calm drops when covered, private windows, tab-strip replacement); surface graph, climbing, pull-up, lifting/lowering ledges, retraction without fear, 50 taskbar flaps in 10 s, fuzz with dynamic taskbars/walls/tab strips (invariant: a visible cat never stays inside a shown taskbar); UIA protocol client (timeouts, malformed/oversized lines, crash/stall budgets, per-window quarantine), segment math; climb clip poses, hit rects (paws only past the wall line), presence margins.

## Real-Windows checks (REAL)

| Area | Check | Result |
|---|---|---|
| Launch at sign-in | `scripts/install-test.ps1` with the 1.1.0 installer, installed into `%TEMP%\dcat install <rand>` (path with a space) | exit 0, `ok: true`: first start registered exactly `"…\dcat install ad852307\DesktopCat.exe" --launched-at-login` and no StartupApproved value; a stale path was **repaired**; a Task Manager disable (`03`+FILETIME) was **left untouched** (rule `windows-disabled`); upgrade kept both values; uninstall (`Uninstall DesktopCat.exe`) removed both and wrote the reinstall marker; cleanup left nothing |
| Upgrade 1.0 → 1.1 | `scripts/upgrade-test.ps1 -OldInstaller …1.0.0.exe` with a v1-shaped `settings.json` (`launchAtLogin:false`) | exit 0, `ok: true`: both installers exit 0, one uninstall entry (1.1.0); settings migrated to schema 2 (name and coat kept, `launchAtLogin` removed, `loginItem` = unset/default with `v1Value:false`); startup registered with the exact installed path; uninstall removed Run + StartupApproved |
| Registry/quoting | `scripts/login-item-probe.mjs`, `tests/integration/win32/registry.real.test.ts`, NSIS `customUnInstall` harness (makensis 3.0.4.1) | all pass: byte-exact match with Electron's quoting incl. spaces/non-ASCII (149-char golden string); StartupApproved rule agrees with Electron on 6 byte patterns; 7 registry and 11 uninstaller cases; unique test value names, cleanup confirmed |
| Packaged app | `npm run package`, fuses, `smoke-packaged.mjs` | `release/Desktop-Cat-Setup-1.1.0.exe` (115.8 MB, unsigned); fuses as v1.0; `resources/native/DesktopCatUia.exe --version` → protocol 1, per-monitor-v2; smoke: 0 errors/warnings, second launch exits 0, login item gate closed (`DESKTOP_CAT_LOGIN_ITEM=off`, no uninstaller next to win-unpacked) |
| Taskbar vs overlay | `scripts/taskbar-probe.mjs` (earlier in the session, no fullscreen window in front) | with `NonRudeHWND` the taskbar kept `WS_EX_TOPMOST` in 41/41 samples and the bottom reveal row hit-tested as the taskbar; **control** without the fix: topmost lost after 63 ms and the reveal strip stopped hit-testing — the v1.0 overlay had this defect |
| Taskbar transition | observed passively (no synthetic input): a first-run Welcome window started from a background process revealed the auto-hide taskbar | Explorer slid it in over ~190 ms in ~9 visible steps and out over ~400 ms; the real tracker followed showing → shown → hiding → hidden, the ledge appeared at 54 % shown, one `taskbar.shown` and one `taskbar.hidden` event. The reveal was caused by a refused focus request and pinned the taskbar open (36/38 samples); fixed — the app-initiated Welcome window opens inactive: 0/38 (`scripts/qa-taskbar-firstrun.mjs`) |
| Window surfaces | own throwaway topmost window (separate Electron process) | `windowTop` at the DWM frame top (rounded corners inset ≥ 10 px), left/right walls; a programmatic move followed within 5 s; minimize removed its surfaces |
| Tab strips | `scripts/uia-probe.mjs --browsers edge,chrome` with own throwaway instances (temp profiles) | Edge 156 and Chrome 155: strip, 3 tabs, new-tab/caption buttons located; walkable segment excludes them; `tabs.changed added` ~180 ms after a new tab; helper 22 MB private / 31 MB working set; **no web-accessibility activation** (browser growth +0.1–0.3 MB) while a positive control with a naive query was detected (+75–78 MB); maximize removes the strip; instances closed gracefully, profiles deleted. A suspended (hung) own Edge for 45 s: 2 timeouts, feature stayed available, strip back after resume |
| Climbing art | preview sheets (`render-preview.cjs --only=climb*`) | all skins, both facings, smooth/pixel, transitions walk → climb → pull-up → stand reviewed visually |

## Resource benchmark (REAL, `scripts/bench.mjs --phase-sec=90`)

Code at `0413285` (before the review fixes, which only lowered taskbar sampling further). CPU in % of one core summed over all processes. Raw data: `docs/bench/bench-2026-10-29T04-41-25-454Z.json`.

| Phase | CPU avg (max) | Private MB | Timers / handles |
|---|---|---|---|
| Awake, kept active (grooming, resting; 44 % of samples napping on this idle machine) | 0.95 % (1.06 %) | 338 → 383 | 4 → 4 / 6 → 6 |
| Asleep | 0.58 % (0.79 %) | 388 → 369 | 4 → 4 / 6 → 6 |
| Hidden | **0.02 %** (0.04 %) | 314 → 312 | 4 → 4 / 6 → 6 |
| Paused | 0.54 % (0.56 %) | 323 → 329 | 4 → 4 / 6 → 6 |

Compared with v1.0 (asleep 0.55 %, hidden 0.03 %, paused 0.53 %), the new observers cost ≈ 0.03 % of a core at rest. 0 warnings/errors, 0 tick errors. Main heap 12 → 15 MB over ~7 min (within GC noise for this duration; longer runs UNVERIFIED).

## Adversarial review (REAL)

7 dimensions over the v1.1 diff with an independent verifier each: **57 findings, 48 confirmed, 9 refuted, 0 critical/high**. All 36 code findings fixed with regression tests (mutation-checked by the fix agents); 12 documentation findings corrected. Notable: the cat on the auto-hide floor made the reveal strip interactive; a perched cat fell when its window was dragged fast or covered, or when the browser's tab strip was discovered; one hung browser disabled tab strips for the session; the diagnostics export leaked the Windows user name through the registered path; status stayed wrong after re-enabling in Task Manager.

## Not verified in v1.1 (UNVERIFIED)

- An actual **reboot / sign-in** that starts the app from the Run key (registration, quoting and repair were verified on a real install; the start by Windows was not observed).
- The cat **riding a physically revealed taskbar** under a real mouse (the reveal itself was observed; riding was SIMULATED through the real app with injected geometry).
- The one-time tray notification actually appearing (its delivery is tested against a mocked Electron; `noticeShown` stayed false in the upgrade run).
- Standard-user (non-elevated) token: this session ran with a high-integrity token; no step requires elevation by design (`asInvoker`, HKCU only).
- Multiple monitors, secondary taskbars, top/left/right taskbars (not ledges by design), mixed DPI hardware, Windows 10, Firefox (not supported), vertical tabs, long runs beyond ~7 minutes.

# v1.0.0 (2026-10-28)

Code: branch `feat/desktop-cat-v1`, installer built from commit `6ca2bec`.

## Environment

Windows 11 Home 10.0.26200 x64 · one display 1920×1200 at 125 % (1536×960 DIP) · auto-hide taskbar (work area = full screen) · Node 26.4.0 (host tools) · Electron 44.9.3 (Chromium 152, Node 24.22) · shared PC: every heavy run went through the machine-wide lock (`scripts/with-lock.mjs`).

## Static checks — REAL

| Check | Result |
|---|---|
| `tsc -p tsconfig.node.json` and `tsconfig.web.json` (TS 6.0.3 strict, `noUncheckedIndexedAccess`) | 0 errors |
| `eslint .` (typescript-eslint type-checked rules, no-floating-promises, import boundaries for core/shared/renderer) | 0 problems |
| `npm audit --audit-level=high` (all dependencies, incl. Electron and zod) | 0 vulnerabilities |

## Unit and integration tests (Vitest 5) — REAL / MOCKED

`npx vitest run` → **88 files, 1128 tests, all passed**.

| Area | Highlights |
|---|---|
| Behaviour & movement (`tests/unit/core/behavior`, `movement`; 20 files, 201 tests) | transition-table validity; 200k-tick randomized fuzz (no illegal transition, dwell/cooldown/thrash invariants, finite outputs, always inside the world); every behaviour toggle honoured individually and together; physics (exact jump arcs, landing without tunnelling at 250 ms ticks, perch riding, platform loss, throws, pounce); multi-monitor with mixed DPI/negative coordinates/display removal; never walks onto a fullscreen display; quit → `quitReady` ≤ 900 ms; sim time tracks real time with timer lateness; wake-up stretch on every start; tap reactions; capped ignored calls; playful dodge; private windows never followed or perched on; calmer with windowed video; persistence round-trip and corrupt-state recovery; 2-hour behaviour mix × 6 seeds (91 % calm states, 1.3 % active) |
| Win32 & awareness (`tests/unit/win32`, `tests/integration/win32`) | tracker coalescing/bounded queues/reconcile/polling fallback; platforms with z-order occlusion (excluded windows filtered); fullscreen rules incl. auto-hide taskbar; privacy masks cover dialogs/tool windows/popups; titles read only while analysis is enabled; activity heuristics; **REAL koffi calls in plain Node** (structural assertions only, no titles printed) |
| Display & interaction (`tests/unit/core/display`, `interaction`) | DIP↔px conversion for mixed DPI and negative origins; floor inset; gesture recogniser (tap, double tap, drag velocity, pet strokes); click-through gate hysteresis/staleness |
| Perception & AI (`tests/unit/core/perception`, `tests/unit/perception`, `tests/integration/perception`) | analysis on synthetic frames; 3-frame burst motion, video-like/new-element labels; privacy-gate matrix incl. loopback tricks, real-foreground verdict, full-region masks; consent/pause/lock/exclusion blocks; post-capture mask re-check; masking before resize; no lingering display images; cloud-model detection fail-closed; limits and circuit breaker; AI-output fuzz (fences, prose, injection text, schema violations); adapters against **MOCKED** `node:http` servers (success, 500, malformed, slow → timeout, oversized, redirect) |
| Main shell (`tests/unit/main`) | atomic JSON store (backup, quarantine, ENOENT vs read errors), secrets never backed up, settings/cat stores, startup state, logger redaction and resilience, crash guard, quit sequencing, shortcut validation, render mapping, IPC validation and rate limits, host loop timing and catch-up |
| Renderer (`tests/unit/renderer`) | every clip × skin × detail level produces finite poses (MOCKED canvas); blending continuity; reactions (ear flick, tail flick, head tilt); 60/30/20 fps policy; tail stability under extreme dt; interpolation; hit regions; settings UI logic (patches, validation, live polling, truthful privacy copy, memory-label drift) |
| Shared (`tests/unit/shared`) | settings schema defaults/recovery/migration, strict patches, consent-bypass guard |

## End-to-end (Playwright 1.64 driving the real Electron app) — REAL

`npm run build && npx playwright test` → **22 passed** (6 spec files, ~60 s). Each test uses its own temp userData.

- One overlay per display: transparent background, non-focusable, topmost, tool window, ignoring the mouse by default (window styles read back from Windows).
- OS hit-testing (`WindowFromPoint` via koffi from the test process) passes through the overlay away from the cat and hits it only where the cat is interactive; interactions-off keeps everything click-through.
- A hung overlay renderer (infinite loop) is made click-through and recreated within ~11 s; live overlays never flagged over 10 s.
- Malformed and flooding IPC dropped without crashing; IPC from an unregistered window refused; nothing secret echoed.
- Settings persist across restart; quit saves the cat and a restart restores its position; corrupt settings/cat files quarantined; truncated cat file falls back to `.bak`; start state *hidden* and *as I left it (paused)* survive a restart.
- Single instance: second launch exits 0 and the first surfaces the cat.
- First run shows Welcome; pause, hide, show, resume, quit (exit 0, no error log lines).
- Stress: 25 rapid pause/hide/show/resume cycles → no growth in IPC/power/screen listeners, timers or handles, overlay count unchanged, 0 errors; 3 close/reopen rounds → one cat each time, exit 0, no error log lines.
- Perception off by default and never captures; API key stored encrypted, never echoed, logged or exported.

## Desktop and platform checks — REAL

| Check | Result |
|---|---|
| Feasibility spike (`scripts/spike-overlay`): full-work-area transparent overlay at 59 fps | GPU process ≈0.4 % CPU, renderer ≈0.2 %; idle overlay 0 %; WinEvent hooks delivered on Electron's main thread; `WindowFromPoint` passes through when ignoring the mouse |
| `scripts/qa-desktop.mjs` — real app on the real desktop | cat composited with per-pixel transparency over the window beneath (visually inspected; captures deleted); starts with the intro nap and wake-up stretch; 0 tick errors, 0 warnings/errors, window awareness `event-hooks`, exit 0 |
| `scripts/qa-settings.mjs` — settings window against the real main process | 10 pages × light/dark: 0 console errors/CSP violations, no horizontal overflow, 0 log problems |
| `scripts/win32-probe.cjs` (Electron) | 31/31 checks: hook mode active, per-monitor DPI awareness, one event per change of its own test window (shown/minimised/restored/closed, 150–182 ms latency), own windows not private, `WindowFromPoint` skips the click-through overlay, DIP↔px matches Electron's conversion to 0 px |
| Finding | `SHQueryUserNotificationState` reports `busy` while our full-work-area overlay is up → treated only as a soft signal |
| Art preview sheets (`scripts/render-preview.cjs`) | every clip, skin, style, scale on light/dark backgrounds visually reviewed; render cost 0.10 ms/frame smooth, 0.32 ms pixel (software raster, JS side) |

## Resource benchmark — REAL

`node scripts/bench.mjs --phase-sec=90 --sample-sec=10` (real app, dev build, test hooks used only to switch phases). CPU is `app.getAppMetrics()` summed over all app processes, in % of **one** core. Working set is summed over processes (shared pages counted more than once); private bytes are the non-shared part. Raw data: `docs/bench/`.

**Run 2 — final code (30 fps when calm), `docs/bench/bench-2026-10-28T17-26-30-369Z.json`:**

| Phase | States seen | CPU avg (max) | Private MB | Working set MB | Main heap | Timers / handles |
|---|---|---|---|---|---|---|
| Free (cat chooses) | resting, sleeping (44 % of samples asleep) | 0.70 % (1.02 %) | 340 → 351 | 565 → 582 | 11 → 11 MB | 4 → 4 / 6 → 6 |
| Asleep | sleeping (100 %) | 0.55 % (0.69 %) | 360 → 373 | 590 → 605 | 11 → 12 MB | 4 → 4 / 6 → 6 |
| Hidden | away | **0.03 %** (0.05 %) | 315 → 314 | 550 → 549 | 11 → 12 MB | 4 → 4 / 6 → 6 |
| Paused | sleeping (100 %) | 0.53 % (0.55 %) | 325 → 331 | 559 → 565 | 12 → 12 MB | 4 → 4 / 6 → 6 |

**Run 1 — before the frame-rate policy (always ~60 fps), `docs/bench/bench-2026-10-28T16-21-21-774Z.json`:** active phase (idle, resting, grooming, playing) **1.27 %** (max 1.41 %), mostly the GPU process (0.92 %); hidden 0.03 %; paused 0.82 %.

Both runs: 0 warnings, 0 errors, 0 tick errors, clean exit; no growth of main heap, timers or handles. The second renderer process in the samples is the Welcome/settings window opened on first run (0 % CPU).

Budgets set for this stack: active < 2 % of one core, hidden < 0.2 %, no monotonic growth of main heap/timers/handles → **met**. Run 2's free phase was partly asleep, so the cleanest "active" figure is run 1's 1.27 % (an upper bound, measured at 60 fps). Runs longer than ~7 minutes are UNVERIFIED for the real app; the sim was fuzzed for 200k ticks (≈343 simulated minutes).

## Packaging — REAL

| Check | Result |
|---|---|
| `npm run package` (electron-builder 26.18.1) at `6ca2bec` | `release/Desktop-Cat-Setup-1.0.0.exe`, 115.8 MB, NSIS per-user, SHA-256 `9DF908DF1C94CCBFEB0C5448A6703A97D105FF3B183F89564EC2C8633AF3FB3E`; **unsigned** (no certificate) |
| Fuses (`@electron/fuses read`) | RunAsNode off, NODE_OPTIONS off, inspect off, cookie encryption on, ASAR integrity on, only-load-from-ASAR on, file-protocol extra privileges off |
| Contents | koffi native module unpacked (`app.asar.unpacked/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node`); `LICENSE` and `THIRD_PARTY_NOTICES.md` in the asar |
| `scripts/smoke-packaged.mjs` | packaged exe runs, 0 errors/warnings in log, second launch exits 0, first survives |
| `scripts/install-test.ps1` (exit 0, `ok: true`) | silent install → exe, Start Menu + desktop shortcuts, uninstall entry v1.0.0; installed exe passes smoke; **upgrade in place** (install over the existing install) exit 0, one uninstall entry, user data intact; silent uninstall exit 0 → exe, shortcuts and uninstall entry removed, user data kept (by design); marker data folder removed afterwards |

## Adversarial review and completeness critique — REAL

1. **Review**: 7 dimensions (security, privacy, lifecycle, Win32, behaviour, renderer, settings integration), each followed by an independent verifier instructed to refute → 63 findings, 53 confirmed, 10 refuted; 0 critical, 8 high. All 53 fixed with regression tests (fix agents confirmed the new tests fail on the pre-fix code). Notable: server-forwarded cloud models could receive frames without "Allow cloud"; owned dialogs of excluded apps were not masked; window titles were read with analysis off; a removed API key survived in a backup file; cross-monitor drag dropped the cat; pixel-style ghost pixels; opacity applied twice; hung renderers not detected; the cat could walk onto a fullscreen display.
2. **Completeness critique** against the product brief: 35 gaps (behaviour depth, perception burst/labels, settings, release evidence, doc accuracy) → behaviour/renderer/settings/perception gaps implemented with tests; doc and release items corrected (this report, README, ADR, PRIVACY, THREAT_MODEL, CI, checklist).

## Not verified (UNVERIFIED)

- Windows 10; multiple physical monitors and mixed-DPI hardware (logic unit-tested with synthetic layouts only); a visible (non-auto-hide) taskbar — the test machine hides its taskbar, so the "floor on top of the taskbar" case was only unit-tested.
- Real Ollama, LM Studio/llama.cpp and Anthropic endpoints (adapters tested against mock servers; no keys available; the machine's Ollama was off-limits).
- Real user input paths that need synthetic OS input, which was deliberately not sent: tray left/right click, native right-click menu on the cat, the global shortcut keypress, the diagnostics save dialog, petting/dragging with a physical mouse (gesture recognition and routing are covered by unit tests and IPC-level E2E).
- Real logoff/shutdown (`session-end`), suspend/resume; hook delivery for move/size of other apps' windows (needs a user drag).
- Long-running stability beyond the benchmark (~7 min) for the real app; exclusive-fullscreen games.
- The GitHub Actions workflow (`.github/workflows/ci.yml`) has never run (no remote; Actions unavailable on this account) — it mirrors the local commands above.
- Code signing (no identity).
