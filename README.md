# Desktop Cat

A living desktop companion for Windows: **one** animated, persistent cat that lives on top of your desktop, wanders along the bottom of your screen and the tops of your windows, naps when you're away, watches you work, reacts to windows opening and closing, and can be petted, picked up and thrown — without ever getting in the way of your clicks.

![The cat's coats and poses, rendered by the app's own renderer](docs/images/skins.png)

- **Original procedural art** — a vector rig drawn in code (21 animation clips, 7 coats, optional pixel style), no third-party assets.
- **Click-through by design** — only the cat's body catches the mouse; everything else goes to the windows underneath. No global mouse or keyboard hooks.
- **Works offline, no AI required.** Optional, opt-in screen perception (local statistics, or an AI vision model you configure) with privacy enforced in code.

> Status: v1.0.0, built and validated on Windows 11 (see [Tested environments](#tested-environments)). The installer is **not code-signed**.

## Install

Run `release/Desktop-Cat-Setup-1.0.0.exe` (per-user install, no admin). SmartScreen may warn because the build is unsigned: **More info → Run anyway**. The cat appears at the bottom of your screen; a Welcome page explains the controls. Uninstall from Windows Settings → Apps.

## Controls

| Action | Result |
|---|---|
| Move the cursor back and forth over the cat | Petting (purrs, leans in) |
| Click / double-click | Ear flick or meow / happy hop (too many clicks annoy it) |
| Drag | Carry it; drop it on the floor, a window, another monitor; fling to throw |
| Right-click the cat | Pet, Call, Play, Sleep/Wake, Pause, Hide, Settings, Quit |
| Tray icon | Left-click show/hide; right-click menu (pause, interactions on/off, vision privacy pause, call, settings, quit) |
| `Ctrl+Alt+Shift+C` | Show/hide (configurable) |

Full guide: [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

## What is implemented

**Overlay & Windows integration.** One transparent, frameless, non-focusable, topmost overlay per display (sized to the work area), never moved or hidden (works around Electron's transparent-window bugs); main-process cursor polling decides click-through against the cat's reported hit region; hung/crashed renderers are forced click-through and recreated. Multi-monitor and mixed-DPI coordinates (physical px world, per-display DIP rendering), display add/remove/re-layout, auto-hide taskbars. Tray, global shortcut, single-instance lock (second launch surfaces the running cat), launch at sign-in (opt-in), graceful quit (the cat falls asleep, state saved), session-end/suspend saves, crash guard.

**The cat.** A 24-state behaviour machine (sleeping, waking, idle, walking, running, chasing/watching the cursor, curious, inspecting/perching on windows, watching you work, playing, petted, startled, annoyed, seeking attention, resting, grooming, hiding, falling asleep, held, jumping, falling, landing, away) with an explicit transition table, priorities, dwell times, cooldowns and anti-thrash rules; utility-scored autonomous choices with bounded seeded randomness; physics (gravity, ballistic jumps onto window tops, riding moving windows, drag and throw). Persistent personality (traits), needs (energy, boredom, bond, annoyance, fear), favourite spots, learned preferences and a small memory, in a versioned schema with migration and corrupt-file recovery.

**Awareness (Tier A, always on, local).** WinEvent hooks (foreground, show/hide/destroy, minimise, move/size, cloak) with a reconcile poll; app categories from executable names; fullscreen detection (the cat gets out of the way); typing-like activity inferred from input without cursor motion (no keyboard hook); idle/return.

**Perception (optional, OFF by default).** Tier B: tiny masked in-memory frames → brightness/contrast/colourfulness/edge density/change/motion (no semantic claims). Tier C: Ollama, OpenAI-compatible local servers, or Anthropic (`claude-haiku-5-5`), strict schema + 8-reaction allow-list, rate limits, circuit breaker; cloud requires a separate switch, and server-forwarded cloud models are detected and fail closed. Consent flow, exclusions (password managers, auth, banking, private browsing — including their dialogs), privacy pause, "preview what the cat sees". See [docs/PRIVACY.md](docs/PRIVACY.md) and [docs/AI_SETUP.md](docs/AI_SETUP.md).

**Settings UI.** Welcome, General, Appearance, Behavior, Interaction, Privacy & Vision, AI, Personality, Diagnostics (live resource charts, log export), About. Light/dark, keyboard accessible.

| Appearance | Privacy & Vision | Personality (dark) |
|---|---|---|
| ![Appearance page](docs/images/settings-appearance.png) | ![Privacy page](docs/images/settings-privacy.png) | ![Personality page](docs/images/settings-personality-dark.png) |

Screenshots are of the real settings window driven by the real main process (`scripts/qa-settings.mjs`); the cat sheets above are rendered by the app's own overlay renderer (`scripts/render-preview.cjs`). No screenshot of a desktop is included because that would capture other people's screen content; `scripts/qa-desktop.mjs` reproduces the on-desktop check locally.

**Security.** Sandboxed renderers, context isolation, custom scheme + strict CSP, validated IPC with sender checks, DPAPI-encrypted keys never exposed to renderers, Electron fuses on packaged builds. See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Not implemented / future possibilities

- UI Automation (accessibility tree) awareness — not implemented; window metadata is used instead.
- Sounds (meows/purrs) — not implemented.
- Climbing window sides, multiple skins per cat at once, localisation beyond English.
- Code signing and auto-update — not configured (no signing identity available).

## Build, run, test

Requires Windows 10/11 x64, Node ≥ 22 (built with Node 26.4), npm.

```powershell
npm ci
node node_modules/electron/install.js   # Electron 44 downloads its binary lazily
npm run dev                             # development build + run (separate userData via --user-data-dir if desired)
npm run typecheck; npm run lint; npm test
npm run build; npx playwright test      # E2E: launches the real app (a cat appears briefly)
npm run package                         # -> release/Desktop-Cat-Setup-<version>.exe (+ release/win-unpacked)
node scripts/smoke-packaged.mjs         # smoke-test the packaged exe
powershell -File scripts/install-test.ps1   # silent install -> smoke -> silent uninstall
node scripts/bench.mjs                  # resource benchmark -> out/bench/*.json
node scripts/qa-desktop.mjs             # real-desktop compositing check
npx electron scripts/render-preview.cjs # art contact sheets -> out/preview/
```

On shared machines wrap heavy commands: `node scripts/with-lock.mjs <label> -- <command>`.

## Tested environments

| Environment | What ran | Result |
|---|---|---|
| Windows 11 Home 10.0.26200, x64, one 1920×1200 display at 125 %, auto-hide taskbar | typecheck, lint, 1006 unit/integration tests, 18 Playwright E2E specs against the real app, Win32 probe (31 checks), desktop compositing QA, packaged-exe smoke, silent install/uninstall, resource benchmark | all pass — see [docs/TEST_REPORT.md](docs/TEST_REPORT.md) |
| Windows 10 | — | **not tested** (Win32 APIs used exist since 1903; expected to work) |
| Multi-monitor / mixed DPI hardware | unit-tested with synthetic layouts only | **not tested on hardware** |
| Real Ollama / LM Studio / Anthropic endpoints | adapters tested against local mock servers | **not tested against real providers** |

## Documentation

[Architecture decision record](docs/adr/0001-architecture.md) · [User guide](docs/USER_GUIDE.md) · [Privacy](docs/PRIVACY.md) · [Threat model](docs/THREAT_MODEL.md) · [AI setup](docs/AI_SETUP.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Test report](docs/TEST_REPORT.md) · [Release checklist](docs/RELEASE_CHECKLIST.md) · [Third-party notices](THIRD_PARTY_NOTICES.md) · [Example settings](docs/settings.example.json) · [Research notes](docs/research/)

## License

MIT — see [LICENSE](LICENSE). Artwork is original and part of this project.
