# ADR 0001 — Architecture of Desktop Cat

- Status: accepted (2026-10-28)
- Context: one persistent, animated cat living on the Windows 10/11 desktop; must never get in the way of normal computer use; optional, opt-in screen perception; no mandatory network or paid service.

## Decision summary

| Concern | Decision |
|---|---|
| Stack | **Electron 44.9 + TypeScript 6.0 (strict)**, esbuild bundles, zod 4 validation, koffi 3.3 FFI for Win32. |
| Why not Tauri | No Rust toolchain on the build machine; WebView2 transparent always-on-top windows have weaker click-through/topmost control; Electron gives a single, pinned Chromium for deterministic rendering and a mature NSIS packaging path. Cost: memory — about 550–610 MB summed working set across all app processes (shared pages counted more than once; see docs/TEST_REPORT.md) — and a ~116 MB installer. |
| Overlay | **One transparent, frameless, non-focusable, topmost BrowserWindow per display, sized to that display's work area.** Every overlay stays shown and click-through for its whole life (hiding/moving transparent frameless windows triggers Electron bugs #41063, #27651, #54627); only the rendered content changes, and an overlay draws nothing while the cat is elsewhere. On a display change an affected overlay is destroyed and recreated rather than re-bounded. |
| Click-through | Overlays ignore the mouse by default (`setIgnoreMouseEvents(true)` → `WS_EX_TRANSPARENT`). Main polls the cursor and turns interaction on **only while the cursor is inside the cat's reported hit region** and the renderer is healthy. No global mouse hook. |
| Simulation | Pure TypeScript in `src/core` (no Electron/Node imports), hosted by the main process: ~30 Hz while active, ~15 Hz calm, 5–7 Hz asleep, 4–5 Hz hidden (the sim caps its tick interval at 200 ms and the host catches up gaps ≤ 1 s in ≤ 250 ms sub-steps, so sim time tracks real time). Rendering is decoupled: the overlay interpolates snapshots at the display rate and throttles while calm. World space = physical virtual-screen pixels. |
| Rendering | Renderer receives `CatRenderState` snapshots (overlay-local DIP), interpolates, and draws a **procedural vector rig** on Canvas 2D (all clips, blending, breathing, blinking, tail physics, look-at). Optional "pixel" style renders the same rig at low resolution with nearest-neighbour upscale. |
| Windows awareness | koffi → `SetWinEventHook` (out-of-context, skip own process) for foreground/minimize/move-size/show/hide/destroy/cloak events on Electron's main thread, plus a slow reconcile poll. `GetLastInputInfo` for idle; "typing" = input without cursor motion (no keyboard hook). |
| Perception | Tier A (metadata, always on), Tier B (opt-in local pixel statistics on a tiny, masked, in-memory frame), Tier C (opt-in AI vision via Ollama / OpenAI-compatible local server / Anthropic, strict schema + reaction allow-list). |
| Persistence | Versioned JSON in `%APPDATA%/Desktop Cat` with atomic writes, field-level defaults, corrupt-file quarantine; API keys encrypted with `safeStorage` (DPAPI). |
| Packaging | electron-builder NSIS, per-user install, no elevation; user data kept on uninstall unless chosen. Unsigned unless a signing identity is provided. |

## Evidence behind the overlay decision (measured on the dev machine, Windows 11 26200, 1920×1200 @125%)

Spike (`Electron 44.9.3`, Chromium 152; reproducible with `npx electron scripts/spike-overlay`), REAL measurements via `app.getAppMetrics()`:

- Full-work-area transparent overlay animating at 59 fps: GPU process ≈0.4 % CPU, renderer ≈0.2 % CPU.
- Small 300×200 moving-content window: GPU ≈0.66 %, renderer ≈0.2 % — no meaningful advantage.
- Idle overlay (no rAF): 0 %.
- `WindowFromPoint` at a point covered by the overlay returns the window *underneath* while ignoring the mouse, and the overlay itself when interactive → OS-level click-through confirmed and usable as a test oracle.
- koffi `SetWinEventHook(WINEVENT_OUTOFCONTEXT)` callbacks are delivered on Electron's main thread (create/destroy/show/hide/reorder/location events observed).

A small window moved every frame was rejected because moving windows across mixed-DPI monitors is error-prone and makes cross-monitor hand-off and jumps/drags clip at window edges; per-display overlays never move between monitors, so each window lives in exactly one DPI.

## Process & module boundaries

```
main process (Node, trusted)                       renderers (sandboxed, contextIsolation, no Node)
├─ app.ts            composition root, lifecycle   ├─ overlay/   canvas rig + animator, pointer capture
├─ catHost.ts        sim loop, env, events         │             (window.desktopCat API from preload)
├─ overlay/          per-display windows,          └─ settings/  settings & onboarding UI
│                    render dispatch, click-through               (window.desktopCatSettings API)
├─ win32/            koffi bindings, window tracker, activity monitor
├─ display/          topology, DIP<->px
├─ perception/       capture, AI adapters, privacy gate enforcement
├─ store/            settings, cat state, secrets (safeStorage)
├─ diagnostics/      logger (redacting, rotating), resource sampler, export
└─ ipc/              validated handlers, sender checks
core (pure TS, unit-tested): behavior/ movement/ interaction/ perception/ display/
shared (pure TS): contracts, zod schemas, IPC channel names
```

Rules: `src/core` and `src/shared` may not import Electron, Node built-ins or process-specific code (ESLint-enforced). Renderers may not import Electron/Node/main code. Every IPC payload into main is zod-validated and the sender is checked against the windows main created.

## Behaviour model

A hierarchical state machine (24 states incl. physical states `held/jumping/falling/landing` and lifecycle `away`) with an explicit transition table, priorities, minimum dwell times, cooldowns and interruption rules. Autonomous choices use utility scoring (personality traits × needs × context × user settings × repetition penalty) with bounded, seeded randomness. Stimuli (window events, typing, idle, cursor, perception) go through relevance scoring and habituation so frequent events produce observation, not constant movement.

## Privacy model (enforced in main, not just the UI)

- Screen analysis is off by default and requires an explicit opt-in that records a consent timestamp; without it the capture path refuses to run.
- Capture is event-driven and rate-limited; frames are tiny, in-memory, masked (cat and excluded windows removed), and discarded after analysis.
- Excluded processes/titles (password managers, auth dialogs, banking/payment, private browsing) block capture; titles are matched in memory and never logged or persisted.
- Images leave the device only if the user selects a cloud provider **and** enables `allowCloud`; non-loopback endpoints are refused otherwise. The tray icon and tooltip always show the active perception mode; privacy pause is one click/shortcut away.
- No keyboard hook, no keystroke/clipboard capture, no telemetry.

## Consequences

- Windows 10 1903+/11 x64 only (Win32 APIs, `WDA_*`, per-monitor DPI v2 via Electron).
- The overlay cannot appear above exclusive-fullscreen games, the secure desktop (UAC, lock screen) or windows of elevated processes in higher integrity bands; this is a platform limitation, documented in the user guide.
- Some Win32 calls are synchronous FFI on the main thread; they are cheap (µs) and bounded per tick.
