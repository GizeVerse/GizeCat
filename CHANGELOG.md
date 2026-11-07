# Changelog

GizeCat (formerly Desktop Cat). Versions follow semantic versioning. 1.3.0 is the first public release; earlier versions were built and tested locally but not published.

## 1.3.0 — first public release

### Fixed
- **Clicking, dragging and throwing the cat could stop working after it had run for a while.** A safety check ended any press 400 ms after Windows reported the mouse button up, even while the cat's window was still receiving the held button. That button state can read "up" by mistake, and a busy PC delays the check, so taps were lost, drags were cut short and throws fell flat, silently. The cat's own window input is now authoritative while it is alive. Also: the click guard no longer gets stuck after a bail-out or a momentarily stale window list; lock and sleep states always recover (also when Windows misses the unlock or resume event); a right-click, a hung or reloaded renderer, or a resume no longer leave a half-finished gesture behind; overlays recover after repeated renderer failures. More than 80 new tests: long-run, fuzz and 24-hour simulated suites, plus an opt-in soak of the real app, which passed a two-hour run with simulated input ([details](docs/gizeverse/13-interaction-reliability.md)).
- **Profile counters** for edge climbs, excursions, surface hops, slips and hard landings were shown in Settings but never counted.

### Added
- **GizeVerse foundation.**
  - A platform layer (`src/main/platform`) with a capability model: every capability's status on every platform is declared in code and published as [docs/gizeverse/capability-matrix.md](docs/gizeverse/capability-matrix.md).
  - **Web host:** the real cat (same simulation, host loop and renderer) in a browser page, with mouse and touch gestures, no network access after load and no key listeners ([report](docs/gizeverse/07-web-host.md)).
  - **macOS and Linux X11 foundations:**
    - overlay profiles and logical coordinates on both;
    - on X11, an overlay only while a compositing window manager runs;
    - on Wayland and XWayland, no overlay, because clicks could be blocked there.

  None of these platforms is a supported release yet ([reports](docs/gizeverse/README.md)).
- **Settings → Diagnostics → Platform** lists what this platform can and cannot do, and why.
- **Open-source files:** contributing guide, code of conduct, security policy, issue and pull-request templates, CI and release workflows, roadmap.

### Changed
- **The product is now called GizeCat**, "a GizeVerse character". Persistent identifiers are unchanged, so that existing installs keep their cat, settings, API keys and startup entry: the app ID, the `%APPDATA%\Desktop Cat` data folder, the executable name and the `DESKTOP_CAT_*` environment variables. The installer, shortcuts and Apps entry keep the name "Desktop Cat" for now.
- **Your data folder is pinned explicitly** to `%APPDATA%\Desktop Cat`, so a future product rename can never move it.

### Security
- **The packaged app refuses to start with `--no-sandbox`.** Renderers always run in Chromium's sandbox.
- **On Linux, plaintext keyring backends are refused** for API keys.
- **No new runtime dependency.** `npm audit --omit=dev`: 0 vulnerabilities.

## 1.2.0 — a lively cat (not published)

- **Livelier behaviour.** The cat explores on its own, stays on windows and browser tab strips for minutes, hunts the cursor (stalk, crouch, pounce, bat) and reacts to throws in varied ways. Utility-scored choices with needs, moods and rhythm ([ADR 0003](docs/adr/0003-lively-cat.md)).
- **Screen edges.** The cat clings to and peeks over screen edges, with a fail-closed click guard. A covered or vanished support ends in a controlled bail-out.
- **Small additions.** Personality presets, optional sound (off by default) and a behaviour profile in Diagnostics.

## 1.1.1 — reaching windows from the floor (not published)

- Leap-and-cling, top re-resolution, landing spans, and tab-strip interest for floating windows. The cat could get stuck on the floor.
- **Settings → Diagnostics → Surfaces** explains what the cat can reach.

## 1.1.0 — surfaces and startup (not published)

- **Surfaces.** Window tops and sides, browser tab strips (Edge, Chrome) and an auto-hiding taskbar as moving ledges.
- **Startup.** Starts at sign-in by default, through the per-user Run entry. Opt-outs are respected.

## 1.0.0 — first version (not published)

- One animated cat in transparent, click-through overlays on Windows 10/11, with a 24-state behaviour machine, petting, dragging and throwing.
- A Settings UI, and optional opt-in screen perception (local statistics or an AI vision model).
