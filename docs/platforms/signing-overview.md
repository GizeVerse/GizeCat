# Signing overview: GizeCat 1.5.0 release candidate (1.4.0 record below)

## 1.5.0 release candidate: current state

Windows and Android only; macOS and iPad are not part of this release candidate. Details and exact owner steps: [1.5.0 signing readiness report](../releases/1.5.0-signing-readiness.md).

**No GizeCat 1.5.0 file is signed with a release credential.** No certificate, SignPath project or production Android keystore exists, and nothing was bought or applied for. No test, emulator, simulator or app launch was performed for 1.5.0 code; all of it is IMPLEMENTED and statically verified only. Nothing is published or tagged.

| File (in `release/1.5.0/`, named by the build; hashes are not recorded in repository docs) | Signature |
|---|---|
| `windows/Desktop-Cat-Setup-1.5.0-x64.exe`, `windows/Desktop-Cat-Setup-1.5.0-arm64.exe` | **Unsigned** (NSIS). Windows shows no verified publisher; SmartScreen or Smart App Control may warn or block. Not yet checked with `scripts/verify-windows-signature.ps1` for 1.5.0 |
| `android/GizeCat-1.5.0-android-unsigned.apk` | **Unsigned**: Android will not install it |
| `android/GizeCat-1.5.0-android-unsigned.aab` | **Unsigned**: Google Play will not accept it |
| `android/GizeCat-1.5.0-android-trial-debugsigned.apk` | **Android debug certificate**, application id `io.github.gizeverse.gizecat.trial`, for sideload trials only |
| `SHA256SUMS.txt` | Checksums of the files above, written by `npm run release:sums` |

- The signing infrastructure in the repository is unchanged since 1.4.0 (`electron-builder.yml` SHA-256 and timestamp settings, `scripts/sign-windows.ps1`, the SignPath path of `release.yml`, `android/app/build.gradle.kts` key selection, `android-release.yml`). It is IMPLEMENTED and has never been run on a GizeCat file.
- A production-signed Android app cannot update the debug-signed trial: the certificate and the application id both differ, so they are separate apps. See the upgrade warning in the readiness report.
- A signature shows who published a file and that it is unchanged. It does not show that the app works, that Windows or Google trusts it, or that it is free of malware.
- The Android 1.4.2 floating cat was OWNER-VERIFIED on one physical phone; Windows 1.3.0 ran on Windows 11 hardware. Neither says anything about the signing of 1.5.0.

---

## 1.4.0 record (historical)

The sections below describe the 1.4.0 candidate as checked on 2026-11-10 and stay as they were. Their hashes and sizes belong to the 1.4.0 files only.

Where signing stands on every platform, what is prepared, and what only the owner can do. Status words: [README.md](README.md#status-vocabulary-for-140). Checked on 2026-11-10 on the candidate branch `release/1.4.0-universal-devices`.

**No GizeCat 1.4.0 file carries a release signature.** Nothing was bought, enrolled in or applied for. No test, emulator, simulator or app run took place; every statement below comes from static inspection or cryptographic signature verification of files.

## Signing inventory (what exists today)

| Platform | Credential | Where it was looked for | Found |
|---|---|---|---|
| Windows | Code-signing certificate, SignPath project | `Cert:\CurrentUser\My` and `Cert:\LocalMachine\My` on the build machine: no code-signing certificate. The repository: no certificate, `.pfx` or `.p12` tracked. GitHub: no `windows-signing` environment, secret or variable | None |
| macOS | Developer ID Application certificate, notarization credentials | Repository (no `.p12` or `.p8` tracked); GitHub has no `macos-signing` environment, secret or variable | None |
| Android | Release (upload) keystore | `android/keystore.properties`, `%USERPROFILE%\.gizecat-keys`, the four `ANDROID_*` variables, tracked key files, GitHub `android-signing` environment | None. Only the SDK's `~/.android/debug.keystore`, which signs the trial APK and never a release |
| GitHub | Secrets and variables | Repository level: none of either. Environments: only `github-pages` (deploys from `main` only). Organization-level secrets could not be listed with the available token (UNVERIFIED) | None at repository level |

Names were checked, never values: GitHub cannot return a secret value, and no keystore or password was opened.

## The candidate artifacts and their exact signing status

Built from commit `d3cdb6b`; branch head `07cc19a` adds documentation only. The files are in `release/1.4.0/`, are identical to the assets of the draft prerelease v1.4.0, and are listed in `release/1.4.0/SHA256SUMS.txt`.

| File | Bytes | SHA-256 | Signature |
|---|---|---|---|
| `windows/Desktop-Cat-Setup-1.4.0-x64.exe` | 121,546,236 | `8d0a801d523ebf34c5b4525c420e527ddb25926eb977fb6605d755ba629f9c38` | **NotSigned** (Authenticode; the inner `DesktopCat.exe`, `DesktopCatUia.exe` and `elevate.exe` are also unsigned) |
| `windows/Desktop-Cat-Setup-1.4.0-arm64.exe` | 116,041,548 | `ea741167394785f3f62d8240de0c5ca367700dac19cd1ad09b6e4d1b76661e2a` | **NotSigned**, same |
| `mac/GizeCat-1.4.0-mac-x64-adhoc.zip` | 136,575,688 | `79033184f14371b85839fedcee9575dfd373a1f2ea85ecba93c97ef78c964c41` | **Ad-hoc** (no signer identity), not notarized |
| `mac/GizeCat-1.4.0-mac-arm64-adhoc.zip` | 130,906,589 | `1154b39e69c8b1de6486e60a3e5f7f2bfe665230bad72a89684e10d782b000a9` | **Ad-hoc**, not notarized |
| `web/GizeCat-web-1.4.0.zip` | 444,862 | `5ea8ba93b0fab3f1b761cc4a790710eeb9b76bea0ef8ca1355e001c69de305db` | Not applicable (served over HTTPS when deployed; not deployed) |
| `android/GizeCat-1.4.0-android-unsigned.apk` | 650,757 | `a1a0ff2a6275b9dcd0f288f5daa5dd1a688af6c412b26dee75f916894bedb46a` | **Unsigned** (Android will not install it) |
| `android/GizeCat-1.4.0-android-unsigned.aab` | 638,754 | `054e105e3ff26b837be89a849ca0e60eccfb413e6e74075084b83d74741ef205` | **Unsigned** (Google Play will not accept it) |
| `android/GizeCat-1.4.0-android-trial-debugsigned.apk` | 654,873 | `bd7d8ac5911a61f942a53357e2f160040938431ffa5873e8f0e7be964976c74e` | **Debug key** (`CN=Android Debug`, certificate SHA-256 `162fffa6298efb7c668a7b4f41ae87720c90caa383b460449737e53dadcd53a1`), APK Signature Scheme v2; separate application id; never a release |

Older artifacts stay untouched and are not part of 1.4.0: `release/Desktop-Cat-Setup-1.1.0.exe`, `1.1.1.exe`, `1.2.0.exe` and `release/1.3.0/`.

## Readiness per platform

| Platform | Prepared | Status | Next owner action |
|---|---|---|---|
| **Windows** x64 + ARM64 | Two routes:<br>- CI: `release.yml` → `signpath`, with verification and byte comparison;<br>- local: `scripts/sign-windows.ps1`.<br>SHA-256 + RFC 3161 settings in `electron-builder.yml`. | IMPLEMENTED, never run; REQUIRES_OWNER_CREDENTIALS | Apply to SignPath Foundation (free) or buy a Certum Open Source certificate ([windows-signing.md](windows-signing.md)) |
| **macOS** x64, arm64, universal | `macos-packages.yml` → `developer-id`, which checks:<br>- the Developer ID identity, hardened runtime and secure timestamp;<br>- Gatekeeper's notarization verdict and stapling;<br>- the shipped zips;<br>- a signed, notarized (blocking) and stapled DMG;<br>- Apple's submission record. | IMPLEMENTED, never run; REQUIRES_OWNER_CREDENTIALS | Paid Apple Developer Program, Developer ID Application certificate, API key ([macos-signing.md](macos-signing.md)) |
| **Android** | Signing from `keystore.properties` or the environment.<br>`android-release.yml` refuses:<br>- debug keys;<br>- APK/AAB certificate mismatch;<br>- with `ANDROID_EXPECTED_CERT_SHA256` set, any other certificate.<br>Owner script `scripts/android-create-upload-key.ps1`. | IMPLEMENTED; no key exists; REQUIRES_OWNER_CREDENTIALS | Run the key script yourself, back the key up, decide Play App Signing option A or B ([android-signing.md](android-signing.md)) |
| **iPadOS / web (PWA)** | `pages.yml`; Pages configured for GitHub Actions (expected `https://gizeverse.github.io/GizeCat/`).<br>Static review on 2026-11-10 found the bundle consistent:<br>- relative `start_url` and `scope` (`./`);<br>- `standalone`; icons 192/512 and maskable;<br>- a 180×180 `apple-touch-icon`; Apple web-app meta tags;<br>- a service worker;<br>- a CSP with `connect-src 'none'`. | COMPILED_OR_PACKAGED; **not deployed** (the address returns HTTP 404; Pages has never built) | Bring `pages.yml` to `main` (the `github-pages` environment deploys from `main` only) and run it ([ipados.md](ipados.md)) |

No platform is VERIFIED. A signature, once it exists, shows who published a file and that it is unchanged. It does not show that the app works.

## Where things live

| What | Path |
|---|---|
| Windows signing guide | [windows-signing.md](windows-signing.md) |
| macOS signing guide | [macos-signing.md](macos-signing.md) |
| Android signing guide | [android-signing.md](android-signing.md) |
| Everything the owner does, in order | [release-owner-actions.md](release-owner-actions.md) |
| Workflows, secret names and formats | [release-automation.md](release-automation.md); `.github/workflows/release.yml`, `macos-packages.yml`, `android-release.yml`, `pages.yml` |
| SignPath artifact configurations (reference copies) | `.github/signpath/` |
| Signature tools (read files, run nothing) | `scripts/verify-windows-signature.ps1`, `scripts/compare-signed-pe.mjs`, `scripts/check-mac-payload.mjs --expect-signature adhoc\|cms` |
| Owner tools (agents never run them) | `scripts/sign-windows.ps1`, `scripts/android-create-upload-key.ps1` |

## Rules that apply on every platform

- Keys, certificates with private keys, keystores, passwords and API tokens never enter the repository, an issue, a chat, a log or a message to an agent. CI secrets live only in GitHub Environments with a required reviewer.
- Every signing path fails closed: missing or partial credentials, an invalid signature, a missing timestamp, a debug key or a refused notarization stop the job, and no file is labelled signed.
- Unsigned files are preserved. Signed files get new names or folders and new checksums, with a provenance record mapping unsigned to signed.
- A release's single `SHA256SUMS.txt` is rebuilt from the files actually published.
