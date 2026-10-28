# Test report — Desktop Cat 1.0.0

Date: 2026-10-28. Labels: **REAL** = executed and observed on the machine below; **MOCKED** = executed against fakes/mock servers; **UNVERIFIED** = not executed.

## Environment

Windows 11 Home 10.0.26200 x64 · one display 1920×1200 at 125 % (1536×960 DIP), auto-hide taskbar (work area = full screen) · Node 26.4.0 (host tools) · Electron 44.9.3 (Chromium 152, Node 24.22) · shared PC: every heavy run went through the machine-wide lock (`scripts/with-lock.mjs`).

## Static checks — REAL

| Check | Result |
|---|---|
| `tsc -p tsconfig.node.json` and `tsconfig.web.json` (TS 6.0.3 strict, `noUncheckedIndexedAccess`) | 0 errors |
| `eslint .` (typescript-eslint type-checked rules, no-floating-promises, import boundaries for core/shared/renderer) | 0 problems |
| `npm audit` (install) | 0 vulnerabilities |

## Unit and integration tests (Vitest 5) — REAL / MOCKED

`npx vitest run` → **79 files, 1006 tests, all passed** (~6 s).

| Area | Highlights |
|---|---|
| Behaviour & movement (`tests/unit/core/behavior`, `movement`) | transition-table validity; 200k-tick randomized fuzz (no illegal transition, dwell/cooldown/thrash invariants, finite outputs, always inside the world); every behaviour toggle disabled → never occurs; physics (exact jump arcs, landing without tunnelling at 250 ms ticks, perch riding, platform loss, throws); multi-monitor with mixed DPI/negative coordinates/display removal; never walks onto a fullscreen display; quit → `quitReady` ≤ 900 ms; sim time tracks real time with timer lateness; persistence round-trip and corrupt-state recovery; 2-hour behaviour mix (> 80 % calm states, naps > 3 %) |
| Win32 & awareness (`tests/unit/win32`, `tests/integration/win32`) | tracker coalescing/bounded queues/reconcile/polling fallback; platforms with z-order occlusion; fullscreen rules incl. auto-hide taskbar; privacy masks cover dialogs/tool windows/popups; titles read only while analysis is enabled; activity heuristics; **10 REAL koffi calls in plain Node** (structural assertions only, no titles printed) |
| Display & interaction (`tests/unit/core/display`, `interaction`) | DIP↔px conversion for mixed DPI and negative origins; gesture recogniser (tap, double tap, drag velocity, pet strokes); click-through gate hysteresis/staleness |
| Perception & AI (`tests/unit/core/perception`, `tests/unit/perception`, `tests/integration/perception`) | analysis on synthetic frames (0.47 ms median for 256×144); privacy-gate matrix incl. loopback tricks; consent/pause/lock/exclusion blocks; post-capture mask re-check; cloud-model detection fail-closed; limits and circuit breaker; AI-output fuzz (fences, prose, injection text, schema violations); adapters against **MOCKED** `node:http` servers (success, 500, malformed, slow → timeout, oversized, redirect) |
| Main shell (`tests/unit/main`) | atomic JSON store (backup, quarantine, ENOENT vs read errors), secrets never backed up, settings/cat stores, logger redaction and resilience, crash guard, quit sequencing, shortcuts validation, render mapping, IPC validation and rate limits, host loop timing |
| Renderer (`tests/unit/renderer`) | every clip × skin × detail level produces finite poses (MOCKED canvas); blending continuity; tail stability under extreme dt; interpolation (snap, out-of-order, clock steps); hit regions; settings UI logic (patches, validation, live polling, memory-label drift) |
| Shared (`tests/unit/shared`) | settings schema defaults/recovery/migration, strict patches, consent-bypass guard |

## End-to-end (Playwright 1.64 driving the real Electron app) — REAL

`npm run build && npx playwright test` → **18 passed** (~57 s). Each test uses its own temp userData.

- One overlay per display: transparent background, non-focusable, topmost, tool window, ignoring the mouse by default (window styles read back from Windows).
- OS hit-testing (`WindowFromPoint` via koffi from the test process) passes through the overlay away from the cat, and hits it only where the cat is interactive; interactions-off keeps everything click-through.
- A hung overlay renderer (infinite loop) is made click-through and recreated within ~11 s; live overlays never flagged over 10 s.
- Malformed and flooding IPC dropped without crashing; IPC from an unregistered window refused; nothing secret echoed.
- Settings persist across restart; quit saves the cat and a restart restores its position; corrupt settings/cat files quarantined; truncated cat file falls back to `.bak`.
- Single instance: second launch exits 0 and the first surfaces the cat.
- First run shows Welcome; pause, hide, show, resume, quit (exit 0, no error log lines).
- Perception off by default and never captures; API key stored encrypted, never echoed, logged or exported.

## Desktop and platform checks — REAL

| Check | Result |
|---|---|
| Feasibility spike: full-work-area transparent overlay at 59 fps | GPU process ≈0.4 % CPU, renderer ≈0.2 %; idle overlay 0 % |
| `scripts/qa-desktop.mjs` — real app on the real desktop | cat composited with per-pixel transparency over the window beneath (visually inspected); 403 ticks, 0 tick errors, 0 warnings/errors, window awareness `event-hooks`, exit 0 |
| `scripts/win32-probe.cjs` (Electron) | 31/31 checks: hook mode active, per-monitor DPI awareness, one event per change of its own test window (shown/minimised/restored/closed, 150–182 ms latency), own windows not private, `WindowFromPoint` skips the click-through overlay, DIP↔px matches Electron's conversion to 0 px |
| Finding | `SHQueryUserNotificationState` reports `busy` while our full-work-area overlay is up → treated only as a soft signal |
| Art preview sheets (`scripts/render-preview.cjs`) | every clip, skin, style, scale on light/dark backgrounds visually reviewed; render cost 0.10 ms/frame smooth, 0.32 ms pixel (software raster, JS side) |

## Packaging — REAL

| Check | Result |
|---|---|
| `npm run package` (electron-builder 26.18.1) | `release/Desktop-Cat-Setup-1.0.0.exe`, 115.8 MB, NSIS per-user; **unsigned** (no certificate) |
| Fuses (`@electron/fuses read`) | RunAsNode off, NODE_OPTIONS off, inspect off, cookie encryption on, ASAR integrity on, only-load-from-ASAR on, file-protocol extra privileges off |
| koffi native module | present in `app.asar.unpacked/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node` |
| `scripts/smoke-packaged.mjs` | packaged exe runs, 0 errors/warnings in log, second launch exits 0, first survives |
| `scripts/install-test.ps1` | silent install exit 0 → exe, Start Menu + desktop shortcuts, uninstall entry (v1.0.0); installed exe passes smoke; silent uninstall exit 0 → exe, shortcuts and uninstall entry removed |

## Adversarial review — REAL

A 7-dimension review (security, privacy, lifecycle, Win32, behaviour, renderer, settings integration), each followed by an independent verifier instructed to refute: **63 findings, 53 confirmed, 10 refuted; 0 critical, 8 high.** All 53 were fixed with regression tests (fix agents confirmed the new tests fail on the pre-fix code). Notable fixes: server-forwarded cloud models could receive frames without "Allow cloud"; owned dialogs of excluded apps were not masked; window titles were read with analysis off; a removed API key survived in a backup file; cross-monitor drag dropped the cat; pixel-style ghost pixels; opacity applied twice; hung renderers not detected; the cat could walk onto a fullscreen display.

## Resource benchmark — REAL

`node scripts/bench.mjs --phase-sec=90 --sample-sec=10` (real app, dev build, test hooks used only to switch phases). CPU is `app.getAppMetrics()` summed over all app processes, in % of **one** core; working set is summed over processes (shared pages counted more than once). Raw data: `out/bench/bench-2026-10-28T16-21-21-774Z.json`.

| Phase | CPU avg (max) | Working set first → last | Main heap | Timers / handles (main) |
|---|---|---|---|---|
| Awake (idle, resting, grooming, playing) | 1.27 % (1.41 %) — GPU 0.92, overlay renderer 0.29, main 0.06 | 566 → 611 MB | 11 → 11 MB | 4 → 4 / 6 → 6 |
| After a sleep command (the cat woke again; wakingUp, resting, watchingUser) | 1.15 % (1.35 %) | 613 → 602 MB | 11 → 11 MB | 4 → 4 / 6 → 6 |
| Hidden | **0.03 %** (0.04 %) | 548 → 547 MB | 11 → 12 MB | 4 → 4 / 6 → 6 |
| Paused (resting → falling asleep → sleeping) | 0.82 % (1.27 %) | 565 → 567 MB | 12 → 13 MB | 4 → 4 / 6 → 6 |

0 warnings, 0 errors, 0 tick errors, clean exit. No growth in timers, handles or main heap across ~7 minutes. The second renderer process in the sample is the Welcome/settings window opened on first run (0 % CPU).

Budgets (initial, set for this stack): awake < 2 % of one core, hidden < 0.2 %, no monotonic growth of main heap/timers/handles → **met** in this run. Longer runs (hours) are UNVERIFIED; the sim itself was fuzzed for 200k ticks (≈ 343 simulated minutes) without invariant violations. A possible optimisation not done: render idle poses at 30 fps instead of 60 to roughly halve the GPU share.

## Not verified (UNVERIFIED)

- Windows 10; multiple physical monitors and mixed-DPI hardware (logic unit-tested with synthetic layouts only).
- Real Ollama, LM Studio/llama.cpp and Anthropic endpoints (adapters tested against mock servers; no keys available, the machine's Ollama was off-limits).
- Real user input paths that require synthetic OS input, which was deliberately not sent: tray left/right click, native right-click menu on the cat, the global shortcut keypress, the diagnostics save dialog, petting/dragging with a physical mouse (gesture recognition and routing are covered by unit tests and IPC-level E2E).
- Real logoff/shutdown (`session-end`) and suspend/resume; hook delivery for move/size of other apps' windows (needs a user drag).
- Long-running stability beyond the benchmark duration; exclusive-fullscreen games.
- Code signing (no identity).
