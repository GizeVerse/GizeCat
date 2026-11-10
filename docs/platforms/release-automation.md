# Release automation (GitHub Actions)

The manual GitHub workflows that build, sign and attach GizeCat 1.4.0 packages, the secrets they use, and what the project owner has to do.

**Nothing on this page has ever been started.** No workflow here has run on GitHub, so no step below is known to pass. A person must check each workflow's first real run step by step and inspect every file it produces before sharing any of them.

| Item | Status |
|---|---|
| The four workflow files | IMPLEMENTED; parsed as YAML only |
| Any run of them | THEORETICALLY_COMPATIBLE_NOT_EXECUTED |
| Developer ID signing and notarization (macOS) | REQUIRES_OWNER_CREDENTIALS |
| Authenticode signing through SignPath (Windows, CI) | REQUIRES_OWNER_CREDENTIALS (SignPath acceptance and settings) |
| Authenticode signing with a token or cloud-HSM certificate (Windows, local, `scripts/sign-windows.ps1`) | REQUIRES_OWNER_CREDENTIALS (a certificate) |
| Release signing (Android) | REQUIRES_OWNER_CREDENTIALS |
| Publishing the web app on GitHub Pages | REQUIRES_OWNER_CREDENTIALS (the repository's Pages source is already set; `pages.yml` must reach `main` and be run; nothing is deployed) |

The signing guides: [signing overview](signing-overview.md), [Windows](windows-signing.md), [macOS](macos-signing.md), [Android](android-signing.md), [owner actions](release-owner-actions.md).

Status words: [docs/platforms/README.md](README.md#status-vocabulary-for-140). A build is not a test: a package these workflows produce is COMPILED_OR_PACKAGED at most, and says nothing about whether the app runs.

## The default-branch rule

GitHub only starts a `workflow_dispatch` workflow whose file exists on the default branch. Its documentation says: "This event will only trigger a workflow run if the workflow file exists on the default branch" ([events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)).

The default branch is `main`, which holds v1.3.0 and has `ci.yml`, `installer-check.yml` and an older `release.yml`. **`macos-packages.yml`, `pages.yml` and `android-release.yml` are not on `main` yet, so those three cannot be started today.** `release.yml` can already be started from the candidate branch, because a file of that name is on `main`. The owner decides when the candidate reaches `main`.

Once a file is on `main`, the Run workflow form has a branch selector, and the run builds the code of the branch you pick. GitHub's documentation does not say which copy of the workflow file such a run uses, so compare the first run's steps with the branch's file.

Pushing to `main` also triggers `ci.yml`, which has `push` and `pull_request` triggers and runs test suites. It is not one of the release workflows.

## The workflows

All four are manual only: no `push`, `pull_request`, `schedule`, `release` or `workflow_run` trigger, and no test step. Their checks read the built files and never run them. None of them publishes anything except `pages.yml`, which deploys the website when you start it.

| File in `.github/workflows/` | Name in the Actions tab | Runner | What it builds | Where the output goes |
|---|---|---|---|---|
| `macos-packages.yml` | macos-packages | `macos-15` | DMG and zip for x64, arm64 and universal | Workflow artifact; optional draft release |
| `android-release.yml` | android-release | `ubuntu-latest` | APK and AAB (`:app:assembleRelease`, `:app:bundleRelease`) | Workflow artifact; optional draft release |
| `release.yml` | release-artifacts | `windows-latest`, `ubuntu-latest` | NSIS installers (x64, ARM64); Linux AppImage and tar.gz | Workflow artifacts; optional draft release (Windows files only) |
| `pages.yml` | web-pages | `ubuntu-latest` | The production web bundle (`out/web`) | The repository's GitHub Pages project site |

Each workflow has `permissions: contents: read` by default. Only the job that needs more gets more: `attach-to-draft` has `contents: write`, and the Pages `deploy` job has `pages: write` and `id-token: write`. Artifacts are kept for 14 days.

### macos-packages.yml

| Input | Values | Effect |
|---|---|---|
| `signing` | `adhoc` (default), `developer-id` | Which job runs |
| `universal` | `true` (default), `false` | Also build the universal DMG and zip |
| `draft_release_tag` | empty (default) or a tag | Attach the files to that draft release |

**`adhoc` needs no secrets.** It runs `electron-builder --mac dmg zip --x64 --arm64 --universal --publish never` with `-c.mac.identity=-` and `-c.mac.hardenedRuntime=false`.

- electron-builder 26 has no automatic ad-hoc fallback: with no identity it leaves the app unsigned, and Apple Silicon Macs refuse unsigned code. So the job asks for ad-hoc signing explicitly.
- The hardened runtime is off on this path because library validation rejects an ad-hoc signed app's frameworks.
- The files are not notarized. macOS blocks them until the user allows them.
- Files: `GizeCat-<version>-mac-<arch>-adhoc-macrunner.dmg` and `.zip` (`<arch>` is `x64`, `arm64` or `universal`), `SHA256SUMS-mac-adhoc.txt`. `-adhoc` keeps them from being confused with notarized files. `-macrunner` keeps them from being confused with the `GizeCat-<version>-mac-<arch>-adhoc.zip` files the Linux routes build, which have a different signer and different bytes.

**`developer-id` needs the owner's secrets** and runs in the GitHub Environment `macos-signing`. It produces Developer ID signed, hardened, notarized and stapled apps.

- Files: `GizeCat-<version>-mac-<arch>.dmg` and `.zip`, `SHA256SUMS-mac.txt`.
- A guard step fails the job before the build when a secret is missing, or when either notarization set is partial, even if the other set is complete. If both sets are complete, the API key set is used.
- Files: also `notarization-mac.txt`, Apple's submission ID and status for each DMG.
- `-c.forceCodeSigning=true` stops the build only when electron-builder finds no signing identity at all. It does not check the certificate's type: in app-builder-lib 26.18.1 a `.p12` holding another identity, such as Apple Development, can be picked and used for signing.
- After packaging, the job checks each built app **and the app inside each shipped zip**, and refuses anything that lacks:
  - a Developer ID Application signature under Apple's Developer ID CA;
  - the hardened runtime and a secure timestamp;
  - a Team ID (`MAC_EXPECTED_TEAM_ID` when set);
  - Gatekeeper's verdict "Notarized Developer ID";
  - a valid stapled ticket.

  The thin zips then go through the static payload check, which requires real (CMS) signatures.
- Each DMG container is then signed with the same Developer ID Application identity, notarized and stapled. This step **blocks**: a DMG Apple does not answer `Accepted` for fails the job and never reaches the artifact. Details: [macos-signing.md](macos-signing.md).

### android-release.yml

| Input | Values | Effect |
|---|---|---|
| `signing` | `unsigned` (default), `release-signed` | Which job runs |
| `draft_release_tag` | empty (default) or a tag | Attach the files to that draft release |

Both jobs use Node 24 and Temurin 21, install the SDK packages `platforms;android-36` and `build-tools;36.0.0`, and run `node scripts/android-gradle.mjs :app:assembleRelease :app:bundleRelease`. That script builds the production web bundle first. Gradle's own static `lintVital` check is part of these tasks.

- **`unsigned`** needs no secrets. Files: `GizeCat-<version>-android-unsigned.apk` and `.aab`, `SHA256SUMS-android.txt` (attached to a draft as `SHA256SUMS-android-unsigned.txt`). An unsigned APK cannot be installed, and an unsigned AAB cannot be uploaded to Google Play.
- **`release-signed`** needs the owner's secrets and runs in the GitHub Environment `android-signing`. The keystore is decoded to a file under `$RUNNER_TEMP`, passed to Gradle as `ANDROID_KEYSTORE_FILE` with `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`, and removed at the end of the job. Files: `GizeCat-<version>-android.apk` and `.aab`, `SHA256SUMS-android.txt` (attached to a draft as `SHA256SUMS-android-signed.txt`). The job reads the APK's and the AAB's signature afterwards (`apksigner verify`, `jarsigner -verify`, `keytool -printcert -jarfile`). It refuses:
  - a debug-signed output;
  - an AAB that `jarsigner` does not report as verified;
  - an APK and AAB signed by different certificates;
  - with the environment variable `ANDROID_EXPECTED_CERT_SHA256` set, any other certificate.

The workflow does not publish to any store. The key itself is covered in [android-signing.md](android-signing.md).

### release.yml

| Input | Values | Effect |
|---|---|---|
| `windows_signing` | `unsigned` (default), `signpath` | Which Windows job runs |
| `draft_release_tag` | empty (default) or a tag | Attach the Windows files to that draft release |

Both Windows jobs stage the ARM64 koffi binary, build both architectures, and run the static payload check for each (`scripts/check-win-payload.mjs`, which never runs a binary). The x64 runner cannot run ARM64 binaries, so the ARM64 installer is only ever checked statically.

- **`unsigned`** needs no secrets and sets `CSC_IDENTITY_AUTO_DISCOVERY=false`.
- **`signpath`** runs in the GitHub Environment `windows-signing` and signs through SignPath; the key stays in SignPath's HSM.
  - Optional round 1 signs GizeCat's own executables inside both app folders.
  - Round 2 signs the two final installers, built from those folders with `--prepackaged`.
  - A person approves each round in SignPath.
  - Every signed file must pass `scripts/verify-windows-signature.ps1` (valid, SHA-256 digest, RFC 3161 timestamp, no warnings).
  - Every signed file must also pass `scripts/compare-signed-pe.mjs`, which checks that it is byte-identical to the file the run built, apart from the signature.
  - Any failure stops the job; the unsigned inputs are kept as artifacts.
  - The earlier `.pfx` route (`WIN_CSC_LINK`) is gone, for the reason in [windows-signing.md](windows-signing.md).
- Files: `Desktop-Cat-Setup-<version>-x64.exe`, `Desktop-Cat-Setup-<version>-arm64.exe`, `SHA256SUMS-windows.txt`, and on the signed path also `signing-provenance-windows.txt`.

The Linux job is unchanged: it builds an unsigned AppImage and tar.gz and uploads them as an artifact.

### pages.yml

No inputs and no secrets. It runs `node scripts/build.mjs --web-only` and deploys `out/web` to the repository's GitHub Pages project site, in the `github-pages` environment.

GitHub Pages is already configured for the GitHub Actions source (done 2026-11-08 through the API). Nothing has been deployed.

The site is served under the `/GizeCat/` subpath of the project-site address. The bundle uses relative URLs only (`index.html`, the manifest's `start_url` and `scope`, `sw.js` with scope `./`), so it needs no base-path setting. The real address is the one the deploy job prints.

The result is a **public website**. A project site shares its origin with the other Pages sites of the same account or organization (shared `localStorage` and caches); a custom domain owned by you avoids that.

GitHub's `github-pages` environment can restrict which branches may deploy. If the deploy job is refused with an environment protection error, run the workflow from `main`, or allow the branch under **Settings**, **Environments**, `github-pages`.

## Attaching files to a draft release

The optional `draft_release_tag` input works the same in `macos-packages.yml`, `android-release.yml` and `release.yml`.

- The tag must name a release that already exists. The workflows never create a release.
- A release that is not a draft is refused, so a published release such as v1.3.0 cannot be changed by these workflows.
- Files are added with `gh release upload` without `--clobber`. If an asset with the same name is already on the draft, the upload fails and nothing is replaced. Delete that asset from the draft first if you want to replace it.
- The job that attaches runs after the build, holds no signing secret, and is the only job with write access to the repository.

The per-workflow checksum files (`SHA256SUMS-mac-adhoc.txt`, `SHA256SUMS-mac.txt`, `SHA256SUMS-windows.txt`, and on a draft `SHA256SUMS-android-unsigned.txt` or `SHA256SUMS-android-signed.txt`) cover only that workflow's files. The install guides point users to the release's single `SHA256SUMS.txt`, which `npm run release:sums` writes ([how](building-and-packaging.md#release-checksums)). After stapling or signing, generate it from the files that are actually on the release.

## Secrets

Secrets live in **GitHub Environments**, one per signing path. An environment with a required reviewer holds its secrets back until the reviewer approves the job: "a job cannot access environment secrets until one of the required reviewers approves it" ([deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)). On GitHub Free, Pro and Team plans required reviewers exist only for public repositories; this repository is public.

Never put a secret value in a repository file, an issue, a pull request, a chat, a log or a message to an agent. Agents never create, read or handle these values.

### macos-signing (workflow macos-packages.yml)

| Secret | Format | Where it comes from |
|---|---|---|
| `MAC_CSC_LINK` | Base64 of a `.p12` file, single line | "Developer ID Application" certificate with its private key, exported from Keychain Access as `.p12`. Needs a paid Apple Developer Program membership. |
| `MAC_CSC_KEY_PASSWORD` | Text | The password chosen when exporting the `.p12` |

Plus one complete notarization set:

| Set | Secret | Format | Where it comes from |
|---|---|---|---|
| App Store Connect API key (preferred) | `APPLE_API_KEY_P8_BASE64` | Base64 of the `.p8` file | App Store Connect, Users and Access, Integrations, team API key. Apple offers the `.p8` for download only once. Choose the least-privileged role Apple's current documentation accepts for notarization. |
| | `APPLE_API_KEY_ID` | Text | The key's ID, shown next to it |
| | `APPLE_API_ISSUER` | Text (UUID) | The Issuer ID on the same page |
| Apple ID (alternative) | `APPLE_ID` | Text (e-mail) | The Apple Account in the developer team |
| | `APPLE_APP_SPECIFIC_PASSWORD` | Text | An app-specific password from that Apple Account, not the account password |
| | `APPLE_TEAM_ID` | Text | The team's ID from the developer account's membership details |

### android-signing (workflow android-release.yml)

| Secret | Format | Where it comes from |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | Base64 of the upload keystore file | The upload key you generate ([android-signing.md](android-signing.md)) |
| `ANDROID_KEYSTORE_PASSWORD` | Text | The store password |
| `ANDROID_KEY_ALIAS` | Text | The key's alias in the keystore |
| `ANDROID_KEY_PASSWORD` | Text | The key's password (for a PKCS12 keystore, the same as the store password) |

Back up the keystore and its passwords offline. GitHub never shows a secret again, so it is not a backup.

### windows-signing (workflow release.yml)

| Name | Kind | Format | Where it comes from |
|---|---|---|---|
| `SIGNPATH_API_TOKEN` | Secret | Text | An API token of a SignPath CI user with the submitter role in your SignPath organization |
| `SIGNPATH_ORGANIZATION_ID` | Variable | Text (UUID) | Your SignPath organization's ID |
| `SIGNPATH_PROJECT_SLUG` | Variable | Text | The SignPath project's slug |
| `SIGNPATH_SIGNING_POLICY_SLUG` | Variable | Text | The signing policy's slug (for example the release policy) |
| `SIGNPATH_INSTALLER_ARTIFACT_CONFIGURATION_SLUG` | Variable | Text | The slug of the artifact configuration made from `.github/signpath/windows-installers.xml` |
| `SIGNPATH_APP_ARTIFACT_CONFIGURATION_SLUG` | Variable, optional | Text | Enables round 1: the slug of the configuration made from `windows-app-helper.xml` (or `windows-app-helper-and-exe.xml`) |
| `SIGNPATH_ROUND1_FILES` | Variable, optional | `DesktopCatUia.exe` (default) or `DesktopCat.exe DesktopCatUia.exe` | Must match the round 1 configuration |
| `WINDOWS_SIGNER_SUBJECT` | Variable, optional | Text | Text the signer certificate's subject must contain, once you know it from the first signing |

Since 2023-06-01 the [CA/Browser Forum's code-signing requirements](https://cabforum.org/working-groups/code-signing/requirements/) require certificate keys to be generated and kept in a hardware crypto module, so a certificate bought today cannot be exported as `.pfx` for a CI secret. A token or cloud-HSM certificate is used on your own computer with `scripts/sign-windows.ps1` instead ([windows-signing.md](windows-signing.md)). Variables are set with `gh variable set <NAME> --env windows-signing --repo GizeVerse/GizeCat --body <value>`.

### Creating and storing the secrets

Do this once per environment you intend to use.

1. In the repository go to **Settings**, **Environments**, **New environment**, and enter the name exactly (`macos-signing`, `android-signing` or `windows-signing`).
2. Under **Deployment protection rules**, turn on **Required reviewers**, add yourself, and save.
3. Under **Environment secrets**, add each secret with its exact name, and under **Environment variables** each variable (the non-secret names above, such as the SignPath slugs and the optional fingerprints).

Create the environment before the first run: a job that names a missing environment makes GitHub create it without protection rules. The guard steps still fail when secrets are absent, but no reviewer would be required.

With the GitHub CLI (run on your own computer, in a terminal only you can see):

```sh
# Files, on macOS or Linux (macOS: base64 -i file; Linux: base64 -w0 file). Nothing is written to disk.
base64 -i Certificates.p12 | gh secret set MAC_CSC_LINK --env macos-signing --repo GizeVerse/GizeCat
base64 -i AuthKey_XXXXXXXXXX.p8 | gh secret set APPLE_API_KEY_P8_BASE64 --env macos-signing --repo GizeVerse/GizeCat

# Text values: gh prompts for the value, so it stays out of your shell history.
gh secret set MAC_CSC_KEY_PASSWORD --env macos-signing --repo GizeVerse/GizeCat
```

```powershell
# Files, in PowerShell on Windows.
gh secret set SIGNPATH_API_TOKEN --env windows-signing --repo GizeVerse/GizeCat
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\upload.keystore")) | gh secret set ANDROID_KEYSTORE_BASE64 --env android-signing --repo GizeVerse/GizeCat
```

The certificate and keystore files themselves must stay outside the repository. Replace `XXXXXXXXXX` with your key's ID.

## What the owner does, in order

1. **Decide when the workflow files reach `main`.** Until they do, `macos-packages.yml`, `android-release.yml` and `pages.yml` cannot be started; `release.yml` already can (see [the default-branch rule](#the-default-branch-rule)). Pushing to `main` also triggers `ci.yml`.
2. **For the web app:** decide that it may be public. GitHub Pages is already configured for the GitHub Actions source (done 2026-11-08 through the API; nothing deployed), so the only Pages steps left are: bring `pages.yml` to `main`, then run it.
3. **For each signing path you want:** create the environment, the required reviewer and the secrets, as above. Skip this for unsigned and ad-hoc builds.
4. **If files should go on a draft release:** make sure the draft exists with the tag you will enter.
5. **Start a workflow:** the repository's **Actions** tab, the workflow's name, **Run workflow**, pick the branch, fill in the inputs, **Run workflow**. Start with the paths that need no secrets.
6. **Approve signing jobs:** a job in a protected environment waits for you under **Review deployments**. Approve it only for a run you started.
7. **Check the first real run of each workflow step by step.** Read each log. Confirm no secret value appears (GitHub masks them, but check). Download every artifact and compare it with its checksum file.
8. **Check the files on real devices** before sharing them. The per-platform guides list what to check; nothing in 1.4.0 has run on any device yet.
9. **Build the release's `SHA256SUMS.txt`** from the final files, attach it to the draft, and publish the draft yourself. These workflows never publish a release.

## Limits

- No workflow here has run, so runner image details (preinstalled tools, the Android SDK path) are assumptions until the first run.
- Ad-hoc macOS packages are not notarized. They are for trials by people who accept allowing them manually, not for general distribution.
- A universal build needs a macOS runner. The two Linux routes make ad-hoc zips for x64 and arm64 only: the Docker route (`npm run package:mac:adhoc-docker`, a container) and the WSL route (`npm run package:mac:adhoc-wsl`, a disposable WSL 2 distro on a Windows PC).
- The ARM64 Windows installer can only be checked statically on an x64 runner. Installing it needs a Windows on Arm PC or VM.
- `installer-check.yml` is a separate manual workflow that really installs and uninstalls on a hosted runner. It is not part of this release automation.
