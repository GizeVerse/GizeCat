# GizeCat on macOS (1.4.0 release candidate)

1.4.0 makes macOS a first-class desktop target for Intel and Apple Silicon Macs: a menu-bar icon, a Dock switch, an opt-in login item and packaging. **It has never run on a Mac.** No Mac, macOS virtual machine or Xcode exists on the machine that builds GizeCat. Everything below comes from reading the code, Electron 44.9.3's sources and Apple's documentation. Statuses use the 1.4.0 vocabulary in [README.md](README.md#status-vocabulary-for-140).

## Requirements

- macOS 13 (Ventura) or later, the minimum of the Electron version GizeCat uses. The login item also needs macOS 13.
- An Intel Mac (x64) or an Apple Silicon Mac (arm64). Apple menu → **About This Mac**: "Chip: Apple M…" means Apple Silicon; "Processor: … Intel …" means Intel.

## How to get it

electron-builder can build the ad-hoc zips on Linux, but not on Windows itself. DMG and universal builds need a Mac: electron-builder needs `hdiutil` for a DMG, and `@electron/universal` refuses other hosts. The builds that macOS trusts also need the owner's Apple Developer account. So there are three kinds of download:

| Download | What it is | Status |
|---|---|---|
| `GizeCat-1.4.0-mac-arm64-adhoc.zip`, `GizeCat-1.4.0-mac-x64-adhoc.zip` | Test builds made in a disposable WSL 2 distro on the Windows build PC, and signed **ad hoc** (no Apple identity). **Not notarized.** | COMPILED_OR_PACKAGED. Statically inspected by `scripts/check-mac-payload.mjs`. **Never run.** |
| `GizeCat-1.4.0-mac-<arm64, x64, universal>-adhoc-macrunner.dmg` and `.zip` | Ad-hoc signed builds from the manual workflow `macos-packages.yml` on a Mac runner, with no secrets. **Not notarized.** | THEORETICALLY_COMPATIBLE_NOT_EXECUTED. The workflow has never been started. |
| `GizeCat-1.4.0-mac-<arm64, x64, universal>.dmg` and `.zip` | Builds signed with a Developer ID and notarized by Apple, from the same workflow with the owner's secrets | REQUIRES_OWNER_CREDENTIALS. Not available until the owner provides Apple credentials. |

`macos-packages.yml` is not on `main`, so it cannot be started until the owner brings it there ([release automation](release-automation.md)). 1.4.0 is not published: a zip can be downloaded only once the owner attaches it to a release.

An ad-hoc build is **not equivalent to a notarized app or an App Store app.** Apple has not checked it, and macOS blocks it until you allow it by hand. Install one only if you trust its source and its SHA-256 matches.

Every download contains an app named **Desktop Cat.app**. The bundle name and its identifier `io.github.enesiltas.desktopcat` are frozen, because the Keychain and login items are keyed by them ([why](../gizeverse/12-branding.md)).

## Install an ad-hoc test build, step by step

1. Download the zip for your Mac and `SHA256SUMS.txt` from the release page (<https://github.com/GizeVerse/GizeCat/releases>).
2. Check it in Terminal: `shasum -a 256 ~/Downloads/GizeCat-1.4.0-mac-arm64-adhoc.zip`. The hash must match the file's line in `SHA256SUMS.txt`.
3. Double-click the zip to unpack it, and move **Desktop Cat.app** to the **Applications** folder. "Open at login" only works from there.
4. Open the app once. macOS refuses to open it. Close the message; do not move the app to the Trash.
5. Open **System Settings → Privacy & Security**, scroll to **Security**, and click **Open Anyway** next to the message about Desktop Cat. Confirm with your password or Touch ID, then choose **Open**. On macOS 15 and later this is the only way through the dialog; the older Control-click → Open bypass was removed.
6. Alternative, for a build you trust: in Terminal, `xattr -dr com.apple.quarantine "/Applications/Desktop Cat.app"` removes the download mark, and the app then opens normally.
7. macOS may ask whether Desktop Cat may use its Keychain item "Desktop Cat Safe Storage". Each new ad-hoc build can ask again, because its signature changes.

If something goes wrong: [troubleshooting](troubleshooting.md#macos).

## Install a signed and notarized build (when available)

1. Download the DMG for your Mac (arm64, x64, or universal for both) and check its SHA-256 as above.
2. Open the DMG and drag **Desktop Cat** to **Applications**.
3. Open it from Applications.

## Permissions

GizeCat 1.4.0 requests **no permission** on macOS: no Accessibility, Screen Recording, Input Monitoring, camera, microphone or Bluetooth.
- Electron's built-in reasons for camera, microphone, audio capture and Bluetooth are replaced with "GizeCat never uses … If macOS asks, choose Don't Allow", so even an unexpected prompt says what is true.
- Screen analysis is not available on macOS. It fails closed: no capture code runs, so no Screen Recording prompt can appear.
- **Open at login** is off by default. If you turn it on, macOS may ask you to approve it in **System Settings → General → Login Items**. Settings then shows that it waits for your approval, with an **Open Login Items settings** button.
- **Keychain.** With no API key saved, GizeCat does not ask the Keychain for its status. Saving an API key is what first needs it. Chromium's own cookie store may still ask at launch (not checked on a Mac).

## What works and what does not

What exists in code (THEORETICALLY_COMPATIBLE_NOT_EXECUTED for every item):
- The cat on the floor of each screen's work area, just above the Dock, in a transparent panel that lets clicks through everywhere except the cat. The cat reacts to the first click.
- The panel sits at the "floating" level: above normal windows, below menus, the menu bar, the Dock and system alerts. By Electron's panel behaviour it is on every Space and also over fullscreen apps. It is hidden from Mission Control.
- Petting, clicking, dragging and throwing.
- A menu-bar icon drawn as a template, so it follows light, dark and tinted menu bars. Paused and vision states have different shapes. A click opens the menu; it does not hide the cat.
- A Dock icon, on by default. **Settings → General → Show GizeCat in the Dock** turns it off; the menu-bar icon then stays.
- **Settings → General → Open at login**, through macOS's login-item service. It works only when the app is in /Applications; a copy in Downloads shows the reason instead of the switch.
- The application menu has About, Services, Hide Others, Show All and Quit, but no Hide, so Cmd+H can never hide the cat. Cmd+C and Cmd+V work in Settings.
- The show/hide shortcut Control+Option+Shift+C. The shortcut field accepts Command and Cmd, and shows Option and Command. In `settings.json` they are stored as `Alt` and `Super`.
- Settings in macOS terms: "this Mac", "menu bar", "Open at login". Settings icons are plain Unicode symbols, because the Windows icon font does not exist on a Mac.
- The Behaviour page leaves out the taskbar, tab-strip and window-hop rows when those capabilities are unavailable.
- **Take your cat to another device** in Settings → Personality ([guide](profile-transfer.md)).
- A quick quit at logout or shutdown that saves the cat at once.

What it does not do:
- Climb windows, ride the Dock or walk on browser tabs. 1.4.0 is floor-only on macOS: the only permission-free source of other windows' positions needs native code that has never run on a Mac (NOT_IMPLEMENTED).
- Get out of the way of fullscreen apps. The fullscreen setting has no effect on macOS, and Settings says so under it (NOT_IMPLEMENTED).
- Screen analysis and AI vision (NOT_IMPLEMENTED on macOS; fails closed).

## Limitations

- Nothing has run on a Mac. The first-click delivery, the click-through and the panel level are the first things a Mac run must check ([checklist](../gizeverse/04-macos.md)).
- "Hide from screenshots" asks macOS not to share the cat's windows. Newer capture tools, on macOS 15 and later, may still show the cat (not checked).
- The Apps exclusion list on the Privacy page has no effect on macOS, because screen analysis is unavailable.
- Some rows and texts are still written for Windows. The window rows that do not name Windows have no effect on a Mac, Diagnostics › Surfaces still lists taskbars and tab strips, and About still mentions koffi, which macOS builds do not ship.
- There is no automatic update. Replace the app with a new version.

## Signing and store status

| Item | Status |
|---|---|
| Ad-hoc zips (x64, arm64), built in a disposable WSL 2 distro | COMPILED_OR_PACKAGED; never run; never notarized |
| Ad-hoc DMG and zip (x64, arm64, universal), workflow job `adhoc` | THEORETICALLY_COMPATIBLE_NOT_EXECUTED (the workflow has never been started); never notarized |
| Developer ID signing and notarization (DMG and zip, x64, arm64, universal), workflow job `developer-id` | REQUIRES_OWNER_CREDENTIALS (Apple Developer Program, a Developer ID certificate, a notarization key, in the `macos-signing` environment) |
| Universal build | THEORETICALLY_COMPATIBLE_NOT_EXECUTED (only a Mac can build it) |
| Mac App Store | NOT_IMPLEMENTED |

## Uninstall

1. If you turned on **Open at login**, turn it off in Settings → General first, or remove Desktop Cat in System Settings → General → Login Items.
2. Quit the cat: menu-bar icon → **Quit GizeCat**.
3. Drag **Desktop Cat** from Applications to the Trash.
4. Your cat and settings stay in `~/Library/Application Support/Desktop Cat`. Delete that folder to remove them. The Keychain item "Desktop Cat Safe Storage" can be deleted in Keychain Access.

## Feedback

Mac reports are the only way macOS statuses can move. Open a **Platform report** at <https://github.com/GizeVerse/GizeCat/issues>, choose macOS, and give your macOS version, Intel or Apple Silicon, and which zip or DMG you installed. If the overlay ever blocks clicks, quit GizeCat (menu-bar icon, or Activity Monitor) and say so first. Logs are in `~/Library/Application Support/Desktop Cat/logs/`; read them before you attach them.
