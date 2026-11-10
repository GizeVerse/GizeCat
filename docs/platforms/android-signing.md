# Signing the GizeCat Android app (owner procedure)

Only the owner does this. **No release key exists yet**, and no agent or script creates one, handles one or asks for one. Everything in angle brackets is a placeholder for your own value. Never paste a password or keystore into a chat, an issue, a commit or a log.

Statuses use the 1.4.0 vocabulary in [README.md](README.md#status-vocabulary-for-140).

| Item | Status |
|---|---|
| Unsigned release APK and AAB | COMPILED_OR_PACKAGED |
| Signing from `android/keystore.properties` or the environment | IMPLEMENTED; the signed path has never run, because no key exists (THEORETICALLY_COMPATIBLE_NOT_EXECUTED) |
| Signed release APK and AAB | REQUIRES_OWNER_CREDENTIALS |
| Play App Signing and upload | REQUIRES_OWNER_CREDENTIALS |

## 1. How the build chooses a key

The release build type signs the APK and the AAB with the same key and the same application id, `io.github.gizeverse.gizecat`. It takes the key from the first of these that holds anything:

1. **The environment**, for CI: `ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. A blank value counts as unset. If only some are set, the Gradle configuration stops and names the missing ones.
2. **`android/keystore.properties`**, for your own computer. An incomplete file also stops the build.
3. **Nothing**: the outputs are unsigned.

`scripts/android-gradle.mjs` copies the outputs to `release/<version>/android/` and names them by what they are:

| File | What it is |
|---|---|
| `GizeCat-<version>-android.apk`, `GizeCat-<version>-android.aab` | Signed with your key |
| `GizeCat-<version>-android-unsigned.apk`, `GizeCat-<version>-android-unsigned.aab` | Unsigned. Android does not install this APK and Google Play does not accept this AAB |
| `GizeCat-<version>-android-trial-debugsigned.apk` | The separate sideload trial, signed with the SDK debug key, with its own application id. Never a release |

## 2. Decide how Play and the GitHub APK relate

Google Play always re-signs what users install, so decide this **before the first upload**. It is the one choice here that is hard to change later.

| | A. Google generates the app signing key (the simple default) | B. You supply the app signing key |
|---|---|---|
| Who holds the key users' installs are signed with | Google | Google, from a copy you upload; you keep the original |
| The key in this build | Your upload key, for both APK and AAB | The upload key for the AAB; the app signing key for any APK outside Play |
| Can one user move between the GitHub APK and Play in place | No: the certificates differ, so Android refuses the update | Yes: same certificate |
| What a user switching channels must do | Save the cat to a file (Settings, **Take your cat to another device**), uninstall, install the other one, load the file | Nothing |
| Extra work | None | Generate and guard two keys, and export the app signing key with Google's PEPK tool when enrolling |

Google says: "If you want to use the same signing key across multiple stores, make sure to provide your own signing key when you configure Play App Signing, instead of having Google generate one for you."

For option B the two outputs need different keys, so build them in two runs, setting the key for each: `npm run android:apk` with the app signing key and `npm run android:aab` with the upload key.

## 3. Generate the upload key

You need `keytool`, which comes with Android Studio's JDK. keytool asks for the password and for your name and organisation; these go into the certificate, so use details you are willing to publish. **Do not pass a password on the command line**: it would stay in your shell history.

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.gizecat-keys"
& 'C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe' -genkeypair -v -storetype PKCS12 -keystore "$env:USERPROFILE\.gizecat-keys\<KEYSTORE_NAME>.jks" -alias <KEY_ALIAS> -keyalg RSA -keysize 4096 -validity 10000
```

macOS or Linux (with a JDK's `keytool` on the `PATH`):

```sh
mkdir -p ~/.gizecat-keys && chmod 700 ~/.gizecat-keys
keytool -genkeypair -v -storetype PKCS12 -keystore ~/.gizecat-keys/<KEYSTORE_NAME>.jks -alias <KEY_ALIAS> -keyalg RSA -keysize 4096 -validity 10000
```

- `-validity 10000` is about 27 years. Google recommends at least 25 years, and for Google Play the key's validity must end after 22 October 2033.
- With a PKCS12 keystore the key password and the keystore password are the same. Everywhere below, `<KEY_PASSWORD>` equals `<KEYSTORE_PASSWORD>`.
- Keep the file **outside this repository**. `*.jks`, `*.keystore` and `android/keystore.properties` are gitignored as a second line of defence, not the first.
- Use a long password in plain ASCII. `keystore.properties` is read as a Java properties file, so a backslash in a value has to be written twice.

Look at what you made (keytool asks for the password):

```text
keytool -list -v -keystore <KEYSTORE_PATH> -alias <KEY_ALIAS>
```

Note the certificate's SHA-256 fingerprint in your records. It is public, and it is how you tell keys apart later.

## 4. Store it and back it up

- Keep the keystore in the folder above, and the passwords in a password manager.
- Make at least two copies on separate encrypted offline media, kept in different places, with the password stored separately from them. Check a copy by running the `keytool -list` command above against it.
- Never put the keystore or passwords in the repository, an unencrypted synced folder, email, chat, an issue or a build log.
- A GitHub secret cannot be read back, so it is not a backup.
- Do not upload the keystore to Google Play. Play only ever receives the certificate (`.pem`), or, for option B, the key encrypted by the PEPK tool.

If you lose the key: see [section 9](#9-if-a-key-is-lost-or-exposed).

## 5. Sign on your own computer

Copy `android/keystore.properties.example` to `android/keystore.properties` and fill it in. Write the path with forward slashes:

```properties
storeFile=C:/Users/<YOU>/.gizecat-keys/<KEYSTORE_NAME>.jks
storePassword=<KEYSTORE_PASSWORD>
keyAlias=<KEY_ALIAS>
keyPassword=<KEY_PASSWORD>
```

Alternatively, set the four variables for one PowerShell session without writing a file. The password is read without echo and does not reach the shell history:

```powershell
$env:ANDROID_KEYSTORE_FILE = 'C:/Users/<YOU>/.gizecat-keys/<KEYSTORE_NAME>.jks'
$env:ANDROID_KEY_ALIAS = '<KEY_ALIAS>'
$env:ANDROID_KEYSTORE_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host -AsSecureString 'Keystore password')).Password
$env:ANDROID_KEY_PASSWORD = $env:ANDROID_KEYSTORE_PASSWORD
```

Bash:

```sh
export ANDROID_KEYSTORE_FILE="$HOME/.gizecat-keys/<KEYSTORE_NAME>.jks"
export ANDROID_KEY_ALIAS='<KEY_ALIAS>'
read -rs -p 'Keystore password: ' ANDROID_KEYSTORE_PASSWORD; echo
export ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_PASSWORD="$ANDROID_KEYSTORE_PASSWORD"
```

The environment wins over the file: to go back to the file, close the session or clear all four variables.

## 6. Produce the signed APK and AAB

From the repository root, once section 5 is done:

```text
npm ci --ignore-scripts
npm run android:release
```

This needs a JDK 17+ and the Android SDK with platform `android-36` (see [android/README.md](../../android/README.md#build)). It rebuilds the web bundle, runs Gradle for `:app:assembleRelease` and `:app:bundleRelease`, and produces:

```text
release/<version>/android/GizeCat-<version>-android.apk
release/<version>/android/GizeCat-<version>-android.aab
release/<version>/android/SHA256SUMS-android.txt
```

If a name ends in `-unsigned`, no key was picked up: go back to section 5.

`npm run android:apk` and `npm run android:aab` build one output each. `<version>` follows `package.json`, and each published version needs a higher version there (`versionCode` is MAJOR×10000 + MINOR×100 + PATCH, so 1.4.0 is 10400).

Check the signatures yourself. The certificate's SHA-256 must be the one from section 3:

```text
"%LOCALAPPDATA%\Android\Sdk\build-tools\36.0.0\apksigner.bat" verify --print-certs release\<version>\android\GizeCat-<version>-android.apk
"C:\Program Files\Android\Android Studio\jbr\bin\jarsigner.exe" -verify -verbose -certs release\<version>\android\GizeCat-<version>-android.aab
```

A signed file is still not a tested app: nothing in 1.4.0 has run on a device. Install the signed APK on a tablet you own before you distribute it.

## 7. GitHub secrets, for signing in CI

The manual workflow `.github/workflows/android-release.yml` has never been started. Its signed path reads these secrets from a GitHub **Environment** named `android-signing`. Create that environment first, with a required reviewer, in **Settings, Environments** of `GizeVerse/GizeCat`: a job that names a missing environment makes GitHub create it without protection rules. The workflow's guide is [release-automation.md](release-automation.md).

| Secret name | Format |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | The keystore file as standard base64 on one line, with no line breaks |
| `ANDROID_KEYSTORE_PASSWORD` | The keystore password as plain text |
| `ANDROID_KEY_ALIAS` | The key alias as plain text |
| `ANDROID_KEY_PASSWORD` | The key password as plain text; with PKCS12 it equals the keystore password |

`ANDROID_KEYSTORE_FILE` is **not** a secret: the job decodes `ANDROID_KEYSTORE_BASE64` to a file under the runner's temp folder, sets this variable to its path, and deletes the file at the end.

Set them on the environment, with `--env android-signing`. Do not set them repository-wide: a repository secret would reach the job without the reviewer gate. Without a value on the command line, `gh` prompts and nothing lands in your history:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('<KEYSTORE_PATH>')) | gh secret set ANDROID_KEYSTORE_BASE64 --repo GizeVerse/GizeCat --env android-signing
gh secret set ANDROID_KEYSTORE_PASSWORD --repo GizeVerse/GizeCat --env android-signing
gh secret set ANDROID_KEY_ALIAS --repo GizeVerse/GizeCat --env android-signing
gh secret set ANDROID_KEY_PASSWORD --repo GizeVerse/GizeCat --env android-signing
```

On macOS or Linux, the first line is `base64 < <KEYSTORE_PATH> | tr -d '\n' | gh secret set ANDROID_KEYSTORE_BASE64 --repo GizeVerse/GizeCat --env android-signing`.

- Never expose these secrets to a pull-request build, or to any job other than the one that signs.
- Gradle's own rule is the backstop for any job: with all four variables blank the build is unsigned, and with only some of them set it stops and names the missing ones.

## 8. Play App Signing

Google Play requires Play App Signing for new apps. Your key is the **upload key**: it proves an upload came from you, and Google signs what users install.

1. Sign in to the [Play Console](https://play.google.com/console/) and create the app. The application id is fixed at the first upload and can never change: `io.github.gizeverse.gizecat`.
2. Create a release on a track (start with internal testing).
3. In **App signing**: for option A, do nothing; the key that signs your first upload becomes your upload key. For option B, choose **Change app signing key** and follow the export and upload steps there.
4. Upload `GizeCat-<version>-android.aab`.
5. Sign every later version with the same upload key.

The rest of the store preparation is in [docs/store/google-play/release-readiness.md](../store/google-play/release-readiness.md).

## 9. If a key is lost or exposed

**Upload key (Play):** you are not locked out. Create a new key as in section 3, export its certificate, and in the Play Console open **Protected with Play, Play Store protection, Manage Play app signing**. Under **Upload key certificate**, choose **Request upload key reset**, give the reason and upload the certificate:

```text
keytool -export -rfc -keystore <KEYSTORE_PATH> -alias <KEY_ALIAS> -file <PEM_PATH>
```

**A key that signs APKs outside Play:** there is no recovery. Your users cannot update to an APK signed with a new key: they have to uninstall, so they should first save the cat to a file. If this key was exposed, stop publishing with it and tell users.

**An exposed key in CI:** delete the four GitHub secrets, and treat the key as compromised as above.

## 10. What the build says when something is wrong

| Message or symptom | Meaning |
|---|---|
| `Release signing from the environment is incomplete. Missing: ...` | Some of the four variables are set, and the named ones are not. Set them, or clear all four |
| `android/keystore.properties is missing values for: ...` | The file exists, and the named keys are empty |
| `Release signing: the keystore file does not exist ...` | The path is wrong. In CI, the restore step did not run before the build |
| A failure in a signing task after configuration | A wrong password or alias. This error comes from the Android Gradle Plugin, not from this project |
| Output names end in `-unsigned` | No key was configured |

These messages name variables and keys only. They never print a value.

## Sources

Checked on 2026-11-08; Google changes these, so check them again when you publish.

- [Sign your app](https://developer.android.com/studio/publish/app-signing)
- [Use Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756), and [resetting an upload key](https://support.google.com/googleplay/android-developer/answer/7384423)
