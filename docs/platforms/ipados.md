# GizeCat on iPad (1.4.0 release candidate)

On an iPad, GizeCat is the **installable web app**: you open it in Safari and add it to your Home Screen. It is not an App Store app. **It has never run on an iPad or in Safari.** No iPad or Mac is available to the project. Statuses use the 1.4.0 vocabulary in [README.md](README.md#status-vocabulary-for-140).

## What it is, and what it is not

- The same cat as on the desktop: the same simulation, renderer, gestures, coats and personality presets, in a web page that works offline once installed.
- The cat lives **inside its own window**. iPadOS has no API that lets any app or web page draw over other apps, so a desktop-style overlay is impossible (BLOCKED_BY_PLATFORM).
- **No native app.** A native SwiftUI app around the same cat was evaluated and is not justified now. It would add no capability beyond the web app: the cat would still live only inside its own window. An App Store release would also need the owner's Apple Developer Program enrollment, which does not exist. The native app is NOT_IMPLEMENTED.

## How to get it

The web app must be served over **HTTPS**, because Safari installs web apps and keeps their offline copy only on secure sites.

- **No public address exists yet.** The project's GitHub Pages workflow is manual, and it needs the owner to enable GitHub Pages for the repository (REQUIRES_OWNER_CREDENTIALS). When the owner publishes an address, the release notes and the README will give it.
- **Until then, you can host it yourself.** `GizeCat-web-1.4.0.zip` on the release page is a static website of 11 files with no server code. Put its files on any static HTTPS host, at any path. `README-web.txt` lists the details: serve `manifest.webmanifest` as `application/manifest+json`, and opening `index.html` from disk does not work.

## Install, step by step

Requirements: iPadOS 16.4 or later is assumed by the design; it has not been checked on a device.

1. Open the web app's HTTPS address in **Safari**.
2. Tap **Share** (the square with an arrow), then **Add to Home Screen**, then **Add**.
3. Open **GizeCat** from the Home Screen.
4. **Install first, then meet your cat.** A Home Screen web app may keep its own storage, separate from Safari. A cat you met in a Safari tab may not come along.
5. The toolbar has Call, Sleep or Wake, Pause, Sound and **Settings**. Settings holds the cat's name, coat, drawing style, size, shadow, emotes, personality, sound, storage status and privacy notes.

How to play: stroke the cat back and forth to pet it; tap it to say hello; press and hold it for a moment, then drag to pick it up; let go to drop it, or flick to throw it. Everything else on the screen keeps working.

## Permissions

None. The web app asks for no camera, microphone, location, notifications or other permission.
- Sound starts only after you tap the Sound button or turn on Cat sounds in Settings, because Safari allows audio only after a tap. The iPad's volume and silent setting apply.
- In the installed app, GizeCat asks the browser to keep its storage (`navigator.storage.persist()`). Safari decides by itself; nothing is shown to you.

## What works and what does not

What exists in code (THEORETICALLY_COMPATIBLE_NOT_EXECUTED for every item):
- The cat on the floor of the app window, above the home indicator.
- Touch gestures; rotation, Split View and Stage Manager resize the cat's world.
- Starting without a network connection after the first visit (a service worker keeps the app's own files).
- The cat and its settings saved on the iPad between visits.

What it does not do:
- Appear over other apps (BLOCKED_BY_PLATFORM).
- Keep running in the background. iPadOS suspends web apps that are not on screen; the cat naps and wakes when you come back.
- Climb windows or ride a taskbar. There is no screen analysis or AI on the web app.

## Limitations

- **Safari may clear the cat.** In a Safari tab, Safari may delete the site's data after 7 days without a visit. A Home Screen web app keeps its own storage and its own day count. Install it to keep your cat.
- **Each place has its own cat.** A Safari tab, the Home Screen app and other devices do not share a cat. Settings → **Take your cat to another device** saves the cat to a file and loads one, so you can move it. In the installed app, saving opens the share sheet (choose Save to Files); in a Safari tab it is a download. That share-sheet route is based on platform knowledge and has not been checked on an iPad.
- A new version starts at the next launch after the host updates the files; there is no forced update.
- The first visit downloads the app twice (the page, then its offline copy). The app is about 1.1 MB, so that is about 2 MB.

## Signing and store status

| Item | Status |
|---|---|
| Web bundle (`GizeCat-web-1.4.0.zip`) | COMPILED_OR_PACKAGED |
| Public HTTPS hosting | REQUIRES_OWNER_CREDENTIALS |
| Native iPad app, App Store | NOT_IMPLEMENTED (needs the owner's Apple Developer Program enrollment; not justified now) |
| Overlay over other apps | BLOCKED_BY_PLATFORM |

## Uninstall

- **Home Screen app:** touch and hold the GizeCat icon, then choose to remove or delete the app. This deletes its storage, so the cat and its settings go with it.
- **Inside the app:** Settings → Start again → **Start over with a new cat** deletes the cat on this iPad. **Reset settings** keeps the cat.
- **Safari tab:** remove the site's data in Safari's website-data settings.

## Feedback

iPad reports are the only way these statuses can move. Open a **Platform report** at <https://github.com/GizeVerse/GizeCat/issues>, choose "Other (say below)", and give your iPad model, iPadOS version, whether you used a Safari tab or the Home Screen app, and where the app was hosted.
