# Open-source readiness

Status: 2026-11-06, branch `feat/gizeverse-foundation`.
- **Nothing has been published.** No public repository and no GitHub organization were created, and nothing was pushed: the repository has no remote, and creating either needs the owner's explicit authorization and credentials.
- **This report covers what a first public release would need, and what exists now.**
- Labels: REAL means checked here, UNVERIFIED means not checked.

## What exists

| Item | File | Status |
|---|---|---|
| License | [LICENSE](../../LICENSE) | MIT, © 2026 enesiltas (REAL, unchanged) |
| Third-party notices | [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) | Runtime components listed, now with full license texts for zod (bundled; its license comment is stripped by the bundler, so this was a real gap), koffi, and koffi's vendored node-addon-api and node-api-headers. The texts were copied from the installed packages and checked as exact substrings (REAL). |
| README | [README.md](../../README.md) | GizeCat naming, GizeVerse architecture, a platform section that links the generated matrix |
| Contributing guide | [CONTRIBUTING.md](../../CONTRIBUTING.md) | Setup, verify, honesty labels, the six platform statuses, invariants, frozen identifiers, how to add a platform |
| Code of conduct | [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md) | Contributor Covenant 2.1, verbatim from EthicalSource/contributor_covenant (REAL fetch) |
| Security policy | [SECURITY.md](../../SECURITY.md) | Scope, out of scope, reporting, response goals |
| Issue and PR templates | `.github/ISSUE_TEMPLATE/` (bug, feature, platform report; blank issues off), `.github/pull_request_template.md` | YAML parses (REAL); GitHub's acceptance of the forms is UNVERIFIED |
| CI | `.github/workflows/ci.yml` | Windows, Ubuntu and macOS matrix. **UNEXECUTED**: Actions on this account's private repositories have not started a job since 2026-10-02 (billing), and there is no remote. |
| Release workflow | `.github/workflows/release.yml` | Manual only. Builds the Windows NSIS installer and the Linux AppImage/tar.gz, then uploads them as workflow artifacts. It never publishes, signs or uses secrets. **UNEXECUTED.** |
| Platform support matrix | [capability-matrix.md](capability-matrix.md) | Generated from `src/shared/platform.ts`; a test fails if it is stale (REAL) |
| Roadmap | [ROADMAP.md](../../ROADMAP.md) | Directions, no dates |
| Dependency audit | `npm audit` | Production dependencies: 0 vulnerabilities. Dev tooling: 15 moderate, all one `minimatch` denial-of-service advisory, through eslint, typescript-eslint and electron-builder; nothing of it ships (REAL, 2026-11-06). |

## Owner decisions before publishing

The project must not invent any of these:

1. **Contacts.** A security contact for SECURITY.md and an enforcement contact for CODE_OF_CONDUCT.md. Both are clearly marked placeholders now. Alternatively, GitHub private vulnerability reporting can be turned on after the repository is public.
2. **Where the code lives.** The GizeVerse organization (name, account), the repository name, and whether `io.github.enesiltas.desktopcat` stays the appId. It is frozen: changing it orphans every install (ADR 0004 §9).
3. **Linux deb/rpm metadata.** electron-builder needs a `homepage` and a maintainer e-mail for deb and rpm, and none is set. Only the AppImage and tar.gz are configured.
4. **SECURITY.md response goals** (7, 14 and 90 days). They were drafted as goals and need the owner's confirmation.
5. **Signing.** Windows Authenticode, and a macOS Developer ID with notarization. Without them, SmartScreen and Gatekeeper warn, and macOS distribution is effectively blocked.

## License review notes

- **The project.** It is MIT and all artwork is original procedural code, so there are no asset licenses to track.
- **Shipped runtime dependencies.** Electron (MIT, with Chromium's notices in `LICENSES.chromium.html`), zod (MIT), and koffi (MIT, plus its vendored MIT headers). On Linux the package also contains `@koromix/koffi-linux-x64` (MIT, the same author; its installed package has no license file, like the win32 one).
- **Before a Linux release:**
  - add a notices line for `@koromix/koffi-linux-x64`;
  - add a line for the AppImage runtime that electron-builder embeds (its license is UNVERIFIED here).
- **elevate.exe.** The Windows installer carries electron-builder's `elevate.exe` (`nsis.packElevateHelper` defaults to true). It is not listed in the notices, and its license is UNVERIFIED here. Dropping it (`packElevateHelper: false`, safe in principle because `perMachine` and `allowElevation` are false) changes the installer, so it waits for an install test on a disposable machine (ADR 0004 §11).
- **NSIS.** The installer stub is NSIS (zlib/libpng license), and the notices already say so.

## Hygiene checks done here (REAL)

- **No secrets in the tree or the history.** A full scan of all 110 commits (2026-11-07) covered key patterns (Anthropic, OpenAI, GitHub, AWS, Slack, PEM, `.env`), personal paths, captured data and committed binaries. Every key-shaped string is a test fake:
  - `sk-ant-test…` and `sk-ant-e2e-NOT-A-REAL-KEY…`;
  - the redaction test's `ghp_abc…`;
  - a base64 sample.

  No `.env`, `.pem` or `.pfx` file, large binary or real-desktop screenshot ever existed in history.
- **Personal data: corrected.** An earlier version of this report said the tree had none; that scan only covered e-mails and keys. The full scan found:
  - eight lines in research docs with the developer's local scratch paths (Windows user folder, a local job folder id);
  - the names of apps open during one diagnosis;
  - machine-specific notes in CLAUDE.md.

  All are reworded in HEAD (`d44b182`). The **history is published unrewritten**, so older commits still contain those paths and names. They are low-sensitivity (the user name is visible in the public author e-mail anyway), and rewriting would change every commit hash that these reports cite as evidence.
- **Commit metadata.** Author and committer are `enesiltas <enes1iltas2@gmail.com>`, the address already public on that GitHub profile. The commits carry `Co-Authored-By` and `Claude-Session` trailers.
- **Contact addresses.** The Code of Conduct and the notices contain only the verbatim upstream addresses.
- **Sample settings files** contain no keys (docs/settings.example.json is the template).
- **Reproducible steps.** CONTRIBUTING and the README give the commands; `verify.mjs` is part of the repository.

## Not done

- No public repository, organization, release, tag or package registry entry was created.
- No CI run was observed. The workflows are unexecuted drafts that a person must check on the first real run.
