# Performance and dependency review

Machine: Windows 11, the shared hybrid CPU of the v1.2.0 report. The machine's load differs from run to run, so CPU figures are indicative.

## Runtime cost of the platform layer (Windows)

| Addition | Cost on Windows | Evidence |
|---|---|---|
| Platform services, coordinates | Built once at start. The win32 coordinate path makes the same Electron calls as v1.2, so there is no per-tick work. | code + tests (REAL) |
| Overlay gate | None on Windows: the gate is X11-only (`allowOverlays` undefined). | code |
| Runtime capability report | Built on demand (Settings state, diagnostics) plus one log line at start; reads cached service states only | code |
| Coarse idle | Off Windows only (review L1) | code |

### Resource benchmark

`node scripts/bench.mjs --phase-sec=60`. CPU is in % of one core over all app processes.

Run on the app code of `60c408b` (later commits change docs and tests only) and on v1.2.0's own code (`58b4cd6`, exported to a scratch folder and built the same way), **back to back on the same machine**. Evidence: [evidence-bench-ab.txt](evidence-bench-ab.txt), [evidence-bench-run2.txt](evidence-bench-run2.txt), [docs/bench/](../bench/).

| Phase | v1.2.0 code, today (90 s ×2) | Current code (60 s ×1, 90 s ×3) | v1.2.0 report (2026-11-05, 90 s) |
|---|---|---|---|
| Awake | 1.23, 1.31 (mean 1.27) | 1.33, 1.39, 1.48, 1.15 (mean 1.34) | 0.91 |
| Asleep | 0.68, 0.92 | 0.83, 0.66, 0.67, 0.66 | 0.63 |
| Hidden | 0.03, 0.03 | 0.03, 0.03, 0.03, 0.02 | 0.02 |
| Paused | 0.66, 0.64 | 0.74, 0.64, 0.60, 0.59 | 0.57 |

Reading, all REAL measurements:
- **Under the same machine state, the current code is within the run-to-run spread of v1.2.0's code.** The awake mean differs by +0.07 pp, while the current code's own awake readings range over 0.33 pp. Asleep and paused are equal or lower.
- **No regression is measurable.** One smaller than about 0.1 pp cannot be excluded with 6 runs.
- **The 0.91 % of the v1.2.0 report reflects that day's machine state:** v1.2.0's own code measures 1.23–1.31 % today.
- **Timers and handles.** Main-process timers stay at 5 and handles at 7 in every phase, so no leak growth is visible. Private memory is 320–400 MB, as before.
- **Gate B12** checks awake ≤ 1.5 % and at most 0.3 pp above a fixed 1.05 % baseline measured for v1.1.1. It **passed in 2 of the 4 current runs** (1.33, 1.15) and failed narrowly in 2 (1.39 and 1.48: 0.34 and 0.43 pp above 1.05). Against v1.2.0's code under today's conditions the gate's absolute baseline is not comparable. That should be reconsidered next milestone: compare against same-day runs of the previous release.

## Off-Windows runtime cost

- **X11 compositor probe.** One libX11 connection, one extension query, one atom and one selection-owner query every 10 s (about a millisecond, not measured on real hardware).
- **Idle.** `powerMonitor.getSystemIdleTime()` once per cursor poll; it is a cheap system call (UNVERIFIED cost).

## Bundle and package sizes

| Artifact | Size | Note |
|---|---|---|
| Windows app.asar | 1.2.0: 1,365,288 bytes; now 1,407,850 bytes (+42.6 KB, +3.1 %), 115 entries | app code only; `out/web*` excluded (review H1; 0 web entries, REAL) |
| Windows unpacked payload | about 389 MB | Electron dominates; unchanged in kind |
| Linux AppImage / tar.gz (`d97c36f`) | 126,761,781 / 120,556,977 bytes | built in a container (REAL) |
| Web host `out/web/main.js` | about 870 KB minified | About 444 KB is zod v4 with all its locales (src/shared imports `{ z }`). It loads once and makes no network requests. Shrinking it (zod/mini, or no locales) is a next-milestone item. |
| Web host first load | 3 files (HTML, JS, CSS) | E2E counts requests (REAL) |

## Dependencies

| Item | State |
|---|---|
| Production dependencies | `koffi` (runtime), with `zod` bundled. **No new package** on this branch. |
| `npm audit --omit=dev` | 0 vulnerabilities (REAL, 2026-11-06) |
| `npm audit` | 15 moderate, all one `minimatch` denial-of-service advisory, through eslint, typescript-eslint and electron-builder; build-time only |
| Electron | 44.9.3 pinned; 44.10.2 available. Electron 44 is end-of-life on 2027-03-02. **Next milestone:** bump within 44.x behind a Windows regression run. Electron 45 deprecates the synchronous safeStorage API that secretStore uses. |
| Platform binaries | koffi ships per-OS binaries: win32-x64 in Windows packages, linux-x64 in Linux packages (needed for the compositor probe), and none in macOS packages (excluded). |
| Licences | All runtime dependencies are MIT; see [11-open-source-readiness.md](11-open-source-readiness.md) |
