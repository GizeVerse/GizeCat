# Security and privacy review: GizeVerse foundation

Scope: every change on `feat/gizeverse-foundation` against v1.2.0 (`58b4cd6`). The changes were checked against:
- the invariants in CLAUDE.md;
- [docs/THREAT_MODEL.md](../THREAT_MODEL.md) and [docs/PRIVACY.md](../PRIVACY.md);
- the brief's "never introduce" list.

An independent adversarial review of the whole diff found 1 high, 4 medium and 4 low findings. All are fixed in `60c408b`, and two of them are security-relevant (below). Labels as elsewhere.

## Invariants

| Invariant | Effect of this branch | Evidence |
|---|---|---|
| Screen analysis and cloud egress off by default; only main's consent actions enable analysis | **Unchanged.** Perception stays fail-closed off Windows (declared BLOCKED; a test forbids any non-Windows perception claim). The web host has no perception at all. | platform.test.ts; existing perception suites (REAL) |
| No keyboard hook, no keystroke or clipboard capture, no telemetry; window titles never leave src/main/win32 and are read only while analysis is on | **Unchanged on Windows.** No new code reads window titles anywhere. The one new native call reads a single X11 selection owner and one extension name. The web host registers no key listeners and makes no requests after load. The Linux session log line records only whether variables are set, never their values. | web E2E (key-listener scan, request count) REAL; src/main/linux/x11Compositor.ts; src/main/index.ts |
| Sandboxed renderers, context isolation, no Node; zod-validated, sender-checked IPC | **Strengthened.** A packaged build started with `--no-sandbox` refuses to start before the lock, logger or any window. Tests cover this, and it was observed in the Linux container: refusal printed, exit code 1, no logger. No new IPC channel: `AppStatus.platform` is main → renderer state built from constants. | startup.test.ts (REAL); Linux packaged check (REAL, container) |
| The overlay never blocks the desktop (T8) | **Strengthened off Windows, with one known gap.** No overlay on native Wayland or XWayland: detected from the environment, and from the X server's `XWAYLAND` extension after review L3. On X11, overlays exist only while a compositing manager runs, and are withdrawn within the 10 s check when it stops. Unknown platforms fail closed; a throwing gate counts as closed. Windows takes the unchanged path. **Gap:** on X11 the overlay's top-left pixel is not click-through, because Chromium leaves a 1×1 input rectangle at the window origin. Seen in Xvfb; see [05-linux.md](05-linux.md). | overlayManager gate tests (REAL); Linux container phases A–C (SIMULATED desktop); the origin probe (SIMULATED desktop) |
| Test hooks and DevTools never in packaged builds | **Unchanged for Electron.** In the Linux container the packaged app could not be exercised under the default sandbox; see the rerun note in 05-linux.md. **Web:** the hook exists only in the separate `out/web-test` build. The production build fails if `out/web` contains it, and an E2E test scans for it. Review H1 removed `out/web*` from the desktop package. | web E2E (REAL); build check |
| src/core and src/shared platform-agnostic | **Strengthened.** ESLint bans every Node built-in, in both spellings, and the Node and DOM globals there. | eslint.config.mjs; probe file (REAL) |

## The brief's "never introduce" list

| Item | Status |
|---|---|
| Hidden screenshot capture | None added. The capture code changed only in how it computes display bounds (the same Windows call). |
| Keystroke logging, reading typed text | None. Off-Windows idle is a number of seconds from `powerMonitor`, and its coarse mode turns typing inference off. |
| Unnecessary global keyboard hooks | None. The global shortcut is the existing Electron `globalShortcut` registration. |
| Undisclosed network activity | None added. The web host's CSP has `connect-src 'none'`, and the E2E test counts 0 requests after load. |
| Hidden persistence | None. Login items are explicitly blocked off Windows (nothing is written). Windows is unchanged and disclosed. |
| Unnecessary administrator privileges | None. The per-user install is unchanged; `requestedExecutionLevel: asInvoker`. |
| Unnecessary accessibility permissions | None. No macOS Accessibility or Screen Recording request exists, and window surfaces off Windows are not implemented for that reason. |

## New attack surface

| Surface | Assessment |
|---|---|
| libX11 via koffi (Linux) | Five calls: open the display named by `DISPLAY`, query one extension, intern one atom, read its selection owner, close. No input, no window contents, no strings from other clients. Lazy and Linux-only; any failure fails closed. koffi already shipped for Windows. |
| Linux secret storage | Plaintext backends (`basic_text`, `unknown`) are refused on every Linux id. Review M1 found XWayland was missed; it is fixed and tested. |
| macOS application menu, `activate` → Settings | Roles only; opens the existing Settings window. No new IPC or privilege. |
| Web host | A static page with a strict CSP (meta, plus a header from the dev server); zod runs jitless, so there is no `new Function`. There are no HTML sinks (`innerHTML`, `eval`) and no network APIs (grep, REAL). localStorage holds only the cat state and a settings subset, validated with the desktop migrations. The dev server binds to 127.0.0.1 only and contains paths. |
| Packaging | The Linux AppImage/tar.gz and the macOS dmg/zip are unsigned. Where an AppImage cannot get a sandbox, it is refused (deliberately, R5). Review H1: the desktop package no longer carries the web build. |

## Dependencies

- **`npm audit` (REAL, 2026-11-06).** Production: 0 vulnerabilities. Dev: 15 moderate, all one `minimatch` denial-of-service advisory through eslint, typescript-eslint and electron-builder; build-time only.
- **New packages.** The branch adds **no** new npm package. The web host bundles zod, which is already a dependency.

## Residual risks

- **Linux X11.** The 1×1 dead pixel at each overlay's top-left corner. Fix candidates are in 05-linux.md; Linux is not a supported platform.
- **macOS.** Overlay click-through has never been observed (panel plus `acceptFirstMouse`), so T8 there is UNVERIFIED. The fallback is a one-line profile change to create no overlay.
- **X11 compositor detection.** It follows the EWMH convention (`_NET_WM_CM_S<n>`). A compositor that owns the selection but draws without alpha would not be caught (UNVERIFIED).
- **Electron runway.** Electron 44 is end-of-life on 2027-03-02, and Electron 45 deprecates the synchronous safeStorage API.
