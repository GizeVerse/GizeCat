# GizeCat on Linux (X11, XWayland, Wayland): foundation report

Status per capability: [capability matrix](capability-matrix.md), Linux sections.
- **Executed here:** only own Docker containers from the local `node:24-bookworm-slim` image (Debian 12 "bookworm", Node 24.21.0, x86_64), with Electron 44.9.3 under **Xvfb**, a virtual X server with no desktop session.
- **Labels.**
  - Build and unit-test results are REAL for "builds and passes its tests on Linux".
  - Everything about the running app is SIMULATED_OR_MOCK_TESTED: a virtual display, synthetic input through XTest, no real window manager or desktop.
  - No real GNOME, KDE or Xfce session, no Wayland compositor and no Linux hardware was used.
- **Never touched:** the user's WSL distribution and other projects' containers or images (no pull, no prune).

## Platform policy (what the code does)

| Session | Platform id | Overlay | Why |
|---|---|---|---|
| X11 session (`DISPLAY`, no Wayland) | `linux-x11` | Yes, **only while a compositing manager runs** (`_NET_WM_CM_S<screen>` has an owner; re-checked every 10 s) | Without compositing, a transparent full-screen window can be drawn opaque and hide the desktop |
| Wayland session, app forced to X11 (`--ozone-platform=x11`), or an X server with the `XWAYLAND` extension | `linux-xwayland` | **No** | X11 apps do not see the pointer over Wayland windows, so a stale position could make the overlay take clicks (T8) |
| Wayland session (Electron 38+ default) | `linux-wayland` | **No** | No always-on-top, positioning or global pointer for clients; late input regions on Mutter |

**Also:**
- **Logical coordinates** (px = DIP).
- **Idle** from `powerMonitor` at 1 s resolution, with no typing inference.
- **The floor only:** no window surfaces, panels or tab strips.
- **Secrets.** Plaintext keyrings (`basic_text`, `unknown`) are refused.
- **Startup.** Login items are explicitly not implemented.
- **Shutdown.** `powerMonitor` `shutdown` saves the cat.
- **Sandbox.** A packaged build started with `--no-sandbox` refuses to start.

## Container runs

Scripts: `.claude/state/gv/linux/` during this work. The archived scripts and summaries are in [evidence-linux/](evidence-linux/).

### Headless tiers (REAL on Linux)

| Run | Commit | npm ci | typecheck | lint | vitest | build |
|---|---|---|---|---|---|---|
| 1 | `8177ea1` | pass | pass | pass | 3658 passed, **5 failed**, 50 skipped | pass |
| final | `d97c36f` | pass | pass | pass | **3750 passed, 0 failed**, 50 skipped (188 files; the 5 skipped files are the Windows-only real-API tests) | pass |
| rerun | `60c408b` (the review fixes) | pass | pass | pass | **3755 passed, 0 failed**, 50 skipped (189 files) | pass |

The 5 run-1 failures were host assumptions in tests: Windows paths through the host's `node:path` (2), and the Windows 11 corner radius taken from `os.release()` (3). They were fixed in `a033e96`.

### The app under Xvfb (SIMULATED desktop)

Electron runs as a non-root user.
- **Sandbox (run 1 and the final run).** The Chromium sandbox could not start in a default container ("Failed to move to new namespace … Operation not permitted"), so the development runs used `--no-sandbox`, which development builds allow with a warning.
- **Rerun.** The container got the namespace capability (`--cap-add SYS_ADMIN`, unconfined seccomp; own throwaway container only) so the sandbox can run: it did ("Chromium sandbox on (setuid helper, user node)"), and every phase below passed **with the sandbox on** (REAL in the container).

| Phase | Setup | Expected | Run 1 | Final (`d97c36f`) | Rerun (`60c408b`, sandbox on) |
|---|---|---|---|---|---|
| Platform identity | Xvfb 1920×1080 | `platform {"id":"linux-x11","coordinates":"logical","overlay":true}` | pass | pass | pass |
| A: no compositing manager | Xvfb only | overlays withheld, 0 created | pass (withheld 1, created 0) | pass | pass |
| B: compositing manager | `xcompmgr` | overlay created | pass | pass | pass |
| B: click-through | a plain window placed under the overlay; XTest click at (300, 300), far from the cat | the click reaches the window below | pass | pass | pass |
| B: controls | no app / a blocking window over the probe | reaches / does not reach | pass / pass | pass / pass | pass / pass |
| C: compositor dies | `xcompmgr` killed 12 s in | overlays withdrawn within the 10 s check | pass | pass | pass |
| Errors | all runs | 0 `error` log lines | 0 | 0 | 0 |

Runtime report in the log: `platform capabilities {"id":"linux-x11","unavailable":["windowSurfaces","taskbarSurfaces","tabStrips","fullscreenAware","loginItem","secretStorage","perception","touchInput"]}`. The container has no keyring, so secret storage is correctly unavailable; the global shortcut registered.

### Overlay window facts (from the X server, python-xlib)

- **Window type.** The overlay is an **override-redirect**, mapped window. This matches Electron's documented `focusable: false` behaviour on Linux: out of window-manager control, on top on all workspaces.
- **Size.** 1919×1079 on a 1920×1080 screen: one pixel short in each direction (cause UNVERIFIED; the cat's last pixel column and row at the screen edge cannot be drawn).
- **Known gap.** One pixel per overlay is **not** click-through. Electron/Chromium's X11 click-through leaves a **1×1 input rectangle** at the window's top-left corner (`inputRects: [[0,0,1,1]]`):
  - a click at (0, 0) was swallowed by the overlay;
  - (1, 1) and (300, 300) reached the window below (final run and rerun, REAL in Xvfb; the same with and without the sandbox).

  On a real desktop that is the top-left corner pixel of each display, where panels often put a menu button. This misses T8 by one pixel on Linux X11, which is not a supported platform.
  - Fix candidates for the next milestone: extend the overlay one pixel beyond the work area's top-left (the dead pixel goes off-screen), or use `setShape` once its cost is measured.

### Packaging (REAL for the build)

`npm run package:linux` in the container (final run, `d97c36f`):
- `GizeCat-1.2.0-linux-x86_64.AppImage`: 126,761,781 bytes.
- `GizeCat-1.2.0-linux-x64.tar.gz`: 120,556,977 bytes.
- The executable is `desktop-cat`, and koffi's linux-x64 binary is unpacked next to app.asar (it is needed for the compositor probe).

The packaged app in the container:
- **With the sandbox, default container:** Chromium could not create its namespaces and exited. It did **not** fall back to running unsandboxed (REAL).
- **With `--no-sandbox`:** it printed "GizeCat cannot start safely …" and exited with code 1 before creating any logger or window (REAL). Electron prints pre-ready error boxes to stderr on Linux.
- **Rerun with the namespace capability (`60c408b`, REAL in the container):** the tar.gz build **started with its sandbox**, created its overlay (with xcompmgr), logged its capability report, and had 0 error lines. With `DESKTOP_CAT_TEST=1` set it still ran as `packaged:true, test:false`, so the test hooks stayed off. With `--no-sandbox` it printed the refusal and exited with code 1, with no logger and no overlay. Artifacts: AppImage 126,524,084 bytes, tar.gz 120,332,777 bytes; slightly smaller since `out/web` is excluded (review H1).

The packages are unsigned. deb and rpm are not configured: they need a homepage and a maintainer e-mail, which the owner must choose. On Ubuntu 24.04 and later an AppImage often has no usable sandbox (AppArmor restricts unprivileged user namespaces), and the packaged GizeCat then refuses to start rather than run unsandboxed. A deb with an AppArmor profile, or a Flatpak, is the route to a usable Linux package.

## Not verified (needs real Linux desktops)

- A real X11 session: GNOME on Xorg, KDE X11, Xfce or MATE with compositing, i3 plus picom. That covers stacking over real apps and panels, the tray (StatusNotifier, GNOME's AppIndicator extension), the global shortcut, and HiDPI or fractional scaling.
- Real Wayland sessions: that the app keeps its tray and Settings and shows the explanation (the logic is unit-tested only).
- Multi-monitor layouts, keyring backends (libsecret, KWallet), `powerMonitor` idle and shutdown on real systemd sessions.
- The AppImage and tar.gz on real distributions.
