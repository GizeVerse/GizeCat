# Release automation (GitHub Actions)

The manual GitHub workflows that build, sign and attach GizeCat 1.4.0 packages, the secrets they use, and what the project owner has to do.

**Nothing on this page has ever been started.** No workflow here has run on GitHub, so no step below is known to pass. A person must check each workflow's first real run step by step and inspect every file it produces before sharing any of them.

| Item | Status |
|---|---|
| The four workflow files | IMPLEMENTED; parsed as YAML only |
| Any run of them | THEORETICALLY_COMPATIBLE_NOT_EXECUTED |
| Developer ID signing and notarization (macOS) | REQUIRES_OWNER_CREDENTIALS |
| Authenticode signing (Windows) | REQUIRES_OWNER_CREDENTIALS |
| Release signing (Android) | REQUIRES_OWNER_CREDENTIALS |
| Publishing the web app on GitHub Pages | REQUIRES_OWNER_CREDENTIALS (repository setting) |
| Signing with a key held only on a hardware token or cloud HSM (Windows) | NOT_IMPLEMENTED |

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
- Files: `GizeCat-<version>-mac-<arch>-adhoc.dmg` and `.zip`, `SHA256SUMS-mac-adhoc.txt`. The `-adhoc` suffix keeps them from being confused with notarized files.

**`developer-id` needs the owner's secrets** and runs in the GitHub Environment `macos-signing`. It produces Developer ID signed, hardened, notarized and stapled apps.

- Files: `GizeCat-<version>-mac-<arch>.dmg` and `.zip`, `SHA256SUMS-mac.txt`.
- A guard step fails the job before the build when a secret is missing, or when either notarization set is partial, even if the other set is complete. If both sets are complete, the API key set is used.
- `-c.forceCodeSigning=true` stops the build if the certificate is not a usable Developer ID Application identity.
- After packaging, the job reads each app's signature, hardened-runtime flag and Team ID, and runs `spctl` and `stapler validate` on the app bundles.
- DMG containers stay unsigned, as electron-builder's documentation advises for notarized builds. The job also notarizes and staples each DMG, but that step does not fail the run: a DMG Apple or `stapler` refuses gives a warning, and the notarized apps inside are unaffected.

### android-release.yml

| Input | Values | Effect |
|---|---|---|
| `signing` | `unsigned` (default), `release-signed` | Which job runs |
| `draft_release_tag` | empty (default) or a tag | Attach the files to that draft release |

Both jobs use Node 24 and Temurin 21, install the SDK packages `platforms;android-36` and `build-tools;36.0.0`, and run `node scripts/android-gradle.mjs :app:assembleRelease :app:bundleRelease`. That script builds the production web bundle first. Gradle's own static `lintVital` check is part of these tasks.

- **`unsigned`** needs no secrets. Files: `GizeCat-<version>-android-unsigned.apk` and `.aab`, `SHA256SUMS-android.txt`. An unsigned APK cannot be installed, and an unsigned AAB cannot be uploaded to Google Play.
- **`release-signed`** needs the owner's secrets and runs in the GitHub Environment `android-signing`. The keystore is decoded to a file under `$RUNNER_TEMP`, passed to Gradle as `ANDROID_KEYSTORE_FILE` with `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`, and removed at the end of the job. Files: `GizeCat-<version>-android.apk` and `.aab`, `SHA256SUMS-android.txt`. The job reads the APK's and the AAB's signature afterwards (`apksigner verify`, `jarsigner -verify`).

The workflow does not publish to any store. The key itself is covered in [android-signing.md](android-signing.md).

### release.yml

| Input | Values | Effect |
|---|---|---|
| `windows_signing` | `unsigned` (default), `authenticode` | Which Windows job runs |
| `draft_release_tag` | empty (default) or a tag | Attach the Windows files to that draft release |

Both Windows jobs stage the ARM64 koffi binary, build both installers, and run the static payload check for each architecture (`scripts/check-win-payload.mjs`, which never runs a binary). The x64 runner cannot run ARM64 binaries, so the ARM64 installer is only ever checked statically.

- **`unsigned`** needs no secrets and sets `CSC_IDENTITY_AUTO_DISCOVERY=false`.
- **`authenticode`** runs in the GitHub Environment `windows-signing`. It passes `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` to electron-builder, which reads both names directly. Afterwards `Get-AuthenticodeSignature` must report `Valid` for both installers and both app executables.
- Files in both cases: `Desktop-Cat-Setup-<version>-x64.exe`, `Desktop-Cat-Setup-<version>-arm64.exe`, `SHA256SUMS-windows.txt`.

The Linux job is unchanged: it builds an unsigned AppImage and tar.gz and uploads them as an artifact.

### pages.yml

No inputs and no secrets. It runs `node scripts/build.mjs --web-only` and deploys `out/web` to the repository's GitHub Pages project site, in the `github-pages` environment.

The site is served under the `/GizeCat/` subpath of the project-site address. The bundle uses relative URLs only (`index.html`, the manifest's `start_url` and `scope`, `sw.js` with scope `./`), so it needs no base-path setting. The real address is the one the deploy job prints.

The result is a **public website**. A project site shares its origin with the other Pages sites of the same account or organization (shared `localStorage` and caches); a custom domain owned by you avoids that.

GitHub's `github-pages` environment can restrict which branches may deploy. If the deploy job is refused with an environment protection error, run the workflow from `main`, or allow the branch under **Settings**, **Environments**, `github-pages`.

## Attaching files to a draft release

The optional `draft_release_tag` input works the same in `macos-packages.yml`, `android-release.yml` and `release.yml`.

- The tag must name a release that already exists. The workflows never create a release.
- A release that is not a draft is refused, so a published release such as v1.3.0 cannot be changed by these workflows.
- Files are added with `gh release upload` without `--clobber`. If an asset with the same name is already on the draft, the upload fails and nothing is replaced. Delete that asset from the draft first if you want to replace it.
- The job that attaches runs after the build, holds no signing secret, and is the only job with write access to the repository.

The per-workflow checksum files (`SHA256SUMS-mac-adhoc.txt`, `SHA256SUMS-mac.txt`, `SHA256SUMS-android.txt`, `SHA256SUMS-windows.txt`) cover only that workflow's files. The install guides point users to the release's single `SHA256SUMS.txt`, which `npm run release:sums` writes ([how](building-and-packaging.md#release-checksums)). After stapling or signing, generate it from the files that are actually on the release.

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

| Secret | Format | Where it comes from |
|---|---|---|
| `WIN_CSC_LINK` | Base64 of a `.pfx` file, single line | An exported code-signing certificate with its private key |
| `WIN_CSC_KEY_PASSWORD` | Text | The password of that `.pfx` |

Only a certificate whose private key can be exported works here. Since 2023-06-01 the [CA/Browser Forum's code-signing requirements](https://cabforum.org/working-groups/code-signing/requirements/) require certificate keys to be generated and kept in a hardware crypto module, so a certificate bought today normally cannot be exported as `.pfx`. Signing with a hardware token or cloud HSM is NOT_IMPLEMENTED in this workflow.

### Creating and storing the secrets

Do this once per environment you intend to use.

1. In the repository go to **Settings**, **Environments**, **New environment**, and enter the name exactly (`macos-signing`, `android-signing` or `windows-signing`).
2. Under **Deployment protection rules**, turn on **Required reviewers**, add yourself, and save.
3. Under **Environment secrets**, add each secret with its exact name.

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
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\certificate.pfx")) | gh secret set WIN_CSC_LINK --env windows-signing --repo GizeVerse/GizeCat
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\upload.keystore")) | gh secret set ANDROID_KEYSTORE_BASE64 --env android-signing --repo GizeVerse/GizeCat
```

The certificate and keystore files themselves must stay outside the repository. Replace `XXXXXXXXXX` with your key's ID.

## What the owner does, in order

1. **Decide when the workflow files reach `main`.** Until they do, nothing here can be started (see [the default-branch rule](#the-default-branch-rule)). Pushing to `main` also triggers `ci.yml`.
2. **For the web app:** decide that it may be public. Then, once only, set **Settings**, **Pages**, **Build and deployment**, **Source: GitHub Actions**.
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
- A universal build needs a macOS runner; the Linux container route makes ad-hoc zips for x64 and arm64 only.
- The ARM64 Windows installer can only be checked statically on an x64 runner. Installing it needs a Windows on Arm PC or VM.
- `installer-check.yml` is a separate manual workflow that really installs and uninstalls on a hosted runner. It is not part of this release automation.
