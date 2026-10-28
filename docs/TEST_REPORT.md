# Test report — Desktop Cat 1.0.0

Date: 2026-10-28. Code: branch `feat/desktop-cat-v1`, installer built from commit `6ca2bec`. Labels: **REAL** = executed and observed on the machine below; **MOCKED** = executed against fakes/mock servers; **UNVERIFIED** = not executed.

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
