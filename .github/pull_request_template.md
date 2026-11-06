## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## How it was verified

<!--
Paste the summary of `node .claude/scripts/verify.mjs fast` (and `full`, if you ran it).
Label every claim REAL, MOCKED, SIMULATED or UNVERIFIED (see CONTRIBUTING.md).
For platform work, name the platform, the setup and the status you are claiming.
-->

## Checklist

- [ ] `node .claude/scripts/verify.mjs fast` passed on the final tree of this branch
- [ ] `node .claude/scripts/verify.mjs full` passed on Windows, or this change does not touch `src/main`, `src/preload`, `src/renderer` or packaging
- [ ] New or changed behaviour has tests that fail without this change
- [ ] Every claim above carries an honesty label (REAL, MOCKED, SIMULATED, UNVERIFIED)
- [ ] Platform statuses are updated in the capability table and the generated matrix, or no platform behaviour changed
- [ ] No platform is described as supported without execution evidence on it
- [ ] No invariant changed: privacy off by default, no keyboard hook or telemetry, sandboxed renderers and zod-validated IPC, click-through overlay, no test hooks in packaged builds, platform-agnostic `src/core` and `src/shared`
- [ ] No persistent identifier changed (appId, user-data folder, executable name, `DESKTOP_CAT_*` variables, `desktop-cat://` scheme)
- [ ] Small conventional commits on a branch other than `main`
