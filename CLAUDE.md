# Desktop Cat

A Windows 10/11 desktop companion: one animated, persistent cat in transparent, always-on-top, click-through Electron overlays, with optional opt-in screen perception. Status: v1.0.0, validated on Windows 11 (see docs/TEST_REPORT.md); installer unsigned.

## Invariants
Never violate these. If a task seems to require changing one, stop and ask.
- Screen analysis and cloud egress are OFF by default; only the consent actions in main can enable analysis (`rejectConsentBypass`) — docs/PRIVACY.md. *Pinned in .claude/standard.json.*
- No keyboard hook, no keystroke/clipboard capture, no telemetry; window titles never leave `src/main/win32` and are read only while analysis is on — docs/PRIVACY.md.
- Renderers stay sandboxed with context isolation and no Node; every IPC payload is zod-validated and sender-checked — docs/THREAT_MODEL.md. *Pinned.*
- The overlay must never block the desktop: click-through by default, interactive only over the cat's hit region while the renderer is healthy (T8).
- Test hooks and DevTools never exist in packaged builds. *Pinned.*
- `src/core` and `src/shared` stay platform-agnostic (ESLint-enforced); the sim is the source of truth for behaviour, AI may only pick from the reaction allow-list.
- Never claim REAL for something not executed; label MOCKED/UNVERIFIED (docs/TEST_REPORT.md is the evidence record).

## Commands
- Setup: `npm ci --ignore-scripts` then `node node_modules/electron/install.js`
- Verify (definition of done): `node .claude/scripts/verify.mjs fast` · before PRs: `node .claude/scripts/verify.mjs full` (builds and runs the Playwright E2E suite, which puts a real cat on the desktop)
- Run locally: `npm run dev` · package: `npm run package` → `release/` · packaged checks: `node scripts/smoke-packaged.mjs`, `powershell -File scripts/install-test.ps1`
- Shared machine: wrap any other heavy command in `node scripts/with-lock.mjs <label> -- <cmd>`

## Layout
- `src/shared/`: contracts and zod schemas (settings, cat state, IPC, sim, perception)
- `src/core/`: pure logic — behavior (state machine, personality, memory), movement, interaction (gestures, click-through), perception (analysis, privacy gate, limits, AI output), display math
- `src/main/`: Electron main — app/catHost composition, overlay/, win32/ (koffi), perception/ (capture, adapters), store/, diagnostics/, ipc/, lifecycle/
- `src/renderer/overlay/`: procedural cat rig and animator · `src/renderer/settings/`: settings UI · `src/preload/`: typed bridges
- `tests/unit`, `tests/integration` (vitest), `tests/e2e` (Playwright, real app) · `scripts/`: build, QA, bench, packaging checks · `docs/`: ADR, privacy, threat model, guides, test report

## Project notes
- Electron 44 downloads its binary lazily: run `node node_modules/electron/install.js` after a fresh install.
- `npm run build` wipes `out/` (previews, QA images, bench output); copy anything worth keeping elsewhere first.
- Never contact `localhost:11434` (the user's Ollama) or real AI providers from tests; adapters are tested against mock servers.
- Overlay windows are never hidden/moved (Electron transparent-window bugs); display changes recreate them.
- The machine's taskbar auto-hides (work area = full screen); multi-monitor/mixed DPI and Windows 10 are untested on hardware.

The engineering standard (definition of done, honesty labels, git rules, skills, agents) loads from `.claude/rules/standard.md`.
