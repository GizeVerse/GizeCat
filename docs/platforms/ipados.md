# GizeCat on iPad (1.4.0 release candidate)

On an iPad, GizeCat is the **installable web app**: you open it in Safari and add it to your Home Screen. It is not an App Store app. **It has never run on an iPad or in Safari.** No iPad or Mac is available to the project. Statuses use the 1.4.0 vocabulary in [README.md](README.md#status-vocabulary-for-140).

## What it is, and what it is not

- The same cat as on the desktop: the same simulation, renderer, gestures, coats and personality presets, in a web page that works offline once installed.
- The cat lives **inside its own window**. iPadOS has no API that lets any app or web page draw over other apps, so a desktop-style overlay is impossible (BLOCKED_BY_PLATFORM).
- **No native app.** A native SwiftUI app around the same cat was evaluated and is not justified now. It would add no capability beyond the web app: the cat would still live only inside its own window. An App Store release would also need the owner's Apple Developer Program enrollment, which does not exist. The native app is NOT_IMPLEMENTED.

## How to get it

The web app must be served over **HTTPS**, because Safari installs web apps and keeps their offline copy only on secure sites.

- **Expected address: `https://gizeverse.github.io/GizeCat/`. It is not deployed.** The web app is prepared for this GitHub project site, but nothing has been published there. The deploy job will print the real address. When it exists, the release notes and the README will give it (REQUIRES_OWNER_CREDENTIALS).
- **What the owner has to do:** bring the workflow file `pages.yml` to `main`, then run it from the Actions tab (the repository's Pages source is already set to GitHub Actions; nothing is deployed yet) ([release automation](release-automation.md)). The workflow is manual and has never been started.
- **Until then, you can host it yourself.** `GizeCat-web-1.4.0.zip`, once a release lists it, is a static website of 12 files with no server code. Put its files on any static HTTPS host, at any path. `README-web.txt` lists the details: serve `manifest.webmanifest` as `application/manifest+json`, and opening `index.html` from disk does not work.

## Install, step by step

Requirements: iPadOS 16.4 or later is assumed. The build targets ES2022, which esbuild's compatibility data maps to Safari 16.4. This has not been checked on a device.

1. Open the web app's HTTPS address in **Safari**.
2. Tap **Share** (the square with an arrow), then **Add to Home Screen**, then **Add**.
3. Open **GizeCat** from the Home Screen.
4. **Install first, then meet your cat.** A Home Screen web app may keep its own storage, separate from Safari. A cat you met in a Safari tab may not come along.
5. The toolbar has Call, Sleep or Wake, Pause, Sound and **Settings**. Settings holds the cat's name, coat, drawing style, size, shadow, emotes, personality, sound, storage status, privacy notes and the third-party notices (under About).

If something goes wrong: [troubleshooting](troubleshooting.md#ipad).

How to play: stroke the cat back and forth to pet it; tap it to say hello; press and hold it for a moment, then drag to pick it up; let go to drop it, or flick to throw it. Everything else on the screen keeps working.

## Permissions

None. The web app asks for no camera, microphone, location, notifications or other permission.
- Sound starts only after you tap the Sound button or turn on Cat sounds in Settings, because Safari allows audio only after a tap. The iPad's volume and silent setting apply.
- In the installed app, GizeCat asks the browser to keep its storage (`navigator.storage.persist()`). Safari decides by itself; nothing is shown to you.

## What works and what does not

What exists in code (THEORETICALLY_COMPATIBLE_NOT_EXECUTED for every item):
- The cat on the floor of the app window, above the home indicator.
- Touch gestures; rotation, Split View, Slide Over and Stage Manager resize the cat's world.
- A loading screen until the cat starts. If the app's code cannot load, or the browser is too old, the page says "GizeCat has not started" after 15 seconds.
- Starting without a network connection after the first visit (a service worker keeps the app's own files). One line in Settings says where the offline copy stands.
- In the Home Screen app, the page runs under the status bar.
- A third-party notices page that opens offline, under Settings → About.
- The cat and its settings saved on the iPad between visits.

What it does not do:
- Appear over other apps (BLOCKED_BY_PLATFORM).
- Keep running in the background. iPadOS suspends web apps that are not on screen; the cat naps and wakes when you come back.
- Climb windows or ride a taskbar. There is no screen analysis or AI on the web app.

## Limitations

- **Safari may clear the cat.** In a Safari tab, Safari may delete the site's data after 7 days without a visit. A Home Screen web app keeps its own storage and its own day count. Install it to keep your cat.
- **Each place has its own cat.** A Safari tab, the Home Screen app and other devices do not share a cat. Settings → **Take your cat to another device** saves the cat to a file and loads one, so you can move it ([guide](profile-transfer.md)). In the installed app, saving opens the share sheet (choose Save to Files); in a Safari tab it is a download. That share-sheet route is based on platform knowledge and has not been checked on an iPad.
- A new version downloads in the background after the host updates the files. Settings then says to close GizeCat and open it again. There is no forced update.
- There is no splash image, so the launch screen is blank until the first paint.
- The first visit downloads the app twice (the page, then its offline copy). The app is about 1.1 MB, so that is about 2 MB.

## Signing and store status

| Item | Status |
|---|---|
| Web bundle (`GizeCat-web-1.4.0.zip`) | COMPILED_OR_PACKAGED |
| Public HTTPS hosting | REQUIRES_OWNER_CREDENTIALS. Expected address `https://gizeverse.github.io/GizeCat/`, not deployed |
| Native iPad app, App Store | NOT_IMPLEMENTED (needs the owner's Apple Developer Program enrollment; not justified now) |
| Overlay over other apps | BLOCKED_BY_PLATFORM |

## Uninstall

- **Home Screen app:** touch and hold the GizeCat icon, then choose to remove or delete the app. This deletes its storage, so the cat and its settings go with it.
- **Inside the app:** Settings → Start again → **Start over with a new cat** deletes the cat on this iPad. **Reset settings** keeps the cat.
- **Safari tab:** remove the site's data in Safari's website-data settings.

## Feedback

iPad reports are the only way these statuses can move. Open a **Platform report** at <https://github.com/GizeVerse/GizeCat/issues>, choose "Other (say below)", and give your iPad model, iPadOS version, whether you used a Safari tab or the Home Screen app, and where the app was hosted.
