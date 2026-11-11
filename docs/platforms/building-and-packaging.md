# Building and packaging GizeCat (1.4.0, with the 1.5.0 release candidate)

How to set up a development environment for each platform, and the exact commands that produce each artifact (the 1.5.0 release candidate section comes first; the step lists below were written for 1.4.0). The commands come from `package.json` and the scripts in `scripts/`. **A build is not a test**: an artifact that builds is COMPILED_OR_PACKAGED, nothing more ([status vocabulary](README.md#status-vocabulary-for-140)).

## 1.5.0 release candidate

GizeCat 1.5.0 ("Living Companion") is a **release candidate**: `package.json` says 1.5.0, `android/version.properties` says `versionName` 1.5.0 and `versionCode` 10500. Nothing is published or tagged; the owner reviews and publishes. The rest of this page was written for 1.4.0 and its commands still apply; the 1.4.0 macOS and iPad material is unchanged and is not part of this release candidate (Windows and Android only).

**Status of the artifacts.** They are COMPILED_OR_PACKAGED. No test, emulator, simulator or application launch was performed for any 1.5.0 code, so everything new is IMPLEMENTED and statically verified only. The Android 1.4.2 floating cat was OWNER-VERIFIED on one physical phone; tablets and other phones are not individually verified. The Windows 1.3.0 baseline ran on Windows 11 hardware; the 1.4.0 Preview and 1.5.0 were never run by the build tooling.

### Which commands built what

The release candidate was produced by one detached script, `.claude/state/publish/build-150.mjs`. It runs one heavy step at a time, each under `scripts/with-lock.mjs`, logs each step to `.claude/state/logs/build-150-<step>.log`, runs no tests and launches no application, and stops at the first failing step.

| Step | Command | Output |
|---|---|---|
| 1. Windows installers | `node scripts/with-lock.mjs win-150 -- npm run package:win` (stages the ARM64 koffi package, runs `node scripts/build.mjs`, then `electron-builder --win nsis --x64 --arm64 --publish never`) | `Desktop-Cat-Setup-1.5.0-x64.exe`, `Desktop-Cat-Setup-1.5.0-arm64.exe`, `win-unpacked/`, `win-arm64-unpacked/` written flat into `release/` |
| 2. Collect | The script moves those files (and `builder-debug.yml`) into `release/1.5.0/windows/`, the 1.4.0 layout | `release/1.5.0/windows/` |
| 3. Android release | `node scripts/with-lock.mjs android-150 -- node scripts/android-gradle.mjs :app:assembleRelease :app:bundleRelease` (rebuilds `out/web` first, copies it into the app assets, then Gradle) | `release/1.5.0/android/GizeCat-1.5.0-android-unsigned.apk` and `GizeCat-1.5.0-android-unsigned.aab` (unsigned because no production key exists) |
| 4. Android trial | `node scripts/with-lock.mjs android-150t -- node scripts/android-gradle.mjs :app:assembleTrial` | `release/1.5.0/android/GizeCat-1.5.0-android-trial-debugsigned.apk` (Android debug certificate, application id `.trial`) |
| 5. Checksums | `node scripts/release-sums.mjs` (same as `npm run release:sums`) | `release/1.5.0/SHA256SUMS.txt` |

The step 3 and 4 output names are fixed by `scripts/android-gradle.mjs`, which also writes `release/1.5.0/android/SHA256SUMS-android.txt` (a by-product, not attached). Windows signing and Android signing are not part of this build: the installers are unsigned, the release APK and AAB are unsigned and the trial APK carries the debug certificate. See the [signing readiness report](../releases/1.5.0-signing-readiness.md). Hashes and sizes are not recorded in repository documents; the maintainer fills them in later from `SHA256SUMS.txt`.

Two differences from the 1.4.0 step list below: this run packaged with `npm run package:win` into `release/` and then moved the files, instead of passing `-c.directories.output=release/<version>/windows`; and it ran neither the optional payload checker nor the packaged smoke test. `node scripts/check-win-payload.mjs` reads files only and may be run afterwards.

### Test-free commands (safe when tests are prohibited)

These type-check, lint, bundle or package. They launch no GizeCat window and run no test runner:

- `npm run typecheck` (two `tsc` projects), `npm run lint` (ESLint).
- `npm run build`, `npm run build:web`, `npm run android:web` (esbuild bundles; `build` also compiles the UIA helper with `csc.exe` when present, without running it).
- `npm run package`, `npm run package:win`, `npm run package:win:arm64`, `npm run package:dir` (electron-builder; the ARM64 routes download packages from the npm registry and Electron's win32-arm64 build, so they need the network).
- `npm run android:apk`, `android:aab`, `android:release`, `android:trial` (Gradle; they need the JDK, the Android SDK and, on first use, the network).
- `npm run package:web` (builds the static web zip).
- `npm run release:sums`, and the read-only inspectors `node scripts/check-win-payload.mjs ...`, `scripts/verify-windows-signature.ps1`, `scripts/compare-signed-pe.mjs`.
- Read-only git (`git log`, `git diff`, `git show`) and the documentation link checker `node .claude/state/publish/doc-linkcheck.cjs`.

A build that finishes proves only that it builds. It says nothing about whether the cat behaves.

### Commands that run tests or launch the app (do not use when tests are prohibited)

| Command | Why it is excluded |
|---|---|
| `npm test`, `npm run test:unit` | Vitest runs the unit and integration suites |
| `npm run test:e2e`, `npm run test:web` | Playwright starts the real app (a real cat on the desktop) or a browser |
| `npm run check`, `npm run verify` | Run type-check, lint **and** `npm test` |
| `node .claude/scripts/verify.mjs fast` and `full` | The repository's definition of done: test tiers, and `full` also builds and runs the Playwright suite |
| `npm run dev`, `npm start` | Launch Electron |
| `node scripts/smoke-packaged.mjs` | Launches the packaged `DesktopCat.exe` |
| `powershell -File scripts/install-test.ps1`, `scripts/upgrade-test.ps1` | Install the app and touch the startup entry; only for a disposable Windows user or VM |
| `scripts/qa-*.mjs`, `scripts/bench.mjs`, `scripts/win32-probe.cjs`, `scripts/taskbar-probe.mjs`, `scripts/uia-probe.mjs`, `scripts/login-item-probe.mjs` | Start the app or probe the live desktop |
| `.github/workflows/ci.yml` (push, pull request or manual) and `installer-check.yml` | Run `npm test`, Playwright, the smoke test and the install test on GitHub runners. Pushing a branch can start `ci.yml`; the owner's note says private-repository Actions have not started jobs since 2026-10-02 (billing), so treat CI as absent until a run really starts |
| `scripts/sign-windows.ps1`, `scripts/android-create-upload-key.ps1` | Owner tools that use credentials; agents never run them |
| Emulators, simulators, `gradlew test` or `connectedAndroidTest` | Nothing in this release candidate was run on an emulator or device |

Heavy commands go one at a time on a shared machine (`node scripts/with-lock.mjs <label> -- <command>`).

## Common setup (every platform)

You need Node 22.13+, 24 or 26 (enforced by `engines`; the project builds with Node 26.4) and npm.

```sh
npm ci --ignore-scripts                 # no dependency needs an install script
node node_modules/electron/install.js   # Electron downloads its binary lazily; run this after every fresh install
npm run typecheck                       # tsc for the main/preload/test project and the renderer/web project
npm run lint
```

- `npm run build` writes `out/` (the desktop app and `out/web`). It wipes `out/` first; copy anything you want to keep.
- On a shared machine, run heavy commands one at a time: `node scripts/with-lock.mjs <label> -- <command>`. The `android:*`, `package:mac:adhoc-wsl` and `package:mac:adhoc-docker` scripts already do this.
- After changing `src/shared/platform.ts`, regenerate the capability matrix: `node scripts/capability-matrix.mjs`.

## Windows (x64 and ARM64)

**Environment:** Windows 10 or 11 on x64. The tab-strip helper `DesktopCatUia.exe` is compiled by `npm run build` with the .NET Framework's `csc.exe`; without it the build only warns, and a release must not ship without the helper. The ARM64 installer is cross-built on the same x64 PC.

| Command | Output (in `release/`) |
|---|---|
| `npm run package` | `Desktop-Cat-Setup-<version>-x64.exe` and `win-unpacked/` (x64 only) |
| `npm run package:win` | Both installers: `Desktop-Cat-Setup-<version>-x64.exe`, `Desktop-Cat-Setup-<version>-arm64.exe`, `win-unpacked/`, `win-arm64-unpacked/` |
| `npm run package:win:arm64` | `Desktop-Cat-Setup-<version>-arm64.exe` and `win-arm64-unpacked/` only |
| `npm run package:dir` | `win-unpacked/` only (x64, no installer) |

`package:win` and `package:win:arm64` first run `node scripts/stage-koffi-arch.mjs --arch arm64`. It downloads `@koromix/koffi-win32-arm64` from the npm registry at the exact version and sha512 locked in `package-lock.json`, checks the binary's machine type, and puts it into `node_modules` without changing `package.json` or the lockfile. Do not run `npm ci` between staging and packaging, because that removes the staged package; if you do, stage again. The first ARM64 package also downloads Electron's win32-arm64 build (about 150 MB).

A release run into a versioned folder, step by step:

1. `npm ci --ignore-scripts` and `node node_modules/electron/install.js`.
2. `node scripts/with-lock.mjs stage-koffi -- node scripts/stage-koffi-arch.mjs --arch arm64`, then `git diff --exit-code -- package.json package-lock.json` (must print nothing).
3. `node scripts/build.mjs`.
4. `node scripts/with-lock.mjs package-win -- npx electron-builder --win nsis --x64 --arm64 --publish never -c.directories.output=release/<version>/windows`. The arch flags are required: without them only the host's arch is built.
5. Static payload checks (they read files and never run a binary):
   - `node scripts/check-win-payload.mjs --arch x64 --dir release/<version>/windows/win-unpacked --out <evidence>.json`
   - `node scripts/check-win-payload.mjs --arch arm64 --dir release/<version>/windows/win-arm64-unpacked --out <evidence>.json`

   They check the executable's machine type, the koffi binary for that arch, the app archive's header and integrity, and the Electron fuses. They also fail when `app.asar` holds any file outside the app's own allow-list (`out/main`, `out/preload`, `out/renderer`, `assets`, `node_modules`, `package.json`, `LICENSE`, `THIRD_PARTY_NOTICES.md`), so sources, docs, local state or old installers can never ship inside it, and when `app.asar` is larger than 32 MB. They warn when the archive's `package.json` version differs from the repository's.
6. The packaged smoke test takes the exe explicitly: `node scripts/with-lock.mjs smoke -- node scripts/smoke-packaged.mjs release/<version>/windows/win-unpacked/DesktopCat.exe`. With no argument it uses `release/win-unpacked/DesktopCat.exe` (the `npm run package` output). It refuses, before launching anything, a build whose `app.asar` version differs from the repository's.
7. Once every platform's packages are in `release/<version>/`, run `npm run release:sums` (see [Release checksums](#release-checksums)).

`scripts/install-test.ps1` and `scripts/upgrade-test.ps1` take `-Arch x64|arm64` (default: the PC's own arch) and `-Installer <path>`. Without `-Installer` they look for exactly `Desktop-Cat-Setup-<version>-<arch>.exe` in `release\`, `release\<version>\` and `release\<version>\windows\`, and refuse when there is none or more than one copy. They install the app and touch the startup entry: **run them only on a disposable Windows user or VM, never on a PC where GizeCat is really used.** The ARM64 installer can only be install-tested on a Windows on Arm PC or VM.

Code signing needs the owner's credentials: REQUIRES_OWNER_CREDENTIALS.
- In CI, the manual `release.yml` workflow signs through SignPath (`windows_signing: signpath`, `windows-signing` environment).
- On your own computer, `scripts/sign-windows.ps1` signs with a token or cloud-HSM certificate from the Windows certificate store. Mode `SignExisting` signs copies of these installers; mode `Rebuild` rebuilds them with every executable signed.
- `electron-builder.yml` fixes SHA-256 and an RFC 3161 timestamp for any signing run. Without a certificate, those settings change nothing.
- Neither path has run ([Windows signing](windows-signing.md)).

## macOS (Intel, Apple Silicon, universal)

electron-builder refuses to build macOS apps on Windows, but allows them on Linux. DMG and universal builds need a Mac: electron-builder needs `hdiutil` for a DMG, and `@electron/universal` refuses other hosts. There are four routes.

**1. On a Mac** (macOS 13 or later, Node and npm as above):

| Command | Output (in `release/`) |
|---|---|
| `npm run package:mac` | `GizeCat-<version>-mac-x64.dmg` / `.zip` and `GizeCat-<version>-mac-arm64.dmg` / `.zip` |
| `npm run package:mac:universal` | `GizeCat-<version>-mac-universal.dmg` / `.zip` |
| `npx electron-builder --mac dmg zip --x64 --arm64 --universal --publish never` (after `npm run build`) | All three |

The configuration sets the hardened runtime and one entitlement (`com.apple.security.cs.allow-jit`, in `build/entitlements.mac.plist`). Notarization is deliberately not configured in `electron-builder.yml`; the signed workflow does it. Without a Developer ID identity in the Keychain the output is not notarized, and macOS blocks it like the ad-hoc zips. Only a Mac can build the universal app.

**2. From Windows, in a disposable WSL 2 distro** (ad-hoc test zips for x64 and arm64 only; no DMG, no universal). This is the route that produced the 1.4.0 candidate's zips.

```sh
npm run package:mac:adhoc-wsl
```

- WSL 2 must be available. It needs no Docker.
- **Commit first.** The script archives `HEAD` (`git archive`) and refuses a working tree with uncommitted changes. `--allow-dirty` builds `HEAD` anyway, without those changes.
- It imports its own uniquely named distro from the official Ubuntu 24.04 WSL root filesystem (sha256-checked against Ubuntu's `SHA256SUMS`), and installs a pinned Node there (sha256-checked).
- Inside the distro it runs `scripts/docker/mac-adhoc-build.sh`: `electron-builder --mac dir` for x64 and arm64, then ad-hoc signing with rcodesign 0.29.0 (sha256-checked), then zips that keep their symbolic links.
- It unregisters its own distro when the build finishes or fails, but not if the process itself is killed: then remove it with `wsl --unregister <name>` (the name is in the log and in `distro-name.txt` in the kept stage folder). It never touches another WSL distro or the Docker engine.
- Output in `release/<version>/mac/`: `GizeCat-<version>-mac-x64-adhoc.zip`, `GizeCat-<version>-mac-arm64-adhoc.zip`, `README-adhoc.txt` and `SHA256SUMS.txt`. The script checks each zip against that `SHA256SUMS.txt`, a build by-product that is not attached to the release ([Release checksums](#release-checksums)).
- It takes a while. On a shared machine, start it as a detached process.

Then inspect each zip. The checker reads the zip's bytes and never runs anything; it is inspection, not a test:

```sh
node scripts/check-mac-payload.mjs --arch x64 --zip release/<version>/mac/GizeCat-<version>-mac-x64-adhoc.zip
node scripts/check-mac-payload.mjs --arch arm64 --zip release/<version>/mac/GizeCat-<version>-mac-arm64-adhoc.zip
```

It checks the bundle parts, the symbolic links, the Mach-O architecture and signature presence, `Info.plist`, the contents of `app.asar` (and that no koffi is inside), the asar integrity value and the Electron fuses.

**3. From Windows or Linux, in a Linux container** (the same zips, the same build script):

```sh
npm run package:mac:adhoc-docker
```

- Docker Desktop must be running.
- **Commit first.** The script archives `HEAD` (`git archive`) and refuses uncommitted changes to tracked files.
- It runs one container (`node:24-bookworm-slim`, `linux/amd64`) that installs dependencies, builds, packages `Desktop Cat.app` for x64 and arm64, signs it ad hoc with rcodesign 0.29.0 (sha256-checked), and zips it.
- It downloads Debian packages, the npm dependencies, two Electron macOS builds and rcodesign, so expect more than 10 minutes. On a shared machine, start it as a detached process.
- The output is the same as for the WSL route.
- It never lists, prunes or removes other containers or images. On failure it keeps its staging folder and prints the path.

**4. On a GitHub macOS runner**, with `.github/workflows/macos-packages.yml` (manual `workflow_dispatch` only; it has never been started, and it cannot be started until its file is on `main`; see [release automation](release-automation.md)):
- Job `adhoc` (input `signing`: `adhoc`, the default): no secrets. Ad-hoc signed DMG **and** zip for x64, arm64 and universal (input `universal`, default true), hardened runtime off. Files are named `GizeCat-<version>-mac-<arch>-adhoc-macrunner.dmg` and `.zip` (so they cannot be confused with the WSL-built `-adhoc.zip` files), with `SHA256SUMS-mac-adhoc.txt`. Not notarized.
- Job `developer-id`: Developer ID signing and notarization of DMG and zip for x64, arm64 and optionally universal. Files are named `GizeCat-<version>-mac-<arch>.dmg` and `.zip`, with `SHA256SUMS-mac.txt`. It runs in the GitHub Environment `macos-signing`. Before the first run the owner creates that environment with a required reviewer and the secrets `MAC_CSC_LINK` (a base64 Developer ID Application .p12) and `MAC_CSC_KEY_PASSWORD`, plus either `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`, or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. A guard step fails when they are missing or when a set is partial. REQUIRES_OWNER_CREDENTIALS; only the owner dispatches it.

## Web app (iPad, Android tablets, desktop browsers)

**Environment:** any OS with Node and npm.

| Command | Output |
|---|---|
| `npm run build:web` | `out/web/`: `index.html`, `licenses.html`, `main.js`, `web.css`, `manifest.webmanifest`, `sw.js` and six icons |
| `npm run package:web` | `release/<version>/web/`: the folder `GizeCat-web-<version>/`, the zip `GizeCat-web-<version>.zip`, `README-web.txt` and `SHA256SUMS.txt` (a by-product for the web files, not attached to the release) |

The production build checks itself: the exact file set, no test hook or key-listener code in any file, the page's CSP equal to the pinned policy, the service worker's precache list equal to the files on disk, only relative URLs in the pages and the manifest, a manifest `id`, and a static licences page. The zip is deterministic (sorted entries, fixed timestamps). `licenses.html` is generated from `THIRD_PARTY_NOTICES.md` at build time and also reaches the Android app's assets.

**Hosting.** Any static HTTPS host, at any path. HTTPS is needed to install the app and for offline start; `file://` does not work. Serve `manifest.webmanifest` as `application/manifest+json`. Optional headers are in `README-web.txt`.

`.github/workflows/pages.yml` publishes `out/web` to the repository's GitHub project site. The expected address is `https://gizeverse.github.io/GizeCat/`; **it is not deployed**, and the deploy job prints the real address. The workflow is manual and has never been started. The Pages source is already set to GitHub Actions (2026-11-08, through the API; nothing was deployed). The owner brings the workflow file to `main`, then runs it. REQUIRES_OWNER_CREDENTIALS.

## Android app

**Environment:**
- a JDK 17 or newer (Android Studio's bundled JBR works);
- the Android SDK with platform `android-36` and build-tools `36.0.0`;
- network access on first use: the Gradle wrapper downloads Gradle 9.1.0 (a sha256-pinned distribution), and Gradle downloads the Android Gradle Plugin 9.0.1 and its Kotlin from Google Maven and Maven Central.

`scripts/android-gradle.mjs` sets `JAVA_HOME` and `ANDROID_HOME` for the Gradle process only: the environment's values when they are valid, otherwise Android Studio's JBR and the default SDK folder. It first runs `scripts/build-web-app.mjs`, which rebuilds `out/web`, refuses source maps, test hooks and key-listener code, and copies the bundle into `android/app/src/main/assets/` (generated, gitignored).

| Command | Gradle output | Copied to `release/<version>/android/` as |
|---|---|---|
| `npm run android:apk` | `android/app/build/outputs/apk/release/app-release-unsigned.apk` (`app-release.apk` when signed) | `GizeCat-<version>-android-unsigned.apk` (`GizeCat-<version>-android.apk` when signed) |
| `npm run android:aab` | `android/app/build/outputs/bundle/release/app-release.aab` | `GizeCat-<version>-android-unsigned.aab` (`…-android.aab` when signed) |
| `npm run android:release` | Both of the release outputs above | Both, named as above |
| `npm run android:trial` | `android/app/build/outputs/apk/trial/app-trial.apk` | `GizeCat-<version>-android-trial-debugsigned.apk` |
| `npm run android:web` | `android/app/src/main/assets/` only | — |

The copy step also writes `release/<version>/android/SHA256SUMS-android.txt`, a build by-product that is not attached to the release. Direct form: `node scripts/android-gradle.mjs :app:assembleRelease [--no-web] [--no-collect]`. Do not use `--no-web` for a release: it would package whatever web bundle is already in the assets folder.

- `versionName` comes from `package.json`; `versionCode` = MAJOR×10000 + MINOR×100 + PATCH (1.4.0 → 10400).
- Build release artifacts from the final commit, and write that commit down yourself: the APK does not record it. The release build turns version-control info off (`vcsInfo { include = false }`), and neither `android/app/build.gradle.kts` nor `scripts/android-gradle.mjs` embeds a commit. Two builds have not been compared, so this page does not claim reproducible builds.
- Build types: `release` (R8; signed from the environment or `android/keystore.properties`, otherwise unsigned), `trial` (the release code signed with the SDK debug key, id suffix `.trial`, label "GizeCat (trial)"), `debug` (developers only; WebView DevTools on).
- **Signing (owner only).** The first source that holds anything wins: the environment variables `ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`; then `android/keystore.properties` (gitignored). With neither, the outputs are unsigned. A partial set stops the build and names what is missing, never a value. The manual `android-release.yml` workflow has an unsigned path and a signed path, with secrets in the `android-signing` environment; it has never been started. Back up the keystore and passwords offline. The full procedure is in [android-signing.md](android-signing.md). REQUIRES_OWNER_CREDENTIALS.

## Linux (unchanged in 1.4.0)

`npm run package:linux` on Linux gives `GizeCat-<version>-linux-x86_64.AppImage` and `GizeCat-<version>-linux-x64.tar.gz` ([report](../gizeverse/05-linux.md)).

## Where the outputs go

| Artifact | Folder |
|---|---|
| Windows installers and unpacked folders | `release/` (or `release/<version>/windows/` with `-c.directories.output`) |
| macOS ad-hoc zips (WSL or container) | `release/<version>/mac/` |
| macOS DMG and zip (Mac, workflow) | `release/` on the build machine; workflow artifacts on GitHub |
| Web app | `release/<version>/web/` |
| Android | `release/<version>/android/` |
| The release's one checksum file | `release/<version>/SHA256SUMS.txt` (`npm run release:sums`) |

`release/` is git-ignored. Publishing a release (uploading files to GitHub Releases) is an owner action; see [docs/RELEASE_CHECKLIST.md](../RELEASE_CHECKLIST.md).

## Release checksums

`npm run release:sums` (`scripts/release-sums.mjs`) writes `release/<version>/SHA256SUMS.txt`. It hashes every `*.exe`, `*.dmg`, `*.zip`, `*.apk` and `*.aab` in `release/<version>/windows`, `mac`, `web` and `android` (never blockmaps, unpacked folders or other checksum files), one `<sha256>  <file name>` line each, sorted by name. It refuses two files with the same name, because release assets are attached side by side. This is the one `SHA256SUMS.txt` that is attached to the release and that the install guides tell users to check. Run it last, after every package that will be attached is in place; Windows installers count only from `release/<version>/windows`, so package them with `-c.directories.output=release/<version>/windows`.

The per-folder files (`web/SHA256SUMS.txt`, `mac/SHA256SUMS.txt`, `android/SHA256SUMS-android.txt`) are build by-products that the packaging scripts use to check their own output. They are not attached: two of them share the name `SHA256SUMS.txt`, and none covers the Windows installers. The workflows write their own per-workflow files too (`SHA256SUMS-mac-adhoc.txt`, `SHA256SUMS-mac.txt`, `SHA256SUMS-android.txt`, `SHA256SUMS-windows.txt`); these are not the release's `SHA256SUMS.txt` either.
