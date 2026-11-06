# Contributing to GizeCat

GizeCat (formerly Desktop Cat) is the first character of GizeVerse: one animated cat that lives in transparent, always-on-top, click-through overlays on your desktop, with optional, opt-in screen perception. The code is MIT-licensed. So far Windows 11 is the only platform it has been verified on.

Thanks for helping. Please read this page before your first pull request; it is short on purpose.

- Be kind: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Security problems go to a private channel, not an issue: [SECURITY.md](SECURITY.md).
- By contributing you agree that your contribution is licensed under the project's [MIT license](LICENSE).
- Useful background: [README.md](README.md), [docs/PRIVACY.md](docs/PRIVACY.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) and the ADRs in [docs/adr/](docs/adr/) (0004 covers the multi-platform plan).

## Set up

You need Node 22.13+, 24 or 26 (enforced by `engines`) and npm. To run the app and the end-to-end tests you need Windows 10 or 11 on x64.

```sh
npm ci --ignore-scripts                 # no dependency needs an install script
node node_modules/electron/install.js   # Electron downloads its binary lazily; run this after every fresh install
npm run dev                             # development build, then run the app
```

On macOS and Linux, typecheck, lint, the unit tests and the build should run. The app has a platform profile for both. It has never run on a Mac. On Linux it has run only in a container under a virtual X server, not on a real desktop, and it shows the cat only on an X11 session with a compositing window manager. What has actually run where is in the [capability matrix](docs/gizeverse/capability-matrix.md) and the GizeVerse reports in [docs/gizeverse/](docs/gizeverse/).

## Verify your change

```sh
node .claude/scripts/verify.mjs fast    # typecheck, lint, unit and integration tests
node .claude/scripts/verify.mjs full    # fast, plus the build and the Playwright E2E suite
```

- `full` starts the real app, so a cat appears on your desktop while it runs. It needs the Electron binary. Run it on Windows before you open a pull request that touches `src/main`, `src/preload`, `src/renderer` or packaging.
- The script runs one step at a time and writes each step's log to `.claude/state/logs/`. A skipped step means "not verified", never "passed".
- The single steps are `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and `npx playwright test`.
- On a shared machine, wrap other heavy commands so they run one at a time: `node scripts/with-lock.mjs <label> -- <command>`.

A change is done when:
1. it exists and has tests that fail without it;
2. `node .claude/scripts/verify.mjs fast` passes on the final tree;
3. every claim in the pull request carries an honesty label (below).

## Branches, commits and pull requests

- Never commit to `main`. Use one branch per change, for example `feat/<topic>`, `fix/<topic>` or `docs/<topic>`.
- Write small Conventional Commits: `type(scope): summary`, with types such as `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci` and `chore`. Examples from the history: `docs(gizeverse): Phase Zero baseline and portability audit`, `fix(v1.2 RES-7): hiding the cat ends a playing cue at once`.
- Stage explicit paths (`git add src/core/movement/foo.ts`), not everything at once.
- Open pull requests as drafts. Mark them ready once `verify full` has passed.
- Do not force-push, do not rewrite history that others have pulled, and do not skip hooks with `--no-verify`. Maintainers merge; nobody pushes to `main`.

## Say what you actually checked

Label every claim in a pull request, an issue reply or a report:

| Label | Meaning |
|---|---|
| REAL | You ran it against the real component and saw the result. Give the command, its exit code and the lines that show it. |
| MOCKED | It passed only with test doubles. Say which test and what was mocked. |
| SIMULATED | It ran against a stand-in: an emulator, a container, a virtual display, synthetic data or a faked platform. Say what stood in for what. |
| UNVERIFIED | It did not run, it was only compiled or type-checked, or you know it only from docs or config. Say why, and what would verify it. |

"The config file exists", "the docs say so" and "it should work" are UNVERIFIED. Do not upgrade a label later: MOCKED stays MOCKED. Claims about a device, a cloud service or third-party software are REAL only if you observed them directly.

## Platform statuses

Each platform's capabilities carry one of six statuses:

| Status | Meaning |
|---|---|
| IMPLEMENTED_AND_LOCALLY_VERIFIED | The code exists and ran on that platform, with the result recorded in a report |
| IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | The code exists behind platform checks but has never run on that platform |
| ARCHITECTURALLY_VALIDATED | The design is shown to fit, by code reading or bundling; it is not implemented as a feature |
| SIMULATED_OR_MOCK_TESTED | It ran only against fakes or in a virtual environment (Xvfb, Weston, device emulation) |
| BLOCKED_BY_PLATFORM_OR_PERMISSION | The platform or a permission prevents it, or no maintainer can reach the platform |
| NOT_IMPLEMENTED | Nothing exists |

**A platform is never advertised as supported without execution evidence on it.** That applies to the README, release notes, package descriptions and issue replies. Say exactly what ran: "builds and passes its unit tests on Ubuntu in a container" is a fair claim; "supports Linux" is not, until the app itself has run on Linux and the result is recorded. A green CI job, a package that builds, or an emulator run is not evidence that the cat works on that desktop.

Where the statuses live (ADR 0004 §2.3): one data table in `src/shared/platform.ts` is the claim. `node scripts/capability-matrix.mjs` renders it to [docs/gizeverse/capability-matrix.md](docs/gizeverse/capability-matrix.md), and a test fails when that file is stale. Never restate a status by hand anywhere else; link to the rendered matrix. Evidence goes in [docs/TEST_REPORT.md](docs/TEST_REPORT.md) and the reports in [docs/gizeverse/](docs/gizeverse/).

## Invariants

Do not break these. If a change seems to need one of them to move, open an issue first instead of sending the pull request.

1. **Privacy is off by default.** Screen analysis and cloud egress are off by default, and only the consent actions in the main process can turn analysis on (`rejectConsentBypass` in `src/main/ipc/handlers.ts`). See [docs/PRIVACY.md](docs/PRIVACY.md).
2. **No keyboard hook and no telemetry.** No keystroke or clipboard capture, no analytics, no crash upload. Window titles never leave `src/main/win32` and are read only while analysis is on.
3. **Sandboxed renderers and validated IPC.** Renderers run sandboxed, with context isolation and without Node. Every IPC payload is validated with zod and its sender is checked. See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) (T1, T2).
4. **The overlay never blocks the desktop.** It is click-through by default, and interactive only over the cat's hit region while the renderer is healthy (T8).
5. **No test hooks in packaged builds.** Test hooks and DevTools exist only in unpackaged development and test runs (T13).
6. **`src/core` and `src/shared` stay platform-agnostic.** No Electron, Node built-ins or koffi there; ESLint enforces it. The simulation decides behaviour, and AI may only pick a reaction from the allow-list.

Persistent identifiers are frozen too ([ADR 0004 §9](docs/adr/0004-gizeverse-platform.md) has the full list, and tests pin each one). Among them:
- the appId `io.github.enesiltas.desktopcat`;
- the package `productName` "Desktop Cat", which is the app name, the user-data folder, the single-instance lock and the macOS Keychain item;
- the executable names `DesktopCat` and `desktop-cat`;
- the `DESKTOP_CAT_*` environment variables and the `desktop-cat://` scheme.

Renaming any of them loses users' cats, settings, API keys or startup entries. The GizeCat branding changes display strings only, and the Windows installer keeps the name "Desktop Cat" until an upgrade test on a disposable machine has passed.

## Where code goes

| Path | What goes there |
|---|---|
| `src/shared/` | Contracts and zod schemas: settings, cat state, IPC, sim, perception |
| `src/core/` | Pure logic: behaviour (state machine, personality, memory), movement, interaction (gestures, click-through), perception (analysis, privacy gate, limits, AI output), display math |
| `src/main/` | Electron main process: app and catHost composition, `overlay/`, `win32/` (koffi), `perception/` (capture, adapters), `store/`, `diagnostics/`, `ipc/`, `lifecycle/` |
| `src/main/platform/` | ADR 0004 §3: `createPlatformServices(probe, screen)`, runtime capability detection, boot decisions (sandbox), the macOS menu |
| `src/main/linux/` | Linux-only native checks (the X11 compositing-manager probe) |
| `src/renderer/overlay/` | The procedural cat rig and its animator |
| `src/renderer/settings/` | The settings UI |
| `src/preload/` | Typed bridges between renderers and main, nothing else |
| `src/web/` | *Planned (ADR 0004 §8).* The web host: the real catHost, sim and overlay renderer in one page, with no network, no key listeners and no perception |
| `native/uia-helper/` | The Windows UI Automation helper (tab-strip geometry only) |
| `tests/unit`, `tests/integration` | Vitest |
| `tests/e2e` | Playwright against the real app (Windows) |
| `scripts/` | Build, QA, benchmarks, packaging checks |
| `docs/` | ADRs, privacy, threat model, guides, test report |

## Adding a platform adapter

1. **Capability table first.** Before writing the adapter, set the declared status of each capability on the target platform in the capability table (`src/shared/platform.ts`), and regenerate the matrix. Start honestly, usually at NOT_IMPLEMENTED or ARCHITECTURALLY_VALIDATED. An IMPLEMENTED_AND_LOCALLY_VERIFIED entry must name its evidence in a report. For now the table's test also forbids that status for darwin, every Linux id (linux-x11, linux-xwayland, linux-wayland), android and ios. No maintainer can run their real desktops or devices, and a container is not a desktop session.
2. **Write the adapter behind the platform check.** New per-OS decisions go in `src/main/platform/` and are chosen in `createPlatformServices(probe, screen)`.
   - The Windows adapters that predate GizeVerse (`src/main/win32`, `src/main/uia`, the login-item registry) guard themselves and stay where they are.
   - Never branch on the platform in `src/core` or `src/shared`; ESLint forbids `process` there.
3. **Give it a safe fallback.** When the capability is not available on the machine at run time, report `{ available: false, reason }` and use the existing "unavailable" stub. Never ship an empty implementation that pretends to work. Privacy fails closed: no capture and no window metadata. The overlay fails safe: if click-through and always-on-top cannot be guaranteed (native Wayland, for example), no overlay is created. Settings hides controls that cannot work and shows the reason.
4. **Leave Windows unchanged.** The win32 path must construct today's adapters exactly as before. `verify.mjs full` on Windows is the proof.
5. **Test it.** Use unit tests with fake screens and a fake environment for the platform (SIMULATED_OR_MOCK_TESTED). If you ran it on real hardware, record the setup and the result in `docs/TEST_REPORT.md` and file a platform report.
6. **Raise the status only to what ran.** Window adapters and screen capture on a new OS need a maintainer decision first: privacy exclusions are keyed on Windows executable names today (ADR 0004 §14, risk R2).

## Easy to get wrong

- `npm run build` wipes `out/`, including previews, QA images and benchmark output. Copy anything you want to keep first.
- Overlay windows are never hidden or moved (that works around Electron's transparent-window bugs). Display changes recreate them.
- Tests never contact real AI providers or a local AI server running on your machine. The adapters are tested against mock servers.
- `scripts/install-test.ps1` and `scripts/upgrade-test.ps1` install the app and touch the per-user startup entry. Run them only on a disposable Windows user or VM, never on a machine where you use GizeCat.
- Multi-monitor, mixed DPI and Windows 10 have not been tested on hardware. Reports are welcome (use the platform report issue template).
