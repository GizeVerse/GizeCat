# Release owner actions: GizeCat 1.4.0 signing and publication

Everything that only the owner can do before GizeCat 1.4.0 ships signed, in a workable order. Agents prepared the workflows, scripts and guides; none of the steps below has been done.

Labels:
- **[PAID]** costs money;
- **[IDENTITY]** needs your legal identity or documents;
- **[CREDENTIAL]** creates or handles a secret;
- **[APPROVAL]** is a decision or an approval click.

Never paste a secret into a chat, an issue, a commit, a log or a message to an agent.

## 0. Decide first

1. **[APPROVAL]** Which Windows route:
   - SignPath Foundation: free; the publisher shown is "SignPath Foundation".
   - Certum Open Source Code Signing: paid; your name is shown with the prefix "Open Source Developer".
   - Both, SignPath for CI and Certum as fallback.

   See [windows-signing.md, section 2](windows-signing.md#2-recommendation).
2. **[APPROVAL]** Whether to pay for the Apple Developer Program now. Without it, macOS stays ad-hoc and not notarized.
3. **[APPROVAL]** Android Play App Signing: option A (Google generates the app signing key) or B (you supply it). This is hard to change after the first upload. See [android-signing.md, section 2](android-signing.md#2-decide-how-play-and-the-github-apk-relate).
4. **[APPROVAL]** When the candidate branch reaches `main`. `macos-packages.yml`, `android-release.yml` and `pages.yml` cannot be started until their files are on `main`; `release.yml` already can. Pushing to `main` also triggers `ci.yml`, which runs tests.

## 1. Windows

**Route A, SignPath (CI):**

1. **[IDENTITY] [APPROVAL]** Apply to SignPath Foundation with GizeVerse/GizeCat. Before or during the application:
   - **[APPROVAL]** Publish a "Code signing policy" page with SignPath's credit line, the team roles and a privacy policy link, and mention it on the home and download pages.
   - Turn on MFA for every account with access to SignPath and the repository.
   - Settle two points with SignPath:
     - the product name "Desktop Cat" (frozen) versus the project name GizeCat;
     - whether round 1 is wanted, given that `DesktopCatUia.exe` has no version resource and `DesktopCat.exe` is an upstream Electron binary.
2. **[CREDENTIAL]** In SignPath, create:
   - the project, with the GitHub trusted build system;
   - a release signing policy with manual approval;
   - a CI user with the submitter role and its API token;
   - the artifact configurations from `.github/signpath/`.
3. **[CREDENTIAL]** In GitHub, create the environment `windows-signing` with yourself as required reviewer, then the secret `SIGNPATH_API_TOKEN` and the variables ([commands](windows-signing.md#5-route-a-signpath-in-ci-releaseyml-windows_signing-signpath)).
4. **[APPROVAL]** Run `release.yml` with `windows_signing: signpath`, approve the environment, and approve each SignPath signing request.
5. Check the artifact on your computer: run `scripts\verify-windows-signature.ps1` and read `signing-provenance-windows.txt`. Then set `WINDOWS_SIGNER_SUBJECT`.

**Route B, your own certificate (local):**

1. **[PAID] [IDENTITY]** Buy a Certum Open Source Code Signing certificate (card or SimplySign) and complete Certum's identity verification. Install its software.
2. **[CREDENTIAL]** Run `scripts\sign-windows.ps1 -CertificateThumbprint <THUMBPRINT>`. The token software asks for the PIN in its own window. Use `-Mode Rebuild` to also sign the executables inside the installers ([details](windows-signing.md#6-route-b-your-own-certificate-on-your-own-computer-scriptssign-windowsps1)).

## 2. macOS

1. **[PAID] [IDENTITY]** Enroll in the Apple Developer Program.
2. **[CREDENTIAL]** As Account Holder, create a Developer ID Application certificate and export it as `.p12` with a strong password. Create an App Store Connect API key and download the `.p8`.
3. **[CREDENTIAL]** Back up both offline (two encrypted media, password kept separately).
4. **[CREDENTIAL]** Create the environment `macos-signing` with a required reviewer, then set the secrets and the variable `MAC_EXPECTED_TEAM_ID` ([commands](macos-signing.md#4-owner-steps)).
5. **[APPROVAL]** Once `macos-packages.yml` is on `main`, run it with `signing: developer-id` and approve the environment.
6. Check the artifact on a Mac ([commands](macos-signing.md#5-checking-a-signed-package-yourself-on-a-mac-reads-files-runs-no-app)). `notarization-mac.txt` must show Apple's `Accepted` for every DMG.

## 3. Android

1. **[CREDENTIAL]** Run `powershell -ExecutionPolicy Bypass -File scripts\android-create-upload-key.ps1` yourself.
   - keytool asks for the password and the certificate's name fields; use details you are willing to publish.
   - Store the password in your password manager immediately.
2. **[CREDENTIAL]** Back up the `.jks` on two encrypted offline media in different places, with the password stored separately. Check one copy with `keytool -list`.
3. Sign:
   - **[CREDENTIAL]** locally: fill in `android/keystore.properties` (gitignored) or set the four variables for one session, then run `npm run android:release`;
   - in CI: create the environment `android-signing` with a required reviewer, the four secrets and the variable `ANDROID_EXPECTED_CERT_SHA256` (the script prints its value), then run `android-release.yml` with `signing: release-signed` once it is on `main`.
4. **[PAID] [IDENTITY]** Create the Google Play developer account (one-time registration fee; Google's identity verification). Then create the app with application id `io.github.gizeverse.gizecat`, set up Play App Signing per your decision, and upload the signed AAB to internal testing ([android-signing.md, section 8](android-signing.md#8-play-app-signing)).

## 4. iPadOS and web (PWA)

1. **[APPROVAL]** Decide that the web app may be public at the project-site address (expected `https://gizeverse.github.io/GizeCat/`). A project site shares its origin with the organization's other Pages sites.
2. Bring `pages.yml` to `main`. The `github-pages` environment deploys from `main` only.
3. **[APPROVAL]** Run `pages.yml`, then open the address the deploy job prints. Until then the site does not exist (HTTP 404 on 2026-11-10).

## 5. Before publishing the release

1. Install and try every signed package on real devices you own: Windows x64, Windows on Arm, an Intel Mac, an Apple Silicon Mac, an Android tablet and an iPad. Nothing in 1.4.0 has run on any device yet. The tests and E2E suites the project normally requires were also not run for 1.4.0; run them first (`node .claude/scripts/verify.mjs full`).
2. On the draft v1.4.0, replace the unsigned or ad-hoc assets with the signed ones. The workflows never overwrite an asset, so delete the old asset first, then attach the new one.
3. Rebuild the single `SHA256SUMS.txt` from the files actually on the release (`npm run release:sums`), and attach it.
4. **[APPROVAL]** Update the release notes so that every file is described as what it is (signed, ad-hoc, unsigned or debug), then publish the draft yourself. No workflow or agent publishes it.

## What an agent did not and will not do

- Buy, enroll, apply, or create any key, certificate, token or account.
- Read, print or store any secret value.
- Start any workflow, publish the release, create a tag or merge into `main`.
- Run the app, a test suite, an emulator or a simulator, or install anything.
