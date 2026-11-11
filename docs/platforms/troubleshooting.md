# Troubleshooting GizeCat on your device (1.4.0 release candidate)

**Nothing in 1.4.0 has run on any device.** These are the problems we expect, based on the code and the platform documentation. Nobody has seen them happen yet. The words and screens on your device may differ from the ones here. If a step is wrong, please tell us ([how](#report-what-happened)).

For the Windows app's everyday problems (a black rectangle, surfaces, AI, startup), see [docs/TROUBLESHOOTING.md](../TROUBLESHOOTING.md).

Jump to: [Windows](#windows) · [macOS](#macos) · [iPad](#ipad) · [Android tablets](#android-tablets) · [Importing a profile](#importing-a-profile) · [Report what happened](#report-what-happened)

## Windows

### SmartScreen says "Windows protected your PC"

The installers are not code-signed, so this is expected.

1. Compare the installer's SHA-256 with `SHA256SUMS.txt` ([how](windows.md#install-step-by-step)).
2. If the hash matches, choose **More info**, then **Run anyway**.
3. If there is no **Run anyway**, a policy on your PC blocks unsigned apps. Ask whoever manages the PC.

### Smart App Control blocks the installer

Smart App Control can block unsigned installers, and it has no per-app exception.

1. Check its state in **Windows Security → App & browser control → Smart App Control**.
2. Turning it off is your decision. Read what Windows says first: on some versions it cannot be turned back on without reinstalling Windows.
3. If you want to keep it on, wait for a signed installer (REQUIRES_OWNER_CREDENTIALS).

### The installer says it is for Windows on Arm

You started the ARM64 installer on a PC that is not Windows on Arm. It stops without installing anything. Use `Desktop-Cat-Setup-1.4.0-x64.exe`. To check your PC: **Settings → System → About → System type**.

### The x64 build does not start on Windows 10 on Arm

Windows 10 on Arm has no x64 emulation (BLOCKED_BY_PLATFORM). The ARM64 build has not been tried on Windows 10 on Arm.

### The cat does not appear

1. Wait a few seconds. Windows delays startup apps after sign-in.
2. Find the icon in the notification area. If you do not see it, open the `^` overflow.
3. Left-click the icon to show the cat, or right-click it and choose **Call**.
4. Press `Ctrl+Alt+Shift+C`.
5. The cat hides on a monitor where a fullscreen app is in front. Check **Settings → Behavior → Fullscreen behaviour**.
6. Quit from the tray, then open **Desktop Cat** from the Start menu. The installed name is still Desktop Cat ([why](../gizeverse/12-branding.md)).
7. Still nothing: look in `%APPDATA%\Desktop Cat\logs\main.log`. On a Windows on Arm PC, please report it: the ARM64 build has never run.

### Clicks do not reach the windows under the cat

Only the cat's body should catch the mouse. If anything else does:

1. Press `Ctrl+Alt+Shift+C` to hide the cat.
2. Tray menu → **Interactions** off makes the cat fully click-through.
3. Quit from the tray, or from Task Manager.
4. Please report it, and say so first in the report.

## macOS

### macOS refuses to open the app (Gatekeeper)

This is expected for an ad-hoc zip. Apple has not notarized it.

1. Open the app once, and close the message. Do not move the app to the Trash.
2. Open **System Settings → Privacy & Security**, scroll to **Security**, and click **Open Anyway** next to the message about Desktop Cat.
3. Confirm with your password or Touch ID, then choose **Open**.

On macOS 15 and later this is the only way through the dialog. The older Control-click → Open bypass was removed. For a build you trust, Terminal also works: `xattr -dr com.apple.quarantine "/Applications/Desktop Cat.app"`.

An ad-hoc build is not equivalent to a notarized app or an App Store app ([more](macos.md#how-to-get-it)).

### macOS says the app is damaged, or it still will not open

1. Compare the zip's SHA-256 with `SHA256SUMS.txt`: `shasum -a 256 <file>`.
2. Unpack the zip by double-clicking it in Finder. The app holds symbolic links, and another unzip tool may break them.
3. Check you have the right zip. Apple menu → **About This Mac**: "Chip: Apple M…" needs `arm64`, and "Processor: … Intel …" needs `x64`.
4. Move **Desktop Cat.app** to **Applications** and try the Gatekeeper steps again.

### A Keychain prompt appears

The item is "Desktop Cat Safe Storage". Saving an API key needs it, so a prompt then is expected. With no key saved, GizeCat does not ask for it just to report its status. Chromium's own cookie store may still ask at launch (not checked on a Mac). Each new ad-hoc build can ask again, because its signature changes.

### The cat does not appear

1. Look along the floor of each screen, just above the Dock.
2. Click the menu-bar icon and choose **Show**. On a Mac with a notch, the icon can be hidden behind the notch.
3. Click the Dock icon to open Settings. If you turned the Dock icon off, use the menu-bar icon.
4. Press Control+Option+Shift+C.
5. Still nothing: look in `~/Library/Application Support/Desktop Cat/logs/`, and please report it.

### Clicks do not reach the apps under the cat

Quit GizeCat from the menu-bar icon or Activity Monitor. Please report it, and say so first in the report.

### "Open at login" is missing or waiting

1. It works only when the app is in the **Applications** folder. A copy in Downloads shows the reason instead of the switch.
2. macOS may ask you to approve it in **System Settings → General → Login Items**.
3. It needs macOS 13 or later.

## iPad

### The web address does not open

The expected address, `https://gizeverse.github.io/GizeCat/`, is **not deployed**. Until the owner publishes the web app, there is nothing there.

You can host `GizeCat-web-1.4.0.zip` yourself on any static HTTPS host. Opening `index.html` from disk does not work.

### "Add to Home Screen" is missing

1. Open the address in **Safari**, in a normal tab.
2. Tap **Share** (the square with an arrow).
3. Scroll the list until you find **Add to Home Screen**.

### My cat is gone, or I have two different cats

A Safari tab and the Home Screen app may keep **separate storage**, so they can hold different cats. Each device has its own cat as well.

- **Install first, then meet your cat.** A cat you met in a Safari tab may not come along.
- **To move a cat from a Safari tab to the Home Screen app:** in the Safari tab, open **Settings → Take your cat to another device → Save my cat to a file**. Then open the Home Screen app and choose **Load a cat from a file** ([details](profile-transfer.md)).
- **Safari may clear the cat.** In a Safari tab, Safari may delete a site's data after 7 days without a visit. A Home Screen app keeps its own storage and its own day count.
- Removing the Home Screen app deletes its storage, and the cat with it. Save the cat to a file first.

### "GizeCat has not started"

The page shows this after 15 seconds if the app's code has not loaded, or if the browser is too old. A slow connection can also cause it; the message goes away if the cat starts after all.

1. Check your connection.
2. Close GizeCat and open it again.
3. Update iPadOS. iPadOS 16.4 or later is assumed.

### What the offline line in Settings means

| The line says | Meaning |
|---|---|
| Ready to work offline | GizeCat can start without a connection. |
| Getting GizeCat ready to work offline | It is still saving its offline copy. Keep it open for a moment. |
| A new version of GizeCat is ready | Close GizeCat and open it again to start the new version. |
| GizeCat could not save an offline copy | It works while it is open, but needs a connection to start again. |
| GizeCat cannot keep an offline copy here | It needs a connection to start. Check that the address is HTTPS. |

### The cat does not show over other apps

That is expected. iPadOS has no way for an app or web page to draw over other apps (BLOCKED_BY_PLATFORM). The cat lives inside its own window.

### No sound

Tap the **Sound** button, or turn on Cat sounds in Settings. Safari allows audio only after a tap. The iPad's volume and silent setting apply.

## Android tablets

### The unsigned APK will not install

`GizeCat-1.4.0-android-unsigned.apk` has no signature, and Android does not install an unsigned APK. Android may only say "App not installed". Nothing on the tablet can fix that.

- Use the debug-signed trial APK, `GizeCat-1.4.0-android-trial-debugsigned.apk`, if the release lists it. It is for sideload trials only and is never a production release.
- Or wait for a signed APK (REQUIRES_OWNER_CREDENTIALS).
- Someone with their own release key can build a signed APK: [android-signing.md](android-signing.md).

### The trial APK will not install

1. It needs Android 10 or later.
2. Allow installs from the app you opened it with (Chrome or Files): turn on **Allow from this source**, then go back.
3. Google Play Protect may warn about an unknown developer. That is expected for an app from outside Play.
4. Google's developer verification may apply on your device ([more](android.md#install-the-trial-apk-step-by-step)).

### A signed app will not install over another one

Android refuses an update signed with a different key. The trial has its own application id, so it installs next to a signed app and has its own cat.

1. In the old app, save the cat to a file ([how](profile-transfer.md)).
2. Uninstall the old app.
3. Install the new one and load the file.

### The Android System WebView is too old

The app draws the cat with Android System WebView. An outdated WebView cannot start the app, and the page then shows "GizeCat has not started" after 15 seconds.

1. Open **Settings → Apps → Android System WebView** and note the version.
2. Update it from Google Play.
3. Open GizeCat again.

A WebView without `WEB_MESSAGE_LISTENER` can show the cat but cannot save a file, so the **Save** controls are hidden. Loading a file still works.

### The cat reloads when I change dark mode, language or text size

That is deliberate. These changes rebuild the page so the theme, system bars and text are applied again. The cat was saved first and comes back. Rotation, split screen, resizing and moving to another display are meant to keep the live cat.

### I am stuck on the third-party notices page

Android's Back button sends the app to the background from that page. Use the **Back to GizeCat** link at the top or bottom of the page.

### "Install app" is missing in Chrome

The web app needs an HTTPS address, and the expected one, `https://gizeverse.github.io/GizeCat/`, is **not deployed**. On a self-hosted copy, open Chrome's menu (⋮) and look for **Install app** or **Add to Home screen**.

### The cat does not show over other apps

That is expected. Android's touch rules rule out a click-through overlay (BLOCKED_BY_PLATFORM). The cat lives inside its own window.

### The app and the web app in Chrome have different cats

They do not share a cat. Use a [profile file](profile-transfer.md) to move one.

## Living Companion (1.5.0 release candidate, Windows and Android)

None of this has been run on a device; these are the likely causes from reading the code.

### The cat ignores world events, or no event happens

World events are rare by design: the first comes 5 to 30 minutes after the app starts, and the next 5 to 30 minutes after each one ends (Settings → Behaviour → How often can halve or double that, never below 2 minutes). Check, in order:
- **Off.** Settings → Behaviour → **World events** (or Accessibility & Focus → **Disable all world events**), or the individual event is switched off. Android: Behavior → World events.
- **Paused.** Settings → Companion → **Pause events** holds events until you resume or restart GizeCat; the Companion page says "World events are paused for this session". The cat itself paused (**Pause**) also stops them. Android: Behavior → **Pause world events**.
- **Fullscreen.** While a game, video or presentation is full screen on the cat's monitor, events do not start and a running one winds down (unless Full-screen quiet mode is Carry on).
- **Laser Mode is on**, or you are typing a lot, or the cat is hidden: events do not start.
- **Asleep.** A sleeping cat is not woken by a gentle event; it waits (20 to 90 seconds) and tries later, so events cluster while the cat is awake.
- **The cat is busy or being handled** (carried, thrown, petted): the event waits or the cat finishes first. A given event also needs room: a very small screen or window may rule some out.
- **Rare events** are on by default and can be switched off under Behaviour → Rare events; even when on, a due event comes from the rare pool only about 6 times in 100.
- The cat may simply not react: a lazy, shy or calm personality ignores small things. Settings → Companion shows the current event or "Next in about ...".

### The laser dot does not follow my pointer

- **Windows:** Laser Mode must be on (Settings → Companion, tray, or the cat's menu). The dot follows the pointer on the cat's display only, and is not drawn over a display with a full-screen app in front. While you are pressing a button, typing, dragging or have the cat paused or hidden, the cat lets go of the light. Right-click the cat or use the tray menu to stop it.
- **Android:** this is a limit of Android, not a fault. Over other apps GizeCat sees only touches and mouse or trackpad hover on the cat's own small touch window, and position hints from its own app window, so the dot follows just those and goes away when they stop; it cannot follow your finger over other apps. Also check that **Hunt and pounce** is on (Laser mode is greyed out without it) and that Laser mode is switched on again after opening the app, because it is off every time.
- The cat never catches the dot, and a sleeping cat wakes to it only after the dot has been around for a moment.

### The journal is empty

- **Keep a journal** is off (Settings → Journal; Android: panel → Journal). Nothing new is written while it is off.
- No event worth remembering has happened yet, or World events are off or paused, so nothing was written.
- You used **Clear journal**, which also clears the short event history, or you loaded a profile onto a device: a profile never carries the journal.
- Settings could not load it ("The journal could not be loaded") or the version does not have it; it retries. Android: while the floating cat runs, the panel shows what it last saved; stop the floating cat to clear.

## Importing a profile

Nothing changes until you confirm the preview. If you see one of these messages, your cat on this device is untouched.

| Message | Meaning | What to do |
|---|---|---|
| This file is not a GizeCat profile. | The file is not a profile. | Pick the `gizecat-<name>-<date>.json` file you saved. |
| This file is too large to be a GizeCat profile. | It is over 64 KiB. | Same as above. A real profile is a few KB. |
| This profile was saved by a newer GizeCat. Update GizeCat on this device, then try again. | Its major format is newer than this app. | Update GizeCat on this device. |
| This profile format is not supported. | The format cannot be read. | Save the cat again with a current GizeCat. |
| This file holds a different GizeVerse character, which this version cannot load. | It is not a cat. | Use a cat's profile. |
| This profile is damaged or was edited by hand, so it cannot be loaded. | The contents failed the checks. | Save the cat again on the first device. Do not edit the file. |
| The file could not be read. | The system could not read it. | Copy it to the device again, then retry. |
| That file was opened too long ago. Choose it again. (desktop) | The preview waited over 10 minutes. | Choose the file again. |
| A file window is already open. / A save window is already open. | One is open already. | Finish or close it. |
| Nothing was changed: this device refused to store the cat. (web app) | The browser's storage refused. | Free some space, or check the site's storage settings. |

**Other things you may notice:**

- **"Walking on … tabs stays off, because it is off on this device."** Expected. An import never switches tab-strip reading back on.
- **Screen analysis, AI, startup or shortcuts did not come along.** Expected. A file never holds them ([list](profile-transfer.md#what-it-never-holds)).
- **The file is not offered in Android's picker.** The picker shows JSON and plain-text documents. A `.json` file that the storage app labels as generic data may be hidden. Try another storage location, such as Downloads.
- **On an iPad, nothing seems to be saved.** In the Home Screen app, saving opens the share sheet: choose **Save to Files**. In a Safari tab it is a download.

## Report what happened

Your report is how these statuses can move. Open an issue at <https://github.com/GizeVerse/GizeCat/issues>:

- **Platform report** for what happened on a Mac, an iPad, an Android tablet, a Windows on Arm PC, Windows 10 or several monitors. Choose "Other (say below)" for iPad, Android or Windows on Arm.
- **Bug report** for something that went wrong.

Say which file you installed, your device and its OS version. Read any log before you attach it. Do not include API keys, screenshots of other people's content or personal data. Security problems go through [SECURITY.md](../../SECURITY.md), never a public issue.
