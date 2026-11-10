# Windows code signing (Authenticode) for GizeCat

How the Windows x64 and ARM64 installers get signed, which certificate route fits an individual developer in Türkiye with an MIT-licensed project, and exactly what the owner has to do. Status words: [README.md](README.md#status-vocabulary-for-140).

**Nothing on this page has been signed or run.** No certificate exists, no SignPath project exists, and the signing workflow and scripts have never processed a GizeCat file.

| Item | Status |
|---|---|
| `Desktop-Cat-Setup-1.4.0-x64.exe`, `Desktop-Cat-Setup-1.4.0-arm64.exe` in `release/1.4.0/windows/` | COMPILED_OR_PACKAGED, **NotSigned**. Checked on 2026-11-10 with `Get-AuthenticodeSignature` and `signtool verify` through `scripts/verify-windows-signature.ps1`; both refused as unsigned |
| CI signing through SignPath (`release.yml`, `windows_signing: signpath`) | IMPLEMENTED; never started; REQUIRES_OWNER_CREDENTIALS (SignPath acceptance, settings) |
| Local signing with a token or cloud-HSM certificate (`scripts/sign-windows.ps1`) | IMPLEMENTED; never run; REQUIRES_OWNER_CREDENTIALS (a certificate) |
| Signature checks (`scripts/verify-windows-signature.ps1`, `scripts/compare-signed-pe.mjs`) | IMPLEMENTED. Both refused the unsigned candidate installers, and the verifier accepted one correctly signed reference file (`node.exe`). Neither has seen a signed GizeCat file |
| Microsoft Store (MSIX) | NOT_IMPLEMENTED (section 8) |

## 1. Certificate routes for an individual in Türkiye

Researched on 2026-11-10. Prices, terms and eligibility change; check each provider before you decide. Nothing was bought or applied for.

| Route | Who can get it | Publisher users see | Where the key lives; CI | Cost | Fit for GizeCat |
|---|---|---|---|---|---|
| **SignPath Foundation** (open-source programme) | Open-source projects that meet its terms; no company needed | **SignPath Foundation** (the certificate is issued to the Foundation, not to you) | SignPath's HSM; built for CI (GitHub action) | Free | **Recommended first** |
| **Certum Open Source Code Signing** | Natural persons only; the subscriber must be the applicant; document-based verification, including the project's website | "Open Source Developer, <your name>" | Smart card, or Certum's SimplySign cloud with an interactive login; suits local signing, not unattended CI | From €49 (SimplySign) or €69 gross in Certum's shop listings; card-reader sets more | **Fallback**, with `scripts/sign-windows.ps1` |
| Other OV or IV certificates, for example SSL.com with eSigner cloud signing | Depends on the CA; eligibility for an individual in Türkiye was not confirmed | Your verified name | Cloud HSM; some offer GitHub Actions integration | Paid; varies | Possible later; needs a separate workflow path |
| Azure Artifact Signing (formerly Trusted Signing) | Public-trust identities for organizations in the USA, Canada, the EU and the UK, and individuals in the USA and Canada only | Your verified name | Azure; CI-friendly | Paid | **Not available** to an individual in Türkiye |
| EV certificates | Organizations | The organization | Token or HSM | Expensive | **No SmartScreen benefit** (section 3); not worth it here |
| Microsoft Store (MSIX) | Individual developer accounts; registration free since September 2025 | Your Store publisher name | Microsoft signs MSIX packages it distributes | Free | Future option; needs app changes (section 8) |

**Hardware keys are mandatory.** Since 1 June 2023 the [CA/Browser Forum's code-signing requirements](https://cabforum.org/working-groups/code-signing/requirements/) require the private key of a publicly trusted code-signing certificate to be generated and kept in a hardware module (token, smart card or HSM). A new certificate therefore cannot be exported as a `.pfx` file and stored as a CI secret. That is why the old `.pfx` route (`WIN_CSC_LINK`) was removed from `release.yml`.

**Shorter validity.** Certum says that from 27 February 2026 a single code-signing certificate may be valid for at most 459 days, and its open-source product page describes one year.

## 2. Recommendation

1. **Apply to SignPath Foundation** and use the `signpath` path of `release.yml`.
   - It is free, the key never leaves an HSM, and it fits a GitHub-built MIT project.
   - The publisher shown to users is "SignPath Foundation". That is the trade-off.
2. **If SignPath declines**, or you want your own name as the publisher: buy a Certum Open Source Code Signing certificate (no company needed) and sign on your own computer with `scripts/sign-windows.ps1`.
3. **Not now:**
   - Azure Artifact Signing: not available to individuals in Türkiye.
   - EV: no SmartScreen advantage.
   - The Store: a separate product decision with code changes.

SignPath Foundation's [terms](https://signpath.org/terms) that matter for GizeCat:

- **Verifiable builds.** Binaries must be built from source in a verifiable, automated way; build scripts and CI configuration count as source. The `signpath` path builds on GitHub-hosted runners in the same run that requests the signature.
- **Own code only.** "Upstream binaries must not be signed under your subscription, though they may be included in signed packages." `DesktopCat.exe` is Electron's prebuilt executable, renamed and resource-edited by electron-builder, so under a Foundation subscription it should **not** be in round 1. Round 1 is optional and signs only `DesktopCatUia.exe` by default; the installers (round 2) contain the upstream binaries, which the terms allow.
- **Manual approval** of every release signing request; **MFA** for every team member on SignPath and on the repository; defined roles (authors, reviewers, approvers).
- **Code signing policy page.**
  - It is published on the project's home page, and the words "Code signing policy" appear on the home and download pages.
  - It carries the credit that begins "Free code signing provided by", linking SignPath.io and SignPath Foundation.
  - It lists the team roles and members.
  - It links a privacy policy ([docs/PRIVACY.md](../PRIVACY.md) exists).
- **Metadata.** Product name attributes must be set to the project name, with the product version identical across a build's files, enforced through metadata restrictions. Two facts to settle with SignPath:
  - The installers' and the app's version resource says ProductName **"Desktop Cat"**, the frozen product name (src/shared/identity.ts), while the project is called GizeCat.
  - `DesktopCatUia.exe` has **no version resource at all** (ProductName empty, 0.0.0.0). If its round 1 needs metadata, the helper's C# source (native/uia-helper) first needs assembly attributes. Otherwise leave round 1 off.
- Acceptance is at SignPath's discretion, and violations can lead to revocation.

## 3. SmartScreen, honestly

- **Signing does not remove SmartScreen warnings by itself.** Microsoft's [SmartScreen reputation](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation) guidance:
  - Reputation builds up for files and their signing certificate as people download and run them.
  - A new certificate or a new file can still show the warning for a while.
  - Microsoft publishes no download count that guarantees a clean prompt.
- **EV is not a shortcut.** Microsoft's documentation says EV certificates used to get positive SmartScreen reputation by default and that this no longer happens. Beginning in August 2024 the Microsoft Trusted Root Program removed the EV code-signing OIDs, so all code-signing certificates are treated alike.
- **What signing does give:**
  - a named publisher instead of "Unknown publisher" in Windows prompts;
  - tamper evidence;
  - a valid signature, which Windows 11's Smart App Control can use in place of reputation.
- With SignPath Foundation, reputation accrues to SignPath Foundation's certificate, which other projects use as well.

## 4. Authenticode and timestamping: what the tools enforce

Every signing route here uses, and every check requires:

- **SHA-256 file digest** (`signtool sign /fd sha256`). electron-builder's default is a SHA-1 pass plus a SHA-256 pass; `electron-builder.yml` now sets `win.signtoolOptions.signingHashAlgorithms: [sha256]`.
- **An RFC 3161 timestamp with a SHA-256 digest** (`/tr <url> /td sha256`). The default service is DigiCert's `http://timestamp.digicert.com`, set explicitly in `electron-builder.yml` and in `scripts/sign-windows.ps1`. Prefer the issuing CA's own service when there is one (Certum: `http://time.certum.pl`). Timestamp services use plain HTTP by design: the response is itself signed.
- **Why the timestamp matters:** a timestamped signature stays valid after the certificate expires. Observed on this machine on 2026-11-10: `node.exe` is signed with a certificate valid only from 2026-06-23 to 2026-06-26, and it still verifies because of its RFC 3161 timestamp. Without a timestamp, GizeCat's signatures would stop validating when the certificate expires.
- `ELECTRON_BUILDER_OFFLINE=true` makes electron-builder skip the timestamp; `scripts/sign-windows.ps1` refuses to run with it.

Checks, which you can run yourself on any signed file. They read files and run nothing:

```powershell
# All of it: valid, embedded Authenticode, timestamped, SHA-256 only, no signtool warnings
powershell -ExecutionPolicy Bypass -File scripts\verify-windows-signature.ps1 <signed.exe> [<more.exe> ...]

# Windows SDK signtool directly (exit code 0 = valid; 2 = warning such as no timestamp)
& 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe' verify /pa /all /tw /v <signed.exe>

# The signed file is the unsigned build plus a signature, byte for byte
node scripts/compare-signed-pe.mjs <unsigned.exe> <signed.exe>
```

## 5. Route A: SignPath in CI (`release.yml`, `windows_signing: signpath`)

**What the job does:**

1. Builds both app folders unsigned (`electron-builder --win dir --x64 --arm64`).
2. *Round 1 (optional).* Uploads GizeCat's own executables from both folders as a GitHub artifact and submits them to SignPath. A SignPath approver approves the request, and the job waits up to two hours. The job then verifies each returned file, compares it byte for byte with what it uploaded, and puts it back into the app folder.
3. Runs the static payload checks.
4. Builds each NSIS installer from its app folder with `--prepackaged`. electron-builder then packs the folder as it is: it neither edits nor re-signs the executables.
5. *Round 2.* Uploads the two installers, gets them signed through SignPath, then verifies and compares them the same way.
6. Writes `SHA256SUMS-windows.txt` and `signing-provenance-windows.txt`:
   - the commit and the run;
   - both SignPath request IDs;
   - each installer's SHA-256 before and after signing.

   These and the signed installers make up the artifact `windows-nsis-installer-signed`. The unsigned inputs stay available as the artifacts `signpath-input-app-executables` and `signpath-input-installers`.

Any failure stops the job, and no signed artifact is produced. The causes include:
- a missing setting;
- a file SignPath did not return;
- an invalid, untimestamped or non-SHA-256 signature;
- a byte difference outside the signature.

**Owner setup, once:**

1. Apply at [signpath.org](https://signpath.org/terms) with the GizeVerse/GizeCat repository. Prepare the code signing policy page and turn on MFA for everyone with access.
2. In SignPath:
   - Create the project, and connect GitHub as the trusted build system.
   - Create a release signing policy with manual approval.
   - Create a CI user with the submitter role, and an API token for it.
3. Create the artifact configurations from `.github/signpath/`:
   - `windows-installers.xml`, always;
   - for round 1, `windows-app-helper.xml` (default), or `windows-app-helper-and-exe.xml` only if your plan allows signing `DesktopCat.exe`.

   SignPath validates them when you save them.
4. In GitHub, **Settings, Environments**, create `windows-signing` with yourself as required reviewer, **before** the first run. Add the secret `SIGNPATH_API_TOKEN` and the variables listed in [release-automation.md](release-automation.md#windows-signing-workflow-releaseyml):

```powershell
gh secret set SIGNPATH_API_TOKEN --env windows-signing --repo GizeVerse/GizeCat
gh variable set SIGNPATH_ORGANIZATION_ID --env windows-signing --repo GizeVerse/GizeCat --body <organization-id>
gh variable set SIGNPATH_PROJECT_SLUG --env windows-signing --repo GizeVerse/GizeCat --body <project-slug>
gh variable set SIGNPATH_SIGNING_POLICY_SLUG --env windows-signing --repo GizeVerse/GizeCat --body <policy-slug>
gh variable set SIGNPATH_INSTALLER_ARTIFACT_CONFIGURATION_SLUG --env windows-signing --repo GizeVerse/GizeCat --body <installer-config-slug>
# optional, round 1:
gh variable set SIGNPATH_APP_ARTIFACT_CONFIGURATION_SLUG --env windows-signing --repo GizeVerse/GizeCat --body <app-config-slug>
```

5. Run **Actions, release-artifacts, Run workflow** with `windows_signing: signpath`, on the candidate branch or `main`.
   - Approve the environment in GitHub.
   - Approve each signing request in SignPath.
6. Download `windows-nsis-installer-signed`, then check it on your own computer:
   - run `scripts/verify-windows-signature.ps1` on both installers;
   - read `signing-provenance-windows.txt`.

   Once you know the signer subject, set `WINDOWS_SIGNER_SUBJECT` (for example the organization name in it), so later runs refuse any other signer.

## 6. Route B: your own certificate on your own computer (`scripts/sign-windows.ps1`)

This route is for a certificate whose key sits on a token or smart card, or in a cloud HSM that appears in the Windows certificate store, such as Certum's card or SimplySign virtual card. The token's or cloud client's software must be installed and signed in, and the Windows SDK's signtool must be present. The script finds signtool itself.

Find the certificate's thumbprint (public):

```powershell
Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Format-List Subject, Issuer, Thumbprint, NotAfter
```

**Sign the exact candidate files** (default mode `SignExisting`):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sign-windows.ps1 -CertificateThumbprint <THUMBPRINT> -TimestampUrl http://time.certum.pl
```

- It copies `release\<version>\windows\Desktop-Cat-Setup-<version>-{x64,arm64}.exe` to `release\<version>\windows-signed\` and signs **the copies**; the originals are never touched.
- It first checks:
  - each input against `release\<version>\SHA256SUMS.txt`, so only the inventoried candidate files are signed;
  - that each input is unsigned.
- It refuses a certificate that:
  - has no private key on this machine;
  - is expired or not yet valid;
  - lacks the code-signing usage;
  - does not chain to a trusted root. A self-made certificate therefore fails.
- After signing it runs the verifier and the byte comparison, then writes `SHA256SUMS-windows-signed.txt` and `signing-provenance-windows.txt`.
- On any failure it deletes the signed copies it made and leaves `SIGNING-FAILED.txt`.
- It never asks for, stores or prints a PIN or password. The token software asks for those in its own window.
- In this mode only the installers are signed: `DesktopCat.exe`, `DesktopCatUia.exe` and the uninstaller inside them stay unsigned.

**Rebuild with everything signed** (mode `Rebuild`):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sign-windows.ps1 -CertificateThumbprint <THUMBPRINT> -Mode Rebuild -TimestampUrl http://time.certum.pl
```

- It requires a clean working tree, so the commit is exact provenance.
- It builds both installers again with electron-builder, which signs every executable it produces with the certificate (`DesktopCat.exe`, `DesktopCatUia.exe`, the uninstaller, the installers). It uses `forceCodeSigning`, the SHA-256 and RFC 3161 settings, and the Windows SDK signtool through `SIGNTOOL_PATH`.
- Output goes to `release\<version>\windows-signed\`. This is a **new build**: its checksums differ from the unsigned candidate files.
- Afterwards it verifies the installers and the inner executables.

## 7. What each route signs

| File | SignPath, round 1 off | SignPath, round 1 default | Local `SignExisting` | Local `Rebuild` |
|---|---|---|---|---|
| The two installers | Signed | Signed | Signed | Signed |
| `DesktopCatUia.exe` (GizeCat's helper) | Unsigned | Signed | Unsigned | Signed |
| `DesktopCat.exe` (Electron's executable) | Unsigned | Unsigned (signed only with `windows-app-helper-and-exe.xml` and a plan that allows it) | Unsigned | Signed |
| The uninstaller inside each installer | Unsigned | Unsigned | Unsigned | Signed by electron-builder (UNVERIFIED: never run) |
| Electron's DLLs, `elevate.exe`, `koffi.node` | As shipped by their vendors (Microsoft's two DLLs signed, the rest unsigned) | Same | Same | electron-builder signs only `.exe` files by default |

## 8. Microsoft Store and MSIX (not implemented)

- **Store:**
  - Individual developer registration has been free since September 2025 ([Windows Developer Blog](https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/)).
  - Microsoft signs MSIX packages it distributes.
  - An MSI or EXE submission must already be Authenticode-signed with a certificate from a CA in the Microsoft Trusted Root Program ([code signing options](https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options)).
  - So the Store does not avoid the certificate question for the existing NSIS installer.
- **MSIX would change GizeCat's behaviour:**
  - **Data folder.** MSIX redirects `%APPDATA%` writes into the package's private storage. The frozen data folder `%APPDATA%\Desktop Cat` would no longer be shared with an NSIS installation, so a user moving between the two would need the profile transfer.
  - **Start with Windows.** An MSIX app cannot add itself to `HKCU\...\Run`; it needs a declared StartupTask.
  - **Updates.** The package is updated by the Store, not by an in-app updater (GizeCat has none; it publishes nothing itself).
  - **Packaging.** electron-builder builds MSIX/AppX packages ([AppX/MSIX target](https://www.electron.build/docs/appx)). The overlay, click-through and perception features have never been tried inside an MSIX package.
- A Store release is a separate product decision with code and documentation changes. It is not prepared in 1.4.0.

## 9. Key backup, recovery and renewal

- **Backup.** A key generated in a token or HSM cannot be copied, by design.
  - With a token: keep the token physically safe, with its PIN and PUK in a password manager.
  - With SimplySign or another cloud key: protect the account, with MFA on.
  - With SignPath: SignPath holds the key.
- **Loss or theft.** Ask the CA to revoke the certificate at once, then get a new one.
  - Timestamped signatures made before the revocation date stay valid, unless the CA backdates the revocation.
  - A new certificate may start with no SmartScreen reputation.
- **Renewal.** Expect at most about a year (459 days maximum) per certificate. Renew before expiry. Timestamped files signed earlier stay valid; new files are signed with the new certificate.
- **CI secret rotation.** If `SIGNPATH_API_TOKEN` leaks, revoke it in SignPath, create a new one and replace the environment secret. The token cannot sign anything without an approval in SignPath.

## 10. Provenance

- The candidate installers were built from commit `d3cdb6b`; their SHA-256 values are in `release/1.4.0/SHA256SUMS.txt`:
  - x64: `8d0a801d523ebf34c5b4525c420e527ddb25926eb977fb6605d755ba629f9c38`;
  - arm64: `ea741167394785f3f62d8240de0c5ca367700dac19cd1ad09b6e4d1b76661e2a`.
- Signing appends a signature, so a signed installer has a new SHA-256. Each route therefore writes `signing-provenance-windows.txt`, which maps every unsigned SHA-256 to its signed one. `scripts/compare-signed-pe.mjs` proves that every byte apart from the signature fields is unchanged.
- After signing, rebuild the release's single `SHA256SUMS.txt` from the files actually published (`npm run release:sums`, [how](building-and-packaging.md#release-checksums)).

## 11. Limits

- Never run. Every claim about a signed result is THEORETICALLY_COMPATIBLE_NOT_EXECUTED until a real certificate or SignPath project exists:
  - the workflow path;
  - the SignPath artifact configurations, which SignPath has not validated;
  - the `--prepackaged` installer build;
  - both scripts' signing paths.
- The SignPath action's output folder layout (`signpath/app-out/...`, `signpath/installers-out/...`) is taken from its documentation. If the first run lays files out differently, the job fails with a listing rather than continuing.
- `release.yml` can be started from the candidate branch because a file of that name is on `main`. The form's `signpath` choice exists only in the candidate branch's version ([the default-branch rule](release-automation.md#the-default-branch-rule)).
- The ARM64 installer is checked only statically; no Windows on Arm device has run it.
- SmartScreen behaviour after signing cannot be predicted (section 3).

## Sources

Checked on 2026-11-10.

- [CA/Browser Forum code-signing requirements](https://cabforum.org/working-groups/code-signing/requirements/)
- [SignPath Foundation terms](https://signpath.org/terms) · [SignPath artifact configuration syntax](https://docs.signpath.io/artifact-configuration/syntax) and [examples](https://docs.signpath.io/artifact-configuration/examples) · [SignPath GitHub action](https://github.com/SignPath/github-action-submit-signing-request) (pinned in `release.yml` to v2, commit `c92b958760219087e01f8d67a1669ed57afe2627`)
- Certum: [Open Source Code Signing](https://shop.certum.eu/open-source-code-signing.html), [on SimplySign](https://shop.certum.eu/open-source-code-signing-on-simplysign.html), [required documents](https://www.support.certum.eu/en/required-documents/)
- Microsoft: [SmartScreen reputation](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation), [code signing options](https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options), [Artifact Signing quickstart](https://learn.microsoft.com/azure/artifact-signing/quickstart) and [FAQ](https://learn.microsoft.com/azure/artifact-signing/faq), [free Store registration for individuals](https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/)
- [SSL.com code signing certificates](https://www.ssl.com/code-signing-certificates/)
- [electron-builder AppX/MSIX target](https://www.electron.build/docs/appx); electron-builder 26.18.1 source in `node_modules/app-builder-lib/out/codeSign/windowsSignToolManager.js` (hash algorithms, timestamp defaults, `ELECTRON_BUILDER_OFFLINE`) and `platformPackager.js` (`--prepackaged` skips packing and signing)
