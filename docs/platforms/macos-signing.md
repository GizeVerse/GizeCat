# macOS signing and notarization (Developer ID) for GizeCat

How GizeCat's macOS packages for Intel (x64), Apple Silicon (arm64) and universal Macs get a Developer ID signature, Apple's notarization and a stapled ticket, and what the owner has to do. Status words: [README.md](README.md#status-vocabulary-for-140).

**Nothing on this page has been signed by Apple's certificate or notarized.** No Apple Developer Program membership or certificate is connected to the project. Ad-hoc signing is not Developer ID signing: an ad-hoc signature says only that the files are internally consistent. It names no developer, and Gatekeeper blocks ad-hoc apps from the internet until the user allows them.

| Item | Status |
|---|---|
| `GizeCat-1.4.0-mac-x64-adhoc.zip`, `GizeCat-1.4.0-mac-arm64-adhoc.zip` in `release/1.4.0/mac/` | COMPILED_OR_PACKAGED, **ad-hoc signed, not notarized**. Checked statically on 2026-11-10 with `scripts/check-mac-payload.mjs --expect-signature adhoc`: every Mach-O and the Electron framework carry an ad-hoc signature with no CMS signer, and a check for a real (CMS) signature fails as it should |
| DMG and universal packages | Not built here (they need a macOS host); the `adhoc` job of `macos-packages.yml` builds them |
| Developer ID signing, notarization and stapling (`macos-packages.yml`, `signing: developer-id`) | IMPLEMENTED; never started; REQUIRES_OWNER_CREDENTIALS (paid Apple Developer Program) |
| PKG installer, Developer ID Installer certificate | Not produced, not needed |
| Any run on a Mac | Not done. Nothing in 1.4.0 has run on a Mac |

## 1. What is needed

- **Apple Developer Program membership.** A paid yearly membership. Enrolling as an individual is possible, and then the certificate shows your personal name.
- **A "Developer ID Application" certificate,** created in your developer account or with Xcode. Apple lets only the Account Holder create Developer ID certificates. Export it from Keychain Access as a `.p12` with its private key and a strong password.
- **Notarization credentials**, one of:
  - **App Store Connect API key (preferred):** the `.p8` file (Apple offers the download only once), its Key ID and the Issuer ID;
  - **Apple ID:** the account's e-mail, an app-specific password (not the account password) and the Team ID.
- **No "Developer ID Installer" certificate:** that one signs `.pkg` installers, and GizeCat ships DMG and zip only.

The secret names and formats are in [release-automation.md](release-automation.md#macos-signing-workflow-macos-packagesyml): `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, and one complete set of `APPLE_API_KEY_P8_BASE64` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` or `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`. Optional environment **variable** (not secret): `MAC_EXPECTED_TEAM_ID`, your 10-character Team ID.

## 2. How the build signs (electron-builder.yml and the workflow)

- **Hardened runtime:** `mac.hardenedRuntime: true`, which notarization requires. It is switched off only on the ad-hoc path, where library validation would reject ad-hoc frameworks.
- **Entitlements:** `build/entitlements.mac.plist` and `build/entitlements.mac.inherit.plist` both hold exactly `com.apple.security.cs.allow-jit` (V8's JIT).
  - Electron's own defaults in `@electron/osx-sign` add camera, microphone, Bluetooth, USB, printing and location entitlements; GizeCat uses none of these and does not ask for them.
  - There is no `disable-library-validation`: every Mach-O in the bundle is signed with the same Team ID.
  - There is no `allow-unsigned-executable-memory`.
  - Fallback, UNVERIFIED until a signed build runs on a Mac: if the app dies at launch with a code-signing crash in V8, add `com.apple.security.cs.allow-unsigned-executable-memory` to both files.
- **Secure timestamp:** electron-builder signs with Apple's timestamp service; notarization requires it, and the workflow checks for it.
- **Notarization:** electron-builder submits each signed `.app` to Apple's notary service and staples the ticket, before it makes the DMG and zip from that app.
  - It does this only when it finds exactly one complete set of credentials; a partial set is an error.
  - A zip cannot be stapled, so the zip carries the stapled app.
- **DMG containers:** electron-builder leaves them unsigned. The workflow then signs each DMG with the same Developer ID Application identity (secure timestamp), submits it with `xcrun notarytool submit --wait`, and accepts only Apple's status `Accepted`. It then staples it with `xcrun stapler staple`.
- **Universal:** electron-builder merges the x64 and arm64 apps; the universal app is signed and notarized like the others.

## 3. What the workflow refuses (fail closed)

The `developer-id` job of `macos-packages.yml` runs in the protected `macos-signing` environment, and stops:

- **before the build**, when a signing secret is missing or a notarization set is partial;
- **after packaging**, for each built `.app` **and** for the `.app` inside each shipped zip, when any of these is missing:
  - a deep, strict valid signature;
  - the hardened runtime flag;
  - `Authority=Developer ID Application: …`, chained to `Developer ID Certification Authority` and `Apple Root CA`;
  - a secure timestamp;
  - a Team ID (equal to `MAC_EXPECTED_TEAM_ID` when set);
  - Gatekeeper's verdict `source=Notarized Developer ID`;
  - a valid stapled ticket.

  This also catches electron-builder picking a non-Developer-ID identity, which `forceCodeSigning` alone does not prevent.
- **in the static payload check** of the thin x64 and arm64 zips, which requires a real CMS signature on every Mach-O (`--expect-signature cms`);
- **for each DMG**, when signing, Apple's notarization (`Accepted`), stapling, or Gatekeeper's `Notarized Developer ID` verdict for the disk image fails. Such a DMG never reaches the artifact.

It keeps `notarization-mac.txt`, which lists each DMG's notarytool submission ID and status, next to `SHA256SUMS-mac.txt`. A notarization claim for a GizeCat file is only true when such a record from Apple exists.

Secrets handling:
- The `.p8` key is written under the runner's temp folder with mode 600.
- The certificate for DMG signing goes into a throwaway keychain whose random password is never printed.
- A final `always()` step deletes the key file, the certificate copy and the keychain.

## 4. Owner steps

1. Enroll in the Apple Developer Program (paid), create the Developer ID Application certificate, and export it as `.p12` with a strong password.
2. Create an App Store Connect API key with the least-privileged role Apple's current documentation accepts for notarization. Download the `.p8` once and store it in your password manager.
3. In GitHub, create the environment `macos-signing` with yourself as required reviewer, **before** the first run. Then set the secrets and the optional variable:

```sh
base64 -i DeveloperID.p12 | gh secret set MAC_CSC_LINK --env macos-signing --repo GizeVerse/GizeCat
gh secret set MAC_CSC_KEY_PASSWORD --env macos-signing --repo GizeVerse/GizeCat
base64 -i AuthKey_<KEY_ID>.p8 | gh secret set APPLE_API_KEY_P8_BASE64 --env macos-signing --repo GizeVerse/GizeCat
gh secret set APPLE_API_KEY_ID --env macos-signing --repo GizeVerse/GizeCat
gh secret set APPLE_API_ISSUER --env macos-signing --repo GizeVerse/GizeCat
gh variable set MAC_EXPECTED_TEAM_ID --env macos-signing --repo GizeVerse/GizeCat --body <TEAM_ID>
```

4. Bring `macos-packages.yml` to `main`: a `workflow_dispatch` workflow can only be started once its file is on the default branch ([the rule](release-automation.md#the-default-branch-rule)).
5. Run **Actions, macos-packages, Run workflow** with `signing: developer-id`, then approve the environment.
6. Download the artifact and check it on a Mac, with the commands in section 5. Install it on a real Apple Silicon Mac and a real Intel Mac before you share it ([docs/gizeverse/04-macos.md](../gizeverse/04-macos.md)).

## 5. Checking a signed package yourself (on a Mac; reads files, runs no app)

```sh
codesign --verify --deep --strict --verbose=2 "Desktop Cat.app"
codesign -dv --verbose=4 "Desktop Cat.app"        # Authority=Developer ID Application: …, TeamIdentifier, Timestamp, flags=…runtime
codesign -d --entitlements :- "Desktop Cat.app"   # only com.apple.security.cs.allow-jit
spctl -a -t exec -vv "Desktop Cat.app"            # accepted, source=Notarized Developer ID
xcrun stapler validate "Desktop Cat.app"
spctl -a -t open --context context:primary-signature -vv GizeCat-<version>-mac-<arch>.dmg
xcrun stapler validate GizeCat-<version>-mac-<arch>.dmg
xcrun notarytool history --key AuthKey_<KEY_ID>.p8 --key-id <KEY_ID> --issuer <ISSUER_ID>
```

On any computer, `node scripts/check-mac-payload.mjs --arch <x64|arm64> --zip <zip> --expect-signature cms` checks a thin zip's payload and confirms real signatures.

## 6. Key backup, recovery and renewal

- **Backup:**
  - Keep the exported `.p12` on two encrypted offline media in different places, with the password stored separately.
  - Delete any unencrypted export once the GitHub secret is set.
  - Keep the `.p8` the same way: Apple will not offer it again.
- **Loss:**
  - A lost `.p12` means creating a new Developer ID Application certificate in the account. Apple limits how many can exist.
  - A lost or leaked `.p8`: revoke the key in App Store Connect and create a new one.
- **Compromise:**
  - Revoking a Developer ID certificate can affect software already signed with it. Read Apple's current guidance before revoking, and contact Apple Developer Support if the key was compromised.
  - Then delete the GitHub secrets and replace them.
- **Renewal:**
  - The membership renews yearly.
  - The certificate has its own expiry date (shown in the account); create a new one before it expires.
  - Notarized and stapled builds made earlier keep working; new builds are signed with the new certificate.

## 7. Limits

- Never run:
  - the workflow, every Apple step in it, and the DMG signing and notarization step: THEORETICALLY_COMPATIBLE_NOT_EXECUTED;
  - runner details (tools on `macos-15`): assumptions until the first run.
- Whether the minimal entitlements suffice is UNVERIFIED until a signed build starts on a Mac.
- The universal zip holds fat binaries, which `check-mac-payload.mjs` does not read; codesign, spctl and stapler cover it.
- Notarization is Apple's automated malware and signature check. It is not an App Store review, and it says nothing about whether GizeCat works on a Mac.

## Sources

- electron-builder 26.18.1 source: `app-builder-lib/out/macPackager.js`, `mac/MacTargetHelper.js` (notarization credentials), `codeSign/macCodeSign.js` (identity search); `@electron/osx-sign` default entitlements in `node_modules/@electron/osx-sign/entitlements/`.
- Apple developer documentation on notarizing macOS software, `notarytool`, `stapler` and Gatekeeper (`spctl`); check it again before the first run.
